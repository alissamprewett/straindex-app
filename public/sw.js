// sw.js — minimal service worker. Caches the app shell (CSS/JS/icons) so the
// icon/launch screen work offline-ish; page content itself always goes to
// the network first since it's dynamic (FAQ/recipes change).
//
// The shell assets use NETWORK-FIRST, not cache-first: this app is under
// active development, so app.css/app.js change often. A cache-first
// strategy would silently keep serving whatever version of app.js a
// browser first saw, forever — even after real server-side updates —
// since the cache key never has a reason to change. Network-first means
// every visit gets the current file when online, and only falls back to
// the cached copy if the network is genuinely unavailable.
const CACHE = 'straindex-shell-v2';
const SHELL = ['/app.css', '/app.js', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (SHELL.some(p => url.pathname === p)) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  }
  // Everything else (pages, API) goes straight to the network — this app's
  // content changes too often for an offline-first strategy to make sense yet.
});
