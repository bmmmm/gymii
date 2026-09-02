// Logic-level test for js/map.js — the shared floor-map renderer:
// finger-sized (px-based) touch targets, invisible tap pads for small items,
// edge clamping into the padded viewBox, wall/door geometry, the usage
// ramp, and the machines-never-overlap placement logic.
// The EDITOR that sits on top of these lives in test/gym.test.mjs.
// Run with: node test/map.test.mjs
import './helpers/localstorage.mjs'; // FIRST: installs the stub
import { strict as assert } from 'node:assert';

const store = await import(new URL('../js/store.js', import.meta.url).href);
const { drawLayout, overlapsSolid, fits, freeSpot } =
  await import(new URL('../js/map.js', import.meta.url).href);

// drawLayout renders into whatever quacks like an SVG element, so a plain
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

const layout = store.newLayout('Layout test');
// editor viewBox is padded by 2.5 units per side (60x40 grid -> 65-unit
// viewBox), so ppu = 358/65 ≈ 5.5 px per unit
const PAD = 2.5;
const ppu = SVG_PX / (layout.grid.w + 2 * PAD);
layout.machines.push({ id: 'm1', num: 1, label: 'Small', x: 10, y: 10, w: 4, h: 3 });
layout.machines.push({ id: 'm2', num: 2, label: 'Corner', x: 56, y: 37, w: 4, h: 3 });
layout.shapes.push({ id: 'z1', kind: 'rect', x: 30, y: 5, w: 20, h: 20, label: 'Big zone' });
layout.shapes.push({ id: 'f1', kind: 'fixture', fixture: 'water', x: 20, y: 20, w: 2, h: 2 });
layout.shapes.push({ id: 'd1', kind: 'fixture', fixture: 'door', x: 5, y: 0, w: 2.4, h: 1.2, rot: 0 });
layout.shapes.push({ id: 'l1', kind: 'line', x: 0, y: 20, w: 10, h: 0 });

// --- editor render, nothing selected: tap pads for small items only ---
let svg = fakeSvg();
drawLayout(svg, layout, { editor: true });
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

// --- selected but LOCKED: a dashed outline and nothing else ---
svg = fakeSvg();
drawLayout(svg, layout, { editor: true, selectedId: 'm1' });
const lockedOutline = tagsWith(svg.innerHTML, 'selected-outline');
assert.equal(lockedOutline.length, 1, 'selection is still marked while locked');
assert.ok(!lockedOutline[0].includes('unlocked'), 'a locked outline stays dashed');
assert.equal(tagsWith(svg.innerHTML, 'handle-hit').length, 0,
  'no resize handle until the item is double-tapped');
assert.ok(!svg.innerHTML.includes('handle-icon'), 'no resize icon under the thumb either');

// --- unlocked by a double tap: solid outline, icon handle, big hit circle ---
svg = fakeSvg();
drawLayout(svg, layout, { editor: true, selectedId: 'm1', unlockedId: 'm1' });
assert.ok(tagsWith(svg.innerHTML, 'selected-outline')[0].includes('unlocked'),
  'an unlocked outline says so, so the state reads at arm\'s length');
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
drawLayout(svg, layout, { editor: true, selectedId: 'm2', unlockedId: 'm2' });
const hitR = 22 / ppu;
const hit2 = tagsWith(svg.innerHTML, 'handle-hit')[0];
assert.ok(close(num(hit2, 'cx'), 60 + PAD - hitR) && close(num(hit2, 'cy'), 40 + PAD - hitR),
  'corner handle clamps fully inside the padded viewBox');

// --- the unlock belongs to ONE item: a stale id never unlocks the selected one ---
svg = fakeSvg();
drawLayout(svg, layout, { editor: true, selectedId: 'm1', unlockedId: 'm2' });
assert.equal(tagsWith(svg.innerHTML, 'handle-hit').length, 0,
  'another item being unlocked does not hand m1 a handle');

// --- outline selected but LOCKED: no corner handles to grab by accident ---
svg = fakeSvg();
drawLayout(svg, layout, { editor: true, selectedId: 'outline' });
assert.equal(tagsWith(svg.innerHTML, 'vertex-hit').length, 0,
  'a locked outline hands out no corner handles');
assert.equal(tagsWith(svg.innerHTML, 'mid-hit').length, 0, 'and no midpoint dots');

// --- outline unlocked: enlarged, clamped vertex/midpoint handles ---
svg = fakeSvg();
drawLayout(svg, layout, { editor: true, selectedId: 'outline', unlockedId: 'outline' });
const verts = tagsWith(svg.innerHTML, 'vertex-hit');
assert.equal(verts.length, layout.outline.length, 'one hit rect per outline corner');
const vertHit = 40 / ppu;
const v0 = verts.find((v) => attr(v, 'data-vertex') === '0');
assert.ok(close(num(v0, 'x'), -PAD) && close(num(v0, 'y'), -PAD),
  'corner (0,0) hit rect clamps to start at the padded viewBox edge');
assert.ok(close(num(v0, 'width'), vertHit), 'vertex hit rect is 40px');
const vVis = tagsWith(svg.innerHTML, 'vertex');
assert.ok(vVis.every((v) => v.includes('pointer-events="none"')), 'visible vertices inert');
assert.ok(close(num(vVis[0], 'x'), -(20 / ppu) / 2),
  'visible vertex stays on the true (unclamped) corner');
assert.equal(tagsWith(svg.innerHTML, 'mid-hit').length, layout.outline.length,
  'one hit circle per edge midpoint');

// --- layers: `z` decides the stacking order, not the array order ---
// Array order cannot carry it: merge.js's mergeById documents "order
// unspecified", so a stack kept as array order dies on the first sync.
const layered = store.newLayout('Layers');
layered.shapes.push(
  { id: 's-top', kind: 'rect', label: 'Top', x: 2, y: 2, w: 10, h: 10, z: 1 },
  { id: 's-mid', kind: 'rect', label: 'Mid', x: 3, y: 3, w: 10, h: 10 },
  { id: 's-bot', kind: 'rect', label: 'Bot', x: 4, y: 4, w: 10, h: 10, z: -1 },
);
svg = fakeSvg();
drawLayout(svg, layered, { editor: true });
const order = ['s-bot', 's-mid', 's-top'].map((id) => svg.innerHTML.indexOf(id));
assert.deepEqual([...order].sort((a, b) => a - b), order,
  'shapes render background -> normal -> on top, whatever the array says');

// an absent z is Normal, and equal layers keep their creation order (stable sort)
const tied = store.newLayout('Tied');
tied.shapes.push(
  { id: 's-first', kind: 'rect', x: 2, y: 2, w: 5, h: 5 },
  { id: 's-second', kind: 'rect', x: 3, y: 3, w: 5, h: 5, z: 0 },
);
svg = fakeSvg();
drawLayout(svg, tied, { editor: true });
assert.ok(svg.innerHTML.indexOf('s-first') < svg.innerHTML.indexOf('s-second'),
  'same layer keeps creation order — the sort is stable');

// machines stay above every shape, including an "On top" one
svg = fakeSvg();
const overMachine = store.newLayout('Over');
overMachine.shapes.push({ id: 's-over', kind: 'rect', x: 2, y: 2, w: 20, h: 20, z: 1 });
overMachine.machines.push({ id: 'm-under', num: 1, x: 4, y: 4, w: 4, h: 3, settingsFields: [] });
drawLayout(svg, overMachine, { editor: true });
assert.ok(svg.innerHTML.indexOf('s-over') < svg.innerHTML.indexOf('m-under'),
  'a machine is never hidden behind a zone, whatever its layer');

// --- read-only mini-map: no editor artifacts, no layout measurement ---
svg = fakeSvg();
svg.getBoundingClientRect = () => { throw new Error('mini-map must not measure layout'); };
drawLayout(svg, layout, { editor: false });
assert.equal(tagsWith(svg.innerHTML, 'tap-hit').filter((p) => attr(p, 'data-id')).length, 0,
  'no item pads in the mini-map');
assert.ok(!svg.innerHTML.includes('handle'), 'no handles in the mini-map');
const miniDoorHit = tagsWith(svg.innerHTML, 'tap-hit').find((p) => !attr(p, 'data-id'));
assert.ok(close(num(miniDoorHit, 'height'), 2.6), 'mini-map keeps the fixed-unit door strip');

// --- "where is it?" highlight: target pulses, every other machine dims ---
svg = fakeSvg();
drawLayout(svg, layout, { highlightId: 'm1' });
assert.ok(svg.innerHTML.includes('class="machine locate" data-id="m1"'),
  'highlight target carries the locate class');
assert.equal(tagsWith(svg.innerHTML, 'machine').filter((g) => attr(g, 'opacity') === '0.35').length,
  layout.machines.length - 1, 'all non-target machines dim');
assert.equal((svg.innerHTML.match(/stroke:#fff/g) || []).length, 1,
  'exactly the target gets the white stroke');
svg = fakeSvg();
drawLayout(svg, layout, {});
assert.ok(!svg.innerHTML.includes('locate') && !svg.innerHTML.includes('opacity="0.35"'),
  'no highlight artifacts without highlightId');

// --- zero-width fallback: sizes stay finite ---
svg = fakeSvg();
svg.getBoundingClientRect = () => ({ width: 0 });
drawLayout(svg, layout, { editor: true, selectedId: 'm1', unlockedId: 'm1' });
const fallbackHit = tagsWith(svg.innerHTML, 'handle-hit')[0];
assert.ok(Number.isFinite(num(fallbackHit, 'r')) && num(fallbackHit, 'r') > 0,
  'ASSUMED_SVG_PX fallback keeps handle sizes finite');

// --- overlapsSolid: AABB semantics ---
const m1 = layout.machines[0];
assert.ok(overlapsSolid(layout, null, 12, 11, 4, 3), 'overlap detected');
assert.ok(!overlapsSolid(layout, null, 0, 0, 4, 3), 'clear spot is free');
assert.ok(!overlapsSolid(layout, null, 14, 10, 4, 3), 'edge-to-edge contact is allowed');
assert.ok(!overlapsSolid(layout, m1, 10, 10, 4, 3), 'item never collides with itself');

// --- free-standing fixtures are solid too ---
assert.ok(overlapsSolid(layout, null, 19, 19, 4, 3), 'fixture footprint blocks like a machine');
const waterFixture = layout.shapes.find((s) => s.id === 'f1');
assert.ok(!fits(layout, m1, 19, 19, 4, 3), 'machine may not cover a fixture');
assert.ok(!fits(layout, waterFixture, 11, 11, 2, 2), 'fixture may not cover a machine');
assert.ok(fits(layout, waterFixture, 0, 0, 2, 2), 'fixture moves freely onto empty floor');

// --- fits: exclusivity is solids-only and grandfathered ---
const zone = { id: 'z2', kind: 'rect', x: 0, y: 0, w: 12, h: 8 };
assert.ok(fits(layout, zone, 10, 10, 12, 8), 'zones may overlap machines freely');
assert.ok(!fits(layout, m1, 55, 36, 4, 3), 'clean machine may not move onto another footprint');
assert.ok(fits(layout, m1, 24, 10, 4, 3), 'clean machine may move to a free spot');
const tangled = { id: 'm3', num: 3, x: 11, y: 11, w: 4, h: 3 }; // overlaps m1 already
layout.machines.push(tangled);
assert.ok(fits(layout, tangled, 11, 11, 3, 2),
  'pre-existing overlap: shrinking is allowed even while still overlapping');
assert.ok(fits(layout, tangled, 12, 11, 4, 3),
  'pre-existing overlap: any move is allowed so it can be untangled');
layout.machines.pop();

// --- freeSpot: placement for new machines ---
assert.deepEqual(freeSpot(layout, 30, 30, 4, 3), { x: 30, y: 30 }, 'preferred spot used when free');
const found = freeSpot(layout, 11, 11, 4, 3);
assert.deepEqual(found, { x: 11, y: 13 },
  'occupied preferred spot: the NEAREST free spot wins (right below m1, edge-to-edge)');
const packed = store.newLayout('Packed');
packed.grid = { w: 8, h: 6 };
packed.machines.push(
  { id: 'p1', num: 1, x: 0, y: 0, w: 8, h: 3 },
  { id: 'p2', num: 2, x: 0, y: 3, w: 8, h: 3 },
);
assert.deepEqual(freeSpot(packed, 2, 2, 4, 3), { x: 2, y: 2 },
  'packed floor falls back to the preferred spot instead of refusing');

console.log('map renderer + collision: all assertions passed');
