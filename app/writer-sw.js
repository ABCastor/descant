/* Complete, explicit founder flight packs. No reader pages or POST caching. */
'use strict';
var META = 'descant-flight-meta-v1', INDEX = new URL('/write/__flight', self.location.origin).href;
var storageDenied = false;
// Any writer of this installation, in the shape the server gives writer keys.
var WRITER = /^founder:[a-z][a-z0-9-]{0,23}$/;
var AUTH = new URL('/write/__authenticated', self.location.origin).href;
function clientKey(id) { return new URL('/write/__client/' + encodeURIComponent(id), self.location.origin).href; }
function cacheKey(value) { var url = new URL(value); url.searchParams.sort(); return url.href; }
function problem(message, status) { return new Response(message, { status: status || 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Descant-Problem': '1' } }); }
/* A launch the server cannot answer, with no prepared offline copy to open: not a dead end. The page
   shows the words this device kept for the writer (keep.js's journal, read-only: they are not saved,
   and it never says so), and opens the app by itself once the server answers again. */
function waiting(account) {
  var page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Descant</title><style>' +
    ':root{color-scheme:light dark;--paper:#F7F4EC;--ink:#1B1915;--ink-2:#5D584E;--rule:rgba(27,25,21,.14)}' +
    '@media (prefers-color-scheme:dark){:root{--paper:#000;--ink:#EEE9DE;--ink-2:#A8A296;--rule:rgba(238,233,222,.18)}}' +
    'body{margin:0;background:var(--paper);color:var(--ink);font:400 17px/1.55 -apple-system,system-ui,sans-serif}' +
    'main{max-width:38rem;margin:0 auto;padding:max(48px,env(safe-area-inset-top)) 24px 48px}' +
    'h1{font-size:22px;line-height:1.25;font-weight:600;margin:0 0 12px}p{margin:0 0 12px;color:var(--ink-2)}' +
    'button{font:inherit;min-height:44px;padding:0 18px;border-radius:22px;border:1px solid var(--rule);background:transparent;color:var(--ink)}' +
    'article{margin:28px 0 0;padding:20px 0 0;border-top:1px solid var(--rule)}article h2{font-size:15px;font-weight:600;margin:0 0 8px;color:var(--ink-2)}' +
    '.words{white-space:pre-wrap;overflow-wrap:anywhere;font:400 18px/1.6 "Source Serif 4",ui-serif,Georgia,serif;color:var(--ink);-webkit-user-select:text;user-select:text}' +
    '</style></head><body><main><h1 id="head">Descant can\u2019t reach the server</h1>' +
    '<p id="say">This device has no offline copy of Descant, so it opens once the server answers. It opens by itself.</p>' +
    '<p id="state" role="status" aria-live="polite">Waiting for the server\u2026</p><button type="button" id="again">Try now</button><div id="kept"></div></main><script>' +
    '(' + offlineWaiting.toString() + ')(' + JSON.stringify(account || '') + ');</script></body></html>';
  return new Response(page, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Descant-Problem': '1' } });
}
// Runs in that page, not in the worker.
function offlineWaiting(account) {
  var writer = account.replace(/^founder:/, ''), live = new URLSearchParams(location.search).get('live') || '';
  var state = document.getElementById('state'), busy = false;
  function sig(e) { return JSON.stringify([e.path, e.text, e.base || '', e.who || [], e.at || 0]); }
  function writerOf(e) { var first = e.who && e.who[0]; return (typeof first === 'string' ? first : first && first.id) || ''; }
  function valid(e) { return !!e && typeof e.key === 'string' && typeof e.path === 'string' && typeof e.text === 'string'; }
  // The journal's two stores, read only: an absent database is never created here.
  function rows() {
    var local = [];
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf('castor.keep.') === 0) { try { local.push(JSON.parse(localStorage.getItem(k))); } catch (e) {} } } } catch (e) {}
    return new Promise(function (done) {
      var q;
      try { q = indexedDB.open('castor-keep'); } catch (e) { done(local); return; }
      q.onupgradeneeded = function () { q.transaction.abort(); };
      q.onerror = function () { done(local); };
      q.onsuccess = function () {
        var db = q.result;
        try { var all = db.transaction('entries').objectStore('entries').getAll(); all.onsuccess = function () { db.close(); done((all.result || []).concat(local)); }; all.onerror = function () { db.close(); done(local); }; }
        catch (e) { db.close(); done(local); }
      };
    });
  }
  function title(text) { var m = /^---\n(?:[\s\S]*?\n)?title:\s*["']?(.+?)["']?\s*\n[\s\S]*?\n---/.exec(text); return m ? m[1] : ''; }
  function body(text) { var t = text.replace(/^---\n[\s\S]*?\n---\n*/, '').trim(), name = title(text); return name && t.indexOf('# ' + name + '\n') === 0 ? t.slice(name.length + 3).trim() : t; }
  rows().then(function (all) {
    all = all.filter(valid);
    var saved = {}, gone = {};
    all.forEach(function (e) { if (!e.confirmed) return; if (e.key === 'saved|' + e.path) saved[e.path] = e.text; if (e.key.indexOf('discarded|') === 0 || e.key.indexOf('saved|' + e.path + '|') === 0) gone[sig(e)] = true; });
    var newest = {};
    all.forEach(function (e) {
      if (e.confirmed || gone[sig(e)] || live && e.path !== live) return;
      if (writer && writerOf(e) && writerOf(e) !== writer) return;
      if (saved[e.path] === e.text) return;
      if (!newest[e.path] || (e.at || 0) > (newest[e.path].at || 0)) newest[e.path] = e;
    });
    var kept = Object.keys(newest).map(function (k) { return newest[k]; }).sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    if (!kept.length) return;
    document.getElementById('head').textContent = 'Your words are on this device';
    document.getElementById('say').textContent = 'Descant can\u2019t reach the server, and this device has no offline copy of it. What you typed here is kept on this device and not sent yet: it goes to the server when Descant opens, by itself, once the server answers.';
    var box = document.getElementById('kept');
    kept.forEach(function (e) {
      var a = document.createElement('article'), h = document.createElement('h2'), w = document.createElement('div');
      h.textContent = title(e.text) || e.path.replace(/^articles\//, '').replace(/\/article\.md$/, '');
      w.className = 'words'; w.textContent = body(e.text);
      a.appendChild(h); a.appendChild(w); box.appendChild(a);
    });
  });
  // The server answers when a read comes back that this worker did not write itself.
  function probe() {
    if (busy) return; busy = true;
    fetch('/write/api/whoami', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      if (!r.headers.get('X-Descant-Problem')) { state.textContent = 'The server answered. Opening Descant\u2026'; location.reload(); return; }
      busy = false; state.textContent = 'Waiting for the server…';
    }, function () { busy = false; state.textContent = 'Waiting for the server…'; });
  }
  setInterval(probe, 3000);
  addEventListener('online', probe); addEventListener('focus', probe); addEventListener('pageshow', probe);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) probe(); });
  document.getElementById('again').addEventListener('click', function () { state.textContent = 'Asking the server…'; probe(); });
}
async function state(meta, id) {
  var hit = id && await meta.match(clientKey(id)), value = hit && await hit.json();
  return { account: value && value.account || '', revision: value && Number.isSafeInteger(value.revision) ? value.revision : 0 };
}
async function expected(meta, id) { return (await state(meta, id)).account; }
async function bind(meta, id, account, force) {
  if (!id) return;
  var prior = await state(meta, id);
  if (force || prior.account !== account) await meta.put(clientKey(id), new Response(JSON.stringify({ account: account, revision: prior.revision + 1 })));
}
async function grant(meta) {
  var hit = await meta.match(AUTH), value = hit && await hit.json();
  return { account: value && value.account || '', revision: value && Number.isSafeInteger(value.revision) ? value.revision : 0, epoch: value && value.epoch || '' };
}
async function confirm(meta, account, force) {
  var prior = await grant(meta);
  if (force || prior.account !== account) await meta.put(AUTH, new Response(JSON.stringify({ account: account, revision: prior.revision + 1, epoch: crypto.randomUUID() })));
}
async function revoke(meta) {
  try { await confirm(meta, '', true); }
  catch (error) {
    try { await meta.delete(AUTH); }
    catch (error) {
      storageDenied = true;
      await caches.delete(META);
      throw Error('Writer storage could not retain the denial. Reopen online after storage is available; your writing remains on this device.');
    }
  }
}
function ordered(work) {
  var locks = self.navigator && self.navigator.locks;
  return locks && locks.request ? locks.request('descant-writer-bindings', function () { if (storageDenied) throw Error('Writer storage is unavailable. Reopen online after storage is available.'); return work(); }) : Promise.reject(Error('Coordinated writer storage is unavailable.'));
}
function unchanged(before, after) { return before.account === after.account && before.revision === after.revision && before.epoch === after.epoch; }
self.addEventListener('install', function (event) { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'descant-flight-version-v1' && event.source && event.ports[0]) {
    event.ports[0].postMessage({ generation: 2 }); return;
  }
  if (event.data && event.data.type === 'descant-flight-claim-v1' && event.source) {
    event.waitUntil(self.clients.claim()); return;
  }
  if (!event.data || event.data.type !== 'descant-flight-bind-v1' || !event.source || !event.ports[0]) return;
  event.waitUntil(ordered(async function () {
    var account = event.data.account, meta = await caches.open(META), before = await expected(meta, event.source.id);
    var valid = WRITER.test(account || '') && (!before || before === account);
    if (valid) await bind(meta, event.source.id, account);
    event.ports[0].postMessage({ version: 1, ok: valid, account: valid ? account : '' });
  }).catch(function () { event.ports[0].postMessage({ version: 1, ok: false, account: '' }); }));
});
self.addEventListener('fetch', function (event) {
  var request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !(url.pathname === '/write' || url.pathname.startsWith('/write/')) || url.pathname === '/write/sw.js') return;
  event.respondWith((async function () {
    var meta, observed, observedGrant, response;
    try { await ordered(async function () { meta = await caches.open(META); observed = await state(meta, event.clientId); observedGrant = await grant(meta); }); }
    catch (error) { return problem(error.message); }
    var account = observed.account, target = event.resultingClientId || event.clientId;
    try { response = await fetch(request); } catch (error) {
      if (request.headers.get('X-Descant-Flight-Online') === '1') return problem('The live server could not verify a new offline copy. Your previous complete copy is unchanged.');
      return ordered(async function () {
      meta = await caches.open(META);
      if (!unchanged(observed, await state(meta, event.clientId)) || !unchanged(observedGrant, await grant(meta))) return problem('The writer session changed while this request was pending. Reopen it to confirm the writer.', 409);
      if (!observedGrant.account) return problem('The writer session was denied online. Reopen Descant online to confirm the writer; your unsent writing remains on this device.');
      var indexHit = await meta.match(INDEX), index = indexHit && await indexHit.json();
      // Only a new navigation can choose the last prepared writer. Every request
      // from an existing tab must retain that tab's original account binding.
      if (!account && request.mode === 'navigate' && !event.clientId) {
        account = observedGrant.account;
      }
      var record = index && account && index.accounts && index.accounts[account];
      if (!record) return request.mode === 'navigate' ? waiting(account) : problem('No offline copy is prepared for this writer on this device. Open Descant online and choose Prepare offline.');
      var key = request.mode === 'navigate' && (url.pathname === '/write' || url.pathname === '/write/') ? new URL('/write/', url.origin).href : cacheKey(request.url);
      var hit = await (await caches.open(record.cache)).match(key);
      if (!hit) return problem('This file is not in the prepared offline copy. Your unsent writing remains on this device.');
      await bind(meta, event.resultingClientId || event.clientId, account);
      if (/^\/write\/api\/(whoami|piece|comments)$/.test(url.pathname)) {
        var identity = await hit.json(); identity.offline = true;
        if (url.pathname === '/write/api/piece') identity.save = null;
        return new Response(JSON.stringify(identity), { headers: { 'Content-Type': 'application/json', 'X-Descant-Account': account, 'X-Descant-Offline': '1', 'Cache-Control': 'no-store' } });
      }
      var headers = new Headers(hit.headers); headers.set('X-Descant-Offline', '1');
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: headers });
      }).catch(function (error) { return problem(error.message); });
    }
    // 401/403 and every other HTTP error remain live errors, never cached grants.
    return ordered(async function () {
    meta = await caches.open(META);
    var current = await state(meta, event.clientId), actual = response.headers.get('X-Descant-Account');
    // A known denial takes precedence over a concurrent bind or confirmation.
    // Clear shared authority first, before any client write that can hit quota.
    // A 403 on any other read refuses that one file (an unreadable path), not the writer.
    if (response.status === 401 || response.status === 403 && (request.mode === 'navigate' || url.pathname === '/write/api/whoami')) {
      var original = current.account || account || observedGrant.account;
      original = original.startsWith('revoked:') ? original.slice(8) : original;
      var revoked = original && original !== 'revoked' ? 'revoked:' + original : 'revoked';
      await revoke(meta);
      await bind(meta, event.clientId, revoked, true);
      if (target !== event.clientId) await bind(meta, target, revoked, true);
      return response;
    }
    if (!response.ok) return response;
    if (!unchanged(observed, current) || !unchanged(observedGrant, await grant(meta))) return problem('The writer session changed while this request was pending. Retry to confirm the writer.', 409);
    // A whoami the Worker answered itself names the signed-in writer but says nothing about
    // the writing server: it never lifts a denial that server gave or renews the offline grant.
    var edge = url.pathname === '/write/api/whoami' && response.headers.get('X-Descant-Identity') === 'edge';
    if (actual && WRITER.test(actual)) {
      if (account.startsWith('revoked:') && url.pathname === '/write/api/whoami') {
        if (edge) return problem('The writer session was denied online. Reopen Descant online to confirm the writer; your unsent writing remains on this device.', 401);
        account = account.slice(8);
      }
      // A legacy account-less tombstone cannot safely be rebound in this client.
      if (account && account !== actual) return problem('The signed-in writer changed. Your original unsent writing is preserved. Open the other writer in a new tab.', 409);
      await bind(meta, event.resultingClientId || event.clientId, actual);
      if ((request.mode === 'navigate' || url.pathname === '/write/api/whoami') && !edge) await confirm(meta, actual);
    }
    return response;
    }).catch(function (error) { return problem(error.message); });
  })());
});
