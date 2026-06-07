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

  const title = payload.notification?.title
    || payload.data?.title
    || 'عوالم 🌍';

  const body = payload.notification?.body
    || payload.data?.body
    || 'رسالة جديدة';

  const isDM = payload.data?.type === 'dm';

  self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: isDM
      ? 'dm-' + (payload.data?.fromUid || Date.now())
      : 'msg-' + Date.now(),
    data: payload.data || {},
    vibrate: [200, 100, 200],
    requireInteraction: false,
    dir: 'rtl',
    lang: 'ar'
  });
});

// عند الضغط على الإشعار
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('majed132010.github.io') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('https://majed132010.github.io');
    })
  );
});
