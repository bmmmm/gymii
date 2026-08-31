// Network-first service worker: an online user always gets the freshest
// files (no stale-module hell, no cache-name bump per deploy); an offline
// user gets whatever was last fetched successfully. Relative URLs keep the
// app subpath-safe (e.g. GitHub Pages project sites).
const CACHE = 'gymii-v10'; // bumped: js/qr.js joined the shell (M3 QR pairing)
const SHELL = [
  './', 'index.html', 'manifest.webmanifest',
  'css/style.css',
  'js/app.js', 'js/store.js', 'js/train.js', 'js/plan.js', 'js/gym.js', 'js/history.js',
  'js/ai.js', 'js/settings.js', 'js/ui.js', 'js/chart.js', 'js/demo.js', 'js/map.js',
  'js/merge.js', 'js/sync.js', 'js/qr.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png',
  // template FILES are on-demand content and enter the cache when first
  // loaded (the fetch handler PUTs every ok response) — precaching only
  // the manifest keeps community template PRs out of this file entirely
  'templates/index.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      // respondWith(undefined) throws inside the worker — return a real
      // network error for anything that was never cached
      .catch(() => caches.match(e.request).then((hit) => hit ?? Response.error())),
  );
});
