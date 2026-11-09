// Logic test for app/js/minimal.js — Minimal mode: the series chips, the
// record per kind, the one-liners, the extras (and junk in them), the set
// shapes a tap logs, the auto-close, "+ New" without twins, the fun switch,
// and that the workout it writes stays one the full view can continue.
// Run with: node test/minimal.test.mjs
import { mem } from './helpers/localstorage.mjs'; // FIRST: installs the stub
import { strict as assert } from 'node:assert';

const store = await import(new URL('../app/js/store.js', import.meta.url).href);
const m = await import(new URL('../app/js/minimal.js', import.meta.url).href);
const { renderTrain, openPlanBuilder, openBuilder } = await import(new URL('../app/js/train.js', import.meta.url).href);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// --- the stub DOM (train.test.mjs's): every selector hands back an element,
// one per id, so a test can preset a field and capture a listener ---
const stubEl = () => ({
  listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
  value: '', innerHTML: '', textContent: '',
  querySelector: () => stubEl(), querySelectorAll: () => [],
  classList: (() => {
    const set = new Set();
    return {
      add: (c) => set.add(c), remove: (c) => set.delete(c),
      toggle: (c, force) => {
        const on = force ?? !set.has(c);
        if (on) set.add(c); else set.delete(c);
        return on;
      },
      contains: (c) => set.has(c),
    };
  })(),
  dataset: {}, style: {},
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
const el = (sel) => root.querySelector(sel);
const click = (sel, target = {}) => el(sel).listeners.click({ target: { closest: () => target }, currentTarget: el(sel) });
const activeSets = (machineId) => store.getActive()?.entries.find((e) => e.machineId === machineId)?.sets ?? [];
const settings = (patch) => store.saveSettings({ ...store.getSettings(), ...patch });

// --- a gym with one machine of every kind, plus exercises and grips ---
const gym = store.newLayout('Test gym');
const mk = (id, num, label, extra = {}) => ({ id, num, label, x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles: [], ...extra });
gym.machines.push(
  mk('lp', 1, 'Leg press'),
  mk('ap', 2, 'Assisted pull-up', { assisted: true }),
  mk('pu', 3, 'Pull-up bar', { bodyweight: true }),
  mk('tm', 4, 'Treadmill', { cardio: true }),
  mk('db', 5, 'Dumbbells', { exercises: ['Curl', 'Press'] }),
  mk('ct', 6, 'Cable tower', { grips: ['Rope'] }),
);
store.saveLayout(gym);
const machine = (id) => store.getLayout().machines.find((x) => x.id === id);

const now = Date.now();
const workout = (id, startedAt, entries) => ({ id, startedAt, finishedAt: startedAt + 40 * MIN, entries });
const set = (weight, reps, at) => ({ weight, reps, ...(at ? { at } : {}) });

// ======================================================================
// 1. the series chips: recent first (newest set), each once, then the gym
// ======================================================================
{
  const workouts = [
    workout('w1', now - 9 * DAY, [store.newEntry(machine('lp'), null, [set(80, 10, now - 9 * DAY)])]),
    workout('w2', now - 3 * DAY, [
      store.newEntry(machine('tm'), null, [{ distance: 2000, seconds: 600, at: now - 3 * DAY }]),
      store.newEntry(machine('ct'), null, [set(25, 12, now - 3 * DAY + 5 * MIN)], 'Rope'),
      store.newEntry(machine('lp'), null, [set(85, 10, now - 3 * DAY - MIN)]),
      // not loggable any more: a deleted machine, an exercise the machine no
      // longer lists, a grip it no longer offers
      { machineId: 'gone', num: 9, label: 'Gone', settings: {}, sets: [set(1, 1, now - 3 * DAY)] },
      store.newEntry(machine('db'), 'Fly', [set(8, 10, now - 3 * DAY)]),
      store.newEntry(machine('ct'), null, [set(25, 12, now - 3 * DAY)], 'V-bar'),
    ]),
  ];
  const active = {
    id: 'a', startedAt: now - 20 * MIN, plan: [], entries: [store.newEntry(machine('ap'), null, [set(30, 8, now - 5 * MIN)])],
  };
  const chips = m.seriesChips({ workouts, active, layout: store.getLayout() });
  assert.deepEqual(chips.map((c) => [c.machineId, c.exercise, c.grip]), [
    ['ap', null, null], // the running workout's newest set
    ['ct', null, 'Rope'], // then the history by newest set
    ['tm', null, null],
    ['lp', null, null], // once, though trained in two workouts
    ['pu', null, null], // then the rest of the gym, by number
    ['db', 'Curl', null], ['db', 'Press', null], // a multi-exercise machine offers each
    ['ct', null, null], // the gripless series is a series of its own
  ], 'recent series first, each once, then every other machine');
  assert.equal(m.seriesChips({}).length, 0, 'no gym, no chips');
}

// ======================================================================
// 2. the record per kind — and a series' first set is none
// ======================================================================
{
  assert.equal(m.isNewBest('strength', { weight: 90 }, []), false, 'the very first set of a series is no record');
  assert.equal(m.isNewBest('strength', { weight: 90 }, [{ weight: 80 }, { weight: 85, reps: 5 }]), true, 'strength: heaviest');
  assert.equal(m.isNewBest('strength', { weight: 85 }, [{ weight: 80 }, { weight: 85 }]), false, 'a tie is no record');
  assert.equal(m.isNewBest('assisted', { weight: 20 }, [{ weight: 30 }, { weight: 25 }]), true, 'assisted: least assist');
  assert.equal(m.isNewBest('assisted', { weight: 30 }, [{ weight: 25 }]), false, 'more assist is no record');
  assert.equal(m.isNewBest('assisted', { weight: 0 }, [{ weight: 5 }]), true, 'unassisted beats 5 kg of help');
  assert.equal(m.isNewBest('bodyweight', { reps: 11 }, [{ reps: 8 }, { reps: 10, weight: 5 }]), true, 'bodyweight: most reps');
  assert.equal(m.isNewBest('bodyweight', { reps: 10 }, [{ reps: 10 }]), false);
  assert.equal(m.isNewBest('bodyweight', { reps: 9 }, []), false, 'first bodyweight set: none');
  const runs = [{ distance: 2000, seconds: 600 }, { distance: 1500, seconds: 400 }];
  assert.equal(m.isNewBest('cardio', { distance: 2100, seconds: 900 }, runs), true, 'cardio: longest distance');
  assert.equal(m.isNewBest('cardio', { distance: 2000, seconds: 590 }, runs), true, 'same distance, shorter time');
  assert.equal(m.isNewBest('cardio', { distance: 2000, seconds: 600 }, runs), false, 'same distance, same time');
  assert.equal(m.isNewBest('cardio', { distance: 1900, seconds: 100 }, runs), false, 'shorter is no record, however fast');
  assert.equal(m.isNewBest('cardio', { distance: 100, seconds: 30 }, []), false, 'first bout: none');
  // the earlier sets are the series' of that kind only
  const sel = { machineId: 'lp', exercise: null, grip: null };
  const ws = [workout('x', now - DAY, [store.newEntry(machine('lp'), null, [set(80, 10)]),
    store.newEntry(machine('lp'), null, [set(200, 1)], 'Rope')])];
  assert.deepEqual(m.seriesSets(sel, 'strength', { workouts: ws }), [set(80, 10)], 'another grip is another series');
}

// ======================================================================
// 3. the one-liners: by occasion, never twice in a row, injectable chance
// ======================================================================
{
  const total = Object.values(m.LINES).reduce((n, l) => n + l.length, 0);
  assert.ok(total >= 40, `at least 40 lines (${total})`);
  ['set', 'best', 'done', 'firstOfDay', 'comeback'].forEach((k) => assert.ok(m.LINES[k].length >= 2, `${k} has lines`));
  const all = Object.values(m.LINES).flat();
  assert.equal(new Set(all).size, all.length, 'no line twice');
  // the tone rules, as far as words can say it
  all.forEach((l) => assert.ok(!/\b(fat|skinny|slim|diet|calorie|weight loss|lose weight|body|belly|abs|lazy|skipp?ed|should|must|finally|again\?)\b/i.test(l),
    `no body talk, no guilt: "${l}"`));
  assert.equal(m.pickLine('best', { rand: () => 0 }), m.LINES.best[0], 'the injected chance decides');
  assert.equal(m.pickLine('best', { rand: () => 0.99999 }), m.LINES.best.at(-1), 'the top of the range is the last line');
  assert.equal(m.pickLine('best', { rand: () => 0, last: m.LINES.best[0] }), m.LINES.best[1], 'never the line said last');
  assert.ok(m.LINES.done.includes(m.pickLine('done', { rand: () => 0.5 })), 'a done line for Done');
  assert.ok(m.LINES.set.includes(m.pickLine('nonsense', { rand: () => 0.3 })), 'an unknown occasion falls back to a set line');
  // a seeded walk never repeats directly
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let last = null;
  for (let i = 0; i < 200; i++) {
    const line = m.pickLine('set', { rand, last });
    assert.notEqual(line, last, 'no direct repeat');
    last = line;
  }
}

// ======================================================================
// 4. the occasion a set earns
// ======================================================================
{
  assert.equal(m.occasionFor({ best: true, now }), 'best');
  assert.equal(m.occasionFor({ now, workouts: [] }), 'firstOfDay', 'a first set ever is the first of the day');
  assert.equal(m.occasionFor({ now, workouts: [workout('t', now - 30 * MIN, [])] }), 'set', 'a workout today: a plain set');
  assert.equal(m.occasionFor({ now, active: { entries: [{ sets: [{ at: now - MIN }] }] } }), 'set', 'a set today in this workout');
  assert.equal(m.occasionFor({ now, workouts: [workout('o', now - 2 * DAY, [])] }), 'firstOfDay');
  assert.equal(m.occasionFor({ now, workouts: [workout('o', now - 20 * DAY, [])] }), 'comeback', 'after two weeks: welcome back');
}

// ======================================================================
// 5. the extras: read defensively, toggled clean
// ======================================================================
{
  const k = m.extrasKey('lp', null);
  assert.equal(k, 'lp|', 'machine id and an empty exercise');
  assert.equal(m.extrasKey('db', 'Curl'), 'db|Curl');
  assert.deepEqual(m.readExtras({}, k), [], 'nothing stored: nothing on');
  ['junk', 5, null, ['reps'], { [k]: 'reps' }, { [k]: { 0: 'reps' } }].forEach((raw) =>
    assert.deepEqual(m.readExtras({ minimalExtras: raw }, k), [], `junk is nothing: ${JSON.stringify(raw)}`));
  assert.deepEqual(m.readExtras({ minimalExtras: { [k]: ['reps', '<img onerror=x>', 5, null, 'level', 'reps', '__proto__'] } }, k),
    ['reps', 'level'], 'only known field names, each once');
  assert.deepEqual(m.readExtras({ minimalExtras: {} }, 'toString'), [], 'an inherited key is no key');
  const parsed = JSON.parse('{"minimalExtras": {"__proto__": ["reps"], "lp|": ["reps"]}}');
  assert.deepEqual(m.readExtras(parsed, '__proto__'), ['reps'], 'a "__proto__" key is a plain key');
  const toggled = m.toggleExtra(parsed, 'lp|', 'reps');
  assert.deepEqual(Object.keys(toggled), ['__proto__'], 'toggled off: the key goes');
  assert.equal(Object.getPrototypeOf(toggled), Object.prototype, 'and nothing reached the prototype');
  const dirty = { minimalExtras: { 'lp|': ['bogus'], 'tm|': ['level', 'x'] } };
  assert.deepEqual(m.toggleExtra(dirty, 'ap|', 'reps'), { 'tm|': ['level'], 'ap|': ['reps'] },
    'a write keeps the good, drops the junk and the emptied');
  assert.equal(m.extraOn({ minimalExtras: { 'lp|': ['reps'] } }, 'lp|', 'reps'), true);
  assert.equal(m.extraOn({ minimalExtras: { 'lp|': ['reps'] } }, 'lp|', 'weight'), false);
}

// ======================================================================
// 6. buildSet: exactly the fields on screen — absent, never 0 or null
// ======================================================================
{
  const v = { weight: 80, reps: 8, distance: 2000, seconds: 600, level: 0 };
  assert.deepEqual(m.buildSet('strength', v, false, 1), { weight: 80, at: 1 }, 'strength: the weight alone');
  assert.deepEqual(m.buildSet('strength', v, true, 1), { weight: 80, reps: 8, at: 1 }, '+ Reps adds them');
  assert.deepEqual(m.buildSet('assisted', v, false, 1), { weight: 80, at: 1 }, 'assisted: the assist alone');
  assert.deepEqual(m.buildSet('bodyweight', v, false, 1), { reps: 8, at: 1 }, 'bodyweight: the reps alone');
  assert.deepEqual(m.buildSet('bodyweight', { ...v, weight: 0 }, true, 1), { reps: 8, weight: 0, at: 1 }, '+ Weight: added weight, 0 included');
  assert.deepEqual(m.buildSet('cardio', v, false, 1), { distance: 2000, seconds: 600, at: 1 }, 'cardio: time and distance');
  assert.deepEqual(m.buildSet('cardio', v, true, 1), { distance: 2000, seconds: 600, at: 1 }, 'level 0 is none: absent');
  assert.deepEqual(m.buildSet('cardio', { ...v, level: 5 }, true, 1), { distance: 2000, seconds: 600, level: 5, at: 1 });
  assert.deepEqual(m.buildSet('cardio', { ...v, level: 5 }, false, 1), { distance: 2000, seconds: 600, at: 1 },
    'a level not shown is not written');
}

// ======================================================================
// 7. the fun plan: off is nothing, reduced motion is the line alone
// ======================================================================
{
  assert.equal(m.funPlan({ minimalFun: false }, 'best'), null, 'fun off: no motif, no line');
  assert.deepEqual(m.funPlan({}, 'set'), { motion: 'toss', line: 'set' }, 'fun is on by default');
  assert.deepEqual(m.funPlan({}, 'best'), { motion: 'rain', line: 'best' }, 'a record gets the big one');
  assert.deepEqual(m.funPlan({}, 'done'), { motion: 'parade', line: 'done' });
  assert.deepEqual(m.funPlan({}, 'best', { reduced: true }), { motion: null, line: 'best' }, 'reduced motion: the line alone');
  assert.deepEqual(m.funPlan({}, 'idle'), { motion: 'stroll', line: null }, 'the idle stroller says nothing');
  assert.equal(m.funPlan({}, 'idle', { reduced: true }), null, 'and under reduced motion does nothing');
}

// ======================================================================
// 8. the auto-close decision
// ======================================================================
{
  assert.equal(m.staleWorkout(null, now), null);
  const stale = { startedAt: now - 5 * HOUR, entries: [{ sets: [set(80, 10, now - 4 * HOUR), set(80, 10, now - 4 * HOUR + 3 * MIN)] }] };
  assert.deepEqual(m.staleWorkout(stale, now), { action: 'finish', at: now - 4 * HOUR + 3 * MIN }, 'ends at the newest set');
  assert.equal(m.staleWorkout({ ...stale, entries: [{ sets: [set(80, 10, now - 2 * HOUR)] }] }, now), null, '2 h: still on');
  assert.deepEqual(m.staleWorkout({ startedAt: now - 4 * HOUR, entries: [{ sets: [] }] }, now), { action: 'discard' },
    'no set and that old: dropped');
  assert.equal(m.staleWorkout({ startedAt: now - HOUR, entries: [] }, now), null);
  assert.deepEqual(m.staleWorkout({ startedAt: now - 5 * HOUR, entries: [{ sets: [set(80, 10)] }] }, now),
    { action: 'finish', at: now - 5 * HOUR }, 'sets without `at`: the start is the reference');
}

// ======================================================================
// 9. the view: a tap logs exactly the fields on screen
// ======================================================================
const recorder = { calls: [], play(motion, line) { this.calls.push({ motion, line }); }, clear() { this.calls.push('clear'); } };
m.setFunStage(recorder);
const chipFor = (machineId, exercise = null, grip = null) => {
  const chips = m.seriesChips({ workouts: store.getWorkouts(), active: store.getActive(), layout: store.getLayout() });
  const i = chips.findIndex((c) => c.machineId === machineId && c.exercise === exercise && c.grip === grip);
  assert.ok(i >= 0, `a chip for ${machineId}`);
  return { id: '', dataset: { i: String(i) } };
};
const pickSeries = (machineId, exercise, grip) => click('#min-series', chipFor(machineId, exercise, grip));
{
  store.saveWorkouts([workout('h1', now - 2 * DAY, [store.newEntry(machine('lp'), null, [set(80, 12, now - 2 * DAY)])])]);
  store.clearActive();
  settings({ minimalExtras: undefined, minimalFun: undefined });
  m.renderMinimal(root, { entry: true });
  assert.ok(root.innerHTML.includes('id="min-view"'), 'the Minimal view renders');
  assert.ok(root.innerHTML.includes('id="minimal-toggle"') && root.innerHTML.includes('aria-pressed="true"'),
    'with its switch, on');
  assert.ok(!root.innerHTML.includes('id="min-done"'), 'no workout, no Done');

  pickSeries('lp');
  assert.ok(root.innerHTML.includes('Weight (kg)') && !root.innerHTML.includes('id="min-reps"'),
    'strength: ONE field, the weight');
  assert.ok(root.innerHTML.includes('>+ Reps</button>'), 'and the chip that adds the reps');
  recorder.calls = [];
  click('#min-log');
  const first = activeSets('lp');
  assert.equal(first.length, 1, 'the tap logged one set');
  assert.deepEqual(Object.keys(first[0]).sort(), ['at', 'weight'], 'a strength set is {weight, at}: no reps key at all');
  assert.equal(first[0].weight, 80, 'prefilled from the history (nextSetDefaults)');
  assert.ok(Number.isFinite(first[0].at), 'stamped');
  assert.deepEqual(recorder.calls, [{ motion: 'toss', line: recorder.calls[0]?.line }], 'one small effect');
  assert.ok(m.LINES.firstOfDay.includes(recorder.calls[0].line), 'the first set of the day says so');

  // the workout is one the full view can carry on with
  const a = store.getActive();
  assert.equal(a.currentMachineId, 'lp');
  assert.deepEqual(a.plan, [{ machineId: 'lp', exercise: null, free: true }], 'the machine has its slot');
  assert.equal(a.visits?.[0]?.machineId, 'lp', 'and its visit');
  const full = { ...root, innerHTML: '', querySelector: root.querySelector };
  renderTrain(full);
  assert.ok(full.innerHTML.includes('Log set') && full.innerHTML.includes('80 kg'), 'the full log screen shows it');
  assert.ok(!full.innerHTML.includes('undefined'), 'without an "undefined" for the missing reps');
  m.renderMinimal(root);
  assert.ok(root.innerHTML.includes('id="min-done"'), 'a running workout has Done');
  assert.ok(root.innerHTML.includes('id="min-today"') && root.innerHTML.includes('>80</button>'),
    'today\'s set reads "80", never "80×undefined"');

  // + Reps: the second field, and the set that carries it
  click('#min-extra');
  assert.deepEqual(store.getSettings().minimalExtras, { 'lp|': ['reps'] }, 'switched on for this series');
  assert.ok(root.innerHTML.includes('id="min-reps"'), 'the reps field shows');
  el('#min-weight').value = '82,5';
  el('#min-reps').value = '9';
  click('#min-log');
  assert.deepEqual(activeSets('lp').at(-1), { weight: 82.5, reps: 9, at: activeSets('lp').at(-1).at },
    'with the extra on: {weight, reps, at}');
  assert.equal(recorder.calls.at(-1).motion, 'rain', '82.5 beat 80: a new best gets the big effect');
  assert.ok(m.LINES.best.includes(recorder.calls.at(-1).line));
  el('#min-weight').value = '';
  el('#min-reps').value = '';
  click('#min-extra'); // and off again
  assert.equal(store.getSettings().minimalExtras.lp, undefined);
  assert.deepEqual(store.getSettings().minimalExtras, {}, 'switched off: the key is gone');
  click('#min-log');
  assert.deepEqual(Object.keys(activeSets('lp').at(-1)).sort(), ['at', 'weight'], 'off again: no reps');
  assert.equal(activeSets('lp').at(-1).weight, 82.5, 'the prefill follows the set just done');

  // bodyweight: the reps alone, + Weight adds the extra weight
  pickSeries('pu');
  assert.ok(!root.innerHTML.includes('id="min-weight"') && root.innerHTML.includes('id="min-reps"'), 'bodyweight: the reps');
  click('#min-log');
  assert.deepEqual(Object.keys(activeSets('pu')[0]).sort(), ['at', 'reps'], 'a bodyweight set is {reps, at}');
  assert.equal(store.getActive().currentMachineId, 'pu', 'the current machine moved…');
  assert.deepEqual(store.getActive().visits.map((v) => v.machineId), ['lp', 'pu'], '…through switchMachine');
  click('#min-extra');
  el('#min-weight').value = '5';
  click('#min-log');
  assert.deepEqual(Object.keys(activeSets('pu').at(-1)).sort(), ['at', 'reps', 'weight']);
  assert.equal(activeSets('pu').at(-1).weight, 5, '+ Weight: the added weight');
  el('#min-weight').value = '';

  // cardio: time + distance; a level only with + Level, and only from 1
  pickSeries('tm');
  assert.ok(root.innerHTML.includes('id="min-time"') && root.innerHTML.includes('id="min-distance"'), 'cardio: both');
  click('#min-log');
  assert.deepEqual(Object.keys(activeSets('tm')[0]).sort(), ['at', 'distance', 'seconds'], 'no level key');
  click('#min-extra');
  el('#min-level').value = '6';
  click('#min-log');
  assert.equal(activeSets('tm').at(-1).level, 6, '+ Level writes it');
  el('#min-level').value = '0';
  click('#min-log');
  assert.ok(!('level' in activeSets('tm').at(-1)), 'level 0 is none: absent');
  el('#min-level').value = '';

  // a multi-exercise machine logs the chosen exercise, a gripped series its grip
  pickSeries('db', 'Press');
  click('#min-log');
  assert.equal(store.getActive().entries.find((e) => e.machineId === 'db').exercise, 'Press');
  assert.ok(store.getActive().plan.some((p) => p.machineId === 'db'), 'its machine got a slot');
  pickSeries('ap');
  assert.ok(root.innerHTML.includes('Assist (kg)'), 'assisted: the assist');
  click('#min-log');
  assert.deepEqual(Object.keys(activeSets('ap')[0]).sort(), ['at', 'weight'], 'an assisted set is {weight, at}');
  const full2 = { ...root, innerHTML: '', querySelector: root.querySelector };
  renderTrain(full2);
  assert.ok(!full2.innerHTML.includes('undefined'), 'the full view renders the mixed workout cleanly');
}

// ======================================================================
// 10. removing a set: the first tap arms and does NOT re-render
// ======================================================================
{
  pickSeries('lp');
  const before = activeSets('lp');
  const n = before.length;
  const btn = { ...stubEl(), textContent: '82.5', dataset: { i: String(n - 1), at: String(before[n - 1].at) } };
  const html = root.innerHTML;
  root.innerHTML = 'sentinel';
  el('#min-today').listeners.click({ target: { closest: () => btn } });
  assert.equal(root.innerHTML, 'sentinel', 'the first tap re-renders nothing');
  assert.equal(btn.textContent, '✕ remove?', 'it arms the chip');
  assert.equal(activeSets('lp').length, n, 'and removes nothing');
  el('#min-today').listeners.click({ target: { closest: () => btn } });
  assert.equal(activeSets('lp').length, n - 1, 'the second tap removes the set');
  assert.deepEqual(activeSets('lp'), before.slice(0, -1), 'exactly that one');
  assert.notEqual(root.innerHTML, 'sentinel', 'and re-renders');
  assert.ok(html.length > 0);

  // two sets in one millisecond: the chip tapped is the one that goes
  const a = store.getActive();
  const lp = a.entries.find((e) => e.machineId === 'lp');
  const keep = lp.sets;
  lp.sets = [{ weight: 1, at: 5 }, { weight: 2, at: 5 }];
  store.saveActive(a);
  const twin = { ...stubEl(), textContent: '2', dataset: { i: '1', at: '5' } };
  el('#min-today').listeners.click({ target: { closest: () => twin } });
  el('#min-today').listeners.click({ target: { closest: () => twin } });
  assert.deepEqual(activeSets('lp'), [{ weight: 1, at: 5 }], 'a shared stamp removes the chip\'s own set');
  const b = store.getActive();
  b.entries.find((e) => e.machineId === 'lp').sets = keep;
  store.saveActive(b);
}

// ======================================================================
// 11. fun off: nothing plays — the set is logged all the same
// ======================================================================
{
  const fun = el('#min-fun');
  click('#min-fun');
  assert.equal(store.getSettings().minimalFun, false, 'the Fun chip turns it off');
  assert.ok(recorder.calls.includes('clear'), 'and clears what is playing');
  recorder.calls = [];
  const n = activeSets('lp').length;
  el('#min-weight').value = '200';
  click('#min-log');
  el('#min-weight').value = '';
  assert.equal(activeSets('lp').length, n + 1, 'the set is logged');
  assert.deepEqual(recorder.calls, [], 'no motif and no line, even for a new best');
  assert.equal(m.celebrate('done'), null, 'nothing for Done either');
  click('#min-fun');
  assert.equal(store.getSettings().minimalFun, undefined, 'on again is the default: the key is gone');
  assert.ok(fun.classList.contains('sel'), 'the chip says so in place');
}

// ======================================================================
// 12. Done: two taps, the second finishes
// ======================================================================
{
  m.renderMinimal(root);
  const done = el('#min-done');
  done.textContent = 'Done';
  const sets = store.getActive().entries.reduce((k, e) => k + e.sets.length, 0);
  recorder.calls = [];
  done.listeners.click();
  assert.ok(store.getActive(), 'the first tap only arms');
  assert.equal(done.textContent, 'Tap again to finish');
  done.listeners.click();
  assert.equal(store.getActive(), null, 'the second finishes');
  const w = store.getWorkouts().at(-1);
  assert.equal(w.entries.reduce((k, e) => k + e.sets.length, 0), sets, 'every set reached History');
  assert.ok(w.entries.find((e) => e.machineId === 'lp').sets.some((st) => !('reps' in st)), 'weight-only sets included');
  assert.ok(root.innerHTML.includes('Workout saved'), 'and says so');
  assert.equal(recorder.calls[0]?.motion, 'parade', 'with a parade');
}

// ======================================================================
// 13. the auto-close: finishedAt is the last set, not now
// ======================================================================
{
  const last = now - 4 * HOUR;
  store.saveActive({
    v: 2, id: 'stale', startedAt: now - 5 * HOUR, plan: [{ machineId: 'lp', exercise: null, free: true }],
    currentMachineId: 'lp', currentExercise: null, visits: [{ machineId: 'lp', in: now - 5 * HOUR }],
    entries: [store.newEntry(machine('lp'), null, [set(70, 10, now - 5 * HOUR), set(70, 10, last)])],
  });
  const count = store.getWorkouts().length;
  m.renderMinimal(root, { entry: true });
  assert.equal(store.getActive(), null, 'opening the view closed it');
  const w = store.getWorkouts().find((x) => x.id === 'stale');
  assert.ok(w, 'into History');
  assert.equal(w.finishedAt, last, 'ending at its last set, not now');
  assert.ok(w.updatedAt >= now, 'the sync stamp is the write\'s');
  assert.equal(w.visits[0].out, last, 'the open visit closes then too');
  assert.equal(store.getWorkouts().length, count + 1);
  assert.ok(root.innerHTML.includes('Your last workout was saved'), 'and the view says so');

  // no set and that old: dropped, nothing reaches History
  store.saveActive({ v: 2, id: 'empty', startedAt: now - 4 * HOUR, plan: [], currentMachineId: null, entries: [] });
  m.renderMinimal(root);
  assert.equal(store.getActive(), null, 'an empty stale workout is dropped');
  assert.ok(!store.getWorkouts().some((x) => x.id === 'empty'), 'without a record');

  // still current: kept
  store.saveActive({ v: 2, id: 'fresh', startedAt: now - 2 * HOUR, plan: [], currentMachineId: null,
    entries: [store.newEntry(machine('lp'), null, [set(70, 10, now - 2 * HOUR)])] });
  m.renderMinimal(root);
  assert.equal(store.getActive()?.id, 'fresh', 'two hours: still the workout');
  store.clearActive();
}

// ======================================================================
// 14. "+ New": a known name picks that machine, a new one gets its kind
// ======================================================================
{
  m.renderMinimal(root);
  click('#min-series', { id: 'min-new', dataset: {} });
  assert.ok(root.innerHTML.includes('id="min-new-name"'), '+ New opens the name field');
  assert.ok(['Weight', 'Reps', 'Time + distance'].every((k) => root.innerHTML.includes(`>${k}</button>`)), 'and the kind chips');
  const machines = store.getLayout().machines.length;

  el('#min-new-name').value = '   ';
  click('#min-new-kind', { dataset: { kind: 'strength' } });
  assert.equal(store.getLayout().machines.length, machines, 'no name, no machine');
  assert.equal(el('#min-new-msg').textContent, 'Type a name first.');

  el('#min-new-name').value = '  leg   PRESS ';
  click('#min-new-kind', { dataset: { kind: 'cardio' } });
  assert.equal(store.getLayout().machines.length, machines, 'a known name (any case, any spacing) adds no twin');
  assert.ok(!machine('lp').cardio, 'nor retypes it');
  assert.ok(root.innerHTML.includes('Weight (kg)') && root.innerHTML.includes('Leg press'), 'it picks that machine');

  // a machine that synced in after the render must survive the create:
  // the layout is read IN the tap, never through the render's copy
  click('#min-series', { id: 'min-new', dataset: {} });
  const synced = store.getLayout();
  synced.machines.push(mk('sy', 40, 'Synced in'));
  store.saveLayout(synced);
  el('#min-new-name').value = 'Hip thrust';
  click('#min-new-kind', { dataset: { kind: 'bodyweight' } });
  const layout = store.getLayout();
  const hip = layout.machines.find((x) => x.label === 'Hip thrust');
  assert.ok(hip, 'a new name creates the machine');
  assert.equal(hip.num, 41, 'under the next free number');
  assert.equal(hip.bodyweight, true, 'with the kind tapped');
  assert.ok(layout.machines.some((x) => x.id === 'sy'), 'and the synced-in machine survived');
  assert.ok(!store.getTombstones().machines.some((t) => t.id === 'sy'), 'untombstoned');
  assert.ok(root.innerHTML.includes('id="min-reps"') && root.innerHTML.includes('Hip thrust'), 'and it is on screen, ready to log');
  click('#min-log');
  assert.deepEqual(Object.keys(activeSets(hip.id)[0]).sort(), ['at', 'reps']);

  click('#min-series', { id: 'min-new', dataset: {} });
  el('#min-new-name').value = 'Rower';
  click('#min-new-kind', { dataset: { kind: 'cardio' } });
  assert.equal(store.getLayout().machines.find((x) => x.label === 'Rower')?.cardio, true, 'Time + distance: cardio');
  click('#min-series', { id: 'min-new', dataset: {} });
  el('#min-new-name').value = 'Chest press';
  click('#min-new-kind', { dataset: { kind: 'strength' } });
  const chest = store.getLayout().machines.find((x) => x.label === 'Chest press');
  assert.ok(chest && !chest.cardio && !chest.bodyweight && !chest.assisted, 'Weight: strength, no flag');
  el('#min-new-name').value = '';
  store.clearActive();
}

// ======================================================================
// 15. the switch: device-local, and the hub carries it
// ======================================================================
{
  settings({ minimal: true }); // the Minimal view is on show only while it is on
  const stamp = store.getSettings().updatedAt;
  const events = [];
  globalThis.window = new EventTarget();
  window.addEventListener('gymii:reroute', () => events.push('reroute'));
  m.renderMinimal(root);
  click('#minimal-toggle');
  assert.equal(store.getSettings().minimal, undefined, 'off is the absent key');
  click('#minimal-toggle');
  assert.equal(store.getSettings().minimal, true, 'on');
  assert.deepEqual(events, ['reroute', 'reroute'], 'each tap asks app.js to route again, in place');
  assert.equal(store.getSettings().updatedAt, stamp, 'device-local: the sync stamp does not move');
  delete globalThis.window;
  const hub = { ...root, innerHTML: '', querySelector: root.querySelector };
  renderTrain(hub);
  assert.ok(hub.innerHTML.includes('id="minimal-toggle"') && hub.innerHTML.includes('<h1>Train</h1>'),
    'the hub carries the switch, off');
  assert.ok(hub.innerHTML.includes('aria-pressed="false"'));
}

// ======================================================================
// 16. what Minimal has no screen for: a plan in the builder, a bind prompt
// ======================================================================
{
  store.clearActive();
  settings({ minimal: true });
  m.renderMinimal(root);
  assert.ok(!root.innerHTML.includes('id="min-plan"'), 'no plan waiting: no card');

  // an AI import hands its plan to the builder, then routes to #train —
  // which Minimal renders: the plan must not wait there unseen
  store.savePlan({ id: 'pw', name: 'Push <day>', items: [{ machineId: 'lp', exercise: null }] });
  openPlanBuilder('pw', 'Imported from AI — review, adjust, save.');
  m.renderMinimal(root);
  assert.ok(root.innerHTML.includes('id="min-plan"')
    && root.innerHTML.includes('Plan "Push &lt;day&gt;" is waiting for review in the plan builder.'),
    'Minimal names the waiting plan, escaped');
  const events = [];
  globalThis.window = new EventTarget();
  window.addEventListener('gymii:reroute', () => events.push('reroute'));
  click('#min-plan-open');
  delete globalThis.window;
  assert.equal(store.getSettings().minimal, undefined, 'one tap turns Minimal off');
  assert.deepEqual(events, ['reroute'], 'and routes again, in place');
  assert.equal(openBuilder()?.planId, 'pw', 'the builder still holds that plan: the full view opens on it');
  const full = { ...root, innerHTML: '', querySelector: root.querySelector };

  // a running workout outranks the builder (as in the full view): no card then
  settings({ minimal: true });
  store.saveActive({
    v: 2, id: 'w-bind', startedAt: Date.now(),
    plan: [{ machineId: null, name: 'Hack squat', exercise: null }, { machineId: 'lp', exercise: null }],
    binding: 0, currentMachineId: null, currentExercise: null, entries: [],
  });
  m.renderMinimal(root);
  assert.ok(!root.innerHTML.includes('id="min-plan"'), 'a workout runs: the builder waits, unannounced');

  // the bind prompt from the full view: a set logged here moves on from it,
  // as Skip would — the plan step stays unbound, never bound by guess
  pickSeries('lp');
  click('#min-log');
  const a = store.getActive();
  assert.ok(!('binding' in a), 'the bind prompt is answered by moving on');
  assert.equal(a.plan[0].machineId, null, 'its step stays unbound');
  assert.equal(activeSets('lp').length, 1, 'and the set went where it was logged');
  renderTrain(full);
  assert.ok(!full.innerHTML.includes('Which machine is this?'), 'the full view does not pop the old question');
  store.clearActive();
}

// the stub was the device; nothing else may have written outside it
assert.ok(mem.size > 0);
console.log('minimal mode: all assertions passed');
