// Keeps the reporting app usable with weak or no network: the app shell is cached,
// and every state/LGA/ward/unit list someone has opened is remembered.
const SHELL = 'ivote-shell-v3';
const DATA = 'ivote-data-v1';
const FILES = ['/', '/style.css', '/app.js', '/manifest.json', '/icon.svg', '/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, DATA].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const LOOKUPS = /^\/api\/(states|lgas|wards|pus|pu|meta|ballot)$/;

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Lookups: network first, fall back to what we saw before.
  if (LOOKUPS.test(url.pathname)) {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(DATA).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then((r) => r || new Response(JSON.stringify({ error: 'No network' }), { status: 503, headers: { 'content-type': 'application/json' } }))));
    return;
  }
  // Party logos and candidate photos rarely change: serve from cache, fetch once.
  if (url.pathname.startsWith('/img/') || url.pathname.startsWith('/api/candidate-photo/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(DATA).then((c) => c.put(e.request, copy)); }
      return r;
    })));
    return;
  }
  // App shell: network first so updates show, cache when offline.
  if (FILES.includes(url.pathname)) {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
