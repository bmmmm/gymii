import { getGym, getWorkouts, getSettings, getActive } from './store.js';
import { esc, fmtDate, fmtTime } from './ui.js';
import { lineChart } from './chart.js';
import { startWorkoutFrom } from './train.js';

export function renderHistory(root) {
  const workouts = getWorkouts();
  if (!workouts.length) {
    root.innerHTML = `<h1>History</h1>
      <div class="empty"><div class="big">📈</div>
        <p>No workouts yet.</p>
        <p>Finish your first <a href="#train">workout</a> and it shows up here.</p>
      </div>`;
    return;
  }

  const unit = getSettings().unit;
  const gym = getGym();

  // Machines seen in history, labeled with their current gym name when
  // still present, otherwise the name recorded at workout time.
  const machines = new Map();
  workouts.forEach((w) => w.entries.forEach((e) => {
    machines.set(e.machineId, { num: e.num, label: e.label });
  }));
  gym?.machines.forEach((m) => {
    if (machines.has(m.id)) machines.set(m.id, { num: m.num, label: m.label });
  });
  const options = [...machines.entries()].sort((a, b) => a[1].num - b[1].num);

  root.innerHTML = `
    <h1>History</h1>
    <section class="card">
      <h2>Progress — top set weight (${unit})</h2>
      <select id="chart-machine" aria-label="Machine">
        ${options.map(([id, m]) => `<option value="${id}">#${m.num} ${esc(m.label)}</option>`).join('')}
      </select>
      <div class="chart-wrap" id="chart"></div>
    </section>
    <section class="card">
      <h2>Workouts</h2>
      <div id="workout-list">
        ${workouts.slice().reverse().map((w) => workoutHtml(w, unit)).join('')}
      </div>
    </section>`;

  root.querySelector('#workout-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.repeat-w');
    if (!btn) return;
    if (getActive()) {
      btn.textContent = 'Finish your current workout first';
      btn.disabled = true;
      return;
    }
    const workout = workouts.find((w) => w.id === btn.dataset.wid);
    if (!workout) return;
    startWorkoutFrom(workout);
    location.hash = '#train';
  });

  const select = root.querySelector('#chart-machine');
  const chartEl = root.querySelector('#chart');
  const draw = () => {
    const id = select.value;
    const points = workouts
      .filter((w) => w.entries.some((e) => e.machineId === id && e.sets.length))
      .map((w) => ({
        t: w.startedAt,
        v: Math.max(...w.entries.find((e) => e.machineId === id).sets.map((s) => s.weight)),
      }));
    lineChart(chartEl, points, { unit });
  };
  select.addEventListener('change', draw);
  draw();
}

function workoutHtml(w, unit) {
  const sets = w.entries.reduce((n, e) => n + e.sets.length, 0);
  const volume = w.entries.reduce(
    (v, e) => v + e.sets.reduce((x, st) => x + st.reps * st.weight, 0), 0);
  const mins = Math.max(1, Math.round((w.finishedAt - w.startedAt) / 60000));
  const chain = w.entries.map((e) => `#${e.num}`).join(' → ');
  return `<details class="workout">
    <summary>
      <div class="spread"><strong>${fmtDate(w.startedAt)}</strong>
        <span class="muted">${fmtTime(w.startedAt)} · ${mins} min</span></div>
      <div class="muted">${chain}</div>
      <div class="muted">${sets} sets · ${Math.round(volume)} ${unit}</div>
    </summary>
    ${w.entries.map((e) => `
      <div class="entry-line">
        <div>#${e.num} ${esc(e.label)}</div>
        <div class="sets">${e.sets.map((s) => `${s.weight}×${s.reps}`).join(', ')}${settingsStr(e)}</div>
      </div>`).join('')}
    <button class="btn repeat-w" data-wid="${w.id}">Repeat this workout</button>
  </details>`;
}

function settingsStr(entry) {
  const parts = Object.entries(entry.settings || {})
    .filter(([, v]) => String(v).trim() !== '')
    .map(([k, v]) => `${esc(k)} ${esc(v)}`);
  return parts.length ? ` · ${parts.join(', ')}` : '';
}
