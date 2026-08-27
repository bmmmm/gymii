import {
  getSettings, saveSettings, getLayout,
  getGyms, createGym, renameGym, deleteGym, setActiveGym, setUnit,
  exportGymTemplate, exportBackup, importData, clearAll,
} from './store.js';
import { download, esc, twoTapConfirm, TIMER_SOUNDS, playTimerSound } from './ui.js';
import { loadDemoData } from './demo.js';

export function renderSettings(root) {
  const s = getSettings();
  const gyms = getGyms();
  const activeGym = gyms.list.find((p) => p.id === gyms.activeId);
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
      <div class="field-block"><span>Timer sound — tap to hear it</span>
        <div class="chip-select" id="sound-chips">
          ${Object.entries(TIMER_SOUNDS).map(([key, snd]) => `<button type="button"
            class="chip${s.timerSound === key ? ' sel' : ''}" data-sound="${key}">${snd.label}</button>`).join('')}
        </div>
      </div>
      <div class="field-block"><span>Keep screen awake</span>
        <div class="chip-select" id="awake-chips">
          ${[['break', 'During the break'], ['workout', 'Whole workout'], ['off', 'Off']]
    .map(([v, label]) => `<button type="button" class="chip${s.keepAwake === v ? ' sel' : ''}"
            data-awake="${v}">${label}</button>`).join('')}
        </div>
        <p class="muted">"During the break" holds the screen on until the rest timer
          ends, then lets it sleep. "Whole workout" keeps it on until you finish —
          handy between sets, harder on the battery. Needs a browser that offers a
          screen wake lock.</p>
      </div>
      <div class="field-block"><span>While resting, darken the screen</span>
        <div class="chip-select" id="dim-chips">
          ${[['off', 'Never'], ['10s', '10 s into the break'], ['now', 'Straight away']]
    .map(([v, label]) => `<button type="button" class="chip${s.timerDim === v ? ' sel' : ''}"
            data-dim="${v}">${label}</button>`).join('')}
        </div>
        <p class="muted">A rest screen at full brightness is a lamp in a dark gym. This
          turns gymii's own pixels down while you wait — the screen stays on, and the
          countdown stays readable: it ticks one beat brighter every second. A touch
          brings it back to full, the last seconds are bright again, and the same
          choice sits on the timer itself so you can change it mid-break.</p>
      </div>
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
      <h2>Gym</h2>
      <a class="btn" href="#gym">Open the gym</a>
      <p class="muted">Draw the floor plan, number the machines and edit their
        muscles, settings and exercises.</p>
    </section>

    <!-- Singular above = the active gym's floor plan; plural here = every
         gym you train at. The two sections sit next to each other, so the
         headings have to carry that difference on their own. -->
    <section class="card">
      <h2>Your gyms</h2>
      <div class="chip-select" id="gym-chips">
        ${gyms.list.map((p) => `<button type="button" class="chip${p.id === gyms.activeId
          ? ' sel' : ''}" data-id="${p.id}">${esc(p.name)}</button>`).join('')}
      </div>
      <label class="field"><span>Gym name</span>
        <input id="gym-rename" type="text" value="${esc(activeGym.name)}"></label>
      <div class="row">
        <input id="gym-new-name" type="text" placeholder="New gym name">
        <button id="gym-add" class="btn btn-inline">Add gym</button>
      </div>
      ${gyms.list.length > 1 || activeGym.demo
        ? '<button id="gym-delete" class="btn btn-danger">Delete this gym</button>' : ''}
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
      <h2>Test data</h2>
      <button id="demo-load" class="btn">${gyms.list.some((p) => p.demo)
        ? 'Reload test data' : 'Load test data'}</button>
      <p id="demo-msg" class="muted" role="status"></p>
      <p class="muted">Fills a separate Demo gym with a floor plan, eight weeks of
        history and three plans, then switches to it. Your own gyms stay untouched —
        remove it again with "Delete this gym" above.</p>
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
    // 0.5 min matches the stepper's data-min and setUnit's clamp; the ||
    // catches NaN AND a typed 0, so both land on the minimum, not the default
    const v = Math.max(0.5, parseFloat(e.target.value) || 0.5);
    e.target.value = v;
    saveSettings({ ...getSettings(), weightStep: v });
  });

  // every chip previews its sound — this click IS the gesture the audio
  // context needs; tapping the selected one just plays it again
  root.querySelector('#sound-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    playTimerSound(chip.dataset.sound);
    if (chip.dataset.sound !== getSettings().timerSound) {
      saveSettings({ ...getSettings(), timerSound: chip.dataset.sound });
      renderSettings(root);
    }
  });

  root.querySelector('#awake-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    saveSettings({ ...getSettings(), keepAwake: chip.dataset.awake });
    renderSettings(root);
  });

  root.querySelector('#dim-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    saveSettings({ ...getSettings(), timerDim: chip.dataset.dim });
    renderSettings(root);
  });

  root.querySelector('#unit-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    setUnit(chip.dataset.unit); // converts all stored weights across gyms
    renderSettings(root);
  });

  root.querySelector('#gym-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    setActiveGym(chip.dataset.id);
    renderSettings(root);
  });

  root.querySelector('#gym-rename').addEventListener('change', (e) => {
    renameGym(getGyms().activeId, e.target.value);
    renderSettings(root);
  });

  root.querySelector('#gym-add').addEventListener('click', () => {
    createGym(root.querySelector('#gym-new-name').value);
    renderSettings(root);
  });

  const delGymBtn = root.querySelector('#gym-delete');
  delGymBtn?.addEventListener('click', () => {
    if (!twoTapConfirm(delGymBtn,
      'Tap again to delete this gym and its history', 'Delete this gym')) return;
    deleteGym(getGyms().activeId);
    renderSettings(root);
  });

  root.querySelector('#export-gym').addEventListener('click', () => {
    if (!getLayout()) { msg.textContent = 'No gym to export yet — build one in Gym.'; return; }
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

  const demoBtn = root.querySelector('#demo-load');
  demoBtn.addEventListener('click', () => {
    // replacing an existing Demo gym discards its edits — guard that, but
    // not the harmless first load
    const exists = getGyms().list.some((p) => p.demo);
    if (exists && !twoTapConfirm(demoBtn,
      'Tap again to replace the Demo gym', 'Reload test data')) return;
    const r = loadDemoData();
    renderSettings(root); // re-render swaps the DOM, so write the message after
    root.querySelector('#demo-msg').textContent =
      `Demo gym loaded — ${r.machines} machines, ${r.workouts} workouts, ${r.plans} plans.`;
  });

  // Two-step confirm instead of a blocking confirm() dialog.
  const clearBtn = root.querySelector('#clear-all');
  clearBtn.addEventListener('click', () => {
    if (!twoTapConfirm(clearBtn, 'Tap again to erase everything', 'Clear all data')) return;
    clearAll();
    renderSettings(root);
  });
}
