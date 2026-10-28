// Keeps the phone page openable while the relay is asleep.
// Pages are always fetched fresh when the relay answers within a few seconds; if it doesn't
// (free hosting wakes up slowly) or is unreachable, the last copy is shown instead, and the page
// itself shows a "waking up" screen and keeps trying. Nothing else is cached.
const CACHE = 'shell-v1';
self.addEventListener('install', (e) => {
  // Keep a copy from the very first visit, so even the second open can work while the relay sleeps.
  e.waitUntil(caches.open(CACHE).then((c) => c.add('/')).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.mode !== 'navigate') return;
  const url = new URL(req.url);
  if (url.pathname !== '/') return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(req).then((res) => { if (res.ok) cache.put('/', res.clone()); return res; }).catch(() => null);
    const timeout = new Promise((r) => setTimeout(() => r(null), 3500));
    const first = await Promise.race([net, timeout]);
    if (first) return first;
    const cached = await cache.match('/');
    if (cached) return cached;
    return (await net) || Response.error();
  })());
});
