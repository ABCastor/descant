/* Save evidence belongs to the exact text on screen, never the previous save. */
(function (global) {
  'use strict';
  var pending = 0;
  function activity(delta) {
    pending += delta;
    var bus = global.Castor && global.Castor.bus;
    if (bus && bus.emit) bus.emit('save:activity', pending);
  }
  function track(promise) {
    activity(1);
    return Promise.resolve(promise).then(function (value) { activity(-1); return value; },
      function (error) { activity(-1); throw error; });
  }
  function time(at) {
    // 24-hour, as the rest of the app (Versions): never "03:41:01 PM" in an American-language browser.
    return at ? new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  }
  function describe(s) {
    var current = s.current === true;
    var device = !!s.deviceAt;
    var history = current && !!(s.history && s.history.sha && s.history.at);
    var shared = history && !!(s.shared && s.shared.ok === true && s.shared.at);
    var sharedFailed = history && !shared && !!(s.shared && s.shared.failed === true);
    var lastConfirmed = s.shared && s.shared.last_confirmed_at;
    // Words typed since the last save are saving: the pause before it is part of saving. "Kept on
    // this device" is for words that cannot reach the server (offline), below.
    var word = s.saving || !current ? 'Saving…'
      : !history ? 'Checking…' : !shared ? (sharedFailed ? 'Not backed up' : 'Checking backup…') : !device ? 'Kept in history' : 'Saved';
    var rows = [
      { ok: device, label: 'On this device', detail: device ? time(s.deviceAt) : 'Waiting for this browser to keep a copy.' },
      { ok: history, label: 'In the article’s history', detail: history ? s.history.sha.slice(0, 7) + ' · ' + time(s.history.at) : 'Waiting for the article’s save.' },
      { ok: shared, label: 'Copied to the shared server', detail: shared ? (s.shared.checked ? 'Checked ' : '') + time(s.shared.at)
        : ((s.shared && s.shared.reason) || 'Waiting for the server to confirm the backup.')
          + (lastConfirmed ? ' Last confirmed ' + time(lastConfirmed) + '.' : '') }
    ];
    /* Amber only for a known failure; a receipt still on its way is part of saving, not a fault. */
    var failed = !!(s.warning || s.problem || sharedFailed);
    var onDevice = s.offline && device && !s.warning;
    if (onDevice) word = 'On device';
    var state = onDevice ? 'device' : failed ? 'partial' : pending || s.saving || !rows.every(function (row) { return row.ok; }) ? 'saving' : 'saved';
    var missing = rows.filter(function (row) { return !row.ok; }).map(function (row) { return row.label + ': ' + row.detail; });
    if (s.warning) missing.push(s.warning);
    if (s.problem) missing.push(s.problem);
    var label = state === 'device' ? 'Kept on this device. Waiting to sync when the connection returns.' : state === 'saving' ? (history && !shared ? 'Checking the shared backup. ' + rows[2].detail : 'Saving') : state === 'saved' ? 'Saved: all three copies confirmed' : 'Save incomplete. ' + missing.join(' ');
    // Saved words that break a writing rule are safe; only publishing waits. Calm words, the same mark.
    var held = state === 'saved' && s.held ? s.held : '';
    if (held) { word = 'Saved as draft'; label = 'All three copies confirmed. ' + held; }
    return { word: word, state: state, label: label, rows: rows, sharedFailed: sharedFailed, held: !!held };
  }
  function shortWord(view) {
    return view.state === 'device' ? 'On device' : view.state === 'saved' ? (view.held ? 'Draft' : 'Saved')
      : view.sharedFailed ? 'Not backed up' : view.state === 'partial' ? 'Not saved'
      : /^Checking/.test(view.word) ? 'Checking' : 'Saving';
  }
  function render(button, view) {
    var icon = button.querySelector('.save-signal'), label = button.querySelector('.save-signal-label');
    if (!icon) {
      button.textContent = '';
      var doc = button.ownerDocument;
      icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'save-signal');
      icon.setAttribute('viewBox', '0 0 20 20');
      icon.setAttribute('aria-hidden', 'true');
      var path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      icon.appendChild(path); button.appendChild(icon);
      label = doc.createElement('span');
      label.setAttribute('class', 'save-signal-label'); button.appendChild(label);
      button.setAttribute('aria-live', 'polite'); button.setAttribute('aria-atomic', 'true');
    }
    button.setAttribute('data-signal', view.state);
    var shapes = { device: 'M3 4h14v12H3z M7 13h6', saved: 'M4 10l4 4 8-8', partial: 'M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16 M10 6v5 M10 14v.01',
      saving: 'M10 2a8 8 0 1 1-8 8' };
    icon.firstChild.setAttribute('d', shapes[view.state]);
    var word = shortWord(view);
    if (label.textContent !== word) label.textContent = word;
    button.setAttribute('aria-label', view.label);
    if (button.title !== view.label) button.title = view.label;
  }
  var api = { describe: describe, render: render, track: track, shortWord: shortWord };
  (global.Castor || (global.Castor = {})).saveStatus = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
