// ════ عوالم — Service Worker ════
const CACHE_NAME = 'awalem-v2';
const IMAGE_CACHE = 'awalem-images-v1';

const CACHE_URLS = [
  '',
  'index.html',
  'manifest.json',
  'https://fonts.googleapis.com/css2?family=Tajawal:wght@300;400;500;700;800;900&display=swap',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-storage-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js',
];

// Install
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(CACHE_URLS).catch(err => console.log('[SW] partial fail:', err))
    )
  );
  self.skipWaiting();
});

// Activate
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== IMAGE_CACHE).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // Firebase Realtime DB — لا كاش
  if (url.hostname.includes('firebaseio.com')) return;

  // Firebase Storage (الصور والفيديوهات) — كاش مع تحديث في الخلفية
  if (url.hostname.includes('firebasestorage.googleapis.com') || 
      url.hostname.includes('firebasestorage.app')) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          const fetchPromise = fetch(event.request).then(response => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => cached);
          // إرجاع الكاش فوراً إذا موجود، وتحديثه في الخلفية
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // HTML — Network first
  if (event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          caches.open(CACHE_NAME).then(c => c.put(event.request, response.clone()));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // باقي الملفات — Cache first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          caches.open(CACHE_NAME).then(c => c.put(event.request, response.clone()));
        }
        return response;
      }).catch(() => cached);
    })
  );
});

// Push notifications
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
  event.waitUntil(clients.openWindow(''));
});
