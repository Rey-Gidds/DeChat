const CACHE_NAME = 'doors-cache-v1';
const ASSETS_TO_CACHE = [
  '/', // landing page
  '/index.html',
  '/doors.html',
  '/doors.css',
  '/index.css',
  '/doors.js',
  '/chat_room.js',
  '/about.html',
  '/about_page.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install & cache static files
self.addEventListener('install', (event) => {
  console.log('[ServiceWorker] Installing...');
  self.skipWaiting(); // optional: activate immediately

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[ServiceWorker] Caching static assets');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Activate & cleanup old caches
self.addEventListener('activate', (event) => {
  console.log('[ServiceWorker] Activating...');
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  return self.clients.claim();
});

// Serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedRes) => {
      return (
        cachedRes ||
        fetch(event.request).catch(() =>
          caches.match('/offline.html') // Optional offline fallback page
        )
      );
    })
  );
});

