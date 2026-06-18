// ════ عوالم — Service Worker v5 (محدّث) ════
const CACHE_NAME = 'awalem-v6';
const IMAGE_CACHE = 'awalem-images-v3';
const CACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/firebase-config.js',
  '/js/ui.js',
  '/js/notifications.js',
  '/js/voice.js',
  '/js/auth.js',
  '/js/servers.js',
  '/js/messages.js',
  '/js/dm.js',
  '/js/calls.js',
  '/js/push.js',
  'https://fonts.googleapis.com/css2?family=Tajawal:wght@300;400;500;700;800;900&display=swap',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(CACHE_URLS).catch(() => {})
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== IMAGE_CACHE).map(k => {
          console.log('Deleting old cache:', k);
          return caches.delete(k);
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Firebase Realtime DB — لا كاش أبداً
  if (url.hostname.includes('firebaseio.com')) return;

  // Agora Token Server — لا كاش
  if (url.hostname.includes('railway.app')) return;

  // Cloudinary — لا كاش
  if (url.hostname.includes('cloudinary.com')) return;

  // Firebase Storage — كاش مع تحديث في الخلفية
  if (url.hostname.includes('firebasestorage')) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async cache => {
        const cached = await cache.match(event.request);
        try {
          const response = await fetch(event.request);
          if (response.ok) await cache.put(event.request, response.clone());
          return response;
        } catch {
          return cached || new Response('', { status: 408 });
        }
      })
    );
    return;
  }

  // ملفات JS و CSS — Network first
  if (url.pathname.startsWith('/js/') || url.pathname.startsWith('/css/')) {
    event.respondWith(
      fetch(event.request)
        .then(async response => {
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(event.request, response.clone());
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // HTML — Network first
  if (event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(event.request)
        .then(async response => {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, response.clone());
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
      return fetch(event.request).then(async response => {
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, response.clone());
        }
        return response;
      }).catch(() => new Response('', { status: 408 }));
    })
  );
});

// Push notifications — مع كبح التكرار
const NOTIF_THROTTLE_MS = 4000;
const _lastShownByTag = {};
function _throttled(tag) {
  const now = Date.now();
  if (_lastShownByTag[tag] && now - _lastShownByTag[tag] < NOTIF_THROTTLE_MS) return true;
  _lastShownByTag[tag] = now;
  return false;
}

self.addEventListener('push', event => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const d = data.data || {};
    const isCall = d.type === 'call';
    const tag = isCall
      ? 'call_' + (d.callId || '')
      : (d.type || 'msg') + '_' + (d.fromUid || d.serverId || '');

    // ✅ استخدام الأيقونة الصحيحة
    const iconUrl = '/icon-192.png';
    const badgeUrl = '/icon-192.png';

    event.waitUntil(
      self.registration.getNotifications({ tag }).then(existing => {
        if (existing.length || _throttled(tag)) return;
        return self.registration.showNotification(data.title || 'عوالم', {
          body: data.body || '',
          icon: iconUrl,
          badge: badgeUrl,
          dir: 'rtl',
          lang: 'ar',
          tag,
          requireInteraction: isCall,
          data: d
        });
      })
    );
  } catch(e) {
    console.error('Push error:', e);
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('majed132010-github-io.vercel.app') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('https://majed132010-github-io.vercel.app');
    })
  );
});
