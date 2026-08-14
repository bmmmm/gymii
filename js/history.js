import {
  getGym, getWorkouts, getSettings, getActive, deleteWorkout, updateWorkout, distUnit,
} from './store.js';
import { esc, fmtDate, fmtTime, workoutTotals, setStr, twoTapConfirm } from './ui.js';
import { lineChart } from './chart.js';
import { startWorkoutFrom } from './train.js';

// Active workout-name filter ('' = all). Module state, so it survives the
// full re-render that a save or a delete triggers.
let nameFilter = '';

export function renderHistory(root) {
  const all = getWorkouts();
  // names in use, most-trained first — a name is only a way back in if
  // you can actually filter by it
  const nameCounts = new Map();
  all.forEach((w) => {
    if (w.name) nameCounts.set(w.name, (nameCounts.get(w.name) || 0) + 1);
  });
  if (nameFilter && !nameCounts.has(nameFilter)) nameFilter = ''; // last one renamed/deleted
  const named = [...nameCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // everything below reads `workouts` — filtering here filters the
  // heatmap, the chart, the machine lists and the workout list at once
  const workouts = nameFilter ? all.filter((w) => w.name === nameFilter) : all;
  if (!all.length) {
    root.innerHTML = `<h1>History</h1>
      <div class="empty"><div class="big">📈</div>
        <p>No workouts yet.</p>
        <p>Finish your first <a href="#train">workout</a> and it shows up here.</p>
      </div>`;
    return;
  }

  const s = getSettings();
  const unit = s.unit;
  const gym = getGym();

  // Stations — and, at multi-exercise stations, each exercise — seen in
  // history, labeled with their current gym name when still present.
  // Keyed "machineId exercise": uid()s never contain spaces, so decoding
  // splits on the FIRST space only (exercise names may contain more).
  const machines = new Map();
  workouts.forEach((w) => w.entries.forEach((e) => {
    machines.set(`${e.machineId} ${e.exercise ?? ''}`,
      { machineId: e.machineId, exercise: e.exercise ?? null, num: e.num, label: e.label });
  }));
  gym?.machines.forEach((m) => {
    machines.forEach((val, key) => {
      if (val.machineId === m.id) machines.set(key, { ...val, num: m.num, label: m.label });
    });
  });
  const options = [...machines.entries()].sort((a, b) =>
    a[1].num - b[1].num || (a[1].exercise ?? '').localeCompare(b[1].exercise ?? ''));
  const optionHtml = ([key, m]) => `<option value="${esc(key)}">#${m.num} ${esc(m.label)}${
    m.exercise ? ` · ${esc(m.exercise)}` : ''}</option>`;
  const decodeKey = (value) => {
    if (!value) return null; // '' = the heatmap's "All machines"
    const i = value.indexOf(' ');
    if (i === -1) return { machineId: value, exercise: null }; // defensive: bare id
    return { machineId: value.slice(0, i), exercise: value.slice(i + 1) || null };
  };
  const entryMatches = (e, sel) =>
    e.machineId === sel.machineId && (e.exercise ?? null) === sel.exercise;

  root.innerHTML = `
    <h1>History</h1>
    ${named.length ? `
    <div class="chip-select" id="name-filter">
      <button type="button" class="chip${nameFilter ? '' : ' sel'}" data-name="">All</button>
      ${named.map(([n, c]) => `<button type="button" class="chip${nameFilter === n ? ' sel' : ''}"
        data-name="${esc(n)}">${esc(n)} <span class="muted">· ${c}</span></button>`).join('')}
    </div>` : ''}
    <section class="card">
      <h2>Training days</h2>
      <div class="hm-head">
        <button id="hm-prev" class="btn btn-inline" aria-label="previous month">‹</button>
        <strong id="hm-title"></strong>
        <button id="hm-next" class="btn btn-inline" aria-label="next month">›</button>
      </div>
      <select id="hm-machine" aria-label="Heatmap machine filter">
        <option value="">All machines</option>
        ${options.map(optionHtml).join('')}
      </select>
      <div id="hm-grid" class="hm-grid"></div>
      <div class="hm-legend"><span>less</span>
        <i class="hm-swatch"></i><i class="hm-swatch l1"></i><i class="hm-swatch l2"></i>
        <i class="hm-swatch l3"></i><i class="hm-swatch l4"></i>
      <span>more</span></div>
      <p id="hm-info" class="muted" role="status">Tap a day for details.</p>
    </section>
    <section class="card">
      <h2 id="chart-title">Progress</h2>
      <select id="chart-machine" aria-label="Machine">
        ${options.map(optionHtml).join('')}
      </select>
      <div class="chart-wrap" id="chart"></div>
    </section>
    <section class="card">
      <h2>Workouts${nameFilter ? ` — ${esc(nameFilter)}` : ''}</h2>
      <div id="workout-list"></div>
    </section>`;

  root.querySelector('#name-filter')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    nameFilter = chip.dataset.name;
    renderHistory(root);
  });

  // One card at a time can be in edit mode; the draft is a deep clone so
  // Cancel never touches stored data.
  let editDraft = null;
  const list = root.querySelector('#workout-list');
  const renderList = () => {
    list.innerHTML = workouts.slice().reverse()
      .map((w) => (editDraft?.id === w.id ? editWorkoutHtml(editDraft, s) : workoutHtml(w, s)))
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
      if (!editDraft.name) delete editDraft.name;
      updateWorkout(editDraft);
      renderHistory(root); // heatmap/chart/options close over the old snapshot
      return;
    }

    const del = e.target.closest('.delete-w');
    if (del) {
      // works per card: the arm timer lives on each button element
      if (!twoTapConfirm(del, 'Tap again to delete', 'Delete')) return;
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
    } else if (t.classList.contains('edit-distance')) {
      const v = Math.max(0, parseFloat(t.value) || 0);
      t.value = v;
      editDraft.entries[+t.dataset.ei].sets[+t.dataset.si].distance = v;
    } else if (t.classList.contains('edit-minutes')) {
      const v = Math.max(0, parseFloat(t.value) || 0);
      t.value = v;
      editDraft.entries[+t.dataset.ei].sets[+t.dataset.si].seconds = Math.round(v * 60);
    } else if (t.classList.contains('edit-locker')) {
      editDraft.locker = t.value.trim();
    } else if (t.classList.contains('edit-name')) {
      editDraft.name = t.value.trim();
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
      const sel = decodeKey(hmMachine.value);
      const entries = sel ? w.entries.filter((e) => entryMatches(e, sel)) : w.entries;
      const sets = entries.reduce((n, e) => n + e.sets.length, 0);
      if (!sets) return;
      const volume = entries.reduce(
        (v, e) => v + e.sets.reduce((x, st) => x + (st.reps * st.weight || 0), 0), 0);
      const dist = entries.reduce(
        (v, e) => v + e.sets.reduce((x, st) => x + (st.distance || 0), 0), 0);
      const day = days.get(d.getDate()) || { sets: 0, volume: 0, dist: 0, nums: new Set() };
      day.sets += sets;
      day.volume += volume;
      day.dist += dist;
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
          ? [`${label} — ${info.sets} set${info.sets === 1 ? '' : 's'}`,
            info.volume ? `${Math.round(info.volume)} ${unit}` : '',
            info.dist ? `${Math.round(info.dist * 100) / 100} ${distUnit(s)}` : '',
            [...info.nums].sort((a, b) => a - b).map((n) => `#${n}`).join(', ')]
            .filter(Boolean).join(' · ')
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
  const chartTitle = root.querySelector('#chart-title');
  const draw = () => {
    const sel = decodeKey(select.value);
    if (!sel) {
      chartEl.innerHTML = '<p class="muted">No data yet.</p>';
      return;
    }
    const relevant = workouts
      .map((w) => ({ w, e: w.entries.find((e) => entryMatches(e, sel) && e.sets.length) }))
      .filter((x) => x.e);
    // A machine's type can be toggled over time; plot the metric of its
    // most recent entry and skip entries of any other shape.
    const latest = relevant[relevant.length - 1]?.e;
    const cardio = !!latest?.cardio;
    const bodyweight = !!latest?.bodyweight;
    const series = relevant.filter(({ e }) => !!e.cardio === cardio && !!e.bodyweight === bodyweight);
    // Bodyweight progress lives in reps until extra weight shows up.
    const bwLoaded = bodyweight && series.some(({ e }) => e.sets.some((st) => st.weight > 0));
    const points = series.map(({ w, e }) => ({
      t: w.startedAt,
      v: cardio ? Math.max(...e.sets.map((st) => st.distance || 0))
        : bodyweight && !bwLoaded ? Math.max(...e.sets.map((st) => st.reps || 0))
          : Math.max(...e.sets.map((st) => st.weight || 0)),
    }));
    const metric = cardio ? `top distance (${distUnit(s)})`
      : bodyweight ? (bwLoaded ? `top added weight (${unit})` : 'top reps')
        : `top set weight (${unit})`;
    chartTitle.textContent = `Progress — ${metric}`;
    lineChart(chartEl, points, {
      unit: cardio ? distUnit(s) : bodyweight && !bwLoaded ? 'reps' : unit,
      label: `Progress: ${metric} over time`,
    });
  };
  select.addEventListener('change', draw);
  draw();
}

const setCount = (w) => w.entries.reduce((n, e) => n + e.sets.length, 0);
const minsOf = (w) => // finishedAt can be absent in imported data
  Math.max(1, Math.round(((w.finishedAt ?? w.startedAt) - w.startedAt) / 60000));

const entryTitle = (e) => `#${e.num} ${esc(e.label)}${e.exercise ? ` · ${esc(e.exercise)}` : ''}`;

function workoutHtml(w, s) {
  const sets = setCount(w);
  const chain = w.entries.map((e) => `#${e.num}`).join(' → ');
  return `<details class="workout">
    <summary>
      <div class="spread"><strong>${fmtDate(w.startedAt)}</strong>
        <span class="muted">${fmtTime(w.startedAt)} · ${minsOf(w)} min</span></div>
      <div class="muted">${w.name ? `<strong>${esc(w.name)}</strong> · ` : ''}${chain}</div>
      <div class="muted">${sets} set${sets === 1 ? '' : 's'} · ${workoutTotals(w, s)}${w.locker
        ? ` · 🔒 ${esc(w.locker)}` : ''}</div>
    </summary>
    ${w.entries.map((e) => `
      <div class="entry-line">
        <div>${entryTitle(e)}</div>
        <div class="sets">${e.sets.map((st) => setStr(st, s, !!e.bodyweight)).join(', ')}${settingsStr(e)}</div>
      </div>`).join('')}
    <button class="btn repeat-w" data-wid="${w.id}">Repeat this workout</button>
    <div class="row">
      <button class="btn btn-inline edit-w" data-wid="${w.id}">Edit</button>
      <button class="btn btn-inline btn-danger delete-w" data-wid="${w.id}">Delete</button>
    </div>
  </details>`;
}

function editWorkoutHtml(w, s) {
  const sets = setCount(w);
  const du = distUnit(s);
  return `<details class="workout" open>
    <summary>
      <div class="spread"><strong>${fmtDate(w.startedAt)}</strong>
        <span class="muted">${fmtTime(w.startedAt)} · ${minsOf(w)} min</span></div>
      <div class="muted">Editing — ${sets} set${sets === 1 ? '' : 's'} · ${workoutTotals(w, s)}</div>
    </summary>
    ${w.entries.map((e, ei) => `
      <div class="entry-line">
        <div>${entryTitle(e)}</div>
        ${e.sets.map((st, si) => `
          <div class="set-row">
            <span>Set ${si + 1}</span>
            <span class="edit-set">${e.cardio ? `
              <input type="number" inputmode="decimal" class="edit-distance" data-ei="${ei}" data-si="${si}"
                value="${st.distance}" aria-label="Distance (${du})"> ${du} ·
              <input type="number" inputmode="decimal" class="edit-minutes" data-ei="${ei}" data-si="${si}"
                value="${Math.round((st.seconds / 60) * 100) / 100}" aria-label="Time (minutes)"> min` : `
              ${e.bodyweight ? 'BW+' : ''}<input type="number" inputmode="decimal" class="edit-weight"
                data-ei="${ei}" data-si="${si}" value="${st.weight}"
                aria-label="${e.bodyweight ? 'Extra weight' : 'Weight'} (${s.unit})"> ${s.unit} ×
              <input type="number" inputmode="numeric" class="edit-reps" data-ei="${ei}" data-si="${si}"
                value="${st.reps}" aria-label="Reps">`}
            </span>
            <button class="x set-del" data-ei="${ei}" data-si="${si}" aria-label="Remove set ${si + 1}">✕</button>
          </div>`).join('') || '<p class="muted">No sets left — removed on save.</p>'}
      </div>`).join('')}
    <label class="field"><span>Name</span>
      <input type="text" class="edit-name" value="${esc(w.name || '')}" placeholder="none"></label>
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
