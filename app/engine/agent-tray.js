/* Deliberate, comments-only agent batches. Notes stay in Git when the tray closes.
   The tray is opt-in (Settings, or the "Agent tray" command) and off until then.
   Turning it off only hides it: a request already saved or in flight is neither
   cancelled nor sent again, and the notes and their journals are never touched. */
(function (global) {
  'use strict';
  var C = global.Castor = global.Castor || {}, D = global.document;
  var tray, status, review, mode = 'everything', busy = false, problem = '', confirmation = '', context = '', rendered = '', index = -1;
  var ENABLED = 'castor.agentTrayEnabled';    // deliberately outside the per-article keys: castor.agentTray.<who>.<path>
  function enabled() { try { return global.localStorage.getItem(ENABLED) === '1'; } catch (e) { return false; } }
  function setEnabled(on) {
    try { global.localStorage.setItem(ENABLED, on ? '1' : '0'); } catch (e) { return enabled(); }
    render();
    return enabled();
  }
  function identity() { return C.who && C.who.get ? C.who.get() : ''; }
  function path() { return C.piecePath ? C.piecePath() : ''; }
  function available() {
    return !(C.role && C.role.reviewer) &&
      !!(C.people && C.people.isWriter(identity())) && /^articles\/[^/]+\/article\.md$/.test(path()) &&
      C.comments && (!C.comments.available || C.comments.available());
  }
  /* Whether the tray may be on screen or start a send: opted in, and the page can use it. */
  function shown() { return enabled() && available(); }
  function key() { return 'castor.agentTray.' + identity() + '.' + path(); }
  function read(k) { try { return JSON.parse(global.localStorage.getItem(k || key()) || '{"seen":{}}'); } catch (e) { return {seen:{}}; } }
  function store(k, value) { global.localStorage.setItem(k, JSON.stringify(value)); }
  function noteKey(t) { return t.clientId || t.id; }
  function messages(t) { return [t].concat(t.replies || []).filter(function (m) { return m.by !== 'agent' && String(m.text || '').trim(); }); }
  function signature(t) { return JSON.stringify(messages(t).map(function (m) { return [m.author, m.text, m.created]; })); }
  function tagged(t) {
    return messages(t).some(function (m) {
      return /(^|[^\w@])@agent(?![\w.-])/i.test(m.text.replace(/```[\s\S]*?```|`[^`]*`/g, ''));
    });
  }
  function notes() {
    if (!available() || !C.comments) return [];
    var seen = read().seen || {};
    return C.comments.list().filter(function (t) { return !t.done && messages(t).length && seen[noteKey(t)] !== signature(t); });
  }
  function questions() { return notes().filter(function (t) { return mode === 'everything' || tagged(t); }); }
  function selected() { return mode === 'tagged' ? questions() : notes(); }
  function selectionStamp() { return key() + mode + JSON.stringify(selected().map(function (t) { return [noteKey(t), signature(t)]; })) + JSON.stringify(read().pending); }
  function reviewSend() {
    if (busy || !shown()) return;
    var pending = read().pending;
    review = {stamp:selectionStamp(), ids:pending ? pending.body.threads : selected().map(function (t) { return t.id; })};
    problem = ''; confirmation = ''; render();
    var confirm = tray && tray.querySelector('.castor-agent-send'); if (confirm) confirm.focus();
  }
  function cancelReview() {
    review = null; render();
    var go = tray && tray.querySelector('.castor-agent-send'); if (go) go.focus();
  }
  function node(tag, text, cls) {
    var n = D.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n;
  }
  function button(text, label, fn) {
    var b = node('button', text); b.type = 'button'; if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', fn); return b;
  }
  function consume(state, list) {
    state.seen = state.seen || {};
    list.forEach(function (t) { state.seen[noteKey(t)] = signature(t); });
  }
  function cancel() {
    if (busy || read().pending) return;
    try { var state = read(); consume(state, notes()); store(key(), state); problem = ''; }
    catch (e) { problem = 'Could not close the tray. Your notes are still here.'; }
    render();
  }
  function visit(direction) {
    var list = notes(); if (!list.length) return;
    index = (index + direction + list.length) % list.length; C.comments.open(list[index].id);
  }
  async function send(approved) {
    if (busy || !shown()) return;
    if (approved && approved.stamp !== selectionStamp()) { review = null; problem = 'Your notes changed. Review them before sending.'; render(); return; }
    var k = key(), article = path(), who = identity();
    busy = true; review = null; problem = ''; confirmation = ''; render();
    async function deliver() {
      await C.comments.whenSaved();
      if (key() !== k || !available()) throw Error('The article or writer changed. Send from the original article.');
      if (approved && approved.stamp !== selectionStamp()) throw Error('Your notes changed. Review them before sending.');
      var state = read(k);
      if (!state.pending) {
        var selected = notes(), asked = questions();
        if (!asked.length) throw Error('Tag a note with @agent, or choose Everything.');
        var included = mode === 'tagged' ? asked : selected;
        state.pending = {body:{path:article,who:who,mode:mode,threads:included.map(function (t) { return t.id; }),
          request_id:'batch-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)}, signatures:{}};
        included.forEach(function (t) { state.pending.signatures[noteKey(t)] = signature(t); });
        store(k, state);
      }
      var pending = state.pending;
      var response = await global.fetch('/api/agent/batch', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending.body)});
      var receipt = await response.json();
      state = read(k);
      var ownsPending = state.pending && state.pending.body.request_id === pending.body.request_id;
      if (!response.ok) {
        // A refused note has not been queued. Let the writer correct the selection.
        if (ownsPending && [400, 404, 422].indexOf(response.status) !== -1) { delete state.pending; store(k, state); }
        throw Error(receipt.error || 'The request was refused. Retry when your notes are saved.');
      }
      if (ownsPending) {
        state.seen = Object.assign(state.seen || {}, pending.signatures);
        delete state.pending; store(k, state);
      }
      if (key() === k && shown()) {
        confirmation = "Sent to agent. The reply will appear in the first question's thread.";
        C.comments.open(receipt.thread);
      }
    }
    try {
      if (global.navigator && global.navigator.locks) await global.navigator.locks.request(k, deliver);
      else await deliver();
    } catch (e) {
      if (key() === k) problem = (e && e.message) || 'Could not send. Your notes are kept. Try again.';
    } finally { busy = false; render(); }
  }
  function render() {
    if (!status) {
      status = node('div', '', 'castor-agent-status'); status.setAttribute('role', 'status'); status.hidden = true;
      if (C.commands && C.commands.register) C.commands.register({id:'agent:tray',title:'Send notes to agent',when:shown,run:function () {
        try { var state = read(); state.seen = {}; store(key(), state); } catch (e) { problem = 'Browser storage is unavailable.'; }
        if (C.panels && C.panels.open) C.panels.open('comments', 'right'); render();
      }});
    }
    if (context !== key()) { context = key(); review = null; confirmation = ''; problem = ''; }
    if (!shown()) { confirmation = ''; review = null; }
    var slot = D.querySelector('.comments-agent-slot');
    if (slot) {
      if (status.parentNode !== slot) slot.appendChild(status);
      if (tray && tray.parentNode !== slot) slot.appendChild(tray);
    } else {
      if (status.parentNode) status.remove();
      if (tray && tray.parentNode) tray.remove();
    }
    if (status.textContent !== confirmation) status.textContent = confirmation;
    status.hidden = !confirmation;
    var list = notes(), pending = read().pending;
    if (!shown() || (!list.length && !pending)) { if (tray) tray.hidden = true; rendered = ''; return; }
    var stamp = selectionStamp() + busy + problem + JSON.stringify(list.map(signature)) + JSON.stringify(review);
    if (stamp === rendered) return; rendered = stamp;
    if (!tray) { tray = node('section', '', 'castor-agent-tray'); tray.setAttribute('aria-label', 'Send notes to agent'); if (slot) slot.appendChild(tray); }
    tray.hidden = false; tray.textContent = '';
    tray.appendChild(node('p', 'Send new or changed open notes to Codex on the review Mac, with the article and its sources.', 'castor-agent-help'));
    tray.appendChild(node('p', 'It replies with evidence and a counter-case in the first question\'s thread; it does not change your text.', 'castor-agent-help'));
    if (review) {
      var preview = node('div', '', 'castor-agent-preview'); tray.appendChild(preview);
      preview.appendChild(node('p', (pending ? 'Retry sending ' : 'Send ') + review.ids.length + (review.ids.length === 1 ? ' note' : ' notes') + ' to the agent?'));
      preview.appendChild(node('p', (pending ? pending.body.mode : mode) === 'both' ? 'Tagged notes are questions; the others go as context.' : ((pending ? pending.body.mode : mode) === 'tagged' ? 'Only notes with @agent will be sent.' : 'Everything selected below will be sent.')));
      var items = node('ol'); preview.appendChild(items);
      review.ids.forEach(function (id) {
        var t = C.comments.list().filter(function (t) { return t.id === id; })[0];
        items.appendChild(node('li', pending ? 'Previously selected note ' + id : (t ? messages(t).map(function (m) { return m.text; }).join('\n') : 'Saved note ' + id)));
      });
      if (pending) preview.appendChild(node('p', 'This retries the same selection. If already sent, the original notes are kept.'));
      var approved = review;
      var confirm = button('Send', '', function () { return send(approved); }); confirm.className = 'castor-agent-send'; tray.appendChild(confirm);
      tray.appendChild(button('Cancel', '', cancelReview));
      return;
    }
    var count = node('span', list.length + (list.length === 1 ? ' note' : ' notes'), 'castor-agent-count'); tray.appendChild(count);
    var nav = node('div', '', 'castor-agent-nav'); tray.appendChild(nav);
    [-1, 1].forEach(function (direction) {
      var b = button('', direction < 0 ? 'Previous note' : 'Next note', function () { visit(direction); });
      var svg = D.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
      var line = D.createElementNS('http://www.w3.org/2000/svg', 'path'); line.setAttribute('d', direction < 0 ? 'M5 12l5-5 5 5' : 'M5 8l5 5 5-5'); svg.appendChild(line); b.appendChild(svg); nav.appendChild(b);
    });
    var select = node('select'); select.setAttribute('aria-label', 'Notes to send'); select.disabled = busy || !!pending;
    [['tagged','@agent only'],['everything','Everything'],['both','@agent + context']].forEach(function (item) { var option = node('option',item[1]); option.value = item[0]; select.appendChild(option); });
    select.value = pending ? pending.body.mode : mode;
    select.title = 'Both: tagged questions with the other notes as context';
    select.addEventListener('change', function () { mode = select.value; problem = ''; render(); }); tray.appendChild(select);
    var close = button('Dismiss notes', '', cancel); close.disabled = busy || !!pending; tray.appendChild(close);
    var go = button(busy ? 'Sending...' : (pending ? 'Retry send' : 'Send to agent'), '', reviewSend); go.className = 'castor-agent-send' + (busy ? ' castor-pending' : ''); go.setAttribute('aria-busy', String(busy)); go.disabled = busy || (!pending && !questions().length); tray.appendChild(go);
    if (problem) tray.appendChild(node('p', problem, 'castor-agent-error'));
  }
  C.agentTray = {render:render,notes:notes,questions:questions,send:send,cancel:cancel,enabled:enabled,setEnabled:setEnabled,setMode:function (value) { mode = value; render(); }};
})(typeof window !== 'undefined' ? window : globalThis);
