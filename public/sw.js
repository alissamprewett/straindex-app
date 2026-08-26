// sw.js — minimal service worker, just enough to make the app installable
// and a little faster on repeat visits.
//
// Deliberately conservative: this only caches truly static assets (CSS,
// JS, icons). It never caches HTML pages or /api/* responses, since almost
// everything in this app is personal, per-user data (check-ins, feeds,
// friends) -- caching that would risk showing someone stale or wrong
// information instead of what's actually true right now.
//
// IMPORTANT: app.css and app.js are under active development and change
// often. They use network-first: always try to fetch the latest version,
// and only fall back to the cached copy if the network request fails
// (actually offline). An earlier version of this file used cache-first
// for everything, which meant a browser could keep running old,
// already-fixed-server-side-but-not-client-side JavaScript for a while
// after every deploy -- exactly the kind of bug that's invisible until
// someone hits a real behavior change and it looks broken. Icons don't
// change this often, so they stay cache-first for speed.

const CACHE_NAME = 'straindex-static-v2';
const CODE_ASSETS = ['/app.css', '/app.js', '/manifest.json'];
const ICON_ASSETS = ['/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([...CODE_ASSETS, ...ICON_ASSETS])).catch(() => {})
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
  if (event.request.method !== 'GET') return; // let everything else hit the network normally

  if (CODE_ASSETS.includes(url.pathname)) {
    // Network-first: always prefer the live version. Only reach for the
    // cache if the network genuinely fails (offline).
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  const isIcon = ICON_ASSETS.includes(url.pathname) || url.pathname.startsWith('/icons/');
  if (isIcon) {
    // Cache-first is fine here -- icons rarely change, so favor speed.
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
