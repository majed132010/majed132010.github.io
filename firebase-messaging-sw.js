// Firebase Messaging Service Worker — عوالم (محدّث)
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// ⚠️ يجب أن يطابق هذا الإعداد إعداد العميل في firebase-config.js (مشروع awalim2-5bdb1)
firebase.initializeApp({
  apiKey: "AIzaSyCmZPRoEt3IDFxeH-aqvYQIi5dGOmFlS5Y",
  authDomain: "awalim2-5bdb1.firebaseapp.com",
  databaseURL: "https://awalim2-5bdb1-default-rtdb.firebaseio.com",
  projectId: "awalim2-5bdb1",
  storageBucket: "awalim2-5bdb1.firebasestorage.app",
  messagingSenderId: "939518942115",
  appId: "1:939518942115:web:404307d7b8e0677c335816"
});
const messaging = firebase.messaging();

// كبح تكرار الإشعارات: آخر وقت عرض لكل tag
const NOTIF_THROTTLE_MS = 10000;
const _lastShownByTag = {};
function _throttled(tag) {
  const now = Date.now();
  if (_lastShownByTag[tag] && now - _lastShownByTag[tag] < NOTIF_THROTTLE_MS) return true;
  _lastShownByTag[tag] = now;
  return false;
}

// استقبال الإشعارات عندما يكون التطبيق في الخلفية
messaging.onBackgroundMessage(payload => {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    if (clients.length > 0) return; // app is open, skip

    const data = payload.data || {};
    const title = data.title || (payload.notification && payload.notification.title) || '🔥 عوالم';
    const body = data.body || (payload.notification && payload.notification.body) || 'لديك إشعار جديد';

    // ✅ تم إصلاح مسارات الأيقونات — تستخدم الأيقونات من manifest
    const iconUrl = '/icon-192.png';
    const badgeUrl = '/icon-192.png';

    // مكالمة واردة
    if (data.type === 'call') {
      const tag = 'call_' + (data.callId || '');
      return self.registration.getNotifications({ tag }).then(existing => {
        if (existing.length || _throttled(tag)) return;
        return self.registration.showNotification(title, {
          body,
          icon: iconUrl,
          badge: badgeUrl,
          dir: 'rtl', lang: 'ar',
          vibrate: [300, 150, 300, 150, 300],
          tag,
          requireInteraction: true,
          data,
          actions: [
            { action: 'accept', title: 'قبول ✅' },
            { action: 'reject', title: 'رفض ❌' }
          ]
        });
      });
    }

    // إشعار عادي
    const tag = (data.type || 'msg') + '_' + (data.fromUid || data.serverId || '');
    if (_throttled(tag)) return;
    self.registration.showNotification(title, {
      body,
      icon: iconUrl,
      badge: badgeUrl,
      dir: 'rtl', lang: 'ar',
      vibrate: [200, 100, 200],
      tag,
      data,
      actions: [
        { action: 'open', title: 'فتح عوالم' },
        { action: 'close', title: 'إغلاق' }
      ]
    });
  });
});

// رفض المكالمة من الخلفية
const REJECT_FN_URL = "https://us-central1-awalim2-5bdb1.cloudfunctions.net/rejectCall";

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

// عند الضغط على الإشعار
self.addEventListener('notificationclick', e => {
  const data = e.notification.data || {};
  e.notification.close();

  if (e.action === 'reject') {
    e.waitUntil(rejectCallViaFunction(data));
    return;
  }

  if (e.action === 'close') return;

  const openUrl = (e.action === 'accept' && data.callId)
    ? `https://majed132010-github-io.vercel.app?acceptCall=${encodeURIComponent(data.callId)}`
    : 'https://majed132010-github-io.vercel.app';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('majed132010-github-io.vercel.app')) {
          client.focus();
          if (e.action === 'accept') client.postMessage({ type: 'acceptCall', callId: data.callId });
          return;
        }
      }
      return clients.openWindow(openUrl);
    })
  );
});
