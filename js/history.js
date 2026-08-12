import {
  getGym, getWorkouts, getSettings, getActive, deleteWorkout, updateWorkout,
} from './store.js';
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
      <h2>Training days</h2>
      <div class="hm-head">
        <button id="hm-prev" class="btn btn-inline" aria-label="previous month">‹</button>
        <strong id="hm-title"></strong>
        <button id="hm-next" class="btn btn-inline" aria-label="next month">›</button>
      </div>
      <select id="hm-machine" aria-label="Heatmap machine filter">
        <option value="">All machines</option>
        ${options.map(([id, m]) => `<option value="${id}">#${m.num} ${esc(m.label)}</option>`).join('')}
      </select>
      <div id="hm-grid" class="hm-grid"></div>
      <div class="hm-legend"><span>less</span>
        <i class="hm-swatch"></i><i class="hm-swatch l1"></i><i class="hm-swatch l2"></i>
        <i class="hm-swatch l3"></i><i class="hm-swatch l4"></i>
      <span>more</span></div>
      <p id="hm-info" class="muted" role="status">Tap a day for details.</p>
    </section>
    <section class="card">
      <h2>Progress — top set weight (${unit})</h2>
      <select id="chart-machine" aria-label="Machine">
        ${options.map(([id, m]) => `<option value="${id}">#${m.num} ${esc(m.label)}</option>`).join('')}
      </select>
      <div class="chart-wrap" id="chart"></div>
    </section>
    <section class="card">
      <h2>Workouts</h2>
      <div id="workout-list"></div>
    </section>`;

  // One card at a time can be in edit mode; the draft is a deep clone so
  // Cancel never touches stored data.
  let editDraft = null;
  const list = root.querySelector('#workout-list');
  const renderList = () => {
    list.innerHTML = workouts.slice().reverse()
      .map((w) => (editDraft?.id === w.id ? editWorkoutHtml(editDraft, unit) : workoutHtml(w, unit)))
      .join('');
  };
  renderList();

  list.addEventListener('click', (e) => {
    const repeat = e.target.closest('.repeat-w');
    if (repeat) {
      if (getActive()) {
        repeat.textContent = 'Finish your current workout first';
        repeat.disabled = true;
        return;
      }
      const workout = workouts.find((w) => w.id === repeat.dataset.wid);
      if (!workout) return;
      startWorkoutFrom(workout);
      location.hash = '#train';
      return;
    }

    const edit = e.target.closest('.edit-w');
    if (edit) {
      const workout = workouts.find((w) => w.id === edit.dataset.wid);
      if (!workout) return;
      editDraft = JSON.parse(JSON.stringify(workout));
      renderList();
      return;
    }
    if (e.target.closest('.edit-cancel')) {
      editDraft = null;
      renderList();
      return;
    }
    const setDel = e.target.closest('.set-del');
    if (setDel && editDraft) {
      editDraft.entries[+setDel.dataset.ei].sets.splice(+setDel.dataset.si, 1);
      renderList();
      return;
    }
    if (e.target.closest('.edit-save') && editDraft) {
      if (!editDraft.locker) delete editDraft.locker;
      updateWorkout(editDraft);
      renderHistory(root); // heatmap/chart/options close over the old snapshot
      return;
    }

    const del = e.target.closest('.delete-w');
    if (del) {
      // Two-tap guard per card: the arm timer lives on the button element
      // because the list holds one delete button per workout.
      if (!del.classList.contains('armed')) {
        del.classList.add('armed');
        del.textContent = 'Tap again to delete';
        clearTimeout(del._armTimer);
        del._armTimer = setTimeout(() => {
          del.classList.remove('armed');
          del.textContent = 'Delete';
        }, 4000);
        return;
      }
      clearTimeout(del._armTimer);
      deleteWorkout(del.dataset.wid);
      renderHistory(root);
    }
  });

  list.addEventListener('change', (e) => {
    if (!editDraft) return;
    const t = e.target;
    if (t.classList.contains('edit-weight')) {
      const v = Math.max(0, parseFloat(t.value) || 0);
      t.value = v;
      editDraft.entries[+t.dataset.ei].sets[+t.dataset.si].weight = v;
    } else if (t.classList.contains('edit-reps')) {
      const v = Math.max(1, Math.round(parseFloat(t.value) || 1));
      t.value = v;
      editDraft.entries[+t.dataset.ei].sets[+t.dataset.si].reps = v;
    } else if (t.classList.contains('edit-locker')) {
      editDraft.locker = t.value.trim();
    }
  });

  // --- training-days heatmap: month × machine ---
  let hmDate = new Date();
  const hmMachine = root.querySelector('#hm-machine');
  const hmGrid = root.querySelector('#hm-grid');
  const hmInfo = root.querySelector('#hm-info');

  const drawHeatmap = () => {
    const y = hmDate.getFullYear();
    const m = hmDate.getMonth();
    root.querySelector('#hm-title').textContent =
      hmDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    // aggregate sets/volume per day of this month, optionally per machine
    const days = new Map();
    workouts.forEach((w) => {
      const d = new Date(w.startedAt);
      if (d.getFullYear() !== y || d.getMonth() !== m) return;
      const entries = hmMachine.value
        ? w.entries.filter((e) => e.machineId === hmMachine.value)
        : w.entries;
      const sets = entries.reduce((n, e) => n + e.sets.length, 0);
      if (!sets) return;
      const volume = entries.reduce(
        (v, e) => v + e.sets.reduce((x, st) => x + st.reps * st.weight, 0), 0);
      const day = days.get(d.getDate()) || { sets: 0, volume: 0, nums: new Set() };
      day.sets += sets;
      day.volume += volume;
      entries.forEach((e) => day.nums.add(e.num));
      days.set(d.getDate(), day);
    });

    const startOffset = (new Date(y, m, 1).getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const now = new Date();
    const isThisMonth = now.getFullYear() === y && now.getMonth() === m;
    const level = (sets) => (sets >= 10 ? 4 : sets >= 6 ? 3 : sets >= 3 ? 2 : sets >= 1 ? 1 : 0);

    hmGrid.innerHTML =
      ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<span class="hm-dow">${d}</span>`).join('')
      + '<span></span>'.repeat(startOffset)
      + Array.from({ length: daysInMonth }, (_, i) => {
        const dayNum = i + 1;
        const info = days.get(dayNum);
        const lvl = level(info?.sets ?? 0);
        return `<button type="button" class="hm-cell${lvl ? ` l${lvl}` : ''}${isThisMonth
          && now.getDate() === dayNum ? ' today' : ''}" data-day="${dayNum}">${dayNum}</button>`;
      }).join('');

    hmInfo.textContent = 'Tap a day for details.';
    hmGrid.querySelectorAll('.hm-cell').forEach((cell) => {
      cell.addEventListener('click', () => {
        const dayNum = parseInt(cell.dataset.day, 10);
        const info = days.get(dayNum);
        const label = new Date(y, m, dayNum)
          .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        hmInfo.textContent = info
          ? `${label} — ${info.sets} set${info.sets === 1 ? '' : 's'} · ${Math.round(info.volume)} ${unit}`
            + ` · ${[...info.nums].sort((a, b) => a - b).map((n) => `#${n}`).join(', ')}`
          : `${label} — no training`;
      });
    });
  };

  root.querySelector('#hm-prev').addEventListener('click', () => {
    hmDate = new Date(hmDate.getFullYear(), hmDate.getMonth() - 1, 1);
    drawHeatmap();
  });
  root.querySelector('#hm-next').addEventListener('click', () => {
    hmDate = new Date(hmDate.getFullYear(), hmDate.getMonth() + 1, 1);
    drawHeatmap();
  });
  hmMachine.addEventListener('change', drawHeatmap);
  drawHeatmap();

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

const setCount = (w) => w.entries.reduce((n, e) => n + e.sets.length, 0);
const volumeOf = (w) => w.entries.reduce(
  (v, e) => v + e.sets.reduce((x, st) => x + st.reps * st.weight, 0), 0);
const minsOf = (w) => Math.max(1, Math.round((w.finishedAt - w.startedAt) / 60000));

function workoutHtml(w, unit) {
  const sets = setCount(w);
  const chain = w.entries.map((e) => `#${e.num}`).join(' → ');
  return `<details class="workout">
    <summary>
      <div class="spread"><strong>${fmtDate(w.startedAt)}</strong>
        <span class="muted">${fmtTime(w.startedAt)} · ${minsOf(w)} min</span></div>
      <div class="muted">${chain}</div>
      <div class="muted">${sets} set${sets === 1 ? '' : 's'} · ${Math.round(volumeOf(w))} ${unit}${w.locker
        ? ` · 🔒 ${esc(w.locker)}` : ''}</div>
    </summary>
    ${w.entries.map((e) => `
      <div class="entry-line">
        <div>#${e.num} ${esc(e.label)}</div>
        <div class="sets">${e.sets.map((s) => `${s.weight}×${s.reps}`).join(', ')}${settingsStr(e)}</div>
      </div>`).join('')}
    <button class="btn repeat-w" data-wid="${w.id}">Repeat this workout</button>
    <div class="row">
      <button class="btn btn-inline edit-w" data-wid="${w.id}">Edit</button>
      <button class="btn btn-inline btn-danger delete-w" data-wid="${w.id}">Delete</button>
    </div>
  </details>`;
}

function editWorkoutHtml(w, unit) {
  const sets = setCount(w);
  return `<details class="workout" open>
    <summary>
      <div class="spread"><strong>${fmtDate(w.startedAt)}</strong>
        <span class="muted">${fmtTime(w.startedAt)} · ${minsOf(w)} min</span></div>
      <div class="muted">Editing — ${sets} set${sets === 1 ? '' : 's'} · ${Math.round(volumeOf(w))} ${unit}</div>
    </summary>
    ${w.entries.map((e, ei) => `
      <div class="entry-line">
        <div>#${e.num} ${esc(e.label)}</div>
        ${e.sets.map((st, si) => `
          <div class="set-row">
            <span>Set ${si + 1}</span>
            <span class="edit-set">
              <input type="number" inputmode="decimal" class="edit-weight" data-ei="${ei}" data-si="${si}"
                value="${st.weight}" aria-label="Weight (${unit})"> ${unit} ×
              <input type="number" inputmode="numeric" class="edit-reps" data-ei="${ei}" data-si="${si}"
                value="${st.reps}" aria-label="Reps">
            </span>
            <button class="x set-del" data-ei="${ei}" data-si="${si}" aria-label="Remove set ${si + 1}">✕</button>
          </div>`).join('') || '<p class="muted">No sets left — removed on save.</p>'}
      </div>`).join('')}
    <label class="field"><span>Locker</span>
      <input type="text" class="edit-locker" value="${esc(w.locker || '')}" placeholder="none"></label>
    <div class="row">
      <button class="btn btn-primary edit-save">Save</button>
      <button class="btn edit-cancel">Cancel</button>
    </div>
  </details>`;
}

function settingsStr(entry) {
  const parts = Object.entries(entry.settings || {})
    .filter(([, v]) => String(v).trim() !== '')
    .map(([k, v]) => `${esc(k)} ${esc(v)}`);
  return parts.length ? ` · ${parts.join(', ')}` : '';
}
