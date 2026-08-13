import {
  getGym, saveGym, getSettings, saveSettings, getActive, saveActive, finishWorkout,
  lastEntryFor, getWorkouts, getPlans, uid, usageByMachine, gymMuscles, distUnit,
  newGym, addMachine,
} from './store.js';
import { drawGym, usagePayload, findMachineByNum } from './studio.js';
import { renderPlanBuilder } from './plan.js';
import { esc, fmtDuration, workoutTotals, setStr, twoTapConfirm, stepperField } from './ui.js';

// Active workout shape:
//   { v: 2, id, startedAt, plan: [{machineId, exercise|null, target?}…],
//     currentMachineId|null, currentExercise|null, entries: [] }
// plan is the guided order — one slot per (machine, exercise) pair when
// repeating a workout (so "Next:" walks every exercise of a multi-exercise
// station), growing as machines are opened in a free session. exercise null
// means the slot covers the whole station. currentMachineId null shows the
// workout overview hub instead of a machine's logging screen. Slots started
// from a stored plan may carry a target ({sets,reps,weight} or
// {distance,seconds}) — older/free slots simply lack the key.
// Each entry.sets item ({ reps, weight } or { distance, seconds }) also
// carries `at` — epoch ms stamped via `Date.now()` when the set is logged.
// Sets logged before this feature lack `at`; consumers must guard for it.

// Train-tab internal screen state: when set, the start screen yields to
// the plan builder ({ planId|null, notice }). An active workout still
// outranks it — a mid-workout AI import just saves the plan silently.
let builder = null;

// Lets ai.js hand an imported plan over for review before switching the
// hash to #train (module state survives; the app never reloads between tabs).
export function openPlanBuilder(planId, notice = '') {
  builder = { planId, notice };
}

export function renderTrain(root, message = '') {
  const gym = getGym();
  const active = getActive();
  // An in-progress workout outranks onboarding: machines can be wiped
  // mid-workout by an import or a studio edit, and the quick start must
  // never overwrite logged sets.
  if (!gym || (!active && !gym.machines.length)) {
    builder = null; // a wiped gym invalidates a pending builder screen
    renderOnboarding(root, message);
    return;
  }
  if (active) {
    if (!active.plan) { // migrate a pre-plan active workout
      active.plan = active.queue || active.entries.map((e) => e.machineId);
      saveActive(active);
    }
    if (active.plan.some((p) => typeof p === 'string')) { // machineIds → slots
      active.plan = active.plan.map((p) =>
        (typeof p === 'string' ? { machineId: p, exercise: null } : p));
      saveActive(active);
    }
    if (active.currentMachineId) renderLog(root, gym, active);
    else renderOverview(root, gym, active);
  } else if (builder) {
    renderPlanBuilder(root, builder, (message2 = '') => {
      builder = null;
      renderTrain(root, message2);
    });
  } else {
    renderStart(root, gym, message);
  }
}

// Start a guided workout from a past one (or empty/free with one machine).
// Exported so History can offer "repeat this workout" too.
export function startWorkoutFrom(source, firstMachineId = null) {
  const gym = getGym();
  // One plan slot per (machine, exercise) pair, deduped — the guided flow
  // then walks every exercise of a multi-exercise station. An exercise the
  // machine no longer offers falls back to a whole-station slot, and such
  // station slots are dropped again when exercise slots for the same
  // machine exist (the overview would double-report their sets).
  const pairs = (source?.entries ?? [])
    .map((e) => {
      const machine = gym?.machines.find((m) => m.id === e.machineId);
      if (!machine) return null;
      const exercise = machine.exercises?.includes(e.exercise) ? e.exercise : null;
      // a stored plan's items carry their target through to the slot
      return { machineId: e.machineId, exercise, ...(e.target ? { target: e.target } : {}) };
    })
    .filter(Boolean);
  const plan = pairs
    .filter((p, i) => pairs.findIndex(
      (q) => q.machineId === p.machineId && q.exercise === p.exercise) === i)
    .filter((p) => p.exercise
      || !pairs.some((q) => q.machineId === p.machineId && q.exercise));
  if (firstMachineId && !plan.some((p) => p.machineId === firstMachineId)) {
    plan.push({ machineId: firstMachineId, exercise: null });
  }
  saveActive({
    v: 2, id: uid(), startedAt: Date.now(),
    // repeating a named workout keeps its identity — without this the
    // routine group would split into a named and an unnamed half
    ...(source?.name ? { name: source.name } : {}),
    plan,
    currentMachineId: firstMachineId ?? plan[0]?.machineId ?? null,
    currentExercise: firstMachineId ? null : plan[0]?.exercise ?? null,
    entries: [],
  });
}

const machineChain = (workout) =>
  [...new Set(workout.entries.map((e) => `#${e.num}`))].join(' → ');

// --- start screen ---

// Distinct machine nums of a plan, in item order — the plan-list twin of
// machineChain (which reads a workout's entries).
const planChain = (plan, gym) => [...new Set(plan.items
  .map((it) => gym.machines.find((m) => m.id === it.machineId))
  .filter(Boolean).map((m) => `#${m.num}`))].join(' → ');

function renderStart(root, gym, message) {
  const workouts = getWorkouts();
  const last = workouts[workouts.length - 1];
  const s = getSettings();
  const plans = getPlans();
  // A named plan OWNS its routine: workouts logged from it carry its name,
  // and their derived start rows would duplicate the plan's own row.
  const planNames = new Set(plans.map((p) => p.name).filter(Boolean));

  // Easy starting points: the latest workout gets the big button, and
  // every DIFFERENT machine set in history (a push/pull/legs rotation,
  // say) gets its own start row — routines emerge from the log, no
  // manual routine management. Keyed on machine IDs, not the displayed
  // #num chain, so renumbering in the studio doesn't split a routine.
  // An optional workout name outranks that chain: two routines on the
  // same machines but with different exercises stay apart once named.
  const routineKey = (w) => (w.name
    ? `name:${w.name}`
    : [...new Set(w.entries.map((e) => e.machineId))].join('|'));
  const routines = [];
  const seen = new Set(last ? [routineKey(last)] : []);
  for (let i = workouts.length - 2; i >= 0 && routines.length < 4; i--) {
    const w = workouts[i];
    const key = routineKey(w);
    if (seen.has(key) || (w.name && planNames.has(w.name))) continue;
    seen.add(key);
    routines.push(w);
  }

  // "last done" for a plan comes from history via its name
  const planLastDone = (p) => (p.name
    ? workouts.findLast((w) => w.name === p.name) ?? null : null);

  root.innerHTML = `
    <h1>Train</h1>
    ${message ? `<p class="notice" role="status">${esc(message)}</p>` : ''}
    ${last ? `<button id="repeat" class="btn btn-primary btn-big">Repeat last workout
      <span class="sub">${new Date(last.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
      · ${last.name ? `${esc(last.name)} · ` : ''}${machineChain(last)}</span></button>` : ''}
    <section class="card">
      <h2>Planned workouts</h2>
      <div id="plan-list">
        ${plans.map((p) => {
    const done = planLastDone(p);
    const machines = new Set(p.items.map((it) => it.machineId)).size;
    return `<div class="recent-row">
          <div class="recent-info">
            <strong>${p.name ? esc(p.name) : planChain(p, gym) || 'Unnamed plan'}</strong>
            <span class="muted">${p.name ? `${planChain(p, gym)} · ` : ''}${machines} machine${machines === 1 ? '' : 's'}${done
    ? ` · last: ${new Date(done.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}</span>
          </div>
          <button class="btn btn-inline plan-edit" data-pid="${p.id}">Edit</button>
          <button class="btn btn-inline plan-start" data-pid="${p.id}">Start</button>
        </div>`;
  }).join('')}
      </div>
      <button id="plan-new" class="btn">+ Plan a workout</button>
      ${plans.length ? '' : `<p class="muted">Build a session in advance — pick machines
        by muscle, set targets, start it any day. Or ask your AI for one on the AI tab.</p>`}
    </section>
    ${routines.length ? `
    <section class="card">
      <h2>Start another routine</h2>
      ${routines.map((w) => `
        <div class="recent-row">
          <div class="recent-info">
            <strong>${w.name ? esc(w.name) : machineChain(w)}</strong>
            <span class="muted">${w.name ? `${machineChain(w)} · ` : ''}last: ${new Date(w.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              · ${workoutTotals(w, s)}</span>
          </div>
          <button class="btn btn-inline repeat-w" data-wid="${w.id}">Repeat</button>
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

  // delegated: the stubbed test DOM (and less wiring) both prefer one
  // listener on the list over one per row
  root.querySelector('#plan-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.plan-start, .plan-edit');
    if (!btn) return;
    const plan = plans.find((p) => p.id === btn.dataset.pid);
    if (!plan) return;
    if (btn.classList.contains('plan-edit')) {
      builder = { planId: plan.id, notice: '' };
      renderTrain(root);
      return;
    }
    startWorkoutFrom({
      ...(plan.name ? { name: plan.name } : {}),
      entries: plan.items,
    });
    renderTrain(root);
  });

  root.querySelector('#plan-new').addEventListener('click', () => {
    builder = { planId: null, notice: '' };
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
    // backstop: never clobber a workout that already has logged sets
    if (getActive()?.entries.some((e) => e.sets.length)) return;
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

// Number input, muscle filter and a tappable mini-map; calls
// onPick(machineId). The map is collapsed by default (settings.pickerMap)
// — number and muscle are the picker's primary inputs, the map is the
// on-demand answer to "where?", not the main navigation surface.
function machinePicker(container, gym, onPick) {
  const allMuscles = gymMuscles(gym);

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
      <button type="button" class="chip map-toggle">🗺 Map</button>
      <button type="button" class="chip" data-mode="custom">Colors</button>
      <button type="button" class="chip" data-mode="usage">Usage</button>
    </div>
    <p class="pick-err muted">Enter a machine number — or pick by muscle or map.</p>`;

  const svg = container.querySelector('svg');
  // drawn lazily on first expand — most picks go via number or muscle
  const drawMap = () => drawGym(svg, gym, {
    usage: getSettings().mapColors === 'usage' ? usagePayload(usageByMachine()) : null,
  });

  const modeBar = container.querySelector('.pick-mode');
  const updateModeBar = () => modeBar.querySelectorAll('.chip[data-mode]').forEach((c) =>
    c.classList.toggle('sel', (c.dataset.mode === 'usage') === (getSettings().mapColors === 'usage')));
  updateModeBar();

  // Collapse state lives in settings (one global preference, both picker
  // instances follow it). Colors/Usage only make sense with a visible map.
  const mapWrap = container.querySelector('.map-wrap');
  const mapToggle = modeBar.querySelector('.map-toggle');
  const applyMapState = () => {
    const shown = getSettings().pickerMap === 'shown';
    mapWrap.style.display = shown ? '' : 'none';
    modeBar.querySelectorAll('.chip[data-mode]').forEach((c) => {
      c.style.display = shown ? '' : 'none';
    });
    mapToggle.classList.toggle('sel', shown);
    if (shown && !svg.childElementCount) { // not drawn yet
      drawMap();
      applyMuscleFilter(); // map may open with a muscle filter already set
    }
  };
  mapToggle.addEventListener('click', () => {
    const cur = getSettings();
    saveSettings({ ...cur, pickerMap: cur.pickerMap === 'shown' ? 'hidden' : 'shown' });
    applyMapState();
  });

  const input = container.querySelector('.pick-num');
  const err = container.querySelector('.pick-err');

  const go = () => {
    const num = Math.round(parseFloat(input.value));
    if (!num || num < 1) return;
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
    const chip = e.target.closest('.chip[data-mode]'); // not the map toggle
    if (!chip) return;
    saveSettings({ ...getSettings(), mapColors: chip.dataset.mode });
    updateModeBar();
    drawMap();
    applyMuscleFilter(); // redraw resets the dimming, so re-apply it
  });

  applyMapState();

  // small outside API: the overview's muscle-coverage chips drive the
  // picker's filter ("Legs still open" → tap → leg machines listed here)
  return {
    setMuscle(muscle) {
      if (!muscleSelect) return;
      muscleSelect.value = muscle;
      applyMuscleFilter();
      container.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    },
  };
}

// Fullscreen read-only floor map with one machine highlighted — answers
// "where is it?", the map's one job during training. Any tap closes it.
function showMapOverlay(gym, machine) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay map-overlay';
  overlay.innerHTML = `
    <div class="machine-head">
      <span class="machine-badge">${machine.num}</span>
      <div class="title">${esc(machine.label)}</div>
    </div>
    <div class="map-wrap"><svg xmlns="http://www.w3.org/2000/svg"></svg></div>
    <div class="muted">Tap anywhere to close</div>`;
  document.body.appendChild(overlay);
  drawGym(overlay.querySelector('svg'), gym, { highlightId: machine.id });
  overlay.addEventListener('click', () => overlay.remove());
}

// --- workout overview hub ---

// Exact-match lookup for the logging screen (exercise-scoped entries at
// multi-exercise stations); slotEntries aggregates a whole station when the
// slot's exercise is null. A slot is done once any of its entries has sets.
const entryFor = (active, machineId, exercise = null) =>
  active.entries.find((e) => e.machineId === machineId && (e.exercise ?? null) === exercise);
const slotEntries = (active, slot) =>
  active.entries.filter((e) => e.machineId === slot.machineId
    && (!slot.exercise || (e.exercise ?? null) === slot.exercise));
const slotSetCount = (active, slot) =>
  slotEntries(active, slot).reduce((n, e) => n + e.sets.length, 0);
// Done means any set logged — or, when the slot carries a plan target,
// the target's set count reached: the "Next" walk then keeps pulling the
// workout back to stations with unfinished targets.
const slotDone = (active, slot) => (slot.target?.sets
  ? slotSetCount(active, slot) >= slot.target.sets
  : slotEntries(active, slot).some((e) => e.sets.length));

function renderOverview(root, gym, active) {
  const s = getSettings();
  const sets = active.entries.reduce((n, e) => n + e.sets.length, 0);
  const mins = Math.max(1, Math.round((Date.now() - active.startedAt) / 60000));

  // Muscle coverage today: muscles of every machine with ≥1 set this
  // session, read live from the gym (entries don't snapshot muscles;
  // deleted machines contribute none). The chips double as navigation —
  // tapping one drives the picker's muscle filter below.
  const allMuscles = gymMuscles(gym);
  const trained = new Set(active.entries
    .filter((e) => e.sets.length)
    .flatMap((e) => gym.machines.find((m) => m.id === e.machineId)?.muscles ?? []));

  const rows = active.plan.map((slot, i) => {
    const machine = gym.machines.find((m) => m.id === slot.machineId);
    const entries = slotEntries(active, slot);
    if (!machine && !entries.length) return '';
    const num = machine?.num ?? entries[0].num;
    const label = machine?.label ?? entries[0].label;
    const slotSets = entries.reduce((n, e) => n + e.sets.length, 0);
    const done = slotDone(active, slot);
    const goal = slot.target?.sets;
    // with a target the status counts progress against it ("1/3 sets")
    const status = !slotSets && !done ? 'open'
      : `${done ? '✓ ' : ''}${slotSets}${goal ? `/${goal}` : ''} set${(goal ?? slotSets) === 1 ? '' : 's'}`;
    return `<button class="plan-row" data-i="${i}" ${machine ? '' : 'disabled'}>
      <span class="machine-badge sm">${num}</span>
      <span class="plan-label">${esc(label)}${slot.exercise
        ? ` <span class="muted">· ${esc(slot.exercise)}</span>` : ''}</span>
      <span class="plan-status${done ? ' done' : ''}">${status}</span>
    </button>`;
  }).join('');

  root.innerHTML = `
    <h1>Workout</h1>
    <p class="muted">${mins} min · ${sets} set${sets === 1 ? '' : 's'} · ${workoutTotals(active, s)}</p>
    <section class="card">
      <h2>Name</h2>
      <div class="row">
        <input id="workout-name" type="text" placeholder="e.g. Push day"
          value="${esc(active.name ?? '')}">
      </div>
      <p class="muted">Optional — a named workout gets its own start row, so
        two routines on the same machines stay apart.</p>
    </section>
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
    ${allMuscles.length ? `
    <section class="card">
      <h2>Muscles today</h2>
      <div class="chip-select" id="muscle-coverage">
        ${allMuscles.map((m) => `<button type="button" class="chip${trained.has(m)
    ? ' sel done' : ''}" data-muscle="${esc(m)}">${esc(m)}</button>`).join('')}
      </div>
      <p class="muted">Tap an open muscle to find a machine for it below.</p>
    </section>` : ''}
    <section class="card">
      <h2>Add machine</h2>
      <div id="picker"></div>
    </section>
    <button id="finish" class="btn">Finish workout</button>`;

  root.querySelector('#workout-name').addEventListener('change', (e) => {
    active.name = e.target.value.trim();
    saveActive(active);
  });

  root.querySelector('#locker-num').addEventListener('change', (e) => {
    active.locker = e.target.value.trim();
    saveActive(active);
  });

  root.querySelectorAll('.plan-row').forEach((row) => {
    row.addEventListener('click', () => {
      const slot = active.plan[parseInt(row.dataset.i, 10)];
      active.currentMachineId = slot.machineId;
      active.currentExercise = slot.exercise;
      saveActive(active);
      renderTrain(root);
    });
  });

  const picker = machinePicker(root.querySelector('#picker'), gym, (machineId) => {
    if (!active.plan.some((p) => p.machineId === machineId)) {
      active.plan.push({ machineId, exercise: null });
    }
    active.currentMachineId = machineId;
    active.currentExercise = null;
    saveActive(active);
    renderTrain(root);
  });

  root.querySelector('#muscle-coverage')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) picker.setMuscle(chip.dataset.muscle);
  });

  // two-tap guard: finishing only happens once, at the very end
  const finishBtn = root.querySelector('#finish');
  finishBtn.addEventListener('click', () => {
    const armedLabel = sets
      ? 'Tap again to finish & save'
      : 'Tap again to discard (no sets logged)';
    if (!twoTapConfirm(finishBtn, armedLabel, 'Finish workout')) return;
    finish(root, active);
  });
}

// Next unfinished plan slot after the current one, wrapping around so a
// skipped (busy) machine comes up again at the end. Another exercise at
// the SAME station is a valid next stop — only the current slot is out.
function nextOpenSlot(active, afterId, afterExercise = null) {
  const idx = planSlotIndex(active, afterId, afterExercise);
  const order = [...active.plan.slice(idx + 1), ...active.plan.slice(0, Math.max(idx, 0))];
  return order.find((slot) => !slotDone(active, slot)) ?? null;
}

// The plan index the logging screen is at: the exact (machine, exercise)
// slot when one exists, else the machine's first slot (pick pending).
function planSlotIndex(active, machineId, exercise = null) {
  const exact = active.plan.findIndex(
    (p) => p.machineId === machineId && (p.exercise ?? null) === (exercise ?? null));
  return exact !== -1 ? exact
    : active.plan.findIndex((p) => p.machineId === machineId);
}

// The physically closest OTHER station with an open slot — the escape
// hatch when the plan's next machine is busy. The user stands at
// `machine` (its center is the location proxy); the plan-ordered walk
// stays untouched, this is pure display logic with no stored state: a
// skipped slot stays open and resurfaces via nextOpenSlot's wrap-around.
// First open slot per station wins (plan order = exercise order there).
// Exported for the logic tests.
export function nearbyAlternative(active, gym, machine, excludeMachineId = null) {
  const center = (m) => [m.x + m.w / 2, m.y + m.h / 2];
  const [fx, fy] = center(machine);
  const seen = new Set();
  let best = null;
  for (const slot of active.plan) {
    if (slot.machineId === machine.id || slot.machineId === excludeMachineId) continue;
    if (seen.has(slot.machineId) || slotDone(active, slot)) continue;
    seen.add(slot.machineId);
    const m = gym.machines.find((mm) => mm.id === slot.machineId);
    if (!m) continue;
    const [cx, cy] = center(m);
    const d = (cx - fx) ** 2 + (cy - fy) ** 2;
    if (!best || d < best.d) best = { slot, machine: m, d };
  }
  return best;
}

// The plan target that applies at this logging position, if any.
const planTargetFor = (active, machineId, exercise = null) => {
  const idx = planSlotIndex(active, machineId, exercise);
  return idx === -1 ? null : active.plan[idx].target ?? null;
};

// "3 × 10 @ 50 kg" / "3 × 10 @ BW+5 kg" / "1000 m · 10:00"
const targetStr = (t, type, s) => (type === 'cardio'
  ? `${t.distance} ${distUnit(s)} · ${fmtDuration(t.seconds)}`
  : type === 'bodyweight'
    ? `${t.sets} × ${t.reps}${t.weight ? ` @ BW+${t.weight} ${s.unit}` : ''}`
    : `${t.sets} × ${t.reps} @ ${t.weight} ${s.unit}`);

// --- logging screen ---

// Resolves which entry the logging screen edits. At multi-exercise
// stations (free weights) each exercise gets its own entry; until one is
// picked (pickPending) there is no entry and no logging UI. Entries are
// created eagerly so settings edits stick; set-less ones are dropped again
// when the workout is finished. Type flags and the exercise are
// snapshotted like num/label so history stays readable if the machine
// changes. `last` is the previous session's entry for set prefills.
function resolveEntry(machine, active) {
  const exercises = machine.exercises ?? [];
  const exercise = exercises.includes(active.currentExercise) ? active.currentExercise : null;
  const pickPending = exercises.length > 0 && !exercise;
  if (pickPending) return { exercises, exercise, pickPending, entry: null, last: null };

  const last = lastEntryFor(machine.id, exercise);
  let entry = entryFor(active, machine.id, exercise);
  if (!entry) {
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
  return { exercises, exercise, pickPending, entry, last };
}

function renderLog(root, gym, active) {
  const machine = gym.machines.find((m) => m.id === active.currentMachineId);
  if (!machine) { // machine was deleted in the studio mid-workout
    active.currentMachineId = null;
    active.currentExercise = null;
    saveActive(active);
    renderTrain(root);
    return;
  }

  const { exercises, exercise, pickPending, entry, last } = resolveEntry(machine, active);

  const machineSlots = active.plan.filter((p) => p.machineId === machine.id);
  if (!machineSlots.length) { // free sessions grow the plan
    active.plan.push({ machineId: machine.id, exercise: null });
    saveActive(active);
  } else if (exercise && !machineSlots.some((p) => !p.exercise)
    && !machineSlots.some((p) => p.exercise === exercise)) {
    // a fresh exercise at a station whose slots are exercise-scoped gets
    // its own slot (after its siblings) so the overview and "Next:" see
    // it; a whole-station slot already aggregates it otherwise
    const lastIdx = active.plan.findLastIndex((p) => p.machineId === machine.id);
    active.plan.splice(lastIdx + 1, 0, { machineId: machine.id, exercise });
    saveActive(active);
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
  // Plan target for this slot — dropped when its shape no longer matches
  // the machine's type (flag toggled since the plan was made).
  const rawTarget = pickPending ? null : planTargetFor(active, machine.id, exercise);
  const target = rawTarget
    && (cardio ? rawTarget.distance != null : rawTarget.reps != null) ? rawTarget : null;
  const def = pickPending ? null : nextSetDefaults(entry, lastSets, type, s, target);
  const restSeconds = machine.restSeconds ?? s.restSeconds;
  const planPos = `${planSlotIndex(active, machine.id, exercise) + 1}/${active.plan.length}`;
  const nextSlot = nextOpenSlot(active, machine.id, exercise);
  const nextMachine = nextSlot ? gym.machines.find((m) => m.id === nextSlot.machineId) : null;
  // offered only when it differs from the plan's next (excludeMachineId)
  const nearby = nextMachine ? nearbyAlternative(active, gym, machine, nextMachine.id) : null;

  // Quick-switch: the OTHER stations most recently trained this session,
  // ranked by their newest `at`-stamped set. Superset workouts swing
  // between machines constantly — one tap back beats an overview detour,
  // and this stays visible even at the superset end-game where every slot
  // is done and no Next button shows.
  const otherStations = new Map(); // machineId -> { at, exercise }
  active.entries.forEach((e) => {
    if (e.machineId === machine.id) return;
    e.sets.forEach((st) => {
      if (typeof st.at !== 'number') return;
      const cur = otherStations.get(e.machineId);
      if (!cur || st.at > cur.at) otherStations.set(e.machineId, { at: st.at, exercise: e.exercise ?? null });
    });
  });
  const quickSwitch = [...otherStations].map(([machineId, v]) => ({
    machineId, ...v, m: gym.machines.find((mm) => mm.id === machineId),
  })).filter((c) => c.m).sort((a, b) => b.at - a.at).slice(0, 2);

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
        ${target ? `<div class="muted">Target: ${targetStr(target, type, s)}</div>` : ''}
        ${machine.muscles?.length ? `<div class="muted">${machine.muscles.map(esc).join(' · ')}</div>` : ''}
        ${machine.docUrl ? `<a class="doc-link" href="${esc(machine.docUrl)}"
          target="_blank" rel="noopener">Machine docs ↗</a>` : ''}
      </div>
      <button type="button" id="locate-current" class="locate-btn"
        aria-label="Show this machine on the map">📍</button>
    </div>

    ${exercises.length ? `
    <section class="card">
      <h2>Exercise</h2>
      <div class="chip-select" id="exercise-chips">
        ${exercises.map((x) => {
    const done = (entryFor(active, machine.id, x)?.sets.length ?? 0) > 0;
    return `<button type="button" class="chip${x === exercise ? ' sel' : ''}${done ? ' done' : ''}"
          data-exercise="${esc(x)}">${esc(x)}</button>`;
  }).join('')}
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
        ${stepperField(`Distance (${du})`, 'set-distance', { step: s.unit === 'kg' ? 100 : 0.1, min: 0, value: def.distance })}
        ${stepperField('Time (min)', 'set-time', { step: 1, min: 0, value: Math.round((def.seconds / 60) * 100) / 100 })}`
    : type === 'bodyweight' ? `
        ${stepperField('Reps', 'set-reps', { step: 1, min: 1, value: def.reps, mode: 'numeric' })}
        ${stepperField('Extra weight', 'set-weight', { step: s.weightStep, min: 0, value: def.weight })}`
      : `
        ${stepperField('Weight', 'set-weight', { step: s.weightStep, min: 0, value: def.weight })}
        ${stepperField('Reps', 'set-reps', { step: 1, min: 1, value: def.reps, mode: 'numeric' })}`}
        ${stepperField('Rest (s)', 'set-rest', { step: 15, min: 0, value: restSeconds, mode: 'numeric' })}
        <button id="log-set" class="btn btn-primary btn-big">✓ Log set</button>
      </div>
    </section>`}

    ${quickSwitch.length ? `
    <div class="quick-switch">
      ${quickSwitch.map((c) => `<button type="button" class="chip" data-machine="${esc(c.machineId)}">
        ↩ #${c.m.num} ${esc(c.m.label)}</button>`).join('')}
    </div>` : ''}

    ${nextMachine
    ? `<div class="next-row">
        <button id="next-machine" class="btn btn-next btn-big">Next: #${nextMachine.num}
          ${esc(nextMachine.label)}${nextSlot.exercise ? ` · ${esc(nextSlot.exercise)}` : ''} →</button>
        <button type="button" id="locate-next" class="btn btn-next btn-big locate-next"
          aria-label="Show the next machine on the map">📍</button>
      </div>
      ${nearby ? `<button id="nearby-machine" class="btn">Busy? #${nearby.machine.num}
        ${esc(nearby.machine.label)} is nearby →</button>` : ''}
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
      entry.sets.push({ distance, seconds, at: Date.now() });
    } else {
      const weight = Math.max(0, parseFloat(root.querySelector('#set-weight').value) || 0);
      const reps = Math.max(1, Math.round(parseFloat(root.querySelector('#set-reps').value) || 1));
      entry.sets.push({ reps, weight, at: Date.now() });
    }
    saveActive(active);
    renderLog(root, gym, active);
    startRest(rest);
  });

  root.querySelector('.quick-switch')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const c = quickSwitch.find((x) => x.machineId === chip.dataset.machine);
    if (!c) return;
    active.currentMachineId = c.machineId;
    active.currentExercise = c.exercise ?? null;
    saveActive(active);
    renderTrain(root);
  });

  root.querySelector('#locate-current').addEventListener('click',
    () => showMapOverlay(gym, machine));
  root.querySelector('#locate-next')?.addEventListener('click',
    () => showMapOverlay(gym, nextMachine));

  // same move as a Next tap, just to the nearby station instead
  root.querySelector('#nearby-machine')?.addEventListener('click', () => {
    active.currentMachineId = nearby.slot.machineId;
    active.currentExercise = nearby.slot.exercise;
    saveActive(active);
    renderTrain(root);
  });

  root.querySelector('#next-machine')?.addEventListener('click', () => {
    active.currentMachineId = nextSlot.machineId;
    active.currentExercise = nextSlot.exercise;
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
// done this session, then the last set of the previous session. `last` and
// `target` must already be type-matched to the entry (caller gates on the
// flags). A plan target is the goal for THIS session: it beats history as
// the first-set prefill, but never what was actually just lifted — after a
// deviation (50 instead of the planned 55) the prefill follows the real
// working weight.
function nextSetDefaults(entry, last, type, s, target = null) {
  if (target) {
    if (entry.sets.length) return entry.sets[entry.sets.length - 1];
    return type === 'cardio'
      ? { distance: target.distance, seconds: target.seconds }
      : { reps: target.reps, weight: target.weight };
  }
  const i = entry.sets.length;
  if (last?.sets?.[i]) return last.sets[i];
  if (entry.sets.length) return entry.sets[entry.sets.length - 1];
  if (last?.sets?.length) return last.sets[last.sets.length - 1];
  if (type === 'cardio') return { distance: s.unit === 'kg' ? 1000 : 0.5, seconds: 600 };
  if (type === 'bodyweight') return { reps: 10, weight: 0 };
  return { reps: 10, weight: 20 };
}

// Joins ui.js's setStr per set; the weight unit is appended once when any
// weight was actually moved.
const setsSummary = (sets, s, bodyweight = false) => {
  const body = sets.map((st) => setStr(st, s, bodyweight)).join(', ');
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
  // count stations, not entries — a multi-exercise station is one machine
  const stations = new Set(saved.entries.map((e) => e.machineId)).size;
  renderTrain(root, `Workout saved: ${stations} machine${stations === 1 ? '' : 's'}, `
    + `${sets} set${sets === 1 ? '' : 's'}, ${workoutTotals(saved, getSettings())} total.`);
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
  // when the tab is hidden, so re-acquire on return. Guard against the
  // request being in flight (visibilitychange re-entry) and against the
  // overlay closing before the request resolves — an unreleased sentinel
  // would keep the screen awake forever.
  let wakeLock = null;
  let wakeLockPending = false;
  let closed = false;
  const requestWakeLock = async () => {
    if (wakeLock || wakeLockPending) return;
    wakeLockPending = true;
    try {
      const sentinel = await navigator.wakeLock?.request('screen');
      if (!sentinel) return;
      if (closed) { sentinel.release().catch(() => {}); return; }
      wakeLock = sentinel;
      sentinel.addEventListener('release', () => {
        if (wakeLock === sentinel) wakeLock = null;
      });
    } catch { /* unsupported or denied */ } finally {
      wakeLockPending = false;
    }
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  };
  requestWakeLock();
  document.addEventListener('visibilitychange', onVisible);

  const close = () => {
    closed = true;
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
