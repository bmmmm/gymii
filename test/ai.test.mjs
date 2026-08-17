// Logic-level test for the AI exchange: the export's plans section (same
// wire shape the prompt teaches for answers), and the paste-back flow —
// a new plan lands as a new plan, a revision carrying an exported id
// replaces its original only after a two-tap confirm.
// Run with: node test/ai.test.mjs
import { strict as assert } from 'node:assert';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const store = await import(new URL('../js/store.js', import.meta.url).href);
const { renderAi, buildAiExport } = await import(new URL('../js/ai.js', import.meta.url).href);

// --- fixture: a small gym and one saved plan with everything on it ---

const gym = store.newGym('AI test gym');
gym.machines.push(
  { id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: ['Seat'], muscles: ['Chest'] },
  { id: 'tm', num: 9, label: 'Treadmill', x: 6, y: 0, w: 3, h: 6, settingsFields: [], muscles: ['Quads'], cardio: true },
);
store.saveGym(gym);
store.savePlans([{
  id: 'p1', name: 'Push day', createdAt: 123, days: [1, 4],
  items: [
    { machineId: 'm1', exercise: null, target: { sets: 3, reps: 10, weight: 50 } },
    { machineId: 'gone', exercise: null, target: { sets: 3, reps: 12, weight: 20 } },
    { machineId: null, name: 'Face pulls', num: 12, exercise: null, target: { sets: 3, reps: 15, weight: 15 } },
    { machineId: 'tm', exercise: null, target: { distance: 3000, seconds: 900 } },
  ],
}]);

// --- the export carries plans in the answer's wire shape ---

const exported = JSON.parse(buildAiExport());
assert.equal(exported.plans.length, 1, 'saved plans are exported');
const [p] = exported.plans;
assert.equal(p.id, 'p1', 'the id rides along — it is the replace handle');
assert.deepEqual(p.days, [1, 4]);
assert.deepEqual(p.items[0], { num: 1, sets: 3, reps: 10, weight: 50 },
  'bound items export their num and a flattened target');
assert.equal(p.items.length, 3, 'an item whose machine was deleted is skipped');
assert.deepEqual(p.items[1], { name: 'Face pulls', num: 12, sets: 3, reps: 15, weight: 15 },
  'unbound items keep their name and num hint');
assert.deepEqual(p.items[2], { num: 9, distance: 3000, seconds: 900 },
  'cardio targets keep their own shape');
assert.ok(!('createdAt' in p) && !('machineId' in p.items[0]),
  'internal fields stay internal');

store.savePlans([]);
assert.ok(!('plans' in JSON.parse(buildAiExport())),
  'no plans, no plans key — empty users pay no tokens');

// --- workout dates export in LOCAL time, not UTC (a 00:30 session must
// not roll onto the previous day for anyone east of UTC) ---

const lateNightTs = new Date(2030, 0, 15, 0, 30).getTime();
const lnd = new Date(lateNightTs);
const expectedLocalDate = `${lnd.getFullYear()}-${String(lnd.getMonth() + 1).padStart(2, '0')}-${String(lnd.getDate()).padStart(2, '0')}`;
store.saveWorkouts([{ id: 'w1', startedAt: lateNightTs, entries: [] }]);
const exportedWorkouts = JSON.parse(buildAiExport()).workouts;
assert.equal(exportedWorkouts.length, 1);
assert.equal(exportedWorkouts[0].date, expectedLocalDate,
  'export date is the local calendar day, not the UTC-shifted one');
store.saveWorkouts([]);

store.savePlans([{
  id: 'p1', name: 'Push day', createdAt: 123, days: [1, 4],
  items: [{ machineId: 'm1', exercise: null, target: { sets: 3, reps: 10, weight: 50 } }],
}]);

// --- DOM stubs: stable per selector, stateful classList for two-tap ---

const classListStub = () => {
  const set = new Set();
  return {
    add: (c) => set.add(c), remove: (c) => set.delete(c),
    toggle: () => {}, contains: (c) => set.has(c),
  };
};
const stubEl = () => ({
  innerHTML: '', value: '', textContent: '', dataset: {}, listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
  querySelector: () => stubEl(),
  querySelectorAll: () => [],
  classList: classListStub(),
});
const byId = new Map();
const root = {
  innerHTML: '',
  querySelector(sel) {
    if (!byId.has(sel)) byId.set(sel, stubEl());
    return byId.get(sel);
  },
  querySelectorAll: () => [],
};

// an active workout keeps the import on this screen (no builder
// navigation), which is also the real mid-workout paste-back scenario
store.saveActive({ v: 2, id: 'aw', startedAt: 1, entries: [] });
renderAi(root);
const importBtn = root.querySelector('#ai-import-btn');
const importEl = root.querySelector('#ai-import');

// --- a new plan (no id) lands as a new plan, no confirm needed ---

importEl.value = JSON.stringify({
  app: 'gymii', kind: 'workout-plan', name: 'Pull day',
  items: [{ num: 1, sets: 3, reps: 10, weight: 40 }],
});
importBtn.listeners.click();
assert.equal(store.getPlans().length, 2, 'a plan without id is added');
assert.ok(store.getPlans().some((x) => x.name === 'Pull day'));

// --- an unknown id is NOT a replace handle (nothing to replace) ---

importEl.value = JSON.stringify({
  app: 'gymii', kind: 'workout-plan', id: 'zzz', name: 'Mystery',
  items: [{ num: 1, sets: 1, reps: 1, weight: 1 }],
});
importBtn.listeners.click();
assert.equal(store.getPlans().length, 3, 'an unknown id still creates a new plan');
assert.ok(!store.getPlans().some((x) => x.id === 'zzz'), 'the foreign id is not adopted');

// --- a revision carrying an exported id replaces after two-tap ---

importEl.value = JSON.stringify({
  app: 'gymii', kind: 'workout-plan', id: 'p1',
  items: [{ num: 1, sets: 4, reps: 8, weight: 55 }], // no name, no days
});
importBtn.listeners.click();
assert.equal(importBtn.textContent, 'Tap again to replace plan "Push day"',
  'the confirm names the plan that would be overwritten');
assert.deepEqual(store.getPlans().find((x) => x.id === 'p1').items[0].target,
  { sets: 3, reps: 10, weight: 50 }, 'the first tap only arms — nothing replaced yet');

importBtn.listeners.click();
const replaced = store.getPlans().find((x) => x.id === 'p1');
assert.equal(store.getPlans().length, 3, 'replaced in place, not duplicated');
assert.deepEqual(replaced.items[0].target, { sets: 4, reps: 8, weight: 55 },
  'the revision content landed');
assert.equal(replaced.name, 'Push day', 'a revision without a name keeps the old one');
assert.deepEqual(replaced.days, [1, 4], 'a revision without days keeps the weekday tags');
assert.equal(replaced.createdAt, 123, 'createdAt survives — missed-day tracking intact');
assert.equal(importBtn.textContent, 'Import pasted JSON',
  'the button label rests again after the confirming tap');

console.log('ai exchange: all assertions passed');
