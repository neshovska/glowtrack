// GlowTrack Service Worker v2
const CACHE = 'glowtrack-v2';
const STATIC = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

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
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  
  // Always network-first for Firebase/API calls
  if(url.hostname.includes('firebase') || 
     url.hostname.includes('google') ||
     url.hostname.includes('gstatic') ||
     e.request.method !== 'GET') {
    e.respondWith(
      fetch(e.request).catch(() => new Response(JSON.stringify({error:'offline'}), {
        headers: {'Content-Type': 'application/json'}
      }))
    );
    return;
  }
  
  // Cache-first for static assets, network fallback
  e.respondWith(
    caches.match(e.request).then(cached => {
      if(cached) return cached;
      return fetch(e.request)
        .then(response => {
          if(response.ok && e.request.method === 'GET') {
            const clone = response.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return response;
        })
        .catch(() => caches.match('/index.html'));
    })
  );
});

// Handle offline/online messages
self.addEventListener('message', e => {
  if(e.data === 'skipWaiting') self.skipWaiting();
});
