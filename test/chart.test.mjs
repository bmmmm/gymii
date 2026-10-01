// Logic-level test for chart.js: tick math, the time axis, the markup of
// both charts and the tap/scrub/keyboard selection over a stub container.
// chart.js imports nothing, so no localStorage stub is needed.
// Run with: node test/chart.test.mjs
process.env.TZ = 'Europe/Berlin'; // the monthly axis crosses a DST change
import { strict as assert } from 'node:assert';

const { lineChart, barChart, niceTicks, timeTicks } = await import(new URL('../js/chart.js', import.meta.url).href);

const day = (y, m, d) => new Date(y, m - 1, d).getTime(); // local midnight
const count = (html, re) => (html.match(re) ?? []).length;
const labels = (ticks) => ticks.map((x) => x.label);
// every() over [] is vacuously true — never let a property check run on nothing
const all = (arr, pred) => arr.length > 0 && arr.every(pred);
// A stand-in for .chart-wrap: 520 px wide at left 0, so clientX == viewBox x.
const box = (over = {}) => ({
  innerHTML: '',
  getBoundingClientRect: () => ({ left: 0, width: 520 }),
  added: [],
  addEventListener(type) { this.added.push(type); },
  ...over,
});
const selCx = (html) => +html.match(/class="c-dot sel" cx="([\d.]+)"/)?.[1];

// --- niceTicks ---

assert.deepEqual(niceTicks(0, 100), [0, 25, 50, 75, 100], 'round steps over 0..100');
assert.deepEqual(niceTicks(57.5, 82.5), [50, 60, 70, 80, 90], 'ticks enclose the data');
for (const [lo, hi] of [[0, 3], [12, 13], [40, 40], [0, 0], [0, 12345], [2.5, 7.5]]) {
  const t = niceTicks(lo, hi);
  assert.ok(t.length >= 3 && t.length <= 6, `3–6 ticks for ${lo}..${hi}, got ${t}`);
  assert.ok(t[0] <= lo && t[t.length - 1] >= hi, `ticks span ${lo}..${hi}`);
}

// --- timeTicks: Mondays up to 6 weeks, month starts beyond ---

assert.deepEqual(labels(timeTicks(day(2026, 9, 1), day(2026, 10, 1))),
  ['7 Sep', '14 Sep', '21 Sep', '28 Sep'], 'a month span labels its Mondays');
assert.ok(all(timeTicks(day(2026, 10, 10), day(2026, 11, 15)), ({ t }) => new Date(t).getDay() === 1
  && new Date(t).getHours() === 0), 'weekly ticks sit on local Monday midnight, across the October DST change too');
// Sun 6 Sep → the Monday after is 1 day in, inside the 20-unit edge (≈1.3 days here)
assert.deepEqual(labels(timeTicks(day(2026, 9, 6), day(2026, 10, 6))),
  ['14 Sep', '21 Sep', '28 Sep'], 'a tick within 20 viewBox units of an edge is skipped');
assert.deepEqual(labels(timeTicks(day(2026, 7, 15), day(2027, 4, 15))),
  ['Sep', 'Nov', "Jan '27", 'Mar'], 'a 9-month span labels every 2nd month start, January with its year');
assert.ok(all(timeTicks(day(2026, 7, 15), day(2027, 4, 15)), ({ t }) => new Date(t).getDate() === 1
  && new Date(t).getHours() === 0), 'monthly ticks sit on local midnight of the 1st across DST');
for (const [a, b] of [[day(2026, 9, 1), day(2026, 10, 13)], [day(2024, 1, 1), day(2026, 10, 1)],
  [day(2016, 3, 1), day(2026, 10, 1)], [day(2026, 1, 1), day(2026, 12, 31)]]) {
  const t = timeTicks(a, b);
  assert.ok(t.length >= 1 && t.length <= 6, `1–6 labels, got ${labels(t)}`);
}
assert.ok(all(labels(timeTicks(day(2016, 3, 1), day(2026, 10, 1))), (l) => /^Jan '\d\d$/.test(l)),
  'a decade is labelled by years');
assert.deepEqual(timeTicks(day(2026, 9, 7), day(2026, 9, 7)), [], 'no span, no ticks (even on a Monday midnight)');

// --- lineChart markup ---

const pts = [
  { t: day(2026, 8, 10), v: 70, workoutId: 'a' },
  { t: day(2026, 8, 17), v: 75, workoutId: 'b' },
  { t: day(2026, 8, 27), v: 80, workoutId: 'c' },
  { t: day(2026, 9, 3), v: 82.5, workoutId: 'd' },
];

let c = box();
lineChart(c, pts, { unit: 'kg' });
assert.equal(count(c.innerHTML, /class="c-dot[ "]/g), 4, 'one dot per point');
assert.equal(count(c.innerHTML, /class="c-line"/g), 1, 'one line through them');
assert.equal(count(c.innerHTML, /class="c-dot sel"/g), 1, 'exactly one selected dot');
assert.ok(/class="c-dot sel" cx="[\d.]+" cy="[\d.]+" r="6"/.test(c.innerHTML), 'the selected dot is r=6');
assert.equal(selCx(c.innerHTML), 502, 'without selectedT the newest point is selected');
assert.ok(c.innerHTML.includes(`class="c-cursor" x1="${selCx(c.innerHTML).toFixed(1)}"`), 'the cursor stands at the selected x');
assert.ok(c.innerHTML.includes('82.5 kg · 3 Sep'), 'the label names value and date of the selection');
assert.ok(!c.innerHTML.includes('c-hit') && !c.innerHTML.includes('c-tip'), 'no tooltip remnants');
assert.ok(!c.innerHTML.includes('alt'), 'no second series unless asked');
assert.equal(c.tabIndex, 0, 'the chart is reachable by keyboard');

c = box();
lineChart(c, pts, { unit: 'kg', selectedT: day(2026, 8, 18) });
// 17 Aug is 7 of 24 days in: 42 + 7/24 · 460
assert.equal(selCx(c.innerHTML), 176.2, 'selectedT picks the nearest point');
assert.ok(c.innerHTML.includes('75 kg · 17 Aug'), 'the label follows selectedT');
assert.ok(c.innerHTML.includes('class="c-cursor" x1="176.2"'), 'the cursor follows selectedT');

c = box();
lineChart(c, [pts[0]], { unit: 'kg' });
assert.equal(count(c.innerHTML, /class="c-dot[ "]/g), 1, 'a lone point is one dot');
assert.ok(!c.innerHTML.includes('c-line'), 'a lone point draws no line');

c = box();
lineChart(c, pts, { unit: 'kg' });
lineChart(c, [], { unit: 'kg' });
assert.ok(c.innerHTML.includes('No data for this machine yet.'), 'empty series says so');
assert.equal(c.onpointerdown, null, 'an empty chart drops the previous chart\'s handlers');

c = box();
lineChart(c, pts, { unit: 'kg', xDomain: [day(2026, 9, 10), day(2026, 9, 20)] });
assert.ok(c.innerHTML.includes('No data in this range.'), 'nothing inside the domain says so');

c = box();
lineChart(c, pts, {
  unit: 'kg', second: { label: 'e1RM', points: pts.map((p) => ({ t: p.t, v: p.v * 1.2 })) },
});
assert.equal(count(c.innerHTML, /class="c-line alt"/g), 1, 'the second series is a dashed .alt path');
assert.ok(/class="c-key alt">e1RM</.test(c.innerHTML), 'the legend names the second series');
assert.equal(count(c.innerHTML, /class="c-dot[ "]/g), 4, 'the second series adds no selectable dots');

c = box();
lineChart(c, pts.slice(1), { label: 'Progress: "Row" <machine>' });
assert.ok(c.innerHTML.includes('aria-label="Progress: &quot;Row&quot; &lt;machine&gt;"'), 'label is escaped into the attribute');

// xDomain: the scale spans the domain, not the data
c = box();
lineChart(c, pts, { xDomain: [day(2026, 8, 13), day(2026, 9, 3)] });
assert.equal(count(c.innerHTML, /class="c-dot[ "]/g), 3, 'a point before the domain is left out');
assert.equal(selCx(c.innerHTML), 502, 'the domain end maps to the right edge');
c = box();
lineChart(c, pts.slice(2), { xDomain: [day(2026, 8, 6), day(2026, 9, 3)], selectedT: 0 });
// 27 Aug is 21 of 28 days into the domain: 42 + 0.75 · 460
assert.equal(selCx(c.innerHTML), 387, 'with xDomain the first point is NOT pinned to the left edge');
c = box();
const picked = [];
lineChart(c, pts, { xDomain: [day(2026, 8, 13), day(2026, 9, 3)], onSelect: (p, i) => picked.push([p.workoutId, i]) });
c.onpointerdown({ clientX: 1, pointerId: 1 });
assert.deepEqual(picked, [['b', 1]], 'onSelect indexes the caller\'s array, not the points left after the domain cut');

// --- interaction: tap, scrub, keyboard ---

c = box();
let calls = [];
let captured = null;
c.setPointerCapture = (id) => { captured = id; };
lineChart(c, pts, { unit: 'kg', selectedT: pts[0].t, onSelect: (p, i) => calls.push([p, i]) });
assert.equal(typeof c.onpointerdown, 'function', 'handlers are assigned as properties');
assert.deepEqual(c.added, [], 'addEventListener is never used — it would stack per redraw');
assert.equal(calls.length, 0, 'the draw itself reports nothing');
c.onpointerdown({ clientX: 519, pointerId: 7 });
assert.equal(captured, 7, 'pointerdown captures the pointer');
assert.equal(calls.length, 1, 'a tap on a new point reports once');
assert.equal(calls[0][0].workoutId, 'd', 'down@519 selects the last point, extra fields intact');
assert.equal(calls[0][1], 3, 'onSelect gets the index into the caller\'s array');
assert.equal(selCx(c.innerHTML), 502, 'the redraw moves the selection');
c.onpointermove({ clientX: 500 });
assert.equal(calls.length, 1, 'scrubbing within the same point reports nothing');
c.onpointermove({ clientX: 1 });
assert.equal(calls.length, 2, 'scrubbing to another point reports once');
assert.equal(calls[1][0].workoutId, 'a', 'move@1 while dragging selects the first point');
c.onpointerup({});
assert.equal(selCx(c.innerHTML), 42, 'the selection stays after the finger lifts');
c.onpointermove({ clientX: 519 });
assert.equal(calls.length, 2, 'moving without a pressed pointer selects nothing');
c.onpointerdown({ clientX: 519, pointerId: 8 });
c.onpointercancel({});
c.onpointermove({ clientX: 1 });
assert.equal(calls.length, 3, 'pointercancel ends the drag too');

const prevented = [];
const key = (k) => ({ key: k, preventDefault: () => prevented.push(k) });
c.onkeydown(key('ArrowLeft'));
assert.equal(calls.length, 4, 'ArrowLeft reports once');
assert.equal(calls[3][0].workoutId, 'c', 'ArrowLeft steps one point back');
c.onkeydown(key('ArrowRight'));
assert.equal(calls[4][0].workoutId, 'd', 'ArrowRight steps one point forward');
c.onkeydown(key('ArrowRight'));
assert.equal(calls.length, 5, 'stepping past the end does nothing');
c.onkeydown(key('Enter'));
assert.equal(calls.length, 5, 'other keys are not handled');
assert.ok(!prevented.includes('Enter'), 'other keys keep their default');

// a redraw replaces the handlers: only the newest onSelect hears the tap
const old = [];
const fresh = [];
c = box();
lineChart(c, pts, { onSelect: () => old.push(1) });
lineChart(c, pts, { onSelect: () => fresh.push(1) });
c.onpointerdown({ clientX: 1, pointerId: 1 });
assert.deepEqual([old.length, fresh.length], [0, 1], 'a redraw replaces the previous handlers');

// without a measurable container a tap is ignored, never a throw
for (const over of [{ getBoundingClientRect: undefined }, { getBoundingClientRect: () => ({ left: 0, width: 0 }) }]) {
  const quiet = [];
  c = box(over);
  lineChart(c, pts, { onSelect: () => quiet.push(1) });
  assert.doesNotThrow(() => c.onpointerdown({ clientX: 1, pointerId: 1 }), 'no rect, no throw');
  assert.equal(quiet.length, 0, 'no rect, no selection');
}

// --- barChart ---

const weeks = Array.from({ length: 12 }, (_, i) => ({ key: `w${i}`, label: `${i + 1} Sep`, v: i === 4 ? 0 : 3 + i }));
c = box();
let barCalls = [];
barChart(c, weeks, { unit: 'sets', onSelect: (b, i) => barCalls.push([b, i]) });
assert.equal(count(c.innerHTML, /<rect class="c-bar/g), 12, 'one bar per week');
assert.equal(count(c.innerHTML, /class="c-bar sel/g), 1, 'exactly one selected bar');
assert.ok(c.innerHTML.includes('class="c-bar sel" data-key="w11"'), 'without selectedKey the last bar is selected');
assert.ok(c.innerHTML.includes('<g class="c-bars has-sel">'), 'the group marks that a bar is selected');
assert.ok(/class="c-bar zero" data-key="w4"[^>]*height="2.0"/.test(c.innerHTML), 'a zero week is a 2-unit .zero stub');
assert.equal(count(c.innerHTML, /c-bar[^"]*zero/g), 1, 'only the zero week is a stub');
assert.ok(c.innerHTML.includes('>14 sets</text>'), 'the selected bar carries its value');
const xl = [...c.innerHTML.matchAll(/text-anchor="middle">([^<]+)<\/text>/g)].map((m) => m[1]);
assert.deepEqual(xl, ['3 Sep', '6 Sep', '9 Sep', 'now', '14 sets'], 'x labels every third week, the last reads "now"');
assert.equal(c.tabIndex, 0, 'the bar chart is reachable by keyboard');

c.onpointerdown({ clientX: 190, pointerId: 1 }); // column 3 spans 157–195 (38.3 units each from 42)
assert.equal(barCalls.length, 1, 'a column tap reports once');
assert.equal(barCalls[0][0].key, 'w3', 'the tap picks the column by its x band');
assert.ok(c.innerHTML.includes('class="c-bar sel" data-key="w3"'), 'the tapped bar is selected');
c.onpointerup({});
c.onkeydown(key('ArrowLeft'));
assert.equal(barCalls[1][1], 2, 'ArrowLeft steps one bar back');

c = box();
barChart(c, weeks, { selectedKey: 'w4' });
assert.ok(c.innerHTML.includes('class="c-bar sel zero" data-key="w4"'), 'selectedKey picks the bar, a zero one too');
assert.ok(c.innerHTML.includes('>0</text>'), 'a selected zero week says 0');

c = box();
barChart(c, weeks);
barChart(c, []);
assert.ok(c.innerHTML.includes('No data yet.') && c.onpointerdown === null, 'no bars: text, no handlers');

console.log('chart: all assertions passed');
