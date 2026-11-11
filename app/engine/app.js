/* ============================================================================
   Castor engine — app.js
   Wiring, and nothing else: read the embedded data, render the page, mount the
   docks, hand every module that happens to exist its element, and wire the top
   bar's words, the article tabs and their fold, the light/dark toggle, Focus,
   and the footer line (word count, save word, Shortcuts, Settings).

   Every module is optional. The shell must be drivable with only engine.css,
   panels.js and this file present, so each call is guarded and a module that
   throws is reported in its panel instead of taking the app down.
   ========================================================================== */

(function (global) {
  'use strict';

  var Castor = global.Castor || (global.Castor = {});
  var toggleShortcutHints = null;

  /* signature.css is loaded after the world's stylesheet, so the provenance
     contract wins without asking every shell to repeat it. A self-contained
     build may inline the same file and mark it with this id. */
  function installSignatureStyles() {
    if (typeof document === 'undefined' || document.getElementById('castor-signature')) return false;
    var script = document.currentScript ||
      document.querySelector('script[src$="/engine/app.js"],script[src="../../engine/app.js"],script[src="../engine/app.js"]');
    if (!script || !script.src) return false;
    var link = document.createElement('link');
    link.id = 'castor-signature';
    link.rel = 'stylesheet';
    link.href = new URL('signature.css', script.src).href;
    document.head.appendChild(link);
    return true;
  }

  installSignatureStyles();

  /* --- the event bus ------------------------------------------------------- */
  /* 'layout' (docks moved) · 'doc:change' · 'select' · 'theme' · 'size'
     plus 'panel:open' / 'panel:close' derived from layout, for modules that
     only do work while their panel is up (changes.js turns the marks on). */

  var subs = {};
  var bus = Castor.bus = {
    on: function (name, fn) { (subs[name] || (subs[name] = [])).push(fn); return bus; },
    off: function (name, fn) {
      var a = subs[name]; if (!a) return bus;
      var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
      return bus;
    },
    emit: function (name, payload) {
      (subs[name] || []).slice().forEach(function (fn) {
        try { fn(payload); } catch (e) { console.error('[castor] ' + name, e); }
      });
      return bus;
    }
  };

  /* --- criticism from drives and agents ---------------------------------- */

  var CRITIQUE_KEY = 'castor.agent-critique';

  function critiqueRecord(input) {
    if (!input || typeof input !== 'object') throw new TypeError('Castor.critique.note needs an object.');
    var record = {
      step: String(input.step || '').trim(),
      what: String(input.what || '').trim(),
      why: String(input.why || '').trim(),
      cut: String(input.cut || '').trim(),
      time: new Date().toISOString()
    };
    if (!record.step || !record.what || !record.why) {
      throw new TypeError('Castor.critique.note needs step, what, and why.');
    }
    return record;
  }

  function storeCritique(record) {
    var notes = [];
    try {
      notes = JSON.parse(global.localStorage.getItem(CRITIQUE_KEY) || '[]');
      if (!Array.isArray(notes)) notes = [];
      notes.push(record);
      global.localStorage.setItem(CRITIQUE_KEY, JSON.stringify(notes));
      return Promise.resolve({ saved: true, storage: 'local', count: notes.length, note: record });
    } catch (e) {
      return Promise.reject(new Error('Local critique storage is unavailable.'));
    }
  }

  function noteCritique(input) {
    var record = critiqueRecord(input);
    var protocol = global.location && global.location.protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return storeCritique(record);
    return global.fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        world: 'agent-critique', step: record.step, what: record.what,
        why: record.why, cut: record.cut, time: record.time
      })
    }).then(function (response) {
      if (!response.ok) throw new Error('The critique endpoint answered ' + response.status + '.');
      return response.json();
    });
  }

  Castor.critique = { note: noteCritique };

  /* --- data ---------------------------------------------------------------- */

  var PLACEHOLDER = '# A page with nothing on it yet\n\n' +
    'No data was embedded in this shell, so the engine is showing two paragraphs of its own. ' +
    'Everything else on the screen is real: the docks open, the page keeps its measure beside them, ' +
    'and Zen takes the chrome away.\n\n' +
    'Give the shell a `<script id="castor-data" type="application/json">` block, or load ' +
    '`Castor.SAMPLE`, and this text is replaced by the piece.';

  Castor.piecePath = function () {
    if (liveState && liveState.path) return String(liveState.path);
    var d = (Castor.app && Castor.app.data) || {};
    var piece = d.piece || {};
    var folder = piece.folder || '';
    var files = piece.files || [];
    var best = '';
    for (var i = 0; i < files.length; i++) {
      var f = String(files[i]);
      if (!/\.md$/.test(f)) continue;
      if (/(^|\/)materials\//.test(f) || /(^|\/)INDEX\.md$/.test(f)) continue;
      var full = f.indexOf('/') === 0 ? f.slice(1)
        : (folder && f.indexOf(folder) !== 0 ? folder + '/' + f : f);
      if (/\/article\.md$/.test(full)) return full;
      if (!best) best = full;
    }
    if (best) return best;
    return folder ? folder + '/article.md' : '';
  };

  function readData() {
    var tag = document.getElementById('castor-data');
    if (tag && tag.textContent.trim()) {
      try { return JSON.parse(tag.textContent); }
      catch (e) { console.error('[castor] #castor-data is not JSON', e); }
    }
    if (Castor.SAMPLE) return Castor.SAMPLE;
    return {
      piece: { title: 'Untitled', folder: '', files: [] },
      versions: [{ id: 'v1', label: 'placeholder', markdown: PLACEHOLDER }],
      current: 'v1', pieces: [], comments: [], canvas: null, agentNotes: {}
    };
  }

  /* --- live: the piece read from the repository, not from the block ------- */
  /* Served over http(s) AND asked for (?live, #live, or data-live="1" on a script
     tag), the shell fetches the piece and its real saves from serve.py instead of
     reading the block build.py embedded. The block stays as the fallback, so the
     same built file still opens from disk with nothing running. */

  var DEFAULT_PIECE = 'design/app/engine/sample/sample.md';
  var liveState = null;
  var displayedPath = null;

  function liveConfig() {
    var loc = global.location || {};
    if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return null;
    var search = loc.search || '', hash = loc.hash || '';
    var tag = document.querySelector('script[data-live]');
    var inUrl = /[?&]live(=|&|$)/.test(search) || /(^#|&)live($|&|=)/.test(hash);
    var asked = inUrl || !!(tag && tag.getAttribute('data-live') === '1');
    if (!asked) return null;
    /* ?live=<path> names another piece; ?live on its own means the sample. A value
       with no slash in it is a flag ("?live=1"), never a path. `explicit` says the
       address itself asked: the built page's own default article is only a default,
       and gives way to the article this writer last had open (boot, below). */
    var m = /[?&]live=([^&]*)/.exec(search);
    var named = m ? decodeURIComponent(m[1]) : ((tag && tag.getAttribute('data-piece')) || '');
    return { path: named.indexOf('/') > 0 ? named : DEFAULT_PIECE, explicit: inUrl };
  }

  var PUBLIC_WRITER = readData().publicWriter === true || /^\/write(?:\/|$)/.test((global.location || {}).pathname || '');
  var PUBLIC_REVIEWER = readData().publicReviewer === true || /^\/read(?:\/|$)/.test((global.location || {}).pathname || '');
  Castor.role = Castor.role || { reviewer: false, confirmed: false, name: '' };
  Castor.roleFrom = function (payload) {
    if (!payload || typeof payload !== 'object' || payload.role !== 'reviewer') {
      if (PUBLIC_REVIEWER) return { reviewer: true, confirmed: false, name: '' };
      var founder = { reviewer: false, confirmed: !!payload && payload.role === 'founder', name: '' };
      if (founder.confirmed && payload.publicWriter === true && !!(Castor.people && Castor.people.isWriter(payload.who)) && payload.id === 'founder:' + payload.who) {
        founder.publicWriter = true; founder.id = payload.id; founder.who = payload.who; founder.offline = payload.offline === true;
        if (payload.passwords === false) founder.passwords = false;
      }
      if (PUBLIC_WRITER) {
        founder.publicWriter = true;
        founder.confirmed = !!(founder.id && founder.who);
      }
      return founder;
    }
    var name = typeof payload.name === 'string' ? payload.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    var id = typeof payload.id === 'string' ? payload.id : '';
    return Object.assign({ reviewer: true, confirmed: true, name: name }, payload.writingApp === true ? { writingApp: true } : {}, id ? { id: id } : {}, typeof payload.color === 'string' && payload.color.length === 7 && /^#[0-9a-fA-F]{6}$/.test(payload.color) ? { color: payload.color } : {});
  };
  function reviewing() { return !!(Castor.role && Castor.role.reviewer); }

  /* A slow server still lets the page open, with no authenticated replay grant. */
  var ROLE_WAIT = 8000, roleStatus = 0;
  function askRole() {
    if (!servedOverHttp() || !global.fetch) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var settled = false;
      function finish(payload) { if (settled) return; settled = true; clearTimeout(timer); resolve(payload); }
      var timer = setTimeout(function () { roleStatus = 0; finish(null); }, ROLE_WAIT);
      function ask(retries) {
        if (settled) return;
        global.fetch('/api/whoami', { cache: 'no-store' })
          .then(function (r) {
            roleStatus = r.status;
            // A first-load font may bind the new worker client before whoami
            // returns. Reconfirm once without weakening the worker's boundary.
            if (PUBLIC_WRITER && r.status === 409 && retries) { ask(retries - 1); return; }
            return (r.ok ? r.json() : Promise.resolve(null)).then(finish);
          }).catch(function () { roleStatus = 0; finish(null); });
      }
      ask(1);
    });
  }

  /* A writer page whose sign-in could not be confirmed is never left stuck. It asks
     again when it comes back to the screen, when the network returns and every 20 s;
     once the writer is confirmed it reopens, since everything typed here is kept on
     this device (the journal, comment drafts) and reopening binds it to that writer.
     A session that has ended is said in plain words, with the way back in. */
  var signedOut = false, recheck = null, recheckTimer = 0, roleSettled = false, openingCheck = null;
  function reconfirm(now) {
    // A Post before the opening check settles is answered by that check: a page it confirms
    // has nothing to reopen. Otherwise only after it settles, and never on a reader's page.
    if (!roleSettled && now && openingCheck && !PUBLIC_REVIEWER) return openingCheck.then(function () { return reconfirm(now); });
    if (!roleSettled || PUBLIC_REVIEWER || reviewing() || Castor.role.confirmed) return Promise.resolve(!!Castor.role.confirmed);
    if (!recheck) recheck = askRole().then(function (payload) {
      recheck = null;
      if (Castor.roleFrom(payload).confirmed) { reopen(now); return true; }
      unconfirmed();
      return false;
    });
    return recheck;
  }
  // What an unconfirmed answer means: an ended session is said; anything else is asked again
  // in 20 s while the page is on screen (coming back to the screen asks at once).
  function onScreen() { return document.visibilityState === 'visible'; }
  function unconfirmed() {
    if (PUBLIC_WRITER && (roleStatus === 401 || roleStatus === 403)) showSignedOut();
    // 409: this page's writer is no longer the one signed in in this browser. A reload would open
    // the other writer, so the way back as himself is the sign-in page.
    else if (PUBLIC_WRITER && roleStatus === 409) showSignedOut('Another writer is signed in in this browser. Everything you typed stays on this device. To go on writing as yourself, sign in again; to write as them, open Descant in a new tab.', 'Another writer', '/signin?write=1');
    else if (!recheckTimer && onScreen()) recheckTimer = setTimeout(function () { recheckTimer = 0; if (onScreen()) reconfirm(); }, 20000);
  }
  function reopen(now) {
    var field = document.activeElement;
    if (!now && field && field !== document.body && (field.isContentEditable || /^(INPUT|TEXTAREA)$/.test(field.tagName || ''))) {
      field.addEventListener('blur', function () { setTimeout(function () { reopen(true); }, 0); }, { once: true });
      return;
    }
    flushSave(true);
    try { global.location.reload(); } catch (e) { /* the next check reopens it */ }
  }
  var signinAt = '';
  function showSignedOut(detail, word, at) {
    signedOut = true; signinAt = at || '';
    setSave('locked', detail || 'Your sign-in has ended. Everything you typed stays on this device. Sign in again to go on writing.', word || 'Signed out');
  }
  Castor.reconfirm = function (reason) { return reconfirm(reason === 'comment'); };
  // A send that finds the session ended keeps the writer named, marked ended: their threads and
  // pending comments stay in view, read-only, and nothing is sent as them until they sign in again.
  Castor.signedOut = function () {
    if (!PUBLIC_WRITER) return;
    keptOperation = (keptOperation || 0) + 1;
    if (!saver.writer || !saver.writer.length) saver.writer = whoList();
    Castor.role = Castor.role.confirmed || Castor.role.ended ? Object.assign({}, Castor.role, { confirmed: false, ended: true }) : Castor.roleFrom(null);
    journal();
    reconfirm();
  };
  // Reopening is the way back in: the server sends a page without a session to its sign-in,
  // and a page whose session is fine simply opens again.
  Castor.signin = function () { flushSave(true); try { if (signinAt) global.location.assign(signinAt); else global.location.reload(); } catch (e) { /* nothing to reopen */ } };
  if (global.addEventListener) {
    global.addEventListener('online', function () { reconfirm(); });
    global.addEventListener('pageshow', function () { reconfirm(); });
  }
  if (document.addEventListener) document.addEventListener('visibilitychange', function () { if (!document.hidden) reconfirm(); });

  var REVIEWER_WITHHELD = ['files', 'beside', 'changes', 'drafts', 'workspace', 'live', 'assist', 'for-you', 'links'];
  /* The palette rows a reader has a use for: going somewhere, the panels still
     offered (panels.js drops the withheld ones), the view, and commenting. */
  var READER_COMMANDS = /^(go\.search|go\.heading|outline:top|panel\.[a-z]+|view\.(focus|lastpanel|focusparagraph|theme\.[a-z]+|size\.[a-z]+)|comment:[a-z]+|help\.(keys|walkthrough)|tabs\.(fold|close|reopen))$/;
  function readerCommand(c) { return !!(c && READER_COMMANDS.test(String(c.id))); }

  function applyRole(r) {
    Castor.role = r;
    if (r.reviewer) document.documentElement.setAttribute('data-role', 'reviewer');
  }

  /* A reviewer who reaches the page with no piece, or a piece not shared with
     them, gets one plain paragraph and the way back -- never the embedded
     sample, whose comments would stay in their browser and read as sent. */
  var NOT_SHARED = '# This article is not open to you\n\n' +
    'The link names an article that has not been shared with you, or the server could not read it just now. ' +
    '[Open what was shared with you](/).';
  function notShared(target) {
    target.versions = [{ id: 'v1', label: 'not shared', markdown: NOT_SHARED }];
    target.current = 'v1';
    target.piece = { title: 'Not shared', folder: '', files: [], fileEntries: [] };
    target.pieces = [];
    target.comments = [];
    target.agentNotes = {};
    return target;
  }

  /* Only disposable server snapshots live here, never unsaved editor text or
     save authority. The journal still wins on opening; attachSaver always checks
     the live version before confirming a baseline. Account/role changes cannot
     reuse a snapshot. Eight MiB of serialized UTF-16 bounds the retained payloads
     (including history); closed tabs and least recently used entries go first. */
  // The open article is re-read every 30 s; other open tabs every five minutes, so a
  // phone and a tablet on one network stay well inside the server's request limit.
  var PIECE_CACHE_BYTES = 8 * 1024 * 1024, PIECE_CACHE_AGE = 30000, PREFETCH_AGE = 300000;
  var pieceCache = new Map(), pieceCacheBytes = 0, pieceEpoch = {}, pieceRead = {};
  var prefetchPending = false, prefetchFlight = null, prefetchTried = {}, pieceSaveActivity = 0;
  function cacheablePiece(path) {
    return !reviewing() && (!PUBLIC_WRITER || Castor.role.confirmed) &&
      (path === displayedPath || path === (liveState && liveState.path) ||
        pieces.some(function (p) { return p.path === path && !closedTabs[path]; }));
  }
  function dropPieceCache(path) {
    var entry = pieceCache.get(path);
    if (entry) { pieceCacheBytes -= entry.bytes; pieceCache.delete(path); }
  }
  function prunePieceCache() {
    pieceCache.forEach(function (entry, path) {
      if (!cacheablePiece(path) || entry.authority !== writingAuthority()) dropPieceCache(path);
    });
  }
  function cachedPiece(path) {
    prunePieceCache();
    var entry = pieceCache.get(path);
    if (!entry) return null;
    pieceCache.delete(path); pieceCache.set(path, entry);
    return entry.payload;
  }
  function cachePiece(path, payload) {
    if (!payload || !payload.versions || !cacheablePiece(path)) return;
    dropPieceCache(path);
    var bytes = JSON.stringify(payload).length * 2;
    prefetchTried[path] = Date.now();
    if (bytes > PIECE_CACHE_BYTES) return;
    while (pieceCacheBytes + bytes > PIECE_CACHE_BYTES && pieceCache.size) {
      dropPieceCache(pieceCache.keys().next().value);
    }
    pieceCache.set(path, { payload: payload, bytes: bytes, at: Date.now(), authority: writingAuthority() });
    pieceCacheBytes += bytes;
  }
  function fetchPiece(path, options) {
    var authority = writingAuthority(), epoch = pieceEpoch[path] || 0;
    var read = pieceRead[path] = (pieceRead[path] || 0) + 1;
    return global.fetch('/api/piece?path=' + encodeURIComponent(path), Object.assign({ cache: 'no-store' }, options))
      .then(function (r) {
        if (!r.ok) throw new Error('/api/piece answered ' + r.status);
        return r.json();
      }).then(function (payload) {
        if (authority !== writingAuthority()) throw new Error('The writer changed while the article loaded.');
        // A GET started before our save is not a new baseline, even if it lands last.
        if (epoch !== (pieceEpoch[path] || 0)) return fetchPiece(path, options);
        if (read === pieceRead[path]) cachePiece(path, payload);
        return payload;
      });
  }
  function stopPiecePrefetch() {
    if (prefetchFlight && prefetchFlight.abort) prefetchFlight.abort();
  }
  function queuePiecePrefetch() {
    prunePieceCache();
    // Nonvisual shells have no first paint or reason to speculate. The worker
    // remains the sole persistent offline cache; never bypass its fetch routing.
    if (prefetchPending || prefetchFlight || !global.requestAnimationFrame || reviewing() ||
        !liveState || (global.navigator && global.navigator.onLine === false)) return;
    prefetchPending = true;
    global.requestAnimationFrame(function () { setTimeout(function () {
      function idle() {
        prefetchPending = false;
        if (reviewing() || (global.navigator && global.navigator.onLine === false)) return;
        if (saver.inflight || saver.typed && editorSource() !== saver.text ||
            pieceSaveActivity) {
          setTimeout(queuePiecePrefetch, 500); return;
        }
        var now = Date.now();
        var next = visiblePieces().find(function (p) {
          var entry = pieceCache.get(p.path);
          return p.path !== displayedPath && (!entry || now - entry.at >= PREFETCH_AGE) &&
            (!prefetchTried[p.path] || now - prefetchTried[p.path] >= PREFETCH_AGE);
        });
        if (!next) return;
        prefetchTried[next.path] = now;
        try { prefetchFlight = new global.AbortController(); } catch (e) { prefetchFlight = {}; }
        fetchPiece(next.path, { priority: 'low', signal: prefetchFlight.signal }).catch(function () {
          // A failed speculative read never changes the editor or save state.
        }).then(function () { prefetchFlight = null; queuePiecePrefetch(); });
      }
      if (global.requestIdleCallback) global.requestIdleCallback(idle, { timeout: 1000 });
      else setTimeout(idle, 0);
    }, 0); });
  }
  function savedPieceCache(path, text, res, done) {
    if (!done) return;
    pieceEpoch[path] = (pieceEpoch[path] || 0) + 1;
    var entry = cachedPiece(path), b = res.body || {};
    dropPieceCache(path);
    // A complete receipt can update history immediately, even for an article
    // left while its POST was in flight. Otherwise refetch, never invent a save.
    if (entry && Array.isArray(b.versions)) {
      var saved = b.versions.find(function (v) { return v.sha === done.sha && v.markdown === text; });
      if (saved) cachePiece(path, Object.assign({}, entry, { markdown: text, versions: b.versions,
        current: saved.id, save: b.save || null, article_sha256_now: b.article_sha256_now || null }));
    }
    delete prefetchTried[path];
    queuePiecePrefetch();
  }

  function writingAuthority() {
    return JSON.stringify([Castor.role.id, Castor.role.who, Castor.role.confirmed,
      Castor.role.reviewer, Castor.role.publicWriter]);
  }

  /* --- the article last open -------------------------------------------------
     A founder's browser remembers the article that writer last had open, and a
     page opened with no article named goes back to it. The record is never
     trusted: it must be this writer's, in the right shape, and the server must
     still list the article for this account and let it be read, or it is
     dropped. A reader never reads or writes one. */
  var RESUME_PREFIX = 'castor.resume.';
  var ARTICLE_PATH = /^articles\/[A-Za-z0-9._-]{1,80}\/article\.md$/;

  function forgetPiece(who) {
    if (!who) return;
    try { global.localStorage.removeItem(RESUME_PREFIX + who); } catch (e) { /* nothing was stored */ }
  }
  /* Written only once the server has confirmed a founder: a slow or failed answer
     must not replace the article to come back to with whatever opened by default. */
  function rememberPiece(path) {
    var who = reviewing() || !Castor.role.confirmed ? '' : whoGet();
    if (!who || !ARTICLE_PATH.test(String(path || ''))) return;
    try {
      global.localStorage.setItem(RESUME_PREFIX + who, JSON.stringify({ v: 1, who: who, path: path }));
    } catch (e) { /* this browser forgets it */ }
  }
  function savedPiece(who) {
    if (!who) return '';
    try {
      var record = JSON.parse(global.localStorage.getItem(RESUME_PREFIX + who) || 'null');
      if (record && record.v === 1 && record.who === who && typeof record.path === 'string' &&
          ARTICLE_PATH.test(record.path)) return record.path;
    } catch (e) { /* unreadable: the same as none */ }
    forgetPiece(who);
    return '';
  }
  /* The article to open when the address names none: the saved one for a founder
     the server confirms, if the server's own list for this account holds it. An
     unconfirmed role (the server did not answer) resumes nothing. */
  function restoredPath(whoami) {
    var role = Castor.roleFrom(whoami), who = whoGet();
    if (role.reviewer || !role.confirmed || !who) return Promise.resolve('');
    // No separate catalogue request first: the article's own answer carries the
    // account's list (articleTabs), which readLive checks before keeping it.
    return Promise.resolve(savedPiece(who));
  }
  /* A piece that cannot be read, or that the server's list for this account no
     longer holds, falls back to `fallback`, forgetting the saved one. */
  function readLive(path, fallback) {
    return fetchPiece(path).then(function (payload) {
      if (!fallback || fallback === path) return { path: path, payload: payload };
      var listed = payload && payload.articleTabs;
      // A server that sends no list with the article is asked for it separately.
      var list = Array.isArray(listed) ? Promise.resolve(listed) : global.fetch('/api/pieces', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
      return list.then(function (pieces) {
        // No list to check against: open the default but keep the record.
        if (!Array.isArray(pieces)) return readLive(fallback);
        if (pieces.some(function (p) { return p && p.path === path; })) return { path: path, payload: payload };
        forgetPiece(whoGet()); return readLive(fallback);
      });
    }, function (err) {
      if (fallback && fallback !== path) { forgetPiece(whoGet()); return readLive(fallback); }
      console.error('[castor] live mode could not read the piece', err);
      return { path: path, payload: null, error: String((err && err.message) || err) };
    });
  }

  /* The served piece replaces what the piece IS; it never touches what the world is
     (theme, heading presets, the canvas) unless the server sent that too. Comments are
     emptied on purpose: the seeded ones belong to the embedded piece and every one of
     their anchors would land on this piece as "lost its place". */
  function applyLive(target, payload) {
    if (!payload || !payload.versions) return target;
    target.versions = payload.versions;
    target.current = payload.current ||
      (payload.versions.length ? payload.versions[payload.versions.length - 1].id : target.current);
    target.piece = target.piece || {};
    target.piece.title = payload.title || target.piece.title;
    target.piece.draft = payload.draft || null;
    target.piece.live = payload.live || null;
    target.piece.sites = Array.isArray(payload.sites) ? payload.sites : [];
    target.piece.article_sha256_now = payload.article_sha256_now || null;
    target.piece.savedMarkdown = payload.markdown;
    target.piece.folder = payload.folder || target.piece.folder;
    target.piece.fileEntries = payload.files || [];
    target.piece.fileOrder = payload.fileOrder || {};
    target.piece.files = (payload.files || []).map(function (f) { return f.path; });
    if (payload.pieces) target.pieces = payload.pieces;
    if (payload.headingPresets) target.headingPresets = payload.headingPresets;
    target.comments = [];
    target.agentNotes = payload.agentNotes || {};
    return target;
  }

  /* Called by agent.js after the loop commits: the page becomes what the repository
     now holds, and the saves rail grows the agent's own save. */
  var pieceScroll = {};
  var sheetMotion = null, pieceRequest = 0;
  function nextSheet(from, to) {
    if (!els.article || !els.article.animate || reducedMotion()) return;
    if (sheetMotion) sheetMotion.cancel();
    var a = pieces.findIndex(function (p) { return p.path === from; });
    var b = pieces.findIndex(function (p) { return p.path === to; });
    var direction = b >= a ? 1 : -1;
    sheetMotion = els.article.animate([
      { opacity: .72, transform: 'translate(' + direction * 8 + 'px, 4px)' },
      { opacity: 1, transform: 'translate(0, 0)' }
    ], { duration: 200, easing: 'cubic-bezier(.16,1,.3,1)' });
  }

  /* The article the page holds, whether or not a tab shows it. */
  function openArticle() {
    if (liveState) return liveState.path;
    return (data.piece && data.piece.folder) ? data.piece.folder + '/article.md' : null;
  }

  /* Leaving an article first writes the journal and starts a save for anything
     still only on this page, so no switch can drop typed text. Closing the last
     tab leans on the same road by "opening" the article that is already open,
     which does exactly that and nothing else. The two events let the tab code
     (below) keep its row, its empty state and its memory without this function
     knowing about any of them. */
  function canLeaveArticle() {
    if (Castor.editor && Castor.editor.flush) Castor.editor.flush();
    if (!Castor.editor || (!saver.typed && saver.text === null) || !(writableHere() || keepOn()) || editorSource() === saver.text) return Promise.resolve(true);
    journal();
    var timeout = function () { return new Promise(function (resolve) { setTimeout(resolve, 1000); }); };
    var kept = keepOn() ? Castor.keep.now() : Promise.resolve(false);
    function exactCopy() {
      return editorSource() === saver.text || !!(Castor.keep && Castor.keep.receipt && Castor.keep.receipt(saver.path, editorSource()));
    }
    return Promise.race([kept, timeout()]).then(function () {
      if (exactCopy()) {
        if (saver.base && !saver.inflight && editorSource() !== saver.text) saveNow(false);
        return true;
      }
      return Promise.race([saveNow(false), timeout()]).then(function () {
        if (exactCopy()) return true;
        setSave('unsaved', 'This article stays open because these words have no confirmed recovery copy or server save. Copy them before leaving.');
        return false;
      });
    });
  }

  function openPiece(path) {
    var leaving = Castor.changes && Castor.changes.leaveFullView ? Castor.changes.leaveFullView() : Promise.resolve();
    return leaving.then(function () {
      bus.emit('piece:opening', { path: path });
      return canLeaveArticle();
    }).then(function (safe) {
      return safe ? openPieceNow(path) : false;
    }).then(function (ok) {
      bus.emit('piece:opened', { path: path, ok: ok });
      return ok;
    });
  }

  function rememberPieceUrl(path) {
    try {
      var url = new URL(global.location.href || global.location.pathname + global.location.search + (global.location.hash || ''), 'http://castor.invalid');
      url.searchParams.set('live', path);
      global.history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) { /* The article remains open if this shell cannot change its URL. */ }
  }

  function openPieceNow(path) {
    /* Served but not live -- the built page anyone opens at /typewell/ -- there is
       nothing in memory to swap, so choosing an article is a navigation. It comes
       back live on that piece, which is what choosing it means. */
    if (!liveState || !liveState.path) {
      try {
        global.location.search = '?live=' + encodeURIComponent(path);
        return Promise.resolve(true);
      } catch (e) { return Promise.resolve(false); }
    }
    if (displayedPath === path) {
      if (liveState.path !== path) pieceRequest++;
      liveState.path = path;
      rememberPieceUrl(path);
      renderTabs();
      return Promise.resolve(true);
    }
    try {
      pieceScroll[displayedPath || liveState.path] = { y: global.scrollY || 0, top: els.scroll ? els.scroll.scrollTop : 0 };
    } catch (e) { /* no scroll to keep */ }
    var previous = displayedPath || liveState.path;
    liveState.path = path;
    var wanted = pieceRequest + 1;
    return reloadLive().then(function (result) {
      if (result && (result.superseded || result.blocked)) return false;
      if (!result) { liveState.path = previous; return false; }
      rememberPieceUrl(path);
      nextSheet(previous, path);
      bus.emit('piece:open', { path: path, from: previous });
      var back = pieceScroll[path] || { y: 0, top: 0 };
      try {
        global.scrollTo(0, back.y);
        if (els.scroll) els.scroll.scrollTop = back.top;
      } catch (e2) { /* nothing to restore */ }
      renderTabs();
      return true;
    }).catch(function (error) {
      if (wanted !== pieceRequest || liveState.path !== path) return false;
      liveState.path = previous;
      console.error('[castor] could not open that piece', error);
      renderTabs();
      return false;
    });
  }

  /* The chord that switches articles on this machine (commands.js, section 0).
     A shell without commands.js falls back to Control plus a number. */
  var cachedTabChord = null, chordSource = null;
  function tabChord() {
    var source = Castor.keys && Castor.keys.tabChord;
    if (!cachedTabChord || source !== chordSource) {
      chordSource = source;
      cachedTabChord = source ? source() :
        { badge: '\u2303', words: '', aria: 'Control+', hold: ['Meta', 'Control'], chords: [{ ctrl: true }] };
    }
    return cachedTabChord;
  }
  if (global.matchMedia) {
    ['(display-mode: standalone)', '(display-mode: window-controls-overlay)'].forEach(function (query) {
      var media = global.matchMedia(query);
      var refresh = function () { cachedTabChord = null; tabChord(); };
      if (media.addEventListener) media.addEventListener('change', refresh);
      else if (media.addListener) media.addListener(refresh);
    });
  }

  var pieces = [];
  /* Closing a tab only HIDES it. closedTabs holds the hidden articles' paths;
     `emptied` is the path of the article the editor still holds while no tab is
     open ('' otherwise); `closing` is the tabs being closed right now. */
  var closedTabs = {}, emptied = '', closing = {}, tabMenuEl = null;
  var tabEls = { strip: null, fold: null, mark: null, title: null };
  var knotMotion = null, knotStretch = null, knotLineMotion = null, knotFrame = 0;
  function placeKnot(moving) {
    if (!tabEls.mark || !tabEls.strip || !els.app) return;
    var current = tabEls.strip.querySelector('[aria-selected="true"] .castor-tab-name');
    if (!current) return;
    var box = current.getBoundingClientRect(), base = els.app.getBoundingClientRect();
    var title = tabEls.title.getBoundingClientRect();
    var folded = tabsFolded();
    var x = folded ? (base.width || base.right - base.left) / 2 : box.left + box.width / 2 - base.left;
    var bar = global.document.getElementById('topbar');
    var rule = bar && global.getComputedStyle ? global.getComputedStyle(bar, '::after') : null;
    var lineW = rule ? parseFloat(rule.height) || 2 : 2;
    // Open, the knot sits on the two-colour line above its tab, as on the Logbook's tab bar.
    // offset geometry stays in the app's coordinate space during the Zen transform.
    var y = !bar ? title.top + title.height / 2 - base.top : bar.offsetTop + bar.offsetHeight - lineW / 2;
    var inset = rule ? parseFloat(rule.left) || 0 : 0;
    var junction = bar ? x + base.left - bar.getBoundingClientRect().left - inset : 0;
    var lineWidth = rule ? parseFloat(rule.width) : 0;
    if (bar && lineWidth > 8) {
      junction = Math.max(4, Math.min(lineWidth - 4, junction));
      x = junction + bar.getBoundingClientRect().left + inset - base.left;
    }
    var target = 'translate(' + x + 'px,' + y + 'px)';
    var old = global.getComputedStyle ? global.getComputedStyle(tabEls.mark).transform : '';
    junction = bar ? junction + 'px' : '';
    var oldJunction = bar && global.getComputedStyle ? global.getComputedStyle(bar).getPropertyValue('--article-junction') : '';
    if (knotMotion) knotMotion.cancel();
    if (knotStretch) knotStretch.cancel();
    if (knotLineMotion) knotLineMotion.cancel();
    tabEls.mark.style.transform = target;
    if (bar) bar.style.setProperty('--article-junction', junction);
    if (moving && old && old !== 'none' && tabEls.mark.animate && !reducedMotion()) {
      var clock = { duration: 450, easing: 'cubic-bezier(.45,0,.55,1)' };
      knotMotion = tabEls.mark.animate([{ transform: old }, { transform: target }],
        clock);
      if (bar && bar.animate) knotLineMotion = bar.animate([
        { '--article-junction': oldJunction || junction }, { '--article-junction': junction }
      ], clock);
      knotStretch = tabEls.mark.firstChild.animate([
        { transform: 'scale(1)', easing: 'cubic-bezier(.45,0,.6,1)' },
        { transform: 'scale(4,.62)', offset: .48, easing: 'cubic-bezier(.3,0,.5,1)' },
        { transform: 'scale(.82,1.16)', offset: .84, easing: 'cubic-bezier(.4,0,.6,1)' },
        { transform: 'scale(1)' }
      ], { duration: 450, easing: 'linear' });
    }
  }
  function queueKnot(moving) {
    if (!global.requestAnimationFrame) return;
    if (knotFrame) global.cancelAnimationFrame(knotFrame);
    knotFrame = global.requestAnimationFrame(function () { knotFrame = 0; placeKnot(moving); });
  }

  function revealTab() {
    var strip = tabEls.strip;
    if (!strip || tabsFolded()) return;
    if (Castor.capsule) { fitArticleTabs(); return; }
    var active = strip.querySelector('[aria-selected="true"]');
    if (active && strip.clientWidth && active.getBoundingClientRect) {
      var box = active.getBoundingClientRect(), bounds = strip.getBoundingClientRect();
      if (box.right > bounds.right - 32) strip.scrollLeft += box.right - bounds.right + 32;
      else if (box.left < bounds.left + 16) strip.scrollLeft -= bounds.left + 16 - box.left;
    }
  }

  /* Keep complete tabs in the row. Overflow stays open, just behind N more. */
  function fitArticleTabs() {
    var strip = tabEls.strip;
    if (!Castor.capsule || !strip || !strip.clientWidth) return;
    var items = Array.prototype.slice.call(strip.querySelectorAll('.castor-tab-item'));
    var more = strip.querySelector('.castor-tabs-more');
    if (!more) return;
    items.forEach(function (item) { item.hidden = false; });
    more.hidden = false;
    more.textContent = items.length + ' more';
    var gap = parseFloat(global.getComputedStyle(strip).columnGap) || 0;
    var plus = strip.querySelector('.castor-tab-new');
    var available = strip.clientWidth - (plus ? plus.getBoundingClientRect().width + gap : 0);
    var widths = items.map(function (item) { return item.getBoundingClientRect().width; });
    var total = widths.reduce(function (sum, width) { return sum + width + gap; }, 0);
    if (total <= available) { more.hidden = true; strip.scrollLeft = 0; return; }
    available -= more.getBoundingClientRect().width + gap;
    var current = items.filter(function (item) { return item.querySelector('.castor-tab[aria-selected="true"]'); })[0];
    if (current) available -= widths[items.indexOf(current)] + gap;
    var hidden = 0;
    items.forEach(function (item, i) {
      if (item === current) return;
      item.hidden = widths[i] + gap > available;
      if (item.hidden) hidden++;
      else available -= widths[i] + gap;
    });
    more.textContent = hidden + ' more';
    more.hidden = !hidden;
    strip.scrollLeft = 0;
  }

  function moreArticleTabs() {
    var hidden = Array.prototype.slice.call(tabEls.strip.querySelectorAll('.castor-tab-item[hidden] .castor-tab'));
    if (Castor.commands && Castor.commands.openList) {
      Castor.commands.openList({ title: 'More articles', items: hidden.map(function (tab) {
        return { id: tab.dataset.path, label: tab.querySelector('.castor-tab-name').textContent };
      }), onPick: function (item) { openPiece(item.id); } });
    } else openChooser();
  }

  /* The strip and its chevron, created once. JS says the strip exists and
     whether it is folded (#app[data-tabs] = on | folded); CSS decides how tall
     the row is, so "Clear everything away" can still close it. */
  var FOLD_PATH = 'M6.5 14.5l5.5-5.5 5.5 5.5';
  function ensureStrip() {
    var app = document.getElementById('app');
    if (!tabEls.strip) {
      var strip = document.createElement('nav');
      strip.id = 'castor-tabs';
      strip.className = 'castor-tabs';
      strip.setAttribute('aria-label', 'Articles');
      if (els.topbar && els.topbar.parentNode) els.topbar.parentNode.insertBefore(strip, els.topbar.nextSibling);
      else if (app) app.insertBefore(strip, app.firstChild);
      else document.body.insertBefore(strip, document.body.firstChild);
      var fold = document.createElement('button');
      fold.type = 'button';
      fold.id = 'castor-tabs-fold';
      fold.className = 'castor-tabs-fold';
      fold.setAttribute('aria-controls', 'castor-tabs');
      fold.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + FOLD_PATH + '"/></svg>';
      fold.addEventListener('click', function () { foldTabs(!tabsFolded()); });
      if (strip.parentNode) strip.parentNode.insertBefore(fold, strip.nextSibling);
      tabEls.strip = strip;
      tabEls.fold = fold;
      if (app) {
        var mark = line('span', 'article-knot');
        mark.setAttribute('aria-hidden', 'true'); mark.appendChild(line('i', ''));
        app.appendChild(mark); tabEls.mark = mark;
        var title = line('span', 'folded-article');
        title.setAttribute('aria-hidden', 'true'); app.appendChild(title); tabEls.title = title;
        strip.addEventListener('scroll', function () { queueKnot(false); }, { passive: true });
        global.addEventListener('resize', function () { revealTab(); queueKnot(false); }, { passive: true });
        if (global.ResizeObserver) new global.ResizeObserver(revealTab).observe(strip);
        if (document.fonts) document.fonts.ready.then(revealTab);
      }
    }
    paintFold(recall('tabs') === 'folded', false);
    return tabEls.strip;
  }

  function dropStrip() {
    var bar = document.getElementById('topbar');
    if (knotLineMotion) knotLineMotion.cancel();
    if (bar) bar.style.removeProperty('--article-junction');
    if (tabEls.strip) tabEls.strip.remove();
    if (tabEls.fold) tabEls.fold.remove();
    if (tabEls.mark) tabEls.mark.remove();
    if (tabEls.title) tabEls.title.remove();
    tabEls.strip = tabEls.fold = null;
    tabEls.mark = tabEls.title = null;
    var app = document.getElementById('app');
    if (app) app.removeAttribute('data-tabs');
  }

  function tabsFolded() {
    var app = document.getElementById('app');
    return !!(app && app.getAttribute('data-tabs') === 'folded');
  }

  /* Folded, the row's words leave the tab order and the accessibility tree; the
     chevron stays, says which way it will go, and the choice is kept per browser. */
  var tabsMoving = 0;
  function paintFold(folded, moving) {
    var app = document.getElementById('app');
    if (app) {
      if (moving) {
        app.setAttribute('data-tabs-moving', '');
        clearTimeout(tabsMoving);
        tabsMoving = setTimeout(function () { app.removeAttribute('data-tabs-moving'); }, 460);
      }
      app.setAttribute('data-tabs', folded ? 'folded' : 'on');
    }
    if (tabEls.strip) {
      if (folded) { tabEls.strip.setAttribute('inert', ''); tabEls.strip.setAttribute('aria-hidden', 'true'); }
      else { tabEls.strip.removeAttribute('inert'); tabEls.strip.removeAttribute('aria-hidden'); }
    }
    if (tabEls.fold) {
      var say = folded ? 'Show the article tabs' : 'Hide the article tabs';
      tabEls.fold.setAttribute('aria-expanded', folded ? 'false' : 'true');
      tabEls.fold.setAttribute('aria-label', say);
      tabEls.fold.title = say;
      if (folded && els.topbar) {
        var nav = els.topbar.querySelector('.nav');
        els.topbar.insertBefore(tabEls.title, nav);
        els.topbar.insertBefore(tabEls.fold, nav);
      } else if (tabEls.strip && tabEls.strip.parentNode) {
        tabEls.strip.parentNode.insertBefore(tabEls.fold, tabEls.strip.nextSibling);
        if (tabEls.title) app.appendChild(tabEls.title);
      }
    }
  }

  function foldTabs(folded) {
    folded = !!folded;
    store('tabs', folded ? 'folded' : 'open');
    if (!tabEls.strip) return folded;
    var before = tabEls.fold && tabEls.fold.getBoundingClientRect();
    var name = tabEls.strip.querySelector('[aria-selected="true"] .castor-tab-name');
    var fromTitle = folded ? name : tabEls.title;
    var titleBefore = fromTitle && fromTitle.getBoundingClientRect();
    paintFold(folded, true);
    refitHeader();
    if (!folded) revealTab();
    var toTitle = folded ? tabEls.title : name;
    if (titleBefore && toTitle && toTitle.animate && !reducedMotion()) {
      var titleAfter = toTitle.getBoundingClientRect();
      toTitle.animate([
        { transform: 'translate(' + (titleBefore.left - titleAfter.left) + 'px,' + (titleBefore.top - titleAfter.top) + 'px)' },
        { transform: 'translate(0,0)' }
      ], { duration: 450, easing: 'cubic-bezier(.45,0,.55,1)' });
    }
    if (before && tabEls.fold.animate && !reducedMotion()) {
      var after = tabEls.fold.getBoundingClientRect();
      tabEls.fold.animate([
        { transform: 'translate(' + (before.left - after.left) + 'px,' + (before.top - after.top) + 'px)' },
        { transform: 'translate(0,0)' }
      ], { duration: 220, easing: 'cubic-bezier(.16,1,.3,1)' });
    }
    queueKnot(true);
    setTimeout(function () { queueKnot(false); }, 460);
    return folded;
  }

  Castor.tabs = {
    folded: tabsFolded,
    fold: function (on) { return foldTabs(on === undefined ? !tabsFolded() : on); },
    close: closeTab,
    move: moveArticleTab,
    closed: function () {
      var shown = visiblePieces();
      return pieces.filter(function (p) { return shown.indexOf(p) < 0; });
    }
  };

  /* --- closing tabs ------------------------------------------------------------
     A tab is a view of an article, not the article: closing one never deletes
     text, saves or journals. Opening the article by any road (a tab, search, the
     empty state, the palette) brings its tab back. A founder's hidden tabs are
     kept per writer in this browser; a reader's last for the page only. */
  function closedKey() {
    var who = reviewing() ? '' : whoGet();
    return who ? 'tabsClosed.' + who : '';
  }
  var tabsUnset = false;
  function loadClosed() {
    closedTabs = {}; tabsUnset = false;
    var name = closedKey(), list = null;
    if (!name) return;
    var raw = recall(name);
    if (raw === null) { tabsUnset = true; return; }
    try { list = JSON.parse(raw || '[]'); } catch (e) { return; }
    if (Array.isArray(list)) list.slice(0, 50).forEach(function (p) {
      if (typeof p === 'string' && ARTICLE_PATH.test(p)) closedTabs[p] = true;
    });
  }
  function keepClosed() {
    var name = closedKey();
    if (name) store(name, JSON.stringify(Object.keys(closedTabs)));
  }
  /* A browser this writer has never used opens on what is live on the sites,
     plus the practice pieces the walkthrough uses; every other article stays
     one search or Files away. A server that says nothing about publication
     leaves every tab open. */
  function defaultTabs() {
    if (!tabsUnset || !pieces.length) return;
    tabsUnset = false;
    if (!pieces.some(function (p) { return p.live === true; })) return;
    var here = openArticle(), practice = (Castor.walkthrough && Castor.walkthrough.practice) || [];
    pieces.forEach(function (p) {
      if (p.live !== true && practice.indexOf(p.path) < 0 && p.path !== here) closedTabs[p.path] = true;
    });
    keepClosed();
  }
  /* The article the writer is on always has its tab, unless the page is empty. */
  function visiblePieces() {
    var here = openArticle();
    return orderedPieces().filter(function (p) { return !closedTabs[p.path] || (p.path === here && !emptied); });
  }

  function orderedPieces() {
    var order = [];
    try { var saved = JSON.parse(recall('tabsOrder') || '[]'); if (Array.isArray(saved)) order = saved; } catch (e) { /* use the catalogue */ }
    var result = [];
    order.forEach(function (path) {
      var piece = pieces.find(function (p) { return p.path === path; });
      if (piece && result.indexOf(piece) < 0) result.push(piece);
    });
    return result.concat(pieces.filter(function (p) { return result.indexOf(p) < 0; }));
  }

  function placeArticleTab(path, target, after) {
    if (path === target) return false;
    var order = orderedPieces().map(function (p) { return p.path; });
    if (order.indexOf(path) < 0 || order.indexOf(target) < 0) return false;
    order.splice(order.indexOf(path), 1);
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, path);
    store('tabsOrder', JSON.stringify(order));
    renderTabs();
    return true;
  }

  function moveArticleTab(path, direction) {
    var shown = visiblePieces(), index = shown.findIndex(function (p) { return p.path === path; });
    var target = index >= 0 && shown[index + (direction < 0 ? -1 : 1)];
    if (!target) return false;
    return placeArticleTab(path, target.path, direction > 0);
  }

  // Capture the tab, not the strip: closing and ordinary clicking remain native.
  // Rebuild only on drop so the captured button survives throughout the drag.
  function wireTabDrag(button, piece) {
    var drag = null;
    function clear() {
      if (drag && drag.ghost) drag.ghost.remove();
      if (drag && drag.target) delete drag.target.dataset.drop;
      if (drag && drag.item) delete drag.item.dataset.dragging;
    }
    button.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, live: false, item: button.parentNode };
      if (button.setPointerCapture) button.setPointerCapture(e.pointerId);
    });
    button.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (!drag.live) {
        if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 6) return;
        drag.live = true; button._dragged = true;
        drag.item.dataset.dragging = '1';
        drag.ghost = line('div', 'castor-tab-ghost', piece.title);
        document.body.appendChild(drag.ghost);
      }
      drag.ghost.style.left = (e.clientX + 12) + 'px';
      drag.ghost.style.top = (e.clientY + 12) + 'px';
      if (drag.target) delete drag.target.dataset.drop;
      drag.target = null;
      var strip = tabEls.strip, bounds = strip.getBoundingClientRect();
      if (e.clientY < bounds.top - 40 || e.clientY > bounds.bottom + 40) return;
      if (e.clientX < bounds.left + 32) strip.scrollLeft -= 24;
      else if (e.clientX > bounds.right - 32) strip.scrollLeft += 24;
      var items = Array.prototype.slice.call(strip.querySelectorAll('.castor-tab-item')).filter(function (item) { return item !== drag.item; });
      if (!items.length) return;
      var target = items[items.length - 1];
      for (var i = 0; i < items.length; i++) {
        if (e.clientX < items[i].getBoundingClientRect().right) { target = items[i]; break; }
      }
      var rect = target.getBoundingClientRect();
      drag.after = e.clientX > rect.left + rect.width / 2;
      drag.target = target;
      target.dataset.drop = drag.after ? 'after' : 'before';
    });
    button.addEventListener('pointerup', function () {
      var ended = drag; clear(); drag = null;
      if (!ended || !ended.live || !ended.target) return;
      placeArticleTab(piece.path, ended.target.dataset.path, ended.after);
      focusArticleTab(piece.path);
    });
    button.addEventListener('pointercancel', function () { clear(); drag = null; button._dragged = false; });
    button.addEventListener('lostpointercapture', function () { clear(); drag = null; });
  }

  function focusArticleTab(path) {
    if (!tabEls.strip) return;
    var tabs = tabEls.strip.querySelectorAll('.castor-tab');
    for (var i = 0; i < tabs.length; i++) if (tabs[i].dataset.path === path) { tabs[i].focus(); break; }
  }

  /* A close button that had the keyboard is gone with its tab: put the focus on the
     tab now open, or on the first way out of the empty page. Focus that is already
     somewhere (the text being written) is never taken. */
  function refocusTabs() {
    var here = document.activeElement;
    if (here && here !== document.body) return;
    var box = document.getElementById('castor-empty');
    var target = box ? box.querySelector('.castor-empty-open') :
      (tabEls.strip && tabEls.strip.querySelector('[aria-selected="true"]'));
    if (target && target.focus) target.focus();
  }
  function hideTab(path) {
    closedTabs[path] = true;
    keepClosed();
    renderTabs();
    refocusTabs();
  }

  /* Closes `path`. Resolves true when its tab is gone. Another tab: just hidden.
     The open article: the next tab to its right (else its left) opens first, by
     the same road a click takes, so the journal and the save run before anything
     changes. With no other tab, the page goes empty and says so; the editor is
     only hidden, so saving carries on. A switch that fails leaves the tab. */
  function closeTab(path) {
    var shown = visiblePieces(), at = -1;
    shown.forEach(function (p, i) { if (p.path === path) at = i; });
    if (at < 0 || closing[path]) return Promise.resolve(false);
    if (path !== openArticle()) { hideTab(path); return Promise.resolve(true); }
    var next = shown[at + 1] || shown[at - 1];
    /* Only a page reading from the repository can go empty; the built page opened
       without ?live has no piece in memory to put away. */
    if (!next && !(liveState && liveState.path)) return Promise.resolve(false);
    closing[path] = true;
    var left = openPiece(next ? next.path : path);
    return left.then(function (ok) {
      delete closing[path];
      if (!ok && (displayedPath === path || !liveState || liveState.path !== displayedPath)) return false;
      if (openArticle() === path) {
        if (next) return false;
        closedTabs[path] = true; keepClosed(); showEmpty(path);
        return true;
      }
      hideTab(path);
      return true;
    }, function (error) { delete closing[path]; throw error; });
  }

  function showEmpty(path) {
    emptied = path;
    forgetPiece(whoGet());
    var title = '';
    pieces.forEach(function (p) { if (p.path === path) title = p.title; });
    var old = document.getElementById('castor-empty');
    if (old) old.remove();
    var box = line('section', 'castor-empty');
    box.id = 'castor-empty';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'No article open');
    box.appendChild(line('p', 'castor-empty-title', 'No article is open.'));
    if (saver.inflight || (saver.base && editorSource() !== saver.text)) {
      box.appendChild(line('p', 'castor-empty-note', 'Your last changes' + (title ? ' to “' + title + '”' : '') +
        (journalKeeps() ? ' are kept on this device and are still being saved.' : ' are still being saved.')));
    }
    var list = line('div', 'castor-empty-list');
    pieces.forEach(function (p) {
      var open = line('button', 'castor-empty-open', p.title);
      open.type = 'button';
      open.dataset.path = p.path;
      open.addEventListener('click', function () { openPiece(p.path); });
      list.appendChild(open);
    });
    box.appendChild(list);
    if (Castor.panels && Castor.panels.open) {
      var files = line('button', 'castor-empty-files', 'Files');
      files.type = 'button';
      files.addEventListener('click', function () { Castor.panels.open('files'); });
      box.appendChild(files);
    }
    els.article.parentNode.insertBefore(box, els.article);
    els.article.hidden = true;
    els.article.setAttribute('inert', '');
    els.app.setAttribute('data-empty', 'on');
    renderTabs();
    if (Castor.files && Castor.files.render) Castor.files.render();
    refocusTabs();
  }
  function leaveEmpty() {
    emptied = '';
    var box = document.getElementById('castor-empty');
    if (box) box.remove();
    els.article.hidden = false;
    els.article.removeAttribute('inert');
    els.app.removeAttribute('data-empty');
  }
  /* THE + TAB. After the last article tab, + opens a chooser in the sheet: a search
     over every article (newest first) and New article. The article in view is only
     put away, as on the empty page, so its saving carries on. Choosing an article
     turns the chooser into that article's tab; Escape or its × brings back the one
     that was open. */
  var chooser = null;
  function chooserItems(query) {
    var q = String(query || '').trim().toLowerCase();
    return pieces.slice().sort(function (a, b) { return (b.order || 0) - (a.order || 0); })
      .filter(function (p) { return !q || String(p.title || '').toLowerCase().indexOf(q) >= 0; });
  }
  function fillChooser() {
    if (!chooser) return;
    chooser.list.textContent = '';
    var found = chooserItems(chooser.search.value);
    found.forEach(function (p) {
      var open = line('button', 'castor-chooser-open', p.title);
      open.type = 'button';
      open.dataset.path = p.path;
      open.addEventListener('click', function () { chooseArticle(p.path); });
      chooser.list.appendChild(open);
    });
    if (!found.length) chooser.list.appendChild(line('p', 'castor-chooser-none', 'No article has that in its title.'));
  }
  function openChooser() {
    if (reviewing() || !liveState || !liveState.path) return;
    if (chooser) { chooser.search.focus(); return; }
    var box = line('section', 'castor-chooser');
    box.id = 'castor-chooser';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Open or start an article');
    box.appendChild(line('p', 'castor-chooser-heading', 'Open an article, or start a new one.'));
    var search = line('input', 'castor-chooser-search');
    search.type = 'search';
    search.placeholder = 'Find an article';
    search.setAttribute('aria-label', 'Find an article by its title');
    box.appendChild(search);
    var list = line('div', 'castor-chooser-list');
    box.appendChild(list);
    var start = line('button', 'castor-chooser-new', 'New article');
    start.type = 'button';
    box.appendChild(start);
    var status = line('p', 'castor-chooser-status');
    status.setAttribute('role', 'status');
    box.appendChild(status);
    chooser = { box: box, search: search, list: list, status: status, start: start, back: openArticle() };
    search.addEventListener('input', fillChooser);
    search.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      var first = chooserItems(search.value)[0];
      if (first) { e.preventDefault(); chooseArticle(first.path); }
    });
    start.addEventListener('click', function () { startForm(); });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); closeChooser(true); }
    });
    fillChooser();
    els.article.parentNode.insertBefore(box, els.article);
    els.article.hidden = true;
    els.article.setAttribute('inert', '');
    els.app.setAttribute('data-chooser', 'on');
    renderTabs();
    search.focus();
  }
  function startForm() {
    if (!chooser || chooser.form) return;
    var form = line('form', 'castor-chooser-form');
    var title = line('input', 'castor-chooser-title');
    title.type = 'text'; title.maxLength = 120; title.placeholder = 'Title of the new article';
    title.setAttribute('aria-label', 'Title of the new article');
    var create = line('button', 'castor-chooser-create', 'Create'); create.type = 'submit';
    var cancel = line('button', 'castor-chooser-cancel', 'Cancel'); cancel.type = 'button';
    form.appendChild(title); form.appendChild(create); form.appendChild(cancel);
    chooser.start.hidden = true;
    chooser.box.insertBefore(form, chooser.status);
    chooser.form = form;
    cancel.addEventListener('click', function () { form.remove(); chooser.form = null; chooser.start.hidden = false; chooser.start.focus(); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = String(title.value || '').trim();
      if (!name) { chooser.status.textContent = 'Give the new article a title.'; title.focus(); return; }
      create.disabled = true;
      chooser.status.textContent = 'Creating the article in Git.';
      createArticle(name).then(function (made) {
        if (!pieces.some(function (p) { return p.path === made.path; })) pieces = pieces.concat([{ path: made.path, folder: made.folder, title: made.title || name }]);
        return chooseArticle(made.path);
      }).catch(function (error) {
        create.disabled = false;
        if (chooser) chooser.status.textContent = (error && error.message) || 'The article could not be created.';
      });
    });
    title.focus();
  }
  function createArticle(title) {
    var who = sessionNow().map(function (p) { return p.id || { name: p.name, email: p.email }; });
    return global.fetch('/api/pieces/new', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ who: who, title: title }) }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || !payload.path) throw new Error(payload.error || ('The server returned ' + response.status + '.'));
        return payload;
      });
    });
  }
  function closeChooser(refocus) {
    if (!chooser) return;
    chooser.box.remove();
    chooser = null;
    if (!emptied) { els.article.hidden = false; els.article.removeAttribute('inert'); }
    els.app.removeAttribute('data-chooser');
    renderTabs();
    if (refocus && tabEls.strip) {
      var here = tabEls.strip.querySelector('[aria-selected="true"]');
      if (here && here.focus) here.focus();
    }
  }
  function chooseArticle(path) {
    var already = path === openArticle() && !emptied;
    closeChooser(false);
    return already ? Promise.resolve(true) : openPiece(path);
  }

  /* Opening an article by any road ends the empty state first, so the editor is laid
     out in view before it is reloaded. Afterwards the article has its tab back and
     is the one to return to. An article that could not be read changes nothing: the
     writer is on the last one again, with its tab. */
  var openingTabs = {};
  bus.on('piece:opening', function (e) {
    if (e) openingTabs[e.path] = !visiblePieces().some(function (p) { return p.path === e.path; });
    if (chooser) closeChooser(false);
    if (emptied) leaveEmpty();
  });
  bus.on('piece:opened', function (e) {
    var newTab = e && openingTabs[e.path];
    if (e) delete openingTabs[e.path];
    if (!e || !e.ok) return;
    if (emptied) leaveEmpty();                    // an open that began before the page went empty
    if (closedTabs[e.path]) { delete closedTabs[e.path]; keepClosed(); }
    rememberPiece(e.path);
    renderTabs();
    if (newTab && tabsFolded()) foldTabs(false);
  });

  function closeTabMenu() {
    if (tabMenuEl) { tabMenuEl.remove(); tabMenuEl = null; }
  }
  /* Each action uses the same article path and the existing permission-checked reader. */
  function openTabMenu(e, piece) {
    if (e.preventDefault) e.preventDefault();
    closeTabMenu();
    var menu = line('div', 'castor-tab-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', piece.title);
    menu.style.left = (e.clientX || 0) + 'px';
    menu.style.top = (e.clientY || 0) + 'px';
    var item = line('button', 'castor-tab-menu-item', 'Close');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    /* The close chord closes the open article, so it is shown only on that tab's menu. */
    if (piece.path === openArticle()) {
      var chord = !Castor.keys || Castor.keys.os() === 'mac' ? '⌃⇧W' : 'Alt+Shift+W';
      item.appendChild(line('span', 'castor-tab-menu-keys', chord));
      item.setAttribute('aria-keyshortcuts', chord === '⌃⇧W' ? 'Control+Shift+W' : 'Alt+Shift+W');
    }
    item.addEventListener('click', function () { closeTabMenu(); closeTab(piece.path); });
    menu.appendChild(item);
    if (Castor.files && Castor.files.openArticle) {
      var beside = line('button', 'castor-tab-menu-item', 'Open beside'); beside.type = 'button';
      beside.setAttribute('role', 'menuitem');
      beside.addEventListener('click', function () { closeTabMenu(); Castor.files.openArticle(piece.path, piece.title); });
      menu.appendChild(beside);
    }
    document.body.appendChild(menu);
    tabMenuEl = menu;
    if (item.focus) item.focus();
  }

  /* Ctrl+Shift+W on a Mac, Alt+Shift+W elsewhere. The browsers keep Cmd/Ctrl+W for
     their own tab, and a bare Ctrl+W is a habit from terminals that must not close
     an article under the writer's hands. */
  function closeChord() { return !Castor.keys || Castor.keys.os() === 'mac' ? { ctrl: true, shift: true } : { alt: true, shift: true }; }
  function closeChordHit(e) {
    var want = closeChord();
    return !!e.ctrlKey === !!want.ctrl && !!e.altKey === !!want.alt && !!e.shiftKey === !!want.shift && !e.metaKey &&
      (e.code === 'KeyW' || String(e.key).toLowerCase() === 'w');
  }
  function canCloseHere() {
    var here = openArticle();
    return !emptied && visiblePieces().some(function (p) { return p.path === here; });
  }
  function wireTabs() {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && tabMenuEl) { e.preventDefault(); closeTabMenu(); return; }
      var mac = !Castor.keys || Castor.keys.os() === 'mac';
      if (!e.isComposing && e.altKey && e.shiftKey && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) &&
          (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        var path = e.target && e.target.classList && e.target.classList.contains('castor-tab') ? e.target.dataset.path : openArticle();
        if (moveArticleTab(path, e.key === 'ArrowLeft' ? -1 : 1)) focusArticleTab(path);
        e.preventDefault(); e.stopPropagation(); return;
      }
      if (e.isComposing || !closeChordHit(e) || !canCloseHere()) return;
      e.preventDefault();
      closeTab(openArticle());
    }, true);
    document.addEventListener('pointerdown', function (e) {
      if (tabMenuEl && !(e.target && e.target.closest && e.target.closest('.castor-tab-menu'))) closeTabMenu();
    }, true);
    var C = Castor.commands;
    if (!C || !C.register) return;
    var mac = !Castor.keys || Castor.keys.os() === 'mac';
    C.register({ id: 'tabs.beside', title: 'Open article beside', section: 'Go to',
      when: function () { return !!(Castor.files && Castor.files.openArticle && C.openList); },
      run: function () { C.openList({ title: 'Open beside', items: pieces.map(function (p) { return { id: p.path, label: p.title }; }),
        onPick: function (item) { var p = pieces.find(function (p) { return p.path === item.id; }); if (p) Castor.files.openArticle(p.path, p.title); } }); } });
    C.register({ id: 'tabs.new', title: 'Open or start an article', hint: 'a new tab', section: 'Go to',
      when: function () { return !reviewing() && !!(liveState && liveState.path); }, run: openChooser });
    C.register({ id: 'tabs.close', title: 'Close this article', hint: 'hides its tab, deletes nothing', section: 'Go to',
      keys: mac ? '⌃⇧W' : '⌥⇧W', when: canCloseHere, run: function () { closeTab(openArticle()); } });
    [-1, 1].forEach(function (direction) {
      C.register({ id: direction < 0 ? 'tabs.moveleft' : 'tabs.moveright',
        title: 'Move this article ' + (direction < 0 ? 'left' : 'right'), section: 'Go to',
        keys: (mac ? '⌘⌥⇧' : 'Ctrl+Alt+Shift+') + (direction < 0 ? '←' : '→'),
        when: function () { var shown = visiblePieces(), at = shown.findIndex(function (p) { return p.path === openArticle(); }); return at >= 0 && !!shown[at + direction]; },
        run: function () { var path = openArticle(); moveArticleTab(path, direction); focusArticleTab(path); }
      });
    });
    C.register({ id: 'tabs.reopen', title: 'Reopen a closed article', hint: 'its tab comes back', section: 'Go to',
      when: function () { return Castor.tabs.closed().length > 0 && !!C.openList; },
      run: function () {
        C.openList({ title: 'Reopen a closed article', items: Castor.tabs.closed().map(function (p) { return { id: p.path, label: p.title }; }),
          onPick: function (item) { openPiece(item.id); } });
      } });
  }

  function chooserTab() {
    var item = document.createElement('span');
    item.className = 'castor-tab-item castor-tab-item-chooser';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'castor-tab castor-tab-chooser';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', 'true');
    var name = document.createElement('span');
    name.className = 'castor-tab-name';
    name.textContent = 'Open or new';
    b.appendChild(name);
    b.addEventListener('click', function () { if (chooser) chooser.search.focus(); });
    item.appendChild(b);
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'castor-tab-close castor-tab-chooser-close';
    x.setAttribute('aria-label', 'Close this tab and go back');
    x.title = 'Close';
    x.textContent = '×';
    x.addEventListener('click', function () { closeChooser(true); });
    item.appendChild(x);
    return item;
  }
  function plusButton() {
    var mac = !Castor.keys || Castor.keys.os() === 'mac';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'castor-tab-new';
    b.setAttribute('aria-label', 'Open or start an article');
    b.setAttribute('aria-keyshortcuts', mac ? 'Meta+Alt+P' : 'Control+Alt+P');
    b.title = 'Open or start an article (' + (mac ? '⌘⌥P' : 'Ctrl+Alt+P') + ')';
    b.textContent = '+';
    b.addEventListener('click', openChooser);
    return b;
  }

  function renderTabs() {
    defaultTabs();
    prunePieceCache();
    var shown = visiblePieces();
    if (pieces.length < 2 || !shown.length) { dropStrip(); return; }
    var strip = ensureStrip();
    if (recall('tabs') !== 'folded') store('tabs', 'open');
    var signature = shown.map(function (p) { return p.path + '\n' + p.title; }).join('\n') + (chooser ? '\n+chooser' : '');
    if (strip._pieces !== signature) {
    strip._pieces = signature;
    strip.textContent = '';
    shown.forEach(function (piece, i) {
      /* The tab and its close button are siblings: a button never sits inside a button. */
      var item = document.createElement('span');
      item.className = 'castor-tab-item';
      item.dataset.path = piece.path;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'castor-tab';
      b.dataset.path = piece.path;
      b.setAttribute('role', 'tab');
      var here = !chooser && (liveState ? piece.path === liveState.path
        : piece.path === ((data.piece && data.piece.folder) ? data.piece.folder + '/article.md' : ''));
      b.setAttribute('aria-selected', here ? 'true' : 'false');
      var name = document.createElement('span');
      name.className = 'castor-tab-name';
      name.textContent = piece.title;
      b.appendChild(name);
      if (i < 9) b.setAttribute('aria-keyshortcuts', tabChord().aria + (i + 1));
      b.title = 'Drag to reorder. Move left or right with ' + ((!Castor.keys || Castor.keys.os() === 'mac') ? 'Cmd+Option+Shift+Arrow.' : 'Ctrl+Alt+Shift+Arrow.');
      b.addEventListener('click', function () { if (b._dragged) { b._dragged = false; return; } openPiece(piece.path); });
      wireTabDrag(b, piece);
      b.addEventListener('contextmenu', function (e) { openTabMenu(e, piece); });
      b.addEventListener('keydown', function (e) {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        e.preventDefault();
        closeTab(piece.path);
      });
      item.appendChild(b);
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'castor-tab-close';
      x.dataset.path = piece.path;
      x.setAttribute('aria-label', 'Close ' + piece.title);
      x.title = 'Close';
      x.textContent = '×';
      x.addEventListener('click', function () { closeTab(piece.path); });
      item.appendChild(x);
      strip.appendChild(item);
      if (here && tabEls.title) tabEls.title.textContent = piece.title;
    });
    if (chooser) strip.appendChild(chooserTab());
    if (!reviewing() && liveState && liveState.path) strip.appendChild(plusButton());
    if (Castor.capsule) {
      var more = document.createElement('button');
      more.type = 'button'; more.className = 'castor-tabs-more'; more.hidden = true;
      more.addEventListener('click', moreArticleTabs);
      strip.insertBefore(more, strip.querySelector('.castor-tab-new'));
    }
    } else {
      strip.querySelectorAll('.castor-tab').forEach(function (b) {
        if (b.classList.contains('castor-tab-chooser')) return;
        var here = !chooser && liveState && b.dataset.path === liveState.path;
        b.setAttribute('aria-selected', here ? 'true' : 'false');
        if (here && tabEls.title) {
          var name = b.querySelector('.castor-tab-name');
          var piece = pieces.filter(function (p) { return p.path === b.dataset.path; })[0];
          tabEls.title.textContent = name ? name.textContent : piece ? piece.title : '';
        }
      });
    }
    // The sheet paints before measuring the strip, so this read cannot force its first layout.
    if (global.requestAnimationFrame) global.requestAnimationFrame(function () { global.requestAnimationFrame(revealTab); });
    else setTimeout(revealTab, 32);
    queueKnot(true);
    installHint(strip);
  }

  /* INSTALLING FREES THE NATURAL CHORD. In an installed app window there are no
     browser tabs, so ⌘1-9 (Ctrl+1-9 off a Mac) reach the page and switch
     articles. One quiet line at the end of the strip says so: only where the
     strip exists (several articles, so the chord matters), only on a computer,
     only in a browser that can install a page, never once installed, and never
     again once dismissed. When the browser offers its install prompt the line
     carries an Install word that opens it; otherwise the line only informs. */
  var installPrompt = null;          // dismissal is remembered as castor.<world>.installHint
  function canInstallHere() {
    var host = global.Castor && global.Castor.host;
    if (host && host.native()) return false;                     // the app is installed already
    if (installPrompt) return true;
    var nav = global.navigator || {};
    var ua = nav.userAgent || '';
    if (/Firefox\//.test(ua)) return false;                       // no install on desktop Firefox
    var chromium = !!(nav.userAgentData && nav.userAgentData.brands) || /Chrome\/|Edg\//.test(ua);
    var safari = /Safari\//.test(ua) && !/Chrome\/|Chromium\//.test(ua);
    return chromium || safari;
  }
  function installHint(strip) {
    var old = document.getElementById('install-hint');
    var dismissed = recall('installHint') === 'dismissed';
    var keys = Castor.keys;
    /* Never for a reviewer: installing is for the people who work here daily. */
    var show = !reviewing() && !!(strip && keys && keys.form() === 'desktop' && !keys.standalone() &&
      !dismissed && canInstallHere());
    if (!show) { if (old) old.remove(); return; }
    var mac = keys.os() === 'mac';
    var line = old || document.createElement('span');
    line.id = 'install-hint';
    line.className = 'install-hint';
    line.textContent = '';
    var say = document.createElement('span');
    say.className = 'install-hint-text';
    say.textContent = (mac ? '\u23181\u20139' : 'Ctrl+1\u20139') +
      (installPrompt ? ' switch articles in the installed app' : ' switch articles once this page is installed as an app');
    line.appendChild(say);
    if (installPrompt) {
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'install-hint-go';
      go.textContent = 'Install';
      go.addEventListener('click', function () {
        var p = installPrompt;
        if (!p) return;
        installPrompt = null;
        try {
          p.prompt();
          Promise.resolve(p.userChoice).then(function () { renderTabs(); });
        } catch (e) { renderTabs(); }
      });
      line.appendChild(go);
    }
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'install-hint-x';
    x.setAttribute('aria-label', 'Dismiss this tip');
    x.textContent = '\u00d7';
    x.addEventListener('click', function () {
      store('installHint', 'dismissed');
      line.remove();
    });
    line.appendChild(x);
    if (line.parentNode !== strip) strip.appendChild(line);
  }
  global.addEventListener('beforeinstallprompt', function (e) {
    /* Only a computer gets the line; a tablet or phone keeps the browser's own
       install offer, which preventDefault would suppress. */
    if (!Castor.keys || Castor.keys.device() !== 'desktop' || reviewing()) return;
    e.preventDefault();
    installPrompt = e;
    renderTabs();
  });
  global.addEventListener('appinstalled', function () { installPrompt = null; renderTabs(); });

  function loadPieces() {
    /* The strip needs a server, not live mode. A page opened from disk has no
       server and no other pieces to reach, so it asks nothing. */
    var proto = (global.location && global.location.protocol) || '';
    if (proto !== 'http:' && proto !== 'https:') return;
    /* A browser that has shown the strip before keeps its row from the first
       frame, so the page does not move down when the list arrives. */
    if (recall('tabs')) ensureStrip();
    // The authenticated article response already lists the same catalogue.
    var included = liveState && liveState.payload && liveState.payload.articleTabs;
    var listing = Array.isArray(included) ? Promise.resolve(included)
      : global.fetch('/api/pieces', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('pieces did not load'); return r.json(); });
    listing.then(function (list) {
        if (!Array.isArray(list)) { dropStrip(); return; }
        pieces = list;
        if (Castor.files && Castor.files.render) Castor.files.render();
        /* The piece the shell opened may not be one of the articles -- the sample
           is the usual case -- and it still deserves a tab, or the strip would
           show you places you are not. */
        var open = liveState ? liveState.path
          : ((data.piece && data.piece.folder) ? data.piece.folder + '/article.md' : '');
        var known = pieces.some(function (p) { return p.path === open; });
        /* A reviewer's strip is exactly what the server shares with them. */
        if (!known && open && !reviewing()) {
          pieces = [{ path: open, title: (data.piece && data.piece.title) || 'This piece' }].concat(pieces);
        }
        renderTabs();
        queuePiecePrefetch();
      })
      .catch(function () { dropStrip(); /* no strip is the right answer when the list cannot be read */ });
  }

  /* --- who is writing -------------------------------------------------------
     A writing session: the people at this page, in order. The first is at the
     keyboard and signs each save as its author; everyone else is named in it.
     The installation's writers are ticked; anyone else is added with a name and an
     email. Every save names at least one founder, because the commit's
     Principal is always a founder. Not a login: the private network is the
     door, and this is a signature.

     The card is shown when the page opens only if this browser has never
     been told who is writing, and never while someone is typing. The session
     lives in this tab (sessionStorage) and is remembered in this browser
     (localStorage), which a new tab starts from. `castor.who` keeps the first founder, which is
     what comments are saved under. */
  var WHO_KEY = 'castor.who';
  var SESSION_KEY = 'castor.session';
  /* The writers come from the space's people.json through people.js. */
  var WHO_NAMES = Castor.people ? Castor.people.names() : {};
  var WHO_SHORT = Castor.people ? Castor.people.shorts() : {};
  var EMAIL_RE = /^[^\s@<>()[\],;:"\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;
  var whoWaiters = [];
  var afterWho = [];
  var sessionMemory = null;          // the session when this browser stores nothing

  function cleanName(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

  /* Why a name and email cannot sign a save, or '' when they can. serve.py
     applies the same rules and refuses what fails them. */
  function guestProblem(name, email) {
    name = cleanName(name);
    email = String(email == null ? '' : email).trim();
    if (!name || name.length > 60) return 'A name is 1 to 60 characters.';
    if (/[<>\u0000-\u001f\u007f]/.test(name) || !/[0-9A-Za-z\u00c0-\uffff]/.test(name)) return 'A name needs letters, and no < or >.';
    if (email.length > 254 || !EMAIL_RE.test(email)) return 'That email does not look complete.';
    return '';
  }

  function samePerson(a, b) {
    if (a.id || b.id) return a.id === b.id;
    return a.email.toLowerCase() === b.email.toLowerCase();
  }
  function personName(p) { return p.id ? WHO_NAMES[p.id] : p.name; }
  function personShort(p) {
    if (p.id) return WHO_SHORT[p.id];
    var words = p.name.split(' ');
    var a = words[0].charAt(0), b = words.length > 1 ? words[words.length - 1].charAt(0) : words[0].charAt(1);
    return (a + b).toUpperCase();
  }
  function hasFounder(people) { return people.some(function (p) { return !!p.id; }); }
  function tickWriterLine() {
    var named = Object.keys(WHO_NAMES).map(function (id) { return WHO_NAMES[id]; });
    if (named.length === 1) return 'Tick ' + named[0] + ' too: every save names ' + named[0] + '.';
    return 'Tick ' + (named.length > 2 ? 'one of ' : '') + named.slice(0, -1).join(', ') + ' or ' + named[named.length - 1] + ' too: every save names one of them.';
  }

  /* A stored or offered list, cleaned: founders as {id}, others as {name, email}. */
  function readPeople(list) {
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { return []; } }
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (p) {
      var person = null;
      if (typeof p === 'string' && WHO_NAMES[p]) person = { id: p };
      else if (p && WHO_NAMES[p.id]) person = { id: p.id };
      else if (p && typeof p === 'object' && !guestProblem(p.name, p.email)) {
        person = { name: cleanName(p.name), email: String(p.email).trim() };
      }
      if (person && !out.some(function (x) { return samePerson(x, person); })) out.push(person);
    });
    return out;
  }

  function tabStore() { try { return global.sessionStorage || null; } catch (e) { return null; } }
  function browserStore() { try { return global.localStorage || null; } catch (e) { return null; } }
  function readStored(store, name) {
    if (!store) return [];
    try { return readPeople(store.getItem(name) || '[]'); } catch (e) { return []; }
  }

  /* The session saves are signed with: this tab's, or the one remembered. */
  function sessionNow() {
    if (reviewing()) return [];
    if (Castor.role.publicWriter) {
      if (!Castor.role.confirmed || !Castor.role.who) return [];
      var remembered = sessionMemory || readStored(tabStore(), SESSION_KEY);
      return remembered.length && remembered[0].id === Castor.role.who ? remembered.slice() : [{ id: Castor.role.who }];
    }
    if (sessionMemory && hasFounder(sessionMemory)) return sessionMemory.slice();
    var s = readStored(tabStore(), SESSION_KEY);
    if (!hasFounder(s)) s = readStored(browserStore(), SESSION_KEY);
    if (!hasFounder(s)) {
      var v = null;
      try { var b = browserStore(); v = b ? b.getItem(WHO_KEY) : null; } catch (e) { v = null; }
      s = WHO_NAMES[v] ? [{ id: v }] : [];
    }
    return hasFounder(s) ? s : [];
  }
  /* A session this tab confirmed, or the one this browser remembers: the card
     opens by itself only when neither names a founder. The initials beside the
     save word reopen it to change who is writing. */
  function confirmedHere() {
    if (Castor.role.publicWriter) return !!Castor.role.confirmed;
    return !!(sessionMemory && hasFounder(sessionMemory)) || hasFounder(readStored(tabStore(), SESSION_KEY)) ||
      hasFounder(readStored(browserStore(), SESSION_KEY));
  }
  /* What a save sends as `who`: a writer's key for a writer, {name, email} for anyone else. */
  function whoList() {
    return sessionNow().map(function (p) { return p.id ? p.id : { name: p.name, email: p.email }; });
  }
  /* The founder comments are saved under: the first one in the session. */
  function whoGet() {
    var first = sessionNow().filter(function (p) { return !!p.id; })[0];
    return first ? first.id : '';
  }

  function setSession(list) {
    var people = readPeople(list);
    if (!hasFounder(people)) return false;
    if (Castor.role.publicWriter && people[0].id !== Castor.role.who) return false;
    if (Castor.editor && Castor.editor.flush) Castor.editor.flush();
    if (saver && !saver.writerUnknown && whoList().length && JSON.stringify(people) !== JSON.stringify(sessionNow()) &&
        writableHere() && (saver.inflight || (saver.typed && editorSource() !== saver.text))) {
      var path = saver.path;
      if (keepOn()) Castor.keep.nowSync();
      flushSave(false).then(function () {
        if (saver.path !== path) return;
        if (!saver.inflight && editorSource() === saver.text) setSession(people);
        else {
          var problem = document.getElementById('castor-who-problem');
          if (problem) { problem.textContent = 'Save this writing before changing who is at the keyboard.'; problem.hidden = false; }
        }
      });
      return false;
    }
    // Identity may return to the same value after a real keyboard-session
    // change; an older recovery continuation must still remain canceled.
    if (JSON.stringify(people) !== JSON.stringify(sessionNow())) keptOperation = (keptOperation || 0) + 1;
    sessionMemory = people;
    var attributeKept = saver && saver.writerUnknown;
    if (attributeKept) { saver.writer = whoList(); saver.writerUnknown = false; }
    else if (saver && !saver.inflight && editorSource() === saver.text) releaseWriter();
    var raw = JSON.stringify(people);
    var tab = tabStore(), browser = browserStore();
    try { if (tab) tab.setItem(SESSION_KEY, raw); } catch (e) { /* this tab forgets on reload */ }
    try {
      if (browser) {
        browser.setItem(SESSION_KEY, raw);
        browser.setItem(WHO_KEY, people.filter(function (p) { return !!p.id; })[0].id);
      }
    } catch (e2) { /* this browser forgets and the card asks again */ }
    loadClosed();
    renderTabs();
    closeWhoCard();
    whoWaiters.splice(0).forEach(function (resolve) { resolve(whoGet()); });
    bus.emit('who:set', whoGet());
    renderSaveState();
    resume();
    drainSoon(0);
    if (attributeKept) { journal(); if (keepOn()) Castor.keep.nowSync(); saveNow(false); }
    return true;
  }

  function closeWhoCard() {
    var card = document.getElementById('castor-who');
    if (card) card.remove();
    var opener = document.getElementById('castor-session');
    if (opener) opener.setAttribute('aria-expanded', 'false');
    whoWaiters.splice(0).forEach(function (resolve) { resolve(whoGet()); });
    afterWho.splice(0).forEach(function (fn) { try { fn(); } catch (e) { console.error('[castor] after who', e); } });
  }
  /* Run `fn` once the card is out of the way (now, if it is not up). */
  function whenWhoClosed(fn) {
    if (document.getElementById('castor-who')) afterWho.push(fn); else return fn();
  }

  /* The card's few rules that engine.css does not carry yet. */
  function installWhoStyles() {
    if (document.getElementById('castor-who-styles') || !document.head) return;
    var style = document.createElement('style');
    style.id = 'castor-who-styles';
    style.textContent =
      '.castor-who-list{display:grid;gap:.4rem;margin:0 0 .7rem}' +
      '.castor-who-person{display:flex;align-items:center;gap:.5rem;cursor:pointer}' +
      '.castor-who-person input{margin:0;accent-color:currentColor}' +
      '.castor-who-tag{font-size:.75rem;opacity:.62}' +
      '.castor-who-add{display:grid;gap:.4rem;margin:.6rem 0 0}' +
      '.castor-who-add[hidden]{display:none}' +
      '.castor-who-add input{font:inherit;font-size:.88rem;color:inherit;background:transparent;' +
      'border:1px solid var(--rule,#d9dad6);border-radius:6px;padding:.35rem .5rem}' +
      '.castor-who-problem{opacity:1}' +
      '.castor-session{margin-left:-.25rem;letter-spacing:.02em}';
    document.head.appendChild(style);
  }

  function pick(text, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'castor-who-pick';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }
  function line(tag, cls, text) {
    var n = document.createElement(tag);
    n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  /* Someone is in the middle of writing: the card never takes the focus then. */
  function typingNow() {
    if (saver.typed) return true;
    try { return !!(Castor.editor && Castor.editor.isFocused && Castor.editor.isFocused()); } catch (e) { return false; }
  }

  function whoCard() {
    if (reviewing() || document.getElementById('castor-who')) return;
    installWhoStyles();
    var picked = sessionNow();
    var others = picked.filter(function (p) { return !p.id; });
    var card = document.createElement('div');
    card.id = 'castor-who';
    card.className = 'castor-who';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Who is writing');
    var question = line('p', 'castor-who-q', saver.writerUnknown ? 'Who wrote this unsaved text?' : 'Who’s writing?');
    question.id = 'castor-who-question'; card.appendChild(question);

    var list = line('div', 'castor-who-list');
    var problem = line('p', 'castor-who-note castor-who-problem');
    problem.id = 'castor-who-problem';
    problem.hidden = true;
    function isPicked(p) { return picked.some(function (x) { return samePerson(x, p); }); }
    function draw() {
      list.textContent = '';
      Object.keys(WHO_NAMES).map(function (id) { return { id: id }; }).concat(others).forEach(function (person) {
        var row = line('label', 'castor-who-person');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = isPicked(person);
        box.addEventListener('change', function () {
          if (box.checked && !isPicked(person)) picked.push(person);
          if (!box.checked) picked = picked.filter(function (x) { return !samePerson(x, person); });
          problem.hidden = true;
          draw();
        });
        row.appendChild(box);
        row.appendChild(line('span', 'castor-who-name', personName(person)));
        if (picked.length && samePerson(picked[0], person)) row.appendChild(line('span', 'castor-who-tag', 'at the keyboard'));
        list.appendChild(row);
      });
    }
    draw();
    card.appendChild(list);

    var form = line('div', 'castor-who-add');
    form.hidden = true;
    var name = document.createElement('input');
    name.type = 'text';
    name.placeholder = 'Name';
    name.maxLength = 60;
    name.setAttribute('aria-label', 'Name');
    name.setAttribute('autocomplete', 'name');
    var mail = document.createElement('input');
    mail.type = 'email';
    mail.placeholder = 'Email';
    mail.setAttribute('aria-label', 'Email');
    mail.setAttribute('autocomplete', 'email');
    function addGuest() {
      var why = guestProblem(name.value, mail.value);
      if (why) { problem.textContent = why; problem.hidden = false; return; }
      var person = { name: cleanName(name.value), email: String(mail.value).trim() };
      if (!others.some(function (x) { return samePerson(x, person); })) others.push(person);
      if (!isPicked(person)) picked.push(person);
      name.value = '';
      mail.value = '';
      form.hidden = true;
      problem.hidden = true;
      draw();
    }
    [name, mail].forEach(function (field) {
      field.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addGuest(); } });
    });
    form.appendChild(name);
    form.appendChild(mail);
    var formRow = line('div', 'castor-who-row');
    formRow.appendChild(pick('Add', addGuest));
    form.appendChild(formRow);

    var row = line('div', 'castor-who-row');
    var go = pick(saver.writerUnknown ? 'Save this version' : 'Start writing', function () {
      if (!hasFounder(picked)) {
        problem.textContent = tickWriterLine();
        problem.hidden = false;
        return;
      }
      setSession(picked);
    });
    row.appendChild(go);
    row.appendChild(pick('Someone else', function () {
      form.hidden = false;
      try { name.focus(); } catch (e) { /* nothing to focus */ }
    }));
    row.appendChild(pick('Not now', closeWhoCard));
    card.appendChild(row);
    card.appendChild(form);
    card.appendChild(problem);
    card.appendChild(line('p', 'castor-who-note',
      'The first one ticked is at the keyboard and signs each save; everyone ticked is named in it. Remembered in this browser.'));
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && Castor.popovers) { Castor.popovers.containTab(e, card, document); return; }
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); closeWhoCard();
        var opener = document.getElementById('castor-session'); if (opener) opener.focus();
      }
    });
    document.body.appendChild(card);
    var opener = document.getElementById('castor-session');
    if (Castor.popovers && opener && card.showPopover) {
      card.setAttribute('popover', 'auto');
      card.addEventListener('toggle', function (e) { if (e.newState === 'closed' && document.getElementById('castor-who') === card) closeWhoCard(); });
      card.showPopover();
    }
    if (opener) opener.setAttribute('aria-expanded', 'true');
    if (!typingNow()) { try { go.focus(); } catch (e) { /* nothing to focus */ } }
  }

  /* A reviewer is never asked: the server knows who they are from how they
     signed in, and it records their comments under that name whatever the
     page sends. */
  function whoAsk(force) {
    if (reviewing()) return Promise.resolve('');
    var now = whoGet();
    if (now && !force) return Promise.resolve(now);
    return new Promise(function (resolve) {
      whoWaiters.push(resolve);
      whoCard();
    });
  }

  /* The card at the page's opening, once, unless this tab already chose. */
  var askedAtOpen = false;
  function askAtOpen() {
    if (askedAtOpen || reviewing()) return;
    askedAtOpen = true;
    if (!confirmedHere()) whoCard();
  }

  Castor.who = {
    get: whoGet,
    name: function () {
      if (reviewing()) return Castor.role.name || '';
      var v = whoGet(); return v ? WHO_NAMES[v] : '';
    },
    ask: function () { return whoAsk(false); },
    change: function () { return whoAsk(true); },
    session: function () { return sessionNow(); },
    whenClosed: whenWhoClosed,
    set: setSession,
    problem: guestProblem
  };

  var SAVE_PAUSE = 8000;
  var SAVE_TIMEOUT = 20000;
  var RETRY_FIRST = 2000;
  var RETRY_MAX = 30000;
  var WRITABLE = new RegExp('^articles/[^/]+/(article\\.md|drafts/(' + Object.keys(WHO_NAMES).join('|') + ')/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\\.md)$');
  var saver = { path: '', base: '', text: null, state: 'none', detail: '', short: '', timer: 0, inflight: null,
    retries: 0, again: false, restored: false, typed: false, conflict: null, evidence: null, writer: null, writerHold: false, writerUnknown: false, needsLive: false };
  var SAVE_WORDS = {
    none: '', ready: 'Saved', saved: 'Saved', restored: 'Restored your unsaved text', saving: 'Saving',
    unsaved: 'Kept on this device', offline: 'Kept on this device',
    locked: 'Read only here', stale: 'Older than the file: reload',
    dirty: 'Not saved: changed outside the app', conflict: 'Not saved: changed elsewhere',
    refused: 'Not saved', reviewing: 'Reviewing'
  };

  function editorSource() {
    return (Castor.editor && Castor.editor.getSource) ? Castor.editor.getSource() : source;
  }
  function servedOverHttp() {
    var p = (global.location && global.location.protocol) || '';
    return p === 'http:' || p === 'https:';
  }
  /* The journal holds what is typed here; false when its last write reached no store. */
  function journalKeeps() { return !!(Castor.keep && Castor.keep.healthy()); }
  var pendingComments = {}, pendingFiles = {};
  function fileWarning() { return Object.keys(pendingFiles).map(function (name) { return pendingFiles[name]; }).join(' '); }
  bus.on('files:error', function (info) {
    if (info) pendingFiles[info.name] = info.name + ': ' + info.error;
    renderSaveState();
  });
  bus.on('files:stored', function (info) {
    if (info) delete pendingFiles[info.name];
    renderSaveState();
  });
  bus.on('save:activity', renderSaveState);
  var pendingCommentKeys = {};
  function pendingCommentPath(storageKey) {
    if (!/\.unsaved$/.test(storageKey || '') || !Castor.commentScope) return '';
    var scope = Castor.commentScope(storageKey.slice(0, -8));
    if (!scope || scope.world !== 'typewell' || scope.kind === 'unconfirmed') return '';
    if (scope.kind && (scope.kind !== (reviewing() ? 'reader' : 'writer') || scope.account !== Castor.role.id)) return '';
    return scope.path;
  }
  try {
    for (var keptComment = 0; keptComment < global.localStorage.length; keptComment++) {
      var pendingKey = global.localStorage.key(keptComment);
      if (/\.unsaved$/.test(pendingKey || '')) pendingCommentKeys[pendingKey] = true;
    }
  } catch (e) { /* the current article also reports its own pending copy */ }
  if (global.addEventListener) global.addEventListener('storage', function (event) {
    if (!/\.unsaved$/.test(event.key || '')) return;
    if (event.newValue) pendingCommentKeys[event.key] = true;
    else delete pendingCommentKeys[event.key];
    var path = pendingCommentPath(event.key);
    if (!path) return;
    if (!event.newValue) delete pendingComments[path];
    renderSaveState();
  });
  function commentWarning() {
    var paths = Object.keys(pendingComments);
    return paths.length ? pendingComments[paths[0]] : Object.keys(pendingCommentKeys).some(function (key) { return !!pendingCommentPath(key); })
      ? 'A comment is kept on this device and is waiting to save.' : '';
  }
  function saveWord() {
    if (!reviewing() && commentWarning()) return 'Not saved: comment';
    if (Castor.saveStatus && ['ready', 'saved', 'restored', 'unsaved', 'saving', 'offline'].indexOf(saver.state) >= 0) {
      return saveDescription().word;
    }
    var kept = journalKeeps();
    // An ordinary pause before the save is saving; kept on this device is for a save that waits.
    if (saver.state === 'unsaved') return !kept ? 'Not saved yet' : saver.detail ? SAVE_WORDS.unsaved : 'Saving…';
    if (saver.state === 'offline') return kept ? SAVE_WORDS.offline : 'Not saved: can’t reach the server';
    if (saver.state === 'refused' && saver.short) return 'Not saved: ' + saver.short;
    if (saver.state === 'locked' && saver.short) return saver.short;
    return SAVE_WORDS[saver.state] || '';
  }
  function saveDescription() {
    var evidence = saver.evidence || {};
    var text = editorSource();
    return Castor.saveStatus.describe({
      current: text === saver.text, offline: saver.state === 'offline', saving: !!saver.inflight || saver.state === 'saving',
      deviceAt: Castor.keep && Castor.keep.receipt ? Castor.keep.receipt(saver.path, text) : 0,
      history: evidence.history, shared: evidence.shared, warning: [commentWarning(), fileWarning()].filter(Boolean).join(' '),
      problem: ['dirty', 'refused', 'conflict', 'stale', 'locked', 'offline'].indexOf(saver.state) >= 0 ? saver.detail || SAVE_WORDS[saver.state] : ''
    });
  }
  var savePoll = 0;
  function refreshSaveEvidence() {
    if (!Castor.saveStatus || !saver.path || !saver.base || !global.fetch || reviewing() || saver.needsLive) return;
    var path = saver.path, sha = saver.base;
    return global.fetch('/api/save-status?path=' + encodeURIComponent(path) + '&sha=' + encodeURIComponent(sha), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('save status unavailable'); return r.json(); })
      .then(function (evidence) {
        if (path !== saver.path || sha !== saver.base) return;
        saver.evidence = evidence;
        // Save-status also drives the server's background pull. Refresh idle
        // open tabs periodically: this endpoint proves the requested old commit,
        // not whether it is still the article's newest one.
        queuePiecePrefetch();
        var entry = pieceCache.get(path);
        if (entry && Date.now() - entry.at >= PIECE_CACHE_AGE && !saver.inflight &&
            !saver.needsLive && editorSource() === saver.text) attachSaver();
        renderSaveState();
      }).catch(function () {
        if (path !== saver.path || sha !== saver.base) return;
        /* A previous confirmation remains evidence; a missing one stays unknown. */
        if (!saver.evidence) saver.evidence = { shared: { ok: false, reason: 'The server is unreachable. Checking again when it answers.' } };
        renderSaveState();
      });
  }
  function renderSavePopover() {
    var panel = document.getElementById('castor-save-details');
    if (!panel || !Castor.saveStatus) return;
    panel.textContent = '';
    saveDescription().rows.forEach(function (row) {
      var p = line('p', 'save-step');
      p.dataset.confirmed = String(row.ok);
      var mark = line('span', 'save-step-mark', row.ok ? '✓' : '·');
      mark.setAttribute('aria-label', row.ok ? 'Confirmed' : 'Not confirmed');
      p.appendChild(mark);
      var words = line('span', 'save-step-words');
      words.appendChild(line('span', 'save-step-label', row.label));
      words.appendChild(line('small', 'save-step-detail', row.detail));
      p.appendChild(words); panel.appendChild(p);
    });
    if (commentWarning()) panel.appendChild(line('p', 'save-explanation', commentWarning()));
    if (fileWarning()) panel.appendChild(line('p', 'save-explanation', fileWarning()));
    if (saver.detail && (editorSource() !== saver.text || ['dirty', 'refused', 'conflict', 'stale', 'locked', 'offline'].indexOf(saver.state) >= 0)) panel.appendChild(line('p', 'save-explanation', saver.detail));
    if (saver.state === 'refused' && saver.refusal && saver.refusal.line && Castor.editor && Castor.editor.revealSource) {
      panel.appendChild(pick('Show line ' + saver.refusal.line, function () { if (panel.hidePopover) panel.hidePopover(); showRefusal(); }));
    }
    if (['unsaved', 'offline', 'dirty', 'refused'].indexOf(saver.state) >= 0) {
      panel.appendChild(pick('Try saving now', function () { retryNow(true); }));
    }
    if (saver.state === 'conflict') panel.appendChild(pick('Compare versions', showConflict));
    if (saver.state === 'stale') panel.appendChild(pick('Open current article', function () { reloadLive(); }));
    if (signedOut) panel.appendChild(pick('Sign in again', Castor.signin));
    if (Castor.keep && saver.path) {
      var path = saver.path;
      panel.appendChild(pick('Other kept copies', function () { if (saver.path === path) return showKeptCopies(path); }));
    }
  }
  function renderSaveState() {
    if (reviewing() && Castor.readerShell) { Castor.readerShell.render(); return; }
    var el = document.getElementById('castor-save');
    var word = saveWord();
    if (!word) { if (el) el.remove(); renderSession(); return; }
    if (!el) {
      var slot = document.getElementById('castor-save-slot');
      if (!slot && !els.topbar) return;
      el = document.createElement('button');
      el.type = 'button';
      el.id = 'castor-save';
      el.className = 'castor-save';
      el.setAttribute('aria-live', 'polite');
      if (Castor.popovers && Castor.saveStatus) {
        var panel = line('div', 'save-details');
        panel.id = 'castor-save-details';
        panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Save status');
        document.body.appendChild(panel);
        Castor.popovers.bind(el, panel, function () { renderSavePopover(); refreshSaveEvidence(); });
      }
      el.addEventListener('click', function () {
        if (reviewing()) { reviewerNotice(); return; }
        if (Castor.saveStatus) return;
        if (saver.state === 'stale') { global.location.search = '?live=' + encodeURIComponent(saver.path); return; }
        if (saver.state === 'conflict') { showConflict(); return; }
        if (['unsaved', 'offline', 'dirty', 'refused'].indexOf(saver.state) >= 0 && saver.base) { retryNow(true); return; }
        whoAsk(true);
      });
      /* The footer line holds it; a shell without one keeps it at the bar's end. */
      if (slot) slot.appendChild(el);
      else els.topbar.appendChild(el);
    }
    el.dataset.state = saver.state;
    if (reviewing()) {
      /* A reviewer's word says whose comments these will be, where a founder's
         says whether the text is saved. */
      var me = Castor.role.name;
      el.textContent = saver.state === 'refused' ? 'Comment not saved'
        : (me ? 'Reviewing as ' + me : 'Reviewing');
      el.title = saver.detail || REVIEWING_SAYS;
      renderSession();
      return;
    }
    if (Castor.saveStatus) Castor.saveStatus.render(el, saveDescription());
    else { el.textContent = word; el.title = commentWarning() || saver.detail || ''; }
    // The panel is built as it opens (popovers.bind) and kept current while open, never rebuilt
    // on a key while it is closed, so a keystroke does no DOM work for it. A browser without
    // native popovers shows it by other means, so there it is built every time.
    var details = document.getElementById('castor-save-details'), shut = false;
    try { shut = !!(details && details.matches && !details.matches(':popover-open')); } catch (e) { shut = false; }
    if (!shut) renderSavePopover();
    renderSession();
    if (Castor.touchLayout) Castor.touchLayout.placeSave();
  }

  /* Who is in the session, as initials beside the save word; clicking them
     opens the card. */
  function renderSession() {
    var save = document.getElementById('castor-save');
    var el = document.getElementById('castor-session');
    if (reviewing() || !save || !save.parentNode) { if (el) el.remove(); return; }
    if (!el) {
      installWhoStyles();
      el = document.createElement('button');
      el.type = 'button';
      el.id = 'castor-session';
      el.className = 'castor-save castor-session';
      el.addEventListener('click', function () {
        if (document.getElementById('castor-who')) closeWhoCard(); else whoAsk(true);
      });
    }
    var slot = document.getElementById('castor-save-slot') || save.parentNode;
    if (el.parentNode !== slot) slot.appendChild(el);
    var people = sessionNow();
    el.textContent = people.length ? people.map(personShort).join(' ') : 'Who?';
    var names = people.map(function (p, i) { return personName(p) + (i === 0 ? ' (at the keyboard)' : ''); });
    var says = people.length ? 'Writing: ' + names.join(', ') + '. Click to change.' : 'Say who is writing. Click to choose.';
    el.setAttribute('aria-label', says);
    el.title = says;
    el.setAttribute('aria-expanded', String(!!document.getElementById('castor-who')));
    el.setAttribute('aria-controls', 'castor-who');
  }

  /* --- telling a reviewer, in a card they cannot miss --------------------------
     A founder's failed save is a word in the bar with its reason on hover. A
     reviewer may be on a phone, where nothing hovers, and may not know the app
     at all, so what happened to their comment is said in a card, in plain
     words, with what they wrote kept in it to copy. Same card as "Who's
     writing?", so it adds no new look. */
  var REVIEWING_SAYS = 'You can read this article and comment on it: select words and choose Comment, ' +
    'or reply to a comment. The text itself cannot be changed here, and what is already written in a comment stays as it is.';
  function closeNotice() {
    var old = document.getElementById('castor-notice');
    if (old) old.remove();
  }
  function showNotice(head, text, words, alarm) {
    closeNotice();
    var card = document.createElement('div');
    card.id = 'castor-notice';
    card.className = 'castor-who castor-notice';
    card.setAttribute('role', alarm ? 'alertdialog' : 'dialog');
    card.setAttribute('aria-label', head);
    var q = document.createElement('p');
    q.className = 'castor-who-q';
    q.textContent = head;
    card.appendChild(q);
    var say = document.createElement('p');
    say.className = 'castor-notice-text';
    say.textContent = text;
    card.appendChild(say);
    if (words && words.length) {
      var label = document.createElement('p');
      label.className = 'castor-who-note';
      label.textContent = 'What you wrote, to copy:';
      card.appendChild(label);
      var box = document.createElement('textarea');
      box.className = 'castor-notice-words';
      box.readOnly = true;
      box.setAttribute('aria-label', 'What you wrote');
      box.value = words.join('\n\n');
      card.appendChild(box);
    }
    var row = document.createElement('div');
    row.className = 'castor-who-row';
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'castor-who-pick';
    ok.textContent = 'OK';
    ok.addEventListener('click', closeNotice);
    row.appendChild(ok);
    card.appendChild(row);
    card.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeNotice(); } });
    document.body.appendChild(card);
    ok.focus();
    return card;
  }
  function reviewerNotice() {
    if (saver.state === 'refused' && saver.detail) {
      return showNotice('Your comment was not saved', saver.detail, saver.words, true);
    }
    var me = Castor.role.name;
    return showNotice(me ? 'Reviewing as ' + me : 'Reviewing', REVIEWING_SAYS, null, false);
  }

  /* A comment that did not reach the repository says so where a save would. */
  bus.on('comments:pending', function (info) {
    pendingComments[(info && info.path) || saver.path] = 'A comment is kept on this device and is waiting to save.';
    renderSaveState();
  });
  bus.on('comments:unsaved', function (info) {
    if (reviewing()) {
      info = info || {};
      /* comments.js has already put the page back to what the server holds when
         the server REFUSED the comment (`dropped`); on a network failure it keeps
         the comment and sends it again with the next one. */
      var why = String(info.reason || 'the server refused it').replace(/\s+$/, '');
      if (!/[.!?]$/.test(why)) why += '.';
      var detail = info.held
        ? why + ' Your words are kept on this device. Open Comments to compare the saved copy and choose which to keep.'
        : info.dropped
        ? why + ' The comments shown now are the ones the server has.'
        : why + ' It is kept in this browser and sent again with your next comment.';
      setSave('refused', detail, 'comment');
      saver.words = info.words || null;
      showNotice(info.held ? 'Compare your comment with the saved copy' : 'Your comment was not saved', detail, saver.words, true);
      return;
    }
    pendingComments[(info && info.path) || saver.path] = info && info.held
      ? 'Your comment is kept on this device. Open Comments to compare it with the saved copy and choose which to keep.'
      : 'A comment was not saved to the shared history: ' + ((info && info.reason) || 'the server refused it') +
        ' It is kept in this browser and sent again when the connection returns or with your next comment.';
    renderSaveState();
  });
  bus.on('comments:saved', function (info) {
    delete pendingComments[(info && info.path) || saver.path];
    Object.keys(pendingCommentKeys).forEach(function (key) {
      try { if (!global.localStorage.getItem(key)) delete pendingCommentKeys[key]; } catch (e) { /* keep the warning until confirmed */ }
    });
    renderSaveState();
    if (saver.state === 'refused' && saver.short === 'comment') setSave(reviewing() ? 'reviewing' : 'saved');
  });
  // `refusal`: the check's line, for Show line; it belongs to this state only, so any other state
  // or refusal shown after it clears it.
  function setSave(state, detail, short, refusal) {
    saver.refusal = state === 'refused' && refusal || null;
    saver.state = state;
    saver.detail = detail || '';
    saver.short = short || '';
    renderSaveState();
    bus.emit('save:state', { state: state });
  }

  var KEPT_WAIT = 1500;              // opening never waits longer than this on the journal
  var opened = null, lastTypedCopy = null;
  var saveAttachment = 0, keptOperation = 0, recoveryRevision = 0, recoveryComposing = false, recoveryCompositionTarget = null;
  function compositionActive() {
    var nativeField = recoveryComposing && recoveryCompositionTarget && els.article && els.article.contains(recoveryCompositionTarget) && /^(INPUT|TEXTAREA)$/.test(recoveryCompositionTarget.tagName);
    return !!nativeField || (Castor.editor && Castor.editor.isComposing ? Castor.editor.isComposing() : recoveryComposing);
  }
  ['beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      if (!els.article || !event.target || !els.article.contains(event.target)) return;
      if (type === 'compositionstart') { recoveryComposing = true; recoveryCompositionTarget = event.target; }
      if (type === 'compositionend') { recoveryComposing = false; recoveryCompositionTarget = null; }
      recoveryRevision++;
      var notice = document.getElementById('castor-kept');
      if (notice && notice.hasAttribute('data-kept-choice')) closeKeptNotice();
      else keptOperation++;
    }, true);
  });

  function keptFor(path) {
    if (!Castor.keep || !WRITABLE.test(String(path || '')) || !servedOverHttp()) return Promise.resolve(null);
    var cap = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, KEPT_WAIT); });
    return Promise.race([Castor.keep.list(path, { includeEvidence: true }).then(keptForWriter).catch(function () { return null; }), cap]);
  }

  function keptForWriter(entries) {
    if (!Castor.role.publicWriter) return entries;
    if (!Castor.role.confirmed || !Castor.role.who) return [];
    return (entries || []).filter(function (entry) {
      var first = entry.who && entry.who[0];
      return (typeof first === 'string' ? first : first && first.id) === Castor.role.who;
    });
  }

  /* Choose what the editor opens with. Kept text typed over the version the
     server holds now replaces the server's text in `source`; anything else
     kept is left for recover() to offer. */
  function opening(path, payload, entries, prepared) {
    var vs = data.versions || [];
    var latest = vs.length ? vs[vs.length - 1] : null;
    opened = { path: path, sha: (latest && latest.sha) || '', serverText: source, shown: source, restored: null };
    if (!entries || !latest || !latest.sha || reviewing() || !payload || payload.locked) return;
    if (payload.markdown !== latest.markdown || latest.markdown !== source) return;
    var top = prepared;
    if (top && eligibleKept(top, entries) && top.base === latest.sha && recoveryCandidate(top, path, source, matchingKeptAt(entries, source))) {
      source = top.text;
      opened.shown = top.text;
      opened.restored = top;
    }
  }

  async function prepareOpening(path, payload, entries) {
    var versions = payload && payload.versions || [], latest = versions[versions.length - 1];
    var result = { ready: true, entry: null, entries: entries || [] };
    if (!Castor.keep) return result;
    if (!await Castor.keep.preserveCurrent(path, result.entries.some(function (entry) { return entry.mine; }))) return { ready: false, entry: null };
    if (!latest || !latest.sha || reviewing() || payload.locked || payload.markdown !== latest.markdown) return result;
    var top = result.entries.filter(function (entry) { return !entry.confirmed && !entry.unverified && !entry.live && entry.text !== payload.markdown; })[0];
    if (top && top.base === latest.sha && recoveryCandidate(top, path, payload.markdown, matchingKeptAt(result.entries, payload.markdown)) && await Castor.keep.adopt(top)) {
      try { result.entries = keptForWriter(await Castor.keep.list(path, { strict: true, includeEvidence: true })); }
      catch (e) { return { ready: false, entry: null }; }
      if (eligibleKept(top, result.entries) && recoveryCandidate(top, path, payload.markdown, matchingKeptAt(result.entries, payload.markdown))) result.entry = top;
    }
    return result;
  }

  function bindKept(entry) {
    saver.writer = entry.who && entry.who.length ? entry.who.slice() : [];
    saver.writerUnknown = !saver.writer.length;
    saver.writerHold = saver.writerUnknown || JSON.stringify(saver.writer) !== JSON.stringify(whoList());
    if (saver.writerHold && Castor.editor && Castor.editor.setReadOnly) Castor.editor.setReadOnly(true);
    saver.restored = true;
    saver.typed = true;
  }

  function restoreKept(entry, bound) {
    if (!bound) bindKept(entry);
    setSave('restored', saver.writerUnknown ? 'Choose who wrote this unsaved text before saving it.' : saver.writerHold ? 'This text keeps its original writer. Editing resumes after it is saved.' : 'Your unsaved text from ' + when(entry.at) + ' was put back and is being saved.');
    if (saver.writerUnknown) {
      whoCard();
      var question = document.getElementById('castor-who-question');
      if (question) question.textContent = 'Who wrote this unsaved text?';
    }
    saveNow(false);
  }

  function releaseWriter() {
    saver.writer = null; saver.writerUnknown = false;
    if (saver.writerHold && Castor.editor && Castor.editor.setReadOnly) Castor.editor.setReadOnly(false);
    saver.writerHold = false;
  }

  function attachSaver(initial, afterPaint) {
    if (Castor.editor && Castor.editor.flush) Castor.editor.flush();
    var path = Castor.piecePath ? Castor.piecePath() : '';
    // Rechecking a version must not release unsaved words or their writer.
    var pending = saver.path === path && saver.typed ? {
      writer: saver.writer && saver.writer.slice(), hold: saver.writerHold, unknown: saver.writerUnknown
    } : null;
    if (!opened && saver.path === path && saver.base && saver.text !== null) {
      opened = { path: path, sha: saver.base, serverText: saver.text, shown: editorSource(), adopted: true,
        restored: editorSource() !== saver.text ? { path: path, text: editorSource(), base: saver.base,
          who: saver.writerUnknown ? [] : saver.writer || whoList() } : null };
    }
    var attachment = ++saveAttachment;
    var checkpoint = Promise.resolve();
    clearTimeout(saver.timer);
    saver.timer = 0; saver.retries = 0; saver.base = ''; saver.text = null;
    saver.again = false; saver.restored = false; saver.typed = false; saver.conflict = null;
    saver.writer = null; saver.writerHold = false; saver.writerUnknown = false;
    closeKeptNotice();
    saver.path = path;
    // Adopt before attachment yields: later typing must follow this snapshot.
    if (opened && opened.path === path && opened.restored) {
      bindKept(opened.restored, !opened.adopted);
      opened.adopted = true;
    }
    if (pending) {
      saver.typed = true; saver.writer = pending.writer;
      saver.writerHold = pending.hold; saver.writerUnknown = pending.unknown;
    }
    saver.evidence = null; saver.needsLive = false;
    clearTimeout(savePoll);
    if (PUBLIC_WRITER && !Castor.role.confirmed) {
      if (Castor.editor && Castor.editor.setReadOnly) Castor.editor.setReadOnly(true);
      if (!signedOut) setSave('locked', 'Checking your sign-in. Everything you type stays on this device; the page reopens by itself once you are confirmed.', 'Checking sign-in');
      return Promise.resolve();
    }
    /* A reviewer never saves text, so there is nothing to ask the server: the
       page is read only from the start and the word says whose comments these are. */
    if (reviewing()) {
      if (Castor.editor && Castor.editor.setReadOnly) Castor.editor.setReadOnly(true);
      setSave('reviewing');
      return Promise.resolve();
    }
    if (!servedOverHttp() || !WRITABLE.test(path) || !global.fetch) { setSave('none'); return Promise.resolve(); }
    function freshPiece() { return fetchPiece(path, { priority: 'low' }); }
    var backgroundRead = afterPaint ? new Promise(function (resolve) {
      // Cached text gets its first frame before revalidation does any work.
      if (global.requestAnimationFrame) global.requestAnimationFrame(function () { setTimeout(resolve, 0); });
      else setTimeout(resolve, 0);
    }).then(freshPiece) : null;
    var read = PUBLIC_WRITER && initial && initial.payload && initial.path === path &&
      initial.writerRole === Castor.role && initial.writerAuthority === writingAuthority() && Castor.role.confirmed
      ? Promise.resolve(initial.payload)
      : backgroundRead || freshPiece();
    return read
      .then(function (p) {
        if (saver.path !== path || attachment !== saveAttachment) return null;
        // Native composition can still live only in the editable DOM. Capture it
        // before comparing snapshots or mounting a newer server document.
        if (Castor.editor && Castor.editor.flush) Castor.editor.flush();
        if (p.offline === true) {
          // A cached baseline can support editing, never confirm current Git.
          var cachedVersions = p.versions || [], cached = cachedVersions[cachedVersions.length - 1];
          var heldAt = opened && opened.path === path ? opened : null;
          opened = null;
          saver.needsLive = true;
          saver.base = heldAt && heldAt.restored && heldAt.restored.base || cached && cached.sha || '';
          saver.text = p.markdown;
          if (heldAt && heldAt.restored && cached && heldAt.restored.base !== cached.sha) {
            whenWhoClosed(function () { offerOfflineKept(heldAt.restored, path); });
          }
          retryLater('offline', 'Showing the prepared copy. The live version has not been checked; your unsent words remain on this device.');
          return { markdown: p.markdown, sha: saver.base, offline: true };
        }
        // Metadata may move without the text moving. Updating it must not
        // remount the editor, reset the caret or claim that cached text is saved.
        applyLive(data, p);
        if (data.piece && data.piece.title) document.title = data.piece.title;
        // Changes already follows save:state below, after this metadata swap.
        saver.evidence = p.save || null;
        if (p.save && Castor.keep) checkpoint = Castor.keep.confirm(path, p.markdown, Castor.role.publicWriter ? Castor.role.who : undefined);
        var ed = Castor.editor;
        if (p.locked) {
          if (ed && ed.setReadOnly) ed.setReadOnly(true);
          setSave('locked', 'This article is being written somewhere else, so it cannot be changed here. You can still read it and comment on it.');
          return null;
        }
        if (ed && ed.setReadOnly) ed.setReadOnly(saver.writerHold);
        var versions = p.versions || [];
        var latest = versions.length ? versions[versions.length - 1] : null;
        var at = (opened && opened.path === path) ? opened : null;
        opened = null;
        var clean = !!(latest && latest.sha && latest.markdown === p.markdown);
        if (at && clean && latest.sha === at.sha) {
          saver.base = latest.sha;
          saver.text = p.markdown;
          if (at.restored) {
            setSave('ready');
            restoreKept(at.restored, true);
            askAtOpen();
            return null;
          }
          setSave('ready');
          askAtOpen();
          drainSoon(0);
          if (editorSource() !== p.markdown) noteChange();
          return { markdown: p.markdown, sha: latest.sha };
        }
        var differs = editorSource() !== p.markdown;
        if (at && clean && differs && editorSource() === at.shown) {
          // A restored journal over the cached base is not new typing. When
          // live history advanced, keep that copy for the ordinary recovery
          // choice rather than adopting it and hiding it as active typing.
          if (at.restored) { releaseWriter(); saver.typed = false; }
          var scrollTop = els.scroll && els.scroll.scrollTop, scrollY = global.scrollY || 0;
          putText(p.markdown);
          if (els.scroll) els.scroll.scrollTop = scrollTop;
          if (global.scrollTo) global.scrollTo(0, scrollY);
        } else if (at && clean && differs && at.sha) {
          /* It moved, and there is typing over the version the page opened with:
             that typing is in the journal; the writer chooses which to keep. */
          saver.base = at.sha;
          saver.text = at.serverText;
          askAtOpen();
          conflictWith({ sha: latest.sha, markdown: p.markdown });
          return null;
        }
        if (at && at.restored && !clean) {
          setSave('dirty', 'The file has changes that are not in its history yet, so the app will not save over them. Your unsaved text is on screen and kept on this device.');
          return null;
        }
        if (editorSource() !== p.markdown) {
          setSave('stale', 'The file was saved after this page was made, so saving here could undo newer text. Click to open the current file.');
          return null;
        }
        if (!latest || !latest.sha || latest.markdown !== p.markdown) {
          setSave('dirty', 'The file has changes that are not in its history yet, so the app will not save over them.');
          return null;
        }
        saver.base = latest.sha;
        saver.text = p.markdown;
        setSave('ready');
        askAtOpen();
        drainSoon(0);
        return { markdown: p.markdown, sha: latest.sha };
      }, function () {
        if (saver.path === path && attachment === saveAttachment) setSave('offline', 'The page could not ask the server which version it is showing. What you type is kept on this device.');
        return null;
      })
      .then(function (server) {
        if (saver.path !== path || attachment !== saveAttachment) return null;
        if (Castor.saveStatus && saver.path === path) {
          refreshSaveEvidence();
          function poll() {
            if (saver.path !== path || attachment !== saveAttachment) return;
            refreshSaveEvidence(); savePoll = setTimeout(poll, 5000);
          }
          savePoll = setTimeout(poll, 5000);
        }
        return Promise.all([checkpoint, server ? recover(path, server.markdown, server.sha, !server.offline) : null]);
      });
  }

  /* --- the journal ----------------------------------------------------------- */

  /* An article this page can save, so what is typed in it is worth keeping. */
  function writableHere() {
    return !!(saver.path && WRITABLE.test(saver.path) && servedOverHttp() && !reviewing() && (!PUBLIC_WRITER || Castor.role.confirmed));
  }
  function keepOn() {
    return !!Castor.keep && (writableHere() || !!(PUBLIC_WRITER && Castor.role.ended && Castor.role.id && Castor.role.who &&
      saver.path && WRITABLE.test(saver.path) && servedOverHttp() && !reviewing()));
  }
  /* Within keep.js's SOON of this call, the editor's text is on this device. */
  function journal() {
    if (!keepOn()) return;
    var path = saver.path;
    var who = saver.writerUnknown ? [] : saver.writer && saver.writer.length ? saver.writer.slice() : whoList();
    Castor.keep.note(path, function () {
      if (saver.path !== path) return null;
      // The sheet's fetched version is known before attachment's second read returns.
      var base = saver.base || (opened && opened.path === path ? opened.sha : '');
      return { text: editorSource(), base: base, who: who };
    });
  }
  bus.on('keep:written', function (info) { if (info && info.path === saver.path) renderSaveState(); });

  /* Replace what the editor shows, the same way a live reload does. */
  function putText(text) {
    source = text;
    render();
    if (Castor.editor && Castor.editor.mount) {
      try { Castor.editor.mount(els.article, doc, editorOptions()); }
      catch (e) { console.error('[castor] editor restore', e); }
    }
  }

  function when(at) {
    var d = new Date(at || 0);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var time = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var today = new Date();
    if (d.toDateString() === today.toDateString()) return time;
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + time;
  }

  /* On opening an article: text this device kept and the server does not
     have comes back. Typed over the version the server still holds, it goes
     straight into the editor and is saved; typed over an older one, the
     newer version is shown and the kept one is offered. Entries another open
     page is still writing are left to that page. */
  function recover(path, serverText, sha, liveConfirmed) {
    if (!Castor.keep || compositionActive()) return Promise.resolve();
    var revision = recoveryRevision, operation = keptOperation;
    function current() { return saver.path === path && saver.base === sha && !compositionActive() && revision === recoveryRevision && operation === keptOperation; }
    return Castor.keep.list(path, { includeEvidence: true }).then(keptForWriter).then(function (entries) {
      if (!current()) return;
      if (Castor.editor && Castor.editor.flush) Castor.editor.flush();
      if (!current()) return;
      var shown = editorSource(), currentAt = entries.reduce(function (at, e) { return e.text === shown ? Math.max(at, e.at || 0) : at; }, 0);
      var waiting = [];
      entries.forEach(function (e) {
        // This page is already writing the current article. Its delayed journal
        // is a backup, never a recovery choice over the newer editor buffer.
        if (e.live || e.confirmed || e.unverified) return;
        if (liveConfirmed !== false && !saver.needsLive && e.text === serverText) { Castor.keep.confirm(path, serverText, Castor.role.publicWriter ? Castor.role.who : undefined); return; }
        if (e.mine && saver.typed) return;
        if (recoveryCandidate(e, path, shown, currentAt)) waiting.push(e);
      });
      var top = waiting[0];
      if (!top) {
        var notice = document.getElementById('castor-kept');
        if (notice && notice.hasAttribute('data-kept-choice') && !notice.hasAttribute('data-kept-list') && !notice.hasAttribute('aria-busy')) closeKeptNotice();
        return;
      }
      if (liveConfirmed === false || saver.needsLive) {
        if (editorSource() !== top.text) return whenWhoClosed(function () { return current() && offerOfflineKept(top, path, currentAt); });
        return;
      }
      if (top.base && top.base === sha && editorSource() === serverText) {
        return openKeptCopy(top, path, serverText, saveAttachment, false, { currentAt: currentAt });
      }
      return whenWhoClosed(function () { return current() && offerKept(top, path, currentAt); });
    }).catch(function (e) { console.error('[castor] journal', e); });
  }

  function closeKeptNotice() {
    keptOperation++;
    var old = document.getElementById('castor-kept');
    if (old) old.remove();
  }
  /* A card in the Who's-writing look that never takes the focus: the writer
     may be mid-sentence when it appears. It stays until a choice is made. */
  function keptNotice(head, text, actions) {
    closeKeptNotice();
    var card = document.createElement('div');
    card.id = 'castor-kept';
    card.className = 'castor-who castor-notice castor-kept';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');
    card.setAttribute('aria-label', head);
    card.appendChild(line('p', 'castor-who-q', head));
    if (text) card.appendChild(line('p', 'castor-notice-text', text));
    var row = line('div', 'castor-who-row');
    actions.forEach(function (a) { row.appendChild(pick(a[0], function () { if (document.getElementById('castor-kept') === card) return a[1](); })); });
    card.appendChild(row);
    document.body.appendChild(card);
    return card;
  }

  function matchingKeptAt(entries, shown) {
    return entries.reduce(function (at, entry) { return entry.text === shown ? Math.max(at, entry.at || 0) : at; }, 0);
  }

  function eligibleKept(entry, entries) {
    var signature = function (e) { return JSON.stringify([e.path, e.text, e.base || '', e.who || [], e.at || 0]); };
    return keptForWriter(entries).some(function (e) { return !e.confirmed && !e.unverified && !e.live && e.key === entry.key && signature(e) === signature(entry); });
  }

  function recoveryCandidate(entry, path, shown, at) {
    if (!entry || entry.unverified || typeof entry.text !== 'string' || shown.indexOf(entry.text) >= 0) return false;
    var receipt = Castor.keep && Castor.keep.receipt ? Castor.keep.receipt(path, shown, { activity: true }) : 0;
    if (lastTypedCopy && lastTypedCopy.path === path && lastTypedCopy.text === shown) at = Math.max(at || 0, lastTypedCopy.at);
    return !(entry.at && entry.at < Math.max(at || 0, receipt || 0));
  }

  function keptDescription(entry, shown) {
    var a = Array.from(shown), b = Array.from(entry.text), first = 0, end = 0;
    while (first < a.length && first < b.length && a[first] === b[first]) first++;
    while (end < a.length - first && end < b.length - first && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    function words(chars) { var text = chars.join('').replace(/\s+/g, ' ').trim(); return Array.from(text).slice(0, 80).join('') + (Array.from(text).length > 80 ? '…' : ''); }
    var now = words(a.slice(first, a.length - end)), kept = words(b.slice(first, b.length - end));
    var difference = kept && now ? 'This copy has “' + kept + '” where the page has “' + now + '”. '
      : kept ? 'This copy adds “' + kept + '”. ' : now ? 'This copy leaves out “' + now + '”. ' : 'This copy has different spacing. ';
    return (entry.at > 1 ? 'Kept ' + when(entry.at) + '. ' : 'Kept from an earlier session. ') + difference + 'Opening it keeps the text on this page as another copy first.';
  }

  function showKeptCopies(path) {
    if (!Castor.keep || saver.path !== path || compositionActive()) return Promise.resolve(false);
    closeKeptNotice();
    var request = keptOperation, attachment = saveAttachment, authority = writingAuthority(), revision = recoveryRevision;
    var shown = editorSource(), offline = !!saver.needsLive;
    function current() { return request === keptOperation && saver.path === path && attachment === saveAttachment && authority === writingAuthority() && revision === recoveryRevision && editorSource() === shown && !compositionActive(); }
    return Castor.keep.list(path, { strict: true, includeKept: true }).then(keptForWriter).then(function (entries) {
      if (!current()) return false;
      var seen = Object.create(null);
      entries = entries.filter(function (entry) {
        if (entry.text === shown) return false;
        var key = JSON.stringify([entry.text, entry.base, entry.who, entry.at]);
        if (seen[key]) return false;
        seen[key] = true; return true;
      });
      var card = keptNotice('Other kept copies', entries.length ? 'Choose a copy to reopen. The text on this page is kept first.' : 'No other kept copies of this article were found on this device.', [
        ['Close', function () { if (document.getElementById('castor-kept') === card) closeKeptNotice(); }]
      ]);
      card.setAttribute('data-kept-choice', '');
      card.setAttribute('data-kept-list', '');
      card.style.maxHeight = '70vh'; card.style.overflowY = 'auto';
      var closing = card.children[card.children.length - 1];
      entries.forEach(function (entry) {
        var row = line('div', 'castor-notice-text');
        var writer = (entry.who || []).map(function (p) { return typeof p === 'string' ? WHO_NAMES[p] || p : personName(p) || p.id || ''; }).filter(Boolean).join(', ');
        row.appendChild(line('p', 'castor-notice-text', (writer ? writer + '. ' : 'Writer not recorded. ') + keptDescription(entry, shown)));
        var open = pick('Open this copy', function () { return openKeptCopy(entry, path, shown, attachment, offline, { explicit: true, notice: card }); });
        open.setAttribute('data-kept-key', entry.key); row.appendChild(open);
        card.insertBefore(row, closing);
      });
      return true;
    }).catch(function () {
      if (current()) keptNotice('The kept copies could not be read.', 'Nothing was replaced. Keep this page open and try again.', [
        ['Close', closeKeptNotice]
      ]);
      return false;
    });
  }

  function openKeptCopy(entry, path, shown, attachment, offline, options) {
    options = options || {};
    if (saver.path !== path || attachment !== saveAttachment || options.notice && document.getElementById('castor-kept') !== options.notice) return Promise.resolve(false);
    if (compositionActive()) return Promise.resolve(false);
    if (Castor.editor && Castor.editor.flush) Castor.editor.flush();
    var authority = writingAuthority(), session = JSON.stringify(whoList()), notice = document.getElementById('castor-kept'), applied = false;
    if (options.notice && options.notice !== notice || notice && notice.hasAttribute('aria-busy')) return Promise.resolve(false);
    var operation = ++keptOperation, revision = recoveryRevision, appliedRevision;
    function context() { return operation === keptOperation && saver.path === path && attachment === saveAttachment && writingAuthority() === authority && JSON.stringify(whoList()) === session && (!notice || document.getElementById('castor-kept') === notice); }
    function unchanged() { return context() && !compositionActive() && recoveryRevision === revision && editorSource() === shown; }
    function stale() { if (notice && document.getElementById('castor-kept') === notice) notice.remove(); return false; }
    if (!unchanged() || !options.explicit && !recoveryCandidate(entry, path, shown, options.currentAt) || !keptForWriter([entry]).length) return Promise.resolve(false);
    if (notice) notice.setAttribute('aria-busy', 'true');
    // A prepared page with no typing time must not become newer than real unsent writing.
    var before = { path: path, text: shown, base: saver.base || '', who: saver.writerUnknown ? [] : saver.writer || whoList(),
      at: Castor.keep.receipt(path, shown, { activity: true }) || (lastTypedCopy && lastTypedCopy.path === path && lastTypedCopy.text === shown ? lastTypedCopy.at : 1) };
    var id = 'before-' + Castor.keep.page + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    // Flushes can reuse the fallback key on an IndexedDB abort. Protect its
    // divergent physical values BEFORE the first preflight flush, not after it.
    return Castor.keep.preserveCurrent(path, true).then(function (ok) {
      if (!ok) throw Error('The current journal variants were not completely kept.');
      if (!unchanged()) return false;
      return Castor.keep.now().then(function () { return Castor.keep.list(path, { strict: true, includeEvidence: true }); });
    }).then(function (entries) {
      if (!Array.isArray(entries)) return false;
      if (!unchanged()) return false;
      var currentAt = options.currentAt || 0;
      entries.forEach(function (e) {
        if (e.text === shown) currentAt = Math.max(currentAt, e.at || 0);
        if (e.text === shown && JSON.stringify(e.who) === JSON.stringify(before.who)) before.at = Math.max(before.at, e.at || 0);
      });
      if (!options.explicit && (!eligibleKept(entry, entries) || !recoveryCandidate(entry, path, shown, currentAt))) return false;
      return Castor.keep.importCopies([before], id).then(function (count) {
        if (count !== 1) throw Error('The previous copy was not completely kept.');
        if (!unchanged()) return false;
        return Castor.keep.importCopies([entry], id + '-chosen').then(function (chosen) {
          if (chosen !== 1) throw Error('The chosen copy was not completely kept.');
          if (!unchanged()) return false;
          // Protect every physical current-key variant, not only the displayed
          // text: a later synchronous journal may reuse its fallback key.
          return Castor.keep.adopt(entry).then(function (ok) {
            if (!ok) throw Error('The current journal variants were not completely kept.');
            return Castor.keep.list(path, { strict: true, includeEvidence: true });
          });
        });
      });
    }).then(function (entries) {
      if (!Array.isArray(entries) || !unchanged()) return stale();
      var currentAt = entries.reduce(function (at, e) { return e.text === shown ? Math.max(at, e.at || 0) : at; }, options.currentAt || 0);
      if (!options.explicit && (!eligibleKept(entry, entries) || !recoveryCandidate(entry, path, shown, currentAt))) return stale();
      if (compositionActive()) return stale();
      if (Castor.editor && Castor.editor.flush) Castor.editor.flush();
      if (!unchanged()) return stale();
      clearTimeout(saver.timer); saver.timer = 0;
      if (notice) Array.prototype.forEach.call(notice.querySelectorAll('button'), function (button) { button.disabled = true; });
      putText(entry.text); bindKept(entry, false); applied = true; appliedRevision = recoveryRevision;
      if (offline) { saver.base = entry.base || saver.base; saver.needsLive = true; }
      journal();
      return Castor.keep.now().then(function (ok) {
        if (!ok) throw new Error('The new journal copy could not be written.');
        if (!context() || compositionActive() || recoveryRevision !== appliedRevision || editorSource() !== entry.text) return stale();
        closeKeptNotice();
        if (offline) retryLater('offline', 'Your unsent copy is open. The previous text is kept as another copy.');
        else restoreKept(entry, true);
        return true;
      });
    }).catch(function () {
      if (saver.path !== path || attachment !== saveAttachment || writingAuthority() !== authority || JSON.stringify(whoList()) !== session || !notice || document.getElementById('castor-kept') !== notice) return false;
      notice.removeAttribute('aria-busy');
      var error = document.getElementById('castor-kept-error');
      if (!error) { error = line('p', 'castor-notice-text'); error.id = 'castor-kept-error'; notice.appendChild(error); }
      error.textContent = applied ? 'Your copy is open. Both earlier copies are kept, but this page could not write a new journal copy. Keep it open and copy your words.'
        : 'Nothing was replaced. This page’s words could not be kept as another copy. Keep this page open and copy your words.';
      if (applied) notice.appendChild(pick('Close', function () { if (document.getElementById('castor-kept') === notice) closeKeptNotice(); }));
      return false;
    });
  }

  function offerKeptChoice(entry, path, currentAt, offline) {
    if (saver.path !== path || compositionActive() || !keptForWriter([entry]).length) return Promise.resolve(false);
    var existing = document.getElementById('castor-kept');
    if (existing && (existing.hasAttribute('aria-busy') || existing.hasAttribute('data-kept-list'))) return Promise.resolve(false);
    var shown = editorSource(), attachment = saveAttachment, revision = recoveryRevision;
    var authority = writingAuthority(), session = JSON.stringify(whoList()), request = keptOperation;
    function context() { return saver.path === path && attachment === saveAttachment && revision === recoveryRevision && authority === writingAuthority() && session === JSON.stringify(whoList()) && editorSource() === shown && !compositionActive(); }
    return Castor.keep.list(path, { strict: true, includeEvidence: true }).then(keptForWriter).then(function (entries) {
      if (request !== keptOperation || !context()) return false;
      currentAt = entries.reduce(function (at, e) { return e.text === shown ? Math.max(at, e.at || 0) : at; }, currentAt || 0);
      if (!eligibleKept(entry, entries) || !recoveryCandidate(entry, path, shown, currentAt)) return false;
      var card;
      function open() {
        if (!context() || document.getElementById('castor-kept') !== card || !offline && !saver.base) return false;
        return openKeptCopy(entry, path, shown, attachment, offline, { notice: card, currentAt: currentAt });
      }
      function discard() {
        if (!context() || document.getElementById('castor-kept') !== card) return false;
        closeKeptNotice(); // Cancels an earlier Put it back on this same card.
        if (Castor.editor && Castor.editor.flush) Castor.editor.flush();
        if (!context()) return false;
        var cancelled = keptOperation;
        return Castor.keep.discard(entry).then(function (ok) {
          if (!ok) throw Error('The copy could not be set aside.');
          if (cancelled === keptOperation && context() && saver.base && saver.text !== null) return recover(path, saver.text, saver.base);
          return false;
        }).catch(function () {
          if (cancelled === keptOperation && context()) keptNotice('The copy could not be set aside.', 'Nothing was removed. Keep this page open and try again.', [['Close', closeKeptNotice]]);
          return false;
        });
      }
      var head = offline ? entry.at > 1 ? 'Your unsent copy from ' + when(entry.at) + ' is on this device.' : 'An earlier unsent copy is on this device.'
        : entry.at > 1 ? 'Your unsaved version from ' + when(entry.at) + ' is kept on this device.' : 'An earlier unsaved copy is kept on this device.';
      card = keptNotice(head, keptDescription(entry, shown), offline ? [['Open my unsent copy', open]] : [['Put it back', open], ['Discard', discard]]);
      card.setAttribute('data-kept-choice', '');
      return true;
    }).catch(function () { return false; });
  }
  function offerOfflineKept(entry, path, currentAt) { return offerKeptChoice(entry, path, currentAt, true); }
  function offerKept(entry, path, currentAt) { return offerKeptChoice(entry, path, currentAt, false); }

  /* --- asking the server ----------------------------------------------------- */

  function noteChange() {
    recoveryRevision++;
    if (keepOn() || writableHere()) {
      lastTypedCopy = { path: saver.path, text: editorSource(), at: Date.now() };
      var notice = document.getElementById('castor-kept');
      if (notice && notice.hasAttribute('data-kept-choice')) closeKeptNotice();
      if (!sessionMemory && hasFounder(sessionNow())) sessionMemory = sessionNow();
      if (!saver.writer || !saver.writer.length) saver.writer = whoList();
      saver.typed = true; journal();
    }
    if (!saver.base) return;
    if (saver.state === 'conflict' || saver.state === 'dirty') return;
    if (['ready', 'saved', 'restored', 'unsaved', 'saving', 'offline', 'refused'].indexOf(saver.state) < 0) return;
    if (saver.state === 'offline') return;              // the retry already scheduled sends the latest text
    if (saver.state !== 'saving') {
      if (editorSource() === saver.text) {
        clearTimeout(saver.timer); saver.timer = 0;
        setSave(saver.restored ? 'restored' : 'saved');
        return;
      }
      saver.restored = false;
      setSave('unsaved');
    }
    clearTimeout(saver.timer);
    saver.timer = setTimeout(function () { saver.timer = 0; saveNow(false); }, SAVE_PAUSE);
  }

  /* One POST, bounded by SAVE_TIMEOUT. Always resolves: {status, body, error}. */
  function post(path, base, text, who, keepalive) {
    if (Castor.bus && Castor.bus.emit) Castor.bus.emit('piece:save-start');
    var ctl = null, timer = 0, sent;
    try { ctl = new global.AbortController(); } catch (e) { ctl = null; }
    if (ctl) timer = setTimeout(function () { ctl.abort(); }, SAVE_TIMEOUT);
    try {
      sent = global.fetch('/api/piece', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: !!keepalive,
        signal: ctl ? ctl.signal : undefined,
        body: JSON.stringify({ path: path, markdown: text, base: base, who: who })
      });
    } catch (e) { sent = Promise.reject(e); }
    var flight = Promise.resolve(sent).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b || {} }; });
    }).then(function (res) { clearTimeout(timer); return res; },
      function (err) { clearTimeout(timer); return { status: 0, body: {}, error: err }; });
    return Castor.saveStatus ? Castor.saveStatus.track(flight) : flight;
  }

  /* The server holds exactly `text`: a save it took, one it already had, or
     one that reached it before a timeout and is now the newer version. */
  function settled(res, text) {
    var b = res.body || {};
    if (res.status === 200 && b.ok && b.sha) return { sha: b.sha };
    if (b.reason === 'no-change') return { sha: b.sha || '' };
    if (b.reason === 'moved-under-you' && typeof b.markdown === 'string' && b.markdown === text && b.sha) return { sha: b.sha };
    return null;
  }
  function retryable(res) {
    var b = res.body || {};
    return !res.status || res.status >= 500 || b.reason === 'busy' || b.reason === 'changed-on-disk' ||
      (res.status >= 200 && res.status < 300);
  }

  function saveNow(keepalive) {
    if (PUBLIC_WRITER && !Castor.role.confirmed) return Promise.resolve();
    clearTimeout(saver.timer);
    saver.timer = 0;
    if (saver.writerUnknown) return Promise.resolve();
    if (saver.needsLive) return attachSaver();
    if (!saver.base) return Promise.resolve();
    if (saver.inflight) { saver.again = true; return saver.inflight; }
    var text = editorSource();
    if (text === saver.text) {
      releaseWriter();
      if (['unsaved', 'offline', 'refused', 'dirty', 'saving'].indexOf(saver.state) >= 0) setSave(saver.restored ? 'restored' : 'saved');
      return Promise.resolve();
    }
    var who = saver.writer && saver.writer.length ? saver.writer : whoList();
    if (!who.length) {
      setSave('unsaved', 'Your text is kept on this device. Say who is writing (the initials beside this word) and it is saved to the server.');
      return Promise.resolve();
    }
    var path = saver.path;
    setSave(saver.restored ? 'restored' : 'saving', saver.restored ? saver.detail : '');
    var flight = post(path, saver.base, text, who, keepalive).then(function (res) {
      saver.inflight = null;
      landed(path, text, res);
    });
    saver.inflight = flight;
    return flight;
  }

  function landed(path, text, res) {
    var done = settled(res, text);
    // An attempt with no answer (or a server error) may have landed: remembered, so a later "moved"
    // to exactly these words is known as his own save, not a change made elsewhere.
    if (!done && (!res.status || res.status >= 500) && saver.path === path) saver.unanswered = (saver.unanswered || []).concat([text]).slice(-8);
    if (done && Castor.bus && Castor.bus.emit) Castor.bus.emit('piece:saved', { path: path, text: text, res: res, done: done });
    if (done && Castor.keep) Castor.keep.confirm(path, text, Castor.role.publicWriter ? Castor.role.who : undefined);
    if (saver.path !== path) {
      drainSoon(done || !retryable(res) ? 0 : RETRY_FIRST);
      resume();
      return;
    }
    var again = saver.again;
    saver.again = false;
    if (done) {
      if (done.sha) saver.base = done.sha;
      saver.text = text;
      saver.retries = 0;
      saver.unanswered = [];
      var b = res.body || {};
      // The save receipt carries real commit metadata. Keep Changes current
      // without reloading the article, which would replace the writer's caret.
      var saved = Array.isArray(b.versions) && b.versions.find(function (v) { return v.sha === done.sha; });
      if (saved) {
        data.versions = b.versions; data.current = saved.id;
        if (data.piece) {
          data.piece.savedMarkdown = saved.markdown;
          data.piece.article_sha256_now = b.article_sha256_now || null;
        }
      }
      saver.evidence = b.save || null;
      refreshSaveEvidence();
      var shared = b.push === 'pending' ? ' It reaches the shared copy once the hub answers.' : '';
      if (editorSource() !== text) {
        journal();                                   // the newer text, typed over the new version
        setSave('unsaved');
        if (again || !saver.timer) saveNow(false);
      } else {
        releaseWriter();
        saver.typed = false;
        setSave(saver.restored ? 'restored' : 'saved',
          saver.restored ? 'Your unsaved text was put back and saved.' + shared : (shared ? 'Saved on the server.' + shared : ''));
      }
      if (Castor.publishState && Castor.publishState.refresh) Castor.publishState.refresh();
      drainSoon(0);
      return;
    }
    var reason = (res.body || {}).reason;
    var kept = ' Your text is kept on this device.';
    switch (reason) {
      case 'locked':
        if (Castor.editor && Castor.editor.setReadOnly) Castor.editor.setReadOnly(true);
        setSave('locked', 'This article is being written somewhere else, so it cannot be changed here.' + kept);
        return;
      case 'moved-under-you':
        // His own attempt that got no answer landed after all: the server holds those words, so it is
        // his version, not one from elsewhere. The newer words go on top of it at once.
        var mine = res.body || {};
        if (mine.sha && typeof mine.markdown === 'string' && (saver.unanswered || []).indexOf(mine.markdown) >= 0) {
          saver.base = mine.sha; saver.text = mine.markdown; saver.unanswered = [];
          saveNow(false);
          return;
        }
        conflictWith(res.body || {});
        return;
      case 'changed-on-disk':
        retryLater('dirty', 'The file has changes made outside the app that are not saved yet, so the app will not save over them.' + kept);
        return;
      case 'founder-marker':
        setSave('refused', 'A line marked for a founder has to stay exactly as it is. Put it back and the next pause saves.' + kept, 'a marked line changed');
        return;
      case 'frontmatter-is-the-founders':
        setSave('refused', 'Owner, phase and status are changed outside the app. Put them back and the next pause saves.' + kept, 'owner or phase changed');
        return;
      case 'gate-failed':
        var refusal = gateRefusal((res.body || {}).stdout);
        if (refusal) {
          setSave('refused', refusalMessage(refusal, editorSource()) + kept, refusal.rule, refusal);
          return;
        }
        setSave('refused', 'The project’s format check refused this version. Keep writing and the next pause tries again.' + kept, 'format check');
        return;
      case 'invalid-who':
        setSave('refused', 'The server did not accept the names of who is writing. Click the initials beside this word to check them.' + kept, 'who is writing');
        return;
      case 'busy':
        retryLater('offline', 'The server is finishing another save.' + kept);
        return;
    }
    if (retryable(res)) {
      var late = res.error && res.error.name === 'AbortError';
      retryLater('offline', (late ? 'The server did not answer within ' + Math.round(SAVE_TIMEOUT / 1000) + ' seconds.'
        : 'The server could not be reached.') + kept);
      return;
    }
    setSave('refused', ((res.body || {}).error || 'The server refused this save.') + kept);
  }

  /* The check's first refusal, from its own line ("FAIL <rule> in <file> (<why>) -> <line>:<words>"):
     the rule, why, the line of the article it names and the words there, and for an em dash the
     character itself, so Show line can select it. Its notes are not refusals. */
  function gateRefusal(stdout) {
    var fail = String(stdout || '').split('\n').filter(function (l) { return /^FAIL /.test(l); })[0];
    if (!fail) return null;
    // The check's whys hold no ")"; what follows the arrow is his line, whatever it holds.
    var m = /^FAIL (.+?) in \S+(?: \(([^)]*)\))? -> (\d+):(.*)$/.exec(fail);
    if (!m) return { rule: fail.replace(/^FAIL /, '').replace(/\.$/, ''), why: '', line: 0, words: '', at: '' };
    // The check cuts the line at 120 characters: a character the cut broke is not his. The em dash
    // it names is on the line even when it lies past the cut.
    return { rule: m[1], why: m[2] || '', line: +m[3], words: m[4].replace(/\uFFFD+$/, '').trim(), at: m[1] === 'em dash' ? '—' : '' };
  }

  /* The refusal in plain words: the rule as advice, the line, and the words around the character
     the check named (an em dash can sit a thousand characters into the line it quotes the start of). */
  function refusalMessage(r, text) {
    var none = /^owner: \S+ writes none; (.+)$/.exec(r.why || '');
    var rule = none ? 'this article takes no ' + r.rule + ' (write a ' + none[1] + ')' : r.rule + (r.why ? ' (' + r.why + ')' : '');
    var words = r.line ? refusalQuote(text, r) : '';
    // Words that end a sentence end it inside the quote: no second full stop after it.
    return 'The project’s check refused this version: ' + rule + (r.line ? ', line ' + r.line + (words ? ': “' + words + '”' : '') : '') +
      (/[.!?…]$/.test(words) ? ' ' : '. ') + 'Change it and the next pause saves.';
  }
  /* About six words on each side of the character the check named, cut at spaces, on the line where Show
     line finds it; without it, the check's own words, their first dozen or so. */
  function refusalQuote(text, r) {
    var at = refusalAt(text, r), words = String(r.words || '').trim(), REACH = 48;
    if (at && at.end > at.start) {
      var lineStart = String(text).lastIndexOf('\n', at.start - 1) + 1, lineEnd = String(text).indexOf('\n', at.end);
      var line = String(text).slice(lineStart, lineEnd < 0 ? undefined : lineEnd), from = at.start - lineStart, to = at.end - lineStart;
      var a = from > REACH ? line.indexOf(' ', from - REACH) + 1 : 0, z = line.length - to > REACH ? line.lastIndexOf(' ', to + REACH) : line.length;
      if (a <= 0 || a > from) a = 0;
      if (z < to) z = line.length;
      words = (a > 0 ? '…' : '') + line.slice(a, z).trim() + (z < line.length ? '…' : '');
    } else if (words.length > 2 * REACH) {
      words = words.slice(0, words.lastIndexOf(' ', 2 * REACH) > 0 ? words.lastIndexOf(' ', 2 * REACH) : 2 * REACH) + '…';
    }
    return words;
  }

  /* Where Show line goes, in the article's text: the line that starts with the words the check
     quoted (all of them it gave), nearest the line it named, wherever typing since has moved it;
     on that line its em dash, when the rule names one. When no line holds those words any more:
     the start of the line named, nothing selected. Null when there is no such line. */
  function refusalAt(text, r) {
    if (!r || !r.line) return null;
    var lines = String(text).split('\n'), words = String(r.words || '').trim(), named = r.line - 1, found = -1;
    if (words) for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim().indexOf(words) === 0 && (found < 0 || Math.abs(i - named) < Math.abs(found - named))) found = i;
    }
    var n = found >= 0 ? found : named;
    if (n < 0 || n >= lines.length) return null;
    var at = 0;
    for (var k = 0; k < n; k++) at += lines[k].length + 1;
    var hit = found >= 0 && r.at ? lines[n].indexOf(r.at) : -1;
    return hit >= 0 ? { start: at + hit, end: at + hit + r.at.length } : { start: at, end: at };
  }

  /* Show line: the caret there in typing mode, the line brought into view as a tap brings it. */
  function showRefusal() {
    var at = refusalAt(editorSource(), saver.refusal);
    return !!at && Castor.editor.revealSource(at.start, at.end);
  }

  /* Never gives up: the wait doubles from RETRY_FIRST to RETRY_MAX and stays there. */
  function retryLater(state, detail) {
    saver.retries += 1;
    var wait = Math.min(RETRY_MAX, RETRY_FIRST * Math.pow(2, saver.retries - 1));
    setSave(state, detail + ' Trying again in ' + Math.max(1, Math.round(wait / 1000)) + ' s.');
    clearTimeout(saver.timer);
    saver.timer = setTimeout(function () { saver.timer = 0; saveNow(false); }, wait);
  }

  function retryNow(evenRefused) {
    drainSoon(0);
    if (!saver.base) {
      if (writableHere() && saver.state === 'offline') return attachSaver();
      return;
    }
    if (saver.inflight) return;
    var states = evenRefused ? ['unsaved', 'offline', 'dirty', 'refused'] : ['unsaved', 'offline', 'dirty'];
    if (states.indexOf(saver.state) < 0 || !saver.needsLive && editorSource() === saver.text) return;
    saveNow(false);
  }

  /* After any request lands: the open article's own save, if it is due. */
  function resume() {
    if (saver.inflight || saver.timer || !saver.base) return;
    if (['unsaved', 'offline'].indexOf(saver.state) < 0 || editorSource() === saver.text) return;
    saveNow(false);
  }

  function conflictWith(body) {
    saver.conflict = { sha: body.sha || '', markdown: typeof body.markdown === 'string' ? body.markdown : null };
    if (Castor.keep && keepOn()) Castor.keep.now();
    setSave('conflict', 'This article was saved elsewhere after you opened it. Nothing was overwritten, and your version is kept on this device.');
    showConflict();
  }
  function showConflict() {
    var c = saver.conflict, path = saver.path;
    if (!c) return;
    if (!c.sha || c.markdown === null) {
      keptNotice('Not saved: this article changed elsewhere', 'Your version is kept on this device. Open the article again to see both.', [
        ['Open it again', function () { closeKeptNotice(); reloadLive(); }]
      ]);
      return;
    }
    keptNotice('Not saved: this article changed elsewhere',
      'Your version is kept on this device. Keep mine saves it on top of the newer one, which stays in the history. Discard mine shows the newer one.', [
        ['Keep mine', function () {
          closeKeptNotice();
          if (saver.path !== path || saver.conflict !== c) return;
          saver.conflict = null;
          saver.base = c.sha;
          saver.text = c.markdown;
          setSave('unsaved');
          journal();
          saveNow(false);
        }],
        ['Discard mine', function () {
          closeKeptNotice();
          if (saver.path !== path || saver.conflict !== c) return;
          var drop = Castor.keep ? Castor.keep.list(path).then(function (entries) {
            return Promise.all(entries.filter(function (e) { return e.mine; }).map(Castor.keep.discard));
          }) : Promise.resolve();
          drop.then(function () {
            if (saver.path !== path || saver.conflict !== c) return;
            saver.conflict = null;
            releaseWriter();
            putText(c.markdown);
            saver.base = c.sha;
            saver.text = c.markdown;
            saver.typed = false;
            setSave('saved');
          });
        }]
      ]);
  }

  var drainTimer = 0, drainTries = 0, parked = {};
  function drainSoon(wait) {
    if (!Castor.keep || reviewing() || !servedOverHttp()) return;
    clearTimeout(drainTimer);
    drainTimer = setTimeout(drain, wait || 0);
  }
  function drain() {
    drainTimer = 0;
    if (saver.inflight) return;                       // landed() calls drainSoon again
    var who = whoList();
    if (!who.length) return;
    Castor.keep.mine().then(keptForWriter).then(function (entries) {
      var next = entries.filter(function (e) {
        return e.path !== saver.path && e.base && e.who && e.who.length && WRITABLE.test(e.path) && !parked[e.key + '@' + e.at];
      })[0];
      if (!next || saver.inflight) return;
      saver.inflight = post(next.path, next.base, next.text, next.who, false).then(function (res) {
        saver.inflight = null;
        if (next.path === saver.path) { landed(next.path, next.text, res); return; }
        if (settled(res, next.text)) {
          savedPieceCache(next.path, next.text, res, settled(res, next.text));
          drainTries = 0;
          Castor.keep.confirm(next.path, next.text, Castor.role.publicWriter ? Castor.role.who : undefined).then(function () { drainSoon(0); });
        } else if (retryable(res)) {
          drainTries += 1;
          drainSoon(Math.min(RETRY_MAX, RETRY_FIRST * Math.pow(2, drainTries - 1)));
        } else {
          parked[next.key + '@' + next.at] = true;
          drainSoon(0);
        }
        renderSaveState();
        resume();
      });
    }).catch(function (e) { console.error('[castor] drain', e); });
  }

  function flushSave(keepalive) {
    if (Castor.editor && Castor.editor.flush) Castor.editor.flush();
    if (keepOn()) { if (keepalive) Castor.keep.nowSync(); else Castor.keep.now(); }
    if (!saver.base || saver.state === 'conflict' || saver.state === 'locked') return saver.inflight || Promise.resolve();
    if (saver.inflight) {
      if (editorSource() !== saver.text) saver.again = true;
      return saver.inflight;
    }
    if (editorSource() === saver.text) return Promise.resolve();
    return saveNow(keepalive);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushSave(true);
    else retryNow(false);
  });
  global.addEventListener('pagehide', function () { flushSave(true); });
  global.addEventListener('online', function () {
    if (!saver.base && writableHere()) attachSaver();
    else retryNow(false);
  });
  global.addEventListener('beforeunload', function (e) {
    if (Castor.editor && Castor.editor.flush) Castor.editor.flush();
    if (!saver.typed || editorSource() === saver.text) return undefined;
    var kept = keepOn() ? Castor.keep.nowSync() : false;
    if (kept) return undefined;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });
  document.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== 's') return;
    if (saver.state === 'none') return;
    e.preventDefault();
    if (saver.state === 'refused') { retryNow(true); return; }
    flushSave(false);
  }, true);

  /* The open article's words for flush(): 'none' when nothing here is written to, 'saved' when
     the server has them, 'journalled' when this device keeps them until they can be sent, and
     'at-risk' when neither does. The save it starts carries on after the answer. */
  function flushWords() {
    if (Castor.editor && Castor.editor.flush) Castor.editor.flush();
    if (!Castor.editor || (!saver.typed && saver.text === null) || !writableHere()) return Promise.resolve('none');
    var path = saver.path, text = editorSource();
    if (text === saver.text) return Promise.resolve('saved');
    function answer() {
      if (saver.path === path && saver.text === text) return 'saved';
      return Castor.keep && Castor.keep.receipt && Castor.keep.receipt(path, text) ? 'journalled' : null;
    }
    journal();
    var kept = Promise.resolve().then(function () { return keepOn() ? Castor.keep.now() : false; }).catch(function () { return false; });
    var sent = Promise.resolve().then(function () { return flushSave(false); }).catch(function () { return null; });
    return kept.then(function () { return answer() || sent.then(function () { return answer() || 'at-risk'; }); });
  }

  /* Everything written so far, either confirmed by the server or kept on this device, for a
     host that may stop the page without warning (the app, leaving the screen). Resolves
     { words, comments }, each 'none', 'saved', 'journalled' or 'at-risk'. Never rejects. */
  Castor.flush = function () {
    function settle(run) {
      return Promise.resolve().then(run).then(function (v) { return v || 'none'; }, function () { return 'at-risk'; });
    }
    return Promise.all([
      settle(flushWords),
      settle(function () { return Castor.comments && Castor.comments.flush ? Castor.comments.flush() : 'none'; })
    ]).then(function (r) { return { words: r[0], comments: r[1] }; });
  };

  Castor.saver = {
    state: function () { return saver.state; },
    refusal: function () { var r = saver.refusal; return r ? { rule: r.rule, line: r.line, words: r.words, at: r.at } : null; },
    flush: function () { return flushSave(false); },
    snapshot: function () { return { path: saver.path, base: saver.base, clean: !saver.inflight && editorSource() === saver.text }; },
    reattach: attachSaver
  };

  Castor.pieces = {
    open: openPiece,
    list: function () { return pieces.slice(); },
    /* No article is open on the empty page, though the editor still holds the last
       one (piecePath keeps naming it, so its saves and comments stay bound to it). */
    current: function () { return emptied ? '' : openArticle(); }
  };

  function reloadLive() {
    if (!liveState || !liveState.path) return Promise.resolve(false);
    var before = (doc && doc.blocks) ? doc.blocks.slice() : [];
    var path = liveState.path;
    var request = ++pieceRequest;
    var cached = displayedPath !== path && cachedPiece(path);
    return Promise.all([cached ? Promise.resolve(cached) : fetchPiece(path), keptFor(path)]).then(async function (got) {
      if (request !== pieceRequest || liveState.path !== path) return { superseded: true };
      if (Castor.editor && Castor.editor.flush) Castor.editor.flush();
      // A reload is a snapshot, not authority to replace typing made while it waited.
      if (saver.path === path && saver.typed && editorSource() !== saver.text) return { superseded: true };
      // The fetch can outlive the initial checkpoint. Keep the final outgoing bytes
      // while both the editor and the saver still belong to that article.
      if (saver.path !== path && editorSource() !== saver.text) {
        if (!await canLeaveArticle()) {
          if (request === pieceRequest) liveState.path = displayedPath;
          return { superseded: true };
        }
        if (request !== pieceRequest || liveState.path !== path) return { superseded: true };
      }
      var payload = got[0], revision = recoveryRevision, authority = writingAuthority(), outgoing = editorSource();
      var prepared = await prepareOpening(path, payload, got[1]);
      if (!prepared.ready) {
        if (request === pieceRequest && liveState.path === path) {
          liveState.path = displayedPath;
          keptNotice('The article’s kept copies could not be safely opened.', 'Nothing was replaced. Keep this page open and try again.', [['Close', closeKeptNotice]]);
        }
        return { blocked: true };
      }
      if (request !== pieceRequest || liveState.path !== path || revision !== recoveryRevision || authority !== writingAuthority() || editorSource() !== outgoing || compositionActive()) {
        if (request === pieceRequest && liveState.path === path && displayedPath !== path) liveState.path = displayedPath;
        return { superseded: true };
      }
      applyLive(data, payload);
      displayedPath = path;
      source = sourceOf(data);
      opening(path, payload, prepared.entries || [], prepared.entry);
      render(false);
      if (data.piece && data.piece.title) document.title = data.piece.title;
      if (Castor.editor && Castor.editor.mount) {
        try { var options = editorOptions(); options.notifyMount = false; Castor.editor.mount(els.article, doc, options); }
        catch (e) { console.error('[castor] editor reload', e); }
      }
      /* The column preferences stay on the same page element. History work
         follows the first paint, while the new text is already editable. */
      if (!reviewing() && Castor.changes && Castor.changes.refresh) {
        var refreshHistory = function (deadline) {
          if (deadline && !deadline.didTimeout && deadline.timeRemaining() < 10) {
            global.requestIdleCallback(refreshHistory, { timeout: 200 }); return;
          }
          if (request !== pieceRequest || liveState.path !== path) return;
          try { Castor.changes.refresh(); } catch (e2) { console.error('[castor] changes reload', e2); }
        };
        // An idle callback requested while mounting can still run in that same
        // display interval. Yield past the sheet's first paint before diffing.
        var queueHistory = function () {
          if (global.requestIdleCallback) global.requestIdleCallback(refreshHistory, { timeout: 200 });
          else setTimeout(refreshHistory, 0);
        };
        if (global.requestAnimationFrame) global.requestAnimationFrame(function () { setTimeout(queueHistory, 0); });
        else setTimeout(queueHistory, 32);
      }
      bus.emit('live:reload', { path: liveState.path, before: before, doc: doc, cached: !!cached });
      var notify = function () {
        if (request !== pieceRequest || liveState.path !== path) return;
        bus.emit('doc:change', { doc: doc, source: editorSource() });
      };
      if (global.requestAnimationFrame) global.requestAnimationFrame(function () { setTimeout(notify, 0); });
      else setTimeout(notify, 16);
      return { before: before, doc: doc };
    });
  }

  function sourceOf(data) {
    var vs = data.versions || [];
    var v = null, i;
    for (i = 0; i < vs.length; i++) if (vs[i].id === data.current) v = vs[i];
    if (!v) v = vs[vs.length - 1];
    return (v && (v.markdown || v.source)) || PLACEHOLDER;
  }

  /* --- a minimal renderer, used only until md.js is loaded ------------------ */

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function fallbackParse(src) {
    var body = src.replace(/^---\n[\s\S]*?\n---\n/, '');
    var blocks = body.split(/\n{2,}/).filter(function (c) { return c.trim(); })
      .map(function (chunk, i) {
        var t = chunk.trim();
        var h = /^(#{1,6})\s+(.*)$/.exec(t);
        if (h) {
          var lvl = h[1].length;
          return {
            id: 'b' + i, type: 'h' + lvl, source: t, text: h[2],
            html: '<h' + lvl + '>' + escapeHtml(h[2]) + '</h' + lvl + '>', meta: { level: lvl }
          };
        }
        return {
          id: 'b' + i, type: 'p', source: t, text: t,
          html: '<p>' + escapeHtml(t).replace(/\n/g, ' ') + '</p>', meta: {}
        };
      });
    return {
      blocks: blocks, footnotes: {}, frontmatter: {},
      headings: blocks.filter(function (b) { return b.type[0] === 'h'; })
        .map(function (b) { return { level: b.meta.level, text: b.text, id: '', blockId: b.id }; })
    };
  }

  /* --- state --------------------------------------------------------------- */

  var data, world, doc, source;
  var els = {};
  var themeMode = 'system';
  var sizeMode = 'computer';
  /* %%writer notes%% are the writer's, not the reader's. Shown by default because
     this app is the writing surface; the palette turns them off to read as a reader. */
  var writerNotes = true;

  function key(name) { return 'castor.' + world + '.' + name; }
  function store(name, value) { try { localStorage.setItem(key(name), value); } catch (e) {} }
  function recall(name) { try { return localStorage.getItem(key(name)); } catch (e) { return null; } }

  /* --- the page ------------------------------------------------------------ */

  function render(notify) {
    doc = (Castor.md && Castor.md.parse) ? Castor.md.parse(source) : fallbackParse(source);
    /* A block that renders as nothing (frontmatter, a paragraph that is only a
       %%writer note%% while notes are hidden) contributes nothing, not an empty
       <p>. Only used while editor.js is absent; the editor owns its own render. */
    if (!(Castor.editor && Castor.editor.mount)) els.article.innerHTML = doc.blocks.map(function (b) {
      if (b.html) return b.html;
      if (b.html === '') return '';
      if (Castor.md && Castor.md.blockToHtml) return Castor.md.blockToHtml(b);
      return '<p>' + escapeHtml(b.text || '') + '</p>';
    }).filter(Boolean).join('\n');
    Castor.app.doc = doc;
    if (notify !== false) bus.emit('doc:change', { doc: doc, source: source });
  }

  /* --- theme and size ------------------------------------------------------ */

  /* Light, dark, or follow the system: the logbook's and the website's control.
     The stored choice wins; with none, the page follows the system, and keeps
     following it while the choice is "system". The toggle in the bar is a drawing
     with no words (signature.css): its FACE says the choice (data-theme-choice),
     its COLOUR what is painted (data-resolved). theme-early.js paints the same
     four attributes before the first frame; this repaints them on boot and owns
     them from then on. Changing theme cross-fades the page. */
  var THEME_ORDER = ['light', 'dark', 'system'];
  var THEME_WORD = { light: 'Light', dark: 'Dark', system: 'Follow the system' };
  var themeBooted = false;

  function systemDark() {
    try { return !!(global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches); }
    catch (e) { return false; }
  }
  function reducedMotion() {
    try { return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }

  function paintTheme(mode) {
    var root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    var dark = mode === 'system' ? systemDark() : mode === 'dark';
    root.setAttribute('data-theme-choice', mode);
    root.setAttribute('data-resolved', dark ? 'dark' : 'light');
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', dark ? '#141311' : '#FAF9F4');
    var next = THEME_ORDER[(THEME_ORDER.indexOf(mode) + 1) % THEME_ORDER.length];
    var toggles = document.querySelectorAll('[data-theme-toggle]');
    for (var j = 0; j < toggles.length; j++) {
      toggles[j].dataset.state = mode;
      toggles[j].setAttribute('aria-label', THEME_WORD[mode] + '. Switch to ' + THEME_WORD[next].toLowerCase() + '.');
    }
    var radios = document.querySelectorAll('input[name="set-theme"]');
    for (var k = 0; k < radios.length; k++) radios[k].checked = radios[k].value === mode;
  }

  function setTheme(mode) {
    themeMode = THEME_ORDER.indexOf(mode) >= 0 ? mode : 'system';
    var root = document.documentElement;
    var willBeDark = themeMode === 'system' ? systemDark() : themeMode === 'dark';
    var fade = themeBooted && root.getAttribute('data-resolved') !== (willBeDark ? 'dark' : 'light') && !reducedMotion();
    var mode = themeMode;
    if (fade && document.startViewTransition) {
      root.classList.add('theming-vt');
      var done = function () { root.classList.remove('theming-vt'); };
      try { document.startViewTransition(function () { paintTheme(mode); }).finished.then(done, done); }
      catch (e) { done(); paintTheme(mode); }
    } else {
      if (fade) {
        root.classList.add('theming');
        setTimeout(function () { root.classList.remove('theming'); }, 400);
      }
      paintTheme(mode);
    }
    store('theme', themeMode);
    bus.emit('theme', themeMode);
  }

  function nextTheme() {
    setTheme(THEME_ORDER[(THEME_ORDER.indexOf(themeMode) + 1) % THEME_ORDER.length]);
  }

  /* While following the system, a change of the system's theme repaints the page. */
  try {
    var darkQuery = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)');
    var onSystem = function () { if (themeBooted && themeMode === 'system') setTheme('system'); };
    if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', onSystem);
    else if (darkQuery && darkQuery.addListener) darkQuery.addListener(onSystem);
  } catch (e) { /* no media queries: the choice alone decides */ }

  function setSize(size) {
    sizeMode = ['computer', 'ipad', 'phone'].indexOf(size) >= 0 ? size : 'computer';
    if (els.frame) els.frame.dataset.size = sizeMode;
    if (els.sizeSwitch) {
      els.sizeSwitch.querySelectorAll('[data-size]').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.size === sizeMode));
      });
    }
    store('size', sizeMode);
    bus.emit('size', sizeMode);
  }

  /* --- optional modules ---------------------------------------------------- */

  function ctx(extra) {
    var c = {
      app: els.app, page: els.page, article: els.article, pageEl: els.article,
      scroll: els.scroll, topbar: els.topbar, frame: els.frame,
      doc: doc, data: data, world: world, bus: bus, panels: Castor.panels
    };
    for (var k in (extra || {})) c[k] = extra[k];
    return c;
  }

  /* One place the editor's options are written, because a live reload remounts the
     editor over the new source and the two mounts must agree. */
  function editorOptions() {
    var o = {
      onChange: function (src) { source = src; noteChange(); },
      /* editor.js already emits 'select' on the bus; re-emitting it here
         fired every listener twice. */
      onSelect: null,
      spellcheck: recall('spellcheck') !== '0',
      showWriterNotes: writerNotes,
      showMarks: marksOn(),
      onComment: function (anchor) {
        if (Castor.comments && Castor.comments.compose) Castor.comments.compose(anchor);
        else bus.emit('comment:new', anchor);
      },
      onLink: null              /* editor.js's own default: wrap in [[ ]] and open the picker */
    };
    if (reviewing()) o.readOnly = true;
    return o;
  }

  function mountModules() {
    /* editor and agent take an element first; everyone else takes the context */
    if (Castor.editor && Castor.editor.mount) {
      try { Castor.editor.mount(els.article, doc, editorOptions()); }
      catch (e) { console.error('[castor] editor', e); }
    }
    var reader = reviewing();
    if (Castor.comments && Castor.comments.mount) {
      /* comments live in two places at once: the thread under the paragraph
         (mounted now) and the card in the panel (its own registration) */
      try { Castor.comments.mount(ctx(), data.comments || []); }
      catch (e) { console.error('[castor] comments', e); }
    }
    /* A personal installation has no Publish until its writer's own agent wires one
       (PUBLISHING.md in the writing folder); Castor's Publish knows only Castor's sites. */
    var install = Castor.app && Castor.app.data && Castor.app.data.install;
    var personal = !!(install && install.kind === 'personal');
    if (personal && typeof registerPublishSetup === 'function') registerPublishSetup();
    ['subtitle', 'language', 'files', 'drafts', 'footnotes', 'outline', 'mentions', 'links', 'changes', 'commands', 'fonts', 'island', 'readerShell', 'walkthrough', 'publication', 'publishState', 'checking', 'offline', 'touchLayout'].forEach(function (name) {
      var mod = Castor[name];
      if (!mod || typeof mod.mount !== 'function') return;
      if (personal && ['publication', 'publishState', 'offline'].indexOf(name) >= 0) return;
      if (reader && ['files', 'drafts', 'changes', 'island', 'publication', 'publishState', 'checking', 'offline', 'touchLayout'].indexOf(name) >= 0) return;
      try { mod.mount(ctx()); } catch (e) { console.error('[castor] ' + name, e); }
    });
    if (reader) {
      /* the design-review island writes design notes; a reviewer has none to write */
    } else if (Castor.review && typeof Castor.review.install === 'function') {
      try { Castor.review.install(ctx()); } catch (e) { console.error('[castor] review', e); }
    }
    /* canvas.js registers and mounts itself into the Workspace panel body */
  }

  /* --- the phone bar ------------------------------------------------------- */
  /* Under 700px the bar keeps the name, the two words a reader reaches for
     (Outline, Comments), one more, **More**, and the lens and the toggle. More
     opens a small sheet holding everything else: Files, Changes, Workspace,
     Focus, Type, and the footer line's Settings. Review and device sizes live in
     the review island.

     The controls are MOVED, not duplicated: the same buttons, with the listeners
     already on them, travel into the sheet and back out again. A second copy
     would need its own wiring and its own aria-pressed, and the two would drift. */

  var PHONE_SHEET_WORDS = ['files', 'drafts', 'workspace', 'links', 'for-you'];
  var BAR_ORDER = ['files', 'outline', 'comments', 'drafts', 'workspace', 'links', 'for-you', 'changes'];
  var moreEls = null, phoneChrome = false;
  var headerWidth = 0;

  /* Measure the real row, including the chosen mark and loaded fonts. The same
     controls move into More when they no longer fit, at any device width. */
  function orderMorePanels() {
    if (!moreEls) return;
    BAR_ORDER.forEach(function (id) {
      var word = moreEls.sheet.querySelector('[data-panel="' + id + '"]');
      if (word) moreEls.sheet.insertBefore(word, moreEls.type);
    });
  }
  function fitHeader() {
    var bar = els.topbar;
    if (!bar || !bar.clientWidth || bar.clientWidth === headerWidth) return;
    headerWidth = bar.clientWidth;
    // The capsule has its own room: its secondary words always live in More.
    // Other worlds still fit their inline header below.
    if (Castor.capsule) { applyPhoneChrome(true); return; }
    // Return the same tools before measuring another layout, including desktop.
    if (moreEls && moreEls.tools && moreEls.tools.parentNode === moreEls.sheet) bar.appendChild(moreEls.tools);
    bar.removeAttribute('data-folded-tools');
    bar.removeAttribute('data-tight');
    applyPhoneChrome(false);
    bar.removeAttribute('data-compact');
    if (headerWidth > 700 && bar.scrollWidth <= headerWidth) return;
    bar.setAttribute('data-compact', '1');
    applyPhoneChrome(true);
    if (headerWidth <= 700 && els.app && els.app.getAttribute('data-tabs') === 'folded') {
      bar.setAttribute('data-folded-tools', '');
      moreEls.tools = bar.querySelector('.bar-tools');
      if (moreEls.tools) moreEls.sheet.appendChild(moreEls.tools);
      ['outline', 'comments'].forEach(function (id) {
        var word = bar.querySelector('[data-panel="' + id + '"]');
        if (word) moreEls.sheet.appendChild(word);
      });
      orderMorePanels();
      return;
    }
    if (bar.scrollWidth <= headerWidth) return;
    ['outline', 'comments'].forEach(function (id) {
      var word = bar.querySelector('[data-panel="' + id + '"]');
      if (word) moreEls.sheet.appendChild(word);
    });
    orderMorePanels();
    // Shrink the caption only after every navigation word is reachable in More.
    if (bar.scrollWidth > headerWidth) bar.setAttribute('data-tight', '1');
  }

  function refitHeader() {
    headerWidth = 0;
    fitHeader();
  }

  function buildMore() {
    if (moreEls) return moreEls;
    var word = document.createElement('button');
    word.type = 'button';
    word.className = 'word';
    word.id = 'more-word';
    word.innerHTML = '<span class="more-label word-label">More</span><svg class="more-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg><span class="more-count" aria-hidden="true" hidden></span>';
    word.setAttribute('aria-label', 'More');
    word.setAttribute('aria-expanded', 'false');
    word.setAttribute('aria-controls', 'more-sheet');

    var sheet = document.createElement('div');
    sheet.id = 'more-sheet';
    sheet.hidden = true;
    sheet.setAttribute('role', 'group');
    sheet.setAttribute('aria-label', 'More');

    /* Type has no word of its own in any shell: it is a section of the palette.
       On a phone the palette needs a keyboard, so the sheet carries the word. */
    var type = document.createElement('button');
    type.type = 'button';
    type.className = 'word';
    type.id = 'type-word';
    type.textContent = 'Type';
    type.addEventListener('click', function () {
      closeMore();
      /* fonts.js registers a `type` panel; if it is not loaded, the palette's own
         Type section is the same list */
      if (Castor.panels && Castor.panels.toggle && Castor.panels.isOpen) {
        try { Castor.panels.toggle('type'); return; } catch (e) { /* palette below */ }
      }
      if (Castor.commands && Castor.commands.open) { try { Castor.commands.open('Type'); } catch (e2) {} }
    });

    word.addEventListener('click', function () { setMore(!moreIsOpen()); });
    word.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault(); setMore(true);
      var items = moreItems();
      if (items.length) items[e.key === 'ArrowUp' ? items.length - 1 : 0].focus();
    });
    sheet.addEventListener('keydown', function (e) {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(e.key) < 0) return;
      var items = moreItems(), i = items.indexOf(e.target);
      if (!items.length) return;
      e.preventDefault();
      if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = items.length - 1;
      else i = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[i].focus();
    });
    // Tab uses native button order; leaving the disclosure closes it.
    sheet.addEventListener('focusout', function (e) {
      if (e.relatedTarget && !sheet.contains(e.relatedTarget) && e.relatedTarget !== word) closeMore();
    });
    /* A sheet is a menu: choosing something in it puts it away. */
    sheet.addEventListener('click', function (e) {
      var hit = e.target.closest && e.target.closest('.word');
      var tool = e.target.closest && e.target.closest('.bar-tools button');
      if (hit || tool) {
        var moveFocus = Castor.capsule && hit && hit.dataset.panel && sheet.contains(document.activeElement);
        closeMore();
        if (moveFocus) {
          var head = document.querySelector('.panel[data-panel-id="' + hit.dataset.panel + '"] .panel-head');
          (head || word).focus();
        }
        if (tool && !tool.hasAttribute('popovertarget') && Castor.popovers) Castor.popovers.returnFocus(tool, true);
      }
    });
    document.addEventListener('click', function (e) {
      if (!moreIsOpen()) return;
      if (sheet.contains(e.target) || word.contains(e.target)) return;
      closeMore();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && moreIsOpen()) { e.preventDefault(); e.stopPropagation(); closeMore(); word.focus(); }
    }, true);
    if (Castor.capsule && global.MutationObserver && els.app) {
      new global.MutationObserver(closeMore).observe(els.app, { attributes: true, attributeFilter: ['data-preset'] });
    }

    moreEls = { word: word, sheet: sheet, type: type, rule: null };
    return moreEls;
  }

  /* The open state is READ OFF THE SHEET, never held beside it, so nothing else
     touching the element can leave a second copy of "is it open" wrong. */
  function moreIsOpen() { return !!(moreEls && !moreEls.sheet.hidden); }
  function moreItems() {
    if (!moreEls) return [];
    return Array.prototype.slice.call(moreEls.sheet.querySelectorAll('button'))
      .concat(Array.prototype.slice.call(moreEls.sheet.querySelectorAll('a[href]'))).filter(function (n) {
      return !n.hidden && !n.disabled && global.getComputedStyle(n).display !== 'none' && (!n.getClientRects || n.getClientRects().length > 0);
    });
  }
  function setMore(on) {
    if (!moreEls) return;
    // On a phone, Menu replaces the current tool sheet. Its header lives in
    // a lower stacking context than the docks, so raising the child cannot help.
    if (on && Castor.capsule && els.app && els.app.dataset.mode === 'phone' && Castor.panels) {
      Castor.panels.ids.forEach(function (id) { Castor.panels.close(id); });
    }
    // Unhide before measuring the real preset-filtered rows.
    moreEls.sheet.hidden = !on;
    var items = on && Castor.capsule ? moreItems() : [];
    if (Castor.capsule) on = !!(on && items.length);
    moreEls.sheet.hidden = !on;
    moreEls.word.setAttribute('aria-expanded', String(!!on));
    moreEls.word.setAttribute('aria-pressed', String(!!on));
    if (on && items.length) items[0].focus();
  }
  function closeMore() { setMore(false); }

  function applyPhoneChrome(on) {
    if (Castor.capsule) {
      var menu = buildMore();
      if (Castor.capsule.layoutMenu) { Castor.capsule.layoutMenu(menu); return; }
      var nav = els.topbar && els.topbar.querySelector('.topwords');
      if (!nav) return;
      if (menu.word.parentNode !== nav) nav.appendChild(menu.word);
      if (menu.sheet.parentNode !== els.topbar) els.topbar.appendChild(menu.sheet);
      PHONE_SHEET_WORDS.forEach(function (id) {
        var button = nav.querySelector('[data-panel="' + id + '"]');
        if (button) menu.sheet.appendChild(button);
      });
      return;
    }
    if (on === phoneChrome) return;
    phoneChrome = on;
    var m = buildMore();
    var words = els.topbar && els.topbar.querySelector('.topwords');
    if (!words) return;
    var settingsWord = document.getElementById('castor-settings-word');

    if (on) {
      words.appendChild(m.word);
      els.topbar.appendChild(m.sheet);
      PHONE_SHEET_WORDS.forEach(function (id) {
        var w = words.querySelector('[data-panel="' + id + '"]');
        if (w) m.sheet.appendChild(w);
      });
      m.sheet.appendChild(m.type);
      if (settingsWord) {
        if (!m.rule) { m.rule = document.createElement('div'); m.rule.className = 'more-rule'; }
        m.sheet.appendChild(m.rule);
        m.sheet.appendChild(settingsWord);
      }
    } else {
      closeMore();
      /* back in the order the shell wrote them: Files · Outline · Comments ·
         Changes · Workspace, then whatever a module added */
      BAR_ORDER.forEach(function (id, i) {
        var w = els.topbar.querySelector('[data-panel="' + id + '"]');
        if (!w) return;
        var after = null;
        for (var j = i - 1; j >= 0 && !after; j--) after = words.querySelector('[data-panel="' + BAR_ORDER[j] + '"]');
        words.insertBefore(w, after ? after.nextSibling : words.firstChild);
      });
      if (m.type.parentNode) m.type.remove();
      if (m.rule && m.rule.parentNode) m.rule.remove();
      var meta = document.querySelector('#footline .foot-meta');
      if (settingsWord && meta) meta.appendChild(settingsWord);
      if (m.word.parentNode) m.word.remove();
      if (m.sheet.parentNode) m.sheet.remove();
    }
  }

  /* --- the top bar --------------------------------------------------------- */

  function wireTopbar() {
    if (!els.topbar) return;
    document.addEventListener('keydown', function (e) {
      var card = document.getElementById('castor-who');
      if (e.key === 'Escape' && card) {
        e.preventDefault(); e.stopPropagation(); closeWhoCard();
        var opener = document.getElementById('castor-session'); if (opener) opener.focus();
      }
    }, true);

    els.topbar.querySelectorAll('[data-panel]').forEach(function (w) {
      w.addEventListener('click', function () { Castor.panels.toggle(w.dataset.panel); });
    });
    /* Reading tools stay beside the writing until explicitly closed. */
    document.addEventListener('pointerdown', function (e) {
      if (!e.target.closest || e.target.closest('.dock,#topbar,#more-sheet,[popover],.cw-palette,.cw-picker,.walkthrough,.focus-exit,.changes-screen,.changes-menu')) return;
      if (document.getElementById('castor-who') && !document.getElementById('castor-who').hasAttribute('popover')) closeWhoCard();
      if (!Castor.panels.ids || !Castor.panels.close) return;
      Castor.panels.ids.forEach(function (id) {
        if (id !== 'comments' && id !== 'outline' && id !== 'changes' && Castor.panels.isOpen(id)) Castor.panels.close(id);
      });
    });

    function numbered() {
      var strip = document.getElementById('castor-tabs');
      if (strip && strip.querySelectorAll('.castor-tab').length > 1) {
        return Array.prototype.slice.call(strip.querySelectorAll('.castor-tab')).slice(0, 9);
      }
      return Array.prototype.filter.call(
        els.topbar.querySelectorAll('[data-panel]'),
        function (w) { return w.offsetParent !== null; }
      ).slice(0, 9);
    }
    function showNumbers(on) {
      document.documentElement.setAttribute('data-keyhint', on ? 'on' : 'off');
      var stale = document.querySelectorAll('.word-key, .keyhint-chord');
      for (var j = 0; j < stale.length; j++) stale[j].remove();
      if (!on) { els.topbar.setAttribute('data-keyhint', 'off'); return; }
      var c = tabChord();
      var words = numbered();
      for (var i = 0; i < words.length; i++) {
        var k = document.createElement('kbd');
        k.className = 'word-key';
        k.textContent = c.badge + (i + 1);
        k.setAttribute('aria-hidden', 'true');
        words[i].appendChild(k);
        words[i].setAttribute('aria-keyshortcuts', c.aria + (i + 1));
      }
      /* One line, in words. Fixed to the viewport and placed from the numbered
         boxes, so nothing in the bar or the strip moves to make room for it:
         after the last tab, in the strip's empty run, when it fits there
         without touching the install line; under the first number otherwise. */
      if (words.length && c.words) {
        var cap = document.createElement('div');
        cap.className = 'keyhint-chord';
        cap.setAttribute('aria-hidden', 'true');
        cap.textContent = c.words;
        document.body.appendChild(cap);
        var last = words[words.length - 1].getBoundingClientRect();
        var w = cap.offsetWidth, h = cap.offsetHeight;
        var tip = document.getElementById('install-hint');
        var stop = tip ? tip.getBoundingClientRect().left : (global.innerWidth || 0);
        var inStrip = !!(words[0].closest && words[0].closest('#castor-tabs'));
        if (inStrip && last.right + 12 + w + 12 <= stop) {
          cap.style.left = Math.round(last.right + 12) + 'px';
          cap.style.top = Math.round(last.top + (last.height - h) / 2) + 'px';
        } else {
          cap.remove(); /* The numbered badges already name the chord; never cover the masthead. */
        }
      }
      els.topbar.setAttribute('data-keyhint', 'on');
    }
    var numberHintTimer = 0;
    var hintsPinned = false;
    var hintsHeld = false;
    var hide = function (clearPinned) {
      clearTimeout(numberHintTimer); numberHintTimer = 0;
      if (clearPinned) { hintsPinned = false; hintsHeld = false; }
      showNumbers(hintsPinned || hintsHeld);
      var button = document.getElementById('castor-shortcuts');
      if (button) button.setAttribute('aria-pressed', String(hintsPinned));
    };
    toggleShortcutHints = function () { hintsPinned = !hintsPinned; hide(); };
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hide(true); return; }
      if (e.isComposing || (e.getModifierState && e.getModifierState('AltGraph'))) { hintsHeld = false; hide(); return; }
      if (Castor.keys && !Castor.keys.shown()) return;
      var c = tabChord();
      if (c.hold.indexOf(e.key) >= 0) {
        if (!e.repeat) {
          hintsHeld = false; hide();
          numberHintTimer = setTimeout(function () { numberHintTimer = 0; hintsHeld = true; showNumbers(true); }, 1000);
        }
        return;
      }
      hintsHeld = false; hide();
      var n = Castor.keys ? Castor.keys.digitOf(c, e)
        : (e.ctrlKey && !e.metaKey && !e.altKey && /^[1-9]$/.test(e.key) ? Number(e.key) : 0);
      if (!n) return;
      var target = numbered()[n - 1];
      if (!target) return;
      e.preventDefault();
      if (target.dataset.path) openPiece(target.dataset.path);
      else Castor.panels.toggle(target.dataset.panel);
    }, true);
    document.addEventListener('keyup', function (e) {
      if (tabChord().hold.indexOf(e.key) >= 0) { hintsHeld = false; hide(); }
    }, true);
    global.addEventListener('blur', function () { hide(true); });

    if (els.sizeSwitch) {
      els.sizeSwitch.querySelectorAll('[data-size]').forEach(function (b) {
        b.addEventListener('click', function () { setSize(b.dataset.size); });
      });
    }

    if (els.theme) els.theme.addEventListener('click', nextTheme);

    /* the words follow the docks, whoever moved them */
    var wasOpen = [];
    var tabMode = '', tabWidth = 0;
    Castor.panels.onLayout(function (i) {
      fitHeader();
      var width = tabEls.strip ? tabEls.strip.clientWidth : 0;
      if (i.mode !== tabMode || width !== tabWidth) {
        tabMode = i.mode; tabWidth = width;
        revealTab();
      }
      queueKnot(false);
      els.topbar.querySelectorAll('[data-panel]').forEach(function (w) {
        var id = w.dataset.panel;
        var open = i.open.indexOf(id) >= 0;
        w.setAttribute('aria-pressed', String(open));
        /* on iPad the other dock is collapsed to its words: say so quietly */
        if (open && i.mode !== 'desktop' && i.left.ids.indexOf(id) >= 0 !== (i.activeSide === 'left')) {
          w.dataset.collapsed = '1';
        } else { delete w.dataset.collapsed; }
      });
      var focusSwitch = document.getElementById('set-focus');
      if (focusSwitch) focusSwitch.checked = !!i.focus;
      applyDim();
      i.open.forEach(function (id) { if (wasOpen.indexOf(id) < 0) bus.emit('panel:open', id); });
      wasOpen.forEach(function (id) { if (i.open.indexOf(id) < 0) bus.emit('panel:close', id); });
      wasOpen = i.open.slice();
    });
    if (global.ResizeObserver) new global.ResizeObserver(function () { fitHeader(); queueKnot(false); }).observe(els.topbar);
    if (els.app) els.app.addEventListener('transitionend', function (e) {
      if (e.target === els.app || e.target === els.topbar) queueKnot(false);
    });
    bus.on('type:change', refitHeader);
    bus.on('type:change', function () { queueKnot(false); });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { refitHeader(); queueKnot(false); });
      if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', function () { refitHeader(); queueKnot(false); });
    }
  }

  /* --- the footer line and Settings ------------------------------------------ */

  /* "Dim the other paragraphs while I write" is the --focus-paragraph writing
     mode, on unless this browser turned it off. writing.css dims only while the
     text has the focus, so on means while writing, never a dim page at rest. */
  function setFocus(on) {
    Castor.panels.focus(!!on);
    var sw = document.getElementById('set-focus');
    if (sw) sw.checked = Castor.panels.isFocus();
    var settings = document.getElementById('castor-settings');
    if (on && settings && settings.hidePopover) settings.hidePopover();
    applyDim();
  }

  function dimOn() { return recall('dim') !== '0'; }
  /* Show Markdown marks: off unless this device turned it on. */
  function marksOn() { return recall('marks') === '1'; }
  function setMarks(on) {
    store('marks', on ? '1' : '0');
    var settings = document.getElementById('castor-settings');
    var inSettings = settings && settings.matches && settings.matches(':popover-open');
    if (Castor.editor && Castor.editor.setMarks) Castor.editor.setMarks(!!on, { focus: !inSettings });
    var sw = document.getElementById('set-marks'); if (sw) sw.checked = marksOn();
    return marksOn();
  }
  function applyDim() {
    var on = dimOn();
    if (Castor.editor && Castor.editor.setWritingMode) Castor.editor.setWritingMode('--focus-paragraph', on);
    var sw = document.getElementById('set-dim');
    if (sw) sw.checked = dimOn();
    return on;
  }
  function setDim(on) {
    store('dim', (on === undefined ? !dimOn() : !!on) ? '1' : '0');
    return applyDim();
  }

  function writingPreference(name, allowed, fallback) {
    var value = recall(name); return allowed.indexOf(value) >= 0 ? value : fallback;
  }
  function applyWritingPreferences() {
    if (!els.app) return;
    els.app.style.setProperty('--measure', writingPreference('textWidth', ['60', '68', '74'], '60') + 'ch');
    var size = writingPreference('textSize', ['18', '20', '22'], '20');
    els.app.style.setProperty('--reading-size', size + 'px');
    els.app.style.setProperty('--reading-size-narrow', Math.max(16, Number(size) - 2) + 'px');
    if (Castor.editor && Castor.editor.setSpellcheck) Castor.editor.setSpellcheck(recall('spellcheck') !== '0');
    if (Castor.island) Castor.island.setTouchEnabled(recall('touchFormat') !== '0');
  }
  function defaultPanels() {
    try { var ids = JSON.parse(recall('defaultPanels')); return Array.isArray(ids) ? ids : null; }
    catch (e) { return null; }
  }
  function paintReaderColor() {
    var row = document.getElementById('set-reader-color-row'), input = document.getElementById('set-reader-color');
    if (row) row.hidden = !reviewing();
    if (input) { input.disabled = !reviewing() || !Castor.role.id; input.value = Castor.role.color || '#55534c'; }
  }
  async function saveReaderColor(input) {
    var identity = Castor.role, note = document.getElementById('set-reader-color-note');
    if (!identity.reviewer || !identity.confirmed || !identity.id || !/^#[0-9a-fA-F]{6}$/.test(input.value)) { paintReaderColor(); return; }
    var color = input.value; input.disabled = true;
    if (note) note.textContent = 'Saving colour…';
    try {
      var response = await global.fetch('/api/profile', { method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({reviewer_id:identity.id,color:color}) });
      var result = response.ok ? await response.json() : null;
      if (Castor.role !== identity) return;
      if (!result || result.ok !== true || result.id !== identity.id || result.color !== color) throw Error('not saved');
      identity.color = color;
      if (note) note.textContent = 'Saved. New comments use this colour; earlier comments keep theirs.';
    } catch (error) {
      if (Castor.role === identity && note) note.textContent = 'Colour was not saved. Try again.';
    } finally { paintReaderColor(); }
  }
  function paintSettings() {
    if (Castor.readerShell) Castor.readerShell.settings();
    paintReaderColor();
    var format = document.getElementById('set-touch-format'); if (format) format.checked = recall('touchFormat') !== '0';
    var focus = document.getElementById('set-focus'); if (focus) focus.checked = Castor.panels.isFocus();
    applyDim();
    var spell = document.getElementById('set-spell'); if (spell) spell.checked = recall('spellcheck') !== '0';
    var marks = document.getElementById('set-marks'); if (marks) marks.checked = marksOn();
    var width = document.getElementById('set-width'); if (width) width.value = writingPreference('textWidth', ['60', '68', '74'], '60');
    var size = document.getElementById('set-size'); if (size) size.value = writingPreference('textSize', ['18', '20', '22'], '20');
    var ids = defaultPanels();
    document.querySelectorAll('.set-panels input').forEach(function (b) { b.checked = ids ? ids.indexOf(b.value) >= 0 : Castor.panels.isOpen(b.value); });
    var writer = document.getElementById('set-writer-name'); if (writer) writer.textContent = sessionNow().map(personName).join(', ') || 'Choose';
    var writerControl = document.getElementById('set-writer'); if (writerControl) writerControl.hidden = reviewing() || PUBLIC_WRITER;
    var passwordControl = document.getElementById('set-writing-password'); if (passwordControl) passwordControl.hidden = !PUBLIC_WRITER || !Castor.role.confirmed || Castor.role.passwords === false;
    applyPreset();
    var tray = document.getElementById('set-agent-tray');
    if (tray) {
      var agent = Castor.agentTray;
      tray.disabled = !agent || !agent.enabled || reviewing();
      if (tray.closest('label')) tray.closest('label').hidden = reviewing();
      tray.checked = !!(agent && agent.enabled && agent.enabled());
    }
    paintSettingsSegments();
  }

  function paintSettingsSegments() {
    document.querySelectorAll('.settings-segment input').forEach(function (radio) {
      var select = document.getElementById(radio.dataset.select);
      radio.checked = !!select && select.value === radio.value;
    });
  }

  function wireSettingsTabs(panel) {
    // A tab can appear later (Offline mounts once the account is known), so the
    // keyboard order is read from the visible tabs at each key press.
    var all = Array.prototype.slice.call(panel.querySelectorAll('[role="tab"]'));
    function shown() { return all.filter(function (tab) { return !tab.hidden; }); }
    function selectTab(tab, focus) {
      all.forEach(function (item) {
        var selected = item === tab;
        item.setAttribute('aria-selected', String(selected));
        item.tabIndex = selected ? 0 : -1;
        var page = document.getElementById(item.getAttribute('aria-controls'));
        if (page) page.hidden = !selected;
      });
      if (focus) tab.focus();
    }
    all.forEach(function (tab) {
      tab.addEventListener('click', function () { selectTab(tab, false); });
      tab.addEventListener('keydown', function (e) {
        var tabs = shown(), index = tabs.indexOf(tab);
        var next = e.key === 'ArrowRight' ? (index + 1) % tabs.length : e.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
        if (next < 0) return;
        e.preventDefault(); selectTab(tabs[next], true);
      });
    });
    ['set-width', 'set-size', 'set-preset'].forEach(function (id) {
      var select = document.getElementById(id);
      if (!select || !select.options || select.hidden) return;
      var group = line('span', 'seg settings-segment');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', select.parentNode.querySelector('.set-lbl').textContent);
      var description = select.getAttribute('aria-describedby');
      if (description) group.setAttribute('aria-describedby', description);
      Array.prototype.forEach.call(select.options, function (option) {
        var label = line('label', '');
        var radio = document.createElement('input');
        radio.type = 'radio'; radio.name = id + '-choice'; radio.value = option.value;
        radio.dataset.select = id;
        radio.addEventListener('change', function () {
          if (!radio.checked) return;
          select.value = radio.value;
          select.dispatchEvent(new global.Event('change', { bubbles: true }));
        });
        label.appendChild(radio); label.appendChild(line('span', '', option.textContent)); group.appendChild(label);
      });
      select.hidden = true;
      select.parentNode.appendChild(group);
      select.addEventListener('change', paintSettingsSegments);
    });
    paintSettingsSegments();
  }

  /* --- interface presets and the device profile --------------------------------
     Minimal (the default) keeps the bar quiet, Writing adds Outline and Comments,
     Advanced is every control the app has. A preset only sets attributes: #app
     gets data-preset, each panel word its data-tier (the stylesheet decides what
     that hides). Nothing is removed: every hidden word is still a palette command
     and a Settings row. Readers never get a preset. */
  var PRESETS = ['minimal', 'writing', 'advanced'], PRESET_NAMES = { minimal: 'Few', writing: 'Some', advanced: 'All' };
  var WORD_TIER = { outline: 'writing', comments: 'writing', files: 'advanced', changes: 'advanced',
    drafts: 'advanced', workspace: 'advanced', links: 'writing', 'for-you': 'advanced', live: 'advanced', beside: 'advanced' };
  function presetNow() { return writingPreference('preset', PRESETS, 'minimal'); }
  function applyPreset() {
    var preset = presetNow();
    if (els.app && !reviewing()) {
      els.app.setAttribute('data-preset', preset);
      if (els.topbar) els.topbar.querySelectorAll('[data-panel]').forEach(function (word) {
        var tier = WORD_TIER[word.dataset.panel];
        if (tier) word.setAttribute('data-tier', tier);
      });
    }
    var select = document.getElementById('set-preset');
    if (select) select.value = preset;
    return preset;
  }
  function setPreset(value) {
    if (PRESETS.indexOf(value) < 0) return presetNow();
    store('preset', value);
    return applyPreset();
  }
  function registerPreferenceCommands() {
    var C = Castor.commands;
    if (!C || !C.register) return;
    PRESETS.forEach(function (name) {
      C.register({ id: 'view.preset.' + name, title: 'Tools in More: ' + PRESET_NAMES[name],
        hint: name === 'minimal' ? 'Shortcuts only' : name === 'writing' ? 'adds Links' : 'every tool',
        section: 'View', when: function () { return !reviewing(); }, run: function () { setPreset(name); paintSettings(); } });
    });
    C.register({ id: 'view.marks', title: 'Show Markdown marks', hint: 'on or off, everywhere in the article', section: 'View',
      when: function () { return !reviewing(); }, run: function () { setMarks(!marksOn()); paintSettings(); } });
    C.register({ id: 'view.agenttray', title: 'Agent tray', hint: 'send notes to the agent; off until you turn it on', section: 'View',
      when: function () { return !reviewing() && !!(Castor.agentTray && Castor.agentTray.setEnabled); },
      run: function () { Castor.agentTray.setEnabled(!Castor.agentTray.enabled()); paintSettings(); } });
  }

  /* A preference profile is a small file a founder can carry between devices:
     only the settings named here, each with a closed set of allowed values. It
     never holds who is writing, an account, an article path, a token, a saved or
     unsaved text, a comment or a pending request: an unknown key is not skipped,
     it makes the whole file refused, and nothing is applied unless all of it is. */
  var PROFILE_NAME = 'descant-preferences', PROFILE_VERSION = 1, PROFILE_MAX = 1024;
  function yesNo(name, fallback) { var v = recall(name); return v === null || v === undefined ? fallback : v !== '0'; }
  var PROFILE_FIELDS = {
    preset: { values: PRESETS, read: presetNow, write: setPreset },
    theme: { values: THEME_ORDER, read: function () { return themeMode; }, write: function (v) { setTheme(v); } },
    textWidth: { values: ['60', '68', '74'], read: function () { return writingPreference('textWidth', ['60', '68', '74'], '60'); },
      write: function (v) { store('textWidth', v); } },
    textSize: { values: ['18', '20', '22'], read: function () { return writingPreference('textSize', ['18', '20', '22'], '20'); },
      write: function (v) { store('textSize', v); } },
    dim: { values: [true, false], read: dimOn, write: function (v) { store('dim', v ? '1' : '0'); } },
    marks: { values: [true, false], read: marksOn, write: setMarks },
    spellcheck: { values: [true, false], read: function () { return recall('spellcheck') !== '0'; },
      write: function (v) { store('spellcheck', v ? '1' : '0'); } },
    touchFormat: { values: [true, false], read: function () { return yesNo('touchFormat', true); },
      write: function (v) { store('touchFormat', v ? '1' : '0'); } },
    agentTray: { values: [true, false], present: function () { return !reviewing() && !!(Castor.agentTray && Castor.agentTray.enabled); },
      read: function () { return !!Castor.agentTray.enabled(); }, write: function (v) { Castor.agentTray.setEnabled(v); } }
  };
  function exportProfile() {
    var preferences = {};
    Object.keys(PROFILE_FIELDS).forEach(function (name) {
      var field = PROFILE_FIELDS[name];
      if (!field.present || field.present()) preferences[name] = field.read();
    });
    return JSON.stringify({ app: PROFILE_NAME, version: PROFILE_VERSION, preferences: preferences }, null, 2) + '\n';
  }
  function plainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
  }
  function importProfile(text) {
    var refuse = function (why) { return { ok: false, error: why }; };
    if (typeof text !== 'string' || text.length > PROFILE_MAX) return refuse('That file is too big to be a preference profile.');
    var profile;
    try { profile = JSON.parse(text); } catch (e) { return refuse('That file is not a preference profile.'); }
    if (!plainObject(profile) || Object.keys(profile).sort().join() !== 'app,preferences,version' ||
        profile.app !== PROFILE_NAME || profile.version !== PROFILE_VERSION || !plainObject(profile.preferences)) {
      return refuse('That file is not a preference profile this version of Descant reads.');
    }
    var names = Object.keys(profile.preferences);
    if (!names.length || names.length > Object.keys(PROFILE_FIELDS).length) return refuse('That profile has the wrong number of settings.');
    for (var i = 0; i < names.length; i++) {
      var field = Object.prototype.hasOwnProperty.call(PROFILE_FIELDS, names[i]) ? PROFILE_FIELDS[names[i]] : null;
      if (!field) return refuse('That profile holds something other than preferences, so nothing was applied.');
      if (field.values.indexOf(profile.preferences[names[i]]) < 0) return refuse('That profile holds a value Descant does not accept, so nothing was applied.');
    }
    var applied = [];
    names.forEach(function (name) {
      var field = PROFILE_FIELDS[name];
      if (field.present && !field.present()) return;
      field.write(profile.preferences[name]);
      applied.push(name);
    });
    applyWritingPreferences(); applyDim(); applyPreset(); paintSettings();
    return { ok: true, applied: applied };
  }
  Castor.prefs = { preset: presetNow, setPreset: setPreset, exportProfile: exportProfile, importProfile: importProfile,
    marks: marksOn, setMarks: setMarks,
    theme: function () { return themeMode; }, setTheme: function (mode) { setTheme(mode); return themeMode; },
    themes: THEME_ORDER.map(function (mode) { return { value: mode, label: THEME_WORD[mode] }; }) };

  /* Export saves the profile through the browser's own download; Import reads a
     chosen file here, in the page, and sends it nowhere. */
  function wireProfile(note) {
    var say = function (text) { if (note) note.textContent = text; };
    var out = document.getElementById('set-export-prefs');
    if (out) out.addEventListener('click', function () {
      try {
        var link = document.createElement('a');
        var url = global.URL.createObjectURL(new global.Blob([exportProfile()], { type: 'application/json' }));
        link.href = url;
        link.download = PROFILE_NAME + '.json';
        link.click();
        setTimeout(function () { global.URL.revokeObjectURL(url); }, 1000);
        say('Settings saved to a file. It holds settings only.');
      } catch (e) { say('The file could not be made here.'); }
    });
    var into = document.getElementById('set-import-prefs');
    if (into) into.addEventListener('click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.hidden = true;
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        input.remove();
        if (!file) return;
        if (file.size > PROFILE_MAX) { say('That file is too big to be a preference profile.'); return; }
        var reader = new global.FileReader();
        reader.onerror = function () { say('That file could not be read.'); };
        reader.onload = function () {
          var result = importProfile(String(reader.result || ''));
          say(result.ok ? 'Settings applied.' : result.error);
        };
        reader.readAsText(file);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  /* The article's words as a reader counts them: no frontmatter, no writer notes,
     no link targets, no Markdown marks. */
  function countWords(markdown) {
    var text = String(markdown || '')
      .replace(/^---\n[\s\S]*?\n---\n?/, '')
      .replace(/%%[\s\S]*?%%/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, function (m, target, label) { return label || target; })
      .replace(/\[\^[^\]]+\]:?/g, ' ');
    var words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
    return words ? words.length : 0;
  }
  Castor.countWords = countWords;

  function wireFootline() {
    /* Counted when the writing pauses, never on each key. */
    var count = document.getElementById('castor-words');
    if (count) {
      var timer = 0;
      var paintCount = function () {
        timer = 0;
        var n = countWords((Castor.editor && Castor.editor.getSource) ? Castor.editor.getSource() : source);
        count.textContent = n.toLocaleString('en') + (n === 1 ? ' word' : ' words');
      };
      bus.on('doc:change', function () { clearTimeout(timer); timer = setTimeout(paintCount, 600); });
      bus.on('live:reload', paintCount);
      paintCount();
    }

    var keysWord = document.getElementById('castor-shortcuts');
    if (keysWord) {
      if (Castor.popovers) {
        var keysPanel = line('div', 'shortcuts-reference');
        keysPanel.id = 'castor-keys-reference'; keysPanel.setAttribute('role', 'dialog');
        keysPanel.setAttribute('aria-label', 'Shortcuts'); document.body.appendChild(keysPanel);
        Castor.popovers.bind(document.getElementById('set-shortcuts'), keysPanel, function () {
          keysPanel.textContent = ''; keysPanel.appendChild(line('h2', 'settings-title', 'Shortcuts'));
          if (!Castor.commands || !Castor.commands.keyboardMap) return;
          var section = '';
          Castor.commands.keyboardMap().forEach(function (c) {
            if (section !== c.section) {
              section = c.section;
              keysPanel.appendChild(line('h3', 'shortcut-section', section));
            }
            var row = line('p', 'shortcut-row');
            row.appendChild(line('span', '', c.label));
            row.appendChild(line('kbd', '', c.keys)); keysPanel.appendChild(row);
          });
        });
      }
      keysWord.setAttribute('aria-pressed', 'false');
      keysWord.addEventListener('click', function () { if (toggleShortcutHints) toggleShortcutHints(); });
    }

    /* Settings is a native popover over the footer's right end: Escape or a click
       outside closes it with no script. What it shows is read again as it opens. */
    var panel = document.getElementById('castor-settings');
    if (!panel) return;
    wireSettingsTabs(panel);
    var gear = document.getElementById('castor-settings-gear');
    if (Castor.popovers) Castor.popovers.bind(gear, panel, paintSettings);
    [['set-focus', setFocus], ['set-dim', setDim], ['set-marks', setMarks]].forEach(function (pair) {
      var control = document.getElementById(pair[0]);
      if (control) control.addEventListener('change', function () { pair[1](control.checked); });
    });
    [['set-spell', 'spellcheck'], ['set-touch-format', 'touchFormat'], ['set-width', 'textWidth'], ['set-size', 'textSize']].forEach(function (pair) {
      var control = document.getElementById(pair[0]);
      if (control) control.addEventListener('change', function () {
        store(pair[1], control.type === 'checkbox' ? (control.checked ? '1' : '0') : control.value);
        applyWritingPreferences();
      });
    });
    var boxes = panel.querySelectorAll('.set-panels input');
    boxes.forEach(function (box) { box.addEventListener('change', function () {
      store('defaultPanels', JSON.stringify(Array.prototype.filter.call(boxes, function (b) { return b.checked; }).map(function (b) { return b.value; })));
    }); });
    [['set-writer', function () { whoAsk(true); }],
      ['set-walkthrough', function () { if (Castor.walkthrough) Castor.walkthrough.start(); }]
    ].forEach(function (pair) {
      var button = document.getElementById(pair[0]);
      if (button) button.addEventListener('click', function () { if (panel.hidePopover) panel.hidePopover(); pair[1](); });
    });
    var color = document.getElementById('set-reader-color');
    if (color) color.addEventListener('change', function () { saveReaderColor(color); });
    var preset = document.getElementById('set-preset');
    if (preset) preset.addEventListener('change', function () { setPreset(preset.value); });
    var trayControl = document.getElementById('set-agent-tray');
    if (trayControl) trayControl.addEventListener('change', function () {
      if (!reviewing() && Castor.agentTray && Castor.agentTray.setEnabled) Castor.agentTray.setEnabled(trayControl.checked);
      paintSettings();
    });
    // The picker's first choice is the world's own reading font, so it is also the reset.
    if (Castor.fonts && Castor.fonts.mountReadingPicker) Castor.fonts.mountReadingPicker(document.getElementById('set-reading-font'));
    wireProfile(document.getElementById('set-prefs-note'));
  }

  /* --- a personal installation ------------------------------------------- */

  function registerPublishSetup() {
    if (!Castor.commands || !Castor.commands.register || registerPublishSetup.done) return;
    registerPublishSetup.done = true;
    Castor.commands.register({
      id: 'publish.setup', title: 'Publish', hint: 'not set up yet', section: 'Writing',
      run: function () {
        Castor.commands.openList({ title: 'Publish', items: [
          { id: 'publish.setup.1', label: 'Publishing is not set up yet.' },
          { id: 'publish.setup.2', label: 'Your coding agent can set it up.', detail: 'PUBLISHING.md' }
        ], onPick: function () {} });
      }
    });
  }

  /* --- boot ---------------------------------------------------------------- */

  function boot() {
    var live = liveConfig();
    /* Opened from disk there is no server to ask anything, so nothing waits. */
    if (!servedOverHttp()) return bootWith(null);
    /* The page waits for the piece rather than showing the embedded one first and
       replacing it a moment later: one flash of the wrong article is worse than a
       beat of nothing. If the server cannot answer, the embedded block still boots.
       Who is asking is asked in the same beat, because what mounts depends on it. */
    /* The article is asked for as soon as the server has said who is asking, while
       the offline storage check below still runs. What comes back
       is shown only if the writer is the same once that check settles; otherwise it
       is dropped and the article is read again, as it was before. */
    var whoami = askRole().then(function (payload) { applyRole(Castor.roleFrom(payload)); return payload; });
    openingCheck = whoami.then(function () { roleSettled = true; if (PUBLIC_WRITER && !Castor.role.confirmed) unconfirmed(); });
    var role = whoami.then(function (payload) {
      if (PUBLIC_WRITER && Castor.role.confirmed && Castor.offline) {
        var original = Castor.role.id;
        function sameWriter() { return Castor.role.confirmed && Castor.role.id === original; }
        function denied() { applyRole(Castor.roleFrom(null)); return null; }
        return Castor.offline.connect().then(function () { return sameWriter() ? payload : denied(); }, function () {
          // An installed worker can change during its first upgrade. Recheck
          // authentication before one retry; every storage handshake still runs.
          if (!sameWriter()) return denied();
          return askRole().then(function (fresh) {
            var checked = Castor.roleFrom(fresh);
            if (!sameWriter() || !checked.confirmed || checked.id !== original) return denied();
            applyRole(checked);
            return Castor.offline.connect().then(function () { return sameWriter() ? fresh : denied(); }, denied);
          });
        });
      }
      return payload;
    });
    /* An address that names an article is authoritative. One that names none (the
       built page's own default) gives way to the article this writer last had
       open, once the server has confirmed who is asking and still lists it. */
    function chosenAfter(asked) {
      return !live ? Promise.resolve('') : live.explicit ? Promise.resolve(live.path)
        : asked.then(restoredPath).then(function (saved) { return saved || live.path; });
    }
    function pieceAfter(asked) {
      return !live ? Promise.resolve(null) : Promise.all([chosenAfter(asked), asked]).then(function (ready) {
        var path = ready[0], writerRole = Castor.role, writerAuthority = writingAuthority();
        /* What this device kept for the piece is read in the same beat, so text
           typed here and never saved is what the editor first shows. */
        return Promise.all([readLive(path, live.path), keptFor(path)]).then(function (got) {
          got[0].writerRole = writerRole;
          got[0].writerAuthority = writerAuthority;
          if (got[0].path === path) { got[0].kept = got[1]; return got[0]; }
          return keptFor(got[0].path).then(function (kept) { got[0].kept = kept; return got[0]; });
        });
      });
    }
    var early = pieceAfter(whoami);
    // The writer as the offline check left it. A change after this point is a
    // change during the read and is refused below, as before.
    var checked = role.then(function () { return { role: Castor.role, authority: writingAuthority() }; });
    var piece = Promise.all([checked, early]).then(function (both) {
      var got = both[1], at = both[0];
      if (!PUBLIC_WRITER || !got) return got;
      var same = got.writerRole === at.role && got.writerAuthority === at.authority;
      if (same && got.payload) return got;
      /* The service worker refuses a read that was pending while the page bound its
         writer, so a failed early read is asked again, but only while the writer is
         still the one the check confirmed; a change is refused below, as before. */
      if (same && (Castor.role !== at.role || writingAuthority() !== at.authority)) return got;
      return pieceAfter(role);
    });
    Promise.all([role, piece]).then(function (both) {
      if (!PUBLIC_WRITER) applyRole(Castor.roleFrom(both[0]));
      else if (both[1] && (both[1].writerRole !== Castor.role || both[1].writerAuthority !== writingAuthority())) {
        applyRole(Castor.roleFrom(null));
        both[1] = { path: both[1].path, payload: null, error: 'The writer changed while this article opened. Reconnect and reopen this page.' };
      }
      /* A reviewer who opened the review page with no piece named goes to the
         site's root, which the server answers with their first shared piece (or
         says, in words, that nothing is shared yet). */
      if (reviewing() && !both[1]) {
        try { global.location.replace('/'); return; } catch (e) { /* boot as is */ }
      }
      bootWith(both[1]);
    });
  }

  // The visible viewport moves as well as shrinks when a phone keyboard opens.
  // Its height is already the usable height; subtracting offsetTop adds a gap.
  function wireViewport() {
    if (!els.frame) return;
    var vv = global.visualViewport, raf = 0, full = {}, deepest = {}, opened = 0, taller = null;
    function fit() {
      raf = 0;
      var height = vv ? vv.height : global.innerHeight;
      // Phone: after focus moves, iOS can stop counting the browser's own row above
      // the keys (Chrome's key, card and pin; Safari's arrows) while it is still drawn.
      // That row is there on every keyboard, so the deepest keyboard seen at this
      // width is the one in front of the page. Measured from the viewport alone:
      // innerHeight changes for a frame on Return. Mid-writing, a taller keyboard
      // counts only once it has stayed 200 ms, so a one-frame flicker moves nothing.
      var width = global.innerWidth, zoomed = vv && (vv.scale || 1) > 1.01;
      // Before the viewport tag applies, the first frame can be laid out zoomed out and far taller than the screen.
      var scr = global.screen, tallest = scr && scr.height ? Math.max(scr.height, scr.width || 0) : Infinity;
      if (!zoomed && height <= tallest) full[width] = Math.max(full[width] || 0, height);   // from the first fit, before the app knows it is a phone
      if (vv && !zoomed && els.app && els.app.dataset.mode === 'phone') {
        var now = Date.now(), keys = full[width] - height;
        // No phone keyboard covers more than 70 % of the screen; such a sample is a glitch.
        if (keys <= 120 || keys > full[width] * .7) { opened = 0; taller = null; }
        else {
          if (!opened) opened = now;
          if (!deepest[width] || keys > deepest[width] && now - opened < 600) deepest[width] = Math.max(deepest[width] || 0, keys);
          else if (keys > deepest[width]) {
            if (!taller || Math.abs(taller.keys - keys) > 2) { taller = { keys: keys, at: now }; global.setTimeout(schedule, 210); }
            else if (now - taller.at >= 200) { deepest[width] = keys; taller = null; }
          } else taller = null;
          height = full[width] - deepest[width];
        }
      }
      els.frame.style.setProperty('--viewport-height', height + 'px');
      els.frame.style.setProperty('--viewport-top', '0px');
      resetWindow();
      bus.emit('layout');
    }
    function schedule() {
      if (!raf) raf = global.requestAnimationFrame(fit);
    }
    function resetWindow() {
      // iOS pans the outer document after focus, even with preventScroll. The
      // article has its own scrollport; a keyboard must never move the window.
      var touch = global.matchMedia && global.matchMedia('(pointer: coarse)').matches;
      if ((global.scrollY || global.scrollX) && global.scrollTo &&
          (touch || document.activeElement && document.activeElement.closest && document.activeElement.closest('.cw-edit'))) {
        global.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      }
    }
    global.addEventListener('scroll', resetWindow);
    global.addEventListener('resize', schedule);
    if (vv) {
      vv.addEventListener('resize', schedule);
      vv.addEventListener('scroll', schedule);
    }
    fit();
  }

  async function bootWith(live) {
    var authority = writingAuthority();
    var revision = recoveryRevision, attachment = saveAttachment, request = pieceRequest, outgoing = editorSource(), operation = keptOperation;
    var prepared = live && live.payload ? await prepareOpening(live.path, live.payload, live.kept) : { ready: true, entry: null };
    // A refusal belongs to its captured context too: never replace a newer
    // notice with an obsolete error, or revive an interrupted equal identity.
    if (revision !== recoveryRevision || attachment !== saveAttachment || request !== pieceRequest || operation !== keptOperation ||
        authority !== writingAuthority() || editorSource() !== outgoing || compositionActive()) return;
    if (!prepared.ready) {
      keptNotice('The article’s kept copies could not be safely opened.', 'Nothing was replaced. Keep this page open and try again.', [['Close', closeKeptNotice]]);
      return;
    }
    liveState = live;
    displayedPath = live && live.payload ? live.path : null;
    data = readData();
    if (live && live.payload) { applyLive(data, live.payload); cachePiece(live.path, live.payload); }
    else if (reviewing()) notShared(data);
    world = data.world || document.documentElement.dataset.world || 'dev';
    source = sourceOf(data);
    if (live && live.payload) opening(live.path, live.payload, prepared.entries || [], prepared.entry);
    /* The article now open is the one to come back to, and it has its tab. */
    if (live && live.payload) rememberPiece(live.path);
    loadClosed();
    if (live && live.path) delete closedTabs[live.path];

    els.frame = document.getElementById('frame');
    wireViewport();
    els.app = document.getElementById('app');
    els.topbar = document.getElementById('topbar');
    els.page = document.getElementById('page');
    els.scroll = els.page && els.page.querySelector('.page-scroll');
    els.sizeSwitch = document.getElementById('size-switch');
    els.theme = document.getElementById('theme-switch');
    els.article = document.getElementById('page-article') ||
      (els.page && els.page.querySelector('.page-column'));

    if (!els.app || !els.article) {
      console.error('[castor] this shell has no #app or no .page-column');
      return;
    }

    if (data.piece && data.piece.title) document.title = data.piece.title;

    Castor.app = {
      get doc() { return doc; }, set doc(d) { doc = d; },
      data: data, world: world,
      get source() { return source; },
      get live() {
        return liveState ? { on: true, path: liveState.path, error: liveState.error || null } : null;
      },
      reload: reloadLive,
      render: render, setTheme: setTheme, setSize: setSize,
      get theme() { return themeMode; }, get size() { return sizeMode; },
      setDim: setDim, get dim() { return dimOn(); },
      get writerNotes() { return writerNotes; },
      setWriterNotes: function (on) {
        writerNotes = on === undefined ? !writerNotes : !!on;
        store('writerNotes', writerNotes ? '1' : '0');
        if (Castor.editor && Castor.editor.setWriterNotes) Castor.editor.setWriterNotes(writerNotes);
        else render();
        bus.emit('writer-notes', writerNotes);
        return writerNotes;
      }
    };

    /* A reviewer is a reader, and writer notes are hidden to readers. */
    writerNotes = reviewing() ? false : recall('writerNotes') !== '0';

    render();

    /* editor.js owns the page's DOM once it mounts, so app.js must never re-render
       over it: it keeps its copy of the source and the doc from the editor's own
       'doc:change' instead. */
    bus.on('doc:change', function (p) {
      if (!p) return;
      if (p.doc) doc = p.doc;
      if (typeof p.source === 'string') source = p.source;
    });

    /* the theme and the frame width are settled BEFORE the docks mount: panels
       reads the app's real width to pick its mode, and a shell reopened at
       Phone must not mount as a desktop first */
    setTheme(recall('theme') || data.theme || 'system');
    themeBooted = true;
    setSize(recall('size') || 'computer');

    if (reviewing()) {
      if (Castor.panels.withhold) Castor.panels.withhold(REVIEWER_WITHHELD);
      if (Castor.commands && Castor.commands.limit) Castor.commands.limit(readerCommand);
    }
    Castor.panels.mount({
      app: els.app, left: document.getElementById('dock-left'),
      right: document.getElementById('dock-right'), page: els.page,
      topbar: els.topbar, world: world
    });

    mountModules();
    applyWritingPreferences();

    if (!reviewing()) {
      var defaults = defaultPanels();
      if (defaults) BAR_ORDER.forEach(function (id) { if (defaults.indexOf(id) >= 0) Castor.panels.open(id); else Castor.panels.close(id); });
    }
    applyDim();
    wireTopbar();
    wireFootline();
    applyPreset();
    registerPreferenceCommands();
    wireTabs();
    loadPieces();
    bus.on('live:reload', function (info) { attachSaver(null, info && info.cached); queuePiecePrefetch(); });
    bus.on('piece:save-start', stopPiecePrefetch);
    bus.on('piece:saved', function (info) { savedPieceCache(info.path, info.text, info.res, info.done); });
    bus.on('save:activity', function (pending) {
      pieceSaveActivity = pending || 0;
      if (pieceSaveActivity) stopPiecePrefetch();
      else queuePiecePrefetch();
    });
    bus.on('save:state', queuePiecePrefetch);
    bus.on('piece:opened', queuePiecePrefetch);
    var attached = attachSaver(live);
    Promise.resolve(attached).then(function () {
      function settledLayout() {
        queueKnot(false);
        if (Castor.footnotes && Castor.footnotes.layout) Castor.footnotes.layout();
      }
      function reveal() {
        if (!els.frame) return;
        els.frame.setAttribute('data-ready', '');
        // The moment the article is shown, for anyone timing how fast the page opens.
        try { if (global.performance && global.performance.mark) global.performance.mark('descant-ready'); } catch (e) { /* no timing */ }
      }
      /* Recovery has settled. Background frame throttling and font swapping
         must not hide a ready writing sheet. */
      reveal();
      if (global.requestAnimationFrame) global.requestAnimationFrame(settledLayout);
      else settledLayout();
      if (document.fonts) Promise.resolve(document.fonts.ready).then(settledLayout);
    });
  }

  /* Native focus scrolling can miss links in the article's nested scroller.
     Mouse caret placement stays with the editor; only keyboard focus reveals. */
  var pageKeyboardFocus = false;
  function revealPageFocus(event) {
    var target = event.target;
    if (!pageKeyboardFocus || !target.matches || !target.matches(':focus-visible') || target.classList && target.classList.contains('cw-edit')) return;
    var scroll = target.closest('.page-scroll');
    if (!scroll) return;
    global.requestAnimationFrame(function () {
      if (!pageKeyboardFocus || document.activeElement !== target || !target.matches(':focus-visible')) return;
      var box = target.getBoundingClientRect(), bounds = scroll.getBoundingClientRect();
      var delta = box.bottom > bounds.bottom - 8 ? box.bottom - bounds.bottom + 8
        : box.top < bounds.top + 8 ? box.top - bounds.top - 8 : 0;
      if (delta) scroll.scrollBy({ top: delta, behavior: 'instant' });
    });
  }
  document.addEventListener('keydown', function () { pageKeyboardFocus = true; }, true);
  document.addEventListener('pointerdown', function () { pageKeyboardFocus = false; }, true);
  document.addEventListener('focusin', revealPageFocus);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : this);
