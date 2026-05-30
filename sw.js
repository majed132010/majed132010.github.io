// ════ عوالم — Service Worker ════
const CACHE_NAME = 'awalem-v1';
const CACHE_URLS = [
  '',
  'index.html',
  'manifest.json',
  'https://fonts.googleapis.com/css2?family=Tajawal:wght@300;400;500;700;800;900&display=swap',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-storage-compat.js',
];

// Install — cache core files
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_URLS).catch(err => {
        console.log('[SW] Cache addAll partial failure:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch — Network first, fall back to cache
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET and Firebase API requests (always need live data)
  if (event.request.method !== 'GET') return;
  if (url.hostname.includes('firebaseio.com')) return;
  if (url.hostname.includes('firebasestorage')) return;
  if (url.hostname.includes('googleapis.com') && url.pathname.includes('/rtdb')) return;

  // For HTML pages: Network first
  if (event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // For other assets: Cache first, then network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});

// Push notifications (future use)
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || 'عوالم', {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    dir: 'rtl',
    lang: 'ar',
    data: data
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('')
  );
});
