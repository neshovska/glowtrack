// GlowTrack Service Worker v5
// ЗАБЕЛЕЖКА: Firebase Messaging / push известия НЕ се обработват тук.
// Това се прави изцяло от firebase-messaging-sw.js, за да няма два SW,
// конкуриращи се за push събития на едно и също scope (причина за
// дублирани известия - виж git history за контекст).
const CACHE = 'glowtrack-v5';
const STATIC = ['./manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

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
