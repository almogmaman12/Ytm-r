// Minimal service worker so the page is installable. No caching of the app shell,
// so updates always load fresh.
self.addEventListener('fetch', () => {});
