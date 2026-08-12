import {
  getSettings, saveSettings, getGym,
  exportGymTemplate, exportBackup, importData, clearAll,
} from './store.js';
import { download } from './ui.js';

export function renderSettings(root) {
  const s = getSettings();
  root.innerHTML = `
    <h1>Settings</h1>

    <section class="card">
      <h2>Workout</h2>
      <label class="field"><span>Rest timer (seconds)</span>
        <div class="stepper" data-step="15" data-min="0">
          <button type="button" class="step-down" aria-label="decrease">−</button>
          <input id="rest-seconds" type="number" inputmode="numeric" value="${s.restSeconds}">
          <button type="button" class="step-up" aria-label="increase">+</button>
        </div>
      </label>
      <label class="field"><span>Weight step (${s.unit})</span>
        <div class="stepper" data-step="0.5" data-min="0.5">
          <button type="button" class="step-down" aria-label="decrease">−</button>
          <input id="weight-step" type="number" inputmode="decimal" value="${s.weightStep}">
          <button type="button" class="step-up" aria-label="increase">+</button>
        </div>
      </label>
    </section>

    <section class="card">
      <h2>Templates &amp; data</h2>
      <button id="export-gym" class="btn">Export gym template</button>
      <button id="export-backup" class="btn">Export full backup</button>
      <button id="import-btn" class="btn">Import file…</button>
      <input id="import-file" type="file" accept=".json,application/json" hidden>
      <p id="data-msg" class="muted" role="status"></p>
    </section>

    <section class="card">
      <h2>Danger zone</h2>
      <button id="clear-all" class="btn btn-danger">Clear all data</button>
    </section>

    <p class="muted footnote">gymii stores everything in this browser only (localStorage). Export a backup before switching devices.</p>
  `;

  const msg = root.querySelector('#data-msg');

  root.querySelector('#rest-seconds').addEventListener('change', (e) => {
    const v = Math.max(0, Math.round(parseFloat(e.target.value) || 0));
    e.target.value = v;
    saveSettings({ ...getSettings(), restSeconds: v });
  });

  root.querySelector('#weight-step').addEventListener('change', (e) => {
    const v = Math.max(0.25, parseFloat(e.target.value) || 2.5);
    e.target.value = v;
    saveSettings({ ...getSettings(), weightStep: v });
  });

  root.querySelector('#export-gym').addEventListener('click', () => {
    if (!getGym()) { msg.textContent = 'No gym to export yet — build one in Studio.'; return; }
    download('gymii-gym-template.json', exportGymTemplate());
    msg.textContent = 'Gym template exported.';
  });

  root.querySelector('#export-backup').addEventListener('click', () => {
    download('gymii-backup.json', exportBackup());
    msg.textContent = 'Full backup exported.';
  });

  root.querySelector('#import-btn').addEventListener('click', () => {
    root.querySelector('#import-file').click();
  });

  root.querySelector('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const kind = importData(JSON.parse(await file.text()));
      msg.textContent = kind === 'backup' ? 'Backup imported.' : 'Gym template imported.';
    } catch (err) {
      msg.textContent = `Import failed: ${err.message}`;
    }
    e.target.value = '';
  });

  // Two-step confirm instead of a blocking confirm() dialog.
  const clearBtn = root.querySelector('#clear-all');
  let armTimer = null;
  clearBtn.addEventListener('click', () => {
    if (!clearBtn.classList.contains('armed')) {
      clearBtn.classList.add('armed');
      clearBtn.textContent = 'Tap again to erase everything';
      armTimer = setTimeout(() => {
        clearBtn.classList.remove('armed');
        clearBtn.textContent = 'Clear all data';
      }, 4000);
      return;
    }
    clearTimeout(armTimer);
    clearAll();
    renderSettings(root);
  });
}
