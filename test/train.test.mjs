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
const { startWorkoutFrom } = await import(new URL('../js/train.js', import.meta.url).href);

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

console.log('train plan construction: all assertions passed');
