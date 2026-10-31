
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

  function pageId() {
    try {
      var a = new Uint32Array(2);
      global.crypto.getRandomValues(a);
      return a[0].toString(36) + a[1].toString(36);
    } catch (e) {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
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
      if (!handle) throw new Error('IndexedDB is not available here');
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

  function localRead(name) {
    var s = local();
    if (!s) return null;
    try { return JSON.parse(s.getItem(name)); } catch (e) { return null; }
  }

  function localDrop(name) {
    var s = local();
    if (!s) return;
    try { s.removeItem(name); } catch (e) { /* nothing to drop */ }
  }

  function localAll() {
    var s = local(), out = [], names = [];
    if (!s) return out;
    try { for (var i = 0; i < s.length; i++) names.push(s.key(i)); } catch (e) { return out; }
    names.forEach(function (name) {
      if (typeof name !== 'string') return;
      if (name.indexOf(LOCAL) === 0) {
        var entry = localRead(name);
        if (valid(entry)) out.push(entry);
      } else if (name.indexOf(LEGACY) === 0) {
        var old = localRead(name);
        if (old && typeof old.markdown === 'string') {
          out.push({ key: name, path: name.slice(LEGACY.length), text: old.markdown, base: '',
            at: Date.parse(old.at) || 0, page: '', legacy: true });
        }
      }
    });
    return out;
  }

  /* Every entry in both stores, one per key, the newest copy of each. */
  function everything() {
    var fromLocal = localAll();
    return idb('readonly', function (s) { return s.getAll(); })
      .then(function (rows) { return rows || []; }, function () { return []; })
      .then(function (rows) {
        var byKey = {};
        rows.concat(fromLocal).forEach(function (entry) {
          if (!valid(entry)) return;
          var had = byKey[entry.key];
          if (!had || (entry.at || 0) > (had.at || 0)) byKey[entry.key] = entry;
        });
        return Object.keys(byKey).map(function (k) { return byKey[k]; });
      });
  }

  function remove(entry) {
    if (entry.legacy) { localDrop(entry.key); return Promise.resolve(); }
    localDrop(LOCAL + entry.key);
    return idb('readwrite', function (s) { return s.delete(entry.key); }).then(noop, noop);
  }

  function tell(entry, ok) {
    if (ok) receipts[entry.path] = { text: entry.text, at: entry.at };
    else delete receipts[entry.path];
    if (Castor.bus && Castor.bus.emit) Castor.bus.emit('keep:written', { path: entry.path, ok: ok });
  }

  /* IndexedDB first; localStorage when it cannot. A localStorage copy older
     than what IndexedDB now holds is dropped, a newer one is left alone. */
  function store(entry) {
    inAir = entry;
    var flight = queue(function () {
      return idb('readwrite', function (s) { return s.put(entry); }).then(function () {
        var copy = localRead(LOCAL + entry.key);
        if (copy && (copy.at || 0) <= entry.at) localDrop(LOCAL + entry.key);
        return true;
      }, function () {
        return localPut(entry);
      }).then(function (ok) {
        if (inAir === entry) inAir = null;
        healthy = ok;
        tell(entry, ok);
        return ok;
      });
    });
    return Castor.saveStatus ? Castor.saveStatus.track(flight) : flight;
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
    var copied = localPut(pending);
    return copied || healthy;
  }

  /* The server holds exactly `text` for `path`: every entry with that text goes. */
  function confirm(path, text, writer) {
    if (queued && queued.path === path) now();
    return queue(function () {
      return everything().then(function (entries) {
        return Promise.all(entries.filter(function (e) {
          var first = e.who && e.who[0];
          return e.path === path && e.text === text && (!writer || (typeof first === 'string' ? first : first && first.id) === writer);
        }).map(remove));
      });
    }).then(function () {
      return store({ key: 'saved|' + path, path: path, text: text, base: '', at: Date.now(), page: '', confirmed: true });
    });
  }

  function shape(entry, open) {
    return {
      key: entry.key, path: entry.path, text: entry.text, base: entry.base || '', who: entry.who || [], at: entry.at || 0,
      page: entry.page || '', legacy: !!entry.legacy,
      mine: entry.page === PAGE,
      live: !!entry.page && entry.page !== PAGE && !!open[entry.page]
    };
  }

  /* Every entry for one article, newest first. `live` marks an entry another
     open page is still writing; `mine` one this page wrote. */
  function list(path) {
    return queue(function () {
      return Promise.all([everything(), openPages()]).then(function (got) {
        return got[0].filter(function (e) { return (path === undefined || e.path === path) && !e.confirmed; })
          .map(function (e) { return shape(e, got[1]); })
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

  /* An entry left by a closed page becomes this page's: written under this
     page's key first, then the old key goes. */
  function adopt(entry) {
    if (!entry || entry.mine) return Promise.resolve(true);
    var copy = { key: keyOf(entry.path), path: entry.path, text: entry.text, base: entry.base || '', who: entry.who || [],
      at: entry.at || Date.now(), page: PAGE };
    return store(copy).then(function (ok) {
      if (!ok) return false;
      return queue(function () { return remove(entry); }).then(function () { return true; });
    });
  }

  /* The writer chose Discard. */
  function discard(entry) {
    if (!entry || !entry.key) return Promise.resolve();
    if (queued && entry.mine && queued.path === entry.path) { clearTimeout(timer); timer = 0; queued = null; }
    return queue(function () { return remove(entry); });
  }

  /* A recovery import adds independent copies. Existing entries and receipts
     are never replaced, and opening still compares the original base revision. */
  async function importCopies(entries, importId) {
    var copies = entries.map(function (entry, index) {
      if (!entry || typeof entry.text !== 'string' || typeof entry.base !== 'string' || !Array.isArray(entry.who) ||
          !/^articles\/[A-Za-z0-9._-]+\/(?:article\.md|drafts\/[A-Za-z0-9._/-]+\.md)$/.test(entry.path) || /(?:^|\/)\.\.(?:\/|$)/.test(entry.path)) throw Error('Invalid recovery writing.');
      var page = 'recovery-' + (importId ? importId + '-' + index : global.crypto.randomUUID());
      return { key: page + '|' + entry.path, page: page, path: entry.path, text: entry.text, base: entry.base, who: entry.who.slice(), at: entry.at || Date.now() };
    });
    for (var copy of copies) if (!await store(copy)) throw Error('This device could not retain every recovered copy. Keep the recovery file.');
    return copies.length;
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
    adopt: adopt,
    discard: discard,
    importCopies: importCopies,
    receipt: function (path, text) { var r = receipts[path]; return r && r.text === text ? r.at : 0; },
    healthy: function () { return healthy; }
  };
})(typeof window !== 'undefined' ? window : this);
