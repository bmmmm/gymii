import { renderTrain } from './train.js';
import { renderGym } from './gym.js';
import { renderHistory } from './history.js';
import { renderAi } from './ai.js';
import { renderSettings, setPendingPairCode } from './settings.js';
import { initSteppers, initNumericOverwrite } from './ui.js';
import { initAmbientSync, syncHealth, onSyncActivity } from './sync.js';

const routes = {
  train: renderTrain,
  gym: renderGym,
  history: renderHistory,
  ai: renderAi,
  settings: renderSettings,
};

// The Settings-tab dot: accent while offline edits wait, danger once a
// sync failed. Fed by onSyncActivity below and refreshed on every render.
function updateSyncBadge() {
  const el = document.getElementById('sync-badge');
  if (!el) return;
  const { state } = syncHealth();
  el.hidden = state === 'ok';
  el.classList.toggle('error', state === 'error');
}

function route() {
  const name = location.hash.replace('#', '');
  // A scanned QR lands here as #pair=<code> (M3). The code is a
  // credential: hand it to Settings and scrub it from the URL in the same
  // breath — location.replace leaves no history entry carrying it.
  if (name.startsWith('pair=')) {
    setPendingPairCode(decodeURIComponent(name.slice(5)));
    location.replace('#settings'); // hashchange re-enters route()
    return;
  }
  const tab = routes[name] ? name : 'train';
  const view = document.getElementById('view');
  view.innerHTML = '';
  view.scrollTop = 0;
  routes[tab](view);
  document.querySelectorAll('#tabbar a').forEach((a) => {
    const here = a.dataset.tab === tab;
    a.classList.toggle('active', here);
    // the pill says it to the eye, aria-current says it to a screen reader
    if (here) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  updateSyncBadge();
}

initSteppers();
initNumericOverwrite();
initAmbientSync(); // M2: pull on open/visible, debounced push after edits
onSyncActivity(updateSyncBadge);
window.addEventListener('hashchange', route);
route();

// Offline support; relative path keeps the registration subpath-safe.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
