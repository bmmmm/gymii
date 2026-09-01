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

// build a layout
const layout = store.newLayout('Test layout');
layout.machines.push({ id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: ['Seat'] });
layout.machines.push({ id: 'm2', num: 2, label: 'Lat pulldown', x: 6, y: 0, w: 4, h: 3, settingsFields: [] });
store.saveLayout(layout);

// log a workout; the set-less entry must be dropped on finish
store.saveActive({
  v: 2, id: 'w1', startedAt: 1000,
  plan: [{ machineId: 'm1', exercise: null }, { machineId: 'm2', exercise: null }],
  currentMachineId: null, currentExercise: null,
  entries: [
    { machineId: 'm1', num: 1, label: 'Chest press', settings: { Seat: '4' }, sets: [{ reps: 10, weight: 40 }, { reps: 8, weight: 45 }] },
    { machineId: 'm2', num: 2, label: 'Lat pulldown', settings: {}, sets: [] },
  ],
});
const activeBefore = store.getActive();
activeBefore.locker = '23';
activeBefore.name = 'Push day';
const saved = store.finishWorkout(activeBefore);
assert.equal(saved.entries.length, 1, 'set-less entries dropped');
assert.equal(saved.locker, '23', 'locker number carried into history');
assert.equal(saved.name, 'Push day', 'workout name carried into history');
assert.equal(store.getActive(), null, 'active cleared after finish');
assert.equal(store.getWorkouts().length, 1);

// last-entry lookup feeds the training defaults
const last = store.lastEntryFor('m1');
assert.equal(last.sets[1].weight, 45);
assert.equal(last.settings.Seat, '4');
assert.strictEqual(store.lastEntryFor('m2'), null, 'machines without sets have no last entry');

// export -> clear -> import roundtrip
const backup = store.exportBackup();
const template = store.exportGymTemplate();
store.clearAll();
assert.equal(store.getLayout(), null);
assert.equal(store.importData(JSON.parse(JSON.stringify(backup))), 'backup');
assert.equal(store.getLayout().name, 'Test layout');
assert.equal(store.getWorkouts().length, 1);
assert.equal(store.lastEntryFor('m1').sets[0].weight, 40);
store.clearAll();
assert.equal(store.importData(JSON.parse(JSON.stringify(template))), 'gym-template');
assert.equal(store.getLayout().machines.length, 2);
assert.equal(store.getWorkouts().length, 0, 'template import brings no history');

// invalid files must throw, not corrupt
assert.throws(() => store.importData({ app: 'other' }));
// `gym` here is the frozen WIRE field, not the internal layout name
assert.throws(() => store.importData({ app: 'gymii', kind: 'gym-template', gym: { machines: 'nope' } }));
assert.throws(() => store.importData({
  app: 'gymii', kind: 'gym-template', v: 1,
  gym: { ...store.newLayout('bad'), machines: [{ id: 'x', num: 1, exercises: [{ name: 'Curl' }] }] },
}), 'non-string exercises rejected');

// machines healed on read: a hand-edited import without settingsFields must
// not brick Train/Gym (they call machine.settingsFields.forEach)
const bare = store.newLayout('Bare');
bare.machines.push({ id: 'b1', num: 1, label: 'Imported' });
store.saveLayout(bare);
assert.deepEqual(store.getLayout().machines[0].settingsFields, [], 'missing settingsFields healed');
assert.deepEqual(store.getLayout().machines[0].muscles, [], 'missing muscles healed');

// outline: a new layout carries a full-rect outline, a legacy one gets it on read
assert.equal(store.newLayout('x').outline.length, 4);
const legacy = store.newLayout('Legacy');
delete legacy.outline;
store.saveLayout(legacy);
assert.deepEqual(store.getLayout().outline[2], { x: 60, y: 40 }, 'legacy layout migrated on read');

// outline validation: fewer than 3 points or non-numbers are rejected
assert.throws(() => store.importData({
  app: 'gymii', kind: 'gym-template', v: 1,
  gym: { ...store.newLayout('bad'), outline: [{ x: 1, y: 2 }] },
}));
assert.throws(() => store.importData({
  app: 'gymii', kind: 'gym-template', v: 1,
  gym: { ...store.newLayout('bad'), outline: [{ x: 1, y: 2 }, { x: 'a', y: 3 }, { x: 4, y: 5 }] },
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

assert.strictEqual(store.updateWorkout({ id: 'nope', entries: [] }), null, 'unknown update id returns null');
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
const cleared = store.updateWorkout({ ...store.getWorkouts()[0], locker: '' });
assert.strictEqual(cleared.locker, undefined, 'an emptied locker stays gone (spread merge trap)');
const named = store.updateWorkout({ ...store.getWorkouts()[0], name: 'Push day' });
assert.equal(named.name, 'Push day', 'update stores an optional workout name');
const unnamed = store.updateWorkout({ ...store.getWorkouts()[0], name: '' });
assert.strictEqual(unnamed.name, undefined, 'an emptied name stays gone (spread merge trap)');
assert.equal(store.updateWorkout({ id: 'wb', entries: [{ machineId: 'm2', num: 2, label: 'B', settings: {}, sets: [] }] }),
  null, 'update with only empty entries removes the workout');
assert.equal(store.getWorkouts().length, 0);

// gyms: pre-profile top-level keys migrate under a default gym on first
// access, and the one called 'gym' back then lands as the 'layout' part
store.clearAll();
localStorage.setItem('gymii.gym', JSON.stringify(store.newLayout('Legacy gym')));
localStorage.setItem('gymii.workouts', JSON.stringify(
  [{ id: 'lw', startedAt: 1, finishedAt: 2, entries: [{ machineId: 'm1', num: 1, label: 'A', settings: {}, sets: [{ reps: 5, weight: 20 }] }] }]));
const migratedLegacy = store.getGyms();
assert.equal(migratedLegacy.list.length, 1);
assert.equal(migratedLegacy.list[0].name, 'Legacy gym', 'the migrated gym takes the layout name');
assert.equal(localStorage.getItem('gymii.gym'), null, 'the legacy key moved under the gym');
assert.equal(localStorage.getItem(`gymii.${migratedLegacy.activeId}.layout`) != null, true,
  'the pre-profile gym key became the layout part');
assert.equal(store.getLayout().name, 'Legacy gym', 'layout readable through the gym');
assert.equal(store.getWorkouts().length, 1, 'history readable through the gym');

// --- the profile era migrates: gymii.profiles → gymii.gyms, and each
// profile's `gym` part → `layout`. Ids are preserved; only names move. ---
store.clearAll();
const pid = 'legacy-profile-id';
const eraLayout = store.newLayout('Profile-era gym');
eraLayout.machines = [{ id: 'em1', num: 7, label: 'Old press', x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Chest'] }];
localStorage.setItem('gymii.profiles', JSON.stringify(
  { v: 1, list: [{ id: pid, name: 'Profile-era gym' }], activeId: pid }));
localStorage.setItem(`gymii.${pid}.gym`, JSON.stringify(eraLayout)); // the old part name
localStorage.setItem(`gymii.${pid}.workouts`, JSON.stringify(
  [{ id: 'ew', startedAt: 1, finishedAt: 2, entries: [{ machineId: 'em1', num: 7, label: 'Old press', settings: {}, sets: [{ reps: 8, weight: 40 }] }] }]));

const migrated = store.getGyms();
assert.equal(localStorage.getItem('gymii.profiles'), null, 'the profile registry is gone');
assert.ok(localStorage.getItem('gymii.gyms'), 'the gym registry took its place');
assert.equal(migrated.activeId, pid, 'ids survive the rename — only key names change');
assert.equal(migrated.list[0].name, 'Profile-era gym');
assert.equal(localStorage.getItem(`gymii.${pid}.gym`), null, 'the old gym part is gone');
assert.equal(store.getLayout().machines[0].label, 'Old press', 'the layout came across intact');
assert.equal(store.getWorkouts().length, 1, 'untouched parts keep working');

// idempotent: a second pass finds nothing to do and changes nothing
const again = store.getGyms();
assert.deepEqual(again, migrated, 'migrating twice is a no-op');
assert.equal(store.getLayout().machines[0].label, 'Old press');

// crash-safety: the parts move BEFORE the registry, so a replay that finds
// the layout already in place must not clobber it with the stale copy
store.clearAll();
localStorage.setItem('gymii.profiles', JSON.stringify(
  { v: 1, list: [{ id: pid, name: 'Half-migrated' }], activeId: pid }));
localStorage.setItem(`gymii.${pid}.gym`, JSON.stringify(store.newLayout('Stale')));
localStorage.setItem(`gymii.${pid}.layout`, JSON.stringify(store.newLayout('Already moved')));
store.getGyms();
assert.equal(store.getLayout().name, 'Already moved',
  'a replay leaves the newer layout alone and only drops the stale key');
assert.equal(localStorage.getItem(`gymii.${pid}.gym`), null, 'the stale key is cleaned up');

// gym switching: each gym is an isolated {layout, workouts, active} bundle
store.clearAll();
const firstId = store.getGyms().activeId;
store.saveLayout(store.newLayout('Legacy gym'));
store.saveWorkouts(
  [{ id: 'lw', startedAt: 1, finishedAt: 2, entries: [{ machineId: 'm1', num: 1, label: 'A', settings: {}, sets: [{ reps: 5, weight: 20 }] }] }]);
const secondId = store.createGym('Second layout');
assert.equal(store.getGyms().activeId, secondId, 'a new layout becomes active');
assert.equal(store.getLayout(), null, 'a new layout starts without a layout');
assert.equal(store.getWorkouts().length, 0);
store.saveWorkouts(
  [{ id: 'sw', startedAt: 3, finishedAt: 4, entries: [{ machineId: 'x', num: 1, label: 'X', settings: {}, sets: [{ reps: 8, weight: 100 }] }] }]);
store.setActiveGym(firstId);
assert.equal(store.getLayout().name, 'Legacy gym', 'switching back returns the original bundle');
assert.equal(store.getWorkouts()[0].id, 'lw');
store.renameGym(firstId, 'Renamed layout');
assert.equal(store.getGyms().list.find((p) => p.id === firstId).name, 'Renamed layout');

// setUnit converts every layout's stored weights, not just the active one
store.saveActive({ v: 2, id: 'aw', startedAt: 5, entries: [{ machineId: 'm1', num: 1, label: 'A', settings: {}, sets: [{ reps: 3, weight: 60 }] }] });
store.setUnit('lbs');
assert.equal(store.getSettings().unit, 'lbs');
assert.equal(store.getWorkouts()[0].entries[0].sets[0].weight, 44, '20 kg -> 44 lbs (nearest 0.5)');
assert.equal(store.getActive().entries[0].sets[0].weight, 132.5, 'active workout converted');
assert.equal(store.getSettings().weightStep, 5.5, '2.5 kg step -> 5.5 lbs');
store.setActiveGym(secondId);
assert.equal(store.getWorkouts()[0].entries[0].sets[0].weight, 220.5, 'inactive layout converted too');
store.setUnit('lbs');
assert.equal(store.getWorkouts()[0].entries[0].sets[0].weight, 220.5, 'same-unit switch is a no-op');
store.setUnit('kg');
assert.equal(store.getWorkouts()[0].entries[0].sets[0].weight, 100, 'roundtrip back to kg');
store.setActiveGym(firstId);
assert.equal(store.getActive().entries[0].sets[0].weight, 60, 'active roundtrips too');
store.clearActive();

// deleting gyms: keys are removed, the last layout is protected
store.setActiveGym(secondId);
assert.equal(store.deleteGym(secondId), true);
assert.equal(store.getGyms().activeId, firstId, 'active falls back to the first remaining layout');
assert.equal(localStorage.getItem(`gymii.${secondId}.workouts`), null, 'deleted layout keys removed');
assert.equal(store.deleteGym(firstId), false, 'the last layout cannot be deleted');
assert.equal(store.getGyms().list.length, 1);

// cardio sets {distance, seconds}: finish keeps them, setUnit converts
// distances per field (m <-> mi), seconds stay untouched
store.setActiveGym(firstId);
assert.equal(store.distUnit(store.getSettings()), 'm', 'metric pairs with meters');
store.saveActive({
  v: 2, id: 'cw', startedAt: 10, plan: [], currentMachineId: null,
  entries: [
    { machineId: 'm1', num: 1, label: 'A', settings: {}, sets: [{ reps: 5, weight: 20 }] },
    { machineId: 'tm', num: 9, label: 'Treadmill', cardio: true, settings: {}, sets: [{ distance: 5000, seconds: 1800 }] },
  ],
});
const cardioSaved = store.finishWorkout(store.getActive());
assert.equal(cardioSaved.entries[1].cardio, true, 'cardio flag survives finish');
assert.ok(!('name' in cardioSaved), 'an unnamed workout carries no name field');
assert.deepEqual(cardioSaved.entries[1].sets[0], { distance: 5000, seconds: 1800 });

store.setUnit('lbs');
assert.equal(store.distUnit(store.getSettings()), 'mi', 'imperial pairs with miles');
let cw = store.getWorkouts().find((w) => w.id === 'cw');
assert.equal(cw.entries[0].sets[0].weight, 44, 'mixed workout: weight converted');
assert.equal(cw.entries[1].sets[0].distance, 3.11, '5000 m -> 3.11 mi');
assert.equal(cw.entries[1].sets[0].seconds, 1800, 'seconds untouched by unit switch');
store.setUnit('kg');
cw = store.getWorkouts().find((w) => w.id === 'cw');
assert.equal(cw.entries[1].sets[0].distance, 5005, '3.11 mi -> 5005 m (accepted rounding drift)');
assert.equal(store.updateWorkout({ ...cw, locker: '3' }).entries[1].sets[0].seconds, 1800,
  'updateWorkout passes cardio sets through');
store.deleteWorkout('cw');

// exercises: entries at one machine are isolated per exercise; the bare
// bucket (no exercise) never leaks into exercise lookups and vice versa
store.saveActive({
  v: 2, id: 'ew', startedAt: 20, currentMachineId: null, currentExercise: null,
  plan: [
    { machineId: 'db', exercise: 'Biceps curls' },
    { machineId: 'db', exercise: 'Shoulder press' },
    { machineId: 'pb', exercise: null },
  ],
  entries: [
    { machineId: 'db', num: 4, label: 'Dumbbells', exercise: 'Biceps curls', settings: {}, sets: [{ reps: 10, weight: 12.5 }] },
    { machineId: 'db', num: 4, label: 'Dumbbells', exercise: 'Shoulder press', settings: {}, sets: [{ reps: 8, weight: 10 }] },
    { machineId: 'pb', num: 5, label: 'Pull-up bar', bodyweight: true, settings: {}, sets: [{ reps: 8, weight: 0 }, { reps: 6, weight: 10 }] },
  ],
});
const exSaved = store.finishWorkout(store.getActive());
assert.equal(exSaved.entries.length, 3, 'same-machine entries with different exercises both kept');
assert.equal(store.lastEntryFor('db', 'Biceps curls').sets[0].weight, 12.5);
assert.equal(store.lastEntryFor('db', 'Shoulder press').sets[0].weight, 10);
assert.strictEqual(store.lastEntryFor('db'), null, 'bare bucket does not match exercise entries');
assert.equal(store.lastEntryFor('pb').entries, undefined); // sanity: returns an entry, not a workout
assert.equal(store.lastEntryFor('pb').bodyweight, true, 'bodyweight flag survives finish');

// bodyweight added weight converts like any weight; 0 stays 0
store.setUnit('lbs');
const pb = store.getWorkouts().find((w) => w.id === 'ew').entries[2];
assert.deepEqual(pb.sets.map((st) => st.weight), [0, 22], 'added weight converted, 0 stays 0');
store.setUnit('kg');
store.deleteWorkout('ew');

// lastEntryFor scoping — this is what feeds train.js's set prefills, so the
// rules are pinned here: exercise-scoped in BOTH directions, newest workout
// first (over the chronologically sorted list), and only entries that
// actually carry sets count.
const dbEntry = (exercise, sets) => ({
  machineId: 'db', num: 4, label: 'Dumbbells',
  ...(exercise === undefined ? {} : { exercise }),
  settings: {}, sets,
});
store.saveWorkouts([
  // handed over out of order on purpose: the backwards walk relies on
  // saveWorkouts' chronological sort
  { id: 's3', startedAt: 3000, finishedAt: 3500, entries: [
    { machineId: 'other', num: 9, label: 'Rower', settings: {}, sets: [{ reps: 5, weight: 5 }] },
    dbEntry('Biceps curls', []),
  ] },
  { id: 's1', startedAt: 1000, finishedAt: 1500, entries: [
    dbEntry(undefined, [{ reps: 10, weight: 10 }]), // logged before the machine had exercises
    dbEntry('Biceps curls', [{ reps: 10, weight: 12.5 }]),
  ] },
  { id: 's4', startedAt: 4000, finishedAt: 4500, entries: [dbEntry('Biceps curls', [{ reps: 6, weight: 17.5 }])] },
  { id: 's2', startedAt: 2000, finishedAt: 2500, entries: [dbEntry(null, [{ reps: 8, weight: 15 }])] },
]);
assert.deepEqual(store.getWorkouts().map((w) => w.id), ['s1', 's2', 's3', 's4'],
  'saveWorkouts sorts chronologically — lastEntryFor depends on it');
assert.equal(store.lastEntryFor('db').sets[0].weight, 15,
  'bare lookup: an explicit exercise:null counts as bare, and the newest bare workout wins');
assert.equal(store.lastEntryFor('db', undefined).sets[0].weight, 15,
  'an omitted exercise reads the bare bucket, never a newer exercise entry');
assert.equal(store.lastEntryFor('db', 'Biceps curls').sets[0].weight, 17.5,
  'an exercise lookup takes its own newest workout');
store.deleteWorkout('s4');
assert.deepEqual(store.lastEntryFor('db', 'Biceps curls').sets, [{ reps: 10, weight: 12.5 }],
  'a newer set-less entry never shadows the last real one');
assert.strictEqual(store.lastEntryFor('db', 'Shoulder press'), null,
  'an exercise never trained at this machine has no last entry');
assert.strictEqual(store.lastEntryFor('nope'), null, 'unknown machine: no last entry');
store.saveWorkouts([]);

// clearAll wipes every gymii key and self-heals into a fresh default layout
store.clearAll();
assert.equal([...mem.keys()].filter((k) => k.startsWith('gymii.')).length, 0, 'clearAll leaves no gymii keys');
assert.equal(store.getLayout(), null);
assert.equal(store.getGyms().list.length, 1, 'fresh default layout after reset');

// addMachine appends with an auto position (quick start / create-on-miss)
const quickGym = store.newLayout('Quick');
const quickMachine = store.addMachine(quickGym, 1, 'Chest press');
assert.equal(quickGym.machines.length, 1);
assert.ok(quickMachine.id, 'gets an id');
assert.ok(Number.isFinite(quickMachine.x) && Number.isFinite(quickMachine.y), 'auto-position assigned');
assert.equal(store.addMachine(quickGym, 2, 'Row').num, 2);
store.saveLayout(quickGym);
assert.equal(store.getLayout().machines.length, 2, 'quick layout saves cleanly');

// bindOrCreateMachine — the one invariant behind every binding surface
// (train's bind screen, the plan builder, workoutFromText)
const bindGym = store.newLayout('Bind');
bindGym.machines.push({ id: 'known', num: 5, label: 'Leg press', x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles: [] });
assert.strictEqual(store.bindOrCreateMachine(bindGym, 5, 'Whatever', null).id, 'known',
  'a known number binds to that machine, name and target ignored');
assert.equal(bindGym.machines.length, 1, 'and creates nothing');
const bindNew = store.bindOrCreateMachine(bindGym, 14, 'Cable crossover', { sets: 3, reps: 10, weight: 20 });
assert.equal(bindNew.label, 'Cable crossover', 'an unknown number creates the machine under the ITEM name');
assert.equal(bindNew.num, 14);
assert.ok(!('cardio' in bindNew), 'a sets/reps target leaves it a strength machine');
assert.equal(bindGym.machines.length, 2, 'appended to the layout');
const bindCardio = store.bindOrCreateMachine(bindGym, 21, 'Treadmill', { distance: 0, seconds: 1200 });
assert.equal(bindCardio.cardio, true,
  'a distance target makes it cardio — else the target is dropped as the wrong shape');
assert.equal(store.bindOrCreateMachine(bindGym, 7, '', null).label, 'Machine 7',
  'a nameless item falls back to "Machine <num>"');
assert.equal(store.bindOrCreateMachine(bindGym, 7, 'Late name', null).label, 'Machine 7',
  'the second call finds the machine it just created');
assert.equal(store.getLayout().machines.length, 2,
  'bindOrCreateMachine persists NOTHING — saveLayout timing stays with the caller');

// newEntry — the entry snapshot the log screen, the editor, workoutFromText
// and the demo data all write
const strengthMachine = { id: 's1', num: 3, label: 'Chest press', settingsFields: ['Seat'] };
assert.deepEqual(store.newEntry(strengthMachine, null, [{ reps: 10, weight: 40 }]), {
  machineId: 's1', num: 3, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 40 }],
}, 'strength: no type flag at all, settings start empty');
const cardioEntry = store.newEntry({ id: 'c1', num: 9, label: 'Rower', cardio: true }, 'Sprints', []);
assert.deepEqual(Object.keys(cardioEntry),
  ['machineId', 'num', 'label', 'cardio', 'exercise', 'settings', 'sets'],
  'flags before the exercise, settings and sets last (history reads this shape)');
assert.equal(store.newEntry({ id: 'b1', num: 4, label: 'Pull-up bar', bodyweight: true }).bodyweight, true);
const flagless = store.newEntry({ id: 'x', num: 1, label: 'X', cardio: false, bodyweight: false }, '');
assert.ok(!('cardio' in flagless) && !('bodyweight' in flagless) && !('exercise' in flagless),
  'false flags and an empty exercise are absent, not falsy');
assert.deepEqual(flagless.sets, [], 'sets default to empty');
assert.notStrictEqual(store.newEntry(strengthMachine).sets, store.newEntry(strengthMachine).sets,
  'each entry gets its OWN sets array — a shared one would log into two entries');

// the shipped example template must pass import validation
const { readFileSync } = await import('node:fs');
const example = JSON.parse(readFileSync(new URL('../templates/example-gym.json', import.meta.url), 'utf8'));
assert.equal(store.importData(example), 'gym-template');
assert.equal(store.getLayout().machines.length, 11);
assert.ok(store.getLayout().machines.some((m) => (m.muscles || []).includes('Lower back')),
  'example template has a lower-back machine');

// usageByMuscle / workoutsWithMuscle — muscles resolve against the LIVE
// layout; a set on a two-muscle machine counts fully for both (no 1/n split)
const mGym = store.newLayout('Muscle layout');
mGym.machines.push(
  { id: 'm1', num: 1, label: 'Leg press', x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Quads', 'Glutes'] },
  { id: 'm2', num: 2, label: 'Lat pulldown', x: 6, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Lats'] },
  { id: 'm3', num: 3, label: 'Mystery', x: 12, y: 0, w: 4, h: 3, settingsFields: [], muscles: [] },
);
const mWorkouts = [
  { id: 'mw1', startedAt: 1000, finishedAt: 2000, entries: [
    { machineId: 'm1', num: 1, label: 'Leg press', settings: {}, sets: [{ reps: 10, weight: 100 }, { reps: 10, weight: 100 }] },
    { machineId: 'm3', num: 3, label: 'Mystery', settings: {}, sets: [{ reps: 10, weight: 20 }] },
  ] },
  { id: 'mw2', startedAt: 3000, finishedAt: 4000, entries: [
    { machineId: 'm1', num: 1, label: 'Leg press', settings: {}, sets: [{ reps: 8, weight: 105 }] },
    { machineId: 'm2', num: 2, label: 'Lat pulldown', settings: {}, sets: [{ reps: 10, weight: 50 }] },
    { machineId: 'gone', num: 9, label: 'Deleted machine', settings: {}, sets: [{ reps: 10, weight: 30 }] },
  ] },
];
const usage = store.usageByMuscle(mWorkouts, mGym);
assert.equal(usage.get('Quads').sets, 3, 'both leg-press entries counted');
assert.equal(usage.get('Glutes').sets, 3, 'second muscle gets the FULL count, not half');
assert.deepEqual(usage.get('Quads'), { sets: 3, workouts: 2 });
assert.deepEqual(usage.get('Lats'), { sets: 1, workouts: 1 });
assert.ok(!usage.has(undefined) && usage.size === 3, 'untagged and deleted machines attribute nothing');
assert.equal(store.usageByMuscle([], mGym).size, 0);
assert.equal(store.usageByMuscle(mWorkouts, null).size, 0, 'no layout, no muscles');

// setUnit must convert plan targets along with the sets — they are stored
// in the display unit like everything else
store.savePlan({
  id: 'unit-plan', name: 'Unit plan',
  items: [
    { machineId: 'm1', exercise: null, target: { sets: 3, reps: 10, weight: 80 } },
    { machineId: 'm2', exercise: null, target: { distance: 3000, seconds: 900 } },
  ],
});
// …and a RUNNING workout carries its own copy of those targets on its plan
// slots (train.js startWorkoutFrom), which the log screen's first-set
// prefill reads — so a mid-workout switch has to convert them too
store.saveActive({
  v: 2, id: 'unit-active', startedAt: 9000,
  plan: [
    { machineId: 'm1', exercise: null, target: { sets: 3, reps: 10, weight: 80 } },
    { machineId: 'm2', exercise: null, target: { distance: 3000, seconds: 900 } },
  ],
  currentMachineId: 'm1', currentExercise: null,
  entries: [{ machineId: 'm1', num: 1, label: 'Leg press', settings: {}, sets: [{ reps: 10, weight: 75 }] }],
});
store.setUnit('lbs');
const lbsPlan = store.getPlans().find((p) => p.id === 'unit-plan');
assert.equal(lbsPlan.items[0].target.weight, Math.round(80 * 2.2046226218 * 2) / 2,
  'weight target converted to lbs');
assert.equal(lbsPlan.items[1].target.distance, 1.86, 'distance target converted to miles');
assert.equal(lbsPlan.items[1].target.seconds, 900, 'seconds stay unit-less');
const lbsActive = store.getActive();
assert.equal(lbsActive.entries[0].sets[0].weight, Math.round(75 * 2.2046226218 * 2) / 2,
  'the running workout\'s logged sets convert');
assert.equal(lbsActive.plan[0].target.weight, Math.round(80 * 2.2046226218 * 2) / 2,
  'the running workout\'s slot target converts too — else 80 kg becomes 80 lbs mid-workout');
assert.equal(lbsActive.plan[1].target.distance, 1.86, 'a cardio slot target converts its distance');
assert.equal(lbsActive.plan[1].target.seconds, 900, 'and leaves the seconds alone');
store.setUnit('kg');
assert.equal(store.getPlans().find((p) => p.id === 'unit-plan').items[0].target.weight, 80,
  'the kg → lbs → kg roundtrip lands back on the value');
assert.equal(store.getActive().plan[0].target.weight, 80, 'slot targets roundtrip too');
store.clearActive();
store.deletePlan('unit-plan');

// pre-plan actives (plan as bare machineId strings, migrated in renderTrain)
// must survive the same walk
store.saveActive({ v: 2, id: 'legacy-active', startedAt: 9500, plan: ['m1'], entries: [] });
store.setUnit('lbs');
assert.deepEqual(store.getActive().plan, ['m1'], 'a legacy string plan is left alone');
store.setUnit('kg');
store.clearActive();

const lats = store.workoutsWithMuscle(mWorkouts, mGym, 'Lats');
assert.deepEqual(lats.map((w) => w.id), ['mw2']);
assert.equal(lats[0].entries.length, 3, 'the WHOLE workout survives, entries untouched');
assert.deepEqual(store.workoutsWithMuscle(mWorkouts, mGym, 'Chest'), []);
assert.deepEqual(store.workoutsWithMuscle(mWorkouts, null, 'Lats'), []);

// --- timer sound: settings default names a real TIMER_SOUNDS entry ---
const ui = await import(new URL('../js/ui.js', import.meta.url).href);
assert.equal(store.getSettings().timerSound, 'double', 'timer sound defaults to double');
assert.ok(ui.TIMER_SOUNDS[store.getSettings().timerSound], 'the default names a real sound');
for (const [name, snd] of Object.entries(ui.TIMER_SOUNDS)) {
  assert.ok(snd.label && Array.isArray(snd.notes) && snd.notes.length,
    `${name} has a label and notes`);
  snd.notes.forEach(([at, freq]) => {
    assert.ok(Number.isFinite(at) && at >= 0 && Number.isFinite(freq) && freq > 0,
      `${name} notes are [offset, hz] pairs`);
  });
}
// the WAV renderer is pure and testable headless: valid RIFF/WAVE header,
// the exact length its notes demand, and actual signal in the data
const wav = new DataView(ui.renderWav(ui.TIMER_SOUNDS.double.notes));
const tag = (off) => String.fromCharCode(
  wav.getUint8(off), wav.getUint8(off + 1), wav.getUint8(off + 2), wav.getUint8(off + 3));
assert.equal(tag(0), 'RIFF');
assert.equal(tag(8), 'WAVE');
assert.equal(tag(36), 'data');
const expectedSamples = Math.ceil((0.35 + 0.3) * 44100); // last note offset + note length
assert.equal(wav.byteLength, 44 + expectedSamples * 2, 'wav sized to the notes');
assert.equal(wav.getUint32(40, true), expectedSamples * 2, 'data chunk length matches');
let nonzero = false;
for (let i = 0; i < 2000 && !nonzero; i++) nonzero = wav.getInt16(44 + i * 2, true) !== 0;
assert.ok(nonzero, 'the wav actually carries signal');

// The gesture prime plays SILENCE, so it can never leak an audible note the
// way pausing a real sound mid-play did (a tone fired right after "Log set",
// then again at zero). A zero-frequency note must render pure zeros.
const silent = new DataView(ui.renderWav([[0, 0]]));
let silentPeak = 0;
for (let i = 0; i < (silent.byteLength - 44) / 2; i++) {
  silentPeak = Math.max(silentPeak, Math.abs(silent.getInt16(44 + i * 2, true)));
}
assert.equal(silentPeak, 0, 'the priming wav is pure silence');

// wake-lock scope: 'break' by default, 'workout' never implicitly (battery),
// and the pre-scope boolean migrates instead of reading as an unknown scope
assert.equal(store.getSettings().keepAwake, 'break', 'wake lock covers the break by default');
assert.equal(store.getSettings().timerDim, '10s', 'the rest screen dims after 10s by default');
const keptSettings = store.getSettings();
store.saveSettings({ ...keptSettings, keepAwake: true });
assert.equal(store.getSettings().keepAwake, 'break', 'legacy true migrates to the break scope');
store.saveSettings({ ...keptSettings, keepAwake: false });
assert.equal(store.getSettings().keepAwake, 'off', 'legacy false migrates to off');
store.saveSettings({ ...keptSettings, keepAwake: 'workout' });
assert.equal(store.getSettings().keepAwake, 'workout', 'an explicit scope survives untouched');
store.saveSettings(keptSettings);

// no Audio element in Node — playback must stay a silent no-op, never throw
ui.playTimerSound('double');
ui.playTimerSound('no-such-sound');
ui.primeAudio('double');

// --- sync groundwork: stamps, tombstones, and the v2 backup roundtrip ---
store.clearAll();
store.saveWorkouts([
  { id: 'ws1', startedAt: 1, entries: [{ machineId: 'm1', num: 1, label: 'A', settings: {}, sets: [{ reps: 10, weight: 40 }] }] },
  { id: 'ws2', startedAt: 2, entries: [{ machineId: 'm1', num: 1, label: 'A', settings: {}, sets: [{ reps: 8, weight: 45 }] }] },
]);
store.deleteWorkout('ws1');
assert.equal(store.getWorkouts().length, 1, 'delete removes the workout');
assert.equal(store.getTombstones().workouts[0]?.id, 'ws1', 'and leaves a tombstone');
store.deleteWorkout('nope');
assert.equal(store.getTombstones().workouts.length, 1, 'an unknown id leaves no tombstone');

const edited = store.updateWorkout({
  id: 'ws2',
  entries: [{ machineId: 'm1', num: 1, label: 'A', settings: {}, sets: [{ reps: 9, weight: 50 }] }],
});
assert.ok(edited.updatedAt > 0, 'an inline edit stamps updatedAt');
store.updateWorkout({ id: 'ws2', entries: [{ machineId: 'm1', num: 1, label: 'A', settings: {}, sets: [] }] });
assert.equal(store.getTombstones().workouts.some((t) => t.id === 'ws2'), true,
  'editing away the last set tombstones like a delete');

store.savePlan({ id: 'ps1', name: 'Push', items: [] });
assert.ok(store.getPlans()[0].updatedAt > 0, 'savePlan stamps updatedAt');
assert.ok(store.getPlans()[0].createdAt > 0, 'and createdAt on first save');
store.deletePlan('ps1');
assert.equal(store.getTombstones().plans[0]?.id, 'ps1', 'deletePlan tombstones');

// saveLayout diffs: a vanished machine tombstones, an unchanged one keeps its stamp
const g2 = store.newLayout('Diff layout');
g2.machines.push({ id: 'gm1', num: 1, label: 'Press', x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles: [] });
g2.machines.push({ id: 'gm2', num: 2, label: 'Row', x: 6, y: 0, w: 4, h: 3, settingsFields: [], muscles: [] });
store.saveLayout(g2);
const firstStamp = store.getLayout().machines.find((m) => m.id === 'gm1').updatedAt;
assert.ok(firstStamp > 0, 'a new machine gets stamped');
const g3 = store.getLayout();
g3.machines = g3.machines.filter((m) => m.id !== 'gm2');
store.saveLayout(g3);
assert.equal(store.getTombstones().machines[0]?.id, 'gm2', 'a vanished machine tombstones');
assert.equal(store.getLayout().machines.find((m) => m.id === 'gm1').updatedAt, firstStamp,
  'an untouched machine keeps its stamp');

// v2 export -> clear -> import: the delete stays dead, tombstones travel
const backup2 = store.exportBackup();
assert.equal(backup2.v, 2, 'backups are v2 now');
store.clearAll();
store.importData(JSON.parse(JSON.stringify(backup2)));
assert.equal(store.getWorkouts().some((w2) => w2.id === 'ws1'), false,
  'a deleted workout does not come back from its own backup');
assert.equal(store.getTombstones().workouts.some((t) => t.id === 'ws1'), true,
  'its tombstone rode along');
assert.equal(store.getTombstones().machines[0]?.id, 'gm2', 'machine tombstones too');

// a v1 backup (no tombstones, no stamps) still imports cleanly
store.clearAll();
const v1 = {
  app: 'gymii', kind: 'backup', v: 1,
  gym: store.newLayout('Old layout'), // wire field, frozen at `gym`
  workouts: [{ id: 'wOld', startedAt: 5, entries: [{ machineId: 'x', num: 1, label: 'O', settings: {}, sets: [{ reps: 1, weight: 1 }] }] }],
  plans: [], settings: { v: 1, unit: 'kg' },
};
assert.equal(store.importData(JSON.parse(JSON.stringify(v1))), 'backup', 'v1 backups still import');
assert.equal(store.getWorkouts().length, 1);
assert.deepEqual(store.getTombstones().workouts, [], 'a v1 file simply carries no tombstones');

// ids: crypto-random, 16 chars, and unique across a burst
const ids = new Set(Array.from({ length: 1000 }, () => store.uid()));
assert.equal(ids.size, 1000, 'uid burst has no collisions');
assert.ok([...ids].every((id) => /^[0-9a-z]{16}$/.test(id)), 'uids are 16 base-36 chars');

store.clearAll();

// --- change notifier (M2 ambient sync) ---
// Interactive writers announce, restore* twins stay silent — announcing an
// applied sync would echo it straight back into another sync.
let changes = 0;
const unsubscribe = store.onStoreChange(() => { changes += 1; });
const gymA = store.getGyms().activeId; // fresh default gym after clearAll

store.savePlan({ id: 'note1', name: 'Notify', items: [] });
assert.equal(changes, 1, 'savePlan notifies (via savePlans)');
store.saveWorkouts([]);
assert.equal(changes, 2, 'saveWorkouts notifies');
const notifyLayout = store.newLayout('Notify layout');
store.saveLayout(notifyLayout);
assert.equal(changes, 3, 'saveLayout notifies');
store.saveSettings({ ...store.getSettings(), restSeconds: 45 });
assert.equal(changes, 4, 'saveSettings notifies');
store.renameGym(gymA, 'Renamed');
assert.equal(changes, 5, 'renameGym notifies');

store.restoreLayout(notifyLayout);
store.restoreSettings(store.getSettings());
store.restoreGymEntry({ id: gymA, name: 'Renamed', updatedAt: 1 });
assert.equal(changes, 5, 'the restore twins never notify');

unsubscribe();
store.savePlan({ id: 'note2', name: 'Silent', items: [] });
assert.equal(changes, 5, 'unsubscribe works');

// --- deleteGym queues the server blob's DELETE (M2) ---
// The pending entry must be built BEFORE the GYM_PARTS sweep wipes the
// sync config it is made of.
store.saveSyncConfig(gymA, {
  server: 'https://sync.example', token: 'tok-del', remoteId: 'remote-77',
});
const gymB = store.createGym('Survivor');
assert.equal(store.deleteGym(gymA), true);
const pending = store.getPendingDeletes();
assert.equal(pending.length, 1, 'one pending delete queued');
assert.deepEqual(pending[0], {
  server: 'https://sync.example', token: 'tok-del', remoteId: 'remote-77', tries: 0,
}, 'built from the config, addressed by the blob id');
store.savePendingDeletes([]);
assert.equal(store.getPendingDeletes().length, 0, 'queue clears');
assert.equal(store.deleteGym(gymB), false, 'the last gym still refuses to die');

// --- a backup of a layout-less gym round-trips (pre-existing bug) ---
// A user who only ever logged against plans has gym: null in the backup;
// importData must accept it instead of refusing the whole file.
store.savePlan({ id: 'plan-nl', name: 'No-layout plan', items: [] });
store.saveWorkouts([{
  id: 'w-nl',
  startedAt: 1000,
  finishedAt: 2000,
  updatedAt: 1000,
  entries: [{
    machineId: 'mx', num: 1, label: 'Somewhere', settings: {}, sets: [{ reps: 5, weight: 20 }],
  }],
}]);
const noLayoutBackup = JSON.parse(JSON.stringify(store.exportBackup()));
assert.equal(noLayoutBackup.gym, null, 'no editor visit means gym: null');
store.clearAll();
assert.equal(store.importData(noLayoutBackup), 'backup', 'null-layout backup imports');
assert.equal(store.getPlans().length, 1, 'plans survived the round-trip');
assert.equal(store.getWorkouts()[0].id, 'w-nl', 'workouts survived the round-trip');
assert.throws(() => store.importData({ app: 'gymii', kind: 'backup', gym: { broken: true }, workouts: [] }),
  /Invalid backup/, 'a malformed layout is still refused');

store.clearAll();

// --- gym address: postcode is part of the shape, and rides the wire ---
// meta lives INSIDE the layout, so template/backup/sync carry it for free —
// what this pins is that a fresh layout offers the field at all.
assert.deepEqual(Object.keys(store.newLayout('Meta').meta).sort(),
  ['address', 'city', 'country', 'postcode'], 'a fresh layout has a postcode slot');
const withMeta = store.newLayout('Meta');
withMeta.meta = { address: 'Demostr. 1', postcode: '10115', city: 'Berlin', country: 'DE' };
withMeta.machines.push({
  id: 'mb1', num: 1, label: 'Chest press', brand: 'Technogym',
  model: 'Selection Pro', x: 2, y: 2, w: 4, h: 3, settingsFields: [], muscles: [],
});
store.saveLayout(withMeta);
const exported = JSON.parse(JSON.stringify(store.exportGymTemplate()));
assert.equal(exported.gym.meta.postcode, '10115', 'the postcode travels with the template');
assert.equal(exported.gym.machines[0].brand, 'Technogym', 'so does the brand');
assert.equal(exported.gym.machines[0].model, 'Selection Pro', 'and the model');
store.clearAll();
assert.equal(store.importData(exported), 'gym-template', 'the template imports back');
assert.equal(store.getLayout().meta.postcode, '10115', 'postcode survived the round-trip');
assert.equal(store.getLayout().machines[0].brand, 'Technogym', 'brand survived the round-trip');

// The brand pick list is a starting point, not a taxonomy — but it must not
// be empty, or the chip row renders as a bare text field.
assert.ok(store.MACHINE_BRANDS.length > 5, 'the brand pick list has usable entries');
assert.equal(new Set(store.MACHINE_BRANDS).size, store.MACHINE_BRANDS.length,
  'no duplicate brands (a dupe would render two chips that toggle each other)');

store.clearAll();

// --- map layers survive the wire, and the merge does not need array order ---
assert.deepEqual(store.MAP_LAYERS.map((l) => l.z), [-1, 0, 1],
  'three layers, Normal in the middle as the absent default');
const layered = store.newLayout('Layers');
layered.shapes.push({ id: 'sl1', kind: 'rect', label: 'Turf', x: 2, y: 2, w: 8, h: 8, z: -1 });
store.saveLayout(layered);
const tpl = JSON.parse(JSON.stringify(store.exportGymTemplate()));
assert.equal(tpl.gym.shapes[0].z, -1, 'the layer travels with the template');
store.clearAll();
store.importData(tpl);
assert.equal(store.getLayout().shapes[0].z, -1, 'and comes back on import');

store.clearAll();

console.log('store roundtrip: all assertions passed');
