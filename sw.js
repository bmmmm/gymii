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

// How long a gym's captive-portal wifi may stall before the cache answers.
// A dead network rejects at once; this is for the worse case where the
// connection accepts the request and then says nothing.
const NET_TIMEOUT_MS = 2500;

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  networkFirst(e);
});

function networkFirst(e) {
  const cached = caches.match(e.request);
  const network = fetch(e.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
    }
    return res;
  });
  // The escape hatch: after NET_TIMEOUT_MS a cached copy answers instead of
  // the spinner. Only a copy we actually hold, and never a `Cache-Control:
  // no-store` one — that keeps serve.py honest, since a slow localhost can
  // then never be masked by a stale module. Without a usable hit this
  // promise never settles at all and the network wins outright, so first
  // loads and on-demand template files still work on a slow line.
  const timeout = new Promise((resolve) => {
    setTimeout(() => cached.then((hit) => {
      if (hit && !/no-store/i.test(hit.headers.get('Cache-Control') || '')) resolve(hit);
    }), NET_TIMEOUT_MS);
  });
  // The put must land even when the cache won the race and the response
  // the page got is long since delivered.
  e.waitUntil(network.catch(() => {}));
  e.respondWith(
    // A network REJECTION beats the timer immediately, so hard offline
    // stays as fast as it ever was. respondWith(undefined) throws inside
    // the worker — anything never cached gets a real network error.
    Promise.race([network, timeout])
      .catch(() => cached.then((hit) => hit ?? Response.error())),
  );
}
