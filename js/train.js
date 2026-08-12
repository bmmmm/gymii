import {
  getGym, saveGym, getSettings, saveSettings, getActive, saveActive, finishWorkout,
  lastEntryFor, getWorkouts, uid, usageByMachine,
} from './store.js';
import { drawGym, usagePayload, findMachineByNum } from './studio.js';
import { esc } from './ui.js';

// Active workout shape:
//   { v: 2, id, startedAt, plan: [machineId…], currentMachineId|null, entries: [] }
// plan is the guided order — prefilled when repeating a workout, growing as
// machines are opened in a free session. currentMachineId null shows the
// workout overview hub instead of a machine's logging screen.

export function renderTrain(root, message = '') {
  const gym = getGym();
  if (!gym || !gym.machines.length) {
    root.innerHTML = `<h1>Train</h1>
      <div class="empty"><div class="big">🏗️</div>
        <p>No machines yet.</p>
        <p><a href="#studio">Build your gym in Studio</a> — add numbered machines, then start training here.</p>
      </div>`;
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
  const plan = source
    ? source.entries.map((e) => e.machineId).filter((id) => gym?.machines.some((m) => m.id === id))
    : [];
  if (firstMachineId && !plan.includes(firstMachineId)) plan.push(firstMachineId);
  saveActive({
    v: 2, id: uid(), startedAt: Date.now(),
    plan,
    currentMachineId: firstMachineId ?? plan[0] ?? null,
    entries: [],
  });
}

const machineChain = (workout) => workout.entries.map((e) => `#${e.num}`).join(' → ');

const workoutVolume = (workout) => workout.entries.reduce(
  (v, e) => v + e.sets.reduce((x, st) => x + st.reps * st.weight, 0), 0);

// --- start screen ---

function renderStart(root, gym, message) {
  const workouts = getWorkouts();
  const last = workouts[workouts.length - 1];
  const unit = getSettings().unit;
  const recent = workouts.slice(-5).reverse();

  root.innerHTML = `
    <h1>Train</h1>
    ${message ? `<p class="notice" role="status">${esc(message)}</p>` : ''}
    ${last ? `<button id="repeat" class="btn btn-primary btn-big">Repeat last workout
      <span class="sub">${new Date(last.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
      · ${machineChain(last)}</span></button>` : ''}
    <section class="card">
      <h2>Free training</h2>
      <div id="picker"></div>
    </section>
    ${recent.length ? `
    <section class="card">
      <h2>Recent workouts</h2>
      ${recent.map((w) => `
        <div class="recent-row">
          <div class="recent-info">
            <strong>${new Date(w.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</strong>
            <span class="muted">${machineChain(w)} · ${Math.round(workoutVolume(w))} ${unit}</span>
          </div>
          <button class="btn btn-inline repeat-w" data-wid="${w.id}">Repeat</button>
        </div>`).join('')}
    </section>` : ''}`;

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
      err.textContent = `No machine #${num} in this gym.`;
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

const entryFor = (active, machineId) => active.entries.find((e) => e.machineId === machineId);
const isDone = (active, machineId) => (entryFor(active, machineId)?.sets.length ?? 0) > 0;

function renderOverview(root, gym, active) {
  const unit = getSettings().unit;
  const sets = active.entries.reduce((n, e) => n + e.sets.length, 0);
  const volume = active.entries.reduce(
    (v, e) => v + e.sets.reduce((x, st) => x + st.reps * st.weight, 0), 0);
  const mins = Math.max(1, Math.round((Date.now() - active.startedAt) / 60000));

  const rows = active.plan.map((id) => {
    const machine = gym.machines.find((m) => m.id === id);
    const entry = entryFor(active, id);
    if (!machine && !entry) return '';
    const num = machine?.num ?? entry.num;
    const label = machine?.label ?? entry.label;
    const done = isDone(active, id);
    return `<button class="plan-row" data-id="${id}" ${machine ? '' : 'disabled'}>
      <span class="machine-badge sm">${num}</span>
      <span class="plan-label">${esc(label)}</span>
      <span class="plan-status${done ? ' done' : ''}">${done
        ? `✓ ${entry.sets.length} set${entry.sets.length === 1 ? '' : 's'}` : 'open'}</span>
    </button>`;
  }).join('');

  root.innerHTML = `
    <h1>Workout</h1>
    <p class="muted">${mins} min · ${sets} set${sets === 1 ? '' : 's'} · ${Math.round(volume)} ${unit}</p>
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
      saveActive(active);
      renderTrain(root);
    });
  });

  machinePicker(root.querySelector('#picker'), gym, (machineId) => {
    if (!active.plan.includes(machineId)) active.plan.push(machineId);
    active.currentMachineId = machineId;
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
    saveActive(active);
    renderTrain(root);
    return;
  }

  if (!active.plan.includes(machine.id)) { // free sessions grow the plan
    active.plan.push(machine.id);
    saveActive(active);
  }

  const last = lastEntryFor(machine.id);
  let entry = entryFor(active, machine.id);
  if (!entry) {
    // created eagerly so settings edits stick; set-less entries are
    // dropped again when the workout is finished
    entry = { machineId: machine.id, num: machine.num, label: machine.label, settings: {}, sets: [] };
    machine.settingsFields.forEach((f) => { entry.settings[f] = last?.settings?.[f] ?? ''; });
    active.entries.push(entry);
    saveActive(active);
  }

  const s = getSettings();
  const def = nextSetDefaults(entry, last);
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
        <div class="muted">${last
          ? `Last: ${setsSummary(last.sets)} ${s.unit}`
          : 'First time on this machine'}</div>
        ${machine.muscles?.length ? `<div class="muted">${machine.muscles.map(esc).join(' · ')}</div>` : ''}
        ${machine.docUrl ? `<a class="doc-link" href="${esc(machine.docUrl)}"
          target="_blank" rel="noopener">Machine docs ↗</a>` : ''}
      </div>
    </div>

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
            <span>${st.weight} ${s.unit} × ${st.reps}</span>
            <button class="x" data-i="${i}" aria-label="Remove set ${i + 1}">✕</button>
          </div>`).join('') || '<p class="muted">No sets logged yet.</p>'}
      </div>
      <div class="next-set">
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
        </div>
        <div class="spread"><span class="label">Rest (s)</span>
          <div class="stepper" data-step="15" data-min="0">
            <button type="button" class="step-down" aria-label="decrease rest">−</button>
            <input id="set-rest" type="number" inputmode="numeric" value="${restSeconds}">
            <button type="button" class="step-up" aria-label="increase rest">+</button>
          </div>
        </div>
        <button id="log-set" class="btn btn-primary btn-big">✓ Log set</button>
      </div>
    </section>

    ${nextMachine
    ? `<button id="next-machine" class="btn btn-next btn-big">Next: #${nextMachine.num}
        ${esc(nextMachine.label)} →</button>
      <button id="change-machine" class="btn">Change machine / overview</button>`
    : '<button id="change-machine" class="btn btn-next btn-big">Workout overview →</button>'}
  `;

  root.querySelectorAll('.m-setting').forEach((inp) => {
    inp.addEventListener('change', () => {
      entry.settings[inp.dataset.field] = inp.value.trim();
      saveActive(active);
    });
  });

  root.querySelector('#sets-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.x');
    if (!btn) return;
    entry.sets.splice(parseInt(btn.dataset.i, 10), 1);
    saveActive(active);
    renderLog(root, gym, active);
  });

  // per-machine rest override, remembered on the machine itself
  root.querySelector('#set-rest').addEventListener('change', (e) => {
    const v = Math.max(0, Math.round(parseFloat(e.target.value) || 0));
    e.target.value = v;
    machine.restSeconds = v;
    saveGym(gym);
  });

  root.querySelector('#log-set').addEventListener('click', () => {
    const weight = Math.max(0, parseFloat(root.querySelector('#set-weight').value) || 0);
    const reps = Math.max(1, Math.round(parseFloat(root.querySelector('#set-reps').value) || 1));
    const rest = Math.max(0, Math.round(parseFloat(root.querySelector('#set-rest').value) || 0));
    entry.sets.push({ reps, weight });
    saveActive(active);
    renderLog(root, gym, active);
    startRest(rest);
  });

  root.querySelector('#next-machine')?.addEventListener('click', () => {
    active.currentMachineId = nextId;
    saveActive(active);
    renderTrain(root);
  });

  root.querySelector('#change-machine').addEventListener('click', () => {
    active.currentMachineId = null;
    saveActive(active);
    renderTrain(root);
  });
}

// Default for the next set: same set number last time, then the set just
// done this session, then the last set of the previous session.
function nextSetDefaults(entry, last) {
  const i = entry.sets.length;
  if (last?.sets?.[i]) return last.sets[i];
  if (entry.sets.length) return entry.sets[entry.sets.length - 1];
  if (last?.sets?.length) return last.sets[last.sets.length - 1];
  return { reps: 10, weight: 20 };
}

const setsSummary = (sets) => sets.map((s) => `${s.weight}×${s.reps}`).join(', ');

function finish(root, active) {
  const saved = finishWorkout(active);
  if (!saved) {
    renderTrain(root, 'Workout discarded — no sets were logged.');
    return;
  }
  const sets = saved.entries.reduce((n, e) => n + e.sets.length, 0);
  renderTrain(root, `Workout saved: ${saved.entries.length} machine${saved.entries.length === 1 ? '' : 's'}, `
    + `${sets} sets, ${Math.round(workoutVolume(saved))} ${getSettings().unit} total volume.`);
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
  const fmt = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

  const close = () => {
    clearInterval(interval);
    overlay.remove();
  };
  const tick = () => {
    const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    cd.textContent = fmt(rem);
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
