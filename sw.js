// GlowTrack Service Worker v7
// ЕДИН файл за кеширане + Firebase Messaging (push известия).
// ВАЖНО: не регистрирай отделен firebase-messaging-sw.js на същия scope —
// браузърът позволява само един активен SW на scope, и всяка автоматична
// re-регистрация на този файл (при всяко зареждане на страницата) би
// изместила отделен push-worker и push известията биха спрели да работят
// без грешка (точно това се случи във v5 — виж git history).
//
// v7 — ПОПРАВКА: сървърът вече праща DATA-ONLY payload (виж functions/index.js),
// затова title/body се четат от payload.data, не от payload.notification.
// Причина: когато payload има `notification` поле, Firebase Web SDK автоматично
// показва системно известие САМ, паралелно с нашия onBackgroundMessage handler
// по-долу — 1 сървърно съобщение се превръщаше в 2 показани известия.

const CACHE = 'glowtrack-v7';
const STATIC = ['./manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

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

console.log('[sw.js] v7 активен — data-only dedup handler зареден.');

// Background message handler — показва notification когато app-ът е затворен/на заден план
messaging.onBackgroundMessage(payload => {
  console.log('[sw.js] Background message (data-only):', payload);
  const data = payload.data || {};
  const title = data.title || 'GlowTrack';
  const body = data.body || '';
  // tag-ът е уникален по notifId — ако въпреки всичко същото push събитие
  // пристигне повторно (напр. iOS at-least-once доставка), браузърът "събира"
  // двете показвания в едно вместо да покаже два отделни banner-а.
  const notifId = data.notifId || ('t' + Date.now());
  self.registration.showNotification(title, {
    body: body,
    icon: './icon-192.png',
    badge: './favicon-32.png',
    data: data,
    tag: 'glowtrack-' + notifId,
    renotify: false,
    requireInteraction: false,
  });

  // Показва червена точка върху PWA иконата (iOS 16.4+/поддържани браузъри)
  if (self.registration && 'setAppBadge' in self.registration) {
    self.registration.setAppBadge(1).catch(err => console.warn('setAppBadge failed:', err));
  }
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

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache HTML or Firebase — always fetch fresh
  if(
    e.request.headers.get('accept')?.includes('text/html') ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('google') ||
    url.hostname.includes('gstatic') ||
    url.hostname.includes('firebaseapp') ||
    e.request.method !== 'GET'
  ) {
    e.respondWith(
      fetch(e.request).catch(() => new Response('', {status: 503}))
    );
    return;
  }
  // Cache-first for static assets only
  e.respondWith(
    caches.match(e.request).then(cached => {
      if(cached) return cached;
      return fetch(e.request).then(response => {
        if(response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      }).catch(() => new Response('', {status: 503}));
    })
  );
});

self.addEventListener('message', e => {
  if(e.data === 'skipWaiting' || e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
