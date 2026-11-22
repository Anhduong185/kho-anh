// Minimal PWA service worker stub (enables standalone install on iOS/Android/Windows).
// Never caches private media or authenticated API responses.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
