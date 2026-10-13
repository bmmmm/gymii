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
  // with a layout, a deleted machine drops out BEFORE collapsing — the
  // weighted map then counts the same legs workoutPath draws
  const viaGone = W(T0, [], { visits: [
    { machineId: 'm2', in: stamp(0), out: stamp(100) },
    { machineId: 'gone', in: stamp(110), out: stamp(200) },
    { machineId: 'm3', in: stamp(210), out: stamp(300) },
  ] });
  assert.deepEqual([...stats.transitionCounts([viaGone], LAYOUT).keys()], ['m2>m3'],
    'transitionCounts with a layout skips machines missing from it');
  assert.deepEqual([...stats.transitionCounts([viaGone]).keys()], ['m2>gone', 'gone>m3'],
    'without a layout every stop counts');
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
  const out = stats.insights(ws, layout, settings, { now: NOW, plans });
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
  assert.equal(fired?.text, 'Target beaten twice — try 60 kg.');
  assert.equal(fired.source, 'acsm2009');
  assert.equal(fired.machineId, 'm2');
  assert.equal(fired.exercise, null, 'a whole-machine entry carries exercise null (the log screen matches on it)');
  assert.equal(find(prog(14, 13), 'progress'), undefined, 'progress: 13 reps is one short of T+2');
  const aged = (n) => prog(14, 14).map((w) => ({ ...w, startedAt: w.startedAt - n * 864e5, finishedAt: w.finishedAt - n * 864e5 }));
  assert.ok(find(aged(19), 'progress'), 'progress: a last session 20 days ago still counts');
  assert.equal(find(aged(20), 'progress'), undefined, 'progress: a machine not trained for 21 days is not due for more load');
  assert.equal(find(prog(12, 12, { rir2: 2, rir3: 2 }), 'progress')?.text,
    'Target beaten twice — try 60 kg.', 'progress: reps ≥ T with rir 2');
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
    'Target beaten twice — add 1–2 reps first.', 'progress: a step over 10 % of W');
  assert.equal(find(prog(14, 14, { machine: 'm3', w: 25, w2: 25 }), 'progress')?.text,
    'Target beaten twice — try 27.5 kg.', 'progress: a step of exactly 10 % is fine');
  assert.equal(find(prog(14, 14), 'progress', { settings: { unit: 'lbs', weightStep: 5 } })?.text,
    'Target beaten twice — try 62.5 lbs.', 'progress: unit and step from settings');
}

// 2 frequency — ≥ 28 days of history, < 2 strength days/week over 4 full weeks
{
  // first workout Sun 4 Oct (before the oldest full week), then full weeks:
  // Oct 5 (2 days), Oct 12 (2), Oct 19 (2), Oct 26 (1) = 7 → 1.75
  const freq = (first, extra = []) => [first, 27, 26, 22, 20, 15, 13, 8, ...extra]
    .map((n) => W(day(n), [E('m1', [S(10, 40)])]));
  assert.equal(find(freq(31), 'frequency')?.text, 'Aim for 2 strength days a week — 1.75 over the last 4 weeks.');
  assert.equal(find(freq(31), 'frequency').source, 'who2020');
  assert.equal(find(freq(31, [6]), 'frequency'), undefined, 'frequency: a mean of exactly 2 is enough');
  assert.equal(find(freq(27), 'frequency'), undefined, 'frequency: 27 days of history is too short');
  // first workout on Mon 5 Oct 18:00 — inside the oldest week, which would
  // otherwise read as a low week (1.75 without the guard)
  const partial = [30, 26, 22, 20, 15, 13, 8].map((n) => W(day(n), [E('m1', [S(10, 40)])]));
  assert.equal(find(partial, 'frequency'), undefined, 'frequency: a first workout inside the oldest week leaves it partial');
  const covered = [31, 26, 22, 20, 15, 13, 8].map((n) => W(day(n), [E('m1', [S(10, 40)])]));
  assert.equal(find(covered, 'frequency')?.text, 'Aim for 2 strength days a week — 1.5 over the last 4 weeks.',
    'frequency: a first workout before the oldest week makes it full');
}

// 3 muscle-gap — trained in the last 42 d, not in the last 10, ≥ 2 workouts in those 10
{
  const gap = (back, recent = [5, 2]) => [
    W(day(back), [E('m4', [S(10, 30)])]),
    ...recent.map((n) => W(day(n), [E('m1', [S(10, 40)])])),
  ];
  const g = find(gap(10), 'muscle-gap');
  assert.equal(g?.text, 'Train it this week — last trained 10 days ago.');
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
  assert.equal(v?.text, 'Add a set or two — 3.8 sets/week, your median muscle gets 8.',
    'muscle-volume fires — and the treadmill does not count as calf sets');
  assert.equal(v.muscle, 'Calves');
  assert.equal(v.source, 'schoenfeld2017');
  const L5 = { ...L4, machines: [...L4.machines, M('ve', 6, 'E', 32, 2, ['Abs'])] };
  assert.equal(find(vol([4, 4, 4, 3]), 'muscle-volume', { layout: L5 })?.muscle, 'Calves',
    'muscle-volume: a muscle nobody trains is untrained, not low volume');
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
  assert.equal(r?.text, 'Hold 90 s — your median is 89 s (incl. the set).');
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
  assert.equal(rt?.text, 'Reorder — back to #1 after #3 in 3 workouts.');
  assert.equal(rt.machineId, 'm1');
  assert.equal(rt.source, 'own');
  assert.equal(rt.workout, 'Pull day', 'the plan builder of that name shows it');
  assert.equal(find([walk(9, BT), walk(6, BT), walk(3, CLEAN)], 'route'), undefined, 'route: 2 workouts are one short');
  assert.equal(find([walk(9, BT, null), walk(6, BT, null), walk(3, BT, null)], 'route')?.workout,
    null, 'route: nameless workouts belong to no plan');
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
  assert.equal(b?.text, 'Usually busy Mondays 17–19 h — start elsewhere.');
  assert.equal(b.machineId, 'm8');
  assert.equal(b.weekday, 1, 'Monday, for the log screen to show it on Mondays only');
  assert.deepEqual([b.h0, b.h1], [17, 19], 'and the window it names, for the log screen to show it around then only');
  assert.equal(b.source, 'own');
  assert.equal(find([mon(16, 17, 10), mon(9, 17, 40), busyW(day(2, 18, 30), null)], 'busy'), undefined,
    'busy: 2 marks are one short');
  const t3 = day(2, 18, 30);
  const threeHops = W(t3 - 600e3, [E('m1', [S(10, 40)]), E('m3', [S(10, 40)])], { visits: [
    { machineId: 'm1', in: t3 - 600e3, out: t3 - 60e3 },
    { machineId: 'm3', in: t3, out: t3 + 100e3, busy: 'm8' },
    { machineId: 'm1', in: t3 + 110e3, out: t3 + 200e3, busy: 'm8' },
    { machineId: 'm3', in: t3 + 210e3, out: t3 + 500e3, busy: 'm8' },
  ] });
  assert.equal(find([mon(16, 17, 10), threeHops, busyW(day(9, 18, 0), null)], 'busy'), undefined,
    'busy: three hops in one evening are one mark, not a weekday pattern');
  assert.equal(find([mon(16, 17, 10), mon(9, 17, 40), mon(2, 19, 10)], 'busy')?.text,
    'Usually busy Mondays 17–20 h — start elsewhere.', 'busy: a span of exactly 2 h still counts');
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
  assert.equal(p?.text, 'No new best in 6 workouts (76 kg e1RM) — vary reps or load.');
  assert.equal(p.machineId, 'm1');
  assert.equal(p.exercise, null);
  assert.equal(p.source, 'pmc11435939');
  const named = plat([7, 8, 7, 7, 7, 7, 7, 7]).map((w) => ({ ...w, entries: w.entries.map((e) => ({ ...e, exercise: 'Incline' })) }));
  assert.equal(find(named, 'plateau')?.exercise, 'Incline', 'plateau names its exercise — the chart of that exercise shows it');
  assert.equal(find(plat([8, 7, 7, 7, 7, 7, 7]), 'plateau'), undefined, 'plateau: 7 sessions are one short');
  assert.equal(find(plat([7, 7, 8, 7, 7, 7, 7, 7]), 'plateau'), undefined, 'plateau: a best inside the last 6 is recent');
  assert.ok(find(plat([7, 8, 7, 7, 7, 7, 7, 7], 20), 'plateau'), 'plateau: trained 20 days ago still counts');
  assert.equal(find(plat([7, 8, 7, 7, 7, 7, 7, 7], 21), 'plateau'), undefined, 'plateau: 21 days ago is dropped');
}

// --- order: everything that fires, by weight then text — no cap ---
{
  // three machines beat 12 by 2 at the same load: equal scores, so the
  // text decides, and all three come back — each log screen shows its own
  const trio = [9, 5, 1].map((n) => W(day(n), [E('m1', [S(14, 40)]), E('m2', [S(14, 40)]), E('m3', [S(14, 40)])]));
  const ranked = stats.insights(trio, LAYOUT, KG, { now: NOW });
  seen.push(...ranked);
  assert.deepEqual(ranked.map((i) => [i.kind, i.machineId]),
    [['progress', 'm1'], ['progress', 'm2'], ['progress', 'm3']], 'no cap: a third machine is not silenced');
  assert.deepEqual(stats.insights(trio.slice(1), LAYOUT, KG, { now: NOW }), [], 'fewer than 3 workouts: nothing');

  // memoised on the serialised input: a fresh copy of the same data (what
  // every render's getWorkouts() hands over) is answered from the memo…
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const first = stats.insights(trio, LAYOUT, KG, { now: NOW });
  assert.strictEqual(stats.insights(copy(trio), copy(LAYOUT), { ...KG }, { now: NOW + 3600e3 }), first,
    'same workouts, layout, settings, plans and day: the remembered answer');
  assert.ok(Object.isFrozen(first) && first.every(Object.isFrozen),
    'and frozen: one caller sorting or editing it in place cannot corrupt the next one\'s');
  // …and every input it reads makes a fresh one
  const fresh = [
    ['a new workout', () => stats.insights([...trio, W(day(0), [E('m1', [S(5, 20)])])], LAYOUT, KG, { now: NOW })],
    ['an edited set', () => stats.insights([...trio.slice(0, 2), W(trio[2].startedAt, [E('m1', [S(13, 40)])])], LAYOUT, KG, { now: NOW })],
    ['another layout', () => stats.insights(trio, { ...LAYOUT, machines: LAYOUT.machines.slice(1) }, KG, { now: NOW })],
    ['another unit', () => stats.insights(trio, LAYOUT, { ...KG, unit: 'lbs' }, { now: NOW })],
    ['another weight step', () => stats.insights(trio, LAYOUT, { ...KG, weightStep: 5 }, { now: NOW })],
    ['other plans', () => stats.insights(trio, LAYOUT, KG, { now: NOW, plans: [{ id: 'x', items: [] }] })],
    ['the next day', () => stats.insights(trio, LAYOUT, KG, { now: NOW + 864e5 })],
  ];
  for (const [what, ask] of fresh) {
    const held = stats.insights(trio, LAYOUT, KG, { now: NOW }); // the memo holds this question again
    assert.notStrictEqual(ask(), held, `${what}: a fresh answer`);
  }

  // one machine, two findings: progress (50) sorts before plateau (40),
  // and both come back — they sit on different screens
  const both = [100, ...Array(7).fill(60)].map((kg, i) => W(day(23 - i * 3), [E('m1', [S(kg === 100 ? 8 : 10, kg)])]));
  const plan = [{ id: 'p', items: [{ machineId: 'm1', exercise: null, target: { sets: 3, reps: 8, weight: 60 } }] }];
  const withPlan = stats.insights(both, LAYOUT, KG, { now: NOW, plans: plan });
  seen.push(...withPlan);
  assert.deepEqual(withPlan.filter((i) => i.machineId === 'm1').map((i) => i.kind), ['progress', 'plateau'],
    'progress first, the plateau stays visible under its chart');
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
    assert.match(i.text, /^[A-Z][^:]*\.$/, `${i.kind}: an instruction, one sentence, no "Machine:" prefix — the screen names the subject`);
    assert.equal('why' in i, false, `${i.kind}: no explainer, the ↗ is the detail`);
  });
  for (const key of ['who2020', 'acsm2009', 'garber2011', 'schoenfeld2016', 'schoenfeld2017',
    'pelland2025', 'pmc11435939', 'pmc11349676', 'detraining']) {
    assert.match(stats.SOURCES[key]?.url ?? '', /^https:\/\//, `SOURCES.${key} links its evidence`);
    assert.ok(stats.SOURCES[key].label, `SOURCES.${key} has a label`);
  }
}

// --- grips: one series per (machine, exercise, grip) ---
{
  const rope = { exercise: 'Pushdown', grip: 'Rope' };
  const vbar = { exercise: 'Pushdown', grip: 'V-bar' };
  const ws = [
    W(day(9), [E('m2', [S(12, 20)], rope), E('m2', [S(10, 30)], vbar)]),
    W(day(5), [E('m2', [S(12, 22.5)], rope)]),
    W(day(1), [E('m2', [S(10, 32.5)], vbar), E('m2', [S(8, 40)], { exercise: 'Pushdown' })]),
  ];
  assert.deepEqual(stats.machineSeries(ws, 'm2', 'Pushdown', 'Rope').map((p) => p.top.weight), [20, 22.5],
    'the rope series holds only rope sets');
  assert.deepEqual(stats.machineSeries(ws, 'm2', 'Pushdown', 'V-bar').map((p) => p.top.weight), [30, 32.5],
    'the V-bar series only V-bar sets');
  assert.deepEqual(stats.machineSeries(ws, 'm2', 'Pushdown').map((p) => p.top.weight), [40],
    'a gripless series is the entries without a grip — old data reads as it did');
  assert.equal(stats.seriesKey({ machineId: 'm2', exercise: 'Pushdown', grip: 'Rope' }), '["m2","Pushdown","Rope"]');
  assert.equal(stats.seriesKey({ machineId: 'm2' }), '["m2",null,null]', 'absent parts are null');
  const sel = { machineId: 'm2', exercise: 'Pushdown', grip: 'Rope' };
  assert.ok(stats.sameSeries({ machineId: 'm2', exercise: 'Pushdown', grip: 'Rope' }, sel));
  assert.ok(!stats.sameSeries({ machineId: 'm3', exercise: 'Pushdown', grip: 'Rope' }, sel), 'machine differs');
  assert.ok(!stats.sameSeries({ machineId: 'm2', exercise: 'Kickback', grip: 'Rope' }, sel), 'exercise differs');
  assert.ok(!stats.sameSeries({ machineId: 'm2', exercise: 'Pushdown', grip: 'V-bar' }, sel), 'grip differs');
  assert.ok(!stats.sameSeries({ machineId: 'm2', exercise: 'Pushdown' }, sel), 'no grip is not Rope');
  assert.ok(stats.sameSeries({ machineId: 'm2' }, { machineId: 'm2', exercise: null, grip: null }),
    'absent and null are one');

  // the progress hint is about ONE grip, and says which
  const prog = [
    W(day(9), [E('m2', [S(10, 55)], rope)]),
    W(day(5), [E('m2', [S(10, 57.5), S(14, 57.5)], rope), E('m2', [S(14, 57.5)], vbar)]),
    W(day(1), [E('m2', [S(10, 57.5), S(14, 57.5)], rope)]),
  ];
  const hits = stats.insights(prog, null, KG, { now: NOW }).filter((i) => i.kind === 'progress');
  assert.deepEqual(hits.map((h) => h.grip), ['Rope'], 'one hint, on the rope series — the V-bar was beaten once');
  const plan = [{ id: 'p', name: 'Arms', items: [
    { machineId: 'm2', exercise: 'Pushdown', grip: 'V-bar', target: { sets: 3, reps: 15, weight: 57.5 } }] }];
  assert.equal(stats.insights(prog, null, KG, { now: NOW, plans: plan }).filter((i) => i.kind === 'progress').length, 1,
    'a plan target for the V-bar does not raise the rope\'s bar');
  const anyGrip = [{ id: 'p', name: 'Arms', items: [
    { machineId: 'm2', exercise: 'Pushdown', target: { sets: 3, reps: 15, weight: 57.5 } }] }];
  assert.equal(stats.insights(prog, null, KG, { now: NOW, plans: anyGrip }).filter((i) => i.kind === 'progress').length, 0,
    'a gripless plan item targets every grip: 14 reps no longer beat 15');
  const ropePlan = [{ id: 'p', name: 'Arms', items: [
    { machineId: 'm2', exercise: 'Pushdown', grip: 'Rope', target: { sets: 3, reps: 15, weight: 57.5 } }] }];
  assert.equal(stats.insights(prog, null, KG, { now: NOW, plans: ropePlan }).filter((i) => i.kind === 'progress').length, 0,
    'a rope plan item sets the rope\'s target');
}

// --- assisted machines: the weight is the ASSIST, less is stronger ---
{
  const MA = (goal) => M('ma', 17, 'Assisted pull-up', 50, 30, ['Lats'], { assisted: true, ...(goal ? { assistGoal: goal } : {}) });
  const LA = (goal) => ({ ...LAYOUT, machines: [...LAYOUT.machines, MA(goal)] });
  const A = (sts) => E('ma', sts, { assisted: true });
  // the top set is the least assist, then the most reps; no e1RM, no volume
  const one = stats.machineSeries([W(day(3), [A([S(8, 30), S(10, 25), S(6, 25)])])], 'ma');
  assert.deepEqual([one[0].kind, one[0].top, one[0].e1rm, one[0].volume], ['assisted', { weight: 25, reps: 10 }, null, 0],
    'assisted top set: 25 kg assist × 10, the least help');
  const wk = stats.weeklyBuckets([W(day(0), [A([S(10, 30)]), E('m1', [S(10, 40)])])], { weeks: 1, now: NOW });
  assert.equal(wk[0].volume, 400, 'an assisted set adds no volume — its weight is help, not load');
  assert.equal(wk[0].sets, 2, 'but it is a set');

  // the goal: said > observed trend > rep range (12+ is endurance)
  const pts = (pairs) => pairs.map(([w, r], i) => ({ kind: 'assisted', t: i, top: { weight: w, reps: r } }));
  assert.deepEqual(stats.assistGoal({ assistGoal: 'endurance' }, pts([[30, 8], [25, 8]])),
    { goal: 'endurance', observed: false, basis: 'said' }, 'what the user said wins over the trend');
  assert.deepEqual(stats.assistGoal({}, pts([[30, 8], [27.5, 8]])), { goal: 'strength', observed: true, basis: 'trend' },
    'the assist went down: strength');
  assert.deepEqual(stats.assistGoal({}, pts([[30, 8], [30, 11]])), { goal: 'endurance', observed: true, basis: 'trend' },
    'the reps went up at the same assist: endurance');
  assert.deepEqual(stats.assistGoal({}, pts([[30, 12]])).goal, 'endurance', 'no trend, 12 reps: endurance');
  assert.deepEqual(stats.assistGoal({}, pts([[30, 11]])).goal, 'strength', 'no trend, 11 reps: strength');
  assert.deepEqual(stats.assistGoal({}, pts([[30, 8], [30, 8]]), 12).goal, 'endurance', 'a plan target of 12 decides a flat trend');
  assert.deepEqual(stats.assistGoal({ assistGoal: 'bogus' }, pts([[30, 8], [25, 8]])).observed, true, 'an unknown goal is no goal');
  assert.deepEqual(stats.assistGoal({}, []), { goal: 'strength', observed: true, basis: 'none' },
    'no history, no target: strength — and it says it read nothing');
  assert.equal(stats.assistGoal({}, pts([[30, 12]])).basis, 'reps', 'one workout: going by the reps');

  // rule 1 at the same assist: the next step follows the goal
  const prog = (r2, r3, w = 25) => [W(day(9), [A([S(10, 30)])]), W(day(5), [A([S(r2, w)])]), W(day(1), [A([S(r3, w)])])];
  assert.equal(find(prog(14, 14), 'progress', { layout: LA('strength') })?.text,
    'Target beaten twice — try 2.5 kg less assist.', 'strength: less assist');
  assert.equal(find(prog(14, 14), 'progress', { layout: LA('endurance') })?.text,
    'Target beaten twice — add 2 reps at this assist.', 'endurance: more reps at this assist');
  assert.equal(find(prog(14, 13), 'progress', { layout: LA('strength') }), undefined, 'one rep short of T + 2: quiet');
  assert.equal(find(prog(14, 14, 2), 'progress', { layout: LA('strength') })?.text,
    'Target beaten twice — try 2 kg less assist.', 'never more off than the assist that is left');
  assert.equal(find(prog(14, 14, 0), 'progress', { layout: LA('strength') }), undefined,
    'unassisted (0 kg): no assist left to take away');
  assert.equal(find(prog(14, 14), 'progress', { layout: LA() })?.text,
    'Target beaten twice — try 2.5 kg less assist.', 'no goal said: the trend (30 → 25 kg) says strength');

  // rule 8, assisted: the record is the least assist (strength) or the most reps (endurance)
  const series8 = (vals, goalReps = false) => vals.map((v, i) => W(day(40 - 5 * i),
    [A([goalReps ? S(v, 25) : S(8, v)])]));
  assert.equal(find(series8([30, 25, 25, 25, 25, 25, 25, 25]), 'plateau', { layout: LA('strength') })?.text,
    'No new low in 6 workouts (25 kg assist) — vary reps or assist.', 'strength: no new low in six');
  assert.equal(find(series8([30, 25, 25, 25, 25, 25, 25, 22.5]), 'plateau', { layout: LA('strength') }), undefined,
    'a new low in the last six: no plateau');
  assert.equal(find(series8([8, 12, 12, 12, 12, 12, 12, 12], true), 'plateau', { layout: LA('endurance') })?.text,
    'No new rep best in 6 workouts (12 reps) — vary assist or reps.', 'endurance: no new rep best in six');
  assert.equal(find(series8([8, 12, 12, 12, 12, 12, 12, 13], true), 'plateau', { layout: LA('endurance') }), undefined,
    'a new rep best: no plateau');
  assert.equal(find(series8([25, 30, 30, 30, 30, 30, 30]), 'plateau', { layout: LA('strength') }), undefined,
    'seven workouts without a new low: one short of the eight it needs');
  assert.equal(find(series8([30, 0, 0, 0, 0, 0, 0, 0, 0]), 'plateau', { layout: LA('strength') }), undefined,
    'unassisted already: no lower to reach, no plateau');
  // one goal for every rule and screen: a plan target of 8 says strength even
  // where the reps (12) alone would say endurance
  const planned = [{ id: 'pp', items: [{ machineId: 'ma', exercise: null, target: { sets: 3, reps: 8, weight: 25 } }] }];
  const reps12 = [W(day(9), [A([S(12, 25)])]), W(day(5), [A([S(12, 25)])], { planId: 'pp' })];
  assert.equal(stats.assistGoalAt(reps12, LA(), planned, { machineId: 'ma' }).goal, 'strength', 'the plan target decides');
  assert.equal(stats.assistGoalAt(reps12, LA(), [], { machineId: 'ma' }).goal, 'endurance', 'without it, 12 reps do');
}

// --- secondary muscles: half a set each, and never "trained" for the gap rule ---
{
  const PM = (id, num, muscles, secondaryMuscles) => M(id, num, `M${num}`, 2 + num * 6, 2, muscles,
    secondaryMuscles ? { secondaryMuscles } : {});
  const L2 = { ...LAYOUT, machines: [PM('p1', 1, ['Chest'], ['Triceps']), PM('p2', 2, ['Triceps'])] };
  const wk = stats.weeklyBuckets([W(day(0), [E('p1', sets(4))])], { weeks: 1, now: NOW, layout: L2 });
  assert.deepEqual([wk[0].muscles.get('Chest'), wk[0].muscles.get('Triceps')], [4, 2],
    'four chest-press sets: 4 for the chest, 2 for the triceps');
  assert.ok(stats.muscleWeekly([], L2, { weeks: 1, now: NOW }).has('Triceps'), 'a secondary muscle is listed');
  // the gap rule: a chest press yesterday does not count as triceps training
  const gap = [W(day(12), [E('p2', sets(3))]), W(day(3), [E('p1', sets(3))]), W(day(1), [E('p1', sets(3))])];
  const g = find(gap, 'muscle-gap', { layout: L2 });
  assert.equal(g?.muscle, 'Triceps', 'the triceps was last trained (as PRIMARY) 12 days ago');
  assert.equal(g?.text, 'Train it this week — last trained 12 days ago.');
  // the volume rule at its threshold: X only ever secondary
  const L5 = { ...LAYOUT, machines: [PM('a', 1, ['A']), PM('b', 2, ['B']), PM('c', 3, ['C']), PM('d', 4, ['D']), PM('f', 5, [], ['X'])] };
  const weeks = (fSets) => [9, 16, 23, 30].map((n) => W(day(n),
    [E('a', sets(4)), E('b', sets(4)), E('c', sets(4)), E('d', sets(4)), E('f', sets(fSets))]));
  assert.equal(find(weeks(3), 'muscle-volume', { layout: L5 })?.text,
    'Add a set or two — 1.5 sets/week, your median muscle gets 4.', 'three secondary sets a week are 1.5: under half of 4');
  assert.equal(find(weeks(4), 'muscle-volume', { layout: L5 }), undefined, 'four are 2: exactly half, quiet');
}

// --- walkLength: A* on the floor, around walls and machines ---
{
  const box = (id, x, y, w = 2, h = 2) => ({ id, num: 1, label: id, x, y, w, h, settingsFields: [] });
  const floor = (machines, shapes = [], outline = []) => ({ grid: { w: 20, h: 10 }, outline, machines, shapes });
  const a = box('a', 1, 4);
  const b = box('b', 15, 4);
  const open = stats.walkLength(floor([a, b]), a, b);
  assert.equal(open, 14, 'open floor: the straight line, centre to centre');
  const wall = { id: 'w', kind: 'line', x: 10, y: 0, w: 0, h: 8 };
  const around = stats.walkLength(floor([a, b], [wall]), a, b);
  assert.ok(around > open + 2, `a wall in between is walked around (${around.toFixed(1)} > 14)`);
  const block = box('c', 6, -1, 2, 12); // a machine across the whole floor
  assert.equal(stats.walkLength(floor([a, b, block]), a, b), null, 'no way through: null');
  const thin = box('t', 6, -1, 1, 12); // one unit thin: every node beside it is free, the step across is not
  assert.equal(stats.walkLength(floor([a, b, thin]), a, b), null, 'no stepping through a thin machine');
  const offGrid = { id: 'w2', kind: 'line', x: 10.5, y: 0, w: 0, h: 8 }; // between the grid points
  assert.ok(stats.walkLength(floor([a, b], [offGrid]), a, b) > open + 2, 'a wall between the grid points is no gap');
  const slanted = { id: 'w3', kind: 'line', x: 10.3, y: 0, w: 0.5, h: 8 }; // crosses steps between the half-grid points
  assert.ok(stats.walkLength(floor([a, b], [slanted]), a, b) > open + 2, 'a slanted wall is walked around too');
  // a machine flush against a wall is not reached from the wall's other side
  {
    const two = (shapes) => ({ grid: { w: 20, h: 20 }, outline: [], shapes,
      machines: [box('F', 5, 6), box('T', 5, 10)] }); // F above the partition y=10, T flush below it
    const partition = { id: 'p', kind: 'line', x: 0, y: 10, w: 20, h: 0 };
    const F = box('F', 5, 6);
    const T = box('T', 5, 10);
    assert.equal(stats.walkLength(two([partition]), F, T), null, 'no door anywhere: unreachable, not "4 away"');
    const above = box('A', 5, 8); // flush ABOVE the partition, walked to from below
    const below = box('B', 5, 12);
    assert.equal(stats.walkLength({ grid: { w: 20, h: 20 }, outline: [], shapes: [partition], machines: [above, below] },
      below, above), null, 'nor from the other side');
    const farDoor = { id: 'fd', kind: 'fixture', fixture: 'door', x: 16.8, y: 9.4, w: 2.4, h: 1.2 };
    const viaDoor = stats.walkLength(two([partition, farDoor]), F, T);
    assert.ok(viaDoor > 15, `through the door at the far end: the long way (${viaDoor?.toFixed(1)})`);
    const mirror = { id: 'mi', kind: 'fixture', fixture: 'mirror', x: 3, y: 8.5, w: 6, h: 1 };
    const shortcut = stats.walkLength({ grid: { w: 20, h: 20 }, outline: [], shapes: [mirror],
      machines: [box('F', 5, 6), box('T', 5, 9.5)] }, F, { ...T, y: 9.5 });
    assert.ok(shortcut > 5, `a mirror flush against it is walked around (${shortcut?.toFixed(1)})`);
    // the two checks of the last step, one at a time: a wall between the
    // half-grid points, and a solid too thin to block the ring point itself
    const offGridWall = { id: 'p2', kind: 'line', x: -1, y: 10.2, w: 22, h: 0 }; // past both edges: no way round its ends
    const T2 = { ...T, y: 10.2 };
    assert.equal(stats.walkLength({ grid: { w: 20, h: 20 }, outline: [], shapes: [offGridWall], machines: [F, T2] }, F, T2),
      null, 'a wall off the half grid: not reached through it');
    const thin = { id: 'th', kind: 'fixture', fixture: 'mirror', x: 3, y: 9.25, w: 6, h: 0.5 };
    const around = stats.walkLength({ grid: { w: 20, h: 20 }, outline: [], shapes: [thin], machines: [F, T] }, F, T);
    assert.ok(around > 5, `a thin mirror in front of it: reached from the side (${around?.toFixed(1)})`);
    // the outline is no wall segment: a slit of it between the two is read off the raster
    const slit = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
      { x: 0, y: 9.6 }, { x: 15, y: 9.6 }, { x: 15, y: 9.4 }, { x: 0, y: 9.4 }];
    const roundSlit = stats.walkLength({ grid: { w: 20, h: 20 }, outline: slit, shapes: [], machines: [F, T] }, F, T);
    assert.ok(roundSlit > 15, `a slit of the outline in front of it: walked round its end (${roundSlit?.toFixed(1)})`);
    // only the step up to the target's box counts: beyond it lies the machine itself
    const cut = { id: 'cw', kind: 'line', x: 0, y: 10.5, w: 20, h: 0 };
    assert.equal(stats.walkLength({ grid: { w: 20, h: 20 }, outline: [], shapes: [cut], machines: [F, T] }, F, T), 4,
      'a wall drawn through a machine: reached from the side it is walked to');
    const T3 = box('T', 5, 10, 2, 3);
    const short = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 11 }, { x: 0, y: 11 }];
    assert.equal(stats.walkLength({ grid: { w: 20, h: 20 }, outline: short, shapes: [], machines: [F, T3] }, F, T3), 4.5,
      'a machine whose centre lies past the outline: reached from the floor');
    const L = box('L', 3, 6);
    const R = box('R', 5, 6);
    assert.equal(stats.walkLength({ grid: { w: 20, h: 20 }, outline: [], shapes: [], machines: [L, R] }, L, R), 2,
      'flush neighbours: the step from inside the start machine is clear');
    const off = box('O', 5.3, 6); // off the grid: the step's last sample rounds into the target itself
    const walked = stats.walkLength({ grid: { w: 20, h: 20 }, outline: [], shapes: [], machines: [box('S', 1, 6), off] },
      box('S', 1, 6), off);
    assert.ok(Math.abs(walked - 4.3) < 1e-9, `the target's own box is no obstacle (${walked})`);
    // a file's machine of absurd size costs no more than its ring on the grid
    const huge = { id: 'H', x: -1e8, y: 12, w: 1e8 + 4, h: 3 };
    const t0 = performance.now();
    stats.walkLength({ grid: { w: 20, h: 20 }, outline: [], shapes: [], machines: [F, huge] }, F, huge);
    assert.ok(performance.now() - t0 < 1000, `a huge machine: no hang (${(performance.now() - t0).toFixed(0)} ms)`);
  }
  // a grid only a file could carry is no floor to walk — never a crash
  assert.equal(stats.walkLength({ grid: { w: -40, h: 30 }, outline: [], shapes: [], machines: [a, b] }, a, b), null,
    'a negative grid: no walk');
  assert.equal(stats.walkableGrid({ grid: { w: 4000, h: 30 } }), false, 'nor a huge one');
  const room = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 10 }, { x: 0, y: 10 }];
  assert.equal(stats.walkLength(floor([a, b], [], room), a, b), null, 'a machine outside the outline: unreachable');
  // machines placed flush (the editor allows edge-to-edge) are a barrier, not a corridor
  assert.equal(stats.walkLength(floor([a, b, box('f1', 6, -1, 2, 6), box('f2', 6, 5, 2, 6)]), a, b), null,
    'two flush machines across the floor: no way along their seam');
  assert.equal(stats.walkLength(floor([a, b, box('c1', 6, -1, 2, 6), box('c2', 8, 5, 2, 6)]), a, b), null,
    'two machines touching at a corner: no squeezing through the corner');
  // a door in an interior wall opens it
  const fullWall = { id: 'fw', kind: 'line', x: 10, y: 0, w: 0, h: 10 };
  assert.equal(stats.walkLength(floor([a, b], [fullWall]), a, b), null, 'a wall across the floor: no way');
  const door = { id: 'dr', kind: 'fixture', fixture: 'door', x: 8.8, y: 4.4, w: 2.4, h: 1.2, rot: 90 };
  const through = stats.walkLength(floor([a, b], [fullWall, door]), a, b);
  assert.ok(through != null && through < open + 1, `a door in it: straight through (${through})`);
  const lockers = { id: 'l', kind: 'fixture', fixture: 'locker', x: 6, y: 3, w: 2, h: 4 };
  assert.ok(stats.walkLength(floor([a, b], [lockers]), a, b) > open, 'a solid fixture in the way costs a detour');
  const doorPiece = { id: 'd', kind: 'fixture', fixture: 'door', x: 6, y: 3, w: 2, h: 4 };
  assert.equal(stats.walkLength(floor([a, b], [doorPiece]), a, b), open, 'a wall piece (door) is no obstacle itself');
  const offGridMachine = box('x', 30, 4); // left beyond a floor that was shrunk
  assert.equal(stats.walkLength(floor([a, offGridMachine]), a, offGridMachine), null, 'a machine off the grid: null, no flood');
}

// --- closerStop: the recommender under "Next" ---
{
  const box = (id, x, y, muscles = []) => ({ id, num: id.charCodeAt(0) - 96, label: id.toUpperCase(), x, y, w: 2, h: 2,
    settingsFields: [], muscles });
  const here = box('a', 0, 4, ['Chest']);
  const next = box('n', 30, 4); // 30 away
  const near = box('c', 6, 4); // 6 away: a fifth of the walk
  const layout = { grid: { w: 40, h: 10 }, outline: [], shapes: [], machines: [here, next, near] };
  const slot = (m) => ({ machine: m, slot: { machineId: m.id } });
  const r = stats.closerStop({ layout, from: here, next, candidates: [slot(next), slot(near)] });
  // (the walk to Next goes AROUND c, which stands in the straight line: 6 of ~30.8)
  assert.ok(r?.machine.id === 'c' && r.ratio > 0.19 && r.ratio < 0.2, `the near open stop, about a fifth of the walk (${r?.ratio})`);
  assert.equal(stats.walkSaving(r.ratio), 'a quarter of the walk');
  // walks are memoised per floor geometry: a machine moved since is walked anew
  const moved = { ...layout, machines: [here, next, { ...near, x: 28 }] };
  assert.equal(stats.closerStop({ layout: moved, from: here, next, candidates: [slot(next), slot(moved.machines[2])] }), null,
    'c moved next to Next: no longer closer');
  assert.equal(stats.closerStop({ layout, from: here, next, candidates: [slot(next), slot(near)], busyNow: new Set(['c']) }),
    null, 'usually busy now: not offered');
  // the threshold: at most 70 % of the walk to Next
  const at = (x) => {
    const m = box('c', x, 4);
    return stats.closerStop({ layout: { ...layout, machines: [here, next, m] }, from: here, next, candidates: [slot(m)] });
  };
  assert.ok(at(21), '21 of 30 (70 %): said');
  assert.equal(at(22), null, '22 of 30: less than 30 % saved, quiet');
  // recovery: the same muscle as the machine just left costs 25 %
  const same = box('s', 6, 4, ['Chest']);
  const other = box('o', 5, 6, ['Lats']); // 5.8 away, +0.5 for its later place in the plan
  const two = { ...layout, machines: [here, next, same, other] };
  assert.equal(stats.closerStop({ layout: two, from: here, next, candidates: [slot(same), slot(other)],
    recentMuscles: ['Chest'] }).machine.id, 'o', 'the chest again right after the chest press loses to the lats one step further');
  assert.equal(stats.closerStop({ layout: two, from: here, next, candidates: [slot(same), slot(other)], recentMuscles: [] }).machine.id, 's',
    'without the recovery malus the nearer one wins');
  assert.equal(stats.closerStop({ layout: two, from: here, next, candidates: [slot(same), slot(other)] }).machine.id, 'o',
    'by default the malus reads the muscles of the machine just left');
  // plan order: equal walks, the earlier stop
  const p1 = box('p', 6, 2);
  const p2 = box('q', 6, 6);
  const even = { ...layout, machines: [here, next, p1, p2] };
  assert.equal(stats.closerStop({ layout: even, from: here, next, candidates: [slot(p2), slot(p1)] }).machine.id, 'q',
    'equal walks: the one first in the plan');
  assert.equal(stats.closerStop({ layout, from: here, next: here, candidates: [slot(near)] }), null, 'Next is here: nothing to say');
  assert.deepEqual([0.1, 0.2, 0.3, 0.5, 0.6].map(stats.walkSaving),
    ['a fraction of the walk', 'a quarter of the walk', 'a third of the walk', 'half the walk', '40 % less walk']);
  // a stop over the 70 % line never silences one under it, however it ranks
  {
    const n20 = box('n', 20, 4); // Next, 20 away
    const x13 = box('x', 13, 4, ['Chest']); // 13 away: under the line (14), with the recovery malus
    const y15 = box('w', 15, 7); // ~15 away: over the line, first in the plan, no malus
    const L3 = { grid: { w: 40, h: 12 }, outline: [], shapes: [], machines: [here, n20, x13, y15] };
    assert.equal(stats.closerStop({ layout: L3, from: here, next: n20, candidates: [slot(x13)] })?.machine.id, 'x');
    assert.equal(stats.closerStop({ layout: L3, from: here, next: n20, candidates: [slot(y15), slot(x13)] })?.machine.id, 'x',
      'adding a candidate over the line never takes the answer away');
  }
  // the recovery malus reads the secondary muscles of the machine just left
  {
    const chest = { ...box('a2', 0, 4, ['Chest']), secondaryMuscles: ['Triceps'] };
    const push = box('t', 6, 4, ['Triceps']);
    const legs = box('l', 6, 1, ['Quads']); // a step further
    const L4 = { ...layout, machines: [chest, next, push, legs] };
    assert.equal(stats.closerStop({ layout: L4, from: chest, next, candidates: [slot(legs), slot(push)] }).machine.id, 'l',
      'the triceps worked as a secondary muscle a minute ago: the pushdown waits');
    assert.equal(stats.closerStop({ layout: L4, from: chest, next, candidates: [slot(legs), slot(push)], recentMuscles: [] })
      .machine.id, 't', 'without the malus the nearer pushdown would win');
  }
}

console.log('stats.test.mjs: all passed');
