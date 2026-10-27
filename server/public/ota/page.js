// ytmr-payload page.js
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

  // ---- Regular YouTube (www.youtube.com) ----
  // Only the basics: volume, search for videos and a connection check. Everything else on this
  // file is about YouTube Music and is never started on this site.
  if (location.hostname === 'www.youtube.com') { liteYouTube(); return; }

  function liteYouTube() {
    let lastVol = null;
    const reportVol = (force) => {
      const pl = getPlayer();
      const v = typeof pl?.getVolume === 'function' ? pl.getVolume() : null;
      if (typeof v === 'number' && (force || v !== lastVol)) { lastVol = v; post({ type: 'volume', value: v }); }
    };
    const searchVideos = async (query) => {
      const json = await innertube('search', { query }, 10000);
      const out = [];
      const seen = new Set();
      const walk = (n) => {
        if (!n || typeof n !== 'object' || out.length >= 20) return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        const r = n.videoRenderer;
        if (r) {
          if (r.videoId && ID_RE.test(r.videoId) && !seen.has(r.videoId)) {
            seen.add(r.videoId);
            const arr = r.thumbnail?.thumbnails || [];
            const t = arr.length ? arr[arr.length - 1].url : '';
            const len = r.lengthText?.simpleText || '';
            out.push({ kind: 'song', videoId: r.videoId, title: runsText(r.title?.runs),
              subtitle: [runsText(r.ownerText?.runs), len].filter(Boolean).join(' • '),
              thumb: String(t).startsWith('https://') ? t : `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg` });
          }
          return;
        }
        for (const k in n) walk(n[k]);
      };
      walk(json);
      return out;
    };
    window.addEventListener('message', async (ev) => {
      if (ev.source !== window || !ev.data || ev.data.source !== 'ytmr-ext') return;
      const { cmd, value } = ev.data;
      if (cmd === 'ping') post({ type: 'hello' });
      else if (cmd === 'volume') {
        const pl = getPlayer(); const n = Math.min(100, Math.max(0, Number(value)));
        if (typeof pl?.setVolume === 'function' && isFinite(n)) { if (n > 0 && pl.isMuted?.()) pl.unMute?.(); pl.setVolume(n); reportVol(true); }
      } else if (cmd === 'search') {
        try {
          const text = String(value).replace(/^(song|album|artist|playlist)\|/, '');
          const kind = (/^(song|album|artist|playlist)\|/.exec(String(value)) || [])[1] || 'song';
          const results = kind === 'song' ? await searchVideos(text) : [];
          post({ type: 'results', query: value, results, error: kind === 'song' ? undefined : 'Only videos can be searched on regular YouTube' });
        } catch (e) { post({ type: 'results', query: value, results: [], error: String((e && e.message) || e) }); }
      } else if (cmd === 'health') {
        const checks = [];
        const test = async (name, fn) => { try { const r = await fn(); checks.push({ name, ok: !!r.ok, detail: String(r.detail || '') }); } catch (e) { checks.push({ name, ok: false, detail: String((e && e.message) || e) }); } };
        await test('Player', async () => { const pl = getPlayer(); return { ok: typeof pl?.getVideoData === 'function', detail: pl ? 'regular YouTube player found' : 'no player' }; });
        await test('Volume', async () => { const pl = getPlayer(); return { ok: typeof pl?.getVolume === 'function' && typeof pl?.setVolume === 'function', detail: 'getVolume/setVolume ' + (typeof pl?.setVolume === 'function' ? 'found' : 'missing') }; });
        await test('Search', async () => { const r = await searchVideos('love'); return { ok: r.length > 0, detail: `${r.length} videos found` }; });
        post({ type: 'health', checks });
      } else if (cmd === 'get_state') reportVol(true);
    }, sig);
    const iv = setInterval(() => reportVol(false), 1500);
    sig.signal.addEventListener('abort', () => clearInterval(iv));
    post({ type: 'hello' });
    reportVol(true);
  }

  // ---- Search ----

  // Search "filter" parameter per kind of result. If one is refused, the unfiltered search is
  // used and the results are sorted by kind afterwards.
  const SEARCH_FILTERS = {
    song: SONGS_FILTER,
    album: 'EgWKAQIYAWoMEA4QChADEAQQCRAF',
    artist: 'EgWKAQIgAWoMEA4QChADEAQQCRAF',
    playlist: 'Eg-KAQwIABAAGAAgACgBMABqChAEEAMQCRAFEAo=',
  };
  const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{2,64}$/;
  const BROWSE_ID_RE = /^(UC|MPREb_|VL)[A-Za-z0-9_-]{4,60}$/;

  // videoId -> YT Music's own "Play next" / "Add to queue" commands, taken from search results.
  const playNextEndpoints = new Map();
  const addEndEndpoints = new Map();

  function findQueueCommand(node, position) {
    if (!node || typeof node !== 'object') return null;
    const item = node.menuServiceItemRenderer;
    if (item?.serviceEndpoint?.queueAddEndpoint?.queueInsertPosition === position) return item.serviceEndpoint;
    if (node.queueAddEndpoint?.queueInsertPosition === position) return node;
    for (const k in node) {
      const v = findQueueCommand(node[k], position);
      if (v) return v;
    }
    return null;
  }

  function remember_(map, id, ep) {
    map.delete(id);
    map.set(id, ep);
    while (map.size > 200) map.delete(map.keys().next().value);
  }

  // Every song row and every album / playlist / artist card in a response.
  function collect(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return; }
    if (node.musicResponsiveListItemRenderer) out.push({ r: node.musicResponsiveListItemRenderer, two: false });
    if (node.musicTwoRowItemRenderer) out.push({ r: node.musicTwoRowItemRenderer, two: true });
    for (const k in node) collect(node[k], out);
  }

  function findKey(node, key) {
    if (!node || typeof node !== 'object') return null;
    if (node[key]) return node[key];
    for (const k in node) {
      const v = findKey(node[k], key);
      if (v) return v;
    }
    return null;
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

  // What kind of thing is this? Decided from ids, so it works in any language.
  function kindOf(browseId, playlistId) {
    if (/^MPREb/.test(browseId)) return 'album';
    if (/^UC/.test(browseId)) return 'artist';
    if (/^VL/.test(browseId)) return /^OLAK5uy/.test(playlistId || browseId.slice(2)) ? 'album' : 'playlist';
    if (/^OLAK5uy/.test(playlistId || '')) return 'album';
    return playlistId ? 'playlist' : '';
  }

  // Songs: { kind:'song', videoId, title, subtitle, thumb }
  // Albums / playlists: { kind, playlistId, title, subtitle, thumb }   (playable as a whole)
  // Artists: { kind:'artist', browseId, title, subtitle, thumb }       (can be opened)
  function parseAll(json, limit) {
    const found = [];
    collect(json, found);
    const seen = new Set();
    const out = [];
    for (const { r, two } of found) {
      let title; let subtitle; let thumbs; let videoId = ''; let browseId = ''; let playlistId = '';
      if (two) {
        title = runsText(r.title?.runs);
        subtitle = runsText(r.subtitle?.runs);
        thumbs = r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails;
        browseId = r.navigationEndpoint?.browseEndpoint?.browseId || '';
        videoId = r.navigationEndpoint?.watchEndpoint?.videoId || '';
        playlistId = findKey(r.thumbnailOverlay, 'watchPlaylistEndpoint')?.playlistId || '';
      } else {
        const cols = r.flexColumns || [];
        title = runsText(cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
        subtitle = runsText(cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
        thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
        browseId = r.navigationEndpoint?.browseEndpoint?.browseId || '';
        videoId = r.playlistItemData?.videoId || (!browseId ? findVideoId(r.overlay) || '' : '');
        playlistId = findKey(r.overlay, 'watchPlaylistEndpoint')?.playlistId || '';
      }
      if (!title) continue;
      if (!playlistId && /^VL/.test(browseId)) playlistId = browseId.slice(2);
      const arr = thumbs || [];
      const t = arr.length ? arr[arr.length - 1].url : '';
      const thumb = String(t).startsWith('https://') ? t : '';
      let item = null;
      if (videoId && ID_RE.test(videoId) && !/^(MPREb|UC)/.test(browseId)) {
        item = { kind: 'song', videoId, title, subtitle: subtitle.replace(/^(Song|Video)\s*•\s*/, ''), thumb };
        const next = findQueueCommand(r.menu, 'INSERT_AFTER_CURRENT_VIDEO');
        if (next) remember_(playNextEndpoints, videoId, next);
        const end = findQueueCommand(r.menu, 'INSERT_AT_END');
        if (end) remember_(addEndEndpoints, videoId, end);
      } else {
        const kind = kindOf(browseId, playlistId);
        if ((kind === 'album' || kind === 'playlist') && PLAYLIST_ID_RE.test(playlistId)) {
          item = { kind, playlistId, title, subtitle, thumb };
        } else if (kind === 'artist' && BROWSE_ID_RE.test(browseId)) {
          item = { kind, browseId, title, subtitle, thumb };
        }
      }
      if (!item) continue;
      const key = item.videoId || item.playlistId || item.browseId;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  }

  // The site proves who you are on personal requests with a signature made from one of your
  // own cookies (SAPISID). Returns the headers for it, or {} if the cookie isn't readable.
  async function authHeaders() {
    try {
      const jar = Object.fromEntries(document.cookie.split('; ').map((c) => { const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]; }));
      const sapisid = jar['SAPISID'] || jar['__Secure-3PAPISID'];
      if (!sapisid || !crypto?.subtle) return {};
      const ts = Math.floor(Date.now() / 1000);
      const origin = location.origin;
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${sapisid} ${origin}`));
      const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return { Authorization: `SAPISIDHASH ${ts}_${hash}`, 'X-Goog-AuthUser': '0', 'X-Origin': origin };
    } catch { return {}; }
  }

  // One call to YT Music's own API, signed in as you (the same way the site does it).
  // signed: also send the signature, needed for personal data such as your library.
  async function innertube(path, body, ms = 8000, signed = false) {
    const cfg = window.ytcfg;
    const key = cfg?.get?.('INNERTUBE_API_KEY');
    const context = cfg?.get?.('INNERTUBE_CONTEXT');
    if (!key || !context) throw new Error("YouTube Music isn't ready yet. Wait a moment and try again");
    const headers = { 'Content-Type': 'application/json', ...(signed ? await authHeaders() : {}) };
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(`/youtubei/v1/${path}?key=${encodeURIComponent(key)}&prettyPrint=false`, {
        method: 'POST', credentials: 'include', headers,
        body: JSON.stringify({ context, ...body }), signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`${path} failed (${res.status})`);
      return await res.json();
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('YouTube Music took too long. Try again');
      throw e;
    } finally { clearTimeout(timeout); }
  }

  async function search(query, kind = 'song') {
    if (!SEARCH_FILTERS[kind]) kind = 'song';
    const call = async (params) => {
      const body = { query };
      if (params) body.params = params;
      return parseAll(await innertube('search', body), 40).filter((i) => i.kind === kind);
    };
    let results = await call(SEARCH_FILTERS[kind]);
    if (!results.length) results = await call(null); // fall back to unfiltered search
    return results.slice(0, kind === 'song' ? 15 : 20);
  }

  // Phone-side library and artist pages.
  const LIBRARY_BROWSE = { home: 'FEmusic_home', playlists: 'FEmusic_liked_playlists', albums: 'FEmusic_liked_albums', history: 'FEmusic_history' };

  // The home page is a stack of shelves ("Listen again", "Mixed for you", ...), each with a title.
  function parseShelves(json) {
    const shelves = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const shelf = n.musicCarouselShelfRenderer || n.musicImmersiveCarouselShelfRenderer;
      if (shelf) {
        const head = shelf.header?.musicCarouselShelfBasicHeaderRenderer || shelf.header?.musicImmersiveCarouselShelfBasicHeaderRenderer;
        const title = runsText(head?.title?.runs);
        const items = parseAll(shelf.contents, 14);
        if (title && items.length) shelves.push({ title, items });
        return;
      }
      for (const k in n) walk(n[k]);
    };
    walk(json);
    return shelves.slice(0, 12);
  }

  async function loadLibrary(section) {
    const browseId = LIBRARY_BROWSE[section];
    if (!browseId) return;
    try {
      const json = await innertube('browse', { browseId }, 12000, true);
      if (section === 'home') {
        const shelves = parseShelves(json);
        if (!shelves.length) throw new Error('The home page had no shelves');
        post({ type: 'library', section, items: shelves.flatMap((s) => s.items).slice(0, 60), shelves });
        return;
      }
      // Recently played is a list of songs (each song once, newest first); the rest are albums and playlists.
      let items = parseAll(json, 60).filter((i) => (section === 'history' ? i.kind === 'song' : i.kind === 'album' || i.kind === 'playlist'));
      if (section === 'playlists') {
        items = items.filter((i) => i.playlistId !== 'LM');
        items.unshift({ kind: 'playlist', playlistId: 'LM', title: 'Liked songs', subtitle: 'Playlist', thumb: '' });
      }
      post({ type: 'library', section, items });
    } catch (e) {
      post({ type: 'library', section, items: [], error: String((e && e.message) || e) });
    }
  }

  // Songs similar to one: what the site's own radio for that song would play.
  async function relatedSongs(value) {
    const query = `related:${value}`;
    try {
      const id = value === 'current' ? currentVideoId() : String(value);
      if (!id || !ID_RE.test(id)) throw new Error('No song is playing');
      const json = await innertube('next', { videoId: id, playlistId: 'RDAMVM' + id, enablePersistentPlaylistPanel: true, isAudioOnly: true }, 12000);
      const out = [];
      const seen = new Set([id]);
      const walk = (n) => {
        if (!n || typeof n !== 'object' || out.length >= 25) return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        const r = n.playlistPanelVideoRenderer;
        if (r) {
          const vid = r.videoId;
          if (vid && ID_RE.test(vid) && !seen.has(vid)) {
            seen.add(vid);
            const arr = r.thumbnail?.thumbnails || [];
            const t = arr.length ? arr[arr.length - 1].url : '';
            out.push({ kind: 'song', videoId: vid, title: runsText(r.title?.runs), subtitle: runsText(r.shortBylineText?.runs),
              thumb: String(t).startsWith('https://') ? t : '' });
          }
          return;
        }
        for (const k in n) walk(n[k]);
      };
      walk(json);
      if (!out.length) throw new Error('YouTube Music found no similar songs');
      post({ type: 'results', query, results: out });
    } catch (e) {
      post({ type: 'results', query, results: [], error: String((e && e.message) || e) });
    }
  }

  // Search-as-you-type suggestions.
  async function suggest(text) {
    try {
      const json = await innertube('music/get_search_suggestions', { input: text }, 5000);
      const items = [];
      const walk = (n) => {
        if (!n || typeof n !== 'object' || items.length >= 8) return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (n.searchSuggestionRenderer) {
          const t = runsText(n.searchSuggestionRenderer.suggestion?.runs);
          if (t && !items.includes(t)) items.push(t);
          return;
        }
        for (const k in n) walk(n[k]);
      };
      walk(json);
      post({ type: 'suggest', query: text, items });
    } catch { post({ type: 'suggest', query: text, items: [] }); }
  }

  async function openBrowse(browseId) {
    const query = `open:${browseId}`;
    try {
      const json = await innertube('browse', { browseId }, 12000);
      post({ type: 'results', query, results: parseAll(json, 40) });
    } catch (e) {
      post({ type: 'results', query, results: [], error: String((e && e.message) || e) });
    }
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

  const urlVideo = () => { try { return new URLSearchParams(location.search).get('v') || ''; } catch { return ''; } };

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await sleep(120);
    }
    return !!fn();
  }

  // Starts a song WITHOUT reloading the page (a reload triggers Chrome's
  // "changes may not be saved" prompt). The song has to start the way a click on the site
  // would start it, so the page, the title and the queue all follow. Methods, in order:
  //  1. YT Music's own navigation (counts only if the page address really changes);
  //  2. add the song as "play next" in YT Music's own queue, then press Next;
  //  3. last resort: switch the audio only (the page and queue will NOT follow).
  // Returns true if the song started.
  // Starts something with YT Music's own navigation (the same thing a click on the site does).
  // Counts only if `followed()` becomes true, i.e. the page address really changed.
  async function tryNavigate(endpoint, followed) {
    const app = document.querySelector('ytmusic-app');
    if (!app) return '';
    const nav = [];
    for (const name of ['navigate', 'navigate_']) {
      if (typeof app[name] === 'function') nav.push([name, () => app[name](endpoint)]);
    }
    nav.push(['yt-navigate event', () => app.dispatchEvent(
      new CustomEvent('yt-navigate', { detail: { endpoint }, bubbles: true, composed: true }))]);
    for (const [name, fn] of nav) {
      try { fn(); } catch { continue; }
      if (await waitFor(followed, 2000)) {
        console.debug('[ytm-remote] navigated via', name);
        return name;
      }
    }
    return '';
  }

  async function play(videoId) {
    if (!ID_RE.test(String(videoId))) return false;
    const endpoint = { watchEndpoint: { videoId } };
    const app = document.querySelector('ytmusic-app');
    const player = getPlayer();
    const tried = [];
    const followed = () => urlVideo() === videoId;

    if (app && (await tryNavigate(endpoint, followed))) {
      await waitForVideo(videoId, 2500);
      return true;
    }

    // YT Music's own queue: insert after the current song, then go to it.
    const added = await addToYtQueue(videoId);
    tried.push('queue+next');
    if (added.ok) {
      document.querySelector('ytmusic-player-bar .next-button')?.click();
      if (await waitForVideo(videoId, 3500)) {
        console.debug('[ytm-remote] started song via queue+next');
        return true;
      }
    }

    if (player && typeof player.loadVideoById === 'function') {
      tried.push('player.loadVideoById');
      try { player.loadVideoById(videoId); } catch { /* fall through */ }
      if (await waitForVideo(videoId, 2500)) {
        console.warn('[ytm-remote] started song with audio only; the page may not follow', { tried });
        return true;
      }
    }

    console.warn('[ytm-remote] could not start song', { tried, addFailed: added.ok ? '' : added.reason });
    status("Couldn't start that song. Reload the YouTube Music tab on the PC and try again.");
    return false;
  }

  // ---- Volume ----

  // The player's own volume (0-100). Setting it the way the site's slider does keeps the
  // slider, the saved volume and the audio in step.
  function setVolume(value) {
    const n = Math.round(Number(value));
    if (!isFinite(n)) return;
    const vol = Math.min(100, Math.max(0, n));
    const player = getPlayer();
    try { if (vol > 0 && player?.isMuted?.()) player.unMute(); } catch { /* ignore */ }
    try { player?.setVolume?.(vol); } catch { /* ignore */ }
    const v = document.querySelector('video');
    if (v && !player?.setVolume) v.volume = vol / 100;
    // Move the site's own slider too, so what the PC shows matches.
    const slider = document.querySelector('ytmusic-player-bar #volume-slider');
    if (slider) {
      try {
        slider.value = vol;
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      } catch { /* ignore */ }
    }
    reportVolume(true);
  }

  let lastVol = null;
  function reportVolume(force) {
    let vol = null;
    try { vol = getPlayer()?.getVolume?.(); } catch { /* ignore */ }
    if (typeof vol !== 'number' || !isFinite(vol)) return;
    vol = Math.round(vol);
    if (!force && vol === lastVol) return;
    lastVol = vol;
    post({ type: 'volume', value: vol });
  }
  const volTimer = setInterval(() => reportVolume(false), 1000);
  ac.signal.addEventListener('abort', () => clearInterval(volTimer));
  document.addEventListener('volumechange', () => reportVolume(false), { capture: true, ...sig });

  // ---- "Play next" ----

  let upNext = [];          // fallback queue kept by this script: [{ videoId, title, subtitle, thumb }]
  let advancing = false;
  const known = new Map();  // videoId -> track info from recent searches

  const publishQueue = () => post({ type: 'queue', items: upNext });

  function remember(results) {
    for (const r of results) {
      if (r.kind !== 'song') continue;
      known.delete(r.videoId);
      known.set(r.videoId, r);
    }
    while (known.size > 200) known.delete(known.keys().next().value);
  }

  // What YT Music's own queue currently shows, so we can tell whether an add worked.
  const queueCount = () => document.querySelectorAll('ytmusic-player-queue-item').length;

  // YT Music keeps its queue in a small store on the queue element. Reading it is more
  // reliable than counting rows (rows may not exist while the side panel is closed).
  function ytQueueEl() {
    return document.querySelector('ytmusic-player-queue#queue') || document.getElementById('queue')
      || document.querySelector('ytmusic-player-queue');
  }
  function queueStore() {
    const q = ytQueueEl();
    return q?.queue?.store?.store || q?.store?.store || null;
  }
  function storeItems() {
    try {
      const items = queueStore()?.getState?.()?.queue?.items;
      return Array.isArray(items) ? items : null;
    } catch { return null; }
  }
  const queueLen = () => { const it = storeItems(); return it ? it.length : queueCount(); };
  const rendererOf = (item) => item?.playlistPanelVideoRenderer
    || item?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer || null;

  // ---- Show YT Music's own queue on the phone ----
  function trackOf(renderer) {
    const thumbs = renderer.thumbnail?.thumbnails || [];
    const thumb = (thumbs[thumbs.length - 1]?.url) || '';
    return {
      videoId: renderer.videoId,
      title: runsText(renderer.title?.runs) || String(renderer.title?.simpleText || ''),
      subtitle: runsText((renderer.shortBylineText || renderer.longBylineText)?.runs),
      thumb,
      by: addedBy.get(renderer.videoId) || '',
    };
  }

  // Finds a song in YT Music's queue from "position:videoId" (position counts from the first
  // song after the current one). The id is checked, so a queue that changed meanwhile is safe.
  function locateInQueue(ref) {
    const [ks, id] = String(ref).split(':'); // (a trailing :u / :d direction is ignored here)
    const k = Number(ks);
    const items = storeItems();
    if (!items || !ID_RE.test(id || '') || !isFinite(k)) return null;
    const idxs = [];
    items.forEach((it, i) => { const r = rendererOf(it); if (r && ID_RE.test(String(r.videoId))) idxs.push(i); });
    const rs = idxs.map((i) => rendererOf(items[i]));
    let at = rs.findIndex((r) => r.selected);
    if (at < 0) { const now = currentVideoId(); at = rs.findIndex((r) => r.videoId === now); }
    let pos = at + 1 + k;
    if (rs[pos]?.videoId !== id) {
      pos = rs.findIndex((r, j) => j > at && r.videoId === id);
      if (pos < 0) return null;
    }
    return { id, storeIndex: idxs[pos], steps: pos - at, rowIndex: pos,
      prevIndex: pos - 1 > at ? idxs[pos - 1] : -1, nextIndex: pos + 1 < idxs.length ? idxs[pos + 1] : -1 };
  }

  async function jumpInQueue(ref) {
    const hit = locateInQueue(ref);
    if (!hit) { status('That song is no longer in the queue.'); publishYtQueue(true); return; }
    const done = () => currentVideoId() === hit.id;
    if (done()) return;
    // 1. The site's own queue row, clicked the way you would on the PC.
    const row = document.querySelectorAll('ytmusic-player-queue-item')[hit.storeIndex];
    if (row) {
      const attempts = [
        () => row.querySelector('ytmusic-play-button-renderer')?.click(),
        () => row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true })),
      ];
      for (const go of attempts) {
        try { go(); } catch { continue; }
        if (await waitFor(done, 1500)) { publishYtQueue(true); return; }
      }
    }
    // 2. Press the site's Next button once per song in between.
    if (hit.steps < 1 || hit.steps > 15) { status("Couldn't jump to that song."); return; }
    const btn = document.querySelector('ytmusic-player-bar .next-button');
    for (let i = 0; i < hit.steps && !done(); i++) {
      btn?.click();
      await sleep(350);
    }
    if (!(await waitFor(done, 2500))) status("Couldn't jump to that song.");
    publishYtQueue(true);
  }

  async function removeFromQueue(ref) {
    const hit = locateInQueue(ref);
    const q = ytQueueEl();
    const store = queueStore();
    if (!hit || !q || !store) { status('That song is no longer in the queue.'); publishYtQueue(true); return; }
    const before = storeItems().length;
    const shapes = [hit.storeIndex, { index: hit.storeIndex }];
    for (const payload of shapes) {
      try {
        const action = { type: 'REMOVE_ITEM', payload };
        if (typeof q.dispatch === 'function') q.dispatch(action); else store.dispatch(action);
      } catch { continue; }
      if (await waitFor(() => (storeItems()?.length ?? before) < before, 1200)) { publishYtQueue(true); return; }
    }
    console.warn("[ytm-remote] couldn't remove from the site queue", hit);
    status("Couldn't remove that song from YouTube Music's queue.");
  }

  // Moves one song to another place in the queue ("from:videoId:to", positions counted from the
  // first song after the current one). The queue's own actions are used in pairs (remove, then
  // insert at the new place), and the result is checked.
  async function reorderQueue(value) {
    const to = Number(String(value).split(':')[2]);
    const hit = locateInQueue(value);
    const q = ytQueueEl();
    const store = queueStore();
    if (!hit || !q || !store || !isFinite(to)) { status('That song is no longer in the queue.'); publishYtQueue(true); return; }
    const items = storeItems();
    const idxs = [];
    items.forEach((it, i) => { const r = rendererOf(it); if (r && ID_RE.test(String(r.videoId))) idxs.push(i); });
    const here = idxs.indexOf(hit.storeIndex);          // this song's place among real songs
    const first = here - hit.steps + 1;                  // place of the first upcoming song
    const dest = Math.min(idxs.length - 1, Math.max(first, first + to));
    if (dest === here) { publishYtQueue(true); return; } // nothing to move
    const target = idxs[dest];
    const run = (action) => { if (typeof q.dispatch === 'function') q.dispatch(action); else store.dispatch(action); };
    const item = items[hit.storeIndex];
    const len = items.length;
    queueBusy = true;
    try {
      run({ type: 'REMOVE_ITEM', payload: hit.storeIndex });
      if (!(await waitFor(() => (storeItems()?.length ?? len) < len, 1200))) {
        run({ type: 'REMOVE_ITEM', payload: { index: hit.storeIndex } });
        if (!(await waitFor(() => (storeItems()?.length ?? len) < len, 1200))) throw new Error('remove failed');
      }
      const state = store.getState().queue;
      run({ type: 'ADD_ITEMS', payload: {
        nextQueueItemId: state.nextQueueItemId, index: target, items: [item], shuffleEnabled: false, shouldAssignIds: true } });
      if (!(await waitFor(() => (storeItems()?.length ?? 0) >= len, 1500))) throw new Error('re-insert failed');
    } catch (e) {
      console.warn("[ytm-remote] couldn't reorder the site queue", e);
      status("Couldn't reorder YouTube Music's queue.");
    } finally { queueBusy = false; }
    publishYtQueue(true);
  }

  const addedBy = new Map();   // videoId -> name of the phone that queued it
  const tagAdded = (id, by) => { if (!by) return; addedBy.delete(id); addedBy.set(id, by); while (addedBy.size > 300) addedBy.delete(addedBy.keys().next().value); };

  let lastQueueKey = null;
  let queueBusy = false;   // true while a reorder is half-done, so the phone never sees the gap
  // YouTube Music's "Autoplay" list: songs it will play when the queue runs out. They are not
  // queue entries (the queue itself can be empty), but the site shows them under "Up next", so
  // the phone shows them too, marked as autoplay. Read from the queue state, or failing that from
  // what the site's own queue panel is showing.
  function autoplayRenderers(currentId) {
    const out = [];
    const seen = new Set([currentId]);
    const add = (r) => { if (r && ID_RE.test(String(r.videoId)) && !seen.has(r.videoId) && out.length < 50) { seen.add(r.videoId); out.push(r); } };
    try {
      const st = queueStore()?.getState?.()?.queue;
      for (const k of Object.keys(st || {})) {
        if (!/automix|autoplay/i.test(k)) continue;
        const walk = (n, d) => {
          if (!n || typeof n !== 'object' || d > 7) return;
          if (Array.isArray(n)) { n.forEach((x) => walk(x, d + 1)); return; }
          const r = rendererOf(n);
          if (r) { add(r); return; }
          for (const kk in n) walk(n[kk], d + 1);
        };
        walk(st[k], 0);
      }
    } catch { /* state not readable */ }
    if (out.length) return out;
    try {
      let after = false;
      for (const el of document.querySelectorAll('ytmusic-player-queue-item')) {
        const d = el.data || el.__data?.data || {};
        const r = d.playlistPanelVideoRenderer || d;
        if (el.hasAttribute('selected') || r?.selected) { after = true; continue; }
        if (after) add(r);
      }
    } catch { /* panel not readable */ }
    return out;
  }

  function publishYtQueue(force) {
    if (queueBusy) return;
    const items = storeItems();
    if (!items) return;
    const rs = items.map(rendererOf).filter((r) => r && ID_RE.test(String(r.videoId)));
    let at = rs.findIndex((r) => r.selected);
    if (at < 0) { const now = currentVideoId(); at = rs.findIndex((r) => r.videoId === now); }
    const upcoming = rs.slice(at + 1, at + 51);
    const nowId = currentVideoId();
    const autos = autoplayRenderers(nowId).filter((r) => !upcoming.some((u) => u.videoId === r.videoId));
    const key = upcoming.map((r) => r.videoId).join(',') + '|' + autos.map((r) => r.videoId).join(',');
    if (!force && key === lastQueueKey) return;
    lastQueueKey = key;
    post({ type: 'ytqueue', items: [...upcoming.map(trackOf), ...autos.map((r) => ({ ...trackOf(r), auto: true }))] });
  }
  const ytqTimer = setInterval(() => publishYtQueue(false), 1500);
  ac.signal.addEventListener('abort', () => clearInterval(ytqTimer));

  // Without "selected": a song added to the queue must never look like the one playing.
  function unselect(item) {
    const r = item?.playlistPanelVideoRenderer;
    if (r) return { ...item, playlistPanelVideoRenderer: { ...r, selected: false } };
    const w = item?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
    if (w) {
      const wr = item.playlistPanelVideoWrapperRenderer;
      return { ...item, playlistPanelVideoWrapperRenderer: { ...wr, primaryRenderer: {
        ...wr.primaryRenderer, playlistPanelVideoRenderer: { ...w, selected: false } } } };
    }
    return item;
  }

  // Asks YT Music for the queue entries of songs (videoIds) or of a whole album / playlist
  // (playlistId): the same call the site makes when you add something to the queue.
  async function fetchQueueItems(body) {
    const json = await innertube('music/get_queue', body);
    const items = (json.queueDatas || []).map((d) => d && d.content).filter(Boolean);
    if (!items.length) throw new Error('get_queue returned nothing');
    return items.map(unselect);
  }

  // Fallback for lists: the "next" endpoint lists a playlist as queue entries too.
  async function nextItems(playlistId) {
    const json = await innertube('next', { playlistId, enablePersistentPlaylistPanel: true, isAudioOnly: true }, 12000);
    const out = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.playlistPanelVideoWrapperRenderer) {
        const p = n.playlistPanelVideoWrapperRenderer.primaryRenderer?.playlistPanelVideoRenderer;
        if (p) out.push(unselect({ playlistPanelVideoRenderer: p }));
        return;
      }
      if (n.playlistPanelVideoRenderer) { out.push(unselect({ playlistPanelVideoRenderer: n.playlistPanelVideoRenderer })); return; }
      for (const k in n) walk(n[k]);
    };
    walk(json);
    if (!out.length) throw new Error('next returned nothing');
    return out;
  }

  async function collectionItems(playlistId) {
    try { return await fetchQueueItems({ playlistId }); } catch { return nextItems(playlistId); }
  }

  // Inserts queue entries straight into YT Music's own queue: right after the current song
  // ('next') or at the very end ('end'). Checks that the queue actually grew.
  async function insertViaStore(items, where) {
    const q = ytQueueEl();
    const store = queueStore();
    if (!q || !store) return { ok: false, reason: 'queue element not found' };
    const state = store.getState()?.queue;
    const current = state?.items;
    if (!Array.isArray(current)) return { ok: false, reason: 'queue state not readable' };
    let index = current.length;
    if (where !== 'end') {
      const nowId = currentVideoId();
      let at = current.findIndex((it) => rendererOf(it)?.selected);
      if (at < 0 && nowId) at = current.findIndex((it) => rendererOf(it)?.videoId === nowId);
      index = at < 0 ? 0 : at + 1;
    }
    const before = queueLen();
    const action = { type: 'ADD_ITEMS', payload: {
      nextQueueItemId: state.nextQueueItemId, index, items, shuffleEnabled: false, shouldAssignIds: true } };
    try {
      if (typeof q.dispatch === 'function') q.dispatch(action); else store.dispatch(action);
    } catch (e) { return { ok: false, reason: 'dispatch failed: ' + String(e.message || e) }; }
    for (let i = 0; i < 8; i++) {
      await sleep(250);
      if (queueLen() > before) return { ok: true, method: 'queue store' };
    }
    return { ok: false, reason: 'queue did not grow after ADD_ITEMS' };
  }

  async function addViaQueueStore(videoId, where) {
    if (!ytQueueEl() || !queueStore()) return { ok: false, reason: 'queue element not found' };
    let items;
    try { items = await fetchQueueItems({ videoIds: [videoId] }); } catch (e) { return { ok: false, reason: String(e.message || e) }; }
    return insertViaStore(items, where);
  }

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
  async function addViaCommand(videoId, where) {
    const ep = (where === 'end' ? addEndEndpoints : playNextEndpoints).get(videoId);
    if (!ep) return { ok: false, reason: 'search result had no queue command' };
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
      const before = queueLen();
      tried.push(name);
      try { fn(); } catch { continue; }
      for (let i = 0; i < 8; i++) {
        await sleep(250);
        if (queueLen() > before) return { ok: true, method: name };
      }
      // If the queue isn't readable at all we can't tell, so don't keep re-sending.
      if (before === 0 && queueLen() === 0) {
        return { ok: false, reason: `couldn't verify (queue list not readable) after ${name}` };
      }
    }
    const names = protoNames(app, /command|queue|action|resolve|service/i).slice(0, 8).join(', ');
    return { ok: false, reason: `no change after ${tried.join(', ')}; page functions: ${names || 'none'}` };
  }

  // Adds a song to YT Music's own queue ('next' = after the current song, 'end' = last).
  // Tries the queue itself, then the site's own command.
  // Returns { ok: true, method } | { ok: false, reason }.
  async function addToYtQueue(videoId, where = 'next') {
    const a = await addViaQueueStore(videoId, where);
    if (a.ok) return a;
    const b = await addViaCommand(videoId, where);
    if (b.ok) return b;
    return { ok: false, reason: `queue: ${a.reason}; command: ${b.reason}` };
  }

  async function enqueue(id, where = 'next', by = '') {
    if (!ID_RE.test(String(id))) return;
    const track = { ...(known.get(id) || { videoId: id, title: id, subtitle: '', thumb: '' }), by };
    tagAdded(id, by);
    const r = await addToYtQueue(id, where);
    if (r.ok) {
      console.debug('[ytm-remote] added to YT Music queue via', r.method);
      publishYtQueue(true);
      status(`Added to YouTube Music's queue${where === 'end' ? ' (at the end)' : ''}: ${track.title}`);
      return;
    }
    console.warn('[ytm-remote] using fallback queue:', r.reason);
    // Never duplicates: "play next" goes to the front of the waiting list, "add to end" to the back.
    const rest = upNext.filter((q) => q.videoId !== id);
    upNext = where === 'end' ? [...rest, track] : [track, ...rest];
    publishQueue();
    status(`Added to Up next: ${track.title}`);
  }
  const enqueueNext = (id, by) => enqueue(id, 'next', by);

  // A whole album or playlist, after the current song or at the end of the queue.
  async function addCollection(playlistId, where, by = '') {
    if (!PLAYLIST_ID_RE.test(String(playlistId))) return;
    let items;
    try { items = await collectionItems(playlistId); } catch (e) {
      console.warn("[ytm-remote] couldn't load the list", e);
      status("Couldn't load that list from YouTube Music.");
      return;
    }
    items.forEach((it) => tagAdded(rendererOf(it)?.videoId, by));
    const r = await insertViaStore(items, where);
    if (r.ok) {
      publishYtQueue(true);
      status(where === 'end'
        ? `Added ${items.length} songs to the end of the queue`
        : `Added ${items.length} songs after the current one`);
    } else {
      console.warn("[ytm-remote] couldn't add the list:", r.reason);
      status("Couldn't add that to YouTube Music's queue.");
    }
  }

  // Starts an album / playlist as the new queue, the way clicking Play on the site does.
  async function playCollection(playlistId) {
    if (!PLAYLIST_ID_RE.test(String(playlistId))) return;
    const endpoint = { watchPlaylistEndpoint: { playlistId } };
    const followed = () => new URLSearchParams(location.search).get('list') === playlistId;
    if (await tryNavigate(endpoint, followed)) return;
    // Fallback: start its first song, then put the rest right after it.
    let items;
    try { items = await collectionItems(playlistId); } catch { items = []; }
    const first = rendererOf(items[0])?.videoId;
    if (first && (await play(first))) {
      if (items.length > 1) await insertViaStore(items.slice(1), 'next');
      publishYtQueue(true);
      return;
    }
    status("Couldn't start that. Reload the YouTube Music tab on the PC and try again.");
  }

  // Removes everything coming up (the current song stays), plus the phone-side waiting list.
  async function clearQueue() {
    upNext = [];
    publishQueue();
    const q = ytQueueEl();
    const store = queueStore();
    const items = storeItems();
    if (!q || !store || !items) { publishYtQueue(true); return; }
    const rs = items.map(rendererOf);
    let at = rs.findIndex((r) => r?.selected);
    if (at < 0) { const now = currentVideoId(); at = rs.findIndex((r) => r?.videoId === now); }
    const keep = at < 0 ? 0 : at + 1;
    if (items.length <= keep) { publishYtQueue(true); return; }
    queueBusy = true;
    try {
      // Highest position first, so the positions still to remove don't move.
      for (let i = items.length - 1; i >= keep; i--) {
        if (typeof q.dispatch === 'function') q.dispatch({ type: 'REMOVE_ITEM', payload: i });
        else store.dispatch({ type: 'REMOVE_ITEM', payload: i });
      }
      if (!(await waitFor(() => (storeItems()?.length ?? 0) <= keep, 2500))) status("Couldn't clear all of YouTube Music's queue.");
    } catch (e) {
      console.warn("[ytm-remote] couldn't clear the queue", e);
      status("Couldn't clear YouTube Music's queue.");
    } finally { queueBusy = false; }
    publishYtQueue(true);
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

  // ---- Do-not-play list ----
  // Songs and artists you never want to hear. Kept in this browser (YouTube Music's own site storage)
  // and checked every moment: when a blocked song starts, it is skipped.
  const BLOCK_KEY = 'ytmr_block';
  const normName = (s) => String(s || '').toLowerCase().replace(/\s*-\s*topic$/, '').replace(/\s*vevo$/, '').trim();
  let blocked = [];
  try {
    const a = JSON.parse(localStorage.getItem(BLOCK_KEY) || '[]');
    if (Array.isArray(a)) blocked = a.filter((b) => b && (b.kind === 'song' || b.kind === 'artist') && typeof b.id === 'string' && b.id).slice(0, 200)
      .map((b) => ({ kind: b.kind, id: b.id.slice(0, 90), title: String(b.title || b.id).slice(0, 120) }));
  } catch { /* none saved yet */ }
  const saveBlocked = () => { try { localStorage.setItem(BLOCK_KEY, JSON.stringify(blocked)); } catch { /* storage full or blocked */ } };
  const postBlocked = () => post({ type: 'blocklist', items: blocked });
  const explicit = new Set();           // songs you asked for yourself are never skipped
  let blockSeen = '', blockActed = '', pendingBlock = '';
  const skipTimes = [];

  function currentArtists() {
    const out = new Set();
    const byline = document.querySelector('ytmusic-player-bar .byline')?.textContent || '';
    byline.split('•')[0].split(/\s*(?:,|&| and )\s*/i).forEach((n) => { if (n.trim()) out.add(normName(n)); });
    try { const a = getPlayer()?.getVideoData?.()?.author; if (a) out.add(normName(a)); } catch { /* ignore */ }
    return out;
  }
  const isBlocked = (id, artists) => blocked.some((b) => (b.kind === 'song' ? b.id === id : artists.has(b.id)));

  function checkBlocked(now) {
    if (!blocked.length) return;
    const id = currentVideoId();
    if (!id || explicit.has(id)) return;
    const artists = currentArtists();
    const key = id + '|' + [...artists].join(',');
    // The artist line can lag a moment behind a new song: act only once it has stayed the same.
    if (!now && key !== blockSeen) { blockSeen = key; return; }
    if (key === blockActed) return;
    if (!isBlocked(id, artists)) { blockActed = key; return; }
    blockActed = key;
    const t = Date.now();
    while (skipTimes.length && t - skipTimes[0] > 10000) skipTimes.shift();
    if (skipTimes.length >= 4) {
      try { getPlayer()?.pauseVideo?.(); } catch { /* ignore */ }
      status('Everything coming up is on your do-not-play list, so playback was paused.');
      return;
    }
    skipTimes.push(t);
    status('Skipped a song from your do-not-play list');
    nextTrack();
  }
  const blockTimer = setInterval(() => checkBlocked(false), 700);
  sig.signal.addEventListener('abort', () => clearInterval(blockTimer));

  function blockCurrent(what) {
    const id = currentVideoId();
    if (!id) { status('Nothing is playing to block.'); return; }
    if (what === 'artist') {
      const name = (document.querySelector('ytmusic-player-bar .byline')?.textContent || '').split('•')[0].split(/\s*(?:,|&| and )\s*/i)[0].trim();
      if (!name) { status("Couldn't tell who the artist is."); return; }
      const key = normName(name);
      if (!blocked.some((b) => b.kind === 'artist' && b.id === key)) blocked.push({ kind: 'artist', id: key, title: name.slice(0, 120) });
    } else {
      const title = document.querySelector('ytmusic-player-bar .title')?.textContent?.trim() || id;
      if (!blocked.some((b) => b.kind === 'song' && b.id === id)) blocked.push({ kind: 'song', id, title: title.slice(0, 120) });
    }
    blocked = blocked.slice(-200);
    saveBlocked(); postBlocked();
    explicit.delete(id);
    checkBlocked(true);                // skip it right away if it is playing now
  }
  function unblock(value) {
    const i = String(value).indexOf(':');
    const kind = String(value).slice(0, i), id = String(value).slice(i + 1);
    blocked = blocked.filter((b) => !(b.kind === kind && b.id === id));
    saveBlocked(); postBlocked();
  }

  // ---- Messages from content.js ----

  // ---- Radio: endless songs like this one (the site's own "Start radio") ----
  async function startRadio(value) {
    const id = value === 'current' ? currentVideoId() : String(value);
    if (!ID_RE.test(id || '')) { status('Nothing is playing to start a radio from.'); return; }
    const playlistId = `RDAMVM${id}`;
    const followed = () => new URLSearchParams(location.search).get('list') === playlistId;
    if (await tryNavigate({ watchEndpoint: { videoId: id, playlistId } }, followed)) { status('Radio started'); return; }
    await playCollection(playlistId);   // same thing, started from the list instead
  }

  // ---- Health check: which parts of the site integration still work ----
  async function healthCheck(deep) {
    const checks = [];
    const test = async (name, fn) => {
      try { const r = await fn(); checks.push({ name, ok: !!r.ok, detail: String(r.detail || '') }); }
      catch (e) { checks.push({ name, ok: false, detail: String((e && e.message) || e) }); }
    };
    const player = getPlayer();
    await test('Player', async () => {
      const id = currentVideoId();
      return { ok: typeof player?.getVideoData === 'function', detail: id ? `playing ${id}` : (player ? 'player found, nothing playing' : 'no player') };
    });
    await test('Volume', async () => {
      if (typeof player?.getVolume !== 'function' || typeof player?.setVolume !== 'function') return { ok: false, detail: 'getVolume/setVolume missing' };
      const v = player.getVolume();
      player.setVolume(v);
      await sleep(200);
      return { ok: typeof v === 'number' && player.getVolume() === v, detail: `volume ${v}, set and read back` };
    });
    await test('Page navigation', async () => {
      const app = document.querySelector('ytmusic-app');
      const fns = ['navigate', 'navigate_'].filter((n) => typeof app?.[n] === 'function');
      return fns.length ? { ok: true, detail: `${fns.join(', ')} found (not run, so the song isn't interrupted)` }
        : { ok: false, detail: app ? 'no navigate function, only the event fallback is left' : 'ytmusic-app not found' };
    });
    await test('Queue (read)', async () => {
      const items = storeItems();
      return items ? { ok: true, detail: `${items.length} songs in the queue, ${autoplayRenderers(currentVideoId()).length} autoplay suggestions` } : { ok: false, detail: ytQueueEl() ? 'queue state not readable' : 'queue element not found' };
    });
    await test('Queue (change access)', async () => {
      const q = ytQueueEl();
      const ok = !!q && (typeof q.dispatch === 'function' || typeof queueStore()?.dispatch === 'function');
      return { ok, detail: ok ? 'dispatch available' : 'no dispatch function' };
    });
    await test('Search', async () => {
      const r = await search('love', 'song');
      return { ok: r.length > 0, detail: `${r.length} songs found` };
    });
    await test('Queue entries', async () => {
      const id = currentVideoId();
      if (!id) return { ok: true, detail: 'skipped, nothing is playing' };
      const items = await fetchQueueItems({ videoIds: [id] });
      return { ok: items.length > 0, detail: 'get_queue answered' };
    });
    await test('Library (signed in)', async () => {
      const h = await authHeaders();
      if (!h.Authorization) return { ok: false, detail: 'sign-in cookie not readable, library needs it' };
      const json = await innertube('browse', { browseId: LIBRARY_BROWSE.playlists }, 12000, true);
      const n = parseAll(json, 60).filter((i) => i.kind === 'playlist' || i.kind === 'album').length;
      return { ok: n > 0, detail: `${n} playlists found` };
    });
    await test('Home page', async () => {
      const shelves = parseShelves(await innertube('browse', { browseId: LIBRARY_BROWSE.home }, 12000, true));
      return { ok: shelves.length > 0, detail: `${shelves.length} shelves found` };
    });
    await test('Related songs', async () => {
      const id = currentVideoId();
      if (!id) return { ok: true, detail: 'skipped, nothing is playing' };
      const json = await innertube('next', { videoId: id, playlistId: 'RDAMVM' + id, enablePersistentPlaylistPanel: true, isAudioOnly: true }, 12000);
      const n = (JSON.stringify(json).match(/"playlistPanelVideoRenderer"/g) || []).length;
      return { ok: n > 1, detail: `${n} songs in the radio list` };
    });
    if (deep) {
      await test('Queue add and remove', async () => {
        const q = ytQueueEl(); const store = queueStore(); const before = storeItems()?.length;
        if (!q || !store || before == null) return { ok: false, detail: 'queue not readable' };
        const items = await fetchQueueItems({ videoIds: [currentVideoId()] });
        queueBusy = true;
        try {
          const added = await insertViaStore(items, 'end');
          if (!added.ok) return { ok: false, detail: 'add failed: ' + added.reason };
          const run = (a) => (typeof q.dispatch === 'function' ? q.dispatch(a) : store.dispatch(a));
          let removed = false;
          for (const payload of [before, { index: before }]) {
            run({ type: 'REMOVE_ITEM', payload });
            if (await waitFor(() => (storeItems()?.length ?? 0) <= before, 1200)) { removed = true; break; }
          }
          return removed ? { ok: true, detail: 'added a test copy at the end and removed it again' }
            : { ok: false, detail: 'added, but removing failed: one extra song may be at the end of the queue' };
        } finally { queueBusy = false; publishYtQueue(true); }
      });
    }
    const bad = checks.filter((c) => !c.ok).map((c) => c.name);
    console.log('[ytm-remote] health check', bad.length ? 'FAILED: ' + bad.join(', ') : 'all ok', checks);
    post({ type: 'health', checks });
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'ytmr-ext') return;
    const { cmd, value, by } = ev.data;
    if (cmd === 'ping') {
      post({ type: 'hello' });
    } else if (cmd === 'search') {
      try {
        // "kind|words" (kind = song, album, artist or playlist); plain words mean songs.
        const m = /^(song|album|artist|playlist)\|([\s\S]*)$/.exec(String(value));
        const results = await search(m ? m[2] : String(value), m ? m[1] : 'song');
        remember(results);
        post({ type: 'results', query: value, results });
      } catch (e) {
        post({ type: 'results', query: value, results: [], error: String((e && e.message) || e) });
      }
    } else if (cmd === 'volume') {
      setVolume(value);
    } else if (cmd === 'play_video') {
      explicit.add(String(value)); if (explicit.size > 30) explicit.delete(explicit.values().next().value);
      await play(value);
    } else if (cmd === 'play_next') {
      await enqueueNext(value, by);
    } else if (cmd === 'refresh') {
      publishQueue(); publishYtQueue(true); reportVolume(true); postBlocked();
    } else if (cmd === 'block_current') {
      blockCurrent(value === 'artist' ? 'artist' : 'song');
    } else if (cmd === 'block_remove') {
      unblock(String(value));
    } else if (cmd === 'block_list') {
      postBlocked();
    } else if (cmd === 'radio') {
      await startRadio(value);
    } else if (cmd === 'related') {
      await relatedSongs(String(value));
    } else if (cmd === 'suggest') {
      await suggest(String(value).slice(0, 60));
    } else if (cmd === 'health') {
      await healthCheck(value === 'deep');
    } else if (cmd === 'queue_end') {
      await enqueue(value, 'end', by);
    } else if (cmd === 'queue_clear') {
      await clearQueue();
    } else if (cmd === 'play_collection') {
      await playCollection(value);
    } else if (cmd === 'collection_next') {
      await addCollection(value, 'next', by);
    } else if (cmd === 'collection_end') {
      await addCollection(value, 'end', by);
    } else if (cmd === 'open') {
      if (BROWSE_ID_RE.test(String(value))) await openBrowse(String(value));
    } else if (cmd === 'library') {
      await loadLibrary(String(value));
    } else if (cmd === 'yt_jump') {
      await jumpInQueue(value);
    } else if (cmd === 'yt_reorder') {
      await reorderQueue(value);
    } else if (cmd === 'yt_remove') {
      await removeFromQueue(value);
    } else if (cmd === 'queue_remove') {
      dequeue(value);
    } else if (cmd === 'next') {
      nextTrack();
    } else if (cmd === 'get_state') {
      publishQueue();
      publishYtQueue(true);
    }
  }, sig);

  post({ type: 'hello' });
  publishQueue();
  reportVolume(true);
})();
