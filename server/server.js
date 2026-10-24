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
]);
const MAX_MSG_BYTES = 65536;        // PC -> server (search results can be a few KB)
const MAX_PHONE_MSG_BYTES = 1024;   // phone -> server (commands are tiny)
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const QUEUE_REF_RE = /^\d{1,2}:[A-Za-z0-9_-]{11}$/;
const QUEUE_MOVE_RE = /^\d{1,2}:[A-Za-z0-9_-]{11}:\d{1,2}$/;  // from position : video id : to position   // position in the site queue : video id
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

// token -> { pc: ws|null, phones: Set<ws>, lastState: object|null }
const rooms = new Map();

function getRoom(token) {
  let room = rooms.get(token);
  if (!room) {
    room = { pc: null, phones: new Set(), lastState: null, lastYtQueue: null };
    rooms.set(token, room);
  }
  return room;
}

function cleanupRoom(token) {
  const room = rooms.get(token);
  if (room && !room.pc && room.phones.size === 0) rooms.delete(token);
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
  return list
    .slice(0, limit)
    .filter((r) => r && VIDEO_ID_RE.test(String(r.videoId)))
    .map((r) => ({
      videoId: String(r.videoId),
      title: String(r.title || '').slice(0, 200),
      subtitle: String(r.subtitle || '').slice(0, 200),
      thumb: safeHttps(r.thumb),
    }));
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
      (role !== 'pc' && role !== 'phone')) {
    return rejectUpgrade(socket, 400, 'Bad Request');
  }
  if (wss.clients.size >= MAX_CLIENTS) return rejectUpgrade(socket, 503, 'Service Unavailable');

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, { token, role });
  });
});

wss.on('connection', (ws, { token, role }) => {
  // Without an error listener, a bad frame or an oversized message would crash the whole server.
  ws.on('error', () => {});

  if (role === 'phone') {
    const existing = rooms.get(token);
    if (existing && existing.phones.size >= MAX_PHONES_PER_ROOM) return ws.close(4001, 'too many phones');
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

  if (role === 'pc') {
    if (room.pc && room.pc !== ws) room.pc.close(4000, 'replaced');
    room.pc = ws;
    room.phones.forEach((p) => send(p, { type: 'pc_status', online: true }));
  } else {
    room.phones.add(ws);
    send(ws, { type: 'pc_status', online: !!room.pc });
    if (room.lastState) send(ws, { type: 'state', state: room.lastState });
    if (room.lastYtQueue) send(ws, room.lastYtQueue);
    if (room.pc) send(room.pc, { type: 'cmd', cmd: 'get_state' });
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // Lets either side notice a dead connection quickly.
    if (msg.type === 'ping') return send(ws, { type: 'pong' });

    if (role === 'phone') {
      if (raw.length > MAX_PHONE_MSG_BYTES || msg.type !== 'cmd') return;
      if (overLimit(MAX_CMDS_PER_SEC)) return;
      if (!ALLOWED_CMDS.has(msg.cmd)) return;
      const out = { type: 'cmd', cmd: msg.cmd };
      if (msg.cmd === 'volume' || msg.cmd === 'seek') {
        const v = Number(msg.value);
        if (!Number.isFinite(v)) return;
        out.value = msg.cmd === 'volume' ? Math.min(100, Math.max(0, v)) : Math.max(0, v);
      } else if (msg.cmd === 'search') {
        const q = String(msg.value || '').trim().slice(0, 100);
        if (!q) return;
        out.value = q;
      } else if (msg.cmd === 'play_video' || msg.cmd === 'play_next' || msg.cmd === 'queue_remove') {
        if (!VIDEO_ID_RE.test(String(msg.value))) return;
        out.value = String(msg.value);
      } else if (msg.cmd === 'yt_jump' || msg.cmd === 'yt_remove') {
        if (!QUEUE_REF_RE.test(String(msg.value))) return;
        out.value = String(msg.value);
      } else if (msg.cmd === 'yt_reorder') {
        if (!QUEUE_MOVE_RE.test(String(msg.value))) return;
        out.value = String(msg.value);
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
    } else if (msg.type === 'results' && Array.isArray(msg.results)) {
      const out = {
        type: 'results',
        query: String(msg.query || '').slice(0, 100),
        results: cleanTracks(msg.results),
      };
      if (msg.error) out.error = String(msg.error).slice(0, 200);
      room.phones.forEach((p) => send(p, out));
    }
  });

  ws.on('close', () => {
    if (role === 'pc') {
      if (room.pc === ws) {
        room.pc = null;
        room.phones.forEach((p) => send(p, { type: 'pc_status', online: false }));
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
