const $ = (id) => document.getElementById(id);

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function showStatus(s) {
  const el = $('status');
  el.textContent = s === 'connected' ? 'Connected to relay' : 'Not connected';
  el.className = s === 'connected' ? 'ok' : 'bad';
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
  const serverUrl = $('url').value.trim();
  const token = $('token').value.trim();
  if (!/^https?:\/\//.test(serverUrl)) return alert('Server URL must start with https://');
  if (token.length < 20 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return alert('Token must be 20+ characters: letters, numbers, - and _ only.');
  }
  await chrome.storage.local.set({ serverUrl, token });
  chrome.runtime.sendMessage({ type: 'reconnect' });
};
