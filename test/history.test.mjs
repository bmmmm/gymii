// Logic-level test for history.js: the two screens (overview, Workouts)
// and what survives a re-render, the workout-name filter (it narrows the
// WHOLE view, not just the list), the full editor (add/remove sets and
// machines, edit the date) and logging a workout after the fact.
// Run with: node test/history.test.mjs
import './helpers/localstorage.mjs'; // FIRST: installs the stub
import { strict as assert } from 'node:assert';

const store = await import(new URL('../js/store.js', import.meta.url).href);
const { renderHistory } = await import(new URL('../js/history.js', import.meta.url).href);

// --- fixture: three named workouts across two routines ---

const layout = store.newLayout('History test layout');
[
  ['m1', 14, 'Leg press', ['Quads']],
  ['m2', 3, 'Lat pulldown', ['Lats']],
  ['m3', 7, 'Chest press', ['Chest']],
].forEach(([id, num, label, muscles]) => layout.machines.push({
  id, num, label, x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles,
}));
store.saveLayout(layout);

const entry = (id, num, label, sets) => ({ machineId: id, num, label, settings: {}, sets });
store.saveWorkouts([
  {
    id: 'w1', startedAt: Date.UTC(2026, 7, 1, 10), finishedAt: Date.UTC(2026, 7, 1, 11), name: 'Leg day',
    entries: [entry('m1', 14, 'Leg press', [{ reps: 10, weight: 80, at: Date.UTC(2026, 7, 1, 10, 5), rir: 2 }])],
    visits: [{ in: Date.UTC(2026, 7, 1, 10), out: Date.UTC(2026, 7, 1, 10, 20) }],
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
  scrollTop: 0,
  // stable per selector, so a handler registered on it can be fired again
  querySelector(sel) {
    if (!byId.has(sel)) byId.set(sel, stubEl());
    return byId.get(sel);
  },
  querySelectorAll: () => [],
};
const render = () => { byId = new Map(); renderHistory(root); };
// a tab tap: app.js passes { entry: true }
const enter = () => { byId = new Map(); renderHistory(root, { entry: true }); };

// The stub hands back EVERY selector, and a stub keeps the listener of a
// render long gone — so every screen change asserts where it starts and
// where it lands, or a stale listener would let a test pass on a screen
// that no longer shows that control.
const onOverview = () => root.innerHTML.includes('<h1>History</h1>');
const onWorkouts = () => root.innerHTML.includes('<h1>Workouts</h1>');
const openWorkouts = () => {
  assert.ok(onOverview() && root.innerHTML.includes('id="open-workouts"'),
    'the Workouts screen is opened from the overview');
  root.querySelector('#open-workouts').listeners.click();
  assert.ok(onWorkouts(), '"All workouts" opens the Workouts screen');
};
const backToOverview = () => {
  assert.ok(onWorkouts() && root.innerHTML.includes('id="hist-back"'), 'the back row is on show');
  root.querySelector('#hist-back').listeners.click();
  assert.ok(onOverview(), '"‹ History" returns to the overview');
};

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
assert.ok(onOverview(), 'History opens on its overview');
assert.ok(root.innerHTML.includes('id="name-filter"'), 'name chips render');
assert.ok(root.innerHTML.includes('Leg day') && root.innerHTML.includes('· 2'),
  'each name carries how often it was trained');
// match the <option> markup, not the bare label — the past-workout
// placeholder mentions these machines too
const options = () => [...root.innerHTML.matchAll(/<option value="[^"]*">([^<]+)</g)]
  .map((m) => m[1].trim());
assert.deepEqual([...new Set(options())].sort(),
  ['#14 Leg press', '#3 Lat pulldown'],
  'unfiltered, every trained machine is selectable');

// Two screens. The overview analyses; the Workouts screen holds what you
// did, day by day and workout by workout, and the form that adds one.
const order = (heads) => heads.map((h) => root.innerHTML.search(new RegExp(`<h2[^>]*>${h}`)));
const overviewOrder = order(['Progress', 'Muscles']);
assert.ok(overviewOrder.every((i) => i > 0), 'every overview card renders');
assert.deepEqual(overviewOrder.slice().sort((a, b) => a - b), overviewOrder,
  'the overview: progress, then muscles');
assert.ok(!root.innerHTML.includes('id="workout-list"'), 'the full list is not on the overview');
assert.ok(root.innerHTML.includes('All workouts (3) ›'), 'the way in counts what it leads to');
openWorkouts();
const workoutsOrder = order(['Training days', 'Workouts', 'Log a past workout']);
assert.ok(workoutsOrder.every((i) => i > 0), 'every Workouts-screen card renders');
assert.deepEqual(workoutsOrder.slice().sort((a, b) => a - b), workoutsOrder,
  'the Workouts screen: training days, the list, log a past workout');
assert.ok(!/<h2[^>]*>Progress/.test(root.innerHTML), 'and no analysis card');
backToOverview();

// a changed screen is navigation and starts at the top; an in-place
// re-render (a filter tap) keeps the scroll where the user left it
root.scrollTop = 480;
root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: '' }));
assert.equal(root.scrollTop, 480, 'a re-render on the same screen keeps the scroll');
openWorkouts();
assert.equal(root.scrollTop, 0, 'a screen change resets it');
backToOverview();

root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: 'Leg day' }));
assert.ok(onOverview(), 'a filter tap stays on the screen it was made on');
assert.ok(!options().includes('#3 Lat pulldown'),
  'machine lists follow the filter, not just the workout list');
assert.ok(root.innerHTML.includes('All workouts (2) ›'), 'and so does the count');
openWorkouts();
assert.ok(root.innerHTML.includes('Workouts — Leg day'), 'the heading names the active filter');
assert.ok(root.innerHTML.includes('id="name-filter"'), 'the name chips sit on this screen too');

// the filter clears itself when its last workout loses that name
store.saveWorkouts(store.getWorkouts().map((w) => (w.name === 'Leg day' ? { ...w, name: 'Legs' } : w)));
render();
assert.ok(onWorkouts(), 'a re-render keeps the screen');
assert.ok(root.innerHTML.includes('<h2>Workouts</h2>'), 'a filter with nothing left resets');
backToOverview();
assert.ok(options().includes('#3 Lat pulldown'), 'and the full view comes back');

// a tab tap is the one thing that returns to the overview
openWorkouts();
enter();
assert.ok(onOverview(), 'renderHistory(root, { entry: true }) lands on the overview');

// --- the editor: add a set, add a machine, move the date ---

const list = () => root.querySelector('#workout-list');
openWorkouts();
// the heatmap month is "where in time": a save keeps it, an entry resets it
const hmTitle = () => root.querySelector('#hm-title').textContent;
const thisMonth = hmTitle();
root.querySelector('#hm-prev').listeners.click();
const pickedMonth = hmTitle();
assert.notEqual(pickedMonth, thisMonth, 'the heatmap steps back a month');
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

assert.ok(onWorkouts(), 'a save stays on the Workouts screen');
assert.equal(hmTitle(), pickedMonth, 'and keeps the heatmap month');

const saved = store.getWorkouts().find((w) => w.id === 'w1');
assert.equal(saved.entries.length, 2, 'the added machine survives the save');
assert.deepEqual(saved.entries[0].sets.slice(1), [
  { reps: 10, weight: 80 }, { reps: 10, weight: 80 },
], 'a added set copies the previous one');
assert.ok(saved.entries[0].sets.slice(1).every((st) => !('at' in st)),
  'sets added by editing never claim a live timestamp');
assert.ok(saved.entries[0].sets.slice(1).every((st) => !('rir' in st)),
  'nor a rating: a copied set was never rated');
assert.equal(saved.entries[0].sets[0].rir, 2, 'the original set keeps its rating');
assert.equal(saved.entries[0].sets[0].at - saved.startedAt, 5 * 60000,
  'a date edit moves set.at with the workout (offset unchanged)');
assert.equal(saved.visits[0].out - saved.startedAt, 20 * 60000,
  'and the visits');
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

// removing a machine drops it
list().listeners.click(clickOn('.edit-w', { wid: 'w1' }));
list().listeners.click(clickOn('.entry-del', { ei: '1' }));
list().listeners.click(clickOn('.edit-save'));
assert.equal(store.getWorkouts().find((w) => w.id === 'w1').entries.length, 1,
  'a removed machine is gone after saving');
enter();
openWorkouts();
assert.equal(hmTitle(), thisMonth, 'an entry brings the heatmap back to this month');

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
enter();
assert.ok(root.innerHTML.includes('No workouts yet.'), 'empty state renders');
assert.ok(root.innerHTML.includes('id="past-log"'), 'and still lets you log a past workout');
root.querySelector('#past-date').value = '2026-07-30';
root.querySelector('#past-time').value = '08:00';
root.querySelector('#past-text').value = '#3 Lat pulldown 4x12 50';
root.querySelector('#past-log').listeners.click();
assert.equal(store.getWorkouts().length, 1, 'logging works from the empty screen too');
assert.ok(onWorkouts() && list().innerHTML.includes('edit-save'),
  'and opens it in edit mode on the Workouts screen, where the list lives');

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

enter();
assert.ok(root.innerHTML.includes('id="muscle-list"'), 'the muscle card renders');
assert.ok(root.innerHTML.includes('Quads') && root.innerHTML.includes('Lats'),
  'every layout muscle gets a row');
assert.ok(root.innerHTML.includes('bar-fill'), 'rows carry usage bars');

// tapping a row narrows the WHOLE view, like the name filter does
const pressed = (mu) => new RegExp(`data-muscle="${mu}" aria-pressed="true"`).test(root.innerHTML);
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Lats' }));
assert.ok(onOverview() && pressed('Lats'), 'the row shows its filter is on');
assert.ok(!options().includes('#14 Leg press'),
  'machine selects follow the muscle filter too');
assert.ok(root.innerHTML.includes('All muscles'), 'an explicit way out renders');
openWorkouts();
assert.ok(root.innerHTML.includes('Workouts — Lats'), 'the list heading names the muscle');
backToOverview();

// the same row again clears it
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Lats' }));
assert.ok(!pressed('Lats') && !root.innerHTML.includes('All muscles'), 're-tap clears the filter');
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
assert.ok(root.innerHTML.includes('data-muscle="Lats"'),
  'other muscles stay reachable while one is selected');
openWorkouts();
assert.ok(list().innerHTML.includes('No workouts match this filter.'),
  'an empty combination is stated, not blank');
backToOverview();
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
openWorkouts();
assert.ok(root.innerHTML.includes('Workouts — Quads'),
  'the muscle filter is active going into the edit');
list().listeners.click(clickOn('.edit-w', { wid: 'mw3' }));
list().listeners.click(clickOn('.set-add', { ei: '0' }));
list().listeners.click(clickOn('.edit-save'));
const savedFiltered = store.getWorkouts().find((w) => w.id === 'mw3');
assert.equal(savedFiltered.entries.length, 2,
  'a save under a muscle filter keeps the entries that did not match');
backToOverview();
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Quads' }));

// a freshly logged past workout resets the muscle filter, or it could
// vanish behind it and never open in edit mode
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Lats' }));
openWorkouts();
root.querySelector('#past-date').value = '2026-08-04';
root.querySelector('#past-time').value = '09:00';
root.querySelector('#past-text').value = '#14 Leg press 3x10 90';
root.querySelector('#past-log').listeners.click();
assert.ok(list().innerHTML.includes('edit-save'),
  'the logged workout opens in edit mode despite the previous filter');

// the filter clears itself when its muscle leaves the layout, and orphaned
// sets are counted instead of silently dropped
backToOverview();
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Lats' }));
assert.ok(pressed('Lats') && root.innerHTML.includes('All muscles'));
store.saveLayout({ ...store.getLayout(), machines: store.getLayout().machines.filter((m) => m.id !== 'm2') });
render();
assert.ok(onOverview() && !root.innerHTML.includes('All muscles'), 'a stranded muscle filter resets');
assert.ok(root.innerHTML.includes("can't be attributed"),
  'sets of a deleted machine are reported, not hidden');

// --- the editor's cardio fields: m:ss time, a comma distance ---
// a rower display reads "12:30" and "2.000 m"; typed on the German pad that
// is "12,30" and "2.000" — 750 s and 2000 m, not decimal minutes or 2 m
store.saveWorkouts([...store.getWorkouts(), {
  id: 'wrow', startedAt: Date.UTC(2026, 7, 10, 10), finishedAt: Date.UTC(2026, 7, 10, 11),
  entries: [{ ...entry('mrow', 9, 'Rower', [{ distance: 1000, seconds: 600 }]), cardio: true }],
}]);
render();
openWorkouts();
list().listeners.click(clickOn('.edit-w', { wid: 'wrow' }));
assert.ok(/data-kind="time"[\s\S]*?value="10:00"/.test(list().innerHTML), 'the time field shows m:ss');
const cardioChange = (cls, value) => {
  const target = { value, dataset: { ei: '0', si: '0' }, classList: { contains: (c) => c === cls }, closest: () => null };
  list().listeners.change({ target });
  return target.value;
};
assert.equal(cardioChange('edit-minutes', '12,30'), '12:30', 'the field shows the clean form back');
assert.equal(cardioChange('edit-distance', '2.000'), 2000);
assert.equal(cardioChange('edit-minutes', 'xx'), '12:30', 'refused input keeps the last good value');
list().listeners.click(clickOn('.edit-save'));
assert.deepEqual(store.getWorkouts().find((w) => w.id === 'wrow').entries[0].sets[0],
  { distance: 2000, seconds: 750 });

console.log('history: all assertions passed');
