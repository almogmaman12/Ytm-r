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

chrome.storage.onChanged.addListener((changes, area) => { if (unlocked && area === 'local' && (changes.ota || changes.pcStatus)) refresh(); });
setInterval(() => { if (unlocked) refresh(); }, 3000);

/* ---------- settings password ----------
   A salted PBKDF2 hash is kept in storage.local. The page shows nothing until the password is
   entered, and locks again after it has been in the background for a minute. This keeps casual
   visitors out of the settings; it does not encrypt what is stored (the extension must be able to
   connect on its own), so it is not protection against someone with full control of the PC. */
let unlocked = false;
let fails = 0;
let hiddenAt = 0;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((x) => parseInt(x, 16)));
async function derive(pw, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 310000 }, key, 256));
}
async function makeLock(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: hex(salt), hash: await derive(pw, salt) };
}
function showLock(mode) {
  unlocked = false;
  $('app').hidden = true;
  $('lock').hidden = false;
  const first = mode === 'set';
  $('lockTitle').textContent = first ? 'Set a password' : 'Locked';
  $('lockText').textContent = first
    ? 'Choose a password for this extension\'s settings. You will need it every time you open them.'
    : 'Enter the password to open the settings.';
  $('pw1Label').textContent = first ? 'New password (8 or more characters)' : 'Password';
  $('pw1').autocomplete = first ? 'new-password' : 'current-password';
  $('pw2Wrap').hidden = !first;
  $('lockGo').textContent = first ? 'Set password' : 'Unlock';
  $('lockHint').textContent = first ? 'There is no way to recover a forgotten password. If you lose it, remove and reinstall the extension.' : '';
  $('pw1').value = ''; $('pw2').value = ''; $('lockMsg').textContent = '';
  setTimeout(() => $('pw1').focus(), 50);
}
function open_() {
  unlocked = true;
  $('lock').hidden = true;
  $('app').hidden = false;
  $('pw1').value = ''; $('pw2').value = '';
  load();
}
async function gate() {
  const { lock } = await chrome.storage.local.get('lock');
  if (!lock || !lock.hash) showLock('set'); else showLock('enter');
}
$('lockGo').onclick = async () => {
  const { lock } = await chrome.storage.local.get('lock');
  const pw = $('pw1').value;
  const msg = $('lockMsg');
  msg.className = 'msg bad';
  if (!lock || !lock.hash) {
    if (pw.length < 8) return (msg.textContent = 'Use 8 or more characters.');
    if (pw !== $('pw2').value) return (msg.textContent = 'The two passwords do not match.');
    $('lockGo').disabled = true;
    await chrome.storage.local.set({ lock: await makeLock(pw) });
    $('lockGo').disabled = false;
    return open_();
  }
  $('lockGo').disabled = true;
  const ok = (await derive(pw, unhex(lock.salt))) === lock.hash;
  if (ok) { fails = 0; $('lockGo').disabled = false; return open_(); }
  fails++;
  msg.textContent = 'Wrong password.';
  $('pw1').value = '';
  // Slow repeated guessing down: 1s after the first miss, doubling up to 30s.
  const wait = Math.min(30, 2 ** (fails - 1));
  setTimeout(() => { $('lockGo').disabled = false; }, wait * 1000);
};
for (const id of ['pw1', 'pw2']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lockGo').click(); });
$('changepw').onclick = async () => {
  const pw = $('newpw').value;
  if (pw.length < 8) return say('Use 8 or more characters for the password.', 'bad');
  await chrome.storage.local.set({ lock: await makeLock(pw) });
  $('newpw').value = '';
  say('Password changed.', 'ok');
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (unlocked && hiddenAt && Date.now() - hiddenAt > 60000) gate();
});
gate();
