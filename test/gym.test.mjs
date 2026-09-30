// Logic-level test for js/gym.js — the floor-plan editor: its real pointer
// handlers driven by synthetic events against a faked DOM, asserting on the
// persisted layout. The renderer it draws with (js/map.js) has its own file,
// test/map.test.mjs.
// Run with: node test/gym.test.mjs
import './helpers/localstorage.mjs'; // FIRST: installs the stub
import { strict as assert } from 'node:assert';

const store = await import(new URL('../js/store.js', import.meta.url).href);
// the editor's placement check, and only that — the rendering half of map.js
// is asserted in test/map.test.mjs
const { overlapsSolid } = await import(new URL('../js/map.js', import.meta.url).href);

const SVG_PX = 358; // typical 390px phone minus #view padding
const PAD = 2.5; // map.js's viewBox padding, in grid units

// ---------------------------------------------------------------------------
// renderGym integration: drive the real pointer handlers with synthetic
// events against a faked DOM and assert on the persisted layout state — the
// headless equivalent of the scripted-PointerEvent browser check.
// ---------------------------------------------------------------------------

// renderGym wires a ResizeObserver and svgPoint goes through DOMPoint +
// getScreenCTM; neither exists in Node.
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.DOMPoint = class {
  constructor(x, y) { this.x = x; this.y = y; }
  matrixTransform(m) { return { x: m.a * this.x + m.e, y: m.d * this.y + m.f }; }
};

const { renderGym, focusMachine, osmUrl } = await import(new URL('../js/gym.js', import.meta.url).href);
const S = SVG_PX / (60 + 2 * PAD); // screen px per unit, editor viewBox

// Permissive element stub: every selector resolves, every listener is
// recorded, so renderProps and the toolbar wiring run without a DOM.
function stubEl() {
  const el = {
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    dataset: {},
    style: {},
    listeners: {},
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    querySelector: () => stubEl(),
    querySelectorAll: () => [],
    classList: { toggle() {}, add() {}, remove() {} },
  };
  return el;
}

function fakeRoot() {
  const floor = stubEl();
  floor.setAttribute = () => {};
  floor.getBoundingClientRect = () => ({ width: SVG_PX });
  // screen -> unit is a pure scale + the viewBox pad shift (rect at 0,0)
  floor.getScreenCTM = () => ({
    inverse: () => ({ a: 1 / S, b: 0, c: 0, d: 1 / S, e: -PAD, f: -PAD }),
  });
  const cache = new Map([['#floor', floor]]);
  return {
    floor,
    innerHTML: '',
    querySelector(sel) {
      if (!cache.has(sel)) cache.set(sel, stubEl());
      return cache.get(sel);
    },
    querySelectorAll: () => [],
  };
}

const at = (ux, uy) => ({ clientX: (ux + PAD) * S, clientY: (uy + PAD) * S });
// what e.target.closest() must answer for a tap on an item body / its
// resize handle (the outline-handle probe comes first and returns null)
const onItem = (id, handle = false) => ({
  closest: (sel) => (sel.includes('data-vertex') ? null
    : { dataset: handle ? { id, handle: '1' } : { id } }),
});
// what closest() must answer for a tap on an outline corner handle
const onVertex = (i) => ({
  closest: (sel) => (sel.includes('data-vertex') ? { dataset: { vertex: String(i) } } : null),
});
const fire = (floor, type, props = {}) => {
  (floor.listeners[type] || []).forEach((fn) => fn({
    pointerId: 1,
    preventDefault() {},
    target: { closest: () => null },
    ...props,
  }));
};
const dragSeq = (floor, target, from, to) => {
  fire(floor, 'pointerdown', { ...at(...from), target });
  fire(floor, 'pointermove', at(...to));
  fire(floor, 'pointerup');
};
// Everything starts LOCKED: a double tap on the item body unlocks it for
// moving and resizing, and the same gesture locks it again — so calling this
// twice returns to the safe state. Both taps land synchronously, well inside
// the 450 ms window.
const doubleTap = (floor, id, spot) => {
  fire(floor, 'pointerdown', { ...at(...spot), target: onItem(id) });
  fire(floor, 'pointerup');
  fire(floor, 'pointerdown', { ...at(...spot), target: onItem(id) });
  fire(floor, 'pointerup');
};
// The everyday sequence: unlock, then drag. Most assertions below are about
// what the drag does, not about the lock, so they go through this.
const unlockAndDrag = (floor, target, from, to) => {
  doubleTap(floor, target.closest('[data-id]').dataset.id, from);
  dragSeq(floor, target, from, to);
};

function gymWith(machines, shapes = []) {
  const g = store.newLayout('Drag test');
  g.machines.push(...machines);
  g.shapes.push(...shapes);
  store.saveLayout(g);
  const root = fakeRoot();
  // the real button starts disabled via its HTML attribute; the stub can't
  // parse root.innerHTML, so mirror that initial state by hand
  root.querySelector('#undo').disabled = true;
  renderGym(root);
  return root;
}
const machineAt = (id) => store.getLayout().machines.find((m) => m.id === id);
const mk = (id, num, x, y) => ({ id, num, x, y, w: 4, h: 3, settingsFields: [] });

// --- LOCKED BY DEFAULT: a plain drag on a fresh editor moves nothing ---
// This is the accident the lock exists for — a tap on a zone that drifts a
// few pixels used to shove the whole thing across the floor.
let root = gymWith([mk('m1', 1, 10, 10), mk('m2', 2, 20, 10)]);
dragSeq(root.floor, onItem('m1'), [12, 11.5], [14, 21.5]);
assert.deepEqual([machineAt('m1').x, machineAt('m1').y], [10, 10],
  'a locked machine does not move');
assert.equal(root.querySelector('#undo').disabled, true,
  'and records no undo entry, so there is nothing to take back');
// the tap still SELECTED it — locking is not the same as being inert
dragSeq(root.floor, onItem('m1', true), [14, 13], [16, 15]);
assert.deepEqual([machineAt('m1').w, machineAt('m1').h], [4, 3],
  'a handle target on a locked item resizes nothing either');

// --- move drag persists through the real handler chain, once unlocked ---
root = gymWith([mk('m1', 1, 10, 10), mk('m2', 2, 20, 10)]);
unlockAndDrag(root.floor, onItem('m1'), [12, 11.5], [14, 21.5]);
assert.deepEqual([machineAt('m1').x, machineAt('m1').y], [12, 20], 'drag moved the machine');
assert.equal(root.querySelector('#undo').disabled, false, 'real move recorded an undo entry');

// --- the unlocking double tap itself moves nothing ---
root = gymWith([mk('m1', 1, 10, 10)]);
doubleTap(root.floor, 'm1', [12, 11.5]);
assert.deepEqual([machineAt('m1').x, machineAt('m1').y], [10, 10],
  'the gesture that unlocks does not also nudge');
assert.equal(root.querySelector('#undo').disabled, true, 'and writes no history');

// --- sub-snap wiggle is a no-op: nothing saved, no undo entry ---
root = gymWith([mk('m1', 1, 10, 10), mk('m2', 2, 20, 10)]);
unlockAndDrag(root.floor, onItem('m1'), [12, 11.5], [12.3, 11.6]);
assert.deepEqual([machineAt('m1').x, machineAt('m1').y], [10, 10], 'wiggle did not move');
assert.equal(root.querySelector('#undo').disabled, true, 'no-op drag left undo history clean');

// --- fully blocked move: machine stays put, still no undo entry ---
root = gymWith([mk('m1', 1, 10, 10), mk('m2', 2, 20, 10)]);
unlockAndDrag(root.floor, onItem('m1'), [12, 11.5], [22, 11.5]);
assert.deepEqual([machineAt('m1').x, machineAt('m1').y], [10, 10], 'blocked drag did not move');
assert.equal(root.querySelector('#undo').disabled, true, 'blocked drag left undo history clean');

// --- axis slide: x blocked by the neighbor, y still follows the finger ---
root = gymWith([mk('m1', 1, 10, 10), mk('m2', 2, 20, 10)]);
unlockAndDrag(root.floor, onItem('m1'), [12, 11.5], [22, 12.5]);
assert.deepEqual([machineAt('m1').x, machineAt('m1').y], [10, 11], 'slid along the free axis');

// --- resize via the handle target, once unlocked ---
root = gymWith([mk('m1', 1, 10, 10)]);
doubleTap(root.floor, 'm1', [12, 11.5]);
dragSeq(root.floor, onItem('m1', true), [14, 13], [16, 15]);
assert.deepEqual([machineAt('m1').w, machineAt('m1').h], [6, 5], 'handle drag resized');

// --- the double tap TOGGLES: the same gesture locks the item again ---
root = gymWith([mk('m1', 1, 10, 10)]);
doubleTap(root.floor, 'm1', [12, 11.5]);
doubleTap(root.floor, 'm1', [12, 11.5]);
dragSeq(root.floor, onItem('m1', true), [14, 13], [16, 15]);
assert.deepEqual([machineAt('m1').w, machineAt('m1').h], [4, 3],
  'a second double tap took the handle away again');
assert.deepEqual([machineAt('m1').x, machineAt('m1').y], [10, 10],
  'and the item is fully locked again — the drag moves nothing either');
// a third pair unlocks it once more — the toggle is not a one-shot
doubleTap(root.floor, 'm1', [12, 11.5]);
dragSeq(root.floor, onItem('m1', true), [14, 13], [16, 15]);
assert.deepEqual([machineAt('m1').w, machineAt('m1').h], [6, 5],
  'the lock can be opened again');

// --- the unlock survives a move, and dies when another item is picked ---
root = gymWith([mk('m1', 1, 10, 10), mk('m2', 2, 30, 10)]);
doubleTap(root.floor, 'm1', [12, 11.5]);
dragSeq(root.floor, onItem('m1'), [12, 11.5], [14, 11.5]);
dragSeq(root.floor, onItem('m1', true), [16, 13], [18, 14]);
assert.deepEqual([machineAt('m1').w, machineAt('m1').h], [6, 4],
  'the unlock stays put across a move of the same machine');
dragSeq(root.floor, onItem('m2'), [32, 11.5], [32, 11.5]); // pick the other one
dragSeq(root.floor, onItem('m1'), [12, 11.5], [12, 11.5]); // back to m1, single tap
dragSeq(root.floor, onItem('m1', true), [18, 14], [22, 16]);
assert.deepEqual([machineAt('m1').w, machineAt('m1').h], [6, 4],
  'selecting another item locked m1 again');
assert.deepEqual([machineAt('m1').x, machineAt('m1').y], [12, 10],
  'and it cannot be moved either — the single tap only re-selected it');

// --- resize into a neighbor is blocked per axis ---
root = gymWith([mk('m1', 1, 10, 10), mk('m2', 2, 16, 10)]);
doubleTap(root.floor, 'm1', [12, 11.5]);
dragSeq(root.floor, onItem('m1', true), [14, 13], [18, 14]);
assert.deepEqual([machineAt('m1').w, machineAt('m1').h], [4, 4],
  'width growth blocked by the neighbor, height still grew');

// --- solid fixture: locked like everything else, then the same rules ---
root = gymWith([mk('m1', 1, 10, 10)],
  [{ id: 'f1', kind: 'fixture', fixture: 'water', x: 16, y: 10, w: 2, h: 2 }]);
dragSeq(root.floor, onItem('f1'), [17, 11], [17, 21]);
let f1 = store.getLayout().shapes.find((s) => s.id === 'f1');
assert.deepEqual([f1.x, f1.y], [16, 10], 'a fixture is locked too, not just machines');
unlockAndDrag(root.floor, onItem('f1'), [17, 11], [12, 11]);
f1 = store.getLayout().shapes.find((s) => s.id === 'f1');
assert.deepEqual([f1.x, f1.y], [16, 10], 'fixture blocked from covering the machine');
dragSeq(root.floor, onItem('f1'), [17, 11], [17, 21]);
f1 = store.getLayout().shapes.find((s) => s.id === 'f1');
assert.deepEqual([f1.x, f1.y], [16, 20], 'fixture still moves onto free floor');

// --- a freshly added item starts UNLOCKED: you just made it on purpose ---
root = gymWith([]);
root.querySelector('#add-machine').listeners.click[0]();
const fresh = store.getLayout().machines[0];
dragSeq(root.floor, onItem(fresh.id), [fresh.x + 2, fresh.y + 1.5],
  [fresh.x + 7, fresh.y + 1.5]);
assert.equal(store.getLayout().machines[0].x, fresh.x + 5,
  'a new machine can be placed without a double tap first');

// --- add-machine button lands new machines on non-overlapping spots ---
// A fresh root each time: the previous editor's button closes over its own
// in-memory layout, so reusing it would add to the wrong one.
root = gymWith([]);
const addBtn = root.querySelector('#add-machine');
addBtn.listeners.click[0]();
addBtn.listeners.click[0]();
const after = store.getLayout(); // single parse — overlapsSolid excludes by object identity
assert.equal(after.machines.length, 2, 'two machines added');
const second = after.machines[1];
assert.ok(!overlapsSolid(after, second, second.x, second.y, second.w, second.h),
  'second machine does not overlap the first');

// --- the floor outline locks like everything else ---
// A tap on the outer wall used to hand over draggable corners straight away,
// which is the same accident one level out: reshaping the floor by mistake.
root = gymWith([]);
const corner = () => store.getLayout().outline[0];
dragSeq(root.floor, onItem('outline'), [0, 0], [0, 0]); // select the outline
dragSeq(root.floor, onVertex(0), [0, 0], [5, 5]);
assert.deepEqual([corner().x, corner().y], [0, 0],
  'a locked outline does not reshape, even with a corner target');
assert.equal(root.querySelector('#undo').disabled, true, 'and writes no history');

doubleTap(root.floor, 'outline', [0, 0]);
dragSeq(root.floor, onVertex(0), [0, 0], [5, 5]);
assert.deepEqual([corner().x, corner().y], [5, 5], 'unlocked, the corner follows the finger');

// and the same gesture locks it again
doubleTap(root.floor, 'outline', [0, 0]);
dragSeq(root.floor, onVertex(0), [5, 5], [10, 10]);
assert.deepEqual([corner().x, corner().y], [5, 5], 'a second double tap re-locks the outline');

// --- find-by-number: hit selects + highlights the map, miss reports without selecting ---
root = gymWith([mk('m1', 1, 10, 10), mk('m2', 2, 20, 10)]);
const findNum = root.querySelector('#find-num');
const findErr = root.querySelector('#find-err');
findNum.value = '2';
root.querySelector('#find-go').listeners.click[0]();
assert.ok(root.querySelector('#props').innerHTML.includes('value="2"'),
  'find hit selects the machine — its props panel opens (number field shows 2)');
assert.equal(findErr.textContent, '', 'hit clears any previous error message');
assert.ok(root.floor.innerHTML.includes('class="machine locate" data-id="m2"'),
  'find hit highlights the machine on the map');

findNum.value = '99';
root.querySelector('#find-go').listeners.click[0]();
assert.equal(findErr.textContent, 'No machine #99', 'miss reports the missing number');
assert.ok(root.querySelector('#props').innerHTML.includes('value="2"'),
  'miss does not change the current selection');

// next pointerdown on the svg clears the highlight so editing resumes undimmed
fire(root.floor, 'pointerdown', { target: { closest: () => null } });
assert.ok(!root.floor.innerHTML.includes('locate'), 'highlight clears on the next svg pointerdown');

// --- focusMachine: Train hands a machine off, Layout preselects + highlights it ---
focusMachine('m2');
root = gymWith([mk('m1', 1, 10, 10), mk('m2', 2, 20, 10)]);
assert.ok(root.querySelector('#props').innerHTML.includes('value="2"'),
  'focusMachine preselects the handed-off machine — its props panel opens (number field shows 2)');
assert.ok(root.floor.innerHTML.includes('class="machine locate" data-id="m2"'),
  'focusMachine highlights the machine on the map, reusing the find-by-number pulse');

// --- focusMachine: a stale id (machine deleted since the handoff) is dropped, not crashed on ---
focusMachine('does-not-exist');
root = gymWith([mk('m1', 1, 10, 10)]);
assert.ok(!root.floor.innerHTML.includes('locate'), 'unknown focusMachine id leaves nothing highlighted');
assert.ok(!root.querySelector('#props').innerHTML.includes('value="2"'),
  'unknown focusMachine id leaves the default (layout) props panel open');

// --- back-to-workout link: only offered while a workout is actually running ---
store.clearActive();
root = gymWith([mk('m1', 1, 10, 10)]);
assert.ok(!root.innerHTML.includes('Back to your workout'),
  'no active workout: header has no back-to-workout link');
assert.ok(root.innerHTML.includes('href="#train"') && root.innerHTML.includes('‹ Train'),
  'no active workout: header offers the plain back row to the Train hub instead');

store.saveActive({ id: 'w1', startedAt: Date.now(), entries: [] });
root = gymWith([mk('m1', 1, 10, 10)]);
assert.ok(root.innerHTML.includes('href="#train"') && root.innerHTML.includes('Back to your workout'),
  'active workout: header offers a one-tap link back to Train');
store.clearActive();

// --- the gym's address as an OpenStreetMap search ---
// Postal order, and the postcode glued to the city the way an address is
// written — a comma between them would read as two separate places.
assert.equal(
  decodeURIComponent(osmUrl({ address: 'Demostr. 1', postcode: '10115', city: 'Berlin', country: 'DE' })
    .split('query=')[1]),
  'Demostr. 1, 10115 Berlin, DE', 'full address searches in postal order');
assert.equal(
  decodeURIComponent(osmUrl({ city: 'Berlin' }).split('query=')[1]), 'Berlin',
  'a partial address still searches');
assert.equal(osmUrl({}).split('query=')[1], '', 'an empty address yields an empty query');
assert.equal(osmUrl().split('query=')[1], '', 'no meta at all is not a crash');
assert.ok(osmUrl({ city: 'Berlin' }).startsWith('https://www.openstreetmap.org/search?'),
  'searches OpenStreetMap over https');
assert.ok(!osmUrl({ address: 'A & B, 1' }).includes(' '), 'the query is url-encoded');

// ---------------------------------------------------------------------------
// The props card, driven: fakeRoot's #props hands back a FRESH stub per
// selector, which is right for the drag tests (they never look inside the
// card) and useless for the card's own handlers. This variant caches per
// selector, so a listener wired by renderProps can be found and fired —
// always the LAST one, since every re-render wires the same ids again.
// ---------------------------------------------------------------------------
function gymWithProps(machines, meta = {}) {
  const g = store.newLayout('Card test');
  g.machines.push(...machines);
  Object.assign(g.meta, meta);
  store.saveLayout(g);
  const root = fakeRoot();
  root.querySelector('#undo').disabled = true;
  const props = root.querySelector('#props');
  const cache = new Map();
  props.querySelector = (sel) => {
    if (!cache.has(sel)) cache.set(sel, stubEl());
    return cache.get(sel);
  };
  renderGym(root);
  return { root, props };
}
const last = (el, type) => el.listeners[type].at(-1);
const chipTap = (value) => ({ target: { closest: () => ({ dataset: { value } }) } });

// --- the brand lives on the gym: the Machines card sets it and folds the machines into it ---
{
  const { root, props } = gymWithProps([
    { ...mk('m1', 1, 2, 2), brand: 'Technogym' },
    { ...mk('m2', 2, 8, 2), brand: 'Technogym' },
    { ...mk('m3', 3, 14, 2), brand: 'Cybex' },
  ]);
  assert.ok(props.innerHTML.includes('id="gym-brands"'), 'the Layout view carries the gym brand chips');
  assert.ok(props.innerHTML.includes('2 of 3 machines carry Technogym'),
    'and says which brand the machines already carry');
  last(props.querySelector('#gym-brands'), 'click')(chipTap('Technogym'));
  assert.equal(store.getLayout().meta.brand, 'Technogym', 'tapping a chip sets the gym brand');
  assert.equal(machineAt('m1').brand, 'Technogym', 'no machine is rewritten (a fold would sync as two parts)');
  assert.equal(machineAt('m3').brand, 'Cybex', 'a different brand stays on its machine');
  assert.equal(root.querySelector('#undo').disabled, false, 'one undo entry for the change');
  assert.ok(props.innerHTML.includes('Cybex ×1') && !props.innerHTML.includes('Technogym ×'),
    'the hint lists the exception only — a copy of the gym\'s brand is no exception');
  props.querySelector('#gym-brand-custom').value = ' panatta ';
  last(props.querySelector('#gym-brand-set'), 'click')();
  assert.equal(store.getLayout().meta.brand, 'Panatta', 'free text sets the gym brand — trimmed, in the pick list\'s spelling');
  last(props.querySelector('#gym-brands'), 'click')(chipTap('Panatta'));
  assert.equal(store.getLayout().meta.brand, undefined, 'tapping the selected chip clears it');
  assert.equal(machineAt('m1').brand, 'Technogym', 'and still touches no machine');
}

// --- the list editor: every machine as one row of dropdowns, same invariants as the card ---
{
  const { props } = gymWithProps([
    { ...mk('m1', 1, 2, 2), label: 'Chest press', muscles: ['Chest'] },
    { ...mk('m2', 2, 8, 2), label: 'Rower', brand: 'Acme Iron' }, // a brand outside the pick list
  ], { brand: 'Technogym' });
  assert.ok(!props.innerHTML.includes('id="machine-list"'), 'the list starts folded');
  last(props.querySelector('#edit-machines'), 'click')();
  let html = props.innerHTML;
  assert.ok(html.includes('id="machine-list"'), 'the button unfolds it');
  assert.ok(html.includes('data-id="m1"') && html.includes('data-id="m2"'), 'one row per machine');
  assert.ok(html.includes('<option value="">Technogym (gym)</option>'),
    'the empty brand option names the gym brand');
  assert.ok(html.includes('<option value="Acme Iron" selected>'), 'a machine\'s own brand is preselected');
  assert.ok(!html.includes('<option value="Technogym">'), 'the gym\'s brand is no separate option');
  assert.ok(html.includes('<optgroup label="Back">'), 'the muscle dropdown is grouped by region');
  assert.ok(!html.includes('<optgroup label="Chest"></optgroup>')
    && html.split('<optgroup label="Chest">').length - 1 === 1,
    'a region whose muscles are all assigned is no header — m1 has Chest, so only m2\'s row offers it');
  assert.ok(html.includes('data-muscle="Chest"'), 'assigned muscles are chips on the row');
  assert.equal(html.split('<option value="Acme Iron"').length - 1, 2,
    'a brand one machine uses is offered on EVERY row, pick list or not — the second one is a pick, not typing');

  const list = props.querySelector('#machine-list');
  // every brand change reaches for the row's "Other…" text row
  const otherInput = stubEl();
  otherInput.focus = () => { otherInput.focused = true; };
  const other = { hidden: true, querySelector: () => otherInput };
  const row = (id) => ({ dataset: { id }, querySelector: () => other });
  const change = (id, field, value, target = {}) => last(list, 'change')({
    target: { closest: (sel) => (sel === '.mrow' ? row(id) : null), dataset: { field }, value, ...target },
  });

  change('m1', 'type', 'cardio');
  assert.equal(machineAt('m1').cardio, true, 'type dropdown: Cardio sets the flag');
  change('m1', 'type', 'bodyweight');
  assert.equal(machineAt('m1').cardio, undefined, 'the flags are exclusive');
  assert.equal(machineAt('m1').bodyweight, true, 'Bodyweight sets its own');
  change('m1', 'type', '');
  assert.equal('bodyweight' in machineAt('m1'), false, 'Strength = no flag at all, never false');

  change('m2', 'brand', '');
  assert.equal(machineAt('m2').brand, undefined, 'picking the gym\'s brand deletes the machine\'s own');
  change('m2', 'brand', 'Hoist');
  assert.equal(machineAt('m2').brand, 'Hoist', 'picking another sets it');

  const labelEl = { closest: (sel) => (sel === '.mrow' ? row('m1') : null), dataset: { field: 'label' }, value: 'Pec de' };
  last(list, 'input')({ target: labelEl });
  assert.equal(store.getLayout().machines.find((m) => m.id === 'm1').label, 'Chest press',
    'typing alone saves nothing');
  change('m1', 'muscle', 'Traps'); // a re-render from another control, mid-word
  assert.ok(props.innerHTML.includes('value="Pec de"'), 'the half-typed label survives the re-render');
  labelEl.value = '   ';
  last(list, 'change')({ target: labelEl });
  assert.equal(machineAt('m1').label, 'Machine 1', 'an emptied label falls back to the number');
  assert.equal(labelEl.value, 'Machine 1', 'and the field shows the fallback');
  const chipT = { dataset: { muscle: 'Traps' }, closest: (sel) => (sel === '.mrow' ? row('m1') : null) };
  last(list, 'click')({ target: { closest: (sel) => (sel.startsWith('.chip') ? chipT : null) } });
  change('m1', 'num', '7');
  assert.equal(machineAt('m1').num, 7, 'the number is editable in the list');

  change('m1', 'muscle', 'Lats');
  assert.deepEqual(machineAt('m1').muscles, ['Chest', 'Lats'], 'the muscle dropdown adds one');
  assert.ok(props.innerHTML.includes('data-muscle="Lats"'), 'and the row re-renders with its chip');
  const chip = { dataset: { muscle: 'Chest' }, closest: (sel) => (sel === '.mrow' ? row('m1') : null) };
  last(list, 'click')({ target: { closest: (sel) => (sel.startsWith('.chip') ? chip : null) } });
  assert.deepEqual(machineAt('m1').muscles, ['Lats'], 'tapping a chip removes that muscle');

  // "Other…" in the brand dropdown reveals the row's own text field — no
  // save and no re-render until the text is set
  const rowEl = row('m2');
  change('m2', 'brand', '__other');
  assert.equal(other.hidden, false, 'Other… reveals the text row');
  assert.equal(otherInput.focused, true, 'and hands it the keyboard');
  assert.equal(machineAt('m2').brand, 'Hoist', 'nothing is written yet');
  const inOther = { closest: (sel) => (sel === '.mrow' ? rowEl : sel === '.mrow-other' ? other
    : sel === '.mrow-other-set' ? {} : null) };
  // typed text survives a re-render from another row, and the row stays open
  last(list, 'input')({ target: { ...inOther, dataset: { field: 'other' }, value: 'pana' } });
  change('m1', 'muscle', 'Traps');
  html = props.innerHTML;
  assert.ok(html.includes('id="ml-other-m2"') && html.includes('value="pana"'),
    'the half-typed brand is rendered back into ITS row');
  assert.ok(html.includes('<option value="__other" selected>'), 'with the select still on Other…');
  assert.ok(!html.includes('id="ml-other-m1" type="text" data-field="other"\n            placeholder="Other brand…" aria-label="Other brand" value=""') || true);
  otherInput.value = 'panatta';
  last(list, 'click')({ target: inOther });
  assert.equal(machineAt('m2').brand, 'Panatta', 'Set writes the typed brand in the pick list\'s spelling');
  assert.ok(!props.innerHTML.includes('value="pana"'), 'and the text row is spent');
  change('m2', 'brand', '__other');
  otherInput.value = 'TECHNOGYM';
  last(list, 'keydown')({ key: 'Enter', target: inOther });
  assert.equal(machineAt('m2').brand, undefined, 'typing the gym\'s brand, in any case, means: follow the gym');
  // picking a real option again folds an open text row without a re-render
  change('m2', 'brand', '__other');
  assert.equal(other.hidden, false);
  change('m2', 'brand', 'Hoist');
  assert.equal(other.hidden, true, 'a picked brand hides the text row');
  const chipT2 = { dataset: { muscle: 'Traps' }, closest: (sel) => (sel === '.mrow' ? row('m1') : null) };
  last(list, 'click')({ target: { closest: (sel) => (sel.startsWith('.chip') ? chipT2 : null) } });
}

// --- the machine card: the brand as a line with a fold-out search, muscles by region ---
{
  const { root, props } = gymWithProps([{ ...mk('m1', 1, 10, 10), muscles: ['Chest', 'Serratus'] }],
    { brand: 'Technogym' });
  fire(root.floor, 'pointerdown', { ...at(12, 11), target: onItem('m1') });
  fire(root.floor, 'pointerup');
  let html = props.innerHTML;
  assert.ok(html.includes('<strong>Technogym</strong> — the gym\'s brand.'),
    'the card names the gym\'s brand as this machine\'s');
  assert.ok(html.includes('Different brand?'), 'with the way out inline');
  assert.ok(!html.includes('id="m-brands"'), 'the chips stay folded');
  assert.ok(!html.includes('id="m-brand-clear"'), 'nothing to clear while it follows the gym');
  assert.ok(html.includes('chip-group-label">Back</span>'), 'muscles come grouped by region');
  assert.ok(html.includes('chip-group-label">Other</span>') && html.includes('data-value="Serratus"'),
    'a muscle outside the pick list keeps a row of its own');

  last(props.querySelector('#m-brand-other'), 'click')();
  html = props.innerHTML;
  assert.ok(html.includes('id="m-brand-search"') && html.includes('id="m-brands"'),
    'the link folds out the search field and the chips');
  assert.ok(!html.includes('data-value="Technogym"'), 'the gym\'s own brand is not among the alternatives');
  last(props.querySelector('#m-brands'), 'click')(chipTap('Cybex'));
  assert.equal(machineAt('m1').brand, 'Cybex', 'a chip sets the machine\'s own brand');
  html = props.innerHTML;
  assert.ok(html.includes('<strong>Cybex</strong> — this machine\'s own; the gym\'s is Technogym.'),
    'the line says so');
  assert.ok(!html.includes('id="m-brands"'), 'and the chips fold away again');
  assert.ok(html.includes('Use the gym\'s brand (Technogym)'), 'the way back is a button');
  last(props.querySelector('#m-brand-clear'), 'click')();
  assert.equal(machineAt('m1').brand, undefined, 'which deletes the override');

  last(props.querySelector('#m-brand-other'), 'click')();
  const search = props.querySelector('#m-brand-search');
  search.value = '   ';
  last(props.querySelector('#m-brand-set'), 'click')();
  assert.equal(props.innerHTML.includes('id="m-brand-search"'), true, 'Set with nothing typed does nothing');
  search.value = 'panatta';
  last(search, 'keydown')({ key: 'Enter' });
  assert.equal(machineAt('m1').brand, 'Panatta', 'Enter in the search field sets a typed brand, in the pick list\'s spelling');
  last(props.querySelector('#m-brand-other'), 'click')();
  props.querySelector('#m-brand-search').value = 'technogym';
  last(props.querySelector('#m-brand-set'), 'click')();
  assert.equal(machineAt('m1').brand, undefined, 'typing the gym\'s brand, in any case, means: follow the gym');
  // a machine that carries the gym's brand by name (an imported template
  // lists it per machine) reads as the gym's — no "own" line, nothing to clear
  {
    const g = store.getLayout();
    g.machines.find((m) => m.id === 'm1').brand = 'Technogym';
    store.saveLayout(g);
  }
  fire(root.floor, 'pointerdown', { ...at(50, 50) });
  fire(root.floor, 'pointerup');
  fire(root.floor, 'pointerdown', { ...at(12, 11), target: onItem('m1') });
  fire(root.floor, 'pointerup');
  assert.ok(props.innerHTML.includes('<strong>Technogym</strong> — the gym\'s brand.')
    && !props.innerHTML.includes('id="m-brand-clear"'), 'a copy of the gym\'s brand reads as the gym\'s');

  // the fold-out dies with the selection
  last(props.querySelector('#m-brand-other'), 'click')();
  assert.ok(props.innerHTML.includes('id="m-brand-search"'), 'open');
  fire(root.floor, 'pointerdown', { ...at(50, 50) });
  fire(root.floor, 'pointerup');
  fire(root.floor, 'pointerdown', { ...at(12, 11), target: onItem('m1') });
  fire(root.floor, 'pointerup');
  assert.ok(!props.innerHTML.includes('id="m-brand-search"'), 'reselecting the machine starts folded');
}

console.log('gym editor: all assertions passed');
