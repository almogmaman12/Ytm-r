// Runs inside music.youtube.com. Reads player state and performs commands
// by using the page's own controls. Talks only to the background worker
// and to page.js (which runs in the page's own JS world).

(() => {
  // If this extension is updated or reloaded, the old copy of this script stays in the
  // open tab with a dead connection. It notices, and shuts itself down.
  const ac = new AbortController();
  const timers = [];
  let active = true;
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  function shutdown() {
    active = false;
    ac.abort();
    timers.forEach(clearInterval);
  }

  // Only one live copy per tab: a newer copy (loaded after a failed delivery, say) tells any
  // older live copy to stop, so commands are never handled twice.
  const myId = Math.random().toString(36).slice(2);
  document.documentElement.dataset.ytmrOwner = myId;
  document.dispatchEvent(new CustomEvent('ytmr-takeover'));
  document.addEventListener('ytmr-takeover', () => {
    if (document.documentElement.dataset.ytmrOwner !== myId) shutdown();
  }, { signal: ac.signal });
  const every = (fn, ms) => timers.push(setInterval(() => (alive() ? fn() : shutdown()), ms));
  const send = (m) => {
    if (!alive()) return shutdown();
    try { chrome.runtime.sendMessage(m).catch(() => {}); } catch { shutdown(); }
  };

  const q = (sel) => document.querySelector(sel);
  const bar = () => q('ytmusic-player-bar');
  const video = () => q('video');

  function getState() {
    const b = bar();
    const v = video();
    if (!b) return null;
    const title = b.querySelector('.title')?.textContent?.trim() || '';
    const byline = b.querySelector('.byline')?.textContent?.trim() || '';
    const art = b.querySelector('img#img')?.src || b.querySelector('.image')?.src || '';
    const slider = b.querySelector('#volume-slider');
    return {
      title,
      artist: byline.split('•')[0].trim(),
      playing: v ? !v.paused : false,
      volume: slider ? Number(slider.value) : v ? Math.round(v.volume * 100) : null,
      position: v && isFinite(v.currentTime) ? Math.floor(v.currentTime) : null,
      duration: v && isFinite(v.duration) ? Math.floor(v.duration) : null,
      art: art.startsWith('https://') ? art : '',
    };
  }

  // ---- Reporting state to the phone ----
  // Report when something visible changes, when playback jumps (a seek, either on the PC
  // or from the phone), and at least every 10 seconds.
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
    send({ type: 'state', state: s });
  }

  let reportTimer = null;
  const reportSoon = () => {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => report(false), 150);
  };
  for (const ev of ['play', 'pause', 'seeked', 'loadedmetadata', 'durationchange', 'volumechange']) {
    document.addEventListener(ev, reportSoon, { capture: true, signal: ac.signal });
  }
  every(() => report(false), 1000);
  every(() => report(true), 10000);

  // ---- Talking to page.js ----
  let pageIsReady = false;
  const toPage = (cmd, value) => window.postMessage(
    { source: 'ytmr-ext', cmd, value: value == null ? '' : String(value) }, location.origin);

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
    else if (d.type === 'queue') send({ type: 'queue', items: Array.isArray(d.items) ? d.items : [] });
    else if (d.type === 'status') send({ type: 'status', message: String(d.message || '') });
    else if (d.type === 'results') {
      send({
        type: 'results',
        query: d.query,
        results: Array.isArray(d.results) ? d.results : [],
        error: d.error,
      });
    }
  }, { signal: ac.signal });
  toPage('ping'); // find out whether page.js is already running

  // ---- Commands ----
  function click(sel) {
    const el = bar()?.querySelector(sel);
    if (el) el.click();
  }

  async function run(cmd, value) {
    const v = video();
    switch (cmd) {
      case 'play': if (v && v.paused) click('#play-pause-button'); break;
      case 'pause': if (v && !v.paused) click('#play-pause-button'); break;
      case 'toggle': click('#play-pause-button'); break;
      case 'previous': click('.previous-button'); break;
      case 'volume': {
        const n = Number(value);
        if (!isFinite(n)) return;
        const slider = bar()?.querySelector('#volume-slider');
        if (slider) {
          slider.value = n;
          slider.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (v) {
          v.volume = Math.min(1, Math.max(0, n / 100));
        }
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
        if (!(await pageReady())) {
          send({ type: 'status', message: 'Reload the YouTube Music tab on the PC, then try again.' });
          if (cmd === 'search') {
            send({ type: 'results', query: value, results: [], error: 'Reload the YouTube Music tab on the PC' });
          }
          return;
        }
        toPage(cmd, value);
        if (cmd === 'search') return; // results come back asynchronously
        break;
      case 'get_state':
        if (await pageReady()) toPage('get_state');
        break;
      default:
        return;
    }
    // Give the page a moment to update, then report.
    setTimeout(() => report(true), 250);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (active && msg && msg.type === 'cmd') run(msg.cmd, msg.value).catch(() => {});
  });
})();
