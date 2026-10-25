// ytmr-payload content.js
// Runs in Chrome's "user script" world on music.youtube.com. It holds this PC's connection to
// your relay, reports what is playing, and carries out commands from the phone.
// The browser extension only downloads and starts this file; everything in it (and in page.js)
// updates over the air from your own relay server.

(() => {
  const CFG = globalThis.__YTMR_CONFIG__ || {};
  if (!CFG.relay || !CFG.token) return;
  // Regular YouTube (only if the owner turned it on in the extension's settings). YouTube Music is the main target.
  const IS_YT = location.hostname === 'www.youtube.com';

  // ---- Lifecycle: exactly one live copy per tab ----
  // A newer copy (an update applied to an open tab) tells the older one to stop.
  const ac = new AbortController();
  const timers = [];
  let active = true;
  let sock = null;
  let reconnectTimer = null;

  function shutdown() {
    active = false;
    ac.abort();
    timers.forEach(clearInterval);
    clearTimeout(reconnectTimer);
    const s = sock;
    sock = null;
    if (s) { s.onclose = null; try { s.close(); } catch { /* ignore */ } }
  }

  const myId = Math.random().toString(36).slice(2);
  document.documentElement.dataset.ytmrOwner = myId;
  document.dispatchEvent(new CustomEvent('ytmr-takeover'));
  document.addEventListener('ytmr-takeover', () => {
    if (document.documentElement.dataset.ytmrOwner !== myId) shutdown();
  }, { signal: ac.signal });

  const every = (fn, ms) => timers.push(setInterval(fn, ms));

  // Lets the extension's settings page show what this tab is doing (optional; ignored if unavailable).
  function note(state) {
    try {
      const p = chrome.runtime.sendMessage({ type: 'pc-status', state, version: CFG.version });
      if (p && p.catch) p.catch(() => {});
    } catch { /* messaging is not available */ }
  }

  // ---- Connection to the relay ----
  let backoff = 1000;
  let lastRx = 0;
  let replaced = false;
  let refused = false;
  let lastReclaim = 0;

  const wsBase = () => {
    const u = new URL(CFG.relay);
    return `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
  };

  function sendWs(obj) {
    if (sock && sock.readyState === WebSocket.OPEN) {
      try { sock.send(JSON.stringify(obj)); return true; } catch { /* closing */ }
    }
    return false;
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }

  // The relay may ask for the PC code (PC_CODE on the relay). The code itself is never sent:
  // we answer with HMAC-SHA256(code, token|pc|challenge).
  async function answerChallenge(s, nonce) {
    if (!CFG.pcCode) { try { s.close(); } catch { /* ignore */ } refused = true; note('needs-code'); return; }
    try {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', enc.encode(CFG.pcCode), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${CFG.token}|pc|${nonce}`));
      const proof = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (sock === s) s.send(JSON.stringify({ type: 'auth', proof }));
    } catch { try { s.close(); } catch { /* ignore */ } }
  }

  function connect() {
    clearTimeout(reconnectTimer);
    if (!active || replaced || refused) return;
    if (sock && sock.readyState <= WebSocket.OPEN) return;

    let s;
    try {
      s = new WebSocket(`${wsBase()}/ws?role=pc&token=${encodeURIComponent(CFG.token)}`);
    } catch {
      scheduleReconnect();
      return;
    }
    sock = s;
    note('connecting');

    s.onopen = () => {
      if (sock !== s) { try { s.close(); } catch { /* ignore */ } return; }
      backoff = 1000;
      lastRx = Date.now();
      note('connected');
      report(true);
      sendWs({ type: 'version', version: String(CFG.version || '') });
      toPage('get_state'); // republish the Up next list
    };
    s.onmessage = (ev) => {
      if (sock !== s) return;
      lastRx = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && msg.type === 'challenge') { answerChallenge(s, msg.nonce); return; }
      if (msg && msg.type === 'authed') { report(true); sendWs({ type: 'version', version: String(CFG.version || '') }); toPage('get_state'); return; }  // the relay accepted our code
      if (msg && msg.type === 'cmd') run(msg.cmd, msg.value, msg.by).catch(() => {});
    };
    s.onclose = (ev) => {
      if (sock !== s) return;
      sock = null;
      if (ev.code === 4000) {
        // Another tab or computer connected with the same token.
        replaced = true;
        note('replaced');
        // If this tab is the one playing music, take the connection back once;
        // otherwise wait until music starts here.
        const v = video();
        if (v && !v.paused && Date.now() - lastReclaim > 60000) reclaim(2000);
        return;
      }
      if (ev.code === 4003) {
        // The relay wants a PC code and ours is missing or wrong. Trying again would not help;
        // saving a new code in the settings starts a fresh copy of this script.
        refused = true;
        note(CFG.pcCode ? 'refused' : 'needs-code');
        return;
      }
      note('disconnected');
      scheduleReconnect();
    };
    s.onerror = () => { try { s.close(); } catch { /* ignore */ } };
  }

  function reclaim(delay) {
    lastReclaim = Date.now();
    setTimeout(() => {
      if (!active) return;
      replaced = false;
      backoff = 1000;
      connect();
    }, delay || 0);
  }

  // Traffic every 20s: keeps the link alive and shows quickly when it has died.
  every(() => {
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastRx > 150000) {
      const s = sock;
      sock = null;
      try { s.close(); } catch { /* ignore */ }
      note('disconnected');
      scheduleReconnect();
      return;
    }
    sendWs({ type: 'ping' });
  }, 20000);

  // ---- Reading the player ----
  const q = (sel) => document.querySelector(sel);
  const bar = () => q('ytmusic-player-bar');
  const video = () => q('video');

  // Regular YouTube: the video page's own title and channel.
  function getYtState() {
    const v = video();
    const id = new URLSearchParams(location.search).get('v') || '';
    if (!v || !/^[A-Za-z0-9_-]{11}$/.test(id) || !isFinite(v.duration)) return null;
    const title = q('h1.ytd-watch-metadata')?.textContent?.trim() || document.title.replace(/\s*-\s*YouTube\s*$/, '').replace(/^\(\d+\)\s*/, '');
    const channel = q('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a')?.textContent?.trim() || '';
    return {
      site: 'yt', title, artist: channel,
      playing: !v.paused,
      volume: pageVolume != null ? pageVolume : Math.round(v.volume * 100),
      position: isFinite(v.currentTime) ? Math.floor(v.currentTime) : null,
      duration: Math.floor(v.duration),
      art: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  }

  function getState() {
    if (IS_YT) return getYtState();
    const b = bar();
    const v = video();
    if (!b) return null;
    const title = b.querySelector('.title')?.textContent?.trim() || '';
    const byline = b.querySelector('.byline')?.textContent?.trim() || '';
    const art = b.querySelector('img#img')?.src || b.querySelector('.image')?.src || '';
    return {
      site: 'ytm',
      title,
      artist: byline.split('•')[0].trim(),
      playing: v ? !v.paused : false,
      // The player's own volume comes from page.js; the site's slider can't be read from here.
      volume: pageVolume != null ? pageVolume : v ? Math.round(v.volume * 100) : null,
      position: v && isFinite(v.currentTime) ? Math.floor(v.currentTime) : null,
      duration: v && isFinite(v.duration) ? Math.floor(v.duration) : null,
      art: art.startsWith('https://') ? art : '',
    };
  }

  // Report when something visible changes, when playback jumps (a seek, on the PC or from the
  // phone), and at least every 10 seconds.
  let lastKey = '';
  let lastPos = null;
  let lastPosAt = 0;
  let lastPlaying = false;

  function report(force) {
    const s = getState();
    if (!s) return;
    const key = JSON.stringify([s.title, s.artist, s.playing, s.volume, s.duration]);
    let jumped = false;
    if (lastPos !== null && s.position !== null) {
      const expected = lastPos + (lastPlaying ? (Date.now() - lastPosAt) / 1000 : 0);
      jumped = Math.abs(s.position - expected) > 2.5;
    }
    if (!force && key === lastKey && !jumped) return;
    lastKey = key;
    lastPos = s.position;
    lastPosAt = Date.now();
    lastPlaying = s.playing;
    sendWs({ type: 'state', state: s });
  }

  let reportTimer = null;
  const reportSoon = () => {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => report(false), 150);
  };
  for (const ev of ['pause', 'seeked', 'loadedmetadata', 'durationchange', 'volumechange']) {
    document.addEventListener(ev, reportSoon, { capture: true, signal: ac.signal });
  }
  document.addEventListener('play', () => {
    reportSoon();
    // Music started in this tab while another tab or computer holds the connection: take it over.
    if (replaced && Date.now() - lastReclaim > 60000) reclaim(0);
  }, { capture: true, signal: ac.signal });
  every(() => report(false), 1000);
  every(() => report(true), 10000);

  // ---- Talking to page.js (runs in the page's own JS world) ----
  let pageIsReady = false;
  let pageVolume = null;
  const toPage = (cmd, value, by) => window.postMessage(
    { source: 'ytmr-ext', cmd, value: value == null ? '' : String(value), by: by ? String(by) : '' }, location.origin);

  function pageReady() {
    if (pageIsReady) return Promise.resolve(true);
    toPage('ping');
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (pageIsReady) { clearInterval(iv); resolve(true); }
        else if (Date.now() - t0 > 800) { clearInterval(iv); resolve(false); }
      }, 50);
    });
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'ytmr-page') return;
    const d = ev.data;
    if (d.type === 'hello') pageIsReady = true;
    else if (d.type === 'volume') { if (isFinite(d.value)) { pageVolume = Number(d.value); reportSoon(); } }
    else if (d.type === 'queue') sendWs({ type: 'queue', items: Array.isArray(d.items) ? d.items : [] });
    else if (d.type === 'health') sendWs({ type: 'health', checks: Array.isArray(d.checks) ? d.checks : [] });
    else if (d.type === 'library') sendWs({ type: 'library', section: d.section, items: Array.isArray(d.items) ? d.items : [], shelves: Array.isArray(d.shelves) ? d.shelves : undefined, error: d.error });
    else if (d.type === 'blocklist') sendWs({ type: 'blocklist', items: Array.isArray(d.items) ? d.items : [] });
    else if (d.type === 'suggest') sendWs({ type: 'suggest', query: String(d.query || ''), items: Array.isArray(d.items) ? d.items : [] });
    else if (d.type === 'ytqueue') sendWs({ type: 'ytqueue', items: Array.isArray(d.items) ? d.items : [] });
    else if (d.type === 'status') sendWs({ type: 'status', message: String(d.message || '') });
    else if (d.type === 'results') {
      sendWs({
        type: 'results',
        query: d.query,
        results: Array.isArray(d.results) ? d.results : [],
        error: d.error,
      });
    }
  }, { signal: ac.signal });
  toPage('ping'); // find out whether page.js is already running

  // ---- Commands from the phone ----
  function click(sel) {
    const el = bar()?.querySelector(sel);
    if (el) el.click();
  }

  // Regular YouTube has no bar like YouTube Music: control the video itself.
  async function runYt(cmd, value) {
    const v = video();
    const ytBtn = (sel) => { const el = q('#movie_player ' + sel); if (el && el.offsetParent !== null) { el.click(); return true; } return false; };
    switch (cmd) {
      case 'play': if (v && v.paused) v.play().catch(() => {}); break;
      case 'pause': if (v && !v.paused) v.pause(); break;
      case 'toggle': if (v) { v.paused ? v.play().catch(() => {}) : v.pause(); } break;
      case 'previous': if (!ytBtn('.ytp-prev-button') && v) v.currentTime = 0; break;
      case 'next': ytBtn('.ytp-next-button'); break;
      case 'seek': { const n = Number(value); if (v && isFinite(n)) v.currentTime = n; break; }
      case 'volume': {
        const n = Number(value);
        if (!isFinite(n)) return;
        if (await pageReady()) toPage('volume', n); else if (v) v.volume = Math.min(1, Math.max(0, n / 100));
        break;
      }
      case 'play_video': if (/^[A-Za-z0-9_-]{11}$/.test(String(value))) location.assign('/watch?v=' + value); return;
      case 'search': case 'health': case 'suggest':
        if (!(await pageReady())) { sendWs({ type: 'status', message: 'Reload the YouTube tab on the PC, then try again.' }); return; }
        toPage(cmd, value);
        return;
      case 'library': sendWs({ type: 'library', section: value, items: [], error: 'The library is only available on YouTube Music' }); return;
      case 'open': sendWs({ type: 'results', query: `open:${value}`, results: [], error: 'Only available on YouTube Music' }); return;
      case 'related': sendWs({ type: 'results', query: `related:${value}`, results: [], error: 'Only available on YouTube Music' }); return;
      case 'get_state': break;
      default:
        sendWs({ type: 'status', message: 'That only works on YouTube Music. This tab is regular YouTube.' });
        return;
    }
    report(true);
    setTimeout(() => report(true), 250);
  }

  async function run(cmd, value, by) {
    if (IS_YT) return runYt(cmd, value);
    const v = video();
    switch (cmd) {
      case 'play': if (v && v.paused) click('#play-pause-button'); break;
      case 'pause': if (v && !v.paused) click('#play-pause-button'); break;
      case 'toggle': click('#play-pause-button'); break;
      case 'previous': click('.previous-button'); break;
      case 'volume': {
        const n = Number(value);
        if (!isFinite(n)) return;
        // Only the page's own player can change the volume the way the site does.
        if (await pageReady()) toPage('volume', n);
        else if (v) v.volume = Math.min(1, Math.max(0, n / 100));
        break;
      }
      case 'seek': {
        const n = Number(value);
        if (v && isFinite(n)) v.currentTime = n;
        break;
      }
      case 'next':
        // page.js owns the "Up next" list; without it, just press the site's own Next button.
        if (await pageReady()) toPage('next'); else click('.next-button');
        break;
      case 'search':
      case 'play_video':
      case 'play_next':
      case 'queue_remove':
      case 'yt_jump':
      case 'yt_remove':
      case 'yt_reorder':
      case 'queue_end':
      case 'queue_clear':
      case 'play_collection':
      case 'collection_next':
      case 'collection_end':
      case 'open':
      case 'library':
      case 'radio':
      case 'health':
      case 'related':
      case 'suggest':
      case 'block_current':
      case 'block_remove':
      case 'block_list':
        if (!(await pageReady())) {
          sendWs({ type: 'status', message: 'Reload the YouTube Music tab on the PC, then try again.' });
          if (cmd === 'search') {
            sendWs({ type: 'results', query: value, results: [], error: 'Reload the YouTube Music tab on the PC' });
          } else if (cmd === 'open') {
            sendWs({ type: 'results', query: `open:${value}`, results: [], error: 'Reload the YouTube Music tab on the PC' });
          } else if (cmd === 'library') {
            sendWs({ type: 'library', section: value, items: [], error: 'Reload the YouTube Music tab on the PC' });
          } else if (cmd === 'related') {
            sendWs({ type: 'results', query: `related:${value}`, results: [], error: 'Reload the YouTube Music tab on the PC' });
          }
          return;
        }
        toPage(cmd, value, by);
        if (cmd === 'search' || cmd === 'open' || cmd === 'library' || cmd === 'related' || cmd === 'suggest') return; // answers come back asynchronously
        break;
      case 'get_state':
        if (await pageReady()) toPage('get_state');
        break;
      default:
        return;
    }
    // Report straight away, and again once the page has settled. (Background tabs delay timers.)
    report(true);
    setTimeout(() => report(true), 250);
  }

  if (IS_YT) {
    // Don't take the connection from a YouTube Music tab just by being open: wait until a video plays here.
    replaced = true;
  } else {
    connect();
  }
})();
