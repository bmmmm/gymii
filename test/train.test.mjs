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
const {
  startWorkoutFrom, renderTrain, nearbyAlternative, nextSetDefaults, dimDelaySeconds,
  screenKey,
} = await import(new URL('../js/train.js', import.meta.url).href);

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

// an optional workout name is pre-seeded from the source, so repeating a
// named routine keeps its identity instead of splitting off an unnamed half
startWorkoutFrom({ name: 'Push day', entries: [entry('m1')] });
assert.equal(store.getActive().name, 'Push day', 'repeat carries the source workout name');
startWorkoutFrom({ entries: [entry('m1')] });
assert.strictEqual(store.getActive().name, undefined, 'unnamed sources start unnamed');

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

// --- nearby alternative (busy-machine escape hatch) ---
// the closest OTHER station with an open slot, by center distance; the
// current machine and the plan's next are excluded, done slots don't count
gym.machines.push({ id: 'far', num: 4, label: 'Far press', x: 50, y: 30, w: 4, h: 3, settingsFields: [] });
gym.machines.push({ id: 'near', num: 5, label: 'Near fly', x: 0, y: 6, w: 4, h: 3, settingsFields: [] });
store.saveGym(gym);

const m1 = gym.machines.find((m) => m.id === 'm1');
const mkActive = (entries = []) => ({
  v: 2, id: 'w-near', startedAt: 1755000000000,
  plan: [
    { machineId: 'm1', exercise: null },
    { machineId: 'db', exercise: null },
    { machineId: 'm2', exercise: null },
    { machineId: 'far', exercise: null },
    { machineId: 'near', exercise: null },
    { machineId: 'ghost', exercise: null }, // deleted machines never match
  ],
  currentMachineId: 'm1', currentExercise: null, entries,
});

let alt = nearbyAlternative(mkActive(), gym, m1, 'db');
assert.equal(alt.machine.id, 'near', 'closest open other station wins (current + next excluded)');

// a station with sets logged is done and falls out of the running
alt = nearbyAlternative(mkActive([
  { machineId: 'near', num: 5, label: 'Near fly', settings: {}, sets: [{ reps: 8, weight: 10 }] },
]), gym, m1, 'db');
assert.equal(alt.machine.id, 'm2', 'done stations are skipped');

// but a plan target keeps its station open until the set count is met
const targeted = mkActive([
  { machineId: 'near', num: 5, label: 'Near fly', settings: {}, sets: [{ reps: 8, weight: 10 }] },
]);
targeted.plan.find((p) => p.machineId === 'near').target = { sets: 3, reps: 8, weight: 10 };
alt = nearbyAlternative(targeted, gym, m1, 'db');
assert.equal(alt.machine.id, 'near', 'a station below its target set count is still open');

// nothing open besides the plan's next -> no alternative
const onlyNext = { ...mkActive(), plan: [
  { machineId: 'm1', exercise: null }, { machineId: 'db', exercise: null }] };
assert.equal(nearbyAlternative(onlyNext, gym, m1, 'db'), null, 'no candidates -> null');

// log screen offers the escape hatch — and only when it exists
store.saveActive({
  v: 2, id: 'w-nearby-render', startedAt: 1755000000000,
  plan: [{ machineId: 'm1', exercise: null }, { machineId: 'db', exercise: null },
    { machineId: 'near', exercise: null }],
  currentMachineId: 'm1', currentExercise: null, entries: [],
});
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('Busy? #5') && root.innerHTML.includes('is nearby'),
  'log screen renders the nearby alternative');

store.saveActive({
  v: 2, id: 'w-nearby-none', startedAt: 1755000000000,
  plan: [{ machineId: 'm1', exercise: null }, { machineId: 'db', exercise: null }],
  currentMachineId: 'm1', currentExercise: null, entries: [],
});
byId.clear();
renderTrain(root);
assert.ok(!root.innerHTML.includes('Busy?'), 'no nearby line when only the next slot is open');

// --- muscle coverage on the overview ---
// muscles of machines with sets this session read live from the gym;
// covered chips carry sel+done, open ones stay plain
gym.machines.find((m) => m.id === 'm1').muscles = ['Chest'];
gym.machines.find((m) => m.id === 'm2').muscles = ['Lower back'];
gym.machines.find((m) => m.id === 'near').muscles = ['Shoulders'];
store.saveGym(gym);

store.saveActive({
  v: 2, id: 'w-coverage', startedAt: 1755000000000,
  plan: [{ machineId: 'm1', exercise: null }, { machineId: 'm2', exercise: null }],
  currentMachineId: null, currentExercise: null,
  entries: [
    { machineId: 'm1', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 8, weight: 10 }] },
    { machineId: 'm2', num: 3, label: 'Back extension', settings: {}, sets: [] },
  ],
});
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('Muscles today'), 'overview renders the coverage card');
assert.ok(root.innerHTML.includes('chip sel done" data-muscle="Chest"'),
  'a muscle trained this session is marked covered');
assert.ok(root.innerHTML.includes('chip" data-muscle="Lower back"'),
  'a machine without sets leaves its muscle open');
assert.ok(root.innerHTML.includes('chip" data-muscle="Shoulders"'),
  'unvisited machines leave their muscles open');

// --- locker: leads on the way in, collapses once training starts ---
// The locker only matters at the start of a session; from the first logged
// set on, the overview belongs to the next machine and the next reps, so the
// card becomes one row above Finish.
const lockerActive = (sets) => ({
  v: 2, id: 'w-locker', startedAt: 1755000000000,
  plan: [{ machineId: 'm1', exercise: null }],
  currentMachineId: null, currentExercise: null, locker: '42',
  entries: [{ machineId: 'm1', num: 1, label: 'Chest press', settings: {}, sets }],
});

store.saveActive(lockerActive([]));
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('<h2>Locker</h2>'), 'nothing logged yet: the locker card leads');
assert.ok(!root.innerHTML.includes('details class="locker"'),
  'no collapsed row while the card is up');
assert.ok(root.innerHTML.includes('id="locker-num"'), 'the visible input is there to type into');
root.querySelector('#locker-num').listeners.change({ target: { value: ' 12 ' } });
assert.equal(store.getActive().locker, '12', 'the card input writes the locker number');

store.saveActive(lockerActive([{ reps: 8, weight: 10 }]));
byId.clear();
renderTrain(root);
const lockerHtml = root.innerHTML;
assert.ok(!lockerHtml.includes('<h2>Locker</h2>'), 'a logged set collapses the locker card');
assert.ok(lockerHtml.includes('<details class="locker">'), 'collapsed into a details row');
assert.ok(lockerHtml.includes('🔒 42'), 'the summary shows the locker number');
assert.ok(lockerHtml.includes('id="locker-num"'), 'expanding reveals the same input');
const pos = (needle) => lockerHtml.indexOf(needle);
assert.ok(pos('<details class="locker">') > pos('<h2>Add machine</h2>')
  && pos('<details class="locker">') < pos('id="finish"'),
'the collapsed row sits at the bottom, directly above Finish');
root.querySelector('#locker-num').listeners.change({ target: { value: ' 7 ' } });
assert.equal(store.getActive().locker, '7', 'the collapsed input is wired the same way');

// an unset locker still names what the row is for
const lockerUnset = lockerActive([{ reps: 8, weight: 10 }]);
delete lockerUnset.locker;
store.saveActive(lockerUnset);
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('🔒 Locker'), 'an unset locker labels itself');

// --- shared quick start (wireQuickStart) ---
// The first-run screen and the start screen's no-machines branch offer the
// same two controls and now share one handler — backstop included: a workout
// with logged sets that appeared after the render must never be clobbered.
store.saveGym(store.newGym('Empty gym'));
store.clearActive();
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('Welcome to gymii'), 'no gym, no plans -> first-run screen');

root.querySelector('#qs-label').value = 'Cable row';
store.saveActive({
  v: 2, id: 'w-live', startedAt: 1755000000000,
  plan: [{ machineId: 'm1', exercise: null }],
  currentMachineId: null, currentExercise: null,
  entries: [{
    machineId: 'm1', num: 1, label: 'Chest press', settings: {},
    sets: [{ reps: 8, weight: 10 }],
  }],
});
root.querySelector('#qs-start').listeners.click();
assert.equal(store.getActive().id, 'w-live',
  'onboarding quick start backs off from a workout with logged sets');
assert.equal(store.getGym().machines.length, 0, 'and creates no machine when it backs off');

// same wiring on the start screen: a saved plan routes there instead of
// onboarding, and its no-machines branch quick-starts identically
store.clearActive();
store.savePlan(store.planFromText('Leg press 3x10 80'));
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('Start at a machine') && root.innerHTML.includes('id="qs-start"'),
  'start screen without machines offers quick start');
root.querySelector('#qs-label').value = 'Cable row';
root.querySelector('#qs-start').listeners.click();
const qsGym = store.getGym();
assert.equal(qsGym.machines.length, 1, 'quick start creates the named machine');
assert.equal(qsGym.machines[0].label, 'Cable row');
assert.equal(store.getActive().plan[0].machineId, qsGym.machines[0].id,
  'and starts the workout at it');

// --- prefill matrix ---
// The "last weight at this machine" contract, pinned case by case:
//  (a) a plan target vs. a set already logged this session
//  (b) the no-target fallback chain
//  (c) exercise scoping (lastEntryFor's own cases live in store.test.mjs)
//  (d) a previous entry whose type flag was toggled since
//  (e) prefills after setUnit converted the history
// nextSetDefaults is pure precedence logic and is exercised directly (it is
// exported for exactly this, like nearbyAlternative); everything that only
// exists once resolveEntry ran — the "Last:" header, machine settings
// carry-over, the rendered stepper values — goes through renderLog.

const kgS = { v: 1, restSeconds: 90, weightStep: 2.5, unit: 'kg' };
const lbsS = { ...kgS, unit: 'lbs', weightStep: 5.5 };
// three sets, ramping — so "same set number" and "last set" differ
const prev = { sets: [{ reps: 12, weight: 40 }, { reps: 10, weight: 45 }, { reps: 8, weight: 50 }] };
const goal = { sets: 3, reps: 10, weight: 55 };

// (a) the target is the goal for THIS session: it beats history on the
// first set, but never what was actually just lifted
assert.deepEqual(nextSetDefaults({ sets: [] }, null, 'strength', kgS, goal),
  { reps: 10, weight: 55 }, 'a: no sets yet -> the target prefills');
assert.deepEqual(nextSetDefaults({ sets: [] }, prev, 'strength', kgS, goal),
  { reps: 10, weight: 55 }, 'a: the target outranks history on the first set');
assert.deepEqual(nextSetDefaults({ sets: [{ reps: 10, weight: 50 }] }, prev, 'strength', kgS, goal),
  { reps: 10, weight: 50 }, 'a: a set logged this session outranks the target');
assert.deepEqual(nextSetDefaults({ sets: [] }, null, 'cardio', kgS, { distance: 3000, seconds: 900 }),
  { distance: 3000, seconds: 900 }, 'a: a cardio target prefills distance + time');
assert.deepEqual(nextSetDefaults({ sets: [] }, null, 'bodyweight', kgS, { sets: 3, reps: 12, weight: 5 }),
  { reps: 12, weight: 5 }, 'a: a bodyweight target prefills reps + added weight');

// (b) without a target: the set just done this session, else set 1 of the
// previous session, then the static default
assert.deepEqual(nextSetDefaults({ sets: [] }, prev, 'strength', kgS),
  { reps: 12, weight: 40 }, 'b: set 1 comes from set 1 of the previous session');
assert.deepEqual(nextSetDefaults({ sets: [{ reps: 10, weight: 42.5 }] }, prev, 'strength', kgS),
  { reps: 10, weight: 42.5 }, 'b: the set just logged beats the same set number from history');
assert.deepEqual(nextSetDefaults({ sets: prev.sets.slice() }, prev, 'strength', kgS),
  { reps: 8, weight: 50 }, 'b: the set just done keeps winning past history\'s set count');
// history only ever seeds the opener — a non-empty entry never reads `last`,
// so the previous session's later sets are unreachable by construction; both
// sides of that line are pinned above.
assert.deepEqual(nextSetDefaults({ sets: [] }, { sets: [] }, 'strength', kgS),
  { reps: 10, weight: 20 }, 'b: a set-less previous entry falls through to the static default');
assert.deepEqual(nextSetDefaults({ sets: [] }, null, 'strength', kgS), { reps: 10, weight: 20 },
  'b: static strength default');
assert.deepEqual(nextSetDefaults({ sets: [] }, null, 'bodyweight', kgS), { reps: 10, weight: 0 },
  'b: static bodyweight default adds no weight');
assert.deepEqual(nextSetDefaults({ sets: [] }, null, 'cardio', kgS), { distance: 1000, seconds: 600 },
  'b: static cardio default is 1000 m in metric');
// (e) the static cardio default is stated in the display unit too
assert.deepEqual(nextSetDefaults({ sets: [] }, null, 'cardio', lbsS), { distance: 0.5, seconds: 600 },
  'e: static cardio default is 0.5 mi in imperial');

// --- render-level: header line, settings carry-over, stepper values ---
store.clearAll();
const pGym = store.newGym('Prefill gym');
pGym.machines.push(
  { id: 'p1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: ['Seat'] },
  { id: 'pdb', num: 2, label: 'Dumbbells', x: 6, y: 0, w: 4, h: 3, settingsFields: [],
    exercises: ['Biceps curls', 'Shoulder press'] },
  // pex LOST its cardio flag in the studio, pbw GAINED a bodyweight one —
  // either way the stored entry is the wrong shape for this screen now
  { id: 'pex', num: 3, label: 'Rower', x: 12, y: 0, w: 4, h: 3, settingsFields: ['Level'] },
  { id: 'pbw', num: 4, label: 'Dip bar', x: 18, y: 0, w: 4, h: 3, settingsFields: [], bodyweight: true },
  { id: 'pc', num: 5, label: 'Treadmill', x: 24, y: 0, w: 4, h: 3, settingsFields: [], cardio: true },
);
store.saveGym(pGym);

store.saveWorkouts([
  // an older session at the same machine — the prefill must read the LAST
  // one, not the first one it finds
  { id: 'h0', startedAt: 100, finishedAt: 200, entries: [
    { machineId: 'p1', num: 1, label: 'Chest press', settings: { Seat: '2' },
      sets: [{ reps: 15, weight: 30 }, { reps: 15, weight: 30 }] },
  ] },
  { id: 'h1', startedAt: 1000, finishedAt: 2000, entries: [
    { machineId: 'p1', num: 1, label: 'Chest press', settings: { Seat: '4' },
      sets: [{ reps: 12, weight: 40 }, { reps: 10, weight: 45 }] },
    // logged while pex was still a cardio station — settings included
    { machineId: 'pex', num: 3, label: 'Rower', cardio: true, settings: { Level: '7' },
      sets: [{ distance: 3000, seconds: 900 }] },
    // logged before pbw was flagged bodyweight: 30 kg on the bar, not added
    { machineId: 'pbw', num: 4, label: 'Dip bar', settings: {}, sets: [{ reps: 9, weight: 30 }] },
  ] },
  { id: 'h2', startedAt: 3000, finishedAt: 4000, entries: [
    { machineId: 'pdb', num: 2, label: 'Dumbbells', exercise: 'Biceps curls', settings: {},
      sets: [{ reps: 10, weight: 12.5 }] },
    { machineId: 'pdb', num: 2, label: 'Dumbbells', exercise: 'Shoulder press', settings: {},
      sets: [{ reps: 8, weight: 20 }] },
  ] },
]);

// renders the log screen at one (machine, exercise) and hands back the HTML
const logAt = (machineId, exercise = null, { entries = [], target = null } = {}) => {
  store.saveActive({
    v: 2, id: 'w-prefill', startedAt: 5000,
    plan: [{ machineId, exercise, ...(target ? { target } : {}) }],
    currentMachineId: machineId, currentExercise: exercise, entries,
  });
  byId.clear();
  renderTrain(root);
  return root.innerHTML;
};
const stepper = (html, id) =>
  html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`))?.[1] ?? null;

// (b) render-level: set 1 prefills from set 1 of the MOST RECENT session
let html = logAt('p1');
assert.equal(stepper(html, 'set-weight'), '40', 'b: the log screen prefills last session\'s set 1');
assert.equal(stepper(html, 'set-reps'), '12');
assert.ok(html.includes('Last: 40×12, 45×10 kg'), 'b: the header states the whole last session');
assert.ok(!html.includes('30×15'), 'b: the older session at the same machine is not the one read');
assert.ok(/data-field="Seat"[\s\S]*?value="4"/.test(html),
  'b: machine settings come from the same (most recent) entry');
assert.ok(html.includes('✓ Log set — 40 kg × 12'), 'b: the log button names what it will log');

// (c) exercise scoping: each exercise of a station prefills from its own
// history, never from its sibling's
html = logAt('pdb', 'Shoulder press');
assert.equal(stepper(html, 'set-weight'), '20', 'c: the picked exercise prefills from its own entry');
assert.ok(html.includes('Last: 20×8 kg') && !html.includes('12.5'),
  'c: and the header shows that exercise only');
html = logAt('pdb', 'Biceps curls');
assert.equal(stepper(html, 'set-weight'), '12.5', 'c: the sibling exercise has its own prefill');
assert.ok(html.includes('Last: 12.5×10 kg'));

// (d) a previous entry of another type is useless as a prefill and as the
// "Last:" line — but its machine settings still carry over
html = logAt('pex');
assert.ok(html.includes('First time on this machine'),
  'd: a type-toggled previous entry is not announced as "Last:"');
assert.ok(!html.includes('Last:'), 'd: no "Last:" line from the other type');
assert.equal(stepper(html, 'set-weight'), '20', 'd: prefill falls back to the static default');
assert.equal(stepper(html, 'set-distance'), null, 'd: the entry type rules the screen, not the history');
assert.ok(/data-field="Level"[\s\S]*?value="7"/.test(html),
  'd: machine settings DO carry over across a type change');
// the same in the other direction: strength history at a now-bodyweight bar
html = logAt('pbw');
assert.ok(html.includes('First time on this machine') && !html.includes('Last:'),
  'd: a bodyweight toggle discards the strength history too');
assert.deepEqual([stepper(html, 'set-reps'), stepper(html, 'set-weight')], ['10', '0'],
  'd: static bodyweight default instead');
// and a target whose shape no longer matches the machine is dropped as well
html = logAt('pc', null, { target: goal });
assert.ok(!html.includes('Target:'), 'd: a strength target at a cardio machine is dropped');
assert.deepEqual([stepper(html, 'set-distance'), stepper(html, 'set-time')], ['1000', '10'],
  'd: cardio falls back to its static default');

// (a) render-level: the target leads, a logged set takes over
html = logAt('p1', null, { target: goal });
assert.equal(stepper(html, 'set-weight'), '55', 'a: the target prefills over last session\'s 40');
assert.ok(html.includes('Target: 3 × 10 @ 55 kg') && html.includes('set 1/3'),
  'a: the header states the target and the set position');
assert.ok(html.includes('✓ Log set 1/3 — 55 kg × 10'), 'a: the log button counts against the target');
html = logAt('p1', null, {
  target: goal,
  entries: [{ machineId: 'p1', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 50 }] }],
});
assert.equal(stepper(html, 'set-weight'), '50', 'a: after a deviation the real working weight wins');
assert.ok(html.includes('✓ Log set 2/3 — 50 kg × 10'));

// (e) prefills follow setUnit's conversion of the history
store.setUnit('lbs');
html = logAt('p1');
assert.equal(stepper(html, 'set-weight'), '88', 'e: 40 kg history prefills as 88 lbs');
assert.ok(html.includes('Last: 88×12, 99×10 lbs'), 'e: the header follows the conversion');
store.setUnit('kg');
html = logAt('p1');
assert.equal(stepper(html, 'set-weight'), '40', 'e: and back again on the way home');

// a target on a RUNNING workout's slot is its own copy of the plan's — it
// has to follow the switch too, or the goal silently changes weight class
logAt('p1', null, { target: goal }); // 55 kg
store.setUnit('lbs');
byId.clear();
renderTrain(root); // re-render the SAME active, converted in place
html = root.innerHTML;
assert.equal(stepper(html, 'set-weight'), '121.5', 'e: the running slot target converted with the unit');
assert.ok(html.includes('Target: 3 × 10 @ 121.5 lbs'), 'e: and the header states the converted goal');
store.setUnit('kg');
byId.clear();
renderTrain(root);
assert.equal(stepper(root.innerHTML, 'set-weight'), '55', 'e: the roundtrip lands back on 55 kg');

// --- keeping the input in view ---
// screenKey decides scroll-to-top: a different key is navigation between the
// tab's five screens, the same key is an in-place update whose scroll
// position belongs to the user (log a set and the view must NOT jump).
const logging = { currentMachineId: 'm1', currentExercise: null, entries: [], plan: [] };
assert.equal(screenKey(null, null), 'start');
assert.equal(screenKey(null, { planId: 'p1' }), 'builder:p1');
assert.equal(screenKey(null, { planId: null }), 'builder:new');
assert.equal(screenKey({ ...logging, currentMachineId: null }, null), 'overview');
assert.equal(screenKey(logging, null), 'log:m1:');
assert.equal(screenKey({ ...logging, currentExercise: 'Biceps curls' }, null),
  'log:m1:Biceps curls', 'each exercise at a station is its own screen');
assert.equal(screenKey({ ...logging, binding: 0 }, null), 'bind:0',
  'binding index 0 must not read as "no binding"');
assert.equal(screenKey(logging, null), screenKey({ ...logging }, null),
  'logging a set leaves the key alone, so the scroll survives');
// an active workout outranks an open builder, like renderTrain does
assert.equal(screenKey(logging, { planId: 'p1' }), 'log:m1:');

// the reveal path runs against the real render: the stub DOM has no
// scrollIntoView, so an unguarded call would throw here
store.saveActive({
  v: 2, id: 'w-reveal', startedAt: 1755000000000,
  plan: [{ machineId: 'm1', exercise: null }],
  currentMachineId: 'm1', currentExercise: null, entries: [],
});
renderTrain(root);
const logBtn = root.querySelector('#log-set');
assert.equal(logBtn.scrollIntoView, undefined, 'stub really lacks scrollIntoView');
logBtn.listeners.click(); // logs a set, then reveals '.next-set'
assert.equal(store.getActive().entries[0].sets.length, 1, 'the set was logged');

// --- rest-screen dimming: when the overlay starts dimming itself ---
assert.equal(dimDelaySeconds('10s'), 10, 'the default waits 10s before dimming');
assert.equal(dimDelaySeconds('now'), 0, '"now" dims from the first tick');
assert.equal(dimDelaySeconds('off'), Infinity, '"off" never dims');
assert.equal(dimDelaySeconds(undefined), 10, 'an absent setting falls back to 10s');
// a workout-scoped wake lock must not throw where the API is missing (Node
// has a navigator but no wakeLock, like older browsers) — renderTrain runs
// the lock path on every render, and there is no document here either
assert.equal(globalThis.navigator?.wakeLock, undefined, 'no wakeLock API in this env');
assert.equal(typeof globalThis.document, 'undefined', 'no document in this env');
store.saveSettings({ ...store.getSettings(), keepAwake: 'workout' });
renderTrain(root); // would throw if the lock path were unguarded
store.saveSettings({ ...store.getSettings(), keepAwake: 'break' });

console.log('train plan construction: all assertions passed');
