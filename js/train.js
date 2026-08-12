import {
  getGym, getSettings, getActive, saveActive, finishWorkout,
  lastEntryFor, getWorkouts, uid,
} from './store.js';
import { drawGym, findMachineByNum } from './studio.js';
import { esc } from './ui.js';

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
    if (active.currentMachineId) renderLog(root, gym, active);
    else renderPicker(root, gym, active);
  } else {
    renderStart(root, gym, message);
  }
}

// --- start screen ---

function renderStart(root, gym, message) {
  const workouts = getWorkouts();
  const last = workouts[workouts.length - 1];
  const lastInfo = last
    ? `${last.entries.length} machine${last.entries.length === 1 ? '' : 's'} · ${new Date(last.startedAt)
        .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
    : '';

  root.innerHTML = `
    <h1>Train</h1>
    ${message ? `<p class="notice" role="status">${esc(message)}</p>` : ''}
    ${last ? `<button id="repeat" class="btn btn-primary btn-big">Repeat last workout
      <span class="sub">${lastInfo}</span></button>` : ''}
    <section class="card">
      <h2>Free training</h2>
      <div id="picker"></div>
    </section>`;

  root.querySelector('#repeat')?.addEventListener('click', () => {
    const queue = last.entries
      .map((e) => e.machineId)
      .filter((id) => gym.machines.some((m) => m.id === id));
    saveActive({
      v: 1, id: uid(), startedAt: Date.now(),
      mode: queue.length ? 'repeat' : 'free',
      queue: queue.length ? queue : null,
      queueIndex: 0,
      currentMachineId: queue[0] ?? null,
      entries: [],
    });
    renderTrain(root);
  });

  machinePicker(root.querySelector('#picker'), gym, (machineId) => {
    saveActive({
      v: 1, id: uid(), startedAt: Date.now(),
      mode: 'free', queue: null, queueIndex: 0,
      currentMachineId: machineId, entries: [],
    });
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
    <p class="pick-err muted">Enter a machine number or tap one on the map.</p>`;

  const svg = container.querySelector('svg');
  drawGym(svg, gym);
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
  muscleSelect?.addEventListener('change', () => {
    const muscle = muscleSelect.value;
    const matching = muscle
      ? gym.machines.filter((m) => (m.muscles || []).includes(muscle))
      : [];
    const matchIds = new Set(matching.map((m) => m.id));
    svg.querySelectorAll('.machine').forEach((g) => {
      g.style.opacity = !muscle || matchIds.has(g.dataset.id) ? '' : '0.22';
    });
    chips.innerHTML = matching
      .sort((a, b) => a.num - b.num)
      .map((m) => `<button class="chip" data-id="${m.id}">#${m.num} ${esc(m.label)}</button>`)
      .join('');
  });
  chips?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) onPick(chip.dataset.id);
  });
}

// --- mid-workout machine picker ---

function renderPicker(root, gym, active) {
  const done = active.entries.filter((e) => e.sets.length);
  root.innerHTML = `
    <h1>Next machine</h1>
    <p class="muted">${done.length
      ? `${done.length} machine${done.length === 1 ? '' : 's'} done so far.`
      : 'Pick your first machine.'}</p>
    <section class="card"><div id="picker"></div></section>
    <button id="finish" class="btn ${done.length ? 'btn-primary btn-big' : ''}">Finish workout</button>`;

  machinePicker(root.querySelector('#picker'), gym, (machineId) => {
    active.currentMachineId = machineId;
    saveActive(active);
    renderTrain(root);
  });
  root.querySelector('#finish').addEventListener('click', () => finish(root, active));
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

  const last = lastEntryFor(machine.id);
  let entry = active.entries.find((e) => e.machineId === machine.id);
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
  const queuePos = active.mode === 'repeat' && active.queue
    ? ` <span class="muted">${active.queueIndex + 1}/${active.queue.length}</span>` : '';
  const hasNextInQueue = active.mode === 'repeat' && active.queue
    && active.queueIndex < active.queue.length - 1;

  root.innerHTML = `
    <div class="machine-head">
      <span class="machine-badge">${machine.num}</span>
      <div>
        <div class="title">${esc(machine.label)}${queuePos}</div>
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
        <button id="log-set" class="btn btn-primary btn-big">✓ Log set</button>
      </div>
    </section>

    <button id="done-machine" class="btn">${hasNextInQueue ? 'Next machine →' : 'Choose next machine'}</button>
    <button id="finish" class="btn">Finish workout</button>
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

  root.querySelector('#log-set').addEventListener('click', () => {
    const weight = Math.max(0, parseFloat(root.querySelector('#set-weight').value) || 0);
    const reps = Math.max(1, Math.round(parseFloat(root.querySelector('#set-reps').value) || 1));
    entry.sets.push({ reps, weight });
    saveActive(active);
    renderLog(root, gym, active);
    startRest();
  });

  root.querySelector('#done-machine').addEventListener('click', () => {
    if (hasNextInQueue) {
      active.queueIndex += 1;
      active.currentMachineId = active.queue[active.queueIndex];
    } else {
      active.currentMachineId = null;
    }
    saveActive(active);
    renderTrain(root);
  });

  root.querySelector('#finish').addEventListener('click', () => finish(root, active));
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
  const volume = saved.entries.reduce(
    (v, e) => v + e.sets.reduce((x, st) => x + st.reps * st.weight, 0), 0);
  renderTrain(root, `Workout saved: ${saved.entries.length} machine${saved.entries.length === 1 ? '' : 's'}, `
    + `${sets} sets, ${Math.round(volume)} ${getSettings().unit} total volume.`);
}

// --- rest timer ---

function startRest() {
  const secs = getSettings().restSeconds;
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
