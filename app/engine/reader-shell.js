/* Reader-only chrome. Article and comment authority still belongs to the server. */
(function (global) {
  'use strict';
  var Castor = global.Castor || (global.Castor = {}), states = {}, draftsByPath = {}, mounted = false, reader = '';
  function reviewing() { return !!(Castor.role && Castor.role.reviewer); }
  function path() { return Castor.piecePath ? Castor.piecePath() : ''; }
  function view() {
    var account = Castor.role && Castor.role.id || '';
    if (reader !== account) { reader = account; states = {}; draftsByPath = {}; }
    var pending = Castor.comments && Castor.comments.readerPending ? Castor.comments.readerPending() : {};
    var state = states[path()] || { state: 'saving', reason: 'Checking your comments with the review service.' };
    var drafts = Castor.comments && Castor.comments.readerDrafts && Castor.comments.readerDrafts();
    draftsByPath[path()] = !!drafts;
    var others = Object.keys(draftsByPath).some(function (p) { return p !== path() && draftsByPath[p]; }) || Object.keys(states).some(function (p) { return p !== path() && states[p].state !== 'saved'; });
    if (pending[path()] && pending[path()].length) state = { state: state.state === 'saving' ? 'saving' : 'partial', reason: 'Your comments or drafts on this device have not all reached the review service.' };
    others = others || Object.keys(pending).some(function (p) { return p !== path() && pending[p].length; });
    if (drafts) state = { state: 'partial', reason: 'Your comment draft is on this device. Finish it and save it to send it.' };
    else if (state.state === 'saved' && others) state = { state: 'partial', reason: 'Comments in another article have not reached the review service. Open that article to check them.' };
    return { state: state.state, label: state.state === 'saved' ? 'Saved: your comments reached the review service. Drafts are sent when you save them.' : state.reason,
      rows: [{ ok: state.state === 'saved', label: 'On the review service', detail: state.reason }] };
  }
  function details() {
    var panel = global.document.getElementById('castor-reader-save-details');
    if (!panel) return;
    panel.textContent = '';
    var note = global.document.createElement('p'); note.className = 'save-explanation'; note.textContent = view().label; panel.appendChild(note);
    var identity = global.document.createElement('p'); identity.className = 'save-explanation';
    identity.textContent = 'Reviewing as ' + (Castor.role.name || 'you') + '. The writers receive your saved comments and can reply in the same thread.';
    panel.appendChild(identity);
  }
  function render() {
    if (!reviewing()) return;
    var doc = global.document, slot = doc.getElementById('castor-save-slot');
    if (!slot || !Castor.saveStatus) return;
    var button = doc.getElementById('castor-save');
    if (!button) {
      button = doc.createElement('button'); button.type = 'button'; button.id = 'castor-save'; button.className = 'castor-save'; slot.appendChild(button);
      var panel = doc.createElement('div'); panel.id = 'castor-reader-save-details'; panel.className = 'save-details';
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Comment save status'); doc.body.appendChild(panel);
      if (Castor.popovers) Castor.popovers.bind(button, panel, details);
    }
    Castor.saveStatus.render(button, view()); details();
  }
  function settings() {
    if (!reviewing()) return;
    var doc = global.document;
    // A reader keeps Zen and the page's look; the writing tools are the writer's.
    ['set-dim', 'set-marks', 'set-spell', 'set-language', 'set-touch-format', 'set-agent-tray', 'set-preset'].forEach(function (id) {
      var el = doc.getElementById(id), row = el && el.closest ? el.closest('.set-row') : el && el.parentNode;
      if (row) row.hidden = true;
    });
    doc.querySelectorAll('.set-panels label').forEach(function (label) {
      var input = label.querySelector('input'); if (input && ['outline', 'comments'].indexOf(input.value) < 0) label.hidden = true;
    });
    var account = doc.getElementById('settings-account');
    if (account && Castor.role.writingApp === true && !doc.getElementById('reader-writing-app')) {
      var link = doc.createElement('a'); link.id = 'reader-writing-app'; link.className = 'set-row set-action';
      link.href = '/signin?write=1'; link.textContent = 'Open the writing app'; account.appendChild(link);
    }
  }
  function mount() {
    if (!reviewing() || mounted) return;
    mounted = true;
    ['pending', 'saved', 'unsaved', 'unavailable'].forEach(function (kind) {
      Castor.bus.on('comments:' + kind, function (info) {
        info = info || {};
        view();
        states[info.path || path()] = { state: kind === 'saved' ? 'saved' : kind === 'pending' ? 'saving' : 'partial',
          reason: info.reason || (kind === 'saved' ? 'Your comments reached the review service.' : kind === 'pending' ? 'Sending your comments to the review service.' : 'Your comments have not reached the review service.') };
        render();
      });
    });
    ['comments:draft', 'piece:open'].forEach(function (name) { Castor.bus.on(name, render); });
    var brand = global.document.querySelector('#topbar .brand');
    if (brand) brand.setAttribute('aria-label', 'Descant');
    settings(); render();
  }
  Castor.readerShell = { mount: mount, render: render, settings: settings, view: view };
})(typeof window !== 'undefined' ? window : globalThis);
