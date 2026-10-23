// YT Music Remote - relay server
// Extension (role=pc) and phone (role=phone) both connect OUTBOUND to /ws
// with the same secret token. The server forwards whitelisted commands
// phone -> pc and state updates pc -> phone. Nothing is stored on disk.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIN_TOKEN_LEN = 20;
const ALLOWED_CMDS = new Set([
  'play', 'pause', 'toggle', 'next', 'previous', 'volume', 'seek', 'get_state',
  'search', 'play_video', 'play_next', 'queue_remove',
]);
const MAX_MSG_BYTES = 65536;        // PC -> server (search results can be a few KB)
const MAX_PHONE_MSG_BYTES = 1024;   // phone -> server (commands are tiny)
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_CMDS_PER_SEC = 10;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// token -> { pc: ws|null, phones: Set<ws>, lastState: object|null }
const rooms = new Map();

function getRoom(token) {
  let room = rooms.get(token);
  if (!room) {
    room = { pc: null, phones: new Set(), lastState: null };
    rooms.set(token, room);
  }
  return room;
}

function cleanupRoom(token) {
  const room = rooms.get(token);
  if (room && !room.pc && room.phones.size === 0) rooms.delete(token);
}

// Validates and trims a list of tracks coming from the PC before it reaches a phone.
function cleanTracks(list) {
  return list
    .slice(0, 20)
    .filter((r) => r && VIDEO_ID_RE.test(String(r.videoId)))
    .map((r) => ({
      videoId: String(r.videoId),
      title: String(r.title || '').slice(0, 200),
      subtitle: String(r.subtitle || '').slice(0, 200),
      thumb: typeof r.thumb === 'string' && r.thumb.startsWith('https://')
        ? r.thumb.slice(0, 500) : '',
    }));
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  const token = url.searchParams.get('token') || '';
  const role = url.searchParams.get('role');
  if (token.length < MIN_TOKEN_LEN || !/^[A-Za-z0-9_-]+$/.test(token) ||
      (role !== 'pc' && role !== 'phone')) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, { token, role });
  });
});

wss.on('connection', (ws, { token, role }) => {
  const room = getRoom(token);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let windowStart = Date.now();
  let count = 0;

  if (role === 'pc') {
    if (room.pc && room.pc !== ws) room.pc.close(4000, 'replaced');
    room.pc = ws;
    room.phones.forEach((p) => send(p, { type: 'pc_status', online: true }));
  } else {
    room.phones.add(ws);
    send(ws, { type: 'pc_status', online: !!room.pc });
    if (room.lastState) send(ws, { type: 'state', state: room.lastState });
    if (room.pc) send(room.pc, { type: 'cmd', cmd: 'get_state' });
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (role === 'phone' && raw.length > MAX_PHONE_MSG_BYTES) return;

    if (role === 'phone' && msg.type === 'cmd') {
      const now = Date.now();
      if (now - windowStart > 1000) { windowStart = now; count = 0; }
      if (++count > MAX_CMDS_PER_SEC) return;
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
      }
      send(room.pc, out);
    } else if (role === 'pc' && msg.type === 'state' && msg.state &&
               typeof msg.state === 'object') {
      const s = msg.state;
      room.lastState = {
        title: String(s.title || '').slice(0, 300),
        artist: String(s.artist || '').slice(0, 300),
        playing: !!s.playing,
        volume: Number.isFinite(s.volume) ? s.volume : null,
        position: Number.isFinite(s.position) ? s.position : null,
        duration: Number.isFinite(s.duration) ? s.duration : null,
        art: typeof s.art === 'string' && s.art.startsWith('https://') ? s.art.slice(0, 500) : '',
      };
      room.phones.forEach((p) => send(p, { type: 'state', state: room.lastState }));
    } else if (role === 'pc' && msg.type === 'status' && typeof msg.message === 'string') {
      const out = { type: 'status', message: msg.message.slice(0, 300) };
      room.phones.forEach((p) => send(p, out));
    } else if (role === 'pc' && msg.type === 'queue' && Array.isArray(msg.items)) {
      const out = { type: 'queue', items: cleanTracks(msg.items) };
      room.phones.forEach((p) => send(p, out));
    } else if (role === 'pc' && msg.type === 'results' && Array.isArray(msg.results)) {
      const results = cleanTracks(msg.results);
      const out = { type: 'results', query: String(msg.query || '').slice(0, 100), results };
      if (msg.error) out.error = String(msg.error).slice(0, 100);
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
    ws.ping();
  });
}, 25000);
wss.on('close', () => clearInterval(heartbeat));

if (require.main === module) {
  server.listen(PORT, () => console.log(`YTM remote relay listening on :${PORT}`));
}

module.exports = { server, wss };
