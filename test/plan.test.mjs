// Logic-level test for workout plans: store CRUD + backup roundtrip, the
// workout-plan AI import (num resolution, skipping, target sanitizing),
// target carry-through into the guided flow, target-aware prefills and
// slot progress, and a builder + start-screen render smoke.
// Run with: node test/plan.test.mjs
import { strict as assert } from 'node:assert';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const store = await import(new URL('../js/store.js', import.meta.url).href);
const { startWorkoutFrom, renderTrain, goToStart, goToPlans, goToHub } =
  await import(new URL('../js/train.js', import.meta.url).href);

const gym = store.newGym('Plan test gym');
gym.machines.push({
  id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3,
  settingsFields: [], muscles: ['Chest'],
});
gym.machines.push({
  id: 'db', num: 2, label: 'Dumbbells', x: 6, y: 0, w: 4, h: 3, settingsFields: [],
  muscles: ['Shoulders'], exercises: ['Biceps curls', 'Shoulder press'],
});
gym.machines.push({
  id: 'm2', num: 3, label: 'Leg press', x: 12, y: 0, w: 4, h: 3,
  settingsFields: [], muscles: ['Quads'],
});
gym.machines.push({
  id: 'c1', num: 4, label: 'Treadmill', x: 18, y: 0, w: 4, h: 3,
  settingsFields: [], muscles: [], cardio: true,
});
store.saveGym(gym);

// --- store CRUD ---

assert.deepEqual(store.getPlans(), [], 'plans start empty');
store.savePlan({ id: 'p1', name: 'A', items: [{ machineId: 'm1', exercise: null }] });
store.savePlan({ id: 'p2', name: 'B', items: [{ machineId: 'm2', exercise: null }] });
assert.equal(store.getPlans().length, 2);
store.savePlan({ id: 'p1', name: 'A2', items: [] });
assert.equal(store.getPlans().length, 2, 'savePlan upserts by id');
assert.equal(store.getPlans()[0].name, 'A2', 'upsert replaces in place');
store.deletePlan('p2');
assert.deepEqual(store.getPlans().map((p) => p.id), ['p1']);

// backup roundtrip carries plans
const backup = store.exportBackup();
assert.equal(backup.plans.length, 1, 'backup exports plans');
store.savePlans([]);
assert.equal(store.importData(backup), 'backup');
assert.deepEqual(store.getPlans().map((p) => p.id), ['p1'], 'backup import restores plans');
store.savePlans([]);

// --- workout-plan import ---

// nums resolve against the current gym; an unknown num keeps its item as
// an UNBOUND one (it binds on the gym floor) instead of dropping it
const { plan: imported, unbound } = store.planFromImport({
  app: 'gymii',
  kind: 'workout-plan',
  name: '  Push day  ',
  items: [
    { num: 1, sets: 0, reps: 8, weight: -5 }, // sets clamps to 1, weight to 0
    { num: 2, exercise: 'Biceps curls', sets: 3 }, // reps defaults to 10
    { num: 2, exercise: 'Gone', sets: 3 }, // unknown exercise -> station slot
    { num: 4, distance: 2000, seconds: 900 },
    { num: 99, sets: 3 },
    { name: 'Cable crossover', sets: 4, reps: 12, weight: 25 },
    { sets: 3 }, // neither num nor name — nothing to bind, dropped
  ],
});
assert.deepEqual(unbound, ['Machine 99', 'Cable crossover'],
  'unknown nums and machine-less names stay in the plan, unbound');
assert.equal(imported.name, 'Push day', 'name is trimmed');
assert.deepEqual(imported.items, [
  { machineId: 'm1', exercise: null, target: { sets: 1, reps: 8, weight: 0 } },
  { machineId: 'db', exercise: 'Biceps curls', target: { sets: 3, reps: 10, weight: 0 } },
  { machineId: 'db', exercise: null, target: { sets: 3, reps: 10, weight: 0 } },
  { machineId: 'c1', exercise: null, target: { distance: 2000, seconds: 900 } },
  {
    machineId: null, name: 'Machine 99', exercise: null, num: 99,
    target: { sets: 3, reps: 10, weight: 0 },
  },
  {
    machineId: null, name: 'Cable crossover', exercise: null,
    target: { sets: 4, reps: 12, weight: 25 },
  },
], 'items resolve, sanitize targets, cardio gets distance/seconds, rest unbound');

// a name that matches a machine label binds without any num
assert.deepEqual(store.planFromImport({ items: [{ name: 'leg press', sets: 3 }] }).plan.items, [
  { machineId: 'm2', exercise: null, target: { sets: 3, reps: 10, weight: 0 } },
], 'a label match binds by name alone');

assert.throws(() => store.planFromImport({ items: [] }), /no items/);

assert.equal(store.importData({ app: 'gymii', kind: 'workout-plan', name: 'X', items: [{ num: 1 }] }),
  'workout-plan', 'importData accepts the workout-plan kind');
assert.equal(store.getPlans().length, 1, 'importData persisted the plan');
store.savePlans([]);

// --- targets ride startWorkoutFrom into the active plan ---

startWorkoutFrom({
  name: 'Push day',
  entries: [
    { machineId: 'm1', exercise: null, target: { sets: 3, reps: 10, weight: 50 } },
    { machineId: 'm2', exercise: null }, // target-less items stay target-less
  ],
});
let active = store.getActive();
assert.deepEqual(active.plan, [
  { machineId: 'm1', exercise: null, target: { sets: 3, reps: 10, weight: 50 } },
  { machineId: 'm2', exercise: null },
], 'plan targets carry through; plain slots gain no key');
store.clearActive();

// --- render smoke: start screen -> builder -> saved plan -> guided flow ---

const stubEl = () => ({
  listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
  value: '', innerHTML: '', textContent: '',
  querySelector: () => stubEl(), querySelectorAll: () => [],
  // stateful so twoTapConfirm's arm/confirm cycle works in tests
  classList: (() => {
    const set = new Set();
    return {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      toggle: (c) => (set.has(c) ? set.delete(c) : set.add(c)),
      contains: (c) => set.has(c),
    };
  })(),
  dataset: {}, style: {},
  attrs: {},
  setAttribute(k, v) { this.attrs[k] = v; },
  getBoundingClientRect: () => ({ width: 358 }),
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
const fakeClick = (props) => ({ target: { closest: () => props } });

// start screen: empty plans section with the create button (the tab root
// is now the hub, so the tests navigate to the start screen first)
goToStart();
renderTrain(root);
assert.ok(root.innerHTML.includes('Planned workouts'), 'start screen has the plans section');
assert.ok(root.innerHTML.includes('Plan a workout'), 'and the create button');

// open the builder — a plan from scratch starts as a blank note
root.querySelector('#plan-new').listeners.click();
assert.ok(root.innerHTML.includes('Plan workout'), 'builder opens');
assert.ok(root.innerHTML.includes('id="plan-text"'), 'a new plan opens in the text view');

// switch to the list to pick machines the tappable way
root.querySelector('#view-chips').listeners.click(fakeClick({ dataset: { view: 'list' } }));
assert.ok(root.innerHTML.includes('Add an exercise'), 'the list shows the typed-line adder');
assert.ok(root.innerHTML.includes('Add from your gym'), 'and the machine adder');
assert.ok(root.innerHTML.includes('#1 Chest press'), 'machine chips render');
assert.ok(root.innerHTML.includes('Chest'), 'muscle filter chips render');

root.querySelector('#machine-chips').listeners.click(fakeClick({ dataset: { id: 'm1' } }));
assert.ok(root.innerHTML.includes('id="t-sets-0"'), 'added item shows target steppers');
root.querySelector('#plan-name').value = 'Push day';
root.querySelector('#plan-save').listeners.click();
assert.equal(store.getPlans().length, 1, 'save persists the plan');
const saved = store.getPlans()[0];
assert.equal(saved.name, 'Push day');
assert.deepEqual(saved.items, [
  { machineId: 'm1', exercise: null, target: { sets: 3, reps: 10, weight: 20 } },
], 'no-history item defaults to 3 x 10 @ 20');
assert.ok(root.innerHTML.includes('Planned workouts'), 'saving returns to the start screen');
assert.ok(root.innerHTML.includes('Push day'), 'saved plan gets its start row');

// start the plan: target shows in the header and prefills the first set
root.querySelector('#plan-list').listeners.click(fakeClick({
  dataset: { pid: saved.id }, classList: { contains: () => false },
}));
active = store.getActive();
assert.equal(active.name, 'Push day', 'starting a plan carries its name');
assert.deepEqual(active.plan[0].target, { sets: 3, reps: 10, weight: 20 });
assert.ok(root.innerHTML.includes('Target: 3 × 10 @ 20 kg'), 'log header shows the target');
assert.ok(root.innerHTML.includes('· set 1/3'), 'header counts the upcoming target set');
assert.ok(root.innerHTML.includes('✓ Log set 1/3 — 20 kg × 10'), 'one-tap button says what it logs');
assert.ok(root.innerHTML.includes('id="set-weight" type="number" inputmode="decimal" value="20"'),
  'first set prefills from the target');

// after a deviating set the prefill follows the real working weight
root.querySelector('#set-weight').value = '15';
root.querySelector('#set-reps').value = '8';
root.querySelector('#set-rest').value = '0';
root.querySelector('#log-set').listeners.click();
assert.ok(root.innerHTML.includes('id="set-weight" type="number" inputmode="decimal" value="15"'),
  'prefill follows the logged set, not the target');
assert.ok(root.innerHTML.includes('✓ Log set 2/3 — 15 kg × 8'),
  'one-tap button advances and follows the logged set');

// overview counts progress against the target
root.querySelector('#change-machine').listeners.click();
assert.ok(root.innerHTML.includes('1/3 sets'), 'overview shows target progress');
store.clearActive();

// --- "Next" pulls back to stations with unfinished targets ---

store.saveActive({
  v: 2, id: 'w-pull-back', startedAt: 1755000000000,
  plan: [
    { machineId: 'm1', exercise: null, target: { sets: 3, reps: 10, weight: 50 } },
    { machineId: 'm2', exercise: null },
  ],
  currentMachineId: 'm2', currentExercise: null,
  entries: [
    { machineId: 'm1', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 50, at: 1755000001000 }] },
    { machineId: 'm2', num: 3, label: 'Leg press', settings: {}, sets: [{ reps: 10, weight: 100, at: 1755000002000 }] },
  ],
});
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('Next: #1'), 'a 1/3 station stays an open Next stop');
store.clearActive();

// once the target is met, Next takes over as the primary action
store.saveActive({
  v: 2, id: 'w-next-primary', startedAt: 1755000000000,
  plan: [
    { machineId: 'm1', exercise: null, target: { sets: 1, reps: 10, weight: 50 } },
    { machineId: 'm2', exercise: null },
  ],
  currentMachineId: 'm1', currentExercise: null,
  entries: [{
    machineId: 'm1', num: 1, label: 'Chest press', settings: {},
    sets: [{ reps: 10, weight: 50, at: 1755000001000 }],
  }],
});
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('btn-primary btn-big">Next: #3'),
  'a met target promotes Next to the primary action');
assert.ok(root.innerHTML.includes('· ✓ done'), 'header marks the met target');
assert.ok(!root.innerHTML.includes('btn btn-primary btn-big">✓ Log set'),
  'the log button steps back once the target is met');
store.clearActive();

// --- start screen: a named plan owns its routine (no duplicate repeat row) ---

store.saveWorkouts([
  {
    id: 'w-push', startedAt: 1755000000000, finishedAt: 1755003600000, name: 'Push day',
    entries: [{ machineId: 'm1', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 50 }] }],
  },
  {
    id: 'w-legs', startedAt: 1755100000000, finishedAt: 1755103600000,
    entries: [{ machineId: 'm2', num: 3, label: 'Leg press', settings: {}, sets: [{ reps: 10, weight: 100 }] }],
  },
  {
    id: 'w-last', startedAt: 1755200000000, finishedAt: 1755203600000,
    entries: [{ machineId: 'm1', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 52 }] }],
  },
]);
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('data-wid="w-legs"'), 'unnamed routine keeps its repeat row');
assert.ok(!root.innerHTML.includes('data-wid="w-push"'),
  'routine matching a plan name is owned by the plan row');
assert.ok(root.innerHTML.includes('last: '), 'plan row shows when it was last done');

// --- days: import sanitizing, builder chips, Save & start ---

const { plan: dayPlan } = store.planFromImport({
  app: 'gymii', kind: 'workout-plan', name: 'D', days: [4, 1, 9, 4, -1, 2.5],
  items: [{ num: 1 }],
});
assert.deepEqual(dayPlan.days, [1, 4], 'days dedupe, sort and drop junk');
assert.ok(!('days' in store.planFromImport({ items: [{ num: 1 }] }).plan),
  'no days key when absent');

store.savePlans([]);
store.saveWorkouts([]); // deterministic start screen for the blocks below
byId.clear();
renderTrain(root);
root.querySelector('#plan-new').listeners.click();
// the stub DOM hands back every selector, rendered or not — switch to the
// list explicitly so this walks the same path a real builder would
root.querySelector('#view-chips').listeners.click(fakeClick({ dataset: { view: 'list' } }));
root.querySelector('#machine-chips').listeners.click(fakeClick({ dataset: { id: 'm1' } }));
const today = new Date().getDay();
root.querySelector('#day-chips').listeners.click(fakeClick({ dataset: { day: String(today) } }));
root.querySelector('#plan-name').value = 'Today plan';
root.querySelector('#plan-start').listeners.click();
assert.equal(store.getPlans().length, 1, 'Save & start persists the plan');
assert.deepEqual(store.getPlans()[0].days, [today], 'tapped day chip sticks');
active = store.getActive();
assert.ok(active, 'Save & start opens a workout right away');
assert.equal(active.name, 'Today plan');
assert.deepEqual(active.plan[0].target, { sets: 3, reps: 10, weight: 20 },
  'Save & start carries the target');
store.clearActive();

// today's plan floats above an untagged one stored earlier
store.savePlans([
  { id: 'pa', name: 'Anyday', items: [{ machineId: 'm1', exercise: null }] },
  { id: 'pb', name: 'Dayplan', days: [today], items: [{ machineId: 'm2', exercise: null }] },
]);
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.indexOf('Dayplan') < root.innerHTML.indexOf('Anyday'),
  "today's plan sorts to the top");
assert.ok(root.innerHTML.includes('· today'), 'today badge renders');

// --- plan-first: the relevant plan owns the big start button ---

assert.ok(root.innerHTML.includes('id="plan-primary"'),
  "today's plan gets the primary start button");
root.querySelector('#plan-primary').listeners.click();
active = store.getActive();
assert.equal(active.name, 'Dayplan', 'the primary button starts the relevant plan');
store.clearActive();

// repeat drops when the last workout came from the primary plan
store.saveWorkouts([{
  id: 'w-anyday', startedAt: 1755300000000, finishedAt: 1755301000000, name: 'Anyday',
  entries: [{ machineId: 'm1', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 50 }] }],
}]);
store.savePlans([{ id: 'pa', name: 'Anyday', items: [{ machineId: 'm1', exercise: null }] }]);
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('id="plan-primary"'),
  'the last-done plan is primary even without a weekday tag');
assert.ok(!root.innerHTML.includes('id="repeat"'),
  'repeat drops when it would start the primary plan anyway');
store.saveWorkouts([]);

// --- finishing reports target completion ---

store.saveActive({
  v: 2, id: 'w-finish', startedAt: 1755000000000,
  plan: [{ machineId: 'm1', exercise: null, target: { sets: 3, reps: 10, weight: 50 } }],
  currentMachineId: null, currentExercise: null,
  entries: [{
    machineId: 'm1', num: 1, label: 'Chest press', settings: {},
    sets: [
      { reps: 10, weight: 50, at: 1755000001000 },
      { reps: 10, weight: 50, at: 1755000002000 },
    ],
  }],
});
byId.clear();
renderTrain(root); // overview
const finishBtn = root.querySelector('#finish');
finishBtn.listeners.click(); // arm
finishBtn.listeners.click(); // confirm
assert.equal(store.getActive(), null, 'finish clears the active workout');
assert.ok(root.innerHTML.includes('2/3 target sets'), 'finish message tallies target sets');
store.saveWorkouts([]);

// --- reading a plan out of typed lines ---

const s = store.getSettings();
assert.deepEqual(store.parsePlanLine('Leg press 3x10 80', s),
  { name: 'Leg press', target: { sets: 3, reps: 10, weight: 80 } },
  'sets x reps and a bare weight');
assert.deepEqual(store.parsePlanLine('#7 Chest press 3x8-12 40kg', s),
  { name: 'Chest press', num: 7, target: { sets: 3, reps: 8, weight: 40 } },
  'a marked num binds later; a rep range targets its low end');
assert.deepEqual(store.parsePlanLine('12. Lat pulldown 4 sets x 12 reps @ 45', s),
  { name: 'Lat pulldown', num: 12, target: { sets: 4, reps: 12, weight: 45 } },
  'spelled-out sets/reps, "N." num marker and an @ weight');
assert.deepEqual(store.parsePlanLine('Treadmill 20min', s),
  { name: 'Treadmill', target: { distance: 0, seconds: 1200 } },
  'a duration alone makes it cardio');
assert.deepEqual(store.parsePlanLine('Rowing 2km 15min', s),
  { name: 'Rowing', target: { distance: 2000, seconds: 900 } },
  'distance + duration, converted to the display unit');
assert.deepEqual(store.parsePlanLine('Cable crossover', s),
  { name: 'Cable crossover' }, 'a bare name is a valid item — targets are optional');
assert.equal(store.parsePlanLine('Push day:', s), null, 'a heading is not an exercise');
assert.equal(store.parsePlanLine('   ', s), null, 'blank lines drop');
assert.equal(store.parsePlanLine('3x10', s), null, 'a set term with no movement drops');
// a bare leading number stays in the name — "45 degree leg press" is not #45
assert.deepEqual(store.parsePlanLine('45 degree leg press 3x10', s),
  { name: '45 degree leg press', target: { sets: 3, reps: 10, weight: 0 } },
  'an unmarked leading number is part of the name');

// lbs in the note convert into a kg profile
assert.equal(store.parsePlanLine('Bench 3x10 100lb', s).target.weight, 45.5,
  'a note written in lbs converts to the display unit');

assert.equal(store.parsePlanText('Leg press 3x10 80\n\nDay B:\nTreadmill 20min', s).length, 2,
  'parsePlanText drops blanks and headings');

// --- name suggestions: derived from what was trained, not asked for ---

const nameGym = store.newGym('Naming gym');
[
  ['p1', 1, 'Chest press', ['Chest']],
  ['p2', 2, 'Shoulder press', ['Shoulders']],
  ['p3', 3, 'Triceps pushdown', ['Triceps']],
  ['l1', 4, 'Leg press', ['Quads', 'Glutes']],
  ['l2', 5, 'Leg curl', ['Hamstrings']],
  ['b1', 6, 'Row', ['Lats', 'Upper back']],
].forEach(([id, n, label, muscles]) => nameGym.machines.push({
  id, num: n, label, x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles,
}));

assert.ok(store.suggestWorkoutNames(['p1', 'p2', 'p3'], nameGym).includes('Push day'),
  'chest + shoulders + triceps reads as a push day');
assert.ok(store.suggestWorkoutNames(['l1', 'l2'], nameGym).includes('Leg day'),
  'a legs-only session reads as a leg day');
assert.ok(store.suggestWorkoutNames(['b1'], nameGym).includes('Pull day'),
  'lats + upper back read as a pull day');
assert.deepEqual(store.suggestWorkoutNames(['p1', 'l1'], nameGym), ['Chest', 'Chest & Legs'],
  'a mixed session falls back to its regions, never to a wrong split');
assert.deepEqual(store.suggestWorkoutNames([], nameGym), [], 'nothing trained, nothing to suggest');
assert.deepEqual(store.suggestWorkoutNames(['nope'], nameGym), [],
  'machines without muscles suggest nothing');

store.saveWorkouts([
  { id: 'n1', startedAt: 1, name: 'Old one', entries: [] },
  { id: 'n2', startedAt: 2, entries: [] },
  { id: 'n3', startedAt: 3, name: 'Push day', entries: [] },
  { id: 'n4', startedAt: 4, name: 'Push day', entries: [] },
]);
assert.deepEqual(store.recentWorkoutNames(), ['Push day', 'Old one'],
  'names already in use come back newest first, deduped');

// nameChipsFor is what the overview, the history editor and the builder all
// render: suggestions first, names already in use after, deduped and capped
assert.deepEqual(store.nameChipsFor(['p1', 'p2', 'p3'], nameGym),
  ['Push day', 'Chest', 'Chest & Shoulders', 'Old one'],
  'suggestions lead, recent names fill up, a name in both appears once');
assert.deepEqual(store.nameChipsFor([], nameGym), ['Push day', 'Old one'],
  'nothing trained: only the names already in use');
assert.deepEqual(store.nameChipsFor(['l1', 'l2'], nameGym, 2), ['Leg day', 'Legs'],
  'the limit cuts the tail, never the suggestions');
// the weighting the call sites depend on: train/history pass one id PER
// LOGGED SET, so a station trained three times outvotes a single visit
assert.deepEqual(store.nameChipsFor(['p1', 'p1', 'p1', 'l1'], nameGym),
  ['Push day', 'Chest', 'Chest & Legs', 'Old one'],
  'repeated ids weight the suggestion — three chest sets make it a push day');
assert.deepEqual(store.nameChipsFor(['p1', 'l1'], nameGym),
  ['Chest', 'Chest & Legs', 'Push day', 'Old one'],
  'one id each: no split is claimed, "Push day" only rides in as a recent name');
store.saveWorkouts([]);

// --- text view: planToText is the exact inverse of parsePlanText ---

const roundTripItems = [
  { machineId: 'm1', exercise: null, target: { sets: 3, reps: 10, weight: 80 } },
  { machineId: 'db', exercise: 'Biceps curls', target: { sets: 4, reps: 12, weight: 15 } },
  { machineId: 'c1', exercise: null, target: { distance: 2000, seconds: 900 } },
  { machineId: null, name: 'Cable crossover', exercise: null, num: 21, target: { sets: 3, reps: 12, weight: 25 } },
  { machineId: null, name: 'Plank', exercise: null },
];
const note = store.planToText(roundTripItems, gym, s);
assert.equal(note, [
  '#1 Chest press 3x10 80',
  '#2 Dumbbells: Biceps curls 4x12 15',
  '#4 Treadmill 2000m 15min',
  '#21 Cable crossover 3x12 25',
  'Plank',
].join('\n'), 'items serialise to the note they would have been written as');
assert.deepEqual(store.planItemsFrom(store.parsePlanText(note, s), gym), roundTripItems,
  'and read back into exactly the same items');

// a bare weight of 0 is left out and comes back as 0
assert.equal(store.planToText([{ machineId: 'm1', exercise: null, target: { sets: 3, reps: 10, weight: 0 } }], gym, s),
  '#1 Chest press 3x10', 'a zero weight is not written out');

// only a marked num unlocks the "station: exercise" reading — otherwise
// the colon stays part of the name instead of eating half of it
assert.deepEqual(store.parsePlanLine('Day A: Leg press 3x10', s),
  { name: 'Day A: Leg press', target: { sets: 3, reps: 10, weight: 0 } },
  'without a #num a colon does not split off an exercise');
assert.deepEqual(store.parsePlanLine('#2 Dumbbells: Shoulder press 3x10 20', s),
  { name: 'Dumbbells', num: 2, exercise: 'Shoulder press', target: { sets: 3, reps: 10, weight: 20 } },
  'with a #num it names a movement at that station');

// --- onboarding: the typed plan is the way in, before any gym exists ---

store.createProfile('Fresh gym'); // empty profile -> onboarding screen
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('Type in your plan'), 'onboarding leads with the plan note');
assert.ok(root.innerHTML.includes('id="ob-plan"'), 'and offers the textarea');
assert.ok(root.innerHTML.includes('At the gym right now?'), 'quick start stays, one line');

root.querySelector('#ob-plan').value = 'Leg press 3x10 80\nLat pulldown 3x12 45\nTreadmill 20min';
root.querySelector('#ob-read').listeners.click();
assert.equal(store.getPlans().length, 1, 'reading the note saves a plan');
const typed = store.getPlans()[0];
assert.equal(typed.items.length, 3, 'every line became an item');
assert.ok(typed.items.every((it) => store.isUnbound(it)),
  'without a gym every item starts unbound');
assert.equal(store.getGym(), null, 'reading a plan does NOT create a gym');
assert.ok(root.innerHTML.includes('Edit plan'), 'review opens in the builder');
assert.ok(root.innerHTML.includes('Leg press'), 'with the exercise names from the note');
assert.ok(root.innerHTML.includes('Assign machine'), 'each unbound item offers binding');

// --- binding on the gym floor: the gym grows out of the plan ---

root.querySelector('#plan-save').listeners.click();
byId.clear();
goToStart(); // the primary plan button lives on the start screen
renderTrain(root);
root.querySelector('#plan-primary').listeners.click(); // start the typed plan
let bound = store.getActive();
assert.equal(bound.planId, typed.id, 'the active workout remembers its plan');
assert.equal(bound.plan.length, 3, 'unbound slots survive into the guided flow');
assert.ok(store.getGym(), 'starting a workout creates the empty gym it needs');

byId.clear();
renderTrain(root); // overview — every slot is unbound
assert.ok(root.innerHTML.includes('assign'), 'the overview asks for the missing machines');
root.querySelectorAll = () => [];
bound.binding = 0;
store.saveActive(bound);
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('Which machine is this?'), 'the bind screen asks once');
root.querySelector('#bind-num').value = '14';
root.querySelector('#bind-go').listeners.click();
bound = store.getActive();
const created = store.getGym().machines.find((m) => m.num === 14);
assert.ok(created, 'an unknown number creates the machine');
assert.equal(created.label, 'Leg press', 'under the name the plan gave it');
assert.equal(bound.plan[0].machineId, created.id, 'the slot is bound');
assert.equal(bound.currentMachineId, created.id, 'and logging starts right there');
assert.equal(store.getPlans()[0].items[0].machineId, created.id,
  'the binding is written back into the stored plan');
assert.ok(!('name' in store.getPlans()[0].items[0]), 'a bound item drops its name');

// the same bind on a cardio line: the station is born cardio, or its
// distance/time target would be dropped as the wrong shape right away
bound.binding = 2; // "Treadmill 20min"
store.saveActive(bound);
byId.clear();
renderTrain(root);
root.querySelector('#bind-num').value = '21';
root.querySelector('#bind-go').listeners.click();
const treadmill = store.getGym().machines.find((m) => m.num === 21);
assert.equal(treadmill.label, 'Treadmill', 'the cardio line names its station too');
assert.equal(treadmill.cardio, true, 'a distance/time target makes the new station cardio');
assert.deepEqual(store.getActive().plan[2].target, { distance: 0, seconds: 1200 },
  'so the target survives the bind instead of being dropped as the wrong shape');

// --- logging a workout that already happened ---

store.clearActive();
store.saveWorkouts([]);
const past = store.workoutFromText(
  '#14 Leg press 3x10 85\n#42 Pec deck 2x12 30\nSome unknown thing 3x10\nRowing 2km 10min',
  Date.UTC(2026, 7, 4, 17), s);
assert.deepEqual(past.skipped, ['Some unknown thing', 'Rowing'],
  'lines naming no findable machine are reported, never invented');
assert.deepEqual(past.workout.entries.map((e) => [e.num, e.label, e.sets.length]), [
  [14, 'Leg press', 3],
  [42, 'Pec deck', 2],
], 'a target of 3x10 becomes three real sets');
assert.deepEqual(past.workout.entries[0].sets[0], { reps: 10, weight: 85 },
  'each set carries the reps and weight from the note');
assert.ok(!('at' in past.workout.entries[0].sets[0]),
  'a set logged after the fact never claims a live timestamp');
assert.ok(!('finishedAt' in past.workout), 'an unknown duration stays unknown');
assert.ok(store.getGym().machines.some((m) => m.num === 42 && m.label === 'Pec deck'),
  'an unknown #num creates that machine, like binding does');
assert.throws(() => store.workoutFromText('nothing here 3x', Date.now(), s), /No line named a machine/);
assert.throws(() => store.workoutFromText('', Date.now(), s), /No exercises found/);

// history stays chronological no matter which order writers use
store.saveWorkouts([
  { id: 'late', startedAt: 3000, entries: [] },
  { id: 'early', startedAt: 1000, entries: [] },
  { id: 'mid', startedAt: 2000, entries: [] },
]);
assert.deepEqual(store.getWorkouts().map((w) => w.id), ['early', 'mid', 'late'],
  'saveWorkouts sorts by startedAt, so a back-dated workout lands in place');
store.saveWorkouts([]);

// --- a derived routine is not a dead end: tapping it opens its settings ---

store.savePlans([]);
const freshGym = store.getGym();
const legId = freshGym.machines.find((m) => m.num === 14).id;
const pecId = freshGym.machines.find((m) => m.num === 42).id;
const rEntry = (id, n, label, sets) => ({ machineId: id, num: n, label, settings: {}, sets });
store.saveWorkouts([
  {
    id: 'r-old', startedAt: 1755000000000, finishedAt: 1755003600000,
    entries: [
      rEntry(legId, 14, 'Leg press', [{ reps: 10, weight: 90 }, { reps: 10, weight: 90 }]),
      rEntry(pecId, 42, 'Pec deck', [{ reps: 12, weight: 35 }]),
    ],
  },
  { // the newest workout owns the "Repeat last" button, so it is NOT a routine row
    id: 'r-new', startedAt: 1755100000000, finishedAt: 1755103600000,
    entries: [rEntry(legId, 14, 'Leg press', [{ reps: 10, weight: 95 }])],
  },
]);
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('id="routine-list"'), 'derived routines get a list');
assert.ok(root.innerHTML.includes('row-open" data-wid="r-old"'),
  'the row itself is a button, not dead text');
assert.ok(root.innerHTML.includes('row-chevron'), 'and it looks tappable');

root.querySelector('#routine-list').listeners.click(fakeClick({
  dataset: { wid: 'r-old' }, classList: { contains: (c) => c === 'row-open' },
}));
assert.ok(root.innerHTML.includes('Plan workout'), 'tapping a routine opens the builder');
assert.ok(root.innerHTML.includes('From a routine you already train'), 'and says where it came from');
assert.ok(root.innerHTML.includes('id="t-sets-0"') && root.innerHTML.includes('id="t-sets-1"'),
  'seeded with both of its machines, targets ready to edit');
// the routine picks the MACHINES; the targets still come from the newest
// session on each of them (95, not this routine's older 90) — when
// planning, your current working weight is the honest starting point
assert.ok(root.innerHTML.includes('value="95"'),
  "targets are seeded from each machine's latest session, not the routine's");
assert.equal(store.getPlans().length, 0, 'nothing is stored until Save');

root.querySelector('#plan-name').value = 'Legs & chest';
root.querySelector('#plan-save').listeners.click();
assert.deepEqual(store.getPlans()[0].items.map((it) => it.machineId), [legId, pecId],
  'saving turns the routine into a real plan, in its own order');
assert.equal(store.getPlans()[0].name, 'Legs & chest');

// the routine row is gone now: the plan covers exactly those machines, so
// keeping both would list the same session twice
byId.clear();
renderTrain(root);
assert.ok(!root.innerHTML.includes('data-wid="r-old"'),
  'a plan made from a routine takes that routine over');

// and a stored plan's row opens it for editing
root.querySelector('#plan-list').listeners.click(fakeClick({
  dataset: { pid: store.getPlans()[0].id }, classList: { contains: (c) => c === 'row-open' },
}));
assert.ok(root.innerHTML.includes('Edit plan'), 'tapping a plan row edits it');
root.querySelector('#plan-cancel').listeners.click(); // leave the builder closed
store.saveWorkouts([]);
store.savePlans([]);

// --- weekdays: what today is about ---

store.savePlans([]);
store.saveWorkouts([]);
// a fixed local noon; weekdays are derived from it so this holds any day
const noon = new Date(2026, 7, 13, 12, 0, 0);
const dow = noon.getDay();
const back = (n) => (dow + 7 - n) % 7;
const dayMs = 86400000;
const madeLongAgo = { createdAt: noon.getTime() - 90 * dayMs };

const duePlan = { id: 'pd', name: 'Push day', days: [dow], items: [], ...madeLongAgo };
assert.equal(store.planDayState(duePlan, [], noon).state, 'due', "today's plan is due");
assert.equal(store.planDueDay(duePlan, noon).getDay(), dow, 'the due day is today');
assert.equal(store.planNextDay(duePlan, noon).getDay(), dow,
  'and the next one is that weekday again');

// trained today -> done, and the sentence turns into a receipt
const doneToday = [{ id: 'wt', startedAt: noon.getTime() - 3600000, planId: 'pd', entries: [] }];
assert.equal(store.planDayState(duePlan, doneToday, noon).state, 'done',
  'a workout logged today closes it out');
// older workouts have no planId — the name still links them
assert.equal(store.planDayState(duePlan,
  [{ id: 'wo', startedAt: noon.getTime() - 3600000, name: 'Push day', entries: [] }], noon).state,
'done', 'a pre-planId workout is matched by name');

// A day that went by counts as missed only while the rhythm is alive —
// the cycle before it was trained. Otherwise the plan simply isn't
// running, and saying "you missed Monday" every week would be nagging.
const missedPlan = { id: 'pm', name: 'Leg day', days: [back(1)], items: [], ...madeLongAgo };
const lastCycle = [{ id: 'wp', startedAt: noon.getTime() - 8 * dayMs, planId: 'pm', entries: [] }];
assert.equal(store.planDayState(missedPlan, lastCycle, noon).state, 'missed',
  'a day that went by, on a plan that was running');
assert.equal(store.planDayState(missedPlan, [], noon).state, 'clear',
  'a plan nobody has started is not "missed" every week');
assert.equal(store.planDayState(missedPlan,
  [...lastCycle, { id: 'w', startedAt: noon.getTime() - 2 * 3600000, planId: 'pm', entries: [] }],
  noon).state, 'clear', 'and it clears once it was trained since');

// a day BEFORE the plan existed was never missed
assert.equal(store.planDayState(
  { ...missedPlan, createdAt: noon.getTime() }, [], noon).state, 'clear',
'a plan created today did not miss yesterday');

// skipping settles this cycle only
store.savePlans([missedPlan]);
store.skipPlanDay('pm', noon);
assert.equal(store.planDayState(store.getPlans()[0], lastCycle, noon).state, 'skipped',
  'skipped for now');
const nextWeek = new Date(noon.getTime() + 7 * dayMs);
const trainedAfterSkip = [{ id: 'ws', startedAt: noon.getTime() + dayMs, planId: 'pm', entries: [] }];
assert.equal(store.planDayState(store.getPlans()[0], trainedAfterSkip, nextWeek).state, 'missed',
  'the skip settles one cycle, not a permanent free pass');
assert.equal(store.planDayState(store.getPlans()[0], lastCycle, nextWeek).state, 'clear',
  'but a plan left alone after a skip goes quiet rather than nagging on');

// --- todayStatus picks the most actionable plan ---

store.saveWorkouts([]);
assert.equal(store.todayStatus([], [], noon), null, 'no dated plans, nothing to say');
assert.equal(store.todayStatus([{ id: 'x', name: 'Untagged', items: [] }], [], noon), null,
  'plans without weekdays stay silent');
assert.equal(store.todayStatus([missedPlan, duePlan], [], noon).plan.id, 'pd',
  "what's due today outranks what was missed");
assert.equal(store.todayStatus([duePlan], doneToday, noon).state, 'done');
const restStatus = store.todayStatus(
  [{ id: 'pr', name: 'Pull day', days: [(dow + 2) % 7], items: [], ...madeLongAgo }], [], noon);
assert.equal(restStatus.state, 'rest', 'nothing outstanding reads as a rest day');
assert.equal(restStatus.next.getDay(), (dow + 2) % 7, 'and names when the next one lands');

// --- the rhythm gymii notices ---

const rhythmPlan = { id: 'pr2', name: 'Legs', items: [] };
const on = (weekday, weeksAgo) => ({
  id: `r${weekday}-${weeksAgo}`, name: 'Legs',
  startedAt: noon.getTime() - weeksAgo * 7 * dayMs - ((dow - weekday + 7) % 7) * dayMs,
  entries: [],
});
assert.equal(store.usualWeekday(rhythmPlan, [on(back(1), 1), on(back(1), 2)]), null,
  'two sessions are not a rhythm');
const tueish = [on(back(1), 1), on(back(1), 2), on(back(1), 3), on(back(4), 4)];
assert.equal(store.usualWeekday(rhythmPlan, tueish), back(1),
  'three of four on the same weekday is');
assert.equal(store.usualWeekday(rhythmPlan,
  [on(back(1), 1), on(back(2), 2), on(back(3), 3)]), null,
'a scattered week suggests nothing');

// --- the start screen says it out loud ---

// renderTrain reads the real clock, so this plan is tagged with the real
// weekday rather than the fixed one the logic assertions above use
store.savePlans([{
  id: 'pd', name: 'Push day', days: [new Date().getDay()], items: [],
  createdAt: Date.now() - 90 * dayMs,
}]);
store.saveWorkouts([]);
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('class="day-status"'), 'the start screen states the day');
assert.ok(root.innerHTML.includes('<strong>Push day</strong> is on.'), 'naming what is on');
assert.ok(root.innerHTML.includes('id="plan-primary"'), 'and it owns the big button');

// once trained, the plan stops shouting
store.saveWorkouts([{
  id: 'w-today', startedAt: Date.now(), finishedAt: Date.now(), name: 'Push day', planId: 'pd',
  entries: [{ machineId: 'm1', num: 1, label: 'x', settings: {}, sets: [{ reps: 1, weight: 1 }] }],
}]);
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('day-status done'), 'a finished plan day reads as done');
assert.ok(!root.innerHTML.includes('id="plan-primary"'),
  'and stops holding the primary button hostage');
store.saveWorkouts([]);
store.savePlans([]);

// --- the Plans screen: the hub tile's own, smaller surface ---
store.savePlans([store.planFromText('Leg press 3x10 80')]);
goToPlans();
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('<h1>Plans</h1>'), 'the plans screen has its own heading');
assert.ok(root.innerHTML.includes('Planned workouts') && root.innerHTML.includes('Plan a workout'),
  'and renders the shared plan card');
assert.ok(!root.innerHTML.includes('Start at a machine'), 'but none of the start screen');
assert.ok(root.innerHTML.includes('id="back-hub"'), 'with a back row to the hub');

// opening the builder from here and leaving returns here — the builder
// outranks the screen state without ever touching it
root.querySelector('#plan-new').listeners.click();
assert.ok(root.innerHTML.includes('Plan workout'), 'the builder opens from the plans screen');
assert.ok(root.innerHTML.includes('id="plan-back"'), 'the builder carries its own back row');
root.querySelector('#plan-back').listeners.click();
assert.ok(root.innerHTML.includes('<h1>Plans</h1>'),
  'backing out of the builder returns to the plans screen');
store.savePlans([]);
goToHub();

console.log('workout plans: all assertions passed');
