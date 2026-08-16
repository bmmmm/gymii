// Logic-level test for the demo data generator: deterministic output,
// entry/set invariants, weekday plan states on any day of the week, unit
// conversion, and the load-is-a-replace profile behavior.
// Run with: node test/demo.test.mjs
import { strict as assert } from 'node:assert';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const store = await import(new URL('../js/store.js', import.meta.url).href);
const demo = await import(new URL('../js/demo.js', import.meta.url).href);

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

const { gym, workouts, plans } = demo.buildDemoData({ now: NOW, settings: KG });

// --- gym shape ---
assert.equal(gym.machines.length, 16);
assert.equal(new Set(gym.machines.map((m) => m.num)).size, 16, 'nums unique');
assert.equal(gym.machines.filter((m) => m.cardio).length, 2);
assert.equal(gym.machines.filter((m) => m.bodyweight).length, 2);
assert.ok(!gym.machines.some((m) => m.cardio && m.bodyweight), 'flags are exclusive');
assert.ok(gym.machines.some((m) => Array.isArray(m.exercises) && m.exercises.length >= 2),
  'a multi-exercise station exists');
gym.machines.forEach((m) => {
  assert.ok(Array.isArray(m.muscles) && m.muscles.length, `${m.label} has muscles`);
  assert.ok(Array.isArray(m.settingsFields), `${m.label} has settingsFields`);
  assert.ok(m.x >= 0 && m.y >= 0 && m.x + m.w <= gym.grid.w && m.y + m.h <= gym.grid.h,
    `${m.label} inside the grid`);
});
// no two machine boxes overlap (the studio's collision rule)
gym.machines.forEach((a, i) => gym.machines.slice(i + 1).forEach((b) => {
  const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
  assert.ok(apart, `${a.label} must not overlap ${b.label}`);
}));

// --- entry invariants ---
const byId = new Map(gym.machines.map((m) => [m.id, m]));
let sawCardio = 0; let sawBodyweight = 0; let sawExercise = 0;
workouts.forEach((w) => w.entries.forEach((e) => {
  const m = byId.get(e.machineId);
  assert.ok(m, `entry machine ${e.machineId} exists in the gym`);
  assert.equal(e.num, m.num);
  assert.equal(e.label, m.label);
  assert.equal(typeof e.settings, 'object');
  assert.ok(e.sets.length, 'no empty entries');
  if (e.exercise) {
    sawExercise++;
    assert.ok(m.exercises.includes(e.exercise), 'exercise comes from the machine');
  }
  e.sets.forEach((st) => {
    assert.ok(!('at' in st), 'generated sets must not fake the live-log stamp');
    if (e.cardio) {
      sawCardio++;
      assert.deepEqual(Object.keys(st).sort(), ['distance', 'seconds']);
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
}

// --- unit conversion ---
const lbs = demo.buildDemoData({ now: NOW, settings: { unit: 'lbs' } });
const firstWeight = (data, id) => data.workouts
  .flatMap((w) => w.entries).find((e) => e.machineId === id).sets[0].weight;
assert.equal(firstWeight(lbs, 'chest-press'),
  Math.round(firstWeight({ workouts }, 'chest-press') * 2.2046226218 * 2) / 2,
  'weights converted with setUnit rounding');
const dist = (data) => data.workouts.flatMap((w) => w.entries)
  .filter((e) => e.cardio).map((e) => e.sets[0].distance);
assert.ok(dist({ workouts }).every((v) => v >= 1000), 'kg build uses metres');
assert.ok(dist(lbs).every((v) => v < 5), 'lbs build uses miles');
const lbsTarget = lbs.plans.find((p) => p.id === 'demo-plan-core')
  .items.find((it) => it.target.distance).target;
assert.ok(lbsTarget.distance < 5, 'plan targets converted too');

// --- loadDemoData: replaces, never duplicates, never touches real data ---
const realGym = store.newGym('Real gym');
realGym.machines.push({ id: 'r1', num: 1, label: 'Rack', x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles: [] });
store.saveGym(realGym);
store.saveWorkouts([{ id: 'rw1', startedAt: 1000, finishedAt: 2000, entries: [
  { machineId: 'r1', num: 1, label: 'Rack', settings: {}, sets: [{ reps: 5, weight: 100 }] }] }]);
const realId = store.getProfiles().activeId;
const realJson = JSON.stringify([store.getGym(), store.getWorkouts()]);

const r1 = demo.loadDemoData({ now: NOW, settings: KG });
assert.equal(r1.created, true);
assert.equal(store.getProfiles().activeId, r1.profileId, 'Demo profile active');
assert.equal(store.getGym().machines.length, 16);
assert.equal(store.getWorkouts().length, r1.workouts);
assert.equal(store.getPlans().length, 3);

// a stale in-progress workout must not survive a reload
store.saveActive({ id: 'stale', startedAt: NOW, entries: [] });
const r2 = demo.loadDemoData({ now: NOW, settings: KG });
assert.equal(r2.created, false, 'second load reuses the profile');
assert.equal(r2.profileId, r1.profileId);
assert.equal(store.getProfiles().list.filter((p) => p.name === 'Demo').length, 1,
  'exactly one Demo profile');
assert.equal(store.getActive(), null, 'stale active cleared');
assert.equal(store.getWorkouts().length, r1.workouts, 'reload replaces, not appends');

// the real profile is untouched
store.setActiveProfile(realId);
assert.equal(JSON.stringify([store.getGym(), store.getWorkouts()]), realJson,
  'real data byte-identical after the demo load');

console.log('demo.test.mjs: all assertions passed');
