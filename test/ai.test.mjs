// Logic-level test for the AI exchange: the export's plans section (same
// wire shape the prompt teaches for answers), and the paste-back flow —
// a new plan lands as a new plan, a revision carrying an exported id
// replaces its original only after a two-tap confirm.
// Run with: node test/ai.test.mjs
import './helpers/localstorage.mjs'; // FIRST: installs the stub
import { strict as assert } from 'node:assert';

const store = await import(new URL('../js/store.js', import.meta.url).href);
const { renderAi, buildAiExport, compactJson, DEFAULT_PROMPT } = await import(new URL('../js/ai.js', import.meta.url).href);

// --- fixture: a small gym and one saved plan with everything on it ---

const gym = store.newLayout('AI test gym');
gym.machines.push(
  { id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: ['Seat'], muscles: ['Chest'] },
  { id: 'tm', num: 9, label: 'Treadmill', x: 6, y: 0, w: 3, h: 6, settingsFields: [], muscles: ['Quads'], cardio: true },
);
store.saveLayout(gym);
store.savePlans([{
  id: 'p1', name: 'Push day', createdAt: 123, days: [1, 4],
  items: [
    { machineId: 'm1', exercise: null, target: { sets: 3, reps: 10, weight: 50 } },
    { machineId: 'gone', exercise: null, target: { sets: 3, reps: 12, weight: 20 } },
    { machineId: null, name: 'Face pulls', num: 12, exercise: null, target: { sets: 3, reps: 15, weight: 15 } },
    { machineId: 'tm', exercise: null, target: { distance: 3000, seconds: 900 } },
  ],
}]);

// --- the export carries plans in the answer's wire shape ---

const exported = JSON.parse(buildAiExport());
assert.equal(exported.plans.length, 1, 'saved plans are exported');

// --- the brand travels once, on the gym; a machine names one only where it differs ---
assert.ok(!('brand' in exported.gym), 'no gym brand: none exported');
const brandedGym = store.getLayout();
brandedGym.meta.brand = 'Technogym';
brandedGym.machines[0].brand = 'Technogym'; // a copy of the gym's — an imported template lists it per machine
brandedGym.machines[1].brand = 'Woodway';
store.saveLayout(brandedGym);
const brandedExport = JSON.parse(buildAiExport());
assert.equal(brandedExport.gym.brand, 'Technogym', 'the gym brand is exported at gym level');
assert.equal(brandedExport.gym.machines[0].brand, undefined, 'a copy of the gym\'s is not repeated per machine');
assert.equal(brandedExport.gym.machines[1].brand, 'Woodway', 'a different brand is');
delete brandedGym.meta.brand;
delete brandedGym.machines[0].brand;
delete brandedGym.machines[1].brand;
store.saveLayout(brandedGym);
const [p] = exported.plans;
assert.equal(p.id, 'p1', 'the id rides along — it is the replace handle');
assert.deepEqual(p.days, [1, 4]);
assert.deepEqual(p.items[0], { num: 1, sets: 3, reps: 10, weight: 50 },
  'bound items export their num and a flattened target');
assert.equal(p.items.length, 3, 'an item whose machine was deleted is skipped');
assert.deepEqual(p.items[1], { name: 'Face pulls', num: 12, sets: 3, reps: 15, weight: 15 },
  'unbound items keep their name and num hint');
assert.deepEqual(p.items[2], { num: 9, distance: 3000, seconds: 900 },
  'cardio targets keep their own shape');
{
  // a cardio target's level rides along in that shape — the one the prompt teaches back
  const plans = store.getPlans();
  plans[0].items[3].target.level = 5;
  store.savePlans(plans);
  assert.deepEqual(JSON.parse(buildAiExport()).plans[0].items[2], { num: 9, distance: 3000, seconds: 900, level: 5 },
    'a plan item exports its level');
  delete plans[0].items[3].target.level;
  store.savePlans(plans);
}
{
  // grips travel: the machine's list, a plan item's and a logged entry's
  const g = store.getLayout();
  g.machines[0].grips = ['Rope', 'V-bar'];
  store.saveLayout(g);
  const plans = store.getPlans();
  plans[0].items[0].grip = 'Rope';
  store.savePlans(plans);
  store.saveWorkouts([{ id: 'wg', startedAt: 1000, entries: [{ machineId: 'm1', num: 1, label: 'Chest press',
    grip: 'V-bar', settings: {}, sets: [{ reps: 10, weight: 40 }] }] }]);
  const ex = JSON.parse(buildAiExport());
  assert.deepEqual(ex.gym.machines[0].grips, ['Rope', 'V-bar'], 'a machine exports its grips');
  assert.ok(!('grips' in ex.gym.machines[1]), 'and none where it has none');
  assert.equal(ex.plans[0].items[0].grip, 'Rope', 'a plan item its grip');
  assert.equal(ex.workouts[0].entries[0].grip, 'V-bar', 'a logged entry its grip');
  delete g.machines[0].grips;
  store.saveLayout(g);
  delete plans[0].items[0].grip;
  store.savePlans(plans);
  store.saveWorkouts([]);
}
assert.ok(!('createdAt' in p) && !('machineId' in p.items[0]),
  'internal fields stay internal');

store.savePlans([]);
assert.ok(!('plans' in JSON.parse(buildAiExport())),
  'no plans, no plans key — empty users pay no tokens');

// --- workout dates export in LOCAL time, not UTC (a 00:30 workout must
// not roll onto the previous day for anyone east of UTC) ---

const lateNightTs = new Date(2030, 0, 15, 0, 30).getTime();
const lnd = new Date(lateNightTs);
const expectedLocalDate = `${lnd.getFullYear()}-${String(lnd.getMonth() + 1).padStart(2, '0')}-${String(lnd.getDate()).padStart(2, '0')}`;
store.saveWorkouts([{ id: 'w1', startedAt: lateNightTs, entries: [] }]);
const exportedWorkouts = JSON.parse(buildAiExport()).workouts;
assert.equal(exportedWorkouts.length, 1);
assert.equal(exportedWorkouts[0].date, expectedLocalDate,
  'export date is the local calendar day, not the UTC-shifted one');
store.saveWorkouts([]);

// --- set tuples: [w, r], [w, r, sec], [w, r, sec, rir], [w, r, null, rir] ---

const t0 = 1_800_000_000_000;
store.saveWorkouts([{
  id: 'tw', startedAt: t0, finishedAt: t0 + 3600000,
  entries: [
    { machineId: 'm1', num: 1, label: 'Chest press', settings: {}, sets: [
      { reps: 10, weight: 40 },
      { reps: 10, weight: 40, at: t0 + 90000 },
      { reps: 10, weight: 40, at: t0 + 90000, rir: 2 },
      { reps: 10, weight: 40, rir: 0 },
    ] },
    { machineId: 'tm', num: 9, label: 'Treadmill', cardio: true, settings: {}, sets: [
      { distance: 3000, seconds: 900, at: t0 + 120000, rir: 1 },
      { distance: 3000, seconds: 900, at: t0 + 120000, level: 5 },
      { distance: 3000, seconds: 900, level: 5 },
      { distance: 3000, seconds: 900, level: 0 },
    ] },
  ],
}]);
const tupleSets = JSON.parse(buildAiExport()).workouts[0].entries.map((e) => e.sets);
assert.deepEqual(tupleSets[0], [[40, 10], [40, 10, 90], [40, 10, 90, 2], [40, 10, null, 0]],
  'tuples grow only as far as the data goes; rir 0 is kept; rir without at gets a null');
assert.deepEqual(tupleSets[1], [[3000, 900, 120], [3000, 900, 120, 5], [3000, 900, null, 5], [3000, 900]],
  'cardio sets never carry rir; their fourth element is the level, null holds the third slot without at, level 0 is none');
assert.match(JSON.parse(buildAiExport()).note, /on a cardio entry it is the level instead/, 'the note says so');
assert.match(DEFAULT_PROMPT, /except on cardio entries, where the fourth element is the level/, 'and so does the prompt');
assert.match(DEFAULT_PROMPT, /for cardio machines, with an optional "level"/, 'which teaches the plan shape too');
assert.equal('visits' in JSON.parse(buildAiExport()).workouts[0], false, 'no visits recorded: no visits key');

// --- visits: the route, as [num, inSec, outSec, busyNum?] ---
store.saveWorkouts([{
  id: 'vw', startedAt: t0, finishedAt: t0 + 3600000,
  entries: [{ machineId: 'm1', num: 4, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 40 }] }],
  visits: [
    { machineId: 'm1', in: t0, out: t0 + 600000 },
    { machineId: 'tm', in: t0 + 600000, out: t0 + 1500400, busy: 'm1' },
    { machineId: 'gone', in: t0 + 1500400, out: t0 + 1600000, busy: 'tm' },
  ],
}]);
assert.deepEqual(JSON.parse(buildAiExport()).workouts[0].visits, [[1, 0, 600], [9, 600, 1500, 1]],
  'nums are the layout\'s current ones; seconds since the start; busy as a num; a machine neither knows drops out');
assert.match(JSON.parse(buildAiExport()).note, /visits are \[num, seconds in, seconds out, busy num\?\]/,
  'the note explains the shape');
assert.match(DEFAULT_PROMPT, /"visits"[^.]*\[num, seconds in, seconds out\]/, 'the prompt teaches visits too');

// --- compact: valid JSON, tuples and small objects on one line, far fewer lines ---
{
  const sets = Array.from({ length: 5 }, (_, i) => ({ reps: 10 + i, weight: 40, at: t0 + 60000 * (i + 1), rir: 2 }));
  store.saveWorkouts(Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, startedAt: t0 + i * 86400000, finishedAt: t0 + i * 86400000 + 1000,
    entries: [{ machineId: 'm1', num: 1, label: 'Chest press', settings: { Seat: '3' }, sets }] })));
  const raw = buildAiExport();
  // the broken-up branches against the value BEFORE it was written — a key
  // or element lost there could not hide behind a parse of the output itself
  const v = { note: 'x'.repeat(150), nested: { a: [1, 2, [3, 'q"uote', null]], b: { deep: 'y'.repeat(170), n: 0, t: true } },
    list: Array.from({ length: 30 }, (_, i) => ({ i, s: `s${i}` })), empty: [], none: {} };
  const out = compactJson(v);
  assert.ok(out.split('\n').length > 30, 'the sample does break across lines');
  assert.deepEqual(JSON.parse(out), v, 'still valid JSON, every key and element where it was');
  const wide = 'w'.repeat(170);
  assert.deepEqual(JSON.parse(compactJson({ keep: wide, gone: undefined })), { keep: wide },
    'an undefined key drops out of a broken-up object, as in JSON.stringify');
  assert.ok(raw.split('\n').length < 80, `compact output stays short (${raw.split('\n').length} lines)`);
  assert.ok(raw.includes('"sets":[[40,10,60,2],[40,11,120,2]'), 'a set list sits on one line');
  assert.equal(JSON.parse(raw).workouts.length, 6);
  store.saveWorkouts([]);
}

// --- assisted machines: the flag and the goal travel, the prompt says what weight means there ---
{
  const keepLayout = store.getLayout();
  const g = store.getLayout();
  g.machines.push({ id: 'ap', num: 17, label: 'Assisted pull-up', x: 20, y: 0, w: 4, h: 3, settingsFields: [],
    muscles: ['Lats'], assisted: true, assistGoal: 'strength' }, { id: 'ap2', num: 18, label: 'Assisted dip', x: 26, y: 0,
    w: 4, h: 3, settingsFields: [], muscles: ['Chest'], secondaryMuscles: ['Triceps'], assisted: true });
  store.saveLayout(g);
  store.saveWorkouts([{ id: 'aw', startedAt: t0, finishedAt: t0 + 60000,
    entries: [{ machineId: 'ap', num: 17, label: 'Assisted pull-up', assisted: true, settings: {}, sets: [{ reps: 8, weight: 25 }] }] }]);
  const ex = JSON.parse(buildAiExport());
  const machine = (n) => ex.gym.machines.find((m) => m.num === n);
  assert.deepEqual([machine(17).assisted, machine(17).assistGoal], [true, 'strength'], 'the machine carries its flag and goal');
  assert.equal('secondaryMuscles' in machine(17), false, 'no secondary muscles: no key');
  assert.equal('assistGoal' in machine(18), false, 'no goal said: none exported');
  assert.deepEqual(machine(18).secondaryMuscles, ['Triceps'], 'secondary muscles travel');
  assert.match(DEFAULT_PROMPT, /"secondaryMuscles" are worked less/, 'and the prompt says what they mean');
  assert.equal('assisted' in machine(1), false, 'a strength machine carries no flag');
  assert.deepEqual(ex.workouts[0].entries[0], { machine: 'Assisted pull-up', num: 17, assisted: true, sets: [[25, 8]] },
    'the entry says assisted, its weight is the assist');
  assert.match(ex.note, /assisted:true entries log the ASSISTANCE/, 'the note says what the weight is');
  assert.match(DEFAULT_PROMPT, /assisted:true[^;]*ASSISTANCE — less is stronger/, 'and so does the prompt');
  store.saveWorkouts([]);
  store.saveLayout(keepLayout);
}
// --- one num space: a renumbered or renamed machine is named by the layout's CURRENT num/label ---
{
  const keepLayout = store.getLayout();
  const g = store.getLayout();
  g.machines.find((m) => m.id === 'm1').num = 5; // renumbered since the workout (it was 4)
  g.machines.find((m) => m.id === 'm1').label = 'Bench press'; // and renamed
  store.saveLayout(g);
  store.saveWorkouts([{ id: 'rn', startedAt: t0, finishedAt: t0 + 3600000,
    entries: [
      { machineId: 'm1', num: 4, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 40 }] },
      { machineId: 'dead', num: 7, label: 'Old fly', settings: {}, sets: [{ reps: 12, weight: 20 }] },
    ],
    visits: [
      { machineId: 'm1', in: t0, out: t0 + 60000 },
      { machineId: 'dead', in: t0 + 60000, out: t0 + 120000, busy: 'm1' },
      { machineId: 'dead2', in: t0 + 120000, out: t0 + 180000 },
    ] }]);
  const w = JSON.parse(buildAiExport()).workouts[0];
  assert.deepEqual(w.entries.map((e) => [e.num, e.machine]), [[5, 'Bench press'], [7, 'Old fly']],
    'an entry of an existing machine takes its current num and label; a deleted machine keeps its snapshot');
  assert.deepEqual(w.visits, [[5, 0, 60], [7, 60, 120, 5]],
    'visits and their busy marks use the current num too; a deleted machine falls back to the entry snapshot');
  assert.equal(store.getWorkouts()[0].entries[0].num, 4, 'stored data is untouched — only the export is');
  assert.match(JSON.parse(buildAiExport()).note, /current num/, 'the note says which num space it is');
  store.saveLayout(keepLayout);
}
// a busy mark naming a machine nobody knows keeps the visit, minus the mark
store.saveWorkouts([{ id: 'vb', startedAt: t0, finishedAt: t0 + 60000, entries: [],
  visits: [{ machineId: 'm1', in: t0, out: t0 + 30000, busy: 'gone' }] }]);
assert.deepEqual(JSON.parse(buildAiExport()).workouts[0].visits, [[1, 0, 30]], 'the stop stays, the unknown busy mark goes');
// every visit at a machine deleted since: no route, and no empty key either
store.saveWorkouts([{ id: 've', startedAt: t0, finishedAt: t0 + 60000, entries: [],
  visits: [{ machineId: 'gone', in: t0, out: t0 + 30000 }] }]);
assert.equal('visits' in JSON.parse(buildAiExport()).workouts[0], false, 'absent rather than empty');
// visits arrive through backups and sync unchecked: junk is no route, never a dead AI tab
for (const junk of [[null], 'abc', [7, 'x'], { machineId: 'm1' }]) {
  store.saveWorkouts([{ id: 'vj', startedAt: t0, finishedAt: t0 + 60000, entries: [], visits: junk }]);
  assert.equal('visits' in JSON.parse(buildAiExport()).workouts[0], false, `junk visits ${JSON.stringify(junk)} export as none`);
}
store.saveWorkouts([]);

store.savePlans([{
  id: 'p1', name: 'Push day', createdAt: 123, days: [1, 4],
  items: [{ machineId: 'm1', exercise: null, target: { sets: 3, reps: 10, weight: 50 } }],
}]);

// --- DOM stubs: stable per selector, stateful classList for two-tap ---

const classListStub = () => {
  const set = new Set();
  return {
    add: (c) => set.add(c), remove: (c) => set.delete(c),
    toggle: () => {}, contains: (c) => set.has(c),
  };
};
const stubEl = () => ({
  innerHTML: '', value: '', textContent: '', dataset: {}, listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
  querySelector: () => stubEl(),
  querySelectorAll: () => [],
  classList: classListStub(),
});
const byId = new Map();
const root = {
  innerHTML: '',
  querySelector(sel) {
    if (!byId.has(sel)) byId.set(sel, stubEl());
    return byId.get(sel);
  },
  querySelectorAll: () => [],
};

// an active workout keeps the import on this screen (no builder
// navigation), which is also the real mid-workout paste-back scenario
store.saveActive({ v: 2, id: 'aw', startedAt: 1, entries: [] });
renderAi(root);
const importBtn = root.querySelector('#ai-import-btn');
const importEl = root.querySelector('#ai-import');

// --- a new plan (no id) lands as a new plan, no confirm needed ---

importEl.value = JSON.stringify({
  app: 'gymii', kind: 'workout-plan', name: 'Pull day',
  items: [{ num: 1, sets: 3, reps: 10, weight: 40 }],
});
importBtn.listeners.click();
assert.equal(store.getPlans().length, 2, 'a plan without id is added');
assert.ok(store.getPlans().some((x) => x.name === 'Pull day'));

// --- an unknown id is NOT a replace handle (nothing to replace) ---

importEl.value = JSON.stringify({
  app: 'gymii', kind: 'workout-plan', id: 'zzz', name: 'Mystery',
  items: [{ num: 1, sets: 1, reps: 1, weight: 1 }],
});
importBtn.listeners.click();
assert.equal(store.getPlans().length, 3, 'an unknown id still creates a new plan');
assert.ok(!store.getPlans().some((x) => x.id === 'zzz'), 'the foreign id is not adopted');

// --- a revision carrying an exported id replaces after two-tap ---

importEl.value = JSON.stringify({
  app: 'gymii', kind: 'workout-plan', id: 'p1',
  items: [{ num: 1, sets: 4, reps: 8, weight: 55 }], // no name, no days
});
importBtn.listeners.click();
assert.equal(importBtn.textContent, 'Tap again to replace plan "Push day"',
  'the confirm names the plan that would be overwritten');
assert.deepEqual(store.getPlans().find((x) => x.id === 'p1').items[0].target,
  { sets: 3, reps: 10, weight: 50 }, 'the first tap only arms — nothing replaced yet');

importBtn.listeners.click();
const replaced = store.getPlans().find((x) => x.id === 'p1');
assert.equal(store.getPlans().length, 3, 'replaced in place, not duplicated');
assert.deepEqual(replaced.items[0].target, { sets: 4, reps: 8, weight: 55 },
  'the revision content landed');
assert.equal(replaced.name, 'Push day', 'a revision without a name keeps the old one');
assert.deepEqual(replaced.days, [1, 4], 'a revision without days keeps the weekday tags');
assert.equal(replaced.createdAt, 123, 'createdAt survives — missed-day tracking intact');
assert.equal(importBtn.textContent, 'Import pasted JSON',
  'the button label rests again after the confirming tap');

console.log('ai exchange: all assertions passed');
