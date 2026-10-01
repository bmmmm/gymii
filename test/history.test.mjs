// Logic-level test for history.js: the two screens (overview, Workouts)
// and what survives a re-render, the interactive Progress card (machine
// and range chips, the picked point), the workout-name filter (it narrows
// the WHOLE view, not just the list), the full editor (add/remove sets and
// machines, edit the date) and logging a workout after the fact.
// Run with: node test/history.test.mjs
import { mem } from './helpers/localstorage.mjs'; // FIRST: installs the stub
import { strict as assert } from 'node:assert';

const store = await import(new URL('../js/store.js', import.meta.url).href);
const { fmtDay: fmtDayOf } = await import(new URL('../js/ui.js', import.meta.url).href);
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
// the fixtures sit at fixed dates; the default 12-week range would let
// them age out of the chart as the calendar moves on
store.saveSettings({ ...store.getSettings(), historyRange: 'all' });

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
  tabIndex: -1,
  dataset: {},
  style: {},
  listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
  setAttribute() {},
  removeAttribute() {},
  setPointerCapture() {},
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
// the Progress card's machine chips, in render order — match the chip
// markup, not the bare label: the past-workout placeholder mentions these
// machines too
const chips = (html = root.innerHTML) => [...html.matchAll(/data-key="[^"]*"[^>]*>([^<]+)</g)]
  .map((m) => m[1].trim());
assert.deepEqual(chips(), ['#14 Leg press', '#3 Lat pulldown'],
  'unfiltered, every trained machine is a chip — the most recently trained first');
assert.ok(/class="chip sel"\s+data-key="m1 "/.test(root.innerHTML),
  'with nothing picked, the most recent machine is on show');

// Two screens. The overview analyses; the Workouts screen holds what you
// did, day by day and workout by workout, and the form that adds one.
const order = (heads) => heads.map((h) => root.innerHTML.search(new RegExp(`<h2[^>]*>${h}`)));
const overviewOrder = order(['This week', 'Progress', 'Walking paths', 'Muscles']);
assert.ok(overviewOrder.every((i) => i > 0), 'every overview card renders');
assert.deepEqual(overviewOrder.slice().sort((a, b) => a - b), overviewOrder,
  'the overview: this week, progress, walking paths, then muscles');
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
assert.ok(!chips().includes('#3 Lat pulldown'),
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
assert.ok(chips().includes('#3 Lat pulldown'), 'and the full view comes back');

// a tab tap is the one thing that returns to the overview
openWorkouts();
enter();
assert.ok(onOverview(), 'renderHistory(root, { entry: true }) lands on the overview');

// --- Progress: machine chips, the picked point, the range ---

const chartEl = () => root.querySelector('#chart');
const pickEl = () => root.querySelector('#chart-pick');
const machineChips = () => root.querySelector('#machine-chips');
const tapMachine = (key) => machineChips().listeners.click(clickOn('.chip', { key }));
const selKey = (html) => html.match(/class="chip sel"\s+data-key="([^"]*)"/)?.[1];

tapMachine('m2 ');
assert.equal(selKey(machineChips().innerHTML), 'm2 ', 'a chip tap selects that machine');
assert.ok(/aria-label="Progress: #3 Lat pulldown — top set weight \(kg\) over time"/.test(chartEl().innerHTML),
  'and the chart redraws for it, named in its label');
assert.ok(pickEl().innerHTML.includes('45×12'), 'the newest workout shows under the chart');

// Leg press has two workouts: the newest (85) is shown first; a tap at the
// chart's left edge picks the oldest (80). The pick rewrites #chart-pick and
// NOTHING else — re-rendering an ancestor mid-gesture would strand the
// chart's handlers on a dead node.
tapMachine('m1 ');
assert.ok(pickEl().innerHTML.includes('85×10') && pickEl().innerHTML.includes('e1RM'),
  'the newest point is shown, with its e1RM');
assert.ok(chartEl().innerHTML.includes('c-line alt'), 'strength draws the dashed e1RM series');
root.innerHTML += '<!--before the pick-->';
chartEl().getBoundingClientRect = () => ({ left: 0, width: 520 });
chartEl().onpointerdown({ clientX: 0, pointerId: 1 });
chartEl().onpointerup({ clientX: 0 });
assert.ok(pickEl().innerHTML.includes('80×10') && !pickEl().innerHTML.includes('85×10'),
  'a tap on the chart shows the first workout\'s sets');
assert.ok(pickEl().innerHTML.includes('data-wid="w1"'), '"Open workout" carries that workout');
assert.ok(root.innerHTML.includes('<!--before the pick-->'), 'a pick never re-renders the view');

// the picked point survives a re-render; a tab tap forgets it (not the machine)
render();
assert.ok(pickEl().innerHTML.includes('80×10'), 'the picked point survives a re-render');
enter();
assert.ok(pickEl().innerHTML.includes('85×10'), 'a tab tap goes back to the newest point');
tapMachine('m2 '); // not the most recent one, or the default would pass this
enter();
assert.equal(selKey(root.innerHTML), 'm2 ', 'but keeps the picked machine');

// "Open workout ›" lands on the Workouts screen with that workout open
tapMachine('m1 ');
chartEl().getBoundingClientRect = () => ({ left: 0, width: 520 });
chartEl().onpointerdown({ clientX: 0, pointerId: 1 });
chartEl().onpointerup({ clientX: 0 });
pickEl().listeners.click(clickOn('.pick-open', { wid: 'w1' }));
assert.ok(onWorkouts(), '"Open workout ›" opens the Workouts screen');
const openCard = root.querySelector('#workout-list').innerHTML.split('<details')
  .find((c) => c.startsWith(' class="workout" open'));
assert.ok(openCard?.includes('data-wid="w1"'), 'with that workout unfolded');
render();
assert.ok(!root.querySelector('#workout-list').innerHTML.includes('class="workout" open'),
  'once — the next re-render does not unfold it again');
backToOverview();

// the range is a device setting and survives a re-render
root.querySelector('#range-chips').listeners.click(clickOn('.chip', { range: '4w' }));
assert.equal(store.getSettings().historyRange, '4w', 'a range chip is saved');
assert.ok(chartEl().innerHTML.includes('No data in this range.'),
  'and narrows the chart (the fixtures are older than four weeks)');
assert.equal(pickEl().innerHTML, '', 'an empty range shows no stale pick');
render();
assert.ok(/class="chip sel" data-range="4w"/.test(root.innerHTML), 'the range survives a re-render');
root.querySelector('#range-chips').listeners.click(clickOn('.chip', { range: 'all' }));

// the picked machine survives the save that re-renders everything
tapMachine('m2 ');
openWorkouts();
root.querySelector('#workout-list').listeners.click(clickOn('.edit-w', { wid: 'w2' }));
root.querySelector('#workout-list').listeners.click(clickOn('.edit-save'));
backToOverview();
assert.equal(selKey(root.innerHTML), 'm2 ', 'a save keeps the picked machine');

// --- the editor: add a set, add a machine, move the date ---

const list = () => root.querySelector('#workout-list');
openWorkouts();
// the heatmap month is "where in time": a save keeps it, an entry resets it
const hmTitle = () => root.querySelector('#hm-title').textContent;
const thisMonth = hmTitle();
root.querySelector('#hm-prev').listeners.click();
const pickedMonth = hmTitle();
assert.notEqual(pickedMonth, thisMonth, 'the heatmap steps back a month');
// so is its machine filter
const hmSel = root.querySelector('#hm-machine');
hmSel.value = 'm1 ';
hmSel.listeners.change();
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
// the save replaced the <select> node (innerHTML), so a fresh stub must get the value back
render();
assert.equal(root.querySelector('#hm-machine').value, 'm1 ', 'and the heatmap machine filter');

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
assert.ok(!chips().includes('#14 Leg press'),
  'machine selects follow the muscle filter too');
assert.ok(root.innerHTML.includes('All muscles'), 'an explicit way out renders');
openWorkouts();
assert.ok(root.innerHTML.includes('Workouts — Lats'), 'the list heading names the muscle');
backToOverview();

// the same row again clears it
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Lats' }));
assert.ok(!pressed('Lats') && !root.innerHTML.includes('All muscles'), 're-tap clears the filter');
assert.ok(chips().includes('#14 Leg press'), 'and the full view comes back');

// a muscle with zero sets still filters (the "neglected groups" feature) —
// the Progress picker states its emptiness instead of rendering optionless
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Chest' }));
assert.ok(root.innerHTML.includes('No machines match this filter'),
  'the chart picker explains an empty machine list');
assert.deepEqual(chips(), [], 'and renders no chip');
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

// --- machine chips: the first eight, "+N more", the shown one always ---
// ten machines, trained one per day: x0 oldest … x9 newest
store.saveWorkouts(Array.from({ length: 10 }, (_, i) => ({
  id: `wx${i}`, startedAt: Date.UTC(2026, 6, 1 + i, 10), finishedAt: Date.UTC(2026, 6, 1 + i, 11),
  entries: [entry(`x${i}`, 20 + i, `Machine ${i}`, [{ reps: 10, weight: 20 + i }])],
})));
enter();
assert.deepEqual(chips(), [9, 8, 7, 6, 5, 4, 3, 2].map((i) => `#${20 + i} Machine ${i}`),
  'eight chips, most recent first');
assert.ok(root.innerHTML.includes('+2 more'), 'the rest sit behind "+N more"');
machineChips().listeners.click(clickOn('.chip', { more: '1' }));
assert.equal(chips(machineChips().innerHTML).length, 10, '"+N more" shows them all');
tapMachine('x0 ');
enter();
assert.deepEqual(chips().slice(-1), ['#20 Machine 0'],
  'collapsed again, the picked machine stays visible behind the eight');
assert.ok(root.innerHTML.includes('+1 more'), 'and the count says what is still hidden');

// --- This week: four tiles, twelve weekly bars, the picked week's list ---
// Relative to today, or the fixtures would age out of the twelve weeks.
const monday = store.startOfDay(Date.now());
monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
const weekAt = (weeksBack, hour) => {
  const d = new Date(monday);
  d.setDate(d.getDate() - 7 * weeksBack);
  d.setHours(hour);
  return d.getTime();
};
const sets = (n) => Array.from({ length: n }, () => ({ reps: 10, weight: 50 }));
store.saveWorkouts([
  { id: 'wk4', startedAt: weekAt(3, 8), finishedAt: weekAt(3, 9), entries: [entry('m1', 14, 'Leg press', sets(4))] },
  { id: 'wk3', startedAt: weekAt(1, 8), finishedAt: weekAt(1, 8) + 45 * 60000, entries: [entry('m1', 14, 'Leg press', sets(1))] },
  { id: 'wk1', startedAt: weekAt(0, 8), finishedAt: weekAt(0, 9), entries: [entry('m1', 14, 'Leg press', sets(2))] },
  { id: 'wk2', startedAt: weekAt(0, 18), finishedAt: weekAt(0, 19), entries: [entry('m3', 7, 'Chest press', sets(3))] },
]);
enter();
const weekTitle = () => root.querySelector('#week-title').textContent;
const weekList = () => root.querySelector('#week-list').innerHTML;
const weekTiles = () => root.querySelector('#week-tiles').innerHTML;
const weekChart = () => root.querySelector('#week-chart');
const listed = () => [...weekList().matchAll(/class="btn repeat-w" data-wid="([^"]+)"/g)].map((m) => m[1]);
// the value a tile shows, read off the tile with that metric
const tile = (metric) => weekTiles().match(new RegExp(
  `data-metric="${metric}"[\\s\\S]*?tile-value">([^<]*)<[\\s\\S]*?tile-sub">([^<]*)<`))?.slice(1);
assert.ok(/<h2 id="week-title">This week</.test(root.innerHTML), 'the card opens on this week');
assert.equal(weekTitle(), 'This week');
assert.deepEqual(listed(), ['wk2', 'wk1'], 'with this week\'s workouts, newest first');
assert.deepEqual(tile('workouts'), ['2', 'vs 1 the week before'], 'the Workouts tile compares with the week before');
assert.deepEqual(tile('sets'), ['5', 'vs 1 the week before']);
assert.ok(/class="tile stat sel" data-metric="sets"/.test(weekTiles()), 'sets is the default metric');
assert.equal((weekChart().innerHTML.match(/<rect class="c-bar/g) ?? []).length, 12, 'twelve weekly bars');
assert.ok(/aria-label="Sets per week, last 12 weeks"/.test(weekChart().innerHTML), 'the bars count sets');
assert.ok(root.innerHTML.includes('id="open-workouts"'), 'the card ends in the way to every workout');

// a bar tap picks that week: title, tiles and list follow, the view does not re-render
root.innerHTML += '<!--before the bar-->';
weekChart().getBoundingClientRect = () => ({ left: 0, width: 520 });
const barX = (i) => 42 + (i + 0.5) * ((520 - 42 - 18) / 12); // chart.js's column geometry
weekChart().onpointerdown({ clientX: barX(10), pointerId: 1 });
weekChart().onpointerup({ clientX: barX(10) });
assert.ok(weekTitle().startsWith('Week of '), 'a bar tap names its week');
assert.deepEqual(listed(), ['wk3'], 'and narrows the list to it');
assert.deepEqual(tile('workouts'), ['1', 'vs 0 the week before'], 'the tiles describe that week');
assert.ok(root.innerHTML.includes('<!--before the bar-->'), 'a bar tap never re-renders the view');
weekChart().onpointerdown({ clientX: barX(9), pointerId: 1 });
weekChart().onpointerup({ clientX: barX(9) });
assert.ok(/Nothing logged that week\./.test(root.querySelector('#week-workouts').innerHTML),
  'an empty week says so');
weekChart().onpointerdown({ clientX: barX(10), pointerId: 1 });
weekChart().onpointerup({ clientX: barX(10) });

// a save from the week's own list re-renders without `entry`: the week stays
root.querySelector('#week-list').listeners.click(clickOn('.edit-w', { wid: 'wk3' }));
root.querySelector('#week-list').listeners.click(clickOn('.edit-save'));
assert.ok(onOverview() && weekTitle().startsWith('Week of '), 'a save keeps the picked week');
assert.deepEqual(listed(), ['wk3']);
enter();
assert.equal(weekTitle(), 'This week', 'a tab tap goes back to this week');
assert.deepEqual(listed(), ['wk2', 'wk1']);

// a tile tap is the bars' metric: saved on the device, kept across renders
root.querySelector('#week-tiles').listeners.click(clickOn('.tile', { metric: 'volume' }));
assert.equal(store.getSettings().historyMetric, 'volume', 'a tile tap saves the metric');
assert.ok(/aria-label="Volume per week, last 12 weeks"/.test(weekChart().innerHTML), 'and redraws the bars');
assert.ok(/class="tile stat sel" data-metric="volume"/.test(weekTiles()), 'its tile shows it is on');
enter();
assert.ok(/aria-label="Volume per week/.test(weekChart().innerHTML), 'the metric survives a tab tap');
assert.deepEqual(tile('volume'), ['2,500 kg', 'vs 500 kg the week before']);
root.querySelector('#week-tiles').listeners.click(clickOn('.tile', { metric: 'minutes' }));
assert.deepEqual(tile('minutes'), ['2:00 h', 'vs 45 min the week before'], 'time reads in hours from 60 min');

// --- Hints: an instruction with a ↗ to its study, where the user acts ---
// Weekly on one weekday, 49 … 0 days back at 18:00: Chest press 14 × 50
// twice (progress — a log-screen hint, train.test.mjs), its Incline
// exercise stuck at 60 kg for eight sessions (plateau — under the chart of
// THAT exercise), Leg press busy on three evenings (busy — a log-screen
// hint), Quads last trained 21 days ago while training went on (muscle
// gap — under the Quads row), one strength day a week (frequency — under
// the week tiles). History reads every workout, so nothing here depends
// on a filter.
const dayAt = (daysBack, hour) => {
  const d = store.startOfDay(Date.now());
  d.setDate(d.getDate() - daysBack);
  d.setHours(hour);
  return d.getTime();
};
const incline = (reps) => ({ ...entry('m3', 7, 'Chest press', [{ reps, weight: 60 }]), exercise: 'Incline' });
const chestDay = (id, back, reps) => ({
  id, startedAt: dayAt(back, 18), finishedAt: dayAt(back, 19),
  entries: [entry('m3', 7, 'Chest press', [{ reps: 14, weight: 50 }]), incline(reps)],
  visits: [{ machineId: 'm3', in: dayAt(back, 18), out: dayAt(back, 18) + 600000, busy: 'm1' }],
});
const inclineDay = (id, back, reps) => ({
  id, startedAt: dayAt(back, 18), finishedAt: dayAt(back, 19), entries: [incline(reps)],
});
store.saveWorkouts([
  inclineDay('i0', 49, 7), inclineDay('i1', 42, 8), inclineDay('i2', 35, 7), inclineDay('i3', 28, 7),
  { id: 'i4', startedAt: dayAt(21, 18), finishedAt: dayAt(21, 19), entries: [entry('m1', 14, 'Leg press', sets(3)), incline(7)] },
  chestDay('i5', 14, 7), chestDay('i6', 7, 7), chestDay('i7', 0, 7),
]);
enter();
const hint = (text) => root.innerHTML.split('<p class="hint').slice(1).find((h) => h.includes(text)) ?? '';
assert.ok(!root.innerHTML.includes('Worth a look') && !root.innerHTML.includes('insight'),
  'no card of its own: a hint sits where the user acts');
assert.ok(hint('Aim for 2 strength days a week — 1 over the last 4 weeks.').startsWith(' week-hint"'),
  'frequency under the week tiles');
assert.ok(root.innerHTML.search('week-hint') < root.innerHTML.search('id="week-chart"'),
  'the week hint sits between the tiles and the bars');
assert.ok(hint('Aim for 2 strength days').includes(
  'href="https://pmc.ncbi.nlm.nih.gov/articles/PMC7719906/" target="_blank" rel="noopener" aria-label="Source: WHO 2020 guidelines"'),
  'the ↗ opens the study, named for screen readers');
const quadsRow = root.innerHTML.slice(root.innerHTML.indexOf('data-muscle="Quads"'));
assert.match(quadsRow, /^[^]*?<\/button><p class="hint muscle-hint"><span>Train it this week — last trained 21 days ago\.<\/span><a /,
  'the muscle hint follows its row as a sibling — a link inside a button is no link');
assert.ok(!hint('Target beaten twice') && !hint('Usually busy'),
  'progress and busy belong to the log screen, not to History');
assert.equal(root.querySelector('#chart-note').innerHTML, '',
  'the plateau hint is not on show for the newest machine (Chest press, no exercise)');
assert.equal(root.innerHTML.split('class="hint muscle-hint"').length - 1, 1, 'one muscle hint: Quads only');
tapMachine('m3 Incline');
assert.equal(selKey(machineChips().innerHTML), 'm3 Incline');
assert.ok(root.querySelector('#chart-note').innerHTML.includes('No new best in 6 workouts (76 kg e1RM) — vary reps or load.'),
  'the plateau hint sits under the chart of exactly that exercise');
assert.ok(root.querySelector('#chart-note').innerHTML.includes('href="https://pmc.ncbi.nlm.nih.gov/articles/PMC11435939/"'));
tapMachine('m3 ');
assert.equal(root.querySelector('#chart-note').innerHTML, '', 'the same machine, another exercise: no note');

// nothing to say, nothing shown: under three workouts no rule runs
store.saveWorkouts(store.getWorkouts().slice(-2));
render();
assert.ok(!root.innerHTML.includes('class="hint'), 'no hint anywhere');

// --- Walking paths: the route of a live-logged workout ---
store.saveLayout({
  ...store.getLayout(),
  machines: [
    { id: 'm1', num: 14, label: 'Leg press', x: 2, y: 2, w: 4, h: 3, settingsFields: [], muscles: ['Quads'] },
    { id: 'm2', num: 3, label: 'Lat pulldown', x: 20, y: 2, w: 4, h: 3, settingsFields: [], muscles: ['Lats'] },
    { id: 'm3', num: 7, label: 'Chest press', x: 20, y: 20, w: 4, h: 3, settingsFields: [], muscles: ['Chest'] },
  ],
});
const pathMap = () => root.querySelector('#path-map').innerHTML;
const pathChips = () => root.querySelector('#path-chips').innerHTML;
const pathStats = () => root.querySelector('#path-stats').innerHTML;
const t0 = dayAt(3, 17);
const min = 60000;
store.saveWorkouts([{ id: 'bare', startedAt: dayAt(4, 17), finishedAt: dayAt(4, 18),
  entries: [entry('m1', 14, 'Leg press', sets(2)), entry('m2', 3, 'Lat pulldown', sets(2))] }]);
enter();
assert.ok(/<h2>Walking paths<\/h2>\s*<p class="muted">Shows the route you walked/.test(root.innerHTML),
  'without a single `at` the card explains what it needs');
assert.ok(!root.innerHTML.includes('id="path-map"'), 'and draws no map');

// sets with `at`: Leg press → Lat pulldown → Chest press
const stamped = {
  id: 'ps1', startedAt: t0, finishedAt: t0 + 30 * min,
  entries: [
    entry('m1', 14, 'Leg press', [{ reps: 10, weight: 80, at: t0 + 5 * min }]),
    entry('m2', 3, 'Lat pulldown', [{ reps: 10, weight: 40, at: t0 + 14 * min }]),
    entry('m3', 7, 'Chest press', [{ reps: 10, weight: 50, at: t0 + 20 * min }]),
  ],
};
store.saveWorkouts([...store.getWorkouts(), stamped]);
render();
const ps1Day = fmtDayOf(t0);
assert.ok(new RegExp(`class="chip sel"\\s+data-wid="ps1" aria-pressed="true">${ps1Day}<`).test(pathChips()),
  'a stamped workout gets a date chip, selected');
assert.ok(!pathChips().includes('data-wid="all"'), 'one route: no "All" chip');
assert.ok(/class="path-leg" data-from="m1" data-to="m2"/.test(pathMap())
  && /class="path-leg" data-from="m2" data-to="m3"/.test(pathMap()), 'the map draws its legs');
assert.ok(pathStats().includes('3 machines · 2 switches · 0 back-tracks'), 'the route in numbers');
assert.ok(pathStats().includes('#14 9 min → #3 6 min → #7 10 min'),
  'and where the time went: stop to stop, the last one to the finish');

// a visits-based route (the log screen's own order), newer: it is the default
const t1 = dayAt(1, 17);
store.saveWorkouts([...store.getWorkouts(), {
  id: 'ps2', startedAt: t1, finishedAt: t1 + 40 * min,
  entries: [entry('m3', 7, 'Chest press', sets(2)), entry('m1', 14, 'Leg press', sets(2))],
  visits: [{ machineId: 'm3', in: t1, out: t1 + 15 * min }, { machineId: 'm1', in: t1 + 16 * min, out: t1 + 40 * min }],
}]);
render();
assert.ok(/class="chip sel"\s+data-wid="ps2"/.test(pathChips()), 'the latest route is on show');
assert.ok(/class="path-leg" data-from="m3" data-to="m1"/.test(pathMap()), 'drawn from its visits');
assert.ok(pathChips().includes('All · 2 workouts'), 'two routes add the "All" chip');
const pathChipsEl = () => root.querySelector('#path-chips');
pathChipsEl().listeners.click(clickOn('.chip', { wid: 'all' }));
assert.ok(/class="chip sel" data-wid="all"/.test(pathChips()), '"All" is picked');
assert.ok(['m1" data-to="m2', 'm2" data-to="m3', 'm3" data-to="m1'].every((leg) => pathMap().includes(`data-from="${leg}"`)),
  'and every way walked is drawn at once');
render();
assert.ok(/class="chip sel" data-wid="all"/.test(pathChips()), 'the picked route survives a re-render');
enter();
assert.ok(/class="chip sel"\s+data-wid="ps2"/.test(pathChips()), 'a tab tap goes back to the latest');

// a gym without a layout has no floor to draw on
const layoutKey = [...mem.keys()].find((k) => /^gymii\.[^.]+\.layout$/.test(k));
const savedLayout = mem.get(layoutKey);
localStorage.removeItem(layoutKey);
render();
assert.ok(!/<h2>Walking paths/.test(root.innerHTML), 'no layout, no path card');
mem.set(layoutKey, savedLayout);

console.log('history: all assertions passed');
