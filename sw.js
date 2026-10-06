// Minimal service worker. It only exists so browsers treat the site as an installable app; it caches nothing and
// never answers requests itself, so every load still comes straight from the network (no stale game code).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* pass through to the network */ });
