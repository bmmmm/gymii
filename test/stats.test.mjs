// Logic tests for js/stats.js — the pure History analytics: week buckets,
// e1RM, per-machine series, muscle volume, walking paths, transitions,
// rest gaps and the eight insight rules (each at its threshold AND one
// step short). Run with: node test/stats.test.mjs
//
// Pinned to a DST-observing zone: week starts and the busy rule's
// time-of-day only show DAY_MS-style drift where transitions exist (CI runs
// UTC). Static imports are hoisted above this line; that stays correct
// because the helper never looks at the clock and both modules under test
// arrive by dynamic import from the body, after the zone is set.
process.env.TZ = 'Europe/Berlin';

import './helpers/localstorage.mjs'; // FIRST: store.js (the DST pin) needs the stub
import { strict as assert } from 'node:assert';

const store = await import(new URL('../js/store.js', import.meta.url).href);
const stats = await import(new URL('../js/stats.js', import.meta.url).href);

// The zone really is in effect — otherwise every DST assertion below would
// pass vacuously.
assert.equal(new Date(2026, 0, 15).getTimezoneOffset(), -60, 'TZ pinned: CET in winter');
assert.equal(new Date(2026, 6, 15).getTimezoneOffset(), -120, 'TZ pinned: CEST in summer');

// Wednesday 4 Nov 2026, noon; the 12 weeks before it span the 25 Oct switch.
const NOW = new Date(2026, 10, 4, 12, 0).getTime();
// `n` calendar days before NOW at hh:mm local time (Date normalises the day)
const day = (n, hh = 18, mm = 0) => new Date(2026, 10, 4 - n, hh, mm).getTime();
const KG = { unit: 'kg', weightStep: 2.5 };

// Machines are boxes 4×3 placed by their CENTRE (cx, cy) in grid units.
const M = (id, num, label, cx, cy, muscles = [], flags = {}) => ({
  id, num, label, x: cx - 2, y: cy - 1.5, w: 4, h: 3, settingsFields: [], muscles, ...flags,
});
const ENTRANCE = { id: 'ent', kind: 'fixture', fixture: 'entrance', x: 0, y: 20, w: 3.6, h: 1.2, rot: 90 };
const LAYOUT = {
  v: 1, name: 'Test gym', grid: { w: 60, h: 40 }, meta: {}, outline: [],
  shapes: [ENTRANCE],
  machines: [
    M('m1', 1, 'Chest press', 2, 1.5, ['Chest', 'Triceps']),
    M('m2', 2, 'Lat pulldown', 12, 1.5, ['Lats', 'Biceps']),
    M('m3', 3, 'Seated row', 12, 11.5, ['Upper back']),
    M('m4', 4, 'Leg curl', 30, 11.5, ['Hamstrings']),
    M('m5', 5, 'Treadmill', 40, 11.5, ['Quads', 'Calves'], { cardio: true }),
    M('m6', 6, 'Leg press', 30, 20, ['Quads', 'Glutes']),
    M('m8', 8, 'Pec deck', 40, 20, ['Chest']),
  ],
};
// four resistance muscles, one per machine, plus a cardio machine on Calves
const L4 = {
  ...LAYOUT,
  machines: [
    M('va', 1, 'A', 2, 2, ['Chest']), M('vb', 2, 'B', 8, 2, ['Lats']),
    M('vc', 3, 'C', 14, 2, ['Quads']), M('vd', 4, 'D', 20, 2, ['Calves']),
    M('vt', 5, 'T', 26, 2, ['Calves'], { cardio: true }),
  ],
};
const ALL = [...LAYOUT.machines, ...L4.machines];

// An entry snapshot like store's newEntry; flags come from the machine.
const E = (machineId, sets, extra = {}) => {
  const m = ALL.find((x) => x.id === machineId);
  return {
    machineId, num: m?.num ?? 99, label: m?.label ?? 'Gone',
    ...(m?.cardio ? { cardio: true } : {}), ...(m?.bodyweight ? { bodyweight: true } : {}),
    settings: {}, sets, ...extra,
  };
};
const S = (reps, weight, more = {}) => ({ reps, weight, ...more });
const C = (distance, seconds, more = {}) => ({ distance, seconds, ...more });
const sets = (n, reps = 10, weight = 20) => Array.from({ length: n }, () => S(reps, weight));
let wid = 0;
const W = (startedAt, entries, extra = {}) => ({
  id: `w${++wid}`, startedAt, finishedAt: startedAt + 3600e3, entries, ...extra,
});

// --- startOfDay: the copy in stats.js equals store.js's, across DST days ---
{
  let probes = 0;
  for (const [y, mo, d] of [[2026, 2, 29], [2026, 9, 25]]) {
    const end = new Date(y, mo, d + 1, 4).getTime();
    for (let t = new Date(y, mo, d - 1, 20).getTime(); t < end; t += 15 * 60000) {
      assert.equal(stats.startOfDay(t).getTime(), store.startOfDay(t).getTime(),
        `startOfDay copy drifted from store.js at ${new Date(t).toISOString()}`);
      probes++;
    }
  }
  assert.ok(probes > 200, 'the pin probed both DST days');
  // mondayOf: local Monday midnight, also for a Sunday inside the DST week
  const m = stats.mondayOf(new Date(2026, 9, 25, 23, 30).getTime());
  assert.equal(m.getTime(), new Date(2026, 9, 19).getTime(), 'Sunday 25 Oct belongs to Monday 19 Oct');
}

// --- weeklyBuckets ---
{
  const ws = [
    W(new Date(2026, 10, 2, 9, 0).getTime(), // Mon 09:00 — the current week
      [E('m2', [S(10, 50), S(8, 50)]), E('m5', [C(2000, 600)])]),
    W(new Date(2026, 10, 1, 20, 0).getTime(), [E('m5', [C(1000, 300)])]), // Sun 20:00 — the week before
    W(new Date(2026, 9, 26, 0, 30).getTime(), [E('m1', [S(10, 40)])]), // first week after the switch
    W(new Date(2026, 9, 25, 23, 30).getTime(), [E('m1', [S(10, 40)])]), // Sunday of the DST week
    W(new Date(2026, 7, 16, 20, 0).getTime(), [E('m1', [S(10, 40)])]), // Sunday before the range
  ];
  const b = stats.weeklyBuckets(ws, { weeks: 12, now: NOW, layout: LAYOUT });
  assert.equal(b.length, 12);
  b.forEach((x, i) => {
    assert.equal(x.weekStart.getHours(), 0, `week ${i} starts at local midnight`);
    assert.equal(x.weekStart.getDay(), 1, `week ${i} starts on a Monday`);
  });
  assert.equal(b[0].weekStart.getTime(), new Date(2026, 7, 17).getTime(), 'oldest first');
  assert.equal(b[11].weekStart.getTime(), new Date(2026, 10, 2).getTime(), 'last = the week of now');
  assert.equal(b[9].weekStart.getTime(), new Date(2026, 9, 19).getTime(), 'the DST week is in range');
  // bucket edges
  assert.equal(b[11].workouts, 1, 'Mon 09:00 opens the current week');
  assert.equal(b[10].workouts, 2, 'Sun 20:00 and Mon 00:30 fall in the week before');
  assert.equal(b[9].workouts, 1, 'Sun 23:30 of the DST week stays in it');
  assert.equal(b.reduce((n, x) => n + x.workouts, 0), 4, 'a workout before the range is ignored');
  // the rollup
  assert.equal(b[11].sets, 3, 'cardio sets count as sets');
  assert.equal(b[11].volume, 900, 'volume = reps × weight, cardio excluded');
  assert.equal(b[11].cardioMinutes, 10);
  assert.equal(b[11].minutes, 60);
  assert.equal(b[11].strengthDays, 1);
  assert.equal(b[10].strengthDays, 1, 'a cardio-only day is no strength day');
  assert.deepEqual([...b[11].muscles], [['Lats', 2], ['Biceps', 2]], 'cardio machines add no muscle sets');
  assert.equal(stats.weeklyBuckets(ws, { weeks: 2, now: NOW })[1].muscles.size, 0, 'no layout, no muscles');
}

// --- e1rm ---
assert.equal(stats.e1rm(100, 10), 133.3);
assert.equal(stats.e1rm(60, 8), 76);
assert.equal(stats.e1rm(80, 1), 80, 'a single is its own 1RM');
assert.equal(stats.e1rm(50, 11), null, 'beyond 10 reps Epley is not valid');
assert.equal(stats.e1rm(0, 5), null, 'no load, no estimate');

// --- machineSeries ---
{
  const a = W(day(20), [E('m1', [S(8, 50), S(12, 50)])]);
  const b = W(day(10), [E('m1', [S(10, 55, { rir: 2 }), S(6, 60), S(6, 60, { rir: 1 })])]);
  const c = W(day(5), [E('m1', [S(10, 30)], { exercise: 'Flyes' })]);
  const s = stats.machineSeries([b, c, a], 'm1');
  assert.deepEqual(s.map((p) => p.workoutId), [a.id, b.id], 'ascending; another exercise excluded');
  assert.deepEqual(s[0], {
    t: a.startedAt, workoutId: a.id, kind: 'strength', top: { weight: 50, reps: 12 },
    e1rm: 63.3, volume: 1000, sets: 2,
  }, 'top = heaviest then most reps; e1rm from the only valid set');
  assert.deepEqual(s[1].top, { weight: 60, reps: 6 });
  assert.equal(s[1].e1rm, 73.3, 'best valid e1rm across sets, not the top set');
  assert.equal(s[1].rir, 1, "a tie goes to the later set, and so does its rating");
  assert.equal(stats.machineSeries([b, c, a], 'm1', 'Flyes').length, 1, 'exercise filter');
  // mixed kinds: only the newest entry's kind survives
  const mixed = [
    W(day(30), [E('mx', [S(10, 40)])]),
    W(day(20), [E('mx', [S(10, 42.5)])]),
    W(day(10), [E('mx', [S(12, 0)], { bodyweight: true })]),
  ];
  const ms = stats.machineSeries(mixed, 'mx');
  assert.deepEqual(ms.map((p) => p.kind), ['bodyweight'], 'older strength entries dropped');
  assert.equal(ms[0].e1rm, null, 'no e1rm for bodyweight');
  const cs = stats.machineSeries([W(day(3), [E('m5', [C(2000, 600), C(2500, 900), C(2500, 800)])])], 'm5');
  assert.deepEqual(cs[0].top, { distance: 2500, seconds: 800 }, 'cardio top: longest, then fastest');
  assert.equal(cs[0].volume, 7000);
  assert.equal(cs[0].e1rm, null);
  assert.deepEqual(stats.machineSeries(mixed, 'nope'), []);
}

// --- muscleWeekly ---
{
  const ws = [W(day(2), [E('m6', sets(3, 10, 100)), E('m5', [C(3000, 900), C(1000, 300)])])];
  const mw = stats.muscleWeekly(ws, LAYOUT, { weeks: 4, now: NOW });
  assert.ok(!mw.has('Calves'), 'a muscle only a cardio machine carries is not a resistance muscle');
  assert.deepEqual(mw.get('Quads'), [0, 0, 0, 3], 'Quads count the leg press only, not the treadmill');
  assert.deepEqual(mw.get('Glutes'), [0, 0, 0, 3]);
  assert.deepEqual(mw.get('Hamstrings'), [0, 0, 0, 0], 'untrained muscles are present, zeros included');
  assert.deepEqual([...mw.keys()],
    ['Biceps', 'Chest', 'Glutes', 'Hamstrings', 'Lats', 'Quads', 'Triceps', 'Upper back']);
}

// --- workoutPath ---
const T0 = day(1);
const stamp = (sec) => T0 + sec * 1000;
// sets m1@0/60 s, m2@200, m3@400, m1@600
const ROUTE = W(T0, [
  E('m1', [S(10, 40, { at: stamp(0) }), S(10, 40, { at: stamp(60) }), S(10, 40, { at: stamp(600) })]),
  E('m2', [S(10, 40, { at: stamp(200) })]),
  E('m3', [S(10, 40, { at: stamp(400) })]),
]);
{
  const p = stats.workoutPath(ROUTE, LAYOUT);
  assert.deepEqual(p.start, { x: 1.8, y: 20.6 }, 'start = the entrance centre');
  assert.deepEqual(p.stops.map((s) => s.machineId), ['m1', 'm2', 'm3', 'm1']);
  assert.deepEqual(p.stops[0], { machineId: 'm1', x: 2, y: 1.5, at: stamp(0), seconds: 60 },
    'consecutive sets collapse into one stop spanning them');
  assert.deepEqual(p.legs.map((l) => l.len.toFixed(2)), ['19.10', '10.00', '10.00', '14.14']);
  assert.deepEqual(p.legs.map((l) => `${l.from}>${l.to}`), ['null>m1', 'm1>m2', 'm2>m3', 'm3>m1']);
  assert.equal(p.switches, 3);
  assert.equal(p.backtracks, 1, 'm3 → m1 returns to a machine already visited');

  const pingPong = W(T0, [
    E('m1', [S(10, 40, { at: stamp(0) }), S(10, 40, { at: stamp(200) })]),
    E('m2', [S(10, 40, { at: stamp(100) }), S(10, 40, { at: stamp(300) })]),
  ]);
  const pp = stats.workoutPath(pingPong, LAYOUT);
  assert.equal(pp.switches, 3);
  assert.equal(pp.backtracks, 0, 'immediate A→B→A is not a backtrack');

  // visits win over `at`; a machine gone from the layout drops out, then
  // the stops around it collapse
  const visited = {
    ...ROUTE,
    visits: [
      { machineId: 'm3', in: stamp(0), out: stamp(90) },
      { machineId: 'gone', in: stamp(100), out: stamp(150) },
      { machineId: 'm3', in: stamp(150), out: stamp(200) },
      { machineId: 'm2', in: stamp(300), out: stamp(420), busy: 'm8' },
    ],
  };
  const vp = stats.workoutPath(visited, LAYOUT);
  assert.deepEqual(vp.stops.map((s) => [s.machineId, s.seconds]), [['m3', 200], ['m2', 120]],
    'visits-based path preferred over set stamps');
  assert.equal(vp.switches, 1);

  const far = { ...ENTRANCE, id: 'ent2', x: 56, y: 38 };
  assert.deepEqual(stats.workoutPath(ROUTE, { ...LAYOUT, shapes: [far, ENTRANCE] }).start, { x: 1.8, y: 20.6 },
    'the entrance nearest the first machine starts the walk');
  const noEntrance = stats.workoutPath(ROUTE, { ...LAYOUT, shapes: [] });
  assert.equal(noEntrance.start, null);
  assert.equal(noEntrance.legs.length, 3, 'no entrance, no start leg');
  assert.equal(stats.workoutPath(W(T0, [E('m1', [S(10, 40, { at: stamp(0) })])]), LAYOUT), null,
    'one stop is no path');
  assert.equal(stats.workoutPath(W(T0, [E('m1', [S(10, 40)]), E('m2', [S(10, 40)])]), LAYOUT), null,
    'unstamped sets give no path');
  assert.equal(stats.workoutPath(ROUTE, null), null, 'no layout, no path');
}

// --- transitionCounts ---
{
  const pingPong = W(T0, [
    E('m1', [S(10, 40, { at: stamp(0) }), S(10, 40, { at: stamp(200) })]),
    E('m2', [S(10, 40, { at: stamp(100) }), S(10, 40, { at: stamp(300) })]),
  ]);
  const twoStops = W(T0, [E('m1', [S(10, 40, { at: stamp(0) })]), E('m2', [S(10, 40, { at: stamp(100) })])]);
  const tc = stats.transitionCounts([pingPong, twoStops, W(T0, [E('m3', sets(3))])]);
  assert.deepEqual([...tc].sort(), [
    ['m1>m2', { from: 'm1', to: 'm2', n: 2 }],
    ['m2>m1', { from: 'm2', to: 'm1', n: 1 }],
  ], 'once per workout per transition');
}

// --- restGaps ---
{
  const A = (...secs) => E('m1', secs.map((s) => S(10, 40, { at: stamp(s) })));
  assert.deepEqual(stats.restGaps(W(T0, [A(0, 120, 250)])), [120, 130]);
  assert.deepEqual(stats.restGaps(W(T0, [A(0, 120), E('m2', [S(10, 40, { at: stamp(60) })])])), [],
    'A B A: another machine in between breaks the pair');
  assert.deepEqual(stats.restGaps(W(T0, [A(0, 700)])), [], 'a 700 s gap is no rest');
  assert.deepEqual(stats.restGaps(W(T0, [A(0, 600)])), [600], '600 s is the last rest');
  assert.deepEqual(stats.restGaps(W(T0, [E('m5', [C(1000, 300, { at: stamp(0) }), C(1000, 300, { at: stamp(400) })])])), [],
    'cardio has no rests');
  assert.deepEqual(stats.restGaps(W(T0, [E('m1', sets(3))])), [], 'unstamped sets give no gaps');
}

// --- insights: every rule fires at its threshold and stays quiet one step short ---
const seen = []; // every insight produced below, for the shape checks at the end
const find = (ws, kind, { layout = LAYOUT, settings = KG, plans = [] } = {}) => {
  const out = stats.insights(ws, layout, settings, { now: NOW, plans, max: 20 });
  seen.push(...out);
  return out.find((i) => i.kind === kind);
};

// 1 progress — same top weight twice, reps ≥ T+2 (T = plan target, else 12)
// or reps ≥ T with rir ≥ 2
{
  const prog = (r2, r3, { rir2, rir3, w2 = 57.5, machine = 'm2', w = 57.5 } = {}) => [
    W(day(9), [E(machine, [S(10, w - 2.5)])]),
    W(day(5), [E(machine, [S(10, w2), S(r2, w2, rir2 != null ? { rir: rir2 } : {})])]),
    W(day(1), [E(machine, [S(10, w), S(r3, w, rir3 != null ? { rir: rir3 } : {})])]),
  ];
  const fired = find(prog(14, 14), 'progress');
  assert.equal(fired?.text, '#2 Lat pulldown: 14 × 57.5 kg twice — try 60 kg.');
  assert.equal(fired.source, 'acsm2009');
  assert.equal(fired.machineId, 'm2');
  assert.equal(find(prog(14, 13), 'progress'), undefined, 'progress: 13 reps is one short of T+2');
  assert.equal(find(prog(12, 12, { rir2: 2, rir3: 2 }), 'progress')?.text,
    '#2 Lat pulldown: 12 × 57.5 kg twice — try 60 kg.', 'progress: reps ≥ T with rir 2');
  assert.equal(find(prog(12, 12, { rir2: 2, rir3: 1 }), 'progress'), undefined, 'progress: rir 1 is one short');
  assert.equal(find(prog(11, 11, { rir2: 3, rir3: 3 }), 'progress'), undefined, 'progress: rir needs reps ≥ T');
  const plan = [{ id: 'p', name: 'Pull', items: [
    { machineId: 'm2', exercise: null, target: { sets: 3, reps: 10, weight: 57.5 } }] }];
  assert.ok(find(prog(12, 12), 'progress', { plans: plan }), 'progress: plan target 10 → 12 reps beat it');
  assert.equal(find(prog(12, 11), 'progress', { plans: plan }), undefined, 'progress: 11 is one short of 10+2');
  assert.equal(find(prog(14, 14, { w2: 55 }), 'progress'), undefined, 'progress: needs the SAME top weight');
  const heavier = prog(14, 14);
  heavier[1].entries[0].sets.push(S(5, 60));
  assert.equal(find(heavier, 'progress'), undefined, 'progress: an earlier top set of 60 kg is not W twice');
  assert.equal(find(prog(14, 14, { machine: 'm3', w: 20, w2: 20 }), 'progress')?.text,
    '#3 Seated row: 14 × 20 kg twice — add 1–2 reps first.', 'progress: a step over 10 % of W');
  assert.equal(find(prog(14, 14, { machine: 'm3', w: 25, w2: 25 }), 'progress')?.text,
    '#3 Seated row: 14 × 25 kg twice — try 27.5 kg.', 'progress: a step of exactly 10 % is fine');
  assert.equal(find(prog(14, 14), 'progress', { settings: { unit: 'lbs', weightStep: 5 } })?.text,
    '#2 Lat pulldown: 14 × 57.5 lbs twice — try 62.5 lbs.', 'progress: unit and step from settings');
}

// 2 frequency — ≥ 28 days of history, < 2 strength days/week over 4 full weeks
{
  // full weeks: Oct 5 (2 days), Oct 12 (2), Oct 19 (2), Oct 26 (1) = 7 → 1.75
  const freq = (first, extra = []) => [first, 26, 22, 20, 15, 13, 8, ...extra]
    .map((n) => W(day(n), [E('m1', [S(10, 40)])]));
  assert.equal(find(freq(28), 'frequency')?.text, 'Last 4 weeks: 1.75 strength days/week.');
  assert.equal(find(freq(28), 'frequency').source, 'who2020');
  assert.equal(find(freq(28, [6]), 'frequency'), undefined, 'frequency: a mean of exactly 2 is enough');
  assert.equal(find(freq(27), 'frequency'), undefined, 'frequency: 27 days of history is too short');
}

// 3 muscle-gap — trained in the last 42 d, not in the last 10, ≥ 2 workouts in those 10
{
  const gap = (back, recent = [5, 2]) => [
    W(day(back), [E('m4', [S(10, 30)])]),
    ...recent.map((n) => W(day(n), [E('m1', [S(10, 40)])])),
  ];
  const g = find(gap(10), 'muscle-gap');
  assert.equal(g?.text, 'Hamstrings: last trained 10 days ago.');
  assert.equal(g.muscle, 'Hamstrings');
  assert.equal(g.source, 'schoenfeld2016');
  assert.equal(find(gap(9), 'muscle-gap'), undefined, 'muscle-gap: 9 days is still recent');
  assert.ok(find(gap(41), 'muscle-gap'), 'muscle-gap: 41 days is still in the routine');
  assert.equal(find(gap(42), 'muscle-gap'), undefined, 'muscle-gap: 42 days is out of the window');
  assert.equal(find(gap(10, [15, 2]), 'muscle-gap'), undefined, 'muscle-gap: one recent workout is a break, not a gap');
}

// 4 muscle-volume — ≥ 4 weeks, ≥ 4 muscles, lowest 4-week mean < half the median
{
  const vol = (calves, { layout = L4, first = 30 } = {}) => [first, 23, 16, 9].map((n, i) => W(day(n), [
    E('va', sets(8)), E('vb', sets(8)), E('vc', sets(8)), E('vd', sets(calves[i])),
    E('vt', Array.from({ length: 10 }, () => C(1000, 300))),
  ]));
  const v = find(vol([4, 4, 4, 3]), 'muscle-volume', { layout: L4 });
  assert.equal(v?.text, 'Calves: 3.8 sets/week — your median muscle gets 8.',
    'muscle-volume fires — and the treadmill does not count as calf sets');
  assert.equal(v.muscle, 'Calves');
  assert.equal(v.source, 'schoenfeld2017');
  assert.equal(find(vol([4, 4, 4, 4]), 'muscle-volume', { layout: L4 }), undefined,
    'muscle-volume: exactly half the median is not below it');
  const L3 = { ...L4, machines: L4.machines.filter((m) => m.id !== 'vb') };
  assert.equal(find(vol([4, 4, 4, 3], { layout: L3 }), 'muscle-volume', { layout: L3 }), undefined,
    'muscle-volume: three muscles are too few to compare');
  assert.ok(find(vol([4, 4, 4, 3], { first: 28 }), 'muscle-volume', { layout: L4 }), 'muscle-volume: 28 days is enough');
  assert.equal(find(vol([4, 4, 4, 3], { first: 27 }), 'muscle-volume', { layout: L4 }), undefined,
    'muscle-volume: 27 days of history is too short');
}

// 5 rest — ≥ 10 gaps over the last 5 stamped workouts, median < 90 s
{
  const restW = (n, gap, count = 3) => {
    const t0 = day(n);
    return W(t0, [E('m1', Array.from({ length: count }, (_, j) => S(10, 40, { at: t0 + 300e3 + j * gap * 1000 })))]);
  };
  const five = (gap, lastCount = 3) => [12, 10, 8, 6].map((n) => restW(n, gap)).concat(restW(4, gap, lastCount));
  const r = find(five(89), 'rest');
  assert.equal(r?.text, 'Median 89 s between sets (incl. the set).');
  assert.equal(r.source, 'pmc11349676');
  assert.equal(find(five(90), 'rest'), undefined, 'rest: a 90 s median is long enough');
  assert.equal(find(five(89, 2), 'rest'), undefined, 'rest: 9 gaps are too few');
  assert.equal(find([restW(14, 89), ...five(89, 2)], 'rest'), undefined,
    'rest: only the last 5 stamped workouts count');
}

// 6 route — the same backtrack in ≥ 3 of the last 8 workouts with a path
{
  const BT = ['m1', 'm2', 'm3', 'm1'];
  const CLEAN = ['m1', 'm2', 'm3'];
  const walk = (n, order, name = 'Pull day') => {
    const t0 = day(n);
    const by = new Map();
    order.forEach((id, k) => {
      if (!by.has(id)) by.set(id, []);
      // load rises with recency: a new best every time, so no plateau on
      // m1 can claim the machine and hide the route insight
      by.get(id).push(S(10, 100 - n, { at: t0 + (k + 1) * 120e3 }));
    });
    return W(t0, [...by].map(([id, s]) => E(id, s)), name ? { name } : {});
  };
  const rt = find([walk(9, BT), walk(6, BT), walk(3, BT)], 'route');
  assert.equal(rt?.text, 'Pull day: back to #1 after #3 in 3 workouts — reorder the plan?');
  assert.equal(rt.machineId, 'm1');
  assert.equal(rt.source, 'own');
  assert.equal(find([walk(9, BT), walk(6, BT), walk(3, CLEAN)], 'route'), undefined, 'route: 2 workouts are one short');
  assert.equal(find([walk(9, BT, null), walk(6, BT, null), walk(3, BT, null)], 'route')?.text,
    'Back to #1 after #3 in 3 workouts — reorder the plan?', 'route: no name, no prefix');
  const old = [30, 28, 26].map((n) => walk(n, BT));
  const recent = [20, 18, 16, 14, 12, 10, 8, 6].map((n) => walk(n, CLEAN));
  assert.equal(find([...old, ...recent], 'route'), undefined, 'route: only the last 8 paths count');
}

// 7 busy — ≥ 3 busy marks on one machine, same weekday, within 2 h, within 8 weeks
{
  // the busy mark sits on the visit to the machine used INSTEAD (m3);
  // `busy` names the machine that was taken (m8)
  const busyW = (t, busy = 'm8') => W(t - 600e3, [E('m1', [S(10, 40)]), E('m3', [S(10, 40)])], {
    visits: [
      { machineId: 'm1', in: t - 600e3, out: t - 60e3 },
      { machineId: 'm3', in: t, out: t + 500e3, ...(busy ? { busy } : {}) },
    ],
  });
  const mon = (n, hh, mm) => busyW(day(n, hh, mm)); // day(16|9|2) = Mondays 19 Oct (CEST), 26 Oct, 2 Nov
  const b = find([mon(16, 17, 10), mon(9, 17, 40), mon(2, 18, 30)], 'busy');
  assert.equal(b?.text, '#8 Pec deck busy 3× on Mondays 17–19 h.');
  assert.equal(b.machineId, 'm8');
  assert.equal(b.source, 'own');
  assert.equal(find([mon(16, 17, 10), mon(9, 17, 40), busyW(day(2, 18, 30), null)], 'busy'), undefined,
    'busy: 2 marks are one short');
  assert.equal(find([mon(16, 17, 10), mon(9, 17, 40), mon(2, 19, 10)], 'busy')?.text,
    '#8 Pec deck busy 3× on Mondays 17–20 h.', 'busy: a span of exactly 2 h still counts');
  assert.equal(find([mon(16, 17, 10), mon(9, 17, 40), mon(2, 19, 11)], 'busy'), undefined,
    'busy: 2 h 1 min is too wide');
  assert.equal(find([mon(16, 17, 10), mon(9, 17, 40), busyW(day(1, 18, 30))], 'busy'), undefined,
    'busy: a Tuesday is another weekday');
  assert.equal(find([mon(58, 17, 10), mon(9, 17, 40), mon(2, 18, 30)], 'busy'), undefined,
    'busy: a mark older than 8 weeks does not count');
}

// 8 plateau — ≥ 8 e1RM sessions, the best older than the last 6, trained in the last 21 d
{
  // 60 × 8 → 76 e1RM (the best), 60 × 7 → 74; one session every 3 days
  const plat = (reps, last = 2) => reps.map((r, i) => W(day(last + (reps.length - 1 - i) * 3), [E('m1', [S(r, 60)])]));
  const p = find(plat([7, 8, 7, 7, 7, 7, 7, 7]), 'plateau');
  assert.equal(p?.text, '#1 Chest press: no new best in 6 workouts (76 kg e1RM).');
  assert.equal(p.machineId, 'm1');
  assert.equal(p.source, 'pmc11435939');
  assert.equal(find(plat([8, 7, 7, 7, 7, 7, 7]), 'plateau'), undefined, 'plateau: 7 sessions are one short');
  assert.equal(find(plat([7, 7, 8, 7, 7, 7, 7, 7]), 'plateau'), undefined, 'plateau: a best inside the last 6 is recent');
  assert.ok(find(plat([7, 8, 7, 7, 7, 7, 7, 7], 20), 'plateau'), 'plateau: trained 20 days ago still counts');
  assert.equal(find(plat([7, 8, 7, 7, 7, 7, 7, 7], 21), 'plateau'), undefined, 'plateau: 21 days ago is dropped');
}

// --- ranking ---
{
  // three machines beat 12 by 2 at the same load: equal scores, so the
  // text decides, and progress stops at two
  const trio = [9, 5, 1].map((n) => W(day(n), [E('m1', [S(14, 40)]), E('m2', [S(14, 40)]), E('m3', [S(14, 40)])]));
  const ranked = stats.insights(trio, LAYOUT, KG, { now: NOW });
  seen.push(...ranked);
  assert.deepEqual(ranked.map((i) => i.text), [
    '#1 Chest press: 14 × 40 kg twice — try 42.5 kg.',
    '#2 Lat pulldown: 14 × 40 kg twice — try 42.5 kg.',
  ], 'progress: at most two, ties broken on the text');
  assert.equal(stats.insights(trio, LAYOUT, KG, { now: NOW, max: 1 }).length, 1, 'max is honoured');
  assert.deepEqual(stats.insights(trio.slice(1), LAYOUT, KG, { now: NOW }), [], 'fewer than 3 workouts: nothing');

  // one machine, two findings: progress (50) outranks plateau (40) on the
  // same machine, and plateau shows once progress no longer fires
  const both = [100, ...Array(7).fill(60)].map((kg, i) => W(day(23 - i * 3), [E('m1', [S(kg === 100 ? 8 : 10, kg)])]));
  const plan = [{ id: 'p', items: [{ machineId: 'm1', exercise: null, target: { sets: 3, reps: 8, weight: 60 } }] }];
  const withPlan = stats.insights(both, LAYOUT, KG, { now: NOW, plans: plan, max: 20 });
  const noPlan = stats.insights(both, LAYOUT, KG, { now: NOW, max: 20 });
  seen.push(...withPlan, ...noPlan);
  assert.deepEqual(withPlan.filter((i) => i.machineId === 'm1').map((i) => i.kind), ['progress'],
    'one insight per machine');
  assert.deepEqual(noPlan.filter((i) => i.machineId === 'm1').map((i) => i.kind), ['plateau'],
    'the plateau is real — only the per-machine rule hid it');
}

// --- shape of every insight produced above ---
{
  const WEIGHT = {
    progress: 50, plateau: 40, busy: 35, 'muscle-gap': 30, route: 30,
    frequency: 25, rest: 20, 'muscle-volume': 15,
  };
  assert.deepEqual(new Set(seen.map((i) => i.kind)), new Set(Object.keys(WEIGHT)), 'every rule was exercised');
  seen.forEach((i) => {
    const mag = i.score - WEIGHT[i.kind];
    assert.ok(mag >= 0 && mag <= 9 && Number.isInteger(mag), `${i.kind}: magnitude ${mag} within 0–9`);
    assert.ok(stats.SOURCES[i.source], `${i.kind}: source ${i.source} is a SOURCES key`);
    assert.match(i.why, /^[A-Z].*\.$/, `${i.kind}: why is one sentence`);
  });
  for (const key of ['who2020', 'acsm2009', 'garber2011', 'schoenfeld2016', 'schoenfeld2017',
    'pelland2025', 'pmc11435939', 'pmc11349676', 'detraining']) {
    assert.match(stats.SOURCES[key]?.url ?? '', /^https:\/\//, `SOURCES.${key} links its evidence`);
    assert.ok(stats.SOURCES[key].label, `SOURCES.${key} has a label`);
  }
}

console.log('stats.test.mjs: all passed');
