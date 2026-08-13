import {
  getSettings, saveSettings, getGym,
  getProfiles, createProfile, renameProfile, deleteProfile, setActiveProfile, setUnit,
  exportGymTemplate, exportBackup, importData, clearAll,
} from './store.js';
import { download, esc, twoTapConfirm } from './ui.js';

export function renderSettings(root) {
  const s = getSettings();
  const profiles = getProfiles();
  const activeProfile = profiles.list.find((p) => p.id === profiles.activeId);
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
      <div class="field-block"><span>Units</span>
        <div class="chip-select" id="unit-chips">
          <button type="button" class="chip${s.unit === 'kg' ? ' sel' : ''}" data-unit="kg">kg · m</button>
          <button type="button" class="chip${s.unit === 'lbs' ? ' sel' : ''}" data-unit="lbs">lbs · mi</button>
        </div>
      </div>
      <label class="field"><span>Weight step (${s.unit})</span>
        <div class="stepper" data-step="0.5" data-min="0.5">
          <button type="button" class="step-down" aria-label="decrease">−</button>
          <input id="weight-step" type="number" inputmode="decimal" value="${s.weightStep}">
          <button type="button" class="step-up" aria-label="increase">+</button>
        </div>
      </label>
    </section>

    <section class="card">
      <h2>Gyms</h2>
      <div class="chip-select" id="profile-chips">
        ${profiles.list.map((p) => `<button type="button" class="chip${p.id === profiles.activeId
          ? ' sel' : ''}" data-id="${p.id}">${esc(p.name)}</button>`).join('')}
      </div>
      <label class="field"><span>Gym name</span>
        <input id="profile-rename" type="text" value="${esc(activeProfile.name)}"></label>
      <div class="row">
        <input id="profile-new-name" type="text" placeholder="New gym name">
        <button id="profile-add" class="btn btn-inline">Add gym</button>
      </div>
      ${profiles.list.length > 1
        ? '<button id="profile-delete" class="btn btn-danger">Delete this gym</button>' : ''}
      <p class="muted">Each gym has its own floor plan and workout history; units and timers are
        shared. A workout in progress waits in its gym until you switch back.</p>
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
    // 0.5 min matches the stepper's data-min and setUnit's clamp
    const v = Math.max(0.5, parseFloat(e.target.value) || 2.5);
    e.target.value = v;
    saveSettings({ ...getSettings(), weightStep: v });
  });

  root.querySelector('#unit-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    setUnit(chip.dataset.unit); // converts all stored weights across profiles
    renderSettings(root);
  });

  root.querySelector('#profile-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    setActiveProfile(chip.dataset.id);
    renderSettings(root);
  });

  root.querySelector('#profile-rename').addEventListener('change', (e) => {
    renameProfile(getProfiles().activeId, e.target.value);
    renderSettings(root);
  });

  root.querySelector('#profile-add').addEventListener('click', () => {
    createProfile(root.querySelector('#profile-new-name').value);
    renderSettings(root);
  });

  const delProfileBtn = root.querySelector('#profile-delete');
  delProfileBtn?.addEventListener('click', () => {
    if (!twoTapConfirm(delProfileBtn,
      'Tap again to delete this gym and its history', 'Delete this gym')) return;
    deleteProfile(getProfiles().activeId);
    renderSettings(root);
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
      msg.textContent = kind === 'backup' ? 'Backup imported.'
        : kind === 'workout-plan' ? 'Workout plan imported — find it on the Train tab.'
          : 'Gym template imported.';
    } catch (err) {
      msg.textContent = `Import failed: ${err.message}`;
    }
    e.target.value = '';
  });

  // Two-step confirm instead of a blocking confirm() dialog.
  const clearBtn = root.querySelector('#clear-all');
  clearBtn.addEventListener('click', () => {
    if (!twoTapConfirm(clearBtn, 'Tap again to erase everything', 'Clear all data')) return;
    clearAll();
    renderSettings(root);
  });
}
