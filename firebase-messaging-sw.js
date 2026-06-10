importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyCmZPRoEt3IDFxeH-aqvYQIi5dGOmFlS5Y",
  authDomain: "awalim2-5bdb1.firebaseapp.com",
  databaseURL: "https://awalim2-5bdb1-default-rtdb.firebaseio.com",
  projectId: "awalim2-5bdb1",
  storageBucket: "awalim2-5bdb1.firebasestorage.app",
  messagingSenderId: "939518942115",
  appId: "1:939518942115:web:404307d7b8e0677c335816"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// استقبال إشعارات FCM في الخلفية
messaging.onBackgroundMessage(payload => {
  console.log('Background message received:', payload);
  const data = payload.data || {};

  // ═══ مكالمة واردة — إشعار عالي الأولوية برنين واهتزاز صارم وأزرار قبول/رفض ═══
  if (data.type === 'call') {
    const caller = data.fromName || payload.notification?.title || 'مستخدم';
    const kind = data.callType === 'video' ? 'مكالمة فيديو' : 'مكالمة صوتية';
    self.registration.showNotification('📞 مكالمة واردة...', {
      body: caller + ' يتصل بك — ' + kind,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'call-' + (data.callId || data.fromUid || Date.now()),
      data: data,
      // اهتزاز صارم مستمر يحاكي الرنين
      vibrate: [500, 200, 500, 200, 500, 200, 500, 200, 500],
      requireInteraction: true, // لا يختفي إلا بتفاعل المستخدم
      renotify: true,
      dir: 'rtl',
      lang: 'ar',
      actions: [
        { action: 'accept', title: 'قبول ✅' },
        { action: 'reject', title: 'رفض ❌' }
      ]
    });
    return;
  }

  // ═══ بقية الإشعارات (رسائل القنوات / الرسائل الخاصة) ═══
  const title = payload.notification?.title || data.title || 'عوالم 🌍';
  const body = payload.notification?.body || data.body || 'رسالة جديدة';
  const isDM = data.type === 'dm';

  self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: isDM ? 'dm-' + (data.fromUid || Date.now()) : 'msg-' + Date.now(),
    data: data,
    vibrate: [200, 100, 200],
    requireInteraction: false,
    dir: 'rtl',
    lang: 'ar'
  });
});

// عند الضغط على الإشعار أو أحد أزراره
self.addEventListener('notificationclick', event => {
  const action = event.action; // 'accept' | 'reject' | '' (نقر على جسم الإشعار)
  const data = event.notification.data || {};
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // أبلغ أي نافذة مفتوحة بقرار المستخدم (لتنفيذ القبول/الرفض في سياق مصادَق)
      const msg = { type: 'call_action', action: action || 'open', data };
      for (const client of list) {
        if (client.url.includes('majed132010.github.io')) {
          client.postMessage(msg);
          // الرفض لا يتطلب فتح/تركيز التطبيق
          if (action === 'reject') return;
          if ('focus' in client) return client.focus();
        }
      }
      // لا توجد نافذة مفتوحة: افتح التطبيق (إلا عند الرفض)
      if (action === 'reject') return;
      const url = 'https://majed132010.github.io/'
        + (data.type === 'call' ? '?call=' + (action === 'accept' ? 'accept' : 'open') + '&from=' + (data.fromUid || '') : '');
      return clients.openWindow(url);
    })
  );
});
