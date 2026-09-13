// Tally service worker — lets the app open with no signal (e.g. in the freezer).
//
// The page is NETWORK-FIRST so a fresh upload always shows up when you have
// signal; the cache is only the fallback. Static assets are cache-first but
// revalidated in the background, so styles/app changes land on next launch.

const CACHE = 'tally-v3';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.json'];

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(SHELL.map(function (u) {
        return cache.add(u).catch(function () {});
      }));
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

  // Firebase handles its own offline behaviour
  if (/firebaseio\.com|googleapis\.com\/identitytoolkit|gstatic\.com\/firebasejs/.test(url.hostname + url.pathname)) {
    return;
  }

  const isPage = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');
  const sameOrigin = url.origin === self.location.origin;

  // The page and our own app files: network first so updates are never hidden
  if (isPage || (sameOrigin && /\.(js|css|json)$/.test(url.pathname))) {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(isPage ? './index.html' : req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(isPage ? './index.html' : req);
      })
    );
    return;
  }

  // Fonts, icons, scanner libraries: cache first
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
