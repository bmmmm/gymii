// Pure merge-matrix tests for js/merge.js: union by id, whole-record LWW
// via updatedAt (absent = epoch 0), tombstones as the resurrect guard.
// No DOM, no localStorage — merge.js is import-clean by design.
// Run with: node test/merge.test.mjs
import { strict as assert } from 'node:assert';
import {
  stamp, mergeById, mergeWorkouts, mergePlans, mergeLayout, mergeGyms,
  mergeSettings,
} from '../js/merge.js';

const w = (id, updatedAt, weight = 40, startedAt = 1000) => ({
  id, startedAt, ...(updatedAt != null ? { updatedAt } : {}),
  entries: [{ machineId: 'm1', num: 1, label: 'X', settings: {}, sets: [{ reps: 10, weight }] }],
});
const byId = (items) => [...items].sort((a, b) => a.id.localeCompare(b.id));

// (1) both-added while offline: disjoint ids union, nothing dropped
{
  const r = mergeWorkouts([w('a', 1)], [w('b', 2)]);
  assert.deepEqual(byId(r.items).map((x) => x.id), ['a', 'b'], '1: both-added unions');
  assert.equal(r.changed, true, '1: local gains the remote workout');
}

// (2) same id edited on both: whole-record LWW, loser fully discarded
{
  const newer = mergeWorkouts([w('a', 1, 40)], [w('a', 2, 45)]);
  assert.equal(newer.items[0].entries[0].sets[0].weight, 45, '2: newer remote wins whole record');
  assert.equal(newer.changed, true);
  const older = mergeWorkouts([w('a', 3, 40)], [w('a', 2, 45)]);
  assert.equal(older.items[0].entries[0].sets[0].weight, 40, '2: newer local survives');
  assert.equal(older.changed, false, '2: nothing to rewrite locally');
}

// (3) deleted on one device, untouched on the other: tombstone wins
{
  const r = mergeWorkouts([w('a', 1)], [], [], [{ id: 'a', at: 5 }]);
  assert.equal(r.items.length, 0, '3: the delete travels, no resurrection');
  assert.equal(r.changed, true);
  assert.deepEqual(r.tombstones, [{ id: 'a', at: 5 }], '3: tombstone carried forward');
}

// (4) delete on A, LATER edit on B: the edit un-deletes
{
  const r = mergeWorkouts([], [w('a', 10)], [{ id: 'a', at: 5 }], []);
  assert.equal(r.items.length, 1, '4: an edit after the delete revives the record');
}

// (5) edit on B, LATER delete on A: stays deleted, the edit is lost —
// pinned deliberately so nobody "fixes" it into a resurrection bug
{
  const r = mergeWorkouts([], [w('a', 3)], [{ id: 'a', at: 5 }], []);
  assert.equal(r.items.length, 0, '5: the delete outranks an older edit');
}

// (6) unstamped legacy record loses to any stamped edit of the same id
{
  const r = mergeWorkouts([w('a', null, 40)], [w('a', 1, 45)]);
  assert.equal(r.items[0].entries[0].sets[0].weight, 45, '6: legacy (epoch 0) loses');
  assert.equal(stamp(w('a', null)), 0, '6: absent updatedAt reads as 0');
}

// (7) both unstamped, same id, different content: deterministic local win —
// the one-time pre-groundwork migration ambiguity
{
  const r = mergeWorkouts([w('a', null, 40)], [w('a', null, 45)]);
  assert.equal(r.items[0].entries[0].sets[0].weight, 40, '7: tie resolves to local');
}

// (8) merge is order-agnostic; chronology is the WRITER's job (saveWorkouts)
{
  const r = mergeWorkouts([w('b', 1, 40, 2000)], [w('a', 1, 45, 1000)]);
  const sorted = r.items.slice().sort((x, y) => x.startedAt - y.startedAt);
  assert.deepEqual(sorted.map((x) => x.id), ['a', 'b'],
    '8: feeding the result through the saveWorkouts sort restores chronology');
}

// (9) idempotence: re-merging the merged state is a no-op
{
  const first = mergeWorkouts([w('a', 1)], [w('b', 2)], [], [{ id: 'c', at: 3 }]);
  const again = mergeWorkouts(first.items, [w('b', 2)], first.tombstones, [{ id: 'c', at: 3 }]);
  assert.deepEqual(byId(again.items), byId(first.items), '9: merge(merge(a,b), b) is stable');
  assert.equal(again.changed, false, '9: and reports no local change');
  const self = mergeWorkouts([w('a', 1)], [w('a', 1)]);
  assert.equal(self.changed, false, '9: merge(x, x) is a no-op');
}

// (10) two ids with near-identical content are NOT content-deduped — a
// live-logged and a back-logged copy of the same workout both survive
{
  const r = mergeWorkouts([w('a', 1, 40, 1000)], [w('b', 1, 40, 1000)]);
  assert.equal(r.items.length, 2, '10: identity is the id, never the content');
}

// (11) plans: the winner's createdAt travels, the loser's never leaks
{
  const r = mergePlans(
    [{ id: 'p', name: 'Push', createdAt: 100, updatedAt: 1, items: [] }],
    [{ id: 'p', name: 'Push v2', createdAt: 200, updatedAt: 2, items: [] }]);
  assert.equal(r.items[0].createdAt, 200, '11: createdAt belongs to the winning record');
  assert.equal(r.items[0].name, 'Push v2');
}

// (12) plans: delete-vs-edit both directions (mirrors 4/5)
{
  const revived = mergePlans([], [{ id: 'p', updatedAt: 10, items: [] }], [{ id: 'p', at: 5 }], []);
  assert.equal(revived.items.length, 1, '12: later edit revives a deleted plan');
  const dead = mergePlans([], [{ id: 'p', updatedAt: 3, items: [] }], [{ id: 'p', at: 5 }], []);
  assert.equal(dead.items.length, 0, '12: later delete keeps the plan dead');
}

const machine = (id, x, updatedAt) => ({ id, num: 1, label: id, x, y: 0, w: 4, h: 3, updatedAt });
const gymWith = (machines, extra = {}) => ({
  v: 1, name: 'G', grid: { w: 60, h: 40 }, meta: {}, outline: [{ x: 0, y: 0 }],
  shapes: [], machines, ...extra,
});

// (13) the headline case: machine added on A, another machine moved on B —
// BOTH survive (per-item merge, not whole-gym LWW)
{
  const local = gymWith([machine('m1', 0, 1), machine('mNew', 5, 9)]);
  const remote = gymWith([machine('m1', 20, 8)]);
  const r = mergeLayout(local, remote);
  assert.deepEqual(byId(r.merged.machines).map((m) => m.id), ['m1', 'mNew'],
    '13: the new machine survives the other device\'s workout');
  assert.equal(r.merged.machines.find((m) => m.id === 'm1').x, 20, '13: the move survives too');
}

// (14) same machine edited on both: whole-machine LWW (accepted trade-off)
{
  const r = mergeLayout(gymWith([machine('m1', 5, 1)]), gymWith([machine('m1', 9, 2)]));
  assert.equal(r.merged.machines[0].x, 9, '14: newer edit takes the whole machine');
}

// (15) machine deleted on A + a different one rearranged on B compose
{
  const local = gymWith([machine('m2', 7, 9)]);
  const remote = gymWith([machine('m1', 0, 1), machine('m2', 3, 2)]);
  const r = mergeLayout(local, remote, { machines: [{ id: 'm1', at: 5 }] }, {});
  assert.deepEqual(r.merged.machines.map((m) => m.id), ['m2'], '15: the delete holds');
  assert.equal(r.merged.machines[0].x, 7, '15: the rearrangement elsewhere survives');
}

// (16) structural LWW (outline) is independent of the machines merge
{
  const local = gymWith([machine('m1', 0, 1)],
    { outline: [{ x: 9, y: 9 }], updatedAt: 10 });
  const remote = gymWith([machine('m1', 0, 1), machine('m2', 5, 8)], { updatedAt: 2 });
  const r = mergeLayout(local, remote);
  assert.deepEqual(r.merged.outline, [{ x: 9, y: 9 }], '16: local outline wins structurally');
  assert.equal(r.merged.machines.length, 2, '16: while the remote machine still lands');
}

// (17) settings: device-scoped fields never follow remote, user-scoped do
{
  const local = { v: 1, unit: 'kg', weightStep: 2.5, restSeconds: 90, mapColors: 'usage', aiPrompt: 'mine', updatedAt: 1 };
  const remote = { v: 1, unit: 'lbs', weightStep: 5, restSeconds: 60, mapColors: 'custom', updatedAt: 2 };
  const r = mergeSettings(local, remote);
  assert.equal(r.merged.unit, 'lbs', '17: user-scoped unit follows the newer side');
  assert.equal(r.merged.restSeconds, 60, '17: rest timer too');
  assert.equal(r.merged.mapColors, 'usage', '17: device-scoped stays local');
  assert.equal('aiPrompt' in r.merged, false, '17: an absent user field wins too (reset prompt)');
  const stale = mergeSettings(local, { ...remote, updatedAt: 0 });
  assert.equal(stale.merged.unit, 'kg', '17: an older remote changes nothing');
  assert.equal(stale.changed, false);
}

// (18) gyms: tombstoned gym stays dead, activeId is device-local
{
  const local = { v: 1, list: [{ id: 'p1', name: 'Home', updatedAt: 1 }], activeId: 'p1' };
  const remote = {
    v: 1, list: [{ id: 'p2', name: 'Hotel', updatedAt: 2 }], activeId: 'p2',
    deleted: [{ id: 'p1', at: 5 }],
  };
  const r = mergeGyms(local, remote);
  assert.deepEqual(r.merged.list.map((p) => p.id), ['p2'], '18: the delete travels');
  assert.equal(r.merged.activeId, 'p2', '18: activeId healed to a live gym, not taken from remote');
  const keep = mergeGyms(
    { v: 1, list: [{ id: 'p1', name: 'Home', updatedAt: 1 }, { id: 'p3', name: 'B', updatedAt: 1 }], activeId: 'p3' },
    { v: 1, list: [{ id: 'p1', name: 'Home', updatedAt: 1 }], activeId: 'p1' });
  assert.equal(keep.merged.activeId, 'p3', '18: a live local activeId is never touched');
}

// mergeById is the shared engine — one direct sanity check that tombstones
// dedupe to the max `at` per id
{
  const r = mergeById([], [], [{ id: 'x', at: 1 }, { id: 'x', at: 9 }], [{ id: 'x', at: 4 }]);
  assert.deepEqual(r.tombstones, [{ id: 'x', at: 9 }], 'tombstones keep the newest at per id');
}

// The map's stacking order is a FIELD (`z`), never the array order — this is
// why. mergeById unions by id and says nothing about order, so a stack kept
// as array order would come back scrambled; carried on the record it rides
// the same whole-record LWW as every other field.
{
  const l = { shapes: [{ id: 'a', z: -1, updatedAt: 5 }, { id: 'b', updatedAt: 5 }], machines: [] };
  const r = { shapes: [{ id: 'b', updatedAt: 5 }, { id: 'a', z: -1, updatedAt: 5 }], machines: [] };
  const out = mergeLayout(l, r).merged.shapes;
  assert.equal(out.find((x) => x.id === 'a').z, -1, 'z survives the merge on its record');
  // a newer layer change on the remote wins like any other field edit
  const bumped = mergeLayout(
    { shapes: [{ id: 'a', z: -1, updatedAt: 5 }], machines: [] },
    { shapes: [{ id: 'a', z: 1, updatedAt: 9 }], machines: [] });
  assert.equal(bumped.merged.shapes[0].z, 1, 'the newer layer edit wins');
}

console.log('merge matrix: all assertions passed');
