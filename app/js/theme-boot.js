// First-paint theme. A CLASSIC script (no import/export) loaded synchronously
// in <head>, before the stylesheet: js/app.js is a deferred module, so its
// applyTheme() runs only after the default dark colours have already been
// painted — a True black phone flashed grey on every launch. This repeats
// the one decision applyTheme (js/ui.js) makes for 'black', nothing more:
// html[data-theme="black"] and the browser chrome colour. app.js still calls
// applyTheme afterwards, which stays the single owner of every other
// change; test/sw.test.mjs pins that the two agree. The default theme
// needs no work, so a missing, corrupt or unreadable setting does nothing.
// 'gymii.settings' is store.js's KEYS.settings — it cannot be imported here.
(function () {
  try {
    var raw = localStorage.getItem('gymii.settings');
    var settings = raw ? JSON.parse(raw) : null;
    if (!settings || settings.theme !== 'black') return;
    document.documentElement.dataset.theme = 'black';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#000000');
  } catch (e) { /* storage blocked or the JSON broken: the default theme stays */ }
})();
