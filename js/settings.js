import {
  getSettings, saveSettings, getLayout,
  getGyms, createGym, renameGym, deleteGym, setActiveGym, setUnit,
  exportGymTemplate, exportBackup, importData, clearAll,
} from './store.js';
import {
  download, esc, twoTapConfirm, keepInView, fmtDate, fmtTime,
  TIMER_SOUNDS, playTimerSound,
} from './ui.js';
import { loadDemoData } from './demo.js';
import {
  getSyncState, getSyncCode, enableSync, pairWithCode, syncNow, disableSync,
} from './sync.js';

// --- the Sync card (M1, docs/sync-plan.md) ---
// The sync code is the ONLY key to an account (sync-plan decision 7), so it
// is never read from storage by a plain render: minting one, or tapping
// "Show sync code", parks it here and the NEXT renderSettings prints it and
// clears it again. Every later re-render therefore takes it back off the
// screen by itself — "shown once" is a mechanism, not a promise in the copy.
let codeOnce = null;

const SYNC_RESULT = {
  synced: 'Synced.',
  offline: 'Offline — the server did not answer. Nothing was lost; try again later.',
  auth: 'The server refused the token. Check it, or pair again with a fresh sync code.',
  decrypt: 'Could not read the copy on the server — this gym is paired with a different sync code.',
};

const syncResultText = (r) => SYNC_RESULT[r.status]
  ?? `Sync failed${r.detail ? ` (${r.detail})` : ''}.`;

// sync.js throws these as plain Error messages; anything else is surfaced
// verbatim rather than swallowed.
const SYNC_ERRORS = {
  'bad-server': 'Enter both the server URL and the token your sync server printed.',
  'bad-code': 'That is not a gymii sync code — copy the whole line, it starts with "gymii-sync:v1:".',
  'demo-gym': 'The demo gym never syncs.',
  'unknown-gym': 'This gym is gone — switch gyms and try again.',
};

const syncErrorText = (err, prefix) => SYNC_ERRORS[err?.message] ?? `${prefix}: ${err?.message}`;

// The code plus the one warning that has to sit next to it, never a screen
// away: this string is the account.
const codeBlock = (code) => `
  <code id="sync-code-out" class="synccode">${esc(code)}</code>
  <button id="sync-copy" class="btn">Copy sync code</button>
  <div class="notice">Keep this somewhere safe now — a password manager, or on paper.
    It is the only key to this gym's encrypted data: anyone who has it can read the
    sync, nobody without it can (not whoever runs the server, not us). Lose every
    paired device and the code, and the data is gone. There is no recovery.</div>`;

function syncCard(gym, shownCode) {
  const state = getSyncState(gym.id);
  if (!state.configured) {
    return `
    <section class="card">
      <h2>Sync</h2>
      <p class="muted">Sync is off. Turn it on and this gym — floor plan, workouts and
        plans — is encrypted on this device before it leaves it, and stored on a sync
        server you run yourself; the server only ever holds the encrypted blob. Opt-in
        per gym: this switches on "${esc(gym.name)}" alone. You get one sync code, and
        it is the only key — there is no recovery, and nobody can bring the data back
        without it, us included. Export and import keep working without any of this.</p>
      <label class="field-block"><span>Server</span>
        <div class="row"><input id="sync-server" type="text" autocomplete="off"
          placeholder="sync.example.org"></div>
        <p class="muted">Just the domain — https is assumed. An explicit
          http:// works only for localhost setups.</p>
      </label>
      <label class="field-block"><span>Token</span>
        <div class="row"><input id="sync-token" type="text" autocomplete="off"
          placeholder="printed by your sync server"></div>
      </label>
      <button id="sync-enable" class="btn btn-primary">Turn on sync</button>
      <p id="sync-msg" class="muted" role="status"></p>
      <div class="field-block"><span>Have a sync code?</span>
        <div class="row">
          <input id="sync-code" type="text" autocomplete="off" aria-label="Sync code"
            placeholder="gymii-sync:v1:…">
          <button id="sync-pair" class="btn btn-inline">Pair</button>
        </div>
      </div>
      <p class="muted">Pairing joins this gym to a device that already syncs — paste the
        code that device showed you. Both sides then merge into one history.</p>
    </section>`;
  }
  return `
    <section class="card">
      <h2>Sync</h2>
      <div class="spread"><span class="muted">Server</span>
        <span class="sync-val">${esc(state.server)}</span></div>
      <div class="spread"><span class="muted">Last sync</span>
        <span class="sync-val">${state.lastSyncAt
    ? `${fmtDate(state.lastSyncAt)} · ${fmtTime(state.lastSyncAt)}` : 'never'}</span></div>
      ${state.lastError ? `<div class="spread"><span class="muted">Last error</span>
        <span class="sync-val">${esc(state.lastError)}</span></div>` : ''}
      <button id="sync-now" class="btn btn-primary">Sync now</button>
      <p id="sync-msg" class="muted" role="status"></p>
      ${shownCode ? codeBlock(shownCode)
    : '<button id="sync-show-code" class="btn">Show sync code</button>'}
      <button id="sync-off" class="btn btn-danger">Turn off sync</button>
      <p class="muted">Turning sync off removes the server, the token and the key from
        this device only. Your floor plan, workouts and plans stay exactly where they
        are.</p>
    </section>`;
}

export function renderSettings(root) {
  const s = getSettings();
  const gyms = getGyms();
  const activeGym = gyms.list.find((p) => p.id === gyms.activeId);
  const gid = gyms.activeId;
  // consumed by THIS render — see codeOnce
  const shownCode = codeOnce;
  codeOnce = null;
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

    <!-- The demo gym never syncs (sync-plan decision 10), so the card is not
         rendered at all rather than shown disabled. -->
    ${activeGym.demo ? '' : syncCard(activeGym, shownCode)}

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

    <p class="muted footnote">gymii keeps everything in this browser (localStorage). Nothing
      leaves this device unless you turn on sync — and then only end-to-end encrypted, to a
      server you run. Export a backup before switching devices.</p>
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

  // --- sync ---
  // Every button below exists in exactly one of the card's two states (and
  // in neither for the demo gym), so each is wired optionally.

  const syncMsg = root.querySelector('#sync-msg');

  const enableBtn = root.querySelector('#sync-enable');
  enableBtn?.addEventListener('click', async () => {
    enableBtn.disabled = true;
    try {
      const { code, sync } = await enableSync(gid, {
        server: root.querySelector('#sync-server').value,
        token: root.querySelector('#sync-token').value,
      });
      codeOnce = code; // the code block only exists after the re-render
      renderSettings(root);
      root.querySelector('#sync-msg').textContent = `Sync is on. ${syncResultText(sync)}`;
      // the card just grew a code the user has to read before leaving
      keepInView(root, '#sync-code-out');
    } catch (err) {
      enableBtn.disabled = false;
      syncMsg.textContent = syncErrorText(err, 'Could not turn sync on');
    }
  });

  const pairBtn = root.querySelector('#sync-pair');
  pairBtn?.addEventListener('click', async () => {
    const raw = root.querySelector('#sync-code').value;
    if (!raw.trim()) {
      syncMsg.textContent = 'Paste the sync code from your other device first.';
      return;
    }
    pairBtn.disabled = true;
    try {
      // no code block here: the other device already showed it
      const { sync } = await pairWithCode(gid, raw);
      renderSettings(root);
      root.querySelector('#sync-msg').textContent = `Paired. ${syncResultText(sync)}`;
    } catch (err) {
      pairBtn.disabled = false;
      syncMsg.textContent = syncErrorText(err, 'Pairing failed');
    }
  });

  const nowBtn = root.querySelector('#sync-now');
  nowBtn?.addEventListener('click', async () => {
    nowBtn.disabled = true; // one round trip at a time
    nowBtn.textContent = 'Syncing…';
    const r = await syncNow(gid);
    renderSettings(root); // last-sync time and lastError have moved
    root.querySelector('#sync-msg').textContent = syncResultText(r);
  });

  // one extra tap, deliberately: the key is not on screen by default
  root.querySelector('#sync-show-code')?.addEventListener('click', () => {
    const code = getSyncCode(gid);
    if (!code) {
      syncMsg.textContent = 'No sync code on this device.';
      return;
    }
    codeOnce = code;
    renderSettings(root);
    keepInView(root, '#sync-code-out');
  });

  const copyBtn = root.querySelector('#sync-copy');
  copyBtn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shownCode);
      syncMsg.textContent = 'Sync code copied.';
    } catch {
      syncMsg.textContent = 'Clipboard blocked by the browser — select the code above and copy it by hand.';
    }
  });

  const syncOffBtn = root.querySelector('#sync-off');
  syncOffBtn?.addEventListener('click', () => {
    if (!twoTapConfirm(syncOffBtn,
      'Tap again to turn sync off — your data stays here', 'Turn off sync')) return;
    disableSync(gid); // credentials only; the gym's data is untouched
    renderSettings(root);
  });

  // Two-step confirm instead of a blocking confirm() dialog.
  const clearBtn = root.querySelector('#clear-all');
  clearBtn.addEventListener('click', () => {
    if (!twoTapConfirm(clearBtn, 'Tap again to erase everything', 'Clear all data')) return;
    clearAll();
    renderSettings(root);
  });
}
