/* Keyboard layout and reversible design comparisons. No writing or storage. */
(function (global) {
  'use strict';
  var Castor = global.Castor = global.Castor || {}, app, host, mounted = false;
  var choices = ['header', 'compact', 'quiet'];
  function placeSave() {
    if (!app || !host) return;
    var save = document.getElementById('castor-save'), slot = document.getElementById('castor-save-slot');
    if (!save || !slot) return;
    var up = app.dataset.keyboard === 'up', target = up ? host : slot;
    if (save.parentNode === target) return;
    target.appendChild(save);
    if (up && save.animate && !global.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      save.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'ease-out' });
    }
  }
  function select(value) {
    app.dataset.savePosition = choices.indexOf(value) >= 0 ? value : 'header';
    placeSave();
  }
  function versions() {
    if (!app || document.getElementById('descant-versions')) return;
    var dialog = document.createElement('dialog'); dialog.id = 'descant-versions';
    dialog.setAttribute('aria-label', 'Working design versions');
    var title = document.createElement('h2'); title.textContent = 'Working versions'; dialog.appendChild(title);
    var hint = document.createElement('p'); hint.textContent = 'Choose, then focus your writing. These change the interface only.'; dialog.appendChild(hint);
    [['header', 'Save word in the header', 'Recommended: visible while the keyboard is open.'],
      ['compact', 'Smaller save word in the header', 'The same place with a smaller caption.'],
      ['quiet', 'Save symbol in the header', 'The smallest option; tap it for the full save status.']].forEach(function (choice) {
      var button = document.createElement('button'); button.type = 'button'; button.textContent = choice[1];
      button.setAttribute('aria-pressed', String(app.dataset.savePosition === choice[0]));
      button.addEventListener('click', function () { select(choice[0]); dialog.close(); });
      var detail = document.createElement('p'); detail.textContent = choice[2];
      dialog.appendChild(button); dialog.appendChild(detail);
    });
    var close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
    close.addEventListener('click', function () { dialog.close(); }); dialog.appendChild(close);
    dialog.addEventListener('close', function () { dialog.remove(); });
    document.body.appendChild(dialog); dialog.showModal();
  }
  function mount(ctx) {
    if (mounted) return;
    app = ctx.app || document.getElementById('app'); if (!app) return;
    mounted = true;
    host = document.createElement('div'); host.id = 'keyboard-save'; host.className = 'keyboard-save'; var bar = document.getElementById('topbar');
    bar.insertBefore(host, bar.querySelector('.bar-tools'));
    var params = new URLSearchParams(global.location.search); select(params.get('status'));
    Castor.bus.on('keyboard:change', placeSave);
    var settings = document.getElementById('castor-settings');
    if (settings) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'set-row set-action'; button.textContent = 'Working design versions';
      button.addEventListener('click', versions); (document.getElementById('settings-page') || settings).appendChild(button);
    }
    if (Castor.commands && Castor.commands.register) Castor.commands.register({ id: 'design.versions', title: 'Working design versions', section: 'Settings', run: versions });
    if (params.get('versions') === '1') versions();
  }
  Castor.touchLayout = { mount: mount, placeSave: placeSave, versions: versions };
})(typeof window !== 'undefined' ? window : this);
