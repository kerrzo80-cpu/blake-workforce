// Workforce stale request and legacy session guard - 2026-10-06
// Keep app assets current; never cache authenticated API data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('blake-workforce-')).map(key => caches.delete(key))))
    .then(() => self.clients.claim())
));
