// Untrusted input, end to end (store.js § untrusted input). A backup, a gym
// template, an AI-pasted plan and a sync blob are files someone else may
// have written; every view renders stored records into innerHTML. Two
// layers are pinned here, each on its own:
//   1. the entry points hold ids, numbers, colors and the unit to their
//      real shape — a crafted file is refused or repaired before storage;
//   2. the views escape those fields anyway — a record stored before the
//      entry checks existed (seeded here straight into storage, past every
//      check) still renders inert.
// The sync half of layer 1 lives in test/sync.test.mjs (block 19), next
// to the fake server it needs.
// Run with: node test/untrusted.test.mjs
import './helpers/localstorage.mjs'; // FIRST: installs the stub
import { strict as assert } from 'node:assert';

const store = await import(new URL('../js/store.js', import.meta.url).href);

const X = '"><img src=x onerror=alert(1)>';
// inert = the payload reached the markup, and only as text
const inert = (html, what) => {
  assert.ok(!String(html).includes('<img'), `${what}: stored markup rendered raw`);
  assert.ok(String(html).includes('&lt;img'), `${what}: the hostile value never reached the view`);
};
const noRaw = (html, what) => assert.ok(!String(html).includes('<img'), `${what}: stored markup rendered raw`);

// --- 1a. every id gymii ever minted stays valid ---
[
  store.uid(), // today's 16 base36 chars
  Math.random().toString(36).slice(2, 10), // the legacy 8-char ids
  'zone-freeweights', 'demo-plan-push', 'demo-mon-w1', // template and demo slugs
  'outline', 'm1',
].forEach((id) => assert.ok(store.isSafeId(id), `a minted id passes: ${id}`));
['m1' + X, 'a b', '', 7, null, undefined].forEach((id) =>
  assert.ok(!store.isSafeId(id), `not an id: ${String(id)}`));

// --- 1b. gym templates and backup layouts: a bad field refuses the file ---
const layoutOf = () => ({
  v: 1,
  name: 'Crafted',
  grid: { w: 40, h: 30 },
  outline: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }],
  shapes: [{ id: 'zone-a', kind: 'rect', x: 5, y: 5, w: 4, h: 4, color: '#35a273', label: 'Zone' }],
  machines: [{
    id: 'm1', num: 1, label: 'Row', x: 1, y: 1, w: 3, h: 3, color: '#3f7fd1', restSeconds: 60,
    settingsFields: [],
  }],
});
const template = (gym) => ({ app: 'gymii', kind: 'gym-template', v: 1, gym });
const backup = (extra) => ({ app: 'gymii', kind: 'backup', v: 2, gym: null, workouts: [], ...extra });

assert.equal(store.importData(template(layoutOf())), 'gym-template', 'a clean template imports');
[
  ['machine id', (l) => { l.machines[0].id += X; }],
  ['machine color', (l) => { l.machines[0].color += X; }],
  // one per key isPlaced checks
  ['machine x', (l) => { l.machines[0].x = `1${X}`; }],
  ['machine y', (l) => { l.machines[0].y = `1${X}`; }],
  ['machine w', (l) => { l.machines[0].w = `3${X}`; }],
  ['machine h', (l) => { l.machines[0].h = `3${X}`; }],
  ['machine rot', (l) => { l.machines[0].rot = `90${X}`; }],
  ['machine restSeconds', (l) => { l.machines[0].restSeconds = `60${X}`; }],
  ['shape id', (l) => { l.shapes[0].id += X; }],
  ['shape color', (l) => { l.shapes[0].color = `red${X}`; }],
  ['shape w', (l) => { l.shapes[0].w = `4${X}`; }],
].forEach(([what, spoil]) => {
  const l = layoutOf();
  l.name = 'Spoiled';
  spoil(l);
  assert.throws(() => store.importData(template(l)), /Invalid gym template/, `template: ${what}`);
  assert.throws(() => store.importData(backup({ gym: l })), /Invalid backup/, `backup: ${what}`);
});
assert.equal(store.getLayout().name, 'Crafted', 'a refused file leaves the stored layout alone');

// --- 1c. backup workouts: bad ids refuse the file, bad numbers are repaired ---
const workoutOf = () => ({
  id: 'w1',
  startedAt: 1000,
  finishedAt: 2000,
  entries: [{ machineId: 'm1', num: 1, label: 'Row', settings: {}, sets: [{ reps: 10, weight: 40 }] }],
});
store.importData(backup({ workouts: [workoutOf()] }));
[
  ['workout id', (w) => { w.id += X; }],
  ['entry machineId', (w) => { w.entries[0].machineId += X; }],
  ['entries', (w) => { delete w.entries; }],
].forEach(([what, spoil]) => {
  const w = workoutOf();
  w.id = 'w2';
  spoil(w);
  assert.throws(() => store.importData(backup({ workouts: [w] })), /Invalid backup/, `backup: ${what}`);
  assert.deepEqual(store.getWorkouts().map((x) => x.id), ['w1'], `${what}: nothing was restored`);
});
{
  const w = workoutOf();
  w.entries[0].num = `7${X}`;
  w.entries[0].sets = [{ reps: '12', weight: `40${X}` }, { distance: X, seconds: 600 }];
  store.importData(backup({ workouts: [w] }));
  const [entry] = store.getWorkouts()[0].entries;
  assert.equal('num' in entry, false, 'a num that is no number is dropped');
  assert.deepEqual(entry.sets, [{ reps: 12 }, { seconds: 600 }],
    'set numbers: a stringified one survives as a number, markup is dropped');
}

// --- 1d. backup plans: a bad id drops the plan, bad numbers are repaired ---
store.importData(backup({
  plans: [
    {
      id: 'p-ok',
      name: 'Ok',
      items: [{ machineId: null, name: 'Row', num: `3${X}`, target: { sets: '3', reps: 10, weight: X } }],
    },
    { id: `p${X}`, name: 'Bad id', items: [] },
    { id: 'p-bad-item', name: 'Bad item', items: [{ machineId: `m1${X}` }] },
    { id: 'p-str-item', name: 'String item', items: ['m1'] }, // items were always objects
  ],
}));
assert.deepEqual(store.getPlans().map((p) => p.id), ['p-ok'], 'plans with bad ids are dropped');
assert.deepEqual(store.getPlans()[0].items[0],
  { machineId: null, name: 'Row', target: { sets: 3, reps: 10 } },
  'plan item numbers: num dropped, target repaired');

// --- 1e. backup settings: a bad field keeps the device's own value ---
store.saveSettings({ ...store.getSettings(), unit: 'kg', restSeconds: 90, weightStep: 2.5 });
store.importData(backup({ settings: { unit: `kg${X}`, restSeconds: `90${X}`, weightStep: X } }));
{
  const s = store.getSettings();
  assert.equal(s.unit, 'kg', 'a unit that is neither kg nor lbs is refused');
  assert.equal(s.restSeconds, 90, 'a rest that is no number is refused');
  assert.equal(s.weightStep, 2.5, 'a weight step that is no number is refused');
}
store.importData(backup({ settings: { unit: 'lbs', restSeconds: '120' } }));
assert.equal(store.getSettings().unit, 'lbs', 'lbs is a unit');
assert.equal(store.getSettings().restSeconds, 120, 'a stringified rest survives as a number');
store.saveSettings({ ...store.getSettings(), unit: 'kg', restSeconds: 90 });

// --- 1f. AI-pasted workout plans: num is a number or nothing ---
{
  const l = layoutOf();
  l.machines.push({ id: 'm7', num: 7, label: 'Leg press', x: 10, y: 10, w: 3, h: 3, settingsFields: [] });
  store.importData(template(l));
  const { plan } = store.planFromImport({
    app: 'gymii',
    kind: 'workout-plan',
    name: 'AI',
    items: [{ name: 'Zzz', num: `4${X}` }, { name: 'Somewhere', num: '7' }, { name: 'Blank', num: '' }],
  });
  assert.equal('num' in plan.items[0], false, 'AI paste: a num that is no number is dropped');
  assert.equal(plan.items[1].machineId, 'm7', 'AI paste: a stringified num still binds');
  assert.equal('num' in plan.items[2], false, 'AI paste: an empty num is no machine 0');
  store.importData({ app: 'gymii', kind: 'workout-plan', name: 'Filed', items: [{ name: 'Zzz', num: X }] });
  const filed = store.getPlans().find((p) => p.name === 'Filed');
  assert.equal('num' in filed.items[0], false, 'workout-plan file: the same rule');
}

// ---------------------------------------------------------------------------
// 2. Old data: hostile values seeded straight into storage, past every entry
//    check — what an install that imported a crafted file before the checks
//    existed still holds. Every view must render them as text.
// ---------------------------------------------------------------------------

// Node has no ResizeObserver / DOMPoint; the gym editor wires both
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.DOMPoint = class {
  constructor(x, y) { this.x = x; this.y = y; }
  matrixTransform() { return { x: this.x, y: this.y }; }
};

const { renderTrain, goToStart, goToPlans, openPlanBuilder } = await import(
  new URL('../js/train.js', import.meta.url).href);
const { renderHistory } = await import(new URL('../js/history.js', import.meta.url).href);
const { renderSettings } = await import(new URL('../js/settings.js', import.meta.url).href);
const { renderGym, focusMachine } = await import(new URL('../js/gym.js', import.meta.url).href);
const { drawLayout } = await import(new URL('../js/map.js', import.meta.url).href);

// One permissive element stub: every selector resolves (memoised, so a
// listener wired on a nested element is still there when the test fires it)
const stubEl = () => {
  const kids = new Map();
  return {
    innerHTML: '',
    value: '',
    textContent: '',
    disabled: false,
    dataset: {},
    style: {},
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    getBoundingClientRect: () => ({ width: 358, height: 300 }),
    getScreenCTM: () => ({ inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) }),
    querySelector(sel) {
      if (!kids.has(sel)) kids.set(sel, stubEl());
      return kids.get(sel);
    },
    querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    scrollIntoView() {},
    focus() {},
  };
};
let root = stubEl();
const fresh = () => { root = stubEl(); return root; };
const click = (classes, dataset = {}) => ({
  target: {
    closest: () => ({ dataset, classList: { contains: (c) => classes.includes(c) } }),
  },
});

const HID = `m1${X}`; // a machine id that would close data-id="…"
const hostileLayout = () => {
  const l = store.newLayout('Old gym');
  l.machines.push({
    id: HID, num: `1${X}`, label: 'Row', x: 1, y: 1, w: 3, h: 3, color: `#35a273${X}`,
    restSeconds: `60${X}`, settingsFields: [], muscles: ['Back'],
  });
  l.machines.push({ id: 'm2', num: 2, label: 'Press', x: 10, y: 1, w: 3, h: 3, settingsFields: [], muscles: ['Back'] });
  l.machines.push({ id: 'm3', num: 3, label: 'Curl', x: 30, y: 1, w: 3, h: 3, settingsFields: [] });
  l.shapes.push({ id: 'zone-a', kind: 'rect', x: 20, y: 20, w: 5, h: 5, color: `#3f7fd1${X}` });
  return l;
};
store.saveLayout(hostileLayout());
store.saveWorkouts([{
  id: `w1${X}`,
  startedAt: Date.now() - 86400000,
  finishedAt: Date.now() - 86400000 + 3600000,
  name: 'Old',
  // logged at m2, so the editor offers the hostile machine to add; the
  // machine 'gone' was deleted since, so the heatmap filter lists its stored num
  entries: [{
    machineId: 'm2', num: `1${X}`, label: 'Row', settings: {},
    sets: [{ reps: `10${X}`, weight: `40${X}` }],
  }, {
    machineId: 'gone', num: `4${X}`, label: 'Gone', settings: {}, sets: [{ reps: 5, weight: 5 }],
  }],
  // a walked route m2 -> m1: the path card names its stops by num
  visits: [
    { machineId: 'm2', in: Date.now() - 86400000, out: Date.now() - 86400000 + 600000 },
    { machineId: HID, in: Date.now() - 86400000 + 600000, out: Date.now() - 86400000 + 1200000 },
  ],
}]);
store.savePlans([{
  id: `p1${X}`,
  name: 'Old plan',
  items: [{ machineId: HID, exercise: null }, { machineId: null, name: 'Lunge', num: `5${X}` },
    { machineId: null, name: 'Bike', target: { distance: `900${X}`, seconds: 600 } }],
}]);
store.saveSettings({
  ...store.getSettings(), unit: `kg${X}`, restSeconds: `90${X}`, weightStep: `2.5${X}`,
});

// --- the map (map.js drawLayout: colors and machine numbers) ---
{
  const svg = stubEl();
  drawLayout(svg, store.getLayout());
  inert(svg.innerHTML, 'map');
  for (const [what, needle] of [['zone color', '#3f7fd1&quot;'], ['machine color', '#35a273&quot;'],
    ['machine num', '1&quot;&gt;&lt;img']]) {
    assert.ok(svg.innerHTML.includes(needle), `map: ${what} rendered escaped`);
  }
  // each color is written twice (fill and stroke): both copies are escaped
  assert.equal(svg.innerHTML.split('#3f7fd1&quot;').length - 1, 2, 'map: zone fill and stroke');
  assert.equal(svg.innerHTML.split('#35a273&quot;').length - 1, 2, 'map: machine fill and stroke');
  // geometry: every number the editor draws, grid and outline included
  const g = store.getLayout();
  g.grid = { w: `60${X}`, h: `40${X}` };
  g.outline = [{ x: `0${X}`, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }];
  g.machines[0] = { ...g.machines[0], x: `1${X}`, y: `1${X}`, w: `3${X}`, h: `3${X}` };
  g.shapes.push({ id: 'door-a', kind: 'fixture', fixture: 'door', x: `5${X}`, y: 0, w: 2.4, h: 1.2, rot: `90${X}` });
  g.shapes.push({ id: 'wall-a', kind: 'line', x: `5${X}`, y: 10, w: 8, h: 0 });
  const editorSvg = stubEl();
  drawLayout(editorSvg, g, { editor: true, selectedId: HID });
  noRaw(editorSvg.innerHTML, 'map editor, hostile geometry');
  assert.ok(editorSvg.innerHTML.includes('NaN'), 'map: hostile geometry draws as an inert NaN');
  assert.equal(g.grid.w, `60${X}`, 'map: the caller\'s layout is untouched');
  // one grid side at a time: the grid lines loop over the OTHER side, so a
  // single hostile side is the one that would reach the markup
  for (const grid of [{ w: 60, h: `40${X}` }, { w: `60${X}`, h: 40 }]) {
    const one = stubEl();
    drawLayout(one, { ...store.getLayout(), grid }, { editor: true });
    noRaw(one.innerHTML, `map editor, grid ${JSON.stringify(grid)}`);
  }
}

// --- Settings: rest, weight step, unit ---
renderSettings(fresh());
inert(root.innerHTML, 'settings');
assert.ok(root.innerHTML.includes(`value="90&quot;`), 'settings: rest seconds escaped');
assert.ok(root.innerHTML.includes(`value="2.5&quot;`), 'settings: weight step escaped');
assert.ok(root.innerHTML.includes('Weight step (kg&quot;'), 'settings: unit escaped');

// --- History: the workout card, its editor, the machine picker ---
renderHistory(fresh(), { entry: true });
noRaw(root.innerHTML, 'history overview');
inert(root.querySelector('#path-stats').innerHTML, 'walking path card');
assert.ok(root.querySelector('#path-stats').innerHTML.includes('#1&quot;'), 'path card: stop num escaped');
root.querySelector('#open-workouts').listeners.click();
inert(root.innerHTML, 'history workouts screen');
assert.ok(root.innerHTML.includes('">#4&quot;'), 'heatmap filter: a deleted machine\'s stored num escaped');
{
  const list = root.querySelector('#workout-list');
  inert(list.innerHTML, 'history workout card');
  assert.equal(list.innerHTML.split(`data-wid="w1&quot;`).length - 1, 3,
    'history: repeat, edit and delete all carry the id escaped');
  assert.ok(list.innerHTML.includes('40&quot;&gt;&lt;img'), 'history: set text escaped');
  assert.ok(list.innerHTML.includes('#1&quot;'), 'history: machine chain escaped');
  list.listeners.click({
    target: {
      closest: (q) => (q === '.edit-w' ? { dataset: { wid: `w1${X}` }, classList: { contains: () => false } } : null),
    },
  });
  inert(list.innerHTML, 'history editor');
  for (const [what, needle] of [
    ['weight', 'value="40&quot;'], ['reps', 'value="10&quot;'],
    ['unit label', '(kg&quot;'], ['unit text', '> kg&quot;'],
    ['entry title', '#1&quot;&gt;&lt;img'], ['machine option', `<option value="m1&quot;`],
  ]) assert.ok(list.innerHTML.includes(needle), `history editor: ${what} escaped`);
}
// a cardio set in the editor
store.saveWorkouts([{
  id: 'w-cardio',
  startedAt: Date.now() - 86400000,
  entries: [{ machineId: 'm2', num: 2, label: 'Bike', cardio: true, settings: {}, sets: [{ distance: `900${X}`, seconds: 600 }] }],
}]);
renderHistory(fresh(), { entry: true });
root.querySelector('#open-workouts').listeners.click();
root.querySelector('#workout-list').listeners.click({
  target: {
    closest: (q) => (q === '.edit-w' ? { dataset: { wid: 'w-cardio' }, classList: { contains: () => false } } : null),
  },
});
inert(root.querySelector('#workout-list').innerHTML, 'history editor, cardio set');
assert.ok(root.querySelector('#workout-list').innerHTML.includes('value="900&quot;'),
  'history editor: distance escaped');

// --- Train: start screen (routines), plan list, plan builder ---
// the older workout becomes a routine row (the newest one is "Repeat last")
store.saveWorkouts([{
  id: `w1${X}`,
  startedAt: Date.now() - 2 * 86400000,
  finishedAt: Date.now() - 2 * 86400000 + 3600000,
  entries: [{
    machineId: 'm2', num: `1${X}`, label: 'Row', settings: {}, sets: [{ reps: 10, weight: 40 }],
  }],
}, {
  id: 'w-last',
  startedAt: Date.now() - 86400000,
  finishedAt: Date.now() - 86400000 + 3600000,
  entries: [{ machineId: HID, num: 1, label: 'Row', settings: {}, sets: [{ reps: 10, weight: 40 }] }],
}]);
goToStart();
renderTrain(fresh());
inert(root.innerHTML, 'train start screen');
assert.equal(root.innerHTML.split(`data-wid="w1&quot;`).length - 1, 2,
  'start screen: open and repeat carry the workout id escaped');
assert.equal(root.innerHTML.split(`data-pid="p1&quot;`).length - 1, 2,
  'start screen: open and start carry the plan id escaped');
assert.ok(root.innerHTML.includes(' kg&quot;'), 'start screen: the totals unit is escaped');
{
  // the picker's muscle filter lists matching machines as chips
  const picker = root.querySelector('#picker');
  picker.querySelector('.pick-muscle').value = 'Back';
  picker.querySelector('.pick-muscle').listeners.change();
  inert(picker.querySelector('.pick-chips').innerHTML, 'machine picker chips');
  assert.ok(picker.querySelector('.pick-chips').innerHTML.includes(`data-id="m1&quot;`),
    'machine picker: chip id escaped');
}

goToPlans();
renderTrain(fresh());
inert(root.innerHTML, 'train plans screen');

openPlanBuilder(`p1${X}`);
renderTrain(fresh());
inert(root.innerHTML, 'plan builder');
assert.ok(root.innerHTML.includes(`data-id="m1&quot;`), 'plan builder: machine chip id escaped');
assert.ok(root.innerHTML.includes('data-step="2.5&quot;'), 'plan builder: weight step escaped');
assert.ok(root.innerHTML.includes('data-kind="distance" value="900&quot;'), 'plan builder: cardio target escaped');
// open the bind prompt on the unbound item (index 1)
root.querySelector('#plan-items').listeners.click(click(['it-bind'], { i: '1' }));
inert(root.innerHTML, 'plan builder, bind prompt');
assert.ok(root.innerHTML.includes('value="5&quot;'), 'bind prompt: the item num escaped');
assert.ok(root.innerHTML.includes(`data-i="1" data-id="m1&quot;`), 'bind prompt: the chip id escaped');
root.querySelector('#plan-cancel').listeners.click();

// --- Train: a running workout (log screen, overview, bind screen) ---
store.saveActive({
  v: 2,
  id: 'w-now',
  startedAt: Date.now() - 600000,
  plan: [{ machineId: HID, exercise: null, target: { sets: 3, reps: 10, weight: `50${X}` } },
    { machineId: 'm2', exercise: null }],
  currentMachineId: HID,
  currentExercise: null,
  restOverrides: { [HID]: `75${X}` },
  entries: [{ machineId: HID, num: `1${X}`, label: 'Row', settings: {}, sets: [{ reps: `8${X}`, weight: `45${X}` }] }],
});
renderTrain(fresh());
inert(root.innerHTML, 'log screen');
for (const [what, needle] of [
  ['badge', '<span class="machine-badge">1&quot;'],
  ['logged set', `<span>45&quot;&gt;&lt;img src=x onerror=alert(1)&gt; kg&quot;`],
  ['last sets', 'Last: 40×10 kg&quot;'],
  ['weight step', 'data-step="2.5&quot;'],
  ['target', 'Target: 3 × 10 @ 50&quot;'],
  ['keep rest', 'Keep 75&quot;'],
  ['log button', '— 45&quot;'],
  ['stepper value', 'value="75&quot;'],
]) assert.ok(root.innerHTML.includes(needle), `log screen: ${what} escaped`);
{
  // "where is it?": the fullscreen map overlay, built on document.body
  const made = [];
  globalThis.document = { createElement: () => { const el = stubEl(); made.push(el); return el; }, body: { appendChild() {} } };
  try {
    root.querySelector('#locate-current').listeners.click();
  } finally {
    delete globalThis.document;
  }
  inert(made[0].innerHTML, 'map overlay');
  assert.ok(made[0].innerHTML.includes('<span class="machine-badge">1&quot;'), 'map overlay: badge escaped');
}

// the other side: m2 is current, m1 is next — and m1, trained a moment
// ago, is one tap away in the quick switch
const timed = store.getActive();
timed.entries[0].sets[0].at = Date.now() - 60000;
store.saveActive({ ...timed, currentMachineId: 'm2', restOverrides: {} });
renderTrain(fresh());
inert(root.innerHTML, 'log screen, next machine');
assert.ok(root.innerHTML.includes('Next: #1&quot;'), 'log screen: next machine num escaped');
assert.ok(root.innerHTML.includes('↩ #1&quot;'), 'log screen: quick switch num escaped');
// m3 is next, m1 the open slot nearby
store.saveActive({
  ...store.getActive(),
  plan: [{ machineId: 'm2', exercise: null }, { machineId: 'm3', exercise: null }, ...timed.plan],
});
renderTrain(fresh());
inert(root.innerHTML, 'log screen, nearby machine');
assert.ok(root.innerHTML.includes('Busy? #1&quot;'), 'log screen: nearby num escaped');
store.saveActive({ ...store.getActive(), plan: timed.plan });

store.saveActive({ ...store.getActive(), currentMachineId: null });
renderTrain(fresh());
inert(root.innerHTML, 'workout overview');
assert.ok(root.innerHTML.includes('<span class="machine-badge sm">1&quot;'), 'overview: badge escaped');
// the logged set multiplies to NaN, so the totals read "0 <unit>"
assert.ok(root.innerHTML.includes('· 0 kg&quot;'), 'overview: totals unit escaped');
{
  // a slot's target set count, copied from a plan stored before the checks
  const a = store.getActive();
  store.saveActive({ ...a, plan: [{ ...a.plan[0], target: { ...a.plan[0].target, sets: `3${X}` } }, ...a.plan.slice(1)] });
  renderTrain(fresh());
  inert(root.innerHTML, 'workout overview, slot status');
  assert.ok(root.innerHTML.includes('1/3&quot;'), 'overview: slot target escaped');
  store.saveActive(a);
}

store.saveActive({
  ...store.getActive(),
  plan: [...store.getActive().plan, { machineId: null, name: 'Lunge', num: `5${X}` }],
  binding: 2,
});
renderTrain(fresh());
inert(root.innerHTML, 'bind screen');
assert.ok(root.innerHTML.includes('value="5&quot;'), 'bind screen: slot num escaped');
assert.ok(root.innerHTML.includes(`data-id="m1&quot;`), 'bind screen: chip id escaped');
store.clearActive();

// --- Gym editor: machine list, machine props, floor size ---
store.saveLayout({ ...hostileLayout(), grid: { w: `60${X}`, h: `40${X}` } });
renderGym(fresh());
{
  const props = root.querySelector('#props');
  inert(props.innerHTML, 'gym editor, layout card');
  assert.ok(props.innerHTML.includes('id="floor-w" type="number" inputmode="numeric" value="60&quot;'),
    'gym editor: floor width escaped');
  assert.ok(props.innerHTML.includes('value="40&quot;'), 'gym editor: floor height escaped');
  props.querySelector('#edit-machines').listeners.click();
  inert(props.innerHTML, 'gym editor, machine list');
  assert.ok(props.innerHTML.includes('data-field="num"\n            value="1&quot;'),
    'gym editor: list num escaped');
}
focusMachine(HID);
renderGym(fresh());
inert(root.querySelector('#props').innerHTML, 'gym editor, machine card');
assert.ok(root.querySelector('#props').innerHTML.includes('id="m-num" type="number" inputmode="numeric" value="1&quot;'),
  'gym editor: machine num escaped');

console.log('untrusted input: all assertions passed');
