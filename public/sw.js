/* ent-3d service worker.
   JSON is network-first so copy edits reach phones on the next load.
   glb / webp are requested with ?v=<build id>, so cache-first is safe:
   a new build changes the URL. The cache name itself is the build id.
   Install calls skipWaiting; activate drops every other cache and claims clients.
*/
const BUILD = '__ENT3D_BUILD__';
const CACHE = `ent-3d-${BUILD}`;
const JSON_FILE = /\.json$/i;
const HEAVY = /\.(?:glb|gltf|webp|woff2)$/i;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (JSON_FILE.test(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (HEAVY.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(networkFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}
