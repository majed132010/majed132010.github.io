// ════ عوالم — Service Worker v8 (إصلاح تحديث manifest.json) ════
const CACHE_NAME = 'awalem-v8';
const IMAGE_CACHE = 'awalem-images-v3';
const CACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/style.css',
  '/firebase-config.js',
  '/ui.js',
  '/notifications.js',
  '/voice.js',
  '/auth.js',
  '/servers.js',
  '/messages.js',
  '/dm.js',
  '/calls.js',
  '/push.js',
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
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
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

// ════ Push Notifications ════
// ✅ FIX #3: هذا الملف (sw.js) يعالج Push فقط عندما لا يكون firebase-messaging-sw.js نشطاً
// إذا كان firebase-messaging-sw.js مسجلاً، احذف مستمع push من هنا لمنع التكرار.
// الحل: sw.js يعمل كـ fallback فقط عندما لا يوجد FCM token.

// ✅ FIX #2: اسم الأيقونة الصحيح (icon192.png بدون شرطة)
const ICON_URL = '/icon192.png';
const BADGE_URL = '/icon192.png';

// كبح التكرار
const NOTIF_THROTTLE_MS = 4000;
const _lastShownByTag = {};
function _throttled(tag) {
  const now = Date.now();
  if (_lastShownByTag[tag] && now - _lastShownByTag[tag] < NOTIF_THROTTLE_MS) return true;
  _lastShownByTag[tag] = now;
  return false;
}


// رفض المكالمة من الخلفية
const REJECT_FN_URL = 'https://us-central1-awalim2-5bdb1.cloudfunctions.net/rejectCall';

async function rejectCallViaFunction(data) {
  const callId = data.callId;
  const secret = data.rejectSecret;
  if (!callId || !secret) {
    console.warn('[SW] رفض المكالمة: بيانات ناقصة (callId/rejectSecret)', data);
    return;
  }
  try {
    const r = await fetch(REJECT_FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId, secret })
    });
    if (r.ok) console.log('[SW] ✓ رُفضت المكالمة عبر الدالة السحابية:', callId);
    else console.error('[SW] ✖ رفضت الدالة الطلب:', r.status, await r.text().catch(() => ''));
  } catch (err) {
    console.error('[SW] ✖ فشل الاتصال بدالة rejectCall:', err);
  }
}

// ✅ FIX #6: notificationclick يعالج المكالمات بشكل صحيح (مثل firebase-messaging-sw.js)
self.addEventListener('notificationclick', event => {
  const data = event.notification.data || {};
  event.notification.close();

  if (event.action === 'reject') {
    event.waitUntil(rejectCallViaFunction(data));
    return;
  }

  if (event.action === 'close') return;

  // ✅ FIX #6: تمرير acceptCall عند الضغط على قبول المكالمة
  const openUrl = (event.action === 'accept' && data.callId)
    ? 'https://majed132010-github-io.vercel.app?acceptCall=' + encodeURIComponent(data.callId)
    : 'https://majed132010-github-io.vercel.app';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('majed132010-github-io.vercel.app') && 'focus' in client) {
          client.focus();
          // ✅ FIX #6: إرسال postMessage عند قبول المكالمة
          if (event.action === 'accept' && data.callId) {
            client.postMessage({ type: 'acceptCall', callId: data.callId });
          }
          return;
        }
      }
      return clients.openWindow(openUrl);
    })
  );
});
