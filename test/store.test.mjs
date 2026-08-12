// Logic-level test for gymii's store: workout finishing, last-entry
// lookup, and the export -> clear -> import roundtrip.
// Run with: node test/store.test.mjs
import { strict as assert } from 'node:assert';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const store = await import(new URL('../js/store.js', import.meta.url).href);

// build a gym
const gym = store.newGym('Test gym');
gym.machines.push({ id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: ['Seat'] });
gym.machines.push({ id: 'm2', num: 2, label: 'Lat pulldown', x: 6, y: 0, w: 4, h: 3, settingsFields: [] });
store.saveGym(gym);

// log a workout; the set-less entry must be dropped on finish
store.saveActive({
  v: 1, id: 'w1', startedAt: 1000, mode: 'free', queue: null, queueIndex: 0,
  currentMachineId: null,
  entries: [
    { machineId: 'm1', num: 1, label: 'Chest press', settings: { Seat: '4' }, sets: [{ reps: 10, weight: 40 }, { reps: 8, weight: 45 }] },
    { machineId: 'm2', num: 2, label: 'Lat pulldown', settings: {}, sets: [] },
  ],
});
const activeBefore = store.getActive();
activeBefore.locker = '23';
const saved = store.finishWorkout(activeBefore);
assert.equal(saved.entries.length, 1, 'set-less entries dropped');
assert.equal(saved.locker, '23', 'locker number carried into history');
assert.equal(store.getActive(), null, 'active cleared after finish');
assert.equal(store.getWorkouts().length, 1);

// last-entry lookup feeds the training defaults
const last = store.lastEntryFor('m1');
assert.equal(last.sets[1].weight, 45);
assert.equal(last.settings.Seat, '4');
assert.equal(store.lastEntryFor('m2'), null, 'machines without sets have no last entry');

// export -> clear -> import roundtrip
const backup = store.exportBackup();
const template = store.exportGymTemplate();
store.clearAll();
assert.equal(store.getGym(), null);
assert.equal(store.importData(JSON.parse(JSON.stringify(backup))), 'backup');
assert.equal(store.getGym().name, 'Test gym');
assert.equal(store.getWorkouts().length, 1);
assert.equal(store.lastEntryFor('m1').sets[0].weight, 40);
store.clearAll();
assert.equal(store.importData(JSON.parse(JSON.stringify(template))), 'gym-template');
assert.equal(store.getGym().machines.length, 2);
assert.equal(store.getWorkouts().length, 0, 'template import brings no history');

// invalid files must throw, not corrupt
assert.throws(() => store.importData({ app: 'other' }));
assert.throws(() => store.importData({ app: 'gymii', kind: 'gym-template', gym: { machines: 'nope' } }));

// outline: new gyms carry a full-rect outline, legacy gyms get one on read
assert.equal(store.newGym('x').outline.length, 4);
const legacy = store.newGym('Legacy');
delete legacy.outline;
store.saveGym(legacy);
assert.deepEqual(store.getGym().outline[2], { x: 60, y: 40 }, 'legacy gym migrated on read');

// outline validation: fewer than 3 points or non-numbers are rejected
assert.throws(() => store.importData({
  app: 'gymii', kind: 'gym-template', v: 1,
  gym: { ...store.newGym('bad'), outline: [{ x: 1, y: 2 }] },
}));
assert.throws(() => store.importData({
  app: 'gymii', kind: 'gym-template', v: 1,
  gym: { ...store.newGym('bad'), outline: [{ x: 1, y: 2 }, { x: 'a', y: 3 }, { x: 4, y: 5 }] },
}));

// delete/update workouts (inline history edits)
store.clearAll();
store.saveWorkouts([
  { id: 'wa', startedAt: 1, finishedAt: 2, entries: [{ machineId: 'm1', num: 1, label: 'A', settings: {}, sets: [{ reps: 10, weight: 40 }] }] },
  { id: 'wb', startedAt: 3, finishedAt: 4, entries: [{ machineId: 'm2', num: 2, label: 'B', settings: {}, sets: [{ reps: 8, weight: 30 }] }], locker: '7' },
]);
store.deleteWorkout('nope');
assert.equal(store.getWorkouts().length, 2, 'unknown delete id is a no-op');
store.deleteWorkout('wa');
assert.deepEqual(store.getWorkouts().map((w) => w.id), ['wb'], 'delete removes exactly one workout');

assert.equal(store.updateWorkout({ id: 'nope', entries: [] }), null, 'unknown update id returns null');
const updated = store.updateWorkout({
  id: 'wb', startedAt: 3, finishedAt: 4, locker: '9',
  entries: [
    { machineId: 'm2', num: 2, label: 'B', settings: {}, sets: [{ reps: 5, weight: 35 }] },
    { machineId: 'm3', num: 3, label: 'C', settings: {}, sets: [] },
  ],
});
assert.equal(updated.locker, '9', 'update replaces workout fields');
assert.equal(store.getWorkouts()[0].entries.length, 1, 'zero-set entries dropped on update');
assert.equal(store.getWorkouts()[0].entries[0].sets[0].weight, 35);
assert.equal(store.updateWorkout({ id: 'wb', entries: [{ machineId: 'm2', num: 2, label: 'B', settings: {}, sets: [] }] }),
  null, 'update with only empty entries removes the workout');
assert.equal(store.getWorkouts().length, 0);

// the shipped example template must pass import validation
const { readFileSync } = await import('node:fs');
const example = JSON.parse(readFileSync(new URL('../templates/example-gym.json', import.meta.url), 'utf8'));
assert.equal(store.importData(example), 'gym-template');
assert.equal(store.getGym().machines.length, 11);
assert.ok(store.getGym().machines.some((m) => (m.muscles || []).includes('Lower back')),
  'example template has a lower-back machine');

console.log('store roundtrip: all assertions passed');
