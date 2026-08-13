// Logic-level test for studio.js's editor rendering and machine collision
// rules: finger-sized (px-based) touch targets, invisible tap pads for
// small items, edge clamping into the padded viewBox, and the
// machines-never-overlap placement logic.
// Run with: node test/studio.test.mjs
import { strict as assert } from 'node:assert';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const store = await import(new URL('../js/store.js', import.meta.url).href);
const { drawGym, overlapsMachine, fits, freeSpot } =
  await import(new URL('../js/studio.js', import.meta.url).href);

// drawGym renders into whatever quacks like an SVG element, so a plain
// fake object is enough to assert on the generated markup.
const SVG_PX = 358; // typical 390px phone minus #view padding
function fakeSvg() {
  return {
    attrs: {},
    style: {},
    innerHTML: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    getBoundingClientRect() { return { width: SVG_PX }; },
  };
}

const attr = (tag, name) => {
  // whitespace guard so e.g. name 'x' cannot match inside data-vertex="0"
  const m = tag.match(new RegExp(`[\\s"']${name}="([^"]+)"`));
  return m ? m[1] : null;
};
const num = (tag, name) => parseFloat(attr(tag, name));
const tagsWith = (html, cls) =>
  [...html.matchAll(/<(rect|circle|path|g|text|line)\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((t) => (attr(t, 'class') || '').split(/\s+/).includes(cls));
const close = (a, b) => Math.abs(a - b) < 1e-6;

const gym = store.newGym('Studio test');
// editor viewBox is padded by 2.5 units per side (60x40 grid -> 65-unit
// viewBox), so ppu = 358/65 ≈ 5.5 px per unit
const PAD = 2.5;
const ppu = SVG_PX / (gym.grid.w + 2 * PAD);
gym.machines.push({ id: 'm1', num: 1, label: 'Small', x: 10, y: 10, w: 4, h: 3 });
gym.machines.push({ id: 'm2', num: 2, label: 'Corner', x: 56, y: 37, w: 4, h: 3 });
gym.shapes.push({ id: 'z1', kind: 'rect', x: 30, y: 5, w: 20, h: 20, label: 'Big zone' });
gym.shapes.push({ id: 'f1', kind: 'fixture', fixture: 'water', x: 20, y: 20, w: 2, h: 2 });
gym.shapes.push({ id: 'd1', kind: 'fixture', fixture: 'door', x: 5, y: 0, w: 2.4, h: 1.2, rot: 0 });
gym.shapes.push({ id: 'l1', kind: 'line', x: 0, y: 20, w: 10, h: 0 });

// --- editor render, nothing selected: tap pads for small items only ---
let svg = fakeSvg();
drawGym(svg, gym, { editor: true });
// wall-snapped fixture hit rects are tap-hit too but carry no data-id
// (their <g> parent has it) — the id-less ones are NOT item pads
const pads = tagsWith(svg.innerHTML, 'tap-hit').filter((p) => attr(p, 'data-id'));
assert.deepEqual(pads.map((p) => attr(p, 'data-id')).sort(), ['f1', 'm1', 'm2'],
  'pads exactly for small machines + free-standing fixture (no zone, no door, no wall line)');

// wall line + door get finger-sized (px-based) hit strips in the editor
const lineHit = tagsWith(svg.innerHTML, 'hit').find((t) => t.startsWith('<line'));
assert.ok(close(num(lineHit, 'stroke-width'), 28 / ppu), 'wall hit stroke is 28px across');
const doorHit = tagsWith(svg.innerHTML, 'tap-hit').find((p) => !attr(p, 'data-id'));
assert.ok(close(num(doorHit, 'height'), 28 / ppu), 'door hit strip is 28px across the wall');
assert.ok(close(num(doorHit, 'width'), 44 / ppu), 'short door hit stretches to 44px along the wall');
const minUnits = 44 / ppu;
const padM1 = pads.find((p) => attr(p, 'data-id') === 'm1');
assert.ok(close(num(padM1, 'width'), minUnits) && close(num(padM1, 'height'), minUnits),
  'm1 pad is 44px square in grid units');
assert.ok(close(num(padM1, 'x'), 10 + (4 - minUnits) / 2), 'm1 pad centered on the machine');
assert.ok(svg.innerHTML.indexOf('tap-hit') < svg.innerHTML.indexOf('machine-box'),
  'pad layer sits below the machine layer so visible machines win hit-testing');

// --- selected machine: icon handle + big hit circle ---
svg = fakeSvg();
drawGym(svg, gym, { editor: true, selectedId: 'm1' });
const hits = tagsWith(svg.innerHTML, 'handle-hit');
assert.equal(hits.length, 1, 'exactly one resize hit circle');
assert.equal(attr(hits[0], 'data-handle'), '1', 'hit circle carries data-handle');
assert.ok(close(num(hits[0], 'r'), 22 / ppu), 'hit circle radius is 22px (44px diameter)');
assert.ok(close(num(hits[0], 'cx'), 14) && close(num(hits[0], 'cy'), 13),
  'hit circle sits on the bottom-right corner');
const visible = tagsWith(svg.innerHTML, 'handle');
assert.equal(visible.length, 1, 'one visible handle circle');
assert.ok(visible[0].includes('pointer-events="none"'), 'visible handle does not eat events');
assert.ok(close(num(visible[0], 'r'), 13 / ppu), 'visible handle is 26px across');
assert.equal(tagsWith(svg.innerHTML, 'handle-icon').length, 1, 'diagonal arrow icon present');

// --- machine flush against the corner: handle clamped into the viewBox ---
svg = fakeSvg();
drawGym(svg, gym, { editor: true, selectedId: 'm2' });
const hitR = 22 / ppu;
const hit2 = tagsWith(svg.innerHTML, 'handle-hit')[0];
assert.ok(close(num(hit2, 'cx'), 60 + PAD - hitR) && close(num(hit2, 'cy'), 40 + PAD - hitR),
  'corner handle clamps fully inside the padded viewBox');

// --- outline selected: enlarged, clamped vertex/midpoint handles ---
svg = fakeSvg();
drawGym(svg, gym, { editor: true, selectedId: 'outline' });
const verts = tagsWith(svg.innerHTML, 'vertex-hit');
assert.equal(verts.length, gym.outline.length, 'one hit rect per outline corner');
const vertHit = 40 / ppu;
const v0 = verts.find((v) => attr(v, 'data-vertex') === '0');
assert.ok(close(num(v0, 'x'), -PAD) && close(num(v0, 'y'), -PAD),
  'corner (0,0) hit rect clamps to start at the padded viewBox edge');
assert.ok(close(num(v0, 'width'), vertHit), 'vertex hit rect is 40px');
const vVis = tagsWith(svg.innerHTML, 'vertex');
assert.ok(vVis.every((v) => v.includes('pointer-events="none"')), 'visible vertices inert');
assert.ok(close(num(vVis[0], 'x'), -(20 / ppu) / 2),
  'visible vertex stays on the true (unclamped) corner');
assert.equal(tagsWith(svg.innerHTML, 'mid-hit').length, gym.outline.length,
  'one hit circle per edge midpoint');

// --- read-only mini-map: no editor artifacts, no layout measurement ---
svg = fakeSvg();
svg.getBoundingClientRect = () => { throw new Error('mini-map must not measure layout'); };
drawGym(svg, gym, { editor: false });
assert.equal(tagsWith(svg.innerHTML, 'tap-hit').filter((p) => attr(p, 'data-id')).length, 0,
  'no item pads in the mini-map');
assert.ok(!svg.innerHTML.includes('handle'), 'no handles in the mini-map');
const miniDoorHit = tagsWith(svg.innerHTML, 'tap-hit').find((p) => !attr(p, 'data-id'));
assert.ok(close(num(miniDoorHit, 'height'), 2.6), 'mini-map keeps the fixed-unit door strip');

// --- zero-width fallback: sizes stay finite ---
svg = fakeSvg();
svg.getBoundingClientRect = () => ({ width: 0 });
drawGym(svg, gym, { editor: true, selectedId: 'm1' });
const fallbackHit = tagsWith(svg.innerHTML, 'handle-hit')[0];
assert.ok(Number.isFinite(num(fallbackHit, 'r')) && num(fallbackHit, 'r') > 0,
  'ASSUMED_SVG_PX fallback keeps handle sizes finite');

// --- overlapsMachine: AABB semantics ---
const m1 = gym.machines[0];
assert.ok(overlapsMachine(gym, null, 12, 11, 4, 3), 'overlap detected');
assert.ok(!overlapsMachine(gym, null, 0, 0, 4, 3), 'clear spot is free');
assert.ok(!overlapsMachine(gym, null, 14, 10, 4, 3), 'edge-to-edge contact is allowed');
assert.ok(!overlapsMachine(gym, m1, 10, 10, 4, 3), 'item never collides with itself');

// --- fits: exclusivity is machines-only and grandfathered ---
const zone = { id: 'z2', kind: 'rect', x: 0, y: 0, w: 12, h: 8 };
assert.ok(fits(gym, zone, 10, 10, 12, 8), 'shapes may overlap machines freely');
assert.ok(!fits(gym, m1, 55, 36, 4, 3), 'clean machine may not move onto another footprint');
assert.ok(fits(gym, m1, 24, 10, 4, 3), 'clean machine may move to a free spot');
const tangled = { id: 'm3', num: 3, x: 11, y: 11, w: 4, h: 3 }; // overlaps m1 already
gym.machines.push(tangled);
assert.ok(fits(gym, tangled, 11, 11, 3, 2),
  'pre-existing overlap: shrinking is allowed even while still overlapping');
assert.ok(fits(gym, tangled, 12, 11, 4, 3),
  'pre-existing overlap: any move is allowed so it can be untangled');
gym.machines.pop();

// --- freeSpot: placement for new machines ---
assert.deepEqual(freeSpot(gym, 30, 30, 4, 3), { x: 30, y: 30 }, 'preferred spot used when free');
const found = freeSpot(gym, 11, 11, 4, 3);
assert.deepEqual(found, { x: 11, y: 13 },
  'occupied preferred spot: the NEAREST free spot wins (right below m1, edge-to-edge)');
const packed = store.newGym('Packed');
packed.grid = { w: 8, h: 6 };
packed.machines.push(
  { id: 'p1', num: 1, x: 0, y: 0, w: 8, h: 3 },
  { id: 'p2', num: 2, x: 0, y: 3, w: 8, h: 3 },
);
assert.deepEqual(freeSpot(packed, 2, 2, 4, 3), { x: 2, y: 2 },
  'packed floor falls back to the preferred spot instead of refusing');

// ---------------------------------------------------------------------------
// renderStudio integration: drive the real pointer handlers with synthetic
// events against a faked DOM and assert on the persisted gym state — the
// headless equivalent of the scripted-PointerEvent browser check.
// ---------------------------------------------------------------------------

// renderStudio wires a ResizeObserver and svgPoint goes through DOMPoint +
// getScreenCTM; neither exists in Node.
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.DOMPoint = class {
  constructor(x, y) { this.x = x; this.y = y; }
  matrixTransform(m) { return { x: m.a * this.x + m.e, y: m.d * this.y + m.f }; }
};

const { renderStudio } = await import(new URL('../js/studio.js', import.meta.url).href);
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

function studioWith(machines) {
  const g = store.newGym('Drag test');
  g.machines.push(...machines);
  store.saveGym(g);
  const root = fakeRoot();
  // the real button starts disabled via its HTML attribute; the stub can't
  // parse root.innerHTML, so mirror that initial state by hand
  root.querySelector('#undo').disabled = true;
  renderStudio(root);
  return root;
}
const machineAt = (id) => store.getGym().machines.find((m) => m.id === id);
const mk = (id, num, x, y) => ({ id, num, x, y, w: 4, h: 3, settingsFields: [] });

// --- move drag persists through the real handler chain ---
let root = studioWith([mk('m1', 1, 10, 10), mk('m2', 2, 20, 10)]);
dragSeq(root.floor, onItem('m1'), [12, 11.5], [14, 21.5]);
assert.deepEqual([machineAt('m1').x, machineAt('m1').y], [12, 20], 'drag moved the machine');
assert.equal(root.querySelector('#undo').disabled, false, 'real move recorded an undo entry');

// --- sub-snap wiggle is a no-op: nothing saved, no undo entry ---
root = studioWith([mk('m1', 1, 10, 10), mk('m2', 2, 20, 10)]);
dragSeq(root.floor, onItem('m1'), [12, 11.5], [12.3, 11.6]);
assert.deepEqual([machineAt('m1').x, machineAt('m1').y], [10, 10], 'wiggle did not move');
assert.equal(root.querySelector('#undo').disabled, true, 'no-op drag left undo history clean');

// --- fully blocked move: machine stays put, still no undo entry ---
root = studioWith([mk('m1', 1, 10, 10), mk('m2', 2, 20, 10)]);
dragSeq(root.floor, onItem('m1'), [12, 11.5], [22, 11.5]);
assert.deepEqual([machineAt('m1').x, machineAt('m1').y], [10, 10], 'blocked drag did not move');
assert.equal(root.querySelector('#undo').disabled, true, 'blocked drag left undo history clean');

// --- axis slide: x blocked by the neighbor, y still follows the finger ---
root = studioWith([mk('m1', 1, 10, 10), mk('m2', 2, 20, 10)]);
dragSeq(root.floor, onItem('m1'), [12, 11.5], [22, 12.5]);
assert.deepEqual([machineAt('m1').x, machineAt('m1').y], [10, 11], 'slid along the free axis');

// --- resize via the handle target ---
root = studioWith([mk('m1', 1, 10, 10)]);
dragSeq(root.floor, onItem('m1', true), [14, 13], [16, 15]);
assert.deepEqual([machineAt('m1').w, machineAt('m1').h], [6, 5], 'handle drag resized');

// --- resize into a neighbor is blocked per axis ---
root = studioWith([mk('m1', 1, 10, 10), mk('m2', 2, 16, 10)]);
dragSeq(root.floor, onItem('m1', true), [14, 13], [18, 14]);
assert.deepEqual([machineAt('m1').w, machineAt('m1').h], [4, 4],
  'width growth blocked by the neighbor, height still grew');

// --- add-machine button lands new machines on non-overlapping spots ---
root = studioWith([]);
const addBtn = root.querySelector('#add-machine');
addBtn.listeners.click[0]();
addBtn.listeners.click[0]();
const after = store.getGym(); // single parse — overlapsMachine excludes by object identity
assert.equal(after.machines.length, 2, 'two machines added');
const second = after.machines[1];
assert.ok(!overlapsMachine(after, second, second.x, second.y, second.w, second.h),
  'second machine does not overlap the first');

console.log('studio editor rendering + collision + drag integration: all assertions passed');
