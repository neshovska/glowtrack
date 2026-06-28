// GlowTrack Service Worker v3
const CACHE = 'glowtrack-v3';
const STATIC = ['/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', e => {
  // Cache only non-HTML static assets
  // DO NOT cache index.html - let browser handle auth state
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
    // NO clients.claim() - this was breaking Firebase auth sessions
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always skip caching for:
  // - HTML pages (auth state must be fresh)
  // - Firebase/Google APIs
  // - POST/PUT/DELETE requests
  if(
    e.request.headers.get('accept')?.includes('text/html') ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('google') ||
    url.hostname.includes('gstatic') ||
    url.hostname.includes('firebaseapp') ||
    e.request.method !== 'GET'
  ) {
    e.respondWith(fetch(e.request).catch(() => {
      // Offline fallback for HTML
      if(e.request.headers.get('accept')?.includes('text/html')) {
        return caches.match('/index.html');
      }
      return new Response('', {status: 503});
    }));
    return;
  }

  // Cache-first for static assets (icons, manifest)
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
  if(e.data === 'skipWaiting') self.skipWaiting();
});
