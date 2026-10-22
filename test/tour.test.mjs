// Logic-level test for the tour (js/tour.js) and the first-run predicate it
// hangs on (train.js isFirstRun): opening it marks it seen without moving
// the sync stamp, the unit question belongs to the first tour only, Back/
// Next/Skip walk and leave it, and a default weight step follows the unit.
// (`askUnit` is app.js's call — isFirstRun() — passed here by hand.)
// The browser half (redirect on first boot, tab marks, 44px) lives in
// smoke/tour.spec.mjs.
// Run with: node test/tour.test.mjs
import './helpers/localstorage.mjs'; // FIRST: installs the stub
import { strict as assert } from 'node:assert';

const store = await import(new URL('../js/store.js', import.meta.url).href);
const plantext = await import(new URL('../js/plantext.js', import.meta.url).href);
const { renderTour, TOUR_STEPS } = await import(new URL('../js/tour.js', import.meta.url).href);
const { isFirstRun } = await import(new URL('../js/train.js', import.meta.url).href);

const stubEl = () => ({
  listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
});
// Per-selector registry, cleared per render so a listener is the CURRENT
// render's (a stale one would act on a step that is gone).
const byId = new Map();
const root = {
  innerHTML: '',
  scrollTop: 0,
  querySelector(sel) {
    if (!byId.has(sel)) byId.set(sel, stubEl());
    return byId.get(sel);
  },
};
let exits = 0;
const onExit = () => { exits++; };
const render = (opts = {}) => { byId.clear(); renderTour(root, { onExit, ...opts }); };
const click = (sel) => { const fn = byId.get(sel).listeners.click; byId.clear(); fn({}); };
const chip = (unit) => {
  const fn = byId.get('#tour-units').listeners.click;
  byId.clear();
  fn({ target: { closest: () => ({ dataset: { unit } }) } });
};

// --- first run ---
assert.equal(isFirstRun(), true, 'an empty install has nothing to start');
const stampBefore = store.getSettings().updatedAt;
render({ entry: true, askUnit: isFirstRun() });
assert.ok(root.innerHTML.includes('Welcome to gymii') && root.innerHTML.includes('Step 1 of 6'),
  'the tour opens on its first step');
assert.ok(root.innerHTML.includes('Kilograms or pounds?'), 'a first tour asks for the unit');
assert.equal(store.getSettings().tourSeen, true, 'opening the tour marks it seen');
assert.equal(store.getSettings().updatedAt, stampBefore,
  'tourSeen is device-local — the shared settings stamp does not move');
assert.ok(!root.innerHTML.includes('id="tour-back"'), 'nothing to go back to on step one');

// --- the unit question ---
chip('lbs');
assert.equal(store.getSettings().unit, 'lbs');
assert.equal(store.getSettings().weightStep, 5, 'an untouched 2.5 kg step becomes the usual 5 lbs');
assert.match(root.innerHTML, /data-unit="lbs"\s+aria-pressed="true"/, 'the chip shows the choice');
chip('kg');
assert.equal(store.getSettings().unit, 'kg');
assert.equal(store.getSettings().weightStep, 2.5, 'and back again');
store.saveSettings({ ...store.getSettings(), weightStep: 1 });
chip('lbs');
assert.equal(store.getSettings().weightStep, 2, 'a step someone chose converts as setUnit says');
chip('kg');
store.saveSettings({ ...store.getSettings(), weightStep: 2.5 });

// --- walking it ---
click('#tour-next');
assert.ok(root.innerHTML.includes('Step 2 of 6') && root.innerHTML.includes('Train machine by machine'));
assert.ok(root.innerHTML.includes('class="tour-flow"'), 'the training step shows the loop');
assert.ok(root.innerHTML.includes('id="tour-back"'));
click('#tour-back');
assert.ok(root.innerHTML.includes('Step 1 of 6'), 'Back returns a step');
for (let i = 1; i < TOUR_STEPS.length; i++) click('#tour-next');
assert.ok(root.innerHTML.includes(`Step ${TOUR_STEPS.length} of ${TOUR_STEPS.length}`));
assert.ok(root.innerHTML.includes('Let\'s go') && !root.innerHTML.includes('id="tour-skip"'),
  'the last step ends the tour instead of offering to skip it');
assert.equal(exits, 0);
click('#tour-next');
assert.equal(exits, 1, 'Let\'s go leaves the tour');

// --- again, later ---
render({ entry: true });
assert.ok(root.innerHTML.includes('Step 1 of 6'), 'a route entry starts over');
assert.ok(!root.innerHTML.includes('Kilograms or pounds?'), 'without askUnit there is no unit question');
click('#tour-next');
click('#tour-skip');
assert.equal(exits, 2, 'Skip leaves from any step');

// every step points at real tabs only (the Gym is not one)
const TABS = ['train', 'history', 'ai', 'settings'];
TOUR_STEPS.forEach((t) => assert.ok(t.spots.every((s) => TABS.includes(s)), `${t.title}: spots are tabs`));

// --- the predicate ---
store.savePlan(plantext.planFromText('Leg press 3x10 80'));
assert.equal(isFirstRun(), false, 'a saved plan is something to start');

console.log('tour tests passed');
