// YT Music Remote - extension shell.
//
// This is the small part you install once. It downloads the real code (the "payload") from
// YOUR relay's /ota/ folder, checks it, and starts it on music.youtube.com using Chrome's
// userScripts API. To update the remote, change the files in server/public/ota/ and redeploy
// your relay (for example git push); the extension picks the new version up by itself.
//
// Safety rules for the downloaded code:
//   - it only comes from the relay address you typed in settings (https, or localhost);
//   - redirects to other addresses are refused;
//   - every file must match the SHA-256 fingerprint in the relay's manifest and start with the
//     payload marker, so an error page or a half-written file is never run;
//   - it only runs on https://music.youtube.com/*, and the extension has no other site access;
//   - a bad or unreachable download never replaces the copy that already works.

const SHELL_API = 1;            // payloads that need a newer shell are not installed
const SCRIPT_PREFIX = 'ytmr-';
const YTM = 'https://music.youtube.com/*';
const CHECK_EVERY_MINUTES = 10;
const MAX_FILE_BYTES = 400000;
const MARKER = '// ytmr-payload';

// ---- helpers ----

const userScriptsReady = () => {
  try { return !!(chrome.userScripts && typeof chrome.userScripts.register === 'function'); } catch { return false; }
};

function relayOrigin(raw, allowHttp) {
  const u = new URL(String(raw || '').trim());
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && (local || allowHttp)) return u.origin;
  throw new Error('Use an https:// address. (http:// is only accepted for localhost.)');
}

async function getConfig() {
  const c = await chrome.storage.local.get(['relayUrl', 'token', 'allowHttp', 'pcCode']);
  pcCodeNow = c.pcCode || '';
  return { relayUrl: c.relayUrl || '', token: c.token || '', allowHttp: !!c.allowHttp };
}

async function fetchBytes(url, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: ctrl.signal });
    if (!res.ok) throw new Error(`The relay answered HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_FILE_BYTES) throw new Error('File is too large');
    return buf;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('The relay did not answer in time');
    if (e instanceof TypeError) throw new Error("Can't reach the relay (check the address, or it may be waking up)");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function validateManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('The relay sent an invalid update manifest');
  if (typeof m.version !== 'string' || !/^[0-9a-f]{6,64}$/.test(m.version)) throw new Error('Invalid payload version');
  if (!Number.isInteger(m.requiresShell) || m.requiresShell < 1) throw new Error('Invalid manifest');
  if (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > 6) throw new Error('Invalid file list');
  const names = new Set();
  for (const f of m.files) {
    if (!f || !/^[A-Za-z0-9_.-]+\.js$/.test(f.name) || names.has(f.name)) throw new Error('Invalid file entry');
    if (f.world !== 'MAIN' && f.world !== 'USER_SCRIPT') throw new Error('Invalid file world');
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error('Invalid fingerprint');
    names.add(f.name);
  }
}

// The optional PC code (see the README) travels to the page script together with the token.
let pcCodeNow = '';
const cfgKey = (origin, token) => `${origin}|${token}|${pcCodeNow}`;

async function saveStatus(patch) {
  const { ota = {} } = await chrome.storage.local.get('ota');
  await chrome.storage.local.set({ ota: { ...ota, ...patch, checkedAt: Date.now() } });
}

// ---- registering the payload with Chrome ----

function codeFor(f, origin, token, version) {
  const prefix = f.world === 'USER_SCRIPT'
    ? `globalThis.__YTMR_CONFIG__=${JSON.stringify({ relay: origin, token, version, pcCode: pcCodeNow })};\n`
    : '';
  return prefix + f.code;
}

// MAIN-world files first, so the page helper exists before the content script asks for it.
const ordered = (files) => Object.entries(files).sort((a, b) => (a[1].world === 'MAIN' ? -1 : 1) - (b[1].world === 'MAIN' ? -1 : 1));

async function registerFiles(origin, token, version, files) {
  await chrome.userScripts.configureWorld({ messaging: true });
  const existing = (await chrome.userScripts.getScripts()).filter((s) => s.id.startsWith(SCRIPT_PREFIX)).map((s) => s.id);
  if (existing.length) await chrome.userScripts.unregister({ ids: existing });
  await chrome.userScripts.register(ordered(files).map(([name, f]) => ({
    id: SCRIPT_PREFIX + name,
    matches: [YTM],
    js: [{ code: codeFor(f, origin, token, version) }],
    runAt: 'document_idle',
    world: f.world,
  })));
}

// Tabs that are already open get the new code straight away. The new copy tells the old one
// to stop, so nothing runs twice and the page does not need to be reloaded.
async function applyToOpenTabs(origin, token, version, files) {
  const tabs = await chrome.tabs.query({ url: YTM });
  if (!tabs.length) return true;
  if (typeof chrome.userScripts.execute !== 'function') return false;
  let ok = true;
  for (const tab of tabs) {
    for (const [, f] of ordered(files)) {
      try {
        await chrome.userScripts.execute({
          target: { tabId: tab.id },
          world: f.world,
          js: [{ code: codeFor(f, origin, token, version) }],
          injectImmediately: true,
        });
      } catch { ok = false; }
    }
  }
  return ok;
}

// After a browser restart, or if the token changed: make sure what Chrome has registered
// matches the saved copy and current settings.
async function ensureRegistered() {
  if (!userScriptsReady()) return;
  const { ota } = await chrome.storage.local.get('ota');
  if (!ota || !ota.files) return;
  const cfg = await getConfig();
  let origin;
  try { origin = relayOrigin(cfg.relayUrl, cfg.allowHttp); } catch { return; }
  const have = new Set((await chrome.userScripts.getScripts()).map((s) => s.id));
  const wanted = Object.keys(ota.files).map((n) => SCRIPT_PREFIX + n);
  if (ota.cfgKey === cfgKey(origin, cfg.token) && wanted.every((id) => have.has(id))) return;
  await registerFiles(origin, cfg.token, ota.version, ota.files);
  await chrome.storage.local.set({ ota: { ...ota, cfgKey: cfgKey(origin, cfg.token) } });
}

// ---- the update check ----

let running = null;
let rerun = false;

function checkForUpdate(opts) {
  if (running) { rerun = rerun || !!(opts && opts.force); return running; }
  running = doUpdate(opts || {})
    .catch((e) => saveStatus({ state: 'rejected', error: String((e && e.message) || e) }).then(summary))
    .finally(async () => {
      running = null;
      if (rerun) { rerun = false; checkForUpdate({ force: true }); }
    });
  return running;
}

async function doUpdate({ force = false }) {
  const cfg = await getConfig();
  if (!cfg.relayUrl || !cfg.token) { await saveStatus({ state: 'not-configured', error: '' }); return summary(); }

  let origin;
  try { origin = relayOrigin(cfg.relayUrl, cfg.allowHttp); } catch (e) {
    await saveStatus({ state: 'bad-relay', error: e.message });
    return summary();
  }
  if (!userScriptsReady()) { await saveStatus({ state: 'userscripts-disabled', error: '' }); return summary(); }

  const { ota = {} } = await chrome.storage.local.get('ota');

  // 1. Ask the relay what the current payload is.
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(await fetchBytes(`${origin}/ota/manifest.json`)));
    validateManifest(manifest);
  } catch (e) {
    await ensureRegistered().catch(() => {});
getConfig().then(ensureAgent).catch(() => {});
    await saveStatus({ state: ota.version ? 'offline' : 'fetch-failed', error: e.message });
    return summary();
  }

  if (manifest.requiresShell > SHELL_API) {
    await ensureRegistered().catch(() => {});
    await saveStatus({ state: 'needs-shell', latest: manifest.version, error: '' });
    return summary();
  }

  const key = cfgKey(origin, cfg.token);
  if (!force && ota.version === manifest.version && ota.cfgKey === key) {
    await ensureRegistered().catch(() => {});
    await saveStatus({ state: 'ok', latest: manifest.version, error: '' });
    return summary();
  }

  // 2. Download every file and check it.
  const files = {};
  try {
    for (const f of manifest.files) {
      const buf = await fetchBytes(`${origin}/ota/${f.name}`);
      if (hex(await crypto.subtle.digest('SHA-256', buf)) !== f.sha256) throw new Error(`${f.name} does not match its fingerprint`);
      const code = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      if (!code.startsWith(MARKER)) throw new Error(`${f.name} is not a YT Music Remote payload file`);
      files[f.name] = { world: f.world, sha256: f.sha256, code };
    }
  } catch (e) {
    // Keep whatever already works.
    await ensureRegistered().catch(() => {});
    await saveStatus({ state: 'rejected', error: `Update refused: ${e.message}`, latest: manifest.version });
    return summary();
  }

  // 3. Start it.
  try {
    await registerFiles(origin, cfg.token, manifest.version, files);
  } catch (e) {
    await saveStatus({ state: 'rejected', error: `Chrome would not register the update: ${e.message}` });
    return summary();
  }
  const applied = await applyToOpenTabs(origin, cfg.token, manifest.version, files);
  await chrome.storage.local.set({
    ota: {
      version: manifest.version, latest: manifest.version, files, cfgKey: key,
      installedAt: Date.now(), checkedAt: Date.now(), state: 'ok', error: '', reloadNeeded: !applied,
    },
  });
  return summary();
}

async function summary() {
  const { ota = {}, pcStatus = null } = await chrome.storage.local.get(['ota', 'pcStatus']);
  const { files, ...rest } = ota;
  return {
    ...rest,
    pcStatus,
    shellApi: SHELL_API,
    userScriptsReady: userScriptsReady(),
    canApplyLive: userScriptsReady() && typeof chrome.userScripts.execute === 'function',
    extensionId: chrome.runtime.id,
  };
}

// ---- wake-up helper ----
// While no YouTube Music tab is open, keep one small connection to the relay (role "agent", same
// PC code as the tab). If your phone asks, it opens music.youtube.com. It can do nothing else:
// the address is fixed here and the relay sends no other instructions to it.
let agentWs = null;
let agentPing = null;
let agentRetry = null;
let agentDelay = 3000;

function stopAgent() {
  clearInterval(agentPing); agentPing = null;
  clearTimeout(agentRetry); agentRetry = null;
  if (agentWs) { const w = agentWs; agentWs = null; try { w.close(); } catch {} }
}

async function openMusicTab() {
  const tabs = await chrome.tabs.query({ url: YTM }).catch(() => []);
  if (tabs.length) return;
  const url = 'https://music.youtube.com/';
  try { await chrome.tabs.create({ url, active: false }); }
  catch { await chrome.windows.create({ url, focused: false }).catch(() => {}); }
}

async function ensureAgent() {
  const { agent } = await chrome.storage.local.get('agent');
  const cfg = await getConfig();
  let origin;
  try { origin = relayOrigin(cfg.relayUrl, cfg.allowHttp); } catch { return stopAgent(); }
  const tabs = await chrome.tabs.query({ url: YTM }).catch(() => []);
  if (agent === false || !cfg.token || tabs.length) return stopAgent();
  if (agentWs && agentWs.readyState <= 1) return;
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(cfg.token)}&role=agent`);
  agentWs = ws;
  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'challenge') {
      if (!pcCodeNow) return;
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pcCodeNow), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${cfg.token}|agent|${m.nonce}`));
      ws.send(JSON.stringify({ type: 'auth', proof: hex(sig) }));
    } else if (m.type === 'authed') {
      agentDelay = 3000;
      clearInterval(agentPing);
      // A message every 20 s also keeps Chrome from stopping this worker.
      agentPing = setInterval(() => { try { ws.send('{"type":"ping"}'); } catch {} }, 20000);
    } else if (m.type === 'wake') {
      openMusicTab();
    }
  };
  ws.onclose = (ev) => {
    if (agentWs !== ws) return;
    agentWs = null;
    clearInterval(agentPing); agentPing = null;
    const wait = ev.code === 4003 ? 10 * 60 * 1000 : agentDelay;   // wrong or missing code: do not hammer the relay
    agentDelay = Math.min(agentDelay * 2, 60000);
    agentRetry = setTimeout(() => ensureAgent().catch(() => {}), wait);
  };
  ws.onerror = () => {};
}

// ---- events ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'ota-check') { checkForUpdate({ force: !!msg.force }).then(sendResponse, () => sendResponse(null)); return true; }
  if (msg.type === 'ota-status') { summary().then(sendResponse, () => sendResponse(null)); return true; }
});

// Optional status messages from the running payload (shown on the settings page).
if (chrome.runtime.onUserScriptMessage) {
  chrome.runtime.onUserScriptMessage.addListener((msg) => {
    if (msg && msg.type === 'pc-status' && typeof msg.state === 'string') {
      chrome.storage.local.set({ pcStatus: { state: msg.state.slice(0, 20), version: String(msg.version || '').slice(0, 20), at: Date.now() } });
    }
  });
}

chrome.tabs.onRemoved.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: YTM }).catch(() => []);
  if (!tabs.length) chrome.storage.local.set({ pcStatus: { state: 'no-tab', version: '', at: Date.now() } });
  ensureAgent().catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url && info.url.startsWith('https://music.youtube.com/')) ensureAgent().catch(() => {});
  if (info.status !== 'complete' || !tab.url || !tab.url.startsWith('https://music.youtube.com/')) return;
  const { ota = {} } = await chrome.storage.local.get('ota');
  if (Date.now() - (ota.checkedAt || 0) > 120000) checkForUpdate();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.relayUrl || changes.token || changes.allowHttp || changes.pcCode)) checkForUpdate({ force: true });
  if (area === 'local' && (changes.relayUrl || changes.token || changes.allowHttp || changes.pcCode || changes.agent)) { stopAgent(); ensureAgent().catch(() => {}); }
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  checkForUpdate({ force: true });
});
chrome.runtime.onStartup.addListener(() => { checkForUpdate(); ensureAgent().catch(() => {}); });
chrome.alarms.create('ota-check', { periodInMinutes: CHECK_EVERY_MINUTES, delayInMinutes: 1 });
chrome.alarms.create('agent-check', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'ota-check') checkForUpdate();
  if (a.name === 'agent-check') ensureAgent().catch(() => {});
});

// A worker restart only needs to make sure the saved copy is registered; it does not hit the network.
ensureRegistered().catch(() => {});
