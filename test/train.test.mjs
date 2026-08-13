// Logic-level test for train.js's guided-plan construction: one slot per
// (machine, exercise) pair on repeat, dedupe, and fallbacks for machines
// or exercises that no longer exist.
// Run with: node test/train.test.mjs
import { strict as assert } from 'node:assert';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const store = await import(new URL('../js/store.js', import.meta.url).href);
const { startWorkoutFrom, renderTrain } = await import(new URL('../js/train.js', import.meta.url).href);

const gym = store.newGym('Test gym');
gym.machines.push({ id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [] });
gym.machines.push({
  id: 'db', num: 2, label: 'Dumbbells', x: 6, y: 0, w: 4, h: 3, settingsFields: [],
  exercises: ['Biceps curls', 'Shoulder press'],
});
store.saveGym(gym);

const entry = (machineId, exercise = null, extra = {}) => ({
  machineId, num: 0, label: 'x', ...(exercise ? { exercise } : {}),
  settings: {}, sets: [{ reps: 8, weight: 10 }], ...extra,
});

// repeat plans one slot per (machine, exercise) pair, in source order, and
// pre-picks the first slot's exercise
startWorkoutFrom({
  entries: [entry('m1'), entry('db', 'Biceps curls'), entry('db', 'Shoulder press')],
});
let active = store.getActive();
assert.deepEqual(active.plan, [
  { machineId: 'm1', exercise: null },
  { machineId: 'db', exercise: 'Biceps curls' },
  { machineId: 'db', exercise: 'Shoulder press' },
], 'one slot per (machine, exercise) pair');
assert.equal(active.currentMachineId, 'm1');
assert.strictEqual(active.currentExercise, null);

startWorkoutFrom({ entries: [entry('db', 'Shoulder press'), entry('m1')] });
active = store.getActive();
assert.equal(active.currentMachineId, 'db');
assert.equal(active.currentExercise, 'Shoulder press', 'first slot pre-picks its exercise');

// duplicate pairs collapse into one slot
startWorkoutFrom({ entries: [entry('db', 'Biceps curls'), entry('db', 'Biceps curls')] });
assert.equal(store.getActive().plan.length, 1, 'duplicate pairs dedupe');

// an exercise the machine no longer offers falls back to a station slot —
// which is dropped again when exercise slots for the same machine exist
startWorkoutFrom({ entries: [entry('db', 'Gone')] });
assert.deepEqual(store.getActive().plan, [{ machineId: 'db', exercise: null }],
  'unknown exercise falls back to a whole-station slot');
startWorkoutFrom({ entries: [entry('db', 'Gone'), entry('db', 'Biceps curls')] });
assert.deepEqual(store.getActive().plan, [{ machineId: 'db', exercise: 'Biceps curls' }],
  'station slot dropped when exercise slots for the machine exist');

// deleted machines fall out of the plan; firstMachineId seeds a free session
startWorkoutFrom({ entries: [entry('ghost'), entry('m1')] });
assert.deepEqual(store.getActive().plan, [{ machineId: 'm1', exercise: null }],
  'entries of deleted machines are skipped');
startWorkoutFrom(null, 'm1');
active = store.getActive();
assert.deepEqual(active.plan, [{ machineId: 'm1', exercise: null }]);
assert.equal(active.currentMachineId, 'm1');
assert.strictEqual(active.currentExercise, null);

// --- logging-screen render smoke ---
// renderLog once referenced a variable that a refactor had moved out of
// scope, throwing for EVERY machine; a bare innerHTML render catches that
// whole bug class. Stub just enough DOM: renderLog only sets innerHTML and
// wires listeners via (optionally chained) querySelector.
const stubEl = () => ({
  listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
  value: '', innerHTML: '',
  querySelector: () => stubEl(), querySelectorAll: () => [],
  classList: { toggle() {}, add() {} }, dataset: {}, style: {},
});
// Per-id registry so a test can preset input values and capture a
// specific element's click listener (e.g. #log-set) before invoking it.
const byId = new Map();
const root = {
  innerHTML: '',
  querySelector(sel) {
    if (!byId.has(sel)) byId.set(sel, stubEl());
    return byId.get(sel);
  },
  querySelectorAll: () => [],
};

// plain machine: full logging UI
store.saveActive({
  v: 2, id: 'w-log', startedAt: 1755000000000,
  plan: [{ machineId: 'm1', exercise: null }],
  currentMachineId: 'm1', currentExercise: null, entries: [],
});
renderTrain(root);
assert.ok(root.innerHTML.includes('Log set'), 'plain machine renders the set logger');

// multi-exercise station, no exercise picked yet: chip picker, no logger
store.saveActive({
  v: 2, id: 'w-pick', startedAt: 1755000000000,
  plan: [{ machineId: 'db', exercise: null }],
  currentMachineId: 'db', currentExercise: null, entries: [],
});
renderTrain(root);
assert.ok(root.innerHTML.includes('Biceps curls'), 'station renders its exercise chips');
assert.ok(!root.innerHTML.includes('Log set'), 'no logger while the exercise pick is pending');

// #log-set stamps `at: Date.now()` onto the logged set
store.saveActive({
  v: 2, id: 'w-log-at', startedAt: 1755000000000,
  plan: [{ machineId: 'm1', exercise: null }],
  currentMachineId: 'm1', currentExercise: null, entries: [],
});
byId.clear();
renderTrain(root);
// preset values before the click handler reads them; the registry hands
// the click handler the very same stub elements back
root.querySelector('#set-weight').value = '50';
root.querySelector('#set-reps').value = '5';
root.querySelector('#set-rest').value = '0'; // startRest(0) returns before touching document
const before = Date.now();
root.querySelector('#log-set').listeners.click();
const after = Date.now();

const loggedEntry = store.getActive().entries.find((e) => e.machineId === 'm1');
const loggedSet = loggedEntry.sets.at(-1);
assert.equal(loggedSet.reps, 5);
assert.equal(loggedSet.weight, 50);
assert.equal(typeof loggedSet.at, 'number', 'logged set carries a numeric at timestamp');
assert.ok(loggedSet.at >= before && loggedSet.at <= after, 'at is stamped at log time');

// --- quick-switch chips ---
// a superset session logging at station A with `at`-stamped sets on B and
// C shows chips for the OTHER stations, newest first-ish (both present),
// but never a chip for the current station A itself.
gym.machines.push({ id: 'm2', num: 3, label: 'Back extension', x: 12, y: 0, w: 4, h: 3, settingsFields: [] });
store.saveGym(gym);

store.saveActive({
  v: 2, id: 'w-quick-switch', startedAt: 1755000000000,
  plan: [{ machineId: 'm1', exercise: null }, { machineId: 'db', exercise: null }, { machineId: 'm2', exercise: null }],
  currentMachineId: 'm1', currentExercise: null,
  entries: [
    { machineId: 'm1', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 8, weight: 10, at: 1755000005000 }] },
    { machineId: 'db', num: 2, label: 'Dumbbells', exercise: 'Biceps curls', settings: {}, sets: [{ reps: 8, weight: 10, at: 1755000001000 }] },
    { machineId: 'm2', num: 3, label: 'Back extension', settings: {}, sets: [{ reps: 8, weight: 10, at: 1755000002000 }] },
  ],
});
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('quick-switch'), 'quick-switch block renders for stations with at-stamped sets');
assert.ok(root.innerHTML.includes('#2 Dumbbells'), 'chip for station B (Dumbbells)');
assert.ok(root.innerHTML.includes('#3 Back extension'), 'chip for station C (Back extension)');
assert.ok(!root.innerHTML.includes('↩ #1 Chest press'), 'no quick-switch chip for the current station');

// tapping a chip swings the session back: currentMachineId/currentExercise
// switch to the tapped station and the entry that owns its newest set
const quickSwitchChip = root.querySelector('.quick-switch').listeners.click;
quickSwitchChip({ target: { closest: () => ({ dataset: { machine: 'db' } }) } });
active = store.getActive();
assert.equal(active.currentMachineId, 'db', 'tapping a chip switches the current station');
assert.equal(active.currentExercise, 'Biceps curls', 'tapping a chip switches to the entry\'s exercise');

// a session whose OTHER-station sets lack `at` renders no quick-switch
// block at all — nothing to rank, nothing to show
store.saveActive({
  v: 2, id: 'w-quick-switch-no-at', startedAt: 1755000000000,
  plan: [{ machineId: 'm1', exercise: null }, { machineId: 'db', exercise: null }],
  currentMachineId: 'm1', currentExercise: null,
  entries: [
    { machineId: 'm1', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 8, weight: 10, at: 1755000005000 }] },
    { machineId: 'db', num: 2, label: 'Dumbbells', exercise: 'Biceps curls', settings: {}, sets: [{ reps: 8, weight: 10 }] },
  ],
});
byId.clear();
renderTrain(root);
assert.ok(!root.innerHTML.includes('quick-switch'), 'no quick-switch block when other-station sets lack at');

console.log('train plan construction: all assertions passed');
