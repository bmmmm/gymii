// Logic-level test for history.js: the workout-name filter (it narrows
// the WHOLE view, not just the list), the full editor (add/remove sets and
// machines, edit the date) and logging a workout after the fact.
// Run with: node test/history.test.mjs
import { strict as assert } from 'node:assert';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const store = await import(new URL('../js/store.js', import.meta.url).href);
const { renderHistory } = await import(new URL('../js/history.js', import.meta.url).href);

// --- fixture: three named workouts across two routines ---

const gym = store.newGym('History test gym');
[
  ['m1', 14, 'Leg press', ['Quads']],
  ['m2', 3, 'Lat pulldown', ['Lats']],
  ['m3', 7, 'Chest press', ['Chest']],
].forEach(([id, num, label, muscles]) => gym.machines.push({
  id, num, label, x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles,
}));
store.saveGym(gym);

const entry = (id, num, label, sets) => ({ machineId: id, num, label, settings: {}, sets });
store.saveWorkouts([
  {
    id: 'w1', startedAt: Date.UTC(2026, 7, 1, 10), finishedAt: Date.UTC(2026, 7, 1, 11), name: 'Leg day',
    entries: [entry('m1', 14, 'Leg press', [{ reps: 10, weight: 80 }])],
  },
  {
    id: 'w2', startedAt: Date.UTC(2026, 7, 3, 10), finishedAt: Date.UTC(2026, 7, 3, 11), name: 'Pull day',
    entries: [entry('m2', 3, 'Lat pulldown', [{ reps: 12, weight: 45 }])],
  },
  {
    id: 'w3', startedAt: Date.UTC(2026, 7, 5, 10), finishedAt: Date.UTC(2026, 7, 5, 11), name: 'Leg day',
    entries: [entry('m1', 14, 'Leg press', [{ reps: 10, weight: 85 }])],
  },
]);

// --- DOM stubs: enough for innerHTML assertions and firing handlers ---

const stubEl = (over = {}) => ({
  innerHTML: '',
  value: '',
  textContent: '',
  disabled: false,
  dataset: {},
  style: {},
  listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
  querySelector: () => stubEl(),
  querySelectorAll: () => [],
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  ...over,
});

let byId = new Map();
const root = {
  innerHTML: '',
  // stable per selector, so a handler registered on it can be fired again
  querySelector(sel) {
    if (!byId.has(sel)) byId.set(sel, stubEl());
    return byId.get(sel);
  },
  querySelectorAll: () => [],
};
const render = () => { byId = new Map(); renderHistory(root); };

// A click whose closest() answers ONLY the selector under test — history's
// handler walks a chain of closest() calls, so a catch-all stub would make
// the first branch swallow every event.
const clickOn = (sel, dataset = {}, card = null) => ({
  target: {
    closest: (q) => (q === sel ? { dataset, classList: { contains: () => false } }
      : q === 'details' ? card : null),
  },
});
const changeOn = (cls, value, card = null) => ({
  target: {
    value, dataset: {}, classList: { contains: (c) => c === cls }, closest: () => card,
  },
});

// --- the name filter narrows the whole view ---

render();
assert.ok(root.innerHTML.includes('id="name-filter"'), 'name chips render');
assert.ok(root.innerHTML.includes('Leg day') && root.innerHTML.includes('· 2'),
  'each name carries how often it was trained');
// match the <option> markup, not the bare label — the past-workout
// placeholder mentions these machines too
const options = () => [...root.innerHTML.matchAll(/<option value="[^"]*">([^<]+)</g)]
  .map((m) => m[1].trim());
assert.deepEqual([...new Set(options())].sort(),
  ['#14 Leg press', '#3 Lat pulldown', 'All machines'],
  'unfiltered, every trained machine is selectable');

root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: 'Leg day' }));
assert.ok(root.innerHTML.includes('Workouts — Leg day'), 'the heading names the active filter');
assert.ok(!options().includes('#3 Lat pulldown'),
  'machine lists follow the filter, not just the workout list');

// the filter clears itself when its last workout loses that name
store.saveWorkouts(store.getWorkouts().map((w) => (w.name === 'Leg day' ? { ...w, name: 'Legs' } : w)));
render();
assert.ok(!root.innerHTML.includes('Workouts — Leg day'), 'a filter with nothing left resets');
assert.ok(options().includes('#3 Lat pulldown'), 'and the full view comes back');

// --- the editor: add a set, add a machine, move the date ---

const list = () => root.querySelector('#workout-list');
list().listeners.click(clickOn('.edit-w', { wid: 'w1' }));
assert.ok(list().innerHTML.includes('edit-save'), 'the card switches to edit mode');
assert.ok(list().innerHTML.includes('+ Set') && list().innerHTML.includes('+ Machine'),
  'both adders render');
assert.ok(list().innerHTML.includes('class="edit-date"'), 'so do the date and time fields');

list().listeners.click(clickOn('.set-add', { ei: '0' }));
list().listeners.click(clickOn('.set-add', { ei: '0' }));

// + Machine reads the <select> next to it
const pickCard = { querySelector: () => stubEl({ value: 'm3' }) };
list().listeners.click(clickOn('.entry-add', {}, pickCard));

// the date fields are read together off the same card
const dateCard = {
  querySelector: (sel) => stubEl({ value: sel === '.edit-date' ? '2026-08-08' : '07:15' }),
};
list().listeners.change(changeOn('edit-date', '2026-08-08', dateCard));

list().listeners.click(clickOn('.edit-name-chips .chip', { name: 'Morning legs' }));
list().listeners.click(clickOn('.edit-save'));

const saved = store.getWorkouts().find((w) => w.id === 'w1');
assert.equal(saved.entries.length, 2, 'the added machine survives the save');
assert.deepEqual(saved.entries[0].sets, [
  { reps: 10, weight: 80 }, { reps: 10, weight: 80 }, { reps: 10, weight: 80 },
], 'a added set copies the previous one');
assert.ok(saved.entries[0].sets.every((st) => !('at' in st)),
  'sets added by editing never claim a live timestamp');
assert.deepEqual(saved.entries[1], {
  machineId: 'm3', num: 7, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 0 }],
}, 'the added machine is snapshotted like the log screen does it');
assert.equal(saved.name, 'Morning legs', 'the name chip names the workout');
const when = new Date(saved.startedAt);
assert.equal(when.getFullYear(), 2026);
assert.equal(when.getDate(), 8, 'the date moved');
assert.equal(when.getHours(), 7, 'and so did the time');
assert.equal(saved.finishedAt - saved.startedAt, 3600000,
  'moving the start keeps the duration');
// w1 moved from 1 Aug to 8 Aug, so it belongs behind w2 (3rd) and w3 (5th)
assert.deepEqual(store.getWorkouts().map((w) => w.id), ['w2', 'w3', 'w1'],
  'the re-dated workout sorts into place');

// removing a station drops it
list().listeners.click(clickOn('.edit-w', { wid: 'w1' }));
list().listeners.click(clickOn('.entry-del', { ei: '1' }));
list().listeners.click(clickOn('.edit-save'));
assert.equal(store.getWorkouts().find((w) => w.id === 'w1').entries.length, 1,
  'a removed station is gone after saving');

// --- logging a workout after the fact, straight into edit mode ---

render();
root.querySelector('#past-date').value = '2026-08-02';
root.querySelector('#past-time').value = '19:30';
root.querySelector('#past-text').value = '#14 Leg press 3x10 90\nno such machine 3x10';
root.querySelector('#past-log').listeners.click();

const logged = store.getWorkouts().find((w) => new Date(w.startedAt).getDate() === 2);
assert.ok(logged, 'the past workout is stored');
assert.equal(logged.entries[0].sets.length, 3, '3x10 becomes three real sets');
assert.ok(root.querySelector('#past-msg').textContent.includes('no such machine'),
  'a line with no findable machine is reported, not invented');
assert.ok(list().innerHTML.includes('edit-save'),
  'the fresh workout reopens in edit mode for a once-over');

// an empty history still offers the form — that is how paper users start
store.saveWorkouts([]);
render();
assert.ok(root.innerHTML.includes('No workouts yet.'), 'empty state renders');
assert.ok(root.innerHTML.includes('id="past-log"'), 'and still lets you log a past workout');
root.querySelector('#past-date').value = '2026-07-30';
root.querySelector('#past-time').value = '08:00';
root.querySelector('#past-text').value = '#3 Lat pulldown 4x12 50';
root.querySelector('#past-log').listeners.click();
assert.equal(store.getWorkouts().length, 1, 'logging works from the empty screen too');

// --- the muscle card: usage bars that ARE the filter ---

store.saveWorkouts([
  {
    id: 'mw1', startedAt: Date.UTC(2026, 7, 1, 10), finishedAt: Date.UTC(2026, 7, 1, 11), name: 'Leg day',
    entries: [entry('m1', 14, 'Leg press', [{ reps: 10, weight: 80 }, { reps: 10, weight: 80 }])],
  },
  {
    id: 'mw2', startedAt: Date.UTC(2026, 7, 3, 10), finishedAt: Date.UTC(2026, 7, 3, 11), name: 'Pull day',
    entries: [entry('m2', 3, 'Lat pulldown', [{ reps: 12, weight: 47.5 }])],
  },
]);

render();
assert.ok(root.innerHTML.includes('id="muscle-list"'), 'the muscle card renders');
assert.ok(root.innerHTML.includes('Quads') && root.innerHTML.includes('Lats'),
  'every gym muscle gets a row');
assert.ok(root.innerHTML.includes('bar-fill'), 'rows carry usage bars');

// tapping a row narrows the WHOLE view, like the name filter does
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Lats' }));
assert.ok(root.innerHTML.includes('Workouts — Lats'), 'the heading names the muscle');
assert.ok(!options().includes('#14 Leg press'),
  'machine selects follow the muscle filter too');
assert.ok(root.innerHTML.includes('All muscles'), 'an explicit way out renders');

// the same row again clears it
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Lats' }));
assert.ok(!root.innerHTML.includes('Workouts — Lats'), 're-tap clears the filter');
assert.ok(options().includes('#14 Leg press'), 'and the full view comes back');

// a muscle with zero sets still filters (the "neglected groups" feature) —
// the Progress picker states its emptiness instead of rendering optionless
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Chest' }));
assert.ok(root.innerHTML.includes('No machines match this filter'),
  'the chart picker explains an empty machine list');
// the reset row carries a pressed state like every other row in the group
assert.ok(/data-muscle=""\s+aria-pressed="false"/.test(root.innerHTML),
  'the All-muscles reset row announces its unpressed state');
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: '' }));

// name × muscle can produce nothing — the list says so, and the card still
// lists every muscle so the filter is never a dead end
root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: 'Pull day' }));
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Quads' }));
assert.ok(list().innerHTML.includes('No workouts match this filter.'),
  'an empty combination is stated, not blank');
assert.ok(root.innerHTML.includes('data-muscle="Lats"'),
  'other muscles stay reachable while one is selected');
root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: '' }));

// editing under an active filter must keep the WHOLE workout — the filter
// narrows workouts, never their entries. A mixed workout is both the
// reason the filter matches and the thing a narrowed save would maim.
store.saveWorkouts([...store.getWorkouts(), {
  id: 'mw3', startedAt: Date.UTC(2026, 7, 4, 10), finishedAt: Date.UTC(2026, 7, 4, 11), name: 'Full body',
  entries: [
    entry('m1', 14, 'Leg press', [{ reps: 10, weight: 82.5 }]),
    entry('m2', 3, 'Lat pulldown', [{ reps: 12, weight: 45 }]),
  ],
}]);
render();
// the Quads filter is still active from the block above — prove it before
// editing, or this test passes without a filter in play at all (a re-tap
// here would TOGGLE it off and make the assertion below vacuous)
assert.ok(root.innerHTML.includes('Workouts — Quads'),
  'the muscle filter is active going into the edit');
list().listeners.click(clickOn('.edit-w', { wid: 'mw3' }));
list().listeners.click(clickOn('.set-add', { ei: '0' }));
list().listeners.click(clickOn('.edit-save'));
const savedFiltered = store.getWorkouts().find((w) => w.id === 'mw3');
assert.equal(savedFiltered.entries.length, 2,
  'a save under a muscle filter keeps the entries that did not match');
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Quads' }));

// a freshly logged past workout resets the muscle filter, or it could
// vanish behind it and never open in edit mode
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Lats' }));
root.querySelector('#past-date').value = '2026-08-04';
root.querySelector('#past-time').value = '09:00';
root.querySelector('#past-text').value = '#14 Leg press 3x10 90';
root.querySelector('#past-log').listeners.click();
assert.ok(list().innerHTML.includes('edit-save'),
  'the logged workout opens in edit mode despite the previous filter');

// the filter clears itself when its muscle leaves the gym, and orphaned
// sets are counted instead of silently dropped
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Lats' }));
assert.ok(root.innerHTML.includes('Workouts — Lats'));
store.saveGym({ ...store.getGym(), machines: store.getGym().machines.filter((m) => m.id !== 'm2') });
render();
assert.ok(!root.innerHTML.includes('Workouts — Lats'), 'a stranded muscle filter resets');
assert.ok(root.innerHTML.includes("can't be attributed"),
  'sets of a deleted machine are reported, not hidden');

console.log('history: all assertions passed');
