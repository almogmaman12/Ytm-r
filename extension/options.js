document.addEventListener('DOMContentLoaded', async () => {
  const urlInput = document.getElementById('serverUrl');
  const saveBtn = document.getElementById('saveBtn');
  const status = document.getElementById('status');

  // Load existing configuration from storage
  const data = await chrome.storage.sync.get(['relayUrl']);
  if (data.relayUrl) {
    urlInput.value = data.relayUrl;
  }

  saveBtn.addEventListener('click', async () => {
    let url = urlInput.value.trim().replace(/\/+$/, '');

    if (!url) {
      status.style.color = '#ff4444';
      status.textContent = 'Please enter a valid URL.';
      return;
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
      urlInput.value = url;
    }

    // Save URL to Chrome Sync Storage across devices
    await chrome.storage.sync.set({ relayUrl: url });

    status.style.color = '#00e676';
    status.textContent = 'Saved! Reloading active YouTube Music tabs...';

    // Notify background script to inject payload into open tabs
    chrome.runtime.sendMessage({ action: 'RELOAD_PAYLOAD' });

    setTimeout(() => {
      status.textContent = '';
    }, 3000);
  });
});