// firebase-messaging-sw.js
// Трябва да е на корена на домейна (до index.html)
// Версия: 1.0 — GlowTrack FCM background notifications

importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAssUyJ9xhc9JfDbuKWjM9GLsqdlnrkFa8",
  authDomain: "after-care-treatment.firebaseapp.com",
  projectId: "after-care-treatment",
  storageBucket: "after-care-treatment.firebasestorage.app",
  messagingSenderId: "771928458805",
  appId: "1:771928458805:web:770106c907426147d1137c",
  measurementId: "G-XZFJ8ZK6B9"
});

const messaging = firebase.messaging();

// Background message handler — показва notification когато app-ът е затворен/на заден план
messaging.onBackgroundMessage(payload => {
  console.log('[firebase-messaging-sw.js] Background message:', payload);
  const { title, body, icon } = payload.notification || {};
  self.registration.showNotification(title || 'GlowTrack', {
    body: body || '',
    icon: icon || '/icon-192.png',
    badge: '/favicon-32.png',
    data: payload.data || {},
    tag: 'glowtrack-notif',
    renotify: true,
    requireInteraction: false,
  });
});

// При клик на notification — отваря app-а
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('glowtrack') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('https://glowtrack.eu/');
      }
    })
  );
});
