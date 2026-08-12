import {
  getGym, saveGym, getSettings, saveSettings, getActive, saveActive, finishWorkout,
  lastEntryFor, getWorkouts, uid, usageByMachine, distUnit, newGym, addMachine,
} from './store.js';
import { drawGym, usagePayload, findMachineByNum } from './studio.js';
import { esc, fmtDuration, workoutTotals } from './ui.js';

// Active workout shape:
//   { v: 2, id, startedAt, plan: [machineId…], currentMachineId|null, entries: [] }
// plan is the guided order — prefilled when repeating a workout, growing as
// machines are opened in a free session. currentMachineId null shows the
// workout overview hub instead of a machine's logging screen.

export function renderTrain(root, message = '') {
  const gym = getGym();
  if (!gym || !gym.machines.length) {
    renderOnboarding(root, message);
    return;
  }
  const active = getActive();
  if (active) {
    if (!active.plan) { // migrate a pre-plan active workout
      active.plan = active.queue || active.entries.map((e) => e.machineId);
      saveActive(active);
    }
    if (active.currentMachineId) renderLog(root, gym, active);
    else renderOverview(root, gym, active);
  } else {
    renderStart(root, gym, message);
  }
}

// Start a guided workout from a past one (or empty/free with one machine).
// Exported so History can offer "repeat this workout" too.
export function startWorkoutFrom(source, firstMachineId = null) {
  const gym = getGym();
  // Set-dedupe: multi-exercise stations produce several entries per station
  // but only one plan slot.
  const plan = source
    ? [...new Set(source.entries.map((e) => e.machineId)
      .filter((id) => gym?.machines.some((m) => m.id === id)))]
    : [];
  if (firstMachineId && !plan.includes(firstMachineId)) plan.push(firstMachineId);
  saveActive({
    v: 2, id: uid(), startedAt: Date.now(),
    plan,
    currentMachineId: firstMachineId ?? plan[0] ?? null,
    currentExercise: null,
    entries: [],
  });
}

const machineChain = (workout) =>
  [...new Set(workout.entries.map((e) => `#${e.num}`))].join(' → ');

// --- start screen ---

function renderStart(root, gym, message) {
  const workouts = getWorkouts();
  const last = workouts[workouts.length - 1];
  const s = getSettings();

  // Easy starting points: the latest workout gets the big button, and
  // every DIFFERENT machine chain in history (a push/pull/legs rotation,
  // say) gets its own start row — routines emerge from the log, no
  // manual routine management.
  const routines = [];
  const seen = new Set(last ? [machineChain(last)] : []);
  for (let i = workouts.length - 2; i >= 0 && routines.length < 4; i--) {
    const chain = machineChain(workouts[i]);
    if (seen.has(chain)) continue;
    seen.add(chain);
    routines.push(workouts[i]);
  }

  root.innerHTML = `
    <h1>Train</h1>
    ${message ? `<p class="notice" role="status">${esc(message)}</p>` : ''}
    ${last ? `<button id="repeat" class="btn btn-primary btn-big">Repeat last workout
      <span class="sub">${new Date(last.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
      · ${machineChain(last)}</span></button>` : ''}
    ${routines.length ? `
    <section class="card">
      <h2>Start another routine</h2>
      ${routines.map((w) => `
        <div class="recent-row">
          <div class="recent-info">
            <strong>${machineChain(w)}</strong>
            <span class="muted">last: ${new Date(w.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              · ${workoutTotals(w, s)}</span>
          </div>
          <button class="btn btn-inline repeat-w" data-wid="${w.id}">Start</button>
        </div>`).join('')}
    </section>` : ''}
    <section class="card">
      <h2>Start at a machine</h2>
      <div id="picker"></div>
      <p class="muted">Opening a machine starts your workout — finish it any time
        from the workout overview.</p>
    </section>`;

  root.querySelector('#repeat')?.addEventListener('click', () => {
    startWorkoutFrom(last);
    renderTrain(root);
  });

  root.querySelectorAll('.repeat-w').forEach((btn) => {
    btn.addEventListener('click', () => {
      const workout = workouts.find((w) => w.id === btn.dataset.wid);
      if (!workout) return;
      startWorkoutFrom(workout);
      renderTrain(root);
    });
  });

  machinePicker(root.querySelector('#picker'), gym, (machineId) => {
    startWorkoutFrom(null, machineId);
    renderTrain(root);
  });
}

// First-run screen: three ways in — the studio (the intended path), a
// quick start that creates the gym and first machine right here, or the
// template library. Training never requires a studio visit first.
function renderOnboarding(root, message) {
  root.innerHTML = `
    <h1>Train</h1>
    ${message ? `<p class="notice" role="status">${esc(message)}</p>` : ''}
    <section class="card">
      <h2>Build your gym</h2>
      <p class="muted">Draw the floor plan and number the machines like the
        stickers in your gym — training then starts from that map.</p>
      <a class="btn btn-primary btn-big" href="#studio">Open the Studio</a>
    </section>
    <section class="card">
      <h2>Quick start</h2>
      <p class="muted">No time to draw? Name the machine in front of you and
        start logging — arrange the floor plan later in the Studio.</p>
      <div class="row">
        <input id="qs-label" type="text" placeholder="e.g. Chest press">
        <button id="qs-start" class="btn btn-inline">Start</button>
      </div>
    </section>
    <section class="card">
      <h2>Use a template</h2>
      <p class="muted">Load a ready-made gym from the
        <a href="#studio">Studio's template library</a>, or import a backup in
        <a href="#settings">Settings</a>.</p>
    </section>`;

  const start = () => {
    const label = root.querySelector('#qs-label').value.trim();
    if (!label) return;
    const gym = getGym() ?? newGym();
    const machine = addMachine(gym, gym.machines.length + 1, label);
    saveGym(gym);
    startWorkoutFrom(null, machine.id);
    renderTrain(root);
  };
  root.querySelector('#qs-start').addEventListener('click', start);
  root.querySelector('#qs-label').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') start();
  });
}

// Number input, muscle filter and tappable mini-map; calls onPick(machineId).
function machinePicker(container, gym, onPick) {
  const allMuscles = [...new Set(gym.machines.flatMap((m) => m.muscles || []))]
    .sort((a, b) => a.localeCompare(b));

  container.innerHTML = `
    <div class="row">
      <input class="pick-num" type="number" inputmode="numeric" min="1" placeholder="Machine #">
      <button class="btn btn-inline pick-go">Open</button>
    </div>
    ${allMuscles.length ? `
    <select class="pick-muscle" aria-label="Filter by muscle">
      <option value="">All muscles</option>
      ${allMuscles.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}
    </select>
    <div class="pick-chips"></div>` : ''}
    <div class="map-wrap"><svg xmlns="http://www.w3.org/2000/svg"></svg></div>
    <div class="map-mode pick-mode">
      <button type="button" class="chip" data-mode="custom">Colors</button>
      <button type="button" class="chip" data-mode="usage">Usage</button>
    </div>
    <p class="pick-err muted">Enter a machine number or tap one on the map.</p>`;

  const svg = container.querySelector('svg');
  const drawMap = () => drawGym(svg, gym, {
    usage: getSettings().mapColors === 'usage' ? usagePayload(usageByMachine()) : null,
  });
  drawMap();

  const modeBar = container.querySelector('.pick-mode');
  const updateModeBar = () => modeBar.querySelectorAll('.chip').forEach((c) =>
    c.classList.toggle('sel', (c.dataset.mode === 'usage') === (getSettings().mapColors === 'usage')));
  updateModeBar();

  const input = container.querySelector('.pick-num');
  const err = container.querySelector('.pick-err');

  const go = () => {
    const num = Math.round(parseFloat(input.value));
    if (!num) return;
    const machine = findMachineByNum(gym, num);
    if (!machine) {
      // create-on-miss: standing at a real machine whose number gymii
      // doesn't know yet, one tap adds it — rename/arrange later in Studio
      err.innerHTML = `No machine #${num} yet — <button type="button"
        class="btn btn-inline pick-create">Create #${num} &amp; open</button>`;
      err.querySelector('.pick-create').addEventListener('click', () => {
        const created = addMachine(gym, num, `Machine ${num}`);
        saveGym(gym);
        onPick(created.id);
      });
      return;
    }
    onPick(machine.id);
  };
  container.querySelector('.pick-go').addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  svg.addEventListener('click', (e) => {
    const g = e.target.closest('.machine');
    if (g) onPick(g.dataset.id);
  });

  const muscleSelect = container.querySelector('.pick-muscle');
  const chips = container.querySelector('.pick-chips');
  const applyMuscleFilter = () => {
    const muscle = muscleSelect?.value || '';
    const matching = muscle
      ? gym.machines.filter((m) => (m.muscles || []).includes(muscle))
      : [];
    const matchIds = new Set(matching.map((m) => m.id));
    svg.querySelectorAll('.machine').forEach((g) => {
      g.style.opacity = !muscle || matchIds.has(g.dataset.id) ? '' : '0.22';
    });
    if (chips) {
      chips.innerHTML = matching
        .sort((a, b) => a.num - b.num)
        .map((m) => `<button class="chip" data-id="${m.id}">#${m.num} ${esc(m.label)}</button>`)
        .join('');
    }
  };
  muscleSelect?.addEventListener('change', applyMuscleFilter);
  chips?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) onPick(chip.dataset.id);
  });

  modeBar.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    saveSettings({ ...getSettings(), mapColors: chip.dataset.mode });
    updateModeBar();
    drawMap();
    applyMuscleFilter(); // redraw resets the dimming, so re-apply it
  });
}

// --- workout overview hub ---

// Exact-match lookup for the logging screen (exercise-scoped entries at
// multi-exercise stations); entriesForMachine aggregates a whole station
// for the overview hub and done-state.
const entryFor = (active, machineId, exercise = null) =>
  active.entries.find((e) => e.machineId === machineId && (e.exercise ?? null) === exercise);
const entriesForMachine = (active, machineId) =>
  active.entries.filter((e) => e.machineId === machineId);
const isDone = (active, machineId) =>
  entriesForMachine(active, machineId).some((e) => e.sets.length);

function renderOverview(root, gym, active) {
  const s = getSettings();
  const sets = active.entries.reduce((n, e) => n + e.sets.length, 0);
  const mins = Math.max(1, Math.round((Date.now() - active.startedAt) / 60000));

  const rows = active.plan.map((id) => {
    const machine = gym.machines.find((m) => m.id === id);
    const stationEntries = entriesForMachine(active, id);
    if (!machine && !stationEntries.length) return '';
    const num = machine?.num ?? stationEntries[0].num;
    const label = machine?.label ?? stationEntries[0].label;
    const stationSets = stationEntries.reduce((n, e) => n + e.sets.length, 0);
    const done = isDone(active, id);
    return `<button class="plan-row" data-id="${id}" ${machine ? '' : 'disabled'}>
      <span class="machine-badge sm">${num}</span>
      <span class="plan-label">${esc(label)}</span>
      <span class="plan-status${done ? ' done' : ''}">${done
        ? `✓ ${stationSets} set${stationSets === 1 ? '' : 's'}` : 'open'}</span>
    </button>`;
  }).join('');

  root.innerHTML = `
    <h1>Workout</h1>
    <p class="muted">${mins} min · ${sets} set${sets === 1 ? '' : 's'} · ${workoutTotals(active, s)}</p>
    <section class="card">
      <h2>Locker</h2>
      <div class="row">
        <input id="locker-num" type="text" inputmode="numeric" placeholder="Locker #"
          value="${esc(active.locker ?? '')}">
      </div>
      <p class="muted">Note where your stuff is — handy if the key goes missing.</p>
    </section>
    <section class="card">
      <h2>Machines</h2>
      ${rows || '<p class="muted">No machines yet — pick your first one below.</p>'}
    </section>
    <section class="card">
      <h2>Add machine</h2>
      <div id="picker"></div>
    </section>
    <button id="finish" class="btn">Finish workout</button>`;

  root.querySelector('#locker-num').addEventListener('change', (e) => {
    active.locker = e.target.value.trim();
    saveActive(active);
  });

  root.querySelectorAll('.plan-row').forEach((row) => {
    row.addEventListener('click', () => {
      active.currentMachineId = row.dataset.id;
      active.currentExercise = null;
      saveActive(active);
      renderTrain(root);
    });
  });

  machinePicker(root.querySelector('#picker'), gym, (machineId) => {
    if (!active.plan.includes(machineId)) active.plan.push(machineId);
    active.currentMachineId = machineId;
    active.currentExercise = null;
    saveActive(active);
    renderTrain(root);
  });

  // two-tap guard: finishing only happens once, at the very end
  const finishBtn = root.querySelector('#finish');
  let armTimer = null;
  finishBtn.addEventListener('click', () => {
    if (!finishBtn.classList.contains('armed')) {
      finishBtn.classList.add('armed', 'btn-primary');
      finishBtn.textContent = sets
        ? 'Tap again to finish & save'
        : 'Tap again to discard (no sets logged)';
      armTimer = setTimeout(() => {
        finishBtn.classList.remove('armed', 'btn-primary');
        finishBtn.textContent = 'Finish workout';
      }, 4000);
      return;
    }
    clearTimeout(armTimer);
    finish(root, active);
  });
}

// Next unfinished machine in the plan after `afterId`, wrapping around so
// a skipped (busy) machine comes up again at the end.
function nextOpenMachineId(active, afterId) {
  const idx = active.plan.indexOf(afterId);
  const order = [...active.plan.slice(idx + 1), ...active.plan.slice(0, Math.max(idx, 0))];
  return order.find((id) => id !== afterId && !isDone(active, id)) ?? null;
}

// --- logging screen ---

function renderLog(root, gym, active) {
  const machine = gym.machines.find((m) => m.id === active.currentMachineId);
  if (!machine) { // machine was deleted in the studio mid-workout
    active.currentMachineId = null;
    active.currentExercise = null;
    saveActive(active);
    renderTrain(root);
    return;
  }

  if (!active.plan.includes(machine.id)) { // free sessions grow the plan
    active.plan.push(machine.id);
    saveActive(active);
  }

  // At multi-exercise stations (free weights) each exercise gets its own
  // entry; until one is picked there is no entry and no logging UI.
  const exercises = machine.exercises ?? [];
  const exercise = exercises.includes(active.currentExercise) ? active.currentExercise : null;
  const pickPending = exercises.length > 0 && !exercise;

  const last = pickPending ? null : lastEntryFor(machine.id, exercise);
  let entry = null;
  if (!pickPending) {
    entry = entryFor(active, machine.id, exercise);
    if (!entry) {
      // created eagerly so settings edits stick; set-less entries are
      // dropped again when the workout is finished. type flags and the
      // exercise are snapshotted like num/label so history stays readable
      // if the machine changes.
      entry = {
        machineId: machine.id, num: machine.num, label: machine.label,
        ...(machine.cardio ? { cardio: true } : {}),
        ...(machine.bodyweight ? { bodyweight: true } : {}),
        ...(exercise ? { exercise } : {}),
        settings: {}, sets: [],
      };
      machine.settingsFields.forEach((f) => { entry.settings[f] = last?.settings?.[f] ?? ''; });
      active.entries.push(entry);
      saveActive(active);
    } else if (!entry.sets.length
      && (!!entry.cardio !== !!machine.cardio || !!entry.bodyweight !== !!machine.bodyweight)) {
      // machine type was toggled in the studio before any set was logged
      if (machine.cardio) entry.cardio = true; else delete entry.cardio;
      if (machine.bodyweight) entry.bodyweight = true; else delete entry.bodyweight;
      saveActive(active);
    }
  }

  const s = getSettings();
  // entry flags rule the screen — sets stay homogeneous per entry
  const type = entry?.cardio ? 'cardio' : entry?.bodyweight ? 'bodyweight' : 'strength';
  const cardio = type === 'cardio';
  const du = distUnit(s);
  // A last entry of another type (flag toggled since) is useless as a
  // set prefill or "Last:" line; machine settings still carry over above.
  const lastSets = last
    && !!last.cardio === !!entry?.cardio
    && !!last.bodyweight === !!entry?.bodyweight ? last : null;
  const def = pickPending ? null : nextSetDefaults(entry, lastSets, type, s);
  const restSeconds = machine.restSeconds ?? s.restSeconds;
  const planPos = `${active.plan.indexOf(machine.id) + 1}/${active.plan.length}`;
  const nextId = nextOpenMachineId(active, machine.id);
  const nextMachine = nextId ? gym.machines.find((m) => m.id === nextId) : null;

  root.innerHTML = `
    <div class="machine-head">
      <span class="machine-badge">${machine.num}</span>
      <div>
        <div class="title">${esc(machine.label)} <span class="muted">${planPos}</span>
          ${active.locker ? `<span class="muted">· 🔒 ${esc(active.locker)}</span>` : ''}</div>
        <div class="muted">${pickPending
    ? 'Pick an exercise below'
    : lastSets
      ? `Last: ${setsSummary(lastSets.sets, s, !!lastSets.bodyweight)}`
      : `First time on this ${exercise ? 'exercise' : 'machine'}`}</div>
        ${machine.muscles?.length ? `<div class="muted">${machine.muscles.map(esc).join(' · ')}</div>` : ''}
        ${machine.docUrl ? `<a class="doc-link" href="${esc(machine.docUrl)}"
          target="_blank" rel="noopener">Machine docs ↗</a>` : ''}
      </div>
    </div>

    ${exercises.length ? `
    <section class="card">
      <h2>Exercise</h2>
      <div class="chip-select" id="exercise-chips">
        ${exercises.map((x) => `<button type="button" class="chip${x === exercise ? ' sel' : ''}"
          data-exercise="${esc(x)}">${esc(x)}</button>`).join('')}
      </div>
      ${pickPending ? '<p class="muted">Pick an exercise to start logging.</p>' : ''}
    </section>` : ''}

    ${pickPending ? '' : `
    ${machine.settingsFields.length ? `
    <section class="card">
      <h2>Machine settings</h2>
      ${machine.settingsFields.map((f) => `
        <label class="field"><span>${esc(f)}</span>
          <input type="text" class="m-setting" data-field="${esc(f)}"
            value="${esc(entry.settings[f] ?? '')}">
        </label>`).join('')}
    </section>` : ''}

    <section class="card">
      <h2>Sets</h2>
      <div id="sets-list">
        ${entry.sets.map((st, i) => `
          <div class="set-row">
            <span>Set ${i + 1}</span>
            <span>${cardio
    ? `${st.distance} ${du} · ${fmtDuration(st.seconds)}`
    : type === 'bodyweight'
      ? (st.weight ? `BW+${st.weight} ${s.unit} × ${st.reps}` : `BW × ${st.reps}`)
      : `${st.weight} ${s.unit} × ${st.reps}`}</span>
            <button class="x" data-i="${i}" aria-label="Remove set ${i + 1}">✕</button>
          </div>`).join('') || '<p class="muted">No sets logged yet.</p>'}
      </div>
      <div class="next-set">
        ${cardio ? `
        <div class="spread"><span class="label">Distance (${du})</span>
          <div class="stepper" data-step="${s.unit === 'kg' ? 100 : 0.1}" data-min="0">
            <button type="button" class="step-down" aria-label="decrease distance">−</button>
            <input id="set-distance" type="number" inputmode="decimal" value="${def.distance}">
            <button type="button" class="step-up" aria-label="increase distance">+</button>
          </div>
        </div>
        <div class="spread"><span class="label">Time (min)</span>
          <div class="stepper" data-step="1" data-min="0">
            <button type="button" class="step-down" aria-label="decrease time">−</button>
            <input id="set-time" type="number" inputmode="decimal" value="${Math.round((def.seconds / 60) * 100) / 100}">
            <button type="button" class="step-up" aria-label="increase time">+</button>
          </div>
        </div>` : type === 'bodyweight' ? `
        <div class="spread"><span class="label">Reps</span>
          <div class="stepper" data-step="1" data-min="1">
            <button type="button" class="step-down" aria-label="decrease reps">−</button>
            <input id="set-reps" type="number" inputmode="numeric" value="${def.reps}">
            <button type="button" class="step-up" aria-label="increase reps">+</button>
          </div>
        </div>
        <div class="spread"><span class="label">Extra weight</span>
          <div class="stepper" data-step="${s.weightStep}" data-min="0">
            <button type="button" class="step-down" aria-label="decrease extra weight">−</button>
            <input id="set-weight" type="number" inputmode="decimal" value="${def.weight}">
            <button type="button" class="step-up" aria-label="increase extra weight">+</button>
          </div>
        </div>` : `
        <div class="spread"><span class="label">Weight</span>
          <div class="stepper" data-step="${s.weightStep}" data-min="0">
            <button type="button" class="step-down" aria-label="decrease weight">−</button>
            <input id="set-weight" type="number" inputmode="decimal" value="${def.weight}">
            <button type="button" class="step-up" aria-label="increase weight">+</button>
          </div>
        </div>
        <div class="spread"><span class="label">Reps</span>
          <div class="stepper" data-step="1" data-min="1">
            <button type="button" class="step-down" aria-label="decrease reps">−</button>
            <input id="set-reps" type="number" inputmode="numeric" value="${def.reps}">
            <button type="button" class="step-up" aria-label="increase reps">+</button>
          </div>
        </div>`}
        <div class="spread"><span class="label">Rest (s)</span>
          <div class="stepper" data-step="15" data-min="0">
            <button type="button" class="step-down" aria-label="decrease rest">−</button>
            <input id="set-rest" type="number" inputmode="numeric" value="${restSeconds}">
            <button type="button" class="step-up" aria-label="increase rest">+</button>
          </div>
        </div>
        <button id="log-set" class="btn btn-primary btn-big">✓ Log set</button>
      </div>
    </section>`}

    ${nextMachine
    ? `<button id="next-machine" class="btn btn-next btn-big">Next: #${nextMachine.num}
        ${esc(nextMachine.label)} →</button>
      <button id="change-machine" class="btn">Change machine / overview</button>`
    : '<button id="change-machine" class="btn btn-next btn-big">Workout overview →</button>'}
  `;

  root.querySelector('#exercise-chips')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    active.currentExercise = chip.dataset.exercise;
    saveActive(active);
    renderLog(root, gym, active);
  });

  // Everything below the exercise picker only exists once an entry is
  // resolved — hence the optional chaining on the pick-pending screen.
  root.querySelectorAll('.m-setting').forEach((inp) => {
    inp.addEventListener('change', () => {
      entry.settings[inp.dataset.field] = inp.value.trim();
      saveActive(active);
    });
  });

  root.querySelector('#sets-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.x');
    if (!btn) return;
    entry.sets.splice(parseInt(btn.dataset.i, 10), 1);
    saveActive(active);
    renderLog(root, gym, active);
  });

  // per-machine rest override, remembered on the machine itself
  root.querySelector('#set-rest')?.addEventListener('change', (e) => {
    const v = Math.max(0, Math.round(parseFloat(e.target.value) || 0));
    e.target.value = v;
    machine.restSeconds = v;
    saveGym(gym);
  });

  root.querySelector('#log-set')?.addEventListener('click', () => {
    const rest = Math.max(0, Math.round(parseFloat(root.querySelector('#set-rest').value) || 0));
    if (cardio) {
      const distance = Math.max(0, parseFloat(root.querySelector('#set-distance').value) || 0);
      const seconds = Math.max(0, Math.round((parseFloat(root.querySelector('#set-time').value) || 0) * 60));
      entry.sets.push({ distance, seconds });
    } else {
      const weight = Math.max(0, parseFloat(root.querySelector('#set-weight').value) || 0);
      const reps = Math.max(1, Math.round(parseFloat(root.querySelector('#set-reps').value) || 1));
      entry.sets.push({ reps, weight });
    }
    saveActive(active);
    renderLog(root, gym, active);
    startRest(rest);
  });

  root.querySelector('#next-machine')?.addEventListener('click', () => {
    active.currentMachineId = nextId;
    active.currentExercise = null;
    saveActive(active);
    renderTrain(root);
  });

  root.querySelector('#change-machine').addEventListener('click', () => {
    active.currentMachineId = null;
    active.currentExercise = null;
    saveActive(active);
    renderTrain(root);
  });
}

// Default for the next set: same set number last time, then the set just
// done this session, then the last set of the previous session. `last`
// must already be type-matched to the entry (caller gates on the flags).
function nextSetDefaults(entry, last, type, s) {
  const i = entry.sets.length;
  if (last?.sets?.[i]) return last.sets[i];
  if (entry.sets.length) return entry.sets[entry.sets.length - 1];
  if (last?.sets?.length) return last.sets[last.sets.length - 1];
  if (type === 'cardio') return { distance: s.unit === 'kg' ? 1000 : 0.5, seconds: 600 };
  if (type === 'bodyweight') return { reps: 10, weight: 0 };
  return { reps: 10, weight: 20 };
}

// Branches per set shape (bodyweight shares {reps,weight}, so its flag is
// passed in); the weight unit is appended once when any weight was moved.
const setsSummary = (sets, s, bodyweight = false) => {
  const body = sets.map((st) => (st.distance != null
    ? `${st.distance} ${distUnit(s)} · ${fmtDuration(st.seconds)}`
    : bodyweight
      ? (st.weight ? `BW+${st.weight}×${st.reps}` : `BW×${st.reps}`)
      : `${st.weight}×${st.reps}`)).join(', ');
  const suffix = sets.every((st) => st.distance == null) && sets.some((st) => st.weight)
    ? ` ${s.unit}` : '';
  return body + suffix;
};

function finish(root, active) {
  const saved = finishWorkout(active);
  if (!saved) {
    renderTrain(root, 'Workout discarded — no sets were logged.');
    return;
  }
  const sets = saved.entries.reduce((n, e) => n + e.sets.length, 0);
  renderTrain(root, `Workout saved: ${saved.entries.length} machine${saved.entries.length === 1 ? '' : 's'}, `
    + `${sets} sets, ${workoutTotals(saved, getSettings())} total.`);
}

// --- rest timer ---

function startRest(secs) {
  if (!secs) return; // 0 = rest timer off

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="muted">REST</div>
    <div class="countdown" id="cd"></div>
    <div class="row">
      <button class="btn" id="rest-minus">−15s</button>
      <button class="btn" id="rest-plus">+15s</button>
    </div>
    <div class="row"><button class="btn btn-primary" id="rest-skip">Skip</button></div>`;
  document.body.appendChild(overlay);

  let endsAt = Date.now() + secs * 1000;
  let done = false;
  const cd = overlay.querySelector('#cd');

  // Keep the screen on while resting. The browser auto-releases the lock
  // when the tab is hidden, so re-acquire on return.
  let wakeLock = null;
  const requestWakeLock = async () => {
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
      wakeLock?.addEventListener('release', () => { wakeLock = null; });
    } catch { /* unsupported or denied */ }
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible' && !wakeLock) requestWakeLock();
  };
  requestWakeLock();
  document.addEventListener('visibilitychange', onVisible);

  const close = () => {
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisible);
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    overlay.remove();
  };
  const tick = () => {
    const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    cd.textContent = fmtDuration(rem);
    if (rem === 0 && !done) {
      done = true;
      cd.classList.add('done');
      beep();
      navigator.vibrate?.(200);
      setTimeout(close, 900);
    }
  };
  const interval = setInterval(tick, 200);
  tick();

  overlay.querySelector('#rest-skip').addEventListener('click', close);
  overlay.querySelector('#rest-minus').addEventListener('click', () => { endsAt -= 15000; tick(); });
  overlay.querySelector('#rest-plus').addEventListener('click', () => { endsAt += 15000; tick(); });
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const play = (t, freq) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.3);
    };
    play(ctx.currentTime, 880);
    play(ctx.currentTime + 0.35, 880);
    setTimeout(() => ctx.close(), 1000);
  } catch {
    // audio is best-effort; some browsers block it before user interaction
  }
}
