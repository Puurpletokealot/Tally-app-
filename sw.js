// Tally service worker — lets the app open with no signal (e.g. in the freezer).
// Strategy: serve the cached page instantly, refresh it in the background when online.

const CACHE = 'tally-v1';
const SHELL = ['./', './index.html'];

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL).catch(function () {
        // A missing entry shouldn't block install
        return cache.add('./index.html').catch(function () {});
      });
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache Firebase traffic — it has its own offline handling
  if (/firebaseio\.com|googleapis\.com|gstatic\.com\/firebasejs/.test(url.hostname + url.pathname)) {
    return;
  }

  // Navigations: cache first so the app opens instantly and works offline
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(function (cached) {
        const network = fetch(req).then(function (res) {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
          }
          return res;
        }).catch(function () { return cached; });
        return cached || network;
      })
    );
    return;
  }

  // Everything else (fonts, scanner libraries): cache, then fall back to network
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res && res.ok && (url.protocol === 'https:' || url.protocol === 'http:')) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
    })
  );
});
