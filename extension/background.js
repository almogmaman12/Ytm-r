// Service worker: keeps an outbound WebSocket to the relay, forwards
// commands to the YT Music tab, and forwards state back.

const YTM_URL = 'https://music.youtube.com/*';

let ws = null;
let reconnectTimer = null;
let keepAliveTimer = null;
let backoff = 1000;
let lastState = null;
let lastRx = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setStatus = (status) => chrome.storage.local.set({ status }).catch(() => {});

function sendWs(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); return true; } catch { /* socket is closing */ }
  }
  return false;
}

async function connect() {
  clearTimeout(reconnectTimer);
  const { serverUrl, token, status } = await chrome.storage.local.get(['serverUrl', 'token', 'status']);
  if (!serverUrl || !token) return;
  // Another computer took over this token. Stay quiet until the user reconnects on purpose,
  // otherwise two computers would keep kicking each other out.
  if (status === 'replaced') return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  let base;
  try {
    const u = new URL(serverUrl);
    base = `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
  } catch {
    setStatus('error');
    return;
  }
  setStatus('connecting');

  let sock;
  try {
    sock = new WebSocket(`${base}/ws?role=pc&token=${encodeURIComponent(token)}`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  lastRx = Date.now();

  // Every handler checks that its socket is still the current one, so a socket we
  // already replaced can never clear the new one's timers or overwrite its status.
  sock.onopen = () => {
    if (ws !== sock) { try { sock.close(); } catch { /* ignore */ } return; }
    backoff = 1000;
    lastRx = Date.now();
    setStatus('connected');
    if (lastState) sendWs({ type: 'state', state: lastState });
    // Traffic every 20s keeps the service worker alive, and a missing reply means the link is dead.
    clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => {
      if (ws !== sock) return;
      if (Date.now() - lastRx > 60000) { dropSocket(); scheduleReconnect(); return; }
      sendWs({ type: 'ping' });
    }, 20000);
  };

  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    lastRx = Date.now();
    handleMessage(ev.data);
  };

  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    clearInterval(keepAliveTimer);
    if (ev.code === 4000) { setStatus('replaced'); return; }
    setStatus('disconnected');
    scheduleReconnect();
  };

  sock.onerror = () => { try { sock.close(); } catch { /* ignore */ } };
}

function dropSocket() {
  const old = ws;
  ws = null;
  clearInterval(keepAliveTimer);
  try { old && old.close(); } catch { /* ignore */ }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30000);
}

async function resetConnection() {
  dropSocket();
  backoff = 1000;
  await setStatus('disconnected'); // also clears a "replaced" state
  connect();
}

// ---- Commands from the phone -> the YouTube Music tab ----

async function findTab() {
  const tabs = await chrome.tabs.query({ url: YTM_URL });
  // Prefer the tab that is making sound, then the one in front.
  return tabs.find((t) => t.audible) || tabs.find((t) => t.active) || tabs[0];
}

// Tabs that were already open when the extension was installed or updated have no
// working copy of our scripts yet. Load them in on demand.
async function injectInto(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['page.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch { /* tab closed, or not allowed */ }
}

async function deliver(msg, retried) {
  const tab = await findTab();
  if (!tab) {
    sendWs({ type: 'status', message: 'YouTube Music is not open on the PC.' });
    if (msg.cmd === 'search') {
      sendWs({ type: 'results', query: msg.value, results: [], error: 'YouTube Music is not open on the PC' });
    }
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    if (retried) {
      sendWs({ type: 'status', message: "Couldn't reach YouTube Music. Reload its tab on the PC." });
      return;
    }
    await injectInto(tab.id);
    await sleep(300);
    return deliver(msg, true);
  }
}

function handleMessage(data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg && msg.type === 'cmd') deliver(msg, false).catch(() => {});
}

// ---- Messages from the content script on the YouTube Music tab ----

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  switch (msg.type) {
    case 'state':
      lastState = msg.state;
      sendWs({ type: 'state', state: msg.state });
      break;
    case 'queue':
      sendWs({ type: 'queue', items: msg.items });
      break;
    case 'status':
      sendWs({ type: 'status', message: msg.message });
      break;
    case 'results':
      sendWs({ type: 'results', query: msg.query, results: msg.results, error: msg.error });
      break;
    case 'reconnect':
      resetConnection();
      break;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.serverUrl || changes.token) resetConnection();
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(async (details) => {
  connect();
  // Bring tabs that were already open up to date straight away.
  if (details.reason === 'install' || details.reason === 'update') {
    const tabs = await chrome.tabs.query({ url: YTM_URL }).catch(() => []);
    for (const t of tabs) injectInto(t.id);
  }
});
// The alarm wakes the worker if Chrome suspended it, and retries a stopped connection.
chrome.alarms.create('reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(connect);
connect();
