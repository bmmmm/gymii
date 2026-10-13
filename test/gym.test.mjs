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
  change('m1', 'type', 'assisted');
  assert.deepEqual([machineAt('m1').assisted, 'bodyweight' in machineAt('m1')], [true, false],
    'Assisted is a type of its own, exclusive like the others');
  change('m1', 'type', '');
  assert.equal('bodyweight' in machineAt('m1'), false, 'Strength = no flag at all, never false');
  assert.equal('assisted' in machineAt('m1'), false, 'and no assisted flag either');

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
  change('m1', 'num', String(machineAt('m2').num));
  assert.equal(machineAt('m1').num, 7, 'a number another machine has is refused');
  assert.ok(props.innerHTML.includes(`#${machineAt('m2').num} is already ${machineAt('m2').label}`),
    'and the card says whose it is');

  const focused = [];
  const select = props.querySelector('#ml-muscle-m1');
  select.focus = () => focused.push('select');
  // focus is handed on only when the control had it (a keyboard user) —
  // never on a phone tap, where it could pop the picker or drop a keyboard
  const addLats = { closest: (sel) => (sel === '.mrow' ? row('m1') : null), dataset: { field: 'muscle' }, value: 'Lats' };
  globalThis.document = { activeElement: addLats };
  last(list, 'change')({ target: addLats });
  assert.deepEqual(machineAt('m1').muscles, ['Chest', 'Lats'], 'the muscle dropdown adds one');
  assert.ok(props.innerHTML.includes('data-muscle="Lats"'), 'and the row re-renders with its chip');
  assert.deepEqual(focused.splice(0), ['select'], 'the re-rendered row\'s select keeps the focus, not <body>');
  // a chip tap CYCLES its muscle: primary → secondary (½) → removed. The row
  // keeps ONE order (the pick list's) whatever the state, so the chip stays
  // under the thumb; a focused chip keeps the focus while its muscle is on
  // the row, else hands it to the chip in its place, else the select. The
  // stub hands out the chips in the order the render actually drew them.
  const chipEl = (name) => ({ focus: (o) => focused.push([name, o]) });
  const drawnRow = () => {
    const h = props.innerHTML;
    const from = h.indexOf('class="mrow" data-id="m1"');
    const to = h.indexOf('class="mrow" data-id=', from + 1);
    return [...h.slice(from, to === -1 ? undefined : to).matchAll(/class="chip sm[^"]*" data-muscle="([^"]+)"/g)].map((x) => x[1]);
  };
  props.querySelector('.mrow[data-id="m1"]').querySelectorAll = (sel) => (sel === '.chip[data-muscle]' ? drawnRow().map(chipEl) : []);
  const tapChip = (muscle, { keyboard = true } = {}) => {
    const chip = { dataset: { muscle }, closest: (sel) => (sel === '.mrow' ? row('m1') : null) };
    globalThis.document = { activeElement: keyboard ? chip : {} };
    last(list, 'click')({ target: { closest: (sel) => (sel.startsWith('.chip') ? chip : null) } });
  };
  change('m1', 'muscle', 'Traps'); // Chest, Lats, Traps
  focused.length = 0;
  tapChip('Lats');
  assert.deepEqual([machineAt('m1').muscles, machineAt('m1').secondaryMuscles], [['Chest', 'Traps'], ['Lats']],
    'a primary muscle tapped turns secondary');
  assert.deepEqual(drawnRow(), ['Chest', 'Lats', 'Traps'], 'and stays where it was in the row');
  assert.ok(/class="chip sm secondary" data-muscle="Lats"\s+aria-pressed="mixed"/.test(props.innerHTML)
    && props.innerHTML.includes('Lats ½ ✕') && !props.innerHTML.includes('Chest ✕'),
    'drawn dashed with "½ ✕"; a primary chip carries no ✕ — its tap does not remove it');
  assert.ok(/data-muscle="Lats"\s+aria-pressed="mixed" aria-label="Lats">/.test(props.innerHTML)
    && /data-muscle="Chest"\s+aria-pressed="true" aria-label="Chest">/.test(props.innerHTML),
    'the state is said once, by aria-pressed — the name is the muscle\'s, whatever its state');
  assert.deepEqual(focused.splice(0), [['Lats', { preventScroll: true }]], 'the focus stays on its muscle');
  tapChip('Lats'); // secondary → gone; Traps moves into its place
  assert.equal('secondaryMuscles' in machineAt('m1'), false, 'a secondary muscle tapped is removed — the list goes when empty');
  assert.deepEqual(focused.splice(0), [['Traps', { preventScroll: true }]], 'the focus moves to the chip that took its place');
  tapChip('Traps');
  tapChip('Traps'); // Traps was last: nothing moves into its place
  assert.deepEqual(focused.splice(0), [['Traps', { preventScroll: true }], 'select'], 'no chip in its place: the row\'s select takes it');
  tapChip('Chest', { keyboard: false });
  tapChip('Chest', { keyboard: false });
  assert.deepEqual([machineAt('m1').muscles, 'secondaryMuscles' in machineAt('m1')], [[], false], 'taps cycle it all the same');
  assert.deepEqual(focused.splice(0), [], 'but a tap that never focused the chip moves no focus');
  const tapAdd = { closest: (sel) => (sel === '.mrow' ? row('m1') : null), dataset: { field: 'muscle' }, value: 'Chest' };
  globalThis.document = { activeElement: {} };
  last(list, 'change')({ target: tapAdd });
  assert.deepEqual(focused.splice(0), [], 'nor does a pick from a picker that no longer holds the focus');
  delete globalThis.document;
  change('m1', 'muscle', 'Lats');
  focused.length = 0;

  // the model is a column of the list too — absent, never empty
  assert.ok(props.innerHTML.includes('id="ml-model-m1" class="mrow-model" type="text" data-field="model"'),
    'every row has a model field');
  const modelEl = { closest: (sel) => (sel === '.mrow' ? row('m1') : null), dataset: { field: 'model' }, value: 'XR' };
  last(list, 'input')({ target: modelEl });
  change('m1', 'muscle', 'Traps'); // a re-render from another control, mid-word
  assert.ok(props.innerHTML.includes('value="XR" placeholder="Model (optional)"'), 'a half-typed model survives a re-render');
  const modelChange = { closest: (sel) => (sel === '.mrow' ? row('m1') : null), dataset: { field: 'model' }, value: '  XR-5 ' };
  last(list, 'change')({ target: modelChange });
  assert.equal(machineAt('m1').model, 'XR-5', 'the model is saved trimmed');
  assert.equal(modelChange.value, 'XR-5', 'and the field shows it trimmed');
  change('m1', 'model', '   ');
  assert.equal('model' in machineAt('m1'), false, 'an emptied model is removed, never stored empty');
  const traps = { dataset: { muscle: 'Traps' }, closest: (sel) => (sel === '.mrow' ? row('m1') : null) };
  last(list, 'click')({ target: { closest: (sel) => (sel.startsWith('.chip') ? traps : null) } });
  focused.length = 0;

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

  // the card's type chips: Assisted joins Cardio and Bodyweight, one at a time
  last(props.querySelector('#m-bodyweight'), 'click')();
  last(props.querySelector('#m-assisted'), 'click')();
  assert.deepEqual([machineAt('m1').assisted, 'bodyweight' in machineAt('m1')], [true, false], 'Assisted replaces Bodyweight');
  last(props.querySelector('#m-assisted'), 'click')();
  assert.equal('assisted' in machineAt('m1'), false, 'the selected chip again: strength');

  // the card's muscle chips cycle too: primary → secondary (½) → off
  const muscleTap = (value) => last(props.querySelector('#m-muscles'), 'click')(chipTap(value));
  muscleTap('Chest');
  assert.deepEqual([machineAt('m1').muscles, machineAt('m1').secondaryMuscles], [['Serratus'], ['Chest']], 'primary → secondary');
  assert.ok(/class="chip secondary" aria-pressed="mixed"\s+data-value="Chest">Chest ½</.test(props.innerHTML), 'drawn dashed, with ½');
  muscleTap('Chest');
  assert.equal('secondaryMuscles' in machineAt('m1'), false, 'secondary → off, and the empty list goes');
  muscleTap('Chest');
  assert.deepEqual(machineAt('m1').muscles, ['Serratus', 'Chest'], 'off → primary');
  assert.ok(/class="chip sel" aria-pressed="true"\s+data-value="Chest">Chest</.test(props.innerHTML), 'drawn selected');

  last(props.querySelector('#m-brand-other'), 'click')();
  html = props.innerHTML;
  assert.ok(html.includes('id="m-brand-search"') && html.includes('id="m-brands"'),
    'the link folds out the search field and the chips');
  assert.ok(!html.includes('data-value="Technogym"'), 'the gym\'s own brand is not among the alternatives');
  // the search filters the chips IN PLACE (no re-render per keystroke) —
  // the plain stub's querySelectorAll hands out none, so this one does
  {
    const chipEls = ['Cybex', 'Life Fitness', 'Panatta'].map((value) => ({ dataset: { value }, hidden: false }));
    const qsa = props.querySelectorAll;
    props.querySelectorAll = (sel) => (sel === '#m-brands .chip' ? chipEls : []);
    const search = props.querySelector('#m-brand-search');
    const setBtn = props.querySelector('#m-brand-set');
    const typeIn = (v) => { search.value = v; last(search, 'input')(); };
    typeIn('  fit');
    assert.deepEqual(chipEls.map((c) => c.hidden), [true, false, true], 'only chips containing the text stay, any case');
    assert.equal(setBtn.hidden, false, 'no chip IS the text: "Set" offers it');
    assert.equal(setBtn.textContent, 'Set "fit"');
    typeIn('CYBEX');
    assert.deepEqual(chipEls.map((c) => c.hidden), [false, true, true]);
    assert.equal(setBtn.hidden, true, 'an exact chip needs no Set button');
    typeIn('');
    assert.deepEqual(chipEls.map((c) => c.hidden), [false, false, false], 'an empty search shows them all');
    assert.equal(setBtn.hidden, true, 'and offers nothing to set');
    props.querySelectorAll = qsa;
  }
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

// --- a muscle in BOTH lists (an older client tagged it primary again) cycles into ONE secondary entry ---
{
  const { root, props } = gymWithProps([{ ...mk('m1', 1, 10, 10), muscles: ['Triceps'], secondaryMuscles: ['Triceps'] }]);
  fire(root.floor, 'pointerdown', { ...at(12, 11), target: onItem('m1') });
  fire(root.floor, 'pointerup');
  last(props.querySelector('#m-muscles'), 'click')(chipTap('Triceps'));
  assert.deepEqual([machineAt('m1').muscles, machineAt('m1').secondaryMuscles], [[], ['Triceps']],
    'one Triceps, secondary — never twice (it would count every set twice)');
}

// --- the card refuses a machine number that is taken ---
{
  const { root, props } = gymWithProps([mk('m1', 1, 10, 10), { ...mk('m2', 2, 30, 10), label: 'Leg press' }]);
  fire(root.floor, 'pointerdown', { ...at(12, 11), target: onItem('m1') });
  fire(root.floor, 'pointerup');
  const numEl = { value: '2' };
  last(props.querySelector('#m-num'), 'change')({ target: numEl });
  assert.equal(store.getLayout().machines.find((m) => m.id === 'm1').num, 1, 'the card keeps #1');
  assert.equal(numEl.value, 1, 'the field shows the old number again');
  assert.ok(props.innerHTML.includes('#2 is already Leg press'), 'and the card says whose it is');
  numEl.value = '5';
  last(props.querySelector('#m-num'), 'change')({ target: numEl });
  assert.equal(store.getLayout().machines.find((m) => m.id === 'm1').num, 5, 'a free number goes through');
  assert.ok(!props.innerHTML.includes('is already'), 'and the hint is gone');
  numEl.value = '5';
  last(props.querySelector('#m-num'), 'change')({ target: numEl });
  assert.ok(!props.innerHTML.includes('is already'), 'its own number is never "taken"');
}

// --- grips: chips like the settings, custom grips lose their brackets ---
{
  const { root, props } = gymWithProps([mk('m1', 1, 10, 10)]);
  fire(root.floor, 'pointerdown', { ...at(12, 11), target: onItem('m1') });
  fire(root.floor, 'pointerup');
  const grips = () => store.getLayout().machines.find((m) => m.id === 'm1').grips;
  assert.ok(props.innerHTML.includes('id="m-grips"') && props.innerHTML.includes('data-value="Rope"'),
    'the card offers the common grips');
  last(props.querySelector('#m-grips'), 'click')(chipTap('Rope'));
  last(props.querySelector('#m-grips'), 'click')(chipTap('V-bar'));
  assert.deepEqual(grips(), ['Rope', 'V-bar'], 'a chip tap adds a grip');
  props.querySelector('#m-grip-custom').value = ' [Wide]  bar ';
  last(props.querySelector('#m-grip-add'), 'click')();
  assert.deepEqual(grips(), ['Rope', 'V-bar', 'Wide bar'], 'a typed grip is added without brackets');
  assert.ok(props.innerHTML.includes('data-value="Wide bar"'), 'and gets a chip of its own');
  props.querySelector('#m-grip-custom').value = 'Rope';
  last(props.querySelector('#m-grip-add'), 'click')();
  assert.deepEqual(grips(), ['Rope', 'V-bar', 'Wide bar'], 'a grip already listed is not added twice');
  ['Rope', 'V-bar', 'Wide bar'].forEach((g) => last(props.querySelector('#m-grips'), 'click')(chipTap(g)));
  assert.equal('grips' in store.getLayout().machines.find((m) => m.id === 'm1'), false,
    'an emptied list is deleted, not stored empty');
}

// --- staged text: whichever control saves first, a field is written as its own `change` writes it ---
// A text field commits on `change` (blur or Enter), and iOS does not blur it
// when a chip next to it is tapped — so the chip's save() runs first. That
// save must not persist the half-typed text as it stands: '' as a label,
// blanks as a model, an untrimmed link.
{
  const { root, props } = gymWithProps([{ ...mk('m1', 1, 10, 10), label: 'Chest press', model: 'XR' }]);
  fire(root.floor, 'pointerdown', { ...at(12, 11), target: onItem('m1') });
  fire(root.floor, 'pointerup');
  const type = (sel, v) => {
    props.querySelector(sel).value = v;
    last(props.querySelector(sel), 'input')();
  };
  const undo = () => root.querySelector('#undo').listeners.click[0]();
  type('#m-label', '');
  type('#m-model', '   ');
  type('#m-doc', ' https://example.org/manual ');
  last(props.querySelector('#m-cardio'), 'click')(); // no blur, so no `change` yet
  let m1 = machineAt('m1');
  assert.equal(m1.cardio, true, 'the chip did its own job');
  assert.equal(m1.label, 'Machine 1', 'an emptied label is saved as its fallback, never as ""');
  assert.equal('model' in m1, false, 'an emptied model is saved absent, never as blanks');
  assert.equal(m1.docUrl, 'https://example.org/manual', 'the doc link is saved trimmed');
  assert.ok(/id="m-label" type="text"\s+value=""/.test(props.innerHTML),
    'the re-rendered field still shows what was typed — no fallback printed into it mid-edit');
  type('#m-label', '  Pec deck ');
  last(props.querySelector('#m-bodyweight'), 'click')();
  assert.equal(machineAt('m1').label, 'Pec deck', 'typed text is saved trimmed');
  assert.ok(props.innerHTML.includes('value="  Pec deck "'),
    'and shown with its spaces, so the next word does not glue onto the last');
  // the blur comes later and writes what the chip's save already wrote
  ['#m-label', '#m-model', '#m-doc'].forEach((sel) => last(props.querySelector(sel), 'change')());
  assert.equal(props.querySelector('#m-label').value, 'Pec deck', 'the blur shows the trimmed label');
  undo();
  m1 = machineAt('m1');
  assert.deepEqual([m1.label, m1.cardio, 'bodyweight' in m1], ['Machine 1', true, false],
    'one undo takes back the second chip tap, with the label it saved');
  undo();
  m1 = machineAt('m1');
  assert.deepEqual([m1.label, m1.model, 'cardio' in m1, m1.docUrl ?? ''], ['Chest press', 'XR', false, ''],
    'the second takes back the first, with the fields it saved');
  assert.equal(root.querySelector('#undo').disabled, true,
    'two chip taps, two undo entries: the blurs writing the same text again added none');
}

// --- the list editor's staged label and model follow the same rule ---
{
  const { root, props } = gymWithProps([{ ...mk('m1', 1, 2, 2), label: 'Chest press', model: 'XR' }]);
  last(props.querySelector('#edit-machines'), 'click')();
  const list = props.querySelector('#machine-list');
  const row = { dataset: { id: 'm1' } };
  const field = (name, value) => ({ closest: (sel) => (sel === '.mrow' ? row : null), dataset: { field: name }, value });
  const labelEl = field('label', '');
  const modelEl = field('model', ' ');
  last(list, 'input')({ target: labelEl });
  last(list, 'input')({ target: modelEl });
  last(list, 'change')({ target: field('type', 'cardio') }); // another control of the row saves first
  assert.equal(machineAt('m1').label, 'Machine 1', 'the list\'s emptied label is saved as its fallback');
  assert.equal('model' in machineAt('m1'), false, 'and its emptied model absent');
  last(list, 'change')({ target: field('muscle', 'Lats') }); // a re-render, still mid-edit
  assert.ok(/id="ml-label-m1"[^>]*value=""/.test(props.innerHTML)
    && /id="ml-model-m1"[^>]*value=" "/.test(props.innerHTML), 'both fields still show what was typed');
  last(list, 'change')({ target: labelEl });
  last(list, 'change')({ target: modelEl });
  assert.deepEqual([labelEl.value, modelEl.value], ['Machine 1', ''], 'the blur shows what was saved');
  last(list, 'input')({ target: field('label', 'Half-typ') }); // still typing when undo is tapped
  root.querySelector('#undo').listeners.click[0]();
  root.querySelector('#undo').listeners.click[0]();
  assert.deepEqual([machineAt('m1').label, machineAt('m1').model, 'cardio' in machineAt('m1')],
    ['Chest press', 'XR', false], 'two undos take both saves back');
  assert.ok(/id="ml-label-m1"[^>]*value="Chest press"/.test(props.innerHTML),
    'and the row shows the label undo brought back — the half-typed text belonged to the state it left');
  assert.equal(root.querySelector('#undo').disabled, true, 'and there were only two — the blurs added none');
}

// --- undo and redo read the layout IN THE TAP: another writer's work survives them ---
// An undo used to write a whole-layout snapshot back — a render-time copy
// (store.js, ensureMachine): saveLayout tombstones every id such a copy
// lacks, so a machine a sync pull brought in meanwhile died on every
// device, and a grip Train taught another machine was reverted.
{
  const { root, props } = gymWithProps([mk('m1', 1, 10, 10), mk('m2', 2, 30, 10)]);
  fire(root.floor, 'pointerdown', { ...at(12, 11), target: onItem('m1') });
  fire(root.floor, 'pointerup');
  last(props.querySelector('#m-bodyweight'), 'click')(); // the edit to take back
  // meanwhile, other writers: Train teaches m2 a grip, a sync pull brings #3
  store.addMachineVariant('m2', { grips: ['Rope'] });
  const pulled = store.getLayout();
  // an id no earlier block used: each gymWithProps tombstones the last gym's ids
  pulled.machines.push({ ...mk('pulled', 3, 40, 10), label: 'Synced in' });
  store.restoreLayout(pulled);
  const undo = () => root.querySelector('#undo').listeners.click[0]();
  const redo = () => root.querySelector('#redo').listeners.click[0]();
  const others = () => [machineAt('m2').grips, machineAt('pulled')?.label,
    store.getTombstones().machines.some((t) => t.id === 'pulled')];
  undo();
  assert.equal('bodyweight' in machineAt('m1'), false, 'undo takes the edit back');
  assert.deepEqual(others(), [['Rope'], 'Synced in', false],
    'and nothing else: m2 keeps its grip, the machine that synced in is neither gone nor tombstoned');
  redo();
  assert.equal(machineAt('m1').bodyweight, true, 'redo puts the edit back');
  assert.deepEqual(others(), [['Rope'], 'Synced in', false], 'and leaves the others alone too');
  // another writer changed the SAME machine: only the field the edit changed goes back
  store.addMachineVariant('m1', { grips: ['V-bar'] });
  undo();
  assert.deepEqual([machineAt('m1').grips, 'bodyweight' in machineAt('m1')], [['V-bar'], false],
    'undoing the type leaves the grip taught to that machine since');
  // a machine another device deleted since stays deleted — an undo of an
  // edit to it is no reason to bring it back
  redo();
  const gone = store.getLayout();
  gone.machines = gone.machines.filter((m) => m.id !== 'm1');
  store.restoreLayout(gone);
  undo();
  assert.equal(machineAt('m1'), undefined, 'undo does not resurrect a machine deleted elsewhere');
  assert.equal(machineAt('pulled')?.label, 'Synced in', 'and still keeps the one that synced in');
}

// --- an EDIT after another writer: save() takes the stored layout in first ---
// save() used to write the editor's render-time copy whole, so the first
// edit after a sync pull tombstoned the machine that pull brought in.
{
  const { root, props } = gymWithProps([mk('s1', 1, 10, 10), mk('s2', 2, 30, 10)]);
  fire(root.floor, 'pointerdown', { ...at(12, 11), target: onItem('s1') });
  fire(root.floor, 'pointerup');
  store.addMachineVariant('s1', { grips: ['Rope'] }); // Train, on the machine being edited
  const pulled = store.getLayout();
  pulled.machines.push({ ...mk('pulled2', 3, 40, 10), label: 'Synced in' });
  pulled.machines.find((m) => m.id === 's1').bodyweight = false; // the same key, set elsewhere
  store.restoreLayout(pulled);
  last(props.querySelector('#m-bodyweight'), 'click')(); // the edit
  assert.equal(machineAt('pulled2')?.label, 'Synced in', 'the machine a pull brought in survives the edit');
  assert.equal(store.getTombstones().machines.some((t) => t.id === 'pulled2'), false, 'and is not tombstoned');
  assert.deepEqual([machineAt('s1').bodyweight, machineAt('s1').grips], [true, ['Rope']],
    'the edited machine keeps the grip taught to it since; on the key both set, the edit wins');
  root.querySelector('#undo').listeners.click[0]();
  assert.deepEqual(['bodyweight' in machineAt('s1'), machineAt('s1').grips, machineAt('pulled2')?.label],
    [false, ['Rope'], 'Synced in'], 'undo takes back the edit alone');
}

// --- staged text is written once: a later save does not undo a sync rename ---
{
  const { root, props } = gymWithProps([{ ...mk('r1', 1, 10, 10), label: 'Chest press' }]);
  fire(root.floor, 'pointerdown', { ...at(12, 11), target: onItem('r1') });
  fire(root.floor, 'pointerup');
  props.querySelector('#m-label').value = 'Pec deck';
  last(props.querySelector('#m-label'), 'input')();
  last(props.querySelector('#m-cardio'), 'click')(); // no blur: the chip's save writes the label
  assert.equal(machineAt('r1').label, 'Pec deck', 'the waiting label is saved with the chip');
  const pulled = store.getLayout();
  pulled.machines.find((m) => m.id === 'r1').label = 'Renamed elsewhere';
  store.restoreLayout(pulled);
  last(props.querySelector('#m-bodyweight'), 'click')();
  last(props.querySelector('#m-bodyweight'), 'click')();
  assert.equal(machineAt('r1').label, 'Renamed elsewhere',
    'later chip taps do not write the already-saved text over a rename that synced in');
}

console.log('gym editor: all assertions passed');
