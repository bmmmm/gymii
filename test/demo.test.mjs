// Logic-level test for the demo data generator: deterministic output,
// entry/set invariants, live-log data (at/rir/visits) on the last four
// weeks only and the History insights it makes fire, weekday plan states
// on any day of the week, unit conversion, template mirroring, and the
// load-is-a-replace gym behavior. Run with: node test/demo.test.mjs

// Pinned to a DST-observing zone: the hour-of-day assertions below can
// only catch DAY_MS-style drift where transitions exist (CI runs UTC).
// It reads as if it ran before the imports and it does not — static imports
// are hoisted and evaluated first, the helper among them. That stays correct
// because nothing hoisted looks at the clock, and js/demo.js is pulled in by
// a dynamic import from the body, i.e. after the zone is set.
process.env.TZ = 'Europe/Berlin';

import './helpers/localstorage.mjs'; // FIRST: installs the stub
import { strict as assert } from 'node:assert';

const store = await import(new URL('../js/store.js', import.meta.url).href);
const demo = await import(new URL('../js/demo.js', import.meta.url).href);
const stats = await import(new URL('../js/stats.js', import.meta.url).href);

const KG = { unit: 'kg' };
const NOW = new Date('2026-08-12T14:00:00').getTime(); // a Wednesday

// --- determinism ---
assert.deepEqual(
  demo.buildDemoData({ now: NOW, settings: KG }),
  demo.buildDemoData({ now: NOW, settings: KG }),
  'same now/settings/seed must produce identical data');
assert.notDeepEqual(
  demo.buildDemoData({ now: NOW, settings: KG, seed: 1 }).workouts,
  demo.buildDemoData({ now: NOW, settings: KG, seed: 2 }).workouts,
  'the seed must actually steer the output');

const { layout, workouts, plans } = demo.buildDemoData({ now: NOW, settings: KG });

// --- layout shape ---
assert.equal(layout.machines.length, 16);
assert.equal(new Set(layout.machines.map((m) => m.num)).size, 16, 'nums unique');
assert.equal(layout.machines.filter((m) => m.cardio).length, 2);
assert.equal(layout.machines.filter((m) => m.bodyweight).length, 2);
assert.ok(!layout.machines.some((m) => m.cardio && m.bodyweight), 'flags are exclusive');
assert.ok(layout.machines.some((m) => Array.isArray(m.exercises) && m.exercises.length >= 2),
  'a multi-exercise machine exists');
layout.machines.forEach((m) => {
  assert.ok(Array.isArray(m.muscles) && m.muscles.length, `${m.label} has muscles`);
  assert.ok(Array.isArray(m.settingsFields), `${m.label} has settingsFields`);
  assert.ok(m.x >= 0 && m.y >= 0 && m.x + m.w <= layout.grid.w && m.y + m.h <= layout.grid.h,
    `${m.label} inside the grid`);
});
// no two machine boxes overlap (the layout's collision rule)
layout.machines.forEach((a, i) => layout.machines.slice(i + 1).forEach((b) => {
  const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
  assert.ok(apart, `${a.label} must not overlap ${b.label}`);
}));

// --- entry invariants ---
const byId = new Map(layout.machines.map((m) => [m.id, m]));
let sawCardio = 0; let sawBodyweight = 0; let sawExercise = 0;
workouts.forEach((w) => w.entries.forEach((e) => {
  const m = byId.get(e.machineId);
  assert.ok(m, `entry machine ${e.machineId} exists in the layout`);
  assert.equal(e.num, m.num);
  assert.equal(e.label, m.label);
  assert.equal(typeof e.settings, 'object');
  assert.ok(e.sets.length, 'no empty entries');
  if (e.exercise) {
    sawExercise++;
    assert.ok(m.exercises.includes(e.exercise), 'exercise comes from the machine');
  }
  e.sets.forEach((st) => {
    if (e.cardio) {
      sawCardio++;
      assert.deepEqual(Object.keys(st).filter((k) => k !== 'at').sort(), ['distance', 'seconds']);
    } else {
      assert.ok(Number.isFinite(st.reps) && Number.isFinite(st.weight));
    }
  });
  if (e.bodyweight) sawBodyweight++;
}));
assert.ok(sawCardio && sawBodyweight && sawExercise, 'all set shapes appear in the history');

// --- time invariants ---
workouts.slice(1).forEach((w, i) => assert.ok(w.startedAt > workouts[i].startedAt, 'chronological'));
workouts.forEach((w) => {
  assert.ok(w.finishedAt > w.startedAt && w.finishedAt <= NOW, `${w.id} not in the future`);
  const mins = (w.finishedAt - w.startedAt) / 60000;
  const today = new Date(w.startedAt).toDateString() === new Date(NOW).toDateString();
  if (!today) assert.ok(mins >= 45 && mins <= 75, `${w.id} lasts 45-75 min (${mins})`);
});

// --- live-log data: the last four weeks only ---
// A recent workout carries what Train records live — `at` on every set,
// rir 1-3 on every strength/bodyweight set, visits; an older one none of it.
const backOf = (w) => Number(/-w(\d+)$/.exec(w.id)[1]);
let stampedN = 0; let bareN = 0;
workouts.forEach((w) => {
  const sets = w.entries.flatMap((e) => e.sets.map((st) => ({ st, cardio: !!e.cardio })));
  const stamped = Array.isArray(w.visits) && w.visits.length > 0
    && sets.every(({ st, cardio }) => Number.isFinite(st.at)
      && (cardio ? !('rir' in st) : [1, 2, 3].includes(st.rir)));
  const bare = !('visits' in w) && sets.every(({ st }) => !('at' in st) && !('rir' in st));
  assert.ok(backOf(w) <= 3 ? stamped : bare, `${w.id}: stamped exactly when back <= 3`);
  if (backOf(w) <= 3) stampedN++; else bareN++;
});
assert.ok(stampedN && bareN, 'both sides of the four-week cut are populated');

// `at` strictly increasing per entry inside [startedAt, finishedAt]; visits
// in the shape finishWorkout saves (no id, >= 15 s unless busy), inside the
// workout and in order. Checked on every build below, the clamped midnight
// "today" workout included.
function checkTiming(data, label) {
  let stamps = 0;
  data.workouts.forEach((w) => {
    w.entries.forEach((e) => {
      const ats = e.sets.filter((st) => 'at' in st).map((st) => st.at);
      ats.forEach((t, i) => {
        assert.ok(Number.isInteger(t) && t >= w.startedAt && t <= w.finishedAt,
          `${label} ${w.id}: at inside [startedAt, finishedAt]`);
        assert.ok(i === 0 || t > ats[i - 1], `${label} ${w.id}: at strictly increasing at ${e.machineId}`);
      });
      stamps += ats.length;
    });
    (w.visits ?? []).forEach((v, i, vs) => {
      assert.ok(!('id' in v), `${label} ${w.id}: a visit never carries an id`);
      assert.ok(v.in >= w.startedAt && v.in < v.out && v.out <= w.finishedAt,
        `${label} ${w.id}: visit inside the workout`);
      assert.ok(v.busy || v.out - v.in >= 15000, `${label} ${w.id}: visit >= 15 s unless busy`);
      assert.ok(i === 0 || v.in >= vs[i - 1].out, `${label} ${w.id}: visits in order, never overlapping`);
    });
  });
  assert.ok(stamps, `${label}: stamps exist to check`);
}
checkTiming({ workouts }, 'now');

// every set ends while its own machine's log screen was current
let inVisit = 0;
workouts.filter((w) => w.visits).forEach((w) => w.entries.forEach((e) => e.sets.forEach((st) => {
  assert.ok(w.visits.some((v) => v.machineId === e.machineId && v.in <= st.at && st.at <= v.out),
    `${w.id}: a ${e.machineId} set ends during a visit there`);
  inVisit++;
})));
assert.ok(inVisit, 'sets to match against visits exist');

// --- the live-log data moved no drawn value ---
// Digests of everything the main PRNG draws or the generator fixes (ids,
// dates, names, lockers, reps, weights; layout, plans), recorded BEFORE the
// stamps existed. Stripped first: the live-log fields, and the reps of the
// two lat pulldown sets the progress fixture sets to 12 (both drew 10).
const LAT_FIXTURE = ['demo-pull-w0', 'demo-pull-w1'];
const latSets = (data, id) => data.workouts.find((w) => w.id === id)
  .entries.find((e) => e.machineId === 'lat-pulldown').sets;
const { createHash } = await import('node:crypto');
const digest = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
const drawn = structuredClone({ layout, workouts, plans });
drawn.workouts.forEach((w) => {
  delete w.visits;
  w.entries.forEach((e) => e.sets.forEach((st) => { delete st.at; delete st.rir; }));
});
LAT_FIXTURE.forEach((id) => { latSets(drawn, id).at(-1).reps = null; });
assert.deepEqual({
  layout: digest(drawn.layout),
  plans: digest(drawn.plans),
  ...Object.fromEntries(drawn.workouts.map((w) => [w.id, digest(w)])),
}, {
  layout: '21e8c6f7fc01ce67',
  plans: 'bc4649e543b946cd',
  'demo-legs-w7': 'bf889f2b82a18df0',
  'demo-push-w7': '74d2144fe2ef7da4',
  'demo-pull-w7': '88cddfd1b3bca4c1',
  'demo-push-w6': '707d9d1e3e1d94a6',
  'demo-pull-w6': 'ae908a541d3e9291',
  'demo-legs-w5': '78c37d9d9f4d3762',
  'demo-push-w5': '8b117583c2651d0c',
  'demo-pull-w5': '2ec4eab26dcb47f9',
  'demo-legs-w4': '929a07be9afa7f18',
  'demo-push-w4': 'a556442b59468cab',
  'demo-pull-w4': '70e27f552c228a02',
  'demo-legs-w3': '8352604a6cc8bd4a',
  'demo-pull-w3': '9633f779195c286a',
  'demo-legs-w2': '32e6fe7e72909a14',
  'demo-push-w2': '5496ea7d9177305f',
  'demo-pull-w2': '3698a7228e677821',
  'demo-legs-w1': 'eed95836439f6307',
  'demo-push-w1': '084896a6d7bd68e1',
  'demo-pull-w1': '99af453f37e83795',
  'demo-legs-w0': '2f4d3b154df0f2e9',
  'demo-pull-w0': '0114d89b91b0de08',
}, 'every value drawn before the live-log data existed is unchanged');

// --- the insights the demo exists to show ---
// rule 1: the last two pull days end the lat pulldown on target + 2 reps
// with 2 in reserve at the plan's target weight
const latTarget = plans.find((p) => p.id === 'demo-plan-pull')
  .items.find((it) => it.machineId === 'lat-pulldown').target;
LAT_FIXTURE.forEach((id) => {
  const last = latSets({ workouts }, id).at(-1);
  assert.deepEqual([last.reps, last.rir, last.weight], [latTarget.reps + 2, 2, latTarget.weight],
    `${id}: lat pulldown fixture at the plan target`);
});
// progress (lat pulldown), busy (pull-up bar, rule 7), route (back to the
// seated row, rule 6) and one low-volume muscle fire — and nothing else:
// the demo must not nag (no plateau, no gap, no rest, no frequency)
const worthALook = (data, now) => stats.insights(
  data.workouts, data.layout, KG, { now, plans: data.plans }).map((i) => [i.kind, i.machineId ?? i.muscle]);
const SHOWN = [['progress', 'lat-pulldown'], ['busy', 'demo-pullup'], ['route', 'seated-row'], ['muscle-volume', 'Hamstrings']];
assert.deepEqual(worthALook({ layout, workouts, plans }, NOW), SHOWN,
  'the demo shows progress, busy, route and one volume hint');

// --- machines #1-#11 and the zone shapes hand-copy the example template;
// this diff is what keeps the copy honest when the template changes ---
const { readFileSync } = await import('node:fs');
const tpl = JSON.parse(readFileSync(
  new URL('../templates/example-gym.json', import.meta.url), 'utf8')).gym;
const base = ({ id, num, label, x, y, w, h, settingsFields, muscles }) =>
  ({ id, num, label, x, y, w, h, settingsFields, muscles });
tpl.machines.forEach((tm) => {
  const dm = layout.machines.find((m) => m.id === tm.id);
  assert.ok(dm, `demo layout carries template machine ${tm.id}`);
  assert.deepEqual(base(dm), base(tm), `${tm.id} mirrors the template`);
});
assert.deepEqual(layout.shapes, tpl.shapes, 'zone shapes mirror the template');

// --- a load around midnight still produces a valid "today" workout ---
for (const offset of [0, 10 * 60000]) {
  const night = new Date('2026-08-12T00:00:00').getTime() + offset;
  const b = demo.buildDemoData({ now: night, settings: KG });
  b.workouts.forEach((w) => assert.ok(w.finishedAt > w.startedAt,
    `${w.id} keeps a positive duration at midnight+${offset / 60000}min`));
  checkTiming(b, `midnight+${offset / 60000}min`);
  const today = b.workouts.filter((w) =>
    new Date(w.startedAt).toDateString() === new Date(night).toDateString());
  assert.equal(today.length, 1, 'exactly one workout lands on the load day');
  assert.ok(today[0].finishedAt <= night + 60000,
    'the today workout never reaches further than a minute past now');
  assert.equal(store.planDayState(
    b.plans.find((p) => p.id === 'demo-plan-pull'), b.workouts, night).state,
  'done', 'pull still reads done on a night load');
}

// --- workouts keep their local evening hour across a DST transition ---
// Berlin leaves DST on 25 Oct 2026; eight weeks of history built in early
// November reach back across it. Day arithmetic in fixed 86400000-ms
// steps would put the pre-transition workouts an hour off (18:xx).
const dstNow = new Date('2026-11-04T14:00:00').getTime(); // a Wednesday
const dst = demo.buildDemoData({ now: dstNow, settings: KG });
checkTiming(dst, 'dst');
dst.workouts.forEach((w) => {
  if (new Date(w.startedAt).toDateString() === new Date(dstNow).toDateString()) return;
  assert.equal(new Date(w.startedAt).getHours(), 17,
    `${w.id} starts in the usual 17h window across the DST change`);
});

// --- plan states must hold on every day of the week ---
for (let d = 0; d < 7; d++) {
  const now = NOW + d * 86400000;
  const built = demo.buildDemoData({ now, settings: KG });
  const state = (id) => store.planDayState(
    built.plans.find((p) => p.id === id), built.workouts, now).state;
  assert.equal(state('demo-plan-push'), 'missed', `push missed (day ${d})`);
  assert.equal(state('demo-plan-pull'), 'done', `pull done (day ${d})`);
  assert.equal(state('demo-plan-core'), 'due', `core due (day ${d})`);
  assert.equal(store.todayStatus(built.plans, built.workouts, now).plan.id,
    'demo-plan-core', `due wins the headline (day ${d})`);
  checkTiming(built, `day ${d}`);
  assert.deepEqual(worthALook(built, now), SHOWN, `the four hints show on day ${d}`);
}

// --- unit conversion ---
const lbs = demo.buildDemoData({ now: NOW, settings: { unit: 'lbs' } });
const firstWeight = (data, id) => data.workouts
  .flatMap((w) => w.entries).find((e) => e.machineId === id).sets[0].weight;
assert.equal(firstWeight(lbs, 'chest-press'),
  store.convertWeight(firstWeight({ workouts }, 'chest-press'), 'lbs'),
  'weights converted through store.convertWeight — setUnit rounding by construction');
const dist = (data) => data.workouts.flatMap((w) => w.entries)
  .filter((e) => e.cardio).map((e) => e.sets[0].distance);
assert.ok(dist({ workouts }).every((v) => v >= 1000), 'kg build uses metres');
assert.ok(dist(lbs).every((v) => v < 5), 'lbs build uses miles');
const lbsTarget = lbs.plans.find((p) => p.id === 'demo-plan-core')
  .items.find((it) => it.target.distance).target;
assert.ok(lbsTarget.distance < 5, 'plan targets converted too');

// --- loadDemoData: replaces, never duplicates, never touches real data ---
const realGym = store.newLayout('Real gym');
realGym.machines.push({ id: 'r1', num: 1, label: 'Rack', x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles: [] });
store.saveLayout(realGym);
store.saveWorkouts([{ id: 'rw1', startedAt: 1000, finishedAt: 2000, entries: [
  { machineId: 'r1', num: 1, label: 'Rack', settings: {}, sets: [{ reps: 5, weight: 100 }] }] }]);
const realId = store.getGyms().activeId;
const realJson = JSON.stringify([store.getLayout(), store.getWorkouts()]);

const r1 = demo.loadDemoData({ now: NOW, settings: KG });
assert.equal(r1.created, true);
assert.equal(store.getGyms().activeId, r1.gymId, 'Demo gym active');
assert.equal(store.getLayout().machines.length, 16);
assert.equal(store.getWorkouts().length, r1.workouts);
assert.equal(store.getPlans().length, 3);

// a stale in-progress workout must not survive a reload
store.saveActive({ id: 'stale', startedAt: NOW, entries: [] });
const r2 = demo.loadDemoData({ now: NOW, settings: KG });
assert.equal(r2.created, false, 'second load reuses the gym');
assert.equal(r2.gymId, r1.gymId);
assert.equal(store.getGyms().list.filter((p) => p.name === 'Demo').length, 1,
  'exactly one Demo gym');
assert.equal(store.getActive(), null, 'stale active cleared');
assert.equal(store.getWorkouts().length, r1.workouts, 'reload replaces, not appends');

// the real gym is untouched
store.setActiveGym(realId);
assert.equal(JSON.stringify([store.getLayout(), store.getWorkouts()]), realJson,
  'real data byte-identical after the demo load');

// identity is the demo FLAG, not the name: a real gym renamed to "Demo"
// must never be adopted and overwritten by a reload
store.renameGym(realId, 'Demo');
const r3 = demo.loadDemoData({ now: NOW, settings: KG });
assert.equal(r3.gymId, r1.gymId, 'reload sticks to the flagged gym');
store.setActiveGym(realId);
assert.equal(JSON.stringify([store.getLayout(), store.getWorkouts()]), realJson,
  'a real gym named Demo survives a reload untouched');
store.renameGym(realId, 'Real gym');

// ...and the identity survives renaming the demo gym itself
store.renameGym(r1.gymId, 'Playground');
const r4 = demo.loadDemoData({ now: NOW, settings: KG });
assert.equal(r4.created, false, 'a renamed demo gym is still recognized');
assert.equal(r4.gymId, r1.gymId);

// the demo gym can ALWAYS be deleted — even as the last gym, where
// Settings' removal promise would otherwise break — and the registry
// self-heals into a fresh default afterwards
store.setActiveGym(realId);
assert.equal(store.deleteGym(realId), true);
assert.equal(store.deleteGym(r1.gymId), true, 'sole demo gym deletable');
assert.equal(store.getGyms().list.length, 1, 'fresh default after the demo left');
assert.ok(!store.getGyms().list[0].demo, 'the fresh default is a normal gym');

console.log('demo.test.mjs: all assertions passed');
