const CACHE_NAME = 'jeddah-traffic-v1';
const ASSETS = [
    '/',
    '/index.html',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    e.respondWith(caches.match(e.request).then(response => {
        if (response) return response;
        return fetch(e.request).catch(() => {
            if (e.request.url.includes('tomtom.com')) {
                return new Response(JSON.stringify({ offline: true }), { headers: { 'Content-Type': 'application/json' }});
            }
        });
    }));
});

self.addEventListener('push', (e) => {
    const data = e.data?.json() || {};
    e.waitUntil(self.registration.showNotification(data.title || 'ابحث عن الكثافة', {
        body: data.body || 'تنبيه مروري',
        icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"%3E%3Crect fill="%23ff4757" width="192" height="192" rx="32"/%3E%3Ctext x="96" y="120" font-size="80" text-anchor="middle" fill="white"%3E🚨%3C/text%3E%3C/svg%3E',
        badge: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"%3E%3Crect fill="%23ff4757" width="192" height="192" rx="32"/%3E%3Ctext x="96" y="120" font-size="80" text-anchor="middle" fill="white"%3E🚨%3C/text%3E%3C/svg%3E',
        tag: data.tag || 'traffic-alert',
        requireInteraction: true,
        vibrate: [200, 100, 200]
    }));
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    e.waitUntil(clients.openWindow('/'));
});