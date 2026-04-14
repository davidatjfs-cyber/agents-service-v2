const CACHE_NAME = 'hrms-pwa-v228';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/working-fixed.html',
  '/forecast.html',
  '/manifest.json',
  '/pwa-icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        await cache.addAll(PRECACHE_URLS);
      } catch (e) {
        for (const u of PRECACHE_URLS) {
          try {
            await cache.add(u);
          } catch (e2) {}
        }
      }
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())));
      self.clients.claim();
    })()
  );
});

function isApiRequest(url) {
  try {
    return url.pathname.startsWith('/api/');
  } catch (e) {
    return false;
  }
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req) return;
  if (req.method !== 'GET') return;
  if (req.headers && req.headers.has('range')) return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isApiRequest(url)) return;
  if (url.pathname.startsWith('/agents-admin/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          // Bypass HTTP cache so nginx always returns the latest HTML
          const fresh = await fetch(new Request(req, { cache: 'no-store' }));
          const cache = await caches.open(CACHE_NAME);
          try {
            await cache.put(req, fresh.clone());
          } catch (e) {}
          return fresh;
        } catch (e) {
          const cached = await caches.match(req);
          if (cached) return cached;
          const cachedRoot = await caches.match('/');
          if (cachedRoot) return cachedRoot;
          return new Response('离线：无法加载页面', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        try {
          await cache.put(req, fresh.clone());
        } catch (e) {}
        return fresh;
      } catch (e) {
        return cached || new Response('', { status: 504 });
      }
    })()
  );
});
