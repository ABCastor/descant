/* One save control, in the row the writer is using. */
(function (global) {
  'use strict';
  var Castor = global.Castor = global.Castor || {}, app, mounted = false;
  function saveTarget() {
    if (app.dataset.keyboard === 'up') return document.getElementById('writing-save-slot') || document.getElementById('phone-save-slot');
    return document.getElementById(app.dataset.mode === 'phone' ? 'phone-save-slot' : 'castor-save-slot');
  }
  function placeSave() {
    if (!app) return;
    var save = document.getElementById('castor-save'), target = saveTarget();
    if (!save || !target) return;
    if (save.parentNode !== target) target.appendChild(save);
  }
  function mount(ctx) {
    if (mounted) return;
    app = ctx.app || document.getElementById('app'); if (!app) return;
    mounted = true;
    Castor.bus.on('keyboard:change', placeSave);
    Castor.bus.on('save:state', placeSave);
    Castor.bus.on('size', placeSave);
    placeSave();
  }
  Castor.touchLayout = { mount: mount, placeSave: placeSave };
})(typeof window !== 'undefined' ? window : this);
