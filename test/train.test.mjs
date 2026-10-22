// Logic-level test for train.js's guided-plan construction: one slot per
// (machine, exercise) pair on repeat, dedupe, and fallbacks for machines
// or exercises that no longer exist.
// Run with: node test/train.test.mjs
import { failWritesAfter } from './helpers/localstorage.mjs'; // FIRST: installs the stub
import { strict as assert } from 'node:assert';

const store = await import(new URL('../js/store.js', import.meta.url).href);
const plantext = await import(new URL('../js/plantext.js', import.meta.url).href);
const {
  startWorkoutFrom, renderTrain, nearbyAlternative, nextSetDefaults, dimDelaySeconds,
  screenKey, goToHub, goToStart, goToPlans, restLeft, restNextUp, surpriseMachine, muscleProgress, suggestNext,
} = await import(new URL('../js/train.js', import.meta.url).href);

const gym = store.newLayout('Test gym');
gym.machines.push({ id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [] });
gym.machines.push({
  id: 'db', num: 2, label: 'Dumbbells', x: 6, y: 0, w: 4, h: 3, settingsFields: [],
  exercises: ['Biceps curls', 'Shoulder press'],
});
store.saveLayout(gym);

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

// an exercise the machine no longer offers falls back to a machine slot —
// which is dropped again when exercise slots for the same machine exist
startWorkoutFrom({ entries: [entry('db', 'Gone')] });
assert.deepEqual(store.getActive().plan, [{ machineId: 'db', exercise: null }],
  'unknown exercise falls back to a whole-machine slot');
startWorkoutFrom({ entries: [entry('db', 'Gone'), entry('db', 'Biceps curls')] });
assert.deepEqual(store.getActive().plan, [{ machineId: 'db', exercise: 'Biceps curls' }],
  'machine slot dropped when exercise slots for the machine exist');

// deleted machines fall out of the plan; firstMachineId seeds a free workout
startWorkoutFrom({ entries: [entry('ghost'), entry('m1')] });
assert.deepEqual(store.getActive().plan, [{ machineId: 'm1', exercise: null }],
  'entries of deleted machines are skipped');
startWorkoutFrom(null, 'm1');
active = store.getActive();
assert.deepEqual(active.plan, [{ machineId: 'm1', exercise: null, free: true }],
  'a machine merely started at is a free slot (opened, not committed)');
assert.equal(active.currentMachineId, 'm1');
assert.strictEqual(active.currentExercise, null);

// a plan whose first stop has no machine yet opens on that question
startWorkoutFrom({ entries: [{ name: 'Leg press' }, entry('m1')] });
active = store.getActive();
assert.equal(active.binding, 0, 'an unbound first slot opens the bind screen');
assert.strictEqual(active.currentMachineId, null, 'with nothing to log at yet');
// starting AT a machine answers the question before it is asked
startWorkoutFrom({ entries: [{ name: 'Leg press' }] }, 'm1');
active = store.getActive();
assert.ok(!('binding' in active), 'picking a machine to start at overrules the bind screen');
assert.equal(active.currentMachineId, 'm1');

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
  value: '', innerHTML: '', textContent: '',
  querySelector: () => stubEl(), querySelectorAll: () => [],
  // stateful, so twoTapConfirm's arm → confirm cycle works here as it does
  // in plan.test.mjs
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

// the header names the machine's brand — resolved through the gym, since a
// machine without one of its own is the gym's brand
{
  const g = store.getLayout();
  g.meta.brand = 'Technogym';
  store.saveLayout(g);
  renderTrain(root);
  assert.ok(root.innerHTML.includes('Technogym'), 'an unbranded machine shows the gym\'s brand');
  g.machines.find((m) => m.id === 'm1').brand = 'Cybex';
  store.saveLayout(g);
  renderTrain(root);
  assert.ok(root.innerHTML.includes('Cybex') && !root.innerHTML.includes('Technogym'),
    'a machine with its own brand shows that one, not the gym\'s');
  delete g.meta.brand;
  delete g.machines.find((m) => m.id === 'm1').brand;
  store.saveLayout(g);
  renderTrain(root);
}

// multi-exercise machine, no exercise picked yet: chip picker, no logger
store.saveActive({
  v: 2, id: 'w-pick', startedAt: 1755000000000,
  plan: [{ machineId: 'db', exercise: null }],
  currentMachineId: 'db', currentExercise: null, entries: [],
});
renderTrain(root);
assert.ok(root.innerHTML.includes('Biceps curls'), 'machine renders its exercise chips');
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

// a rower's display reads "12:30" and "2.000 m"; the German number pad types
// them as "12,30" and "2.000" — that is 750 s and 2000 m, not 738 s and 2 m
gym.machines.push({ id: 'row', num: 9, label: 'Rower', x: 30, y: 10, w: 3, h: 3, settingsFields: [], cardio: true });
store.saveLayout(gym);
store.saveActive({
  v: 2, id: 'w-row', startedAt: 1755000000000,
  plan: [{ machineId: 'row', exercise: null }],
  currentMachineId: 'row', currentExercise: null, entries: [],
});
byId.clear();
renderTrain(root);
assert.ok(/id="set-time"[^>]*value="10:00"/.test(root.innerHTML), 'the time field shows m:ss');
root.querySelector('#set-distance').value = '2.000';
root.querySelector('#set-time').value = '12,30';
root.querySelector('#set-rest').value = '0';
// the field shows back what will be logged, in its clean form
root.querySelector('#set-time').listeners.change();
assert.equal(root.querySelector('#set-time').value, '12:30', 'a change rewrites "12,30" as 12:30');
root.querySelector('#log-set').listeners.click();
const rowSet = store.getActive().entries.find((e) => e.machineId === 'row').sets.at(-1);
assert.equal(rowSet.seconds, 750, 'comma time is minutes,seconds');
assert.equal(rowSet.distance, 2000, 'a dot before three digits is a thousands mark in metres');
// an unreadable field logs its prefill instead of a zero
root.querySelector('#set-time').value = '12:75';
root.querySelector('#log-set').listeners.click();
assert.equal(store.getActive().entries.find((e) => e.machineId === 'row').sets.at(-1).seconds, 750,
  'refused input falls back to the prefill (the last set)');
gym.machines.pop();
store.saveLayout(gym);

// --- quick-switch chips ---
// a superset workout logging at machine A with `at`-stamped sets on B and
// C shows chips for the OTHER machines, newest first-ish (both present),
// but never a chip for the current machine A itself.
gym.machines.push({ id: 'm2', num: 3, label: 'Back extension', x: 12, y: 0, w: 4, h: 3, settingsFields: [] });
store.saveLayout(gym);

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
assert.ok(root.innerHTML.includes('quick-switch'), 'quick-switch block renders for machines with at-stamped sets');
assert.ok(root.innerHTML.includes('#2 Dumbbells'), 'chip for machine B (Dumbbells)');
assert.ok(root.innerHTML.includes('#3 Back extension'), 'chip for machine C (Back extension)');
assert.ok(!root.innerHTML.includes('↩ #1 Chest press'), 'no quick-switch chip for the current machine');

// tapping a chip swings the workout back: currentMachineId/currentExercise
// switch to the tapped machine and the entry that owns its newest set
const quickSwitchChip = root.querySelector('.quick-switch').listeners.click;
quickSwitchChip({ target: { closest: () => ({ dataset: { machine: 'db' } }) } });
active = store.getActive();
assert.equal(active.currentMachineId, 'db', 'tapping a chip switches the current machine');
assert.equal(active.currentExercise, 'Biceps curls', 'tapping a chip switches to the entry\'s exercise');

// a workout whose OTHER-machine sets lack `at` renders no quick-switch
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
assert.ok(!root.innerHTML.includes('quick-switch'), 'no quick-switch block when other-machine sets lack at');

// --- nearby alternative (busy-machine escape hatch) ---
// the closest OTHER machine with an open slot, by the walk (centres without a floor grid); the
// current machine and the plan's next are excluded, done slots don't count
gym.machines.push({ id: 'far', num: 4, label: 'Far press', x: 50, y: 30, w: 4, h: 3, settingsFields: [] });
gym.machines.push({ id: 'near', num: 5, label: 'Near fly', x: 0, y: 6, w: 4, h: 3, settingsFields: [] });
store.saveLayout(gym);

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
assert.equal(alt.machine.id, 'near', 'closest open other machine wins (current + next excluded)');

// a machine with its set goal logged (the app default, 3) is done and falls
// out of the running — one set alone no longer closes it
const set8 = () => ({ reps: 8, weight: 10 });
alt = nearbyAlternative(mkActive([
  { machineId: 'near', num: 5, label: 'Near fly', settings: {}, sets: [set8(), set8(), set8()] },
]), gym, m1, 'db');
assert.equal(alt.machine.id, 'm2', 'done machines are skipped');
alt = nearbyAlternative(mkActive([
  { machineId: 'near', num: 5, label: 'Near fly', settings: {}, sets: [set8()] },
]), gym, m1, 'db');
assert.equal(alt.machine.id, 'near', 'one of three sets: still open (the default set goal)');

// but a plan target keeps its machine open until the set count is met
const targeted = mkActive([
  { machineId: 'near', num: 5, label: 'Near fly', settings: {}, sets: [{ reps: 8, weight: 10 }] },
]);
targeted.plan.find((p) => p.machineId === 'near').target = { sets: 3, reps: 8, weight: 10 };
alt = nearbyAlternative(targeted, gym, m1, 'db');
assert.equal(alt.machine.id, 'near', 'a machine below its target set count is still open');

// nothing open besides the plan's next -> no alternative
const onlyNext = { ...mkActive(), plan: [
  { machineId: 'm1', exercise: null }, { machineId: 'db', exercise: null }] };
assert.equal(nearbyAlternative(onlyNext, gym, m1, 'db'), null, 'no candidates -> null');

// a template machine without geometry is no NaN distance: a NaN never
// loses a `<` and so used to win the escape hatch outright (straight lines
// here — a grid of 500 is no floor to walk)
{
  const here = { id: 'h', num: 1, label: 'Here', x: 20, y: 20, w: 4, h: 3 };
  const g = { grid: { w: 500, h: 500 }, machines: [
    here,
    { id: 'nogeo', num: 2, label: 'No geometry' },
    { id: 'close', num: 3, label: 'Close', x: 25, y: 20, w: 4, h: 3 },
  ] };
  const a = { id: 'w-nan', plan: [{ machineId: 'h', exercise: null }, { machineId: 'nogeo', exercise: null },
    { machineId: 'close', exercise: null }], currentMachineId: 'h', entries: [] };
  assert.equal(nearbyAlternative(a, g, here, null, { v: 1, defaultSets: 3 }).machine.id, 'close',
    'a machine without x/y/w/h sits at the origin, not at NaN');
}

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
// muscles of machines with sets this workout read live from the gym;
// a trained muscle's row carries a bar, an open one carries .open
gym.machines.find((m) => m.id === 'm1').muscles = ['Chest'];
gym.machines.find((m) => m.id === 'm2').muscles = ['Lower back'];
gym.machines.find((m) => m.id === 'near').muscles = ['Shoulders'];
store.saveLayout(gym);

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
assert.ok(root.innerHTML.includes('class="muscle-row" data-muscle="Chest">'),
  'a muscle trained this workout gets a row with a bar');
assert.ok(!root.innerHTML.includes('data-muscle="Lower back"'), 'the open rows start folded');
assert.ok(root.innerHTML.includes('>Show 2 untrained</button>'), 'behind one toggle that counts them');
store.saveSettings({ ...store.getSettings(), muscleFold: 'shown' });
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('class="muscle-row open" data-muscle="Lower back">'),
  'a machine without sets leaves its muscle open');
assert.ok(root.innerHTML.includes('class="muscle-row open" data-muscle="Shoulders">'),
  'unvisited machines leave their muscles open');
assert.ok(root.innerHTML.includes('1 of 3 muscles trained'), 'the line over the rows counts the trained ones');
{ const { muscleFold, ...rest } = store.getSettings(); store.saveSettings(rest); }

// --- locker: leads on the way in, collapses once training starts ---
// The locker only matters at the start of a workout; from the first logged
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
store.saveLayout(store.newLayout('Empty gym'));
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
assert.equal(store.getLayout().machines.length, 0, 'and creates no machine when it backs off');

// same wiring on the start screen: a saved plan routes there instead of
// onboarding, and its no-machines branch quick-starts identically
store.clearActive();
store.savePlan(plantext.planFromText('Leg press 3x10 80'));
byId.clear();
goToStart(); // the tab root is the hub; quick start lives on the start screen
renderTrain(root);
assert.ok(root.innerHTML.includes('Start at a machine') && root.innerHTML.includes('id="qs-start"'),
  'start screen without machines offers quick start');
root.querySelector('#qs-label').value = 'Cable row';
root.querySelector('#qs-start').listeners.click();
const qsGym = store.getLayout();
assert.equal(qsGym.machines.length, 1, 'quick start creates the named machine');
assert.equal(qsGym.machines[0].label, 'Cable row');
assert.equal(store.getActive().plan[0].machineId, qsGym.machines[0].id,
  'and starts the workout at it');

// --- prefill matrix ---
// The "last weight at this machine" contract, pinned case by case:
//  (a) a plan target vs. a set already logged this workout
//  (b) the no-target fallback chain
//  (c) exercise scoping (lastEntryFor's own cases live in store.test.mjs)
//  (d) a previous entry whose type flag was toggled since
//  (e) prefills after setUnit converted the history
//  (f) a cardio set's level rides the same chain, absent when none
// nextSetDefaults is pure precedence logic and is exercised directly (it is
// exported for exactly this, like nearbyAlternative); everything that only
// exists once resolveEntry ran — the "Last:" header, machine settings
// carry-over, the rendered stepper values — goes through renderLog.

const kgS = { v: 1, restSeconds: 90, weightStep: 2.5, unit: 'kg' };
const lbsS = { ...kgS, unit: 'lbs', weightStep: 5.5 };
// three sets, ramping — so "same set number" and "last set" differ
const prev = { sets: [{ reps: 12, weight: 40 }, { reps: 10, weight: 45 }, { reps: 8, weight: 50 }] };
const goal = { sets: 3, reps: 10, weight: 55 };

// (a) the target is the goal for THIS workout: it beats history on the
// first set, but never what was actually just lifted
assert.deepEqual(nextSetDefaults({ sets: [] }, null, 'strength', kgS, goal),
  { reps: 10, weight: 55 }, 'a: no sets yet -> the target prefills');
assert.deepEqual(nextSetDefaults({ sets: [] }, prev, 'strength', kgS, goal),
  { reps: 10, weight: 55 }, 'a: the target outranks history on the first set');
assert.deepEqual(nextSetDefaults({ sets: [{ reps: 10, weight: 50 }] }, prev, 'strength', kgS, goal),
  { reps: 10, weight: 50 }, 'a: a set logged this workout outranks the target');
assert.deepEqual(nextSetDefaults({ sets: [] }, null, 'cardio', kgS, { distance: 3000, seconds: 900 }),
  { distance: 3000, seconds: 900 }, 'a: a cardio target prefills distance + time');
assert.deepEqual(nextSetDefaults({ sets: [] }, null, 'bodyweight', kgS, { sets: 3, reps: 12, weight: 5 }),
  { reps: 12, weight: 5 }, 'a: a bodyweight target prefills reps + added weight');

// (b) without a target: the set just done this workout, else set 1 of the
// previous workout, then the static default
assert.deepEqual(nextSetDefaults({ sets: [] }, prev, 'strength', kgS),
  { reps: 12, weight: 40 }, 'b: set 1 comes from set 1 of the previous workout');
assert.deepEqual(nextSetDefaults({ sets: [{ reps: 10, weight: 42.5 }] }, prev, 'strength', kgS),
  { reps: 10, weight: 42.5 }, 'b: the set just logged beats the same set number from history');
assert.deepEqual(nextSetDefaults({ sets: prev.sets.slice() }, prev, 'strength', kgS),
  { reps: 8, weight: 50 }, 'b: the set just done keeps winning past history\'s set count');
// history only ever seeds the opener — a non-empty entry never reads `last`,
// so the previous workout's later sets are unreachable by construction; both
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
// (f) a cardio level: the set just logged, else the target, else the last
// workout's opener — and ABSENT (never 0) when that source has none
const bout = { distance: 2000, seconds: 600 };
const lastBout = { sets: [{ distance: 1500, seconds: 420, level: 4 }] };
assert.deepEqual(nextSetDefaults({ sets: [{ ...bout, level: 5 }] }, lastBout, 'cardio', kgS, { ...bout, level: 7 }),
  { ...bout, level: 5 }, 'f: the set just logged carries its level past the target');
assert.deepEqual(nextSetDefaults({ sets: [bout] }, lastBout, 'cardio', kgS, { ...bout, level: 7 }),
  bout, 'f: a set logged without a level prefills none — history does not reach past it');
assert.deepEqual(nextSetDefaults({ sets: [] }, lastBout, 'cardio', kgS, { ...bout, level: 7 }),
  { ...bout, level: 7 }, 'f: the target seeds the first set, level included');
assert.deepEqual(nextSetDefaults({ sets: [] }, lastBout, 'cardio', kgS, bout),
  bout, 'f: a target without a level prefills none');
assert.deepEqual(nextSetDefaults({ sets: [] }, lastBout, 'cardio', kgS),
  { distance: 1500, seconds: 420, level: 4 }, 'f: without a target the last workout\'s opener brings its level');
assert.deepEqual(nextSetDefaults({ sets: [] }, null, 'cardio', kgS, { ...bout, level: 0 }),
  bout, 'f: a level of 0 is none');
assert.deepEqual(nextSetDefaults({ sets: [{ ...bout, level: 2.6 }] }, null, 'cardio', kgS),
  { ...bout, level: 3 }, 'f: a level prefills whole');

// --- render-level: header line, settings carry-over, stepper values ---
store.clearAll();
const pGym = store.newLayout('Prefill gym');
pGym.machines.push(
  { id: 'p1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: ['Seat'] },
  { id: 'pdb', num: 2, label: 'Dumbbells', x: 6, y: 0, w: 4, h: 3, settingsFields: [],
    exercises: ['Biceps curls', 'Shoulder press'] },
  // pex LOST its cardio flag in the gym, pbw GAINED a bodyweight one —
  // either way the stored entry is the wrong shape for this screen now
  { id: 'pex', num: 3, label: 'Rower', x: 12, y: 0, w: 4, h: 3, settingsFields: ['Level'] },
  { id: 'pbw', num: 4, label: 'Dip bar', x: 18, y: 0, w: 4, h: 3, settingsFields: [], bodyweight: true },
  { id: 'pc', num: 5, label: 'Treadmill', x: 24, y: 0, w: 4, h: 3, settingsFields: [], cardio: true },
);
store.saveLayout(pGym);

store.saveWorkouts([
  // an older workout at the same machine — the prefill must read the LAST
  // one, not the first one it finds
  { id: 'h0', startedAt: 100, finishedAt: 200, entries: [
    { machineId: 'p1', num: 1, label: 'Chest press', settings: { Seat: '2' },
      sets: [{ reps: 15, weight: 30 }, { reps: 15, weight: 30 }] },
  ] },
  { id: 'h1', startedAt: 1000, finishedAt: 2000, entries: [
    { machineId: 'p1', num: 1, label: 'Chest press', settings: { Seat: '4' },
      sets: [{ reps: 12, weight: 40 }, { reps: 10, weight: 45 }] },
    // logged while pex was still a cardio machine — settings included
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

// (b) render-level: set 1 prefills from set 1 of the MOST RECENT workout
let html = logAt('p1');
assert.equal(stepper(html, 'set-weight'), '40', 'b: the log screen prefills last workout\'s set 1');
assert.equal(stepper(html, 'set-reps'), '12');
assert.ok(html.includes('Last: 40×12, 45×10 kg'), 'b: the header states the whole last workout');
assert.ok(!html.includes('30×15'), 'b: the older workout at the same machine is not the one read');
assert.ok(/data-field="Seat"[\s\S]*?value="4"/.test(html),
  'b: machine settings come from the same (most recent) entry');
assert.ok(html.includes('✓ Log set 1/3 — 40 kg × 12'),
  'b: the log button names what it will log, counted against the machine\'s set goal (the default, 3)');

// (c) exercise scoping: each exercise of a machine prefills from its own
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
assert.deepEqual([stepper(html, 'set-distance'), stepper(html, 'set-time')], ['1000', '10:00'],
  'd: cardio falls back to its static default');

// (a) render-level: the target leads, a logged set takes over
html = logAt('p1', null, { target: goal });
assert.equal(stepper(html, 'set-weight'), '55', 'a: the target prefills over last workout\'s 40');
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
assert.equal(stepper(html, 'set-rest'), '90', 'e: rest seconds are not a weight and never convert');
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
assert.equal(screenKey(null, null), 'hub', 'the tab root is the hub');
assert.equal(screenKey(null, null, 'start'), 'start');
assert.equal(screenKey(null, null, 'plans'), 'plans');
assert.equal(screenKey(null, { planId: 'p1' }), 'builder:p1');
assert.equal(screenKey(null, { planId: 'p1' }, 'plans'), 'builder:p1',
  'an open builder outranks the screen state');
assert.equal(screenKey(null, { planId: null }), 'builder:new');
assert.equal(screenKey({ ...logging, currentMachineId: null }, null), 'overview');
assert.equal(screenKey(logging, null), 'log:m1:');
assert.equal(screenKey({ ...logging, currentExercise: 'Biceps curls' }, null),
  'log:m1:Biceps curls', 'each exercise at a machine is its own screen');
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

// --- the train hub: neutral landing, tiles navigate ---
store.clearActive();
store.saveLayout(store.newLayout('Hub test gym')); // no machines: start screen quick-starts
store.saveWorkouts([{
  id: 'w-hub', startedAt: 1755000000000, finishedAt: 1755003600000, name: 'Push day',
  entries: [{
    machineId: 'm1', num: 1, label: 'Chest press', settings: {},
    sets: [{ reps: 8, weight: 40 }],
  }],
}]);
// an undated plan keeps the onboarding gate shut without giving the hero
// a weekday status — the fallback path stays reachable
store.savePlans([]);
store.savePlan(plantext.planFromText('Leg press 3x10 80'));
goToHub();
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('class="tile hero"') && root.innerHTML.includes('Start training'),
  'the hub leads with the start hero');
assert.ok(root.innerHTML.includes('id="hub-plans"') && root.innerHTML.includes('id="hub-gym"')
  && root.innerHTML.includes('id="hub-history"'), 'and offers the three nav tiles');
assert.ok(root.innerHTML.includes('last: Push day'),
  'without weekday plans the hero falls back to the last workout');
assert.ok(root.innerHTML.includes('Draw your gym'),
  'an empty gym turns the gym tile into the invitation');

// a dated plan puts today's status on the hero instead — as plain text
store.savePlans([{
  id: 'hub-pd', name: 'Push day', items: [{ machineId: 'm1' }], days: [new Date().getDay()],
}]);
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('Push day is on'),
  'a due weekday plan states itself on the hero');
assert.ok(!root.innerHTML.includes('<strong>'), 'the hero subtitle carries no markup');

// hero → start screen → back row → hub again
root.querySelector('#hub-start').listeners.click();
assert.ok(root.innerHTML.includes('Start at a machine'), 'the hero opens the start screen');
assert.ok(root.innerHTML.includes('id="back-hub"'), 'which carries the back row');
root.querySelector('#back-hub').listeners.click();
assert.ok(root.innerHTML.includes('class="tile hero"'), 'the back row lands on the hub');

// --- start-screen locker: noted before the workout exists, lives on it after ---
goToStart();
byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('id="locker-num"') && root.innerHTML.includes('🔒 Locker #'),
  'the start screen offers the locker option with its symbol');
root.querySelector('#locker-num').listeners.change({ target: { value: ' 42 ' } });
root.querySelector('#qs-label').value = 'Seated row';
root.querySelector('#qs-start').listeners.click();
assert.equal(store.getActive().locker, '42',
  'starting carries the noted locker onto the workout');
startWorkoutFrom({ entries: [] });
assert.strictEqual(store.getActive().locker, undefined,
  'one start consumes the note — it never leaks into the next workout');
store.clearActive();
store.saveWorkouts([]);
store.savePlans([]);

// --- 🏁 in the machine header finishes the workout, two taps ---
// Always click the PAIR: a single tap leaves twoTapConfirm's 4s disarm
// timer pending and node would sit there waiting for it.
byId.clear();
// the quick-start test above replaced the gym, so put a known machine back
const finGym = store.newLayout('Finish gym');
finGym.machines.push({
  id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [],
});
store.saveLayout(finGym);
store.saveActive({
  v: 2, id: 'w-fin', startedAt: Date.now() - 47 * 60000,
  plan: [{ machineId: 'm1', exercise: null }],
  currentMachineId: 'm1', currentExercise: null,
  entries: [{
    machineId: 'm1', num: 1, label: 'Chest press', settings: {},
    sets: [{ reps: 8, weight: 40, at: Date.now() }],
  }],
});
renderTrain(root);
assert.ok(root.innerHTML.includes('id="log-finish"'),
  'the log screen carries a finish button in the machine header');
let fin = byId.get('#log-finish');
fin.listeners.click();
assert.equal(fin.textContent, 'Save?', 'the first tap turns the button into the question');
assert.ok(store.getActive(), 'and nothing is saved yet');
fin.listeners.click();
assert.strictEqual(store.getActive(), null, 'the second tap ends the workout');
assert.equal(store.getWorkouts().length, 1, 'and it lands in history');
assert.ok(root.innerHTML.includes('47 min'),
  'the summary leads with how long the workout took');

// no sets logged: the same button asks the opposite question
byId.clear();
store.saveWorkouts([]);
store.saveActive({
  v: 2, id: 'w-fin-empty', startedAt: Date.now() - 60000,
  plan: [{ machineId: 'm1', exercise: null }],
  currentMachineId: 'm1', currentExercise: null, entries: [],
});
renderTrain(root);
fin = byId.get('#log-finish');
fin.listeners.click();
assert.equal(fin.textContent, 'Discard?', 'with no sets it offers to discard, not to save');
fin.listeners.click();
assert.strictEqual(store.getActive(), null, 'and the second tap discards it');
assert.equal(store.getWorkouts().length, 0, 'nothing empty gets written to history');
store.clearActive();
store.saveWorkouts([]);

// --- the rest you change mid-workout belongs to today, not to the machine ---
byId.clear();
const restGym = store.newLayout('Rest gym');
restGym.machines.push({
  id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [],
});
store.saveLayout(restGym);
store.saveActive({
  v: 2, id: 'w-rest', startedAt: Date.now(),
  plan: [{ machineId: 'm1', exercise: null }],
  currentMachineId: 'm1', currentExercise: null, entries: [],
});
renderTrain(root);
byId.get('#set-rest').listeners.change({ target: { value: '75' } });
assert.deepEqual(store.getActive().restOverrides, { m1: 75 },
  'the stepper writes the rest onto the workout');
assert.strictEqual(store.getLayout().machines[0].restSeconds, undefined,
  'and leaves the machine alone');
assert.equal(byId.get('#rest-keep').textContent, 'Keep 75 s for #1',
  'the offer to keep it names what it would keep');
assert.strictEqual(byId.get('#rest-keep').hidden, false, 'and shows itself');

byId.clear();
renderTrain(root);
assert.ok(root.innerHTML.includes('value="75"'), 'the override survives a re-render');
assert.ok(root.innerHTML.includes('Keep 75 s for #1'), 'and so does the offer');

byId.get('#set-rest').value = '75';
byId.get('#rest-keep').listeners.click();
assert.equal(store.getLayout().machines[0].restSeconds, 75,
  'Keep writes the rest to the machine');
assert.ok(!('restOverrides' in store.getActive()),
  'and the workout stops overriding what is now the machine value');
byId.clear();
renderTrain(root);
assert.ok(/rest-keep"[^>]*\bhidden\b/.test(root.innerHTML),
  'and the offer hides itself — there is nothing left to keep');
store.clearActive();

// --- the rest belongs to the workout, not to the rest SCREEN ---
// Headless there is no document, so only the fact lands: `restUntil` on the
// active workout. That is exactly what the inline row and the overlay both
// read, which is why it can be asserted without a DOM.
byId.clear();
const restNow = Date.now();
store.saveActive({
  v: 2, id: 'w-rest2', startedAt: restNow - 60000,
  plan: [{ machineId: 'm1', exercise: null }],
  currentMachineId: 'm1', currentExercise: null, entries: [],
  restUntil: restNow + 72000,
});
renderTrain(root);
assert.ok(root.innerHTML.includes('id="rest-inline"'),
  'a running rest shows itself on the log screen, not only in the overlay');
assert.ok(root.innerHTML.includes('1:12'), 'counting down from the workout\'s own deadline');
assert.equal(restLeft(store.getActive()), 72, 'restLeft reads the deadline as seconds');

byId.get('#rest-plus').listeners.click();
assert.ok(store.getActive().restUntil >= restNow + 86000,
  '+15s extends the deadline on the workout');

byId.get('#rest-skip').listeners.click();
assert.ok(!('restUntil' in store.getActive()), 'Skip ends the rest for good');
byId.clear();
renderTrain(root);
assert.ok(!root.innerHTML.includes('id="rest-inline"'), 'and the row is gone on the next render');

// logging a set with a rest set starts one — the deadline is the whole
// fact, the overlay is just how a browser shows it
byId.get('#set-rest').value = '90';
byId.get('#set-weight').value = '40';
byId.get('#set-reps').value = '8';
const beforeLog = Date.now();
byId.get('#log-set').listeners.click();
assert.ok(store.getActive().restUntil > beforeLog + 80000,
  'logging a set starts the rest on the workout');
store.clearActive();

// --- "Next:" on the rest screen ---
byId.clear();
const nextGym = store.newLayout('Next gym');
nextGym.machines.push({
  id: 'n1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [],
});
nextGym.machines.push({
  id: 'n3', num: 3, label: 'Back extension', x: 8, y: 0, w: 4, h: 3, settingsFields: [],
});
store.saveLayout(nextGym);
// a target with one of three sets logged: the answer is the next SET
store.saveActive({
  v: 2, id: 'w-next', startedAt: Date.now(),
  plan: [
    { machineId: 'n1', exercise: null, target: { sets: 3, reps: 10, weight: 50 } },
    { machineId: 'n3', exercise: null },
  ],
  currentMachineId: 'n1', currentExercise: null,
  entries: [{
    machineId: 'n1', num: 1, label: 'Chest press', settings: {},
    sets: [{ reps: 10, weight: 50, at: Date.now() }],
  }],
});
renderTrain(root);
assert.equal(restNextUp(), 'set 2/3 — 50 kg × 10',
  'mid-slot the next thing is the next set of it');

// a slot with NO target counts against the machine's set goal (the app
// default, 3): one set in, the answer is still the next set; with the goal
// met it moves on
const n1Sets = (n) => Array.from({ length: n }, () => ({ reps: 10, weight: 50, at: Date.now() }));
const aimless = (n) => ({
  v: 2, id: 'w-next2', startedAt: Date.now(),
  plan: [{ machineId: 'n1', exercise: null }, { machineId: 'n3', exercise: null }],
  currentMachineId: 'n1', currentExercise: null,
  entries: [{ machineId: 'n1', num: 1, label: 'Chest press', settings: {}, sets: n1Sets(n) }],
});
store.saveActive(aimless(1));
byId.clear();
renderTrain(root);
assert.equal(restNextUp(), 'set 2/3 — 50 kg × 10',
  'a target-less slot still has a goal: the next set of it');
store.saveActive(aimless(3));
byId.clear();
renderTrain(root);
assert.equal(restNextUp(), '#3 Back extension',
  'a finished aimless slot points at the next machine');
store.clearActive();

// --- removing a logged set takes two taps ---
byId.clear();
const delGym = store.newLayout('Delete gym');
delGym.machines.push({
  id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [],
});
store.saveLayout(delGym);
store.saveActive({
  v: 2, id: 'w-del', startedAt: Date.now() - 60000,
  plan: [{ machineId: 'm1', exercise: null }],
  currentMachineId: 'm1', currentExercise: null,
  entries: [{
    machineId: 'm1', num: 1, label: 'Chest press', settings: {},
    sets: [{ reps: 8, weight: 40, at: Date.now() }, { reps: 6, weight: 45, at: Date.now() }],
  }],
});
renderTrain(root);
const delX = stubEl();
delX.dataset.i = '1';
const setsClick = byId.get('#sets-list').listeners.click;
setsClick({ target: { closest: () => delX } });
assert.equal(store.getActive().entries[0].sets.length, 2, 'one tap only arms the ✕');
assert.equal(delX.textContent, 'Delete?', 'and says what the second tap will do');
setsClick({ target: { closest: () => delX } });
assert.equal(store.getActive().entries[0].sets.length, 1, 'the second tap removes the set');
assert.equal(store.getActive().entries[0].sets[0].weight, 40, 'the one it pointed at');
store.clearActive();

// --- "Reps left?" with the rest timer off ---
// Rest 0 opens no overlay, so the chips sit above Log set. They must write
// through the log screen's OWN active: the next Log set saves that object,
// and a rating written to a fresh store copy would be overwritten by it.
byId.clear();
const rirGym = store.newLayout('RIR gym');
rirGym.machines.push({
  id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [],
});
store.saveLayout(rirGym);
store.saveActive({
  v: 2, id: 'w-rir', startedAt: Date.now() - 60000,
  plan: [{ machineId: 'm1', exercise: null }],
  currentMachineId: 'm1', currentExercise: null, entries: [],
  restOverrides: { m1: 0 },
});
renderTrain(root);
byId.get('#set-weight').value = '40';
byId.get('#set-reps').value = '8';
byId.get('#set-rest').value = '0';
byId.get('#log-set').listeners.click();
// the stub hands back every selector, so prove the row really rendered
assert.ok(root.innerHTML.includes('id="rir-log"') && root.innerHTML.includes('data-rir="2"'),
  'with the rest timer off the chips sit on the log screen');
byId.get('#rir-log').listeners.click({ target: { closest: () => ({ dataset: { rir: '2' } }) } });
byId.get('#log-set').listeners.click();
const [ratedSet, nextSet] = store.getActive().entries[0].sets;
assert.equal(ratedSet.rir, 2, 'the next Log set keeps the rating');
assert.ok(!('rir' in nextSet), 'and the new set starts unrated');
store.clearActive();

// --- visits: the walking route, recorded at every machine switch ---
// start → Next → "Busy?" → finish, on a clock the test owns: closeVisits
// drops stops under 15 s, so real milliseconds would leave nothing to see.
byId.clear();
const visitGym = store.newLayout('Visit gym');
visitGym.machines.push(
  { id: 'va', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [] },
  { id: 'vb', num: 2, label: 'Lat pulldown', x: 10, y: 0, w: 4, h: 3, settingsFields: [] },
  { id: 'vc', num: 3, label: 'Leg press', x: 40, y: 0, w: 4, h: 3, settingsFields: [] },
  { id: 'vd', num: 4, label: 'Pec deck', x: 10, y: 6, w: 4, h: 3, settingsFields: [] },
);
store.saveLayout(visitGym);
store.saveWorkouts([]);
const realNow = Date.now;
const t0 = 1760000000000;
let clock = t0;
Date.now = () => clock;
try {
  startWorkoutFrom({ entries: [entry('va'), entry('vb'), entry('vc'), entry('vd')] });
  const visitId = store.getActive().id;
  assert.deepEqual(store.getActive().visits, [{ machineId: 'va', in: t0 }],
    'the first visit opens with the workout');
  renderTrain(root);
  byId.get('#set-weight').value = '40';
  byId.get('#set-reps').value = '8';
  byId.get('#set-rest').value = '0';
  clock = t0 + 60000;
  byId.get('#log-set').listeners.click();
  clock = t0 + 90000;
  byId.get('#next-machine').listeners.click(); // → #2, the plan's next
  // #3 is next now; the "Busy?" button offers #4, which stands closer
  assert.ok(root.innerHTML.includes('Busy? #4'), 'the busy escape hatch is on offer');
  clock = t0 + 120000;
  byId.get('#nearby-machine').listeners.click();
  clock = t0 + 180000;
  byId.get('#log-set').listeners.click();
  clock = t0 + 200000;
  byId.get('#log-finish').listeners.click();
  byId.get('#log-finish').listeners.click();
  assert.deepEqual(store.getWorkouts().find((w) => w.id === visitId).visits, [
    { machineId: 'va', in: t0, out: t0 + 90000 },
    { machineId: 'vb', in: t0 + 90000, out: t0 + 120000 },
    { machineId: 'vd', in: t0 + 120000, out: t0 + 200000, busy: 'vc' },
  ], 'every switch closes one visit and opens the next; "Busy?" names the skipped machine');
} finally {
  Date.now = realNow;
}
store.saveWorkouts([]);

// a slot skipped via "Busy?" stays open and comes back as Next at the end
{
  store.saveLayout(visitGym);
  startWorkoutFrom({ entries: [entry('va'), entry('vb'), entry('vc'), entry('vd')] });
  byId.clear();
  renderTrain(root);
  const logOne = () => {
    byId.get('#set-weight').value = '40';
    byId.get('#set-reps').value = '8';
    byId.get('#set-rest').value = '0';
    byId.get('#log-set').listeners.click();
  };
  // three sets meet a machine's set goal (the app default), so every stop
  // the walk leaves is done — one set would leave it open behind us
  const logGoal = () => { for (let k = 0; k < 3; k++) logOne(); };
  logGoal();
  byId.get('#next-machine').listeners.click(); // → #2
  logGoal();
  assert.ok(root.innerHTML.includes('Busy? #4'), '#3 is next, #4 is the escape hatch');
  byId.get('#nearby-machine').listeners.click(); // #3 busy → #4
  assert.equal(store.getActive().chosenSlot, 3, '"Busy?" hands on the plan index of the block it named');
  logGoal();
  assert.ok(/Next: #3\s+Leg press/.test(root.innerHTML), 'the skipped #3 is the last open stop: Next');
  store.clearActive();
  store.saveWorkouts([]);
}


// --- hints where the user acts: the log screen, the plan row, the builder ---
// stats.js insights are not a card any more. Three "Pull day" workouts a
// week apart, each walking #1 → #2 → #3 → back to #1 with #1 marked busy
// from #2 at 18:00: curls 14 × 30 twice (progress: the curls log screen,
// and ONLY that exercise), #1 busy on this weekday (busy: the #1 log
// screen, on that weekday only), and the walk back (route: the plan row
// says "reorder?"; the builder's line is pinned in plan.test.mjs).
// The clock is pinned (Monday 2026-10-12, 18:30 local): the busy hint
// depends on the weekday AND the hour, and a run across midnight or in the
// small hours must not decide the outcome.
const hintsRealNow = Date.now;
let hintsNow = new Date(2026, 9, 12, 18, 30).getTime();
Date.now = () => hintsNow;
try {
  const before = store.getLayout(); // earlier blocks reshaped the gym
  const g3 = store.newLayout('Hints gym');
  g3.machines.push({ id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [] });
  g3.machines.push({
    id: 'db', num: 2, label: 'Dumbbells', x: 6, y: 0, w: 4, h: 3, settingsFields: [],
    exercises: ['Biceps curls', 'Shoulder press'],
  });
  g3.machines.push({ id: 'm3', num: 3, label: 'Row', x: 12, y: 0, w: 4, h: 3, settingsFields: [] });
  store.saveLayout(g3);
  const atDay = (back, h, m = 0) => {
    const d = new Date(Date.now());
    d.setDate(d.getDate() - back);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const pull = (id, back, shift = 0) => {
    const t = atDay(back, 18) + shift;
    return {
      id, startedAt: t, finishedAt: t + 1800e3, name: 'Pull day',
      entries: [
        { machineId: 'm1', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 40 }] },
        { machineId: 'db', num: 2, label: 'Dumbbells', exercise: 'Biceps curls', settings: {}, sets: [{ reps: 14, weight: 30 }] },
        { machineId: 'm3', num: 3, label: 'Row', settings: {}, sets: [{ reps: 10, weight: 40 }] },
      ],
      visits: [
        { machineId: 'm1', in: t, out: t + 500e3 },
        { machineId: 'db', in: t + 500e3, out: t + 1000e3, busy: 'm1' },
        { machineId: 'm3', in: t + 1000e3, out: t + 1400e3 },
        { machineId: 'm1', in: t + 1400e3, out: t + 1800e3 },
      ],
    };
  };
  store.saveWorkouts([pull('h1', 21), pull('h2', 14), pull('h3', 7)]);
  store.savePlan({ id: 'pull', name: 'Pull day', items: [{ machineId: 'm1', exercise: null }, { machineId: 'db', exercise: 'Biceps curls' }] });
  store.savePlan({ id: 'push', name: 'Push day', items: [{ machineId: 'm1', exercise: null }] });
  const logAt = (machineId, exercise) => {
    byId.clear();
    store.saveActive({
      v: 2, id: 'w-hint', startedAt: Date.now() - 60000,
      plan: [{ machineId, exercise }], currentMachineId: machineId, currentExercise: exercise, entries: [],
    });
    renderTrain(root);
    return root.innerHTML;
  };
  const curls = logAt('db', 'Biceps curls');
  assert.ok(curls.includes('<p class="hint head-hint"><span>Target beaten twice — try 32.5 kg.</span><a href="https://doi.org/10.1249/MSS.0b013e3181915670" target="_blank" rel="noopener"'),
    'the progress hint with its ↗, on the exercise it is about');
  assert.ok(curls.indexOf('</div>\n    <p class="hint head-hint">') > 0
    && curls.indexOf('machine-head') < curls.indexOf('head-hint'), 'full width right below the machine head');
  assert.ok(!curls.includes('Usually busy'), '#1\'s busy hint is not on the curls screen');
  assert.ok(!logAt('db', 'Shoulder press').includes('Target beaten'),
    'the same machine, another exercise: no hint — it would name the wrong load');
  assert.ok(logAt('m1', null).includes('<p class="hint head-hint"><span>Usually busy Mondays 18–19 h — start elsewhere.</span></p>'),
    'the busy hint on its weekday, from your own marks: no link');
  // …and only around the window it names: an hour either side
  const busyAt = (h, m) => {
    hintsNow = new Date(2026, 9, 12, h, m).getTime();
    return logAt('m1', null).includes('Usually busy');
  };
  assert.deepEqual([busyAt(9, 0), busyAt(16, 59), busyAt(17, 0), busyAt(19, 59), busyAt(20, 0)],
    [false, false, true, true, false], 'Monday morning hears nothing of the Monday-evening crowd');
  hintsNow = new Date(2026, 9, 12, 18, 30).getTime();
  assert.ok(!logAt('m1', null).includes('Target beaten'), 'no progress at #1: 10 × 40 is under target');
  store.saveWorkouts([pull('h1', 22), pull('h2', 15), pull('h3', 8)]); // another weekday
  assert.ok(!logAt('m1', null).includes('Usually busy'), 'not today: the busy hint waits for its weekday');
  // a late crowd (Mondays 23–24 h) still counts just after midnight on Tuesday
  store.saveWorkouts([pull('h1', 21, 5 * 3600e3), pull('h2', 14, 5 * 3600e3), pull('h3', 7, 5 * 3600e3)]);
  const lateAt = (d, h, m) => {
    hintsNow = new Date(2026, 9, d, h, m).getTime();
    return logAt('m1', null).includes('Usually busy');
  };
  assert.deepEqual([lateAt(12, 21, 59), lateAt(12, 22, 0), lateAt(13, 0, 30), lateAt(13, 1, 0)],
    [false, true, true, false], 'the window reaches across midnight into the next weekday');
  hintsNow = new Date(2026, 9, 12, 18, 30).getTime();
  store.saveWorkouts([pull('h1', 21), pull('h2', 14), pull('h3', 7)]);
  store.clearActive();

  byId.clear();
  goToStart();
  renderTrain(root);
  // the row's muted line: everything up to the first closing span
  const row = (name) => root.innerHTML.slice(root.innerHTML.indexOf(`<strong>${name}`)).split('</span>')[0];
  assert.ok(row('Pull day').endsWith(' · reorder?'), 'the plan whose workouts walk back says so on its row');
  assert.ok(!row('Push day').includes('reorder'), 'the other plan does not');
  // the builder's own line lives in plan.test.mjs (its stub draws the map)
  store.savePlans([]);
  store.saveWorkouts([]);
  store.saveLayout(before);
} finally {
  Date.now = hintsRealNow;
}

// --- the plan list asks the hint rules only when some plan has a NAME ---
// planListCard's guard: "reorder?" can only name a named plan, so with none
// the rules (4 ms at 435 workouts) must not run at all. insights() keeps ONE
// memo entry, so a probe asked before the render comes back as the same
// object only if nothing asked the rules anything else in between.
{
  const before = store.getLayout();
  const { insights } = await import(new URL('../js/stats.js', import.meta.url).href);
  const g = store.newLayout('Guard gym');
  g.machines.push({ id: 'n1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [] });
  store.saveLayout(g);
  store.saveWorkouts([1, 2, 3].map((k) => ({ id: `ng${k}`, startedAt: k * 864e5, finishedAt: k * 864e5 + 1800e3,
    entries: [{ machineId: 'n1', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 40 }] }] })));
  const item = { machineId: 'n1', exercise: null };
  const probe = () => insights(store.getWorkouts(), store.getLayout(), store.getSettings(), { plans: [], now: 0 });
  const listAsks = (plans) => {
    store.savePlans(plans);
    const asked = probe();
    goToPlans();
    byId.clear();
    renderTrain(root);
    assert.ok(root.innerHTML.includes('Planned workouts'), 'the plans screen shows its list');
    return probe() !== asked;
  };
  assert.equal(listAsks([{ id: 'nameless', name: '', items: [item] }]), false,
    'no named plan: the list never runs the rules');
  assert.equal(listAsks([{ id: 'named', name: 'Push day', items: [item] }]), true,
    'a named plan does (the probe can see it)');
  goToHub();
  store.savePlans([]);
  store.saveWorkouts([]);
  store.saveLayout(before);
}

// --- the log screen reads what its fields SHOW (fieldValue) ---
// iOS lets the Log set tap land before the blur that restores a field the
// overwrite arming emptied on focus: '' + dataset.prevValue must log the
// value it showed, never 0 kg × 1 with no rest.
{
  const before = store.getLayout();
  const g = store.newLayout('Read gym');
  g.machines.push({ id: 'r1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [] });
  store.saveLayout(g);
  store.saveActive({
    v: 2, id: 'w-read', startedAt: Date.now() - 60000,
    plan: [{ machineId: 'r1', exercise: null }],
    currentMachineId: 'r1', currentExercise: null, entries: [],
  });
  byId.clear();
  renderTrain(root);
  for (const [id, v] of [['#set-weight', '50'], ['#set-reps', '10'], ['#set-rest', '90']]) {
    const el = byId.get(id);
    el.value = '';
    el.dataset = { prevValue: v };
  }
  byId.get('#log-set').listeners.click();
  let a = store.getActive();
  assert.deepEqual(a.entries[0].sets.map(({ reps, weight }) => ({ reps, weight })), [{ reps: 10, weight: 50 }],
    'an armed-empty field logs the value it showed before focus');
  assert.ok(restLeft(a) > 80, 'and its rest still starts');
  delete a.restUntil;
  store.saveActive(a);

  // the weight is a decimal TEXT field: a comma is a decimal mark, not a typo
  byId.clear();
  renderTrain(root);
  assert.ok(/id="set-weight" type="text" inputmode="decimal"/.test(root.innerHTML),
    'the weight is typed on the decimal pad as text, like the distance');
  byId.get('#set-weight').value = '12,5';
  byId.get('#set-reps').value = '8';
  byId.get('#set-rest').value = '0';
  byId.get('#set-weight').listeners.input();
  assert.equal(byId.get('#log-set').textContent, '✓ Log set 2/3 — 12.5 kg × 8',
    'the button follows the field while it is typed, not only on change');
  assert.equal(byId.get('#set-weight').value, '12,5', 'and input never rewrites a field mid-word');
  byId.get('#set-reps').value = '0';
  byId.get('#set-reps').listeners.change();
  assert.equal(byId.get('#set-reps').value, 1, 'a change writes back what will be logged');
  byId.get('#log-set').listeners.click();
  a = store.getActive();
  assert.equal(a.entries[0].sets.at(-1).weight, 12.5, '"12,5" logs 12.5');
  byId.get('#set-weight').value = '0';
  byId.get('#set-reps').value = '8';
  byId.get('#set-rest').value = '0';
  byId.get('#log-set').listeners.click();
  assert.equal(store.getActive().entries[0].sets.at(-1).weight, 0, 'a typed 0 kg is a weight, not a refusal');
  byId.get('#set-rest').value = 'x';
  byId.get('#log-set').listeners.click();
  assert.ok(restLeft(store.getActive()) > 80, 'an unreadable rest falls back to the machine rest, never 0');
  store.clearActive();
  store.saveLayout(before);
}

// a stored set may lack its weight: the prefill is a full copy, never undefined
assert.deepEqual(nextSetDefaults({ sets: [{ reps: 8 }] }, null, 'strength', { unit: 'kg' }), { reps: 8, weight: 0 },
  'a weightless set prefills 0, not undefined');
assert.deepEqual(nextSetDefaults({ sets: [] }, { sets: [{ reps: 6, at: 1 }] }, 'strength', { unit: 'kg' }),
  { reps: 6, weight: 0 }, 'the last workout\'s weightless first set too');

// --- the rest deadline has one source: the store (saveLog) ---
// endRest/adjustRest change the STORE's copy; a log screen saving its own
// render-time `active` used to write the old deadline back.
{
  const before = store.getLayout();
  const g = store.newLayout('Deadline gym');
  g.machines.push({ id: 'a', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [] });
  g.machines.push({ id: 'b', num: 2, label: 'Row', x: 6, y: 0, w: 4, h: 3, settingsFields: [] });
  store.saveLayout(g);
  store.saveActive({
    v: 2, id: 'w-deadline', startedAt: Date.now() - 60000,
    plan: [{ machineId: 'a', exercise: null }, { machineId: 'b', exercise: null }],
    currentMachineId: 'a', currentExercise: null, entries: [],
  });
  byId.clear();
  renderTrain(root);
  byId.get('#set-weight').value = '40';
  byId.get('#set-reps').value = '8';
  byId.get('#set-rest').value = '90';
  byId.get('#log-set').listeners.click();
  assert.ok(restLeft(store.getActive()) > 80, 'the set starts a rest');
  const staleNext = byId.get('#next-machine').listeners.click; // the screen under the overlay
  renderTrain(root);
  byId.get('#rest-skip').listeners.click(); // the overlay's Skip = endRest on the store copy
  staleNext();
  assert.ok(!('restUntil' in store.getActive()), 'a later save of the old screen keeps the rest skipped');
  assert.ok(!root.innerHTML.includes('id="rest-inline"'), 'and no countdown comes back on the next screen');

  // +15s on the store copy survives any later save of the same screen
  const now = Date.now();
  store.saveActive({ ...store.getActive(), currentMachineId: 'a', restUntil: now + 60000 });
  byId.clear();
  renderTrain(root);
  byId.get('#rest-plus').listeners.click();
  byId.get('#set-rest').listeners.change({ target: { value: '90', dataset: {} } });
  assert.ok(restLeft(store.getActive()) > 70, 'a rest-field change no longer undoes +15s');

  // a set logged with rest 0 ends a rest that is still running
  byId.get('#set-weight').value = '40';
  byId.get('#set-reps').value = '8';
  byId.get('#set-rest').value = '0';
  byId.get('#log-set').listeners.click();
  assert.equal(restLeft(store.getActive()), 0, 'a rest-0 set ends the running rest');
  store.clearActive();
  store.saveLayout(before);
}

// --- the Log set write path ---
{
  const before = store.getLayout();
  const g = store.newLayout('Write gym');
  g.machines.push({ id: 'a', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: ['Seat'] });
  g.machines.push({
    id: 'db', num: 2, label: 'Dumbbells', x: 6, y: 0, w: 4, h: 3, settingsFields: [],
    exercises: ['Biceps curls', 'Shoulder press'],
  });
  store.saveLayout(g);
  store.saveActive({
    v: 2, id: 'w-write', startedAt: Date.now() - 60000,
    plan: [{ machineId: 'a', exercise: null }], currentMachineId: 'a', currentExercise: null, entries: [],
  });
  byId.clear();
  renderTrain(root);
  byId.get('#set-weight').value = '40';
  byId.get('#set-reps').value = '8';
  byId.get('#set-rest').value = '0';
  // a refused write leaves no set behind in memory for the next tap to stack on
  const log = byId.get('#log-set').listeners.click;
  failWritesAfter(0);
  assert.throws(log, /QuotaExceeded/, 'the refused write still announces itself');
  failWritesAfter();
  log();
  assert.equal(store.getActive().entries[0].sets.length, 1, 'one tap after a refusal is one set, not two');

  // a settings / locker field still focused when Log set is tapped (Firefox:
  // no change event, the re-render detaches it) is taken over anyway
  byId.clear();
  renderTrain(root);
  const seat = { dataset: { field: 'Seat' }, value: ' 4 ', addEventListener() {} };
  const qsa = root.querySelectorAll;
  root.querySelectorAll = (sel) => (sel === '.m-setting' ? [seat] : []);
  byId.get('#locker-num').value = '117';
  byId.get('#set-weight').value = '40';
  byId.get('#set-reps').value = '8';
  byId.get('#set-rest').value = '0';
  byId.get('#log-set').listeners.click();
  root.querySelectorAll = qsa;
  const w = store.getActive();
  assert.equal(w.entries[0].settings.Seat, '4', 'the typed setting is saved with the set');
  assert.equal(w.locker, '117', 'and so is the typed locker');

  // the exercise chip renders through renderTrain: its screen key is fresh,
  // so a later same-screen render (the overlay's RIR) keeps the scroll
  store.saveActive({
    v: 2, id: 'w-chip', startedAt: Date.now(),
    plan: [{ machineId: 'db', exercise: null }], currentMachineId: 'db', currentExercise: null, entries: [],
  });
  byId.clear();
  renderTrain(root);
  byId.get('#exercise-chips').listeners.click({ target: { closest: () => ({ dataset: { exercise: 'Biceps curls' } }) } });
  root.scrollTop = 400;
  byId.get('#set-weight').value = '10';
  byId.get('#set-reps').value = '8';
  byId.get('#set-rest').value = '0';
  byId.get('#log-set').listeners.click();
  renderTrain(root);
  assert.equal(root.scrollTop, 400, 'picking an exercise does not leave a stale screen key behind');
  root.scrollTop = 0;
  store.clearActive();
  store.saveLayout(before);
}

// A #picker whose inner parts are reachable: machinePicker wires .pick-num /
// .pick-go / .pick-err inside its container, which the plain stub hands
// out fresh (and so unreachable) on every call.
const pickerStub = () => {
  const parts = new Map();
  const el = stubEl();
  el.querySelector = (sel) => {
    if (!parts.has(sel)) parts.set(sel, stubEl());
    const part = parts.get(sel);
    if (sel === '.pick-err') part.querySelector = (q) => el.querySelector(`.pick-err ${q}`);
    return part;
  };
  el.parts = parts;
  return el;
};
const withPicker = (fn) => {
  const picker = pickerStub();
  const qs = root.querySelector;
  root.querySelector = (sel) => (sel === '#picker' ? picker : qs.call(root, sel));
  try { fn(picker); } finally { root.querySelector = qs; }
  return picker;
};

// --- slots & Next ---
{
  const before = store.getLayout();
  const g = store.newLayout('Slot gym');
  g.machines.push(
    { id: 'a', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [] },
    { id: 'b', num: 2, label: 'Lat pulldown', x: 6, y: 0, w: 4, h: 3, settingsFields: [] },
    { id: 'c', num: 3, label: 'Leg press', x: 12, y: 0, w: 4, h: 3, settingsFields: [] },
    { id: 'db', num: 4, label: 'Dumbbells', x: 18, y: 0, w: 4, h: 3, settingsFields: [],
      exercises: ['Biceps curls', 'Shoulder press'] });
  store.saveLayout(g);
  const set = () => ({ reps: 10, weight: 40, at: Date.now() });
  // a machine deleted in the gym leaves its slot dead: Next skips it, the
  // tally stops counting it, and the plan keeps it for an undo
  store.saveActive({
    v: 2, id: 'w-dead', startedAt: Date.now() - 60000,
    plan: [{ machineId: 'a', exercise: null },
      { machineId: 'b', exercise: null, target: { sets: 3, reps: 10, weight: 40 } },
      { machineId: 'c', exercise: null, target: { sets: 1, reps: 10, weight: 40 } }],
    currentMachineId: 'a', currentExercise: null,
    entries: [{ machineId: 'a', num: 1, label: 'Chest press', settings: {}, sets: [set()] }],
  });
  store.saveLayout({ ...g, machines: g.machines.filter((m) => m.id !== 'b') });
  byId.clear();
  renderTrain(root);
  assert.ok(/id="next-machine"[^>]*>Next: #3/.test(root.innerHTML), 'Next skips the deleted machine\'s slot');
  assert.ok(store.getActive().plan.some((p) => p.machineId === 'b'), 'and the plan still holds it');
  const a = store.getActive();
  store.switchMachine(a, null);
  store.saveActive(a);
  byId.clear();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('1/4 target sets'),
    'the tally counts only live slots — a\'s goal of 3 (one in) plus c\'s target of 1, never the deleted b\'s');
  store.saveLayout(g);

  // the next stop is the SAME machine: no "Busy?" — it would record busy: <here>
  store.saveActive({
    v: 2, id: 'w-same', startedAt: Date.now(),
    plan: [{ machineId: 'db', exercise: 'Biceps curls' }, { machineId: 'db', exercise: 'Shoulder press' },
      { machineId: 'c', exercise: null }],
    currentMachineId: 'db', currentExercise: 'Biceps curls',
    entries: [{ machineId: 'db', num: 4, label: 'Dumbbells', exercise: 'Biceps curls', settings: {}, sets: [set()] }],
  });
  byId.clear();
  renderTrain(root);
  assert.ok(/Next: #4\s+Dumbbells · Shoulder press/.test(root.innerHTML), 'next is the sibling exercise');
  assert.ok(!root.innerHTML.includes('id="nearby-machine"'), 'and no Busy? is offered for it');

  // Add on the overview lands on the machine's first OPEN exercise slot
  // (Shoulder press has met its goal of three)
  store.saveActive({
    v: 2, id: 'w-add', startedAt: Date.now(),
    plan: [{ machineId: 'db', exercise: 'Shoulder press' }, { machineId: 'db', exercise: 'Biceps curls' },
      { machineId: 'a', exercise: null }],
    currentMachineId: null, currentExercise: null,
    entries: [{ machineId: 'db', num: 4, label: 'Dumbbells', exercise: 'Shoulder press', settings: {},
      sets: [set(), set(), set()] }],
  });
  byId.clear();
  withPicker((picker) => {
    renderTrain(root);
    picker.parts.get('.pick-num').value = '4';
    picker.parts.get('.pick-go').listeners.click();
  });
  assert.equal(store.getActive().currentExercise, 'Biceps curls', 'Add opens the open exercise, not the pick screen');
  store.clearActive();
  store.saveLayout(before);
}

// --- 🎲 Surprise me: weighted toward muscles still open, nearness tips equals ---
{
  const before = store.getLayout();
  const g = store.newLayout('Dice gym');
  const mm = (id, num, x, muscles) => ({ id, num, label: `M${num}`, x, y: 0, w: 4, h: 3, settingsFields: [], muscles });
  g.machines.push(mm('d1', 1, 0, ['Chest']), mm('d2', 2, 6, ['Quads']), mm('d3', 3, 50, ['Triceps', 'Chest']),
    mm('d4', 4, 10, ['Chest']));
  store.saveLayout(g);
  // the overview's real state: no current machine, the last visit says where you stand
  const done = { entries: [{ machineId: 'd4', sets: [{ reps: 10, weight: 40 }] }], currentMachineId: null,
    visits: [{ machineId: 'd4', in: 0, out: 1 }] };
  // a sweep of evenly spaced draws stands in for many taps
  const tally = (active) => {
    const n = {};
    for (let i = 0; i < 1000; i++) {
      const m = surpriseMachine(g, active, { rand: () => (i + 0.5) / 1000 });
      n[m.num] = (n[m.num] ?? 0) + 1;
    }
    return n;
  };
  const t = tally(done);
  assert.equal(t[1] ?? 0, 0, 'a machine whose muscles are all trained today is never suggested while others are open');
  assert.equal(t[4] ?? 0, 0, 'nor the machine just trained');
  assert.ok(t[2] > t[3], `equal open muscles (Quads vs Triceps): the nearer #2 is likelier — ${JSON.stringify(t)}`);
  assert.ok(t[3] > 0, 'the far one still comes up: it is a draw, not a ranking');
  // two open muscles outweigh one, whatever the distance
  const all = tally({ entries: [], currentMachineId: 'd2' });
  assert.ok(all[3] > all[2] && all[3] > all[1], `#3 trains two open muscles: ${JSON.stringify(all)}`);
  // everything trained: a plain random pick among the machines not trained today
  const trainedAll = { entries: ['d1', 'd2', 'd3'].map((machineId) => ({ machineId, sets: [{ reps: 1, weight: 1 }] })) };
  assert.deepEqual(tally(trainedAll), { 4: 1000 }, 'all muscles trained: the one machine left');
  const none = tally(null);
  assert.ok(Object.keys(none).length === 4, `no workout yet: every machine can come up — ${JSON.stringify(none)}`);
  // "open today" counts this morning's finished workout too
  const earlier = surpriseMachine(g, null, { rand: () => 0, earlier: done.entries });
  assert.equal(earlier.num, 2, 'Chest trained earlier today: #1 is not suggested, #2 (Quads) is');
  // a muscle that is only SECONDARY narrows the draw to its machines too
  const sec = { ...g, machines: [...g.machines, { ...mm('d5', 5, 30, ['Quads']), secondaryMuscles: ['Forearms'] }] };
  assert.ok([0, 0.5, 0.99].every((r) => surpriseMachine(sec, done, { rand: () => r, muscle: 'Forearms' }).num === 5),
    'a Forearms filter: the one machine that works them as a secondary muscle');
  // the picker's muscle filter narrows the draw while it has something left
  assert.ok([0, 0.5, 0.99].every((r) => surpriseMachine(g, done, { rand: () => r, muscle: 'Triceps' }).num === 3),
    'a Triceps filter: the Triceps machine');
  // a template machine without a position must not poison the weights
  const loose = { ...g, machines: [...g.machines, { id: 'd5', num: 5, label: 'M5', settingsFields: [], muscles: ['Lats'] }] };
  assert.ok([0, 0.3, 0.7, 0.999].every((r) => surpriseMachine(loose, done, { rand: () => r })),
    'a machine with no geometry still leaves a draw that returns a machine');
  // the overview's picker hands its workout to the draw
  store.saveActive({ v: 2, id: 'w-dice', startedAt: Date.now(), plan: [{ machineId: 'd4', exercise: null }],
    currentMachineId: null, currentExercise: null, visits: done.visits,
    entries: [{ machineId: 'd4', num: 4, label: 'M4', settings: {}, sets: [{ reps: 10, weight: 40 }] }] });
  byId.clear();
  {
    const surprise = stubEl();
    withPicker((picker) => {
      const mode = picker.querySelector('.pick-mode');
      const qs = mode.querySelector;
      mode.querySelector = (sel) => (sel === '.pick-surprise' ? surprise : qs.call(mode, sel));
      renderTrain(root);
      const realRand = Math.random;
      Math.random = () => 0;
      try { surprise.listeners.click(); } finally { Math.random = realRand; }
      assert.equal(picker.parts.get('.pick-num').value, '2', 'mid-workout the Chest machines are out: #2 (Quads)');
    });
    assert.equal(store.getActive().currentMachineId, null, 'and the workout did not move to it');
  }
  // the chip only suggests: it fills the number and says why, it never starts
  store.clearActive();
  goToStart();
  byId.clear();
  let picked = 0;
  const surprise = stubEl();
  withPicker((picker) => {
    const mode = picker.querySelector('.pick-mode');
    const qs = mode.querySelector;
    mode.querySelector = (sel) => (sel === '.pick-surprise' ? surprise : qs.call(mode, sel));
    renderTrain(root);
    const realRand = Math.random;
    Math.random = () => 0;
    try { surprise.listeners.click(); } finally { Math.random = realRand; }
    assert.equal(picker.parts.get('.pick-num').value, '1', 'the draw fills the number field (#1 trains Chest, open)');
    assert.ok(picker.parts.get('.pick-err').textContent.startsWith('🎲 #1 M1 — Chest still open today.'),
      'and the line says what it trains that is still open');
    // a workout finished earlier today counts: Chest is done, so is #1
    store.saveWorkouts([{ id: 'am', startedAt: Date.now() - 60000, finishedAt: Date.now(),
      entries: [{ machineId: 'd4', num: 4, label: 'M4', settings: {}, sets: [{ reps: 10, weight: 40 }] }] }]);
    Math.random = () => 0;
    try { surprise.listeners.click(); } finally { Math.random = realRand; }
    assert.equal(picker.parts.get('.pick-num').value, '2', 'this morning\'s Chest session counts as trained today');
    store.saveWorkouts([]);
    picked = store.getActive() ? 1 : 0;
  });
  assert.equal(picked, 0, 'no workout was started — a suggestion, never a decision');
  goToHub();
  store.saveLayout(before);
}

// --- 🎲: an untagged machine is an unknown, and a typed number ends the suggestion ---
{
  const before = store.getLayout();
  const g = store.newLayout('Dice tag gym');
  const mm = (id, num, x, muscles) => ({ id, num, label: `M${num}`, x, y: 0, w: 4, h: 3, settingsFields: [],
    ...(muscles ? { muscles } : {}) });
  g.machines.push(mm('u1', 1, 0), mm('c1', 2, 6, ['Chest']), mm('c2', 3, 12, ['Quads', 'Glutes']), mm('c3', 4, 18, ['Chest']));
  store.saveLayout(g);
  const chestDone = { entries: [{ machineId: 'c3', sets: [{ reps: 10, weight: 40 }] }], currentMachineId: 'c3' };
  const n = {};
  for (let i = 0; i < 1000; i++) {
    const m = surpriseMachine(g, chestDone, { rand: () => (i + 0.5) / 1000 });
    n[m.num] = (n[m.num] ?? 0) + 1;
  }
  assert.ok(n[1] > 0, `the untagged #1 still comes up while tagged muscles are open — ${JSON.stringify(n)}`);
  assert.equal(n[2] ?? 0, 0, 'a tagged machine whose muscles are trained is still out');
  assert.ok(n[3] > n[1], `two open muscles outweigh the unknown — ${JSON.stringify(n)}`);

  // the suggestion lights the machine on the map; another number typed puts it out
  goToStart();
  byId.clear();
  withPicker((picker) => {
    const surprise = stubEl();
    const mode = picker.querySelector('.pick-mode');
    const qs = mode.querySelector;
    mode.querySelector = (sel) => (sel === '.pick-surprise' ? surprise : qs.call(mode, sel));
    const svg = picker.querySelector('svg');
    svg.childElementCount = 1; // the map is drawn
    svg.setAttribute = () => {};
    renderTrain(root);
    const realRand = Math.random;
    Math.random = () => 0.999;
    try { surprise.listeners.click(); } finally { Math.random = realRand; }
    const num = picker.parts.get('.pick-num');
    const err = picker.parts.get('.pick-err');
    assert.ok(svg.innerHTML.includes(`class="machine locate" data-id="${g.machines.find((m) => String(m.num) === num.value).id}"`),
      'the 🎲 pick is highlighted on the map');
    num.listeners.input?.();
    assert.ok(svg.innerHTML.includes('machine locate'), 'its own number in the field keeps it');
    num.value = '7';
    num.listeners.input?.();
    assert.ok(!svg.innerHTML.includes('machine locate'), 'another number typed: the highlight is gone');
    assert.ok(!err.textContent.startsWith('🎲'), 'and so is the 🎲 line naming the machine no longer meant');
  });
  goToHub();
  store.saveLayout(before);
}

// --- machines created or bound in a TAP read the layout in that tap ---
{
  const before = store.getLayout();
  const fresh = () => {
    const g = store.newLayout('Tap gym');
    g.machines.push({ id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles: [] });
    store.saveLayout(g);
    store.saveTombstones({ machines: [] });
  };
  // a pull lands under the rendered screen (restoreLayout re-renders nothing)
  const pull = () => {
    const remote = store.getLayout();
    remote.machines.push({ id: 'm9', num: 9, label: 'Rower', x: 10, y: 0, w: 4, h: 3,
      settingsFields: [], muscles: [], updatedAt: Date.now() - 1000 });
    store.restoreLayout(remote);
  };
  const alive = () => store.getLayout().machines.some((m) => m.id === 'm9')
    && !store.getTombstones().machines.some((t) => t.id === 'm9');

  // the picker's create-on-miss
  fresh();
  store.saveActive({
    v: 2, id: 'w-tap', startedAt: Date.now(), plan: [{ machineId: 'm1', exercise: null }],
    currentMachineId: null, currentExercise: null, entries: [],
  });
  byId.clear();
  withPicker((picker) => {
    renderTrain(root);
    pull();
    picker.parts.get('.pick-num').value = '22';
    picker.parts.get('.pick-go').listeners.click();
    picker.parts.get('.pick-err .pick-create').listeners.click();
  });
  assert.ok(alive(), 'creating #22 keeps the machine that synced in under the overview');
  assert.ok(store.getLayout().machines.some((m) => m.num === 22), 'and #22 exists');
  // …and a number that synced in IS that machine, never a second one
  const back = store.getActive();
  store.switchMachine(back, null);
  store.saveActive(back);
  byId.clear();
  withPicker((picker) => {
    renderTrain(root);
    store.restoreLayout({ ...store.getLayout(), machines: [...store.getLayout().machines,
      { id: 'm7', num: 7, label: 'Leg curl', x: 20, y: 0, w: 4, h: 3, settingsFields: [], muscles: [] }] });
    picker.parts.get('.pick-num').value = '7';
    picker.parts.get('.pick-go').listeners.click();
  });
  assert.equal(store.getLayout().machines.filter((m) => m.num === 7).length, 1, 'no second #7');

  // the bind screen's "That's it"
  fresh();
  store.saveActive({
    v: 2, id: 'w-bind', startedAt: Date.now(), plan: [{ machineId: null, name: 'Leg press', exercise: null }],
    binding: 0, currentMachineId: null, currentExercise: null, entries: [],
  });
  byId.clear();
  renderTrain(root);
  pull();
  root.querySelector('#bind-num').value = '14';
  byId.get('#bind-go').listeners.click();
  assert.ok(alive(), 'binding to a new #14 keeps the machine that synced in under the bind screen');

  // a cardio target bound to a strength machine is dropped OUT LOUD
  fresh();
  store.saveActive({
    v: 2, id: 'w-cardio', startedAt: Date.now(),
    plan: [{ machineId: null, name: 'Bike', exercise: null, target: { distance: 0, seconds: 1200 } }],
    binding: 0, currentMachineId: null, currentExercise: null, entries: [],
  });
  byId.clear();
  renderTrain(root);
  root.querySelector('#bind-num').value = '1';
  byId.get('#bind-go').listeners.click();
  assert.ok(!('target' in store.getActive().plan[0]), 'the cardio target cannot stay on a strength machine');
  assert.ok(root.innerHTML.includes('Target dropped — #1 is not a cardio machine.'), 'and the screen says so');

  // a "Looks like" / "Or pick from your gym" chip binds by its machine id —
  // the plain stub's querySelectorAll hands out none, so this one does
  fresh();
  store.saveActive({
    v: 2, id: 'w-pick', startedAt: Date.now(), plan: [{ machineId: null, name: 'Chest', exercise: null }],
    binding: 0, currentMachineId: null, currentExercise: null, entries: [],
  });
  const pickChip = stubEl();
  const qsa = root.querySelectorAll;
  root.querySelectorAll = (sel) => (sel === '.bind-pick' ? [pickChip] : []);
  try {
    byId.clear();
    renderTrain(root);
  } finally { root.querySelectorAll = qsa; }
  assert.ok(root.innerHTML.includes('class="chip bind-pick"\n    data-id="m1">#1 Chest press'), 'the likely machine is offered as a chip');
  pickChip.dataset.id = 'nope';
  pickChip.listeners.click();
  assert.equal(store.getActive().plan[0].machineId, null, 'a chip naming no machine binds nothing');
  pickChip.dataset.id = 'm1';
  pickChip.listeners.click();
  assert.equal(store.getActive().plan[0].machineId, 'm1', 'the tapped chip binds the slot to its machine');
  assert.equal(store.getActive().currentMachineId, 'm1', 'and the log screen opens there');

  // two lines with one name write back into THEIR OWN item
  fresh();
  store.clearActive();
  const two = plantext.planFromText('Leg press 3x10 80\nLeg press 3x12 50');
  store.savePlan(two);
  startWorkoutFrom({ planId: two.id, entries: two.items });
  for (const [i, num] of [[1, '15'], [0, '14']]) {
    const a = store.getActive();
    a.binding = i;
    store.saveActive(a);
    byId.clear();
    renderTrain(root);
    root.querySelector('#bind-num').value = num;
    byId.get('#bind-go').listeners.click();
  }
  const numOf = (id) => store.getLayout().machines.find((m) => m.id === id).num;
  assert.deepEqual(store.getPlans().find((p) => p.id === two.id).items.map((it) => [numOf(it.machineId), it.target.reps]),
    [[14, 10], [15, 12]], 'each line keeps its own target on its own machine');

  // two lines on ONE number are two exercises there — now and next time
  for (const note of ['#14 Leg press 3x10 80\n#14 Calf raise 3x15 60',
    '#2 Dumbbells: Biceps curls 3x10 12\n#2 Dumbbells: Shoulder press 3x8 14']) {
    fresh();
    store.clearActive();
    const p = plantext.planFromText(note);
    store.savePlan(p);
    startWorkoutFrom({ planId: p.id, entries: p.items });
    const num = note.slice(1, note.indexOf(' '));
    for (const i of [0, 1]) {
      const a = store.getActive();
      a.binding = i;
      store.saveActive(a);
      byId.clear();
      renderTrain(root);
      root.querySelector('#bind-num').value = num;
      byId.get('#bind-go').listeners.click();
    }
    const slots = store.getActive().plan;
    assert.equal(new Set(slots.map((sl) => `${sl.machineId}|${sl.exercise}`)).size, 2, `${note}: two distinct slots`);
    const machine = store.getLayout().machines.find((m) => m.id === slots[0].machineId);
    assert.deepEqual(slots.map((sl) => sl.exercise), machine.exercises, `${note}: the machine offers both`);
    store.clearActive();
    startWorkoutFrom({ planId: p.id, entries: store.getPlans().find((x) => x.id === p.id).items });
    assert.equal(store.getActive().plan.length, 2, `${note}: the next workout keeps both`);
    assert.ok(store.getActive().plan.every((sl) => sl.target), `${note}: with their targets`);
  }
  store.clearActive();
  // the same NAME twice on one number is one movement, not a new exercise
  {
    fresh();
    const p = plantext.planFromText('#14 Leg press 3x10 80\n#14 Leg press 3x6 100');
    store.savePlan(p);
    startWorkoutFrom({ planId: p.id, entries: p.items });
    for (const i of [0, 1]) {
      const a = store.getActive();
      a.binding = i;
      store.saveActive(a);
      byId.clear();
      renderTrain(root);
      root.querySelector('#bind-num').value = '14';
      byId.get('#bind-go').listeners.click();
    }
    assert.equal(store.getLayout().machines.find((m) => m.num === 14).exercises, undefined,
      'a machine named like the line learns no exercise of its own name');
    store.clearActive();
  }

  // quick start numbers one past the highest, never length + 1 — here the
  // pull lands while the empty gym's quick start is on screen
  store.saveLayout(store.newLayout('QS gym'));
  store.clearActive();
  byId.clear();
  goToStart();
  renderTrain(root);
  const qsStart = byId.get('#qs-start').listeners.click;
  const qs = store.getLayout();
  qs.machines.push({ id: 'q2', num: 2, label: 'Leg press', x: 0, y: 0, w: 4, h: 3, settingsFields: [] },
    { id: 'q3', num: 3, label: 'Chest press', x: 6, y: 0, w: 4, h: 3, settingsFields: [] });
  store.restoreLayout(qs);
  byId.get('#qs-label').value = 'Cable row';
  qsStart();
  assert.deepEqual(store.getLayout().machines.map((m) => m.num), [2, 3, 4], 'quick start adds #4, not a second #3');
  // the backstop (a workout with sets is already running) says why it does nothing
  const run = store.getActive();
  run.entries.push({ machineId: run.currentMachineId, num: 4, label: 'Cable row', settings: {}, sets: [{ reps: 8, weight: 20 }] });
  store.saveActive(run);
  qsStart();
  assert.ok(root.innerHTML.includes('A workout is already running — finish it first.'), 'the backstop speaks');
  assert.equal(store.getLayout().machines.length, 3, 'and adds nothing');
  store.clearActive();
  store.saveLayout(before);
}

// --- grips on the log screen ---
{
  const before = store.getLayout();
  const g = store.newLayout('Grip gym');
  g.machines.push(
    { id: 'ct', num: 9, label: 'Cable tower', x: 0, y: 0, w: 4, h: 3, settingsFields: [],
      exercises: ['Pushdown', 'Face pull'], grips: ['Rope', 'V-bar'] },
    { id: 'm1', num: 1, label: 'Chest press', x: 6, y: 0, w: 4, h: 3, settingsFields: [] });
  store.saveLayout(g);
  const done = (exercise, grip, weight) => ({ machineId: 'ct', num: 9, label: 'Cable tower', exercise,
    ...(grip ? { grip } : {}), settings: {}, sets: [{ reps: 12, weight }] });
  store.saveWorkouts([
    { id: 'gw1', startedAt: 1000, entries: [done('Pushdown', 'Rope', 25), done('Pushdown', 'V-bar', 35)] },
    { id: 'gw2', startedAt: 2000, entries: [done('Pushdown', 'V-bar', 37.5)] },
  ]);
  const chips = () => root.innerHTML.match(/id="grip-chips"[\s\S]*?<\/div>/)?.[0] ?? '';
  const selected = () => /class="chip sel[^"]*"\s+data-grip="([^"]+)"/.exec(chips())?.[1] ?? null;
  const start = (plan) => {
    store.saveActive({ v: 2, id: 'w-grip', startedAt: Date.now(), plan,
      currentMachineId: 'ct', currentExercise: 'Pushdown', entries: [] });
    byId.clear();
    renderTrain(root);
  };

  // no plan grip: the last one trained, with its own prefill
  start([{ machineId: 'ct', exercise: 'Pushdown' }]);
  assert.equal(selected(), 'V-bar', 'the grip defaults to the one last trained');
  assert.equal(stepper(root.innerHTML, 'set-weight'), '37.5', 'and prefills from that grip');
  // a plan slot naming a grip beats the habit
  start([{ machineId: 'ct', exercise: 'Pushdown', grip: 'Rope' }]);
  assert.equal(selected(), 'Rope', 'the plan slot\'s grip wins');
  assert.equal(stepper(root.innerHTML, 'set-weight'), '25', 'with the rope\'s own prefill');

  // switching the grip switches the entry
  start([{ machineId: 'ct', exercise: 'Pushdown' }]);
  byId.get('#set-weight').value = '40';
  byId.get('#set-reps').value = '10';
  byId.get('#set-rest').value = '0';
  byId.get('#log-set').listeners.click();
  byId.get('#grip-chips').listeners.click({ target: { closest: () => ({ dataset: { grip: 'Rope' } }) } });
  assert.equal(selected(), 'Rope', 'a chip tap picks the grip');
  assert.equal(stepper(root.innerHTML, 'set-weight'), '25', 'and the prefill follows it');
  byId.get('#set-weight').value = '27.5';
  byId.get('#set-reps').value = '12';
  byId.get('#log-set').listeners.click();
  let a = store.getActive();
  assert.deepEqual(a.entries.filter((e) => e.sets.length).map((e) => [e.grip, e.sets.length]),
    [['V-bar', 1], ['Rope', 1]], 'two grips, two entries');
  assert.ok(/class="chip done"\s+data-grip="V-bar"/.test(chips()), 'the grip already logged is marked done');
  assert.equal(a.plan.length, 1, 'the gripless slot covers the rope — no slot is added');

  // deselecting means "no grip", and stays so
  byId.get('#grip-chips').listeners.click({ target: { closest: () => ({ dataset: { grip: 'Rope' } }) } });
  assert.equal(selected(), null, 'the chosen chip again deselects');
  assert.strictEqual(store.getActive().currentGrip, null, 'stored as a deliberate null');
  byId.clear();
  renderTrain(root);
  assert.equal(selected(), null, 'and is not re-resolved on the next render');
  byId.get('#exercise-chips').listeners.click({ target: { closest: () => ({ dataset: { exercise: 'Pushdown' } }) } });
  assert.strictEqual(store.getActive().currentGrip, null, 'tapping the exercise already on screen keeps the choice');

  // "+ Grip": a machine nobody gave grips still switches one by button —
  // the machine learns it and it is selected at once
  store.saveActive({ v: 2, id: 'w-grip', startedAt: Date.now(), plan: [{ machineId: 'm1', exercise: null }],
    currentMachineId: 'm1', entries: [] });
  byId.clear();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('id="grip-add"') && !root.innerHTML.includes('id="grip-chips"'),
    'a gripless machine shows a lone + Grip chip, no Grip card');
  assert.ok(!root.innerHTML.includes('id="grip-new"'), 'its picker starts closed');
  byId.get('#grip-add').listeners.click();
  assert.ok(/id="grip-new"[\s\S]*data-grip="Rope"/.test(root.innerHTML), 'the tap opens the common grips');
  byId.get('#grip-new').listeners.click({ target: { closest: () => ({ dataset: { grip: 'Rope' } }) } });
  assert.deepEqual(store.getLayout().machines.find((m) => m.id === 'm1').grips, ['Rope'], 'the machine learns the grip');
  assert.equal(store.getActive().currentGrip, 'Rope', 'and it is the grip on screen at once');
  assert.equal(selected(), 'Rope', 'its chip shows selected');
  assert.ok(!root.innerHTML.includes('id="grip-new"'), 'the picker closes after the pick');
  assert.ok(!/id="grip-new"[\s\S]*data-grip="Rope"/.test((byId.get('#grip-add').listeners.click(), root.innerHTML)),
    'a grip the machine knows is not offered again');
  byId.get('#grip-custom').value = ' Wide  [bar] ';
  byId.get('#grip-custom-add').listeners.click();
  assert.deepEqual(store.getLayout().machines.find((m) => m.id === 'm1').grips, ['Rope', 'Wide bar'],
    'a typed grip loses its brackets — "[…]" names the grip in a plan line');
  assert.equal(store.getActive().currentGrip, 'Wide bar', 'and is selected too');
  // a tap on "+ Grip" bubbles into #grip-chips — it must not pick a grip there
  byId.get('#grip-chips').listeners.click({ target: { closest: () => ({ id: 'grip-add', dataset: {} }) } });
  assert.equal(store.getActive().currentGrip, 'Wide bar', '"+ Grip" is no grip chip');
  byId.get('#grip-add').listeners.click();
  byId.get('#grip-custom').value = 'rope';
  byId.get('#grip-custom').listeners.keydown({ key: 'Enter', target: byId.get('#grip-custom') });
  assert.deepEqual(store.getLayout().machines.find((m) => m.id === 'm1').grips, ['Rope', 'Wide bar'],
    'Enter adds too, and "rope" is the Rope the machine knows — no second series');
  assert.equal(store.getActive().currentGrip, 'Rope', 'that Rope is selected');
  // the open picker belongs to this machine in this workout only
  byId.get('#grip-add').listeners.click();
  assert.ok(root.innerHTML.includes('id="grip-new"'), 'picker open');
  a = store.getActive();
  store.switchMachine(a, 'ct', 'Pushdown');
  store.saveActive(a);
  byId.clear();
  renderTrain(root);
  a = store.getActive();
  store.switchMachine(a, 'm1');
  store.saveActive(a);
  byId.clear();
  renderTrain(root);
  assert.ok(!root.innerHTML.includes('id="grip-new"'), 'leaving the machine closed it');
  // cardio: no "+ Grip", but grips it already has still show (and stay switchable)
  const cg = store.getLayout();
  cg.machines.find((m) => m.id === 'm1').cardio = true;
  store.saveLayout(cg);
  byId.clear();
  renderTrain(root);
  assert.ok(!root.innerHTML.includes('id="grip-add"'), 'a cardio machine offers no + Grip');
  assert.ok(/id="grip-chips"[\s\S]*data-grip="Rope"/.test(root.innerHTML), 'but shows the grips it has');
  const reset = store.getLayout();
  delete reset.machines.find((m) => m.id === 'm1').grips;
  store.saveLayout(reset);
  byId.clear();
  renderTrain(root);
  assert.ok(!root.innerHTML.includes('id="grip-add"') && !root.innerHTML.includes('id="grip-chips"'),
    'a gripless cardio machine shows no grip UI at all');
  delete reset.machines.find((m) => m.id === 'm1').cardio;
  store.saveLayout(reset);

  // a wildcard slot counts both grips; two grip slots walk Next between them
  start([{ machineId: 'ct', exercise: 'Pushdown', grip: 'Rope' }, { machineId: 'ct', exercise: 'Pushdown', grip: 'V-bar' },
    { machineId: 'm1', exercise: null }]);
  byId.get('#set-weight').value = '25';
  byId.get('#set-reps').value = '12';
  byId.get('#set-rest').value = '0';
  byId.get('#log-set').listeners.click();
  assert.ok(/id="next-machine"[^>]*>Next: #9\s+Cable tower · Pushdown · V-bar/.test(root.innerHTML),
    'Next walks to the other grip at the same machine');
  byId.get('#next-machine').listeners.click();
  assert.equal(store.getActive().currentGrip, 'V-bar', 'and arrives with that grip');
  assert.ok(root.innerHTML.includes('<span class="muted">2/3</span>'), 'at the V-bar slot, not the rope one');
  // a grip the plan does not cover gets its own slot after its siblings
  store.saveActive({ ...store.getActive(), currentGrip: null });
  byId.clear();
  renderTrain(root);
  assert.deepEqual(store.getActive().plan.map((p) => `${p.machineId}:${p.grip ?? '-'}`),
    ['ct:Rope', 'ct:V-bar', 'ct:-', 'm1:-'], 'an uncovered choice grows a slot after its siblings');
  store.saveActive({ ...store.getActive(), plan: [{ machineId: 'ct', exercise: 'Pushdown', target: { sets: 2, reps: 12, weight: 25 } }],
    currentGrip: 'V-bar' });
  byId.clear();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('set 2/2'), 'a gripless target counts the rope set and the V-bar set alike');

  // Next hands its slot's grip over, even when another grip slot is open first
  start([{ machineId: 'ct', exercise: 'Pushdown', grip: 'Rope' }, { machineId: 'm1', exercise: null },
    { machineId: 'ct', exercise: 'Pushdown', grip: 'V-bar' }]);
  a = store.getActive();
  store.switchMachine(a, 'm1');
  store.saveActive(a);
  byId.clear();
  renderTrain(root);
  byId.get('#set-weight').value = '40';
  byId.get('#set-reps').value = '10';
  byId.get('#set-rest').value = '0';
  byId.get('#log-set').listeners.click();
  byId.get('#next-machine').listeners.click();
  assert.equal(store.getActive().currentGrip, 'V-bar', 'Next lands on the V-bar it promised');
  // switching machines leaves the grip unresolved again
  a = store.getActive();
  a.currentGrip = null;
  store.switchMachine(a, 'm1');
  assert.ok(!('currentGrip' in a), 'a machine switch without a grip forgets the old choice');
  // a new exercise resolves its own grip
  store.saveWorkouts([...store.getWorkouts(), { id: 'gw3', startedAt: 3000, entries: [done('Face pull', 'Rope', 15)] }]);
  start([{ machineId: 'ct', exercise: 'Pushdown' }]);
  byId.get('#grip-chips').listeners.click({ target: { closest: () => ({ dataset: { grip: 'V-bar' } }) } });
  assert.strictEqual(store.getActive().currentGrip, null, 'no grip on the pushdown');
  byId.get('#exercise-chips').listeners.click({ target: { closest: () => ({ dataset: { exercise: 'Face pull' } }) } });
  assert.equal(store.getActive().currentGrip, 'Rope', 'the face pull takes its own last grip');

  // the progress hint is about one grip: it shows at that grip only
  {
    const recent = (days, weight, reps) => ({ id: `gp${days}`, startedAt: Date.now() - days * 864e5,
      entries: [{ ...done('Pushdown', 'Rope', weight), sets: [{ reps: 10, weight }, { reps, weight }] }] });
    const keep = store.getWorkouts();
    store.saveWorkouts([recent(9, 55, 10), recent(5, 57.5, 14), recent(1, 57.5, 14)]);
    const at = (grip) => {
      start([{ machineId: 'ct', exercise: 'Pushdown', grip }]);
      return root.innerHTML.includes('Target beaten twice');
    };
    assert.ok(at('Rope'), 'the rope screen carries the rope\'s progress hint');
    assert.ok(!at('V-bar'), 'the V-bar screen does not — it would name the wrong load');
    store.saveWorkouts(keep);
  }

  // a gripless slot of this exercise is where any grip of it logs
  start([{ machineId: 'ct', exercise: 'Face pull' }, { machineId: 'ct', exercise: 'Pushdown' }]);
  assert.equal(selected(), 'V-bar');
  assert.ok(root.innerHTML.includes('<span class="muted">2/2</span>'), 'the V-bar logs at the gripless pushdown slot');

  // repeating a workout keeps both grips as two slots
  startWorkoutFrom({ entries: [done('Pushdown', 'Rope', 25), done('Pushdown', 'V-bar', 35)] });
  assert.deepEqual(store.getActive().plan.map((p) => p.grip), ['Rope', 'V-bar'], 'repeat keeps both grips');
  startWorkoutFrom({ entries: [done('Pushdown', null, 25), done('Pushdown', 'Rope', 25)] });
  assert.deepEqual(store.getActive().plan.map((p) => p.grip ?? null), ['Rope'],
    'a gripless slot next to a narrower rope slot is dropped — it would count the rope twice');

  // an unbound line naming a grip teaches it to the machine it binds to
  store.clearActive();
  const gp = plantext.planFromText('#12 Cable column: Pushdown [Rope] 3x12 25');
  store.savePlan(gp);
  startWorkoutFrom({ planId: gp.id, entries: gp.items });
  byId.clear();
  renderTrain(root);
  root.querySelector('#bind-num').value = '12';
  byId.get('#bind-go').listeners.click();
  const m12 = store.getLayout().machines.find((m) => m.num === 12);
  assert.deepEqual([m12.exercises, m12.grips], [['Pushdown'], ['Rope']], 'the new machine learns exercise and grip');
  assert.equal(store.getActive().currentGrip, 'Rope', 'and the log screen opens on that grip');
  assert.equal(store.getPlans().find((x) => x.id === gp.id).items[0].grip, 'Rope', 'the stored plan keeps it');

  // grips cleared from the machine: its gripped history still prefills
  store.saveWorkouts([{ id: 'gw3', startedAt: 3000, entries: [done('Pushdown', 'Rope', 27.5)] }]);
  const cleared = store.getLayout();
  const ct = cleared.machines.find((m) => m.id === 'ct');
  const keepGrips = ct.grips;
  ct.grips = [];
  store.saveLayout(cleared);
  start([{ machineId: 'ct', exercise: 'Pushdown' }]);
  assert.equal(stepper(root.innerHTML, 'set-weight'), '27.5', 'no grips left, no gripless entry: the rope value, not 20');
  store.saveWorkouts([{ id: 'gw4', startedAt: 4000, entries: [done('Pushdown', 'Rope', 27.5), done('Pushdown', null, 30)] }]);
  start([{ machineId: 'ct', exercise: 'Pushdown' }]);
  assert.equal(stepper(root.innerHTML, 'set-weight'), '30', 'a gripless entry still wins');
  ct.grips = keepGrips;
  store.saveLayout(cleared);

  // a machine without grips shows no grip row
  store.saveActive({ v: 2, id: 'w-nogrip', startedAt: Date.now(), plan: [{ machineId: 'm1', exercise: null }],
    currentMachineId: 'm1', currentExercise: null, entries: [] });
  byId.clear();
  renderTrain(root);
  assert.ok(!root.innerHTML.includes('id="grip-chips"'), 'no grips, no grip row');
  store.clearActive();
  store.saveWorkouts([]);
  store.saveLayout(before);
}

// --- binding onto a machine already trained WHOLE never relabels its slot ---
{
  const before = store.getLayout();
  const g = store.newLayout('Whole gym');
  g.machines.push({ id: 'm3', num: 3, label: 'Leg press', x: 0, y: 0, w: 4, h: 3, settingsFields: [] });
  store.saveLayout(g);
  store.clearActive();
  const p = plantext.planFromText('#3 Leg press 3x10 80\nCalf raise 3x15 60');
  store.savePlan(p);
  startWorkoutFrom({ planId: p.id, entries: p.items });
  byId.clear();
  renderTrain(root);
  for (let k = 0; k < 3; k++) {
    byId.get('#set-weight').value = '80';
    byId.get('#set-reps').value = '10';
    byId.get('#set-rest').value = '0';
    byId.get('#log-set').listeners.click();
  }
  const a = store.getActive();
  a.binding = 1;
  store.saveActive(a);
  byId.clear();
  renderTrain(root);
  root.querySelector('#bind-num').value = '3';
  byId.get('#bind-go').listeners.click();
  const plan = store.getActive().plan;
  assert.strictEqual(plan[0].exercise ?? null, null, 'the slot with logged whole-machine sets keeps them');
  assert.equal(store.getLayout().machines.find((m) => m.id === 'm3').exercises, undefined,
    'and the machine is not split into exercises its history never had');
  const b = store.getActive();
  store.switchMachine(b, null);
  store.saveActive(b);
  byId.clear();
  renderTrain(root);
  // two whole-machine slots are twins: they share the sets in plan order,
  // so the three sets fill the first block only
  assert.ok(root.innerHTML.includes('3/6 target sets'), 'the three sets count once, on the first twin');
  // a name differing only in case is the machine itself
  store.clearActive();
  const fresh = store.newLayout('Case gym');
  fresh.machines.push({ id: 'm4', num: 4, label: 'Leg press', x: 0, y: 0, w: 4, h: 3, settingsFields: [] });
  const items = [{ machineId: 'm4', exercise: null }, { machineId: null, name: 'leg press', exercise: null }];
  assert.deepEqual(store.bindItemTo(items, 1, fresh.machines[0], 'leg press').exercises, [],
    'case alone makes no new exercise');
  store.saveWorkouts([]);
  store.saveLayout(before);
}

// --- twins: two blocks at one machine share their sets in plan order ---
{
  const before = store.getLayout();
  const g = store.newLayout('Twin gym');
  g.machines.push({ id: 't14', num: 14, label: 'Leg press', x: 0, y: 0, w: 4, h: 3, settingsFields: [] },
    { id: 't15', num: 15, label: 'Calf raise', x: 6, y: 0, w: 4, h: 3, settingsFields: [] },
    { id: 't16', num: 16, label: 'Hack squat', x: 12, y: 0, w: 4, h: 3, settingsFields: [] });
  store.saveLayout(g);
  store.clearActive();
  store.saveWorkouts([]);
  const p = plantext.planFromText('#14 Leg press 3x10 80\n#14 Leg press 3x6 100\n#15 Calf raise 3x15 60\n#16 Hack squat 3x8 50');
  store.savePlan(p);
  startWorkoutFrom({ planId: p.id, entries: p.items });
  assert.equal(store.getActive().plan.length, 4, 'a restart keeps both twins: their targets differ');
  const logSet = (w, r) => {
    byId.get('#set-weight').value = w;
    byId.get('#set-reps').value = r;
    byId.get('#set-rest').value = '0';
    byId.get('#log-set').listeners.click();
  };
  byId.clear();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('3 × 10 @ 80 kg'), 'the first twin\'s target leads');
  assert.ok(/Next: #15\s+Calf raise/.test(root.innerHTML), 'the other twin is no "Next": it is this screen later');
  assert.ok(root.innerHTML.includes('Busy? #16'), 'and the busy escape hatch stays on offer');
  for (let k = 0; k < 2; k++) logSet('80', '10');
  byId.clear();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('Log set 3/3'), 'the third set of the first block is up');
  logSet('80', '10');
  byId.clear();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('3 × 6 @ 100 kg'), 'after three sets the second twin\'s target takes over');
  assert.ok(root.innerHTML.includes('Log set 1/3 — 100 kg × 6'),
    'and counts from its own first set, prefilled from its own target — not the 80 kg × 10 before it');
  assert.ok(root.innerHTML.includes('<span class="muted">2/4</span>'), 'the plan position moves to the second twin');
  assert.ok(/Next[^<]*Calf raise/.test(root.innerHTML), '"Next" is the stop after the second twin');
  const a = store.getActive();
  store.switchMachine(a, null);
  store.saveActive(a);
  byId.clear();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('3/12 target sets'), 'the tally counts the three sets once: 3/12, not 6/12');
  assert.ok(root.innerHTML.includes('✓ 3/3 sets'), 'the first twin row is done');
  assert.equal((root.innerHTML.match(/>open</g) ?? []).length, 3, 'the second twin and the two others are still open');
  // both blocks done: the screen stays on the LAST block, not the first
  store.switchMachine(a, 't14');
  store.saveActive(a);
  byId.clear();
  renderTrain(root);
  for (let k = 0; k < 3; k++) logSet('100', '6');
  byId.clear();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('3 × 6 @ 100 kg') && root.innerHTML.includes('<span class="muted">2/4</span>'),
    'all twins done: the header names the last block');
  // more sets than both blocks ask for: the last twin keeps the surplus
  logSet('100', '6');
  const c = store.getActive();
  store.switchMachine(c, null);
  // twins without a target (bound on the floor): one set each
  c.plan.push({ machineId: 't15', exercise: null }, { machineId: 't15', exercise: null });
  c.plan.splice(2, 1);
  store.saveActive(c);
  byId.clear();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('✓ 4/3 sets'), 'no set vanishes: the last twin shows the surplus');
  store.switchMachine(c, 't15');
  store.saveActive(c);
  byId.clear();
  renderTrain(root);
  logSet('60', '15');
  const d = store.getActive();
  store.switchMachine(d, null);
  store.saveActive(d);
  byId.clear();
  renderTrain(root);
  assert.deepEqual([...root.innerHTML.matchAll(/class="plan-status[^"]*">([^<]*)</g)].map((m) => m[1]),
    ['✓ 3/3 sets', '✓ 4/3 sets', 'open', '1/3 sets', 'open'],
    'a target-less twin fills up to its set goal (the default, 3) first, the next stays open');
  // a past workout's entries repeated: the same triple without targets is one slot
  store.clearActive();
  startWorkoutFrom({ entries: [{ machineId: 't14', exercise: null }, { machineId: 't14', exercise: null }] });
  assert.equal(store.getActive().plan.length, 1, 'an exact repeat still dedupes');
  store.clearActive();
  store.saveWorkouts([]);
  store.saveLayout(before);
}

// --- twins: an overview row opens exactly ITS block; a bind never re-deals ---
{
  const before = store.getLayout();
  const g = store.newLayout('Twin row gym');
  g.machines.push({ id: 't14', num: 14, label: 'Leg press', x: 0, y: 0, w: 4, h: 3, settingsFields: [] },
    { id: 't15', num: 15, label: 'Calf raise', x: 6, y: 0, w: 4, h: 3, settingsFields: [] },
    { id: 't16', num: 16, label: 'Hack squat', x: 12, y: 0, w: 4, h: 3, settingsFields: [] });
  store.saveLayout(g);
  store.clearActive();
  store.saveWorkouts([]);
  // the twins apart: the light block leads, the heavy one comes after the calves
  const p = plantext.planFromText('#14 Leg press 3x10 80\n#15 Calf raise 3x15 60\n#14 Leg press 3x6 100\n#16 Hack squat 3x8 50');
  store.savePlan(p);
  startWorkoutFrom({ planId: p.id, entries: p.items });
  const logSet = (w, r) => {
    byId.get('#set-weight').value = w;
    byId.get('#set-reps').value = r;
    byId.get('#set-rest').value = '0';
    byId.get('#log-set').listeners.click();
  };
  const toOverview = () => {
    const a = store.getActive();
    store.switchMachine(a, null);
    store.saveActive(a);
    byId.clear();
    renderTrain(root);
  };
  const statuses = () => [...root.innerHTML.matchAll(/class="plan-status[^"]*">([^<]*)</g)].map((m) => m[1]);
  // the overview's row `i`, tapped — the plain stub hands out no rows
  const tapRow = (i) => {
    const row = stubEl();
    row.dataset.i = String(i);
    const qsa = root.querySelectorAll;
    root.querySelectorAll = (sel) => (sel === '.plan-row' ? [row] : []);
    try { toOverview(); } finally { root.querySelectorAll = qsa; }
    byId.clear();
    row.listeners.click();
  };
  toOverview();
  const labels = [...root.innerHTML.matchAll(/class="plan-label">([\s\S]*?)<\/span>\s*<span class="plan-status/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  assert.deepEqual(labels, ['Leg press · 3 × 10 @ 80 kg', 'Calf raise', 'Leg press · 3 × 6 @ 100 kg', 'Hack squat'],
    'twin rows name their targets — the rows would read alike otherwise; a single block stays plain');
  tapRow(2);
  const heavy = (h) => h.includes('Target: 3 × 6 @ 100 kg') && h.includes('<span class="muted">3/4</span>');
  assert.ok(heavy(root.innerHTML), 'the heavy row opens the heavy block — its target, its plan position');
  assert.ok(root.innerHTML.includes('Log set 1/3 — 100 kg × 6'), 'its first set comes from its own target');
  assert.ok(/Next: #16\s+Hack squat/.test(root.innerHTML), '"Next" is the stop after THAT block, not after the light one');
  assert.equal(store.getActive().chosenSlot, 2, 'the choice lives on the workout');
  byId.clear();
  renderTrain(root); // a re-render reads the workout back from storage, as a reload does
  assert.ok(heavy(root.innerHTML), 'and survives a re-render and a reload');
  logSet('100', '6');
  logSet('100', '6');
  assert.ok(heavy(root.innerHTML) && root.innerHTML.includes('Log set 3/3 — 100 kg × 6'),
    'its sets count on it: the third heavy set is up');
  toOverview();
  assert.deepEqual(statuses(), ['open', 'open', '2/3 sets', 'open'], 'the overview books them on the heavy row');
  tapRow(2);
  logSet('100', '6');
  assert.ok(root.innerHTML.includes('Target: 3 × 10 @ 80 kg') && root.innerHTML.includes('<span class="muted">1/4</span>')
    && root.innerHTML.includes('Log set 1/3 — 80 kg × 10'), 'the heavy block done: the light block takes over, from its own target');
  tapRow(2);
  assert.ok(root.innerHTML.includes('Target: 3 × 10 @ 80 kg'),
    'a done block yields to its open twin — "Next" never offers a twin of the screen it is on');
  for (let k = 0; k < 3; k++) logSet('80', '10');
  toOverview();
  assert.deepEqual(statuses(), ['✓ 3/3 sets', 'open', '✓ 3/3 sets', 'open'], 'each block holds its own three');
  assert.ok(!('chosenSlot' in store.getActive()), 'back on the overview the choice is gone');

  // a line bound later as the EARLIER twin takes none of the sets already logged
  store.saveActive({ v: 2, id: 'w-rebind', startedAt: Date.now(), currentMachineId: 't14', currentExercise: null, entries: [],
    plan: [{ machineId: null, name: 'Leg press', exercise: null, target: { sets: 2, reps: 10, weight: 80 } },
      { machineId: 't14', exercise: null, target: { sets: 3, reps: 6, weight: 100 } }] });
  byId.clear();
  renderTrain(root);
  for (let k = 0; k < 3; k++) logSet('100', '6');
  const a = store.getActive();
  a.binding = 0;
  store.saveActive(a);
  byId.clear();
  renderTrain(root);
  root.querySelector('#bind-num').value = '14';
  byId.get('#bind-go').listeners.click();
  const bound = store.getActive().plan;
  assert.ok(bound[0].machineId === 't14' && bound[0].exercise == null, 'trained whole: the bound line is a twin');
  assert.ok(root.innerHTML.includes('Target: 2 × 10 @ 80 kg') && root.innerHTML.includes('Log set 1/2 — 80 kg × 10'),
    'the screen is the line just bound');
  toOverview();
  assert.deepEqual(statuses(), ['open', '✓ 3/3 sets'], 'the three sets stay where they were logged — not "✓ 2/2" + "1/3"');
  // …and one bound as the LATER twin opens itself, not the earlier block still open
  store.saveActive({ v: 2, id: 'w-rebind2', startedAt: Date.now(), currentMachineId: 't14', currentExercise: null, entries: [],
    plan: [{ machineId: 't14', exercise: null, target: { sets: 3, reps: 10, weight: 80 } },
      { machineId: null, name: 'Leg press', exercise: null, target: { sets: 3, reps: 6, weight: 100 } }] });
  byId.clear();
  renderTrain(root);
  logSet('80', '10');
  const b = store.getActive();
  b.binding = 1;
  store.saveActive(b);
  byId.clear();
  renderTrain(root);
  root.querySelector('#bind-num').value = '14';
  byId.get('#bind-go').listeners.click();
  assert.ok(root.innerHTML.includes('Target: 3 × 6 @ 100 kg') && root.innerHTML.includes('<span class="muted">2/2</span>'),
    'the line just bound is the screen, though the light block before it is still open');
  toOverview();
  assert.deepEqual(statuses(), ['1/3 sets', 'open'], 'and the light set stays on the light block');
  // "Next" naming the LATER twin opens that block, not the earlier one still open
  store.clearActive();
  startWorkoutFrom({ planId: p.id, entries: p.items });
  tapRow(1);
  assert.ok(/Next: #14\s+Leg press/.test(root.innerHTML), 'from the calves, Next is the leg press');
  byId.get('#next-machine').listeners.click();
  assert.ok(root.innerHTML.includes('Target: 3 × 6 @ 100 kg') && root.innerHTML.includes('<span class="muted">3/4</span>'),
    'a tap on Next opens the heavy block it named — not the light one before it');
  assert.equal(store.getActive().chosenSlot, 2, 'Next hands its plan index on');
  store.clearActive();
  store.saveWorkouts([]);
  store.saveLayout(before);
}

// --- assisted machines: the log screen speaks assist, and asks the goal ---
{
  const before = store.getLayout();
  const g = store.newLayout('Assist gym');
  g.machines.push({ id: 'ax', num: 17, label: 'Assisted pull-up', x: 0, y: 0, w: 4, h: 3, settingsFields: [],
    muscles: ['Lats'], assisted: true });
  store.saveLayout(g);
  const ent = (weight) => ({ machineId: 'ax', num: 17, label: 'Assisted pull-up', assisted: true, settings: {},
    sets: [{ reps: 8, weight }] });
  store.saveWorkouts([{ id: 'as1', startedAt: 1000, finishedAt: 2000, entries: [ent(30)] },
    { id: 'as2', startedAt: 3000, finishedAt: 4000, entries: [ent(27.5)] }]);
  const open = () => {
    store.saveActive({ v: 2, id: 'w-assist', startedAt: Date.now(),
      plan: [{ machineId: 'ax', exercise: null, target: { sets: 3, reps: 8, weight: 25 } }],
      currentMachineId: 'ax', currentExercise: null, entries: [] });
    byId.clear();
    renderTrain(root);
  };
  open();
  const h = root.innerHTML;
  assert.ok(h.includes('<span class="label">Assist</span>'), 'the load stepper is the assist');
  assert.ok(h.includes('Target: 3 × 8 @ −25 kg'), 'the target reads as a minus');
  assert.ok(h.includes('Last: −27.5×8 kg'), '"Last:" too');
  assert.ok(/class="chip sel" data-goal="strength" aria-pressed="true">Less assist/.test(h),
    'the goal: less assist, read from the history (30 → 27.5 kg)');
  assert.ok(h.includes('Read from your last workouts'), 'and it says it was read, not said');
  const goalTap = (goal) => byId.get('#assist-goal').listeners.click({ target: { closest: () => ({ dataset: { goal } }) } });
  goalTap('endurance');
  assert.equal(store.getLayout().machines[0].assistGoal, 'endurance', 'a tap says the goal, on the machine');
  assert.ok(/class="chip sel" data-goal="endurance" aria-pressed="true">More reps/.test(root.innerHTML)
    && !root.innerHTML.includes('Read from your last workouts'), 'said, not read');
  goalTap('endurance');
  assert.equal('assistGoal' in store.getLayout().machines[0], false, 'the chosen chip again unsays it');
  goalTap('strength');
  assert.equal(store.getLayout().machines[0].assistGoal, 'strength',
    'tapping the chip the history picked SAYS it — it does not unsay what was never said');
  goalTap('strength');
  // no history and no target: the card does not pretend to have read one
  store.saveWorkouts([]);
  open();
  assert.ok(root.innerHTML.includes('Not set yet — tap the one you train for.') && !root.innerHTML.includes('Read from'),
    'a first visit says the goal is not set, not "read from your workouts"');
  assert.ok(root.innerHTML.includes('Target: 3 × 8 @ −25 kg'));
  store.saveWorkouts([{ id: 'as1', startedAt: 1000, finishedAt: 2000, entries: [ent(30)] },
    { id: 'as2', startedAt: 3000, finishedAt: 4000, entries: [ent(27.5)] }]);
  open();
  byId.get('#set-weight').value = '25';
  byId.get('#set-reps').value = '8';
  byId.get('#set-rest').value = '0';
  byId.get('#log-set').listeners.click();
  assert.ok(root.innerHTML.includes('<span>−25 kg × 8</span>'), 'a logged set reads "−25 kg × 8"');
  assert.equal(store.getActive().entries[0].assisted, true, 'and its entry is flagged assisted');
  // a machine retyped to assisted before its first set: the empty entry follows
  store.saveActive({ v: 2, id: 'w-retype', startedAt: Date.now(), plan: [{ machineId: 'ax', exercise: null }],
    currentMachineId: 'ax', currentExercise: null,
    entries: [{ machineId: 'ax', num: 17, label: 'Assisted pull-up', settings: {}, sets: [] }] });
  byId.clear();
  renderTrain(root);
  assert.equal(store.getActive().entries[0].assisted, true, 'an empty entry takes the machine\'s new type');
  store.clearActive();
  store.saveWorkouts([]);
  store.saveLayout(before);
}

// --- Muscles today: a muscle worked only as a secondary one is half done ---
{
  const before = store.getLayout();
  const g = store.newLayout('Secondary train gym');
  g.machines.push({ id: 'cp', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [],
    muscles: ['Chest'], secondaryMuscles: ['Triceps'] },
  { id: 'pd', num: 2, label: 'Pushdown', x: 6, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Triceps'] });
  store.saveLayout(g);
  store.saveActive({ v: 2, id: 'w-sec', startedAt: Date.now(), plan: [{ machineId: 'cp', exercise: null }],
    currentMachineId: null, currentExercise: null,
    entries: [{ machineId: 'cp', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 40 }] }] });
  byId.clear();
  withPicker(() => renderTrain(root));
  const cov = root.innerHTML.match(/id="muscle-coverage"[\s\S]*?<\/div>/)[0];
  assert.ok(cov.includes('class="muscle-row" data-muscle="Chest">') && cov.includes('Chest <span class="m-count">· 1 set</span>'),
    'the chest row counts its set');
  assert.ok(cov.includes('class="muscle-row" data-muscle="Triceps">') && cov.includes('Triceps <span class="m-count">· ½ set</span>'),
    'the triceps only half: ½, and no longer open');
  store.saveActive({ v: 2, id: 'w-sec2', startedAt: Date.now(), plan: [{ machineId: 'cp', exercise: null }],
    currentMachineId: 'cp', currentExercise: null, entries: [] });
  byId.clear();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('<div class="muted">Chest · Triceps ½</div>'), 'the log head names both, the secondary with ½');
  store.clearActive();
  store.saveLayout(before);
}

// --- the recommender: one line under Next when an open stop is much closer ---
{
  const before = store.getLayout();
  const g = store.newLayout('Closer gym');
  g.machines.push({ id: 'k1', num: 1, label: 'Chest press', x: 2, y: 2, w: 4, h: 3, settingsFields: [], muscles: ['Chest'] },
    { id: 'k2', num: 2, label: 'Far rower', x: 50, y: 2, w: 4, h: 3, settingsFields: [], muscles: ['Lats'] },
    { id: 'k3', num: 3, label: 'Pec deck', x: 10, y: 2, w: 4, h: 3, settingsFields: [], muscles: ['Chest'] },
    { id: 'k4', num: 4, label: 'Row', x: 2, y: 11, w: 4, h: 3, settingsFields: [], muscles: ['Upper back'] });
  store.saveLayout(g);
  store.saveWorkouts([]);
  const at = (plan, extra = {}) => {
    store.saveActive({ v: 2, id: 'w-closer', startedAt: Date.now(), plan, currentMachineId: 'k1', currentExercise: null,
      entries: [], ...extra });
    byId.clear();
    renderTrain(root);
    return root.innerHTML;
  };
  const slots = (...ids) => ids.map((machineId) => ({ machineId, exercise: null }));
  const h = at(slots('k1', 'k2', 'k3', 'k4'));
  assert.ok(/Next: #2\s+Far rower/.test(h), 'Next stays the plan\'s next');
  assert.ok(h.includes('Busy? #3'), '"Busy?" offers the nearest open machine — the pec deck, 8 away');
  assert.ok(h.includes('<p class="hint next-hint"><span>Closer: #4 Row — a quarter of the walk.</span></p>'),
    'the line names the row (9 away): the pec deck (8) right after the chest press costs the recovery malus — own data, no link');
  assert.ok(!at(slots('k1', 'k2', 'k3')).includes('Closer:'),
    'the only closer stop is the one "Busy?" already offers: one offer, not two');
  assert.ok(!at(slots('k1', 'k3', 'k2', 'k4')).includes('Closer:'), 'Next IS a close one: nothing to say');
  assert.ok(!at(slots('k1', 'k2', 'k3', 'k4'), { visits: [{ machineId: 'k1', in: 1, busy: 'k4' }] }).includes('Closer: #4'),
    'a machine "Busy?" skipped in this workout is not recommended');
  assert.ok(!at(slots('k1', 'k2', 'k3', 'k4'), { entries: [{ machineId: 'k4', num: 4, label: 'Row', settings: {},
    sets: [{ reps: 10, weight: 40 }, { reps: 10, weight: 40 }, { reps: 10, weight: 40 }] }] }).includes('Closer: #4'),
  'nor one already done (its goal of three met)');
  // a FREE slot without a set is where you merely stood, not a stop: like
  // "Next" (nextOpenSlot), neither "Busy?" nor "Closer:" offers it (idleFree)
  const free = (id) => ({ machineId: id, exercise: null, free: true });
  const oneSet = (id) => ({ entries: [{ machineId: id, num: 0, label: 'x', settings: {}, sets: [{ reps: 10, weight: 40 }] }] });
  const busyFree = at([...slots('k1', 'k2'), free('k3'), ...slots('k4')]);
  assert.ok(!busyFree.includes('Busy? #3') && busyFree.includes('Busy? #4'),
    '"Busy?" skips the merely opened pec deck and offers the next nearest open machine');
  assert.ok(at([...slots('k1', 'k2'), free('k3'), ...slots('k4')], oneSet('k3')).includes('Busy? #3'),
    'once the free slot has a set it is a stop again');
  const closerFree = at([...slots('k1', 'k2', 'k3'), free('k4')]);
  assert.ok(closerFree.includes('Busy? #3') && !closerFree.includes('Closer: #4'),
    '"Closer:" skips the merely opened row');
  assert.ok(at([...slots('k1', 'k2', 'k3'), free('k4')], oneSet('k4')).includes('Closer: #4'),
    'and names it again once it has a set');
  store.clearActive();
  store.saveLayout(before);
}

// --- Busy? walks the floor too; the Closer line names the exercise; a bad grid never crashes ---
{
  const before = store.getLayout();
  const g = store.newLayout('Wall gym');
  g.machines.push({ id: 'w1', num: 1, label: 'Chest press', x: 2, y: 2, w: 4, h: 3, settingsFields: [], muscles: ['Chest'] },
    { id: 'w2', num: 2, label: 'Far rower', x: 50, y: 2, w: 4, h: 3, settingsFields: [], muscles: ['Lats'] },
    { id: 'w3', num: 3, label: 'Behind the wall', x: 11, y: 2, w: 4, h: 3, settingsFields: [], muscles: ['Quads'] },
    { id: 'w4', num: 4, label: 'Dumbbell rack', x: 2, y: 12, w: 4, h: 3, settingsFields: [], muscles: ['Biceps'],
      exercises: ['Biceps curls'] });
  g.shapes.push({ id: 'wall', kind: 'line', x: 8.5, y: 0, w: 0, h: 10 });
  store.saveLayout(g);
  store.saveWorkouts([]);
  const active = { v: 2, id: 'w-wall', startedAt: Date.now(), currentMachineId: 'w1', currentExercise: null, entries: [],
    plan: [{ machineId: 'w1', exercise: null }, { machineId: 'w2', exercise: null }, { machineId: 'w3', exercise: null },
      { machineId: 'w4', exercise: 'Biceps curls' }] };
  const alt = nearbyAlternative(active, store.getLayout(), store.getLayout().machines[0], 'w2');
  assert.equal(alt.machine.id, 'w4', '"Busy?": the rack down the aisle, not the machine 5 units away behind a wall');
  store.saveActive(active);
  byId.clear();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('Busy? #4'), 'the screen offers the rack');
  // the wall gone: "Busy?" takes the near one, and "Closer:" names the rack's exercise
  const open = store.getLayout();
  open.shapes = [];
  open.machines[2].muscles = ['Chest']; // and the recovery malus makes the rack the better stop
  store.saveLayout(open);
  byId.clear();
  const { floodCount } = await import(new URL('../js/stats.js', import.meta.url).href);
  const floods = floodCount();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('Busy? #3'), 'without the wall the near machine is "Busy?"');
  assert.ok(root.innerHTML.includes('Closer: #4 Dumbbell rack · Biceps curls'), 'the line names the exercise too');
  assert.equal(floodCount() - floods, 1, 'one flood answers "Busy?" and "Closer:" for every machine');
  byId.clear();
  renderTrain(root);
  assert.equal(floodCount() - floods, 1, 'and a re-render reads the memo');
  // a negative grid (only a file can carry one): centres, never a crash
  const bad = store.getLayout();
  bad.grid = { w: -40, h: 30 };
  store.saveLayout(bad);
  byId.clear();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('Busy?'), 'a grid that is no floor: "Busy?" falls back to centres');
  store.clearActive();
  store.saveLayout(before);
}

// --- Muscles today: session progress as bar rows ---
// One row per muscle of the gym in MUSCLE_REGIONS order, a primary set 1, a
// secondary ½, the bar against the busiest muscle; a row without a set is
// open (muted, empty track) and a tap on any row filters the picker.
{
  const before = store.getLayout();
  const g = store.newLayout('Progress gym');
  g.machines.push(
    { id: 'pl', num: 1, label: 'Leg press', x: 0, y: 0, w: 4, h: 3, settingsFields: [],
      muscles: ['Quads', 'Glutes'], secondaryMuscles: ['Hamstrings'] },
    { id: 'pc', num: 2, label: 'Chest press', x: 6, y: 0, w: 4, h: 3, settingsFields: [],
      muscles: ['Chest'], secondaryMuscles: ['Triceps'] },
    { id: 'pd', num: 3, label: 'Lat pulldown', x: 12, y: 0, w: 4, h: 3, settingsFields: [],
      muscles: ['Lats'], secondaryMuscles: ['Biceps'] },
    { id: 'pn', num: 4, label: 'Neck harness', x: 18, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Neck'] });
  store.saveLayout(g);
  const three = [{ reps: 10, weight: 80 }, { reps: 10, weight: 80 }, { reps: 8, weight: 90 }];
  const active = { v: 2, id: 'w-progress', startedAt: Date.now(),
    plan: [{ machineId: 'pl', exercise: null }, { machineId: 'pc', exercise: null }, { machineId: 'pd', exercise: null }],
    currentMachineId: null, currentExercise: null,
    entries: [{ machineId: 'pl', num: 1, label: 'Leg press', settings: {}, sets: three },
      { machineId: 'pc', num: 2, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 40 }] },
      { machineId: 'pd', num: 3, label: 'Lat pulldown', settings: {}, sets: [] }] };
  const p = muscleProgress(active, store.getLayout());
  assert.deepEqual(p.rows.map((r) => r.muscle), ['Chest', 'Lats', 'Biceps', 'Triceps', 'Quads', 'Hamstrings', 'Glutes', 'Neck'],
    'one row per muscle of the gym, in region order, a muscle outside the pick list last');
  assert.deepEqual(p.rows.map((r) => r.value), [1, 0, 0, 0.5, 3, 1.5, 3, 0],
    'a primary set counts 1, a secondary ½ — the leg press\'s three sets give the hamstrings 1½');
  assert.deepEqual([p.trained, p.total, p.max], [5, 8, 3], 'trained = rows with a value; max = the busiest');
  store.saveActive(active);
  byId.clear();
  let picker = withPicker(() => renderTrain(root));
  // folded by default: the trained rows, most sets first (Quads and Glutes
  // tie at 3 and keep region order), then ONE toggle row for the rest
  const folded = root.innerHTML.match(/id="muscle-coverage"[\s\S]*?<\/div>/)[0];
  assert.deepEqual([...folded.matchAll(/data-muscle="([^"]+)"/g)].map((m) => m[1]),
    ['Quads', 'Glutes', 'Hamstrings', 'Chest', 'Triceps'], 'trained rows only, most sets first, ties in region order');
  assert.ok(folded.includes('<button type="button" id="muscle-fold" class="muscle-fold" aria-expanded="false">Show 3 untrained</button>'),
    'the untrained three fold behind one toggle, last in the list');
  assert.equal(store.getSettings().muscleFold, undefined, 'folded is the default, nothing stored');
  // the toggle unfolds IN PLACE (only #muscle-coverage changes) and persists
  // device-locally — the user settings' stamp stays where it was
  const stampBefore = store.getSettings().updatedAt;
  const coverage = byId.get('#muscle-coverage');
  const fold = { target: { closest: () => ({ id: 'muscle-fold', dataset: {} }) } };
  const htmlBefore = root.innerHTML;
  coverage.listeners.click(fold);
  assert.equal(root.innerHTML, htmlBefore, 'no re-render of the overview: the scroll and the picker stay');
  assert.equal(store.getSettings().muscleFold, 'shown', 'the unfold is stored');
  assert.equal(store.getSettings().updatedAt, stampBefore, 'as a device-local key, under the old stamp');
  const cov = coverage.innerHTML;
  assert.equal((cov.match(/class="muscle-row/g) ?? []).length, 8, 'eight rows for eight muscles');
  assert.deepEqual([...cov.matchAll(/data-muscle="([^"]+)"/g)].map((m) => m[1]),
    ['Quads', 'Glutes', 'Hamstrings', 'Chest', 'Triceps', 'Lats', 'Biceps', 'Neck'],
    'unfolded: the untrained rows follow, in the helper\'s order');
  assert.ok(/Triceps[\s\S]*id="muscle-fold"[^>]*aria-expanded="true">Hide untrained<\/button>[\s\S]*data-muscle="Lats"/.test(cov),
    'the toggle stays between the groups, above what it shows — the tap never moves it');
  // persisted: a fresh render comes back unfolded
  byId.clear();
  picker = withPicker(() => renderTrain(root));
  assert.ok(root.innerHTML.includes('aria-expanded="true">Hide untrained</button>')
    && root.innerHTML.includes('data-muscle="Neck"'), 'a re-render keeps the card unfolded');
  assert.ok(root.innerHTML.includes('<p class="muted">5 of 8 muscles trained</p>'), 'the line above the rows counts the trained ones');
  assert.ok(cov.includes('Quads <span class="m-count">· 3 sets</span>'), 'whole numbers through plural');
  assert.ok(cov.includes('Hamstrings <span class="m-count">· 1½ sets</span>'), 'a half reads as ½');
  assert.ok(cov.includes('Triceps <span class="m-count">· ½ set</span>'), 'a lone half is singular');
  assert.ok(cov.includes('Lats <span class="m-count">· open</span>'), 'a muscle without a set reads open');
  assert.ok(/class="muscle-row open" data-muscle="Lats">/.test(cov), 'and its row carries .open');
  assert.ok(!/class="muscle-row open" data-muscle="Triceps">/.test(cov), 'half a set is not open');
  const widthOf = (mu) => cov.match(new RegExp(`data-muscle="${mu}">[\\s\\S]*?width:(\\d+)%`))[1];
  assert.equal(widthOf('Quads'), '100', 'the busiest muscle fills its track');
  assert.equal(widthOf('Hamstrings'), '50', 'the others relative to it');
  assert.equal(widthOf('Lats'), '0', 'an open row leaves its track empty');
  assert.ok(root.innerHTML.includes('Tap an open muscle to find a machine for it below.'), 'the hint shows with the open rows');
  {
    const { muscleCardHtml } = await import(new URL('../js/train.js', import.meta.url).href);
    const hint = 'Tap an open muscle';
    const mixed = { rows: [{ muscle: 'Quads', value: 3 }, { muscle: 'Lats', value: 0 }], max: 3 };
    assert.ok(!muscleCardHtml(mixed, false).includes(hint), 'folded: no open row on screen, no hint');
    assert.ok(muscleCardHtml(mixed, true).includes(hint), 'unfolded: the hint follows the open rows');
    assert.ok(muscleCardHtml({ rows: [{ muscle: 'Lats', value: 0 }], max: 0 }, false).includes(hint),
      'nothing trained: every row shows, the hint too');
    assert.ok(!muscleCardHtml({ rows: [{ muscle: 'Quads', value: 3 }], max: 3 }, false).includes(hint),
      'everything trained: nothing open, no hint');
  }
  // a tap on a row drives the picker's muscle filter, as the chips did
  byId.get('#muscle-coverage').listeners.click({ target: { closest: () => ({ dataset: { muscle: 'Lats' } }) } });
  assert.equal(picker.parts.get('.pick-muscle').value, 'Lats', 'the row sets the picker\'s muscle filter');
  assert.ok(picker.parts.get('.pick-chips').innerHTML.includes('#3 Lat pulldown'), 'and the picker lists the machine for it');
  // a second tap on the toggle folds again, and that is stored too
  byId.get('#muscle-coverage').listeners.click(fold);
  assert.equal(store.getSettings().muscleFold, 'folded', 'the fold is stored');
  assert.ok(!byId.get('#muscle-coverage').innerHTML.includes('data-muscle="Lats"')
    && byId.get('#muscle-coverage').innerHTML.includes('>Show 3 untrained</button>'), 'and the open rows are gone again');
  // nothing trained yet: every row shows, no toggle — folding all of them
  // would leave an empty card
  store.saveActive({ ...active, entries: [] });
  byId.clear();
  withPicker(() => renderTrain(root));
  const none = root.innerHTML.match(/id="muscle-coverage"[\s\S]*?<\/div>/)[0];
  assert.deepEqual([...none.matchAll(/data-muscle="([^"]+)"/g)].map((m) => m[1]), p.rows.map((r) => r.muscle),
    'all eight open rows, in region order, despite the stored fold');
  assert.ok(!none.includes('muscle-fold'), 'and no toggle');
  { const { muscleFold, ...rest } = store.getSettings(); store.saveSettings(rest); }
  // the log screen's way back carries the same count when nothing is next:
  // every other machine at its goal (three sets, the app default) or trained
  // today, so neither the plan nor a suggestion has a stop left
  store.saveActive({ ...active, currentMachineId: 'pd', entries: [
    active.entries[0], { ...active.entries[1], sets: three }, active.entries[2],
    { machineId: 'pn', num: 4, label: 'Neck harness', settings: {}, sets: [{ reps: 12, weight: 10 }] },
  ] });
  byId.clear();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('Workout overview → <span class="sub">6/8 muscles</span></button>'),
    'the overview button says how far the session is');
  assert.ok(!root.innerHTML.includes('id="next-machine"'), 'no Next: the other slots are at their goal, nothing untrained is left');
  store.clearActive();
  store.saveLayout(before);
}

// --- the machine icon: after the badge on a row and in the head, trailing on the ↩ chips and Next ---
{
  const before = store.getLayout();
  const g = store.newLayout('Icon gym');
  g.machines.push(
    { id: 'i1', num: 1, label: 'Leg press', x: 0, y: 0, w: 5, h: 4, settingsFields: [], muscles: ['Quads'] },
    { id: 'i2', num: 2, label: 'Rower', x: 10, y: 0, w: 4, h: 3, settingsFields: [], cardio: true },
    { id: 'i3', num: 3, label: 'Chest press', x: 20, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Chest'] },
  );
  store.saveLayout(g);
  store.saveWorkouts([]);
  const icon = (glyph) => `<span class="machine-icon" aria-hidden="true">${glyph}</span>`;
  const active = {
    v: 2, id: 'w-icon', startedAt: Date.now() - 600000, currentMachineId: 'i1', currentExercise: null,
    plan: [{ machineId: 'i1', exercise: null }, { machineId: 'i2', exercise: null }, { machineId: 'i3', exercise: null }],
    entries: [{ machineId: 'i3', num: 3, label: 'Chest press', settings: {},
      sets: [{ reps: 10, weight: 50, at: Date.now() - 300000 }] }],
  };
  store.saveActive(active);
  byId.clear();
  renderTrain(root);
  let h = root.innerHTML;
  assert.ok(h.includes(`<span class="machine-badge">1</span>`) && h.includes(`<div class="title">${icon('🦵')} Leg press`),
    'the log screen\'s head: the icon opens the title line, right after the badge');
  assert.ok(/id="next-machine"[^>]*>Next: #2\s+Rower <span class="machine-icon" aria-hidden="true">🚣<\/span> →/.test(h),
    'Next: the icon trails the label, so "Next: #2 Rower" still reads as one text');
  assert.ok(h.includes(`↩ #3 Chest press ${icon('🫁')}</button>`), 'the quick-switch chip: trailing too');
  store.saveActive({ ...active, currentMachineId: null });
  byId.clear();
  renderTrain(root);
  h = root.innerHTML;
  assert.ok(h.includes('<h1>Workout</h1>'), 'the overview');
  assert.ok(/class="machine-badge sm">1<\/span>\s*<span class="machine-icon" aria-hidden="true">🦵<\/span>\s*<span class="plan-label">Leg press/.test(h),
    'a plan row: badge, icon, label');
  assert.ok(/class="machine-badge sm">2<\/span>\s*<span class="machine-icon" aria-hidden="true">🚣<\/span>/.test(h), 'the rower\'s row');
  assert.ok(/class="machine-badge sm">3<\/span>\s*<span class="machine-icon" aria-hidden="true">🫁<\/span>/.test(h), 'the chest press\'s row');
  store.clearActive();
  store.saveLayout(before);
}

// --- cardio levels: a third stepper, stored from 1 up, absent at 0, prefilled like the rest ---
{
  const before = store.getLayout();
  const g = store.newLayout('Level gym');
  g.machines.push({ id: 'rw', num: 9, label: 'Rower', x: 0, y: 0, w: 3, h: 3, settingsFields: [], cardio: true });
  store.saveLayout(g);
  store.saveWorkouts([]);
  const open = (plan) => {
    store.saveActive({ v: 2, id: 'w-level', startedAt: Date.now() - 60000, plan,
      currentMachineId: 'rw', currentExercise: null, entries: [] });
    byId.clear();
    renderTrain(root);
  };
  const logWith = (level) => {
    byId.get('#set-distance').value = '2000';
    byId.get('#set-time').value = '10:00';
    byId.get('#set-rest').value = '0';
    byId.get('#set-level').value = level;
    byId.get('#log-set').listeners.click();
    const { at, ...set } = store.getActive().entries[0].sets.at(-1);
    return set;
  };
  open([{ machineId: 'rw', exercise: null }]);
  assert.ok(root.innerHTML.includes('<span class="label">Level</span>'), 'a cardio log screen has a Level stepper');
  assert.ok(root.innerHTML.includes('<input id="set-level" type="number" inputmode="numeric" value="0">'),
    'a plain numeric stepper like reps, 0 (= none) with no history');
  assert.deepEqual(logWith('5'), { distance: 2000, seconds: 600, level: 5 }, 'the level is stored on the set');
  assert.ok(root.innerHTML.includes('<span>2000 m · 10:00 · L5</span>'), 'the set list says it');
  assert.ok(root.innerHTML.includes('id="set-level" type="number" inputmode="numeric" value="5"'),
    'and the next set is prefilled with it');
  assert.ok(root.innerHTML.includes('>✓ Log set — 2000 m · 10:00 · L5<'), 'so the log button says it');
  byId.get('#set-level').value = '3';
  byId.get('#set-level').listeners.change();
  assert.equal(byId.get('#log-set').textContent, '✓ Log set — 2000 m · 10:00 · L3', 'the stepper updates the label live');
  assert.equal(logWith('x').level, 5, 'an unreadable level logs the prefill (the last set\'s), like distance and time');
  assert.deepEqual(logWith('0'), { distance: 2000, seconds: 600 }, '0 is none: no level key at all');
  assert.ok(root.innerHTML.includes('<span>2000 m · 10:00</span>'), 'and the row says nothing of it');
  assert.ok(root.innerHTML.includes('id="set-level" type="number" inputmode="numeric" value="0"'),
    'the next prefill follows the last set: none');
  assert.equal(logWith('2.6').level, 3, 'a level is a whole number');
  // a plan target's level seeds the first set, and the head line names it
  open([{ machineId: 'rw', exercise: null, target: { distance: 3000, seconds: 900, level: 7 } }]);
  assert.ok(root.innerHTML.includes('id="set-level" type="number" inputmode="numeric" value="7"'),
    'a plan target prefills its level');
  assert.ok(root.innerHTML.includes('Target: 3000 m · 15:00 · L7'), 'the target line names it');
  assert.ok(root.innerHTML.includes('>✓ Log set — 3000 m · 15:00 · L7<'), 'and so does the log button');
  // no target: the last workout's opener brings its level, "Last:" says it
  store.saveWorkouts([{ id: 'lv1', startedAt: 1000, finishedAt: 2000, entries: [{ machineId: 'rw', num: 9,
    label: 'Rower', cardio: true, settings: {}, sets: [{ distance: 1500, seconds: 420, level: 4 }] }] }]);
  open([{ machineId: 'rw', exercise: null }]);
  assert.ok(root.innerHTML.includes('id="set-level" type="number" inputmode="numeric" value="4"'),
    'without a target the last workout\'s level prefills');
  assert.ok(root.innerHTML.includes('Last: 1500 m · 7:00 · L4'), 'and "Last:" says it');
  store.clearActive();
  store.saveWorkouts([]);
  store.saveLayout(before);
}

// --- set goals: every slot counts against one; the "Sets planned" stepper and its Keep link ---
// slotGoal = the slot's target sets, else store's setGoalFor (exercise →
// machine → the app default of 3), null for cardio. The log button, the
// head line, Next's takeover, the overview rows and the tally all read it —
// in a free workout as much as in a planned one.
{
  const before = store.getLayout();
  const keepSettings = store.getSettings();
  const g = store.newLayout('Goal gym');
  g.machines.push(
    { id: 'g1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Chest'] },
    { id: 'g2', num: 2, label: 'Leg press', x: 6, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Quads'], targetSets: 2 },
    { id: 'g3', num: 3, label: 'Dumbbells', x: 12, y: 0, w: 4, h: 3, settingsFields: [],
      exercises: ['Curl', 'Row'], exerciseSets: { Curl: 4 } },
    { id: 'g4', num: 4, label: 'Rower', x: 18, y: 0, w: 4, h: 3, settingsFields: [], cardio: true },
  );
  store.saveLayout(g);
  store.saveWorkouts([]);
  const logSet = () => {
    byId.get('#set-weight').value = '40';
    byId.get('#set-reps').value = '10';
    byId.get('#set-rest').value = '0';
    byId.get('#log-set').listeners.click();
  };
  const show = (active) => {
    store.saveActive({ v: 2, startedAt: Date.now() - 60000, currentExercise: null, entries: [], ...active });
    byId.clear();
    renderTrain(root);
    return root.innerHTML;
  };
  const goalField = () => byId.get('#set-goal');
  const changeGoal = (value) => {
    goalField().value = value;
    goalField().listeners.change({ target: goalField() });
  };

  // a target-less slot at a plain machine: the app default is its goal
  let html = show({ id: 'w-goal', plan: [{ machineId: 'g1', exercise: null }, { machineId: 'g2', exercise: null }],
    currentMachineId: 'g1' });
  assert.ok(html.includes('id="goal-line">Goal: 3 sets · set 1/3<'), 'the head line states the goal and the set position');
  assert.ok(!html.includes('Target:'), 'no plan target: no Target line');
  assert.ok(html.includes('✓ Log set 1/3 — 40 kg × 10') || html.includes('✓ Log set 1/3 — 20 kg × 10'),
    'the log button counts against the goal');
  assert.ok(/id="set-goal" type="number" inputmode="numeric" value="3"/.test(html), 'the Sets planned stepper shows it');
  assert.ok(/id="sets-keep" class="linkish sets-keep" hidden>Keep 3 sets for #1</.test(html),
    'Keep is hidden while the value is what the machine resolves to');
  assert.ok(html.includes('id="log-set" class="btn btn-primary btn-big"'), 'Log set leads while the goal is open');
  assert.ok(/id="next-machine" class="btn btn-next btn-big">Next: #2/.test(html), 'Next is the plain next');
  logSet();
  logSet();
  assert.ok(root.innerHTML.includes('Log set 3/3'), 'two in: the third set is up');
  assert.equal(restNextUp(), 'set 3/3 — 40 kg × 10', 'and the rest screen promises it');
  logSet();
  html = root.innerHTML;
  assert.ok(html.includes('id="goal-line">Goal: 3 sets · ✓ done<'), 'three in: done');
  assert.ok(html.includes('✓ Log set — 40 kg × 10'), 'the log button stops counting');
  assert.ok(html.includes('id="log-set" class="btn btn-big"')
    && /id="next-machine" class="btn btn-primary btn-big">Next: #2/.test(html),
  'the goal met, Next takes over as the primary action — in a free workout too');
  assert.equal(restNextUp(), '#2 Leg press', 'the rest screen moves on');

  // the machine's own goal, and an exercise's over the machine's
  html = show({ id: 'w-goal2', plan: [{ machineId: 'g2', exercise: null }], currentMachineId: 'g2' });
  assert.ok(html.includes('Goal: 2 sets · set 1/2') && /id="set-goal"[^>]*value="2"/.test(html),
    'machine.targetSets is the machine\'s goal');
  html = show({ id: 'w-goal3', plan: [{ machineId: 'g3', exercise: 'Curl' }, { machineId: 'g3', exercise: 'Row' }],
    currentMachineId: 'g3', currentExercise: 'Curl' });
  assert.ok(html.includes('Goal: 4 sets · set 1/4'), 'exerciseSets[exercise] beats the machine\'s');
  html = show({ id: 'w-goal3', plan: [{ machineId: 'g3', exercise: 'Curl' }, { machineId: 'g3', exercise: 'Row' }],
    currentMachineId: 'g3', currentExercise: 'Row' });
  assert.ok(html.includes('Goal: 3 sets · set 1/3'), 'an exercise without one falls back to the machine, then the default');

  // cardio: no goal, no stepper, one bout is done
  html = show({ id: 'w-goal4', plan: [{ machineId: 'g4', exercise: null }, { machineId: 'g1', exercise: null }],
    currentMachineId: 'g4' });
  assert.ok(!html.includes('id="set-goal"') && !html.includes('Goal:'), 'a cardio machine has no set goal');
  assert.ok(html.includes('✓ Log set — '), 'and the log button counts nothing');
  byId.get('#set-distance').value = '1000';
  byId.get('#set-time').value = '10:00';
  byId.get('#set-rest').value = '0';
  byId.get('#log-set').listeners.click();
  assert.equal(restNextUp(), '#1 Chest press', 'one bout: the rest screen moves on');

  // the stepper: a goal for THIS workout, on the slot's target, no re-render
  html = show({ id: 'w-step', plan: [{ machineId: 'g1', exercise: null }, { machineId: 'g2', exercise: null }],
    currentMachineId: 'g1' });
  const rendered = root.innerHTML;
  changeGoal('4');
  assert.equal(root.innerHTML, rendered, 'the change re-renders nothing (the + is under the thumb)');
  assert.deepEqual(store.getActive().plan[0].target, { sets: 4 }, 'a sets-only target is written to the workout');
  assert.equal(goalField().value, 4, 'the field shows the clean value');
  assert.equal(byId.get('#goal-line').textContent, 'Goal: 4 sets · set 1/4', 'the head line follows in place');
  assert.equal(byId.get('#log-set').textContent, '✓ Log set 1/4 — 20 kg × 10',
    'so does the log button (the stub fields are empty, so it reads the prefill)');
  assert.equal(byId.get('#sets-keep').textContent, 'Keep 4 sets for #1', 'the Keep link offers the new count');
  assert.strictEqual(byId.get('#sets-keep').hidden, false, 'and shows itself');
  changeGoal('abc');
  assert.equal(goalField().value, 4, 'unreadable text keeps the goal it had');
  changeGoal('0');
  assert.equal(goalField().value, 1, 'a typed 0 lands on the minimum');
  assert.equal(byId.get('#goal-line').textContent, 'Goal: 1 set · set 1/1');
  changeGoal('4');
  byId.clear();
  renderTrain(root);
  assert.ok(root.innerHTML.includes('Goal: 4 sets · set 1/4') && /id="set-goal"[^>]*value="4"/.test(root.innerHTML),
    'a re-render reads the slot\'s goal back');
  assert.equal(stepper(root.innerHTML, 'set-weight'), '20', 'a sets-only target prefills nothing (no reps in it)');
  // Keep writes it onto the machine through store's setTargetSets
  byId.get('#sets-keep').listeners.click();
  assert.equal(store.getLayout().machines.find((m) => m.id === 'g1').targetSets, 4, 'Keep pins the machine\'s goal');
  assert.strictEqual(byId.get('#sets-keep').hidden, true, 'and hides itself');
  changeGoal('3');
  assert.strictEqual(byId.get('#sets-keep').hidden, false, '3 is no longer what the machine resolves to');
  byId.get('#sets-keep').listeners.click();
  assert.strictEqual(store.getLayout().machines.find((m) => m.id === 'g1').targetSets, undefined,
    'back at the app default Keep DELETES the machine\'s value instead of pinning it');
  // the goal met by the stepper: the takeover follows in place
  logSet();
  byId.clear();
  renderTrain(root);
  changeGoal('1');
  assert.ok(byId.get('#log-set').classList.contains('btn-primary') === false
    && byId.get('#next-machine, #next-unbound').classList.contains('btn-primary'),
  'a goal lowered to what is logged hands the lead to Next without a re-render');
  assert.equal(byId.get('#goal-line').textContent, 'Goal: 1 set · ✓ done');

  // a plan target keeps its load when the stepper changes its count
  html = show({ id: 'w-tgt', plan: [{ machineId: 'g1', exercise: null, target: { sets: 3, reps: 10, weight: 50 } }],
    currentMachineId: 'g1' });
  assert.ok(html.includes('Target: 3 × 10 @ 50 kg · set 1/3'), 'a plan target reads as before');
  changeGoal('4');
  assert.deepEqual(store.getActive().plan[0].target, { sets: 4, reps: 10, weight: 50 }, 'only the count changes');
  assert.equal(byId.get('#goal-line').textContent, 'Target: 4 × 10 @ 50 kg · set 1/4', 'the Target line says so');
  assert.equal(byId.get('#sets-keep').textContent, 'Keep 4 sets for #1');

  // Keep for an exercise writes exerciseSets; back at the MACHINE's goal it deletes the entry
  html = show({ id: 'w-ex', plan: [{ machineId: 'g3', exercise: 'Row' }], currentMachineId: 'g3', currentExercise: 'Row' });
  changeGoal('2');
  assert.equal(byId.get('#sets-keep').textContent, 'Keep 2 sets for #3 · Row', 'the link names the exercise');
  byId.get('#sets-keep').listeners.click();
  assert.deepEqual(store.getLayout().machines.find((m) => m.id === 'g3').exerciseSets, { Curl: 4, Row: 2 },
    'Keep writes the exercise\'s goal next to the existing one');
  changeGoal('3');
  byId.get('#sets-keep').listeners.click();
  assert.deepEqual(store.getLayout().machines.find((m) => m.id === 'g3').exerciseSets, { Curl: 4 },
    'at what the machine resolves to, the exercise\'s entry is deleted, not pinned');

  // the overview: rows count against the goal, the card header counts rows, the tally counts every goal
  const set = () => ({ reps: 10, weight: 40, at: Date.now() });
  show({ id: 'w-ov', plan: [{ machineId: 'g1', exercise: null }, { machineId: 'g2', exercise: null },
    { machineId: 'g4', exercise: null }], currentMachineId: null,
  entries: [{ machineId: 'g1', num: 1, label: 'Chest press', settings: {}, sets: [set(), set(), set()] },
    { machineId: 'g2', num: 2, label: 'Leg press', settings: {}, sets: [set()] }] });
  assert.deepEqual([...root.innerHTML.matchAll(/class="plan-status[^"]*">([^<]*)</g)].map((m) => m[1]),
    ['✓ 3/3 sets', '1/2 sets', 'open'], 'rows read progress against each slot\'s goal');
  assert.ok(root.innerHTML.includes('<h2>Exercises <span class="muted">1 of 3 done</span></h2>'),
    'the card header counts the rows done');
  assert.ok(root.innerHTML.includes('4/5 target sets'), 'the tally counts every slot with a goal, cardio none');

  store.clearActive();
  store.saveSettings(keepSettings);
  store.saveWorkouts([]);
  store.saveLayout(before);
}

// --- "Next" in a free workout: a free slot with no set is no stop; a suggestion when the plan has nothing open ---
// The ask (2026-10-21): Next named whatever machine was opened last. A slot
// grown by opening a machine carries `free: true`; with no set it is where
// you merely stood (nextOpenSlot skips it, the overview still lists it).
// With nothing open, suggestNext proposes a machine not trained today: the
// history's successor, else the most open primary muscles, ties by the walk
// then the number — on the same Next button, "Try next: #N Label →".
{
  const before = store.getLayout();
  const g = store.newLayout('Free gym');
  g.machines.push(
    { id: 'fa', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Chest'] },
    { id: 'fb', num: 2, label: 'Lat pulldown', x: 6, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Lats'] },
    { id: 'fc', num: 3, label: 'Leg press', x: 12, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Quads'] },
    { id: 'fd', num: 4, label: 'Leg curl', x: 18, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Hamstrings', 'Glutes'] },
    { id: 'fe', num: 5, label: 'Pec deck', x: 40, y: 20, w: 4, h: 3, settingsFields: [], muscles: ['Chest', 'Shoulders'] },
    { id: 'ff', num: 6, label: 'Dumbbells', x: 24, y: 0, w: 4, h: 3, settingsFields: [], exercises: ['Curl', 'Row'] },
  );
  store.saveLayout(g);
  store.saveWorkouts([]);
  const layout = store.getLayout();
  const at = (id) => layout.machines.find((m) => m.id === id);
  const set = (t = Date.now()) => ({ reps: 10, weight: 40, at: t });
  const sets3 = () => [set(), set(), set()];
  const entryAt = (id, sets = sets3()) => ({ machineId: id, num: at(id).num, label: at(id).label, settings: {}, sets });
  const free = (machineId) => ({ machineId, exercise: null, free: true });
  const show = (active) => {
    store.saveActive({ v: 2, startedAt: Date.now() - 60000, currentExercise: null, entries: [], ...active });
    byId.clear();
    renderTrain(root);
    return root.innerHTML;
  };

  // the ask's scenario: A (3 sets) · B (opened, 0 sets) · C on screen
  let html = show({ id: 'w-free', plan: [free('fa'), free('fb'), free('fc')], currentMachineId: 'fc',
    entries: [entryAt('fa')] });
  assert.ok(!/Next: #2/.test(html), 'B, merely opened, is not "Next"');
  assert.ok(/id="next-machine" class="btn btn-next btn-big" data-suggested="1">Try next: #4\s+Leg curl\b/.test(html),
    'no history: the machine with the most open primary muscles is suggested, on the Next button');
  assert.ok(!html.includes('Busy?') && !html.includes('Closer:'), 'no "Busy?" row and no "Closer:" hint under a suggestion');
  assert.ok(html.includes('id="locate-next"'), 'the 📍 still answers "where is it?"');
  assert.ok(html.includes('id="change-machine" class="btn">Change machine / overview'), 'the overview stays one tap away');
  // the overview still lists the free slot
  html = show({ id: 'w-free', plan: [free('fa'), free('fb'), free('fc')], currentMachineId: null, entries: [entryAt('fa')] });
  assert.deepEqual([...html.matchAll(/class="plan-status[^"]*">([^<]*)</g)].map((m) => m[1]), ['✓ 3/3 sets', 'open', 'open'],
    'the overview still lists where you stood');
  // a free slot WITH a set is a stop like any other
  html = show({ id: 'w-free2', plan: [free('fa'), free('fb'), free('fc')], currentMachineId: 'fc',
    entries: [entryAt('fa'), entryAt('fb', [set()])] });
  assert.ok(/id="next-machine" class="btn btn-next btn-big">Next: #2\s+Lat pulldown\b/.test(html),
    'one set at B: B is a plain "Next" again (1/3, open)');
  // the suggestion taken: a free slot grows, the walk moves there
  show({ id: 'w-take', plan: [free('fa'), free('fc')], currentMachineId: 'fc', entries: [entryAt('fa'), entryAt('fc')] });
  assert.ok(/data-suggested="1">Try next: #4/.test(root.innerHTML));
  assert.equal(restNextUp(), 'try #4 Leg curl', 'the rest screen promises the suggestion, as one');
  assert.ok(/id="next-machine" class="btn btn-primary btn-big" data-suggested="1"/.test(root.innerHTML),
    'C\'s goal met: the suggestion leads, like a plan\'s Next would');
  byId.get('#next-machine').listeners.click();
  const taken = store.getActive();
  assert.equal(taken.currentMachineId, 'fd', 'the tap switches to it');
  assert.deepEqual(taken.plan.at(-1), { machineId: 'fd', exercise: null, free: true }, 'and grows a free slot for it');
  assert.ok(taken.visits.at(-1).machineId === 'fd' && !('busy' in taken.visits.at(-1)), 'through switchMachine: a visit, no busy mark');
  // every machine trained today: no Next button, the overview button instead
  html = show({ id: 'w-all', plan: [free('fa'), free('fb'), free('fc'), free('fd'), free('fe'), free('ff')], currentMachineId: 'fc',
    entries: ['fa', 'fb', 'fc', 'fd', 'fe', 'ff'].map((id) => entryAt(id)) });
  assert.ok(!html.includes('id="next-machine"') && html.includes('class="btn btn-next btn-big">Workout overview →'),
    'nothing left to try: "Workout overview →" as before');

  // suggestNext itself: candidates, the history's successor, the fallbacks, the tie-breaks
  const active = { plan: [free('fa'), free('fc')], currentMachineId: 'fc', entries: [entryAt('fa')] };
  assert.equal(suggestNext(active, layout, at('fc'), {}).id, 'fd', 'most open primary muscles (Hamstrings + Glutes)');
  assert.equal(suggestNext(active, layout, at('fc'), { earlier: [entryAt('fd')] }).id, 'fb',
    'trained in a workout finished today is trained: Lats (1 open, 6 away) beats the pec deck (1 open, far)');
  assert.equal(suggestNext(active, layout, at('fc'), { earlier: [entryAt('fd'), entryAt('fb')] }).id, 'ff',
    'an untagged machine counts as one open muscle and wins the tie by the shorter walk');
  const t0 = Date.now() - 86400000 * 3;
  const habit = (k) => ({
    id: `h${k}`, startedAt: t0 + k * 1000, finishedAt: t0 + k * 1000 + 600000,
    entries: [entryAt('fc', [set(t0 + k * 1000 + 1)]), entryAt('fe', [set(t0 + k * 1000 + 2)])],
  });
  const workouts = [habit(1), habit(2)];
  assert.equal(suggestNext(active, layout, at('fc'), { workouts }).id, 'fe',
    'with history the usual successor wins over the open muscles and the walk');
  assert.equal(suggestNext(active, layout, at('fc'), { workouts, earlier: [entryAt('fe')] }).id, 'fd',
    'but only while it is still open today');
  assert.equal(suggestNext({ ...active, entries: ['fa', 'fb', 'fd', 'fe', 'ff'].map((id) => entryAt(id)) }, layout, at('fc'), {}), null,
    'nothing untrained: null');
  assert.equal(suggestNext(active, { ...layout, grid: { w: -40, h: 30 } }, at('fc'), {}).id, 'fd',
    'a grid that is no floor: straight lines, never a crash');
  store.saveWorkouts(workouts);
  html = show({ id: 'w-hist', plan: [free('fa'), free('fc')], currentMachineId: 'fc', entries: [entryAt('fa')] });
  assert.ok(/Try next: #5\s+Pec deck\b/.test(html), 'the screen reads the history too');
  store.saveWorkouts([]);

  // where free slots come from: the log screen, the picker, a sibling splice — never a source
  show({ id: 'w-grow', plan: [], currentMachineId: 'fe' });
  assert.deepEqual(store.getActive().plan, [free('fe')], 'the log screen grows a free slot');
  show({ id: 'w-grow2', plan: [free('fa')], currentMachineId: null });
  withPicker((picker) => {
    renderTrain(root);
    picker.parts.get('.pick-num').value = '2';
    picker.parts.get('.pick-go').listeners.click();
  });
  assert.deepEqual(store.getActive().plan.at(-1), free('fb'), 'the overview picker grows a free slot');
  show({ id: 'w-split', plan: [{ machineId: 'ff', exercise: 'Curl', free: true }], currentMachineId: 'ff', currentExercise: 'Row' });
  assert.deepEqual(store.getActive().plan, [{ machineId: 'ff', exercise: 'Curl', free: true }, { machineId: 'ff', exercise: 'Row', free: true }],
    'a sibling spliced in after a free slot is free');
  show({ id: 'w-split2', plan: [{ machineId: 'ff', exercise: 'Curl' }], currentMachineId: 'ff', currentExercise: 'Row' });
  assert.deepEqual(store.getActive().plan, [{ machineId: 'ff', exercise: 'Curl' }, { machineId: 'ff', exercise: 'Row' }],
    'after a committed slot it carries no marker');
  store.clearActive();
  startWorkoutFrom({ entries: [entryAt('fa'), entryAt('fb')] });
  assert.deepEqual(store.getActive().plan, [{ machineId: 'fa', exercise: null }, { machineId: 'fb', exercise: null }],
    'slots from a source (plan or repeat) carry no marker');
  store.clearActive();
  store.saveWorkouts([]);
  store.saveLayout(before);
}

// --- "Start another routine": one row per machine SET, not per order ---
// An unnamed routine was keyed by its machine ids in training order, so
// A→B and B→A made two rows for one routine.
{
  const before = store.getLayout();
  const g = store.newLayout('Routine gym');
  for (const [id, num] of [['ra', 1], ['rb', 2], ['rc', 3]]) {
    g.machines.push({ id, num, label: `R${num}`, x: num * 5, y: 0, w: 4, h: 3, settingsFields: [] });
  }
  store.saveLayout(g);
  store.clearActive();
  const w = (id, t, ids) => ({ id, startedAt: t, entries: ids.map((m) => ({ machineId: m, num: 0, label: 'x', settings: {}, sets: [{ reps: 8, weight: 10 }] })) });
  store.saveWorkouts([
    w('r1', 1755000000000, ['ra', 'rb']),
    w('r2', 1755100000000, ['rb', 'ra']),
    w('r3', 1755200000000, ['rc']),
  ]);
  byId.clear();
  goToStart();
  renderTrain(root);
  const rows = (root.innerHTML.match(/class="btn btn-inline repeat-w" data-wid="[^"]*"/g) ?? []);
  assert.equal(rows.length, 1, `A→B and B→A are one routine row — ${rows.join(', ')}`);
  assert.ok(rows[0].includes('data-wid="r2"'), 'the newer of the two stands for it');
  store.saveWorkouts([]);
  store.saveLayout(before);
  goToHub();
}

// --- the log screen parses the history ONCE per render ---
// renderLog read getWorkouts() four to five times (prefill, grip default,
// hints, assist goal, finished today / the Next suggestion); now one list
// is read and handed down. The local walks match store's own.
{
  const before = store.getLayout();
  const g = store.newLayout('Read-once gym');
  g.machines.push({ id: 'ro', num: 1, label: 'Row', x: 0, y: 0, w: 4, h: 3, settingsFields: [], grips: ['Rope', 'V-bar'] });
  g.machines.push({ id: 'as', num: 2, label: 'Dip', x: 6, y: 0, w: 4, h: 3, settingsFields: [], assisted: true });
  store.saveLayout(g);
  const e = (machineId, grip, weight) => ({ machineId, num: 1, label: 'x', settings: {}, ...(grip ? { grip } : {}),
    ...(machineId === 'as' ? { assisted: true } : {}), sets: [{ reps: 8, weight }] });
  const hist = [
    { id: 'h1', startedAt: Date.now() - 3 * 864e5, entries: [e('ro', null, 30), e('as', null, 20)] },
    { id: 'h2', startedAt: Date.now() - 2 * 864e5, entries: [e('ro', 'Rope', 35)] },
    { id: 'h3', startedAt: Date.now() - 864e5, entries: [e('ro', 'V-bar', 40), e('as', null, 15)] },
  ];
  store.saveWorkouts(hist);
  const { lastEntryIn, lastGripIn } = store;
  const ws = store.getWorkouts();
  for (const [ex, grip, anyGrip] of [[null, null, false], [null, null, true], [null, 'Rope', false], [null, 'Rope', true],
    [null, 'Gone', true], ['Nope', null, true]]) {
    for (const id of ['ro', 'as', 'zz']) {
      assert.deepEqual(lastEntryIn(ws, id, ex, grip, { anyGrip }), store.lastEntryFor(id, ex, grip, { anyGrip }),
        `lastEntryIn = store.lastEntryFor (${id}, ${ex}, ${grip}, ${anyGrip})`);
      assert.equal(lastGripIn(ws, id, ex), store.lastGripFor(id, ex), `lastGripIn = store.lastGripFor (${id}, ${ex})`);
    }
  }
  const reads = () => {
    let n = 0;
    const get = localStorage.getItem;
    localStorage.getItem = (k) => { if (/workouts$/.test(k)) n++; return get(k); };
    return { done: () => { localStorage.getItem = get; return n; } };
  };
  for (const machineId of ['ro', 'as']) {
    store.saveActive({ v: 2, id: `w-ro-${machineId}`, startedAt: Date.now(), plan: [{ machineId, exercise: null }],
      currentMachineId: machineId, currentExercise: null, entries: [] });
    byId.clear();
    const r = reads();
    renderTrain(root);
    assert.equal(r.done(), 1, `one history read per log-screen render (${machineId})`);
  }
  assert.equal(store.getActive().currentMachineId, 'as');
  store.clearActive();
  store.saveWorkouts([]);
  store.saveLayout(before);
}

console.log('train plan construction: all assertions passed');
