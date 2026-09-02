// Logic-level test for js/ui.js — the shared helpers every screen formats
// and renders through. They carried no file of their own; the only ui
// assertions in the repo were a WAV block wedged into store.test.mjs.
// Run with: node test/ui.test.mjs

// UTC+13, and deliberately not Berlin: only well east of UTC does the
// local-vs-UTC bug in dateValue/timeValue reproduce at all — a late
// afternoon here is still YESTERDAY by toISOString. Set before any Date
// exists; the static imports below never look at the clock.
process.env.TZ = 'Pacific/Auckland';

import { strict as assert } from 'node:assert';

const ui = await import(new URL('../js/ui.js', import.meta.url).href);

// --- local time, not UTC ---

// 2026-01-01 21:00 UTC is already 2026-01-02, 10:00, in Auckland.
const evening = Date.UTC(2026, 0, 1, 21, 0);
assert.equal(ui.dateValue(evening), '2026-01-02',
  'the date input gets the LOCAL day — toISOString would hand it the day before');
assert.equal(ui.timeValue(evening), '10:00', 'and the local time with it');
assert.equal(ui.pad2(7), '07');
assert.equal(ui.pad2(70), '70', 'padding never truncates');

// --- durations ---

assert.equal(ui.fmtDuration(0), '0:00');
assert.equal(ui.fmtDuration(72), '1:12');
assert.equal(ui.fmtDuration(600), '10:00');
assert.equal(ui.fmtDuration(90.4), '1:30', 'fractional seconds round');
assert.equal(ui.fmtDuration(undefined), '0:00', 'imported data may have no seconds at all');
assert.equal(ui.fmtDuration(-5), '0:00', 'and it may have nonsense; never render a negative clock');

assert.equal(ui.minsBetween(0, 60000), 1);
assert.equal(ui.minsBetween(0, 4_320_000), 72);
assert.equal(ui.minsBetween(0, 1000), 1, 'a workout is never zero minutes long');
assert.equal(ui.minsBetween(5000, 0), 1, 'and a back-logged, reversed span clamps instead of going negative');

// --- words ---

assert.equal(ui.plural(1, 'set'), '1 set');
assert.equal(ui.plural(0, 'set'), '0 sets', 'zero is plural, as in English');
assert.equal(ui.plural(3, 'machine'), '3 machines');

assert.equal(ui.esc('&<>"\''), '&amp;&lt;&gt;&quot;&#39;', 'all five entities');
assert.equal(ui.esc('<b>'), '&lt;b&gt;', 'the ampersand of an escape is not escaped again');
assert.equal(ui.esc('a & b'), 'a &amp; b');
assert.equal(ui.esc(null), 'null', 'never throws on a missing label');

// --- set lines ---

const kg = { unit: 'kg' };
assert.equal(ui.setStr({ reps: 10, weight: 40 }, kg), '40×10');
assert.equal(ui.setStr({ reps: 10, weight: 0 }, kg, true), 'BW×10', 'bodyweight with no added load');
assert.equal(ui.setStr({ reps: 10, weight: 5 }, kg, true), 'BW+5×10');
assert.equal(ui.setStr({ distance: 2000, seconds: 600 }, kg), '2000 m · 10:00');
assert.equal(ui.setStr({ distance: 1.5, seconds: 600 }, { unit: 'lb' }), '1.5 mi · 10:00',
  'distances follow the weight unit');
// distance 0 is a REAL cardio set (a warm-up on the spot, an imported row).
// A truthy check here would fall through to the strength branch and render
// "undefined×undefined".
assert.equal(ui.setStr({ distance: 0, seconds: 45 }, kg), '0 m · 0:45',
  'a zero distance is still a cardio set');

// --- rollups ---

const wo = (sets) => ({ entries: [{ sets }] });
assert.equal(ui.workoutTotals(wo([{ reps: 10, weight: 40 }, { reps: 8, weight: 45 }]), kg), '760 kg');
assert.equal(ui.workoutTotals(wo([{ distance: 3200, seconds: 900 }]), kg), '3200 m',
  'a pure cardio workout does not read "0 kg"');
assert.ok(!ui.workoutTotals(wo([{ distance: 3200, seconds: 900 }]), kg).includes('0 kg'));
assert.equal(ui.workoutTotals(wo([{ reps: 10, weight: 40 }, { distance: 500, seconds: 120 }]), kg),
  '400 kg · 500 m', 'a mixed workout reports both');
assert.equal(ui.workoutTotals(wo([{ reps: 10 }]), kg), '0 kg',
  'a set with no weight contributes 0, not NaN');
assert.equal(ui.workoutTotals(wo([]), kg), '0 kg', 'and an empty workout says so');

assert.equal(ui.machineChain({ entries: [{ num: 3 }, { num: 7 }] }), '#3 → #7');
assert.equal(ui.machineChain({ entries: [{ num: 16 }, { num: 16 }] }), '#16',
  'two exercises at one machine are one stop, not "#16 → #16"');

// --- stepperField markup, which initSteppers depends on ---

const field = ui.stepperField('Weight', 'set-weight', { step: 2.5, min: 0, value: 40 });
assert.ok(field.includes('data-step="2.5"') && field.includes('data-min="0"'),
  'the delegated handler reads its step and floor off the wrapper');
assert.ok(field.includes('id="set-weight"') && field.includes('value="40"'));
assert.ok(field.includes('inputmode="decimal"'), 'decimal by default');
assert.ok(ui.stepperField('Reps', 'set-reps', { step: 1, min: 1, value: 8, mode: 'numeric' })
  .includes('inputmode="numeric"'), 'and numeric on request');
assert.ok(field.includes('aria-label="increase weight"') && field.includes('aria-label="decrease weight"'),
  'the +/− buttons are named for a screen reader');

// ---------------------------------------------------------------------------
// The DOM-facing helpers, over hand-made stubs. jsdom would be a dependency
// for four functions whose whole contract is which method they call.
// ---------------------------------------------------------------------------

const docHandlers = {};
globalThis.document = {
  addEventListener(type, fn) { (docHandlers[type] ||= []).push(fn); },
};
const fire = (type, event) => (docHandlers[type] || []).forEach((fn) => fn(event));

// --- initSteppers ---

ui.initSteppers();

const makeStepper = ({ step, min, value }) => {
  const input = { value: String(value), events: [], dispatchEvent(e) { this.events.push(e.type); } };
  const wrap = { dataset: { step: String(step), ...(min === undefined ? {} : { min: String(min) }) },
    querySelector: () => input };
  const button = (kind) => ({
    classList: { contains: (c) => c === kind },
    closest: (sel) => (sel === '.stepper' ? wrap : button(kind)),
  });
  return { input, up: button('step-up'), down: button('step-down') };
};

// Float arithmetic must not leak into a field: 0.2 + 0.1 is
// 0.30000000000000004, and that string in a weight input is unusable.
const tenth = makeStepper({ step: 0.1, min: 0, value: 0.2 });
fire('click', { target: tenth.up });
assert.equal(tenth.input.value, '0.3', 'the value is rounded, not shown as 0.30000000000000004');
assert.deepEqual(tenth.input.events, ['change'],
  'and a change event fires — without it the log button keeps naming the old weight');

const floored = makeStepper({ step: 2.5, min: 0, value: 1 });
fire('click', { target: floored.down });
assert.equal(floored.input.value, '0', 'data-min is a floor, never a negative weight');

const empty = makeStepper({ step: 1, min: 0, value: '' });
fire('click', { target: empty.up });
assert.equal(empty.input.value, '1', 'an empty field counts as 0 rather than NaN');

// A click anywhere else must not be mistaken for a stepper
fire('click', { target: { closest: () => null } });

// --- initNumericOverwrite ---

ui.initNumericOverwrite();

const numField = { tagName: 'INPUT', type: 'number', value: '40', placeholder: '', dataset: {} };
fire('focusin', { target: numField });
assert.equal(numField.value, '', 'the number pad starts on an empty field');
assert.equal(numField.placeholder, '(40)', 'with the old value greyed out for orientation');
fire('focusout', { target: numField });
assert.equal(numField.value, '40', 'leaving without typing puts it back');
assert.equal(numField.placeholder, '', 'and the placeholder with it');

fire('focusin', { target: numField });
numField.value = '45';
fire('focusout', { target: numField });
assert.equal(numField.value, '45', 'a typed value survives the restore');

// A TEXT field must be left alone: the gym name emptying itself on a tap
// is exactly what the type check prevents.
const textField = { tagName: 'INPUT', type: 'text', value: 'Home gym', placeholder: '', dataset: {} };
fire('focusin', { target: textField });
assert.equal(textField.value, 'Home gym', 'a text field is not a number pad');
assert.equal(textField.dataset.prevValue, undefined);

// --- twoTapConfirm ---

const armBtn = { textContent: 'Delete', classes: new Set(),
  classList: { contains(c) { return armBtn.classes.has(c); },
    add(c) { armBtn.classes.add(c); }, remove(c) { armBtn.classes.delete(c); } } };
assert.equal(ui.twoTapConfirm(armBtn, 'Tap again', 'Delete'), false, 'the first tap only arms');
assert.equal(armBtn.textContent, 'Tap again');
assert.equal(ui.twoTapConfirm(armBtn, 'Tap again', 'Delete'), true, 'the second tap confirms');
assert.equal(armBtn.textContent, 'Delete',
  'and the label is restored here — a caller that does not re-render would say "Tap again" forever');
assert.ok(!armBtn.classes.has('armed'), 'disarmed again');

// --- keepInView ---

const seen = { scroll: null, focused: 0 };
const viewEl = {
  scrollIntoView(opts) { seen.scroll = opts; },
  focus() { seen.focused += 1; },
};
const viewRoot = { querySelector: (sel) => (sel === '#there' ? viewEl : null) };
ui.keepInView(viewRoot, '#there');
assert.deepEqual(seen.scroll, { block: 'center' },
  'centered and instant — a smooth scroll fights the thumb already moving');
assert.equal(seen.focused, 0,
  'and NO focus by default, or a number field would pop the keyboard');
ui.keepInView(viewRoot, '#there', { focus: true });
assert.equal(seen.focused, 1, 'focus only when asked for');
ui.keepInView(viewRoot, '#missing'); // a selector that renders nothing must not throw
ui.keepInView({}, '#there'); // nor a root without querySelector

// ---------------------------------------------------------------------------
// The timer sounds — moved here from store.test.mjs, where they only ever
// sat because ui.js had no file. What stays there is the COUPLING: that the
// stored default names a real entry.
// ---------------------------------------------------------------------------

for (const [name, snd] of Object.entries(ui.TIMER_SOUNDS)) {
  assert.ok(snd.label && Array.isArray(snd.notes) && snd.notes.length,
    `${name} has a label and notes`);
  snd.notes.forEach(([at, freq]) => {
    assert.ok(Number.isFinite(at) && at >= 0 && Number.isFinite(freq) && freq > 0,
      `${name} notes are [offset, hz] pairs`);
  });
}

// the WAV renderer is pure and testable headless: valid RIFF/WAVE header,
// the exact length its notes demand, and actual signal in the data
const wav = new DataView(ui.renderWav(ui.TIMER_SOUNDS.double.notes));
const tag = (off) => String.fromCharCode(
  wav.getUint8(off), wav.getUint8(off + 1), wav.getUint8(off + 2), wav.getUint8(off + 3));
assert.equal(tag(0), 'RIFF');
assert.equal(tag(8), 'WAVE');
assert.equal(tag(36), 'data');
const expectedSamples = Math.ceil((0.35 + 0.3) * 44100); // last note offset + note length
assert.equal(wav.byteLength, 44 + expectedSamples * 2, 'wav sized to the notes');
assert.equal(wav.getUint32(40, true), expectedSamples * 2, 'data chunk length matches');
let nonzero = false;
for (let i = 0; i < 2000 && !nonzero; i++) nonzero = wav.getInt16(44 + i * 2, true) !== 0;
assert.ok(nonzero, 'the wav actually carries signal');

// The gesture prime plays SILENCE, so it can never leak an audible note the
// way pausing a real sound mid-play did (a tone fired right after "Log set",
// then again at zero). A zero-frequency note must render pure zeros.
const silent = new DataView(ui.renderWav([[0, 0]]));
let silentPeak = 0;
for (let i = 0; i < (silent.byteLength - 44) / 2; i++) {
  silentPeak = Math.max(silentPeak, Math.abs(silent.getInt16(44 + i * 2, true)));
}
assert.equal(silentPeak, 0, 'the priming wav is pure silence');

// no Audio element in Node — playback must stay a silent no-op, never throw
ui.playTimerSound('double');
ui.playTimerSound('no-such-sound');
ui.primeAudio();

// Deliberately not tested: download() (three browser APIs and no logic of
// its own) and fmtDate/fmtTime (their output is Node's ICU data, so a
// pinned string would go red on an ICU update without a bug in gymii).

console.log('ui helpers: all assertions passed');
