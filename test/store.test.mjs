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

// profiles: legacy top-level keys migrate under a default profile on first access
store.clearAll();
localStorage.setItem('gymii.gym', JSON.stringify(store.newGym('Legacy gym')));
localStorage.setItem('gymii.workouts', JSON.stringify(
  [{ id: 'lw', startedAt: 1, finishedAt: 2, entries: [{ machineId: 'm1', num: 1, label: 'A', settings: {}, sets: [{ reps: 5, weight: 20 }] }] }]));
const profiles = store.getProfiles();
assert.equal(profiles.list.length, 1);
assert.equal(profiles.list[0].name, 'Legacy gym', 'migrated profile takes the gym name');
assert.equal(localStorage.getItem('gymii.gym'), null, 'legacy key moved under the profile');
assert.equal(store.getGym().name, 'Legacy gym', 'gym readable through the profile');
assert.equal(store.getWorkouts().length, 1, 'history readable through the profile');

// profile switching: each profile is an isolated {gym, workouts, active} bundle
const firstId = profiles.activeId;
const secondId = store.createProfile('Second gym');
assert.equal(store.getProfiles().activeId, secondId, 'new profile becomes active');
assert.equal(store.getGym(), null, 'new profile starts without a gym');
assert.equal(store.getWorkouts().length, 0);
store.saveWorkouts(
  [{ id: 'sw', startedAt: 3, finishedAt: 4, entries: [{ machineId: 'x', num: 1, label: 'X', settings: {}, sets: [{ reps: 8, weight: 100 }] }] }]);
store.setActiveProfile(firstId);
assert.equal(store.getGym().name, 'Legacy gym', 'switching back returns the original bundle');
assert.equal(store.getWorkouts()[0].id, 'lw');
store.renameProfile(firstId, 'Renamed gym');
assert.equal(store.getProfiles().list.find((p) => p.id === firstId).name, 'Renamed gym');

// setUnit converts every profile's stored weights, not just the active one
store.saveActive({ v: 2, id: 'aw', startedAt: 5, entries: [{ machineId: 'm1', num: 1, label: 'A', settings: {}, sets: [{ reps: 3, weight: 60 }] }] });
store.setUnit('lbs');
assert.equal(store.getSettings().unit, 'lbs');
assert.equal(store.getWorkouts()[0].entries[0].sets[0].weight, 44, '20 kg -> 44 lbs (nearest 0.5)');
assert.equal(store.getActive().entries[0].sets[0].weight, 132.5, 'active workout converted');
assert.equal(store.getSettings().weightStep, 5.5, '2.5 kg step -> 5.5 lbs');
store.setActiveProfile(secondId);
assert.equal(store.getWorkouts()[0].entries[0].sets[0].weight, 220.5, 'inactive profile converted too');
store.setUnit('lbs');
assert.equal(store.getWorkouts()[0].entries[0].sets[0].weight, 220.5, 'same-unit switch is a no-op');
store.setUnit('kg');
assert.equal(store.getWorkouts()[0].entries[0].sets[0].weight, 100, 'roundtrip back to kg');
store.setActiveProfile(firstId);
assert.equal(store.getActive().entries[0].sets[0].weight, 60, 'active roundtrips too');
store.clearActive();

// deleting profiles: keys are removed, the last profile is protected
store.setActiveProfile(secondId);
assert.equal(store.deleteProfile(secondId), true);
assert.equal(store.getProfiles().activeId, firstId, 'active falls back to the first remaining profile');
assert.equal(localStorage.getItem(`gymii.${secondId}.workouts`), null, 'deleted profile keys removed');
assert.equal(store.deleteProfile(firstId), false, 'the last profile cannot be deleted');
assert.equal(store.getProfiles().list.length, 1);

// clearAll wipes every gymii key and self-heals into a fresh default profile
store.clearAll();
assert.equal([...mem.keys()].filter((k) => k.startsWith('gymii.')).length, 0, 'clearAll leaves no gymii keys');
assert.equal(store.getGym(), null);
assert.equal(store.getProfiles().list.length, 1, 'fresh default profile after reset');

// the shipped example template must pass import validation
const { readFileSync } = await import('node:fs');
const example = JSON.parse(readFileSync(new URL('../templates/example-gym.json', import.meta.url), 'utf8'));
assert.equal(store.importData(example), 'gym-template');
assert.equal(store.getGym().machines.length, 11);
assert.ok(store.getGym().machines.some((m) => (m.muscles || []).includes('Lower back')),
  'example template has a lower-back machine');

console.log('store roundtrip: all assertions passed');
