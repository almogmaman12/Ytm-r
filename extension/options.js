const $ = (id) => document.getElementById(id);

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function say(text, cls) {
  const el = $('msg');
  el.textContent = text;
  el.className = cls || '';
}

function setRow(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = cls || '';
}

const PC = {
  connected: ['Connected to your relay', 'ok'],
  connecting: ['Connecting…', 'warn'],
  disconnected: ['Lost the connection, retrying…', 'warn'],
  replaced: ['Another tab or computer took over this token', 'warn'],
  'no-tab': ['No YouTube Music tab is open', 'warn'],
  refused: ['The relay refused the PC code. Check it in the box above', 'bad'],
  'needs-code': ['Your relay needs a PC code. Enter it above', 'bad'],
};

function render(s) {
  if (!s) return;
  setRow('s-us', s.userScriptsReady ? 'On' : 'Off (see below)', s.userScriptsReady ? 'ok' : 'bad');
  $('us-help').hidden = s.userScriptsReady;
  $('shell-help').hidden = s.state !== 'needs-shell';
  $('reload-help').hidden = !(s.reloadNeeded && s.state === 'ok');

  let text;
  let cls = '';
  switch (s.state) {
    case 'ok': text = `Version ${s.version}, checked ${ago(s.checkedAt)}`; cls = 'ok'; break;
    case 'offline': text = `Using saved version ${s.version}. ${s.error || "Can't reach the relay"} (checked ${ago(s.checkedAt)})`; cls = 'warn'; break;
    case 'needs-shell': text = `Using version ${s.version}. A newer version is waiting (needs a newer extension)`; cls = 'warn'; break;
    case 'rejected': text = s.error || 'The update was refused'; cls = 'bad'; break;
    case 'fetch-failed': text = s.error || "Can't reach the relay"; cls = 'bad'; break;
    case 'bad-relay': text = s.error || 'The relay address is not valid'; cls = 'bad'; break;
    case 'userscripts-disabled': text = 'Waiting for the Chrome setting'; cls = 'warn'; break;
    case 'not-configured': text = 'Enter your relay address and token, then save'; break;
    default: text = '—';
  }
  setRow('s-ota', text, cls);

  const pc = s.pcStatus && PC[s.pcStatus.state];
  setRow('s-pc', pc ? pc[0] : 'Waiting for a YouTube Music tab', pc ? pc[1] : '');
}

async function refresh() {
  try { render(await chrome.runtime.sendMessage({ type: 'ota-status' })); } catch { /* worker is starting */ }
}

async function load() {
  const c = await chrome.storage.local.get(['relayUrl', 'token', 'allowHttp', 'pcCode']);
  $('pccode').value = c.pcCode || '';
  if (c.pcCode) $('pcdetails').open = true;
  $('url').value = c.relayUrl || '';
  $('token').value = c.token || '';
  $('allowHttp').checked = !!c.allowHttp;
  refresh();
}

$('gen').onclick = () => { $('token').value = randomToken(); say('New token. Save it, then enter the same token on your phone.'); };
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('token').value.trim()); say('Token copied.', 'ok'); } catch { say('Could not copy. Select the token and copy it by hand.', 'bad'); }
};

$('save').onclick = async () => {
  const allowHttp = $('allowHttp').checked;
  let relayUrl;
  try {
    const u = new URL($('url').value.trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (local || allowHttp))) throw new Error('scheme');
    relayUrl = u.origin; // drops any pasted path, query or trailing slash
  } catch {
    return say('Enter the relay address, starting with https:// (for example https://your-relay.onrender.com).', 'bad');
  }
  const token = $('token').value.trim();
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) {
    return say('The token needs 20 or more characters: letters, numbers, - and _ only.', 'bad');
  }
  $('url').value = relayUrl;
  $('save').disabled = true;
  say('Saving…');
  const pcCode = $('pccode').value.trim();
  if (pcCode && !/^\S{6,100}$/.test(pcCode)) { $('save').disabled = false; return say('The PC code needs 6 or more characters and no spaces (or leave it empty).', 'bad'); }
  await chrome.storage.local.set({ relayUrl, token, allowHttp, pcCode });
  const r = await chrome.runtime.sendMessage({ type: 'ota-check', force: true }).catch(() => null);
  $('save').disabled = false;
  render(r);
  if (r && r.state === 'ok') say('Saved. The remote code is loaded.', 'ok');
  else if (r && r.state === 'userscripts-disabled') say('Saved. Turn on the Chrome setting below to finish.', 'warn');
  else say('Saved, but there is a problem. See the status below.', 'bad');
};

$('check').onclick = async () => {
  $('check').disabled = true;
  say('Checking…');
  const r = await chrome.runtime.sendMessage({ type: 'ota-check', force: false }).catch(() => null);
  $('check').disabled = false;
  render(r);
  say(r && r.state === 'ok' ? 'Up to date.' : '', 'ok');
};

$('open-ext').onclick = () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });

chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes.ota || changes.pcStatus)) refresh(); });
setInterval(refresh, 3000);
load();
