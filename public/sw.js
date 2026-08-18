// sw.js — minimal service worker. Caches the app shell so the icon/launch
// screen work offline-ish; page content itself always goes to the network
// first since it's dynamic (FAQ/recipes change).
const CACHE = 'straindex-shell-v1';
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
    event.respondWith(caches.match(event.request).then(r => r || fetch(event.request)));
  }
  // Everything else (pages, API) goes straight to the network — this app's
  // content changes too often for an offline-first strategy to make sense yet.
});
