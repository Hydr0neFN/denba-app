const V = 'denba-v33';
const ASSETS = ['/', '/static/style.css', '/static/app.js', '/static/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(ASSETS.map(u => fetch(new Request(u, {cache:'reload'})).then(r => c.put(u, r))))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(V).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
