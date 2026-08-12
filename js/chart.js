// Minimal single-series SVG line chart: time on x, value on y.
// Chart color #35a273 is validated (dataviz six checks) against the
// dark surface #171c22 — change both together if the theme moves.

export function lineChart(container, points, { unit = '', label = 'Top set weight over time' } = {}) {
  if (!points.length) {
    container.innerHTML = '<p class="muted">No data for this machine yet.</p>';
    return;
  }

  const W = 520;
  const H = 240;
  const pad = { l: 42, r: 18, t: 16, b: 28 };

  let x0 = points[0].t;
  let x1 = points[points.length - 1].t;
  if (x0 === x1) { x0 -= 43200000; x1 += 43200000; } // lone point: pad half a day

  const ys = points.map((p) => p.v);
  const ticks = niceTicks(Math.min(...ys), Math.max(...ys));
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];

  const X = (t) => pad.l + ((t - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - ((v - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);

  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`).join('');
  const fmtD = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const lastP = points[points.length - 1];

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img"
      aria-label="${label}">
      ${ticks.map((v) => `
        <line class="c-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/>
        <text class="c-tick" x="${pad.l - 8}" y="${Y(v)}" text-anchor="end"
          dominant-baseline="central">${v}</text>`).join('')}
      <text class="c-tick" x="${pad.l}" y="${H - 8}" text-anchor="start">${fmtD(points[0].t)}</text>
      ${points.length > 1
        ? `<text class="c-tick" x="${W - pad.r}" y="${H - 8}" text-anchor="end">${fmtD(lastP.t)}</text>`
        : ''}
      ${points.length > 1 ? `<path class="c-line" d="${path}"/>` : ''}
      ${points.map((p, i) => `
        <circle class="c-dot" cx="${X(p.t).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="4"/>
        <circle class="c-hit" cx="${X(p.t).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="14" data-i="${i}"/>`).join('')}
      <text class="c-label" x="${X(lastP.t).toFixed(1)}"
        y="${(Y(lastP.v) - 12 < 12 ? Y(lastP.v) + 24 : Y(lastP.v) - 12).toFixed(1)}"
        text-anchor="${points.length > 1 ? 'end' : 'middle'}">${lastP.v} ${unit}</text>
    </svg>
    <div class="c-tip" hidden></div>`;

  const tip = container.querySelector('.c-tip');
  container.querySelectorAll('.c-hit').forEach((hit) => {
    const show = () => {
      const p = points[+hit.dataset.i];
      tip.textContent = `${fmtD(p.t)} — ${p.v} ${unit}`;
      tip.hidden = false;
      const cr = container.getBoundingClientRect();
      const hr = hit.getBoundingClientRect();
      tip.style.left = `${hr.left + hr.width / 2 - cr.left}px`;
      tip.style.top = `${hr.top - cr.top}px`;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
  });
}

// 3–6 round tick values spanning [min, max].
function niceTicks(min, max) {
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
