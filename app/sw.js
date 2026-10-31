/* The writing app's service worker. It does two things.

   It lets Chrome offer to install the app: an installed app window is where
   Cmd+1..9 reach the page's own article tabs instead of Chrome's.

   And it lets the app open with no network. The page shell and the last copy
   of each article read are kept on this device: the article list
   (GET /api/pieces) and each article (GET /api/piece?path=...) are asked of
   the network first, every time, and the kept copy answers only when the
   network cannot. Saves never come here as anything but a request passed
   straight through: no POST and no other /api/ path is ever kept or answered
   from a copy. What is typed while the server is away is kept by the page's
   own journal (engine/keep.js), not by this worker.

   A reviewer's page (/review/ on the reviewers' listener) keeps nothing: an
   article shared for review is not left on a reviewer's device.

   On activation it clears every Cache Storage on this origin that is not its
   own: a port reused by another local app can leave one behind that would
   otherwise keep answering. */
'use strict';

var SHELL = 'castor-shell-v2';
var ARTICLES = 'castor-articles-v2';
var OURS = [SHELL, ARTICLES];
var KEPT_API = ['/api/piece', '/api/pieces'];
var LAST_PAGE = '/__castor-last-page';     // the last page opened here, for "/" with no network

var OFFLINE = '<!doctype html><html lang="en"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="color-scheme" content="light dark"><title>Offline</title>' +
  '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;' +
  'background:light-dark(#FAF9F4,#141311);color:light-dark(#14130F,#E9E6DF);' +
  'font:15px/1.55 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}' +
  'p{max-width:30rem;margin:0;padding:0 1.25rem}</style>' +
  '<p>The writing app cannot reach its server, and this device has not opened it ' +
  'before, so there is nothing kept here to show. Reload once the server is running.</p></html>';

self.addEventListener('install', function (event) {
  event.waitUntil(prepareFirstVisit().then(function () { return self.skipWaiting(); }));
});

function prepareFirstVisit() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    var pages = clients.map(function (client) { return new URL(client.url); }).filter(function (url) {
      return url.origin === self.location.origin && url.pathname.indexOf('/review/') !== 0;
    });
    if (!pages.length) return;
    return networkFirst(self.location.origin + '/api/pieces', ARTICLES, self.location.origin + '/api/pieces', true)
      .then(function (response) { return response.clone().json(); })
      .then(function (pieces) {
        return Promise.all(pages.map(function (url) {
          if (url.pathname === '/') url = new URL('/typewell/' + url.search, url.origin);
          var path = url.searchParams.get('live') || (Array.isArray(pieces) && pieces[0] && pieces[0].path);
          var work = [navigate(url.href, url, true)];
          if (path) {
            var piece = url.origin + '/api/piece?path=' + encodeURIComponent(path);
            work.push(networkFirst(piece, ARTICLES, piece, true));
          }
          return Promise.all(work);
        }));
      });
  }).catch(function () { /* a later online navigation can prepare a failed install */ });
}

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return OURS.indexOf(k) < 0; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function fromReviewPage(request, url) {
  if (url.pathname.indexOf('/review/') === 0) return true;
  try { return new URL(request.referrer).pathname.indexOf('/review/') === 0; } catch (e) { return false; }
}

/* A copy that can be stored and served again: no redirect flag (a navigation
   refuses a redirected response) and no encoding header (the body is already
   decoded). */
function keepable(response) {
  return response.blob().then(function (body) {
    var headers = new Headers(response.headers);
    headers.delete('Content-Encoding');
    headers.delete('Content-Length');
    return new Response(body, { status: response.status, statusText: response.statusText, headers: headers });
  });
}

function networkFirst(request, cacheName, key, keep) {
  return fetch(request).then(function (response) {
    if (keep && response.ok) {
      var copy = response.clone();
      return keepable(copy).then(function (stored) {
        return caches.open(cacheName).then(function (cache) { return cache.put(key, stored); });
      }).catch(function () { /* the network answer still goes to the page */ })
        .then(function () { return response; });
    }
    return response;
  }, function (error) {
    return caches.open(cacheName)
      .then(function (cache) { return cache.match(key, { ignoreVary: true }); })
      .then(function (hit) { if (hit) return hit; throw error; });
  });
}

/* Pages: the network first; offline, the kept shell (the page reads ?live=
   itself, so one copy of /typewell/ serves every article). "/" is a redirect
   on the server; offline it opens the last page opened here. */
function navigate(request, url, keep) {
  return fetch(request).then(function (response) {
    if (keep && response.ok && url.pathname !== '/') {
      var copy = response.clone();
      return keepable(copy).then(function (stored) {
        return caches.open(SHELL).then(function (cache) {
          return Promise.all([
            cache.put(url.origin + url.pathname, stored),
            cache.put(url.origin + LAST_PAGE, new Response(url.pathname + url.search))
          ]);
        });
      }).catch(function () { /* the network answer still goes to the page */ })
        .then(function () { return response; });
    }
    return response;
  }, function () {
    if (!keep) return offlinePage();
    return caches.open(SHELL).then(function (cache) {
      if (url.pathname === '/') {
        return cache.match(url.origin + LAST_PAGE).then(function (last) {
          if (!last) return offlinePage();
          return last.text().then(function (where) { return Response.redirect(url.origin + where, 302); });
        });
      }
      return cache.match(url.origin + url.pathname, { ignoreSearch: true, ignoreVary: true }).then(function (hit) {
        return hit || offlinePage();
      });
    });
  });
}

function offlinePage() {
  return new Response(OFFLINE, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;                    // saves and every other write pass straight through
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  var keep = !fromReviewPage(request, url);
  if (url.pathname.indexOf('/api/') === 0) {
    if (KEPT_API.indexOf(url.pathname) < 0 || !keep) return;
    event.respondWith(networkFirst(request, ARTICLES, request.url, true));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request, url, keep));
    return;
  }
  if (keep) event.respondWith(networkFirst(request, SHELL, url.origin + url.pathname, true));
});
