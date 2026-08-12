import { renderTrain } from './train.js';
import { renderStudio } from './studio.js';
import { renderHistory } from './history.js';
import { renderAi } from './ai.js';
import { renderSettings } from './settings.js';
import { initSteppers } from './ui.js';

const routes = {
  train: renderTrain,
  studio: renderStudio,
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
window.addEventListener('hashchange', route);
route();
