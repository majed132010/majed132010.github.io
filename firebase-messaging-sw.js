importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');

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

// استقبال الإشعارات في الخلفية
messaging.onBackgroundMessage(payload => {
  const title = payload.notification?.title || payload.data?.title || 'عوالم';
  const body  = payload.notification?.body  || payload.data?.body  || 'رسالة جديدة';
  const icon  = payload.notification?.icon  || '/icon-192.png';

  self.registration.showNotification(title, {
    body,
    icon,
    badge: '/icon-192.png',
    tag: payload.data?.tag || 'awalem-msg',
    data: payload.data || {},
    vibrate: [200, 100, 200],
    requireInteraction: false
  });
});

// عند الضغط على الإشعار — افتح التطبيق
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
