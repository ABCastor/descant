/* Complete, explicit founder flight packs. No reader pages or POST caching. */
'use strict';
var META = 'descant-flight-meta-v1', INDEX = new URL('/write/__flight', self.location.origin).href;
var storageDenied = false;
// Any writer of this installation, in the shape the server gives writer keys.
var WRITER = /^founder:[a-z][a-z0-9-]{0,23}$/;
var AUTH = new URL('/write/__authenticated', self.location.origin).href;
function clientKey(id) { return new URL('/write/__client/' + encodeURIComponent(id), self.location.origin).href; }
function cacheKey(value) { var url = new URL(value); url.searchParams.sort(); return url.href; }
function problem(message, status) { return new Response(message, { status: status || 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }); }
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
      if (!record) return problem('No offline copy is prepared for this writer on this device. Open Descant online and choose Prepare offline.');
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
    if (response.status === 401 || response.status === 403) {
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
    if (actual && WRITER.test(actual)) {
      if (account.startsWith('revoked:') && url.pathname === '/write/api/whoami') account = account.slice(8);
      // A legacy account-less tombstone cannot safely be rebound in this client.
      if (account && account !== actual) return problem('The signed-in writer changed. Your original unsent writing is preserved. Open the other writer in a new tab.', 409);
      await bind(meta, event.resultingClientId || event.clientId, actual);
      if (request.mode === 'navigate' || url.pathname === '/write/api/whoami') await confirm(meta, actual);
    }
    return response;
    }).catch(function (error) { return problem(error.message); });
  })());
});
