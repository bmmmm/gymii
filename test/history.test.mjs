// Logic-level test for history.js: the two screens (overview, Workouts)
// and what survives a re-render, the interactive Progress card (machine
// and range chips, the picked point), the workout-name filter (it narrows
// the WHOLE view, not just the list), the full editor (add/remove sets and
// machines, edit the date) and logging a workout after the fact.
// Run with: node test/history.test.mjs
import { mem } from './helpers/localstorage.mjs'; // FIRST: installs the stub
import { strict as assert } from 'node:assert';

const store = await import(new URL('../app/js/store.js', import.meta.url).href);
const weekday = await import(new URL('../app/js/weekday.js', import.meta.url).href);
// a Progress chip / heatmap key: stats.js's seriesKey, the (machine, exercise, grip) triple
const K = (machineId, exercise = null, grip = null) => JSON.stringify([machineId, exercise, grip]);
const { fmtDay: fmtDayOf } = await import(new URL('../app/js/ui.js', import.meta.url).href);
const { renderHistory } = await import(new URL('../app/js/history.js', import.meta.url).href);

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
assert.equal(root.innerHTML.match(/class="chip sel"\s+data-key="([^"]*)"/)?.[1]?.replaceAll('&quot;', '"'), K('m1'),
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
// the list card has no h2 of its own: the screen's h1 already says "Workouts"
const workoutsOrder = [...order(['Training days']), root.innerHTML.indexOf('id="workout-list"'),
  ...order(['Log a past workout'])];
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
assert.ok(root.innerHTML.includes('<p class="muted list-filter">Showing: Leg day</p>'), 'the list names the active filter');
assert.equal(root.innerHTML.split('>Workouts<').length - 1, 1, 'and says "Workouts" once: the h1, no h2 under it');
assert.ok(root.innerHTML.includes('id="name-filter"'), 'the name chips sit on this screen too');

// the filter clears itself when its last workout loses that name
store.saveWorkouts(store.getWorkouts().map((w) => (w.name === 'Leg day' ? { ...w, name: 'Legs' } : w)));
render();
assert.ok(onWorkouts(), 'a re-render keeps the screen');
assert.ok(!root.innerHTML.includes('list-filter'), 'a filter with nothing left resets');
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
const selKey = (html) => html.match(/class="chip sel"\s+data-key="([^"]*)"/)?.[1]?.replaceAll('&quot;', '"');

tapMachine(K('m2'));
assert.equal(selKey(machineChips().innerHTML), K('m2'), 'a chip tap selects that machine');
assert.ok(/aria-label="Progress: #3 Lat pulldown — top set weight \(kg\) over time"/.test(chartEl().innerHTML),
  'and the chart redraws for it, named in its label');
assert.ok(pickEl().innerHTML.includes('45×12'), 'the newest workout shows under the chart');

// Leg press has two workouts: the newest (85) is shown first; a tap at the
// chart's left edge picks the oldest (80). The pick rewrites #chart-pick and
// NOTHING else — re-rendering an ancestor mid-gesture would strand the
// chart's handlers on a dead node.
tapMachine(K('m1'));
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
tapMachine(K('m2')); // not the most recent one, or the default would pass this
enter();
assert.equal(selKey(root.innerHTML), K('m2'), 'but keeps the picked machine');

// "Open workout ›" lands on the Workouts screen with that workout open
tapMachine(K('m1'));
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
tapMachine(K('m2'));
openWorkouts();
root.querySelector('#workout-list').listeners.click(clickOn('.edit-w', { wid: 'w2' }));
root.querySelector('#workout-list').listeners.click(clickOn('.edit-save'));
backToOverview();
assert.equal(selKey(root.innerHTML), K('m2'), 'a save keeps the picked machine');

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
hmSel.value = K('m1');
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
assert.equal(root.querySelector('#hm-machine').value, K('m1'), 'and the heatmap machine filter');

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
let pastScroll = null;
root.querySelector('#past-msg').scrollIntoView = (o) => { pastScroll = o; };
root.querySelector('#past-log').listeners.click();
assert.deepEqual(pastScroll, { block: 'center' }, 'the notice about skipped lines is brought back on screen');

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
let rowScroll = null;
byId.set('.muscle-row[data-muscle="Lats"]', stubEl({ scrollIntoView(o) { rowScroll = o; } }));
root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Lats' }));
assert.ok(onOverview() && pressed('Lats'), 'the row shows its filter is on');
assert.deepEqual(rowScroll, { block: 'center' },
  'the tapped row is kept under the thumb — Muscles is the last card, the view resizes above it');
assert.ok(!chips().includes('#14 Leg press'),
  'machine selects follow the muscle filter too');
assert.ok(root.innerHTML.includes('All muscles'), 'an explicit way out renders');
openWorkouts();
assert.ok(root.innerHTML.includes('Showing: Lats'), 'the list names the muscle');
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
assert.ok(root.innerHTML.includes('Showing: Quads'),
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

// --- the editor's cardio level: a third field, whole from 1 up; empty or 0 deletes it ---
render(); // still on the Workouts screen
list().listeners.click(clickOn('.edit-w', { wid: 'wrow' }));
assert.ok(/class="edit-level" data-ei="0" data-si="0"\s+value="" aria-label="Level"/.test(list().innerHTML),
  'a cardio row has a Level field, empty while the set has none');
const levelChange = (si, value) => {
  const target = { value, dataset: { ei: '0', si }, classList: { contains: (c) => c === 'edit-level' }, closest: () => null };
  list().listeners.change({ target });
  return target.value;
};
assert.equal(levelChange('0', '5'), 5, 'a typed level is written back');
assert.equal(levelChange('0', '2.6'), 3, 'whole');
list().listeners.click(clickOn('.set-add', { ei: '0' }));
list().listeners.click(clickOn('.edit-save'));
assert.deepEqual(store.getWorkouts().find((w) => w.id === 'wrow').entries[0].sets,
  [{ distance: 2000, seconds: 750, level: 3 }, { distance: 2000, seconds: 750, level: 3 }],
  'Save stores the level, and + Set copied it with the rest');
render();
list().listeners.click(clickOn('.edit-w', { wid: 'wrow' }));
assert.ok(/class="edit-level" data-ei="0" data-si="1"\s+value="3"/.test(list().innerHTML),
  'the field shows the stored level');
assert.equal(levelChange('0', '0'), '', '0 clears the field');
assert.equal(levelChange('1', ''), '', 'so does emptying it');
list().listeners.click(clickOn('.edit-save'));
assert.deepEqual(store.getWorkouts().find((w) => w.id === 'wrow').entries[0].sets,
  [{ distance: 2000, seconds: 750 }, { distance: 2000, seconds: 750 }],
  'and Save deletes the level from the set — never a stored 0');

// --- the editor's weight: a decimal text field, "12,5" is 12.5 ---
store.saveWorkouts([...store.getWorkouts(), {
  id: 'wdec', startedAt: Date.UTC(2026, 7, 11, 10), finishedAt: Date.UTC(2026, 7, 11, 11),
  entries: [entry('mdec', 8, 'Curl', [{ reps: 10, weight: 10 }])],
}]);
render(); // still on the Workouts screen
list().listeners.click(clickOn('.edit-w', { wid: 'wdec' }));
assert.ok(/type="text" inputmode="decimal"[^>]*data-kind="decimal" class="edit-weight"/.test(list().innerHTML),
  'the set weight takes a comma');
assert.equal(cardioChange('edit-weight', '12,5'), 12.5, 'a comma is the decimal mark (type=number made it 125)');
assert.equal(cardioChange('edit-weight', 'x'), 12.5, 'refused input keeps the last good weight');
// the reps read through fieldValue like the weight: an armed field left
// empty (initNumericOverwrite) still means the value it shows greyed out —
// raw t.value made it 1
{
  const target = { value: '', dataset: { ei: '0', si: '0', prevValue: '12' },
    classList: { contains: (c) => c === 'edit-reps' }, closest: () => null };
  list().listeners.change({ target });
  assert.equal(target.value, 12, 'an armed, empty reps field keeps what it showed');
}
list().listeners.click(clickOn('.edit-save'));
assert.equal(store.getWorkouts().find((w) => w.id === 'wdec').entries[0].sets[0].weight, 12.5, 'and Save stores 12.5');
assert.equal(store.getWorkouts().find((w) => w.id === 'wdec').entries[0].sets[0].reps, 12, 'and the reps it showed');

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
tapMachine(K('x0'));
enter();
assert.deepEqual(chips().slice(-1), ['#20 Machine 0'],
  'collapsed again, the picked machine stays visible behind the eight');
assert.ok(root.innerHTML.includes('+1 more'), 'and the count says what is still hidden');

// --- This week: four tiles, twelve weekly bars, the picked week's list ---
// Relative to today, or the fixtures would age out of the twelve weeks.
const monday = weekday.startOfDay(Date.now());
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

// the week's list is read-only — a bar or tile tap rebuilds it, and an
// edit draft in it died unannounced. "Edit ›" opens the editor on the
// Workouts screen, which nothing redraws under it.
assert.ok(!weekList().includes('edit-w') && !weekList().includes('delete-w'), 'no editor and no delete in the week list');
assert.ok(weekList().includes('class="btn btn-inline edit-open" data-wid="wk3">Edit ›</button>'), 'an "Edit ›" instead');
root.querySelector('#week-list').listeners.click(clickOn('.edit-open', { wid: 'wk3' }));
assert.ok(onWorkouts(), '"Edit ›" goes to the Workouts screen');
assert.ok(list().innerHTML.includes('Editing —') && !list().innerHTML.includes('repeat-w" data-wid="wk3"'),
  'with that workout open in its editor');
list().listeners.click(clickOn('.edit-save'));
backToOverview();
assert.ok(weekTitle().startsWith('Week of '), 'and the picked week is still picked');
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
const barLabel = () => weekChart().innerHTML.match(/class="c-label"[^>]*>([^<]*)</)?.[1];
assert.equal(barLabel(), '2:00 h', 'the selected bar says what its tile says, not "120 min"');
root.querySelector('#week-tiles').listeners.click(clickOn('.tile', { metric: 'volume' }));
assert.equal(barLabel(), '2,500 kg', 'one number format for both: "2,500 kg", not "2500 kg"');
root.querySelector('#week-tiles').listeners.click(clickOn('.tile', { metric: 'minutes' }));

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
  const d = weekday.startOfDay(Date.now());
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
assert.match(quadsRow, /^[\s\S]*?<\/button><p class="hint muscle-hint"><span>Train it this week — last trained 21 days ago\.<\/span><a /,
  'the muscle hint follows its row as a sibling — a link inside a button is no link');
assert.ok(!hint('Target beaten twice') && !hint('Usually busy'),
  'progress and busy belong to the log screen, not to History');
assert.equal(root.querySelector('#chart-note').innerHTML, '',
  'the plateau hint is not on show for the newest machine (Chest press, no exercise)');
assert.equal(root.innerHTML.split('class="hint muscle-hint"').length - 1, 1, 'one muscle hint: Quads only');
tapMachine(K('m3', 'Incline'));
assert.equal(selKey(machineChips().innerHTML), K('m3', 'Incline'));
assert.ok(root.querySelector('#chart-note').innerHTML.includes('No new best in 6 workouts (76 kg e1RM) — vary reps or load.'),
  'the plateau hint sits under the chart of exactly that exercise');
assert.ok(root.querySelector('#chart-note').innerHTML.includes('href="https://pmc.ncbi.nlm.nih.gov/articles/PMC11435939/"'));
tapMachine(K('m3'));
assert.equal(root.querySelector('#chart-note').innerHTML, '', 'the same machine, another exercise: no note');

// a filter narrows what is LISTED, never what the hints read: "1 strength
// day a week" is about all of the training, not about one routine
store.saveWorkouts(store.getWorkouts().map((w) => (w.id === 'i7' ? { ...w, name: 'Solo' } : w)));
render();
root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: 'Solo' }));
assert.ok(/class="chip sel"\s+data-name="Solo"/.test(root.innerHTML), 'the filter is on');
assert.ok(hint('Aim for 2 strength days a week — 1 over the last 4 weeks.'),
  'a filter that leaves ONE workout still shows the hints over all of them');
root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: '' }));

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
store.saveWorkouts([{ id: 'bare', name: 'Typed in', startedAt: dayAt(4, 17), finishedAt: dayAt(4, 18),
  entries: [entry('m1', 14, 'Leg press', sets(2)), entry('m2', 3, 'Lat pulldown', sets(2))] }]);
enter();
assert.ok(/<h2>Walking paths<\/h2>\s*<p class="muted">Shows the route you walked/.test(root.innerHTML),
  'without a single `at` the card explains what it needs');
assert.ok(!root.innerHTML.includes('id="path-map"'), 'and draws no map');
root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: 'Typed in' }));
assert.ok(root.innerHTML.includes('<p class="muted">Shows the route you walked'),
  'with no live-logged workout at all, a filter is not to blame');
root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: '' }));

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
// a name filter that hides every live-logged workout: the text blames the filter
render();
root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: 'Typed in' }));
assert.ok(/<h2>Walking paths<\/h2>\s*<p class="muted">No live-logged workout under this name\.<\/p>/.test(root.innerHTML),
  'the filter took the routes away, not the back-logging');
root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: '' }));
assert.ok(root.innerHTML.includes('id="path-map"'), 'and they come back with the filter off');
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
// the name keeps its routes, the MUSCLE takes them away: the text says so
{
  const keepLayout = store.getLayout();
  store.saveLayout({ ...keepLayout, machines: [...keepLayout.machines,
    { id: 'm9', num: 9, label: 'Calf raise', x: 40, y: 2, w: 4, h: 3, settingsFields: [], muscles: ['Calves'] }] });
  store.saveWorkouts(store.getWorkouts().map((w) => (w.id === 'ps2' || w.id === 'bare' ? { ...w, name: 'Live' } : w)));
  render();
  root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: 'Live' }));
  root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Calves' }));
  assert.ok(root.innerHTML.includes('<p class="muted">No live-logged workout trained this muscle.</p>'),
    'a name with routes is not blamed for what the muscle filter hid');
  root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Calves' }));
  root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: '' }));
  store.saveLayout(keepLayout);
}

// a gym without a layout has no floor to draw on
const layoutKey = [...mem.keys()].find((k) => /^gymii\.[^.]+\.layout$/.test(k));
const savedLayout = mem.get(layoutKey);
localStorage.removeItem(layoutKey);
render();
assert.ok(!/<h2>Walking paths/.test(root.innerHTML), 'no layout, no path card');
mem.set(layoutKey, savedLayout);

// --- grips: one Progress chip per grip, and the editor fixes a grip ---
{
  const g = store.newLayout('Grip history gym');
  g.machines.push({ id: 'ct', num: 9, label: 'Cable tower', x: 0, y: 0, w: 4, h: 3, settingsFields: [],
    exercises: ['Pushdown'], grips: ['Rope', 'V-bar'] });
  store.saveLayout(g);
  const e = (grip, weight) => ({ machineId: 'ct', num: 9, label: 'Cable tower', exercise: 'Pushdown',
    ...(grip ? { grip } : {}), settings: {}, sets: [{ reps: 12, weight }] });
  const t = Date.now();
  store.saveWorkouts([
    { id: 'gh1', startedAt: t - 3 * 864e5, finishedAt: t - 3 * 864e5 + 3600e3, entries: [e('Rope', 20), e('V-bar', 30)] },
    { id: 'gh2', startedAt: t - 864e5, finishedAt: t - 864e5 + 3600e3, entries: [e('Rope', 22.5)] },
  ]);
  enter();
  assert.deepEqual(chips().sort(), ['#9 Cable tower · Pushdown · Rope', '#9 Cable tower · Pushdown · V-bar'],
    'one chip per grip — their numbers never mix');
  tapMachine(K('ct', 'Pushdown', 'V-bar'));
  assert.ok(pickEl().innerHTML.includes('30×12'), 'the V-bar chart shows only the V-bar set');
  assert.ok(/Progress: #9 Cable tower · Pushdown · V-bar/.test(chartEl().innerHTML), 'and names its grip');

  openWorkouts();
  list().listeners.click(clickOn('.edit-w', { wid: 'gh1' }));
  const html = list().innerHTML;
  assert.ok(/entry-grip sel" data-ei="0"\s+data-grip="Rope"/.test(html), 'the entry\'s grip is selected');
  assert.ok(/data-ei="0"\s+data-grip="V-bar" disabled/.test(html),
    'a grip another entry already holds is disabled — a series reads one entry per workout');
  list().listeners.click(clickOn('.entry-grip', { ei: '0', grip: 'V-bar' }));
  assert.equal(list().innerHTML.match(/entry-grip sel" data-ei="0"/g)?.length, 1, 'a disabled grip is never taken');
  list().listeners.click(clickOn('.entry-grip', { ei: '0', grip: 'Rope' }));
  list().listeners.click(clickOn('.edit-save'));
  assert.equal('grip' in store.getWorkouts().find((w) => w.id === 'gh1').entries[0], false,
    'the chosen chip again removes the grip, and Save stores it');
  // deselecting is blocked by a gripless twin: the screen says why, once
  list().listeners.click(clickOn('.edit-w', { wid: 'gh1' }));
  list().listeners.click(clickOn('.entry-grip', { ei: '1', grip: 'V-bar' }));
  {
    const h = list().innerHTML;
    assert.equal(h.match(/Another entry already logs Pushdown without a grip/g)?.length, 1, 'a blocked deselect explains itself, once');
    assert.ok(h.indexOf('Another entry already logs') > h.lastIndexOf('data-ei="1"\n      data-grip="V-bar"'),
      'under that entry\'s chips, not the other one\'s');
  }
  list().listeners.click(clickOn('.set-add', { ei: '1' }));
  assert.ok(!list().innerHTML.includes('Another entry already logs'), 'and the notice is gone after the next tap');
  list().listeners.click(clickOn('.edit-cancel'));
  backToOverview();
  store.saveWorkouts([]);
}

// --- assisted: the chart shows the assist (lower is stronger) or the reps at it ---
{
  const g = store.newLayout('Assist history gym');
  g.machines.push({ id: 'ax', num: 17, label: 'Assisted pull-up', x: 0, y: 0, w: 4, h: 3, settingsFields: [], assisted: true });
  store.saveLayout(g);
  const t = Date.now();
  const ent = (weight, reps) => ({ machineId: 'ax', num: 17, label: 'Assisted pull-up', assisted: true, settings: {},
    sets: [{ reps, weight }] });
  store.saveWorkouts([
    { id: 'ah1', startedAt: t - 3 * 864e5, finishedAt: t - 3 * 864e5 + 3600e3, entries: [ent(30, 8)] },
    { id: 'ah2', startedAt: t - 864e5, finishedAt: t - 864e5 + 3600e3, entries: [ent(25, 9)] },
  ]);
  enter();
  const title = () => root.querySelector('#chart-title').textContent;
  assert.equal(title(), 'Progress — assist (kg) — lower is stronger', 'the assist, and which way is better');
  assert.ok(pickEl().innerHTML.includes('−25×9'), 'the picked workout reads as a minus');
  const assistChips = () => root.querySelector('#assist-chips');
  assert.ok(/class="chip sel" data-view="assist"/.test(assistChips().innerHTML), 'Assist / Reps chips, Assist first');
  assistChips().listeners.click(clickOn('.chip', { view: 'reps' }));
  assert.equal(store.getSettings().historyAssistView, 'reps', 'the view is kept on the device');
  assert.equal(title(), 'Progress — reps at the least assist', 'and the chart shows the reps');
  enter();
  assert.equal(title(), 'Progress — reps at the least assist', 'it survives a tab tap');
  assistChips().listeners.click(clickOn('.chip', { view: 'assist' }));
  store.saveWorkouts([]);
}

// --- the Muscles card: a secondary share is said apart and worth half the bar ---
{
  const g = store.newLayout('Secondary history gym');
  g.machines.push({ id: 'cp', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [],
    muscles: ['Chest'], secondaryMuscles: ['Triceps'] });
  store.saveLayout(g);
  const t = Date.now();
  store.saveWorkouts([{ id: 'sh1', startedAt: t - 864e5, finishedAt: t - 864e5 + 3600e3,
    entries: [{ machineId: 'cp', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 40 }, { reps: 10, weight: 40 }] }] }]);
  enter();
  const row = (mu) => root.innerHTML.slice(root.innerHTML.indexOf(`data-muscle="${mu}"`)).split('</button>')[0];
  assert.ok(row('Chest').includes('2 sets · 1 workout') && row('Chest').includes('width:100%'), 'the chest: two sets, the full bar');
  assert.ok(row('Triceps').includes('0 sets + 2 secondary · 1 workout') && row('Triceps').includes('width:50%'),
    'the triceps: two secondary sets, half the bar');
  store.saveWorkouts([]);
}

// --- the heatmap's day line names a machine by its CURRENT number ---
// like the chips, the chart and the path card; the entry's snapshot only
// once the machine is gone
{
  const g = store.newLayout('Renumbered gym');
  g.machines.push({ id: 'rn', num: 7, label: 'Row', x: 0, y: 0, w: 4, h: 3, settingsFields: [] });
  store.saveLayout(g);
  const t = new Date();
  const at = new Date(t.getFullYear(), t.getMonth(), 1, 10).getTime();
  store.saveWorkouts([{ id: 'hn1', startedAt: at, finishedAt: at + 3600e3, entries: [
    { machineId: 'rn', num: 3, label: 'Row', settings: {}, sets: [{ reps: 10, weight: 40 }] },
    { machineId: 'gone', num: 5, label: 'Old', settings: {}, sets: [{ reps: 10, weight: 40 }] },
  ] }]);
  enter(); // an entry resets the heatmap to this month
  const cell = stubEl({ dataset: { day: '1' } });
  byId.set('#hm-grid', stubEl({ querySelectorAll: () => [cell] }));
  const info = stubEl();
  byId.set('#hm-info', info);
  openWorkouts(); // the heatmap lives on the Workouts screen
  cell.listeners.click();
  assert.ok(info.textContent.endsWith('#5, #7'), `live #7 for the renumbered machine, #5 for the gone one — ${info.textContent}`);
  backToOverview();
  store.saveWorkouts([]);
}

// --- the Muscles card counts resistance machines only, like the hints ---
// stats.js's muscle hints never counted a treadmill tagged Calves; the card
// did, so a row could read "3 sets" while its hint said it was untrained.
// Nor are cardio sets "lost": they were never muscle sets.
{
  const g = store.newLayout('Cardio muscles gym');
  g.machines.push(
    { id: 'tr', num: 1, label: 'Treadmill', x: 0, y: 0, w: 4, h: 3, settingsFields: [], cardio: true, muscles: ['Calves'] },
    { id: 'bk', num: 2, label: 'Bike', x: 6, y: 0, w: 4, h: 3, settingsFields: [], cardio: true },
    { id: 'cr', num: 3, label: 'Calf raise', x: 12, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Calves'] },
  );
  store.saveLayout(g);
  const t = Date.now();
  const run = (id) => ({ machineId: id, num: 1, label: 'x', cardio: true, settings: {}, sets: [{ distance: 1000, seconds: 300 }] });
  store.saveWorkouts([
    { id: 'cm1', startedAt: t - 2 * 864e5, finishedAt: t - 2 * 864e5 + 3600e3, entries: [run('tr'), run('bk'), run('gone')] },
    { id: 'cm2', startedAt: t - 864e5, finishedAt: t - 864e5 + 3600e3,
      entries: [{ machineId: 'cr', num: 3, label: 'Calf raise', settings: {}, sets: [{ reps: 12, weight: 30 }] }] },
  ]);
  enter();
  const row = (mu) => root.innerHTML.slice(root.innerHTML.indexOf(`data-muscle="${mu}"`)).split('</button>')[0];
  assert.ok(row('Calves').includes('1 set · 1 workout'), `the treadmill is no calf set — ${row('Calves')}`);
  assert.ok(!root.innerHTML.includes("can't be attributed"),
    'cardio sets — tagged, untagged or of a deleted cardio machine — are not reported as lost');
  const u = store.usageByMuscle(store.getWorkouts(), g);
  assert.deepEqual(u.get('Calves'), { sets: 1, secondary: 0, workouts: 1 }, 'usageByMuscle skips cardio machines');
  store.saveWorkouts([]);
}

// --- keepFocus: every control that redraws its own container hands the focus on ---
// ui.test.mjs pins the helper; this pins the seven CALL SITES (name chips,
// muscle rows, week tiles, machine chips, assist chips, range chips, path
// chips) — a site that loses its keepFocus() drops a keyboard user to <body>.
// The stub DOM has no focus: `document.activeElement` is a made-up control
// whose nearest [id] ancestor is the container, and the stub root answers the
// successor lookup (`#box [data-…]`) and records the focus() call. What it
// cannot prove — that a real browser keeps the caret on the new node — is the
// browser check in docs/testing.md's list, not this file's.
{
  const { cssStr } = await import(new URL('../app/js/ui.js', import.meta.url).href);
  const g = store.newLayout('Keep focus gym');
  g.machines.push(
    { id: 'ax', num: 17, label: 'Assisted pull-up', x: 0, y: 0, w: 4, h: 3, settingsFields: [], assisted: true, muscles: ['Back'] },
    { id: 'bx', num: 18, label: 'Chest press', x: 8, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Chest'] },
  );
  store.saveLayout(g);
  store.saveSettings({ ...store.getSettings(), historyRange: 'all', historyAssistView: 'assist', historyMetric: 'sets' });
  const t = Date.now();
  const ax = (weight, reps) => ({ machineId: 'ax', num: 17, label: 'Assisted pull-up', assisted: true, settings: {}, sets: [{ reps, weight }] });
  store.saveWorkouts([
    { id: 'kf1', name: 'Chest day', startedAt: t - 3 * 864e5, finishedAt: t - 3 * 864e5 + 3600e3,
      entries: [entry('bx', 18, 'Chest press', [{ reps: 10, weight: 50 }])] },
    { id: 'kf2', name: 'Pull day', startedAt: t - 864e5, finishedAt: t - 864e5 + 3600e3,
      entries: [ax(30, 8), entry('bx', 18, 'Chest press', [{ reps: 10, weight: 55 }])],
      visits: [{ machineId: 'ax', in: t - 864e5, out: t - 864e5 + 900e3 },
        { machineId: 'bx', in: t - 864e5 + 960e3, out: t - 864e5 + 1800e3 }] },
  ]);
  enter();
  tapMachine(K('ax'));
  const attrOf = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const allHtml = () => root.innerHTML + [...byId.values()].map((el) => el.innerHTML).join('');

  // Taps the control `dataset` inside #boxId (fire = the click), with the
  // focus on it; the lookup answers `exact` (a successor) or null (it is gone).
  const tapFocused = (boxId, dataset, fire, { gone = null } = {}) => {
    const asked = [];
    const focused = [];
    const active = { dataset, parentElement: { closest: (sel) => (sel === '[id]' ? { id: boxId } : null) } };
    const successor = { focus: (o) => focused.push(o) };
    const lookup = root.querySelector;
    root.contains = (el) => el === active;
    root.querySelector = function (sel) {
      if (/^#[\w-]+ \[data-/.test(sel)) { asked.push(sel); return gone ? null : successor; }
      if (gone && asked.length && sel === `#${boxId}`) return gone.box(); // only keepFocus's own re-lookup
      return lookup.call(this, sel);
    };
    if (gone) active.parentElement.closest = () => ({ id: boxId,
      querySelectorAll: () => gone.before.map((_, i) => (i === gone.at ? active : {})) });
    globalThis.document = { activeElement: active };
    try { fire(); } finally {
      delete globalThis.document;
      root.querySelector = lookup;
      delete root.contains;
    }
    return { asked, focused };
  };
  const expectKept = (boxId, dataset, fire, what) => {
    const { asked, focused } = tapFocused(boxId, dataset, fire);
    assert.deepEqual(asked, [`#${boxId} ${Object.entries(dataset)
      .map(([k, v]) => `[data-${attrOf(k)}="${cssStr(v)}"]`).join('')}`],
    `${what}: the successor is looked up in its own container by its data-* attributes`);
    assert.deepEqual(focused, [{ preventScroll: true }], `${what}: and gets the focus, without a scroll`);
    // the lookup must be satisfiable by the markup the render really wrote
    assert.ok(allHtml().includes(`id="${boxId}"`), `${what}: the container carries id="${boxId}"`);
    Object.entries(dataset).forEach(([k, v]) => assert.ok(
      allHtml().replaceAll('&quot;', '"').includes(`data-${attrOf(k)}="${v}"`),
      `${what}: the redraw wrote a control with data-${attrOf(k)}="${v}"`));
  };

  // 1. workout-name chips (renderHistory)
  expectKept('name-filter', { name: 'Pull day' },
    () => root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: 'Pull day' })),
    'name chip');
  assert.equal(root.querySelector('#name-filter') && /class="chip sel"\s+data-name="Pull day"/.test(root.innerHTML), true,
    'name chip: the tap really filtered (the focus assertion is not on a no-op)');
  root.querySelector('#name-filter').listeners.click(clickOn('.chip', { name: '' }));

  // 2. muscle rows (renderHistory)
  expectKept('muscle-list', { muscle: 'Back' },
    () => root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Back' })),
    'muscle row');
  assert.ok(root.innerHTML.includes('All muscles'), 'muscle row: the tap really filtered');

  // 3. week tiles (drawWeek)
  expectKept('week-tiles', { metric: 'volume' },
    () => root.querySelector('#week-tiles').listeners.click(clickOn('.tile', { metric: 'volume' })),
    'week tile');
  assert.equal(store.getSettings().historyMetric, 'volume', 'week tile: the tap really switched the metric');

  // 4. machine chips (drawProgress)
  expectKept('machine-chips', { key: K('bx') },
    () => tapMachine(K('bx')), 'machine chip');
  assert.equal(selKey(machineChips().innerHTML), K('bx'), 'machine chip: the tap really picked it');
  tapMachine(K('ax'));

  // 5. assist chips (drawProgress)
  expectKept('assist-chips', { view: 'reps' },
    () => root.querySelector('#assist-chips').listeners.click(clickOn('.chip', { view: 'reps' })),
    'assist chip');
  assert.equal(store.getSettings().historyAssistView, 'reps', 'assist chip: the tap really switched the view');

  // 6. range chips (drawProgress)
  expectKept('range-chips', { range: '4w' },
    () => root.querySelector('#range-chips').listeners.click(clickOn('.chip', { range: '4w' })),
    'range chip');
  assert.equal(store.getSettings().historyRange, '4w', 'range chip: the tap really switched the range');

  // 7. walking-path chips (drawPath)
  expectKept('path-chips', { wid: 'kf2' },
    () => root.querySelector('#path-chips').listeners.click(clickOn('.chip', { wid: 'kf2' })),
    'path chip');
  assert.ok(/class="chip sel"\s+data-wid="kf2"/.test(allHtml()), 'path chip: the tap really picked the route');

  // A control that vanishes in its own tap: the focus lands on the control at
  // its old position. Both are driven with the lookup answering "gone", the
  // way a real browser answers once the node is no longer in the markup.
  const buttonsOf = (html) => html.match(/<button\b[\s\S]*?<\/button>/g) ?? [];
  const textOf = (b) => b.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const stand = (boxId, dataset, before, at, fire, afterHtml) => {
    let landed = null;
    const after = [];
    const { focused } = tapFocused(boxId, dataset, fire, {
      gone: { before, at, box: () => ({ querySelectorAll: () => { after.length = 0;
        buttonsOf(afterHtml()).forEach((b) => after.push({ focus: () => { landed = textOf(b); } })); return after; } }) },
    });
    return { at: landed, focused };
  };

  // "+N more" (machine chips): ten machines, two behind it
  store.saveLayout((() => {
    const l = store.newLayout('Keep focus ten');
    for (let i = 0; i < 10; i++) l.machines.push({ id: `x${i}`, num: 20 + i, label: `Machine ${i}`, x: 0, y: 0, w: 4, h: 3, settingsFields: [] });
    return l;
  })());
  store.saveWorkouts(Array.from({ length: 10 }, (_, i) => ({
    id: `kx${i}`, startedAt: Date.UTC(2026, 6, 1 + i, 10), finishedAt: Date.UTC(2026, 6, 1 + i, 11),
    entries: [entry(`x${i}`, 20 + i, `Machine ${i}`, [{ reps: 10, weight: 20 + i }])],
  })));
  enter();
  const before = buttonsOf(machineChips().innerHTML);
  assert.equal(textOf(before.at(-1)), '+2 more', '"+N more": it is the last control of its row');
  const more = stand('machine-chips', { more: '1' }, before, before.length - 1,
    () => machineChips().listeners.click(clickOn('.chip', { more: '1' })),
    () => byId.get('#machine-chips').innerHTML); // not via root.querySelector: the probe answers that
  assert.ok(!machineChips().innerHTML.includes('data-more'), '"+N more": the tap removed the control itself');
  assert.equal(more.at, '#21 Machine 1', '"+N more": the focus lands on the first chip it revealed');

  // "All muscles": first row of the list, goes away with the filter
  store.saveLayout(g);
  store.saveWorkouts([
    { id: 'kf1', startedAt: Date.now() - 864e5, finishedAt: Date.now() - 864e5 + 3600e3,
      entries: [entry('bx', 18, 'Chest press', [{ reps: 10, weight: 50 }])] }]);
  enter();
  root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: 'Chest' }));
  const muscleHtml = () => { const h = root.innerHTML; const i = h.indexOf('id="muscle-list"'); return h.slice(i, h.indexOf('</section>', i)); };
  assert.equal(textOf(buttonsOf(muscleHtml())[0]), 'All muscles', '"All muscles": the first control of its list');
  const all = stand('muscle-list', { muscle: '' }, buttonsOf(muscleHtml()), 0,
    () => root.querySelector('#muscle-list').listeners.click(clickOn('.muscle-row', { muscle: '' })), muscleHtml);
  assert.ok(!muscleHtml().includes('All muscles'), '"All muscles": the tap removed the control itself');
  assert.ok(all.at?.startsWith('Chest'), '"All muscles": the focus lands on the list\'s first row');
  store.saveWorkouts([]);
}

// --- the machine icon after the number on every entry line, in the list and in the editor ---
{
  const g = store.newLayout('Icon history gym');
  g.machines.push({ id: 'ih', num: 14, label: 'Leg press', x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Quads'] });
  store.saveLayout(g);
  store.saveWorkouts([{
    id: 'wi', startedAt: Date.now() - 864e5, finishedAt: Date.now() - 864e5 + 3600e3,
    entries: [
      entry('ih', 14, 'Leg press', [{ reps: 10, weight: 80 }]),
      { ...entry('gone', 9, 'Old airdyne', [{ distance: 2, seconds: 600 }]), cardio: true },
    ],
  }]);
  enter();
  openWorkouts();
  const icon = (glyph) => `<span class="machine-icon" aria-hidden="true">${glyph}</span>`;
  assert.ok(list().innerHTML.includes(`#14 ${icon('🦵')} Leg press`), 'the list line reads the LIVE machine\'s muscles');
  assert.ok(list().innerHTML.includes(`#9 ${icon('❤️')} Old airdyne`), 'a machine gone from the gym: the entry\'s own flags');
  list().listeners.click(clickOn('.edit-w', { wid: 'wi' }));
  assert.ok(list().innerHTML.includes('class="edit-date"'), 'the editor is open');
  assert.ok(list().innerHTML.includes(`#14 ${icon('🦵')} Leg press`), 'the editor\'s entry title carries it too');
  store.saveWorkouts([]);
}

console.log('history: all assertions passed');
