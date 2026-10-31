/* A complete flight pack is published only after every response was read back.
   Downloaded baselines and the editor's existing raw-word journal stay separate. */
(function (global) {
  'use strict';
  var Castor = global.Castor = global.Castor || {}, busy = false, receipt = null, status, preparation = 0, preparedAt, recoveryAt;
  var META = 'descant-flight-meta-v1', POINTER = '/write/__flight', LIMIT = 64 * 1024 * 1024;
  function absolute(path) { var url = new URL(path, global.location.origin); url.searchParams.sort(); return url.href; }
  function account() { return Castor.role && Castor.role.publicWriter ? Castor.role.id : ''; }
  function ownCommentKey(key, owner) {
    var scope = '.writer.' + encodeURIComponent(owner || account()), at = key && key.indexOf(scope);
    return /^castor\.[^.]+\.comments\./.test(key || '') && at > 0 && (at + scope.length === key.length || key.charAt(at + scope.length) === '.');
  }
  function paintPreparation() {
    if (preparedAt) preparedAt.textContent = receipt ? 'Last prepared: ' + new Date(receipt.at).toLocaleString() + ' · ' + receipt.articles + ' articles on this device.' : 'Not prepared on this device yet.';
  }
  function say(words) { paintPreparation(); if (status) status.textContent = words; }
  function digest(bytes) { return global.crypto.subtle.digest('SHA-256', bytes).then(function (d) { return Array.from(new Uint8Array(d)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }); }
  async function storageRead(read) {
    var timer;
    try {
      // Bound cache lookup and verification, never a publication Cache.put.
      return await Promise.race([read, new Promise(function (_, reject) {
        timer = setTimeout(function () { reject(Error('Offline storage did not respond. No new copy was marked ready. Your writing and previously downloaded recovery remain unchanged.')); }, 8000);
      })]);
    } finally { clearTimeout(timer); }
  }
  function readIndex() {
    return storageRead((async function () {
      var metadata = await global.caches.open(META), hit = await metadata.match(absolute(POINTER));
      return { metadata: metadata, index: hit ? await hit.json() : { v: 1, accounts: {} } };
    })());
  }
  async function pointer() {
    var index = (await readIndex()).index;
    return index && index.accounts && index.accounts[account()] || null;
  }
  async function connect() {
    if (!/^founder:[a-z][a-z0-9-]{0,23}$/.test(account()) || !navigator.serviceWorker || !global.MessageChannel) throw Error('The writer could not be bound to offline storage.');
    var service = navigator.serviceWorker;
    // Keep the original slash scope usable by older cached shells. Updating
    // both scopes also covers the bare launch address without deleting a pack.
    var registrations = [], workers = [];
    for (var scope of ['/write', '/write/']) {
      var registration = await service.register('/write/sw.js', { scope: scope });
      // Force online upgrade discovery. Offline, an already installed compatible
      // worker remains usable; the generation handshake below is mandatory.
      try { await registration.update(); } catch (_) {}
      var candidate = registration.installing || registration.waiting || registration.active;
      if (!candidate) throw Error('The writing app did not install its offline worker.');
      if (candidate.state !== 'activated') await new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { finish(Error('Offline installation did not finish. Your previous copy is unchanged.')); }, 8000);
        function finish(error) { clearTimeout(timer); candidate.removeEventListener('statechange', change); error ? reject(error) : resolve(); }
        function change() { if (candidate.state === 'activated') finish(); else if (candidate.state === 'redundant') finish(Error('Offline installation was replaced. Prepare again.')); }
        candidate.addEventListener('statechange', change); change();
      });
      await new Promise(function (resolve, reject) {
        var channel = new global.MessageChannel(), timer = setTimeout(function () { finish(Error('Reopen Descant online to finish its offline update. Your previous copy is unchanged.')); }, 8000);
        function finish(error) { clearTimeout(timer); channel.port1.close(); error ? reject(error) : resolve(); }
        channel.port1.onmessage = function (event) { finish(event.data && event.data.generation === 2 ? null : Error('The offline worker needs an update. Your previous copy is unchanged.')); };
        candidate.postMessage({ type: 'descant-flight-version-v1' }, [channel.port2]);
      });
      if (registration.active !== candidate) throw Error('The offline worker changed while its version was checked. Prepare again.');
      registrations.push(registration); workers.push(candidate);
    }
    var worker = workers[global.location.pathname === '/write' ? 0 : 1];
    if (service.controller !== worker) await new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { finish(Error('Reopen this page to finish enabling offline use.')); }, 8000);
      function finish(error) { clearTimeout(timer); service.removeEventListener('controllerchange', change); error ? reject(error) : resolve(); }
      function change() { if (service.controller === worker) finish(); }
      service.addEventListener('controllerchange', change);
      worker.postMessage({ type: 'descant-flight-claim-v1' }); change();
    });
    var controller = navigator.serviceWorker.controller, expected = account();
    await new Promise(function (resolve, reject) {
      var channel = new global.MessageChannel(), timer = setTimeout(function () { finish(Error('Offline storage did not confirm this writer.')); }, 8000);
      function finish(error) { clearTimeout(timer); channel.port1.close(); error ? reject(error) : resolve(); }
      channel.port1.onmessage = function (event) {
        var value = event.data || {};
        finish(value.version === 1 && value.ok && value.account === expected && account() === expected && navigator.serviceWorker.controller === controller ? null : Error('The writer changed. Offline storage remains bound to the original writer.'));
      };
      controller.postMessage({ type: 'descant-flight-bind-v1', account: expected }, [channel.port2]);
    });    if (registrations.some(function (registration, index) { return registration.active !== workers[index]; })) throw Error('The offline worker changed while this writer was bound. Prepare again.');
    return { registrations: registrations, workers: workers };
  }
  async function prepare() {
    var expected = account();
    if (!navigator.locks || !navigator.locks.request || !expected) throw Error('A signed-in writer and coordinated storage are required.');
    return navigator.locks.request('descant-flight-prepare-' + expected, async function () {
      if (account() !== expected) throw Error('The writer changed before preparation.');
      return preparePack();
    });
  }
  async function preparePack() {
    if (busy) { say('Offline preparation is already running. Wait for it to finish.'); throw Error('Offline preparation is already running. Wait for it to finish.'); }
    if (!account() || !global.caches || !global.crypto || !navigator.serviceWorker) throw Error('Open the signed-in writing app online first.');
    busy = true; preparation++;
    var cacheName = 'descant-flight-v1-' + account() + '-' + global.crypto.randomUUID(), cache, opening, total = 0, objects = [], seen = {}, expected = account(), snapshot = '', assets = '', controller, published = false, waited = 0;
    try {
      var connected = await connect(), registrations = connected.registrations;
      controller = navigator.serviceWorker.controller;
      function sameWorker() { return navigator.serviceWorker.controller === controller && registrations.every(function (registration, index) { return !registration.installing && !registration.waiting && registration.active && registration.active.state === 'activated' && registration.active === connected.workers[index]; }); }
      opening = global.caches.open(cacheName);
      cache = await storageRead(opening);
      async function live(path) {
        for (var attempt = 0; ; attempt++) {
          if (account() !== expected) throw Error('The writer changed during preparation. Nothing was marked ready.');
          if (!sameWorker()) throw Error('The offline worker changed during preparation. The previous complete copy is preserved.');
          var response = await global.fetch(path, { cache: 'no-store', headers: { 'X-Descant-Flight-Online': '1' } });
          if (response.ok && !response.redirected && response.headers.get('X-Descant-Offline') !== '1') {
            var receivedAssets = response.headers.get('X-Descant-Assets');
            if (!/^[a-f0-9]{64}$/.test(receivedAssets || '') || assets && receivedAssets !== assets) throw Error('The app version changed during preparation. Reopen online and prepare again; the previous complete copy is preserved.');
            assets = receivedAssets;
          }
          if (response.status !== 429 || attempt >= 2 || response.redirected || response.headers.get('X-Descant-Offline') === '1') return response;
          var retry = response.headers.get('Retry-After'), delay = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry || '') - Date.now();
          if (!(delay > 0 && delay <= 60000) || waited + delay > 120000) return response;
          waited += delay;
          say('Rate limit reached. Preparation resumes in ' + Math.ceil(delay / 1000) + ' seconds.');
          await new Promise(function (resolve) { setTimeout(resolve, delay); });
        }
      }
      // A pack uses at most eleven 6 MiB pages, rather than one protected
      // request per file. No per-resource fallback can recreate a rate-limit stall.
      var admission = await live('/write/api/whoami'), admissionIdentity = admission.ok && admission.headers.get('X-Descant-Offline') !== '1' && admission.headers.get('X-Descant-Account') === expected && await admission.json();
      snapshot = admission.headers.get('X-Descant-Snapshot');
      if (!/^[a-f0-9]{64}$/.test(snapshot || '') || !admissionIdentity || admissionIdentity.role !== 'founder' || admissionIdentity.id !== expected || admissionIdentity.who !== Castor.role.who || account() !== expected) throw Error('The signed-in writer could not be verified. Nothing was marked ready.');
      var bundled = {}, bundleId = '', packInfo, cursor = 0, pageCount = 0, incoming = 0, assembled = null;
      while (true) {
        if (++pageCount > 11) throw Error('The offline pack exceeded its bounded page count.');
        var pageResponse = await live('/write/api/offline?cursor=' + cursor + (snapshot ? '&snapshot=' + snapshot : ''));
        if (!pageResponse.ok || pageResponse.redirected || pageResponse.headers.get('X-Descant-Offline') === '1' || pageResponse.headers.get('X-Descant-Account') !== expected || !/application\/json/i.test(pageResponse.headers.get('Content-Type') || '')) throw Error('Could not download a complete offline pack. The previous complete pack is still available.');
        var page = await pageResponse.json(), generation = pageResponse.headers.get('X-Descant-Snapshot');
        if (!page || page.v !== 1 || page.account !== expected || page.snapshot !== generation || !/^[a-f0-9]{64}$/.test(generation || '') || snapshot && generation !== snapshot || !/^[a-f0-9]{64}$/.test(page.bundle || '') || bundleId && page.bundle !== bundleId || page.cursor !== cursor || !Number.isSafeInteger(page.total) || page.total <= 0 || page.total > LIMIT || !Number.isSafeInteger(page.objects) || page.objects <= 0 || page.objects > 10000 || !Number.isSafeInteger(page.articles) || page.articles < 1 || page.articles > 50 || !Number.isSafeInteger(page.drafts) || page.drafts < 0 || page.drafts > 500 || !Number.isSafeInteger(page.threads) || page.threads < 0 || !Array.isArray(page.chunks)) throw Error('The articles changed or the offline pack was incomplete. The previous complete copy is preserved.');
        var next = Math.min(cursor + 6 * 1024 * 1024, page.total);
        if (page.next !== (next < page.total ? next : null) || packInfo && ['total', 'objects', 'articles', 'drafts', 'threads'].some(function (key) { return page[key] !== packInfo[key]; })) throw Error('The offline pages did not describe one complete copy.');
        snapshot = generation; bundleId = page.bundle; packInfo = page;
        var pageBytes = 0;
        for (var row of page.chunks) {
          if (!row || typeof row.url !== 'string' || !row.url.startsWith('/write/') || !row.headers || typeof row.headers['Content-Type'] !== 'string' || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > LIMIT || !Number.isSafeInteger(row.offset) || row.offset < 0 || typeof row.bytes !== 'string' || row.bytes.length > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(row.sha256 || '')) throw Error('An offline resource was incomplete.');
          var url = absolute(row.url);
          if (new URL(url).origin !== global.location.origin || bundled[url]) throw Error('An offline resource had an unexpected address.');
          if (!assembled) {
            if (row.offset !== 0) throw Error('An offline resource started halfway through.');
            assembled = { url: url, size: row.size, sha256: row.sha256, headers: row.headers, bytes: new Uint8Array(row.size), offset: 0 };
          }
          if (assembled.url !== url || assembled.size !== row.size || assembled.sha256 !== row.sha256 || JSON.stringify(assembled.headers) !== JSON.stringify(row.headers) || assembled.offset !== row.offset) throw Error('The offline resource changed between pages.');
          var binary = atob(row.bytes), bytes = new Uint8Array(binary.length);
          for (var b = 0; b < binary.length; b++) bytes[b] = binary.charCodeAt(b);
          if (assembled.offset + bytes.length > assembled.size) throw Error('An offline resource exceeded its declared size.');
          pageBytes += bytes.length; incoming += bytes.length;
          if (pageBytes > 6 * 1024 * 1024 || incoming > LIMIT) throw Error('This pack exceeds the offline byte limit.');
          assembled.bytes.set(bytes, assembled.offset); assembled.offset += bytes.length;
          if (assembled.offset === assembled.size) {
            if (await digest(assembled.bytes) !== assembled.sha256) throw Error('An offline resource did not match its source bytes.');
            // Only supported response headers are recreated; source file policies
            // and shell CSP survive without installing arbitrary bundle headers.
            var headers = { 'Content-Type': assembled.headers['Content-Type'], 'X-Descant-Account': expected, 'X-Descant-Snapshot': snapshot };
            for (var key of ['Content-Security-Policy', 'Content-Disposition']) if (assembled.headers[key]) headers[key] = assembled.headers[key];
            bundled[url] = new Response(assembled.bytes, { headers: headers }); assembled = null;
          }
        }
        if (pageBytes !== next - cursor) throw Error('An offline page was truncated.');
        say('Preparing offline: ' + Math.ceil(incoming / 1024) + ' KB downloaded.');
        cursor = next;
        if (page.next === null) break;
      }
      if (assembled || incoming !== packInfo.total || Object.keys(bundled).length !== packInfo.objects) throw Error('The offline pack was incomplete.');
      async function keep(path, kind) {
        var url = absolute(path);
        if (seen[url]) return seen[url];
        var response = bundled[url];
        if (!response || !response.ok || response.redirected || response.headers.get('X-Descant-Offline') === '1' || response.headers.get('X-Descant-Account') !== expected) throw Error('Could not verify ' + path + '. The previous complete pack is still available.');
        var generation = response.headers.get('X-Descant-Snapshot');
        if (!/^[a-f0-9]{64}$/.test(generation || '') || snapshot && generation !== snapshot) throw Error('The articles changed during preparation. Prepare again; the previous complete copy is preserved.');
        snapshot = generation;
        var bytes = await response.clone().arrayBuffer(); total += bytes.byteLength;
        if (total > LIMIT) throw Error('This pack exceeds 64 MB. The previous complete pack is still available.');
        var value;
        if (kind === 'json') {
          if (!/application\/json/i.test(response.headers.get('Content-Type') || '')) throw Error('Expected article data, received a different page.');
          value = JSON.parse(new TextDecoder().decode(bytes));
        }
        var hash = await digest(bytes);
        await cache.put(url, response);
        var retainedHash = await storageRead((async function () {
          var kept = await cache.match(url);
          return kept && await digest(await kept.arrayBuffer());
        })());
        if (retainedHash !== hash) throw Error('This device did not retain an exact copy.');
        objects.push({ url: url, bytes: bytes.byteLength, sha256: hash });
        seen[url] = value || true;
        say('Preparing offline: ' + objects.length + ' files checked.');
        return value;
      }
      var identity = await keep('/write/api/whoami', 'json');
      if (!identity || identity.role !== 'founder' || identity.id !== expected || !/^[a-z][a-z0-9-]{0,23}$/.test(identity.who)) throw Error('The signed-in writer changed. Nothing was marked ready.');
      var list = await keep('/write/api/pieces', 'json');
      if (!Array.isArray(list) || !list.length || list.length > 50) throw Error('The article list could not be verified.');
      await keep('/write/', 'html');
      await keep('/write/manifest.webmanifest');
      await keep('/write/favicon.svg');
      await keep('/write/favicon.ico');
      for (var icon of ['apple-touch-icon.png', 'castor-192.png', 'castor-512.png', 'castor-maskable-512.png']) await keep('/write/icons/' + icon);
      var fonts = ['literata.woff2', 'randosans-500-sharpie.woff2', 'sourceserif4.woff2', 'sourceserif4-italic.woff2', 'commissioner.woff2', 'martianmono.woff2', 'newsreader.woff2'];
      for (var font of fonts) await keep('/write/fonts/' + font);
      var drafts = 0, threads = 0;
      for (var article of list) {
        if (!article || !/^articles\/[A-Za-z0-9._-]{1,80}\/article\.md$/.test(article.path)) throw Error('An article path was not recognised.');
        var payload = await keep('/write/api/piece?path=' + encodeURIComponent(article.path), 'json');
        if (!payload || typeof payload.markdown !== 'string' || payload.path !== article.path || !Array.isArray(payload.files)) throw Error('An article copy was incomplete.');
        var comments = await keep('/write/api/comments?path=' + encodeURIComponent(article.path) + '&actions=1&who=' + identity.who, 'json');
        if (!comments || !Array.isArray(comments.threads)) throw Error('The comments could not be verified.');
        threads += comments.threads.length;
        var folder = article.path.slice(0, -11);
        for (var file of payload.files || []) {
          if (!file || typeof file.path !== 'string' || /(?:^|\/)\.\.(?:\/|$)/.test(file.path) || file.path.startsWith('/') || !/^(file|folder)$/.test(file.kind)) throw Error('An attachment entry was incomplete.');
          if (file.kind === 'folder') continue;
          await keep('/write/api/files/content?piece=' + encodeURIComponent(folder) + '&path=' + encodeURIComponent(file.path));
        }
        var workspace = await keep('/write/api/canvas?state=1&piece=' + encodeURIComponent(folder), 'json');
        if (!workspace || !workspace.canvas || !Array.isArray(workspace.canvas.nodes) || !Array.isArray(workspace.canvas.edges) || typeof workspace.version !== 'string') throw Error('A workspace copy was incomplete.');
        await keep('/write/api/drafts?piece=' + encodeURIComponent(folder) + '&who=' + identity.who, 'json');
        var draftList = await keep('/write/api/drafts?piece=' + encodeURIComponent(folder) + '&who=' + identity.who + '&hidden=1', 'json');
        if (!draftList || !Array.isArray(draftList.drafts)) throw Error('The draft list could not be verified.');
        for (var draft of draftList.drafts) {
          if (!draft || typeof draft.path !== 'string' || !draft.path.startsWith(folder + '/drafts/') || !/\.md$/.test(draft.path) || /(?:^|\/)\.\.(?:\/|$)/.test(draft.path) || drafts >= 500) throw Error('A draft path could not be verified.');
          var held = await keep('/write/api/piece?path=' + encodeURIComponent(draft.path), 'json');
          if (!held || held.path !== draft.path || typeof held.markdown !== 'string' || !Array.isArray(held.files)) throw Error('A draft copy was incomplete.');
          // Review threads belong to the parent article, already captured above.
          drafts++;
        }
      }
      if (objects.length !== packInfo.objects || total !== packInfo.total || list.length !== packInfo.articles || drafts !== packInfo.drafts || threads !== packInfo.threads) throw Error('The offline pack contained missing or unexpected resources.');
      // A second live identity check prevents an account switch publishing this pack.
      var check = await live('/write/api/whoami');
      var finalIdentity = check.ok && check.headers.get('X-Descant-Offline') !== '1' && check.headers.get('X-Descant-Account') === expected && await check.json();
      if (check.headers.get('X-Descant-Snapshot') !== snapshot || !finalIdentity || finalIdentity.offline || finalIdentity.id !== expected || account() !== expected) throw Error('The live writer could not be verified. Nothing was marked ready.');
      // Recheck installed worker bytes after the last live asset attestation.
      // A deployment after connect() must not publish a new shell under an old worker.
      for (var i = 0; i < registrations.length; i++) {
        var registration = registrations[i];
        try { await registration.update(); }
        catch (_) { throw Error('The offline worker could not be checked online. The previous complete copy is preserved.'); }
        if (registration.installing || registration.waiting || !registration.active || registration.active.state !== 'activated' || registration.active !== connected.workers[i] || navigator.serviceWorker.controller !== controller) throw Error('The offline worker updated during preparation. Prepare again; the previous complete copy is preserved.');
      }
      var persistent = navigator.storage && navigator.storage.persist ? await navigator.storage.persist().catch(function () { return false; }) : false;
      var completed = { v: 1, account: expected, cache: cacheName, at: new Date().toISOString(), articles: list.length, drafts: drafts, threads: threads, snapshot: snapshot, assets: assets, bytes: total, persistent: persistent, objects: objects };
      await cache.put(absolute('/write/__manifest'), new Response(JSON.stringify(completed), { headers: { 'Content-Type': 'application/json' } }));
      if (!navigator.locks || !navigator.locks.request) throw Error('This browser cannot coordinate a complete offline copy. Download your writing before disconnecting.');
      var previousCache;
      await navigator.locks.request('descant-flight-publish', async function () {
        var read = await readIndex(), metadata = read.metadata, index = read.index;
        if (!sameWorker() || account() !== expected) throw Error('The writer or offline worker changed before publication. The previous complete copy is preserved.');
        previousCache = index.accounts[expected] && index.accounts[expected].cache;
        var originalIndex = JSON.stringify(index);
        index.accounts[expected] = completed;
        await metadata.put(absolute(POINTER), new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } }));
        published = true;
        if (!sameWorker() || account() !== expected) {
          try {
            await metadata.put(absolute(POINTER), new Response(originalIndex, { headers: { 'Content-Type': 'application/json' } }));
            published = false;
          } catch (_) {
            throw Error('The writer or offline worker changed and storage could not restore the prior selection. Both complete copies are retained. Reopen online and prepare again.');
          }
          throw Error('The writer or offline worker changed during publication. The previous complete copy is preserved.');
        }
      });
      // Keep the current and previous generation, never other writers/readers.
      var pruningTimer, names;
      try {
        names = await Promise.race([global.caches.keys(), new Promise(function (resolve) {
          pruningTimer = setTimeout(function () { resolve([]); }, 8000);
        })]);
      } catch (_) { names = []; } finally { clearTimeout(pruningTimer); }
      // Freeze obsolete names while preparation is locked. Late enumeration must
      // never discover and remove a future generation; deletion cannot hold the UI.
      for (var name of names) {
        if (name.startsWith('descant-flight-v1-' + expected + '-') && name !== cacheName && name !== previousCache) global.caches.delete(name).catch(function () {});
      }
      receipt = completed;
      say(completed.articles + ' articles, ' + drafts + ' drafts and ' + threads + ' comment threads checked for offline use. ' + (persistent ? 'Persistent storage granted.' : 'Download the recovery copy; this browser may clear its storage.'));
      return completed;
    } catch (error) {
      // A failed open may create its UUID after a retry already pruned. Retain
      // its promise so late cleanup targets only that unpublished generation.
      if (opening && !published) opening.then(function () { return global.caches.delete(cacheName); }).catch(function () {});
      say(error.message + ' Your unsent writing is unchanged.');
      throw error;
    } finally { busy = false; }
  }
  async function prepareAndRecover() {
    var record = await prepare();
    try { await download(record); }
    catch (error) { say((account() === record.account ? record.articles + ' articles checked for offline use.' : 'The writer changed. Prepare again for the current writer.') + ' Recovery download paused: ' + error.message); }
    return record;
  }
  async function download(prepared) {
    if (!Castor.keep || !Castor.keep.snapshot) throw Error('Coordinated recovery is unavailable. Keep this page open and copy your unsent words.');
    say('Taking a recovery snapshot. Writing pauses briefly while the copy is built.');
    return Castor.keep.snapshot(function (check) { return downloadPack(check, prepared); });
  }
  async function downloadPack(check, prepared) {
    var expected = account(), writer = Castor.role.who;
    if (prepared && prepared.account !== expected) throw Error('The writer changed. Prepare again for the current writer.');
    var record = await pointer();
    if (!record || record.account !== expected) throw Error('Prepare an offline copy for this writer first.');
    if (prepared && prepared.cache !== record.cache) throw Error('The prepared copy changed. Prepare again before downloading recovery.');
    var cache = await global.caches.open(record.cache), files = [];
    for (var row of record.objects) {
      check();
      var response = await cache.match(row.url);
      if (!response) throw Error('A prepared file is missing. Prepare the copy again.');
      var bytes = new Uint8Array(await response.arrayBuffer());
      if (await digest(bytes) !== row.sha256) throw Error('A prepared file changed. Prepare the copy again.');
      var binary = ''; for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      files.push({ url: row.url, type: response.headers.get('Content-Type'), bytes: btoa(binary), sha256: row.sha256 });
    }
    if (Castor.editor && Castor.editor.flush) Castor.editor.flush();
    if (!Castor.keep || !Castor.keep.now || !await Castor.keep.now()) throw Error('The latest words could not be retained. Keep this page open and copy them.');
    check();
    var recovery = {};
    for (var k = 0; k < global.localStorage.length; k++) {
      var key = global.localStorage.key(k);
      if (ownCommentKey(key, expected)) recovery[key] = global.localStorage.getItem(key);
    }
    if (!Castor.keep || !Castor.keep.all) throw Error('The full writing journal is unavailable. Keep this page open and copy your unsent words.');
    var held = await Castor.keep.all();
    if (account() !== expected || Castor.role.who !== writer) throw Error('The writer changed. Prepare again for the current writer.');
    held = held.filter(function (entry) { var first = entry.who && entry.who[0]; return (typeof first === 'string' ? first : first && first.id) === writer; });
    var workspace = Castor.canvas && Castor.canvas.pendingForAccount ? Castor.canvas.pendingForAccount(expected) : [];
    // Older pages have only their per-page marker, so check again after all reads.
    var open = await navigator.locks.query();
    check();
    if (open.held.some(function (lock) { return lock.name.startsWith('castor.keep.page.') && lock.name !== 'castor.keep.page.' + Castor.keep.page; })) throw Error('Close the other Descant writing tabs first so their last keystrokes are included in recovery. If no other tab is open, quit the browser fully, reopen Descant and try again.');
    if (account() !== expected || Castor.role.who !== writer) throw Error('The writer changed. Keep the page open and download again.');
    var blob = new Blob([JSON.stringify({ format: 'descant-flight-v1', manifest: record, files: files, recovery: recovery, journal: held, workspace: workspace }, null, 2)], { type: 'application/json' });
    if (blob.size > 128 * 1024 * 1024) throw Error('This recovery copy exceeds 128 MB. Keep the page open and download article copies separately.');
    var link = document.createElement('a'), url = URL.createObjectURL(blob);
    link.href = url; link.download = 'descant-flight-' + record.at.slice(0, 10) + '.json'; link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    if (recoveryAt) recoveryAt.textContent = 'Last download requested: ' + link.download + ', ' + new Date().toLocaleString() + '. Check your browser’s Downloads or Files.';
    say('Recovery download requested. Check that the file is saved on this device.');
    return blob;
  }
  async function restore(file) {
    if (!account() || !file || file.size > 128 * 1024 * 1024) throw Error('Choose this writer’s recovery file, smaller than 128 MB.');
    var rawFile = await file.text(), pack = JSON.parse(rawFile), importId = await digest(new TextEncoder().encode(rawFile));
    if (pack.format !== 'descant-flight-v1' || !pack.manifest || pack.manifest.account !== account() || !Array.isArray(pack.journal)) throw Error('This recovery file belongs to a different writer or format.');
    var entries = pack.journal;
    if (entries.some(function (entry) { var first = entry && entry.who && entry.who[0]; return (typeof first === 'string' ? first : first && first.id) !== Castor.role.who; })) throw Error('The original writer could not be confirmed.');
    if (!Castor.keep || !Castor.keep.importCopies) throw Error('The writing journal is unavailable. Keep the recovery file.');
    var recoveredKeys = Object.keys(pack.recovery || {});
    if (recoveredKeys.some(function (key) { return !ownCommentKey(key) || typeof pack.recovery[key] !== 'string'; })) throw Error('Unexpected comment recovery scope.');
    var workspace = pack.workspace || [];
    if (!Array.isArray(workspace) || workspace.length && (!Castor.canvas || !Castor.canvas.validatePendingForAccount)) throw Error('Workspace recovery is unavailable. Keep the recovery file.');
    if (Castor.canvas && Castor.canvas.validatePendingForAccount && !Castor.canvas.validatePendingForAccount(account(), workspace)) throw Error('The workspace original writer could not be confirmed.');
    for (var key of recoveredKeys) {
      if (key.endsWith('.writer.' + encodeURIComponent(account()))) {
        var value = JSON.parse(pack.recovery[key]);
        if (!Array.isArray(value) || value.some(function (row) { return !row || typeof row !== 'object'; })) throw Error('Invalid comment recovery data.');
      }
    }
    var recovered = await Castor.keep.importCopies(entries, importId), conflicts = 0;
    // Imported executable assets are never installed. The archive contains
    // source copies; a live authenticated Prepare offline verifies app assets.
    for (var key of recoveredKeys) {
      var old = global.localStorage.getItem(key), raw = pack.recovery[key];
      if (old === null) global.localStorage.setItem(key, raw);
      else if (old !== raw) {
        // A conflicting copy is evidence to compare, never an active send journal.
        var owner = '.writer.' + encodeURIComponent(account());
        var scope = key.slice(0, key.indexOf(owner) + owner.length);
        global.localStorage.setItem(scope + '.recovered.' + importId + '.' + encodeURIComponent(key),
          JSON.stringify({ v: 1, sourceKey: key, raw: raw }));
        conflicts++;
      }
    }
    var workspaceResult = Castor.canvas && Castor.canvas.restorePendingForAccount ? Castor.canvas.restorePendingForAccount(account(), workspace, importId) : { restored: 0 };
    try { if (Castor.comments && Castor.comments.layout) Castor.comments.layout(); }
    catch (e) { /* A rendering failure cannot undo durable recovery. Reopen Comments. */ }
    say(workspaceResult.restored + ' workspace copies and ' + recovered + ' independent writing copies restored. Open their articles in Files to compare them. ' + (conflicts ? conflicts + ' recovered comment copies are available in Comments; the originals were preserved.' : 'Current writing was preserved.'));
    return { writing: recovered, commentConflicts: conflicts, workspace: workspaceResult };
  }
  function primary(button) {
    button.addEventListener('click', function () {
      button.disabled = true; button.textContent = 'Preparing offline…';
      prepareAndRecover().catch(function () {}).finally(function () { button.disabled = false; button.textContent = 'Prepare all articles offline'; });
    });
  }
  function mount() {
    if (!account() || document.getElementById('descant-offline')) return;
    var settings = document.getElementById('castor-settings'); if (!settings) return;
    // One home: the Offline tab when the shell has it, else the end of Settings.
    var home = document.getElementById('settings-offline') || settings, tab = document.getElementById('settings-tab-offline');
    if (tab) tab.hidden = false;
    var area = document.createElement('div'); area.id = 'descant-offline';
    var prepareButton = document.createElement('button'); prepareButton.type = 'button'; prepareButton.className = 'descant-offline-action'; prepareButton.textContent = 'Prepare all articles offline';
    var exportButton = document.createElement('button'); exportButton.type = 'button'; exportButton.className = 'descant-recovery-download'; exportButton.textContent = 'Download recovery copy';
    var importButton = document.createElement('button'); importButton.type = 'button'; importButton.className = 'descant-recovery-restore'; importButton.textContent = 'Restore from a file…';
    var input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
    status = document.createElement('p'); status.className = 'set-hint'; status.setAttribute('role', 'status');
    function text(tag, words, cls) { var n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
    var offlineSection = document.createElement('section'); offlineSection.className = 'descant-offline-section';
    offlineSection.appendChild(text('h3', 'Write offline'));
    offlineSection.appendChild(text('p', 'Keeps every article, comment and file on this device, so you can keep writing without a connection.', 'set-hint'));
    offlineSection.appendChild(prepareButton);
    preparedAt = text('p', '', 'set-hint'); preparedAt.setAttribute('role', 'status'); offlineSection.appendChild(preparedAt); paintPreparation();
    var recoverySection = document.createElement('section'); recoverySection.className = 'descant-recovery-section';
    recoverySection.appendChild(text('h3', 'Recovery copy'));
    recoverySection.appendChild(text('p', 'A file with your articles and anything not yet saved online. Keep it outside the browser in case this device loses its data.', 'set-hint'));
    recoverySection.appendChild(text('p', 'On iPad, save it to On My iPad → Descant → Backups.', 'set-hint'));
    recoveryAt = text('p', '', 'set-hint'); recoveryAt.setAttribute('role', 'status');
    recoverySection.appendChild(recoveryAt); recoverySection.appendChild(exportButton);
    var restoreHelp = text('p', 'Pick a recovery file from Files or Downloads. Your current writing stays as it is. The file’s versions are added as separate copies you can open from Files to compare. Nothing is published.', 'set-hint');
    restoreHelp.id = 'descant-recovery-help'; importButton.setAttribute('aria-describedby', restoreHelp.id);
    recoverySection.appendChild(restoreHelp); recoverySection.appendChild(importButton); recoverySection.appendChild(input);
    area.appendChild(offlineSection); area.appendChild(recoverySection); area.appendChild(status); home.appendChild(area);
    primary(prepareButton);
    exportButton.addEventListener('click', function () { download().catch(function (error) { say(error.message); }); });
    importButton.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { if (input.files[0]) { var file = input.files[0]; input.value = ''; restore(file).catch(function (error) { say(error.message + ' Keep the original file.'); }); } });
    var mountedPreparation = preparation, mountedWhileBusy = busy;
    pointer().then(function (record) {
      if (mountedWhileBusy || preparation !== mountedPreparation || busy) return;
      if (record && record.account === account()) { receipt = record; say(record.articles + ' articles prepared ' + new Date(record.at).toLocaleString() + '. Download a fresh recovery copy after writing.'); }
    }).catch(function (error) { if (!mountedWhileBusy && preparation === mountedPreparation && !busy) say(error.message); });
    if (Castor.commands && Castor.commands.register) Castor.commands.register({ id: 'offline.prepare', title: 'Prepare all articles offline', section: 'Files', run: function () { prepareAndRecover().catch(function () {}); } });
  }
  Castor.offline = { connect: connect, mount: mount, prepare: prepare, prepareAndRecover: prepareAndRecover, download: download, restore: restore, receipt: function () { return receipt; } };
})(typeof window !== 'undefined' ? window : this);
