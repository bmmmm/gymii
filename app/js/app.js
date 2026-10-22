import { renderTrain, isFirstRun } from './train.js';
import { renderTour, spotTabs } from './tour.js';
import { renderGym } from './gym.js';
import { renderHistory } from './history.js';
import { renderAi } from './ai.js';
import { renderSettings, setPendingPairCode } from './settings.js';
import { initSteppers, initNumericOverwrite, initFocusCentering, applyTheme } from './ui.js';
import { initAmbientSync, syncHealth, onSyncActivity } from './sync.js';
import { onWriteError, getSettings } from './store.js';

const routes = {
  train: renderTrain,
  gym: renderGym,
  // a tab tap is an ENTRY: History opens on its overview, this month
  history: (v) => renderHistory(v, { entry: true }),
  ai: renderAi,
  settings: renderSettings,
  // not a tab: reached from Settings → Help, the first-run screen, and on
  // a device's very first start (route() below). Done or skipped, it hands
  // over to Train — replace(), so Back never walks into the tour again.
  tour: (v) => renderTour(v, {
    entry: true, askUnit: isFirstRun(), onExit: () => location.replace('#train'),
  }),
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

// A refused write is the one failure no screen can report on its own —
// it can strike while any of them is open. Three facts, in the order they
// matter: it is not saved, what is already stored is untouched, and what
// to do about it.
function showStorageAlert(err) {
  const el = document.getElementById('storage-alert');
  if (!el) return;
  el.hidden = !err;
  el.textContent = err
    ? 'This browser refused to save — your last change is not stored. '
      + 'Everything saved before is untouched. Free up space on the device, '
      + 'then export a backup from Settings before you carry on.'
    : '';
}

function route() {
  const name = location.hash.replace('#', '');
  // A scanned QR lands here as #pair=<code> (M3). The code is a
  // credential: hand it to Settings and scrub it from the URL in the same
  // breath — location.replace leaves no history entry carrying it.
  if (name.startsWith('pair=')) {
    // a malformed escape (#pair=%E0) throws here — before anything renders,
    // which would leave a blank app; such a code could not pair anyway
    try {
      setPendingPairCode(decodeURIComponent(name.slice(5)));
    } catch { /* URIError: dropped, the URL is scrubbed all the same */ }
    location.replace('#settings'); // hashchange re-enters route()
    return;
  }
  // own keys only: #toString or #constructor would find Object.prototype's
  // and render a blank view
  const tab = Object.hasOwn(routes, name) ? name : 'train';
  // First start on this device: the tour comes before the first-run screen,
  // once (renderTour marks it seen). Only where Train would open — a #gym or
  // #settings link (a pairing QR lands there) goes where it points.
  if (tab === 'train' && !getSettings().tourSeen && isFirstRun()) {
    location.replace('#tour'); // hashchange re-enters route()
    return;
  }
  spotTabs([]); // the tour's tab marks never outlive it
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

applyTheme(getSettings()); // before the first render, so nothing flashes in the other theme
initSteppers();
initNumericOverwrite();
// Every focused field lands centred above the keyboard, with its context
// (on the log screen: steppers AND the log button, via data-focus-context).
initFocusCentering();
initAmbientSync(); // M2: pull on open/visible, debounced push after edits
onSyncActivity(updateSyncBadge);
onWriteError(showStorageAlert);
window.addEventListener('hashchange', route);
route();

// Offline support; relative path keeps the registration subpath-safe.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
