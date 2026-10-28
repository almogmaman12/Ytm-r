// YT Music Remote - relay server
// Extension (role=pc) and phone (role=phone) both connect OUTBOUND to /ws
// with the same secret token. The server forwards whitelisted commands
// phone -> pc and state updates pc -> phone. Nothing is stored on disk.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const MIN_TOKEN_LEN = 20;
const ALLOWED_CMDS = new Set([
  'play', 'pause', 'toggle', 'next', 'previous', 'volume', 'seek', 'get_state',
  'search', 'play_video', 'play_next', 'queue_remove', 'yt_jump', 'yt_remove', 'yt_reorder',
  'queue_end', 'queue_clear', 'play_collection', 'collection_next', 'collection_end', 'open', 'library',
  'radio', 'health', 'related', 'suggest', 'block_current', 'block_remove', 'block_list', 'refresh', 'reload_tab', 'queue_restore', 'yt_remove_many', 'yt_move_many',
]);
const MAX_MSG_BYTES = 65536;        // PC -> server (search results can be a few KB)
const MAX_PHONE_MSG_BYTES = 1024;   // phone -> server (commands are tiny)
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{2,64}$/;      // albums, playlists, 'LM' (liked songs)
const BROWSE_ID_RE = /^(UC|MPREb_|VL)[A-Za-z0-9_-]{4,60}$/;   // artist / album / playlist pages
const SEARCH_KIND_RE = /^(song|album|artist|playlist)\|/;
const LIBRARY_SECTIONS = new Set(['home', 'playlists', 'albums', 'history']);
const QUEUE_REF_RE = /^\d{1,2}:[A-Za-z0-9_-]{11}$/;
const ID11 = '[A-Za-z0-9_-]{11}';
const QUEUE_MANY_RE = new RegExp(`^\\d{1,2}:${ID11}(,\\d{1,2}:${ID11}){0,39}$`);                       // pos:id,pos:id
const MOVE_MANY_RE = new RegExp(`^(top|bottom);${ID11}(,${ID11}){0,39}$`);                          // top;id,id
const RESTORE_RE = new RegExp(`^\\d{1,2};${ID11}(,${ID11}){0,59}(\\|\\d{1,2};${ID11}(,${ID11}){0,59}){0,39}$`);  // pos;ids|pos;ids
const QUEUE_MOVE_RE = /^\d{1,2}:[A-Za-z0-9_-]{11}:\d{1,2}$/;  // from position : video id : to position   // position in the site queue : video id
// Commands that put songs into the queue are tagged with who sent them ("added by ...").
const TAG_CMDS = new Set(['play_next', 'queue_end', 'collection_next', 'collection_end']);
const MAX_CMDS_PER_SEC = 10;        // per phone
const MAX_PC_MSGS_PER_SEC = 50;     // per PC connection
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS) || 200;
const MAX_PHONES_PER_ROOM = 10;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' https: data:",
    "connect-src 'self' ws: wss:",
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
};

// ---- Over-the-air payload ----
// The browser extension is a small loader. The code that actually runs on music.youtube.com
// lives in public/ota/ and is downloaded from THIS server. Update it by changing those files
// and redeploying (for example git push). public/ota/ota.json lists the files; this server
// adds a SHA-256 fingerprint for each and a version that changes whenever any file changes.
const OTA_DIR = path.join(PUBLIC_DIR, 'ota');
const OTA_CORS = {
  'Access-Control-Allow-Origin': '*',     // payload files are public, not secret
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cache-Control': 'no-store',
};
let otaMemo = { at: 0, body: null };

function buildOtaManifest() {
  const cfg = JSON.parse(fs.readFileSync(path.join(OTA_DIR, 'ota.json'), 'utf8'));
  if (!Array.isArray(cfg.files) || !cfg.files.length || cfg.files.length > 6) throw new Error('ota.json: bad file list');
  const files = [];
  const parts = [];
  for (const f of cfg.files) {
    if (!f || !/^[A-Za-z0-9_.-]+\.js$/.test(f.name) || (f.world !== 'MAIN' && f.world !== 'USER_SCRIPT')) {
      throw new Error('ota.json: bad entry');
    }
    const buf = fs.readFileSync(path.join(OTA_DIR, f.name));
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    files.push({ name: f.name, world: f.world, sha256, size: buf.length });
    parts.push(`${f.name}:${f.world}:${sha256}`);
  }
  const version = crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12);
  return { version, requiresShell: Number(cfg.requiresShell) || 1, files };
}

function serveOtaManifest(req, res) {
  try {
    if (!otaMemo.body || Date.now() - otaMemo.at > 2000) {
      otaMemo = { at: Date.now(), body: JSON.stringify(buildOtaManifest()) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...OTA_CORS });
    res.end(req.method === 'HEAD' ? undefined : otaMemo.body);
  } catch (e) {
    console.error('OTA manifest error:', e.message);
    plain(res, 500, 'OTA payload is misconfigured', OTA_CORS);
  }
}

// ---- Logging: who connected and who sent what ----
// Goes to the server's normal output (Render: the Logs tab). The token itself is never logged,
// only a short fingerprint of it ("room"), so lines from one setup can be matched up.
const LOG_COMMANDS = process.env.LOG_COMMANDS !== '0';           // LOG_COMMANDS=0 turns command lines off
const QUIET_CMDS = new Set(['volume', 'seek', 'get_state', 'suggest']);    // fire constantly; shown only with LOG_ALL=1
const text = (v, n = 80) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '').slice(0, n);   // keeps any language
const clean = (v, n = 60) => String(v == null ? '' : v).replace(/[^\x20-\x7e]/g, '?').slice(0, n);
const roomId = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 6);

function log(room, text) {
  console.log(`${new Date().toISOString()} [room ${room}] ${text}`);
}

// "Android Chrome", "iOS Safari", "Windows Chrome", ...: enough to tell your devices apart.
function deviceLabel(ua = '') {
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : ua ? 'other browser' : 'no user-agent';
  return `${os} ${br}`;
}

// The caller's address. Behind a host's proxy (Render, Fly...) it arrives in X-Forwarded-For.
// Only for the log: it can be faked by a client talking to the server directly.
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xff || req.socket.remoteAddress || '';
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip.replace(/^::ffff:/, '') : 'unknown';
}

// ---- Access codes ----
// A token alone is not enough when these environment variables are set on the relay (they are
// set in the host's dashboard, never in the repo):
//   ACCESS_CODE  phones must prove they know it
//   PC_CODE      the PC (extension) must prove it too, so nobody can take the PC's place
// Nobody sends the code itself: the relay sends a random challenge and the client answers with
// HMAC-SHA256(code, token|role|challenge). Read at connection time, so it can change on restart.
const accessCode = () => process.env.ACCESS_CODE || '';
const pcCode = () => process.env.PC_CODE || '';
const codeFor = (role) => (role === 'phone' ? accessCode() : pcCode());   // 'pc' and 'agent' are the PC side
function proofFor(code, token, role, nonce) {
  return crypto.createHmac('sha256', code).update(`${token}|${role}|${nonce}`).digest('hex');
}
function proofOk(code, token, role, nonce, proof) {
  const want = Buffer.from(proofFor(code, token, role, nonce));
  const got = Buffer.from(String(proof || ''));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const AUTH_TIMEOUT_MS = 8000;
const MAX_BAD_CODES = 5;                  // wrong answers allowed from one address ...
const BAD_CODE_WINDOW_MS = 10 * 60 * 1000;  // ... in this long, before it is blocked
const BLOCK_MS = 15 * 60 * 1000;
const failures = new Map();               // ip -> { n, first, until }
function isBlocked(ip) {
  const f = failures.get(ip);
  return !!f && f.until > Date.now();
}
function noteBadCode(ip) {
  const now = Date.now();
  let f = failures.get(ip);
  if (!f || now - f.first > BAD_CODE_WINDOW_MS) f = { n: 0, first: now, until: 0 };
  f.n++;
  if (f.n >= MAX_BAD_CODES) f.until = now + BLOCK_MS;
  failures.set(ip, f);
  return f;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of failures) if (f.until < now && now - f.first > BAD_CODE_WINDOW_MS) failures.delete(ip);
}, 60000).unref();
const cleanName = (v) => String(v == null ? '' : v).replace(/[^\p{L}\p{N} ._'’-]/gu, '').trim().slice(0, 24);

// token -> { pc: ws|null, phones: Set<ws>, lastState: object|null }
const rooms = new Map();

function getRoom(token) {
  let room = rooms.get(token);
  if (!room) {
    room = { pc: null, agent: null, version: '', lastWake: 0, phones: new Set(), lastState: null, lastYtQueue: null };
    rooms.set(token, room);
  }
  return room;
}

// What phones are told about the PC. `wake` means: no tab is connected, but the extension's
// small helper is, so the phone may ask it to reopen YouTube Music.
const pcStatus = (room) => ({ type: 'pc_status', online: !!room.pc, wake: !room.pc && !!room.agent, version: room.pc ? room.version || '' : '' });
const tellPhones = (room) => room.phones.forEach((p) => send(p, pcStatus(room)));

function cleanupRoom(token) {
  const room = rooms.get(token);
  if (room && !room.pc && !room.agent && room.phones.size === 0) rooms.delete(token);
}

// Returns a normalised https URL, or '' if it is not a plain https URL.
// (Never truncates: a cut-off URL would be broken, so too-long ones are dropped.)
function safeHttps(u, max = 500) {
  if (typeof u !== 'string' || u.length > 2000) return '';
  try {
    const p = new URL(u);
    if (p.protocol !== 'https:') return '';
    return p.href.length <= max ? p.href : '';
  } catch {
    return '';
  }
}

// Validates and trims a list of tracks coming from the PC before it reaches a phone.
function cleanTracks(list, limit = 20) {
  const out = [];
  for (const r of list) {
    if (out.length >= limit) break;
    if (!r || typeof r !== 'object') continue;
    const kind = ['song', 'album', 'artist', 'playlist'].includes(r.kind) ? r.kind : 'song';
    const item = {
      kind,
      title: String(r.title || '').slice(0, 200),
      subtitle: String(r.subtitle || '').slice(0, 200),
      thumb: safeHttps(r.thumb),
    };
    if (kind === 'song') {
      if (!VIDEO_ID_RE.test(String(r.videoId))) continue;
      item.videoId = String(r.videoId);
    } else if (kind === 'artist') {
      if (!BROWSE_ID_RE.test(String(r.browseId))) continue;
      item.browseId = String(r.browseId);
    } else {
      if (!PLAYLIST_ID_RE.test(String(r.playlistId))) continue;
      item.playlistId = String(r.playlistId);
    }
    if (r.by) item.by = cleanName(r.by);
    if (r.auto) item.auto = true;
    if (r.explicit === true && kind === 'song') item.explicit = true;
    out.push(item);
  }
  return out;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch { /* socket is going away */ }
  }
}

function plain(res, code, text, extra) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS, ...extra });
  res.end(text);
}

function handleHttp(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });

  const pathname = String(req.url || '/').split('?')[0];
  if (pathname === '/healthz') return plain(res, 200, 'ok');
  if (pathname === '/ota/manifest.json') return serveOtaManifest(req, res);

  let urlPath;
  try { urlPath = decodeURIComponent(pathname); } catch { return plain(res, 400, 'Bad request'); }
  if (urlPath.includes('\0')) return plain(res, 400, 'Bad request');
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.resolve(PUBLIC_DIR, '.' + urlPath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) return plain(res, 403, 'Forbidden');

  fs.readFile(filePath, (err, data) => {
    if (err) return plain(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
      ...(filePath.startsWith(OTA_DIR + path.sep) ? OTA_CORS : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer((req, res) => {
  try {
    handleHttp(req, res);
  } catch {
    try { plain(res, 500, 'Server error'); } catch { /* already sent */ }
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

function rejectUpgrade(socket, code, text) {
  try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* ignore */ }
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return rejectUpgrade(socket, 400, 'Bad Request'); }
  if (url.pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');

  const token = url.searchParams.get('token') || '';
  const role = url.searchParams.get('role');
  if (token.length < MIN_TOKEN_LEN || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token) ||
      (role !== 'pc' && role !== 'phone' && role !== 'agent')) {
    if (LOG_COMMANDS) console.log(`${new Date().toISOString()} [rejected] bad connection request from ${clientIp(req)} (${deviceLabel(String(req.headers['user-agent'] || ''))})`);
    return rejectUpgrade(socket, 400, 'Bad Request');
  }
  if (isBlocked(clientIp(req))) {
    if (LOG_COMMANDS) console.log(`${new Date().toISOString()} [blocked] ${clientIp(req)} is blocked for too many wrong codes`);
    return rejectUpgrade(socket, 429, 'Too Many Requests');
  }
  if (wss.clients.size >= MAX_CLIENTS) return rejectUpgrade(socket, 503, 'Service Unavailable');

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, {
      token, role, ip: clientIp(req), device: deviceLabel(String(req.headers['user-agent'] || '')),
    });
  });
});

wss.on('connection', (ws, { token, role, ip, device }) => {
  const rid = roomId(token);
  let name = '';
  let who = `${device}, ${ip}`;
  const setName = (n) => { name = cleanName(n); who = name ? `${name} (${device}, ${ip})` : `${device}, ${ip}`; ws.who = who; };
  // Without an error listener, a bad frame or an oversized message would crash the whole server.
  ws.on('error', () => {});

  if (role === 'phone') {
    const existing = rooms.get(token);
    if (existing && existing.phones.size >= MAX_PHONES_PER_ROOM) { log(rid, `phone refused (too many phones): ${who}`); return ws.close(4001, 'too many phones'); }
  }

  const room = getRoom(token);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let windowStart = Date.now();
  let count = 0;
  const overLimit = (limit) => {
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; count = 0; }
    return ++count > limit;
  };

  let authed = false;
  let authTimer = null;
  let nonce = '';
  const join = () => {
    authed = true;
    clearTimeout(authTimer);
    ws.joined = true;
    if (role === 'agent') {
      if (room.agent && room.agent !== ws) room.agent.close(4000, 'replaced');
      room.agent = ws;
      ws.who = who;
      log(rid, `PC helper connected: ${who}`);
      tellPhones(room);
    } else if (role === 'pc') {
      if (room.pc && room.pc !== ws) { log(rid, `PC replaced: ${room.pc.who} is out, ${who} is in`); room.pc.close(4000, 'replaced'); }
      room.pc = ws;
      ws.who = who;
      log(rid, `PC connected: ${who}`);
      tellPhones(room);
    } else {
      room.phones.add(ws);
      ws.who = who;
      log(rid, `phone connected: ${who}  (${room.phones.size} phone${room.phones.size === 1 ? '' : 's'})`);
      send(ws, pcStatus(room));
      if (room.lastState) send(ws, { type: 'state', state: room.lastState });
      if (room.lastYtQueue) send(ws, room.lastYtQueue);
      if (room.pc) send(room.pc, { type: 'cmd', cmd: 'get_state' });
    }
    send(ws, { type: 'authed', guarded: !!codeFor(role) });
  };

  const code = codeFor(role);
  if (!code) {
    join();
  } else {
    nonce = crypto.randomBytes(16).toString('hex');
    send(ws, { type: 'challenge', nonce });
    authTimer = setTimeout(() => { log(rid, `${role} did not answer the code challenge: ${who}`); ws.close(4003, 'code required'); }, AUTH_TIMEOUT_MS);
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // Lets either side notice a dead connection quickly.
    if (msg.type === 'ping') return send(ws, { type: 'pong' });

    if (!authed) {
      // The only thing an unverified connection may do is answer the code challenge.
      if (msg.type !== 'auth') return;
      if (proofOk(codeFor(role), token, role, nonce, msg.proof)) {
        setName(msg.name);
        join();
      } else {
        const f = noteBadCode(ip);
        log(rid, `${role} gave a WRONG code: ${who}  (${f.n} of ${MAX_BAD_CODES}${f.until ? ', now blocked for 15 minutes' : ''})`);
        ws.close(4003, 'wrong code');
      }
      return;
    }

    if (role === 'phone' && msg.type === 'name') {
      const before = who;
      setName(msg.name);
      if (who !== before) log(rid, `phone renamed: ${before} -> ${who}`);
      return;
    }

    // The helper only keeps the connection alive; it sends nothing else.
    if (role === 'agent') return;

    if (role === 'phone') {
      if (raw.length > MAX_PHONE_MSG_BYTES || msg.type !== 'cmd') return;
      if (overLimit(MAX_CMDS_PER_SEC)) return;
      if (msg.cmd === 'open_music') {
        // Ask the extension to reopen YouTube Music when no tab is connected. At most once per 10 s.
        const now = Date.now();
        if (room.pc || !room.agent || now - room.lastWake < 10000) return;
        room.lastWake = now;
        if (LOG_COMMANDS) log(rid, `command open_music  from ${who}`);
        send(room.agent, { type: 'wake' });
        return;
      }
      if (!ALLOWED_CMDS.has(msg.cmd)) { if (LOG_COMMANDS) log(rid, `unknown command ${clean(msg.cmd, 30)} refused  from ${who}`); return; }
      const out = { type: 'cmd', cmd: msg.cmd };
      if (msg.cmd === 'volume' || msg.cmd === 'seek') {
        const v = Number(msg.value);
        if (!Number.isFinite(v)) return;
        out.value = msg.cmd === 'volume' ? Math.min(100, Math.max(0, v)) : Math.max(0, v);
      } else if (msg.cmd === 'search') {
        const q = String(msg.value || '').trim().slice(0, 110);
        if (!q) return;
        out.value = q;
      } else if (msg.cmd === 'play_collection' || msg.cmd === 'collection_next' || msg.cmd === 'collection_end') {
        if (!PLAYLIST_ID_RE.test(String(msg.value))) return;
        out.value = String(msg.value);
      } else if (msg.cmd === 'open') {
        if (!BROWSE_ID_RE.test(String(msg.value))) return;
        out.value = String(msg.value);
      } else if (msg.cmd === 'library') {
        if (!LIBRARY_SECTIONS.has(String(msg.value))) return;
        out.value = String(msg.value);
      } else if (msg.cmd === 'health') {
        out.value = msg.value === 'deep' ? 'deep' : 'quick';
      } else if (msg.cmd === 'block_current') {
        out.value = msg.value === 'artist' ? 'artist' : 'song';
      } else if (msg.cmd === 'block_remove') {
        const v = String(msg.value || '');
        if (!/^(song:[A-Za-z0-9_-]{11}|artist:.{1,90})$/s.test(v)) return;
        out.value = text(v, 96);
      } else if (msg.cmd === 'suggest') {
        const q = String(msg.value || '').trim().slice(0, 60);
        if (!q) return;
        out.value = q;
      } else if (msg.cmd === 'radio' || msg.cmd === 'related') {
        if (msg.value !== 'current' && !VIDEO_ID_RE.test(String(msg.value))) return;
        out.value = String(msg.value);
      } else if (msg.cmd === 'play_video' || msg.cmd === 'play_next' || msg.cmd === 'queue_end' || msg.cmd === 'queue_remove') {
        if (!VIDEO_ID_RE.test(String(msg.value))) return;
        out.value = String(msg.value);
      } else if (msg.cmd === 'yt_jump' || msg.cmd === 'yt_remove') {
        if (!QUEUE_REF_RE.test(String(msg.value))) return;
        out.value = String(msg.value);
      } else if (msg.cmd === 'yt_remove_many') {
        if (!QUEUE_MANY_RE.test(String(msg.value))) return;
        out.value = String(msg.value);
      } else if (msg.cmd === 'yt_move_many') {
        if (!MOVE_MANY_RE.test(String(msg.value))) return;
        out.value = String(msg.value);
      } else if (msg.cmd === 'queue_restore') {
        if (!RESTORE_RE.test(String(msg.value))) return;
        out.value = String(msg.value);
      } else if (msg.cmd === 'yt_reorder') {
        if (!QUEUE_MOVE_RE.test(String(msg.value))) return;
        out.value = String(msg.value);
      }
      if (TAG_CMDS.has(out.cmd)) out.by = name || device;
      if (LOG_COMMANDS && (process.env.LOG_ALL === '1' || !QUIET_CMDS.has(out.cmd))) {
        log(rid, `command ${out.cmd}${out.value != null && out.value !== '' ? ' ' + clean(out.value) : ''}  from ${who}${room.pc ? '' : '  (PC offline, not delivered)'}`);
      }
      send(room.pc, out);
      return;
    }

    // From here on the sender is the PC.
    if (overLimit(MAX_PC_MSGS_PER_SEC)) return;
    if (msg.type === 'state' && msg.state && typeof msg.state === 'object') {
      const s = msg.state;
      room.lastState = {
        title: String(s.title || '').slice(0, 300),
        artist: String(s.artist || '').slice(0, 300),
        playing: !!s.playing,
        volume: Number.isFinite(s.volume) ? s.volume : null,
        position: Number.isFinite(s.position) ? s.position : null,
        duration: Number.isFinite(s.duration) ? s.duration : null,
        art: safeHttps(s.art),
        site: s.site === 'yt' ? 'yt' : 'ytm',
      };
      room.phones.forEach((p) => send(p, { type: 'state', state: room.lastState }));
    } else if (msg.type === 'status' && typeof msg.message === 'string') {
      const out = { type: 'status', message: msg.message.slice(0, 300) };
      room.phones.forEach((p) => send(p, out));
    } else if (msg.type === 'queue' && Array.isArray(msg.items)) {
      const out = { type: 'queue', items: cleanTracks(msg.items) };
      room.phones.forEach((p) => send(p, out));
    } else if (msg.type === 'ytqueue' && Array.isArray(msg.items)) {
      // YouTube Music's own queue (the songs after the current one).
      const out = { type: 'ytqueue', items: cleanTracks(msg.items, 50) };
      room.lastYtQueue = out;
      room.phones.forEach((p) => send(p, out));
    } else if (msg.type === 'health' && Array.isArray(msg.checks)) {
      const out = { type: 'health', checks: msg.checks.slice(0, 14).map((c) => ({
        name: clean(c && c.name, 40), ok: !!(c && c.ok), detail: clean(c && c.detail, 140) })) };
      const failed = out.checks.filter((c) => !c.ok).map((c) => c.name);
      log(rid, `health check: ${out.checks.length - failed.length}/${out.checks.length} ok${failed.length ? ' (failed: ' + failed.join(', ') + ')' : ''}`);
      room.phones.forEach((p) => send(p, out));
    } else if (msg.type === 'version' && typeof msg.version === 'string') {
      room.version = clean(msg.version, 20);
      tellPhones(room);
    } else if (msg.type === 'blocklist' && Array.isArray(msg.items)) {
      const out = { type: 'blocklist', items: msg.items.slice(0, 200).filter((b) => b && (b.kind === 'song' || b.kind === 'artist') && typeof b.id === 'string')
        .map((b) => ({ kind: b.kind, id: text(b.id, 90), title: text(b.title || b.id, 120) })) };
      room.phones.forEach((p) => send(p, out));
    } else if (msg.type === 'suggest' && Array.isArray(msg.items)) {
      const out = { type: 'suggest', query: text(msg.query, 60),
        items: msg.items.filter((x) => typeof x === 'string').slice(0, 10).map((x) => text(x, 80)).filter(Boolean) };
      room.phones.forEach((p) => send(p, out));
    } else if (msg.type === 'library' && Array.isArray(msg.items) && LIBRARY_SECTIONS.has(msg.section)) {
      const out = { type: 'library', section: msg.section, items: cleanTracks(msg.items, 60) };
      if (Array.isArray(msg.shelves)) {
        out.shelves = msg.shelves.slice(0, 12).map((sh) => ({ title: text(sh && sh.title, 70), items: cleanTracks((sh && sh.items) || [], 14) }))
          .filter((sh) => sh.title && sh.items.length);
      }
      if (msg.error) out.error = String(msg.error).slice(0, 200);
      room.phones.forEach((p) => send(p, out));
    } else if (msg.type === 'results' && Array.isArray(msg.results)) {
      const out = {
        type: 'results',
        query: String(msg.query || '').slice(0, 120),
        results: cleanTracks(msg.results),
      };
      if (msg.error) out.error = String(msg.error).slice(0, 200);
      room.phones.forEach((p) => send(p, out));
    }
  });

  ws.on('close', (code) => {
    clearTimeout(authTimer);
    if (ws.joined) log(rid, `${role === 'pc' ? 'PC' : role === 'agent' ? 'PC helper' : 'phone'} disconnected: ${who}${code === 4000 ? ' (replaced by another PC)' : ''}`);
    if (role === 'agent') {
      if (room.agent === ws) { room.agent = null; tellPhones(room); }
    } else if (role === 'pc') {
      if (room.pc === ws) {
        room.pc = null;
        tellPhones(room);
      }
    } else {
      room.phones.delete(ws);
    }
    cleanupRoom(token);
  });
});

// Heartbeat: drop dead connections, keep proxies from idling us out.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch { /* socket is going away */ }
  });
}, 25000);
heartbeat.unref();
wss.on('close', () => clearInterval(heartbeat));

if (require.main === module) {
  if (!accessCode()) console.warn('WARNING: ACCESS_CODE is not set. Anyone who learns a token can control playback. Set ACCESS_CODE (and PC_CODE) in your host\'s environment settings.');
  else if (accessCode().length < 8) console.warn('WARNING: ACCESS_CODE is short. Use 10 or more characters (letters and numbers are fine).');
  if (accessCode() && !pcCode()) console.warn('Note: PC_CODE is not set, so anyone with a token could take the PC\'s place. Set PC_CODE too.');
  // A bug or a bad client must never take the relay down.
  process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
  process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

  // Hosts send SIGTERM on every deploy: close cleanly so clients reconnect right away.
  const shutdown = () => {
    wss.clients.forEach((c) => { try { c.close(1001, 'server restarting'); } catch { /* ignore */ } });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(PORT, () => console.log(`YTM remote relay listening on :${PORT}`));
}

module.exports = { server, wss };
