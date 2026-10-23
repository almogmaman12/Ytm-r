// Runs in the PAGE's own JavaScript world on music.youtube.com (see manifest "world": "MAIN").
// It can use YT Music's own config and router, which the isolated content script cannot reach.
// Talks to content.js only through window.postMessage.

(() => {
  // After an extension update an older copy of this script may still be running in the tab.
  // Stop it, so exactly one copy (this one) answers.
  try { window.__ytmrAbort && window.__ytmrAbort.abort(); } catch { /* ignore */ }
  const ac = new AbortController();
  window.__ytmrAbort = ac;
  const sig = { signal: ac.signal };

  const ID_RE = /^[A-Za-z0-9_-]{11}$/;
  // Search filter parameter that restricts results to "Songs".
  const SONGS_FILTER = 'EgWKAQIIAWoKEAkQBRAKEAMQBA==';

  const post = (m) => window.postMessage({ source: 'ytmr-page', ...m }, location.origin);
  const status = (message) => post({ type: 'status', message });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const runsText = (runs) => (runs || []).map((r) => r.text).join('');
  const getPlayer = () => document.getElementById('movie_player');

  // ---- Search ----

  // videoId -> YT Music's own "Play next" command, taken from the search results.
  const playNextEndpoints = new Map();

  function findPlayNext(node) {
    if (!node || typeof node !== 'object') return null;
    const item = node.menuServiceItemRenderer;
    if (item && item.icon?.iconType === 'QUEUE_PLAY_NEXT' && item.serviceEndpoint) {
      return item.serviceEndpoint;
    }
    if (node.queueAddEndpoint?.queueInsertPosition === 'INSERT_AFTER_CURRENT_VIDEO') return node;
    for (const k in node) {
      const v = findPlayNext(node[k]);
      if (v) return v;
    }
    return null;
  }

  function collect(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return; }
    if (node.musicResponsiveListItemRenderer) out.push(node.musicResponsiveListItemRenderer);
    for (const k in node) collect(node[k], out);
  }

  function findVideoId(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.watchEndpoint && node.watchEndpoint.videoId) return node.watchEndpoint.videoId;
    for (const k in node) {
      const v = findVideoId(node[k]);
      if (v) return v;
    }
    return null;
  }

  function parse(json) {
    const items = [];
    collect(json, items);
    const seen = new Set();
    const results = [];
    for (const r of items) {
      // Songs/videos carry a videoId; albums and artists have a browse endpoint instead.
      const id = r.playlistItemData?.videoId ||
        (!r.navigationEndpoint?.browseEndpoint ? findVideoId(r.overlay) : null);
      if (!id || !ID_RE.test(id) || seen.has(id)) continue;
      const cols = r.flexColumns || [];
      const title = runsText(cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
      if (!title) continue;
      const ep = findPlayNext(r.menu);
      if (ep) {
        playNextEndpoints.delete(id);
        playNextEndpoints.set(id, ep);
        while (playNextEndpoints.size > 200) playNextEndpoints.delete(playNextEndpoints.keys().next().value);
      }
      const subtitle = runsText(cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs)
        .replace(/^(Song|Video)\s*•\s*/, '');
      const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      const thumb = thumbs.length ? thumbs[thumbs.length - 1].url : '';
      seen.add(id);
      results.push({ videoId: id, title, subtitle, thumb: String(thumb).startsWith('https://') ? thumb : '' });
      if (results.length >= 15) break;
    }
    return results;
  }

  async function search(query) {
    const cfg = window.ytcfg;
    const key = cfg?.get?.('INNERTUBE_API_KEY');
    const context = cfg?.get?.('INNERTUBE_CONTEXT');
    if (!key || !context) throw new Error("YouTube Music isn't ready yet. Wait a moment and try again");

    async function call(params) {
      const body = { context, query };
      if (params) body.params = params;
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(`/youtubei/v1/search?key=${encodeURIComponent(key)}&prettyPrint=false`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`Search failed (${res.status})`);
        return parse(await res.json());
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('Search timed out. Try again');
        throw e;
      } finally {
        clearTimeout(timeout);
      }
    }

    let results = await call(SONGS_FILTER);
    if (!results.length) results = await call(null); // fall back to unfiltered search
    return results;
  }

  // ---- Playing a song ----

  function currentVideoId() {
    try { return getPlayer()?.getVideoData?.()?.video_id || ''; } catch { return ''; }
  }

  async function waitForVideo(id, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (currentVideoId() === id) return true;
      await sleep(150);
    }
    return false;
  }

  // Starts a song WITHOUT reloading the page (a reload triggers Chrome's
  // "changes may not be saved" prompt). Tries several methods and checks which one worked.
  // Returns true if the song started.
  async function play(videoId) {
    if (!ID_RE.test(String(videoId))) return false;
    const endpoint = { watchEndpoint: { videoId } };
    const app = document.querySelector('ytmusic-app');
    const player = getPlayer();
    const canVerify = typeof player?.getVideoData === 'function';
    const attempts = [];

    if (app) {
      for (const name of ['navigate', 'navigate_']) {
        if (typeof app[name] === 'function') attempts.push([name, () => app[name](endpoint)]);
      }
      attempts.push(['yt-navigate event', () => app.dispatchEvent(
        new CustomEvent('yt-navigate', { detail: { endpoint }, bubbles: true, composed: true }))]);
    }
    if (player && typeof player.loadVideoById === 'function') {
      attempts.push(['player.loadVideoById', () => player.loadVideoById(videoId)]);
    }

    const tried = [];
    for (const [name, fn] of attempts) {
      tried.push(name);
      try { fn(); } catch { continue; }
      // If we can't read the player's current video, trust the first call that didn't throw.
      if (!canVerify || await waitForVideo(videoId, 2500)) {
        console.debug('[ytm-remote] started song via', name);
        return true;
      }
    }

    // Nothing worked. Keep the details for debugging, and do NOT reload the page.
    const navLike = [];
    for (let o = app; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) {
        if (/nav/i.test(k) && !navLike.includes(k)) navLike.push(k);
      }
    }
    console.warn('[ytm-remote] could not start song', { tried, navLike });
    status("Couldn't start that song. Reload the YouTube Music tab on the PC and try again.");
    return false;
  }

  // ---- "Play next" ----

  let upNext = [];          // fallback queue kept by this script: [{ videoId, title, subtitle, thumb }]
  let advancing = false;
  const known = new Map();  // videoId -> track info from recent searches

  const publishQueue = () => post({ type: 'queue', items: upNext });

  function remember(results) {
    for (const r of results) {
      known.delete(r.videoId);
      known.set(r.videoId, r);
    }
    while (known.size > 200) known.delete(known.keys().next().value);
  }

  // What YT Music's own queue currently shows, so we can tell whether an add worked.
  const queueCount = () => document.querySelectorAll('ytmusic-player-queue-item').length;

  function protoNames(obj, re) {
    const names = [];
    for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) {
        if (re.test(k) && !names.includes(k)) names.push(k);
      }
    }
    return names;
  }

  // Sends YT Music's own "Play next" command and checks that its queue grew.
  // Returns { ok: true, method } | { ok: false, reason }.
  async function addToYtQueue(videoId) {
    const ep = playNextEndpoints.get(videoId);
    if (!ep) return { ok: false, reason: 'search result had no Play next command' };
    const app = document.querySelector('ytmusic-app');
    if (!app) return { ok: false, reason: 'YT Music app element not found' };

    const shapes = [];
    if (typeof app.resolveCommand === 'function') {
      shapes.push(['resolveCommand', () => app.resolveCommand(ep)]);
    }
    shapes.push(['yt-service-request', () => app.dispatchEvent(new CustomEvent('yt-action', {
      detail: { actionName: 'yt-service-request', args: [app, ep], returnValue: [] },
      bubbles: true, composed: true,
    }))]);

    const tried = [];
    for (const [name, fn] of shapes) {
      const before = queueCount();
      tried.push(name);
      try { fn(); } catch { continue; }
      for (let i = 0; i < 8; i++) {
        await sleep(250);
        if (queueCount() > before) return { ok: true, method: name };
      }
      // If the queue isn't readable at all we can't tell, so don't keep re-sending.
      if (before === 0 && queueCount() === 0) {
        return { ok: false, reason: `couldn't verify (queue list not readable) after ${name}` };
      }
    }
    const names = protoNames(app, /command|queue|action|resolve|service/i).slice(0, 8).join(', ');
    return { ok: false, reason: `no change after ${tried.join(', ')}; page functions: ${names || 'none'}` };
  }

  async function enqueueNext(id) {
    if (!ID_RE.test(String(id))) return;
    const track = known.get(id) || { videoId: id, title: id, subtitle: '', thumb: '' };
    const r = await addToYtQueue(id);
    if (r.ok) {
      console.debug('[ytm-remote] added to YT Music queue via', r.method);
      status(`Added to YouTube Music's queue: ${track.title}`);
      return;
    }
    console.warn('[ytm-remote] using fallback queue:', r.reason);
    // "Play next" goes to the front and never duplicates.
    upNext = [track, ...upNext.filter((q) => q.videoId !== id)];
    publishQueue();
    status(`Added to Up next: ${track.title}`);
  }

  function dequeue(id) {
    upNext = upNext.filter((q) => q.videoId !== id);
    publishQueue();
  }

  async function playQueued() {
    const track = upNext.shift();
    publishQueue();
    if (!track) return;
    // If it could not start, keep it in the list instead of losing it.
    if (!(await play(track.videoId))) {
      upNext.unshift(track);
      publishQueue();
    }
  }

  function nextTrack() {
    if (upNext.length) { playQueued(); return; }
    document.querySelector('ytmusic-player-bar .next-button')?.click();
  }

  // Start the queued song just before the current one ends, so YT Music's own
  // autoplay doesn't get to pick something else. timeupdate is driven by playback,
  // so it keeps firing even when the tab is in the background.
  document.addEventListener('timeupdate', (ev) => {
    const v = ev.target;
    if (!(v instanceof HTMLVideoElement) || advancing || !upNext.length) return;
    if (!isFinite(v.duration) || v.duration < 5 || v.paused) return;
    if (v.duration - v.currentTime < 1.0) {
      advancing = true;
      playQueued().finally(() => setTimeout(() => { advancing = false; }, 4000));
    }
  }, { capture: true, ...sig });

  // ---- Messages from content.js ----

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'ytmr-ext') return;
    const { cmd, value } = ev.data;
    if (cmd === 'ping') {
      post({ type: 'hello' });
    } else if (cmd === 'search') {
      try {
        const results = await search(String(value));
        remember(results);
        post({ type: 'results', query: value, results });
      } catch (e) {
        post({ type: 'results', query: value, results: [], error: String((e && e.message) || e) });
      }
    } else if (cmd === 'play_video') {
      await play(value);
    } else if (cmd === 'play_next') {
      await enqueueNext(value);
    } else if (cmd === 'queue_remove') {
      dequeue(value);
    } else if (cmd === 'next') {
      nextTrack();
    } else if (cmd === 'get_state') {
      publishQueue();
    }
  }, sig);

  post({ type: 'hello' });
  publishQueue();
})();
