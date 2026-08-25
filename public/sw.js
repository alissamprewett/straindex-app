// sw.js — minimal service worker, just enough to make the app installable
// and a little faster on repeat visits.
//
// Deliberately conservative: this only caches truly static assets (CSS,
// JS, icons). It never caches HTML pages or /api/* responses, since almost
// everything in this app is personal, per-user data (check-ins, feeds,
// friends) -- caching that would risk showing someone stale or wrong
// information instead of what's actually true right now. A page simply
// won't load if the phone is fully offline; that's the right tradeoff
// here over accidentally serving stale personal data.

const CACHE_NAME = 'straindex-static-v1';
const STATIC_ASSETS = [
  '/app.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isStaticAsset = STATIC_ASSETS.includes(url.pathname) || url.pathname.startsWith('/icons/');
  if (!isStaticAsset || event.request.method !== 'GET') return; // let everything else hit the network normally

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      // Cache-first for speed, but always refresh the cache in the
      // background so a CSS/JS update doesn't get stuck forever.
      return cached || networkFetch;
    })
  );
});
