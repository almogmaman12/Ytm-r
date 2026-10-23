// Service worker: keeps an outbound WebSocket to the relay, forwards
// commands to the YT Music tab, and forwards state back.

let ws = null;
let reconnectTimer = null;
let keepAliveTimer = null;
let backoff = 1000;
let lastState = null;

async function getConfig() {
  const { serverUrl, token } = await chrome.storage.local.get(['serverUrl', 'token']);
  return { serverUrl, token };
}

async function connect() {
  clearTimeout(reconnectTimer);
  const { serverUrl, token } = await getConfig();
  if (!serverUrl || !token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const base = serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
  try {
    ws = new WebSocket(`${base}/ws?role=pc&token=${encodeURIComponent(token)}`);
  } catch {
    return scheduleReconnect();
  }

  ws.onopen = () => {
    backoff = 1000;
    chrome.storage.local.set({ status: 'connected' });
    if (lastState) ws.send(JSON.stringify({ type: 'state', state: lastState }));
    // Messages every 20s keep the service worker alive while connected.
    clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 20000);
  };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type !== 'cmd') return;
    const tabs = await chrome.tabs.query({ url: 'https://music.youtube.com/*' });
    // Prefer the tab that is playing audio.
    const tab = tabs.find((t) => t.audible) || tabs[0];
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  };

  ws.onclose = () => {
    clearInterval(keepAliveTimer);
    chrome.storage.local.set({ status: 'disconnected' });
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30000);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'state') {
    lastState = msg.state;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'state', state: msg.state }));
    }
  } else if (msg.type === 'results') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'results', query: msg.query, results: msg.results, error: msg.error,
      }));
    }
  } else if (msg.type === 'reconnect') {
    try { ws && ws.close(); } catch {}
    ws = null;
    backoff = 1000;
    connect();
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.serverUrl || changes.token) {
    try { ws && ws.close(); } catch {}
    ws = null;
    connect();
  }
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
// Alarm wakes the worker if Chrome suspended it while disconnected.
chrome.alarms?.create?.('reconnect', { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener(connect);
connect();
