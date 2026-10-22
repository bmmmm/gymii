import {
  getLayout, getWorkouts, saveWorkouts, getSettings, saveSettings, getActive, deleteWorkout,
  updateWorkout, distUnit, newEntry, nameChipsFor,
  layoutMuscles, usageByMuscle, workoutsWithMuscle, shiftWorkout, getPlans,
} from './store.js';
import { workoutFromText } from './plantext.js';
import {
  esc, fmtDate, fmtDay, fmtTime, workoutTotals, setStr, twoTapConfirm, plural,
  dateValue, timeValue, machineChain, keepInView, minsBetween, fmtDuration,
  parseDuration, parseDistance, hintHtml, variantStr, fieldValue, keepFocus, fmtMetric, cssStr,
  entryKind, machineIcon,
} from './ui.js';
import { lineChart, barChart } from './chart.js';
import {
  machineSeries, weeklyBuckets, insights, workoutPath, transitionCounts, seriesKey, sameSeries, quantile,
} from './stats.js';
import { drawLayout } from './map.js';
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
// … and its machine filter ('' = all machines), for the same reason.
let hmMachineKey = '';
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
// This-week card: the picked bar's week as its Monday in ms (null = this
// week). "Where in time", so an entry resets it and a save keeps it.
let pickedWeek = null;
// Walking-paths card: the workout whose route is drawn (null = the latest,
// 'all' = every route at once, weighted). "Where in time", like pickedWeek.
let pathWorkoutId = null;

// `entry` = arriving from the tab bar (app.js). It is the ONE thing that
// resets "where in time" — the screen, the heatmap month, the chart's
// point, the picked week and route (and the chip list's expansion); the filters, the
// picked machine, the range and the week metric survive it. Every other re-render (save, delete, filter)
// calls renderHistory(root) without it, so nothing the user set moves.
export function renderHistory(root, { entry = false } = {}) {
  if (entry) {
    screen = 'overview';
    hmMonth = null;
    hmMachineKey = '';
    pickedT = null;
    pickedWeek = null;
    pathWorkoutId = null;
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

  // Every series seen in history — a machine, and at multi-exercise or
  // multi-grip machines each exercise and grip — labeled with its current
  // name in the layout when still present. Keyed by stats.js's seriesKey
  // (a JSON triple), decoded with JSON.parse.
  const machines = new Map();
  workouts.forEach((w) => w.entries.forEach((e) => {
    const key = seriesKey(e);
    machines.set(key, {
      machineId: e.machineId, exercise: e.exercise ?? null, grip: e.grip ?? null, num: e.num, label: e.label,
      last: Math.max(machines.get(key)?.last ?? -Infinity, w.startedAt),
    });
  }));
  layout?.machines.forEach((m) => {
    machines.forEach((val, key) => {
      if (val.machineId === m.id) machines.set(key, { ...val, num: m.num, label: m.label });
    });
  });
  const byNum = (a, b) => a[1].num - b[1].num
    || (a[1].exercise ?? '').localeCompare(b[1].exercise ?? '')
    || (a[1].grip ?? '').localeCompare(b[1].grip ?? '');
  const options = [...machines.entries()].sort(byNum); // the heatmap's <select>
  // the Progress chips: most recently trained first
  const recent = [...machines.entries()].sort((a, b) => b[1].last - a[1].last || byNum(a, b));
  // The hints (stats.js insights) read EVERY workout, never the filtered
  // list: "1.5 strength days a week" says nothing about one routine on its
  // own. Each card shows only the rows about the thing on it.
  const hints = insights(all, layout, s, { plans: getPlans() });
  return { all, named, byName, workouts, s, unit: s.unit, layout, allMuscles, options, recent, hints };
}

const optionHtml = ([key, m]) => `<option value="${esc(key)}">${esc(machineName(m))}</option>`;
const decodeKey = (value) => {
  if (!value) return null; // '' = the heatmap's "All machines"
  try {
    const [machineId, exercise, grip] = JSON.parse(value);
    return { machineId, exercise, grip };
  } catch {
    return null; // defensive: never a key of ours
  }
};

// The overview: a sequence of cards, rendered in this order. Each is
// { html(ctx) -> markup, wire(root, ctx) }; a new card is one entry here.
const overviewCards = () => [weekCard, progressCard, pathCard, muscleCard];

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
      ${nameFilter || muscleFilter ? `<p class="muted list-filter">Showing: ${
    [nameFilter, muscleFilter].filter(Boolean).map(esc).join(' · ')}</p>` : ''}
      <div id="workout-list"></div>
    </section>
    ${pastCardHtml()}`;
  root.querySelector('#hist-back').addEventListener('click', () => {
    screen = 'overview';
    renderHistory(root);
  });
  wireNameFilter(root);
  wirePastLog(root, ctx.s);
  // the heatmap first: it sits ABOVE the list and fills its grid on wiring,
  // so the list's keepInView ("Open workout ›") measures the final layout
  wireHeatmap(root, ctx);
  wireWorkoutList(root, root.querySelector('#workout-list'), ctx.workouts, ctx.s, ctx.layout);
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
    keepFocus(root, () => renderHistory(root));
  });
}

// Usage per muscle group over the name-filtered list — every row is also
// the filter for that muscle. Computing over `byName` (not `workouts`) is
// what keeps other muscles reachable while one is selected.
const muscleCard = {
  html({ allMuscles, byName, layout, hints }) {
    if (!allMuscles.length) return '';
    const usage = usageByMuscle(byName, layout);
    // a secondary set is worth half (stats.js does the same): the bar and
    // the order follow that weight, the line says the secondary share apart
    const weighted = (r) => r.sets + r.secondary / 2;
    const rows = allMuscles
      .map((mu) => ({ mu, ...(usage.get(mu) ?? { sets: 0, secondary: 0, workouts: 0 }) }))
      .sort((a, b) => weighted(b) - weighted(a) || a.mu.localeCompare(b.mu));
    const max = (rows[0] && weighted(rows[0])) || 1;
    // sets whose machine is gone or untagged — count them, or the card
    // silently disagrees with the workout list's totals. Cardio is no
    // muscle set (usageByMuscle skips it, like the hints), so its sets
    // are not "lost" either — tagged or not, live or (by the entry's
    // flag) gone.
    const byId = new Map(layout.machines.map((m) => [m.id, m]));
    const lost = byName.reduce((n, w) => n + w.entries.reduce((k, e) => {
      const m = byId.get(e.machineId);
      if (m ? m.cardio : e.cardio) return k;
      return k + (m?.muscles?.length || m?.secondaryMuscles?.length ? 0 : e.sets.length);
    }, 0), 0);
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
            <span class="m-count">${plural(r.sets, 'set')}${r.secondary
              ? ` + ${r.secondary} secondary` : ''}${r.workouts
              ? ` · ${plural(r.workouts, 'workout')}` : ''}</span></span>
          <span class="bar-track"><span class="bar-fill"
            style="width:${Math.round((weighted(r) / max) * 100)}%"></span></span>
        </button>${hints.filter((it) => it.muscle === r.mu).map((it) => hintHtml(it, 'muscle-hint')).join('')}`).join('')}
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
      keepFocus(root, () => renderHistory(root));
      // Muscles is the last card: the view shrinks or grows above the row,
      // and the clamp would put the next tap on another row
      keepInView(root, `.muscle-row[data-muscle="${cssStr(m)}"]`);
    });
  },
};

// --- This week: four totals, twelve weeks of bars, that week's workouts ---
// The tiles pick what the bars count (`settings.historyMetric`, device-local
// like the range — merge.js does not sync it); a bar picks the week that the
// title, the tiles and the list describe. Follows the filters (only the
// hints read everything), and ends in the way into the Workouts screen.
const WEEKS = 12;
const METRICS = [['workouts', 'Workouts'], ['sets', 'Sets'], ['volume', 'Volume'], ['minutes', 'Time']];
const metricOf = (s) => (METRICS.some(([k]) => k === s.historyMetric) ? s.historyMetric : 'sets');
const metricValue = (b, metric) => (metric === 'volume' || metric === 'minutes'
  ? Math.round(b[metric]) : b[metric]); // stats.js hands back raw floats
// "8 Sep": a week's Monday — "Week of" already says which weekday it is
const dayMonth = (t) => fmtDay(t).replace(/^\S+ /, '');

// One week more than the bars show, so the oldest bar has a week before it
// to compare with too. Computed once per render (html and wire share it).
function weekData(ctx) {
  if (!ctx.weeks) {
    const all = weeklyBuckets(ctx.workouts, { weeks: WEEKS + 1, layout: ctx.layout });
    ctx.weeks = { all, bars: all.slice(1) };
  }
  const { all, bars } = ctx.weeks;
  const found = bars.findIndex((b) => b.weekStart.getTime() === pickedWeek);
  const i = found < 0 ? bars.length - 1 : found; // a week that aged out: back to now
  return { bar: bars[i], before: all[i], bars, isNow: i === bars.length - 1 };
}
const weekTitle = ({ bar, isNow }) => (isNow ? 'This week' : `Week of ${dayMonth(bar.weekStart)}`);

const statTileHtml = ([key, title], { bar, before }, metric, unit) => `
      <button type="button" class="tile stat${key === metric ? ' sel' : ''}" data-metric="${key}"
        aria-pressed="${key === metric}">
        <span class="tile-title">${title}</span>
        <span class="tile-value">${esc(fmtMetric(metricValue(bar, key), key, unit))}</span>
        <span class="tile-sub">vs ${esc(fmtMetric(metricValue(before, key), key, unit))} the week before</span>
      </button>`;

const weekCard = {
  html: (ctx) => `
    <section class="card" id="week-card">
      <h2 id="week-title">${weekTitle(weekData(ctx))}</h2>
      <div class="tile-grid" id="week-tiles"></div>
      ${ctx.hints.filter((it) => it.kind === 'frequency').map((it) => hintHtml(it, 'week-hint')).join('')}
      <div class="chart-wrap" id="week-chart"></div>
      <div id="week-workouts"></div>
      <button type="button" id="open-workouts" class="btn">All workouts (${ctx.workouts.length}) ›</button>
    </section>`,
  wire(root, ctx) {
    const { workouts, s, unit, layout } = ctx;
    const titleEl = root.querySelector('#week-title');
    const tilesEl = root.querySelector('#week-tiles');
    const chartEl = root.querySelector('#week-chart');
    const holder = root.querySelector('#week-workouts');

    // Title, tiles and list for the picked week — never the chart: this
    // also runs from the chart's onSelect, mid-gesture.
    const drawWeekBody = () => {
      const week = weekData(ctx);
      const metric = metricOf(getSettings());
      titleEl.textContent = weekTitle(week);
      tilesEl.innerHTML = METRICS.map((m) => statTileHtml(m, week, metric, unit)).join('');
      const from = week.bar.weekStart.getTime();
      const to = new Date(week.bar.weekStart);
      to.setDate(to.getDate() + 7); // calendar step, as stats.js buckets them (DST)
      const items = workouts.filter((w) => w.startedAt >= from && w.startedAt < to.getTime());
      // a fresh #week-list per draw: wireWorkoutList adds its listeners to
      // the node, and a reused one would collect a set per picked week
      holder.innerHTML = items.length ? '<div id="week-list"></div>'
        : `<p class="muted" id="week-list">Nothing logged ${week.isNow ? 'this' : 'that'} week.</p>`;
      if (items.length) wireWorkoutList(root, root.querySelector('#week-list'), items, s, layout, { readOnly: true });
    };
    const drawWeek = () => {
      const metric = metricOf(getSettings());
      const title = METRICS.find(([k]) => k === metric)[1];
      const { bars } = weekData(ctx);
      barChart(chartEl, bars.map((b) => ({
        key: String(b.weekStart.getTime()), label: dayMonth(b.weekStart), v: metricValue(b, metric),
      })), {
        // the selected bar reads exactly like its tile ("2:29 h", "3,873 kg")
        format: (v) => fmtMetric(v, metric, unit),
        label: `${title} per week, last ${WEEKS} weeks`,
        selectedKey: pickedWeek == null ? null : String(pickedWeek),
        onSelect: (bar) => {
          pickedWeek = Number(bar.key);
          drawWeekBody();
        },
      });
      drawWeekBody();
    };

    tilesEl.addEventListener('click', (e) => {
      const tile = e.target.closest('.tile');
      if (!tile) return;
      saveSettings({ ...getSettings(), historyMetric: tile.dataset.metric });
      keepFocus(root, drawWeek);
    });
    root.querySelector('#open-workouts').addEventListener('click', () => {
      screen = 'workouts';
      renderHistory(root);
    });
    drawWeek();
  },
};

// --- Progress: one machine's top set over time ---
// Machine chips (most recently trained first) pick the machine, range
// chips the window (`settings.historyRange`, device-local — merge.js does
// not sync it), the chart's selection the workout shown under it.
const CHIP_LIMIT = 8;
const RANGES = [['4w', '4 wk'], ['12w', '12 wk'], ['1y', '1 yr'], ['all', 'All']];
const rangeOf = (s) => (RANGES.some(([k]) => k === s.historyRange) ? s.historyRange : '12w');
// An assisted machine charts its least ASSIST (lower is stronger) or the
// reps at it — `settings.historyAssistView`, device-local like the range.
const ASSIST_VIEWS = [['assist', 'Assist'], ['reps', 'Reps']];
const assistViewOf = (s) => (s.historyAssistView === 'reps' ? 'reps' : 'assist');

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
const machineName = (m) => `#${m.num} ${m.label}${variantStr(m) ? ` · ${variantStr(m)}` : ''}`;

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
      <div class="chip-select scroll" id="machine-chips">${machineChipsHtml(recent)}</div>
      <div class="map-mode" id="range-chips">${rangeChipsHtml(rangeOf(s))}</div>
      <div class="map-mode" id="assist-chips"></div>
      <div class="chart-wrap" id="chart"></div>
      <div id="chart-note"></div>
      <div class="c-pick" id="chart-pick" role="status"></div>`
    // a filter combination can leave no machine at all — say so
    : '<p class="muted">No machines match this filter.</p>'}
    </section>`,
  wire(root, { workouts, recent, s, unit, hints }) {
    if (!recent.length) return;
    const chipsEl = root.querySelector('#machine-chips');
    const rangeEl = root.querySelector('#range-chips');
    const chartEl = root.querySelector('#chart');
    const noteEl = root.querySelector('#chart-note');
    const pickEl = root.querySelector('#chart-pick');
    const chartTitle = root.querySelector('#chart-title');
    const assistEl = root.querySelector('#assist-chips');

    // Redraws THIS card's parts only: the chart handlers close over
    // chartEl, so re-rendering an ancestor would leave them on a dead node.
    const drawProgress = () => {
      chipsEl.innerHTML = machineChipsHtml(recent);
      revealSelected(chipsEl);
      const range = rangeOf(getSettings());
      rangeEl.innerHTML = rangeChipsHtml(range);
      const key = shownKey(recent);
      const m = new Map(recent).get(key);
      const sel = decodeKey(key);
      // the plateau hint for exactly this machine AND exercise — a hint
      // about another exercise on the same machine says nothing about
      // this chart
      noteEl.innerHTML = hints.filter((it) => it.kind === 'plateau' && sameSeries(it, sel))
        .map((it) => hintHtml(it)).join('');
      const series = machineSeries(workouts, sel.machineId, sel.exercise, sel.grip);
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
      const reps = (kind === 'bodyweight' && !series.some((p) => p.top.weight > 0))
        || (kind === 'assisted' && assistViewOf(getSettings()) === 'reps');
      const valueOf = (p) => (kind === 'cardio' ? p.top.distance : reps ? p.top.reps : p.top.weight);
      const points = series.map((p) => ({ t: p.t, v: valueOf(p), workoutId: p.workoutId, e1rm: p.e1rm }));
      const metric = kind === 'cardio' ? `top distance (${distUnit(s)})`
        : kind === 'bodyweight' ? (reps ? 'top reps' : `top added weight (${unit})`)
          : kind === 'assisted' ? (reps ? 'reps at the least assist' : `assist (${unit}) — lower is stronger`)
            : `top set weight (${unit})`;
      assistEl.hidden = kind !== 'assisted'; // an empty row would still take its margin
      assistEl.innerHTML = kind === 'assisted' ? ASSIST_VIEWS.map(([k, label]) => `<button type="button"
        class="chip${(reps ? 'reps' : 'assist') === k ? ' sel' : ''}" data-view="${k}"
        aria-pressed="${(reps ? 'reps' : 'assist') === k}">${label}</button>`).join('') : '';
      const xDomain = domainFor(range, points);
      // The point shown under the chart is the one the chart selects —
      // picked here and handed in as selectedT, so the two never disagree.
      const inRange = points.filter((p) => p.t >= xDomain[0] && p.t <= xDomain[1]);
      const shown = !inRange.length ? null : pickedT == null ? inRange[inRange.length - 1]
        : inRange.reduce((b, p) => (Math.abs(p.t - pickedT) < Math.abs(b.t - pickedT) ? p : b));

      // Rewrites #chart-pick and nothing else — onSelect runs mid-gesture.
      const fillPick = (p) => {
        const w = p && workouts.find((x) => x.id === p.workoutId);
        const e = w?.entries.find((x) => sameSeries(x, sel) && x.sets.length);
        pickEl.innerHTML = e ? `
          <div class="spread"><strong>${fmtDate(w.startedAt)}</strong>${p.e1rm != null
            ? `<span class="muted">e1RM ${p.e1rm} ${esc(unit)}</span>` : ''}</div>
          <div class="muted">${e.sets.map((st) => setStr(st, s, entryKind(e))).join(', ')}</div>
          <button type="button" class="btn btn-inline pick-open" data-wid="${esc(w.id)}">Open workout ›</button>`
          : '';
      };

      chartTitle.textContent = `Progress — ${metric}`;
      lineChart(chartEl, points, {
        unit: kind === 'cardio' ? distUnit(s) : reps ? 'reps' : unit,
        label: `Progress: ${machineName(m)} — ${metric} over time`,
        name: kind === 'cardio' ? 'Top distance' : reps ? 'Top reps' : kind === 'assisted' ? 'Least assist' : 'Top set',
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
      // "+N more" sits at the END of the scrolled row: the chips it reveals
      // appear where the thumb is, so the row keeps its scroll instead of
      // snapping back to the selected chip at the start
      const keep = chip.dataset.more ? chipsEl.scrollLeft : null;
      if (chip.dataset.more) {
        machinesExpanded = true;
      } else if (chip.dataset.key !== shownKey(recent)) {
        pickedMachine = chip.dataset.key;
        pickedT = null; // a point of another machine means nothing here
      }
      keepFocus(root, drawProgress);
      if (keep != null) chipsEl.scrollLeft = keep;
    });
    assistEl.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      saveSettings({ ...getSettings(), historyAssistView: chip.dataset.view });
      keepFocus(root, drawProgress);
    });
    rangeEl.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      saveSettings({ ...getSettings(), historyRange: chip.dataset.range });
      keepFocus(root, drawProgress);
    });
    // "Open workout ›" — the same workout, with its sets and its editor
    pickEl.addEventListener('click', (e) => {
      const open = e.target.closest('.pick-open');
      if (!open) return;
      focusWorkoutId = open.dataset.wid;
      screen = 'workouts';
      renderHistory(root);
    });
    drawProgress();
  },
};

// --- Walking paths: the route a live-logged workout took through the gym ---
// Only workouts with a route (stats.js workoutPath: visits, else stamped
// sets; two or more machines still in the layout), from the filtered list.
// Chips: the last PATH_CHIPS of them, newest first, plus "All · N workouts"
// — every route at once, a way drawn thicker the more workouts walked it.
// The map is read-only (drawLayout measures nothing outside the editor).
const PATH_CHIPS = 5;
const PATH_EMPTY = 'Shows the route you walked through the gym, machine by machine. '
  + 'It needs workouts logged live — sets typed in afterwards carry no time, '
  + 'so there is no route to draw yet.';
// [{w, p}] oldest first; computed once per render (html and wire share it)
const pathsOf = (ctx) => (ctx.paths ??= ctx.layout
  ? ctx.workouts.map((w) => ({ w, p: workoutPath(w, ctx.layout) })).filter((x) => x.p) : []);
// No route to draw: blame the filter when it is the filter — the sets were
// logged live, just not under this name (or with this muscle). The name is
// to blame only when the name-filtered list has no route either.
const pathEmpty = (ctx) => {
  const routed = (ws) => ws.some((w) => workoutPath(w, ctx.layout));
  if (!(nameFilter || muscleFilter) || !routed(ctx.all)) return PATH_EMPTY;
  return nameFilter && !routed(ctx.byName) ? 'No live-logged workout under this name.'
    : 'No live-logged workout trained this muscle.';
};
const routeLen = (p) => p.legs.reduce((n, l) => n + l.len, 0);
const median = (xs) => quantile([...xs].sort((x, y) => x - y), 0.5);
const switches = (n) => `${n} ${n === 1 ? 'switch' : 'switches'}`;

const pathCard = {
  html: (ctx) => (ctx.layout ? `
    <section class="card" id="path-card">
      <h2>Walking paths</h2>
      ${pathsOf(ctx).length ? `
      <div class="chip-select scroll" id="path-chips"></div>
      <div class="map-wrap"><svg id="path-map" role="img"></svg></div>
      <div id="path-stats"></div>` : `<p class="muted">${esc(pathEmpty(ctx))}</p>`}
    </section>` : ''),
  wire(root, ctx) {
    const paths = pathsOf(ctx);
    if (!paths.length) return;
    const { layout } = ctx;
    const chipsEl = root.querySelector('#path-chips');
    const svg = root.querySelector('#path-map');
    const statsEl = root.querySelector('#path-stats');
    const shown = paths.slice(-PATH_CHIPS).reverse();
    // two workouts on one day: the chip names its time as well
    const days = shown.map(({ w }) => fmtDay(w.startedAt));
    const label = (i) => (days.indexOf(days[i]) !== days.lastIndexOf(days[i])
      ? `${days[i]} ${fmtTime(shown[i].w.startedAt)}` : days[i]);
    const num = (id) => layout.machines.find((m) => m.id === id)?.num;
    const lens = paths.map(({ p }) => routeLen(p));

    // One route: its counts, how it compares, and where the time went —
    // a stop lasts from its first `at` to the next stop's (the last one to
    // the finish).
    const oneRoute = ({ w, p }) => {
      const parts = [plural(new Set(p.stops.map((st) => st.machineId)).size, 'machine'),
        switches(p.switches), plural(p.backtracks, 'back-track')];
      const mid = median(lens);
      if (paths.length >= 3 && mid > 0) {
        const pct = Math.round((routeLen(p) / mid - 1) * 100);
        parts.push(pct ? `route ${Math.abs(pct)} % ${pct < 0 ? 'shorter' : 'longer'} than your median`
          : 'route as long as your median');
      }
      const chain = p.stops.map((st, i) => {
        const end = i + 1 < p.stops.length ? p.stops[i + 1].at : w.finishedAt;
        return `#${num(st.machineId)}${Number.isFinite(end) && end > st.at ? ` ${minsBetween(st.at, end)} min` : ''}`;
      }).join(' → ');
      return { stats: `<p class="muted">${parts.join(' · ')}</p><p class="path-chain">${esc(chain)}</p>`, chain };
    };

    const drawPath = () => {
      const all = pathWorkoutId === 'all' && paths.length >= 2;
      const i = all ? -1 : Math.max(0, shown.findIndex(({ w }) => w.id === pathWorkoutId));
      const key = all ? 'all' : shown[i].w.id;
      chipsEl.innerHTML = shown.map(({ w }, k) => `<button type="button" class="chip${w.id === key ? ' sel' : ''}"
        data-wid="${esc(w.id)}" aria-pressed="${w.id === key}">${label(k)}</button>`).join('')
        + (paths.length >= 2 ? `<button type="button" class="chip${all ? ' sel' : ''}" data-wid="all"
        aria-pressed="${all}">All · ${paths.length} workouts</button>` : '');
      revealSelected(chipsEl);
      if (all) {
        const counts = transitionCounts(paths.map(({ w }) => w), layout);
        drawLayout(svg, layout, { pathWeights: counts });
        svg.setAttribute('aria-label', `Walking paths of ${paths.length} workouts`);
        const top = [...counts.values()].reduce((a, b) => (b.n > a.n ? b : a), { n: 0 });
        statsEl.innerHTML = `<p class="muted">The more workouts walked a way, the thicker its line.${top.n >= 2
          ? ` Most walked: #${num(top.from)} → #${num(top.to)}, in ${top.n} workouts.` : ''}</p>`;
      } else {
        const route = oneRoute(shown[i]);
        drawLayout(svg, layout, { path: shown[i].p });
        svg.setAttribute('aria-label', `Walking path of ${label(i)}: ${route.chain}`);
        statsEl.innerHTML = route.stats;
      }
    };

    chipsEl.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      pathWorkoutId = chip.dataset.wid;
      keepFocus(root, drawPath);
    });
    drawPath();
  },
};

// A sideways-scrolling chip row keeps its selected chip in view — along the
// row ONLY: scrollIntoView would also scroll the page to a row that sits
// below the fold. Guarded: the logic tests' stub DOM measures nothing.
function revealSelected(row) {
  const r = row.querySelector?.('.chip.sel')?.getBoundingClientRect?.();
  const box = row.getBoundingClientRect?.();
  if (!r || !box) return;
  if (r.left < box.left) row.scrollLeft += r.left - box.left;
  else if (r.right > box.right) row.scrollLeft += r.right - box.right;
}

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

function wireHeatmap(root, { workouts, s, unit, layout }) {
  // the CURRENT number of a machine still in the gym (the chips, the chart
  // and the path card show that one too); the entry's snapshot once gone
  const liveNum = new Map((layout?.machines ?? []).map((m) => [m.id, m.num]));
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
      const entries = sel ? w.entries.filter((e) => sameSeries(e, sel)) : w.entries;
      const sets = entries.reduce((n, e) => n + e.sets.length, 0);
      if (!sets) return;
      // an assisted set's weight is the help, not the load: no volume
      const volume = entries.reduce((v, e) => (entryKind(e) === 'assisted' ? v
        : v + e.sets.reduce((x, st) => x + (st.reps * st.weight || 0), 0)), 0);
      const dist = entries.reduce(
        (v, e) => v + e.sets.reduce((x, st) => x + (st.distance || 0), 0), 0);
      const day = days.get(d.getDate()) || { sets: 0, volume: 0, dist: 0, nums: new Set() };
      day.sets += sets;
      day.volume += volume;
      day.dist += dist;
      entries.forEach((e) => day.nums.add(liveNum.get(e.machineId) ?? e.num));
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
  // a select ignores a value it has no option for, so a deleted machine falls back to all
  if (hmMachineKey) hmMachine.value = hmMachineKey;
  hmMachine.addEventListener('change', () => { hmMachineKey = hmMachine.value; drawHeatmap(); });
  drawHeatmap();
}

// The workout list with its editor, over `items` (ascending, as stored;
// rendered newest first). One card at a time can be in edit mode; the
// draft is a deep clone so Cancel never touches stored data. A freshly
// logged past workout opens in edit mode straight away (openEditId), so
// its details can be checked and named while the workout is still in mind.
// Shared by every list of workouts History shows; a save or a delete
// re-renders the whole view (the screen and the module state survive).
// `readOnly` (the overview's week list): no editor, no delete — a bar or
// tile tap rebuilds that list, and an open draft would die with it
// unannounced. Its "Edit ›" opens the workout's editor on the Workouts
// screen instead, which nothing else redraws under it.
function wireWorkoutList(root, list, items, s, layout, { readOnly = false } = {}) {
  let editDraft = !readOnly && openEditId
    ? JSON.parse(JSON.stringify(items.find((w) => w.id === openEditId) ?? null)) : null;
  if (!readOnly) openEditId = null;
  const focusId = readOnly ? null : focusWorkoutId; // "Open workout ›": opened on THIS render only
  if (!readOnly) focusWorkoutId = null;
  // why a grip chip did nothing — { ei, text }, shown for ONE render
  let gripMsg = null;
  const renderList = (openId = null) => {
    // reachable only by combining the name and muscle filters
    list.innerHTML = items.length ? items.slice().reverse()
      .map((w) => (editDraft?.id === w.id ? editWorkoutHtml(editDraft, s, layout, gripMsg)
        : workoutHtml(w, s, layout, w.id === openId, readOnly)))
      .join('') : '<p class="muted">No workouts match this filter.</p>';
    gripMsg = null;
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

    const editOpen = e.target.closest('.edit-open');
    if (editOpen) {
      openEditId = editOpen.dataset.wid;
      focusWorkoutId = editOpen.dataset.wid; // scrolled to, like "Open workout ›"
      screen = 'workouts';
      renderHistory(root);
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

    const gripChip = e.target.closest('.entry-grip');
    if (gripChip && editDraft) {
      const ei = +gripChip.dataset.ei;
      const entry = editDraft.entries[ei];
      // the chosen chip again = no grip, unless a gripless twin exists
      const next = entry.grip === gripChip.dataset.grip ? null : gripChip.dataset.grip;
      if (gripTaken(editDraft, ei, next)) {
        gripMsg = { ei, text: `Another entry already logs ${entry.exercise ?? entry.label}${
          next ? ` with ${next}` : ' without a grip'}` };
        renderList();
        return;
      }
      if (next) entry.grip = next;
      else delete entry.grip;
      renderList();
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
      // a decimal text field: "12,5" is 12.5 (type=number turned it into 125)
      const st = editDraft.entries[+t.dataset.ei].sets[+t.dataset.si];
      st.weight = Math.max(0, parseDistance(fieldValue(t), false) ?? st.weight ?? 0);
      t.value = st.weight;
    } else if (t.classList.contains('edit-reps')) {
      // fieldValue, like the weight: an armed field left empty still means
      // the value it shows greyed out
      const v = Math.max(1, Math.round(parseFloat(fieldValue(t)) || 1));
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
    } else if (t.classList.contains('edit-level')) {
      // the level is optional on the set: a whole number from 1 up stays,
      // empty, 0 or junk deletes it — never a stored 0 or null
      const st = editDraft.entries[+t.dataset.ei].sets[+t.dataset.si];
      const v = Math.round(parseFloat(t.value));
      if (v >= 1) st.level = v; else delete st.level;
      t.value = v >= 1 ? v : '';
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

// "#14 🦵 Leg press · Rope" — the icon after the number like the rows'
// badge. Entries snapshot the type flags but never the muscles, so the icon
// reads the LIVE machine while it exists and falls back to the entry's own
// flags (cardio, bodyweight) once it is gone.
const entryTitle = (e, layout) => `#${esc(e.num)} <span class="machine-icon" aria-hidden="true">${
  machineIcon(layout?.machines?.find((m) => m.id === e.machineId) ?? e)}</span> ${esc(e.label)}${
  variantStr(e) ? ` · ${esc(variantStr(e))}` : ''}`;

function workoutHtml(w, s, layout, open = false, readOnly = false) {
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
        <div>${entryTitle(e, layout)}</div>
        <div class="sets">${e.sets.map((st) => setStr(st, s, entryKind(e))).join(', ')}${settingsStr(e)}</div>
      </div>`).join('')}
    <button class="btn repeat-w" data-wid="${esc(w.id)}">Repeat this workout</button>
    <div class="row">${readOnly ? `
      <button class="btn btn-inline edit-open" data-wid="${esc(w.id)}">Edit ›</button>` : `
      <button class="btn btn-inline edit-w" data-wid="${esc(w.id)}">Edit</button>
      <button class="btn btn-inline btn-danger delete-w" data-wid="${esc(w.id)}">Delete</button>`}
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
        // the opened editor above pushed the notice off-screen
        keepInView(root, '#past-msg');
      }
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

// The grip of a logged entry, fixable afterwards — at a machine that offers
// grips. A grip another entry of this workout already holds for the same
// exercise is disabled: a series reads ONE entry per workout, so two would
// silently drop one of them from the chart.
const gripTaken = (w, ei, grip) => w.entries.some((x, xi) => xi !== ei
  && sameSeries(x, { ...w.entries[ei], grip }));
function gripChips(w, e, ei, layout, msg = null) {
  const grips = layout?.machines.find((m) => m.id === e.machineId)?.grips ?? [];
  if (!grips.length) return '';
  return `<div class="chip-select entry-grips">${grips.map((g) => {
    const sel = e.grip === g;
    return `<button type="button" class="chip sm entry-grip${sel ? ' sel' : ''}" data-ei="${ei}"
      data-grip="${esc(g)}"${!sel && gripTaken(w, ei, g) ? ' disabled' : ''}>${esc(g)}</button>`;
  }).join('')}</div>${msg?.ei === ei ? `<p class="muted grip-msg" role="status">${esc(msg.text)}</p>` : ''}`;
}

function editWorkoutHtml(w, s, layout, gripMsg = null) {
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
        <div class="spread"><div>${entryTitle(e, layout)}</div>
          <button class="x entry-del" data-ei="${ei}"
            aria-label="Remove ${esc(e.label)} from this workout">✕</button></div>
        ${gripChips(w, e, ei, layout, gripMsg)}
        ${e.sets.map((st, si) => `
          <div class="set-row">
            <span>Set ${si + 1}</span>
            <span class="edit-set">${e.cardio ? `
              <input type="text" inputmode="decimal" autocomplete="off" data-kind="distance"
                class="edit-distance" data-ei="${ei}" data-si="${si}"
                value="${esc(st.distance)}" aria-label="Distance (${du})"> ${du} ·
              <input type="text" inputmode="numeric" autocomplete="off" data-kind="time"
                class="edit-minutes" data-ei="${ei}" data-si="${si}"
                value="${fmtDuration(st.seconds)}" aria-label="Time (m:ss)"> · L
              <input type="number" inputmode="numeric" class="edit-level" data-ei="${ei}" data-si="${si}"
                value="${st.level >= 1 ? esc(st.level) : ''}" aria-label="Level">` : `
              ${e.bodyweight ? 'BW+' : e.assisted ? '−' : ''}<input type="text" inputmode="decimal" autocomplete="off" data-kind="decimal" class="edit-weight"
                data-ei="${ei}" data-si="${si}" value="${esc(st.weight)}"
                aria-label="${e.bodyweight ? 'Extra weight' : e.assisted ? 'Assist' : 'Weight'} (${esc(s.unit)})"> ${esc(s.unit)} ×
              <input type="number" inputmode="numeric" class="edit-reps" data-ei="${ei}" data-si="${si}"
                value="${esc(st.reps)}" aria-label="Reps">`}
            </span>
            <button class="x set-del" data-ei="${ei}" data-si="${si}" aria-label="Remove set ${si + 1}">✕</button>
          </div>`).join('') || '<p class="muted">No sets left — removed on save.</p>'}
        <button class="btn btn-inline set-add" data-ei="${ei}">+ Set</button>
      </div>`).join('')}
    ${addable.length ? `
    <div class="row">
      <select class="entry-pick" aria-label="Machine to add">
        ${addable.map((m) => `<option value="${esc(m.id)}">#${esc(m.num)} ${esc(m.label)}</option>`).join('')}
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
