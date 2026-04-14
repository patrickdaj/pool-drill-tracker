const CACHE_NAME = 'pool-drill-v17';
const ASSETS = [
  './',
  './index.html',
  './stats.html',
  './styles.css',
  './stats.css',
  './app.js',
  './stats.js',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg',
  './bank-positions.yaml',
  './dual-positions.yaml',
  './excluded-positions.yaml',
  './pocket-targets.yaml'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
