/* Deliberately scoped to /modules/milian-tarot/. No host page, API or user data caching. */
const CACHE = 'lego-milian-tarot-static-v2';
const FILES = ['index.html', 'style.css', 'app.js', 'core.js', 'storage.js', 'cache.js', 'prompts.js',
  'upstream/tarot/cards.js', 'upstream/tarot/spreads.js', 'upstream/tarot/reading.js', 'upstream/tarot/cardface.js',
  'upstream/tarot/LICENSE', 'upstream/companion/result.js', 'upstream/companion/LICENSE', 'THIRD_PARTY_NOTICES.md'];
const ALLOWED = new Set(FILES.map(file => new URL(file, self.registration.scope).pathname));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(file => new Request(new URL(file, self.registration.scope), { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('lego-milian-tarot-static-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !ALLOWED.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = new Request(url.origin + url.pathname);
    try {
      const response = await fetch(event.request);
      if (response.ok && response.type !== 'opaque') await cache.put(key, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(key);
      if (cached) return cached;
      throw error;
    }
  })());
});
