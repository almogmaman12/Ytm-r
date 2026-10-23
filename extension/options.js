const $ = (id) => document.getElementById(id);

const STATUS = {
  connected: ['Connected to relay', 'ok'],
  connecting: ['Connecting…', ''],
  disconnected: ['Not connected. Retrying…', 'bad'],
  replaced: ['Another computer connected with this token and took over. Click Save & connect to take it back.', 'bad'],
  error: ['The relay URL looks wrong. Check it and save again.', 'bad'],
};

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function showStatus(s) {
  const [text, cls] = STATUS[s] || ['Not connected', 'bad'];
  const el = $('status');
  el.textContent = text;
  el.className = cls;
}

function showError(msg) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'bad';
}

chrome.storage.local.get(['serverUrl', 'token', 'status']).then((c) => {
  $('url').value = c.serverUrl || '';
  $('token').value = c.token || '';
  showStatus(c.status);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.status) showStatus(changes.status.newValue);
});

$('gen').onclick = () => { $('token').value = randomToken(); };

$('save').onclick = async () => {
  let serverUrl;
  try {
    const u = new URL($('url').value.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
    serverUrl = u.origin; // drops any path, query or trailing slash that was pasted along
  } catch {
    return showError('Enter the relay address, for example https://your-relay.onrender.com');
  }
  const token = $('token').value.trim();
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) {
    return showError('The token needs 20 or more characters: letters, numbers, - and _ only.');
  }
  $('url').value = serverUrl;
  await chrome.storage.local.set({ serverUrl, token });
  chrome.runtime.sendMessage({ type: 'reconnect' });
};
