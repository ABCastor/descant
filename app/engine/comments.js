/* comments.js: comments on a passage, shown twice at once.
 *
 * Contract: engine/README.md, section "comments.js".
 *   1. A thread card under the block the anchor resolves to.
 *   2. A card per thread in the Comments panel, vertically aligned to its passage,
 *      pushed down when two would overlap, with a persistent thin leader back to the passage line.
 * Comments without a passage stay visible and explain whether they concern the
 * whole article or words no longer on the page.
 *
 * Owns: window.Castor.comments. Reads Castor.md / Castor.editor / Castor.agent /
 * Castor.panels / Castor.commands / Castor.bus when they exist, works without any of them.
 */
(function (global) {
  'use strict';
  function isWriter(id) { return !!(Castor.people && Castor.people.isWriter(id)); }

  var Castor = global.Castor || (global.Castor = {});
  var DOC = global.document;
  var COMMENT_LABELS = { open: 'Open comment by ', messages: ' messages', done: ', done', more: 'More' };
  // Line icons for comment actions, drawn on a 24px grid in the ink's colour.
  var ACTION_ICONS = {
    edit: 'M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4',
    'delete': 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    restore: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4',
    agree: 'M7 11v9H4v-9h3Zm0 0 4-7a2 2 0 0 1 3 2l-1 5h5a2 2 0 0 1 2 2.3l-1.3 6A2 2 0 0 1 16.7 20H7',
    done: 'M5 12l4 4L19 6',
    reply: 'M9 7 4 12l5 5M4 12h9a7 7 0 0 1 7 7',
    link: 'M10 14l4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
    authors: 'M16 21v-2a5 5 0 0 0-10 0v2M15 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M19 10l3 3-3 3',
    inline: 'M4 5h16M4 9h16M7 13h10v6H7z',
    beside: 'M3 5h11M3 9h11M3 13h11M3 17h8M17 5h4v8h-4z'
  };
  function withIcon(button, name) {
    var d = ACTION_ICONS[name];
    if (!d || !DOC.createElementNS) return button;
    var svg = DOC.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'castor-action-icon');
    var path = DOC.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d);
    svg.appendChild(path);
    if (button.firstChild) button.insertBefore(svg, button.firstChild); else button.appendChild(svg);
    return button;
  }

  /* ---------------------------------------------------------------- plumbing */

  // The engine has no shared util module, so each module carries these three.
  function on(name, fn) {
    if (name === 'editor:mirror' && Castor.editor && Castor.editor.on) { Castor.editor.on(name, fn); return; }
    if (Castor.bus && typeof Castor.bus.on === 'function') { Castor.bus.on(name, fn); return; }
    DOC.addEventListener(name, fn);
  }
  // On a phone there is no Esc, and its keyboard's key reads return: say what it does.
  function keysHint(does) {
    var phone = !!(global.matchMedia && global.matchMedia('(hover: none) and (pointer: coarse)').matches);
    return phone ? 'Return ' + does : 'Enter saves · Esc closes';
  }
  function el(tag, cls, text) {
    var n = DOC.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  /* SHOW AND HIDE, ONE WAY. A part of a card that waits closed (the comments without a passage,
     the older versions of an edit) opens with a real button: it names what it holds, says Show or
     Hide in words, carries aria-expanded and names the region it opens, which follows it. No
     native disclosure triangle anywhere in comments. `toggled(open)` keeps the state for the
     next layout. */
  var disclosureSeq = 0;
  function disclosure(cls, label, open, toggled) {
    var box = el('div', cls), id = 'castor-shows-' + (++disclosureSeq);
    var button = el('button', 'castor-disclosure');
    button.type = 'button';
    var state = el('span', 'castor-disclosure-state', open ? 'Hide' : 'Show');
    state.setAttribute('aria-hidden', 'true');
    button.appendChild(el('span', 'castor-disclosure-label', label));
    button.appendChild(state);
    button.setAttribute('aria-expanded', String(!!open));
    button.setAttribute('aria-controls', id);
    var body = el('div', 'castor-disclosure-body');
    body.id = id; body.hidden = !open;
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      var now = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(now));
      state.textContent = now ? 'Hide' : 'Show';
      body.hidden = !now;
      if (toggled) toggled(now);
    });
    box.appendChild(button); box.appendChild(body);
    return { node: box, body: body, button: button };
  }
  function words(s) { return String(s || '').toLowerCase().match(/[a-z0-9']+/g) || []; }
  /* app.js confirms the role. Create/reply retain their existing authority;
     edits and other mutations require server-confirmed per-target capabilities. */
  function reviewing() { return !!(Castor.role && Castor.role.reviewer); }
  function roleConfirmed() { return !!(Castor.role && Castor.role.confirmed); }
  /* The session ended while this writer's page was open (app.js Castor.signedOut): their threads
     and pending comments stay in view in their place, read-only, until they sign in again. */
  function ended() { return !!(Castor.role && Castor.role.ended && Castor.role.id); }

  // One structural stylesheet, inserted as the FIRST child of <head> so that engine.css
  // and a world's theme.css (loaded after) win every tie. Positioning only; each colour
  // reads a token and falls back to something neutral.
  var STRUCTURE = [
    'mark.commented{background:var(--highlight,rgba(190,140,20,.20));color:inherit;',
    '  -webkit-box-decoration-break:clone;box-decoration-break:clone;border-radius:2px;',
    '  padding:0 .04em;cursor:pointer;transition:background 160ms ease-out}',
    'mark.commented.is-lifted{background:var(--sel,rgba(190,140,20,.42))}',
    'mark.commented.is-done{background:var(--pane-hot,rgba(120,120,120,.16))}',
    '.castor-thread-slot{margin:.6rem 0 1.1rem}',
    '.castor-thread{border:1px solid var(--rule,rgba(0,0,0,.14));border-radius:6px;',
    '  background:var(--pane-solid,rgba(0,0,0,.02));padding:10px 12px;font-size:13.5px;line-height:1.45}',
    '.castor-thread + .castor-thread{margin-top:8px}',
    // Under the paragraph a thread is part of the reading surface, so it is a hairline
    // and the words. In the panel it is chrome, so it keeps the box.
    '.castor-thread-slot .castor-thread{border:0;border-top:1px solid var(--rule,rgba(0,0,0,.14));',
    '  border-radius:0;background:none;padding:9px 0 2px;font-size:13px;',
    '  font-family:var(--font-ui,system-ui,sans-serif)}',
    '.castor-thread-slot .castor-thread.is-lifted{border-top-color:var(--ink,#1a1a1a)}',
    '.castor-thread-slot .castor-thread + .castor-thread{margin-top:2px}',
    '.castor-thread.is-lifted{border-color:var(--ink,#1a1a1a)}',
    '.castor-msg + .castor-msg{margin-top:9px;padding-top:9px;border-top:1px solid var(--rule,rgba(0,0,0,.09))}',
    '.castor-prov{font-size:11.5px;line-height:1.35;margin-top:3px;color:var(--ink-3,rgba(0,0,0,.64))}',
    '.castor-prov-author{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    '.castor-comment-model{font-size:10.5px;padding:1px 5px;border-radius:3px;background:var(--pane-hot,rgba(0,0,0,.06));color:var(--ink-2,rgba(0,0,0,.7));font-family:var(--font-mono,monospace)}',
    '.castor-comment-date{margin-left:6px;font-size:11px;color:var(--ink-3,rgba(0,0,0,.5))}',
    '.castor-comment-context{font-size:11px;color:var(--ink-3,rgba(0,0,0,.5));margin-top:2px}',
    '.castor-quote{font-size:12px;margin-bottom:6px;color:var(--ink-2,rgba(0,0,0,.7))}',
    '.castor-more{font-size:12px;margin-top:6px;color:var(--ink-2,rgba(0,0,0,.7))}',
    '.castor-acts{margin-top:8px;display:flex;gap:12px;flex-wrap:wrap}',
    '.castor-acts button,.castor-word{background:none;border:0;padding:0;font:inherit;font-size:12.5px;',
    '  color:var(--ink,#1a1a1a);cursor:pointer;text-align:left}',
    '.castor-acts button:hover,.castor-word:hover{text-decoration:underline}',
    // The band fills the whole panel so a card can sit level with a passage near the top
    // of the reading area. The filter row and the detached list float over it, opaque and
    // one line each, so they cost the band about sixty pixels rather than a screenful.
    '.castor-comments{position:relative;height:100%;min-height:0;font-size:13.5px}',
    '.castor-filter{position:absolute;left:0;right:0;top:0;z-index:3;display:flex;flex-wrap:wrap;',
    '  align-items:baseline;gap:4px 14px;padding:0 0 6px;background:var(--pane,var(--paper,#fff))}',
    '.castor-filter > *{white-space:nowrap}',
    '.castor-filter button[aria-pressed="true"]{font-weight:600;color:var(--ink,#1a1a1a)}',
    '.castor-author-filter{position:relative;display:inline-block}',
    '.castor-author-filter summary{list-style:none;cursor:pointer;min-height:44px;display:inline-flex;align-items:center;',
    '  padding:0 6px;font:inherit;font-size:12px;color:var(--ink,#1a1a1a);user-select:none}',
    '.castor-author-filter summary::-webkit-details-marker{display:none}',
    '.castor-author-filter summary:focus-visible{outline:1px solid currentColor;outline-offset:2px;border-radius:2px}',
    '.castor-author-menu{position:absolute;left:0;top:100%;z-index:10;background:var(--paper,#fff);',
    '  border:1px solid var(--rule,rgba(0,0,0,.15));border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.12);',
    '  min-width:140px;padding:4px 0}',
    '.castor-author-option{display:block;width:100%;text-align:left;border:0;background:none;overflow-wrap:anywhere;',
    '  font:inherit;font-size:12.5px;min-height:44px;padding:6px 12px;color:var(--ink,#1a1a1a);cursor:pointer}',
    '.castor-author-option:hover,.castor-author-option:focus-visible{background:var(--pane-hot,rgba(0,0,0,.06));outline:none}',
    '.castor-author-option[aria-pressed="true"]{font-weight:600;background:var(--pane-hot,rgba(0,0,0,.08))}',
    '.castor-count{font-size:11.5px;color:var(--ink-3,rgba(0,0,0,.64));margin-left:auto}',
    '.castor-shows{display:flex;gap:10px;margin-left:auto;align-items:baseline}',
    '.castor-shows button{-webkit-appearance:none;appearance:none;background:none;border:0;',
    '  padding:0;margin:0;font:inherit;font-size:11.5px;color:var(--ink,#1a1a1a);opacity:.7;',
    '  cursor:pointer}',
    '.castor-shows button[aria-pressed="true"]{opacity:1;font-weight:600}',
    '.castor-shows button:hover{opacity:.9}',
    '.castor-shows button:focus-visible{outline:1px solid currentColor;outline-offset:2px;border-radius:2px}',
    '.castor-filter .castor-count{margin-left:0}',
    '.castor-lost{position:absolute;left:0;right:0;top:24px;z-index:2;padding-bottom:8px;',
    '  background:var(--pane,var(--paper,#fff))}',
    '.castor-lost .castor-thread{border-style:dashed}',
    '.castor-lost .is-lost{padding:6px 10px}',
    '.castor-lost .is-lost .castor-quote{margin:0 0 2px;white-space:nowrap;overflow:hidden;',
    '  text-overflow:ellipsis}',
    '.castor-lost .is-lost .castor-acts{margin-top:2px}',
    '.castor-lost-head{margin-bottom:4px}',
    '.castor-lost-head{font-size:12px;font-weight:600;margin-bottom:6px}',
    '.castor-canvas-wrap{position:absolute;left:0;right:0;top:0;bottom:0;overflow-y:auto;',
    '  overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin}',
    '.castor-canvas{position:absolute;left:0;right:0;top:0}',
    '.castor-canvas .castor-thread{position:absolute;left:16px;right:2px;margin:0}',
    '[data-comment-layout="list"] .castor-canvas{position:static}',
    '[data-comment-layout="list"] .castor-canvas .castor-thread{position:static;left:auto;right:auto;margin:0 2px 8px 2px}',
    '[data-comment-layout="list"] .castor-canvas-wrap{padding:0 0 12px}',
    '[data-comment-layout="list"] .castor-leaders{display:none}',
    '.castor-leaders{position:absolute;left:0;top:0;width:20px;',
    'pointer-events:none;overflow:visible}',
    '.castor-empty{font-size:12.5px;color:var(--ink-3,rgba(0,0,0,.64));padding:8px 0;line-height:1.45}',
    '.castor-empty[hidden]{display:none}',
    '.castor-composer{border:1px solid var(--ink,#1a1a1a);border-radius:6px;padding:10px 12px;',
    '  background:var(--pane-solid,rgba(0,0,0,.02));position:relative}',
    '.castor-composer textarea::placeholder{color:var(--ink-2,rgba(0,0,0,.7));opacity:1}',
    '.castor-composer textarea{width:100%;box-sizing:border-box;min-height:52px;font:inherit;font-size:13.5px;',
    '  border:0;background:transparent;color:inherit;resize:vertical;outline:none}',
    '.castor-hint{font-size:11.5px;color:var(--ink-3,rgba(0,0,0,.64));margin-top:4px}',
    '.castor-at{position:absolute;z-index:40;background:var(--paper,#fff);border:1px solid var(--rule,rgba(0,0,0,.2));',
    '  border-radius:5px;padding:3px 0;min-width:140px;box-shadow:0 6px 18px rgba(0,0,0,.14)}',
    '.castor-at div{padding:3px 10px;font-size:12.5px;cursor:pointer}',
    '.castor-at div[aria-selected="true"]{background:var(--pane-hot,rgba(0,0,0,.07))}',
    '.castor-candidate{outline:1px dashed var(--ink-2,rgba(0,0,0,.7));outline-offset:3px}',
    '@keyframes castor-flash{0%{background:var(--sel,rgba(190,140,20,.5))}',
    '  100%{background:transparent}}',
    '.castor-flash{animation:castor-flash 900ms ease-out}',
    '@media (prefers-reduced-motion:reduce){.castor-flash{animation:none}}'
  ].join('\n');

  function injectStructure() {
    if (DOC.getElementById('castor-comments-structure')) return;
    var s = el('style');
    s.id = 'castor-comments-structure';
    s.textContent = STRUCTURE;
    DOC.head.insertBefore(s, DOC.head.firstChild);
  }

  /* ------------------------------------------------------------------- state */

  var S = {
    page: null, panelEl: null, world: 'sample',
    threads: [], people: [], filter: 'open', authorFilter: '',
    commentActions: null, actionScope: '', actionJournal: {}, actionReceipts: {}, actionErrors: {}, actionSending: {}, actionEditor: null, actionProjection: {}, actionProjectionActors: {},
    loadedPath: Castor.piecePath ? Castor.piecePath() : '',
    active: null,            // thread id lifted right now
    revealId: null,          // selected card stays visible through deferred panel layouts
    expanded: {},            // thread id -> true
    candidates: {},          // equally good positions, offered for an explicit choice
    resolved: {},            // thread id -> {blockId, start, end} | null
    resolutionCache: {},     // thread id -> anchor and text used for its resolution
    blockTexts: {},          // block id -> text at the previous anchor attempt
    serverCopies: {},        // article key -> last server response
    composer: null,          // {node, textarea, record, submit}
    composerJournal: {},     // includes the latest input if browser storage fails
    journalStored: {},       // the journal keys this page knows browser storage holds
    closedComposers: {},
    canvas: null, wrap: null, leaders: null, lostBox: null, filterBox: null,
    items: [], raf: 0, placeRaf: 0,
    // Anchors of the excerpts living on the workspace canvas. canvas.js publishes
    // them on 'canvas:anchors'; the page keeps a faint mark while a card exists.
    workspace: [],
    reading: 'quiet',        // 'quiet' | 'inline' -- see setReading
    panelLayout: 'list',     // 'list' | 'beside' -- see the note above place()
    burstOpen: false,        // the orphan burst is expanded to its rows
    peek: null,              // {node, threadId}
    pairedId: null,          // the thread lit at both ends right now
    peekTimer: 0,
    retryReads: {}             // article/account-bound transient save reconciliation
  };

  function legacyKey() {
    var path = storablePath();
    return 'castor.' + S.world + '.comments' + (path ? '.' + path : '');
  }
  function key() {
    if (!roleConfirmed() && !ended()) return legacyKey() + '.unconfirmed';
    if (!reviewing()) return legacyKey() + (Castor.role.publicWriter ? '.writer.' + encodeURIComponent(Castor.role.id) : '');
    var identity = reviewerIdentity(Castor.role);
    return legacyKey() + (identity ? '.reader.' + encodeURIComponent(identity.id) : '.unconfirmed');
  }
  Castor.commentScope = function (storageKey) {
    var match = /^castor\.([^.]+)\.comments\.(articles\/[^/]+\/article\.md)(?:\.(writer|reader)\.(.+)|\.(unconfirmed))?$/.exec(storageKey || '');
    if (!match) return null;
    try { return { world: match[1], path: match[2], kind: match[3] || match[5] || '', account: match[4] ? decodeURIComponent(match[4]) : '' }; }
    catch (e) { return null; }
  };
  function enterScope() {
    var current = key(), previous = S.storageKey;
    S.storageKey = current;
    if (!previous || previous === current) return false;
    closeComposer();
    S.threads = []; S.lastServer = null; S.commentActions=null; S.actionScope='';closeActionEditor();S.authorFilter='';
    S.resolved = {}; S.resolutionCache = {}; S.candidates = {};
    return true;
  }
  function switchScope() {
    if (!enterScope()) return;
    S.threads = (load() || []).map(normalise);
  }

  /* The server stores review threads for articles and nothing else, so ask it
     only about those. Any other piece -- the sample, a scratch file -- keeps
     its comments in this browser, and `durable` says so honestly. */
  var STORABLE = /^articles\/[^/]+\/article\.md$/;
  function storablePath() {
    var path = Castor.piecePath ? Castor.piecePath() : '';
    return STORABLE.test(path) ? path : '';
  }
  function available() {
    return S.loadedPath === piecePath() && !/^articles\/[^/]+\/drafts\//.test(piecePath());
  }
  function driven() {
    try { return !!(global.navigator && global.navigator.webdriver); }
    catch (e) { return false; }
  }
  /* `settled` names pending threads the server has just accepted in a save. They
     are on the server even when nothing there matches them by text and time --
     for a reviewer the server stamps its own time on a new thread -- so they are
     never sent again (a second send would be a second thread). */
  /* A comment the server holds (its file does not read there, or two files share its number) is
     not in its list but is not gone: `held` names its number. The copy last confirmed stays, so
     words of his on it that the server never took still count as not sent. */
  function heldIds(payload) {
    var ids = {};
    (!Array.isArray(payload) && payload && Array.isArray(payload.held) ? payload.held : []).forEach(function (h) {
      if (h && /^\d+$/.test(String(h.id))) ids[String(h.id)] = true;
    });
    return ids;
  }
  function keepHeld(threads, held, lastKnown) {
    return threads.concat((lastKnown || []).filter(function (t) {
      return held[t.id] && !threads.some(function (s) { return s.id === t.id; });
    }));
  }
  function mergeServer(serverThreads, settled, local, storageKey, submitted, held) {
    local = local || S.threads || [];
    preserveCanonicalInput(serverThreads, local, storageKey || key());
    var sameAs = sameThread;
    var unsent = local.filter(function (t) {
      return t.pending && !serverThreads.some(function (s) { return s.id === t.id || sameAs(s, t); }) &&
        !(settled && settled[t.id]);
    });
    // Held, with no copy confirmed in this page: this device's copy stays, and is not sent yet.
    var kept = local.filter(function (t) {
      return !t.pending && held && held[t.id] && !serverThreads.some(function (s) { return s.id === t.id; });
    });
    var stale = local.filter(function (t) {
      return !t.pending && !serverThreads.some(function (s) { return s.id === t.id; }) && kept.indexOf(t) < 0;
    });
    if (stale.length) {
      try {
        var aside = (storageKey || key()) + '.setaside';
        var had = JSON.parse(global.localStorage.getItem(aside) || '[]');
        global.localStorage.setItem(aside, JSON.stringify(had.concat(stale).slice(-200)));
      } catch (e) {  }
    }
    var waiting = unsent.length + kept.length;
    var merged = serverThreads.map(function (server) {
      var here = local.filter(function (t) {
        return t.id === server.id || sameAs(t, server) || (settled && settled[t.id] === server.id);
      })[0];
      if (!here) return server;
      var sentHere = (submitted || []).filter(function (t) { return t.id === here.id; })[0];
      var replies = (server.replies || []).slice();
      (here.replies || []).forEach(function (reply) {
        // Older accepted snapshots can lack reply IDs and stamp their date.
        // Keep that compatibility only with exact words and a proven writer.
        if (!reply.id && sentHere && messageWriter(reply) &&
            sentHere.replies.some(function (r) { return sameReply(r, reply); }) &&
            replies.some(function (r) { return !r.id && r.author === reply.author && r.text === reply.text &&
              r.by === reply.by && messageWriter(r) === messageWriter(reply); })) return;
        if (!replies.some(function (r) { return sameReply(r, reply); })) {
          replies.push(reply); waiting++;
        }
      });
      var updated = Object.assign({}, server, { replies: replies });
      if (here.legacyHead) updated.legacyHead = here.legacyHead;
      if (sentHere) ['text', 'anchor', 'done', 'status', 'note', 'reanchoredFrom', 'refersTo'].forEach(function (field) {
        var versioned=(field==='text'&&server.actions)||((field==='done'||field==='status')&&server.statusActions);
        if(!versioned&&JSON.stringify(here[field])!==JSON.stringify(sentHere[field]))updated[field]=here[field];
      });
      return updated;
    });
    return { threads: merged.concat(kept, unsent), unsent: waiting };
  }
  function sameThread(a, b) {
    if (a.id === b.id && !a.pending && !b.pending) return true;
    if (a.id === b.id || a.clientId || b.clientId) {
      var sameOperation = (a.clientId || a.id) === (b.clientId || b.id);
      // An authenticated server may stamp a full display name. Retire only this
      // captured writer's exact operation, words and original passage.
      if (a.writer || b.writer) {
        var left = messageWriter(a), right = messageWriter(b);
        return sameOperation && !!left && left === right && a.by === 'human' && b.by === 'human' &&
          canonicalWords(a.text) === canonicalWords(b.text) &&
          JSON.stringify(canonicalAnchor(a.anchor)) === JSON.stringify(canonicalAnchor(b.anchor));
      }
      return sameOperation && canonicalWords(a.text) === canonicalWords(b.text) && a.author === b.author && a.by === b.by;
    }
    if (!/^\d+$/.test(a.id) && !/^\d+$/.test(b.id)) return false;
    if (reviewing() && (a.pending || b.pending)) return false;
    return a.text === b.text && a.author === b.author && a.by === b.by && a.created === b.created;
  }
  function messageWriter(message) {
    if (typeof message.writer === 'string' && message.writer) return message.writer;
    if (message.reviewer === true && message.reviewerIdentity && message.reviewerIdentity.id) return 'reader:' + message.reviewerIdentity.id;
    if (message.reviewer === false && isWriter(message.principal)) return 'founder:' + message.principal;
    return '';
  }
  function sameReply(a, b) {
    if(a.actions&&b.actions&&a.actions.messageRef&&a.actions.messageRef===b.actions.messageRef)return true;
    if (a.id && b.id && (a.writer || b.writer)) {
      // Display names can be stamped by the server. Only an exact operation,
      // exact words and the captured actor can acknowledge an optimistic reply.
      var left = messageWriter(a), right = messageWriter(b);
      return a.id === b.id && !!left && left === right && a.text === b.text && a.by === 'human' && b.by === 'human';
    }
    if (a.id && b.id) return a.id === b.id && canonicalWords(a.text) === canonicalWords(b.text) && a.author === b.author && a.by === b.by;
    if (reviewing() && (a.id || b.id)) return false;
    return a.created === b.created && a.author === b.author && a.text === b.text;
  }
  function canonicalWords(text) {
    return String(text || '').replace(/\r\n?/g, '\n').split('\n').map(function (line) { return line.trimEnd(); }).join('\n').trim();
  }
  function preserveCanonicalInput(server, local, storageKey) {
    local.forEach(function (thread) {
      var saved = server.filter(function (t) { return sameThread(t, thread); })[0];
      if (!saved) return;
      function retain(message, canonical, id) {
        if (message.text === canonical.text) return;
        // Never retire exact input until the account's recovery journal holds it.
        var journal = storageKey + '.canonical-input.' + id, raw = JSON.stringify(message);
        var earlier = global.localStorage.getItem(journal);
        if (earlier && earlier !== raw) journal += '.' + newComposerRecord(thread.anchor).id;
        global.localStorage.setItem(journal, raw);
      }
      if (saved.clientId || thread.id === saved.id) retain(thread, saved, thread.clientId || thread.id);
      thread.replies.forEach(function (r) {
        var accepted = r.id && saved.replies.filter(function (c) { return sameReply(c, r); })[0];
        if (accepted) retain(r, accepted, r.id);
      });
    });
  }
  function canonicalAnchor(anchor) {
    anchor = anchor || {};
    var out = { quote: anchor.quote || '', prefix: anchor.prefix || '', suffix: anchor.suffix || '', blockText: anchor.blockText || '', version: anchor.version || '' };
    var more = anchorParts(anchor.more);
    if (more.length) out.more = more;
    return out;
  }
  /* A passage over paragraphs. Its part in the first paragraph is an ordinary one-paragraph
     anchor, so a reader that knows only those still places it there; `more` holds one part per
     following paragraph, {quote, suffix, blockText}, at most ten. serve.py comment_parts() and
     the Worker's anchorParts() keep the same parts. */
  function anchorParts(more) {
    return (Array.isArray(more) ? more : []).filter(function (p) { return p && typeof p.quote === 'string' && p.quote; }).slice(0, 10)
      .map(function (p) { return { quote: p.quote, suffix: typeof p.suffix === 'string' ? p.suffix : '', blockText: typeof p.blockText === 'string' ? p.blockText : '' }; });
  }
  // The passage's words, one paragraph per line.
  function passageOf(anchor) {
    return [anchor.quote || ''].concat(anchorParts(anchor.more).map(function (p) { return p.quote; })).join('\n');
  }
  // `texts`: the rendered paragraphs from the first to the last; `from` and `to`: where the
  // selection starts in the first and ends in the last. An empty end part (a triple click ends
  // at the start of the next paragraph) is no part: one part left is the anchor of before.
  function spanAnchor(texts, from, to, version) {
    var parts = [];
    texts.forEach(function (text, i) {
      var raw = text.slice(i ? 0 : from, i === texts.length - 1 ? to : text.length), quote = raw.trim();
      if (quote) parts.push({ quote: quote, at: (i ? 0 : from) + raw.indexOf(quote), text: text });
    });
    if (!parts.length) return null;
    function after(p) { return p.text.slice(p.at + p.quote.length, p.at + p.quote.length + 32); }
    var first = parts[0], more = anchorParts(parts.slice(1).map(function (p) { return { quote: p.quote, suffix: after(p), blockText: p.text }; }));
    var anchor = { quote: first.quote, prefix: first.text.slice(Math.max(0, first.at - 32), first.at), suffix: after(first), blockText: first.text, version: version };
    if (more.length) anchor.more = more;
    return anchor;
  }
  // A passage's later parts, each in one of the next three paragraphs after the part before it.
  // A part no longer there ends the passage at the part before it. Where its words occur more than
  // once, the paragraph it was made in (its text unchanged) wins, then the words that go on as they
  // did (its suffix), then the nearest, so the same words in a paragraph put in between never take it.
  function resolveParts(more, blocks, firstId) {
    var out = [], at = -1;
    for (var i = 0; i < blocks.length; i++) if (blocks[i].id === firstId) { at = i; break; }
    if (at < 0) return out;
    anchorParts(more).every(function (part) {
      var best = null;
      for (var j = at + 1; j < blocks.length && j <= at + 3; j++) {
        var text = blocks[j].text;
        for (var start = text.indexOf(part.quote); start >= 0; start = text.indexOf(part.quote, start + 1)) {
          var score = (part.blockText && text === part.blockText ? 2 : 0) +
            (part.suffix && text.slice(start + part.quote.length).indexOf(part.suffix) === 0 ? 1 : 0);
          if (!best || score > best.score) best = { score: score, j: j, start: start };
        }
      }
      if (!best) return false;
      out.push({ blockId: blocks[best.j].id, start: best.start, end: best.start + part.quote.length }); at = best.j;
      return true;
    });
    return out;
  }
  // Where a resolved passage ends: its last part, or its only one.
  function passageEnd(r) { return r && r.more && r.more.length ? r.more[r.more.length - 1] : r; }
  function legacyCandidate(kind, thread, message, index, original) {
    if (kind === 'reply') return { kind: kind, threadId: thread.id, index: index,
      ...(original ? { original: original } : {}),
      message: { author: message.author, text: message.text, created: message.created, by: message.by, basis: message.basis || '', offer: message.offer || null } };
    return { kind: kind, ...(original ? { original: original } : {}), thread: { id: thread.id, anchor: thread.anchor, author: thread.author, by: thread.by,
      text: thread.text, created: thread.created, done: thread.done, status: thread.status, note: thread.note,
      reanchoredFrom: thread.reanchoredFrom, refersTo: thread.refersTo } };
  }
  function legacyHolds(local, server, validateChoice) {
    if (!roleConfirmed() || !reviewing()) return [];
    var held = [];
    function consider(kind, thread, message, candidates) {
      if ((!candidates.length && !message.legacyReconciliation) || !composerIdentityKnown(message)) return;
      if (validateChoice && !candidates.length) return;
      var intent = message.legacyReconciliation;
      if (intent && candidates.some(function (c) { return JSON.stringify(c) === JSON.stringify(intent.candidate); })) return;
      held.push({ kind: kind, thread: thread, message: message, candidates: candidates.length ? candidates : [message.legacyReconciliation.candidate] });
    }
    local.forEach(function (t) {
      if (t.pending) {
        var candidates = [];
        server.forEach(function (c) {
          var originals = c.legacyMessages ? c.legacyMessages.filter(function (m) { return m.kind === 'thread'; }) : (!c.clientId ? [c] : []);
          originals.forEach(function (m) {
            if (m.author === t.author && m.by === t.by && canonicalWords(m.text) === canonicalWords(t.text) && JSON.stringify(canonicalAnchor(m.anchor)) === JSON.stringify(canonicalAnchor(t.anchor)))
              candidates.push(legacyCandidate('thread', c, null, null, m.commentId ? m : null));
          });
        });
        consider('thread', t, t, candidates);
        return;
      }
      var saved = server.filter(function (c) { return c.id === t.id; })[0];
      if (!saved) return;
      t.replies.forEach(function (r) {
        if (saved.replies.some(function (c) { return sameReply(c, r); })) return;
        var candidates = saved.legacyMessages ? saved.legacyMessages.filter(function (m) {
          return m.kind === 'reply' && m.author === r.author && m.by === r.by && canonicalWords(m.text) === canonicalWords(r.text);
        }).map(function (m) { return legacyCandidate('reply', saved, m, -1, m); }) : saved.replies.map(function (c, i) {
          return !c.id && c.author === r.author && c.by === r.by && canonicalWords(c.text) === canonicalWords(r.text) ? legacyCandidate('reply', saved, c, i) : null;
        }).filter(Boolean);
        consider('reply', t, r, candidates);
      });
    });
    return held;
  }
  function holdLegacy(local, storageKey) {
    if (!legacyHolds(local, S.serverCopies[storageKey] || []).length) return false;
    if (Castor.comments) Castor.comments.durable = false;
    if (Castor.bus && Castor.bus.emit) Castor.bus.emit('comments:unsaved', { path: storablePath(),
      held: true, reason: 'Choose how to reconcile the saved and pending words in Comments. Both copies are kept on this device.' });
    return true;
  }
  var saveVersions = {}, threadReceipts = {};
  function submittedRecords(storageKey) {
    var records = [], prefix = storageKey + '.submitted.';
    // Every message has its own durable copy. A bucket read/merge/write cannot
    // protect another tab's words when its read races that tab's write.
    for (var i = 0; i < global.localStorage.length; i++) {
      var journal = global.localStorage.key(i);
      if (!journal || journal.indexOf(prefix) !== 0 || /\.recovered\.[a-f0-9]{64}$/.test(journal)) continue;
      try {
        var record = JSON.parse(global.localStorage.getItem(journal));
        if (record && record.thread && record.message && composerRecoveryAllowed(record.message))
          records.push({ key: journal, record: record });
      } catch (e) { /* Preserve unreadable copies rather than guessing. */ }
    }
    return records;
  }
  function retainSubmitted(threads, storageKey) {
    var server = S.serverCopies[storageKey] || [];
    threads.forEach(function (t) {
      var saved = server.filter(function (c) { return sameThread(c, t); })[0];
      function retain(message, reply) {
        if (!message.id || !composerIdentityKnown(message)) return;
        var head = Object.assign({}, t, { replies: reply ? [message] : [] });
        var input = S.composer && sentId(S.composer.record) === message.id ? S.composer.record.text : message.text;
        var record = { thread: head, message: reply ? message : head, reply: reply, input: input };
        var journal = storageKey + '.submitted.' + encodeURIComponent(message.id);
        var previous = global.localStorage.getItem(journal);
        // Do not let a second tab with a divergent copy replace the first input.
        if (previous) {
          var prior = JSON.parse(previous);
          if (JSON.stringify(prior.message) === JSON.stringify(record.message)) return;
          journal += '.' + newComposerRecord(t.anchor).id;
        }
        global.localStorage.setItem(journal, JSON.stringify(record));
      }
      if (t.pending && !saved) retain(t, false);
      t.replies.forEach(function (r) {
        if (!saved || !saved.replies.some(function (c) { return sameReply(c, r); })) retain(r, true);
      });
    });
  }
  function reconciledThread(thread, storageKey) {
    var seen = {};
    // The durable choice applies to stale buckets as well as independent child
    // journals. A failed following bucket write cannot reverse that choice.
    while (thread.pending && !seen[thread.id]) {
      seen[thread.id] = true;
      var choice = JSON.parse(global.localStorage.getItem(storageKey + '.reconciliation.' + (thread.clientId || thread.id)) || 'null');
      if (!choice || !choice.replacement) break;
      thread = Object.assign({}, choice.replacement, { replies: thread.replies });
    }
    return thread;
  }
  function reconciledThreads(threads, storageKey) {
    var joined = [];
    threads.forEach(function (thread) {
      joined = mergeLocal(joined, [reconciledThread(thread, storageKey)]);
    });
    return joined;
  }
  function submittedThread(record, storageKey) {
    // Keep the original child bytes/identity unchanged until acknowledgement.
    return record.reply ? reconciledThread(record.thread, storageKey) : record.thread;
  }
  function settleSubmitted(server, storageKey, held) {
    submittedRecords(storageKey).forEach(function (entry) {
      var record = entry.record, message = record.message;
      var context = submittedThread(record, storageKey);
      var receipts = threadReceipts[storageKey] || {};
      var saved = server.filter(function (t) {
        return sameThread(t, context) || (receipts[context.id] === t.id &&
          canonicalWords(t.text) === canonicalWords(context.text) &&
          JSON.stringify(canonicalAnchor(t.anchor)) === JSON.stringify(canonicalAnchor(context.anchor)));
      })[0];
      var accepted = record.reply ? saved && saved.replies.filter(function (r) { return sameReply(r, message); })[0] : saved;
      try {
        if (accepted) {
          if (record.input !== accepted.text) {
            var raw = JSON.stringify(Object.assign({}, message, { text: record.input }));
            var journal = storageKey + '.canonical-input.' + encodeURIComponent(message.id);
            var prior = global.localStorage.getItem(journal);
            if (prior && prior !== raw) journal += '.' + newComposerRecord(record.thread.anchor).id;
            global.localStorage.setItem(journal, raw);
          }
          global.localStorage.removeItem(entry.key);
        } else if (held && !record.held) {
          // A refusal is not acknowledgement. Keep this independent copy for
          // recovery, without putting a refused batch back into automatic retry.
          record.held = true;
          global.localStorage.setItem(entry.key, JSON.stringify(record));
        }
      } catch (e) { /* Failure to retire a journal only retains recovery. */ }
    });
  }
  function localThreads(storageKey) {
    var local = [];
    try { local = JSON.parse(global.localStorage.getItem(storageKey) || '[]').map(normalise); }
    catch (e) { /* Independent journals still recover an unreadable bucket. */ }
    try {
      local = reconciledThreads(local, storageKey);
      submittedRecords(storageKey).forEach(function (entry) {
        var record = entry.record;
        if (record.held || global.localStorage.getItem(storageKey + '.reconciliation.' + (record.message.clientId || record.message.id))) return;
        local = mergeLocal(local, [normalise(submittedThread(record, storageKey))]);
      });
    } catch (e) { /* The current page retains its own input. */ }
    return local;
  }
  function accountLocal(storageKey, server) {
    var local = localThreads(storageKey), identity = roleConfirmed() && reviewerIdentity(Castor.role);
    if (!identity || !reviewing() || key() !== storageKey) return local;
    var importedKey = storageKey + '.legacy-imported', imported, legacy;
    try {
      imported = JSON.parse(global.localStorage.getItem(importedKey) || '[]');
      legacy = JSON.parse(global.localStorage.getItem(legacyKey()) || '[]');
      if (!Array.isArray(imported) || !Array.isArray(legacy)) return local;
    } catch (e) { return local; }
    function owned(message) { return message.reviewer === true && sameReviewer(message.reviewerIdentity, identity); }
    var added = [], changed = false;
    legacy.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      var target, head = JSON.stringify(['thread', Object.assign({}, raw, { replies: [] })]);
      if (raw.pending) {
        if (!owned(raw)) return;
        target = local.filter(function (t) { return t.legacyHead === head; })[0];
        if (imported.indexOf(head) < 0) {
          if (!target) {
            target = normalise(Object.assign({}, raw, { replies: [], legacyHead: head }));
            if (local.some(function (t) { return t.id === target.id; })) target.id = newComposerRecord(raw.anchor).id;
            local.push(target);
          }
          added.push(head); changed = true;
        }
      } else {
        target = local.filter(function (t) { return t.id === raw.id && !t.pending; })[0];
        if (!target) {
          var canonical = (server || []).filter(function (t) { return t.id === raw.id; })[0];
          if (canonical) target = normalise(canonical);
        }
      }
      // An old cached head proves no access. Import its owned replies only
      // after this account's server response (or scoped cache) confirms it.
      if (!target) return;
      (Array.isArray(raw.replies) ? raw.replies : []).forEach(function (reply) {
        if (!reply || !owned(reply)) return;
        var receipt = JSON.stringify(['reply', head, reply]);
        if (imported.indexOf(receipt) >= 0) return;
        var message = normalise({ replies: [reply] }).replies[0];
        if (!target.replies.some(function (r) { return sameReply(r, message); })) target.replies.push(message);
        if (local.indexOf(target) < 0) local.push(target);
        added.push(receipt); changed = true;
      });
    });
    if (changed) {
      // Persist the copy before its import receipts, and never POST it until
      // both writes hold. The legacy source remains byte-for-byte untouched.
      try {
        global.localStorage.setItem(storageKey, JSON.stringify(local));
        global.localStorage.setItem(importedKey, JSON.stringify(imported.concat(added)));
        delete S.migrationBlocked;
      } catch (e) { S.migrationBlocked = storageKey; }
    }
    return local;
  }
  function mergeLocal(local, stored) {
    var joined = local.map(function (t) { return Object.assign({}, t, { replies: t.replies.slice() }); });
    stored.forEach(function (t) {
      var here = joined.filter(function (s) { return sameThread(s, t); })[0];
      if (!here) { joined.push(t); return; }
      t.replies.forEach(function (r) { if (!here.replies.some(function (s) { return sameReply(s, r); })) here.replies.push(r); });
    });
    return joined;
  }
  function outgoingNow(outgoing, storageKey) {
    var server = S.serverCopies[storageKey] || [], receipts = threadReceipts[storageKey] || {};
    return outgoing.map(function (t) {
      var id = receipts[t.id] || t.id;
      var there = server.filter(function (s) { return s.id === id || s.clientId === id; })[0];
      if (!there) return t;
      if (t.pending && !sameThread(t, there) && !sameThread(Object.assign({}, t, { id: id }), there)) return t;
      var replies = there.replies.slice();
      t.replies.forEach(function (r) { if (!replies.some(function (s) { return sameReply(s, r); })) replies.push(r); });
      return Object.assign({}, t.pending ? there : t, { id: id, pending: false, replies: replies });
    });
  }
  function load(poll) {
    if (!available()) return [];
    enterScope();
    var local = null;
    var storageKey = key();
    var request = S.loadEpoch = (S.loadEpoch || 0) + 1;
    try {
      local = accountLocal(storageKey, S.serverCopies[storageKey]);
      var raw = global.localStorage && global.localStorage.getItem(storageKey);
      if (raw) {
        var v = JSON.parse(raw);
        local = Array.isArray(v) ? mergeLocal(reconciledThreads(v.map(normalise), storageKey), local || []) : local;
        if (global.localStorage.getItem(storageKey + '.unsaved') && Castor.bus && Castor.bus.emit) {
          Castor.bus.emit('comments:pending', { path: storablePath() });
        }
      }
    } catch (e) { local = null; }
    var path = storablePath();
    if (!path) return local;
    global.fetch(commentReadUrl(path), { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('comments did not load');
        return response.json();
      })
      .then(function (payload) {
        if (!available() || key() !== storageKey || S.loadEpoch !== request || (poll && refreshPaused())) return;
        var threads = Array.isArray(payload) ? payload : payload && payload.threads;
        if (!Array.isArray(threads)) throw new Error('comments had the wrong shape');
        var actionWasPending=actionPending();acceptCapabilities(payload,storageKey);threads=threads.map(function(t){var fresh=preserveActionProjection(t,storageKey);if(fresh.actions||fresh.statusActions)rememberActionProjection(normalise(fresh),storageKey);return fresh;});
        var held = heldIds(payload), lastKnown = S.serverCopies[storageKey];
        var confirmed = function () { return keepHeld(canonicalThreads(threads,storageKey), held, lastKnown); };
        if (poll && !S.retryReads[storageKey] && JSON.stringify(confirmed()) === JSON.stringify(S.lastServer) && actionWasPending===actionPending()) return;
        var authenticated = !payload.offline && roleConfirmed() && (!reviewing() || !!reviewerIdentity(Castor.role));
        try {
          var current = global.localStorage && global.localStorage.getItem(storageKey);
          if (current !== (raw || null)) return;
        } catch (e) { /* no local copy can have changed */ }
        S.lastServer = confirmed();
        S.serverCopies[storageKey] = S.lastServer;
        settleSubmitted(S.lastServer, storageKey);
        var legacy = accountLocal(storageKey, confirmed());
        var fresh = mergeServer(confirmed(), null, mergeLocal(S.threads, legacy), storageKey, undefined, held);
        S.threads = fresh.threads;
        if (Castor.comments) Castor.comments.durable = authenticated && !fresh.unsent && !actionPending();
        try {
          global.localStorage && global.localStorage.setItem(storageKey, JSON.stringify(S.threads));
        } catch (e) { /* the API copy is durable */ }
        if (storageKey === key() && actionCapability()) S.lastServer.forEach(function (t) {
          [t].concat(t.replies || []).forEach(function (m) { if (m.actions) consolidateEditDrafts(t, m); });
        });
        layout();
        var linked = global.location && /[?&]thread=([A-Za-z0-9_:-]+)(?:&|$)/.exec(global.location.search || '');
        if (linked && S.linkOpened !== storageKey + ':' + linked[1] && byId(linked[1])) {
          S.linkOpened = storageKey + ':' + linked[1];
          if (Castor.panels && Castor.panels.open) Castor.panels.open('comments');
          open(linked[1]);
        }
        if (fresh.unsent) { if (!holdLegacy(S.threads, storageKey)) save(); }
        else if (!unsavedWords(S.threads, S.lastServer).length) {
          delete S.retryReads[storageKey];
          try { global.localStorage.removeItem(storageKey + '.unsaved'); } catch (e) { /* the server confirmed it */ }
          if (authenticated && !actionPending() && Castor.bus && Castor.bus.emit) Castor.bus.emit('comments:saved', { path: path });
        }
      })
      .catch(function () {
        if (key() !== storageKey || S.loadEpoch !== request) return;
        if (poll && S.retryReads[storageKey]) deferCommentRetry(storageKey);
        if (!poll && Castor.comments) {
          Castor.comments.durable = false;
          if (reviewing() && Castor.bus && Castor.bus.emit) Castor.bus.emit('comments:unavailable', { path: path, reason: 'The review service could not confirm your comments. Reconnect and reopen this article.' });
        }
      });
    return local;
  }
  function deferCommentRetry(storageKey) {
    var previous = S.retryReads[storageKey], attempts = previous ? previous.attempts + 1 : 1;
    S.retryReads[storageKey] = { attempts: attempts, at: Date.now() + Math.min(60000, 5000 * Math.pow(2, attempts - 1)) };
  }
  function creationCanRefresh() {
    var retry = S.retryReads[key()];
    return !!(retry && retry.at <= Date.now() && roleConfirmed() && available());
  }
  function refreshPaused() {
    return DOC.hidden || S.composer || S.actionEditor || (!Castor.comments.durable && !actionCanRefresh() && !creationCanRefresh()) ||
      (DOC.activeElement && DOC.activeElement.tagName === 'TEXTAREA');
  }
  function refresh() {
    if (!storablePath() || refreshPaused()) return;
    load(true);
  }

  function pendingMessages(threads, storageKey) {
    var server = S.serverCopies[storageKey] || [], messages = [];
    threads.forEach(function (t) {
      if (!/^\d+$/.test(String(t.id)) && !t.pending) return;
      var there = server.filter(function (s) { return sameThread(s, t); })[0];
      if (!there && t.pending) messages.push(t);
      (t.replies || []).forEach(function (r) {
        if (!there || !there.replies.some(function (s) { return sameReply(s, r); })) messages.push(r);
      });
    });
    return messages;
  }
  function reviewerIdentity(role) {
    if (!role || !(role.reviewer || role.role === 'reviewer')) return null;
    var id = typeof role.id === 'string' ? role.id : '';
    var email = typeof role.email === 'string' ? role.email.toLowerCase() : '';
    var name = typeof role.name === 'string' ? role.name : '';
    return id ? { id: id, email: email, name: name } : null;
  }
  function sameReviewer(stored, current) {
    if (!stored || !current) return false;
    return !!stored.id && stored.id === current.id;
  }
  function pendingIdentityKnown(messages, reviewer, identity) {
    return messages.every(function (m) {
      return reviewer ? m.reviewer === true && sameReviewer(m.reviewerIdentity, identity) : m.reviewer === false && isWriter(m.principal);
    });
  }

  var COMMENT_TIMEOUT = 15000;
  // Bound both the connection and its body. A timeout can still have committed:
  // pending operation ids stay intact for reconciliation, never a fresh send.
  function commentRequest(url, init) {
    return new Promise(function (resolve, reject) {
      var controller = null, done = false;
      try { controller = new global.AbortController(); } catch (e) { /* timeout still releases the queue */ }
      var timer = setTimeout(function () {
        finish(new Error('The server is taking longer than usual. Your words stay on this device.'));
        if (controller) controller.abort();
      }, COMMENT_TIMEOUT);
      function finish(error, response) {
        if (done) return;
        done = true; clearTimeout(timer);
        if (error) reject(error); else resolve(response);
      }
      Promise.resolve().then(function () {
        return global.fetch(url, Object.assign({}, init || {}, controller ? { signal: controller.signal } : {}));
      }).then(function (response) {
        function complete(body) {
          var copy = { ok: response.ok, status: response.status, json: function () { return Promise.resolve(body); } };
          copy.clone = function () { return copy; };
          finish(null, copy);
        }
        // Identity refusals are status-only; an optional error page must not delay sign-out.
        if (url === '/api/whoami' && !response.ok) { complete({}); return; }
        return response.json().then(complete);
      }).catch(function (error) { finish(error); });
    });
  }

  function save() {
    if (!available()) return false;
    switchScope();
    var storageKey = key();
    var threads;
    try {
      S.threads = reconciledThreads(S.threads.map(normalise), storageKey);
      // Persist before the shared bucket's first read, including a read that
      // another tab can overtake. The composer is only retired after this write.
      retainSubmitted(S.threads, storageKey);
      threads = mergeLocal(S.threads, accountLocal(storageKey, S.serverCopies[storageKey]));
      global.localStorage.setItem(storageKey, JSON.stringify(threads));
    } catch (e) { return false; }
    S.threads = threads;
    var path = storablePath();
    if (!path) return true;
    var reviewer = reviewing();
    var readerAccount = reviewer && roleConfirmed() ? reviewerIdentity(Castor.role) : null;
    var writerAccount = !reviewer && Castor.role.publicWriter ? Castor.role.id : '';
    function headForWire(t) { var copy = Object.assign({}, t); delete copy.legacyHead; return copy; }
    var canonical = S.serverCopies[storageKey];
    if (roleConfirmed() && (!reviewer || readerAccount) && canonical &&
        JSON.stringify(threads.map(headForWire)) === JSON.stringify(canonical.map(headForWire))) {
      if (Castor.comments) Castor.comments.durable = !actionPending();
      try { global.localStorage.removeItem(storageKey + '.unsaved'); } catch (e) { /* a later load confirms it */ }
      return true;
    }
    if (Castor.comments) Castor.comments.durable = false;
    var token = Date.now().toString(36) + Math.random().toString(36).slice(2);
    try { global.localStorage.setItem(storageKey + '.unsaved', token); } catch (e) { /* the thread copy remains */ }
    /* A comment that stays here says it is waiting on this device; one sent below is saving.
       A path that names its own reason (comments:unsaved) needs neither. */
    function kept() { if (Castor.bus && Castor.bus.emit) Castor.bus.emit('comments:pending', { path: path }); return true; }
    if (driven()) return kept();
    var who = (Castor.who && Castor.who.get) ? Castor.who.get() : '';
    /* A reviewer is not asked and sends no name: the server records their
       comments under the name they signed in with, whatever the page says. */
    if (!roleConfirmed()) {
      if (Castor.bus && Castor.bus.emit) Castor.bus.emit('comments:unsaved', { path: path, reason: 'Checking your sign-in. Your words stay on this device and are sent once you are confirmed.' });
      if (!reviewer && Castor.reconfirm) Castor.reconfirm();
      return true;
    }
    if (S.migrationBlocked === storageKey) return kept();
    if (holdLegacy(threads, storageKey)) return true;
    if (!who && !reviewer) {
      if (Castor.who && Castor.who.ask) Castor.who.ask();
      return kept();
    }
    if (!reviewer && !pendingIdentityKnown(pendingMessages(threads, storageKey), false, null)) {
      if (Castor.bus && Castor.bus.emit) Castor.bus.emit('comments:unsaved', { path: path, reason: 'The original writer of these pending words is unknown or unavailable. Your words remain on this device.' });
      return true;
    }
    if (!reviewer) {
      var principals = [];
      threads.forEach(function (t) {
        var server = (S.serverCopies[storageKey] || []).filter(function (s) { return sameThread(s, t); })[0];
        var messages = (t.pending ? [t] : []).concat(t.replies.filter(function (r) {
          return !server || !server.replies.some(function (s) { return sameReply(s, r); });
        }));
        messages.forEach(function (m) {
          if (isWriter(m.principal) && principals.indexOf(m.principal) < 0) principals.push(m.principal);
        });
      });
      if (principals.length > 1) {
        if (Castor.bus && Castor.bus.emit) Castor.bus.emit('comments:unsaved', { path: path, reason: 'Pending comments have different writers. Their words remain on this device.' });
        return true;
      }
      if (principals.length) who = principals[0];
    }
    if (Castor.bus && Castor.bus.emit) Castor.bus.emit('comments:pending', { path: path, sending: true });
    var revision = saveVersions[storageKey] = (saveVersions[storageKey] || 0) + 1;
    var snapshot = JSON.stringify(S.threads);
    var outgoing = JSON.parse(snapshot).filter(function (t) { return /^\d+$/.test(String(t.id)) || t.pending; });
    var sent = {};
    function refreshReviewer() {
      if (!reviewer) return Promise.resolve();
      if (!roleConfirmed() || !sameReviewer(readerAccount, reviewerIdentity(Castor.role))) return Promise.reject(new Error('Sign in as the original reader to send these comments.'));
      // Other tabs and lost responses can leave the saved prefix ahead of this tab.
      return commentRequest(commentReadUrl(path), { cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('comments did not reload before retry');
          return response.json();
        }).then(function (payload) {
          if (!roleConfirmed() || !sameReviewer(readerAccount, reviewerIdentity(Castor.role))) throw new Error('Sign in as the original reader to send these comments.');
          var threads = Array.isArray(payload) ? payload : payload && payload.threads;
          if (!Array.isArray(threads)) throw new Error('comments had the wrong shape');
          S.serverCopies[storageKey] = canonicalThreads(threads,storageKey);
        });
    }
    save.pending = (save.pending || Promise.resolve()).then(refreshReviewer).then(function () {
      var sending = outgoingNow(outgoing, storageKey);
      if (reviewer && holdLegacy(sending, storageKey)) {
        var ambiguous = new Error('Choose how to reconcile the saved and pending words in Comments. Both copies are kept on this device.');
        ambiguous.reason = 'legacy-reconciliation-required'; throw ambiguous;
      }
      var knownIds = {};
      (S.serverCopies[storageKey] || []).concat(sending.filter(function (t) { return !t.pending; }))
        .forEach(function (t) { knownIds[t.id] = true; });
      function post(retried) {
        var authenticate = commentRequest('/api/whoami', { cache: 'no-store' }).then(function (response) {
          if (!response.ok) {
            // Cards repaint without Reply and actions once the session has ended (S.ended in their signatures).
            if (!reviewer && (response.status === 401 || response.status === 403) && Castor.signedOut) { Castor.signedOut(); S.ended = ended(); }
            throw new Error(reviewer ? 'Your reader identity could not be confirmed. Your words remain on this device.'
              : 'Your sign-in could not be confirmed just now. Your words stay on this device and are sent again.');
          }
          return response.json();
        }).then(function (role) {
          if (!reviewer) {
            if (!role || role.role !== 'founder' || !roleConfirmed() ||
                (writerAccount && (role.id !== writerAccount || Castor.role.id !== writerAccount || role.who !== who)) ||
                !pendingIdentityKnown(pendingMessages(sending, storageKey), false, null)) {
              throw new Error('Your sign-in or the original writer could not be confirmed. Your words remain on this device.');
            }
            return null;
          }
          var identity = reviewerIdentity(role);
          if (!sameReviewer(readerAccount, identity) || !pendingIdentityKnown(pendingMessages(sending, storageKey), true, identity)) {
            throw new Error('These pending words belong to another or unknown reader. Your words remain on this device.');
          }
          return identity;
        });
        return authenticate.then(function (identity) {
          var wire = sending.map(headForWire);
          var body = reviewer ? { path: path, threads: wire, reviewer_id: identity.id } : { path: path, threads: wire, who: who, agent_delivery: 'manual' };
          return commentRequest('/api/comments', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
          }).then(function (response) {
            if (!reviewer || retried || [403, 409].indexOf(response.status) < 0) return response;
            var copy = response.clone ? response.clone() : response;
            return copy.json().catch(function () { return {}; }).then(function (refusal) {
              if (refusal.reason !== 'reviewer-cannot-edit' && refusal.reason !== 'concurrent-save') return response;
              return refreshReviewer().then(function () { sending = outgoingNow(outgoing, storageKey); return post(true); });
            });
          });
        });
      }
      return post(false).then(function (response) {
        if (!response.ok) {
          return response.json().catch(function () { return {}; }).then(function (body) {
            var refused = new Error((body && (body.error || body.reason)) || 'the server refused it');
            refused.status = response.status;
            refused.reason = (body && body.reason) || '';
            throw refused;
          });
        }
        return response.json();
      }).then(function (payload) {
        var threads = payload && payload.threads;
        if (!Array.isArray(threads)) throw new Error('comments had the wrong shape');
        var current = null;
        try { current = global.localStorage && global.localStorage.getItem(storageKey); }
        catch (e) { current = snapshot; }
        var held = heldIds(payload);
        var confirmed = keepHeld(canonicalThreads(threads,storageKey), held, S.serverCopies[storageKey]);
        var active = available() && key() === storageKey;
        var local = active ? mergeLocal(S.threads, localThreads(storageKey)) : null;
        if (!local) {
          try { local = JSON.parse(current || snapshot); }
          catch (e) { local = JSON.parse(snapshot); }
        }
        var receipts = threadReceipts[storageKey] || (threadReceipts[storageKey] = {});
        var claimed = {};
        outgoing.forEach(function (t, index) {
          var actual = sending[index];
          var match = confirmed.filter(function (c) { return (c.id === actual.id || c.clientId === actual.id) && sameThread(c, actual); })[0];
          if (!match && t.pending) match = confirmed.filter(function (c) {
            return !c.clientId && c.by === t.by && !knownIds[c.id] && !claimed[c.id] && (!!messageWriter(t) && messageWriter(c) === messageWriter(t)) && c.text === t.text &&
              JSON.stringify(c.anchor) === JSON.stringify(actual.anchor);
          })[0];
          if (match) {
            receipts[t.id] = match.id;
            claimed[match.id] = true;
            if (t.pending) sent[t.id] = match.id;
          }
        });
        settleSubmitted(confirmed, storageKey);
        var merged = mergeServer(confirmed, sent, local, storageKey, outgoing, held);
        var updated = merged.threads;
        try {
          global.localStorage && global.localStorage.setItem(storageKey, JSON.stringify(updated));
        } catch (e) { /* the API copy is durable */ }
        S.serverCopies[storageKey] = confirmed;
        delete S.retryReads[storageKey];
        if (merged.unsent && revision === saveVersions[storageKey] && Castor.bus && Castor.bus.emit) {
          // A comment the server held is named, with why; any other refusal reads as it always does.
          var named = (Array.isArray(payload.refused) ? payload.refused : []).map(function (r) { return r && r.error; }).filter(Boolean);
          Castor.bus.emit('comments:unsaved', { path: path, reason: named.length ? String(named.join(' ')).slice(0, 300) : 'The server did not confirm this exact comment. Your original words remain on this device.' });
        }
        if (revision === saveVersions[storageKey] && !merged.unsent) {
          var own = false;
          try {
            own = global.localStorage.getItem(storageKey + '.unsaved') === token;
            if (own) global.localStorage.removeItem(storageKey + '.unsaved');
          } catch (e) { /* a later load checks the server */ }
          if (own && (!reviewer || sameReviewer(readerAccount, reviewerIdentity(Castor.role))) && !actionPending(reviewer ? storageKey : undefined, reviewer ? path : undefined) && Castor.bus && Castor.bus.emit) Castor.bus.emit('comments:saved', { path: path });
        }
        if (!active) return;
        S.lastServer = confirmed;
        S.threads = updated;
        schedule();
        if (Castor.comments) Castor.comments.durable = !merged.unsent && !actionPending();

      });
    }).catch(function (error) {
      var transient = !error.status || error.status >= 500 || error.status === 429 || error.reason === 'busy' || error.reason === 'concurrent-save';
      if (transient) deferCommentRetry(storageKey);
      else delete S.retryReads[storageKey];
      if (available() && key() === storageKey && Castor.comments) Castor.comments.durable = false;
      if (reviewer && error && error.status >= 400 && error.status < 500 && (!transient || error.reason === 'too-many-threads') && error.reason !== 'reviewer-identity-mismatch' && error.reason !== 'legacy-reconciliation-required') {
        return refusedForReviewer(path, error, storageKey, readerAccount);
      }
      /* A comment that did not reach the repository is kept in this browser and
         sent again on the next change, but the writer is told, never left to
         believe it is shared. */
      if (Castor.bus && Castor.bus.emit) {
        Castor.bus.emit('comments:unsaved', { path: path, held: error.reason === 'legacy-reconciliation-required', reason: String((error && error.message) || error).slice(0, 300) });
      }
    });
    if (Castor.saveStatus) save.pending = Castor.saveStatus.track(save.pending);
    return true;
  }

  /* What this browser holds that the server does not: new threads and new
     replies, as the words the reviewer typed. */
  function unsavedWords(local, server) {
    var out = [];
    local.forEach(function (t) {
      if (t.pending) { if (t.text) out.push(t.text); return; }
      var there = null;
      for (var i = 0; i < server.length; i++) if (server[i].id === t.id) there = server[i];
      (t.replies || []).forEach(function (r) {
        if (r.text && !(there && there.replies || []).some(function (s) { return sameReply(s, r); })) out.push(r.text);
      });
    });
    return out;
  }

  function refusedForReviewer(path, error, storageKey, readerAccount) {
    storageKey = storageKey || key();
    if (readerAccount && (!roleConfirmed() || !sameReviewer(readerAccount, reviewerIdentity(Castor.role)))) return;
    var local = key() === storageKey ? S.threads.slice() : null;
    if (!local) {
      try { local = JSON.parse(global.localStorage.getItem(storageKey) || '[]'); }
      catch (e) { local = []; }
    }
    var settle = function (server) {
      local = mergeLocal(local, localThreads(storageKey));
      var words = unsavedWords(local, server);
      settleSubmitted(server, storageKey, true);
      try {
        var aside = storageKey + '.setaside';
        var had = JSON.parse(global.localStorage.getItem(aside) || '[]');
        global.localStorage.setItem(aside, JSON.stringify(had.concat(local.filter(function (t) { return unsavedWords([t], server).length; }))));
        global.localStorage.setItem(storageKey, JSON.stringify(server));
      } catch (e) { /* the server copy is the record */ }
      if (key() !== storageKey) return;
      S.threads = server.slice();
      schedule();
      if (Castor.bus && Castor.bus.emit) {
        Castor.bus.emit('comments:unsaved', {
          reason: String((error && error.message) || error).slice(0, 300),
          status: error.status, dropped: true, words: words
        });
      }
    };
    return global.fetch(commentReadUrl(path), { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('comments did not load');
        return response.json();
      })
      .then(function (payload) {
        if (readerAccount && (!roleConfirmed() || !sameReviewer(readerAccount, reviewerIdentity(Castor.role)))) return;
        var threads = Array.isArray(payload) ? payload : payload && payload.threads;
        if (!Array.isArray(threads)) throw new Error('comments had the wrong shape');
        var server = canonicalThreads(threads,storageKey);
        S.serverCopies[storageKey] = server;
        if (key() === storageKey) S.lastServer = server;
        settle(server);
      }, function () {
        if (readerAccount && (!roleConfirmed() || !sameReviewer(readerAccount, reviewerIdentity(Castor.role)))) return;
        var server = S.serverCopies[storageKey];
        if (server) settle(server.slice());
        else if (key() === storageKey && Castor.bus && Castor.bus.emit) {
          Castor.bus.emit('comments:unsaved', { path: path, reason: String((error && error.message) || error).slice(0, 300) });
        }
      });
  }

  function cleanHexColor(s) {
    if (typeof s !== 'string') return null;
    var c = s.trim();
    return /^#[0-9a-fA-F]{6}$/.test(c) ? c : null;
  }

  function normalise(t, i) {
    var col = cleanHexColor(t.color);
    return {
      id: t.id || ('c' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)),
      ...(t.legacyHead ? { legacyHead: t.legacyHead } : {}),
      ...(t.clientId ? { clientId: t.clientId } : {}),
      ...(t.legacyMessages ? { legacyMessages: t.legacyMessages } : {}),
      ...(t.legacyReconciliation ? { legacyReconciliation: t.legacyReconciliation } : {}),
      ...(t.actions ? { actions:JSON.parse(JSON.stringify(t.actions)) } : {}),
      ...(t.statusActions ? { statusActions:JSON.parse(JSON.stringify(t.statusActions)) } : {}),
      anchor: t.anchor || {},
      author: t.author || 'You',
      ...(typeof t.principal === 'string' && t.principal.trim() ? { principal: t.principal.trim() } : (t.principal ? { principal: t.principal } : {})),
      ...(typeof t.model === 'string' && t.model.trim() ? { model: t.model.trim() } : {}),
      ...(founderKey(t.onBehalfOf) ? { onBehalfOf: t.onBehalfOf } : {}),
      ...(col ? { color: col } : {}),
      ...(typeof t.writer === 'string' && t.writer ? { writer: t.writer } : {}),
      ...(typeof t.reviewer === 'boolean' ? { reviewer: t.reviewer } : {}),
      ...(t.reviewerIdentity ? { reviewerIdentity: t.reviewerIdentity } : {}),
      by: t.by === 'agent' ? 'agent' : (t.by === 'human' ? 'human' : ''),
      text: t.text || '',
      created: t.created || '',
      replies: (t.replies || []).map(function (r) {
        var rCol = cleanHexColor(r.color);
        return {
          ...(r.id ? { id: r.id } : {}),
          ...(r.legacyReconciliation ? { legacyReconciliation: r.legacyReconciliation } : {}),
          ...(typeof r.principal === 'string' && r.principal.trim() ? { principal: r.principal.trim() } : (r.principal ? { principal: r.principal } : {})),
          ...(typeof r.model === 'string' && r.model.trim() ? { model: r.model.trim() } : {}),
          ...(founderKey(r.onBehalfOf) ? { onBehalfOf: r.onBehalfOf } : {}),
          ...(rCol ? { color: rCol } : {}),
          ...(typeof r.writer === 'string' && r.writer ? { writer: r.writer } : {}),
          ...(typeof r.reviewer === 'boolean' ? { reviewer: r.reviewer } : {}),
          ...(r.reviewerIdentity ? { reviewerIdentity: r.reviewerIdentity } : {}),
          ...(r.actions ? { actions:JSON.parse(JSON.stringify(r.actions)) } : {}),
          author: r.author || 'You', text: r.text || '', created: r.created || '',
          by: r.by === 'agent' ? 'agent' : (r.by === 'human' ? 'human' : ''),
          basis: r.basis || '', offer: r.offer || null
        };
      }),
      done: !!t.done,
      status: t.status || (t.done ? 'answered' : 'open'),
      note: t.note || '',
      reanchoredFrom: t.reanchoredFrom || '',
      refersTo: t.refersTo || '',
      pending: !!t.pending
    };
  }

  /* ------------------------------------------------------- blocks and anchors */

  // A focused block contains both the visible mirror and the native editing host.
  // Anchors and their marks must use the same visible text, counted only once.
  function passageTextNode(block) {
    return (block.querySelector && block.querySelector('.cw-mirror')) || block;
  }

  // The page's blocks as the DOM has them. md.js is expected to emit data-block-id;
  // if a page does not carry ids at all we fall back to the page's own children so
  // the module still runs (dev pages, a world mid-build).
  function pageBlocks() {
    if (!S.page) return [];
    var nodes = S.page.querySelectorAll('.cw-block[data-block-id]');
    if (!nodes.length) nodes = S.page.querySelectorAll('[data-block-id],[data-block]');
    var out = [], i;
    if (nodes.length) {
      for (i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.closest('[data-castor-ui]')) continue;
        out.push({ id: n.getAttribute('data-block-id') || n.getAttribute('data-block'), el: n, text: passageTextNode(n).textContent });
      }
      return out;
    }
    var kids = S.page.children;
    for (i = 0; i < kids.length; i++) {
      if (kids[i].hasAttribute('data-castor-ui')) continue;
      out.push({ id: 'bi-' + i, el: kids[i], text: passageTextNode(kids[i]).textContent });
    }
    return out;
  }

  function blockById(id) {
    var bs = pageBlocks();
    for (var i = 0; i < bs.length; i++) if (bs[i].id === id) return bs[i];
    return null;
  }

  function similarity(a, b) {
    var A = words(a), B = words(b);
    if (!A.length || !B.length) return 0;
    var seen = Object.create(null), hit = 0, i;
    for (i = 0; i < A.length; i++) seen[A[i]] = (seen[A[i]] || 0) + 1;
    for (i = 0; i < B.length; i++) if (seen[B[i]] > 0) { seen[B[i]]--; hit++; }
    return (2 * hit) / (A.length + B.length);
  }

  // Which block does this anchor live in? md.js answers when it is loaded; otherwise
  // we score every block on quote / prefix / suffix / remembered block text.
  function quickContextScore(text, index, length, anchor) {
    var score = text === anchor.blockText ? 3 : 0;
    if (anchor.prefix) {
      var before = text.slice(Math.max(0, index - anchor.prefix.length), index);
      if (before === anchor.prefix) score += 2;
      else if (before.toLowerCase().endsWith(anchor.prefix.toLowerCase().slice(-16))) score += 1;
    }
    if (anchor.suffix) {
      var after = text.slice(index + length, index + length + anchor.suffix.length);
      if (after === anchor.suffix) score += 2;
      else if (after.toLowerCase().startsWith(anchor.suffix.toLowerCase().slice(0, 16))) score += 1;
    }
    return score;
  }

  // His notes are drawn for him (editor.js withNotes) and quoted by no one: a passage quoted
  // where they were hidden (a reviewer's page, notes off) is found in the words a reader reads,
  // and its place counted back in the drawn text. Only when the drawn text has no exact place.
  function resolveBlock(anchor, quick, blocks, restricted) {
    var r = resolveDrawn(anchor, quick, blocks, restricted);
    if (!anchor || !anchor.quote || (r && (r.ambiguous || Number.isInteger(r.start)))) return r;
    var hit = r && (blocks || pageBlocks()).filter(function (block) { return block.id === r.blockId; })[0];
    if (hit && hit.text.toLowerCase().indexOf(String(anchor.quote).toLowerCase()) >= 0) return r;
    return resolveWithoutNotes(anchor, blocks || pageBlocks()) || r;
  }
  function resolveWithoutNotes(anchor, blocks) {
    var quote = String(anchor.quote), hits = [];
    blocks.forEach(function (block) {
      var root = block.el && passageTextNode(block.el);
      if (!root || !root.querySelector || !root.querySelector('.writer-note')) return;
      var plain = readerText(root);
      for (var at = plain.text.indexOf(quote); at >= 0; at = plain.text.indexOf(quote, at + 1)) {
        hits.push({ blockId: block.id, start: plain.drawn[at], end: plain.drawn[at + quote.length - 1] + 1,
          score: quickContextScore(plain.text, at, quote.length, anchor) });
      }
    });
    hits.sort(function (a, b) { return b.score - a.score; });
    hits = hits.filter(function (hit) { return hit.score === hits[0].score; });
    return hits.length > 1 ? { ambiguous: true, candidates: hits } : hits[0] || null;
  }
  // The words a reader reads in a drawn block (editor.js readerText reads it the same way): his
  // notes and shown marks left out; drawn[j] is the drawn offset of reader character j.
  function readerText(root) {
    var text = '', at = [0], drawn = [], seen = 0;
    (function walk(node, hidden) {
      if (node.nodeType === 3) {
        var value = node.nodeValue || '';
        for (var i = 0; i < value.length; i++, seen++) { if (!hidden) { text += value.charAt(i); drawn.push(seen); } at.push(text.length); }
        return;
      }
      var kids = node.childNodes || [], name = typeof node.className === 'string' ? node.className : '';
      var skip = hidden || /(?:^| )(?:writer-note|cw-mk)(?: |$)/.test(name);
      for (var k = 0; k < kids.length; k++) walk(kids[k], skip);
    })(root, false);
    drawn.push(seen);
    return { text: text, at: at, drawn: drawn };
  }
  function resolveDrawn(anchor, quick, blocks, restricted) {
    if (!anchor || !anchor.quote) return null;
    var candidates = blocks || pageBlocks();
    if (!candidates.length) return null;
    if (quick) {
      var quote = String(anchor.quote), hits = [], foldedHits = [];
      candidates.forEach(function (block) {
        [quote, quote.toLowerCase()].forEach(function (needle, folded) {
          var text = folded ? block.text.toLowerCase() : block.text;
          var from = 0, index;
          while ((index = text.indexOf(needle, from)) >= 0) {
            (folded ? foldedHits : hits).push({ blockId: block.id, start: index, end: index + quote.length,
              score: quickContextScore(block.text, index, quote.length, anchor) });
            from = index + Math.max(1, quote.length);
          }
        });
      });
      hits = hits.length ? hits : foldedHits;
      hits.sort(function (a, b) { return b.score - a.score; });
      hits = hits.filter(function (hit) { return hit.score === hits[0].score; });
      return hits.length > 1 ? { ambiguous: true, candidates: hits } : hits[0] || null;
    }
    if (Castor.md && typeof Castor.md.resolveAnchor === 'function') {
      try {
        // Resolve against rendered blocks so every offered offset names the visible passage.
        var r = Castor.md.resolveAnchor({ blocks: candidates }, anchor);
        if (r && r.ambiguous) return r;
        if (r && candidates.some(function (block) { return block.id === r.blockId; })) return r;
      } catch (e) { /* fall through to the local search */ }
    }
    var bs = candidates, best = [], bestScore = 0;
    for (var i = 0; i < bs.length; i++) {
      var text = bs[i].text, score = 0;
      if (text.indexOf(anchor.quote) >= 0) score += 2;
      else if (text.toLowerCase().indexOf(String(anchor.quote).toLowerCase()) >= 0) score += 1.4;
      else score += similarity(anchor.quote, text) * 0.9;
      if (anchor.blockText && anchor.blockText === text) score += 1;
      else if (anchor.blockText) score += similarity(anchor.blockText, text) * 0.5;
      if (anchor.prefix && text.indexOf(anchor.prefix.slice(-12)) >= 0) score += 0.3;
      if (anchor.suffix && text.indexOf(anchor.suffix.slice(0, 12)) >= 0) score += 0.3;
      if (score > bestScore) { bestScore = score; best = []; }
      if (score === bestScore) best.push({ blockId: bs[i].id });
    }
    // Under this floor the words are simply not on the page any more: detached.
    return bestScore < 1.4 ? null : best.length > 1 ? { ambiguous: true, candidates: best } : best[0];
  }

  // Where the quote sits inside the block's RENDERED text. Offsets are recomputed
  // against the DOM rather than carried over from the source, because md.js strips
  // markers: "**bold**" is 8 characters in the source and 4 on the page.
  function domRange(node, anchor) {
    node = passageTextNode(node);
    var text = node.textContent, q = String(anchor.quote || '');
    if (!q) return null;
    var at = -1;
    if (anchor.prefix) {
      var p = text.indexOf(anchor.prefix.slice(-16));
      if (p >= 0) at = text.indexOf(q, p);
    }
    if (at < 0) at = text.indexOf(q);
    if (at < 0) {
      var lower = text.toLowerCase().indexOf(q.toLowerCase());
      if (lower >= 0) at = lower;
    }
    if (at < 0) return null;
    return { start: at, end: at + q.length };
  }

  function blockTextHash(blocks) {
    var hash = 2166136261;
    for (var i = 0; i < blocks.length; i++) {
      var value = blocks[i].text;
      for (var j = 0; j < value.length; j++) hash = Math.imul(hash ^ value.charCodeAt(j), 16777619);
      hash = Math.imul(hash ^ value.length, 16777619);
    }
    return hash >>> 0;
  }

  function resolveAll(quick, paintedId) {
    S.resolved = {};
    S.candidates = {};
    var blocks = pageBlocks(), byId = {}, hash = blockTextHash(blocks);
    for (var b = 0; b < blocks.length; b++) byId[blocks[b].id] = blocks[b];
    var changed = blocks.filter(function (block) { return S.blockTexts[block.id] !== block.text; });
    var nextTexts = {};
    blocks.forEach(function (block) { nextTexts[block.id] = block.text; });
    var nextCache = {};
    for (var i = 0; i < S.threads.length; i++) {
      var t = S.threads[i];
      var anchor = t.anchor || {};
      var signature = [anchor.quote, anchor.prefix, anchor.suffix, anchor.blockText, JSON.stringify(anchor.chosenPlace || null), JSON.stringify(anchor.more || null)].join('\u0000');
      var cached = S.resolutionCache[t.id];
      var sameAnchor = cached && cached.signature === signature;
      var sameBlock = sameAnchor && cached.result && byId[cached.result.blockId] &&
        byId[cached.result.blockId].text === cached.blockText && cached.docHash === hash;
      var sameDetached = sameAnchor && !cached.result && cached.docHash === hash;
      if ((sameBlock || sameDetached) && (quick || !cached.provisional)) {
        nextCache[t.id] = cached;
        S.resolved[t.id] = cached.result;
        S.candidates[t.id] = cached.candidates || [];
        continue;
      }
      // A detached quote is looked for again only in text that changed since the last look.
      var retryDetached = sameAnchor && cached && !cached.result && !(cached.provisional && !quick);
      var candidates = retryDetached && !(cached.candidates || []).length ? changed : blocks;
      var confirmed = anchor.chosenPlace;
      var chosenBlock = confirmed && byId[confirmed.blockId];
      var r = chosenBlock && confirmed.docHash === hash && chosenBlock.text === confirmed.blockText &&
        chosenBlock.text.slice(confirmed.start, confirmed.end) === anchor.quote
        ? confirmed : resolveBlock(anchor, quick, candidates, retryDetached);
      // A quick miss is inconclusive for an already attached, edited quote.
      // Resolve that passage only; the delayed full pass still checks the document.
      var provisional = false;
      if (paintedId && !r && sameAnchor && cached.result) {
        var previous = byId[cached.result.blockId];
        if (previous) {
          r = previous.text === cached.blockText ? cached.result
            : resolveBlock(anchor, false, [previous], true);
          provisional = true;
        }
      }
      // A unique match in changed text can still tie an unchanged passage.
      if (retryDetached && r && candidates !== blocks) r = resolveBlock(anchor, quick, blocks, false);
      var choices = r && r.ambiguous ? r.candidates : [];
      S.candidates[t.id] = choices;
      var block = r && !r.ambiguous && byId[r.blockId];
      var range = block ? (Number.isInteger(r.start) ? r : domRange(block.el, anchor)) : null;
      var result = block ? { blockId: r.blockId, start: range ? range.start : -1, end: range ? range.end : -1 } : null;
      if (result && anchor.more) result.more = resolveParts(anchor.more, blocks, result.blockId);
      nextCache[t.id] = { signature: signature, result: result, blockText: block && block.text,
        docHash: hash, candidates: choices, provisional: !!quick && (!result || provisional) };
      S.resolved[t.id] = result;
    }
    S.resolutionCache = nextCache;
    S.blockTexts = nextTexts;
  }

  /* ------------------------------------------------------------------- marks */

  function clearMarks(root) {
    root = root || S.page;
    if (!root) return;
    var pins = root.querySelectorAll('[data-castor-ui="comment-mark"]');
    for (var p = 0; p < pins.length; p++) pins[p].remove();
    var marks = root.querySelectorAll('mark.commented, mark.in-workspace');
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i], parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();               // stitch the split text nodes back together
    }
  }

  // Marks retain the existing hit targets and pins, never the paint. A single
  // native range bridges all inline nodes, including visible Markdown markers.
  function wrapRange(node, start, end, threadId, done, className, by, personColor) {
    if (!(end > start)) return false;
    node = passageTextNode(node);
    var walker = DOC.createTreeWalker(node, global.NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue) return global.NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (p && p.closest('[data-castor-ui]')) return global.NodeFilter.FILTER_REJECT;
        return global.NodeFilter.FILTER_ACCEPT;
      }
    });
    var targets = [], pos = 0, n;
    while ((n = walker.nextNode())) {
      var len = n.nodeValue.length, from = pos, to = pos + len;
      pos = to;
      if (to <= start || from >= end) continue;
      targets.push({ node: n, from: Math.max(start - from, 0), to: Math.min(end - from, len) });
    }
    if (!targets.length) return false;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i], text = t.node;
      // split() mutates the tree, so take the tail first, then the head.
      if (t.to < text.nodeValue.length) text.splitText(t.to);
      var middle = t.from > 0 ? text.splitText(t.from) : text;
      var mark = DOC.createElement('mark');
      mark.className = (className || 'commented') + (done ? ' is-done' : '');
      if (threadId) mark.setAttribute('data-thread', threadId);
      if (by) mark.setAttribute('data-by', by);
      if (personColor) {
        mark.setAttribute('data-person-color', 'true');
        mark.style.setProperty('--comment-person', personColor);
      }
      middle.parentNode.insertBefore(mark, middle);
      mark.appendChild(middle);
    }
    return true;
  }

  // One zero-width anchor at the last text fragment. The control is out of flow,
  // so neither its icon nor the message-count experiment changes line wrapping.
  // UI descendants are excluded by the editor and the anchor text walker.
  function applyCommentPins(root, list) {
    var endpoints = {};
    for (var i = 0; i < list.length; i++) {
      var thread = list[i], r = S.resolved[thread.id];
      var marks = root.querySelectorAll('mark.commented[data-thread="' + thread.id + '"]');
      if (!marks.length) continue;
      var host = marks[marks.length - 1];
      var end = passageEnd(r), endpoint = r ? end.blockId + ':' + end.end : thread.id;
      if (endpoints[endpoint]) continue;
      var siblings = list.filter(function (t) {
        var at = passageEnd(S.resolved[t.id]);
        return at && r && at.blockId === end.blockId && at.end === end.end;
      });
      endpoints[endpoint] = true;
      var pin = el('span', 'castor-comment-pin');
      pin.setAttribute('data-castor-ui', 'comment-mark');
      pin.setAttribute('contenteditable', 'false');
      var button = el('button', 'castor-comment-mark');
      button.type = 'button';
      var count = 1 + (thread.replies || []).length;
      var label = COMMENT_LABELS.open + (thread.author || 'Unknown') + ', ' + count + COMMENT_LABELS.messages + (thread.done ? COMMENT_LABELS.done : '');
      button.setAttribute('data-thread', thread.id);
      button.setAttribute('data-thread-count', String(siblings.length || 1));
      if (siblings.length > 1) label += ', ' + siblings.length + ' threads at this passage';
      button.setAttribute('aria-label', label);
      button.setAttribute('data-count', String(count));
      var svg = DOC.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      var path = DOC.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M3 2.5h10v8H7l-4 3v-11Z');
      svg.appendChild(path); button.appendChild(svg); pin.appendChild(button);
      // The editor also listens on the article. A comment control must not
      // become a caret placement first (touchend would replace its DOM).
      button.addEventListener('pointerdown', function (event) { event.preventDefault(); event.stopPropagation(); });
      button.addEventListener('touchend', function (event) { event.stopPropagation(); });
      button.addEventListener('keydown', function (event) { event.stopPropagation(); });
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        pageClicked({ target: event.currentTarget || this });
      });
      host.appendChild(pin);
    }
  }

  // Project the mirror onto reading text, retaining the source positions for
  // painting. Revealing ** must not change which passage a comment belongs to.
  function commentProjection(block) {
    var root = passageTextNode(block.el);
    if (root === block.el) return { id: block.id, el: block.el, text: block.text, raw: block.text,
      offsets: Array.from({ length: block.text.length }, function (_, i) { return i; }) };
    var walker = DOC.createTreeWalker(root, global.NodeFilter.SHOW_TEXT, null);
    var text = '', raw = '', offsets = [], node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (parent && parent.closest('[data-castor-ui]')) continue;
      var value = node.nodeValue || '', at = raw.length;
      raw += value;
      if (parent && parent.closest('.cw-mk')) continue;
      text += value;
      for (var i = 0; i < value.length; i++) offsets.push(at + i);
    }
    return { id: block.id, el: block.el, text: text, raw: raw, offsets: offsets };
  }

  function commentReadingAnchor(anchor) {
    var md = Castor.md, source = anchor.blockText || '';
    if (!md || !md.parse || /[\uE000\uE001]/.test(source)) return anchor;
    var place = resolveBlock(anchor, true, [{ id: 'source', text: source }]);
    if (!place || place.ambiguous) return anchor;
    var at = place.start;
    // Parse in the original context: a selection may contain only the closing
    // ** of a bold phrase. Parsing the quote alone would keep that stray marker.
    var marked = source.slice(0, at) + '\uE000' + anchor.quote + '\uE001' + source.slice(at + anchor.quote.length);
    var text = md.parse(marked).blocks.map(function (b) { return b.text; }).join('\n');
    var start = text.indexOf('\uE000'), end = text.indexOf('\uE001');
    if (start < 0 || end <= start) return anchor;
    return { quote: text.slice(start + 1, end), prefix: text.slice(Math.max(0, start - 32), start),
      suffix: text.slice(end + 1, end + 33), blockText: text.slice(0, start) + text.slice(start + 1, end) + text.slice(end + 1) };
  }

  var commentPaintKeys = [], commentPaintStyle = null, commentPaintObserver = null, commentPaintPage = null;
  function paintCommentRanges() {
    if (!S.page || !DOC.createRange) return;
    var native = global.CSS && global.CSS.highlights && typeof global.Highlight === 'function';
    commentPaintKeys.forEach(function (key) { if (native) global.CSS.highlights.delete(key); });
    commentPaintKeys = [];
    var old = S.page.querySelectorAll('[data-castor-ui="comment-wash"]');
    for (var o = 0; o < old.length; o++) old[o].remove();
    var marks = S.page.querySelectorAll('mark.commented'), groups = new Map(), rules = '';
    for (var i = 0; i < marks.length; i++) {
      var id = marks[i].getAttribute('data-thread');
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(marks[i]);
    }
    groups.forEach(function (parts) {
      var nodes = [];
      parts.forEach(function (mark) {
        var walk = DOC.createTreeWalker(mark, global.NodeFilter.SHOW_TEXT, null), n;
        while ((n = walk.nextNode())) if (n.nodeValue && !(n.parentElement && n.parentElement.closest('[data-castor-ui]'))) nodes.push(n);
      });
      if (!nodes.length) return;
      var first = nodes[0], last = nodes[nodes.length - 1], range = DOC.createRange();
      range.setStart(first, 0); range.setEnd(last, last.nodeValue.length);
      var key = 'castor-comment-' + commentPaintKeys.length, mark = parts[0];
      commentPaintKeys.push(key);
      parts.forEach(function (part) { part.setAttribute('data-comment-paint', key); });
      var by = mark.getAttribute('data-by');
      var colour = by === 'agent' ? 'var(--comment-agent, #006770)' :
        cleanHexColor(mark.style.getPropertyValue('--comment-person')) ||
          (by === 'both' ? 'var(--ink)' : 'var(--comment-human, #C4552A)');
      var current = parts.some(function (part) { return part.classList.contains('is-lifted') || part.classList.contains('is-paired'); });
      // Mix onto paper rather than transparent: overlapping comments cannot stack
      // their alpha and erase text contrast. Every range uses full text ink.
      var wash = 'color-mix(in srgb,' + colour + ' var(--comment-' + (current ? 'current' : 'rest') + '-tint,' + (current ? '34%' : '24%') + '),var(--paper,#F7F4EC))';
      rules += '::highlight(' + key + '){background-color:' + wash + ';color:var(--ink)}' +
        '[data-castor-ui="comment-wash"][data-comment-paint="' + key + '"]{background:' + wash + '}';
      if (native) {
        global.CSS.highlights.set(key, new global.Highlight(range));
      } else {
        // Old engines get the same single band per line, in block coordinates.
        // Scrolling then moves text and wash together without a scroll listener.
        var block = mark.closest('.cw-block') || mark.parentElement;
        var box = block.getBoundingClientRect(), lines = [];
        var rects = [];
        nodes.forEach(function (text) {
          var textRange = DOC.createRange();
          textRange.setStart(text, 0); textRange.setEnd(text, text.nodeValue.length);
          Array.prototype.push.apply(rects, textRange.getClientRects());
        });
        rects.forEach(function (r) {
          if (!r.width || !r.height) return;
          var line = lines.find(function (l) { return Math.abs(l.top - r.top) < 2 && r.left <= l.right + 1 && r.right >= l.left - 1; });
          if (line) {
            line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right);
            line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom);
          } else lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
        });
        block.style.isolation = 'isolate';
        lines.forEach(function (line) {
          var band = el('span');
          band.setAttribute('data-castor-ui', 'comment-wash');
          band.setAttribute('data-comment-paint', key); band.setAttribute('aria-hidden', 'true');
          band.style.cssText = 'position:absolute;pointer-events:none;z-index:-1;border-radius:2px';
          band.style.left = (line.left - box.left) + 'px'; band.style.top = (line.top - box.top) + 'px';
          band.style.width = (line.right - line.left) + 'px'; band.style.height = (line.bottom - line.top) + 'px';
          block.appendChild(band);
        });
      }
    });
    if (!commentPaintStyle) {
      commentPaintStyle = el('style'); commentPaintStyle.id = 'castor-comment-paint';
      DOC.head.appendChild(commentPaintStyle);
    }
    if (commentPaintStyle.textContent !== rules) commentPaintStyle.textContent = rules;
  }

  function observeCommentPaint() {
    if (!global.MutationObserver || commentPaintPage === S.page) return;
    if (commentPaintObserver) commentPaintObserver.disconnect();
    commentPaintPage = S.page;
    commentPaintObserver = new global.MutationObserver(function (changes) {
      // Existing click/hover handlers own these classes. Observe them instead of
      // changing their behavior; no geometry is measured on the native path.
      if (changes.some(function (change) { return change.target.matches && change.target.matches('mark.commented'); })) paintCommentRanges();
    });
    commentPaintObserver.observe(S.page, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  function applyMarks(quick, blockId) {
    var target = blockId && blockById(blockId);
    if (blockId && !target) return;
    clearMarks(target && target.el);
    var list = visibleThreads(), projections = null;
    for (var i = 0; i < list.length; i++) {
      var t = list[i], r = S.resolved[t.id];
      // The resolver counts the revealed markers. Retry the same exact-anchor
      // rules against reading text before declaring a focused passage detached.
      if (!projections) projections = pageBlocks().map(commentProjection);
      var rawBlock = r && projections.find(function (p) { return p.id === r.blockId; });
      var chosen = t.anchor.chosenPlace && rawBlock && r.end > r.start && rawBlock.raw.slice(r.start, r.end) === t.anchor.quote;
      var hit = !chosen && resolveBlock(t.anchor, true, projections);
      if (!chosen && !hit && (!rawBlock || rawBlock.raw.slice(r.start, r.end) !== t.anchor.quote)) {
        hit = resolveBlock(commentReadingAnchor(t.anchor), true, projections);
      }
      if (hit && hit.ambiguous) {
        r = null; S.resolved[t.id] = null;
        S.candidates[t.id] = hit.candidates.map(function (candidate) {
          var p = projections.find(function (b) { return b.id === candidate.blockId; });
          return { blockId: candidate.blockId, start: p.offsets[candidate.start], end: p.offsets[candidate.end - 1] + 1 };
        });
      } else if (hit) {
        var projected = projections.find(function (p) { return p.id === hit.blockId; });
        r = { blockId: hit.blockId, start: projected.offsets[hit.start], end: projected.offsets[hit.end - 1] + 1 };
        S.resolved[t.id] = r;
        S.candidates[t.id] = [];
      }
      if (!r || r.start < 0) continue;
      // A passage's later parts, found in the reading text as the first part is.
      if (t.anchor.more) r.more = resolveParts(t.anchor.more, projections, r.blockId).map(function (part) {
        var p = projections.find(function (x) { return x.id === part.blockId; });
        return { blockId: part.blockId, start: p.offsets[part.start], end: p.offsets[part.end - 1] + 1 };
      });
      [r].concat(r.more || []).forEach(function (part) {
        if (blockId && part.blockId !== blockId) return;
        var b = target || blockById(part.blockId);
        if (b) wrapRange(b.el, part.start, part.end, t.id, t.done, null, threadBy(t), threadAnchorColor(t));
      });
    }
    // The workspace's excerpts get their own faint mark, through the same text-node
    // walk, in the same pass: two passes would compute offsets over already-split
    // text and the second set would land in the wrong place.
    for (var w = 0; w < S.workspace.length; w++) {
      var a = S.workspace[w];
      var hit = a && resolveBlock(a, quick);
      if (!hit || (blockId && hit.blockId !== blockId)) continue;
      var wb = target || blockById(hit.blockId);
      if (!wb) continue;
      var wr = domRange(wb.el, a);
      if (wr) wrapRange(wb.el, wr.start, wr.end,
        a._canvasCardId ? 'canvas:' + a._canvasCardId : null, false, 'in-workspace');
    }
    applyCommentPins(target ? target.el : S.page, list);
    if (S.active) {
      var lifted = (target ? target.el : S.page).querySelectorAll('mark.commented[data-thread="' + S.active + '"]');
      for (var j = 0; j < lifted.length; j++) lifted[j].classList.add('is-lifted');
    }
    paintCommentRanges();
    observeCommentPaint();
  }

  /* ------------------------------------------------------------ the messages */

  // Credit belongs to the message, not to the person who opened its thread.
  // Native list items give metadata the same bullets as a rendered Markdown list.
  function configuredPerson(msg) {
    if (!msg || msg.reviewer || msg.reviewerIdentity) return null;
    var people = (Castor.app && Castor.app.data && Castor.app.data.people) || [];
    var key = msg.principal || (msg.by === 'agent' && founderKey(msg.onBehalfOf) ? msg.onBehalfOf : '');
    if (key) {
      for (var pIdx = 0; pIdx < people.length; pIdx++) {
        if (people[pIdx] && people[pIdx].id === key) return people[pIdx];
      }
      return null;
    }
    var base = ((msg.author || '').replace(/[’']s agent$/i, '')).trim();
    if (!base || base === 'Your agent' || /^claude/i.test(base)) return null;
    for (var i = 0; i < people.length; i++) {
      var p = people[i];
      if (p && p.kind !== 'agent' && (base === p.id || base === p.name)) return p;
    }
    var aliases = people.filter(function (p) {
      return p && p.kind !== 'agent' && p.name && base === p.name.split(' ')[0];
    });
    return aliases.length === 1 ? aliases[0] : null;
  }

  function messagePersonColor(msg) {
    if (!msg) return null;
    var validHex = cleanHexColor(msg.color);
    if (validHex) return validHex;
    var person = configuredPerson(msg);
    if (person && cleanHexColor(person.color)) return cleanHexColor(person.color);
    return null;
  }

  function threadAnchorColor(thread) {
    if (!thread) return '';
    return messagePersonColor(thread) || '';
  }

  // A world colours provenance by ROLE (Twin), so the role has to be in the DOM
  // and not only in the words. `by` wins; otherwise the author is looked up in
  // the room's people, whose `kind` is the only authority on what an agent is.
  function personKind(name, by) {
    if (by) return by === 'agent' ? 'agent' : 'human';
    if (/[’']s agent$/i.test(name) || name === 'Your agent') return 'agent';
    var people = (Castor.app && Castor.app.data && Castor.app.data.people) || [];
    for (var i = 0; i < people.length; i++) {
      if (people[i] && people[i].name === name) return people[i].kind === 'agent' ? 'agent' : 'human';
    }
    return 'human';
  }

  function authorKind(msg) {
    return personKind((msg && msg.author) || '', msg && msg.by);
  }

  function avatarInk(color) {
    var hex = color.slice(1);
    if (hex.length === 3) hex = hex.replace(/./g, function (c) { return c + c; });
    var rgb = hex.match(/../g).map(function (c) {
      var v = parseInt(c, 16) / 255;
      return v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4);
    });
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > .179 ? '#000000' : '#ffffff';
  }

  /* WHO SAID IT, AND FOR WHOM. An agent is named as itself (its model, written the way people
     write it) and with the founder it acted for: the one its record names, or the one the commit
     that wrote it names (`onBehalfOf`, which the server reads from history and never stores).
     Neither known: the agent alone, never a guess. A founder is a first name, never a key or
     an address. */
  function founderKey(key) { return typeof key === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(key) && key !== 'unassigned'; }
  function founderName(key) {
    var people = ((Castor.app && Castor.app.data && Castor.app.data.people) || []).filter(function (p) { return p && p.id && p.kind !== 'agent' && p.name; });
    function first(p) { return String(p.name).trim().split(/\s+/)[0]; }
    if (key === 'both') { var all = people.map(first); return all.length > 1 ? all.slice(0, -1).join(', ') + ' and ' + all[all.length - 1] : ''; }
    for (var i = 0; i < people.length; i++) if (people[i].id === key) return first(people[i]);
    return Castor.people && Castor.people.name ? Castor.people.name(key) : '';
  }
  var AGENT_WORDS = { gpt: 'GPT', ai: 'AI', llm: 'LLM' };
  function agentName(id) {
    var raw = String(id || '').trim();
    // A name written by a person ("Claude 3.5 Sonnet", "GPT-6") stays exactly as written.
    if (!raw || /\s|[A-Z]/.test(raw)) return raw;
    var parts = raw.split('-'), out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], last = out[out.length - 1];
      if (!p) continue;
      if (/^gpt$/.test(p) && /^\d/.test(parts[i + 1] || '')) { out.push('GPT-' + parts[++i]); continue; }
      if (/^\d+$/.test(p) && /^\d+$/.test(last || '') && p.length < 3) { out[out.length - 1] = last + '.' + p; continue; }
      out.push(/^\d/.test(p) ? p : (AGENT_WORDS[p] || p.charAt(0).toUpperCase() + p.slice(1)));
    }
    return out.join(' ');
  }
  function credit(msg) {
    msg = msg || {};
    var kind = authorKind(msg), person = configuredPerson(msg), author = String(msg.author || '').trim();
    if (kind !== 'agent') {
      var who = person ? person.name : (author || 'Unknown author');
      return { kind: 'human', label: who, name: who, agent: '', forName: '', short: who.split(/\s+/)[0] };
    }
    var generic = !author || author === 'Your agent' || /[’']s agent$/i.test(author);
    var namedByPerson = !msg.principal && !founderKey(msg.onBehalfOf) && person;
    var agent = msg.model ? agentName(msg.model) : (generic || namedByPerson ? '' : agentName(author));
    var key = isWriter(msg.principal) || founderKey(msg.principal) ? msg.principal : (founderKey(msg.onBehalfOf) ? msg.onBehalfOf : '');
    var forName = key ? founderName(key) : (person ? person.name.split(/\s+/)[0] : '');
    if (!agent) {
      var plain = person ? person.name + "'s agent" : (author || 'Agent');
      return { kind: 'agent', label: plain, name: plain, agent: '', forName: forName, short: plain.split(/\s+/)[0] };
    }
    return { kind: 'agent', label: agent + (forName ? ' for ' + forName : ''), name: agent, agent: agent, forName: forName,
      model: msg.model || author, short: agent.split(/\s+/)[0] };
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // One way to write a time everywhere a comment shows one: 4 Oct 2026, or 4 Oct 2026, 14:05.
  function stampText(stamp, when) {
    var day = stamp.length === 10 ? new Date(+stamp.slice(0, 4), +stamp.slice(5, 7) - 1, +stamp.slice(8, 10)) : when;
    var text = day.getDate() + ' ' + MONTHS[day.getMonth()] + ' ' + day.getFullYear();
    if (stamp.length === 10) return text;
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return text + ', ' + two(when.getHours()) + ':' + two(when.getMinutes());
  }

  function provenanceLine(msg, thread, root) {
    var who = credit(msg), kind = who.kind, name = who.label;
    var line = el('div', 'castor-prov');
    var row = el('div', 'castor-prov-author');
    var credited = el('span', 'castor-comment-name', (root && thread.done ? '✓ ' : '') + (who.agent ? '' : name));
    if (who.agent) {
      var agentEl = el('span', 'castor-comment-agent', who.agent);
      if (who.model) agentEl.setAttribute('data-model', who.model);
      credited.appendChild(agentEl);
      if (who.forName) credited.appendChild(el('span', 'castor-comment-for', ' for ' + who.forName));
    }
    credited.setAttribute('data-by', kind);credited.title=name;
    var pColor = messagePersonColor(msg);
    if (pColor) credited.style.color = 'color-mix(in srgb, var(--ink) 65%, ' + pColor + ')';
    row.appendChild(credited);
    var dot = el('span', 'castor-person-dot',kind==='agent'?'a':'');
    dot.setAttribute('data-initial', kind === 'agent' ? 'a' : name.charAt(0).toUpperCase());
    dot.setAttribute('aria-hidden', 'true');
    if (kind === 'agent') dot.setAttribute('data-agent', 'true');
    if (pColor) dot.style.backgroundColor = kind === 'agent'
      ? 'color-mix(in srgb, ' + pColor + ' 35%, white)' : pColor;
    if (pColor && kind !== 'agent') dot.style.color = avatarInk(pColor);
    row.appendChild(dot);
    line.appendChild(row);
    if (msg.created) {
      var stamp = String(msg.created), when = new Date(stamp);
      if (/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(stamp) && !isNaN(when.getTime())) {
        var time = el('time', 'castor-comment-time');
        time.setAttribute('datetime', stamp);time.title=stamp;
        time.textContent = stampText(stamp, when);
        var dated = el('span', 'castor-comment-date');
        dated.appendChild(time);
        row.appendChild(dated);
      }
    }
    if (msg.basis) {
      var context = el('div', 'castor-comment-context', 'Based on ' + msg.basis);
      line.appendChild(context);
    }
    return line;
  }

  function messageNode(msg, thread, root) {
    var box = el('div', 'castor-msg'), color = messagePersonColor(msg);
    if (color) {
      box.style.setProperty('--comment-person', color);
      box.setAttribute('data-person-color', 'true');
    }
    box.setAttribute('data-by', authorKind(msg));
    box.appendChild(provenanceLine(msg, thread, root));
    box.appendChild(el('div', 'castor-msg-text', msg.actions&&msg.actions.withdrawn?'Comment withdrawn. You can restore your own comment.':msg.text));
    if(msg.actions)box.setAttribute('data-message-ref',msg.actions.messageRef);
    messageActions(box,msg,thread,root);
    if(!root&&S.replySending&&S.replySending[msg.id]){var sending=el('button','castor-reply-sending','Sending...');sending.type='button';pendingControl(sending,true,'Sending...');box.appendChild(sending);}
    if (msg.offer) box.appendChild(offerNode(msg, thread));
    return box;
  }

  // The agent never argues: it says one thing and offers exactly two plain words.
  function offerNode(msg, thread) {
    var row = el('div', 'castor-acts');
    /* Taking or leaving the agent's offer changes a message already written,
       which is the writers' to do. A reviewer sees the offer and its state only. */
    if (reviewing() && (!msg.offer.state || msg.offer.state === 'open')) return row;
    if (msg.offer.state && msg.offer.state !== 'open') {
      row.appendChild(el('span', 'castor-prov', msg.offer.state === 'taken'
        ? 'Changed on the page.' : 'Left as it is.'));
      return row;
    }
    row.appendChild(el('span', 'castor-prov', 'This scripted offer cannot change the article.'));
    return row;
  }

  /* -------------------------------------------------------------- the cards */

  function byId(id) {
    for (var i = 0; i < S.threads.length; i++) if (S.threads[i].id === id) return S.threads[i];
    return null;
  }
  function visibleThreads() {
    return S.threads.filter(function (t) {
      var messages = [t].concat(t.replies || []);
      var status = S.filter === 'all' || (S.filter === 'withdrawn' ? messages.some(function (m) { return m.actions && m.actions.withdrawn; }) : S.filter === 'done' ? t.done : !t.done);
      if (!status) return false;
      if (!S.authorFilter) return true;
      return messages.some(function (m) {
        if (!m) return false;
        if (m.author === S.authorFilter) return true;
        var p = configuredPerson(m);
        if (p && (p.name === S.authorFilter || p.id === S.authorFilter)) return true;
        return false;
      });
    });
  }
  function doneCount() {
    return S.threads.filter(function (t) { return t.done; }).length;
  }

  function pairWith(id, on, from) {
    if (!S.page) return;
    var marks = S.page.querySelectorAll('mark.commented[data-thread="' + id + '"]');
    for (var i = 0; i < marks.length; i++) marks[i].classList.toggle('is-paired', !!on);
    var card = S.canvas && S.canvas.querySelector('.castor-thread[data-thread-id="' + id + '"]');
    if (card) {
      card.classList.toggle('is-paired', !!on);
      if (on && from === 'page' && S.wrap) {
        S.selfScroll = true;
        revealPanelCard(card);
        global.setTimeout(function () { S.selfScroll = false; }, 60);
      }
    }
  }

  function reconcileLegacy(held, candidate, choice, storageKey) {
    var owner = reviewerIdentity(Castor.role), path = storablePath();
    function warn(reason) {
      if (key() === storageKey && Castor.bus && Castor.bus.emit) Castor.bus.emit('comments:unsaved', { path: path, held: true, reason: reason });
    }
    // Revalidate the displayed saved copy before either explicit choice. A
    // delayed click or response must not consume another account's input.
    if (key() !== storageKey || !composerIdentityKnown(held.message)) return;
    global.fetch(commentReadUrl(path), { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('The saved comments could not be checked. Both copies are kept here.');
      return response.json();
    }).then(function (payload) {
      if (key() !== storageKey || !sameReviewer(owner, reviewerIdentity(Castor.role))) return;
      var server = Array.isArray(payload) ? payload : payload && payload.threads;
      if (!Array.isArray(server)) throw new Error('The saved comments could not be checked. Both copies are kept here.');
      server = server.map(normalise);
      // Other tabs can add words while this choice's GET is in flight. Rejoin
      // their latest bucket before replacing only the explicitly chosen copy.
      S.threads = mergeServer(server, null, mergeLocal(S.threads, localThreads(storageKey)), storageKey).threads;
      var current = legacyHolds(S.threads, server, true).filter(function (h) {
        return h.kind === held.kind && h.thread.id === held.thread.id && h.message.id === held.message.id &&
          h.candidates.some(function (c) { return JSON.stringify(c) === JSON.stringify(candidate); });
      })[0];
      if (!current) throw new Error('The saved copy changed. Reload Comments and choose again. Your pending words are still kept here.');
      var id = current.message.id || newComposerRecord(current.thread.anchor).id;
      var replacement, separateId;
      if (current.kind === 'thread') {
        separateId = choice === 'separate' ? newComposerRecord(current.thread.anchor).id : null;
        replacement = choice === 'separate' ? Object.assign({}, current.thread, {
          id: separateId, replies: [], legacyReconciliation: { candidate: candidate }
        }) : S.threads.filter(function (t) { return t.id === candidate.thread.id; })[0];
        if (!replacement) throw new Error('The saved copy changed. Your words are still kept here.');
        replacement = Object.assign({}, replacement, { replies: [] });
        if (choice === 'separate') delete replacement.clientId;
      }
      global.localStorage.setItem(storageKey + '.reconciliation.' + id, JSON.stringify({
        choice: choice, candidate: candidate, threadId: current.thread.id, pending: current.message,
        ...(replacement ? { replacement: replacement } : {})
      }));
      S.serverCopies[storageKey] = server;
      var before = JSON.stringify(S.threads);
      if (choice === 'separate') {
        current.message.id = separateId || newComposerRecord(current.thread.anchor).id;
        delete current.message.clientId;
        current.message.legacyReconciliation = { candidate: candidate };
      } else if (current.kind === 'thread') {
        var saved = S.threads.filter(function (t) { return t.id === candidate.thread.id; })[0];
        if (!saved) throw new Error('The saved copy changed. Your words are still kept here.');
        current.thread.replies.forEach(function (r) { if (!saved.replies.some(function (c) { return sameReply(c, r); })) saved.replies.push(r); });
        S.threads = S.threads.filter(function (t) { return t !== current.thread; });
      } else {
        current.thread.replies = current.thread.replies.filter(function (r) { return r !== current.message; });
      }
      try { global.localStorage.setItem(storageKey, JSON.stringify(S.threads)); }
      catch (error) { S.threads = JSON.parse(before).map(normalise); throw error; }
      if (!save()) throw new Error("Can't keep this choice on this device. Keep this page open.");
      if (choice === 'saved' && Castor.comments.durable && !actionPending() && Castor.bus && Castor.bus.emit) Castor.bus.emit('comments:saved', { path: path });
      layout();
    }).catch(function (error) { warn(String(error.message || error)); });
  }
  function renderLegacyChoices(card, thread) {
    var storageKey = key();
    legacyHolds(S.threads, S.serverCopies[storageKey] || []).filter(function (h) { return h.thread.id === thread.id; }).forEach(function (held) {
      var kind = held.kind === 'thread' ? 'comment' : 'reply';
      var box = el('div', 'castor-reconciliation');
      box.setAttribute('data-castor-ui', 'reconciliation');
      box.appendChild(el('p', null, 'This pending ' + kind + ' may already be saved. Choose which copy to keep.'));
      var pending = el('p', null, 'Pending words: ' + held.message.text); pending.style.whiteSpace = 'pre-wrap'; box.appendChild(pending);
      held.candidates.forEach(function (candidate) {
        var saved = candidate.kind === 'thread' ? candidate.thread : candidate.message;
        if (candidate.original && candidate.original.text !== saved.text) box.appendChild(el('p', null, 'Originally saved: ' + candidate.original.text));
        var words = el('p', null, 'Saved ' + kind + ': ' + saved.text); words.style.whiteSpace = 'pre-wrap'; box.appendChild(words);
        ['separate', 'saved'].forEach(function (choice) {
          var button = el('button', null, choice === 'separate' ? 'Keep as a separate ' + kind : 'Use saved ' + kind);
          button.type = 'button';
          button.addEventListener('click', function (event) { event.stopPropagation(); reconcileLegacy(held, candidate, choice, storageKey); });
          box.appendChild(button);
        });
      });
      card.appendChild(box);
    });
  }
  function passageStatus(thread) {
    if (!thread.anchor || !thread.anchor.quote) return 'This comment is about the whole article.';
    if ((S.candidates[thread.id] || []).length) return 'Choose a passage for this comment.';
    return S.resolved[thread.id] ? '' : 'Its passage is no longer in the article.';
  }

  function cardClicked(event, thread) {
    // Only a control inside the card keeps the click; an article foldout around the
    // card does not, now that the card itself is the way to its passage.
    var control = event.target.closest && event.target.closest('button, a, input, textarea, select, summary, details, [contenteditable="true"]');
    var card = event.currentTarget;
    if (control && (!card || !card.contains || card === control || card.contains(control))) return;
    var selection = global.getSelection && global.getSelection();
    if (selection && !selection.isCollapsed && String(selection).trim()) return;
    open(thread.id);
    flash(thread);
  }

  function threadCard(thread, opts) {
    opts = opts || {};
    var card = el('div', 'castor-thread' + (thread.done ? ' is-done' : '') +
      (S.active === thread.id ? ' is-lifted' : ''));
    card.setAttribute('data-thread-id', thread.id);
    card.setAttribute('data-castor-ui', 'thread');
    card.setAttribute('data-by', authorKind(thread));
    /* THE PAIRING, once a card is no longer beside its passage. Word deliberately
       dropped the connector line when it moved to modern comments and replaced it
       with exactly this: the anchor shades on hover of the card, the card shades
       on hover of the anchor. A line from a list item to a word two hundred pixels
       away and possibly off screen explains less than a light that comes on at
       both ends. */
    card.addEventListener('pointerenter', function () { pairWith(thread.id, true); });
    card.addEventListener('pointerleave', function () { pairWith(thread.id, false); });
    card.addEventListener('click', function (event) { cardClicked(event, thread); });
    var status = passageStatus(thread);
    if (status) card.appendChild(el('div', 'castor-passage-status', status));

    if (opts.quote !== false && thread.anchor && thread.anchor.quote) {
      // The passage itself, whole: a card never hides words behind a control.
      var quote = el('div', 'castor-quote');
      quote.appendChild(el('p', 'castor-quote-words', '\u201C' + passageOf(thread.anchor) + '\u201D'));
      card.appendChild(quote);
    }

    var moved = (thread.anchor && thread.anchor.reanchoredFrom) || thread.reanchoredFrom;
    if (moved) {
      var mv = el('div', 'castor-moved');
      mv.appendChild(el('span', 'castor-moved-word', 'moved'));
      mv.appendChild(DOC.createTextNode(
        thread.note ? ' · ' + String(thread.note).replace(/^_+|_+$/g, '').trim()
                    : ' · the words it was written against are no longer in the piece'));
      card.appendChild(mv);
    }

    /* The raw status word, when the store has one. Ours is a boolean; the article
       folder's is open / answered / used / routed / declined, and WHICH KIND of
       done is the whole information a boolean throws away. `declined` matters most:
       a system that can only record agreement loses every disagreement, and the
       reasoning behind a no never lands in the artifact the way a yes does. */

    // Every message of the thread is shown; a thread has no collapse of its own.
    var replies = thread.replies || [];
    card.appendChild(messageNode(thread,thread,true));
    for (var i = 0; i < replies.length; i++) card.appendChild(messageNode(replies[i], thread, false));

    var acts = el('div', 'castor-acts');
    var reply = withIcon(el('button', null, 'Reply'), 'reply');
    reply.type = 'button';
    reply.addEventListener('click', function (e) { e.stopPropagation(); openReply(thread, card); });
    if (!ended()) acts.appendChild(reply);

    var link=withIcon(el('button',null,'Copy link'),'link');link.type='button';
    link.addEventListener('click',function(e){e.stopPropagation();copyThreadLink(thread,card);});acts.appendChild(link);

    /* The raw status word, when the store has one. Ours is a boolean; the article
       folder's is open / answered / used / routed / declined, and WHICH KIND of
       done is the whole information a boolean throws away. `declined` matters most:
       a system that can only record agreement loses every disagreement, and the
       reasoning behind a no never lands in the artifact the way a yes does.
       It sits with the other state controls rather than floating in the middle of
       the card, where the first version put it and it read as an interruption. */
    if (thread.status && thread.status !== 'open') {
      var st = el('span', 'castor-status', thread.status);
      st.setAttribute('data-status', thread.status);
      acts.appendChild(st);
    }
    card.appendChild(acts);
    renderLegacyChoices(card, thread);
    return card;
  }

  /* Versioned actions are separate from append-only comment/reply saves. */
  function commentReadUrl(path){var who=!reviewing()&&Castor.who&&Castor.who.get?Castor.who.get():'';return '/api/comments?path='+encodeURIComponent(path)+'&actions=1'+(isWriter(who)?'&who='+who:'');}
  function pageActionActor(){if(!roleConfirmed())return null;if(reviewing()){var reader=reviewerIdentity(Castor.role);return reader?{kind:'reader',id:reader.id}:null;}var who=Castor.who&&Castor.who.get?Castor.who.get():'';return isWriter(who)?{kind:'founder-capability',id:who}:null;}
  function sameActionActor(actor){var current=pageActionActor();return !!(actor&&current&&actor.kind===current.kind&&actor.id===current.id);}
  function actionCapability(){if(ended())return null;var c=S.commentActions;return S.actionScope===key()&&c&&c.version===1&&c.accessEpoch!==undefined&&c.accessEpoch!==null&&Array.isArray(c.reactionKeys)&&['git','descant'].indexOf(c.authority)>=0&&sameActionActor(c.actor)?c:null;}
  function canonicalActionValue(value){if(Array.isArray(value))return value.map(canonicalActionValue);if(value&&typeof value==='object'){var sorted={};Object.keys(value).sort().forEach(function(k){sorted[k]=canonicalActionValue(value[k]);});return sorted;}return value;}
  function sameActionRequest(a,b){return !!(a&&b&&JSON.stringify(canonicalActionValue(a))===JSON.stringify(canonicalActionValue(b)));}
  function exactActionReceipt(receipt,request){return !!(receipt&&request&&receipt.opId===request.opId&&sameActionRequest(receipt.request,request)&&['git','descant'].indexOf(receipt.authority)>=0&&Number.isInteger(receipt.resultRev)&&receipt.resultRev>=0&&typeof receipt.gitDurable==='boolean');}
  function acceptCapabilities(payload,scope){S.commentActions=!Array.isArray(payload)&&payload&&payload.commentActions||null;S.actionScope=scope;var c=actionCapability();if(!c)return;var records=actionRecords();(Array.isArray(c.receipts)?c.receipts:[]).forEach(function(receipt){var record=records.filter(function(r){return r.submitted&&exactActionReceipt(receipt,r.request);})[0],old=receipt&&actionReceipt(receipt.opId);if(!record)return;var prior=old&&sameActionRequest(old.request,record.request)&&exactActionReceipt(old.receipt,record.request)?old:null;if(prior&&(prior.receipt.authority!==receipt.authority||prior.receipt.resultRev!==receipt.resultRev||prior.receipt.gitDurable===true))return;storeActionReceipt({request:record.request,receipt:receipt});});}
  function actionRecords(scope,path){scope=scope||key();path=path||piecePath();var prefix=scope+'.actions.';try{for(var i=0;i<global.localStorage.length;i++){var k=global.localStorage.key(i);if(k&&k.indexOf(prefix)===0&&!S.actionJournal[k]){var record=JSON.parse(global.localStorage.getItem(k));if(record&&record.key===k)S.actionJournal[k]=record;}}}catch(e){/* Current input remains in memory; stored copies remain untouched. */}return Object.keys(S.actionJournal).map(function(k){return S.actionJournal[k];}).filter(function(r){return r.path===path&&r.scope===scope&&sameActionActor(r.actor);});}
  function actionReceipt(id,scope){var k=(scope||key())+'.action-receipts.'+id;if(S.actionReceipts[k])return S.actionReceipts[k];try{return JSON.parse(global.localStorage.getItem(k)||'null');}catch(e){return null;}}
  function acknowledgedAction(r,git){var proof=actionReceipt(r.opId,reviewing()?r.scope:undefined);return !!(proof&&sameActionRequest(proof.request,r.request)&&exactActionReceipt(proof.receipt,r.request)&&(!git||proof.receipt.gitDurable===true));}
  function actionPending(scope,path){return actionRecords(scope,path).some(function(r){return r.submitted&&!acknowledgedAction(r,true);});}
  function actionCanRefresh(){return actionPending()&&!unsavedWords(S.threads,S.serverCopies[key()]||[]).length;}
  function storeActionReceipt(proof){var k=key()+'.action-receipts.'+proof.receipt.opId;S.actionReceipts[k]=proof;try{global.localStorage.setItem(k,JSON.stringify(proof));}catch(e){return;}clearAcknowledgedActions();}
  function clearAcknowledgedActions(){actionRecords().forEach(function(r){var proof;try{proof=JSON.parse(global.localStorage.getItem(r.scope+'.action-receipts.'+r.opId)||'null');}catch(e){return;}if(r.submitted&&proof&&sameActionRequest(proof.request,r.request)&&exactActionReceipt(proof.receipt,r.request)&&proof.receipt.gitDurable)removeActionRecord(r);});}
  function removeActionRecord(r){delete S.actionJournal[r.key];delete S.actionErrors[r.opId];try{global.localStorage.removeItem(r.key);global.localStorage.removeItem(r.scope+'.action-errors.'+r.opId);}catch(e){/* Retry cleanup on next render. */}}
  function pendingControl(button,busy,label){button.classList.toggle('castor-pending',!!busy);button.setAttribute('aria-busy',String(!!busy));button.disabled=!!busy;if(busy)button.textContent=label;return button;}
  function actionBusy(thread,msg,action){return actionRecords().some(function(r){return r.threadId===thread.id&&r.messageRef===(msg&&msg.actions&&msg.actions.messageRef||'')&&r.request.action===action&&S.actionSending[r.opId];});}

  // One unfinished edit per message and writer. Records are ordered by their
  // last change, or by the time in their id for those written before it was kept.
  function draftTime(r){if(typeof r.updated==='number')return r.updated;var m=/^(?:a|draft)([0-9a-z]+)-/.exec(r.opId||'');return m?parseInt(m[1],36):0;}
  function editDrafts(thread,messageRef){return actionRecords().filter(function(r){return r.threadId===thread.id&&r.messageRef===(messageRef||'')&&!r.submitted&&r.request&&r.request.action==='edit'&&!acknowledgedAction(r,false);}).sort(function(a,b){return draftTime(b)-draftTime(a);});}
  function dropActionDraft(r){if(r.submitted)return;delete S.actionJournal[r.key];try{global.localStorage.removeItem(r.key);}catch(e){/* It stays; the next load tries again. */}}
  // Words identical to the saved comment, or to a newer draft, are not writing to keep.
  function consolidateEditDrafts(thread,msg){var a=msg&&msg.actions;if(!a)return [];var seen={},kept=[];editDrafts(thread,a.messageRef).forEach(function(r){if(S.actionEditor&&S.actionEditor.record===r){seen[r.text]=true;kept.push(r);return;}if(r.text===msg.text||Object.hasOwn(seen,r.text)){dropActionDraft(r);return;}seen[r.text]=true;kept.push(r);});return kept;}
  function journalAction(record){S.actionJournal[record.key]=record;if(reviewing()&&Castor.bus&&Castor.bus.emit)Castor.bus.emit('comments:draft',{path:record.path});try{global.localStorage.setItem(record.key,JSON.stringify(record));return true;}catch(e){actionNotice(record,'unsaved',"Can't keep this action on this device. Keep this page open and copy your words.");return false;}}
  function actionNotice(record,kind,reason){var complete=kind==='saved'&&!actionPending()&&!unsavedWords(S.threads,S.serverCopies[key()]||[]).length;if(Castor.comments)Castor.comments.durable=complete;if(kind==='saved'&&!complete){kind='pending';reason+=' Other comments or actions are still pending.';}if(Castor.bus&&Castor.bus.emit)Castor.bus.emit('comments:'+kind,{path:record.path,reason:reason,action:true});}
  function newAction(thread,msg,action,extra){var c=actionCapability();if(!c)return null;var id='a'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),state=msg&&msg.actions,request={path:piecePath(),threadId:thread.id,opId:id,baseRev:action==='resolve'||action==='reopen'?thread.statusActions.rev:action==='reaction'?state.reactions[extra.reaction].rev:state.rev,action:action,accessEpoch:c.accessEpoch};if(state)request.messageRef=state.messageRef;if(c.actor.kind==='reader')request.reviewer_id=c.actor.id;else request.who=c.actor.id;Object.assign(request,extra||{});return {version:1,opId:id,key:key()+'.actions.'+id,scope:key(),path:piecePath(),actor:JSON.parse(JSON.stringify(c.actor)),authority:c.authority,threadId:thread.id,messageRef:state&&state.messageRef||'',text:request.text||'',request:request,submitted:false};}
  function actionProjectionActor(){var c=actionCapability();return c?c.actor.kind+':'+c.actor.id:'';}
  function rememberActionProjection(thread,scope){var seen=S.actionProjection[scope]||(S.actionProjection[scope]={}),actors=S.actionProjectionActors[scope]||(S.actionProjectionActors[scope]={});seen[thread.id]=thread;actors[thread.id]=scope===key()?actionProjectionActor():'';}
  function preserveActionProjection(raw,scope){var known=(S.actionProjection[scope]||{})[raw.id]||(scope===key()?S.threads.filter(function(t){return t.id===raw.id&&!t.pending;})[0]:null);if(!known)return raw;var actor=actionProjectionActor(),sameReactor=!!actor&&(S.actionProjectionActors[scope]||{})[raw.id]===actor;var incoming=JSON.parse(JSON.stringify(raw));function message(now,old){if(!now||!old||!now.actions||!old.actions||now.actions.messageRef!==old.actions.messageRef)return;if(now.actions.rev<old.actions.rev){now.text=old.text;var permissions=now.actions.permissions,reactions=now.actions.reactions;now.actions=JSON.parse(JSON.stringify(old.actions));now.actions.permissions=permissions;now.actions.reactions=reactions;}if(sameReactor)Object.keys(old.actions.reactions||{}).forEach(function(k){var prior=old.actions.reactions[k],next=now.actions.reactions&&now.actions.reactions[k];if(next&&next.rev<prior.rev)now.actions.reactions[k]=JSON.parse(JSON.stringify(prior));});}message(incoming,known);(incoming.replies||[]).forEach(function(r){message(r,(known.replies||[]).filter(function(k){return k.actions&&r.actions&&k.actions.messageRef===r.actions.messageRef;})[0]);});if(incoming.statusActions&&known.statusActions&&incoming.statusActions.rev<known.statusActions.rev){incoming.done=known.done;incoming.status=known.status;incoming.statusActions.rev=known.statusActions.rev;}return incoming;}
  function canonicalThreads(threads,scope){return threads.map(function(raw){var fresh=normalise(preserveActionProjection(raw,scope));if(fresh.actions||fresh.statusActions)rememberActionProjection(fresh,scope);return fresh;});}
  function applyActionThread(raw,scope){var thread=normalise(preserveActionProjection(raw,scope));rememberActionProjection(thread,scope);var server=(S.serverCopies[scope]||[]).slice(),index=server.findIndex(function(t){return t.id===thread.id;});if(index<0)server.push(thread);else server[index]=thread;S.serverCopies[scope]=server;if(scope===key()&&available())S.threads=mergeServer(server,null,S.threads,scope).threads;}
  function sendAction(record, afterAppend){if(!record||S.actionSending[record.opId])return;if(!sameActionActor(record.actor)||record.scope!==key()||record.path!==piecePath()){actionNotice(record,'unsaved','This action belongs to another or unknown writer. Its exact words are kept here.');return;}record.submitted=true;if(!journalAction(record))return;var scope=record.scope,writerAccount=Castor.role.publicWriter?Castor.role.id:'';S.actionSending[record.opId]=true;actionNotice(record,'pending','Saving this comment action.');closeActionEditor();layout();
    var identify=function(){return commentRequest('/api/whoami',{cache:'no-store'});};
    (afterAppend ? afterAppend.then(identify) : identify()).then(function(response){if(!response.ok){if(record.actor.kind!=='reader'&&(response.status===401||response.status===403)&&Castor.signedOut){Castor.signedOut();S.ended=ended();}throw new Error('Your identity could not be confirmed.');}return response.json();}).then(function(role){var correct=record.actor.kind==='reader'?sameReviewer({id:record.actor.id},reviewerIdentity(role)):role&&role.role==='founder'&&(!writerAccount||(role.id===writerAccount&&role.who===record.actor.id&&Castor.role.id===writerAccount));if(!correct||!sameActionActor(record.actor)||key()!==scope||piecePath()!==record.path)throw new Error('The original writer could not be confirmed.');return commentRequest('/api/comments/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(record.request)});}).then(function(response){return response.json().then(function(payload){if(!sameActionActor(record.actor)||key()!==scope)return;if(!response.ok){if(payload.thread)applyActionThread(payload.thread,scope);var reason=payload.reason==='stale-action'?'The comment changed. Compare your exact pending words with the current comment.':payload.error||payload.reason||'The server refused this action.';var failed=new Error(reason);failed.status=response.status;throw failed;}var receipt=payload.receipt;if(!exactActionReceipt(receipt,record.request))throw new Error('The server did not confirm this exact action.');storeActionReceipt({request:record.request,receipt:receipt});if(payload.thread)applyActionThread(payload.thread,scope);if(record.request.action==='resolve'&&payload.thread&&payload.thread.done)showDoneUndo(payload.thread);delete S.actionErrors[record.opId];actionNotice(record,receipt.gitDurable?'saved':'pending',receipt.gitDurable?'Comment action saved.':'Saved to the review service. Waiting for its Git copy.');});}).catch(function(error){S.actionErrors[record.opId]=String(error.message||error);try{global.localStorage.setItem(scope+'.action-errors.'+record.opId,S.actionErrors[record.opId]);}catch(e){}if(key()===scope&&sameActionActor(record.actor))actionNotice(record,'unsaved',S.actionErrors[record.opId]+' Your exact input remains on this device.');}).then(function(){delete S.actionSending[record.opId];if(key()===scope)layout();});
  }
  function captureActionEditor(editor){
    editor=editor||S.actionEditor;if(!editor)return true;
    var record=editor.record,value=editor.textarea.value,owned=sameActionActor(record.actor);
    if(record.submitted&&value===record.text)return true;
    if(!owned&&value===record.text&&editor.persisted)return true;
    if(record.submitted||(!owned&&value!==record.text)){
      record=JSON.parse(JSON.stringify(record));var id='draft'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
      record.opId=id;record.key=record.scope+'.actions.'+id;record.request.opId=id;record.submitted=false;
      if(!owned)record.actor=null;editor.record=record;
    }
    record.text=value;record.request.text=value;record.updated=Date.now();
    var kept=journalAction(record);editor.persisted=kept;editor.status.textContent=kept?'Exact edit kept on this device until you save.':'Keep this page open. Device storage failed.';
    return kept;
  }
  function closeActionEditor(){if(!S.actionEditor)return true;var editor=S.actionEditor;if(!captureActionEditor(editor)){showHeldActionEditorState(editor);return false;}editor.node.remove();S.actionEditor=null;
    // An edit closed with the comment's own words holds nothing to keep.
    if(!editor.record.submitted&&sameActionActor(editor.record.actor)&&typeof editor.original==='string'&&editor.textarea.value===editor.original)dropActionDraft(editor.record);
    return true;}
  function openActionEditor(thread,msg,from){
    // Reopen this message's draft when there is one; a new record only for a first edit.
    if(!actionCapability()||!closeActionEditor())return;
    var draft=from&&!from.submitted?from:consolidateEditDrafts(thread,msg)[0];
    // A submitted edit being compared starts a new edit from its words, at the comment's current revision,
    // unless an unsent edit exists: that one opens instead, so typed words are never replaced (one draft per message).
    var record=draft||newAction(thread,msg,'edit',{text:from?from.text:msg.text});if(!record)return;
    S.expanded[thread.id]=true;var node=el('div','castor-comment-editor'),label=el('label',null,'Edit your comment'),textarea=writingField('Edit your comment','',record.text);
    textarea.value=record.text;label.appendChild(textarea);node.appendChild(label);
    var status=el('p','castor-action-status');status.setAttribute('role','status');node.appendChild(status);
    var editor={node:node,textarea:textarea,record:record,status:status,persisted:false,held:false,original:msg.text};
    var saveEdit=el('button',null,'Save edit');saveEdit.type='button';saveEdit.addEventListener('click',function(e){
      e.stopPropagation();if(S.actionEditor!==editor)return;
      if(!textarea.value.trim()){status.textContent='Write a comment before saving.';return;}
      if(!captureActionEditor(editor))return;sendAction(editor.record, save.pending);
    });var row=sendRow(node);row.appendChild(saveEdit);
    var close=el('button',null,'Close edit');close.type='button';close.addEventListener('click',function(e){e.stopPropagation();if(S.actionEditor===editor)closeActionEditor();layout();});row.appendChild(close);
    textarea.addEventListener('input',function(){if(!sameActionActor(editor.record.actor)){if(S.actionEditor===editor)closeActionEditor();else captureActionEditor(editor);layout();return;}captureActionEditor(editor);});
    textarea.addEventListener('blur',function(){captureActionEditor(editor);});
    textarea.addEventListener('compositionend',function(){captureActionEditor(editor);});
    textarea.addEventListener('keydown',function(e){if(e.isComposing||e.keyCode===229)return;if(e.key==='Escape'){e.preventDefault();if(S.actionEditor===editor)closeActionEditor();layout();}});
    S.actionEditor=editor;editor.persisted=journalAction(record);layout();focusPanelCard(thread.id,textarea);if(textarea.setSelectionRange)try{textarea.setSelectionRange(textarea.value.length,textarea.value.length);}catch(e){}scheduleCommentFocus();
  }
  function messageActions(box,msg,thread,root){var c=actionCapability(),a=msg.actions;function button(row,label,run){var b=el('button',null,label);b.type='button';b.addEventListener('click',function(e){e.stopPropagation();run();});row.appendChild(b);return b;}
    // One row: reactions and Done, then the message's own Edit and Delete, all in view.
    var actionRow=el('div','castor-comment-actionrow'),own=null;
    if(c&&a){own=el('div','castor-comment-menu castor-comment-own');if(authorKind(msg)==='human'&&a.permissions.edit&&!a.withdrawn)withIcon(button(own,'Edit',function(){openActionEditor(thread,msg);}),'edit');if(authorKind(msg)==='human'&&a.permissions.withdraw)withIcon(button(own,a.withdrawn?'Restore':'Delete',function(){sendAction(newAction(thread,msg,a.withdrawn?'restore':'withdraw'));}),a.withdrawn?'restore':'delete');if(!own.children.length)own=null;}
    var canResolve=c&&root&&thread.statusActions&&thread.statusActions.canResolve&&c.actor.kind==='founder-capability';
    if(c&&((a&&a.permissions.react)||canResolve)){
      var reactions=el('div','castor-comment-reactions');
      if(a&&a.permissions.react)(c.reactionKeys||[]).filter(function(k){return k==='agree';}).forEach(function(k){var state=a.reactions[k];if(!state)return;var b=withIcon(button(reactions,(state.active?'Agreed':'Agree')+(state.count?' '+state.count:''),function(){try{global.localStorage.setItem('castor.comments.agree-hint','seen');}catch(e){}S.agreeHintFor=false;sendAction(newAction(thread,msg,'reaction',{reaction:k,active:!state.active}));}),k);b.setAttribute('aria-pressed',String(state.active));b.title=(state.active?'Remove':'Record')+' your Agree reaction. This does not change the article or mark the comment done.';b.setAttribute('aria-label',b.title);pendingControl(b,actionBusy(thread,msg,'reaction'),'Saving...');});
      if(canResolve){
        var done=withIcon(button(reactions,'Done',function(){sendAction(newAction(thread,null,thread.done?'reopen':'resolve'));}),'done');
        done.setAttribute('aria-pressed',String(thread.done));
        done.title=thread.done?'Reopen this comment':'Move this comment to Done';
        pendingControl(done,actionBusy(thread,null,thread.done?'reopen':'resolve'),'Saving...');
        done.setAttribute('aria-label',done.title);
        if(reactions.children.length>2)reactions.insertBefore(done,reactions.children[1]);
      }
      actionRow.appendChild(reactions);
    }
    if(own){for(var ownIndex=0;ownIndex<own.children.length;ownIndex++){var control=own.children[ownIndex];control.title=control.textContent;control.setAttribute('aria-label',control.textContent);}actionRow.appendChild(own);}
    if(actionRow.children.length)box.appendChild(actionRow);
    var hintThread=byId(S.active)||visibleThreads().filter(function(t){return S.resolved[t.id]||S.expanded['lost-'+t.id];})[0];
    // The Agree hint is shown once: on the first card he opens, which keeps it for the rest of this
    // visit, and on no card after that. A tap on Agree retires it for good.
    if(root&&c&&a&&a.permissions.react&&hintThread&&hintThread.id===thread.id){var seen=false;try{seen=global.localStorage.getItem('castor.comments.agree-hint')==='seen';}catch(e){}
      if(!seen&&S.agreeHintFor==null){S.agreeHintFor=thread.id;try{global.localStorage.setItem('castor.comments.agree-hint','seen');}catch(e){}}
      if(S.agreeHintFor===thread.id)box.appendChild(el('p','castor-action-hint','Agree adds a reaction. Words and status stay unchanged.'));}
    var drafts=c&&a?consolidateEditDrafts(thread,msg):[],older=drafts.slice(1);
    actionRecords().filter(function(r){return r.threadId===thread.id&&r.messageRef===(a&&a.messageRef||'')&&!acknowledgedAction(r,true)&&older.indexOf(r)<0;}).forEach(function(r){if(S.actionEditor&&S.actionEditor.record.opId===r.opId)return;var pending=el('div','castor-comment-pending');pending.appendChild(el('p',null,r.submitted?'Pending '+r.request.action:'Unfinished edit'));if(r.text)pending.appendChild(el('p','castor-comment-pending-text',r.text));var error=S.actionErrors[r.opId];if(!error)try{error=global.localStorage.getItem(r.scope+'.action-errors.'+r.opId);}catch(e){}if(error)pending.appendChild(el('p','castor-action-status',error));if(r.submitted&&acknowledgedAction(r,false)){pending.appendChild(el('p','castor-action-status','Saved to the review service. Waiting for its Git copy.'));var check=button(pending,'Check Git copy',function(){sendAction(r);});pendingControl(check,S.actionSending[r.opId],'Saving...');}else if(r.submitted){var retry=button(pending,'Retry action',function(){sendAction(r);});pendingControl(retry,S.actionSending[r.opId],r.request.action==='edit'?'Saving...':'Sending...');}if(!S.actionSending[r.opId])button(pending,'Discard',function(){if(typeof global.confirm==='function'&&!global.confirm('Discard this pending action and its saved input?'))return;removeActionRecord(r);layout();});if(r.request.action==='edit'&&c&&a&&a.permissions.edit&&!a.withdrawn)button(pending,r.submitted?'Compare and edit':'Resume edit',function(){openActionEditor(thread,msg,r);});box.appendChild(pending);});
    if(older.length){
      // Earlier distinct versions of this edit stay until the writer discards them.
      var olderKey='older-'+thread.id+'-'+(a&&a.messageRef||''),pastBox=disclosure('castor-comment-older',older.length===1?'1 older version':older.length+' older versions',!!S.expanded[olderKey],function(now){S.expanded[olderKey]=now;schedulePlace();}),past=pastBox.body;
      older.forEach(function(r){var row=el('div','castor-comment-older-item');row.appendChild(el('p','castor-comment-pending-text',r.text));button(row,'Copy',function(){if(global.navigator&&global.navigator.clipboard)global.navigator.clipboard.writeText(r.text).catch(function(){});});past.appendChild(row);});
      button(past,'Discard older versions',function(){if(typeof global.confirm==='function'&&!global.confirm('Discard the older versions of this edit? The newest stays.'))return;older.forEach(dropActionDraft);layout();});
      box.appendChild(pastBox.node);
    }
    if(root)actionRecords().filter(function(r){return r.threadId===thread.id&&!r.messageRef&&r.submitted&&!acknowledgedAction(r,true);}).forEach(function(r){var pending=el('div','castor-comment-pending');pending.appendChild(el('p',null,'Pending '+r.request.action));if(acknowledgedAction(r,false)){pending.appendChild(el('p',null,'Saved to the review service. Waiting for its Git copy.'));var check=button(pending,'Check Git copy',function(){sendAction(r);});pendingControl(check,S.actionSending[r.opId],'Saving...');}else{var retry=button(pending,'Retry action',function(){sendAction(r);});pendingControl(retry,S.actionSending[r.opId],r.request.action==='edit'?'Saving...':'Sending...');}box.appendChild(pending);});
    if(S.actionEditor&&S.actionEditor.record.threadId===thread.id&&S.actionEditor.record.messageRef===(a&&a.messageRef)){if(sameActionActor(S.actionEditor.record.actor)&&S.actionEditor.record.scope===key()&&S.actionEditor.record.path===piecePath())box.appendChild(S.actionEditor.node);else closeActionEditor();}
  }

  function showHeldActionEditorState(editor){
    editor.held=true;editor.node.setAttribute('data-held-action','true');
    var saveEdit=editor.node.querySelector('button');if(saveEdit)saveEdit.disabled=true;
    var attribution=editor.record.actor?'Its original writer stays unchanged.':'Its writer is unknown and stays unknown.';
    editor.status.textContent=(editor.persisted?'Exact words are kept on this device with their original article. You can copy them or close this held edit.':'Device storage failed. Keep this page open and copy your exact words. Close edit retries keeping them with their original article.')+' '+attribution+' This held edit cannot be submitted here.';
  }
  function renderHeldActionEditor(){
    var editor=S.actionEditor;if(!editor||!editor.held||!S.lostBox)return;
    showHeldActionEditorState(editor);S.lostBox.appendChild(editor.node);
  }

  function renderActionRecovery(){if(!S.lostBox)return;clearAcknowledgedActions();actionRecords().filter(function(r){var thread=byId(r.threadId),present=thread&&(!r.messageRef||[thread].concat(thread.replies||[]).some(function(m){return m.actions&&m.actions.messageRef===r.messageRef;}));return !present&&!acknowledgedAction(r,true);}).forEach(function(r){var box=el('section','castor-comment-pending castor-action-recovery');box.appendChild(el('p',null,'Your pending '+r.request.action+' has no available comment. Its exact input is kept on this device.'));if(r.text)box.appendChild(el('p','castor-comment-pending-text',r.text));if(r.submitted&&actionCapability()){var retry=el('button',null,'Retry action');retry.type='button';retry.disabled=!!S.actionSending[r.opId];retry.addEventListener('click',function(e){e.stopPropagation();sendAction(r);});box.appendChild(retry);}S.lostBox.appendChild(box);});}

  function renderRecoveredComments() {
    if (S.lostBox) journalRecords().filter(function (record) {
      return record.closed && (!record.thread || closedReplyDrafts(draftThread(record))[0] === record);
    }).forEach(function (record) {
      var held = el('section', 'castor-comment-pending castor-recovered-comment');
      held.appendChild(el('p', null, record.thread ? 'Closed reply draft' : 'Closed comment draft'));
      held.appendChild(el('p', 'castor-action-status', 'Kept on this device. Resume when you want to use these words.'));
      held.appendChild(el('p', 'castor-comment-pending-text', record.text));
      var resume = el('button', null, 'Resume draft'); resume.type = 'button';
      resume.addEventListener('click', function (event) {
        event.stopPropagation(); closeComposer(); resumeDraft(record); layout(true);
      });
      var discard = el('button', null, 'Discard draft'); discard.type = 'button';
      discard.addEventListener('click', function (event) {
        event.stopPropagation();
        if (typeof global.confirm === 'function' && !global.confirm('Discard these words? They are kept nowhere else.')) return;
        (record.thread ? closedReplyDrafts(draftThread(record)) : [record]).forEach(removeJournal); layout(true);
      });
      held.appendChild(resume); held.appendChild(discard); S.lostBox.appendChild(held);
    });
    if (!S.lostBox || !available()) return;
    var scope = key(), prefix = scope + '.recovered.', encodedScope = encodeURIComponent(scope), storage, copies = [];
    try {
      storage = global.localStorage;
      for (var i = 0; i < storage.length; i++) {
        var name = storage.key(i);
        if (!name || name.indexOf(scope + '.') !== 0) continue;
        var raw = storage.getItem(name), sourceKey = name.replace(/\.recovered\.[a-f0-9]{64}$/, '');
        var encodedSource = name.slice(prefix.length + 65);
        if (name.indexOf(prefix) === 0 && /^[a-f0-9]{64}\./.test(name.slice(prefix.length)) &&
            (encodedSource === encodedScope || encodedSource.indexOf(encodedScope + '.') === 0)) {
          var capsule;
          try { capsule = JSON.parse(raw); } catch (e) { continue; }
          if (!capsule || capsule.v !== 1 || typeof capsule.raw !== 'string' ||
              typeof capsule.sourceKey !== 'string' ||
              capsule.sourceKey !== scope && capsule.sourceKey.indexOf(scope + '.') !== 0) continue;
          raw = capsule.raw; sourceKey = capsule.sourceKey;
        } else if (!/\.recovered\.[a-f0-9]{64}$/.test(name)) continue;
        copies.push({ key: name, sourceKey: sourceKey, raw: raw });
      }
    } catch (e) { /* Existing stored copies remain untouched if storage is unavailable. */ }
    copies.sort(function (a, b) { return a.key.localeCompare(b.key); }).forEach(function (copy) {
      var text = copy.raw;
      try {
        var value = JSON.parse(copy.raw);
        // Submitted input retains the original keystrokes before submit trims them.
        // Unfinished composer/action text is likewise the authoritative raw input.
        // Unknown schemas remain exact JSON rather than synthesised comment words.
        if (value && !Array.isArray(value)) {
          var suffix = copy.sourceKey.slice(scope.length);
          if (suffix.indexOf('.submitted.') === 0 && typeof value.input === 'string') text = value.input;
          else if ((suffix.indexOf('.composer.') === 0 || suffix.indexOf('.actions.') === 0) && typeof value.text === 'string') text = value.text;
        }
      } catch (e) { /* Show exact unreadable source for manual recovery. */ }
      var box = el('section', 'castor-comment-pending castor-comment-editor castor-recovered-comment');
      box.appendChild(el('p', null, 'Recovered comment copy'));
      box.appendChild(el('p', 'castor-action-status', 'Kept separately on this device. Copy the words into a comment or edit when you want to use them.'));
      var input = el('textarea', 'castor-comment-pending-text'); input.readOnly = true;
      input.textContent = text; input.value = text;
      input.setAttribute('aria-label', 'Recovered comment words'); box.appendChild(input);
      var button = el('button', null, 'Copy text'); button.type = 'button';
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        function select() { input.focus(); if (input.select) input.select(); }
        if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText)
          Promise.resolve(global.navigator.clipboard.writeText(text)).catch(select);
        else select();
      });
      box.appendChild(button);
      var discard = el('button', null, 'Discard'); discard.type = 'button';
      discard.addEventListener('click', function (event) {
        event.stopPropagation();
        if (typeof global.confirm === 'function' && !global.confirm('Discard this recovered copy? This cannot be undone.')) return;
        try { global.localStorage.removeItem(copy.key); } catch (e) { /* it stays listed */ }
        box.remove();
      });
      box.appendChild(discard); S.lostBox.appendChild(box);
    });
  }

  function copyThreadLink(thread,card) {
    var url=new URL(global.location.href);url.searchParams.set('thread',thread.id);
    var status=el('p','castor-action-status');status.setAttribute('role','status');card.appendChild(status);
    if(global.navigator&&global.navigator.clipboard&&global.navigator.clipboard.writeText){
      Promise.resolve(global.navigator.clipboard.writeText(url.href)).then(function(){status.textContent='Link copied. Opening it still requires access to this article.';}).catch(function(){show();});
    }else show();
    function show(){status.textContent='Copy this link. Opening it still requires access to this article.';var input=el('input','castor-copy-link');input.readOnly=true;input.value=url.href;input.setAttribute('aria-label','Thread link');status.appendChild(input);input.focus();if(input.select)input.select();}
  }

  function openReply(thread, card, record) {
    if (!available() || ended()) return;
    switchScope();
    thread = journalThread({ thread: thread.id }) || (record && thread);
    if (!thread) return;
    if(!record){open(thread.id);card=panelCard(thread.id)||card;}
    var existing = card && card.querySelector('[data-castor-ui="reply"]');
    if (existing) { focusPanelCard(thread.id,existing.querySelector('textarea, .cw-field')); return; }
    closeComposer();
    // One reply draft per thread: Reply opens the draft closed here, with its words.
    var draft = !record && closedReplyDrafts(thread.id)[0];
    if (draft) { resumeDraft(draft); return; }
    record = record || newComposerRecord(thread.anchor, thread.id);
    var selector = '[data-thread-id="' + thread.id + '"]';
    card = panelCard(thread.id) || (S.page && S.page.querySelector(selector)) || card;
    var box = el('div', 'castor-composer');
    box.setAttribute('data-castor-ui', 'reply');
    box.style.marginTop = '8px';
    var ta = writingField('Reply', 'Reply.');
    box.appendChild(ta);
    var hint = el('div', 'castor-hint', keysHint('sends'));
    box.appendChild(hint);
    var send=el('button',null,'Send reply');send.type='button';send.setAttribute('data-word','Send');send.addEventListener('click',function(e){e.stopPropagation();if(send.getAttribute('data-claim'))record.claimed=true;submit();});var row=sendRow(box);row.appendChild(send);
    var cancel=el('button',null,'Cancel');cancel.type='button';cancel.addEventListener('click',function(e){e.stopPropagation();cancelComposer();});row.appendChild(cancel);
    if (card) card.appendChild(box);
    if (claimable(record) && record.tab !== TAB) askClaim(record, hint, send);
    function submit() {
      if(send.disabled)return false;
      var text = ta.value.trim();
      var journalled = rememberComposer();
      if (!text) { closeComposer(); return false; }
      if (record.path !== piecePath() || !available()) return false;
      if (!composerReady(record, hint, send)) return false;
      var target = journalThread(record);
      if (!target) { hint.textContent = 'This thread is unavailable. Your reply is kept here.'; return false; }
      var reply = {
        id: sentId(record),
        author: record.author, principal: record.principal, reviewer: record.reviewer, reviewerIdentity: record.reviewerIdentity,
        by: 'human', created: new Date().toISOString(), basis: 'the thread', text: text
      };
      var prior=target.replies.findIndex(function(r){return r.id===reply.id;});
      if(prior<0)target.replies.push(reply);else target.replies[prior]=reply;
      if (!save()) {
        target.replies.splice(target.replies.indexOf(reply), 1);
        if (journalled) hint.textContent = 'Reply was not saved. Your words are kept here.';
        return false;
      }
      var sending=S.replySending||(S.replySending={});sending[reply.id]=true;
      finishComposer(reply.id);
      S.expanded[target.id]=true;layout();
      (save.pending||Promise.resolve()).then(function(){delete sending[reply.id];layout();});
      return true;
    }
    S.composer = { node: box, textarea: ta, hint: hint, record: record, submit: submit };
    if (!reviewing() && !ta.castorEditor) wireAt(ta, box);   // the editor has its own @name picker
    trackComposer();
    if (!card) placeComposer();
    composerKeys(ta, box, submit);
    box.addEventListener('click', function (e) { e.stopPropagation(); });
    positionPanel();focusPanelCard(thread.id,ta);scheduleCommentFocus();
  }

  /* ------------------------------------------------------- rendering: page */

  function clearPageUi() {
    if (!S.page) return;
    var slots = S.page.querySelectorAll('[data-castor-ui="thread-slot"]');
    for (var i = 0; i < slots.length; i++) slots[i].remove();
  }

  function featureOn(name) {
    if (!global.getComputedStyle) return false;
    var style = Castor.frameReads ? Castor.frameReads.style(DOC.documentElement) : global.getComputedStyle(DOC.documentElement);
    var v = style.getPropertyValue(name).trim().toLowerCase();
    return v === 'on' || v === '1' || v === 'true';
  }
  function marginRouted() { return featureOn('--margin-routing') || featureOn('--comment-margin'); }

  var READINGS = { quiet: true, inline: true };
  function quiet() { return S.reading !== 'inline'; }

  /* The panel head's view control follows a change of reading or layout. */
  function refreshShows() {
    if (!S.panelEl) return;
    var sec = S.panelEl.closest ? S.panelEl.closest('section') : (S.panelEl.parentElement && S.panelEl.parentElement.tagName === 'SECTION' ? S.panelEl.parentElement : null);
    if (!sec) return;
    var headShows = sec.querySelector ? sec.querySelector('[data-castor-ui="comment-shows"]') : null;
    if (headShows) updateShows(headShows);
  }

  function setReading(name) {
    name = String(name || '').toLowerCase();
    if (!READINGS[name]) {
      throw new RangeError('Unknown comment reading "' + name + '". Use quiet or inline.');
    }
    S.reading = name;
    if (DOC && DOC.documentElement) DOC.documentElement.setAttribute('data-comments-reading', name);
    try { localStorage.setItem('castor.' + S.world + '.comments.reading', name); } catch (e) { /* private mode */ }
    closePeek();
    layout();
    refreshShows();
    return name;
  }

  var LAYOUTS = { list: 1, beside: 1 };
  function setPanelLayout(name) {
    name = String(name || '').toLowerCase();
    if (!LAYOUTS[name]) {
      throw new RangeError('Unknown comment layout "' + name + '". Use list or beside.');
    }
    S.panelLayout = name;
    if (DOC && DOC.documentElement) DOC.documentElement.setAttribute('data-comment-layout', name);
    try { localStorage.setItem('castor.' + S.world + '.comments.layout', name); } catch (e) { /* private mode */ }
    if (S.wrap) S.wrap.style.top = '';
    closePeek();
    layout();
    refreshShows();
    return name;
  }

  /* Who is in this thread, for the mark's tint. A thread both a person and an
     agent have written in is --between, the olive the signature already defines as
     what the two of them make together; inventing a fourth colour for "mixed"
     would add a meaning to the palette, which the design system forbids. */
  function threadBy(thread) {
    var human = false, machine = false;
    var messages = [thread].concat(thread.replies || []);
    for (var i = 0; i < messages.length; i++) {
      if (!messages[i]) continue;
      if (messages[i].by === 'agent') machine = true; else human = true;
    }
    if (human && machine) return 'both';
    return machine ? 'agent' : 'human';
  }

  function renderPageThreads() {
    /* Quiet reading keeps comment bodies out of the prose flow. A declared
       margin can show the same thread without pushing paragraphs apart. */
    if (quiet() && !marginRouted()) { clearPageUi(); return; }
    var oldSlots = S.page.querySelectorAll('[data-castor-ui="thread-slot"]');
    var list = visibleThreads(), byBlock = {}, order = [];
    for (var i = 0; i < list.length; i++) {
      var r = passageEnd(S.resolved[list[i].id]);
      if (!r) continue;                                   // detached: panel only
      if (!byBlock[r.blockId]) { byBlock[r.blockId] = []; order.push(r.blockId); }
      byBlock[r.blockId].push(list[i]);
    }
    var routed = marginRouted(), placed = [];
    for (var j = 0; j < order.length; j++) {
      var b = blockById(order[j]);
      if (!b) continue;
      var threads = byBlock[order[j]], slot = null;
      var signature = JSON.stringify([threads, S.expanded, S.actionJournal, S.actionReceipts, S.actionErrors, S.replySending, S.actionSending, S.actionEditor && S.actionEditor.record.opId, routed, S.commentActions && S.commentActions.actor, S.ended]);
      for (var n = 0; n < oldSlots.length; n++) {
        if (oldSlots[n].getAttribute('data-comment-block') === order[j]) { slot = oldSlots[n]; break; }
      }
      if (!slot) {
        slot = el('div', 'castor-thread-slot');
        slot.setAttribute('data-castor-ui', 'thread-slot');
        slot.setAttribute('data-comment-block', order[j]);
      }
      // Keep the occupied slot through focus and viewport changes. Removing it
      // first lets WebKit clamp/anchor the article against a temporarily short page.
      if (slot._castorThreads !== signature) {
        slot.textContent = '';
        for (var k = 0; k < threads.length; k++) slot.appendChild(threadCard(threads[k], { quote: false }));
        slot._castorThreads = signature;
      }
      if (routed) slot.setAttribute('data-margin-route', 'comment');
      else slot.removeAttribute('data-margin-route');
      placed.push({ slot: slot, block: b.el });
    }
    if (routed) placed.forEach(function (p) {
      p.top = Math.round(p.block.getBoundingClientRect().top - p.block.parentElement.getBoundingClientRect().top);
    });
    placed.forEach(function (p) {
      if (routed) {
        p.slot.dataset.marginAt = String(p.top);
        p.slot.dataset.marginAnchor = p.block.getAttribute('data-block-id');
      }
      if (p.block.nextSibling !== p.slot) p.block.parentNode.insertBefore(p.slot, p.block.nextSibling);
    });
    for (var stale = 0; stale < oldSlots.length; stale++) {
      if (!placed.some(function (p) { return p.slot === oldSlots[stale]; })) oldSlots[stale].remove();
    }
  }

  /* ------------------------------------------------------ rendering: panel */

  function updateShows(showsEl) {
    if (!showsEl) return;
    var btns = showsEl.querySelectorAll ? showsEl.querySelectorAll('button') : [];
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var text = b.textContent || b._text;
      if (text === 'In the page') {
        b.setAttribute('aria-pressed', String(S.reading === 'inline'));
      } else if (text === 'Beside') {
        b.setAttribute('aria-pressed', String(S.panelLayout === 'beside'));
      }
    }
  }

  function mountHeadShows(bodyEl) {
    if (!bodyEl) return;
    var section = bodyEl.closest ? bodyEl.closest('section') : (bodyEl.parentElement && bodyEl.parentElement.tagName === 'SECTION' ? bodyEl.parentElement : null);
    if (!section) return;
    var head = section.querySelector ? section.querySelector('.panel-head, header') : null;
    if (!head) return;
    var existing = head.querySelector ? head.querySelector('[data-castor-ui="comment-shows"]') : null;
    if (existing) {
      updateShows(existing);
      return;
    }
    var shows = el('div', 'castor-shows');
    shows.setAttribute('data-castor-ui', 'comment-shows');
    shows.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    shows.addEventListener('keydown', function (e) { e.stopPropagation(); });

    var inPage = withIcon(el('button', null, 'In the page'), 'inline');
    inPage.type = 'button';
    inPage.title = 'Show each thread under its paragraph';
    inPage.setAttribute('aria-pressed', String(S.reading === 'inline'));
    inPage.addEventListener('click', function (e) {
      e.stopPropagation();
      setReading(S.reading === 'inline' ? 'quiet' : 'inline');
      updateShows(shows);
    });

    var beside = withIcon(el('button', null, 'Beside'), 'beside');
    beside.type = 'button';
    beside.title = 'Put each card level with its passage, joined by a line';
    beside.setAttribute('aria-pressed', String(S.panelLayout === 'beside'));
    beside.addEventListener('click', function (e) {
      e.stopPropagation();
      setPanelLayout(S.panelLayout === 'beside' ? 'list' : 'beside');
      updateShows(shows);
    });

    shows.appendChild(inPage);
    shows.appendChild(beside);

    var close = head.querySelector ? head.querySelector('.panel-close, .word.panel-close') : null;
    if (close && close.parentNode === head) {
      head.insertBefore(shows, close);
    } else {
      head.appendChild(shows);
    }
  }

  function mountPanel(bodyEl) {
    S.panelEl = bodyEl;
    mountHeadShows(bodyEl);
    bodyEl.addEventListener('pointerdown', holdCommentFocus);
    bodyEl.addEventListener('focusin', scheduleCommentFocus);
    bodyEl.addEventListener('focusout', scheduleCommentFocus);
    bodyEl.addEventListener('input', scheduleCommentFocus);
    // The panel owns list scrolling, including detached cards and the footer.
    // Capture intent before a child control can stop the event. Native scroll
    // events also follow our own reveals, so they must never clear navigation.
    function browseList(event) {
      if (event.type === 'keydown' &&
          (!/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(event.key) ||
           event.target.closest && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return;
      S.revealId = null;
    }
    ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown'].forEach(function (type) {
      bodyEl.addEventListener(type, browseList, { passive: true, capture: true });
    });
    bodyEl.textContent = '';
    var root = el('div', 'castor-comments');

    S.filterBox = el('div', 'castor-filter');
    root.appendChild(S.filterBox);

    S.lostBox = el('div', 'castor-lost');
    root.appendChild(S.lostBox);

    /* A dock with nothing in it must still say what it is for. Without this the
       panel shipped as an empty rectangle under two filter words. */
    S.emptyBox = el('div', 'castor-empty');
    S.emptyBox.setAttribute('data-castor-ui', 'comments-empty');
    root.appendChild(S.emptyBox);

    S.wrap = el('div', 'castor-canvas-wrap');
    S.canvas = el('div', 'castor-canvas');
    S.canvas.setAttribute('data-castor-ui', 'panel-canvas');
    if (S.leaders && S.leaders.parentNode) S.leaders.remove();
    S.leaders = DOC.createElementNS('http://www.w3.org/2000/svg', 'svg');
    S.leaders.setAttribute('class', 'castor-leaders');
    S.canvas.appendChild(S.leaders);
    S.wrap.appendChild(S.canvas);
    root.appendChild(S.wrap);

    bodyEl.appendChild(root);
    bodyEl.appendChild(el('div','comments-agent-slot'));
    schedule();
  }

  // An agent's own name in the author menu, as its messages show it; a person's name as it is.
  function authorOptionName(label) {
    var agent = S.threads.some(function (t) { return [t].concat(t.replies || []).some(function (m) { return m && m.author === label && authorKind(m) === 'agent'; }); });
    return agent ? agentName(label) : label;
  }
  function renderFilter() {
    if (!S.filterBox) return;
    var names = [];
    var people = (Castor.app && Castor.app.data && Castor.app.data.people) || [];
    people.forEach(function (p) {
      if (p && p.name && p.kind !== 'agent' && names.indexOf(p.name) < 0 && !/^You$|^Your agent$/.test(p.name)) {
        names.push(p.name);
      }
    });
    S.threads.forEach(function (t) {
      [t].concat(t.replies || []).forEach(function (m) {
        var raw = m && m.author;
        if (raw && !/^You$|^Your agent$/.test(raw)) {
          var p = configuredPerson(m);
          var label = (p && p.name) ? p.name : raw;
          if (label && names.indexOf(label) < 0 && !/^You$|^Your agent$/.test(label)) {
            names.push(label);
          }
          if (raw && names.indexOf(raw) < 0 && !/^You$|^Your agent$/.test(raw)) {
            names.push(raw);
          }
        }
      });
    });
    var done = doneCount();
    var stamp = JSON.stringify([key(), piecePath(), S.filter, S.authorFilter, names, done]);
    if (S.filterBox._castorFilterStamp === stamp) return;
    S.filterBox._castorFilterStamp = stamp;
    S.filterBox.textContent = '';
    var tabs=el('div','castor-status-tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','Comment status');S.filterBox.appendChild(tabs);
    ['open', 'done', 'all', 'withdrawn'].forEach(function (name) {
      var b = el('button', 'castor-word', name === 'open' ? 'Open' : name==='done'?'Done':name==='all'?'All':'Withdrawn');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(S.filter === name));
      b.addEventListener('click', function () { S.filter = name; layout(); });
      tabs.appendChild(b);
    });

    var chooser = el('details', 'castor-author-filter');
    chooser.setAttribute('aria-label', 'Filter comments by author');
    var summary = withIcon(el('summary'), 'authors');
    summary.appendChild(el('span','castor-author-label',S.authorFilter ? authorOptionName(S.authorFilter) : 'All authors'));summary.setAttribute('data-filtered',String(!!S.authorFilter));summary.title=S.authorFilter || 'All authors';summary.setAttribute('aria-label','Filter comments by author: '+(S.authorFilter || 'All authors'));
    chooser.appendChild(summary);
    chooser.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); chooser.removeAttribute('open'); summary.focus(); }
    });
    chooser.addEventListener('focusout', function (event) {
      if (event.relatedTarget && !chooser.contains(event.relatedTarget)) chooser.removeAttribute('open');
    });
    var menu = el('div', 'castor-author-menu');
    // The menu opens inside the panel and the window: toward whichever side has
    // room, and never wider than the room there is.
    chooser.addEventListener('toggle', function () {
      if (!chooser.open || !menu.getBoundingClientRect) return;
      menu.style.left = ''; menu.style.right = ''; menu.style.maxWidth = '';
      var box = chooser.closest && chooser.closest('.panel, section, .dock') || DOC.documentElement;
      var room = box.getBoundingClientRect(), at = chooser.getBoundingClientRect();
      var right = Math.min(room.right, global.innerWidth || room.right) - 8, left = Math.max(room.left, 0) + 8;
      var width = menu.getBoundingClientRect().width;
      if (at.left + width > right) { menu.style.left = 'auto'; menu.style.right = '0'; }
      menu.style.maxWidth = Math.max(120, Math.floor((at.left + width > right ? at.right - left : right - at.left))) + 'px';
    });
    ['All authors'].concat(names).forEach(function (label) {
      var btn = el('button', 'castor-author-option', label === 'All authors' ? label : authorOptionName(label));
      btn.type = 'button';
      var active = label === 'All authors' ? !S.authorFilter : S.authorFilter === label;
      btn.setAttribute('aria-pressed', String(active));
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        S.authorFilter = label === 'All authors' ? '' : label;
        chooser.removeAttribute('open');
        layout();
      });
      menu.appendChild(btn);
    });
    chooser.appendChild(menu);
    S.filterBox.appendChild(chooser);


  }

  var EMPTY = {
    open: 'No open comments. Select words and choose Comment.',
    done: 'Nothing marked done yet.'
  };

  function emptyWords() {
    if(S.authorFilter||S.filter==='all'||S.filter==='withdrawn')return 'No comments match these filters.';
    if (S.filter === 'done') return EMPTY.done;
    var done = S.threads.filter(function (t) { return t.done; }).length;
    if (!done) return EMPTY.open;
    return 'Nothing open. ' + done + (done === 1 ? ' comment is' : ' comments are') +
      ' marked done. Press Done above to read them.';
  }

  function renderEmpty() {
    if (!S.emptyBox) return;
    var empty = visibleThreads().length === 0;
    S.emptyBox.textContent = empty ? emptyWords() : '';
    S.emptyBox.hidden = !empty;
    placeEmpty();
  }
  function placeEmpty() {
    S.emptyOver = 0;
    if (!S.emptyBox || S.emptyBox.hidden) return;
    var over = (S.filterBox ? S.filterBox.offsetHeight : 0) +
      (S.lostBox && S.lostBox.offsetHeight ? S.lostBox.offsetHeight : 0);
    var want = (over + 8) + 'px';
    if (S.emptyBox.style.paddingTop !== want) S.emptyBox.style.paddingTop = want;
    S.emptyOver = over;
  }

  var BURST = 3;

  function renderLost() {
    if (!S.lostBox) return;
    S.lostBox.textContent = '';
    /* Under the filter row whatever its height: one line is 24px, a narrow dock
       wraps it to two. */
    var foot = S.filterBox ? S.filterBox.offsetHeight : 0;
    S.lostBox.style.top = S.panelLayout === 'list' ? '' : (foot || 24) + 'px';
    var lost = visibleThreads().filter(function (t) { return !S.resolved[t.id]; });
    if (!lost.length) return;
    var total = visibleThreads().length;
    if (lost.length >= BURST && !S.burstOpen) {
      var refocus = !!(DOC.activeElement && DOC.activeElement.closest && DOC.activeElement.closest('.castor-burst'));
      var shows = disclosure('castor-burst', lost.length + ' comments without a passage', !!S.burstExpanded,
        function (now) { S.burstExpanded = now; schedulePlace(); });
      var band = shows.node, inside = shows.body;
      band.setAttribute('data-castor-ui', 'burst');
      inside.appendChild(el('p', 'castor-burst-line',
        lost.length + ' of ' + total + (total === 1 ? ' comment has' : ' comments have') +
        ' no passage here. Open them to see which concern the whole article and which have lost their words.'));
      inside.appendChild(el('p', 'castor-burst-note',
        'Keeping them as history leaves each one attached to the version it was written against. ' +
        'Moving one to where its point now lives is a judgement per comment, so the agent does it one at a time.'));
      var acts = el('div', 'castor-acts');
      var show = el('button', null, 'Show them');
      show.type = 'button';
      show.addEventListener('click', function (e) { e.stopPropagation(); S.burstOpen = true; layout(); });
      var keep = el('button', null, 'Keep as history');
      keep.type = 'button';
      keep.addEventListener('click', function (e) {
        e.stopPropagation();
        lost.forEach(function(t){sendAction(newAction(t,null,'resolve'));});
      });
      acts.appendChild(show);
      var capability=actionCapability();
      if(capability&&capability.actor.kind==='founder-capability'&&lost.every(function(t){return t.statusActions&&t.statusActions.canResolve;}))acts.appendChild(keep);
      inside.appendChild(acts);
      S.lostBox.appendChild(band);
      if (refocus && shows.button.focus) shows.button.focus();
      return;
    }
    var head = el('div', 'castor-lost-head', 'Without a passage');
    if (S.burstOpen && lost.length >= BURST) {
      var back = el('button', 'castor-burst-back', 'Summarise');
      back.type = 'button';
      back.addEventListener('click', function (e) { e.stopPropagation(); S.burstOpen = false; layout(); });
      head.appendChild(back);
    }
    S.lostBox.appendChild(head);
    lost.forEach(function (t) {
      // Compact on purpose: the quote and Find it are always visible (nothing is hidden),
      // and the whole thread is one word away. A full card here would cover the band that
      // the anchored cards need.
      if (S.expanded['lost-' + t.id]) {
        var card = threadCard(t);
        var acts = card.querySelector('.castor-acts');
        var find = el('button', null, 'Find it');
        find.type = 'button';
        find.addEventListener('click', function (e) { e.stopPropagation(); findIt(t); });
        if (t.anchor.quote) acts.insertBefore(find, acts.firstChild);
        var less = el('button', null, 'Hide the thread');
        less.type = 'button'; less.setAttribute('aria-expanded', 'true');
        less.addEventListener('click', function (e) {
          e.stopPropagation();
          S.expanded['lost-' + t.id] = false;
          layout();
        });
        acts.appendChild(less);
        offerCandidates(card, t);
        S.lostBox.appendChild(card);
        return;
      }
      var row = el('div', 'castor-thread is-lost');
      row.setAttribute('data-thread-id', t.id);
      row.setAttribute('data-castor-ui', 'thread');
      row.addEventListener('click', function (event) { cardClicked(event, t); });
      if (t.anchor.quote) row.appendChild(el('div', 'castor-quote', (t.done ? '✓ ' : '') + '\u201C' + passageOf(t.anchor) + '\u201D'));
      row.appendChild(el('div', 'castor-passage-status', passageStatus(t)));
      var acts = el('div', 'castor-acts');
      var find = el('button', null, 'Find it');
      find.type = 'button';
      find.addEventListener('click', function (e) { e.stopPropagation(); findIt(t); });
      var open = el('button', null, 'Show the thread');
      open.type = 'button'; open.setAttribute('aria-expanded', 'false');
      open.addEventListener('click', function (e) {
        e.stopPropagation();
        S.expanded['lost-' + t.id] = true;
        layout();
      });
      if (t.anchor.quote) acts.appendChild(find);
      acts.appendChild(open);
      row.appendChild(acts);
      offerCandidates(row, t);
      S.lostBox.appendChild(row);
    });
  }

  function positionPanel() {
    // Reserve the native form bar for the entire scrollport, including ordinary
    // card actions and the agent footer, rather than only the focused field.
    if (S.panelEl && S.panelEl.parentNode && S.panelEl.parentNode.getBoundingClientRect) {
      var edge = S.panelEl.parentNode.getBoundingClientRect().bottom;
      S.panelEl.style.marginBottom = Math.max(0, edge - commentViewport().bottom) + 'px';
    }
    positionDoneUndo();
    if (!S.canvas) return;
    var cards = S.canvas.querySelectorAll('.castor-thread');
    S.items = [];
    for (var i = 0; i < cards.length; i++) {
      S.items.push({ id: cards[i].getAttribute('data-thread-id'), card: cards[i], height: cards[i].offsetHeight });
    }
    place();
  }

  function place() {
    if (!S.canvas || !S.wrap || !S.page) return;
    if (S.panelLayout === 'list') {
      S.canvas.style.height = '';
      S.canvas.style.paddingBottom = '';
      placeEmpty();
      S.wrap.style.top = '';
      sizeLeaders(0, []);
      if (S.revealId) revealPanelCard(panelCard(S.revealId));
      return;
    }
    placeEmpty();
    var head = 0;
    if (S.filterBox) head += S.filterBox.offsetHeight;
    if (S.lostBox && S.lostBox.offsetHeight) head += S.lostBox.offsetHeight;
    if (S.emptyBox && !S.emptyBox.hidden) head += S.emptyBox.offsetHeight - (S.emptyOver || 0);
    if (Math.abs((parseFloat(S.wrap.style.top) || 0) - head) > 0.5) S.wrap.style.top = head + 'px';
    var band = S.wrap.getBoundingClientRect();
    var items = S.items || [];
    if (!items.length) {
      S.canvas.style.height = '';
      sizeLeaders(0, []);
      return;
    }

    // On a phone the sheet lies under the page, not beside it: a card is level with its passage when it
    // sits as far under the top of the sheet's list as the passage sits under the top of the visible page.
    // Measured from the sheet's own top instead, every readable passage would have its card above the list.
    var from = band.top, panels = Castor.panels;
    if (panels && panels.state && panels.state().mode === 'phone') {
      var scroller = S.page.closest && S.page.closest('.page-scroll'), bar = DOC.getElementById('topbar');
      from = Math.max(scroller ? scroller.getBoundingClientRect().top : 0, bar ? bar.getBoundingClientRect().bottom : 0);
    }
    var wanted = items.map(function (it) {
      var target = passageEl(it.id);
      return { it: it, y: target ? (target.getBoundingClientRect().top - from) : 0 };
    }).sort(function (a, b) { return a.y - b.y; });

    // No floor on the first card: a thread whose passage has scrolled off the top
    // goes with it, exactly as the passage does.
    var GAP = 10, cursor = -1e6, placed = [];
    for (var i = 0; i < wanted.length; i++) {
      var w = wanted[i], top = Math.max(w.y, cursor);
      placed.push({ w: w, top: top });
      cursor = top + w.it.height + GAP;
    }

    /* Where the band sits.
       Normally at PAD, which puts every card exactly level with its passage. PAD
       is whatever the topmost card needs to be a positive offset, so a passage
       that has scrolled above the panel still has its card in the layer — above
       the fold, reachable, never clipped away. Only when NOT ONE card would be
       visible does the band scroll away from PAD, to the nearest card: a scroll
       is honest, moving a card away from its words is not. */
    var PAD = Math.max(0, Math.ceil(-placed[0].top) + 8);
    var lastP = placed[placed.length - 1];
    var target = PAD;
    var anyIn = placed.some(function (p) {
      return p.top + p.w.it.height > 0 && p.top < band.height;
    });
    if (!anyIn) {
      target = placed[0].top >= band.height
        ? placed[0].top + PAD - 12                                       // all below: show the first
        : lastP.top + PAD + lastP.w.it.height + 16 - band.height;        // all above: show the last
    }
    // the window the reader can actually see, in the same space as `top`
    var OFF = target - PAD, WTOP = OFF + 8, WBOT = OFF + band.height - 8;

    /* A card that overlaps the visible window without fitting inside it is the
       one the finish review photographed, cut through its own second line. It is
       pulled to fit, never onto the card beside it; if it cannot fit it is put
       wholly out of the window, because a sliver of a card is the same defect as
       a cut one. Both passes work in the window, not in the band, so they still
       hold when the band has scrolled to the nearest card. */
    for (var b = placed.length - 1; b >= 0; b--) {
      var q = placed[b], qh = q.w.it.height;
      if (q.top >= OFF + band.height) continue;        // wholly below the window
      if (q.top + qh <= WBOT) continue;                // fits
      if (qh + 16 > band.height) continue;             // taller than the window
      var floorTop = b > 0 ? placed[b - 1].top + placed[b - 1].w.it.height + GAP : OFF;
      var want = WBOT - qh;
      q.top = (want >= floorTop && want >= WTOP - 8) ? want : OFF + band.height;
    }
    for (var t = 0; t < placed.length; t++) {
      var u = placed[t], uh = u.w.it.height;
      if (u.top >= WTOP) break;                        // this one and the rest are fine
      if (u.top + uh <= OFF) continue;                 // wholly above the window
      if (uh + 16 > band.height) continue;
      var ceilTop = t + 1 < placed.length ? placed[t + 1].top - uh - GAP : WBOT - uh;
      u.top = ceilTop >= WTOP ? WTOP : OFF - uh;
    }

    var maxBottom = 0, minTop = Infinity;
    for (var j = 0; j < placed.length; j++) {
      var p = placed[j], at = p.top + PAD;
      p.at = at;
      p.w.it.card.style.top = Math.round(at) + 'px';
      maxBottom = Math.max(maxBottom, at + p.w.it.height);
      minTop = Math.min(minTop, at);
    }

    /* As tall as the stack needs, plus room under the last card — and never
       shorter than `target + the band`, or the scroll below is not reachable and
       every card lands a constant distance off its passage. */
    var layerH = Math.max(band.height, maxBottom + 16, target + band.height);
    S.canvas.style.height = layerH + 'px';
    target = Math.max(0, Math.min(target, layerH - band.height));
    // A comment being written keeps the place its reveal gave it: on a phone the keyboard and
    // every key run this, and the list must not move the field and its Save edit away under them.
    var writing = S.actionEditor && holdsFocus(S.actionEditor.textarea) && S.wrap.contains(S.actionEditor.node) ||
      S.composer && holdsFocus(S.composer.textarea) && S.wrap.contains(S.composer.node);
    if (!writing && Math.abs(S.wrap.scrollTop - target) > 1) {
      S.selfScroll = true;
      S.wrap.scrollTop = target;
      S.selfScroll = false;
    }
    /* The leader belongs to the panel's gutter, so its coordinates stay with the
       scrolling canvas rather than spanning the viewport to the reading page. */
    sizeLeaders(layerH, placed);
    if (S.revealId) revealPanelCard(panelCard(S.revealId));
  }

  function schedulePlace() {
    if (S.placeRaf) return;
    S.placeRaf = global.requestAnimationFrame(function () { S.placeRaf = 0; place(); });
  }

  function sizeLeaders(height, placed) {
    if (!S.leaders) return;
    S.leaders.setAttribute('width', '20');
    S.leaders.setAttribute('height', String(Math.max(height || 0, 0)));
    S.leaders.textContent = '';
    var band = S.wrap && S.wrap.getBoundingClientRect();
    if (!band || band.width < 2 || band.height < 2) return;
    var scrollTop = S.wrap.scrollTop;
    (placed || []).forEach(function (item) {
      // Every passage line inside the visible band gets the same short elbow.
      // Collision changes the card's top, never whether the relationship is drawn.
      if (item.w.y <= 0 || item.w.y >= band.height) return;
      var p = DOC.createElementNS('http://www.w3.org/2000/svg', 'path');
      var fromY = Math.round(item.w.y + scrollTop);
      var toY = Math.round(item.at + 12);
      p.setAttribute('d', Math.abs(toY - fromY) <= 2
        ? 'M0 ' + fromY + ' H16'
        : 'M0 ' + fromY + ' H8 V' + toY + ' H16');
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'var(--ink-faint, rgba(0,0,0,.42))');
      p.setAttribute('stroke-width', '1');
      p.setAttribute('data-thread-id', item.w.it.id);
      S.leaders.appendChild(p);
    });
  }

  // What the card points at: the first mark of the thread when the words could be
  // wrapped, otherwise the block itself.
  function passageEl(threadId) {
    if (!S.page) return null;
    var m = S.page.querySelector('mark.commented[data-thread="' + threadId + '"]');
    if (m) return m;
    var r = S.resolved[threadId];
    var b = r && blockById(r.blockId);
    return b ? b.el : null;
  }

  function renderPanelCards() {
    if (!S.canvas) return;
    var old = S.canvas.querySelectorAll('.castor-thread');
    var list = visibleThreads().filter(function (t) { return !!S.resolved[t.id]; });
    // Keep equal-endpoint threads together, in the same order as their single pin.
    var endpoints = {}, order = [];
    list.forEach(function (t) {
      var r = passageEnd(S.resolved[t.id]), key = r.blockId + ':' + r.end;
      if (!endpoints[key]) { endpoints[key] = []; order.push(key); }
      endpoints[key].push(t);
    });
    list = [].concat.apply([], order.map(function (key) { return endpoints[key]; }));
    var signature = JSON.stringify([list, S.expanded, S.actionJournal, S.actionReceipts, S.actionErrors, S.replySending, S.actionSending, S.actionEditor && S.actionEditor.record.opId, S.storageKey, S.commentActions && S.commentActions.actor, S.ended]);
    if (signature === S.panelCardsSignature && old.length === list.length) return;
    S.panelCardsSignature = signature;
    for (var i = 0; i < old.length; i++) old[i].remove();
    if (!list.length) return;
    for (var j = 0; j < list.length; j++) S.canvas.appendChild(threadCard(list[j], { quote: false }));
  }

  /* Bond is a world capability, not comment styling. Register the semantic
     pair against the engine's single overlay and let the registry decide
     whether the active world paints it. The inline thread is always live, so
     the first bond does not depend on opening the Comments panel. */
  function syncBonds() {
    if (!Castor.bonds) return;
    Castor.bonds.clear('comment:');
    visibleThreads().forEach(function (thread) {
      if (!S.resolved[thread.id]) return;
      Castor.bonds.register('comment:' + thread.id, {
        kind: 'comment-to-passage',
        from: function () {
          /* In quiet reading there is no card in the page to draw from, and the
             panel draws its own twenty-pixel elbow in its own gutter. Returning
             null here leaves the bond unpainted rather than pointing at nothing. */
          if (quiet()) return null;
          return S.page && S.page.querySelector('.castor-thread-slot .castor-thread[data-thread-id="' + thread.id + '"]');
        },
        to: function () {
          return S.page && S.page.querySelector('mark.commented[data-thread="' + thread.id + '"]');
        }
      });
    });
    Castor.bonds.layout();
  }

  /* ------------------------------------------------------- moving about */

  function flash(thread) {
    var target = passageEl(thread.id);
    // Comments owns the current rendered-text resolution. A second editor
    // resolver can scroll elsewhere, then repaint away the active comment mark.
    if (!target || !S.resolved[thread.id]) return;
    var reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ block: 'center', behavior: reduce ? 'instant' : 'smooth' });
    var marks = S.page.querySelectorAll('mark.commented[data-thread="' + thread.id + '"]');
    var nodes = marks.length ? marks : [target];
    for (var i = 0; i < nodes.length; i++) {
      (function (n) {
        n.classList.remove('castor-flash');
        void n.offsetWidth;                       // restart the animation
        n.classList.add('castor-flash');
        global.setTimeout(function () { n.classList.remove('castor-flash'); }, 950);
      })(nodes[i]);
    }
  }

  function lift(id) {
    S.active = id;
    var cards = DOC.querySelectorAll('.castor-thread[data-thread-id]');
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle('is-lifted', cards[i].getAttribute('data-thread-id') === id);
    }
    var marks = S.page ? S.page.querySelectorAll('mark.commented') : [];
    for (var j = 0; j < marks.length; j++) {
      marks[j].classList.toggle('is-lifted', marks[j].getAttribute('data-thread') === id);
    }
  }

  function open(id) {
    if (S.touchPeek) closeTouchPeek();
    var t = byId(id);
    if (!t) return;
    var alreadyOpen = Castor.panels && Castor.panels.isOpen && Castor.panels.isOpen('comments');
    closePeek();
    if(Castor.panels&&Castor.panels.open)Castor.panels.open('comments','right');
    S.expanded[id] = true;S.expanded['lost-'+id]=true;
    if(!S.resolved[id])S.burstOpen=true;
    S.authorFilter='';
    if(S.filter!=='all')S.filter=t.done?'done':'open';
    S.active=id;
    S.revealId=id;
    layout(true);
    lift(id);
    focusPanelCard(id);
    if (!alreadyOpen) revealTouchPassage(id);
  }

  function panelCard(id){var selector='.castor-thread[data-thread-id="'+id+'"]';return S.panelEl&&S.panelEl.querySelector(selector);}
  function focusPanelCard(id,field){var card=panelCard(id),target=field||card;if(!target)return;if(card)card.setAttribute('tabindex','-1');target.focus({preventScroll:true});if(card)revealPanelCard(card,field);}
  function commentCaretRect(field) {
    var selection = global.getSelection && global.getSelection();
    if (selection && selection.rangeCount) {
      var range = selection.getRangeAt(0);
      if (field.contains(range.commonAncestorContainer)) {
        range = range.cloneRange(); range.collapse(false);
        var rects = range.getClientRects();
        if (rects.length && rects[0].height) return rects[0];
        // WebKit also returns no rect at an element boundary after bold. Walk
        // adjacent text, skipping hidden Markdown markers and empty elements.
        function adjacent(backward) {
          var node = range.startContainer, offset = range.startOffset;
          while (node && field.contains(node)) {
            if (node.nodeType === 3) {
              var length = node.nodeValue.length;
              if (backward ? offset > 0 : offset < length) {
                var probe = range.cloneRange(), at = backward ? offset - 1 : offset;
                probe.setStart(node, at); probe.setEnd(node, at + 1);
                var boxes = probe.getClientRects();
                for (var i = backward ? boxes.length - 1 : 0; backward ? i >= 0 : i < boxes.length; i += backward ? -1 : 1) {
                  if (boxes[i].height) return boxes[i];
                }
              }
            } else if (node.childNodes && (backward ? offset > 0 : offset < node.childNodes.length)) {
              node = node.childNodes[backward ? offset - 1 : offset];
              offset = backward ? (node.nodeType === 3 ? node.nodeValue.length : node.childNodes.length) : 0;
              continue;
            }
            if (node === field || !node.parentNode) break;
            var parent = node.parentNode;
            offset = Array.prototype.indexOf.call(parent.childNodes, node) + (backward ? 0 : 1);
            node = parent;
          }
          return null;
        }
        var nearby = adjacent(true) || adjacent(false);
        if (nearby) return nearby;
      }
    }
    return field.getBoundingClientRect();
  }

  // With a keyboard up (a comment's or the article's), a button in the comments (Post, Save edit, Reply,
  // Edit, Send to agent, Cancel...) keeps the field's focus until its own click: nothing blurs, rerenders
  // or moves under the finger, so the native click lands on the button, which then decides where focus
  // goes. Only the focus-changing mouse default is cancelled: a cancelled touch loses WebKit's click, and
  // on iOS it leaves the next long press opening typing mode instead of selecting.
  function holdCommentFocus(event) {
    if (event.type === 'pointerdown') return;
    var target = event.target;
    if (!target.closest) return;
    var button = target.closest('button');
    var comments = target.closest('.castor-comment-editor button, .castor-composer > button, .castor-composer > .castor-sendrow > button, .castor-comment-undo button') ||
      button && (S.panelEl && S.panelEl.contains && S.panelEl.contains(button) || S.composer && S.composer.node && S.composer.node.contains(button));
    if (comments && (S.actionEditor && holdsFocus(S.actionEditor.textarea) || S.composer && holdsFocus(S.composer.textarea) ||
        DOC.activeElement && DOC.activeElement.closest && DOC.activeElement.closest('.cw-edit, textarea, [contenteditable="true"]'))) event.preventDefault();
  }

  function scheduleCommentFocus() {
    if (S.commentFocusRaf) return;
    S.commentFocusRaf = global.requestAnimationFrame(function () {
      S.commentFocusRaf = 0;
      var edit = S.actionEditor, composer = S.composer;
      var field = edit && holdsFocus(edit.textarea) ? edit.textarea :
        composer && holdsFocus(composer.textarea) ? composer.textarea : null;
      positionPanel();
      if (!field) return;
      if (composer && field === composer.textarea && composer.node.classList.contains('is-floating')) {
        placeComposer();
        revealPanelCard(composer.node, field);
        return;
      }
      var id = edit && field === edit.textarea ? edit.record.threadId : composer.record.thread;
      // The card that holds the field: in the sheet, or under its paragraph in the page.
      var card = field.closest && field.closest('.castor-thread') || panelCard(id);
      if (card) revealPanelCard(card, field);
      else if (composer) revealPanelCard(composer.node, field);
    });
  }

  function commentViewport() {
    var vv = global.visualViewport, app = DOC.getElementById('app');
    // Embedded mounts without the app's keyboard state retain a layout-height
    // fallback. In the app, a window resize is not a software keyboard.
    if (S.commentViewportWidth !== global.innerWidth) {
      S.commentViewportWidth = global.innerWidth;
      S.commentViewportHeight = 0;
    }
    S.commentViewportHeight = Math.max(S.commentViewportHeight || 0, global.innerHeight || 0, vv ? vv.height : 0);
    var bottom = vv ? vv.height + (vv.offsetTop || 0) : global.innerHeight || Infinity;
    // iOS can count its native form bar as visible. Share this reservation
    // between the panel, field/action reveal, floating composer and Undo.
    var touch = !global.matchMedia || global.matchMedia('(pointer: coarse)').matches;
    var layoutHeight = app ? global.innerHeight : S.commentViewportHeight;
    var keyboard = touch && vv && vv.height < layoutHeight - 120 ||
      app && app.getAttribute('data-keyboard') === 'up';
    return { top: vv ? vv.offsetTop || 0 : 0, bottom: bottom - (keyboard ? 72 : 0) };
  }

  // The words that send or close a comment, in one row that can hold to the list's bottom.
  function sendRow(box) { var row = el('div', 'castor-sendrow'); box.appendChild(row); return row; }
  function revealPanelCard(card,field){
    if (!card) return;
    // A thread "In the page" scrolls with the article.
    var page=S.page&&S.page.contains&&S.page.contains(card)&&(S.page.closest('.page-scroll')||S.page.querySelector('.page-scroll'));
    var scroll=card.classList&&card.classList.contains('is-floating')?card:
      S.panelLayout==='list'&&S.panelEl&&S.panelEl.scrollTo&&S.panelEl.contains(card)?S.panelEl:
      S.wrap&&S.wrap.contains(card)?S.wrap:page||S.lostBox;
    if(!scroll||!scroll.getBoundingClientRect)return;
    var box=scroll.getBoundingClientRect(),at=card.getBoundingClientRect();
    if (!field && S.actionEditor && holdsFocus(S.actionEditor.textarea) && card.contains(S.actionEditor.node)) field = S.actionEditor.textarea;
    if (!field && S.composer && card.contains(S.composer.node)) field = S.composer.textarea;
    if (!box.height) return;
    if (scroll === S.wrap && S.canvas) S.canvas.style.paddingBottom = box.height + 'px';
    S.selfScroll = true;
    if (field) {
      var input = commentCaretRect(field), viewport = commentViewport();
      var top = Math.max(box.top, viewport.top) + 8, bottom = Math.min(box.bottom, viewport.bottom) - 8;
      var end = input.bottom, editor = field.closest && field.closest('.castor-comment-editor, .castor-composer');
      var row = editor && editor.querySelector && editor.querySelector('.castor-sendrow');
      // The send row holds to the list's bottom on a phone: it is in view; the caret stays above it.
      if (row && global.getComputedStyle && global.getComputedStyle(row).position === 'sticky') bottom -= row.offsetHeight;
      // Keep the action words beside the caret when that whole interval fits.
      else if (editor) Array.prototype.forEach.call(editor.querySelectorAll('button'), function (button) {
        var edge = button.getBoundingClientRect().bottom;
        if (edge - input.top <= bottom - top) end = Math.max(end, edge);
      });
      var delta = input.top < top ? input.top - top : end > bottom ? Math.min(end - bottom, input.top - top) : 0;
      if (Math.abs(delta) > 1) {
        var reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (scroll.scrollTo) scroll.scrollTo({ top: scroll.scrollTop + delta, behavior: reduce ? 'instant' : 'smooth' });
        else scroll.scrollTop += delta;
      }
    } else scroll.scrollTop += at.top - box.top;
    S.selfScroll = false;
  }

  function touchSheet() {
    var panels = Castor.panels;
    if (!panels || !panels.state) return false;
    return panels.state().mode !== 'desktop';
  }

  function dismissTouchComments() {
    if (touchSheet() && Castor.panels.isOpen('comments')) Castor.panels.close('comments');
  }

  function cancelPassageReveal(event) {
    var scroll = S.page && ((S.page.closest && S.page.closest('.page-scroll')) || (S.page.querySelector && S.page.querySelector('.page-scroll')));
    if (event && (!scroll || !(event.target === scroll || scroll.contains && scroll.contains(event.target)))) return;
    global.clearTimeout(S.passageTimer);
    S.passageTimer = 0;
  }

  function revealTouchPassage(id) {
    if (!touchSheet()) return;
    global.clearTimeout(S.passageTimer);
    // Panel transitions end before the layout event at 250ms. Read the settled
    // sheet once, then scroll only the article, once.
    S.passageTimer = global.setTimeout(function () {
      if (S.active !== id || !Castor.panels.isOpen('comments')) return;
      var target = passageEl(id), sheet = S.panelEl && S.panelEl.closest('.dock');
      var scroll = S.page && (S.page.closest('.page-scroll') || S.page.querySelector('.page-scroll'));
      if (!target || !sheet || !scroll) return;
      var at = target.getBoundingClientRect();
      var bottom = sheet.getBoundingClientRect().top - 16;
      var topbar = DOC.getElementById('topbar');
      var top = topbar ? topbar.getBoundingClientRect().bottom + 16 : 68;
      var delta = at.bottom > bottom ? at.bottom - bottom : at.top < top ? at.top - top : 0;
      if (delta) scroll.scrollBy({ top: delta, behavior: global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }, 280);
  }
  function positionDoneUndo() {
    var notice = S.panelEl && S.panelEl.querySelector('.castor-comment-undo');
    if (!notice) return;
    var root = notice.parentNode.getBoundingClientRect();
    var bottom = Math.min(root.bottom, commentViewport().bottom);
    var bar = DOC.getElementById('footline');
    if (bar) {
      var edge = bar.getBoundingClientRect();
      if (edge.height && edge.top < bottom) bottom = edge.top;
    }
    notice.style.bottom = Math.max(8, root.bottom - bottom + 8) + 'px';
  }

  function showDoneUndo(thread){
    if(!S.filterBox)return;
    var old=S.panelEl.querySelector('.castor-comment-undo');if(old)old.remove();
    var notice=el('div','castor-comment-undo');notice.setAttribute('role','status');notice.appendChild(el('span',null,'Moved to Done.'));
    var undo=el('button',null,'Undo');undo.type='button';undo.addEventListener('click',function(){var current=byId(thread.id);if(!current||!current.done)return;sendAction(newAction(current,null,'reopen'));notice.remove();});notice.appendChild(undo);S.filterBox.parentNode.appendChild(notice);
    positionDoneUndo();
    global.setTimeout(function(){notice.remove();},7000);
  }

  function offerCandidates(parent, thread) {
    var choices = S.candidates[thread.id] || [];
    if (!choices.length) return;
    parent.appendChild(el('div', 'castor-hint', 'More than one passage fits. Choose where this note belongs.'));
    choices.forEach(function (choice, index) {
      var block = blockById(choice.blockId);
      if (!block) return;
      var pick = el('button', null, 'Use passage ' + (index + 1) + ': ' + block.text.slice(0, 90));
      pick.type = 'button';
      pick.addEventListener('click', function (event) {
        event.stopPropagation();
        var start = Number.isInteger(choice.start) ? choice.start : block.text.indexOf(thread.anchor.quote);
        var end = Number.isInteger(choice.end) ? choice.end : start + thread.anchor.quote.length;
        if (start < 0) return;
        thread.anchor = Object.assign({}, thread.anchor, {
          quote: block.text.slice(start, end), prefix: block.text.slice(Math.max(0, start - 32), start),
          suffix: block.text.slice(end, end + 32), blockText: block.text,
          chosenPlace: { blockId: block.id, blockText: block.text, start: start, end: end, docHash: blockTextHash(pageBlocks()) }
        });
        save(); layout();
      });
      parent.appendChild(pick);
    });
  }

  // A detached thread: show the three blocks whose words are closest to the quote.
  function findIt(thread) {
    var bs = pageBlocks();
    var scored = bs.map(function (b) { return { b: b, s: similarity(thread.anchor.quote, b.text) }; })
      .sort(function (a, b) { return b.s - a.s; }).slice(0, 3);
    var old = S.page.querySelectorAll('.castor-candidate');
    for (var i = 0; i < old.length; i++) old[i].classList.remove('castor-candidate');
    scored.forEach(function (x) { x.b.el.classList.add('castor-candidate'); });
    if (scored[0]) scored[0].b.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    global.setTimeout(function () {
      scored.forEach(function (x) { x.b.el.classList.remove('castor-candidate'); });
    }, 4000);
  }

  /* --------------------------------------------------------- the composer */

  function peopleNames() {
    var out = [];
    (S.people || []).forEach(function (p) {
      var name = typeof p === 'string' ? p : (p && p.name);
      if (!name) return;
      if (p && p.kind === 'agent') return;              // the agent is reachable as @agent
      if (out.indexOf(name) < 0) out.push(name);
    });
    return out;
  }

  // "@" completion. The menu owns Enter and Escape while it is open; the composer
  // gets them back the moment it closes, so Enter still means "save".
  /* Comments, replies and edits are written with the article's editor: same
     type, caret and punctuation as the page. Where that editor cannot run (the
     engine's own tests, which have no real document) the box is a textarea. */
  function writingField(label, placeholder, value) {
    if (Castor.editorField && typeof global.HTMLElement === 'function' && DOC.createElement('div') instanceof global.HTMLElement) {
      return Castor.editorField({ name: 'comment', className: 'castor-field', label: label, placeholder: placeholder, value: value || '' });
    }
    var ta = DOC.createElement('textarea');
    ta.setAttribute('aria-label', label);
    if (placeholder) ta.placeholder = placeholder;
    if (value) ta.value = value;
    return ta;
  }

  // A textarea holds focus itself; an editor field holds it in the paragraph being written.
  function holdsFocus(box) {
    var a = DOC.activeElement;
    return !!a && (a === box || !!(box && box.castorEditor && box.contains && box.contains(a)));
  }

  function wireAt(ta, box) {
    var menu = null, index = 0, matches = [];

    function close() { if (menu) { menu.remove(); menu = null; } }
    function token() {
      var upto = ta.value.slice(0, ta.selectionStart);
      var m = /@([\w'-]*)$/.exec(upto);
      return m ? m[1] : null;
    }
    function accept(name) {
      var start = ta.selectionStart;
      var upto = ta.value.slice(0, start).replace(/@([\w'-]*)$/, '@' + name + ' ');
      var rest = ta.value.slice(start);
      ta.value = upto + rest;
      ta.selectionStart = ta.selectionEnd = upto.length;
      rememberComposer();
      close();
    }
    function paint() {
      var t = token();
      if (t === null) { close(); return; }
      matches = peopleNames().filter(function (n) {
        return !t || n.toLowerCase().indexOf(t.toLowerCase()) === 0 ||
          n.toLowerCase().split(' ').some(function (w) { return w.indexOf(t.toLowerCase()) === 0; });
      });
      if (!matches.length) { close(); return; }
      if (!menu) { menu = el('div', 'castor-at'); box.appendChild(menu); index = 0; }
      if (index >= matches.length) index = 0;
      menu.textContent = '';
      matches.forEach(function (n, i) {
        var row = el('div', null, n);
        row.setAttribute('aria-selected', String(i === index));
        row.addEventListener('mousedown', function (e) { e.preventDefault(); accept(n); });
        menu.appendChild(row);
      });
      menu.style.left = '12px';
      menu.style.top = (ta.offsetTop + ta.offsetHeight + 2) + 'px';
    }

    ta.addEventListener('input', paint);
    ta.addEventListener('keydown', function (e) {
      if (!menu || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); index = (index + 1) % matches.length; paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); index = (index - 1 + matches.length) % matches.length; paint(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); accept(matches[index]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    }, true);
    ta.addEventListener('blur', function () { global.setTimeout(close, 120); });
  }

  function piecePath() { return Castor.piecePath ? Castor.piecePath() : ''; }
  function composerIdentityKnown(record) {
    if (!record.author || !roleConfirmed()) return false;
    if (reviewing()) return record.reviewer === true && sameReviewer(record.reviewerIdentity, reviewerIdentity(Castor.role));
    return record.reviewer === false && isWriter(record.principal);
  }
  /* This browser tab, across reloads (sessionStorage). Words typed in it before the
     writer's sign-in was confirmed belong to whoever holds the tab, so they post as
     the writer it then confirms; words from another tab wait for one explicit tap. */
  var TAB = (function () {
    try { var s = global.sessionStorage, t = s.getItem('castor.tab'); if (!t) { t = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2); s.setItem('castor.tab', t); } return t; }
    catch (e) { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2); }
  })();
  /* The kind of page ('read', 'write', or '' for the app itself): the reader's and the writer's
     pages share one storage, even one tab, so kept words are claimed only on the kind they were
     typed on. A duplicated tab copies the tab's id, so this one page load has its own id too. */
  var PAGE_KIND = String((global.location && global.location.pathname) || '').split('/')[1] || '';
  var PAGE_ID = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  function otherPage(record) { return typeof record.pageKind === 'string' && record.pageKind !== PAGE_KIND; }
  function samePage(record) { return record.tab === TAB && record.pageKind === PAGE_KIND; }
  function unclaimed(record) { return !record.author && !record.principal && record.reviewer === undefined && !record.reviewerIdentity; }
  function claimable(record) {
    return unclaimed(record) && !reviewing() && roleConfirmed() && isWriter(Castor.who && Castor.who.get ? Castor.who.get() : '');
  }
  function claim(record) {
    record.author = Castor.who.name(); record.principal = Castor.who.get(); record.reviewer = false;
  }
  /* Ready to send as a known writer; otherwise says why in the hint and keeps the words. */
  function composerReady(record, hint, button) {
    if (ended()) { hint.textContent = 'Signed out. Your words stay on this device; sign in again to send them.'; return false; }
    if (composerIdentityKnown(record)) return true;
    if (!unclaimed(record) || reviewing() || otherPage(record)) { hint.textContent = 'The original writer is unknown or unavailable. Your words are kept here.'; return false; }
    if (!claimable(record)) {
      record.submitted = true;
      if (S.composer && S.composer.record === record) rememberComposer();
      hint.textContent = 'Checking your sign-in. Your comment stays on this device and is sent once you are confirmed.';
      // Confirmed in this page with no reload (its opening check settled): sent now, as said.
      if (Castor.reconfirm) Promise.resolve(Castor.reconfirm('comment')).then(function (confirmed) {
        if (confirmed && roleConfirmed() && key() !== S.storageKey) { switchScope(); restoreComposer(record); layout(); }
      });
      return false;
    }
    if (!samePage(record) && !record.claimed) { askClaim(record, hint, button); return false; }
    claim(record);
    return composerIdentityKnown(record);
  }
  function askClaim(record, hint, button) {
    button.textContent = (button.getAttribute('data-word') || 'Post') + ' as ' + Castor.who.name();
    button.setAttribute('data-claim', '1');
    hint.textContent = 'Written here before your sign-in was confirmed.';
  }
  function composerRecoveryAllowed(record) {
    // Reader journals are private to their authenticated account, including
    // when the current sign-in is unknown or has become a founder session.
    return record.reviewer === true || reviewing() ? composerIdentityKnown(record) : true;
  }
  function newComposerRecord(anchor, thread) {
    var id = 'c' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    return { id: id, path: S.loadedPath, anchor: anchor, thread: thread || '', text: '', tab: TAB, pageKind: PAGE_KIND,
      author: (Castor.who && Castor.who.name && Castor.who.name()) || '',
      principal: (Castor.who && Castor.who.get && Castor.who.get()) || '', reviewer: roleConfirmed() ? reviewing() : undefined,
      ...(reviewing() ? { reviewerIdentity: reviewerIdentity(Castor.role) } : {}),
      key: key() + '.composer.' + id };
  }
  function journalThread(record) {
    var id = (threadReceipts[key()] || {})[record.thread] || record.thread;
    return S.threads.filter(function (t) { return t.id === id || t.clientId === record.thread; })[0];
  }
  function journalRecords(readOnly) {
    var prefix = key() + '.composer.';
    var oldPrefix = legacyKey() + '.composer.';
    var waiting = !reviewing() && roleConfirmed() ? legacyKey() + '.unconfirmed.composer.' : prefix;
    function matches(k) { return k.indexOf(prefix) === 0 || k.indexOf(oldPrefix) === 0 || k.indexOf(waiting) === 0; }
    try {
      // Another page removed it (it sent, resumed or discarded those words). Words storage refused stay.
      Object.keys(S.journalStored).forEach(function (k) {
        if (global.localStorage.getItem(k) === null) { delete S.composerJournal[k]; delete S.journalStored[k]; }
      });
      for (var i = 0; i < global.localStorage.length; i++) {
        var k = global.localStorage.key(i);
        if (!k || !matches(k) || S.composerJournal[k]) continue;
        var record;
        try { record = JSON.parse(global.localStorage.getItem(k)); } catch (e) { continue; }
        if (record && record.key === k && record.path === piecePath() && typeof record.text === 'string') { S.composerJournal[k] = record; S.journalStored[k] = true; }
      }
    } catch (e) { /* the current page still holds the latest input */ }
    Object.keys(S.composerJournal).forEach(function(k){var r=S.composerJournal[k];if(matches(k)&&r.path===piecePath()&&!r.text.trim())removeJournal(r);});
    return Object.keys(S.composerJournal).filter(function (k) {
      return matches(k) && S.composerJournal[k].path === piecePath();
    }).map(function (k) { return S.composerJournal[k]; }).filter(function (record) {
      if (!composerRecoveryAllowed(record) || otherPage(record)) return false;
      var thread = record.thread && journalThread(record);
      var id = sentId(record), stored = record.storedId || (record.thread ? thread && thread.replies.some(function (r) { return r.id === id && r.text === record.text.trim() && r.author === record.author; }) :
        S.threads.some(function (t) { return (t.id === id || t.clientId === id) && t.text === record.text.trim() && t.author === record.author; }));
      if (stored && !readOnly) removeJournal(record);
      return !stored;
    });
  }
  function rememberComposer() {
    var c = S.composer;
    if (!c || !c.record) return;
    if (!composerRecoveryAllowed(c.record)) {
      // A role switch can precede the next layout or input event. Preserve the
      // original journal unchanged; changed input has no trustworthy writer.
      if (c.textarea.value.trim() && c.textarea.value !== c.record.text) {
        var held = newComposerRecord(c.record.anchor, c.record.thread);
        held.text = c.textarea.value;
        held.author = ''; held.principal = ''; held.reviewer = undefined;
        delete held.reviewerIdentity;
        S.composerJournal[held.key] = held;
        try { global.localStorage.setItem(held.key, JSON.stringify(held)); S.journalStored[held.key] = true; }
        catch (e) {
          if (Castor.bus && Castor.bus.emit) Castor.bus.emit('comments:unsaved', {
            path: c.record.path, reason: "Can't keep this comment on this device. Keep this page open."
          });
        }
      }
      c.node.remove(); S.composer = null;
      return false;
    }
    c.record.text = c.textarea.value;
    if (!c.record.text.trim()) { removeJournal(c.record); return true; }
    S.composerJournal[c.record.key] = c.record;
    if (reviewing() && Castor.bus && Castor.bus.emit) Castor.bus.emit('comments:draft', { path: c.record.path });
    try {
      global.localStorage.setItem(c.record.key, JSON.stringify(c.record));
      S.journalStored[c.record.key] = true;
      c.hint.textContent = keysHint('posts');
      return true;
    } catch (e) {
      c.hint.textContent = "Can't keep this comment on this device. Keep this page open.";
      return false;
    }
  }
  function trackComposer() {
    var c = S.composer;
    c.textarea.value = c.record.text;
    delete S.closedComposers[c.record.key];
    c.textarea.addEventListener('input', function () { rememberComposer(); scheduleCommentFocus(); });
    c.textarea.addEventListener('focusin', scheduleCommentFocus);
    c.textarea.addEventListener('focusout', scheduleCommentFocus);
  }
  function closeComposer() {
    rememberComposer();
    if (S.composer && S.composer.record) S.closedComposers[S.composer.record.key] = true;
    if (S.composer && S.composer.node) S.composer.node.remove();
    S.composer = null;
  }
  /* A composer's keys. Enter sends and Escape cancels; Shift+Enter stays a new line. While
     the @name list is open, and while an input method is composing, the keys are theirs. */
  function composerKeys(ta, box, submit) {
    ta.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey && !box.querySelector('.castor-at')) {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape' && !box.querySelector('.castor-at')) {
        e.preventDefault();
        cancelComposer();
      }
    });
  }

  function cancelComposer() {
    var c = S.composer;
    if (!c) return;
    c.record.closed = true;
    // If storage refuses the close, keep the words and failure visible.
    if (!rememberComposer()) return;
    closeComposer();
    layout(true);
  }
  function removeJournal(record) {
    delete S.composerJournal[record.key]; delete S.journalStored[record.key];
    try { global.localStorage.removeItem(record.key); } catch (e) { /* stable message ids prevent a second submission */ }
  }
  function finishComposer(storedId) {
    var c = S.composer;
    c.record.storedId = storedId;
    rememberComposer();
    c.node.remove(); S.composer = null;
    removeJournal(c.record);
    if (reviewing() && Castor.bus && Castor.bus.emit) Castor.bus.emit('comments:draft', { path: c.record.path });
  }
  function placeComposer() {
    var c = S.composer;
    if (!c || !c.record) return;
    if (!composerRecoveryAllowed(c.record)) { rememberComposer(); return; }
    if (!available() || c.record.path !== piecePath()) { closeComposer(); return; }
    var focused = DOC.activeElement === c.textarea;
    var r = resolveBlock(c.record.anchor), b = r && blockById(r.blockId);
    var thread = c.record.thread && journalThread(c.record);
    var selector = thread && '[data-thread-id="' + thread.id + '"]';
    var card = selector && (panelCard(thread.id) || S.page.querySelector(selector));
    if (card) {
      c.node.classList.remove('is-floating');
      if (c.node.parentNode !== card) card.appendChild(c.node);
    } else if (!quiet() && b && !c.record.thread) {
      c.node.classList.remove('is-floating');
      if (c.node.parentNode !== b.el.parentNode) b.el.parentNode.insertBefore(c.node, b.el.nextSibling);
    } else {
      c.node.classList.add('castor-thread-slot');
      c.node.classList.add('is-floating');
      if (c.node.parentNode !== DOC.body) {
        DOC.body.appendChild(c.node);
        var rect = b ? b.el.getBoundingClientRect() : { left: 12, bottom: 80 };
        c.node.style.left = Math.round(Math.max(12, Math.min(rect.left, (global.innerWidth || 1024) - (c.node.offsetWidth || 320) - 12))) + 'px';
        c.node.style.top = Math.round(Math.max(12, Math.min(rect.bottom + 10, (global.innerHeight || 768) - (c.node.offsetHeight || 120) - 12))) + 'px';
      }
      var viewport = commentViewport(), topbar = DOC.getElementById('topbar');
      var top = Math.max(viewport.top, topbar ? topbar.getBoundingClientRect().bottom : 0) + 8;
      c.node.style.maxHeight = Math.max(44, viewport.bottom - top - 8) + 'px';
      c.node.style.overflowY = 'auto';
      var at = c.node.getBoundingClientRect();
      c.node.style.top = Math.max(top, Math.min(at.top, viewport.bottom - at.height - 8)) + 'px';
    }
    if (focused) c.textarea.focus({preventScroll:true});
  }
  /* Words Posted before the sign-in was confirmed send themselves on the page they were typed
     on, from one page only: a duplicated tab has this tab's id, and two pages can restore at
     once. A page marks the comment as its own and sends it only if the mark is still its own a
     moment later; another page's recent mark leaves the comment to that page. */
  var SENDING_MS = 60000, SETTLE_MS = 50;
  function sendsItself(record) { return !!record.submitted && samePage(record) && claimable(record); }
  // A draft is sent under the id it was typed with, on every page that restores it, so the server
  // keeps one comment however many pages send it.
  function sentId(record) { return record.origin || record.id; }
  /* True while this page's claim settles, so nothing else takes the composer first; false when
     another page sends it. Either way the page then restores its other words. */
  function sendOnce(record) {
    var mark = key() + '.sending.' + sentId(record);
    function holder() { try { return JSON.parse(global.localStorage.getItem(mark) || 'null'); } catch (e) { return null; } }
    var held = holder();
    if (S.claiming) return true;
    if (held && held.by !== PAGE_ID && Date.now() - held.at < SENDING_MS) return false;
    try { global.localStorage.setItem(mark, JSON.stringify({ by: PAGE_ID, at: Date.now() })); } catch (e) { return false; }
    S.claiming = true;
    global.setTimeout(function () {
      S.claiming = false;
      var mine = (holder() || {}).by === PAGE_ID, kept = false;
      try { kept = global.localStorage.getItem(record.key) !== null; } catch (e) { kept = false; }
      if (mine && kept) restoreComposer(record, mark);
      restoreComposer();
    }, SETTLE_MS);
    return true;
  }
  // Closed reply drafts for a thread, newest first (ids start with their time).
  function draftThread(record) { var thread = journalThread(record); return thread ? thread.id : record.thread; }
  function closedReplyDrafts(threadId) {
    var made = function (r) { return parseInt(String(r.id).slice(1), 36) || 0; };
    return journalRecords().filter(function (r) { return r.closed && r.thread && r.text.trim() && draftThread(r) === threadId; })
      .sort(function (a, b) { return made(b) - made(a); });
  }
  function resumeDraft(record) {
    if (record.thread) closedReplyDrafts(draftThread(record)).forEach(function (r) {
      if (r.key !== record.key && (r.origin || r.id) === (record.origin || record.id) && r.text === record.text &&
          r.author === record.author && r.principal === record.principal && r.reviewer === record.reviewer &&
          JSON.stringify(r.reviewerIdentity) === JSON.stringify(record.reviewerIdentity) && JSON.stringify(r.anchor) === JSON.stringify(record.anchor)) removeJournal(r);
    });
    restoreComposer(record);
  }
  function restoreComposer(wanted, sending) {
    if (S.composer || !available()) return;
    var records = wanted ? [wanted] : journalRecords();
    for (var i = 0; i < records.length; i++) {
      var record = records[i], thread = record.thread && journalThread(record);
      if (!record.text || !wanted && (record.closed || S.closedComposers[record.key])) continue;
      if (!sending && sendsItself(record)) { if (sendOnce(record)) return; continue; }
      // An unfinished recovery is a new tab's composer, not a shared mutable journal.
      var fresh = newComposerRecord(record.anchor, record.thread);
      fresh = Object.assign({}, record, { id: fresh.id, key: fresh.key, closed: false, origin: record.origin || record.id });
      if (record.thread) {
        openReply(thread || { id: record.thread, anchor: record.anchor }, null, fresh);
      } else compose(record.anchor, fresh);
      if (rememberComposer()) removeJournal(record);
      if (sending && S.composer && S.composer.record === fresh && sendsItself(fresh) && S.composer.submit()) {
        try { global.localStorage.removeItem(sending); } catch (e) { /* the mark lapses by itself */ }
      }
      break;
    }
  }

  function compose(anchor, record) {
    if (!available() || ended()) return null;
    switchScope();
    if (!S.page || !anchor || !anchor.quote) return null;
    closeComposer();
    record = record || newComposerRecord(anchor);
    var r = resolveBlock(anchor), end = r && anchor.more && resolveParts(anchor.more, pageBlocks(), r.blockId).pop();
    var b = r ? blockById((end || r).blockId) : null;

    var slot = el('div', 'castor-thread-slot');
    slot.setAttribute('data-castor-ui', 'thread-slot');
    var box = el('div', 'castor-composer');
    box.appendChild(el('div', 'castor-quote', '“' + passageOf(anchor) + '”'));
    var ta = writingField('Your comment', 'What is wrong with this, or what you would want.');
    box.appendChild(ta);
    var hint = el('div', 'castor-hint', keysHint('posts'));
    box.appendChild(hint);
    slot.appendChild(box);

    if (quiet()) {
      slot.classList.add('is-floating');
      DOC.body.appendChild(slot);
      var rect = null;
      try {
        var nativeSelection = Castor.frameReads ? null : global.getSelection && global.getSelection();
        var range = Castor.frameReads ? Castor.frameReads.selection().range :
          nativeSelection && nativeSelection.rangeCount ? nativeSelection.getRangeAt(0) : null;
        if (range) rect = range.getBoundingClientRect();
      } catch (e) { rect = null; }
      if ((!rect || !rect.height) && b) rect = b.el.getBoundingClientRect();
      if (rect) {
        var w = slot.offsetWidth || 320;
        var left = Math.min(Math.max(12, rect.left), (global.innerWidth || 1024) - w - 12);
        var top = rect.bottom + 10;
        if (top + slot.offsetHeight > (global.innerHeight || 768) - 12) {
          top = Math.max(12, rect.top - slot.offsetHeight - 10);
        }
        slot.style.left = Math.round(left) + 'px';
        slot.style.top = Math.round(top) + 'px';
      }
    } else if (b) b.el.parentNode.insertBefore(slot, b.el.nextSibling);
    else S.page.appendChild(slot);
    function submit() {
      var text = ta.value.trim();
      var journalled = rememberComposer();
      if (!text) { closeComposer(); return false; }
      if (record.path !== piecePath() || !available()) return false;
      if (!composerReady(record, hint, post)) return false;
      var stored = addFrom('human', anchor, text, sentId(record), record);
      if (!stored) {
        if (journalled) hint.textContent = 'Comment was not saved. Your words are kept here.';
        return false;
      }
      finishComposer(stored.id); layout();
      return true;
    }
    var post = el('button', null, 'Post comment'); post.type = 'button'; post.setAttribute('data-word', 'Post');
    post.addEventListener('click', function (event) { event.stopPropagation(); if (post.getAttribute('data-claim')) record.claimed = true; submit(); });
    var row = sendRow(box); row.appendChild(post);
    if (claimable(record) && !samePage(record)) askClaim(record, hint, post);
    var cancel = el('button', null, 'Cancel'); cancel.type = 'button';
    cancel.addEventListener('click', function (event) { event.stopPropagation(); cancelComposer(); }); row.appendChild(cancel);
    S.composer = { node: slot, anchor: anchor, textarea: ta, hint: hint, record: record, submit: submit };

    if (!reviewing() && !ta.castorEditor) wireAt(ta, box);   // the editor has its own @name picker
    trackComposer();
    composerKeys(ta, box, submit);
    ta.focus({ preventScroll: true });
    scheduleCommentFocus();
    return slot;
  }

  // Turn whatever is selected in the page into an anchor: the words, ~32 characters
  // either side, and the block's text as it reads now (the fallback resolver's evidence).
  function anchorFromSelection() {
    var snapshot = Castor.frameReads ? Castor.frameReads.selection() : null;
    var sel = snapshot ? snapshot.sel : global.getSelection && global.getSelection();
    if (!sel || sel.isCollapsed || (!snapshot && !sel.rangeCount)) return null;
    var range = snapshot ? snapshot.range : sel.getRangeAt(0);
    if (!range) return null;
    if (!S.page || !S.page.contains(range.commonAncestorContainer)) return null;
    var quote = sel.toString().trim();
    if (!quote) return null;
    var node = range.commonAncestorContainer;
    var element = node.nodeType === 1 ? node : node.parentElement;
    var host = element.closest('[data-block-id],[data-block]') || element;
    while (host && host.parentElement !== S.page && host !== S.page &&
      !host.hasAttribute('data-block-id') && !host.hasAttribute('data-block')) {
      host = host.parentElement;
    }
    if (!host || host === S.page || !host.hasAttribute('data-block-id') && !host.hasAttribute('data-block')) return passageFromRange(range);
    var selectedHost = element.closest('.cw-edit,.cw-mirror');
    var textNode = selectedHost && host.contains(selectedHost) ? selectedHost : passageTextNode(host);
    var text = textNode.textContent, at;
    // A quote can occur more than once. Its native Range, rather than the first
    // matching string, identifies the occurrence the reader actually selected.
    if (!textNode.contains(range.startContainer) || !textNode.contains(range.endContainer)) return null;
    try {
      var before = range.cloneRange();
      before.selectNodeContents(textNode);
      before.setEnd(range.startContainer, range.startOffset);
      at = before.toString().length + range.toString().indexOf(quote);
    } catch (error) { return null; }
    if (at < 0 || text.slice(at, at + quote.length) !== quote) return null;
    var plain = readerText(textNode), words = plain.text.slice(plain.at[at], plain.at[at + quote.length]);
    if (!words.trim()) return null;
    at = plain.at[at] + /^\s*/.exec(words)[0].length; quote = words.trim(); text = plain.text;
    return {
      quote: quote,
      prefix: text.slice(Math.max(0, at - 32), at),
      suffix: text.slice(at + quote.length, at + quote.length + 32),
      blockText: text,
      version: (Castor.app && Castor.app.data && Castor.app.data.current) || 'v1'
    };
  }

  // A selection that starts in one paragraph and ends in a later one, or null.
  function passageFromRange(range, version) {
    var blocks = pageBlocks(), first = -1, last = -1;
    for (var i = 0; i < blocks.length; i++) {
      if (first < 0 && blocks[i].el.contains(range.startContainer)) first = i;
      if (blocks[i].el.contains(range.endContainer)) last = i;
    }
    if (first < 0 || last <= first) return null;
    var span = blocks.slice(first, last + 1), roots = span.map(function (b, i) {
      var at = i === 0 ? range.startContainer : i === span.length - 1 ? range.endContainer : null;
      var picked = at && (at.nodeType === 1 ? at : at.parentElement);
      picked = picked && picked.closest && picked.closest('.cw-edit,.cw-mirror');
      return picked && b.el.contains(picked) ? picked : passageTextNode(b.el);
    });
    function offset(root, container, at) {
      var r = DOC.createRange(); r.selectNodeContents(root);
      try {
        if (root.contains(container)) r.setEnd(container, at);
        else if (r.comparePoint(container, at) < 0) return 0;
      } catch (error) { return null; }
      return r.toString().length;
    }
    var from = offset(roots[0], range.startContainer, range.startOffset), to = offset(roots[roots.length - 1], range.endContainer, range.endOffset);
    if (from == null || to == null) return null;
    // His notes are no words of the passage (editor.js anchorFromSelection reads one paragraph so).
    var plains = roots.map(function (n) { return readerText(n); });
    if (plains[0]) from = plains[0].at[from];
    if (plains[plains.length - 1]) to = plains[plains.length - 1].at[to];
    var texts = roots.map(function (n, k) { return plains[k] ? plains[k].text : n.textContent; });
    var anchor = spanAnchor(texts, from, to, version || (Castor.app && Castor.app.data && Castor.app.data.current) || 'v1');
    if (!anchor) return null;
    for (var k = 0; k < texts.length; k++) if (texts[k].indexOf(anchor.quote) >= 0) { anchor.blockId = span[k].id; break; }
    return anchor;
  }

  /* --------------------------------------------------------------- the API */

  function add(anchor, text) { return addFrom('human', anchor, text); }

  function addFrom(who, anchor, text, id, identity) {
    if (!available()) return null;
    switchScope();
    var agent = who === 'agent';
    var me = (Castor.who && Castor.who.name) ? Castor.who.name() : '';
    var thread = normalise({
      id: id,
      anchor: anchor,
      author: identity ? identity.author : (agent ? (me ? me + '’s agent' : 'Your agent') : (me || 'You')),
      principal: identity ? identity.principal : ((Castor.who && Castor.who.get && Castor.who.get()) || ''),
      reviewer: identity ? identity.reviewer : roleConfirmed() ? reviewing() : undefined,
      ...(identity && identity.reviewerIdentity ? { reviewerIdentity: identity.reviewerIdentity } :
        reviewing() ? { reviewerIdentity: reviewerIdentity(Castor.role) } : {}),
      by: agent ? 'agent' : 'human',
      text: text, created: new Date().toISOString(), replies: [], done: false,
      /* Made here and not yet on the server. Only a thread carrying this, or a
         number the server gave it, is ever sent up (see save). */
      pending: true
    }, S.threads.length);
    S.threads.push(thread);
    if (!save()) { S.threads = S.threads.filter(function (t) { return t.id !== thread.id; }); return null; }
    S.filter = 'open';
    layout();
    /* Quiet reading puts the thread somewhere the writer is not looking, so the
       panel opens on the first comment. Without it, pressing Enter makes the
       composer vanish and produces nothing visible except a tinted word. */
    var phone = !!(Castor.panels && Castor.panels.state && (Castor.panels.state() || {}).mode === 'phone');
    if (phone && who === 'human') postedNote();
    else if (quiet() && Castor.panels && Castor.panels.open && !Castor.panels.isOpen('comments')) {
      Castor.panels.open('comments', 'right');
    }
    lift(thread.id);
    /* An agent that answered its own opening line would be talking to itself. */
    return thread;
  }

  /* On the phone a posted comment leaves the writer on the text: the sheet would cover the
     words just commented on. A short note says it went, and goes by itself. */
  function postedNote() {
    var host = (DOC.getElementById && DOC.getElementById('app')) || DOC.body;
    var old = host.querySelector ? host.querySelector('.castor-posted') : S.postedNote;
    if (old && old.remove) old.remove();
    var note = el('div', 'castor-posted');
    note.setAttribute('role', 'status');
    note.appendChild(el('span', 'castor-posted-word', 'Posted'));
    host.appendChild(note); S.postedNote = note;
    global.clearTimeout(S.postedTimer);
    S.postedTimer = global.setTimeout(function () {
      note.classList.add('is-leaving');
      global.setTimeout(function () { if (note.remove) note.remove(); if (S.postedNote === note) S.postedNote = null; }, 240);
    }, 2400);
  }

  /* A quick pass finds exact words only. A comment whose words were since edited
     would stay unmarked until the panel opened, so once typing pauses a full
     pass marks it. It only marks: the panel and the margins are not laid out. */
  function scheduleFullMarks() {
    if (!visibleThreads().some(function (t) { var c = S.resolutionCache[t.id]; return c && c.provisional && !c.result; })) return;
    global.clearTimeout(S.fullTimer);
    S.fullTimer = global.setTimeout(function () {
      S.fullTimer = 0;
      if (!S.page || (Castor.panels && Castor.panels.isOpen && Castor.panels.isOpen('comments'))) return;
      resolveAll(false);
      applyMarks(false);
      if (!quiet()) renderPageThreads();
    }, 400);
  }

  function schedule() {
    if (S.raf) return;
    S.raf = global.requestAnimationFrame(function () { S.raf = 0; layout(); });
  }

  function layout(skipRestore) {
    if (Castor.agentTray) Castor.agentTray.render();
    if (!S.page) return;
    closePeek();
    switchScope();
    if (S.journalPath !== piecePath()) { S.closedComposers = {}; S.journalPath = piecePath(); }
    if (S.composer && S.composer.record && S.composer.record.path !== piecePath()) closeComposer();
    var composerFocus = S.composer && holdsFocus(S.composer.textarea);
    var composerCaret = composerFocus && S.composer.textarea.castorEditor && S.composer.textarea.castorEditor.getCaret();
    var actionFocus=S.actionEditor&&holdsFocus(S.actionEditor.textarea);
    var panelOpen = !Castor.panels || !Castor.panels.isOpen || Castor.panels.isOpen('comments');
    resolveAll(!panelOpen && quiet());
    applyMarks(!panelOpen);
    if (!panelOpen) scheduleFullMarks();
    renderPageThreads();
    if (panelOpen) {
      renderFilter();
      renderLost();
      renderActionRecovery();
      renderRecoveredComments();
      renderEmpty();
      renderPanelCards();
      placeComposer();
      positionPanel();
    }
    if (!panelOpen) placeComposer();
    renderHeldActionEditor();
    if (composerFocus && S.composer && !holdsFocus(S.composer.textarea)) {
      var field = S.composer.textarea;
      if (!composerCaret || !field.castorEditor.restoreCaret(composerCaret)) field.focus({preventScroll:true});
    }
    if(actionFocus&&S.actionEditor)S.actionEditor.textarea.focus({preventScroll:true});
    if(!skipRestore)restoreComposer();
    if (Castor.panels && Castor.panels.routeMargins) Castor.panels.routeMargins();
    syncBonds();
    if (S.touchPeek) syncTouchPeek();
  }

  function list() { return S.threads.slice(); }

  /* ------------------------------------------------------------- wiring up */


  function closePeek() {
    if (S.peekTimer) { global.clearTimeout(S.peekTimer); S.peekTimer = 0; }
    if (S.peek && S.peek.control) S.peek.control.removeAttribute('aria-describedby');
    if (S.peek && S.peek.node) S.peek.node.remove();
    S.peek = null;
    S.peekMark = null;
    if (S.pairedId) { pairWith(S.pairedId, false); S.pairedId = null; }
  }

  function threadById(id) {
    for (var i = 0; i < S.threads.length; i++) if (S.threads[i].id === id) return S.threads[i];
    return null;
  }

  function openPeek(mark) {
    var id = mark.getAttribute('data-thread');
    if (!id || !mark.isConnected || (S.peek && S.peek.threadId === id)) return;
    var thread = threadById(id);
    if (!thread) return;
    closePeek();

    var box = el('div', 'castor-peek');
    box.setAttribute('data-castor-ui', 'peek');
    box.setAttribute('data-by', threadBy(thread));
    box.id = 'castor-comment-preview';
    box.setAttribute('role', 'tooltip');

    var head = el('div', 'castor-peek-head');
    head.appendChild(el('span', 'castor-peek-dot'));
    head.appendChild(el('span', 'castor-peek-who', thread.author ? credit(thread).label : 'Someone'));
    var count = (thread.replies || []).length;
    head.appendChild(el('span', 'castor-peek-more', count === 1 ? '1 reply' : count + ' replies'));
    box.appendChild(head);
    box.appendChild(el('p', 'castor-peek-text', thread.text || ''));
    var reply=withIcon(el('button','castor-peek-reply','Reply'),'reply');reply.type='button';reply.addEventListener('click',function(e){e.stopPropagation();openReply(thread);});box.appendChild(reply);

    box.addEventListener('pointerenter',function(){if(S.peekTimer){global.clearTimeout(S.peekTimer);S.peekTimer=0;}});
    box.addEventListener('pointerleave',pageLeave);
    DOC.body.appendChild(box);
    var r = mark.getBoundingClientRect();
    var w = box.offsetWidth, h = box.offsetHeight;
    /* Below the words by preference. Below covers a line not yet read; above
       covers the one just read and, near the top of a piece, the heading itself,
       since a mark in the opening paragraph has nothing above it but the H1.

       SNAPPED TO THE LINE BOX, not to the glyphs. A mark's rect is the height of
       its characters, not of its line, so `bottom + 8` would land inside the next
       line and cut it through the middle. A popover over prose always covers
       prose; what it must never do is cut a line in half. Clearing the whole line
       box means it covers whole lines and starts on a boundary. */
    var lh = parseFloat(global.getComputedStyle(mark).lineHeight);
    if (!lh || lh < r.height) lh = r.height;
    var lineBottom = r.bottom + (lh - r.height) / 2;
    var top = lineBottom + 2;
    if (top + h > (global.innerHeight || 768) - 8) {
      var lineTop = r.top - (lh - r.height) / 2;
      top = Math.max(8, lineTop - h - 2);
    }
    var left = Math.min(Math.max(8, r.left), (global.innerWidth || 1024) - w - 8);
    box.style.top = Math.round(top) + 'px';
    box.style.left = Math.round(left) + 'px';
    box.classList.add('is-in');
    var control = mark.querySelector(':scope > .castor-comment-pin > .castor-comment-mark');
    if (control) control.setAttribute('aria-describedby', box.id);
    S.peek = { node: box, threadId: id, control: control };
    S.peekMark = mark;
    S.pairedId = id;
    pairWith(id, true);
  }

  // The paragraph being written draws its marks in a mirror under a transparent
  // editing layer, so the pointer never lands on them: find the mark by its boxes.
  function markAt(e) {
    var mark = e.target.closest && e.target.closest('mark.commented');
    if (mark) return mark;
    var block = e.target.closest && e.target.closest('.cw-block');
    if (typeof e.clientX !== 'number' || !S.page) return null;
    if (!block && e.target.isConnected !== false) return null;
    // Repainting a reading paragraph can detach touchend's original target.
    // Its event path still reaches us: hit the current painted marks instead.
    if (!block || !block.isConnected) block = S.page;
    var marks = block.querySelectorAll('mark.commented'), hit = null;
    for (var i = 0; i < marks.length; i++) {
      var rects = marks[i].getClientRects();
      for (var j = 0; j < rects.length; j++) {
        var r = rects[j];
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) hit = marks[i];
      }
    }
    return hit;                          // the last hit is the innermost mark
  }

  function pageHover(e) {
    if (e.pointerType === 'touch' || S.touchPeek) return;
    var mark = markAt(e);
    if (!mark) { closePeek(); return; }
    if (S.peekMark === mark) return;
    closePeek();
    // The innermost mark is the topmost thread when passages overlap.
    S.peekMark = mark;
    S.peekTimer = global.setTimeout(function () {
      S.peekTimer = 0;
      if (S.peekMark === mark) openPeek(mark);
    }, 280);
  }

  function pageLeave(e) {
    if(S.peek&&e.relatedTarget&&S.peek.node.contains(e.relatedTarget))return;
    if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.cw-focused') && S.peekMark && S.peekMark.closest('.cw-focused')) return;
    var next = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('mark.commented');
    if (next && next === S.peekMark) return;
    if(S.peek){if(S.peekTimer)global.clearTimeout(S.peekTimer);S.peekTimer=global.setTimeout(closePeek,180);}else closePeek();
  }

  function closeTouchPeek() {
    S.touchPeek = null;
    if (Castor.capsule && Castor.capsule.commentPeek) Castor.capsule.commentPeek(null);
  }

  function touchPeekCaret() {
    var selection = global.getSelection && global.getSelection();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return null;
    var range = selection.getRangeAt(0), node = range.startContainer;
    var host = node.nodeType === 1 ? node : node.parentElement;
    if (!host || !host.closest || !host.closest('.cw-edit') || !S.page.contains(host)) return null;
    return commentCaretRect(host.closest('.cw-edit'));
  }

  function positionTouchPeek() {
    if (!S.touchPeek) return;
    // Layout/refetch can replace threads without moving the article caret.
    var ids = S.touchPeek.ids, threads = visibleThreads();
    ids = ids.filter(function (id) { return threads.some(function (thread) { return thread.id === id; }); });
    if (!ids.length) { closeTouchPeek(); return; }
    var thread = threads.filter(function (thread) { return thread.id === ids[0]; })[0];
    S.touchPeek.ids = ids;
    // The agent and its founder, as every comment names them (the label falls back to the raw author).
    var who = thread.author && typeof credit === 'function' ? credit(thread) : (thread.author ? { label: thread.author, short: thread.author } : null);
    S.touchPeek.author = who ? who.label : 'Someone';
    S.touchPeek.short = who ? who.short : 'Someone';
    S.touchPeek.words = String(thread.text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    S.touchPeek.open = function () {
      positionTouchPeek();
      if (!S.touchPeek) return;
      var id = S.touchPeek.ids[0];
      closeTouchPeek(); open(id);
    };
    if (Castor.capsule && Castor.capsule.commentPeek)
      S.touchPeek.node = Castor.capsule.commentPeek(S.touchPeek);
  }

  function syncTouchPeek() {
    if (!S.touchPeekEnabled) return;
    var caret = touchPeekCaret(), marks = [], point;
    if (caret) {
      point = { clientX: caret.left, clientY: (caret.top + caret.bottom) / 2 };
      Array.prototype.forEach.call(S.page.querySelectorAll('mark.commented'), function (mark) {
        Array.prototype.some.call(mark.getClientRects(), function (rect) {
          if (point.clientX >= rect.left - 1 && point.clientX <= rect.right + 1 && point.clientY >= rect.top - 2 && point.clientY <= rect.bottom + 2) { marks.push(mark); return true; }
          return false;
        });
      });
    }
    if (!marks.length) closeTouchPeek();
    else showTouchPeek(marks[0], point);
  }

  function showTouchPeek(mark, event) {
    var id = mark.getAttribute('data-thread'), thread = threadById(id);
    if (!thread) return;
    closePeek();
    var ids = [id];
    Array.prototype.forEach.call(S.page.querySelectorAll('mark.commented'), function (other) {
      var otherId = other.getAttribute('data-thread');
      if (ids.indexOf(otherId) >= 0) return;
      Array.prototype.forEach.call(other.getClientRects(), function (rect) {
        if (event.clientX >= rect.left - 1 && event.clientX <= rect.right + 1 && event.clientY >= rect.top - 2 && event.clientY <= rect.bottom + 2) ids.push(otherId);
      });
    });
    S.touchPeek = { ids: ids };
    positionTouchPeek();
  }

  // A tap outside the composer posts the words in it (a posted comment can still be edited);
  // an empty composer just closes. false keeps the words in the box as a draft, sent only by Post.
  // Only a tap: a touch that becomes a scroll, or a press held as long as a long press (or moved),
  // in the article or in the comments, leaves the box as it is, even when the browser still clicks
  // for it. A mouse click and a key on a button are clicks. The post happens on that click, in the
  // document's capture phase, so before the button's own handler: the box posts and its card
  // rebuilds first, then the button (Reply, Edit...) acts, finding its comment by id, not by node.
  var TAP_OUTSIDE_SENDS = true;
  var LONG_PRESS_MS = 500;   // iOS's long press
  // With a comment's keyboard up, a tap on the article places no caret there and closes that keyboard
  // (tapPassage, which also posts the box: the editor keeps that tap's click), so what the writer types
  // next, meant for the comment, never lands in the article; the next tap edits it. Noted as the touch
  // begins; the keyboard closes only if the touch is a tap.
  function commentHasFocus() {
    return !!(S.composer && holdsFocus(S.composer.textarea) || S.actionEditor && holdsFocus(S.actionEditor.textarea));
  }
  function saveOutsideComposer(event) {
    if (event.type === 'pointerdown') {
      S.outsidePress = { type: event.pointerType, at: typeof event.timeStamp === 'number' ? event.timeStamp : Date.now(), x: event.clientX, y: event.clientY };
      S.keyboardTap = (event.pointerType === 'touch' || event.pointerType === 'pen') && commentHasFocus() && !!S.page &&
        S.page.contains(event.target) && !(event.target.closest && event.target.closest('[data-castor-ui]')) ? { at: Date.now(), field: DOC.activeElement } : null;
      return;
    }
    if (event.type === 'click') {
      var press = S.outsidePress, now = typeof event.timeStamp === 'number' ? event.timeStamp : Date.now();
      S.outsidePress = null;
      if (press && (press.type === 'touch' || press.type === 'pen') && event.detail !== 0 &&
          (now - press.at >= (typeof LONG_PRESS_MS === 'number' ? LONG_PRESS_MS : 500) ||
           Math.abs(event.clientX - press.x) > 10 || Math.abs(event.clientY - press.y) > 10)) return;
    }
    var target = event.target;
    if (S.composer && !(S.composer.record && S.composer.record.closed) &&
        !S.composer.node.contains(target) &&
        !(target.closest && target.closest('.castor-comment-undo')) &&
        (TAP_OUTSIDE_SENDS || !S.composer.textarea.value.trim())) S.composer.submit();
  }

  function tapPassage(e) {
    var keyboardTap = S.keyboardTap;
    if (keyboardTap && Date.now() - keyboardTap.at < 1500) {
      S.keyboardTap = null;
      // A long press is not a tap: the box and its keyboard stay as they are, and no caret is placed.
      if (Date.now() - keyboardTap.at >= (typeof LONG_PRESS_MS === 'number' ? LONG_PRESS_MS : 500)) { if (e.preventDefault) e.preventDefault(); return true; }
      saveOutsideComposer({ type: 'tap', target: e.target });
      // The field that had the keyboard lets it go, whether or not its box is still there.
      if (DOC.activeElement === keyboardTap.field && keyboardTap.field.blur) keyboardTap.field.blur();
      if (e.preventDefault) e.preventDefault();
      return true;
    }
    S.touchPeekEnabled = true;
    S.passageTouchUntil = Date.now() + 800;
    var mark = markAt(e);
    if (!mark) {
      if (S.touchPeek) closeTouchPeek();
      if (Castor.panels && Castor.panels.close) dismissTouchComments();
      return false;
    }
    var pin = e.target.closest && e.target.closest('.castor-comment-mark');
    if (pin) {
      if (e.preventDefault) e.preventDefault();
      closeTouchPeek(); closePeek(); open(mark.getAttribute('data-thread'));
      return true;
    }
    if (Castor.panels && Castor.panels.close) dismissTouchComments();
    showTouchPeek(mark, e);
    return false;
  }

  function pageClicked(e) {
    var pin = e.target.closest && e.target.closest('.castor-comment-mark');
    if (!pin && Date.now() < (S.passageTouchUntil || 0)) return;
    closeTouchPeek();
    var mark = markAt(e);
    if (mark) {
      closePeek();
      /* In quiet reading the panel is the only place the thread exists, so opening
         it is part of what the click MEANS. Without this the click would light the
         mark and put the words nowhere the reader can see them. */
      if (quiet() && Castor.panels && Castor.panels.open && !Castor.panels.isOpen('comments')) {
        Castor.panels.open('comments', 'right');
      }
      open(mark.getAttribute('data-thread'));
      return;
    }
    if (e.target.closest && e.target.closest('[data-castor-ui]')) return;
    // No mark could be drawn (the words moved inside the block): the block still opens
    // the card, so a commented passage is never a dead spot.
    var host = e.target.closest && e.target.closest('[data-block-id],[data-block]');
    if (!host) return;
    var id = host.getAttribute('data-block-id') || host.getAttribute('data-block');
    for (var i = 0; i < S.threads.length; i++) {
      var r = S.resolved[S.threads[i].id];
      if (r && r.blockId === id && r.start < 0) { open(S.threads[i].id); return; }
    }
  }

  function registerCommands() {
    if (!Castor.commands || typeof Castor.commands.register !== 'function') return;
    Castor.commands.register({
      id: 'comment:new', title: 'Comment on what is selected', run: function () {
        var a = anchorFromSelection();
        if (a) compose(a);
      }
    });
    Castor.commands.register({
      id: 'comment:open', title: 'Comments: show the open ones',
      run: function () { S.filter = 'open'; layout(); }
    });
    Castor.commands.register({
      id: 'comment:done', title: 'Comments: show the done ones',
      run: function () { S.filter = 'done'; layout(); }
    });
  }

  function mount(ctx, data) {
    if (Castor.bus && Castor.bus.on && !S.whoListening) {
      S.whoListening = true;
      // Every comment box, in the panel, in the page or floating.
      DOC.addEventListener('mousedown', holdCommentFocus, true);
      DOC.addEventListener('pointerdown', saveOutsideComposer, true);
      DOC.addEventListener('click', saveOutsideComposer, true);
      Castor.bus.on('who:set', function () { closeActionEditor();save();load(true); });
      if (global.addEventListener) {
        global.addEventListener('focus', refresh);
        if (global.setInterval) global.setInterval(refresh, 5000);
        global.addEventListener('online', function () {
          if (Castor.comments && !Castor.comments.durable) { save();load(true); }
        });
        global.addEventListener('storage', function (event) {
          if (event.key !== key() && event.key !== key() + '.unsaved') return;
          var stored = load();
          S.threads = mergeLocal(S.threads, (stored || []).map(normalise));
          schedule();
        });
      }
    }
    injectStructure();
    ctx = ctx || {};
    S.page = ctx.page || DOC.getElementById('page');
    S.world = ctx.world || (Castor.app && Castor.app.world) || 'sample';
    closeComposer();
    S.loadedPath = piecePath();

    var appData = (Castor.app && Castor.app.data) || {};
    var seed = (Array.isArray(data) ? data : (data && data.comments)) || appData.comments || [];
    var stored = load();
    S.threads = (available() ? (stored && stored.length ? stored : seed) : []).map(normalise);
    S.people = appData.people || (data && data.people) ||
      [{ name: 'You' }, { name: 'Your agent', kind: 'agent' }];

    if (ctx.panelEl) mountPanel(ctx.panelEl);
    else if (Castor.panels && typeof Castor.panels.register === 'function') {
      Castor.panels.register('comments', { title: 'Comments', mount: mountPanel });
    }

    on('editor:mirror', function (event) {
      if (!S.threads.length && !S.workspace.length) return;
      resolveAll(quiet(), event.blockId);
      applyMarks(true, event.blockId);
      global.requestAnimationFrame(syncTouchPeek);
    });
    // A repainted block comes back without its marks, so they are drawn again here
    // rather than when the paragraph is next clicked. One block is marked at once; a
    // whole page waits for the next layout.
    on('editor:paint', function (event) {
      if (!S.threads.length && !S.workspace.length) return;
      if (!event || !event.blockId) { schedule(); return; }
      resolveAll(quiet(), event.blockId);
      applyMarks(true, event.blockId);
      global.requestAnimationFrame(syncTouchPeek);
    });
    on('doc:change', schedule);
    on('layout', schedule);
    // Marks shown or hidden: every block's text changed shape, so its passages are found again.
    on('editor:marks', function () { S.resolutionCache = {}; S.resolved = {}; S.candidates = {}; S.blockTexts = {}; schedule(); });
    /* Another article opened in the same page: its threads, not the last one's. */
    on('piece:open', function () {
      closeComposer();
      closePeek();
      closeTouchPeek();
      cancelPassageReveal();
      S.active = null; S.revealId = null;
      S.expanded = {};
      S.loadedPath = piecePath();S.commentActions=null;S.actionScope='';S.authorFilter='';closeActionEditor();
      S.resolutionCache = {};
      S.resolved = {};
      S.candidates = {};
      S.blockTexts = {};
      var stored = load();
      S.threads = (stored || []).map(normalise);
      if (global.requestIdleCallback) global.requestIdleCallback(schedule, { timeout: 200 });
      else global.setTimeout(schedule, 32);
    });
    on('canvas:anchors', function (anchors) {
      S.workspace = Array.isArray(anchors) ? anchors : [];
      schedule();
    });
    global.addEventListener('resize', schedule);
    // Same explicit gestures that cancel the article editor's caret reveal.
    // A scroll event alone can be caused by the keyboard or our own reveal.
    global.addEventListener('touchmove', cancelPassageReveal, { passive: true, capture: true });
    global.addEventListener('wheel', cancelPassageReveal, { passive: true, capture: true });
    if (global.visualViewport) {
      global.visualViewport.addEventListener('resize', scheduleCommentFocus);
      global.visualViewport.addEventListener('resize', positionTouchPeek);
      global.visualViewport.addEventListener('scroll', positionTouchPeek);
    }
    on('layout', scheduleCommentFocus);
    on('layout', positionTouchPeek);
    /* capture, so a scroll of the page column reaches us. A scroll of the BAND
       itself is the reader looking down the panel: re-placing there would snap
       it straight back under their finger. */
    global.addEventListener('scroll', function (e) {
      if (S.selfScroll) return;
      var t = e.target;
      if (S.panelEl && t && (t === S.panelEl || S.panelEl.contains(t))) return;
      if (S.wrap && t && t.nodeType === 1 && (t === S.wrap || S.wrap.contains(t))) return;
      if(S.lostBox&&t&&(t===S.lostBox||S.lostBox.contains(t)))return;
      schedulePlace();
    }, true);
    if (S.page) {
      S.page.addEventListener('click', pageClicked);
      S.page.addEventListener('pointerover', pageHover);
      S.page.addEventListener('pointermove', function (event) {
        if (event.target.closest && event.target.closest('.cw-focused')) pageHover(event);
      });
      S.page.addEventListener('pointerout', pageLeave);
      S.page.addEventListener('pointerleave', pageLeave);
      S.page.addEventListener('focusin', function (event) {
        if (event.target.closest && event.target.closest('.castor-comment-mark')) pageHover(event);
      });
      S.page.addEventListener('focusout', pageLeave);
    }
    DOC.addEventListener('keydown',function(e){if(e.key==='Escape'||!S.peek||!S.peek.node.contains(e.target))closePeek();},true);
    DOC.addEventListener('beforeinput', closePeek, true);
    DOC.addEventListener('input', function () { global.requestAnimationFrame(syncTouchPeek); }, true);
    DOC.addEventListener('selectionchange', function () {
      global.requestAnimationFrame(syncTouchPeek);
    });
    DOC.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'mouse') { S.touchPeekEnabled = false; closeTouchPeek(); }
      if (event.pointerType !== 'mouse' && S.page && S.page.contains(event.target)) S.touchPeekEnabled = true;
      // Reconcile after native placement even when a retap leaves selection unchanged.
      global.requestAnimationFrame(syncTouchPeek);
    }, true);
    DOC.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeTouchPeek(); }, true);
    global.addEventListener('scroll', positionTouchPeek, true);
    global.addEventListener('scroll', closePeek, true);
    try {
      var saved = localStorage.getItem('castor.' + S.world + '.comments.reading');
      if (saved && READINGS[saved]) S.reading = saved;
      var savedLayout = localStorage.getItem('castor.' + S.world + '.comments.layout');
      if (savedLayout && LAYOUTS[savedLayout]) S.panelLayout = savedLayout;
    } catch (e) { /* private mode keeps the default */ }
    if (DOC && DOC.documentElement) {
      DOC.documentElement.setAttribute('data-comments-reading', S.reading);
      DOC.documentElement.setAttribute('data-comment-layout', S.panelLayout);
    }
    registerCommands();
    layout();
    return Castor.comments;
  }

  /* Read-only inventory for this reader across articles, including a fresh page.
     Journals remain the authority: an append receipt cannot clear an action or
     composer, and an action is confirmed only by its exact scope-bound receipt. */
  function readerPending() {
    var identity = roleConfirmed() && reviewing() && reviewerIdentity(Castor.role);
    if (!identity) return {};
    return pendingIn('.reader.' + encodeURIComponent(identity.id));
  }
  /* The comments this device holds that no server has confirmed, in the scope of whoever is
     signed in here (this installation's writer, a public-writer account or a reader), as
     { path: [storage key, …] }: unsent threads (their .unsaved mark), unacknowledged actions
     and composer drafts with words. comments.js stays the one owner of these keys. */
  function pending() { return pendingIn(key().slice(legacyKey().length)); }
  function pendingIn(suffix) {
    var prefix = 'castor.' + S.world + '.comments.';
    var pending = {}, records = {};
    function add(path, operation) {
      var list = pending[path] || (pending[path] = []);
      if (list.indexOf(operation) < 0) list.push(operation);
    }
    function scope(path) { return prefix + path + suffix; }
    try {
      for (var i = 0; i < global.localStorage.length; i++) {
        var k = global.localStorage.key(i);
        if (!k || k.indexOf(prefix) !== 0) continue;
        var tail = k.slice(prefix.length), match = /^(articles\/[^/]+\/article\.md)(.*)$/.exec(tail);
        if (!match) continue;
        if (match[2] === suffix + '.unsaved' && global.localStorage.getItem(k)) add(match[1], k);
        if (match[2].indexOf(suffix + '.actions.') !== 0 && match[2].indexOf(suffix + '.composer.') !== 0 && match[2].indexOf('.composer.') !== 0) continue;
        try { records[k] = JSON.parse(global.localStorage.getItem(k)); } catch (e) { /* Other journals remain readable. */ }
      }
    } catch (e) { /* Memory journals below still describe this page's input. */ }
    [S.composerJournal, S.actionJournal].forEach(function (journal) {
      Object.keys(journal).forEach(function (k) { records[k] = journal[k]; });
    });
    Object.keys(records).forEach(function (k) {
      var r = records[k];
      if (!r || r.key !== k || !STORABLE.test(r.path)) return;
      var ownScope = scope(r.path);
      if (k.indexOf(ownScope + '.actions.') === 0 && r.scope === ownScope && sameActionActor(r.actor)) {
        if (!r.submitted || !acknowledgedAction(r, true)) add(r.path, k);
      } else if ((k.indexOf(ownScope + '.composer.') === 0 || k.indexOf(prefix + r.path + '.composer.') === 0) &&
          composerIdentityKnown(r) && !r.storedId && typeof r.text === 'string' && r.text.trim()) {
        add(r.path, k);
      }
    });
    return pending;
  }

  /* For the app shell leaving the screen: an open comment, reply or edit box is kept on this
     device as typed (never sent), then every comment journal in this browser is read back.
     `durable` only when each unsent record this page holds reads back with its exact words;
     `count` is every unsent comment, reply and comment action on this device, any article:
     unfinished boxes, posted words the server has not confirmed, actions without their Git
     receipt. A scope marked unsent with no record found still counts one, never zero. */
  var COMMENT_JOURNAL = /^castor\.[^.]+\.comments\.(articles\/[^/]+\/article\.md)(.*)$/;
  function unsentComments() {
    var durable = true, count = 0, marked = Object.create(null), found = Object.create(null);
    if (S.composer && S.composer.record && !rememberComposer()) durable = false;
    if (S.actionEditor && !captureActionEditor(S.actionEditor)) durable = false;
    function read(k) { try { return JSON.parse(global.localStorage.getItem(k)); } catch (e) { return null; } }
    function scopeOf(k, at) { var i = k.indexOf(at); return i < 0 ? '' : k.slice(0, i); }
    try {
      var names = [];
      for (var i = 0; i < global.localStorage.length; i++) names.push(global.localStorage.key(i));
      names.forEach(function (k) {
        if (typeof k !== 'string' || !COMMENT_JOURNAL.test(k)) return;
        var record;
        if (/\.unsaved$/.test(k)) { if (global.localStorage.getItem(k)) marked[k.slice(0, -8)] = true; return; }
        if (k.indexOf('.submitted.') > 0) {
          record = read(k);
          if (record && record.message) { count++; found[scopeOf(k, '.submitted.')] = true; }
          return;
        }
        if (k.indexOf('.composer.') > 0) {
          record = read(k);
          if (record && record.key === k && typeof record.text === 'string' && record.text.trim() && !record.storedId) { count++; found[scopeOf(k, '.composer.')] = true; }
          return;
        }
        if (k.indexOf('.actions.') > 0) {
          record = read(k);
          if (!record || record.key !== k || !record.request) return;
          var proof = read(record.scope + '.action-receipts.' + record.opId);
          var done = record.submitted && proof && sameActionRequest(proof.request, record.request) && exactActionReceipt(proof.receipt, record.request) && proof.receipt.gitDurable === true;
          if (!done) { count++; found[scopeOf(k, '.actions.')] = true; }
        }
      });
      Object.keys(marked).forEach(function (scope) { if (!found[scope]) count++; });
    } catch (e) { durable = false; }
    // What this page holds must be what the device holds, word for word.
    Object.keys(S.composerJournal).forEach(function (k) {
      var r = S.composerJournal[k], copy = read(k);
      if (r && typeof r.text === 'string' && r.text.trim() && !r.storedId && !(copy && copy.text === r.text)) durable = false;
    });
    Object.keys(S.actionJournal).forEach(function (k) {
      var r = S.actionJournal[k], copy = read(k);
      if (r && !(copy && copy.text === r.text && JSON.stringify(copy.request) === JSON.stringify(r.request))) durable = false;
    });
    if (S.composer && S.composer.record && S.composer.textarea.value.trim()) {
      var open = read(S.composer.record.key);
      if (!open || open.text !== S.composer.textarea.value) durable = false;
    }
    if (S.actionEditor) {
      var editing = read(S.actionEditor.record.key);
      if (!editing || editing.text !== S.actionEditor.textarea.value) durable = false;
    }
    if (S.storageKey && S.threads.some(function (t) { return t.pending; })) {
      var threads = read(S.storageKey);
      S.threads.forEach(function (t) {
        if (t.pending && !(Array.isArray(threads) && threads.some(function (c) { return c && c.id === t.id && c.text === t.text; }))) durable = false;
      });
    }
    return { durable: durable, count: count };
  }

  Castor.comments = {
    credit: function (message) { return credit(message); },
    unsent: unsentComments,
    available: available,
    readerPending: readerPending,
    pending: pending,
    readerDrafts: function () {
      return reviewing() && (journalRecords(true).some(function (record) { return !record.storedId && record.text.trim(); }) ||
        actionRecords().some(function (record) { return !record.submitted; }));
    },
    /* For Castor.flush(): 'none' when this page shows no comments, 'saved' when the server has
       every one, 'journalled' when some wait on this device to be sent (the send goes on), and
       'at-risk' when this device could not keep them. Drafts in an open box are kept as typed. */
    flush: function () {
      if (!available()) return Promise.resolve('none');
      if (!save()) return Promise.resolve('at-risk');
      var unsent = !Castor.comments.durable || S.threads.some(function (t) { return t.pending; });
      return Promise.resolve(unsent ? 'journalled' : 'saved');
    },
    whenSaved: function () {
      var path = S.loadedPath;
      if (!save()) return Promise.reject(new Error('Your notes could not be saved.'));
      return (save.pending || Promise.resolve()).then(function () {
        if (!available() || S.loadedPath !== path || !Castor.comments.durable || S.threads.some(function (t) { return t.pending; })) throw new Error('Your notes are still saving. Try again when they are saved.');
      });
    },
    mount: mount,
    add: add,
    addFrom: addFrom,
    layout: layout,
    list: list,
    open: open,
    tapPassage: tapPassage,
    compose: compose,
    anchorFromSelection: anchorFromSelection,
    passageFromRange: passageFromRange,
    setFilter: function (f) { S.filter = ['open','done','all','withdrawn'].indexOf(f)>=0 ? f : 'open'; layout(); },
    setAuthorFilter: function (name) { S.authorFilter=String(name||'');layout(); },
    setReading: setReading,
    reading: function () { return S.reading; },
    setPanelLayout: setPanelLayout,
    panelLayout: function () { return S.panelLayout; },
    _state: S                                   // dev pages and the harness read this
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Castor.comments;
})(typeof window !== 'undefined' ? window : globalThis);
