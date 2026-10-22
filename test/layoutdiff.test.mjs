// Logic test for js/layoutdiff.js — the gym editor's undo engine. Pure, no
// imports on its side, so NO localStorage stub here (like chart/merge).
// gym.test.mjs drives the same engine through the editor's save() and
// undo/redo buttons; this file pins it directly: the diff/apply round trip,
// foreignOnly keeping another writer's edit, and undo/redo onto a layout a
// sync merge changed underneath.
import { strict as assert } from 'node:assert';

const {
  layoutDiff, applySide, foreignOnly, clone, same,
} = await import(new URL('../js/layoutdiff.js', import.meta.url).href);

const base = () => ({
  id: 'g1',
  name: 'Home gym',
  grid: { w: 40, h: 30 },
  meta: { brand: 'Gym80', city: 'Berlin' },
  outline: [[0, 0], [40, 0], [40, 30], [0, 30]],
  machines: [
    { id: 'm1', num: 1, label: 'Leg press', x: 2, y: 2, w: 4, h: 3, muscles: ['quads'] },
    { id: 'm2', num: 2, label: 'Lat pulldown', x: 10, y: 2, w: 3, h: 3 },
    { id: 'm3', num: 3, label: 'Row', x: 20, y: 2, w: 3, h: 3 },
  ],
  shapes: [{ id: 's1', kind: 'zone', x: 0, y: 10, w: 10, h: 10 }],
});

// --- 1. clone / same ---
assert.equal(clone(undefined), undefined, 'clone keeps undefined (an absent field)');
const c = clone({ a: [1, { b: 2 }] });
assert.deepEqual(c, { a: [1, { b: 2 }] });
assert.ok(same({ a: 1 }, { a: 1 }) && !same({ a: 1 }, { a: 2 }));

// --- 2. no change, no entry ---
assert.deepEqual(layoutDiff(base(), base()), [], 'identical layouts diff to nothing');

// --- 3. diff/apply round trip: every kind of change, both directions ---
{
  const a = base();
  const b = base();
  b.name = 'Studio';
  b.grid = { w: 50, h: 30 };
  delete b.meta.city; // a key removed from a structural record
  b.meta.postcode = '10115';
  b.outline = [[0, 0], [50, 0], [50, 30], [0, 30]];
  b.machines[0].x = 7; // moved
  b.machines[0].muscles = ['quads', 'glutes'];
  delete b.machines[0].label; // a key removed from a part
  b.machines.splice(1, 1); // m2 deleted (index 1)
  b.machines.push({ id: 'm4', num: 4, label: 'Bike', x: 30, y: 20, w: 2, h: 2, cardio: true }); // added
  b.shapes[0].w = 12;

  const d = layoutDiff(a, b);
  assert.deepEqual(d.filter((x) => x.field).map((x) => x.field).sort(), ['grid', 'meta', 'name', 'outline'],
    'each structural field that changed is one change');
  assert.deepEqual(d.filter((x) => x.coll).map((x) => `${x.coll}:${x.id}`).sort(),
    ['machines:m1', 'machines:m2', 'machines:m4', 'shapes:s1'], 'each changed part by id, the untouched m3 not');
  const m2 = d.find((x) => x.id === 'm2');
  assert.equal(m2.after, null, 'a deleted part has no after side');
  assert.equal(m2.at.before, 1, 'and remembers its old index');
  assert.equal(d.find((x) => x.id === 'm4').before, null, 'an added part has no before side');

  const redone = clone(a);
  applySide(redone, d, 'after');
  assert.deepEqual(redone, b, "'after' turns a into b");
  const undone = clone(b);
  applySide(undone, d, 'before');
  assert.deepEqual(undone, a, "'before' turns b back into a — m2 at its old index, the removed keys back");

  // the entry is its own copy: mutating the layouts afterwards changes nothing in it
  b.machines[0].x = 99;
  a.name = 'mutated';
  const again = clone(base());
  applySide(again, d, 'after');
  assert.equal(again.machines[0].x, 7, 'the entry holds clones, not references');
}

// --- 4. a structural field absent on one side ---
{
  const a = base();
  delete a.meta;
  const b = base();
  const d = layoutDiff(a, b);
  const t = clone(b);
  applySide(t, d, 'before');
  assert.ok(!('meta' in t), 'undoing the field that did not exist deletes it, never meta: undefined');
  applySide(t, d, 'after');
  assert.deepEqual(t.meta, b.meta);
  const e = { name: 'x' }; // no machines/shapes arrays at all
  applySide(e, layoutDiff(base(), { ...base(), machines: [] }), 'before');
  assert.equal(e.machines.length, 3, 'a missing collection is created to restore into');
}

// --- 5. foreignOnly: another writer's edit survives this edit ---
// lastSaved = what the editor wrote; mine = this edit; stored = what a sync
// pull (or Train teaching a grip) put into storage meanwhile.
{
  const lastSaved = base();
  const layout = clone(lastSaved); // the editor's render-time copy
  layout.machines[0].x = 9; // my edit: move m1
  layout.machines[0].label = 'Leg press 45°'; // and rename it
  layout.meta.brand = 'Panatta'; // and change the gym's brand
  const mine = layoutDiff(lastSaved, layout);

  const stored = clone(lastSaved);
  stored.machines[0].grips = ['wide']; // a grip on the SAME machine
  stored.machines[0].label = 'Remote name'; // a key BOTH changed
  stored.machines.push({ id: 'm9', num: 9, label: 'Synced in', x: 30, y: 10, w: 2, h: 2 }); // a new machine
  stored.meta.city = 'Hamburg'; // another key of a field I touched
  stored.name = 'Renamed elsewhere'; // a field only they touched
  stored.shapes[0].h = 5; // a part only they touched

  const foreign = foreignOnly(layoutDiff(lastSaved, stored), mine);
  applySide(layout, foreign, 'after');

  const m1 = layout.machines.find((m) => m.id === 'm1');
  assert.equal(m1.x, 9, 'my key stays mine');
  assert.equal(m1.label, 'Leg press 45°', 'a key both changed: this edit wins');
  assert.deepEqual(m1.grips, ['wide'], "the other writer's key on the same machine is taken in");
  assert.ok(layout.machines.some((m) => m.id === 'm9'), 'a machine synced in meanwhile survives (no tombstone)');
  assert.equal(layout.meta.brand, 'Panatta', 'my brand wins');
  assert.equal(layout.meta.city, 'Hamburg', 'their city in the same meta survives');
  assert.equal(layout.name, 'Renamed elsewhere', 'a structural field only they touched comes whole');
  assert.equal(layout.shapes[0].h, 5, 'a part only they touched comes whole');

  // the undo entry stays this edit alone: undoing it keeps everything foreign
  applySide(layout, mine, 'before');
  const u1 = layout.machines.find((m) => m.id === 'm1');
  assert.equal(u1.x, 2, 'undo takes my move back');
  assert.equal(u1.label, 'Leg press', 'and my rename');
  assert.deepEqual(u1.grips, ['wide'], 'but keeps the synced grip');
  assert.equal(layout.meta.brand, 'Gym80');
  assert.equal(layout.meta.city, 'Hamburg', "and their meta key");
  assert.ok(layout.machines.some((m) => m.id === 'm9'), 'and the synced machine');
}

// --- 6. foreignOnly: a part one side deleted or added whole is this edit's call ---
{
  const lastSaved = base();
  const layout = clone(lastSaved);
  layout.machines = layout.machines.filter((m) => m.id !== 'm2'); // I delete m2
  const mine = layoutDiff(lastSaved, layout);
  const stored = clone(lastSaved);
  stored.machines[1].x = 15; // they moved m2
  const foreign = foreignOnly(layoutDiff(lastSaved, stored), mine);
  assert.deepEqual(foreign, [], 'their edit to the machine I deleted is dropped');
  applySide(layout, foreign, 'after');
  assert.ok(!layout.machines.some((m) => m.id === 'm2'), 'my delete stands');
  assert.deepEqual(foreignOnly([], mine), [], 'nothing foreign, nothing to take in');
}

// --- 7. undo/redo after a merge REPLACED a machine ---
// The merge hands storage a new object for m1 (remote's whole record, LWW):
// undo must write only the keys the edit changed into that object.
{
  const before = base();
  const after = clone(before);
  after.machines[0].x = 12; // the recorded edit: move m1
  after.machines.push({ id: 'm5', num: 5, label: 'Dip station', x: 30, y: 25, w: 2, h: 2 }); // and add m5
  after.machines = after.machines.filter((m) => m.id !== 'm3'); // and delete m3
  const entry = layoutDiff(before, after);

  // what storage holds when undo is tapped: a merge replaced m1 and m5
  // whole, added m7, and another device deleted m2
  const merged = clone(after);
  merged.machines[0] = { ...merged.machines[0], label: 'Remote leg press', grips: ['narrow'] };
  merged.machines = merged.machines.filter((m) => m.id !== 'm2');
  merged.machines.find((m) => m.id === 'm5').label = 'Remote dips';
  merged.machines.push({ id: 'm7', num: 7, label: 'Remote only', x: 35, y: 5, w: 2, h: 2 });

  applySide(merged, entry, 'before');
  const m1 = merged.machines.find((m) => m.id === 'm1');
  assert.equal(m1.x, 2, "undo restores the key the edit changed in the merge's object");
  assert.equal(m1.label, 'Remote leg press', "the merge's other keys survive");
  assert.deepEqual(m1.grips, ['narrow']);
  assert.ok(!merged.machines.some((m) => m.id === 'm5'), 'the machine the edit added goes, replaced or not');
  assert.ok(merged.machines.some((m) => m.id === 'm7'), 'a machine the merge brought in survives');
  assert.ok(!merged.machines.some((m) => m.id === 'm2'), 'a machine another device deleted stays deleted');
  const m3i = merged.machines.findIndex((m) => m.id === 'm3');
  assert.equal(m3i, 1, 'the undone delete comes back at its old index (2, then m5 leaves)');
  assert.deepEqual(merged.machines[m3i], before.machines[2], 'whole, as it was');

  // redo onto that state: m3 deleted again, m5 back, m1 moved — m7 untouched
  applySide(merged, entry, 'after');
  assert.equal(merged.machines.find((m) => m.id === 'm1').x, 12);
  assert.equal(merged.machines.find((m) => m.id === 'm1').label, 'Remote leg press', 'redo keeps the merge too');
  assert.ok(!merged.machines.some((m) => m.id === 'm3'));
  assert.ok(merged.machines.some((m) => m.id === 'm5') && merged.machines.some((m) => m.id === 'm7'));

  // a part the edit CHANGED that another writer deleted since stays deleted
  const gone = clone(after);
  gone.machines = gone.machines.filter((m) => m.id !== 'm1');
  applySide(gone, entry, 'before');
  assert.ok(!gone.machines.some((m) => m.id === 'm1'), 'undo does not resurrect a machine deleted elsewhere');
}

console.log('layoutdiff tests passed');
