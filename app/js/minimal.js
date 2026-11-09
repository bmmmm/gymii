// Minimal mode — the Train ROUTE as one screen: tap a series, confirm ONE
// value, done. app.js renders this instead of renderTrain while the
// device-local `settings.minimal` is on (and hides the tabbar); the full app
// is one tap on the same "Minimal" chip away. Both views write the SAME
// records: the running workout is the one `active` the full view continues
// (slots, visits and entries through the shared helpers), so History, sync,
// backups and the stats need no migration. The one new shape is a weighted
// set without reps ({weight, at}) — see docs/architecture.md § store.js.
//
// The fun: motifs and one-liners on a fixed layer OUTSIDE #view (a
// re-render never cuts one off), pointer-events none, aria-hidden, only
// transform/opacity animated, every sprite gone within ~2.5 s, paused while
// the page is hidden, still under prefers-reduced-motion (the line stays,
// as calm text), off with `settings.minimalFun === false`. The set is
// stored BEFORE any of it starts.
//
// Imports train.js (the prefill, the workout start, the slot and rest
// helpers); train.js imports nothing from here — no cycle.

import {
  getLayout, saveLayout, getSettings, saveSettings, getActive, saveActive, getWorkouts, getPlans,
  finishWorkout, ensureMachine, nextNum, newEntry, switchMachine, lastEntryIn, distUnit,
} from './store.js';
import { sameSeries, seriesKey, startOfDay } from './stats.js';
import {
  startWorkoutFrom, nextSetDefaults, ensureSlot, endRest, restLeft, syncWorkoutLock, openBuilder,
} from './train.js';
import {
  esc, stepperField, fieldValue, parseDistance, parseDuration, setStr, twoTapConfirm, keepInView,
  entryKind, machineIcon, variantStr, minimalToggleHtml, wireMinimalToggle, plural, minsBetween, fmtTime,
  reroute,
} from './ui.js';
import { ensurePersisted } from './persist.js';
import { ambientFinished } from './sync.js';

// A workout whose newest set is older than this is over: the next open of
// the view saves it, ending at that set (finishWorkout's `now`).
export const AUTO_CLOSE_MS = 3 * 60 * 60 * 1000;
// A first set after this long without any workout is a comeback.
export const COMEBACK_MS = 14 * 24 * 60 * 60 * 1000;
// The idle stroller: never more often than this, and only while visible.
export const IDLE_MS = 45 * 1000;
// Chips shown before "+N more" (the selected one always shows).
const CHIP_LIMIT = 8;

// --- pure logic (exported for test/minimal.test.mjs) ---

// The second field a series can switch on, per kind: strength and assisted
// log the weight and may add reps, bodyweight logs reps and may add weight
// (ADDED weight), cardio logs time + distance and may add the level.
export const EXTRA_FIELD = { strength: 'reps', assisted: 'reps', bodyweight: 'weight', cardio: 'level' };
const KNOWN_EXTRAS = new Set(Object.values(EXTRA_FIELD));
export const EXTRA_LABEL = { reps: '+ Reps', weight: '+ Weight', level: '+ Level' };

// `settings.minimalExtras` = { "<machineId>|<exercise or empty>": ["reps"] },
// device-local. A backup restores it from a file someone may have written,
// so it is read defensively: only own keys, only arrays, only known field
// names — anything else counts as nothing. It never reaches markup.
export const extrasKey = (machineId, exercise = null) => `${machineId}|${exercise ?? ''}`;
const extrasMap = (settings) => {
  const raw = settings?.minimalExtras;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
};
export function readExtras(settings, key) {
  const map = extrasMap(settings);
  const list = Object.hasOwn(map, key) ? map[key] : null;
  return Array.isArray(list) ? [...new Set(list.filter((f) => typeof f === 'string' && KNOWN_EXTRAS.has(f)))] : [];
}
export const extraOn = (settings, key, field) => readExtras(settings, key).includes(field);

// The map with `field` flipped for `key`, every entry cleaned on the way
// (fromEntries: a "__proto__" key stays a plain own key). An emptied list
// goes, an emptied map is absent.
export function toggleExtra(settings, key, field) {
  const entries = Object.keys(extrasMap(settings)).map((k) => [k, readExtras(settings, k)]);
  const cur = readExtras(settings, key);
  const next = cur.includes(field) ? cur.filter((f) => f !== field) : [...cur, field];
  const out = entries.filter(([k]) => k !== key);
  if (next.length) out.push([key, next]);
  return Object.fromEntries(out.filter(([, list]) => list.length));
}

// One chip per SERIES — store's triple (machine, exercise, grip): a rope and
// a V-bar are two progressions. Recently trained first (the running
// workout's entries and the history's, by their newest set; a set without
// `at` counts as its workout's start), each once; then every other machine
// of the gym by number — a machine of several exercises offers each. Only
// what the full view could log too: the machine must exist, a multi-exercise
// machine needs one of ITS exercises, a grip one of its grips.
export function seriesChips({ workouts = [], active = null, layout = null } = {}) {
  const byId = new Map((layout?.machines ?? []).map((m) => [m.id, m]));
  const seen = new Set();
  const out = [];
  const add = (machineId, exercise, grip, at) => {
    const machine = byId.get(machineId);
    if (!machine) return;
    const exs = machine.exercises ?? [];
    if (exs.length ? !exs.includes(exercise) : exercise != null) return;
    if (grip != null && !(machine.grips ?? []).includes(grip)) return;
    const sel = { machineId, exercise: exercise ?? null, grip: grip ?? null };
    const key = seriesKey(sel);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...sel, machine, at });
  };
  const trained = [];
  const collect = (entries, fallback) => (entries ?? []).forEach((e) => {
    if (!e?.sets?.length) return;
    const at = e.sets.reduce((mx, st) => Math.max(mx, Number.isFinite(st.at) ? st.at : fallback), -Infinity);
    trained.push({ e, at });
  });
  if (active) collect(active.entries, active.startedAt);
  workouts.forEach((w) => collect(w.entries, w.startedAt));
  trained.sort((a, b) => b.at - a.at)
    .forEach(({ e, at }) => add(e.machineId, e.exercise ?? null, e.grip ?? null, at));
  [...byId.values()].sort((a, b) => a.num - b.num).forEach((m) => {
    (m.exercises?.length ? m.exercises : [null]).forEach((x) => add(m.id, x, null, null));
  });
  return out;
}

// What one set of this kind is, as the record counts it: strength the
// heaviest weight, assisted the least assist, bodyweight the most reps,
// cardio the longest distance — at the same distance the shorter time
// (stats.js topCardio). `earlier` = every set of the series before this
// one; with none, nothing is beaten: a series' very first set is no record.
export function isNewBest(kind, set, earlier) {
  const fin = (v) => Number.isFinite(v);
  if (kind === 'cardio') {
    const prev = earlier.filter((st) => fin(st.distance));
    if (!prev.length || !fin(set.distance)) return false;
    const far = Math.max(...prev.map((st) => st.distance));
    if (set.distance !== far) return set.distance > far;
    const times = prev.filter((st) => st.distance === far && fin(st.seconds)).map((st) => st.seconds);
    return times.length > 0 && fin(set.seconds) && set.seconds < Math.min(...times);
  }
  const field = kind === 'bodyweight' ? 'reps' : 'weight';
  const prev = earlier.map((st) => st[field]).filter(fin);
  if (!prev.length || !fin(set[field])) return false;
  return kind === 'assisted' ? set[field] < Math.min(...prev) : set[field] > Math.max(...prev);
}

// Every earlier set of a series of this kind — the history's entries and
// the running workout's (the entry's flags are its type, as in stats.js).
export function seriesSets(sel, kind, { workouts = [], active = null } = {}) {
  return [...workouts.flatMap((w) => w.entries), ...(active?.entries ?? [])]
    .filter((e) => sameSeries(e, sel) && entryKind(e) === kind)
    .flatMap((e) => e.sets);
}

// Which line a logged set earns, decided on the state BEFORE it is stored:
// a new best, else — the first set of the day — a comeback after a long
// pause or a plain first set, else a set.
export function occasionFor({ best = false, now = Date.now(), workouts = [], active = null } = {}) {
  if (best) return 'best';
  const dayStart = startOfDay(now).getTime();
  const times = [
    ...workouts.flatMap((w) => [w.startedAt, w.finishedAt]),
    ...(active?.entries ?? []).flatMap((e) => e.sets.map((st) => st.at)),
  ].filter((t) => Number.isFinite(t) && t <= now);
  if (times.some((t) => t >= dayStart)) return 'set';
  const prev = times.reduce((mx, t) => Math.max(mx, t), -Infinity);
  return Number.isFinite(prev) && now - prev >= COMEBACK_MS ? 'comeback' : 'firstOfDay';
}

// Short, friendly-silly English one-liners, by occasion. The rules: never
// about bodies or weight loss, never guilt or pressure, no real people, no
// brands. A comeback is a welcome, never a "where were you".
export const LINES = {
  set: [
    'Gravity filed a complaint.',
    'Logged. The universe took notes.',
    'Somewhere, a dumbbell is blushing.',
    'The plates applauded quietly.',
    'Smooth like a freshly oiled pulley.',
    'One more for the scrapbook.',
    'Physics just nodded approvingly.',
    'The machine would give you five stars.',
    'Tidy work. Very tidy.',
    'That set has entered the archives.',
    'The barbell says thanks for stopping by.',
    'Your future self sends a thumbs-up.',
    'Nice and steady wins the set.',
    'The log is proud of you.',
  ],
  best: [
    'New personal best! Confetti department, go!',
    'Record broken. Somebody fetch the record keeper.',
    'New best — gravity is rethinking its career.',
    'That is a new high score!',
    'Best ever. The dumbbells want an autograph.',
    'New record! The plates are throwing a party.',
    'Top of your chart. Literally.',
    'Personal best unlocked. The lights flickered in awe.',
    'A new peak. Plant a tiny flag.',
  ],
  done: [
    "That's a wrap. Roll the credits.",
    'Workout saved. Victory lap optional.',
    'Done! The machines will tell stories about today.',
    'All logged. Go be wonderful elsewhere.',
    'Finished. The parade is on its way.',
    'Done and dusted.',
    'Saved. See you next time, champ.',
    'Curtain call. Take a bow.',
  ],
  firstOfDay: [
    'And so it begins.',
    "The day's first set is in. Off we go!",
    'Opening act: nailed.',
    "First set of the day — and it's a good one.",
    'Good to see you. The log says hello.',
    'Kick-off! The rest of the day can wait.',
  ],
  comeback: [
    'Look who is back! The machines saved your spot.',
    'Welcome back — the dumbbells kept your seat warm.',
    'Hello again! Right where you left off.',
    'The return of the regular. Fanfare, please.',
    'Welcome back. Everything is just where you left it.',
    'Back in action. The gym missed your playlist.',
  ],
};

// One line for an occasion, never the one said last (`last`) — `rand` is
// injectable so the tests pick deterministically.
export function pickLine(occasion, { rand = Math.random, last = null } = {}) {
  const pool = LINES[occasion] ?? LINES.set;
  const options = pool.length > 1 ? pool.filter((l) => l !== last) : pool;
  const i = Math.min(options.length - 1, Math.floor(Math.max(0, rand()) * options.length));
  return options[i];
}

// What a moment gets on screen: a motion (or none) and a line occasion (or
// none). Fun off = nothing at all; reduced motion = the line alone. The idle
// stroller says nothing — a line every 45 s would talk over the training.
const MOTION = { set: 'toss', firstOfDay: 'toss', comeback: 'toss', best: 'rain', done: 'parade', idle: 'stroll' };
export function funPlan(settings, occasion, { reduced = false } = {}) {
  if (settings?.minimalFun === false || !MOTION[occasion]) return null;
  const line = occasion === 'idle' ? null : occasion;
  const motion = reduced ? null : MOTION[occasion];
  return motion || line ? { motion, line } : null;
}

// The decision behind the auto-close: a running workout whose newest set
// (else its start, for sets that predate `at`) is older than AUTO_CLOSE_MS
// is saved, ending at that set; one with no set at all and that old is
// dropped. null while it is still current.
export function staleWorkout(active, now = Date.now()) {
  if (!active || !Array.isArray(active.entries)) return null;
  const sets = active.entries.flatMap((e) => e.sets ?? []);
  if (!sets.length) {
    return Number.isFinite(active.startedAt) && now - active.startedAt > AUTO_CLOSE_MS
      ? { action: 'discard' } : null;
  }
  const at = sets.reduce((mx, st) => Math.max(mx, Number.isFinite(st.at) ? st.at : -Infinity), -Infinity);
  const last = Number.isFinite(at) ? at : active.startedAt;
  return Number.isFinite(last) && now - last > AUTO_CLOSE_MS ? { action: 'finish', at: last } : null;
}

// The set a tap logs — exactly the fields on screen: the kind's one field
// (cardio: two), the series' extra when it is switched on, and `at`. A
// field that is not shown is ABSENT — never 0, never null. A level shows
// 0 for none and is written only from 1 up, like the full view's.
export function buildSet(kind, v, extra, at) {
  if (kind === 'cardio') {
    return {
      distance: v.distance, seconds: v.seconds,
      ...(extra && v.level >= 1 ? { level: Math.round(v.level) } : {}), at,
    };
  }
  if (kind === 'bodyweight') return { reps: v.reps, ...(extra ? { weight: v.weight } : {}), at };
  return { weight: v.weight, ...(extra ? { reps: v.reps } : {}), at };
}

// The machine a typed name means: one whose label matches it, ignoring case
// and repeated spaces — "+ New" picks it instead of minting a twin.
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
export const machineNamed = (layout, name) =>
  (norm(name) ? (layout?.machines ?? []).find((m) => norm(m.label) === norm(name)) ?? null : null);

// Closes a stale running workout (staleWorkout) — on every render of this
// view and in the log tap, before anything is read for the screen.
export function autoClose(now = Date.now()) {
  const active = getActive();
  const d = staleWorkout(active, now);
  if (!d) return null;
  const saved = finishWorkout(active, d.action === 'finish' ? { now: d.at } : {});
  if (saved) ambientFinished();
  return saved;
}

// --- module state (the view's, never the data's) ---

let pick = null; // the series on screen: { machineId, exercise, grip }
let adding = null; // the "+ New" form, open: { name }
let showAll = false; // "+N more" unfolded
let lastLine = null; // the line said last, never said twice in a row
let lastFunAt = 0; // when a motif last ran (the idle stroller waits IDLE_MS)

const kindOf = (machine, entry) => (entry?.sets.length ? entryKind(entry) : entryKind(machine));
const findEntry = (active, sel) => active?.entries.find((e) => sameSeries(e, sel)) ?? null;
const sameSel = (a, b) => !!a && !!b && seriesKey(a) === seriesKey(b);

// --- the view ---

// `entry`: app.js's route entry — the series on screen follows the running
// workout's current machine there (it may have moved in the full view).
export function renderMinimal(root, { entry = false, notice = '' } = {}) {
  const closed = autoClose();
  // the 'workout'-scoped wake lock follows the workout here too: this view
  // re-renders after every log and Done, and an auto-close lands above
  syncWorkoutLock();
  const s = getSettings();
  const layout = getLayout();
  const workouts = getWorkouts();
  const active = getActive();
  const chips = seriesChips({ workouts, active, layout });

  const current = active?.currentMachineId
    ? chips.find((c) => c.machineId === active.currentMachineId
      && (c.exercise ?? null) === (active.currentExercise ?? null)
      && (active.currentGrip == null || c.grip === active.currentGrip))
      ?? chips.find((c) => c.machineId === active.currentMachineId)
    : null;
  if (entry && current) pick = current;
  if (!chips.some((c) => sameSel(c, pick))) pick = current ?? chips[0] ?? null;
  if (!chips.length && !adding) adding = { name: '' };
  const sel = pick ? chips.find((c) => sameSel(c, pick)) : null;
  // what the log card shows and its taps read: computed once per render
  const ctx = sel && !adding ? logContext(sel, s, workouts, active) : null;

  const msg = notice || (closed ? `Your last workout was saved — it ended at ${fmtTime(closed.finishedAt)}.` : '');
  const funOn = s.minimalFun !== false;
  // a plan waiting in the builder (an AI import lands there, a half-built
  // one stays there) has no screen here — say so, one tap back to it. A
  // running workout outranks the builder in the full view too: not then.
  const waiting = active ? null : openBuilder();
  const waitingPlan = waiting?.planId ? getPlans().find((p) => p.id === waiting.planId) : null;
  const waitingHtml = waiting ? `
      <div class="min-plan" id="min-plan">
        <p class="muted">${waitingPlan
    ? `Plan "${esc(waitingPlan.name || 'unnamed')}" is waiting for review in the plan builder.`
    : 'A new plan is waiting in the plan builder.'} Minimal mode has no plans.</p>
        <button type="button" id="min-plan-open" class="btn btn-inline">Open the plan builder</button>
      </div>` : '';

  // the chips: the first CHIP_LIMIT and the selected one, the rest behind "+N more"
  const shown = showAll ? chips : chips.filter((c, i) => i < CHIP_LIMIT || c === sel);
  const hidden = chips.length - shown.length;
  const chipHtml = shown.map((c) => {
    const variant = variantStr(c);
    return `<button type="button" class="chip${c === sel && !adding ? ' sel' : ''}" data-i="${chips.indexOf(c)}"
      aria-pressed="${c === sel && !adding}"><span class="machine-icon" aria-hidden="true">${machineIcon(c.machine)}</span>
      ${esc(c.machine.label)}${variant ? ` <span class="muted">· ${esc(variant)}</span>` : ''}</button>`;
  }).join('');

  root.innerHTML = `
    <div id="min-view" class="minimal">
      <div class="view-head">
        <h1>Train</h1>
        <div class="view-head-actions">
          <button type="button" id="min-fun" class="chip mode-toggle${funOn ? ' sel' : ''}"
            aria-pressed="${funOn}">🎉 Fun</button>
          ${minimalToggleHtml(true)}
        </div>
      </div>
      ${msg ? `<p class="notice" role="status">${esc(msg)}</p>` : ''}
      ${waitingHtml}
      <div class="chip-select min-series" id="min-series">
        ${chipHtml}
        ${hidden ? `<button type="button" class="chip" data-more="1">+${hidden} more</button>` : ''}
        <button type="button" class="chip${adding ? ' sel' : ''}" id="min-new" aria-expanded="${!!adding}">+ New</button>
      </div>
      ${adding ? newFormHtml() : ctx ? logHtml(ctx, s, workouts) : ''}
      ${active ? '<button type="button" id="min-done" class="btn">Done</button>' : ''}
    </div>`;

  wireMinimalToggle(root);
  // the full view again — its Train route opens on the builder
  root.querySelector('#min-plan-open')?.addEventListener('click', () => {
    const { minimal: _off, ...rest } = getSettings();
    saveSettings(rest);
    reroute();
  });
  wireFun(root);
  wireSeries(root, chips);
  if (adding) wireNewForm(root);
  else if (ctx) wireLog(root, ctx, s);
  wireDone(root);
  armIdle();
}

// The series on screen: its entry in the running workout, its kind (the
// entry's once it holds sets — sets stay homogeneous — else the machine's),
// its extra field and whether that is on, and the prefill.
function logContext(sel, s, workouts, active) {
  const entry = findEntry(active, sel);
  const kind = kindOf(sel.machine, entry);
  const extraField = EXTRA_FIELD[kind];
  return {
    sel, entry, kind, extraField,
    extra: extraOn(s, extrasKey(sel.machineId, sel.exercise), extraField),
    def: defaultsFor(sel, kind, workouts, entry, s),
  };
}

function logHtml({ sel, entry, kind, extraField, extra, def }, s, workouts) {
  const { machine } = sel;
  const du = distUnit(s);
  const unit = esc(s.unit);
  const weightField = (label) => stepperField(`${label} (${unit})`, 'min-weight',
    { step: s.weightStep, min: 0, value: def.weight, kind: 'decimal' });
  const repsField = stepperField('Reps', 'min-reps', { step: 1, min: 1, value: def.reps, mode: 'numeric' });
  const main = kind === 'cardio' ? `
        ${stepperField('Time (m:ss)', 'min-time', { step: 60, min: 0, value: def.seconds, kind: 'time' })}
        ${stepperField(`Distance (${du})`, 'min-distance', { step: s.unit === 'kg' ? 100 : 0.1, min: 0, value: def.distance, kind: 'distance', metric: s.unit === 'kg' })}`
    : kind === 'bodyweight' ? repsField
      : weightField(kind === 'assisted' ? 'Assist' : 'Weight');
  const second = !extra ? '' : kind === 'cardio'
    ? stepperField('Level', 'min-level', { step: 1, min: 0, value: def.level ?? 0, mode: 'numeric' })
    : kind === 'bodyweight' ? weightField('Extra weight') : repsField;

  // today: this series' sets of the running workout (tap twice to remove)
  // and of the workouts already finished today (read-only)
  const dayStart = startOfDay(Date.now()).getTime();
  const earlier = workouts.filter((w) => w.startedAt >= dayStart)
    .flatMap((w) => w.entries.filter((e) => sameSeries(e, sel) && entryKind(e) === kind).flatMap((e) => e.sets));
  const mine = entry && entryKind(entry) === kind ? entry.sets : [];
  const todayHtml = earlier.length || mine.length ? `
      <div class="min-today" id="min-today">
        <span class="muted">Today</span>
        ${earlier.map((st) => `<span class="min-set-old">${setStr(st, s, kind)}</span>`).join('')}
        ${mine.map((st, i) => `<button type="button" class="chip sm min-set" data-i="${i}"${
    Number.isFinite(st.at) ? ` data-at="${esc(st.at)}"` : ''}>${setStr(st, s, kind)}</button>`).join('')}
      </div>` : '';

  const variant = variantStr(sel);
  return `
    <section class="card min-log" data-focus-context>
      <div class="min-title"><span class="machine-icon" aria-hidden="true">${machineIcon(machine)}</span>
        ${esc(machine.label)}${variant ? ` <span class="muted">· ${esc(variant)}</span>` : ''}</div>
      <div class="min-fields">${main}</div>
      <div class="min-extra-row">
        <button type="button" id="min-extra" class="chip${extra ? ' sel' : ''}" aria-pressed="${extra}"
          data-field="${extraField}">${EXTRA_LABEL[extraField]}</button>
      </div>
      ${second ? `<div class="min-fields">${second}</div>` : ''}
      ${todayHtml}
      <button type="button" id="min-log" class="btn btn-primary btn-big">✓ Log</button>
    </section>`;
}

// The prefill: train.js's nextSetDefaults over this workout's entry (once a
// set is logged it is the truth) and the history's last entry of the series
// — no plan target, Minimal mode has no plans.
function defaultsFor(sel, kind, workouts, entry, s) {
  const last = lastEntryIn(workouts, sel.machineId, sel.exercise, sel.grip,
    { anyGrip: !(sel.machine.grips ?? []).length });
  const lastSets = last && entryKind(last) === kind ? last : null;
  const own = entry && entryKind(entry) === kind ? entry : { sets: [] };
  return nextSetDefaults(own, lastSets, kind, s);
}

const newFormHtml = () => `
    <section class="card min-new" data-focus-context>
      <h2>New exercise</h2>
      <input id="min-new-name" type="text" autocomplete="off" enterkeyhint="done"
        placeholder="Name, e.g. Leg press" value="${esc(adding?.name ?? '')}">
      <p class="muted" id="min-new-msg">What do you log there?</p>
      <div class="chip-select" id="min-new-kind">
        <button type="button" class="chip" data-kind="strength">Weight</button>
        <button type="button" class="chip" data-kind="bodyweight">Reps</button>
        <button type="button" class="chip" data-kind="cardio">Time + distance</button>
      </div>
    </section>`;

function wireSeries(root, chips) {
  root.querySelector('#min-series')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.id === 'min-new') {
      adding = adding ? null : { name: '' };
      renderMinimal(root);
      if (adding) keepInView(root, '#min-new-name', { focus: true });
      return;
    }
    if (chip.dataset.more) {
      showAll = true;
      renderMinimal(root);
      return;
    }
    const c = chips[Number(chip.dataset.i)];
    if (!c) return;
    pick = { machineId: c.machineId, exercise: c.exercise, grip: c.grip };
    adding = null;
    showAll = false;
    renderMinimal(root);
  });
}

function wireFun(root) {
  const btn = root.querySelector('#min-fun');
  btn?.addEventListener('click', () => {
    const cur = getSettings();
    const on = cur.minimalFun === false; // flipped: off → on
    const { minimalFun, ...rest } = cur;
    saveSettings(on ? rest : { ...rest, minimalFun: false });
    // in place: the chip is under the thumb, nothing else changes
    btn.classList.toggle('sel', on);
    btn.setAttribute?.('aria-pressed', String(on));
    if (!on) stage?.clear();
  });
}

function wireNewForm(root) {
  const input = root.querySelector('#min-new-name');
  input?.addEventListener('input', () => { if (adding) adding.name = input.value; });
  root.querySelector('#min-new-kind')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const name = String(input?.value ?? adding?.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) {
      const m = root.querySelector('#min-new-msg');
      if (m) m.textContent = 'Type a name first.';
      input?.focus?.();
      return;
    }
    const machine = createOrFind(name, chip.dataset.kind);
    pick = { machineId: machine.id, exercise: machine.exercises?.[0] ?? null, grip: null };
    adding = null;
    renderMinimal(root);
    keepInView(root, '#min-log');
  });
}

// "+ New": a name that matches a machine IS that machine (no twin). Else a
// machine is created — ensureMachine reads and saves the layout in the tap —
// and its kind flag goes onto the layout read fresh right after, in the same
// tap: a render-time copy would tombstone whatever synced in meanwhile.
function createOrFind(name, kind) {
  const known = machineNamed(getLayout(), name);
  if (known) return known;
  const { machine } = ensureMachine(nextNum(getLayout()), name);
  if (kind === 'cardio' || kind === 'bodyweight') {
    const layout = getLayout();
    const stored = layout?.machines.find((m) => m.id === machine.id);
    if (stored) {
      stored[kind] = true;
      saveLayout(layout);
      return stored;
    }
  }
  return machine;
}

function wireLog(root, { sel, kind, extraField, def }, s) {
  const field = (id) => fieldValue(root.querySelector(id) ?? { value: '' });
  const key = extrasKey(sel.machineId, sel.exercise);

  // an unreadable field logs its prefill, never a zero (the full view's rule)
  const read = () => {
    const level = Math.round(parseFloat(field('#min-level')));
    return {
      weight: Math.max(0, parseDistance(field('#min-weight'), false) ?? def.weight),
      reps: Math.max(1, Math.round(parseFloat(field('#min-reps')))) || def.reps,
      distance: parseDistance(field('#min-distance'), s.unit === 'kg') ?? def.distance,
      seconds: parseDuration(field('#min-time')) ?? def.seconds,
      level: Number.isFinite(level) ? level : def.level ?? 0,
    };
  };

  // the extra's field appears BELOW its chip, so the chip stays put
  root.querySelector('#min-extra')?.addEventListener('click', () => {
    const cur = getSettings();
    saveSettings({ ...cur, minimalExtras: toggleExtra(cur, key, extraField) });
    renderMinimal(root);
  });

  root.querySelector('#min-log')?.addEventListener('click', () => logSet(root, sel, kind, read()));

  // a logged set is gone for good: the first tap only arms ("✕ remove?")
  // and must NOT re-render, or the armed chip dies before the second tap
  root.querySelector('#min-today')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.min-set');
    if (!btn) return;
    btn.dataset.label ??= btn.textContent;
    if (!twoTapConfirm(btn, '✕ remove?', btn.dataset.label)) return;
    const active = getActive();
    const entry = findEntry(active, sel);
    if (!entry) { renderMinimal(root); return; }
    // the rendered index, checked against the set's stamp — two sets may
    // share a millisecond, so the stamp alone could pick the wrong one;
    // only when the list moved under the chip (another tab) does it search
    const i0 = Number(btn.dataset.i);
    const at = btn.dataset.at != null ? Number(btn.dataset.at) : null;
    const i = at == null || entry.sets[i0]?.at === at ? i0 : entry.sets.findIndex((st) => st.at === at);
    if (i >= 0 && i < entry.sets.length) {
      entry.sets.splice(i, 1);
      saveActive(active);
    }
    renderMinimal(root);
    keepInView(root, '#min-log');
  });
}

// The log tap: everything read IN the tap (layout, workout, history), the
// set stored, the screen re-rendered — and only then the fun.
function logSet(root, sel, kind, values) {
  const now = Date.now();
  const closed = autoClose(now);
  const notice = closed ? `Your last workout was saved (it ended at ${fmtTime(closed.finishedAt)}) — this set starts a new one.` : '';
  const layout = getLayout();
  const machine = layout?.machines.find((m) => m.id === sel.machineId);
  if (!machine) {
    renderMinimal(root, { notice: 'That machine is gone — pick another one.' });
    return;
  }
  const s = getSettings();
  const workouts = getWorkouts();
  let active = getActive();
  const entryBefore = findEntry(active, sel);
  if (kindOf(machine, entryBefore) !== kind) { // retyped since the render (sync, another tab)
    renderMinimal(root, { notice: 'This exercise changed — check the value and log again.' });
    return;
  }
  const extra = extraOn(s, extrasKey(sel.machineId, sel.exercise), EXTRA_FIELD[kind]);
  const set = buildSet(kind, values, extra, now);
  const occasion = occasionFor({
    best: isNewBest(kind, set, seriesSets(sel, kind, { workouts, active })), now, workouts, active,
  });

  // the first set starts the workout, through the one start the full view
  // uses; a running one (from either view, plan slots and all) goes on
  if (!active) {
    startWorkoutFrom(null, machine.id);
    active = getActive();
  }
  if (active.currentMachineId !== machine.id || (active.currentExercise ?? null) !== sel.exercise
    || active.currentGrip === undefined || (active.currentGrip ?? null) !== sel.grip) {
    switchMachine(active, machine.id, sel.exercise, { grip: sel.grip, now });
  }
  if (Array.isArray(active.plan) && active.plan.every((p) => p && typeof p === 'object')) {
    ensureSlot(active, machine.id, sel.exercise, sel.grip);
  }
  let entry = findEntry(active, sel);
  if (entry && !entry.sets.length && entryKind(entry) !== entryKind(machine)) { // retyped while empty
    active.entries.splice(active.entries.indexOf(entry), 1);
    entry = null;
  }
  if (!entry) {
    entry = newEntry(machine, sel.exercise, [], sel.grip);
    const last = lastEntryIn(workouts, machine.id, sel.exercise, sel.grip, { anyGrip: !(machine.grips ?? []).length });
    machine.settingsFields.forEach((f) => { entry.settings[f] = last?.settings?.[f] ?? ''; });
    active.entries.push(entry);
  }
  entry.sets.push(set);
  // a bind prompt left open in the full view ("Which machine is this?")
  // was asked about a plan step; a set logged here moved on from it, as
  // Skip there would — the step stays unbound and is asked again later,
  // never bound to this machine by guess
  delete active.binding;
  // no rest timer here: like a set logged with rest 0 in the full view, it
  // ends a rest still running from there
  const resting = restLeft(active) > 0;
  delete active.restUntil;
  try {
    saveActive(active);
  } catch (err) {
    renderMinimal(root); // the screen shows what IS stored
    throw err;
  }
  if (resting) endRest();
  showAll = false;
  renderMinimal(root, { notice });
  keepInView(root, '#min-log'); // the today line just grew above it
  celebrate(occasion);
}

function wireDone(root) {
  const btn = root.querySelector('#min-done');
  btn?.addEventListener('click', () => {
    const active = getActive();
    if (!active) { renderMinimal(root); return; }
    const sets = active.entries.reduce((n, e) => n + e.sets.length, 0);
    if (!twoTapConfirm(btn, sets ? 'Tap again to finish' : 'Tap again to discard', 'Done')) return;
    const saved = finishWorkout(active);
    endRest(); // the workout is over, so is its rest — no tone at the old zero
    if (saved) ensurePersisted();
    ambientFinished();
    const n = saved ? saved.entries.reduce((k, e) => k + e.sets.length, 0) : 0;
    renderMinimal(root, {
      notice: saved ? `Workout saved: ${minsBetween(saved.startedAt, saved.finishedAt)} min, ${plural(n, 'set')}.`
        : 'Workout discarded — no sets were logged.',
    });
    keepInView(root, '.notice'); // Done is gone; what it did is said up top
    if (saved) celebrate('done');
  });
}

// --- the fun ---

// The stage the fun plays on. In a browser a fixed layer on <body>; tests
// swap in a recorder (setFunStage). Node has no document: nothing plays.
let stage = null;
export function setFunStage(next) {
  const prev = stage;
  stage = next;
  return prev;
}

const reducedMotion = () => typeof window !== 'undefined'
  && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function celebrate(occasion, { rand = Math.random } = {}) {
  const plan = funPlan(getSettings(), occasion, { reduced: reducedMotion() });
  if (!plan || !stage) return null;
  const line = plan.line ? pickLine(plan.line, { rand, last: lastLine }) : null;
  if (line) lastLine = line;
  if (plan.motion) lastFunAt = Date.now();
  stage.play(plan.motion, line);
  return { ...plan, text: line };
}

// The idle stroller: checked every 15 s while this view is on screen; at
// most every IDLE_MS since the last motif, only while visible, only in a
// running workout with a set logged (between sets), and only by chance.
let idleTimer = null;
function armIdle() {
  if (idleTimer || typeof document === 'undefined') return;
  idleTimer = setInterval(() => {
    if (!document.getElementById('min-view')) { clearInterval(idleTimer); idleTimer = null; return; }
    if (document.hidden || Date.now() - lastFunAt < IDLE_MS || Math.random() < 0.5) return;
    const a = getActive();
    if (!a?.entries.some((e) => e.sets.length)) return;
    celebrate('idle');
  }, 15000);
}

// The DOM stage. Emoji only (no image files, no colors of our own to
// validate); sprites are positioned once and then move by transform alone.
const MAX_SPRITES = 24;
const TOSSED = ['🏋️', '🥇', '⭐', '🏆', '🎈', '🍌', '🧦', '🥨'];
const RAIN = ['⭐', '🏆', '🥇', '🎉', '✨', '🌟', '🎊'];
const WALKERS = ['🐢', '🦆', '🐧', '🦔', '🐌', '🦖', '🐈', '🦙'];
const rnd = (a, b) => a + Math.random() * (b - a);
const any = (list) => list[Math.floor(Math.random() * list.length)];

function domStage() {
  let layer = null;
  let lineEl = null;
  const live = new Set();
  const ensure = () => {
    if (layer?.isConnected) return layer;
    layer = document.createElement('div');
    layer.id = 'fun-layer';
    layer.className = 'fun-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
    return layer;
  };
  // pause, never drop: a hidden page runs nothing, a visible one goes on
  document.addEventListener('visibilitychange', () => {
    live.forEach((a) => (document.hidden ? a.pause() : a.play()));
  });
  const sprite = (glyph, x, y, size, keyframes, opts) => {
    const host = ensure();
    if (host.childElementCount >= MAX_SPRITES) return;
    const el = document.createElement('span');
    el.className = 'fun-sprite';
    el.textContent = glyph;
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    el.style.fontSize = `${Math.round(size)}px`;
    host.appendChild(el);
    if (typeof el.animate !== 'function') { el.remove(); return; }
    const anim = el.animate(keyframes, { fill: 'both', ...opts });
    live.add(anim);
    const done = () => { live.delete(anim); el.remove(); };
    anim.onfinish = done;
    anim.oncancel = done;
    if (document.hidden) anim.pause();
  };
  const W = () => window.innerWidth;
  const H = () => window.innerHeight;
  // a gravity arc: decelerating up, accelerating down, one small bounce
  const toss = () => {
    const btn = document.getElementById('min-log')?.getBoundingClientRect();
    const x0 = btn ? btn.left + btn.width / 2 + rnd(-40, 40) : W() / 2;
    const y0 = btn ? btn.top - 30 : H() - 140;
    const dx = rnd(-90, 90);
    const room = Math.max(60, Math.min(300, y0 - 20)); // never out of the top
    const h = rnd(Math.min(160, room), room);
    const r = rnd(-260, 260);
    const at = (fx, fy, fr) => `translate(${dx * fx}px, ${-h * fy}px) rotate(${r * fr}deg)`;
    sprite(any(TOSSED), x0 - 16, y0, 32, [
      { transform: at(0, 0, 0), opacity: 0, easing: 'cubic-bezier(.2,.7,.4,1)' },
      { transform: at(0.08, 0.2, 0.05), opacity: 1, offset: 0.06, easing: 'cubic-bezier(.2,.7,.4,1)' },
      { transform: at(0.5, 1, 0.5), offset: 0.42, easing: 'cubic-bezier(.6,0,.8,.4)' },
      { transform: at(1, 0, 1), offset: 0.78, easing: 'cubic-bezier(.2,.7,.4,1)' },
      { transform: at(1.12, 0.16, 1.1), offset: 0.88, easing: 'cubic-bezier(.6,0,.8,.4)' },
      { transform: at(1.24, 0, 1.2), opacity: 1, offset: 0.96 },
      { transform: at(1.24, 0, 1.2), opacity: 0 },
    ], { duration: 1500 });
  };
  // a shower of motifs, falling with gravity and bouncing once at the bottom
  const rain = () => {
    const floor = H() - 70;
    for (let i = 0; i < 16; i++) {
      const x = rnd(8, W() - 40);
      const drop = floor + 40;
      const r = rnd(-180, 180);
      const fall = (fy, fr) => `translate(0, ${drop * fy}px) rotate(${r * fr}deg)`;
      sprite(any(RAIN), x, -40, rnd(22, 36), [
        { transform: fall(0, 0), opacity: 1, easing: 'cubic-bezier(.55,0,1,.45)' },
        { transform: fall(1, 0.8), offset: 0.7, easing: 'cubic-bezier(0,.55,.45,1)' },
        { transform: fall(0.9, 0.9), offset: 0.82, easing: 'cubic-bezier(.55,0,1,.45)' },
        { transform: fall(1, 1), opacity: 1, offset: 0.92 },
        { transform: fall(1, 1), opacity: 0 },
      ], { duration: rnd(1500, 1900), delay: rnd(0, 500) });
    }
    walk(any(WALKERS), 0, 2200);
  };
  // one figure across the bottom edge, right to left, hopping as it goes
  const walk = (glyph, delay = 0, duration = 2400) => {
    const y = H() - 64;
    const dist = W() + 100;
    const frames = Array.from({ length: 11 }, (_, k) => ({
      transform: `translate(${-dist * (k / 10)}px, ${k % 2 ? -8 : 0}px)`,
      ...(k === 0 || k === 10 ? { opacity: k === 0 ? 0.001 : 1 } : {}),
    }));
    frames[1].opacity = 1;
    sprite(glyph, W() + 20, y, 34, frames, { duration, delay, easing: 'linear' });
  };
  const parade = () => {
    const crew = [...WALKERS].sort(() => Math.random() - 0.5).slice(0, 5);
    crew.forEach((g, i) => walk(g, i * 180, 1600));
  };
  const say = (text) => {
    lineEl?.remove();
    const el = document.createElement('div');
    el.className = 'fun-line';
    el.textContent = text;
    ensure().appendChild(el);
    lineEl = el;
    const gone = () => { el.remove(); if (lineEl === el) lineEl = null; };
    if (reducedMotion() || typeof el.animate !== 'function') { setTimeout(gone, 2500); return; }
    const anim = el.animate([
      { opacity: 0, transform: 'translateY(8px) scale(0.96)' },
      { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.1 },
      { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.85 },
      { opacity: 0, transform: 'translateY(-6px) scale(1)' },
    ], { duration: 2400, easing: 'ease-out', fill: 'both' });
    live.add(anim);
    anim.onfinish = () => { live.delete(anim); gone(); };
    anim.oncancel = anim.onfinish;
    if (document.hidden) anim.pause();
  };
  const MOTIONS = { toss, rain, parade, stroll: () => walk(any(WALKERS)) };
  return {
    play(motion, line) {
      if (motion) MOTIONS[motion]?.();
      if (line) say(line);
    },
    clear() {
      [...live].forEach((a) => a.cancel());
      layer?.replaceChildren();
      lineEl = null;
    },
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') stage = domStage();
