import {
  getLayout, getWorkouts, saveWorkouts, getSettings, saveSettings, getActive, deleteWorkout,
  updateWorkout, distUnit, workoutFromText, newEntry, nameChipsFor,
  layoutMuscles, usageByMuscle, workoutsWithMuscle, shiftWorkout,
} from './store.js';
import {
  esc, fmtDate, fmtDay, fmtTime, workoutTotals, setStr, twoTapConfirm, plural,
  dateValue, timeValue, machineChain, keepInView, minsBetween, fmtDuration,
  parseDuration, parseDistance,
} from './ui.js';
import { lineChart } from './chart.js';
import { machineSeries } from './stats.js';
import { startWorkoutFrom } from './train.js';

// Active workout-name filter ('' = all). Module state, so it survives the
// full re-render that a save or a delete triggers.
let nameFilter = '';
// Active muscle-group filter ('' = all), same lifecycle as nameFilter.
let muscleFilter = '';
// Set when a workout should come back up in edit mode after the re-render.
let openEditId = null;

// Which History screen is on show: 'overview' (the cards that analyse) or
// 'workouts' (heatmap, the full list + editor, back-logging). Module state
// like train.js's `screen` — no hash sub-route, the tab stays #history.
let screen = 'overview';
let lastScreen = null;
// The heatmap's month as a Date on the 1st (null = this month). Module
// state, so the full re-render after a save no longer snaps it back.
let hmMonth = null;
// Progress card: the picked machine as its 'machineId exercise' key (null =
// the most recently trained) and the picked point's time (null = the
// newest; cleared when the machine changes). Module state, like the
// filters, so a save does not throw the chart back to another machine.
let pickedMachine = null;
let pickedT = null;
// "+N more" on the machine chips was opened.
let machinesExpanded = false;
// The workout "Open workout ›" asked for: the Workouts screen opens it and
// scrolls it into view, once.
let focusWorkoutId = null;

// `entry` = arriving from the tab bar (app.js). It is the ONE thing that
// resets "where in time" — the screen, the heatmap month, the chart's
// point (and the chip list's expansion); the filters, the picked machine
// and the range survive it. Every other re-render (save, delete, filter)
// calls renderHistory(root) without it, so nothing the user set moves.
export function renderHistory(root, { entry = false } = {}) {
  if (entry) {
    screen = 'overview';
    hmMonth = null;
    pickedT = null;
    focusWorkoutId = null;
    machinesExpanded = false;
  }
  // train.js's rule: a changed screen is NAVIGATION and starts at the top;
  // reset BEFORE the render, while the old (tall) content can still
  // scroll. An unchanged screen is an in-place update — its scroll
  // position belongs to the user.
  if (screen !== lastScreen && root.scrollTop) root.scrollTop = 0;
  lastScreen = screen;

  const ctx = historyContext();
  // Nothing logged yet still gets the past-workout form: someone moving
  // over from paper starts by typing in the weeks they already trained.
  if (!ctx.all.length) {
    root.innerHTML = `<h1>History</h1>
      <div class="empty"><div class="big">📈</div>
        <p>No workouts yet.</p>
        <p>Finish your first <a href="#train">workout</a> and it shows up here.</p>
      </div>
      ${pastCardHtml()}`;
    wirePastLog(root, ctx.s);
    return;
  }
  if (screen === 'workouts') renderWorkoutsScreen(root, ctx);
  else renderOverview(root, ctx);
}

// Everything both screens read, computed once per render.
function historyContext() {
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
  // heatmap, the chart, the machine lists and the workout list at once.
  // Two filters compose: name first, then muscle. The Muscles card reads
  // the name-only list so a muscle tap can always reach every other muscle.
  const byName = nameFilter ? all.filter((w) => w.name === nameFilter) : all;
  const s = getSettings();
  const layout = getLayout();
  // muscles resolve against the LIVE layout — a deleted machine or a gym
  // switch can strand the filter, so it clears itself like nameFilter does
  const allMuscles = layout ? layoutMuscles(layout) : [];
  if (muscleFilter && !allMuscles.includes(muscleFilter)) muscleFilter = '';
  const workouts = muscleFilter ? workoutsWithMuscle(byName, layout, muscleFilter) : byName;

  // Machines — and, at multi-exercise machines, each exercise — seen in
  // history, labeled with their current name in the layout when still present.
  // Keyed "machineId exercise": uid()s never contain spaces, so decoding
  // splits on the FIRST space only (exercise names may contain more).
  const machines = new Map();
  workouts.forEach((w) => w.entries.forEach((e) => {
    const key = `${e.machineId} ${e.exercise ?? ''}`;
    machines.set(key, {
      machineId: e.machineId, exercise: e.exercise ?? null, num: e.num, label: e.label,
      last: Math.max(machines.get(key)?.last ?? -Infinity, w.startedAt),
    });
  }));
  layout?.machines.forEach((m) => {
    machines.forEach((val, key) => {
      if (val.machineId === m.id) machines.set(key, { ...val, num: m.num, label: m.label });
    });
  });
  const byNum = (a, b) =>
    a[1].num - b[1].num || (a[1].exercise ?? '').localeCompare(b[1].exercise ?? '');
  const options = [...machines.entries()].sort(byNum); // the heatmap's <select>
  // the Progress chips: most recently trained first
  const recent = [...machines.entries()].sort((a, b) => b[1].last - a[1].last || byNum(a, b));
  return { all, named, byName, workouts, s, unit: s.unit, layout, allMuscles, options, recent };
}

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

// The overview: a sequence of cards, rendered in this order. Each is
// { html(ctx) -> markup, wire(root, ctx) }; a new card is one entry here.
const overviewCards = () => [progressCard, muscleCard, workoutsLink];

function renderOverview(root, ctx) {
  const cards = overviewCards();
  root.innerHTML = `
    <h1>History</h1>
    ${nameChipsHtml(ctx.named)}
    ${cards.map((c) => c.html(ctx)).join('')}`;
  wireNameFilter(root);
  cards.forEach((c) => c.wire(root, ctx));
}

// The drill-down: what you did, day by day and workout by workout, plus the
// form that adds one after the fact.
function renderWorkoutsScreen(root, ctx) {
  root.innerHTML = `
    <button type="button" id="hist-back" class="back-row">‹ History</button>
    <h1>Workouts</h1>
    ${nameChipsHtml(ctx.named)}
    ${heatmapCardHtml(ctx)}
    <section class="card">
      <h2>Workouts${nameFilter ? ` — ${esc(nameFilter)}` : ''}${
        muscleFilter ? ` — ${esc(muscleFilter)}` : ''}</h2>
      <div id="workout-list"></div>
    </section>
    ${pastCardHtml()}`;
  root.querySelector('#hist-back').addEventListener('click', () => {
    screen = 'overview';
    renderHistory(root);
  });
  wireNameFilter(root);
  wirePastLog(root, ctx.s);
  wireWorkoutList(root, root.querySelector('#workout-list'), ctx.workouts, ctx.s, ctx.layout);
  wireHeatmap(root, ctx);
}

// Workout-name chips, on both screens: the filter narrows everything.
const nameChipsHtml = (named) => (named.length ? `
    <div class="chip-select" id="name-filter">
      <button type="button" class="chip${nameFilter ? '' : ' sel'}" data-name="">All</button>
      ${named.map(([n, c]) => `<button type="button" class="chip${nameFilter === n ? ' sel' : ''}"
        data-name="${esc(n)}">${esc(n)} <span class="muted">· ${c}</span></button>`).join('')}
    </div>` : '');

function wireNameFilter(root) {
  root.querySelector('#name-filter')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    nameFilter = chip.dataset.name;
    renderHistory(root);
  });
}

// Usage per muscle group over the name-filtered list — every row is also
// the filter for that muscle. Computing over `byName` (not `workouts`) is
// what keeps other muscles reachable while one is selected.
const muscleCard = {
  html({ allMuscles, byName, layout }) {
    if (!allMuscles.length) return '';
    const usage = usageByMuscle(byName, layout);
    const rows = allMuscles
      .map((mu) => ({ mu, ...(usage.get(mu) ?? { sets: 0, workouts: 0 }) }))
      .sort((a, b) => b.sets - a.sets || a.mu.localeCompare(b.mu));
    const max = rows[0]?.sets || 1;
    // sets whose machine is gone or untagged — count them, or the card
    // silently disagrees with the workout list's totals
    const tagged = new Set(layout.machines.filter((m) => m.muscles?.length).map((m) => m.id));
    const lost = byName.reduce((n, w) => n + w.entries.reduce(
      (k, e) => k + (tagged.has(e.machineId) ? 0 : e.sets.length), 0), 0);
    return `
    <section class="card">
      <h2>Muscles</h2>
      <div id="muscle-list">
        ${muscleFilter ? `<button type="button" class="muscle-row" data-muscle=""
          aria-pressed="false">All muscles</button>` : ''}
        ${rows.map((r) => `
        <button type="button" class="muscle-row${muscleFilter === r.mu ? ' sel' : ''}"
          data-muscle="${esc(r.mu)}" aria-pressed="${muscleFilter === r.mu}">
          <span class="spread"><span>${esc(r.mu)}</span>
            <span class="m-count">${plural(r.sets, 'set')}${r.workouts
              ? ` · ${plural(r.workouts, 'workout')}` : ''}</span></span>
          <span class="bar-track"><span class="bar-fill"
            style="width:${Math.round((r.sets / max) * 100)}%"></span></span>
        </button>`).join('')}
      </div>
      ${lost ? `<p class="muted">${plural(lost, 'set')} can't be attributed —
        their machine is gone or has no muscles tagged.</p>` : ''}
    </section>`;
  },
  // one delegated listener: a muscle row toggles its filter
  wire(root) {
    root.querySelector('#muscle-list')?.addEventListener('click', (e) => {
      const row = e.target.closest('.muscle-row');
      if (!row) return;
      const m = row.dataset.muscle;
      muscleFilter = m && m !== muscleFilter ? m : '';
      renderHistory(root);
    });
  },
};

// The way into the Workouts screen, last on the overview.
const workoutsLink = {
  html: ({ workouts }) => `
    <button type="button" id="open-workouts" class="btn">All workouts (${workouts.length}) ›</button>`,
  wire(root) {
    root.querySelector('#open-workouts').addEventListener('click', () => {
      screen = 'workouts';
      renderHistory(root);
    });
  },
};

// --- Progress: one machine's top set over time ---
// Machine chips (most recently trained first) pick the machine, range
// chips the window (`settings.historyRange`, device-local — merge.js does
// not sync it), the chart's selection the workout shown under it.
const CHIP_LIMIT = 8;
const RANGES = [['4w', '4 wk'], ['12w', '12 wk'], ['1y', '1 yr'], ['all', 'All']];
const rangeOf = (s) => (RANGES.some(([k]) => k === s.historyRange) ? s.historyRange : '12w');

// The x window: the range back from now, never earlier than the machine's
// first point. A future-dated back-log stretches it rather than vanishing.
function domainFor(range, points, now = Date.now()) {
  const first = points[0].t;
  const end = Math.max(now, points[points.length - 1].t);
  if (range === 'all') return [first, end];
  const from = new Date(now); // calendar steps, not ms multiples (DST)
  if (range === '1y') from.setFullYear(from.getFullYear() - 1);
  else from.setDate(from.getDate() - (range === '4w' ? 28 : 84));
  return [Math.max(from.getTime(), first), end];
}

// The machine on show: the picked one while the filters still show it,
// else the most recently trained.
const shownKey = (recent) =>
  (recent.some(([k]) => k === pickedMachine) ? pickedMachine : recent[0]?.[0] ?? null);
const machineName = (m) => `#${m.num} ${m.label}${m.exercise ? ` · ${m.exercise}` : ''}`;

// The first CHIP_LIMIT by last use, plus the shown one wherever it ranks.
function machineChipsHtml(recent) {
  const key = shownKey(recent);
  const visible = machinesExpanded ? recent
    : recent.filter(([k], i) => i < CHIP_LIMIT || k === key);
  const more = recent.length - visible.length;
  return visible.map(([k, m]) => `<button type="button" class="chip${k === key ? ' sel' : ''}"
      data-key="${esc(k)}" aria-pressed="${k === key}">${esc(machineName(m))}</button>`).join('')
    + (more ? `<button type="button" class="chip" data-more="1">+${more} more</button>` : '');
}

// plain .chip, not .chip.sm: the small chip leaves "All" 40px wide
const rangeChipsHtml = (range) => RANGES.map(([k, label]) => `<button type="button"
      class="chip${k === range ? ' sel' : ''}" data-range="${k}" aria-pressed="${k === range}">${label}</button>`)
  .join('');

const progressCard = {
  html: ({ recent, s }) => `
    <section class="card" id="progress-card">
      <h2 id="chart-title">Progress</h2>
      ${recent.length ? `
      <div class="chip-select" id="machine-chips">${machineChipsHtml(recent)}</div>
      <div class="map-mode" id="range-chips">${rangeChipsHtml(rangeOf(s))}</div>
      <div class="chart-wrap" id="chart"></div>
      <div class="c-pick" id="chart-pick" role="status"></div>`
    // a filter combination can leave no machine at all — say so
    : '<p class="muted">No machines match this filter.</p>'}
    </section>`,
  wire(root, { workouts, recent, s, unit }) {
    if (!recent.length) return;
    const chipsEl = root.querySelector('#machine-chips');
    const rangeEl = root.querySelector('#range-chips');
    const chartEl = root.querySelector('#chart');
    const pickEl = root.querySelector('#chart-pick');
    const chartTitle = root.querySelector('#chart-title');

    // Redraws THIS card's parts only: the chart handlers close over
    // chartEl, so re-rendering an ancestor would leave them on a dead node.
    const draw = () => {
      chipsEl.innerHTML = machineChipsHtml(recent);
      const range = rangeOf(getSettings());
      rangeEl.innerHTML = rangeChipsHtml(range);
      const key = shownKey(recent);
      const m = new Map(recent).get(key);
      const sel = decodeKey(key);
      const series = machineSeries(workouts, sel.machineId, sel.exercise);
      if (!series.length) { // an entry without sets: nothing to plot
        chartTitle.textContent = 'Progress';
        lineChart(chartEl, []);
        pickEl.innerHTML = '';
        return;
      }
      // The shape of the newest entry decides the metric (machineSeries
      // already dropped entries of any other shape); bodyweight progress
      // lives in reps until extra weight shows up.
      const kind = series[series.length - 1].kind;
      const reps = kind === 'bodyweight' && !series.some((p) => p.top.weight > 0);
      const valueOf = (p) => (kind === 'cardio' ? p.top.distance : reps ? p.top.reps : p.top.weight);
      const points = series.map((p) => ({ t: p.t, v: valueOf(p), workoutId: p.workoutId, e1rm: p.e1rm }));
      const metric = kind === 'cardio' ? `top distance (${distUnit(s)})`
        : kind === 'bodyweight' ? (reps ? 'top reps' : `top added weight (${unit})`)
          : `top set weight (${unit})`;
      const xDomain = domainFor(range, points);
      // The point shown under the chart is the one the chart selects —
      // picked here and handed in as selectedT, so the two never disagree.
      const inRange = points.filter((p) => p.t >= xDomain[0] && p.t <= xDomain[1]);
      const shown = !inRange.length ? null : pickedT == null ? inRange[inRange.length - 1]
        : inRange.reduce((b, p) => (Math.abs(p.t - pickedT) < Math.abs(b.t - pickedT) ? p : b));

      // Rewrites #chart-pick and nothing else — onSelect runs mid-gesture.
      const fillPick = (p) => {
        const w = p && workouts.find((x) => x.id === p.workoutId);
        const e = w?.entries.find((x) => entryMatches(x, sel) && x.sets.length);
        pickEl.innerHTML = e ? `
          <div class="spread"><strong>${fmtDate(w.startedAt)}</strong>${p.e1rm != null
            ? `<span class="muted">e1RM ${p.e1rm} ${esc(unit)}</span>` : ''}</div>
          <div class="muted">${e.sets.map((st) => setStr(st, s, !!e.bodyweight)).join(', ')}</div>
          <button type="button" class="btn btn-inline pick-open" data-wid="${esc(w.id)}">Open workout ›</button>`
          : '';
      };

      chartTitle.textContent = `Progress — ${metric}`;
      lineChart(chartEl, points, {
        unit: kind === 'cardio' ? distUnit(s) : reps ? 'reps' : unit,
        label: `Progress: ${machineName(m)} — ${metric} over time`,
        name: kind === 'cardio' ? 'Top distance' : reps ? 'Top reps' : 'Top set',
        // e1RM only where it is valid: loaded strength sets of 1–10 reps
        second: kind === 'strength' ? {
          points: series.filter((p) => p.e1rm != null).map((p) => ({ t: p.t, v: p.e1rm })),
          label: 'Estimated 1RM',
        } : null,
        selectedT: shown?.t ?? null,
        xDomain,
        onSelect: (p) => {
          pickedT = p.t;
          fillPick(p);
        },
      });
      fillPick(shown);
    };

    chipsEl.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      if (chip.dataset.more) {
        machinesExpanded = true;
      } else if (chip.dataset.key !== shownKey(recent)) {
        pickedMachine = chip.dataset.key;
        pickedT = null; // a point of another machine means nothing here
      }
      draw();
    });
    rangeEl.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      saveSettings({ ...getSettings(), historyRange: chip.dataset.range });
      draw();
    });
    // "Open workout ›" — the same workout, with its sets and its editor
    pickEl.addEventListener('click', (e) => {
      const open = e.target.closest('.pick-open');
      if (!open) return;
      focusWorkoutId = open.dataset.wid;
      screen = 'workouts';
      renderHistory(root);
    });
    draw();
  },
};

// --- training-days heatmap: month × machine ---
const heatmapCardHtml = ({ options }) => `
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
    </section>`;

function wireHeatmap(root, { workouts, s, unit }) {
  const hmMachine = root.querySelector('#hm-machine');
  const hmGrid = root.querySelector('#hm-grid');
  const hmInfo = root.querySelector('#hm-info');
  const month = () => {
    if (hmMonth) return hmMonth;
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  };

  const drawHeatmap = () => {
    const hmDate = month();
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
        const label = fmtDay(new Date(y, m, dayNum));
        hmInfo.textContent = info
          ? [`${label} — ${plural(info.sets, 'set')}`,
            info.volume ? `${Math.round(info.volume)} ${unit}` : '',
            info.dist ? `${Math.round(info.dist * 100) / 100} ${distUnit(s)}` : '',
            [...info.nums].sort((a, b) => a - b).map((n) => `#${n}`).join(', ')]
            .filter(Boolean).join(' · ')
          : `${label} — no training`;
      });
    });
  };

  const step = (by) => {
    const d = month();
    hmMonth = new Date(d.getFullYear(), d.getMonth() + by, 1);
    drawHeatmap();
  };
  root.querySelector('#hm-prev').addEventListener('click', () => step(-1));
  root.querySelector('#hm-next').addEventListener('click', () => step(1));
  hmMachine.addEventListener('change', drawHeatmap);
  drawHeatmap();
}

// The workout list with its editor, over `items` (ascending, as stored;
// rendered newest first). One card at a time can be in edit mode; the
// draft is a deep clone so Cancel never touches stored data. A freshly
// logged past workout opens in edit mode straight away (openEditId), so
// its details can be checked and named while the workout is still in mind.
// Shared by every list of workouts History shows; a save or a delete
// re-renders the whole view (the screen and the module state survive).
function wireWorkoutList(root, list, items, s, layout) {
  let editDraft = openEditId
    ? JSON.parse(JSON.stringify(items.find((w) => w.id === openEditId) ?? null)) : null;
  openEditId = null;
  const focusId = focusWorkoutId; // "Open workout ›": opened on THIS render only
  focusWorkoutId = null;
  const renderList = (openId = null) => {
    // reachable only by combining the name and muscle filters
    list.innerHTML = items.length ? items.slice().reverse()
      .map((w) => (editDraft?.id === w.id ? editWorkoutHtml(editDraft, s, layout)
        : workoutHtml(w, s, w.id === openId)))
      .join('') : '<p class="muted">No workouts match this filter.</p>';
  };
  renderList(focusId);
  // its summary, not its middle: an open workout can be taller than the screen
  if (focusId) keepInView(list, 'details.workout[open] summary');

  list.addEventListener('click', (e) => {
    const repeat = e.target.closest('.repeat-w');
    if (repeat) {
      if (getActive()) {
        repeat.textContent = 'Finish your current workout first';
        repeat.disabled = true;
        return;
      }
      const workout = items.find((w) => w.id === repeat.dataset.wid);
      if (!workout) return;
      startWorkoutFrom(workout);
      location.hash = '#train';
      return;
    }

    const edit = e.target.closest('.edit-w');
    if (edit) {
      const workout = items.find((w) => w.id === edit.dataset.wid);
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

    // A forgotten set is the common repair, so it copies the previous one
    // — `at` and `rir` are dropped: this set was neither logged live nor
    // rated, and nothing may claim otherwise (the quick-switch chips rank on that stamp).
    const setAdd = e.target.closest('.set-add');
    if (setAdd && editDraft) {
      const entry = editDraft.entries[+setAdd.dataset.ei];
      const last = entry.sets[entry.sets.length - 1];
      const { at, rir, ...copy } = last ?? {};
      entry.sets.push(last ? copy
        : entry.cardio ? { distance: 0, seconds: 0 } : { reps: 10, weight: 0 });
      renderList();
      // the new row lands ABOVE this button, so it would walk away while
      // you fill in a workout set by set
      keepInView(list, `.set-add[data-ei="${setAdd.dataset.ei}"]`);
      return;
    }

    const entryDel = e.target.closest('.entry-del');
    if (entryDel && editDraft) {
      editDraft.entries.splice(+entryDel.dataset.ei, 1);
      renderList();
      return;
    }

    // A machine forgotten entirely. The entry is snapshotted through store's
    // newEntry, exactly like the live logging screen does.
    if (e.target.closest('.entry-add') && editDraft) {
      const pick = e.target.closest('details').querySelector('.entry-pick');
      const machine = layout?.machines.find((m) => m.id === pick?.value);
      if (machine) {
        editDraft.entries.push(newEntry(machine, null,
          [machine.cardio ? { distance: 0, seconds: 0 } : { reps: 10, weight: 0 }]));
        renderList();
        keepInView(list, '.entry-add'); // the new machine pushed this row down
      }
      return;
    }

    const nameChip = e.target.closest('.edit-name-chips .chip');
    if (nameChip && editDraft) {
      editDraft.name = editDraft.name === nameChip.dataset.name ? '' : nameChip.dataset.name;
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
      const st = editDraft.entries[+t.dataset.ei].sets[+t.dataset.si];
      st.distance = parseDistance(t.value, getSettings().unit === 'kg') ?? st.distance;
      t.value = st.distance;
    } else if (t.classList.contains('edit-minutes')) {
      const st = editDraft.entries[+t.dataset.ei].sets[+t.dataset.si];
      st.seconds = parseDuration(t.value) ?? st.seconds;
      t.value = fmtDuration(st.seconds);
    } else if (t.classList.contains('edit-locker')) {
      editDraft.locker = t.value.trim();
    } else if (t.classList.contains('edit-name')) {
      editDraft.name = t.value.trim();
    } else if (t.classList.contains('edit-date') || t.classList.contains('edit-time')) {
      // both fields are read together; the workout keeps its duration by
      // moving finishedAt with the start
      const card = t.closest('details');
      const [y, mo, d] = (card.querySelector('.edit-date').value || '').split('-').map(Number);
      const [hh, mm] = (card.querySelector('.edit-time').value || '00:00').split(':').map(Number);
      if (!y || !mo || !d) return;
      const next = new Date(y, mo - 1, d, hh || 0, mm || 0).getTime();
      shiftWorkout(editDraft, next - editDraft.startedAt);
    }
  });
}

const setCount = (w) => w.entries.reduce((n, e) => n + e.sets.length, 0);
const minsOf = (w) => // finishedAt can be absent in imported data
  minsBetween(w.startedAt, w.finishedAt ?? w.startedAt);

const entryTitle = (e) => `#${e.num} ${esc(e.label)}${e.exercise ? ` · ${esc(e.exercise)}` : ''}`;

function workoutHtml(w, s, open = false) {
  const sets = setCount(w);
  const chain = machineChain(w);
  return `<details class="workout"${open ? ' open' : ''}>
    <summary>
      <div class="spread"><strong>${fmtDate(w.startedAt)}</strong>
        <span class="muted">${fmtTime(w.startedAt)} · ${minsOf(w)} min</span></div>
      <div class="muted">${w.name ? `<strong>${esc(w.name)}</strong> · ` : ''}${chain}</div>
      <div class="muted">${plural(sets, 'set')} · ${workoutTotals(w, s)}${w.locker
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

// "Log a past workout" — the workout you trained without your phone.
// Same note grammar as a plan, because a past workout IS a plan that
// already happened; shown even when history is empty, since coming over
// from paper starts by typing in the weeks you already trained.
function pastCardHtml() {
  return `<section class="card">
    <h2>Log a past workout</h2>
    <p class="muted">Trained without your phone? Write it the way your plan
      reads — <em>#14 Leg press 3x10 80</em> logs three sets of ten at 80.
      The <em>#number</em> says which machine.</p>
    <div class="row">
      <label class="field"><span>Date</span>
        <input type="date" id="past-date" value="${dateValue(Date.now())}"></label>
      <label class="field"><span>Time</span>
        <input type="time" id="past-time" value="18:00"></label>
    </div>
    <textarea id="past-text" rows="4"
      placeholder="#14 Leg press 3x10 80&#10;#3 Lat pulldown 3x12 45"></textarea>
    <button id="past-log" class="btn">Log it</button>
    <p id="past-msg" class="muted" role="status"></p>
  </section>`;
}

function wirePastLog(root, s) {
  root.querySelector('#past-log').addEventListener('click', () => {
    const msg = root.querySelector('#past-msg');
    const [y, mo, d] = (root.querySelector('#past-date').value || '').split('-').map(Number);
    const [hh, mm] = (root.querySelector('#past-time').value || '18:00').split(':').map(Number);
    if (!y || !mo || !d) { msg.textContent = 'Pick a date first.'; return; }
    try {
      const { workout, skipped } = workoutFromText(
        root.querySelector('#past-text').value,
        new Date(y, mo - 1, d, hh || 0, mm || 0).getTime(), s);
      saveWorkouts([...getWorkouts(), workout]); // saveWorkouts keeps order
      nameFilter = ''; // a workout just logged must not vanish behind a filter
      muscleFilter = '';
      openEditId = workout.id; // reopen it for a once-over and a name
      screen = 'workouts'; // …on the screen whose list holds the editor
      renderHistory(root);
      if (skipped.length) {
        root.querySelector('#past-msg').textContent = `Logged — ${plural(skipped.length, 'line')}
          had no machine gymii could find (${skipped.join(', ')}).`;
      }
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

function editWorkoutHtml(w, s, layout) {
  const sets = setCount(w);
  const du = distUnit(s);
  const inWorkout = new Set(w.entries.map((e) => e.machineId));
  const addable = (layout?.machines ?? []).filter((m) => !inWorkout.has(m.id))
    .slice().sort((a, b) => a.num - b.num);
  // one id per logged set, so the dominant region wins the suggestion
  const nameChips = nameChipsFor(w.entries.flatMap((e) => e.sets.map(() => e.machineId)), layout);
  return `<details class="workout" open>
    <summary>
      <div class="spread"><strong>${fmtDate(w.startedAt)}</strong>
        <span class="muted">${fmtTime(w.startedAt)} · ${minsOf(w)} min</span></div>
      <div class="muted">Editing — ${plural(sets, 'set')} · ${workoutTotals(w, s)}</div>
    </summary>
    <div class="row">
      <label class="field"><span>Date</span>
        <input type="date" class="edit-date" value="${dateValue(w.startedAt)}"></label>
      <label class="field"><span>Time</span>
        <input type="time" class="edit-time" value="${timeValue(w.startedAt)}"></label>
    </div>
    ${w.entries.map((e, ei) => `
      <div class="entry-line">
        <div class="spread"><div>${entryTitle(e)}</div>
          <button class="x entry-del" data-ei="${ei}"
            aria-label="Remove ${esc(e.label)} from this workout">✕</button></div>
        ${e.sets.map((st, si) => `
          <div class="set-row">
            <span>Set ${si + 1}</span>
            <span class="edit-set">${e.cardio ? `
              <input type="text" inputmode="decimal" autocomplete="off" data-kind="distance"
                class="edit-distance" data-ei="${ei}" data-si="${si}"
                value="${st.distance}" aria-label="Distance (${du})"> ${du} ·
              <input type="text" inputmode="numeric" autocomplete="off" data-kind="time"
                class="edit-minutes" data-ei="${ei}" data-si="${si}"
                value="${fmtDuration(st.seconds)}" aria-label="Time (m:ss)">` : `
              ${e.bodyweight ? 'BW+' : ''}<input type="number" inputmode="decimal" class="edit-weight"
                data-ei="${ei}" data-si="${si}" value="${st.weight}"
                aria-label="${e.bodyweight ? 'Extra weight' : 'Weight'} (${s.unit})"> ${s.unit} ×
              <input type="number" inputmode="numeric" class="edit-reps" data-ei="${ei}" data-si="${si}"
                value="${st.reps}" aria-label="Reps">`}
            </span>
            <button class="x set-del" data-ei="${ei}" data-si="${si}" aria-label="Remove set ${si + 1}">✕</button>
          </div>`).join('') || '<p class="muted">No sets left — removed on save.</p>'}
        <button class="btn btn-inline set-add" data-ei="${ei}">+ Set</button>
      </div>`).join('')}
    ${addable.length ? `
    <div class="row">
      <select class="entry-pick" aria-label="Machine to add">
        ${addable.map((m) => `<option value="${m.id}">#${m.num} ${esc(m.label)}</option>`).join('')}
      </select>
      <button class="btn btn-inline entry-add">+ Machine</button>
    </div>` : ''}
    <label class="field"><span>Name</span>
      <input type="text" class="edit-name" value="${esc(w.name || '')}" placeholder="none"></label>
    ${nameChips.length ? `<div class="chip-select edit-name-chips">
      ${nameChips.map((n) => `<button type="button" class="chip${w.name === n ? ' sel' : ''}"
        data-name="${esc(n)}">${esc(n)}</button>`).join('')}
    </div>` : ''}
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
