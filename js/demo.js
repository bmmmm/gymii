// Demo data: one tap fills a separate "Demo" gym with a layout, eight
// weeks of history and three weekday plans, so every feature surface
// (cardio, bodyweight, multi-exercise, targets, weekday states, lockers,
// settings snapshots) is testable without building it by hand first.
//
// Everything is deterministic: fixed ids, a seeded PRNG and an injectable
// `now` — the same inputs always produce byte-identical data, which is
// what makes a reload replace the Demo gym instead of duplicating it.

import {
  getSettings, getGyms, createGym, setActiveGym, clearActive,
  saveLayout, saveWorkouts, savePlans, startOfDay, convertWeight, convertDistance,
  newEntry,
} from './store.js';

const DEMO_GYM_NAME = 'Demo';

// Local midnight `daysBack` days ago, via setDate() — fixed 86400000-ms
// multiples would shift every workout on the far side of a DST transition
// by an hour (store.js's planDueDay uses the same pattern).
const dayStartBack = (now, daysBack) => {
  const d = startOfDay(now);
  d.setDate(d.getDate() - daysBack);
  return d.getTime();
};

// Small deterministic PRNG — Math.random() would defeat the reload-equals-
// replace property and make the logic tests flaky.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- the demo layout ---
// Machines #1-#11 mirror templates/example-gym.json; #12-#16 fill the
// template's empty Free-weights and Cardio zones with the coverage the
// template lacks: cardio, bodyweight and a multi-exercise machine.
// [id, num, label, x, y, w, h, settingsFields, muscles, extra]
const MACHINES = [
  ['chest-press', 1, 'Chest press', 4, 4, 5, 4, ['Seat'], ['Chest', 'Triceps'],
    { docUrl: 'https://en.wikipedia.org/wiki/Bench_press' }],
  ['lat-pulldown', 2, 'Lat pulldown', 11, 4, 5, 4, ['Seat', 'Thigh pad'], ['Lats', 'Upper back', 'Biceps']],
  ['seated-row', 3, 'Seated row', 18, 4, 5, 4, ['Chest pad'], ['Upper back', 'Lats']],
  ['shoulder-press', 4, 'Shoulder press', 25, 4, 5, 4, ['Seat'], ['Shoulders', 'Triceps']],
  ['leg-press', 5, 'Leg press', 4, 12, 5, 4, ['Seat angle'], ['Quads', 'Glutes'],
    { restSeconds: 150 }],
  ['leg-extension', 6, 'Leg extension', 11, 12, 5, 4, ['Seat', 'Shin pad'], ['Quads']],
  ['leg-curl', 7, 'Leg curl', 18, 12, 5, 4, ['Seat', 'Ankle pad'], ['Hamstrings']],
  ['pec-deck', 8, 'Pec deck', 25, 12, 5, 4, ['Seat', 'Arm pads'], ['Chest']],
  ['cable-tower', 9, 'Cable tower', 4, 20, 5, 4, ['Pulley height'], ['Full body'],
    { color: '#3f7fd1' }], // one of map's ITEM_COLORS
  ['abdominal-crunch', 10, 'Abdominal crunch', 11, 20, 5, 4, ['Seat'], ['Abs']],
  ['back-extension', 11, 'Back extension', 18, 20, 5, 4, ['Pad height'], ['Lower back', 'Glutes']],
  ['demo-treadmill', 12, 'Treadmill', 36, 23, 3, 6, ['Incline'], ['Quads', 'Calves'],
    { cardio: true }],
  ['demo-rower', 13, 'Rowing machine', 41, 23, 3, 7, ['Foot plate'], ['Lats', 'Upper back', 'Quads'],
    { cardio: true }],
  ['demo-pullup', 14, 'Pull-up bar', 36, 4, 4, 2, [], ['Lats', 'Biceps'],
    { bodyweight: true }],
  // "Dip station" is this piece of equipment's real-world name, not the
  // old synonym for machine — it stays as a user would read it on the floor
  ['demo-dip', 15, 'Dip station', 42, 4, 4, 3, [], ['Chest', 'Triceps'],
    { bodyweight: true }],
  ['demo-dumbbells', 16, 'Dumbbell rack', 36, 10, 12, 2, [], ['Biceps', 'Shoulders', 'Forearms'],
    { exercises: ['Biceps curls', 'Lateral raises', 'Hammer curls'] }],
];

const SHAPES = [
  { id: 'zone-machines', kind: 'rect', x: 2, y: 2, w: 30, h: 28, label: 'Machines' },
  { id: 'zone-freeweights', kind: 'rect', x: 34, y: 2, w: 24, h: 17, label: 'Free weights' },
  { id: 'zone-cardio', kind: 'rect', x: 34, y: 21, w: 24, h: 17, label: 'Cardio' },
  { id: 'wall-divider', kind: 'line', x: 34, y: 20, w: 24, h: 0 },
  { id: 'door-entrance', kind: 'fixture', fixture: 'door', x: 8.8, y: 33.4, w: 2.4, h: 1.2, rot: 180 },
  { id: 'lockers', kind: 'fixture', fixture: 'locker', x: 7, y: 31, w: 4, h: 2 },
  { id: 'water-fountain', kind: 'fixture', fixture: 'water', x: 28, y: 34, w: 2, h: 2 },
  { id: 'trash-bin', kind: 'fixture', fixture: 'trash', x: 31, y: 34, w: 2, h: 2 },
  { id: 'mirror-freeweights', kind: 'fixture', fixture: 'mirror', x: 34, y: 2, w: 22, h: 1 },
  { id: 'main-entrance', kind: 'fixture', fixture: 'entrance', x: 18.2, y: 35.4, w: 3.6, h: 1.2, rot: 90 },
  { id: 'window-north', kind: 'fixture', fixture: 'window', x: 24, y: 1.5, w: 4, h: 1, rot: 0 },
  { id: 'front-counter', kind: 'fixture', fixture: 'counter', x: 23, y: 33, w: 5, h: 2 },
];

function buildLayout() {
  return {
    v: 1,
    name: 'Demo gym',
    meta: { address: 'Demostr. 1', city: 'Berlin', country: 'DE' },
    grid: { w: 60, h: 40 },
    outline: [
      { x: 2, y: 2 }, { x: 58, y: 2 }, { x: 58, y: 38 },
      { x: 20, y: 38 }, { x: 20, y: 34 }, { x: 2, y: 34 },
    ],
    shapes: SHAPES.map((s) => ({ ...s })),
    machines: MACHINES.map(([id, num, label, x, y, w, h, settingsFields, muscles, extra]) => ({
      id, num, label, x, y, w, h,
      settingsFields: [...settingsFields], muscles: [...muscles], docUrl: '',
      // cloned, not spread: `extra` may carry an array (exercises), and a
      // shared reference would let one build's mutation leak into the next
      ...structuredClone(extra),
    })),
  };
}

// --- eight weeks of history ---
// Three rotation days pinned to weekdays relative to `now`, so the plan
// states below hold on ANY day of the week: Pull lands on today, Push two
// days ago, Legs five days ago.

// Settings snapshots, per machine — only fields the machine actually has.
const SNAP_SETTINGS = {
  'chest-press': { Seat: '4' },
  'lat-pulldown': { Seat: '3', 'Thigh pad': '2' },
  'leg-press': { 'Seat angle': '45' },
  'demo-treadmill': { Incline: '2' },
  'demo-rower': { 'Foot plate': '5' },
};

// Working weights are authored in kg (converted in one pass at the end
// when the display unit is lbs) and progress by 2.5 every second week.
const BASE_KG = {
  'chest-press': 40, 'lat-pulldown': 50, 'seated-row': 45, 'shoulder-press': 25,
  'leg-press': 120, 'leg-extension': 40, 'leg-curl': 35, 'pec-deck': 35,
  'back-extension': 30,
};

const WEEKS = 8;

const machineById = (layout, id) => layout.machines.find((m) => m.id === id);

// weekIdx 0 = oldest week, WEEKS-1 = current. One deload week keeps the
// progress chart from being a straight line.
function strengthKg(id, weekIdx) {
  let kg = BASE_KG[id] + 2.5 * Math.floor(weekIdx / 2);
  if (weekIdx === 4) kg = Math.round((kg * 0.9) / 2.5) * 2.5;
  return kg;
}

// The entry snapshot is store's newEntry (same shape the log screen writes);
// only the settings come from this dataset's own snapshots. `sets` never
// carries `at` — these sets were not logged live.
function entryFor(layout, id, exercise, sets) {
  const entry = newEntry(machineById(layout, id), exercise, sets);
  entry.settings = { ...(SNAP_SETTINGS[id] ?? {}) };
  return entry;
}

function strengthSets(rng, kg) {
  const n = rng() < 0.25 ? 4 : 3;
  return Array.from({ length: n }, () => ({ reps: 8 + Math.floor(rng() * 5), weight: kg }));
}

// day templates: which entries a workout of each rotation day contains
function pushEntries(layout, rng, weekIdx) {
  return [
    entryFor(layout, 'chest-press', null, strengthSets(rng, strengthKg('chest-press', weekIdx))),
    entryFor(layout, 'shoulder-press', null, strengthSets(rng, strengthKg('shoulder-press', weekIdx))),
    entryFor(layout, 'pec-deck', null, strengthSets(rng, strengthKg('pec-deck', weekIdx))),
    entryFor(layout, 'demo-dip', null,
      Array.from({ length: 3 }, () => ({ reps: 8 + Math.floor(rng() * 5), weight: 0 }))),
    entryFor(layout, 'demo-dumbbells', 'Lateral raises',
      strengthSets(rng, 8 + Math.floor(weekIdx / 3) * 2)),
  ];
}

function pullEntries(layout, rng, weekIdx) {
  const entries = [
    entryFor(layout, 'lat-pulldown', null, strengthSets(rng, strengthKg('lat-pulldown', weekIdx))),
    entryFor(layout, 'seated-row', null, strengthSets(rng, strengthKg('seated-row', weekIdx))),
    // added weight appears in the last three weeks, flipping history's
    // bodyweight chart from reps to added-weight
    entryFor(layout, 'demo-pullup', null,
      Array.from({ length: 3 }, () => ({
        reps: 6 + Math.floor(rng() * 5), weight: weekIdx >= WEEKS - 3 ? 5 : 0,
      }))),
    entryFor(layout, 'demo-dumbbells', 'Biceps curls',
      strengthSets(rng, 10 + Math.floor(weekIdx / 3) * 2)),
  ];
  if (rng() < 0.5) {
    entries.push(entryFor(layout, 'demo-rower', null,
      [{ distance: 2000, seconds: 480 + Math.floor(rng() * 120) }]));
  }
  return entries;
}

function legsEntries(layout, rng, weekIdx) {
  return [
    entryFor(layout, 'leg-press', null, strengthSets(rng, strengthKg('leg-press', weekIdx))),
    entryFor(layout, 'leg-extension', null, strengthSets(rng, strengthKg('leg-extension', weekIdx))),
    entryFor(layout, 'leg-curl', null, strengthSets(rng, strengthKg('leg-curl', weekIdx))),
    entryFor(layout, 'back-extension', null, strengthSets(rng, strengthKg('back-extension', weekIdx))),
    entryFor(layout, 'demo-treadmill', null,
      [{ distance: 3000 + Math.floor(rng() * 4) * 250, seconds: 900 + Math.floor(rng() * 300) }]),
  ];
}

const DAYS = [
  { key: 'legs', name: 'Leg day', offset: 5, planId: null, build: legsEntries },
  { key: 'push', name: 'Push day', offset: 2, planId: 'demo-plan-push', build: pushEntries },
  { key: 'pull', name: 'Pull day', offset: 0, planId: 'demo-plan-pull', build: pullEntries },
];

function buildWorkouts(layout, rng, now) {
  // two workouts vanish from the mid weeks for heatmap texture — never
  // from week 0 or 1, which the missed/done plan states depend on
  const drops = new Set([
    `${3 + Math.floor(rng() * 4)}-push`,
    `${3 + Math.floor(rng() * 4)}-legs`,
  ]);
  const workouts = [];
  for (let back = WEEKS - 1; back >= 0; back--) {
    const weekIdx = WEEKS - 1 - back;
    for (const day of DAYS) {
      // the omitted week-0 Push workout is what makes its plan "missed"
      if (back === 0 && day.key === 'push') continue;
      if (drops.has(`${back}-${day.key}`)) continue;
      const entries = day.build(layout, rng, weekIdx);
      let startedAt = dayStartBack(now, day.offset + back * 7)
        + (17.5 * 3600 + Math.floor((rng() - 0.5) * 3600)) * 1000;
      let finishedAt = startedAt + (45 + Math.floor(rng() * 30)) * 60000;
      if (back === 0 && day.offset === 0) {
        // today's workout: ~55 min ending now, clamped into [midnight, now]
        // so the pull plan reads 'done' even on a load just after midnight.
        // finishedAt stays strictly after startedAt — in the first minute
        // of a day that may poke up to a minute past `now`, the lesser evil
        // against a zero-length workout
        const midnight = startOfDay(now).getTime();
        startedAt = Math.max(midnight, now - 55 * 60000);
        finishedAt = Math.max(startedAt + 60000, Math.min(now, startedAt + 55 * 60000));
      }
      workouts.push({
        id: `demo-${day.key}-w${back}`,
        startedAt, finishedAt, entries,
        name: day.name,
        // recent workouts carry the plan id; older ones only the name, so
        // the name-fallback in planTrainedSince gets exercised too
        ...(day.planId && back <= 3 ? { planId: day.planId } : {}),
        ...(rng() < 0.33 ? { locker: String(101 + Math.floor(rng() * 98)) } : {}),
      });
    }
  }
  return workouts;
}

// --- plans ---
// Three plans so all weekday states show at once: Push was due two days
// ago and its week-0 workout is missing (missed), Pull is due today and
// today's workout carries its id (done), Core & cardio was never trained
// (due). createdAt predates the whole history or "missed" could not fire.
function buildPlans(now) {
  const dow = new Date(now).getDay();
  const createdAt = dayStartBack(now, WEEKS * 7);
  const target = (sets, reps, weight) => ({ sets, reps, weight });
  return [
    {
      id: 'demo-plan-push', name: 'Push day', createdAt, days: [(dow + 5) % 7],
      items: [
        { machineId: 'chest-press', exercise: null, target: target(3, 10, strengthKg('chest-press', WEEKS - 1)) },
        { machineId: 'shoulder-press', exercise: null, target: target(3, 10, strengthKg('shoulder-press', WEEKS - 1)) },
        { machineId: 'pec-deck', exercise: null, target: target(3, 12, strengthKg('pec-deck', WEEKS - 1)) },
        { machineId: 'demo-dip', exercise: null, target: target(3, 10, 0) },
        { machineId: 'demo-dumbbells', exercise: 'Lateral raises', target: target(3, 12, 12) },
      ],
    },
    {
      id: 'demo-plan-pull', name: 'Pull day', createdAt, days: [dow],
      items: [
        { machineId: 'lat-pulldown', exercise: null, target: target(3, 10, strengthKg('lat-pulldown', WEEKS - 1)) },
        { machineId: 'seated-row', exercise: null, target: target(3, 10, strengthKg('seated-row', WEEKS - 1)) },
        { machineId: 'demo-pullup', exercise: null, target: target(3, 8, 5) },
        { machineId: 'demo-dumbbells', exercise: 'Biceps curls', target: target(3, 12, 14) },
        { machineId: 'demo-rower', exercise: null, target: { distance: 2000, seconds: 540 } },
      ],
    },
    {
      id: 'demo-plan-core', name: 'Core & cardio', createdAt, days: [dow],
      items: [
        { machineId: 'abdominal-crunch', exercise: null, target: target(3, 15, 30) },
        { machineId: 'back-extension', exercise: null, target: target(3, 12, 35) },
        { machineId: 'demo-treadmill', exercise: null, target: { distance: 3000, seconds: 1200 } },
        { machineId: 'cable-tower', exercise: null, target: target(3, 12, 25) },
      ],
    },
  ];
}

// Stored values are always in the display unit; the dataset is authored in
// kg/metres and converted in one pass through store.js's converters, so
// the rounding is setUnit's by construction.
function convertToLbs({ workouts, plans }) {
  const convert = (o) => {
    if (o.weight != null) o.weight = convertWeight(o.weight, 'lbs');
    if (o.distance != null) o.distance = convertDistance(o.distance, 'lbs');
  };
  workouts.forEach((w) => w.entries.forEach((e) => e.sets.forEach(convert)));
  plans.forEach((p) => p.items.forEach((it) => it.target && convert(it.target)));
}

// Pure apart from its argument defaults: same now/settings/seed, same output.
export function buildDemoData({ now = Date.now(), settings = getSettings(), seed = 0x5eed17 } = {}) {
  const rng = mulberry32(seed);
  const layout = buildLayout();
  const workouts = buildWorkouts(layout, rng, now);
  const plans = buildPlans(now);
  if (settings.unit === 'lbs') convertToLbs({ workouts, plans });
  return { layout, workouts, plans };
}

// Creates or refreshes the Demo gym and switches to it. The gym is
// identified by its `demo` flag, NEVER by name — names are user-editable,
// and matching one would let a reload overwrite a real gym that happens to
// be called "Demo". Order matters: the gym switch must land first so
// every write hits its scoped keys, and a stale in-progress workout is
// cleared or it would hijack Train.
export function loadDemoData({ now = Date.now(), settings = getSettings(), seed } = {}) {
  const { layout, workouts, plans } = buildDemoData({ now, settings, seed });
  const existing = getGyms().list.find((p) => p.demo);
  const gymId = existing ? existing.id : createGym(DEMO_GYM_NAME, { demo: true });
  setActiveGym(gymId);
  clearActive();
  saveLayout(layout);
  saveWorkouts(workouts);
  savePlans(plans);
  return {
    gymId, created: !existing,
    machines: layout.machines.length, workouts: workouts.length, plans: plans.length,
  };
}
