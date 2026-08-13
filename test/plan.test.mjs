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
const { startWorkoutFrom, renderTrain } = await import(new URL('../js/train.js', import.meta.url).href);

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

// nums resolve against the current gym; unknown nums are skipped, not fatal
const { plan: imported, skipped } = store.planFromImport({
  app: 'gymii',
  kind: 'workout-plan',
  name: '  Push day  ',
  items: [
    { num: 1, sets: 0, reps: 8, weight: -5 }, // sets clamps to 1, weight to 0
    { num: 2, exercise: 'Biceps curls', sets: 3 }, // reps defaults to 10
    { num: 2, exercise: 'Gone', sets: 3 }, // unknown exercise -> station slot
    { num: 4, distance: 2000, seconds: 900 },
    { num: 99, sets: 3 },
    { sets: 3 },
  ],
});
assert.deepEqual(skipped, [99, '?'], 'unknown / missing nums land in skipped');
assert.equal(imported.name, 'Push day', 'name is trimmed');
assert.deepEqual(imported.items, [
  { machineId: 'm1', exercise: null, target: { sets: 1, reps: 8, weight: 0 } },
  { machineId: 'db', exercise: 'Biceps curls', target: { sets: 3, reps: 10, weight: 0 } },
  { machineId: 'db', exercise: null, target: { sets: 3, reps: 10, weight: 0 } },
  { machineId: 'c1', exercise: null, target: { distance: 2000, seconds: 900 } },
], 'items resolve, sanitize targets, cardio gets distance/seconds');

assert.throws(() => store.planFromImport({ items: [{ num: 99 }] }), /No machines matched/);
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
  classList: { toggle() {}, add() {}, contains: () => false },
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

// start screen: empty plans section with the create button
renderTrain(root);
assert.ok(root.innerHTML.includes('Planned workouts'), 'start screen has the plans section');
assert.ok(root.innerHTML.includes('Plan a workout'), 'and the create button');

// open the builder, add a machine via its chip, name it, save
root.querySelector('#plan-new').listeners.click();
assert.ok(root.innerHTML.includes('Plan workout'), 'builder opens');
assert.ok(root.innerHTML.includes('Add machines'), 'builder shows the adder');
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
assert.ok(root.innerHTML.includes('id="set-weight" type="number" inputmode="decimal" value="20"'),
  'first set prefills from the target');

// after a deviating set the prefill follows the real working weight
root.querySelector('#set-weight').value = '15';
root.querySelector('#set-reps').value = '8';
root.querySelector('#set-rest').value = '0';
root.querySelector('#log-set').listeners.click();
assert.ok(root.innerHTML.includes('id="set-weight" type="number" inputmode="decimal" value="15"'),
  'prefill follows the logged set, not the target');

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

console.log('workout plans: all assertions passed');
