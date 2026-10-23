(function () {
  if (window.__ytmRemoteLoaded) return;
  window.__ytmRemoteLoaded = true;

  console.log('[Ytm-r OTA Payload] Running dynamically from Server!');

  // The extension supplies the configured relay URL before this payload runs.
  // Fall back to the page origin only for manual/local testing.
  const relayBase = window.__YTM_REMOTE_RELAY_URL__ || window.location.origin;
  let relay;
  try {
    relay = new URL(relayBase);
  } catch (err) {
    console.error('[Ytm-r Payload] Invalid relay URL:', err);
    return;
  }
  const wsProtocol = relay.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${relay.host}`;
  let ws = null;

  function connectWebSocket() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[Ytm-r Payload] WebSocket connected to server');
      sendStateUpdate();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleCommand(data);
      } catch (err) {
        console.error('[Ytm-r Payload] Error parsing incoming command:', err);
      }
    };

    ws.onclose = () => {
      console.warn('[Ytm-r Payload] WebSocket connection lost. Retrying in 3s...');
      setTimeout(connectWebSocket, 3000);
    };
  }

  // Handle Playback Commands Received from Relay Server
  function handleCommand(data) {
    const video = document.querySelector('video');

    switch (data.action) {
      case 'play-pause':
      case 'toggle-play':
        document.querySelector('#play-pause-button, .play-pause-button')?.click();
        break;

      case 'play':
        if (video && video.paused) video.play();
        break;

      case 'pause':
        if (video && !video.paused) video.pause();
        break;

      case 'next':
        document.querySelector('.next-button, #next-button, tp-yt-paper-icon-button[title="Next song"]')?.click();
        break;

      case 'previous':
        document.querySelector('.previous-button, #previous-button, tp-yt-paper-icon-button[title="Previous song"]')?.click();
        break;

      case 'volume':
        if (video && typeof data.value === 'number') {
          video.volume = Math.min(1, Math.max(0, data.value / 100));
        }
        break;

      case 'seek':
        if (video && typeof data.value === 'number') {
          video.currentTime = data.value;
        }
        break;

      case 'like':
        document.querySelector('ytmusic-like-button-renderer .like-button, #like-button-renderer #button')?.click();
        break;

      case 'dislike':
        document.querySelector('ytmusic-like-button-renderer .dislike-button')?.click();
        break;
    }

    setTimeout(sendStateUpdate, 300);
  }

  // Scrape and Broadcast YouTube Music Media Info & State
  function sendStateUpdate() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const video = document.querySelector('video');
    const titleEl = document.querySelector('ytmusic-player-bar .title, .ytmusic-player-bar.title');
    const artistEl = document.querySelector('ytmusic-player-bar .byline, .ytmusic-player-bar.byline');
    const thumbnailEl = document.querySelector('ytmusic-player-bar .thumbnail img, img.ytmusic-player-bar');

    const statePayload = {
      type: 'state',
      isPlaying: video ? !video.paused : false,
      currentTime: video ? Math.floor(video.currentTime) : 0,
      duration: video ? Math.floor(video.duration) : 0,
      volume: video ? Math.round(video.volume * 100) : 100,
      title: titleEl?.textContent?.trim() || '',
      artist: artistEl?.textContent?.trim() || '',
      artwork: thumbnailEl?.src || ''
    };

    ws.send(JSON.stringify(statePayload));
  }

  // Continuously sync playback progress every second
  setInterval(sendStateUpdate, 1000);

  // Initialize Connection
  connectWebSocket();
})();