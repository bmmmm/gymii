import { renderTrain } from './train.js';
import { renderGym } from './gym.js';
import { renderHistory } from './history.js';
import { renderAi } from './ai.js';
import { renderSettings } from './settings.js';
import { initSteppers, initNumericOverwrite } from './ui.js';

const routes = {
  train: renderTrain,
  gym: renderGym,
  history: renderHistory,
  ai: renderAi,
  settings: renderSettings,
};

function route() {
  const name = location.hash.replace('#', '');
  const tab = routes[name] ? name : 'train';
  const view = document.getElementById('view');
  view.innerHTML = '';
  view.scrollTop = 0;
  routes[tab](view);
  document.querySelectorAll('#tabbar a').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === tab);
  });
}

initSteppers();
initNumericOverwrite();
window.addEventListener('hashchange', route);
route();

// Offline support; relative path keeps the registration subpath-safe.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
