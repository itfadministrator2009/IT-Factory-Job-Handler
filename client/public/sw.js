// Work Desk service worker: lets the app be installed on a phone or computer and
// open quickly. Pages always come from the network when it's there (so updates
// show straight away); the last copy is used only when offline. Work Desk data
// (the API) is never stored here.
const CACHE = 'workdesk-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/logo.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // the API and anything else: straight to the network

  // Pages: network first, falling back to the saved app when offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))));
    return;
  }

  // Built files have a fingerprint in their name, so a saved copy is always right.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    })));
  }
});
