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
    if (releaseLock) { try { releaseLock(); } catch { /* ignore */ } releaseLock = null; }
  }

  const myId = Math.random().toString(36).slice(2);
  document.documentElement.dataset.ytmrOwner = myId;
  document.dispatchEvent(new CustomEvent('ytmr-takeover'));
  document.addEventListener('ytmr-takeover', () => {
    if (document.documentElement.dataset.ytmrOwner !== myId) shutdown();
  }, { signal: ac.signal });

  const every = (fn, ms) => timers.push(setInterval(fn, ms));

  // Chrome doesn't freeze a page that holds a Web Lock, so this tab keeps its connection when it is
  // in the background. (Released when this copy stops.)
  let releaseLock = null;
  try {
    navigator.locks.request('ytmr-keepalive', () => new Promise((resolve) => { releaseLock = resolve; })).catch(() => {});
  } catch { /* not available */ }

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

  // If Chrome froze this page and it wakes up, the connection is probably dead: check it right away.
  const wakeCheck = () => {
    if (!active || refused) return;
    if (!sock || sock.readyState !== WebSocket.OPEN) { if (!replaced) { backoff = 1000; connect(); } return; }
    const asked = Date.now(); const s = sock;
    sendWs({ type: 'ping' });
    // No answer within 5 seconds: the connection died while the page slept. Replace it.
    setTimeout(() => {
      if (!active || sock !== s || lastRx >= asked) return;
      sock = null; try { s.close(); } catch { /* ignore */ }
      note('disconnected'); scheduleReconnect();
    }, 5000);
  };
  document.addEventListener('resume', wakeCheck, { signal: ac.signal });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wakeCheck(); }, { signal: ac.signal });

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
  // ---- Site selectors (updatable without a new payload) ----
  // The page elements this script reads and presses. The values below are the built-in ones. The
  // relay's /ota/selectors.json can replace any of them while the tab is open: when the site
  // changes its markup, fixing it is a one-line edit there, no code release and no reload.
  // Each value is one CSS selector or a list tried in order.
  const SEL = {
    likeRoot: 'ytmusic-player-bar ytmusic-like-button-renderer',
    like: ['#button-shape-like button', '#like-button button', 'button.like', '.like', '[aria-label="Like"]'],
    dislike: ['#button-shape-dislike button', '#dislike-button button', 'button.dislike', '.dislike', '[aria-label="Dislike"]'],
    ytLike: ['like-button-view-model button', '#segmented-like-button button'],
    ytDislike: ['dislike-button-view-model button', '#segmented-dislike-button button'],
    shuffle: ['ytmusic-player-bar .shuffle', 'ytmusic-player-queue .shuffle', '#queue-header .shuffle'],
    repeat: ['ytmusic-player-bar .repeat'],
    adSkip: ['.ytp-skip-ad-button', '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern', '.ytp-skip-ad'],
    ytmTitle: ['.title'],
    ytmByline: ['.byline'],
    ytmArt: ['img#img', '.image'],
    ytTitle: ['h1.ytd-watch-metadata'],
    ytChannel: ['ytd-watch-metadata ytd-channel-name a', '#owner ytd-channel-name a'],
    playPause: ['#play-pause-button'],
  };
  const selList = (k) => (Array.isArray(SEL[k]) ? SEL[k] : [SEL[k]]);
  function applySelectors(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return 0;
    let n = 0;
    for (const [k, v] of Object.entries(o)) {
      if (!Object.prototype.hasOwnProperty.call(SEL, k)) continue;
      const list = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && x.trim() && x.length <= 200).slice(0, 12);
      if (!list.length || list.length !== (Array.isArray(v) ? v : [v]).length) continue;
      try { list.forEach((x) => document.createDocumentFragment().querySelector(x)); } catch { continue; }   // not a valid selector
      SEL[k] = k === 'likeRoot' ? list[0] : list;
      n++;
    }
    return n;
  }
  let selVersion = '';
  async function loadSelectors() {
    try {
      const r = await fetch(`${CFG.relay}/ota/selectors.json`, { cache: 'no-store', credentials: 'omit' });
      if (!r.ok) return;
      const j = await r.json();
      const body = j && (j.selectors || j);
      const tag = String((j && j.version) || '') + JSON.stringify(body).length;
      if (tag === selVersion) return;
      selVersion = tag;
      if (applySelectors(body)) reportSoon();
    } catch { /* offline or blocked: the built-in selectors stay */ }
  }
  // Tries each selector of a key in order (optionally inside a root element); a bad one is skipped.
  function qk(key, root) {
    for (const sel of selList(key)) {
      try { const el = (root || document).querySelector(sel); if (el) return el; } catch { /* skip */ }
    }
    return null;
  }
  const q = (sel) => { try { return document.querySelector(sel); } catch { return null; } };
  const bar = () => q('ytmusic-player-bar');
  const video = () => q('video');

  // ---- Extras: like, shuffle, repeat, speed, skip and the sleep timer ----
  // These read and press the site's own buttons, so they are best effort: if the site changes its
  // markup, the matching control simply does nothing (and says so on the phone).
    const likeBtn = (which) => {
    if (IS_YT) return qk(which === 'like' ? 'ytLike' : 'ytDislike');
    const root = q(SEL.likeRoot);
    return root ? qk(which === 'like' ? 'like' : 'dislike', root) : null;
  };
  const press = (el) => el.click();   // one plain click: extra pointer events could toggle twice
  function likeStatus() {
    if (IS_YT) return likeBtn('like')?.getAttribute('aria-pressed') === 'true' ? 'like' : likeBtn('dislike')?.getAttribute('aria-pressed') === 'true' ? 'dislike' : '';
    const r = q(SEL.likeRoot);
    const st = String(r?.getAttribute('like-status') || r?.likeStatus || '').toUpperCase();
    if (st === 'LIKE' || st === 'DISLIKE') return st.toLowerCase();
    if (likeBtn('like')?.getAttribute('aria-pressed') === 'true') return 'like';
    if (likeBtn('dislike')?.getAttribute('aria-pressed') === 'true') return 'dislike';
    return '';
  }
  function repeatMode() {
    if (IS_YT) return video()?.loop ? 'one' : 'none';
    const b = bar();
    const m = String((b && (b.getAttribute('repeat-mode_') || b.repeatMode_)) || '').toUpperCase();
    return m === 'ALL' ? 'all' : m === 'ONE' ? 'one' : 'none';
  }
  function shuffleOn() {
    if (IS_YT) return null;
    const b = qk('shuffle');
    if (!b) return null;
    return b.getAttribute('aria-pressed') === 'true' || b.hasAttribute('active') || b.classList.contains('active');
  }

  let sleepAt = 0, sleepEnd = false, sleepVol = null;
  const sleepLeft = () => (sleepEnd ? -1 : sleepAt ? Math.max(0, Math.round((sleepAt - Date.now()) / 1000)) : null);
  const curVol = () => (pageVolume != null ? pageVolume : video() ? Math.round(video().volume * 100) : 50);
  async function setVol(n) {
    n = Math.round(Math.min(100, Math.max(0, n)));
    if (await pageReady()) toPage('volume', n); else if (video()) video().volume = n / 100;
  }
  function endSleep(restore) {
    const was = sleepVol;
    sleepAt = 0; sleepEnd = false; sleepVol = null;
    if (restore && was != null) setVol(was);
  }
  every(() => {
    if (!sleepAt && !sleepEnd) return;
    const v = video();
    if (!v) return;
    const remain = sleepEnd ? (isFinite(v.duration) ? v.duration - v.currentTime : 999) : (sleepAt - Date.now()) / 1000;
    const fade = sleepEnd ? 6 : 20;
    if (remain <= fade && !v.paused) {
      if (sleepVol == null) sleepVol = curVol();
      setVol(sleepVol * Math.max(0, remain) / fade);
    }
    if (remain <= (sleepEnd ? 0.9 : 0)) {
      if (!v.paused) { if (IS_YT) v.pause(); else (qk('playPause', bar())?.click()); }
      setTimeout(() => endSleep(true), 800);   // bring the volume back once it has stopped
      sleepAt = 0; sleepEnd = false;
      report(true);
    }
  }, 500);

  function adState() {
    const pl = q('#movie_player');
    if (!pl || !(pl.classList.contains('ad-showing') || pl.classList.contains('ad-interrupting'))) return '';
    return qk('adSkip') ? 'skip' : 'ad';
  }
  function extras() {
    const v = video();
    return {
      ad: adState(),
      speed: v && isFinite(v.playbackRate) ? Math.round(v.playbackRate * 100) / 100 : 1,
      like: likeStatus(),
      repeat: repeatMode(),
      shuffle: shuffleOn(),
      sleep: sleepLeft(),
    };
  }

  // Returns true when the command was one of the extras (so the caller stops there).
  function runExtra(cmd, value) {
    const v = video();
    const missing = (what) => sendWs({ type: 'status', message: `${what} isn't available on this page right now.` });
    switch (cmd) {
      case 'like': case 'dislike': {
        const b = likeBtn(cmd);
        if (b) { press(b); setTimeout(reportSoon, 400); setTimeout(reportSoon, 1200); } else missing(cmd === 'like' ? 'Like' : 'Dislike');
        break;
      }
      case 'shuffle': {
        if (IS_YT) { sendWs({ type: 'status', message: 'Shuffle only works on YouTube Music.' }); break; }
        const b = qk('shuffle');
        if (b) b.click(); else missing('Shuffle');
        break;
      }
      case 'repeat': {
        if (IS_YT) { if (v) v.loop = !v.loop; break; }
        const b = qk('repeat');
        if (b) b.click(); else missing('Repeat');
        break;
      }
      case 'speed': {
        const n = Number(value);
        if (v && isFinite(n) && n >= 0.25 && n <= 2) v.playbackRate = n;
        break;
      }
      case 'skip': {
        const n = Number(value);
        if (v && isFinite(n) && isFinite(v.duration)) v.currentTime = Math.min(v.duration - 0.5, Math.max(0, v.currentTime + n));
        break;
      }
      case 'skip_ad': {
        const b = qk('adSkip');
        if (b) b.click();
        break;
      }
      case 'sleep': {
        if (value === 'off') endSleep(true);
        else if (value === 'end') { sleepAt = 0; sleepEnd = true; }
        else { const m = Number(value); if (isFinite(m) && m >= 1 && m <= 720) { sleepEnd = false; sleepAt = Date.now() + m * 60000; } }
        break;
      }
      default: return false;
    }
    report(true);
    setTimeout(() => report(true), 300);
    return true;
  }

  // Regular YouTube: the video page's own title and channel.
  function getYtState() {
    const v = video();
    const id = new URLSearchParams(location.search).get('v') || '';
    if (!v || !/^[A-Za-z0-9_-]{11}$/.test(id) || !isFinite(v.duration)) return null;
    const title = qk('ytTitle')?.textContent?.trim() || document.title.replace(/\s*-\s*YouTube\s*$/, '').replace(/^\(\d+\)\s*/, '');
    const channel = qk('ytChannel')?.textContent?.trim() || '';
    return {
      site: 'yt', title, artist: channel,
      ...extras(),
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
    const title = qk('ytmTitle', b)?.textContent?.trim() || '';
    const byline = qk('ytmByline', b)?.textContent?.trim() || '';
    const art = qk('ytmArt', b)?.src || '';
    return {
      site: 'ytm',
      ...extras(),
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
    const key = JSON.stringify([s.title, s.artist, s.playing, s.volume, s.duration, s.speed, s.like, s.repeat, s.shuffle, s.ad, s.sleep == null ? null : s.sleep < 0 ? -1 : Math.ceil(s.sleep / 60)]);
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
    else if (d.type === 'saved') sendWs({ type: 'saved', ok: !!d.ok, title: String(d.title || ''), count: Number(d.count) || 0, error: d.error ? String(d.error) : '' });
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
  loadSelectors();
  every(loadSelectors, 10 * 60 * 1000);

  // ---- Commands from the phone ----
  function click(sel) {
    const el = bar()?.querySelector(sel);
    if (el) el.click();
  }

  // Regular YouTube has no bar like YouTube Music: control the video itself.
  async function runYt(cmd, value, by) {
    if (runExtra(cmd, value)) return;
    const v = video();
    const ytBtn = (sel) => { const el = q('#movie_player ' + sel); if (el && el.offsetParent !== null) { el.click(); return true; } return false; };
    switch (cmd) {
      case 'play': if (v && v.paused) v.play().catch(() => {}); break;
      case 'pause': if (v && !v.paused) v.pause(); break;
      case 'toggle': if (v) { v.paused ? v.play().catch(() => {}) : v.pause(); } break;
      case 'previous': if (!ytBtn('.ytp-prev-button') && v) v.currentTime = 0; break;
      case 'next': if (await pageReady()) { toPage('next'); return; } ytBtn('.ytp-next-button'); break;
      case 'seek': { const n = Number(value); if (v && isFinite(n)) v.currentTime = n; break; }
      case 'volume': {
        const n = Number(value);
        if (!isFinite(n)) return;
        if (await pageReady()) toPage('volume', n); else if (v) v.volume = Math.min(1, Math.max(0, n / 100));
        break;
      }
      case 'play_video': case 'play_next': case 'queue_end': case 'yt_jump': case 'yt_remove': case 'yt_remove_many': case 'yt_reorder':
      case 'yt_move_many': case 'queue_clear': case 'queue_restore': case 'radio': case 'related':
        if (await pageReady()) { toPage(cmd, value, by); return; }
        if (cmd === 'play_video' && /^[A-Za-z0-9_-]{11}$/.test(String(value))) { location.assign('/watch?v=' + value); return; }
        if (cmd === 'related') sendWs({ type: 'results', query: `related:${value}`, results: [], error: 'Reload the YouTube tab on the PC' });
        else sendWs({ type: 'status', message: 'Reload the YouTube tab on the PC, then try again.' });
        return;
      case 'search': case 'health': case 'suggest':
        if (!(await pageReady())) { sendWs({ type: 'status', message: 'Reload the YouTube tab on the PC, then try again.' }); return; }
        toPage(cmd, value);
        return;
      case 'library': sendWs({ type: 'library', section: value, items: [], error: 'The library is only available on YouTube Music' }); return;
      case 'open': sendWs({ type: 'results', query: `open:${value}`, results: [], error: 'Only available on YouTube Music' }); return;
      case 'get_state': case 'refresh': break;
      case 'reload_tab': setTimeout(() => location.reload(), 300); return;
      default:
        sendWs({ type: 'status', message: 'That only works on YouTube Music. This tab is regular YouTube.' });
        return;
    }
    report(true);
    setTimeout(() => report(true), 250);
  }

  async function run(cmd, value, by) {
    if (IS_YT) return runYt(cmd, value, by);
    if (runExtra(cmd, value)) return;
    const v = video();
    switch (cmd) {
      case 'play': if (v && v.paused) (qk('playPause', bar())?.click()); break;
      case 'pause': if (v && !v.paused) (qk('playPause', bar())?.click()); break;
      case 'toggle': (qk('playPause', bar())?.click()); break;
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
      case 'queue_restore':
      case 'yt_remove_many':
      case 'yt_move_many':
      case 'add_to_playlist':
      case 'save_playlist':
        if (!(await pageReady())) {
          sendWs({ type: 'status', message: 'Reload the YouTube Music tab on the PC, then try again.' });
          if (cmd === 'search') {
            sendWs({ type: 'results', query: value, results: [], error: 'Reload the YouTube Music tab on the PC' });
          } else if (cmd === 'open') {
            sendWs({ type: 'results', query: `open:${value}`, results: [], error: 'Reload the YouTube Music tab on the PC' });
          } else if (cmd === 'library') {
            sendWs({ type: 'library', section: value, items: [], error: 'Reload the YouTube Music tab on the PC' });
          } else if (cmd === 'save_playlist') {
            sendWs({ type: 'saved', ok: false, error: 'Reload the YouTube Music tab on the PC' });
          } else if (cmd === 'related') {
            sendWs({ type: 'results', query: `related:${value}`, results: [], error: 'Reload the YouTube Music tab on the PC' });
          }
          return;
        }
        toPage(cmd, value, by);
        if (cmd === 'search' || cmd === 'open' || cmd === 'library' || cmd === 'related' || cmd === 'suggest') return; // answers come back asynchronously
        break;
      case 'refresh':
        // Everything again: version, state, queue, volume, block list. And ask the extension to look for an update.
        try { const p = chrome.runtime.sendMessage({ type: 'ota-check' }); if (p && p.catch) p.catch(() => {}); } catch { /* messaging unavailable */ }
        sendWs({ type: 'version', version: String(CFG.version || '') });
        loadSelectors();   // also pick up new site selectors now
        if (await pageReady()) { toPage('get_state'); toPage('refresh'); }
        break;
      case 'reload_tab':
        sendWs({ type: 'status', message: 'Reloading YouTube Music on the PC…' });
        setTimeout(() => location.reload(), 300);
        return;
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
    // The exception is a tab the phone just opened or switched to: the extension says so (claim-check).
    replaced = true;
    const askClaim = async () => {
      if (!active || !replaced || document.hidden) return;
      try {
        const r = await chrome.runtime.sendMessage({ type: 'claim-check' });
        if (r && r.claim) reclaim(0);
      } catch { /* messaging unavailable (older extension): wait for a video instead */ }
    };
    askClaim();
    every(askClaim, 3000);
  } else {
    connect();
  }
})();

window.__ytmrMarker = 2;
