
(function (global) {
  'use strict';

  var Castor = global.Castor || (global.Castor = {});

  var SOON = 300;                      // every change is in the journal within this many ms
  var OPEN_WAIT = 2000;                // an IndexedDB that has not opened by then counts as absent
  var DB_NAME = 'castor-keep';
  var STORE = 'entries';
  var LOCAL = 'castor.keep.';          // localStorage copies: castor.keep.<key>
  var LEGACY = 'castor.unsaved.';      // castor.unsaved.<path>: {at, markdown}, a copy taken at a conflict
  var LOCK = 'castor.keep.page.';      // a Web Lock each open page holds for its whole life
  var WRITERS = 'castor.keep.writers'; // shared page admission, exclusive recovery snapshot

  var PAGE = pageId();
  var database = null;                 // a promise of the IndexedDB handle, or of null
  var healthy = true;                  // false while the latest write reached no store
  var queued = null;                   // {path, read} waiting for the timer
  var timer = 0;
  var chain = Promise.resolve();
  var inAir = null;                    // the entry handed to a store and not yet stored
  var receipts = {};                  // the exact text whose device write has committed
  var copySerial = 0, ownedPaths = Object.create(null), handoffs = Object.create(null);

  function pageId() {
    try {
      var a = new Uint32Array(2);
      global.crypto.getRandomValues(a);
      return a[0].toString(36) + a[1].toString(36);
    } catch (e) {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
  }

  function copyPage(label) {
    var unique;
    try { unique = global.crypto.randomUUID(); } catch (e) { unique = pageId(); }
    return 'copy-' + PAGE + '-' + unique + '-' + (++copySerial).toString(36) + (label ? '-' + label : '');
  }

  function ownedKey(entry) { return entry.page === PAGE || String(entry.page).indexOf('copy-' + PAGE + '-') === 0; }
  function writerOf(entry) { var first = entry.who && entry.who[0]; return (typeof first === 'string' ? first : first && first.id) || ''; }
  function acknowledgement(entry) { return !!entry && entry.confirmed && typeof entry.key === 'string' && entry.key.indexOf('saved|') === 0; }

  function beginHandoff(path) {
    var guard = handoffs[path] || (handoffs[path] = { active: 0, copies: Object.create(null) });
    guard.active++;
    return guard;
  }

  function endHandoff(path, guard, ok) {
    guard.active--;
    // A failed handoff remains guarded: its already-queued mutable write must
    // not destroy a variant whose independent copy could not commit.
    if (ok && !guard.active && handoffs[path] === guard) delete handoffs[path];
  }

  function independentCopy(entry, label) {
    var page = copyPage(label);
    return { key: page + '|' + entry.path, path: entry.path, text: entry.text, base: entry.base || '',
      who: (entry.who || []).slice(), at: typeof entry.at === 'number' ? entry.at : 0, page: page };
  }

  function noop() {}

  /* Run `work` after everything asked before it, whatever that came to. */
  function queue(work) {
    var run = chain.then(work, work);
    chain = run.then(noop, noop);
    return run;
  }

  /* --- which pages are open ------------------------------------------------
     Each page holds a Web Lock named after its id while it is shown, so
     another page can tell an entry still being written from one left behind.
     The lock is let go on pagehide: a page being reloaded or closed hands its
     entries to the next page at once, instead of when its teardown ends.
     Without Web Locks every other page counts as closed. */
  var letGo = null, pageEpoch = 0;
  var writerGo = null, writerDone = null, writerReady = null, writerBase = null, writerEpoch = 0, shown = true, snapshotting = false;
  function holdWriter() {
    if (writerReady) return writerReady;
    var locks = global.navigator && global.navigator.locks, body = global.document && global.document.body;
    if (!locks || !locks.request || !body) return Promise.resolve();
    var wasInert = writerBase === null ? !!body.inert : writerBase, epoch = ++writerEpoch;
    writerBase = wasInert;
    body.inert = true;
    writerReady = new Promise(function (admit) {
      writerDone = Promise.resolve(locks.request(WRITERS, { mode: 'shared' }, function () {
        if (epoch !== writerEpoch) { admit(); return; }
        body.inert = wasInert;
        writerBase = null;
        admit();
        if (!shown) return;
        return new Promise(function (resolve) { writerGo = resolve; });
      }));
      writerDone.catch(function () { if (epoch === writerEpoch) { body.inert = wasInert; writerBase = null; } admit(); });
    });
    return writerReady;
  }
  function holdPage() {
    try {
      var locks = global.navigator && global.navigator.locks;
      if (!locks || typeof locks.request !== 'function' || letGo) return;
      var epoch = ++pageEpoch;
      Promise.resolve(locks.request(LOCK + PAGE, function () {
        if (epoch !== pageEpoch || !shown) return;
        return new Promise(function (resolve) { letGo = resolve; });
      })).catch(noop);
    } catch (e) { /* no Web Locks here */ }
  }
  holdPage();
  holdWriter();
  try {
    global.addEventListener('pagehide', function () {
      shown = false;
      pageEpoch++;
      writerEpoch++;
      if (letGo) { letGo(); letGo = null; }
      if (writerGo) { writerGo(); writerGo = null; }
      writerReady = null;
    });
    global.addEventListener('pageshow', function (e) { if (e && e.persisted) { shown = true; holdPage(); holdWriter(); } });
  } catch (e) { /* no page events here */ }

  async function snapshot(work) {
    var locks = global.navigator && global.navigator.locks, body = global.document && global.document.body;
    if (!locks || !locks.request || !body || snapshotting) throw Error('Recovery needs coordinated storage. Keep this page open and try again.');
    await holdWriter();
    if (!writerGo || snapshotting) throw Error('The writing page could not be coordinated. Keep it open.');
    snapshotting = true;
    var wasInert = !!body.inert, editor = Castor.editor, readOnly = editor && editor.isReadOnly && editor.isReadOnly(), role = Castor.role;
    try {
      if (editor && editor.flush) editor.flush();
      if (editor && editor.setReadOnly) editor.setReadOnly(true);
      body.inert = true;
      writerGo(); writerGo = null; await writerDone; writerReady = null;
      return await locks.request(WRITERS, { ifAvailable: true }, async function (lock) {
        if (!lock) throw Error('Close the other Descant writing tabs first so their last keystrokes are included in recovery. If no other tab is open, quit the browser fully, reopen Descant and try again.');
        var expired = false, timer;
        function check() { if (expired || !shown) throw Error('Recovery took too long or the page closed. Keep this page open and try again.'); }
        try {
          return await Promise.race([Promise.resolve().then(async function () {
            var open = await locks.query();
            check();
            if (open.held.some(function (held) { return held.name.indexOf(LOCK) === 0 && held.name !== LOCK + PAGE; })) {
              throw Error('Close the other Descant writing tabs first so their last keystrokes are included in recovery. If no other tab is open, quit the browser fully, reopen Descant and try again.');
            }
            return work(check);
          }), new Promise(function (_, reject) {
            timer = setTimeout(function () { expired = true; reject(Error('Recovery took too long. Your writing remains here; try again.')); }, 30000);
          })]);
        } finally { clearTimeout(timer); expired = true; }
      });
    } finally {
      if (shown && !writerGo) await holdWriter();
      body.inert = wasInert;
      if (editor && editor.setReadOnly && Castor.role === role) editor.setReadOnly(!!readOnly);
      snapshotting = false;
    }
  }

  function openPages() {
    try {
      var locks = global.navigator && global.navigator.locks;
      if (!locks || typeof locks.query !== 'function') return Promise.resolve({});
      return Promise.resolve(locks.query()).then(function (state) {
        var open = {};
        ((state && state.held) || []).forEach(function (lock) {
          if (lock && typeof lock.name === 'string' && lock.name.indexOf(LOCK) === 0) open[lock.name.slice(LOCK.length)] = true;
        });
        return open;
      }, function () { return {}; });
    } catch (e) { return Promise.resolve({}); }
  }

  /* --- the two stores ------------------------------------------------------ */

  function local() {
    try { return global.localStorage || null; } catch (e) { return null; }
  }

  function openDatabase() {
    if (database) return database;
    database = new Promise(function (resolve) {
      var settled = false;
      function settle(handle) { if (!settled) { settled = true; resolve(handle); } }
      var factory = null;
      try { factory = global.indexedDB || null; } catch (e) { factory = null; }
      if (!factory || typeof factory.open !== 'function') { settle(null); return; }
      setTimeout(function () { settle(null); }, OPEN_WAIT);
      try {
        var request = factory.open(DB_NAME, 1);
        request.onupgradeneeded = function () {
          try { request.result.createObjectStore(STORE, { keyPath: 'key' }); } catch (e) { /* already there */ }
        };
        request.onsuccess = function () { settle(request.result); };
        request.onerror = function () { settle(null); };
        request.onblocked = function () { settle(null); };
      } catch (e) { settle(null); }
    });
    return database;
  }

  /* One transaction; resolves with the request's result once it has committed. */
  function idb(mode, work) {
    return openDatabase().then(function (handle) {
      if (!handle) { var absent = new Error('IndexedDB is not available here'); absent.code = 'IDB_UNAVAILABLE'; throw absent; }
      return new Promise(function (resolve, reject) {
        var tx, request;
        try {
          tx = handle.transaction(STORE, mode);
          request = work(tx.objectStore(STORE));
        } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(request ? request.result : undefined); };
        tx.onerror = tx.onabort = function () { reject(tx.error || new Error('IndexedDB did not take the write')); };
      });
    });
  }

  function valid(entry) {
    return !!entry && typeof entry.key === 'string' && typeof entry.path === 'string' &&
      typeof entry.text === 'string';
  }

  function localPut(entry) {
    var s = local();
    if (!s) return false;
    try { s.setItem(LOCAL + entry.key, JSON.stringify(entry)); return true; } catch (e) { return false; }
  }

  // Synchronous lifecycle writes can run while an independent IDB copy is
  // still uncommitted. Reusing that mutable fallback first would erase its
  // only words if the pending copy later aborts. This extra snapshot is scoped
  // to handoffs, never every ordinary local-only keystroke.
  function putFallback(entry) {
    if (entry.key !== keyOf(entry.path)) return localPut(entry);
    var previous;
    try { previous = localRead(LOCAL + entry.key, true); } catch (e) { return false; }
    if (!previous) return localPut(entry);
    if (!valid(previous) || previous.path !== entry.path || previous.who && !Array.isArray(previous.who)) return false;
    var signature = snapshotSignature(previous);
    if (signature === snapshotSignature(entry)) return localPut(entry);
    // A rejected older flight must not replace a newer synchronous journal,
    // including equal-clock snapshots when a later store is already in air.
    if ((previous.at || 0) > (entry.at || 0) || previous.at === entry.at && inAir && inAir !== entry) return false;
    var guard = handoffs[entry.path];
    if (guard && !guard.copies[signature]) {
      var copy = independentCopy(previous, 'lifecycle');
      if (!localPut(copy)) return false;
      guard.copies[signature] = copy; // setItem completed before mutable reuse.
    }
    return localPut(entry);
  }

  function localRead(name, strict) {
    var s;
    try { s = global.localStorage; return s ? JSON.parse(s.getItem(name)) : null; }
    catch (e) { if (strict) throw e; return null; }
  }

  function localDrop(name) {
    var s = local();
    if (!s) return;
    try { s.removeItem(name); } catch (e) { /* nothing to drop */ }
  }

  function localAll(strict) {
    var s, out = [], names = [];
    try { s = global.localStorage; if (!s) return out; for (var i = 0; i < s.length; i++) names.push(s.key(i)); }
    catch (e) { if (strict) throw e; return out; }
    names.forEach(function (name) {
      if (typeof name !== 'string') return;
      if (name.indexOf(LOCAL) === 0) {
        var entry = localRead(name, strict);
        if (valid(entry)) out.push(entry);
      } else if (name.indexOf(LEGACY) === 0) {
        var old = localRead(name, strict);
        if (old && typeof old.markdown === 'string') {
          out.push({ key: name, path: name.slice(LEGACY.length), text: old.markdown, base: '',
            at: Date.parse(old.at) || 0, page: '', legacy: true });
        }
      }
    });
    return out;
  }

  function snapshotSignature(entry) {
    return JSON.stringify([entry.path, entry.text, entry.base || '', entry.who || [], entry.at || 0]);
  }

  /* A timestamp cannot choose between divergent physical-store revisions. */
  function everything(strict) {
    var fromLocal;
    try { fromLocal = localAll(strict); } catch (e) { return Promise.reject(e); }
    return idb('readonly', function (s) { return s.getAll(); })
      .then(function (rows) { return rows || []; }, function (e) {
        // A cached absent handle cannot later overwrite unread IndexedDB data.
        // A failed read on an available handle can: never treat that as empty.
        if (strict && e.code !== 'IDB_UNAVAILABLE') throw e;
        return [];
      })
      .then(function (rows) {
        var seen = Object.create(null), out = [];
        rows.concat(fromLocal).forEach(function (entry) {
          if (!valid(entry)) return;
          var signature = JSON.stringify([entry.key, entry.page || '', !!entry.confirmed, snapshotSignature(entry)]);
          if (!seen[signature]) { seen[signature] = true; out.push(entry); }
        });
        return out;
      });
  }

  function remove(entry) {
    // localStorage has no compare-and-delete transaction. Only our own mutable
    // key (or our unique immutable key) can be checked and removed in this task.
    var ours = ownedKey(entry);
    var localName = entry.legacy ? entry.key : LOCAL + entry.key;
    var localCopy = localRead(localName);
    if (ours && localCopy && snapshotSignature(localCopy) === snapshotSignature(entry)) localDrop(localName);
    if (entry.legacy) return Promise.resolve(false);
    var removed = false;
    return idb('readwrite', function (s) {
      var request = s.getAll();
      request.onsuccess = function () {
        var current = (request.result || []).find(function (e) { return e.key === entry.key; });
        if (current && (current.page || '') === (entry.page || '') && snapshotSignature(current) === snapshotSignature(entry)) {
          s.delete(entry.key); removed = true;
        }
      };
      return request;
    }).then(function () { return removed; }, function () { return false; });
  }

  function dismissed(entry, entries) {
    // A canceled recovery may still finish an immutable clone under another
    // key. Disposition follows the exact snapshot, never merely its source key
    // or text (another writer's same-text work remains independent).
    return entries.some(function (receipt) {
      return receipt.confirmed && (receipt.key.indexOf('discarded|') === 0 || receipt.key.indexOf('saved|' + entry.path + '|') === 0) &&
        snapshotSignature(receipt) === snapshotSignature(entry);
    });
  }

  function tell(entry, ok) {
    if (ok && entry.page === PAGE) ownedPaths[entry.path] = true;
    if (ok) {
      var previous = receipts[entry.path];
      // Byte storage is new at ACK commit; that is not new typing/selection.
      var activity = entry.key === 'saved|' + entry.path ? 0 : entry.at || 0;
      if (previous && previous.text === entry.text) activity = Math.max(activity, previous.activity || 0);
      receipts[entry.path] = { text: entry.text, at: acknowledgement(entry) ? Date.now() : entry.at, activity: activity };
    } else delete receipts[entry.path];
    if (Castor.bus && Castor.bus.emit) Castor.bus.emit('keep:written', { path: entry.path, ok: ok });
  }

  /* IndexedDB first; localStorage when it cannot. A localStorage copy older
     than what IndexedDB now holds is dropped, a newer one is left alone. */
  function store(entry) {
    inAir = entry;
    var flight = queue(function () { return write(entry); });
    return Castor.saveStatus ? Castor.saveStatus.track(flight) : flight;
  }

  // Called within the journal queue so a multi-copy handoff cannot interleave writes.
  function write(entry) {
    var guard = handoffs[entry.path], mutable = entry.key === keyOf(entry.path);
    var prepared = guard && mutable ? everything(true).then(function (entries) { return protectCurrent(entry.path, entries); }, function () { return false; }) : Promise.resolve(true);
    return prepared.then(function (ok) {
      if (!ok) return false;
      return idb('readwrite', function (s) { return s.put(entry); }).then(function () {
        var copy = localRead(LOCAL + entry.key);
        // Only this page's mutable/immutable keys, or already server-backed
        // ACKs, may be cleaned; foreign pending words are never deleted here.
        if (copy && (ownedKey(entry) && snapshotSignature(copy) === snapshotSignature(entry) || acknowledgement(entry) && acknowledgement(copy))) localDrop(LOCAL + entry.key);
        return true;
      }, function () { return putFallback(entry); });
    }).then(function (ok) {
      if (inAir === entry) inAir = null;
      healthy = ok;
      tell(entry, ok);
      if (ok && mutable && handoffs[entry.path] && !handoffs[entry.path].active) delete handoffs[entry.path];
      return ok;
    });
  }

  /* --- what app.js calls ---------------------------------------------------- */

  function keyOf(path) { return PAGE + '|' + path; }

  function take() {
    clearTimeout(timer);
    timer = 0;
    var q = queued;
    queued = null;
    if (!q) return null;
    var got = null;
    try { got = q.read(); } catch (e) { got = null; }
    if (!got || typeof got.text !== 'string') return null;
    return { key: keyOf(q.path), path: q.path, text: got.text, base: got.base || '', who: got.who || [], at: Date.now(), page: PAGE };
  }

  /* A change happened to `path`; read() returns {text, base, who} (or null) when
     the write runs, so a burst of keystrokes is one write of the latest text. */
  function note(path, read) {
    if (queued && queued.path !== path) now();
    queued = { path: path, read: read };
    if (!timer) timer = setTimeout(now, SOON);
  }

  /* Write what is waiting now. Resolves true once it is stored. */
  function now() {
    var entry = take();
    if (entry) return store(entry);
    return queue(function () { return healthy; });
  }

  /* For a page that is closing: what is waiting, or still on its way to
     IndexedDB, goes to localStorage synchronously. True when everything typed
     is in a store or on its way to one that has been working. */
  function nowSync() {
    var entry = take();
    if (entry) store(entry);
    var pending = entry || inAir;
    if (!pending) return healthy;
    var copied = putFallback(pending);
    if (copied && pending.page === PAGE) ownedPaths[pending.path] = true;
    // Even a same-text mutable receipt can be erased by an older outstanding
    // write. Only this completed synchronous copy can certify pending closing.
    return copied;
  }

  // Only ACK text is already known to exist on the server. Its reserved keys
  // may be bounded even when another page concurrently replaces an ACK there;
  // this permission NEVER applies to pending writing or Discard archives.
  function removeAcknowledgement(entry) {
    var current = localRead(LOCAL + entry.key);
    if (acknowledgement(entry) && acknowledgement(current)) localDrop(LOCAL + entry.key);
    return remove(entry);
  }

  /* One exact latest ACK per article/primary writer, in the existing namespace.
     Replacing an older ACK cannot lose sole words: both were server-confirmed.
     An old late clone may reappear after replacement; keep its bytes, rather
     than fill the device with a full-text receipt for every ordinary save. */
  function confirm(path, text, writer) {
    if (queued && queued.path === path) now();
    var flight = queue(async function () {
      var entries = await everything();
      var accepted = entries.filter(function (e) {
        return !e.confirmed && e.path === path && e.text === text && (!writer || writerOf(e) === writer);
      });
      if (!accepted.length && !writer) {
        // No source revision and no verified writer: do not invent an
        // unscoped receipt, nor prune any existing writing or ACK. An already
        // exact server ACK may still prove these bytes on this device.
        var existing = entries.find(function (e) { return acknowledgement(e) && e.path === path && e.text === text; });
        if (existing) tell(existing, true);
        return true;
      }
      var latest = Object.create(null);
      accepted.forEach(function (entry) { var id = writerOf(entry); if (!latest[id] || (entry.at || 0) > (latest[id].at || 0)) latest[id] = entry; });
      if (!accepted.length) latest[writer || ''] = { path: path, text: text, base: '', who: writer ? [writer] : [], at: 0 };
      for (var id of Object.keys(latest)) {
        var chosen = latest[id], key = 'saved|' + path + '|writer-' + encodeURIComponent(id);
        // Prune only obsolete ACK keys (including older per-revision
        // ACKs). In-place replacement needs no growing localStorage budget.
        for (var old of entries) if (acknowledgement(old) && old.path === path && writerOf(old) === id && old.key !== key) await removeAcknowledgement(old);
        if (!await write({ key: key, path: path, text: text, base: chosen.base || '', who: (chosen.who || []).slice(),
          at: chosen.at || 0, page: '', confirmed: true })) return false;
      }
      for (var entry of accepted) await remove(entry);
      return true;
    });
    return Castor.saveStatus ? Castor.saveStatus.track(flight) : flight;
  }

  function unverifiedLegacy(entry, entries) {
    if (entry.confirmed) return false;
    // The released fixed receipt proves bytes, not this writer/revision. Keep
    // ambiguous old copies available as history; never silently ACK them all.
    return entries.some(function (receipt) {
      return receipt.confirmed && receipt.key === 'saved|' + entry.path && receipt.text === entry.text &&
        (!receipt.at || !entry.at || entry.at <= receipt.at);
    });
  }

  function shape(entry, open) {
    var copyOwner = /^copy-([a-z0-9]+)-/.exec(String(entry.page || ''));
    var owner = copyOwner ? copyOwner[1] : entry.page;
    var result = {
      key: entry.key, path: entry.path, text: entry.text, base: entry.base || '', who: entry.who || [], at: entry.at || 0,
      page: entry.page || '', legacy: !!entry.legacy,
      mine: entry.page === PAGE,
      live: !!owner && owner !== PAGE && !!open[owner]
    };
    if (entry.confirmed) result.confirmed = true;
    return result;
  }

  /* Every entry for one article, newest first. `live` marks an entry another
     open page is still writing; `mine` one this page wrote. */
  function list(path, options) {
    options = options || {};
    return queue(function () {
      return Promise.all([everything(!!options.strict), openPages()]).then(function (got) {
        return got[0].filter(function (e) {
          if (path !== undefined && e.path !== path) return false;
          if (options.includeKept) return !e.confirmed || e.key.indexOf('discarded|') === 0;
          // The application can request acknowledged matching-text evidence
          // for age checks without exporting it as pending writing by default.
          // The fixed saved|path time is an acknowledgement time, NOT a
          // typing time. Only captured-revision receipts supply age evidence.
          if (e.confirmed) return !!options.includeEvidence && (e.key.indexOf('discarded|') === 0 || e.key.indexOf('saved|' + e.path + '|') === 0);
          return !dismissed(e, got[0]);
        })
          .map(function (e) {
            var result = shape(e, got[1]);
            if (unverifiedLegacy(e, got[0])) Object.defineProperty(result, 'unverified', { value: true });
            return result;
          })
          .sort(function (a, b) { return b.at - a.at; });
      });
    });
  }

  /* This page's own entries, for every article, newest first. */
  function mine() {
    return queue(function () {
      return everything().then(function (entries) {
        return entries.filter(function (e) { return e.page === PAGE && !e.confirmed; })
          .map(function (e) { return shape(e, {}); })
          .sort(function (a, b) { return b.at - a.at; });
      });
    });
  }

  /* Every unsent copy on this device, for any article and any page, read back from
     the stores after every write asked before it. Rejects when a store that may
     hold words cannot be read: an unreadable store is never taken as empty. */
  function unsent() {
    return queue(function () {
      return everything(true).then(function (entries) {
        return entries.filter(function (e) { return !e.confirmed && !dismissed(e, entries); })
          .map(function (e) { return { path: e.path, text: e.text }; });
      });
    });
  }

  function independent(entry) { return /^copy-[a-z0-9]+-/.test(String(entry.page || '')); }

  // Immutable copies never share a writer's next mutable journal destination.
  async function protect(entry, entries, label) {
    var signature = snapshotSignature(entry);
    var guard = handoffs[entry.path];
    var existing = entries.find(function (e) { return !e.confirmed && independent(e) && snapshotSignature(e) === signature; }) || guard && guard.copies[signature];
    if (existing) { if (guard) guard.copies[signature] = existing; tell(existing, true); return true; }
    var copy = independentCopy(entry, label);
    if (!await write(copy)) {
      // A lifecycle callback may have synchronously committed the same exact
      // snapshot under another immutable key while this IDB attempt waited.
      var emergency = guard && guard.copies[signature];
      if (!emergency) return false;
      healthy = true; tell(emergency, true); entries.push(emergency); return true;
    }
    if (guard) guard.copies[signature] = copy;
    entries.push(copy);
    return true;
  }

  async function protectCurrent(path, entries) {
    var current = entries.filter(function (e) { return e.key === keyOf(path) && !e.confirmed; });
    for (var previous of current) if (!await protect(previous, entries)) return false;
    return true;
  }

  // A server baseline is also a handoff: later typing must not overwrite an
  // older own draft merely because that draft has a different Git base.
  function preserveCurrent(path, observedOwn) {
    if (!ownedPaths[path] && !observedOwn) return Promise.resolve(true);
    var guard = beginHandoff(path);
    return queue(async function () {
      var ok = false;
      try { ok = await protectCurrent(path, await everything(true)); return ok; }
      catch (e) {
        healthy = false;
        if (Castor.bus && Castor.bus.emit) Castor.bus.emit('keep:written', { path: path, ok: false });
        return false;
      } finally { endHandoff(path, guard, ok); }
    });
  }

  /* Adoption protects both sides, without replacing a mutable key or deleting
     a source that another page may resume writing at any moment. */
  function adopt(entry) {
    if (!entry) return Promise.resolve(false);
    var guard = beginHandoff(entry.path);
    var flight = queue(async function () {
      var ok = false;
      try {
        var entries = await everything(true);
        if (!await protectCurrent(entry.path, entries)) return false;
        ok = await protect(entry, entries); return ok;
      } catch (e) { healthy = false; tell(entry, false); return false; }
      finally { endHandoff(entry.path, guard, ok); }
    });
    return Castor.saveStatus ? Castor.saveStatus.track(flight) : flight;
  }

  /* The writer chose Discard. */
  function discard(entry) {
    if (!entry || !entry.key) return Promise.resolve(false);
    return queue(async function () {
      var entries = await everything(true);
      var prefix = 'discarded|' + encodeURIComponent(entry.key) + '|';
      var receipt = entries.find(function (e) { return e.confirmed && e.key.indexOf('discarded|') === 0 && snapshotSignature(e) === snapshotSignature(entry); });
      if (!receipt) {
        var page = copyPage('discarded');
        receipt = { key: prefix + page, path: entry.path, text: entry.text,
          base: entry.base || '', who: (entry.who || []).slice(), at: typeof entry.at === 'number' ? entry.at : 0, page: page, confirmed: true };
        if (!await write(receipt)) return false;
      }
      await remove(entry);
      return true;
    });
  }

  /* A recovery import adds independent copies. Existing entries and receipts
     are never replaced, and opening still compares the original base revision. */
  async function importCopies(entries, importId) {
    var copies = entries.map(function (entry) {
      if (!entry || typeof entry.text !== 'string' || typeof entry.base !== 'string' || !Array.isArray(entry.who) ||
          !/^articles\/[A-Za-z0-9._-]+\/(?:article\.md|drafts\/[A-Za-z0-9._/-]+\.md)$/.test(entry.path) || /(?:^|\/)\.\.(?:\/|$)/.test(entry.path)) throw Error('Invalid recovery writing.');
      return { path: entry.path, text: entry.text, base: entry.base, who: entry.who.slice(), at: typeof entry.at === 'number' ? entry.at : 0 };
    });
    var flight = queue(async function () {
      var existing = await everything();
      for (var copy of copies) if (!await protect(copy, existing, importId)) throw Error('This device could not retain every recovered copy. Keep the recovery file.');
      return copies.length;
    });
    return Castor.saveStatus ? Castor.saveStatus.track(flight) : flight;
  }

  Castor.keep = {
    page: PAGE,
    note: note,
    now: now,
    nowSync: nowSync,
    confirm: confirm,
    list: list,
    all: function () { return list(); },
    snapshot: snapshot,
    mine: mine,
    unsent: unsent,
    adopt: adopt,
    preserveCurrent: preserveCurrent,
    discard: discard,
    importCopies: importCopies,
    receipt: function (path, text, options) { var r = receipts[path]; return r && r.text === text ? options && options.activity ? r.activity || 0 : r.at : 0; },
    healthy: function () { return healthy; }
  };
})(typeof window !== 'undefined' ? window : this);
