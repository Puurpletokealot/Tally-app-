// Tally service worker — lets the app open with no signal (e.g. in the freezer).
//
// Navigation strategy is NETWORK-FIRST: when you have signal you always get the
// newest version, and the cached copy is only used when the network fails.
// (Cache-first would mean uploading a new index.html did nothing until the
// second launch, which is confusing and hides fixes.)

const CACHE = 'tally-v2';

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.add('./index.html').catch(function () {});
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

self.addEventListener('message', function (event) {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Firebase has its own offline handling — never touch it
  if (/firebaseio\.com|googleapis\.com\/identitytoolkit|gstatic\.com\/firebasejs/.test(url.hostname + url.pathname)) {
    return;
  }

  // The page itself: network first, cache as the safety net
  if (req.mode === 'navigate' || url.pathname.endsWith('index.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        }
        return res;
      }).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  // Fonts and scanner libraries: cache first, they don't change
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res && res.ok && url.protocol.startsWith('http')) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
    })
  );
});
