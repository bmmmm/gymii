// All localStorage access lives here. Keys are versioned via a `v` field
// inside each object so future schema migrations have something to check.

const KEYS = {
  gyms: 'gymii.gyms',
  settings: 'gymii.settings',
};

// Layout, workouts and the active workout are stored per gym ("one gym,
// one history"); settings stay global.
const scopedKey = (gid, part) => `gymii.${gid}.${part}`;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// 16 chars of crypto-quality randomness (~82 bits) — enough that two
// devices minting ids offline can never realistically collide. Legacy
// 8-char Math.random() ids stay valid forever: every consumer compares
// ids opaquely. Deliberately NO device prefix — ids travel into AI
// exports and community template PRs, where a stable per-device marker
// would be a quiet fingerprint. (The slight modulo bias is irrelevant
// at id scales.)
export const uid = () => Array.from(
  crypto.getRandomValues(new Uint8Array(16)), (b) => (b % 36).toString(36)).join('');

// --- gyms ---
// gymii.gyms = { v:1, list:[{id,name}], activeId }. A gym is the CONTAINER:
// its own layout, workouts, plans and history, all under gymii.<id>.<part>.
// Created lazily.
//
// Two historical shapes migrate on first access, newest first:
//   1. the profile era — gymii.profiles, and a `gym` part per id (the name
//      `gym` then meant the layout)
//   2. a pre-profile install — top-level gymii.gym|workouts|active
// Both move raw strings (no parse, no reshape) and drop the old keys, so an
// older app version left open in another tab cannot diverge from them.

// Parts move FIRST, the registry last: the registry key is the commit
// signal, so a crash mid-migration replays harmlessly on the next access
// instead of orphaning a layout under a key nothing reads any more.
function migrateProfileEra() {
  const raw = localStorage.getItem('gymii.profiles');
  if (raw == null) return; // never a profile install, or already migrated
  try {
    JSON.parse(raw).list.forEach(({ id }) => {
      const old = localStorage.getItem(scopedKey(id, 'gym'));
      if (old != null && localStorage.getItem(scopedKey(id, 'layout')) == null) {
        localStorage.setItem(scopedKey(id, 'layout'), old);
      }
      localStorage.removeItem(scopedKey(id, 'gym'));
    });
  } catch { /* unreadable registry: it lands below and read() self-heals */ }
  localStorage.setItem(KEYS.gyms, raw);
  localStorage.removeItem('gymii.profiles');
}

function ensureGyms() {
  migrateProfileEra();
  let gyms = read(KEYS.gyms, null);
  if (gyms) return gyms;
  const id = uid();
  let name = 'My gym';
  const legacyLayout = localStorage.getItem('gymii.gym');
  if (legacyLayout) {
    try { name = JSON.parse(legacyLayout).name || name; } catch { /* keep default */ }
  }
  // pre-profile top-level keys; the one called 'gym' back then is the layout
  [['gym', 'layout'], ['workouts', 'workouts'], ['active', 'active']].forEach(([from, to]) => {
    const raw = localStorage.getItem(`gymii.${from}`);
    if (raw != null) {
      localStorage.setItem(scopedKey(id, to), raw);
      localStorage.removeItem(`gymii.${from}`);
    }
  });
  gyms = { v: 1, list: [{ id, name }], activeId: id };
  write(KEYS.gyms, gyms);
  return gyms;
}

const activeGymId = () => ensureGyms().activeId;

export function getGyms() {
  return ensureGyms();
}

// Creates a gym and makes it active. It starts without a layout; the Gym
// screen auto-creates one on first visit. `extra` lets a caller stamp
// identity onto the gym (demo.js marks its gym `demo: true` — names are
// user-editable and must never be an identity).
export function createGym(name, extra = {}) {
  const gyms = ensureGyms();
  const id = uid();
  gyms.list.push({
    id, name: String(name || '').trim() || 'New gym', updatedAt: Date.now(), ...extra,
  });
  gyms.activeId = id;
  write(KEYS.gyms, gyms);
  return id;
}

export function renameGym(id, name) {
  const gyms = ensureGyms();
  const g = gyms.list.find((x) => x.id === id);
  const trimmed = String(name || '').trim();
  if (!g || !trimmed) return;
  g.name = trimmed;
  g.updatedAt = Date.now();
  write(KEYS.gyms, gyms);
}

export function setActiveGym(id) {
  const gyms = ensureGyms();
  if (!gyms.list.some((g) => g.id === id)) return;
  gyms.activeId = id;
  write(KEYS.gyms, gyms);
}

// Refuses to delete the last remaining gym (returns false) — except the
// demo gym: Settings promises it can always be removed, so as the sole
// survivor it takes the registry with it and the next access self-heals
// into a fresh default (same recovery clearAll relies on).
// Deleting the active gym switches to the first remaining one.
export function deleteGym(id) {
  const gyms = ensureGyms();
  const gym = gyms.list.find((g) => g.id === id);
  if (!gym) return false;
  if (gyms.list.length <= 1 && !gym.demo) return false;
  gyms.list = gyms.list.filter((g) => g.id !== id);
  // registry-level tombstone: a gym deleted here must not come back from
  // another device's copy (its scoped keys are dropped wholesale, so no
  // finer-grained tombstones are needed inside a dead gym)
  gyms.deleted = [
    ...(gyms.deleted ?? []).filter((t) => t.id !== id), { id, at: Date.now() }];
  if (!gyms.list.length) {
    // demo-only survivor takes the registry (and its tombstones) with it —
    // the next access self-heals into a fresh default, same as clearAll
    localStorage.removeItem(KEYS.gyms);
  } else {
    if (gyms.activeId === id) gyms.activeId = gyms.list[0].id;
    write(KEYS.gyms, gyms);
  }
  ['layout', 'workouts', 'active', 'plans', 'tombstones']
    .forEach((part) => localStorage.removeItem(scopedKey(id, part)));
  return true;
}

// --- tombstones (sync groundwork) ---
// A delete must leave a trace or a future merge with another device would
// resurrect the record from the other side's copy. Sidecar lists — never
// in-object flags — so every existing read function keeps its contract
// (getWorkouts/getPlans never return dead items). Pruning is a transport
// concern (TTL), not handled here.

const emptyTombstones = () => ({ v: 1, workouts: [], plans: [], machines: [], shapes: [] });

export function getTombstones() {
  return { ...emptyTombstones(), ...read(scopedKey(activeGymId(), 'tombstones'), {}) };
}

export function saveTombstones(tombstones) {
  write(scopedKey(activeGymId(), 'tombstones'),
    { ...emptyTombstones(), ...tombstones });
}

function addTombstone(kind, id, at = Date.now()) {
  const t = getTombstones();
  t[kind] = [...t[kind].filter((x) => x.id !== id), { id, at }];
  saveTombstones(t);
}

// Canonical pick lists — selectable chips beat free text (fewer typos).
export const MUSCLE_GROUPS = [
  'Chest', 'Upper back', 'Lower back', 'Lats', 'Shoulders', 'Traps',
  'Biceps', 'Triceps', 'Forearms', 'Abs', 'Obliques',
  'Quads', 'Hamstrings', 'Glutes', 'Calves', 'Adductors', 'Abductors',
  'Full body',
];

export const ZONE_LABELS = [
  'Machines', 'Free weights', 'Cardio', 'Functional', 'Stretching',
  'Turf', 'Entrance', 'Changing room',
];

export const COMMON_SETTINGS = [
  'Seat', 'Seat angle', 'Back pad', 'Chest pad', 'Thigh pad', 'Shin pad',
  'Ankle pad', 'Arm pads', 'Pad height', 'Pulley height', 'Handle position',
  'Foot plate',
];

// --- layout template ---

export function getLayout() {
  const layout = read(scopedKey(activeGymId(), 'layout'), null);
  if (layout && !Array.isArray(layout.outline)) layout.outline = defaultOutline(layout.grid); // pre-outline layouts
  if (layout && !layout.meta) layout.meta = {}; // pre-meta layouts
  // heal machines from hand-edited/AI-produced imports — a missing
  // settingsFields would otherwise throw across Train and Gym
  layout?.machines.forEach((m) => {
    if (!Array.isArray(m.settingsFields)) m.settingsFields = [];
    if (!Array.isArray(m.muscles)) m.muscles = [];
  });
  return layout;
}

// Interactive save — the single choke point every editing surface (gym,
// train's quick start, create-on-miss, plan binding) already flows through.
// Diffs against the previously stored layout: a changed or new machine/shape
// gets `updatedAt` stamped, a vanished id gets a tombstone, and the
// structural rest (name/grid/meta/outline) carries one layout-level stamp.
// Bulk restore (imports, sync apply) must NOT re-diff or re-stamp — the
// incoming state owns its stamps — and uses restoreLayout below instead; the
// same interactive/bulk split saveWorkouts and savePlans get for free.
export function saveLayout(layout) {
  const key = scopedKey(activeGymId(), 'layout');
  const prev = read(key, null);
  const now = Date.now();
  const gone = [];
  ['machines', 'shapes'].forEach((coll) => {
    const before = new Map((prev?.[coll] ?? []).map((i) => [i.id, i]));
    (layout[coll] ?? []).forEach((item) => {
      const was = before.get(item.id);
      before.delete(item.id);
      if (!was || JSON.stringify(was) !== JSON.stringify(item)) item.updatedAt = now;
      else if (was.updatedAt != null) item.updatedAt = was.updatedAt;
    });
    before.forEach((_, id) => gone.push({ coll, id }));
  });
  const structural = ['name', 'grid', 'meta', 'outline'];
  if (!prev || structural.some((f) => JSON.stringify(prev[f]) !== JSON.stringify(layout[f]))) {
    layout.updatedAt = now;
  } else if (prev.updatedAt != null) {
    layout.updatedAt = prev.updatedAt;
  }
  write(key, layout);
  if (gone.length) {
    const t = getTombstones();
    gone.forEach(({ coll, id }) => {
      t[coll] = [...t[coll].filter((x) => x.id !== id), { id, at: now }];
    });
    saveTombstones(t);
  }
}

export function restoreLayout(layout) {
  write(scopedKey(activeGymId(), 'layout'), layout);
}

export function defaultOutline(grid) {
  return [
    { x: 0, y: 0 },
    { x: grid.w, y: 0 },
    { x: grid.w, y: grid.h },
    { x: 0, y: grid.h },
  ];
}

// Appends a machine near the grid center (loosely mirroring the gym's
// placement). Quick start and the picker's create-on-miss use this, so a
// layout can grow without ever opening the gym — arranging is optional.
export function addMachine(layout, num, label) {
  // 5 per row, next row below, wrapping inside the grid — plain modulo
  // would stack machine 1/6/11 on the same spot
  const n = layout.machines.length;
  const machine = {
    id: uid(), num, label,
    x: Math.round(2 + (n % 5) * 5) % Math.max(1, layout.grid.w - 4),
    y: Math.round(2 + Math.floor(n / 5) * 4) % Math.max(1, layout.grid.h - 3),
    w: 4, h: 3, settingsFields: [], muscles: [], docUrl: '',
  };
  layout.machines.push(machine);
  return machine;
}

// Resolves a machine number to a machine, CREATING it when the layout does not
// know that number — the layout grows out of the plan (or the note) instead of
// gating it. The new machine takes the item's own name, so it never lands
// as a nameless "Machine 14"; the note already said what kind of machine
// this is ("20min" reads as cardio), and a machine born here inherits that,
// or its target would be dropped as the wrong shape the moment it binds.
// Persists NOTHING: every caller keeps its own saveLayout timing (and its own
// newLayout, when there is no layout yet).
export function bindOrCreateMachine(layout, num, name, target = null) {
  const existing = layout.machines.find((m) => m.num === num);
  if (existing) return existing;
  const machine = addMachine(layout, num, name || `Machine ${num}`);
  if (target?.distance != null) machine.cardio = true;
  return machine;
}

export function newLayout(name = 'My layout') {
  const grid = { w: 60, h: 40 };
  return {
    v: 1, name, grid,
    meta: { address: '', city: '', country: '' },
    outline: defaultOutline(grid),
    shapes: [], machines: [],
  };
}

// --- workout history ---

export function getWorkouts() {
  return read(scopedKey(activeGymId(), 'workouts'), []);
}

// Chronological order is an INVARIANT of this list: "repeat last workout"
// reads the tail, lastEntryFor walks it backwards, and history renders it
// reversed. Logging a workout after the fact or editing a workout's date
// would otherwise silently misplace it, so sorting happens here — once,
// for every writer — instead of at each call site.
export function saveWorkouts(list) {
  write(scopedKey(activeGymId(), 'workouts'),
    list.slice().sort((a, b) => a.startedAt - b.startedAt));
}

// Deletes a workout by id; no-op if unknown.
export function deleteWorkout(id) {
  const list = getWorkouts();
  if (!list.some((w) => w.id === id)) return;
  addTombstone('workouts', id);
  saveWorkouts(list.filter((w) => w.id !== id));
}

// Replaces a workout's fields by id (inline history edits). Entries with
// zero sets are dropped, mirroring finishWorkout(); if none remain the
// whole workout is removed. Returns the updated workout, or null.
export function updateWorkout(patch) {
  const list = getWorkouts();
  const idx = list.findIndex((w) => w.id === patch.id);
  if (idx === -1) return null;
  const entries = patch.entries.filter((e) => e.sets.length);
  if (!entries.length) {
    // editing away the last set IS a delete — tombstoned like one
    addTombstone('workouts', patch.id);
    list.splice(idx, 1);
    saveWorkouts(list);
    return null;
  }
  const next = { ...list[idx], ...patch, entries, updatedAt: Date.now() };
  // a spread merge can't express key removal — an emptied locker or name
  // would otherwise silently resurrect from the stored workout
  if (!patch.locker) delete next.locker;
  if (!patch.name) delete next.name;
  list[idx] = next;
  saveWorkouts(list);
  return next;
}

// Most recent entry with at least one set for this machine — and, at
// multi-exercise machines, for this exercise (null matches entries logged
// without one). Returns null if nothing matches.
export function lastEntryFor(machineId, exercise = null) {
  const workouts = getWorkouts();
  for (let i = workouts.length - 1; i >= 0; i--) {
    const entry = workouts[i].entries.find(
      (e) => e.machineId === machineId && (e.exercise ?? null) === exercise);
    if (entry && entry.sets.length) return entry;
  }
  return null;
}

// A fresh history entry for this machine. num/label, the type flags and the
// exercise are SNAPSHOTTED here — history, the editor, the chart and the AI
// export read the entry, never the live machine, so a machine renamed or
// retyped later leaves logged workouts readable. Flags are absent unless
// true (strength carries neither). `settings` starts empty: what belongs in
// it depends on the caller (the log screen prefills from the last workout,
// the demo data from its own snapshots).
export function newEntry(machine, exercise = null, sets = []) {
  return {
    machineId: machine.id,
    num: machine.num,
    label: machine.label,
    ...(machine.cardio ? { cardio: true } : {}),
    ...(machine.bodyweight ? { bodyweight: true } : {}),
    ...(exercise ? { exercise } : {}),
    settings: {},
    sets,
  };
}

// --- workout plans ---
// A plan is an explicitly saved routine: ordered slots plus an optional
// per-slot target. Starting one feeds it straight into the guided flow
// (train.js startWorkoutFrom), so plans and repeats share one execution
// path. Shape:
//   { id, name, items: [{ machineId?, name?, num?, exercise|null,
//     target?: {sets,reps,weight} | {distance,seconds} }] }
// INVARIANT: an item carries a machineId (bound — it knows which machine)
// or a name (unbound — it knows the movement but not the machine yet), or
// both. Unbound items are what lets a plan exist before the layout does: a
// trainer's note is typed in, and each item binds to a machine the first
// time it is trained (train.js renderBind). `num` on an unbound item is a
// hint from the source note, not a binding — it prefills the bind prompt.
// A bound item's type comes from its machine; an unbound one's from the
// shape of its target (distance/seconds = cardio).

export function getPlans() {
  return read(scopedKey(activeGymId(), 'plans'), []);
}

export function savePlans(list) {
  write(scopedKey(activeGymId(), 'plans'), list);
}

// Upserts by id so the builder saves new and edited plans alike. A plan
// stamps `createdAt` the first time it is stored: weekday tracking must
// not report the Monday before a plan existed as a missed one. Plans from
// before this (and from backups) carry none and count as always-there.
export function savePlan(plan) {
  const list = getPlans();
  const idx = list.findIndex((p) => p.id === plan.id);
  plan.updatedAt = Date.now(); // every save, unlike createdAt's first-write-only
  if (idx === -1) list.push({ createdAt: Date.now(), ...plan });
  else list[idx] = plan;
  savePlans(list);
  return plan;
}

export function deletePlan(id) {
  const list = getPlans();
  if (!list.some((p) => p.id === id)) return;
  addTombstone('plans', id);
  savePlans(list.filter((p) => p.id !== id));
}

// --- weekday plans: what is due, what was missed, what today is for ---
// A plan tagged with weekdays turns the start screen into an answer to
// "what today is about" — including the answer "nothing", which is a real
// one. Tone is stated, never scolding: gymii reports, it does not nag.
// All of this is pure date maths over `now`, so it is testable without
// waiting for a Tuesday.

// Local midnight as a Date — THE day-boundary definition (demo.js imports
// it too; day arithmetic goes through setDate(), never DAY_MS multiples,
// which drift an hour across DST transitions).
export const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};
export const dayKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// The plan's most recent due day at or before `now` (today counts), or
// null when it carries no weekdays.
export function planDueDay(plan, now = Date.now()) {
  if (!plan.days?.length) return null;
  for (let back = 0; back < 7; back++) {
    const d = startOfDay(now);
    d.setDate(d.getDate() - back);
    if (plan.days.includes(d.getDay())) return d;
  }
  return null;
}

// The next due day strictly after today.
export function planNextDay(plan, now = Date.now()) {
  if (!plan.days?.length) return null;
  for (let ahead = 1; ahead <= 7; ahead++) {
    const d = startOfDay(now);
    d.setDate(d.getDate() + ahead);
    if (plan.days.includes(d.getDay())) return d;
  }
  return null;
}

// Was this plan trained since `since`? New workouts carry planId; older
// ones are matched by name, which is how a plan owned its routine before.
const planTrainedSince = (plan, workouts, since) => workouts.some((w) =>
  (w.planId === plan.id || (plan.name && w.name === plan.name))
  && w.startedAt >= since.getTime());

// How this plan stands right now: 'due' (today, not trained yet), 'done'
// (today, already trained), 'missed' (an earlier day this cycle went by),
// 'skipped', or 'clear' (nothing outstanding). Missed days only reach back
// to the previous occurrence of that weekday — a skipped Tuesday stops
// mattering next Tuesday, so a holiday never becomes a backlog.
export function planDayState(plan, workouts, now = Date.now()) {
  const due = planDueDay(plan, now);
  if (!due) return { state: 'clear', due: null, next: null };
  const next = planNextDay(plan, now);
  const isToday = due.getTime() === startOfDay(now).getTime();
  // a day that passed before this plan existed was never missed
  if (plan.createdAt && due.getTime() < startOfDay(plan.createdAt).getTime()) {
    return { state: 'clear', due, next };
  }
  if (planTrainedSince(plan, workouts, due)) {
    return { state: isToday ? 'done' : 'clear', due, next };
  }
  if (plan.skippedOn === dayKey(due)) return { state: 'skipped', due, next };
  if (isToday) return { state: 'due', due, next };
  // A day only counts as MISSED while the rhythm is alive — the cycle
  // before it was trained. A plan never started, or dropped weeks ago, is
  // not missed every single week; it just isn't running, and saying so
  // every Monday would be nagging rather than reminding.
  const prevCycle = new Date(due);
  prevCycle.setDate(prevCycle.getDate() - 7);
  if (!planTrainedSince(plan, workouts, prevCycle)) return { state: 'clear', due, next };
  return { state: 'missed', due, next };
}

// The one thing the start screen should say about today. Plans are scanned
// in stored order and the most actionable state wins: something due today
// beats a missed day, which beats "done", which beats a rest day.
export function todayStatus(plans, workouts, now = Date.now()) {
  const dated = plans.filter((p) => p.days?.length);
  if (!dated.length) return null;
  const states = dated.map((p) => ({ plan: p, ...planDayState(p, workouts, now) }));
  const pick = (state) => states.find((x) => x.state === state) ?? null;
  const hit = pick('due') ?? pick('missed') ?? pick('done');
  if (hit) return hit;
  // nothing outstanding: name the next plan that comes up, soonest first
  const upcoming = states.filter((x) => x.next)
    .sort((a, b) => a.next - b.next)[0];
  return upcoming ? { ...upcoming, state: 'rest' } : null;
}

// Marks this cycle's due day as deliberately skipped — it stops being
// outstanding until that weekday comes round again. Locker-style: the key
// disappears when there is nothing to skip.
export function skipPlanDay(planId, now = Date.now()) {
  const plan = getPlans().find((p) => p.id === planId);
  const due = plan ? planDueDay(plan, now) : null;
  if (!due) return null;
  plan.skippedOn = dayKey(due);
  savePlan(plan);
  return plan;
}

// The weekday this plan actually gets trained on, when there is a clear
// one (at least 3 workouts, and 60% of them on the same day). Lets gymii
// notice a rhythm instead of asking for one.
export function usualWeekday(plan, workouts) {
  const mine = workouts.filter((w) =>
    w.planId === plan.id || (plan.name && w.name === plan.name));
  if (mine.length < 3) return null;
  const counts = new Map();
  mine.forEach((w) => {
    const d = new Date(w.startedAt).getDay();
    counts.set(d, (counts.get(d) || 0) + 1);
  });
  const [day, hits] = [...counts].sort((a, b) => b[1] - a[1])[0];
  return hits / mine.length >= 0.6 ? day : null;
}

// --- active (in-progress) workout, saved after every set for crash safety ---

export function getActive() {
  return read(scopedKey(activeGymId(), 'active'), null);
}

export function saveActive(workout) {
  write(scopedKey(activeGymId(), 'active'), workout);
}

export function clearActive() {
  localStorage.removeItem(scopedKey(activeGymId(), 'active'));
}

// Moves the active workout into history; entries without sets are dropped.
export function finishWorkout(active) {
  const entries = active.entries.filter((e) => e.sets.length);
  clearActive();
  if (!entries.length) return null;
  const workout = {
    id: active.id,
    startedAt: active.startedAt,
    finishedAt: Date.now(),
    updatedAt: Date.now(),
    entries,
    ...(active.locker ? { locker: active.locker } : {}),
    ...(active.name ? { name: active.name } : {}),
    // which plan this came from — lets weekday tracking ask "was this plan
    // trained?" exactly, instead of inferring it from a matching name
    ...(active.planId ? { planId: active.planId } : {}),
  };
  const list = getWorkouts();
  list.push(workout);
  saveWorkouts(list);
  return workout;
}

// --- settings ---

// `keepAwake` names the SCOPE of the screen wake lock: 'break' (the rest
// timer only, default), 'workout' (the whole workout — costs battery, so
// never the default) or 'off'. `timerDim` is when the rest screen dims
// itself: '10s' (default), 'now' or 'off'.
export function getSettings() {
  const settings = {
    v: 1, restSeconds: 90, weightStep: 2.5, unit: 'kg', mapColors: 'custom', pickerMap: 'hidden',
    timerSound: 'double', keepAwake: 'break', timerDim: '10s',
    ...read(KEYS.settings, {}),
  };
  // keepAwake was a boolean before it grew a scope — migrate stored ones
  // lazily (true meant "during the break", false meant "never")
  if (settings.keepAwake === true) settings.keepAwake = 'break';
  else if (settings.keepAwake === false) settings.keepAwake = 'off';
  return settings;
}

// Distances pair with the weight unit: meters in metric, miles in imperial.
export const distUnit = (settings) => (settings.unit === 'kg' ? 'm' : 'mi');

const LB_PER_KG = 2.2046226218;
const M_PER_MI = 1609.344;

// THE unit conversion, rounding included: weights to the nearest 0.5 in
// the target unit, distances to whole meters / hundredths of a mile.
// Every converter (setUnit below, demo.js's authored-in-kg data) must go
// through these or values drift between surfaces. `unit` is the TARGET
// display unit; the value is assumed to be in the other one.
export const convertWeight = (v, unit) =>
  Math.round((unit === 'lbs' ? v * LB_PER_KG : v / LB_PER_KG) * 2) / 2;
export const convertDistance = (v, unit) => (unit === 'lbs'
  ? Math.round((v / M_PER_MI) * 100) / 100
  : Math.round(v * M_PER_MI));

// Stored weights and distances are always in the current display unit.
// Switching units therefore converts every stored value — across ALL
// gyms' histories, active workouts and plan targets (unit is global,
// data is per gym) — plus the shared weight step. Seconds are
// unit-less and untouched.
export function setUnit(unit) {
  const s = getSettings();
  if (unit === s.unit) return;
  // one field-walk for everything that stores {weight, distance}
  const convert = (o) => {
    if (o.weight != null) o.weight = convertWeight(o.weight, unit);
    if (o.distance != null) o.distance = convertDistance(o.distance, unit);
  };
  const convertSets = (entries) => entries.forEach((e) => e.sets.forEach(convert));

  ensureGyms().list.forEach((p) => {
    const workouts = read(scopedKey(p.id, 'workouts'), []);
    workouts.forEach((w) => convertSets(w.entries));
    write(scopedKey(p.id, 'workouts'), workouts);

    const active = read(scopedKey(p.id, 'active'), null);
    if (active) {
      convertSets(active.entries);
      // a running workout's slots carry their OWN copy of the plan targets
      // (train.js startWorkoutFrom) — the log screen's header and its
      // first-set prefill read that copy, so skipping it would turn an 80 kg
      // goal into an 80 lbs one the moment the unit is switched mid-workout.
      // Legacy plans are bare machineId strings; they have no target.
      active.plan?.forEach((slot) => slot?.target && convert(slot.target));
      write(scopedKey(p.id, 'active'), active);
    }

    // plan targets are stored in the display unit too — leaving them out
    // would silently turn a 80 kg target into an 80 lbs one
    const plans = read(scopedKey(p.id, 'plans'), []);
    if (plans.length) {
      plans.forEach((pl) => pl.items?.forEach((it) => it.target && convert(it.target)));
      write(scopedKey(p.id, 'plans'), plans);
    }
  });

  saveSettings({ ...s, unit, weightStep: Math.max(0.5, convertWeight(s.weightStep, unit)) });
}

// Sorted list of every muscle assigned across the layout's machines — feeds
// the picker's filter, the overview's coverage chips and the plan builder.
export const layoutMuscles = (layout) => [...new Set(layout.machines.flatMap((m) => m.muscles || []))]
  .sort((a, b) => a.localeCompare(b));

// --- naming a workout ---
// A name is what makes a workout findable later, so gymii proposes one
// instead of asking for one: the muscles of the machines actually trained
// say what this workout was. Chips, not free text — the house rule for
// anything enumerable, and one tap beats typing "Push day" for the ninth
// time. Free text stays available for everything these can't guess.

const MUSCLE_REGION = {
  Chest: 'Chest',
  'Upper back': 'Back',
  'Lower back': 'Back',
  Lats: 'Back',
  Traps: 'Back',
  Shoulders: 'Shoulders',
  Biceps: 'Arms',
  Triceps: 'Arms',
  Forearms: 'Arms',
  Abs: 'Core',
  Obliques: 'Core',
  Quads: 'Legs',
  Hamstrings: 'Legs',
  Glutes: 'Legs',
  Calves: 'Legs',
  Adductors: 'Legs',
  Abductors: 'Legs',
  'Full body': 'Full body',
};
const PUSH = new Set(['Chest', 'Shoulders', 'Triceps']);
const PULL = new Set(['Lats', 'Upper back', 'Lower back', 'Traps', 'Biceps']);

// Names this set of machines could plausibly go by, most specific first.
// Pass one id per set (or per plan item) — repeats are the weighting.
export function suggestWorkoutNames(machineIds, layout) {
  const hits = new Map(); // muscle -> weight
  let total = 0;
  machineIds.forEach((id) => {
    const machine = layout?.machines.find((m) => m.id === id);
    const muscles = machine?.muscles ?? [];
    if (!muscles.length) return;
    // each machine contributes ONE unit, split across its muscles — a
    // machine tagged with three leg muscles must not outvote two others
    const unit = 1 / muscles.length;
    muscles.forEach((mu) => hits.set(mu, (hits.get(mu) || 0) + unit));
    total += 1;
  });
  if (!total) return [];
  const share = (group) => [...hits]
    .reduce((n, [mu, c]) => n + (group.has(mu) ? c : 0), 0) / total;
  const regions = new Map();
  hits.forEach((c, mu) => {
    const region = MUSCLE_REGION[mu];
    if (region) regions.set(region, (regions.get(region) || 0) + c);
  });
  const ranked = [...regions].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  const names = [];
  // a classic split only when the workout really is one — a stray
  // machine from another region should not rename the whole workout
  if (share(PUSH) >= 0.7) names.push('Push day');
  if (share(PULL) >= 0.7) names.push('Pull day');
  if ((regions.get('Legs') ?? 0) / total >= 0.7) names.push('Leg day');
  if (ranked[0]) names.push(ranked[0]);
  if (ranked[1]) names.push(`${ranked[0]} & ${ranked[1]}`);
  return [...new Set(names)].slice(0, 4);
}

// Names already in use, newest first — reusing one keeps a routine
// together on the start screen instead of splitting it in two.
export function recentWorkoutNames(limit = 3) {
  const workouts = getWorkouts();
  const names = [];
  for (let i = workouts.length - 1; i >= 0 && names.length < limit; i--) {
    const name = workouts[i].name;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// The name chips every naming surface offers (the workout overview, the
// history editor, the plan builder): what these machines suggest first, then
// the names already in use, deduplicated. Pass one id per logged set (or per
// plan item) — repeats are the weighting, see suggestWorkoutNames.
export function nameChipsFor(machineIds, layout, limit = 5) {
  return [...new Set([
    ...suggestWorkoutNames(machineIds, layout),
    ...recentWorkoutNames(),
  ])].slice(0, limit);
}

// Total sets per machine across all history — feeds the usage map view.
export function usageByMachine() {
  const usage = new Map();
  getWorkouts().forEach((w) => w.entries.forEach((e) => {
    usage.set(e.machineId, (usage.get(e.machineId) || 0) + e.sets.length);
  }));
  return usage;
}

// Muscles live on the MACHINE, never on the entry, so history resolves
// them against the layout as it is today — a deleted or untagged machine
// simply contributes to no muscle.
const muscleIndex = (layout) => new Map((layout?.machines ?? []).map((m) => [m.id, m.muscles ?? []]));

// Sets per muscle over `workouts` (the caller passes its filtered list).
// A set on a two-muscle machine counts fully for BOTH: this answers "how
// many sets worked this muscle", not "what should this workout be called"
// — suggestWorkoutNames splits 1/n because naming is a vote, usage isn't.
// → Map<muscle, {sets, workouts}>
export function usageByMuscle(workouts, layout) {
  const muscles = muscleIndex(layout);
  const usage = new Map();
  workouts.forEach((w) => {
    const seen = new Set(); // count each workout once per muscle
    w.entries.forEach((e) => muscles.get(e.machineId)?.forEach((mu) => {
      const u = usage.get(mu) ?? { sets: 0, workouts: 0 };
      u.sets += e.sets.length;
      if (!seen.has(mu)) { u.workouts += 1; seen.add(mu); }
      usage.set(mu, u);
    }));
  });
  return usage;
}

// The workouts that touched `muscle` — WHOLE workouts on purpose: history
// edits a full workout, so narrowing entries would let Save silently drop
// the machines that didn't match.
export function workoutsWithMuscle(workouts, layout, muscle) {
  const muscles = muscleIndex(layout);
  return workouts.filter((w) =>
    w.entries.some((e) => muscles.get(e.machineId)?.includes(muscle)));
}

export function saveSettings(settings) {
  write(KEYS.settings, { ...settings, updatedAt: Date.now() });
}

// --- import / export ---

// The wire format is frozen: the field is `gym` and the kind is
// `gym-template`, even though internally this is the LAYOUT. Files in the
// wild read it that way — every backup ever exported, every community
// template under templates/, the AI prompt's format description and the
// gym-template issue form. Renaming the field would be a v3 for no gain.
export function exportGymTemplate() {
  return { app: 'gymii', kind: 'gym-template', v: 1, gym: getLayout() };
}

// v2 adds tombstones (and the records may carry updatedAt stamps) so a
// restored backup keeps its deletes dead across a later sync. v1 files
// (no tombstones, no stamps) import unchanged — absence means epoch 0.
// The sync key (gymii.<pid>.synckey, M1) must NEVER be part of a backup:
// backup files travel far more casually than sync credentials should.
export function exportBackup() {
  return {
    app: 'gymii',
    kind: 'backup',
    v: 2,
    gym: getLayout(), // wire field, see exportGymTemplate above

    workouts: getWorkouts(),
    plans: getPlans(),
    settings: getSettings(),
    tombstones: getTombstones(),
  };
}

function isValidLayout(layout) {
  return layout && typeof layout === 'object'
    && layout.grid && Number.isFinite(layout.grid.w) && Number.isFinite(layout.grid.h)
    && Array.isArray(layout.shapes) && Array.isArray(layout.machines)
    && layout.machines.every((m) => m.id && Number.isFinite(m.num)
      && (m.exercises === undefined
        || (Array.isArray(m.exercises) && m.exercises.every((x) => typeof x === 'string'))))
    && (layout.outline === undefined || (Array.isArray(layout.outline) && layout.outline.length >= 3
      && layout.outline.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))));
}

// --- plan text: the trainer's note ---
// A plan arrives as LINES, not as a form — "Leg press 3x10 80", "#7 Chest
// press 3x8-12 40kg", "Treadmill 20min". Reading them is what makes a plan
// possible before a layout exists. Cutting order matters: set and weight
// terms come out FIRST, so a leftover leading number ("7. Leg press") is
// unambiguously a machine num and "20min Treadmill" never reads its 20 as
// one. Only a MARKED number (#7, 7., 7)) counts — a bare leading digit
// stays part of the name, where "45 degree leg press" belongs.

// sets × reps, with an optional rep range ("3x8-12" targets the low end —
// the number you are sure to hit is the better prefill).
const SETS_REPS = /(\d+)\s*(?:sets?)?\s*[x×*]\s*(\d+)(?:\s*[-–—]\s*\d+)?\s*(?:reps?)?/i;
// weight right after the sets term ("3x10 80", "3x10x80", "3x10 @ 40kg")
const TRAILING_WEIGHT = /^\s*(?:@|x|×|\*|-|with)?\s*(\d+(?:[.,]\d+)?)\s*(kgs?|lbs?|pounds?)?\b/i;
// …or anywhere, when it names its unit ("Chest press 40kg 3x10")
const UNIT_WEIGHT = /(\d+(?:[.,]\d+)?)\s*(kgs?|lbs?|pounds?)\b/i;
const DURATION = /(\d+(?:[.,]\d+)?)\s*(h|hrs?|hours?|min(?:ute)?s?|sec(?:ond)?s?)\b/i;
const DISTANCE = /(\d+(?:[.,]\d+)?)\s*(km|mi|miles?|m)\b/i;
const MARKED_NUM = /^(?:(?:nr|no)\.?\s*)?(?:#\s*(\d{1,3})|(\d{1,3})\s*[.)])\s*/i;

const num = (raw) => parseFloat(String(raw).replace(',', '.'));

// Weights and distances are stored in the display unit, so a note written
// in the other one converts on the way in (convertWeight/convertDistance
// carry the rounding, same as setUnit).
function toDisplayWeight(value, unit, settings) {
  if (!unit) return value;
  const imperial = /^(lbs?|pounds?)$/i.test(unit);
  if (imperial === (settings.unit === 'lbs')) return value;
  return convertWeight(value, settings.unit);
}

function toDisplayDistance(value, unit, settings) {
  const meters = /^km$/i.test(unit) ? value * 1000
    : /^m$/i.test(unit) ? value : value * M_PER_MI;
  return settings.unit === 'kg' ? Math.round(meters) : convertDistance(meters, 'lbs');
}

// Reads one line into a raw item ({ name, num?, target? }), or null when
// there is nothing to train on it (blank lines, "Day A:" headings, a bare
// set term with no movement to attach it to).
export function parsePlanLine(line, settings = getSettings()) {
  let rest = String(line).trim();
  if (!rest || /:$/.test(rest)) return null;

  let target = null;
  const sr = SETS_REPS.exec(rest);
  if (sr) {
    const after = rest.slice(sr.index + sr[0].length);
    const tw = TRAILING_WEIGHT.exec(after);
    const uw = tw ? null : UNIT_WEIGHT.exec(rest);
    const w = tw ?? uw;
    target = {
      sets: Math.max(1, parseInt(sr[1], 10)),
      reps: Math.max(1, parseInt(sr[2], 10)),
      weight: w ? Math.max(0, toDisplayWeight(num(w[1]), w[2], settings)) : 0,
    };
    rest = (rest.slice(0, sr.index) + after.slice(tw ? tw[0].length : 0))
      .replace(uw ? uw[0] : '', '');
  } else {
    // no sets term — a duration or a distance makes it a cardio item
    const dur = DURATION.exec(rest);
    const dist = DISTANCE.exec(rest);
    if (dur || dist) {
      const secs = dur ? num(dur[1]) * (/^(h|hrs?|hours?)$/i.test(dur[2]) ? 3600
        : /^sec/i.test(dur[2]) ? 1 : 60) : 0;
      target = {
        distance: dist ? toDisplayDistance(num(dist[1]), dist[2], settings) : 0,
        seconds: Math.round(secs),
      };
      rest = rest.replace(dur ? dur[0] : '', '').replace(dist ? dist[0] : '', '');
    }
  }

  let machineNum = null;
  const marked = MARKED_NUM.exec(rest.trim());
  if (marked) {
    machineNum = parseInt(marked[1] ?? marked[2], 10);
    rest = rest.trim().slice(marked[0].length);
  }

  // strip the punctuation that separated the terms we just cut out
  let name = rest.replace(/[\s,;:@×*x-]+$/i, '').replace(/^[\s,;:@-]+/, '')
    .replace(/\s+/g, ' ').trim();
  // "#2 Dumbbells: Biceps curls" names a movement AT a machine. Only a
  // MARKED num unlocks this reading — otherwise "Day A: Leg press" would
  // lose its exercise to a heading that merely looks like one.
  let exercise = null;
  if (machineNum && name.includes(':')) {
    const [head, ...tail] = name.split(':');
    const rhs = tail.join(':').trim();
    if (head.trim() && rhs) { name = head.trim(); exercise = rhs; }
  }
  if (!name) return null;
  return {
    name,
    ...(machineNum ? { num: machineNum } : {}),
    ...(exercise ? { exercise } : {}),
    ...(target ? { target } : {}),
  };
}

// The whole note at once. Lines that carry nothing trainable are dropped.
export function parsePlanText(text, settings = getSettings()) {
  return String(text).split('\n')
    .map((line) => parsePlanLine(line, settings))
    .filter(Boolean);
}

// Binds one raw item to a machine when the layout allows it: a known num
// wins, else an exact label match, else a SINGLE substring match (an
// ambiguous one would bind the wrong machine, so it stays unbound). What
// cannot bind keeps its name and num — an unbound item is a full citizen,
// not a failed one.
function resolveItem(raw, layout) {
  const name = String(raw.name || '').trim();
  const machines = layout?.machines ?? [];
  let machine = raw.num != null ? machines.find((m) => m.num === raw.num) : null;
  if (!machine && name) {
    const n = name.toLowerCase();
    const matches = machines.filter((m) => String(m.label || '').toLowerCase() === n);
    const loose = matches.length ? matches : machines.filter((m) => {
      const label = String(m.label || '').toLowerCase();
      return label && (label.includes(n) || n.includes(label));
    });
    if (loose.length === 1) [machine] = loose;
  }
  return { machine, name: name || (raw.num != null ? `Machine ${raw.num}` : '') };
}

// Shapes a raw target against the item's type. Bound items take their type
// from the machine, unbound ones from the target's own shape.
function normalizeTarget(raw, cardio) {
  const int = (v, min, fb) => (Number.isFinite(v) ? Math.max(min, Math.round(v)) : fb);
  const pos = (v, fb) => (Number.isFinite(v) && v >= 0 ? v : fb);
  if (cardio) {
    return raw.distance != null || raw.seconds != null
      ? { distance: pos(raw.distance, 1000), seconds: int(raw.seconds, 0, 600) } : null;
  }
  return raw.sets != null || raw.reps != null || raw.weight != null
    ? { sets: int(raw.sets, 1, 3), reps: int(raw.reps, 1, 10), weight: pos(raw.weight, 0) } : null;
}

// Turns raw items ({num?, name?, exercise?, target?} — from an LLM file or
// a typed note) into plan items, binding what the layout already knows.
export function planItemsFrom(rawItems, layout) {
  return rawItems.map((raw) => {
    const { machine, name } = resolveItem(raw, layout);
    const flat = raw.target ? { ...raw, ...raw.target } : raw;
    const cardio = machine ? !!machine.cardio : flat.distance != null || flat.seconds != null;
    const target = normalizeTarget(flat, cardio);
    if (machine) {
      const exercise = machine.exercises?.includes(raw.exercise) ? raw.exercise : null;
      return { machineId: machine.id, exercise, ...(target ? { target } : {}) };
    }
    // neither a machine nor a name: nothing to train and nothing to bind
    if (!name) return null;
    return {
      machineId: null, name, exercise: null,
      ...(raw.num != null ? { num: raw.num } : {}),
      ...(target ? { target } : {}),
    };
  }).filter(Boolean);
}

export const isUnbound = (item) => !item.machineId;

// The note a plan would have been written as — the exact inverse of
// parsePlanText, so the builder can offer text and list as two views of
// one plan. Bound items lead with their #num, which is what makes the
// round-trip bind again on the way back in.
export function planToText(items, layout, settings = getSettings()) {
  const du = distUnit(settings);
  return items.map((it) => {
    const machine = it.machineId ? layout?.machines.find((m) => m.id === it.machineId) : null;
    if (!machine && !isUnbound(it)) return null; // machine deleted since
    const num = machine?.num ?? it.num ?? null;
    const label = machine ? machine.label : it.name;
    const head = `${num ? `#${num} ` : ''}${label}${it.exercise ? `: ${it.exercise}` : ''}`;
    const t = it.target;
    if (!t) return head;
    if (t.distance != null) {
      const dist = t.distance ? ` ${t.distance}${du}` : '';
      const time = t.seconds
        ? ` ${t.seconds % 60 ? `${t.seconds}s` : `${t.seconds / 60}min`}` : '';
      return `${head}${dist}${time}`;
    }
    return `${head} ${t.sets}x${t.reps}${t.weight ? ` ${t.weight}` : ''}`;
  }).filter(Boolean).join('\n');
}

// Reads a plan out of a typed note. No layout needed — that is the point.
export function planFromText(text, name = '', settings = getSettings()) {
  const raw = parsePlanText(text, settings);
  if (!raw.length) throw new Error('No exercises found — one per line, e.g. "Leg press 3x10 80"');
  return {
    id: uid(),
    name: String(name || '').trim(),
    items: planItemsFrom(raw, getLayout()),
  };
}

// Builds a PAST workout out of the same note grammar — the workout you
// forgot to log is a plan that already happened, so "3x10 80" means three
// sets of ten at eighty rather than a target of them. Lines naming a num
// the layout doesn't know create that machine (same deal as binding on the
// floor); lines with no findable machine are reported, not invented, so
// nothing lands in the layout that the note didn't actually name.
// Returns { workout, skipped } and persists ONLY the layout, not the workout.
export function workoutFromText(text, startedAt, settings = getSettings()) {
  const raw = parsePlanText(text, settings);
  if (!raw.length) throw new Error('No exercises found — one per line, e.g. "#14 Leg press 3x10 80"');
  const layout = getLayout() ?? newLayout();
  const entries = [];
  const skipped = [];
  raw.forEach((item) => {
    const [resolved] = planItemsFrom([item], layout);
    if (!resolved) return;
    let machine = resolved.machineId
      ? layout.machines.find((m) => m.id === resolved.machineId) : null;
    if (!machine && item.num) {
      machine = bindOrCreateMachine(layout, item.num, item.name, item.target);
    }
    if (!machine) { skipped.push(item.name); return; }
    const t = resolved.target;
    const sets = [];
    if (t?.distance != null) {
      sets.push({ distance: t.distance, seconds: t.seconds });
    } else {
      const count = t?.sets ?? 1;
      for (let i = 0; i < count; i++) sets.push({ reps: t?.reps ?? 10, weight: t?.weight ?? 0 });
    }
    entries.push(newEntry(machine, resolved.exercise, sets));
  });
  if (!entries.length) {
    throw new Error('No line named a machine gymii knows — put a #number in front of one');
  }
  saveLayout(layout);
  // no finishedAt: the duration of a workout logged after the fact is
  // simply unknown, and every consumer already guards for its absence
  return { workout: { id: uid(), startedAt, updatedAt: Date.now(), entries }, skipped };
}

// Resolves an LLM-produced workout-plan file against the current layout.
// Machines are referenced by their visible num — the only stable handle an
// LLM sees in the AI export. A num the layout doesn't know does NOT drop the
// item any more: the answer may arrive hours after the export (or before
// the layout exists at all), so it lands unbound and binds on first use.
// The plan always gets a FRESH id; when the file carries the id of an
// existing plan (a revision of an exported one), that id is only REPORTED
// as `replacesId` — replacing is a destructive choice the caller must
// confirm, never something a pasted file does on its own.
// Does not persist anything.
export function planFromImport(data) {
  if (!Array.isArray(data.items) || !data.items.length) throw new Error('Plan has no items');
  const items = planItemsFrom(data.items, getLayout());
  const days = Array.isArray(data.days)
    ? [...new Set(data.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
      .sort((a, b) => a - b)
    : [];
  return {
    plan: {
      id: uid(),
      name: String(data.name || '').trim(),
      ...(days.length ? { days } : {}),
      items,
    },
    unbound: items.filter(isUnbound).map((it) => it.name),
    replacesId: typeof data.id === 'string' && getPlans().some((p) => p.id === data.id)
      ? data.id : null,
  };
}

// Returns the imported kind ('gym-template' | 'backup' | 'workout-plan'),
// throws on bad input. `data.gym` is the frozen wire name for the layout.
export function importData(data) {
  if (!data || data.app !== 'gymii') throw new Error('Not a gymii file');
  if (data.kind === 'gym-template') {
    if (!isValidLayout(data.gym)) throw new Error('Invalid gym template');
    // bulk restore, not an interactive edit: no re-diffing, no re-stamping
    restoreLayout(data.gym);
    return 'gym-template';
  }
  if (data.kind === 'backup') {
    if (!isValidLayout(data.gym) || !Array.isArray(data.workouts)) throw new Error('Invalid backup');
    restoreLayout(data.gym);
    saveWorkouts(data.workouts);
    if (Array.isArray(data.plans)) {
      savePlans(data.plans.filter((p) => p && p.id && Array.isArray(p.items)));
    }
    saveSettings({ ...getSettings(), ...data.settings });
    // a v1 file carries none — restoring it clears the slate, same
    // whole-overwrite semantics as every other part of a backup import
    saveTombstones(data.tombstones ?? {});
    return 'backup';
  }
  if (data.kind === 'workout-plan') {
    savePlan(planFromImport(data).plan);
    return 'workout-plan';
  }
  throw new Error('Unrecognized file kind');
}

// Full factory reset: every gym's data, the registry, and settings.
export function clearAll() {
  const gyms = read(KEYS.gyms, null);
  gyms?.list.forEach((g) => ['layout', 'workouts', 'active', 'plans', 'tombstones']
    .forEach((part) => localStorage.removeItem(scopedKey(g.id, part))));
  // the pre-profile top-level keys keep their historical names — 'gymii.gym'
  // held what is now the layout, and does NOT follow the gym→layout rename
  [KEYS.gyms, 'gymii.profiles', KEYS.settings, 'gymii.gym', 'gymii.workouts', 'gymii.active']
    .forEach((k) => localStorage.removeItem(k));
}
