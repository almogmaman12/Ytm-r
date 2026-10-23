// Runs in the PAGE's own JavaScript world on music.youtube.com (see manifest "world": "MAIN").
// It can use YT Music's own config and router, which the isolated content script cannot reach.
// Talks to content.js only through window.postMessage.

(() => {
  if (window.__ytmrPage) return;
  window.__ytmrPage = true;

  const ID_RE = /^[A-Za-z0-9_-]{11}$/;
  // Search filter parameter that restricts results to "Songs".
  const SONGS_FILTER = 'EgWKAQIIAWoKEAkQBRAKEAMQBA==';

  const post = (m) => window.postMessage({ source: 'ytmr-page', ...m }, location.origin);

  const runsText = (runs) => (runs || []).map((r) => r.text).join('');

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
    if (!key || !context) throw new Error('YT Music config not ready');

    async function call(params) {
      const body = { context, query };
      if (params) body.params = params;
      const res = await fetch(`/youtubei/v1/search?key=${encodeURIComponent(key)}&prettyPrint=false`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`search failed (${res.status})`);
      return parse(await res.json());
    }

    let results = await call(SONGS_FILTER);
    if (!results.length) results = await call(null); // fall back to unfiltered search
    return results;
  }

  function play(videoId) {
    if (!ID_RE.test(String(videoId))) return;
    // Use YT Music's own router so the page doesn't reload and playback continues smoothly.
    try {
      const app = document.querySelector('ytmusic-app');
      if (app && typeof app.navigate === 'function') {
        app.navigate({ watchEndpoint: { videoId } });
        return;
      }
    } catch {}
    location.href = `https://music.youtube.com/watch?v=${videoId}`;
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'ytmr-ext') return;
    const d = ev.data;
    if (d.cmd === 'search') {
      try {
        post({ type: 'results', query: d.query, results: await search(String(d.query)) });
      } catch (e) {
        post({ type: 'results', query: d.query, results: [], error: String(e.message || e) });
      }
    } else if (d.cmd === 'play_video') {
      play(d.videoId);
    }
  });
})();
