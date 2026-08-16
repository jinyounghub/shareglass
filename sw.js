const VERSION = 'shareglass-v1.0.0-star-readiness';
const LOCAL_ASSETS = [
  './', './index.html', './app.css', './manifest.webmanifest',
  './assets/shareglass-mark.svg', './assets/icon-192.png', './assets/icon-512.png',
  './src/app.js', './src/core/analyze.js', './src/core/c2pa.js',
  './src/core/findings.js', './src/core/hash.js', './src/core/report.js',
  './src/core/utils.js', './src/core/zip.js',
  './src/core/detectors/file-type.js', './src/core/detectors/image.js',
  './src/core/detectors/ooxml.js', './src/core/detectors/pdf.js',
  './src/core/sanitizers/image.js', './src/core/sanitizers/ooxml.js',
  './samples/private-photo.png', './samples/private-resume.docx', './samples/risky-contract.pdf'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(LOCAL_ASSETS.map((path) => new URL(path, self.registration.scope)))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then((cached) => {
    const network = fetch(event.request).then((response) => {
      if (response.ok) caches.open(VERSION).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => cached);
    return cached || network;
  }));
});
