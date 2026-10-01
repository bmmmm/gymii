// SVG charts for History: lineChart (time on x, optional dashed second
// series) and barChart (one column per bucket). Both keep ONE point/column
// selected — tap, drag to scrub, or ArrowLeft/Right — and the selection
// stays when the finger lifts; there is no tooltip, the selected value is
// drawn in the chart and onSelect hands the point back to the caller.
// Colors #35a273 (line, dots, bars) and #3f7fd1 (dashed second series)
// pass the dataviz six checks together against the dark surface #171c22 —
// change them with css/style.css (.c-line, .c-dot, .c-bar) and re-validate.
// Imports nothing; every caller string (label, unit, keys) is escaped here,
// so callers pass raw text.

const W = 520;
const DAY_MS = 86400000;
// Fixed month names, not toLocaleDateString: en-GB says "Sept" on newer
// ICU builds, and labels must not change with the runtime.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const fmtDay = (t) => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const fmtVal = (v, unit) => `${Math.round(v * 100) / 100}${unit ? ` ${unit}` : ''}`;

// Interaction shared by both charts. Handlers are PROPERTIES on the
// container: a redraw replaces them, where addEventListener would stack one
// more set per redraw. The container (.chart-wrap) is measured, never the
// svg — the svg is replaced on every selection change.
// Nothing is picked on pointerdown: a touch that starts on the chart may be
// a page scroll (touch-action: pan-y lets the browser take it over and send
// pointercancel), and picking at once selected the week bar under the
// finger — the tiles then showed that week's zeros mid-scroll (2026-10-01).
// A tap picks on pointerup; a drag picks once the finger moved more across
// than down, and follows from there.
const DRAG_PX = 8; // tap slop in CSS px, either axis
function interactive(container, { count, sel, indexAt, draw, report }) {
  let press = null; // {x, y, drag, scroll} while a pointer is down
  const select = (i) => {
    if (i === sel || i < 0 || i >= count) return;
    sel = i;
    draw(sel);
    report(sel);
  };
  const pick = (clientX) => {
    const r = container.getBoundingClientRect?.();
    if (!r?.width) return;
    select(indexAt(((clientX - r.left) / r.width) * W));
  };
  container.tabIndex = 0;
  container.onpointerdown = (e) => {
    container.setPointerCapture?.(e.pointerId);
    press = { x: e.clientX, y: e.clientY ?? 0, drag: false, scroll: false };
  };
  container.onpointermove = (e) => {
    if (!press) return;
    if (!press.drag) {
      const dx = Math.abs(e.clientX - press.x);
      const dy = Math.abs((e.clientY ?? 0) - press.y);
      if (dx >= DRAG_PX && dx >= dy) press.drag = true;
      else if (dy >= DRAG_PX) press.scroll = true; // a mouse can scroll too
      if (!press.drag) return;
    }
    pick(e.clientX);
  };
  container.onpointerup = (e) => {
    if (press && !press.drag && !press.scroll) pick(e.clientX);
    press = null;
  };
  container.onpointercancel = () => { press = null; };
  container.onkeydown = (e) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!step) return;
    e.preventDefault?.();
    select(sel + step);
  };
  draw(sel);
}

// An empty chart must not keep the previous chart's handlers: they would
// redraw the old chart over the empty text on the next tap.
function inert(container, text) {
  container.onpointerdown = container.onpointermove = null;
  container.onpointerup = container.onpointercancel = container.onkeydown = null;
  container.removeAttribute?.('tabindex');
  container.innerHTML = `<p class="muted">${text}</p>`;
}

const gridHtml = (ticks, Y, pad) => ticks.map((v) => `
  <line class="c-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/>
  <text class="c-tick" x="${pad.l - 8}" y="${Y(v)}" text-anchor="end"
    dominant-baseline="central">${v}</text>`).join('');

// points: [{t, v, ...}] ascending by t; extra fields (workoutId) are handed
// back untouched by onSelect(point, indexInPoints). selectedT picks the
// initial selection (nearest t, default the newest); onSelect fires only
// when the selection CHANGES, never on the draw itself. xDomain [t0, t1]
// fixes the x scale; points outside it are left out.
export function lineChart(container, points, {
  unit = '', label = 'Top set weight over time', name = 'Top set',
  second = null, selectedT = null, onSelect = null, xDomain = null,
} = {}) {
  const shown = (p) => Number.isFinite(p?.t) && Number.isFinite(p?.v)
    && (!xDomain || (p.t >= xDomain[0] && p.t <= xDomain[1]));
  const vis = points.map((p, i) => ({ p, i })).filter(({ p }) => shown(p));
  if (!vis.length) {
    inert(container, points.length ? 'No data in this range.' : 'No data for this machine yet.');
    return;
  }
  const alt = (second?.points ?? []).filter(shown);

  const H = 240;
  const pad = { l: 42, r: 18, t: 16, b: 28 };
  const ts = [...vis.map(({ p }) => p.t), ...alt.map((p) => p.t)];
  let [x0, x1] = xDomain ?? [Math.min(...ts), Math.max(...ts)];
  if (x0 === x1) { x0 -= DAY_MS / 2; x1 += DAY_MS / 2; } // lone point: pad half a day

  const ys = [...vis.map(({ p }) => p.v), ...alt.map((p) => p.v)]; // one axis for both series
  const ticks = niceTicks(Math.min(...ys), Math.max(...ys));
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const X = (t) => pad.l + ((t - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - ((v - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);
  const pathOf = (ps) => ps.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`).join('');

  const xs = vis.map(({ p }) => X(p.t));
  const nearest = (arr, x) => arr.reduce((best, a, k) => (Math.abs(a - x) < Math.abs(arr[best] - x) ? k : best), 0);
  const sel = selectedT == null ? vis.length - 1 : nearest(vis.map(({ p }) => p.t), selectedT);

  const xLabels = timeTicks(x0, x1, W - pad.l - pad.r).map(({ t, label: l }) => `
    <text class="c-tick" x="${X(t).toFixed(1)}" y="${H - 8}" text-anchor="middle">${l}</text>`).join('');
  const mainPath = vis.length > 1 ? `<path class="c-line" d="${pathOf(vis.map(({ p }) => p))}"/>` : '';
  const altPath = alt.length > 1 ? `<path class="c-line alt" d="${pathOf(alt)}"/>` : '';
  const legend = altPath ? `
    <div class="c-legend"><span class="c-key">${esc(name)}</span><span class="c-key alt">${esc(second.label ?? '')}</span></div>` : '';

  const draw = (s) => {
    const p = vis[s].p;
    const cx = xs[s];
    const cy = Y(p.v);
    const anchor = cx > W - pad.r - 70 ? 'end' : cx < pad.l + 70 ? 'start' : 'middle';
    container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img"
      aria-label="${esc(label)}">
      ${gridHtml(ticks, Y, pad)}
      ${xLabels}
      <line class="c-cursor" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${pad.t}" y2="${H - pad.b}"/>
      ${altPath}
      ${mainPath}
      ${vis.map((v, k) => `
        <circle class="c-dot${k === s ? ' sel' : ''}" cx="${xs[k].toFixed(1)}" cy="${Y(v.p.v).toFixed(1)}" r="${k === s ? 6 : 4}"/>`).join('')}
      <text class="c-label" x="${cx.toFixed(1)}" y="${(cy - 12 < 12 ? cy + 24 : cy - 12).toFixed(1)}"
        text-anchor="${anchor}">${esc(`${fmtVal(p.v, unit)} · ${fmtDay(p.t)}`)}</text>
    </svg>${legend}`;
  };
  interactive(container, {
    count: vis.length,
    sel,
    indexAt: (vx) => nearest(xs, vx),
    draw,
    report: (s) => onSelect?.(vis[s].p, vis[s].i),
  });
}

// bars: [{key, label, v}] oldest first, one column each. A zero column is a
// 2-unit stub so it reads as 0, not as missing. x labels on every third
// column counted back from the last, which reads "now". selectedKey picks
// the initial column (default the last); onSelect(bar, i) on change only.
export function barChart(container, bars, {
  unit = '', label = 'Bar chart', selectedKey = null, onSelect = null,
} = {}) {
  if (!bars.length) {
    inert(container, 'No data yet.');
    return;
  }
  const H = 200;
  const pad = { l: 42, r: 18, t: 22, b: 28 };
  const n = bars.length;
  const vals = bars.map((b) => (b.v > 0 ? b.v : 0));
  const ticks = niceTicks(0, Math.max(...vals));
  const top = ticks[ticks.length - 1];
  const Y = (v) => H - pad.b - (v / (top || 1)) * (H - pad.t - pad.b);
  const col = (W - pad.l - pad.r) / n;
  const bw = col * 0.7;
  const left = (i) => pad.l + i * col + (col - bw) / 2;
  const found = bars.findIndex((b) => b.key === selectedKey);
  const sel = found < 0 ? n - 1 : found;

  const xLabels = bars.map((b, i) => ((n - 1 - i) % 3 ? '' : `
    <text class="c-tick" x="${(left(i) + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${i === n - 1 ? 'now' : esc(b.label ?? '')}</text>`)).join('');

  const draw = (s) => {
    const rects = bars.map((b, i) => {
      const zero = !vals[i];
      const y = zero ? Y(0) - 2 : Y(vals[i]);
      return `
      <rect class="c-bar${i === s ? ' sel' : ''}${zero ? ' zero' : ''}" data-key="${esc(b.key)}"
        x="${left(i).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(Y(0) - y).toFixed(1)}" rx="3"/>`;
    }).join('');
    const valueY = (vals[s] ? Y(vals[s]) : Y(0) - 2) - 6;
    container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img"
      aria-label="${esc(label)}">
      ${gridHtml(ticks, Y, pad)}
      ${xLabels}
      <g class="c-bars has-sel">${rects}
      </g>
      <text class="c-label" x="${(left(s) + bw / 2).toFixed(1)}" y="${valueY.toFixed(1)}"
        text-anchor="middle">${esc(fmtVal(vals[s], unit))}</text>
    </svg>`;
  };
  interactive(container, {
    count: n,
    sel,
    indexAt: (vx) => Math.min(n - 1, Math.max(0, Math.floor((vx - pad.l) / col))),
    draw,
    report: (s) => onSelect?.(bars[s], s),
  });
}

// 3–6 round tick values spanning [min, max].
export function niceTicks(min, max) {
  if (min === max) {
    min = Math.max(0, min - 5);
    max += 5;
  }
  const raw = (max - min) / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / pow;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * pow;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

// Date labels for a time axis [x0, x1] (ms): Mondays ("8 Sep") for spans up
// to 6 weeks, month starts ("Sep", January as "Jan '27") beyond — at most 6,
// none within 20 viewBox units of either end of a plot `span` units wide.
// Local midnight, stepped by calendar (setDate/setMonth), so DST weeks hold.
export function timeTicks(x0, x1, span = W - 60) {
  if (!(x1 > x0)) return [];
  const edge = (20 / span) * (x1 - x0);
  const fits = (t) => t - x0 >= edge && x1 - t >= edge;
  const d = new Date(x0);
  d.setHours(0, 0, 0, 0);
  const out = [];
  if (x1 - x0 <= 42 * DAY_MS) {
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7)); // the first Monday on or after x0's day
    for (; d.getTime() <= x1; d.setDate(d.getDate() + 7)) {
      if (fits(d.getTime())) out.push({ t: d.getTime(), label: fmtDay(d) });
    }
    return out; // ≤ 6 by construction: 42 days minus both edges hold six Mondays at most
  }
  d.setDate(1);
  if (d.getTime() < x0) d.setMonth(d.getMonth() + 1);
  for (; d.getTime() <= x1; d.setMonth(d.getMonth() + 1)) {
    if (!fits(d.getTime())) continue;
    const m = d.getMonth();
    out.push({
      t: d.getTime(),
      label: m ? MONTHS[m] : `Jan '${String(d.getFullYear()).slice(-2)}`,
      abs: d.getFullYear() * 12 + m,
    });
  }
  // a step that lands on January, so the year label survives thinning
  const k = [1, 2, 3, 6].find((s) => Math.ceil(out.length / s) <= 6) ?? 12 * Math.ceil(out.length / 72);
  return out.filter((o) => o.abs % k === 0).map(({ t, label }) => ({ t, label }));
}
