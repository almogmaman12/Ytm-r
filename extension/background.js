// Open settings tab automatically when installed for the first time
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

async function loadRemoteScriptForTab(tabId) {
  // Retrieve user-configured relay server URL from sync storage
  const { relayUrl } = await chrome.storage.sync.get(['relayUrl']);

  if (!relayUrl) {
    console.warn('[Ytm-r] No relay server URL set. Opening options page.');
    chrome.runtime.openOptionsPage();
    return;
  }

  const cleanBaseUrl = relayUrl.replace(/\/+$/, '');
  const scriptUrl = `${cleanBaseUrl}/extension-payload.js`;

  let codePayload = "";

  try {
    const response = await fetch(scriptUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    codePayload = await response.text();

    // Store in local storage for offline resilience
    await chrome.storage.local.set({ cachedPayload: codePayload });
    console.log(`[Ytm-r] Successfully fetched payload from ${cleanBaseUrl}`);
  } catch (err) {
    console.warn('[Ytm-r] Fetch failed, loading cached fallback:', err);
    const { cachedPayload } = await chrome.storage.local.get(['cachedPayload']);
    codePayload = cachedPayload;
  }

  if (!codePayload) {
    console.error('[Ytm-r] No payload available to execute.');
    return;
  }

  try {
    // Unregister existing payload to avoid duplicate execution
    const existingScripts = await chrome.userScripts.getScripts();
    if (existingScripts.some(s => s.id === 'ytm-remote-payload')) {
      await chrome.userScripts.unregister({ ids: ['ytm-remote-payload'] });
    }

    // Inject dynamic script into YouTube Music context
    await chrome.userScripts.register([{
      id: 'ytm-remote-payload',
      matches: ['https://music.youtube.com/*'],
      // Pass the configured relay URL into the same user-script execution context.
      // The payload remains remotely updateable and cached for offline use.
      js: [{ code: `window.__YTM_REMOTE_RELAY_URL__ = ${JSON.stringify(cleanBaseUrl)};\n${codePayload}` }],
      runAt: 'document_idle'
    }]);

    console.log('[Ytm-r] Payload successfully registered and injected.');
  } catch (err) {
    console.error('[Ytm-r] Failed to register userScript:', err);
  }
}

// Trigger script load whenever music.youtube.com finishes loading
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('music.youtube.com')) {
    loadRemoteScriptForTab(tabId);
  }
});

// Listen for update message from options page
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'RELOAD_PAYLOAD') {
    chrome.tabs.query({ url: 'https://music.youtube.com/*' }, (tabs) => {
      tabs.forEach((tab) => loadRemoteScriptForTab(tab.id));
    });
  }
});