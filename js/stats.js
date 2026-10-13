// Pure History analytics — no DOM, no localStorage, NO imports (like
// merge.js). Everything takes the workouts, the layout and `now` as
// arguments, so it tests without a clock or a browser, and every string it
// returns is RAW: the UI escapes.
//
// Time: only DIFFERENCES between stamps of the same kind are used (`at` to
// `at`, visit `in` to `out`), never `at − startedAt` — workouts whose date
// was edited before shiftWorkout existed moved `startedAt` alone, so that
// difference is garbage for them while `at`-to-`at` stays true. `at` is the
// END of a set and optional: older and typed-in sets carry none, and every
// reader here guards for it.
//
// Insight rules, thresholds and their sources are documented in
// docs/insights.md — change both together.

const DAY_MS = 86400000; // only to ROUND calendar-day differences, never to step

// Local midnight as a Date. A COPY of store.js's startOfDay — store.js holds
// THE definition; this module imports nothing, so test/stats.test.mjs pins
// the two equal across a DST day. Exported for that pin only: callers
// import store.js's.
export const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

// Local midnight of the Monday of t's week. Days step via setDate(), never
// DAY_MS multiples, which drift an hour across DST transitions.
export const mondayOf = (t) => {
  const d = startOfDay(t);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
};

// Whole calendar days from t to now (0 = today). Rounding absorbs the DST hour.
const daysBetween = (t, now) => Math.round((startOfDay(now) - startOfDay(t)) / DAY_MS);

const finite = Number.isFinite;
const setVolume = (st) => st.reps * st.weight || 0;
const isRir = (v) => v === 0 || v === 1 || v === 2 || v === 3;
const byStart = (workouts) => [...workouts].sort((a, b) => a.startedAt - b.startedAt);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
// up to `d` decimals, trailing zeros dropped: 57.5, 60, 1.75
const num = (n, d = 1) => String(Math.round(n * 10 ** d) / 10 ** d);

// Linear-interpolation quantile over an ascending array.
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// machineId -> [[muscle, weight]], for RESISTANCE machines only: a
// treadmill tagged Calves is not a calf set. A primary muscle
// (`machine.muscles`) counts a set as 1, a secondary one
// (`machine.secondaryMuscles`) as ½ — the triceps on a chest press work,
// but not like on a pushdown. Resolved against the live layout, like
// store's usageByMuscle (entries don't snapshot muscles).
const resistanceMuscles = (layout) => new Map((layout?.machines ?? [])
  .filter((m) => !m.cardio && (m.muscles?.length || m.secondaryMuscles?.length))
  .map((m) => [m.id, [
    ...(m.muscles ?? []).map((mu) => [mu, 1]),
    ...(m.secondaryMuscles ?? []).filter((mu) => !(m.muscles ?? []).includes(mu)).map((mu) => [mu, 0.5]),
  ]]));

// `weeks` Monday starts, oldest first, ending with the week holding `now`,
// plus the exclusive end of that last week.
function weekRange(weeks, now) {
  const starts = [mondayOf(now)];
  while (starts.length < weeks) {
    const d = new Date(starts[0]);
    d.setDate(d.getDate() - 7);
    starts.unshift(d);
  }
  const end = new Date(starts[starts.length - 1]);
  end.setDate(end.getDate() + 7);
  return { starts, end };
}

function weekIndex(t, starts, end) {
  if (!finite(t) || t < starts[0].getTime() || t >= end.getTime()) return -1;
  let i = starts.length - 1;
  while (starts[i].getTime() > t) i--;
  return i;
}

// Per-week rollup, oldest first; a workout belongs to the week its
// startedAt falls in. `sets` counts every set (cardio included), `volume`
// is reps × weight (bodyweight: × ADDED weight), `minutes` the workouts'
// own durations (absent finishedAt = unknown = 0), `strengthDays` the
// distinct days with at least one non-cardio set, `muscles` resistance sets
// per tagged muscle (empty without a layout).
export function weeklyBuckets(workouts, { weeks = 12, now = Date.now(), layout = null } = {}) {
  const { starts, end } = weekRange(weeks, now);
  const muscles = resistanceMuscles(layout);
  const buckets = starts.map((weekStart) => ({
    weekStart, workouts: 0, sets: 0, volume: 0, minutes: 0, cardioMinutes: 0,
    strengthDays: 0, muscles: new Map(),
  }));
  const days = buckets.map(() => new Set());
  workouts.forEach((w) => {
    const i = weekIndex(w.startedAt, starts, end);
    if (i === -1) return;
    const b = buckets[i];
    b.workouts += 1;
    if (finite(w.finishedAt) && w.finishedAt > w.startedAt) {
      b.minutes += (w.finishedAt - w.startedAt) / 60000;
    }
    w.entries.forEach((e) => {
      b.sets += e.sets.length;
      if (e.cardio) {
        e.sets.forEach((st) => { b.cardioMinutes += (st.seconds || 0) / 60; });
        return;
      }
      if (!e.sets.length) return;
      days[i].add(startOfDay(w.startedAt).getTime());
      // an assisted set's weight is the help, not the load: no volume
      if (kindOf(e) !== 'assisted') b.volume += sum(e.sets.map(setVolume));
      muscles.get(e.machineId)?.forEach(([mu, weight]) => {
        b.muscles.set(mu, (b.muscles.get(mu) ?? 0) + e.sets.length * weight);
      });
    });
  });
  buckets.forEach((b, i) => { b.strengthDays = days[i].size; });
  return buckets;
}

// Estimated one-rep max (Epley), only where it is valid: a real load and
// 1–10 reps (beyond that it overestimates badly — see SOURCES.pmc11435939).
export function e1rm(weight, reps) {
  if (!(weight > 0) || !(reps >= 1 && reps <= 10)) return null;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

const kindOf = (e) => (e.cardio ? 'cardio' : e.bodyweight ? 'bodyweight' : e.assisted ? 'assisted' : 'strength');

// The heaviest set, then the most reps; a tie goes to the LATER set (the
// more fatigued one — its rating is the honest one).
const topSet = (sets) => sets.reduce((a, st) => ((st.weight || 0) > (a.weight || 0)
  || ((st.weight || 0) === (a.weight || 0) && (st.reps || 0) >= (a.reps || 0)) ? st : a));
// Assisted (weight = the counterweight's HELP): the least assist, then the
// most reps; a tie goes to the later set, as above.
const topAssist = (sets) => sets.reduce((a, st) => ((st.weight || 0) < (a.weight || 0)
  || ((st.weight || 0) === (a.weight || 0) && (st.reps || 0) >= (a.reps || 0)) ? st : a));
// The longest distance, then the shorter time.
const topCardio = (sets) => sets.reduce((a, st) => ((st.distance || 0) > (a.distance || 0)
  || ((st.distance || 0) === (a.distance || 0) && (st.seconds || 0) < (a.seconds || 0)) ? st : a));

// A SERIES is one (machine, exercise, grip) triple: a rope and a V-bar on
// the same cable tower carry different loads, so their numbers never mix.
// A missing exercise or grip is null — old entries without a grip are the
// gripless series, and match it. seriesKey is the one string form (History
// keys its chips on it); sameSeries compares an entry with a selection.
export const seriesKey = (x) => JSON.stringify([x.machineId, x.exercise ?? null, x.grip ?? null]);
export const sameSeries = (e, sel) => e.machineId === sel.machineId
  && (e.exercise ?? null) === (sel.exercise ?? null) && (e.grip ?? null) === (sel.grip ?? null);

// [{w, e, kind}] ascending: the first entry with sets per workout matching
// (machineId, exercise, grip) — null matches entries without one — kept
// only when it has the NEWEST entry's kind (a machine's type can be toggled
// over time; history.js's chart plots the latest shape the same way).
function seriesEntries(workouts, machineId, exercise = null, grip = null) {
  const sel = { machineId, exercise, grip };
  const rel = byStart(workouts)
    .map((w) => ({
      w, e: w.entries.find((e) => sameSeries(e, sel) && e.sets.length),
    }))
    .filter((x) => x.e);
  if (!rel.length) return [];
  const kind = kindOf(rel[rel.length - 1].e);
  return rel.filter((x) => kindOf(x.e) === kind).map((x) => ({ ...x, kind }));
}

// --- walking distance on the floor (wall-aware, user decision 2026-10-13) ---
// A Dijkstra flood over the grid's whole-unit points, 8 neighbours. Blocked:
// a point outside the floor outline (a layout without one is open floor),
// strictly inside a solid item (machines and free-standing fixtures) other
// than the machine the walk starts AT, on the seam where two solid
// items touch (flush machines are a barrier, not a corridor), and on an
// interior wall — except where a door or entrance stands in it (map.js
// draws the gap; snapDoorToWall puts the door's width along the wall). A
// step is blocked when it crosses a wall or its midpoint is blocked the
// same way. Returns the length in grid units, or null when no way exists.
// The floor is rasterised ONCE per geometry onto a half-unit grid (points
// and step midpoints alike), so a walk costs lookups, not item scans.
// The recommender and "Busy?" read it; the walking-path card keeps its
// straight legs (user decision). A grid the editor could never make
// (`walkableGrid`: not 1…400 units a side — only a file can carry one) has
// no floor to walk: every walk is null and "Busy?" falls back to centres.
const WALL_FIXTURES = new Set(['entrance', 'door', 'window']);
const inPolygon = (x, y, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
};
// a point ON a wall is in the wall — or a step could pass through it
// node by node, touching it twice without ever "crossing" it
const onSegment = (p, a, b) => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < 1e-9
  && p.x >= Math.min(a.x, b.x) - 1e-9 && p.x <= Math.max(a.x, b.x) + 1e-9
  && p.y >= Math.min(a.y, b.y) - 1e-9 && p.y <= Math.max(a.y, b.y) + 1e-9;
const crosses = (p1, p2, p3, p4) => {
  const d = (a, b, c) => (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y);
  return d(p3, p4, p1) * d(p3, p4, p2) < 0 && d(p1, p2, p3) * d(p1, p2, p4) < 0;
};
// The interior walls as segments, each cut open where a door or entrance
// stands on it (its centre within half a unit of the wall).
function wallSegments(layout) {
  const doors = (layout.shapes ?? []).filter((s) => s.kind === 'fixture'
    && (s.fixture === 'door' || s.fixture === 'entrance') && [s.x, s.y, s.w, s.h].every(finite));
  return (layout.shapes ?? []).filter((s) => s.kind === 'line' && [s.x, s.y, s.w, s.h].every(finite))
    .flatMap((w) => {
      const a = { x: w.x, y: w.y };
      const len = Math.hypot(w.w, w.h);
      if (!len) return [];
      const gaps = doors.flatMap((d) => {
        const cx = d.x + d.w / 2;
        const cy = d.y + d.h / 2;
        const t = ((cx - a.x) * w.w + (cy - a.y) * w.h) / (len * len);
        const off = Math.abs((cx - a.x) * w.h - (cy - a.y) * w.w) / len;
        return t >= 0 && t <= 1 && off <= 0.5 ? [[t - d.w / 2 / len, t + d.w / 2 / len]] : [];
      }).sort((p, q) => p[0] - q[0]);
      const at = (t) => ({ x: a.x + w.w * t, y: a.y + w.h * t });
      const parts = [];
      let from = 0;
      gaps.forEach(([g0, g1]) => {
        if (g0 > from) parts.push([at(from), at(g0)]);
        from = Math.max(from, g1);
      });
      if (from < 1) parts.push([at(from), at(1)]);
      return parts;
    });
}
// a grid a floor can be walked on: 1 to 400 units each way (a file can
// carry any number, and the raster's arrays grow with it)
export const walkableGrid = (layout) => [layout?.grid?.w, layout?.grid?.h]
  .every((v) => finite(v) && v >= 1 && v <= 400);
// The floor rasterised at half units: for every point (2x, 2y) the solids
// it lies strictly inside and on whose boundary it lies — at most two of
// each kept, which is all the blocking test needs.
function walkFloor(layout) {
  const W = Math.round(layout.grid?.w ?? 0);
  const H = Math.round(layout.grid?.h ?? 0);
  const outline = (layout.outline?.length ?? 0) >= 3 ? layout.outline : null;
  const solids = [...(layout.machines ?? []), ...(layout.shapes ?? [])
    .filter((s) => s.kind === 'fixture' && !WALL_FIXTURES.has(s.fixture))]
    .filter((it) => [it.x, it.y, it.w, it.h].every(finite));
  const walls = wallSegments(layout);
  const CW = 2 * W + 1;
  const n = CW * (2 * H + 1);
  const inA = new Int32Array(n).fill(-1);
  const inB = new Int32Array(n).fill(-1);
  const edgeA = new Int32Array(n).fill(-1);
  const edgeB = new Int32Array(n).fill(-1);
  const edgeC = new Int32Array(n).fill(-1);
  const add = (arrs, i, v) => { const slot = arrs.find((arr) => arr[i] === -1); if (slot) slot[i] = v; };
  solids.forEach((it, k) => {
    const i0 = Math.max(0, Math.ceil(2 * it.x));
    const i1 = Math.min(2 * W, Math.floor(2 * (it.x + it.w)));
    const j0 = Math.max(0, Math.ceil(2 * it.y));
    const j1 = Math.min(2 * H, Math.floor(2 * (it.y + it.h)));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = i / 2;
        const y = j / 2;
        const strict = x > it.x && x < it.x + it.w && y > it.y && y < it.y + it.h;
        add(strict ? [inA, inB] : [edgeA, edgeB, edgeC], j * CW + i, k);
      }
    }
  });
  const offFloor = new Uint8Array(n);
  for (let j = 0; j <= 2 * H; j++) {
    for (let i = 0; i <= 2 * W; i++) {
      const p = { x: i / 2, y: j / 2 };
      if ((outline && !inPolygon(p.x + 1e-6, p.y + 1e-6, outline)) || walls.some(([a, b]) => onSegment(p, a, b))) {
        offFloor[j * CW + i] = 1;
      }
    }
  }
  // fast paths: a point blocked for SOME walk (refined per walk — the
  // start machine is no obstacle), and the grid points within a step of a
  // wall (only their steps can cross one)
  const anyBlock = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    anyBlock[c] = offFloor[c] || inA[c] !== -1 || edgeB[c] !== -1 ? 1 : 0;
  }
  const nearWall = new Uint8Array((W + 1) * (H + 1));
  walls.forEach(([a, b]) => {
    for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y)) - 1); y <= Math.min(H, Math.ceil(Math.max(a.y, b.y)) + 1); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x)) - 1); x <= Math.min(W, Math.ceil(Math.max(a.x, b.x)) + 1); x++) {
        nearWall[y * (W + 1) + x] = 1;
      }
    }
  });
  return { W, H, CW, solids, walls, inA, inB, edgeA, edgeB, edgeC, offFloor, anyBlock, nearWall };
}
let floorMemo = { key: null, floor: null };
// how many floods ran — the tests pin one per log screen (a flood per stop
// would answer the same and cost the walk once per machine)
let floods = 0;
export const floodCount = () => floods;
const floorKey = (layout) => JSON.stringify([layout.grid, layout.outline,
  (layout.shapes ?? []).map((s) => [s.kind, s.fixture, s.x, s.y, s.w, s.h]),
  (layout.machines ?? []).map((m) => [m.id, m.x, m.y, m.w, m.h])]);
function floorOf(layout) {
  const key = floorKey(layout);
  if (floorMemo.key !== key) floorMemo = { key, floor: walkFloor(layout) };
  return floorMemo.floor;
}

// One Dijkstra flood from `from` that answers for every target at once (a
// log screen asks for every open stop): a target is reached at the first
// free point on or next to its box — where you stand to use it — plus the
// straight step from there to its centre. Stops as soon as every target is
// answered; an unreachable one leaves its null. → Map(id → length | null).
export function walksFrom(layout, from, targets) {
  const out = new Map(targets.map((t) => [t.id, null]));
  if (!walkableGrid(layout) || !from || ![from.x, from.y, from.w, from.h].every(finite)) return out;
  const { W, H, CW, solids, walls, inA, inB, edgeA, edgeB, edgeC, offFloor, anyBlock, nearWall } = floorOf(layout);
  const own = solids.findIndex((it) => it.id === from.id);
  const other = (v) => v !== -1 && v !== own;
  // a half-grid point is blocked off the floor, strictly inside another
  // solid, or on the seam of two other solids (flush machines)
  const blocked = (i, j) => {
    const c = j * CW + i;
    if (!anyBlock[c]) return false;
    return offFloor[c] === 1 || other(inA[c]) || other(inB[c])
      || (other(edgeA[c]) + other(edgeB[c]) + other(edgeC[c])) >= 2;
  };
  const key = (x, y) => y * (W + 1) + x;
  // A ring point counts only if the straight step from it towards the
  // target's centre is clear up to a quarter unit into the target's box —
  // no wall crossed, nothing off the floor or inside another solid on the
  // way (read off the raster every half unit): a machine flush against a
  // wall or behind a mirror is not "reached" from the other side. What lies
  // deeper is the machine itself — a wall drawn through it or a centre past
  // the outline blocks nothing — and the step stays short however large a
  // file's machine is.
  const into = (p, c, lo, hi) => (p < lo ? (lo - p) / (c - p) : p > hi ? (hi - p) / (c - p) : 0);
  const clearStep = (px, py, t, cx, cy) => {
    const len = Math.hypot(cx - px, cy - py);
    const f = len ? Math.min(1, Math.max(into(px, cx, t.x, t.x + t.w), into(py, cy, t.y, t.y + t.h)) + 0.25 / len) : 0;
    const ex = px + (cx - px) * f;
    const ey = py + (cy - py) * f;
    if (walls.some(([a, b]) => crosses({ x: px, y: py }, { x: ex, y: ey }, a, b))) return false;
    const tk = solids.findIndex((it) => it.id === t.id);
    const steps = Math.max(1, Math.ceil(len * f * 2));
    for (let s = 1; s < steps; s++) {
      const i = Math.round(2 * (px + ((ex - px) * s) / steps));
      const j = Math.round(2 * (py + ((ey - py) * s) / steps));
      if (i < 0 || j < 0 || i > 2 * W || j > 2 * H) break; // left the grid: it never comes back
      const c = j * CW + i;
      if (!anyBlock[c]) continue;
      if (offFloor[c] === 1) return false;
      if ([inA[c], inB[c]].some((v) => v !== -1 && v !== own && v !== tk)) return false;
    }
    return true;
  };
  // every target's ring: the points on or one step outside its box
  const goals = new Map();
  const open = new Set(); // ids, so a target listed twice is still answered once
  targets.forEach((t) => {
    if (![t.x, t.y, t.w, t.h].every(finite)) return;
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;
    let any = false;
    for (let y = Math.max(0, Math.floor(t.y) - 1); y <= Math.min(H, Math.ceil(t.y + t.h) + 1); y++) {
      for (let x = Math.max(0, Math.floor(t.x) - 1); x <= Math.min(W, Math.ceil(t.x + t.w) + 1); x++) {
        const inside = x > t.x && x < t.x + t.w && y > t.y && y < t.y + t.h;
        const near = x >= t.x - 1 && x <= t.x + t.w + 1 && y >= t.y - 1 && y <= t.y + t.h + 1;
        if (inside || !near || !clearStep(x, y, t, cx, cy)) continue;
        const k = key(x, y);
        if (!goals.has(k)) goals.set(k, []);
        goals.get(k).push([t.id, Math.hypot(cx - x, cy - y)]);
        any = true;
      }
    }
    if (any) open.add(t.id);
  });
  const sx = Math.round(from.x + from.w / 2);
  const sy = Math.round(from.y + from.h / 2);
  if (!open.size || sx < 0 || sy < 0 || sx > W || sy > H) return out;
  floods += 1;
  const answered = new Set();
  const g = new Float64Array((W + 1) * (H + 1)).fill(Infinity);
  g[key(sx, sy)] = 0;
  const done = new Uint8Array((W + 1) * (H + 1));
  const heap = [[0, sx, sy]]; // binary heap of [g, x, y]
  const push = (e) => {
    heap.push(e);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length && answered.size < open.size) {
    const [d, x, y] = pop();
    const k = key(x, y);
    if (done[k]) continue;
    done[k] = 1;
    (goals.get(k) ?? []).forEach(([id, rest]) => {
      if (answered.has(id)) return;
      answered.add(id);
      out.set(id, d + rest);
    });
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const nx = x + dx;
        const ny = y + dy;
        if ((!dx && !dy) || nx < 0 || ny < 0 || nx > W || ny > H) continue;
        if (blocked(2 * nx, 2 * ny) || blocked(2 * x + dx, 2 * y + dy)) continue; // point, then the step's midpoint
        if (nearWall[k] && walls.some(([a, b]) => crosses({ x, y }, { x: nx, y: ny }, a, b))) continue;
        const nk = key(nx, ny);
        if (done[nk]) continue;
        const ng = d + (dx && dy ? Math.SQRT2 : 1);
        if (ng < g[nk]) {
          g[nk] = ng;
          push([ng, nx, ny]);
        }
      }
    }
  }
  return out;
}

export const walkLength = (layout, from, to) => (to ? walksFrom(layout, from, [to]).get(to.id) : null);

// The next-machine recommender (user decisions 2026-10-13): among the open
// stops of a workout, the one worth walking to instead of the plan's
// "Next" — said only when it saves at least 30 % of the walk and is not
// usually busy at this hour (nor marked busy in this workout). Score = walk
// (grid units, walkLength) × 1.25 when it trains a muscle of the machine
// just left (recovery; primary or secondary on either side), plus half a
// unit per place in the plan (its order is a bonus, never overruled for a
// step). Only stops under the 30 % line compete, so a far one can never
// silence a near one. `candidates` [{machine, slot}] in plan order.
// → { machine, slot, ratio } (walk to it ÷ walk to Next) or null. It never
// replaces "Next".
// Walks are MEMOISED per floor geometry and pair: a log screen re-renders
// on every set, the floor changes only in the Gym.
let walkMemo = { key: null, walks: new Map() };
const pairKey = (from, to) => `${from.id}\u0000${to.id}`;
// the walks from `from` to all `targets`, one flood for the ones not known yet
export function walksCached(layout, from, targets) {
  const key = floorKey(layout);
  if (walkMemo.key !== key) walkMemo = { key, walks: new Map() };
  const missing = targets.filter((t) => !walkMemo.walks.has(pairKey(from, t)));
  if (missing.length) {
    const found = walksFrom(layout, from, missing);
    missing.forEach((t) => walkMemo.walks.set(pairKey(from, t), found.get(t.id)));
  }
  return new Map(targets.map((t) => [t.id, walkMemo.walks.get(pairKey(from, t))]));
}

const musclesOf = (m) => [...(m?.muscles ?? []), ...(m?.secondaryMuscles ?? [])];
export function closerStop({ layout, from, next, candidates = [], busyNow = new Set(), recentMuscles = musclesOf(from) }) {
  if (!from || !next || from.id === next.id) return null;
  const walks = walksCached(layout, from, [next, ...candidates.map((c) => c.machine)]);
  const toNext = walks.get(next.id);
  if (!toNext) return null;
  const recent = new Set(recentMuscles);
  let best = null;
  candidates.forEach(({ machine, slot }, i) => {
    if (machine.id === next.id || machine.id === from.id || busyNow.has(machine.id)) return;
    const d = walks.get(machine.id);
    if (d == null || d > 0.7 * toNext) return;
    const same = musclesOf(machine).some((mu) => recent.has(mu));
    const score = d * (same ? 1.25 : 1) + i * 0.5;
    if (!best || score < best.score) best = { machine, slot, d, score };
  });
  return best ? { machine: best.machine, slot: best.slot, ratio: best.d / toNext } : null;
}

// how much shorter, in words a glance can take: "half the walk"
export const walkSaving = (ratio) => (ratio <= 0.15 ? 'a fraction of the walk'
  : ratio <= 0.28 ? 'a quarter of the walk'
    : ratio <= 0.36 ? 'a third of the walk'
      : ratio <= 0.55 ? 'half the walk'
        : `${Math.round((1 - ratio) * 100)} % less walk`);

// One point per workout for a machine's progress chart. `volume` is
// reps × weight (cardio: total distance); `e1rm` the best valid estimate
// across the sets, strength only; `rir` the top set's rating when it has one.
export function machineSeries(workouts, machineId, exercise = null, grip = null) {
  return seriesEntries(workouts, machineId, exercise, grip).map(({ w, e, kind }) => {
    if (kind === 'cardio') {
      const top = topCardio(e.sets);
      return {
        t: w.startedAt, workoutId: w.id, kind,
        top: { distance: top.distance || 0, seconds: top.seconds || 0 },
        e1rm: null,
        volume: sum(e.sets.map((st) => st.distance || 0)),
        sets: e.sets.length,
      };
    }
    const top = (kind === 'assisted' ? topAssist : topSet)(e.sets);
    const est = kind === 'strength'
      ? e.sets.map((st) => e1rm(st.weight, st.reps)).filter((v) => v != null) : [];
    return {
      t: w.startedAt, workoutId: w.id, kind,
      top: { weight: top.weight || 0, reps: top.reps || 0 },
      e1rm: est.length ? Math.max(...est) : null,
      volume: kind === 'assisted' ? 0 : sum(e.sets.map(setVolume)),
      sets: e.sets.length,
      ...(isRir(top.rir) ? { rir: top.rir } : {}),
    };
  });
}

// Resistance sets per muscle per week, oldest first; every muscle tagged on
// a resistance machine of the layout is present, zeros included, and each
// set counts once for EACH muscle its machine is tagged with (attribution,
// like store's usageByMuscle).
export function muscleWeekly(workouts, layout, { weeks = 12, now = Date.now() } = {}) {
  const out = new Map();
  [...new Set([...resistanceMuscles(layout).values()].flat().map(([mu]) => mu))]
    .sort((a, b) => a.localeCompare(b))
    .forEach((mu) => out.set(mu, new Array(weeks).fill(0)));
  weeklyBuckets(workouts, { weeks, now, layout }).forEach((b, i) => {
    b.muscles.forEach((n, mu) => { out.get(mu)[i] = n; });
  });
  return out;
}

// The machine sequence of a workout, consecutive repeats NOT yet collapsed:
// its visits when it has any (the order the log screen actually showed),
// else its stamped sets by `at`. [{machineId, at, end}] — `end` is the
// visit's `out`, for a set its own `at`.
function rawStops(workout) {
  if (Array.isArray(workout.visits) && workout.visits.length) {
    return workout.visits
      .filter((v) => v?.machineId && finite(v.in))
      .map((v) => ({ machineId: v.machineId, at: v.in, end: finite(v.out) ? v.out : v.in }))
      .sort((a, b) => a.at - b.at);
  }
  const sets = [];
  workout.entries.forEach((e) => e.sets.forEach((st) => {
    if (finite(st.at)) sets.push({ machineId: e.machineId, at: st.at, end: st.at });
  }));
  return sets.sort((a, b) => a.at - b.at);
}

// Consecutive stops at the same machine become one; `seconds` spans its
// first `at` to its last `end` (sets: first to last set; visits: in to out).
function collapse(raw) {
  const out = [];
  raw.forEach((s) => {
    const prev = out[out.length - 1];
    if (prev && prev.machineId === s.machineId) {
      prev.end = Math.max(prev.end, s.end);
    } else {
      out.push({ ...s });
    }
  });
  return out.map((s) => ({ machineId: s.machineId, at: s.at, seconds: Math.max(0, (s.end - s.at) / 1000) }));
}

// A leg back to a machine already visited — except the immediate A→B→A,
// which is a superset or a quick look next door, not a detour.
function backtrackLegs(stops) {
  const legs = [];
  const seen = new Set([stops[0]?.machineId]);
  for (let i = 1; i < stops.length; i++) {
    const to = stops[i].machineId;
    if (seen.has(to) && stops[i - 2]?.machineId !== to) {
      legs.push({ from: stops[i - 1].machineId, to });
    }
    seen.add(to);
  }
  return legs;
}

const centre = (item) => ({ x: item.x + item.w / 2, y: item.y + item.h / 2 });
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// The route walked through the gym: machine centres in visit order. Legs are
// straight lines in grid units (walls ignored — the card keeps straight
// legs, a user decision; walksFrom is the walk) — relative, never metres. Machines no longer in the
// layout drop out before collapsing. The first leg starts at the entrance
// nearest the first machine (`from: null`) when the layout has one.
// null when fewer than two stops remain.
export function workoutPath(workout, layout) {
  const machines = new Map((layout?.machines ?? []).map((m) => [m.id, m]));
  const stops = collapse(rawStops(workout).filter((s) => machines.has(s.machineId)))
    .map((s) => ({ machineId: s.machineId, ...centre(machines.get(s.machineId)), at: s.at, seconds: s.seconds }));
  if (stops.length < 2) return null;
  const entrances = (layout.shapes ?? []).filter((s) => s.fixture === 'entrance').map(centre);
  const start = entrances.length
    ? entrances.reduce((a, b) => (dist(b, stops[0]) < dist(a, stops[0]) ? b : a)) : null;
  const legs = start ? [{ from: null, to: stops[0].machineId, len: dist(start, stops[0]) }] : [];
  for (let i = 1; i < stops.length; i++) {
    legs.push({ from: stops[i - 1].machineId, to: stops[i].machineId, len: dist(stops[i - 1], stops[i]) });
  }
  return { start, stops, legs, switches: stops.length - 1, backtracks: backtrackLegs(stops).length };
}

// How many workouts walked each machine-to-machine transition — counted once
// per workout, so one workout's back-and-forth cannot outweigh a habit.
export function transitionCounts(workouts, layout = null) {
  const counts = new Map();
  // with a layout, machines missing from it drop out BEFORE collapsing —
  // the same stops workoutPath draws, so the weighted map matches it
  const known = layout ? new Set((layout.machines ?? []).map((m) => m.id)) : null;
  workouts.forEach((w) => {
    const stops = collapse(rawStops(w).filter((s) => !known || known.has(s.machineId)));
    const seen = new Set();
    for (let i = 1; i < stops.length; i++) {
      const from = stops[i - 1].machineId;
      const to = stops[i].machineId;
      const key = `${from}>${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const c = counts.get(key) ?? { from, to, n: 0 };
      c.n += 1;
      counts.set(key, c);
    }
  });
  return counts;
}

const MAX_GAP_S = 600; // longer is a break or a machine change, not a rest

// Seconds between consecutive stamped sets of the SAME entry, in workout
// order — any other set in between (another machine, cardio) breaks the
// pair. `at` is the END of a set, so a gap includes the next set itself.
export function restGaps(workout) {
  const stamped = [];
  workout.entries.forEach((e, ei) => e.sets.forEach((st) => {
    if (finite(st.at)) stamped.push({ ei, cardio: !!e.cardio, at: st.at });
  }));
  stamped.sort((a, b) => a.at - b.at);
  const gaps = [];
  for (let i = 1; i < stamped.length; i++) {
    const a = stamped[i - 1];
    const b = stamped[i];
    if (a.ei !== b.ei || a.cardio) continue;
    const gap = (b.at - a.at) / 1000;
    if (gap > 0 && gap <= MAX_GAP_S) gaps.push(gap);
  }
  return gaps;
}

// --- insights ---

export const SOURCES = {
  who2020: {
    label: 'WHO 2020 guidelines',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7719906/',
  },
  acsm2009: {
    label: 'Ratamess et al. 2009 (ACSM)',
    url: 'https://doi.org/10.1249/MSS.0b013e3181915670',
  },
  garber2011: {
    label: 'Garber et al. 2011 (ACSM)',
    url: 'https://doi.org/10.1249/MSS.0b013e318213fefb',
  },
  schoenfeld2016: {
    label: 'Schoenfeld et al. 2016',
    url: 'https://doi.org/10.1007/s40279-016-0543-8',
  },
  schoenfeld2017: {
    label: 'Schoenfeld et al. 2017',
    url: 'https://doi.org/10.1080/02640414.2016.1210197',
  },
  pelland2025: {
    label: 'Pelland et al. 2025',
    url: 'https://doi.org/10.1007/s40279-025-02344-w',
  },
  pmc11435939: {
    label: 'e1RM validity (PMC11435939)',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11435939/',
  },
  pmc11349676: {
    label: 'Rest intervals (PMC11349676)',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11349676/',
  },
  detraining: {
    label: 'Detraining (Scand J Med Sci Sports)',
    url: 'https://doi.org/10.1111/sms.14739',
  },
  // rules 6 and 7 rest on the user's own records, not on a study
  own: { label: 'Your own logged workouts', url: null },
};

// Ranking weight per kind; a rule adds a magnitude term of 0–9 on top.
const WEIGHT = {
  progress: 50, plateau: 40, busy: 35, 'muscle-gap': 30, route: 30,
  frequency: 25, rest: 20, 'muscle-volume': 15,
};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const insight = (kind, magnitude, fields) => ({
  kind, ...fields, score: WEIGHT[kind] + Math.max(0, Math.min(9, Math.round(magnitude))),
});

// Whether the live layout still has the machine — a busy mark can name
// one that was deleted since, and a hint about it has no screen to sit on.
const inLayout = (layout, machineId) => !!layout?.machines?.find((x) => x.id === machineId);

// Every series (machineId, exercise, grip) trained.
function trainedPairs(workouts) {
  const pairs = new Map();
  workouts.forEach((w) => w.entries.forEach((e) => {
    if (!e.sets.length) return;
    pairs.set(seriesKey(e), { machineId: e.machineId, exercise: e.exercise ?? null, grip: e.grip ?? null });
  }));
  return [...pairs.values()];
}

// The plan's target reps for this machine: the plan the latest session came
// from first, else the first plan that targets it. A plan item without a
// grip targets every grip of its exercise.
function targetReps(plans, machineId, exercise, planId, grip = null) {
  const item = (p) => p.items?.find((it) => it.machineId === machineId
    && (it.exercise ?? null) === exercise && (it.grip == null || it.grip === grip)
    && it.target?.reps > 0);
  const own = plans.find((p) => p.id === planId);
  const hit = (own && item(own)) || plans.map(item).find(Boolean);
  return hit ? hit.target.reps : null;
}

// The goal at an assisted machine. What the user SAID wins
// (`machine.assistGoal`); else what the history SHOWS over the last (up
// to six) workouts — the least assist went down: strength; it held while
// the reps went up: endurance; else the rep range — a target (or the last
// top set) of 12 reps or more is endurance work; with neither, strength.
// { goal, observed, basis: 'said' | 'trend' | 'reps' | 'none' } — the log
// screen says which, so it never claims a history it does not have.
export function assistGoal(machine, points = [], targetReps = null) {
  const said = machine?.assistGoal;
  if (said === 'strength' || said === 'endurance') return { goal: said, observed: false, basis: 'said' };
  const pts = points.filter((p) => p.kind === 'assisted').slice(-6);
  if (pts.length >= 2) {
    const [a, b] = [pts[0].top, pts[pts.length - 1].top];
    if (b.weight < a.weight) return { goal: 'strength', observed: true, basis: 'trend' };
    if (b.weight === a.weight && b.reps > a.reps) return { goal: 'endurance', observed: true, basis: 'trend' };
  }
  const reps = targetReps ?? pts[pts.length - 1]?.top.reps ?? null;
  if (reps == null) return { goal: 'strength', observed: true, basis: 'none' };
  return { goal: reps >= 12 ? 'endurance' : 'strength', observed: true, basis: 'reps' };
}

// THE goal of one assisted series, the same answer for every screen and
// rule (log screen, progress, plateau): the target reps are the plan's the
// latest session of that series came from, else the first plan's.
export function assistGoalAt(workouts, layout, plans, { machineId, exercise = null, grip = null }) {
  const sel = { machineId, exercise, grip };
  const latest = byStart(workouts).filter((w) => w.entries.some((e) => sameSeries(e, sel) && e.sets.length)).pop();
  return assistGoal(layout?.machines.find((m) => m.id === machineId),
    machineSeries(workouts, machineId, exercise, grip),
    targetReps(plans ?? [], machineId, exercise, latest?.planId, grip));
}

// A machine counts as "still being trained" for this many days (rules 1, 8).
const RECENT_DAYS = 21;

// 1 — the target is beaten twice at the same load: time to add weight.
// At an assisted machine the same test runs at the same ASSIST, and the
// next step follows the goal: less assist (strength) or more reps
// (endurance) — an unassisted machine (assist 0) has no step left.
function progressRule(ws, settings, plans, now, layout = null) {
  const unit = settings?.unit ?? 'kg';
  const step = settings?.weightStep ?? 2.5;
  return trainedPairs(ws).flatMap(({ machineId, exercise, grip }) => {
    const series = seriesEntries(ws, machineId, exercise, grip);
    if (series.length < 2 || !['strength', 'assisted'].includes(series[0].kind)) return [];
    const assisted = series[0].kind === 'assisted';
    const top = assisted ? topAssist : topSet;
    const [p, q] = series.slice(-2);
    // a machine not trained in three weeks is not "due" for more load —
    // the same recency window as the plateau rule
    if (daysBetween(q.w.startedAt, now) >= RECENT_DAYS) return [];
    const W = top(q.e.sets).weight;
    if (!(W > 0) || top(p.e.sets).weight !== W) return [];
    const T = targetReps(plans, machineId, exercise, q.w.planId, grip) ?? 12;
    const repsAt = (e) => Math.max(...e.sets.filter((st) => st.weight === W).map((st) => st.reps || 0));
    const beaten = (e) => repsAt(e) >= T + 2
      || e.sets.some((st) => st.weight === W && st.reps >= T && st.rir >= 2);
    if (!beaten(p.e) || !beaten(q.e)) return [];
    const reps = Math.min(repsAt(p.e), repsAt(q.e));
    const goal = assisted ? assistGoalAt(ws, layout, plans, { machineId, exercise, grip }).goal : null;
    const next = goal === 'endurance' ? 'add 2 reps at this assist'
      : goal === 'strength' ? `try ${num(Math.min(step, W), 2)} ${unit} less assist`
        : step > 0.1 * W ? 'add 1–2 reps first' : `try ${num(W + step, 2)} ${unit}`;
    return [insight('progress', reps - T, {
      text: `Target beaten twice — ${next}.`,
      source: 'acsm2009',
      machineId,
      exercise,
      grip,
    })];
  });
}

// 2 — fewer than two strength days a week over the last four full weeks.
function frequencyRule(ws, now) {
  if (daysBetween(ws[0].startedAt, now) < 28) return [];
  const full = weeklyBuckets(ws, { weeks: 5, now }).slice(0, 4);
  // a first workout INSIDE the oldest week leaves that week partial — it
  // would read as a low week that never was one
  if (ws[0].startedAt > full[0].weekStart.getTime()) return [];
  const mean = sum(full.map((b) => b.strengthDays)) / 4;
  if (!(mean < 2)) return [];
  return [insight('frequency', (2 - mean) * 4.5, {
    text: `Aim for 2 strength days a week — ${num(mean, 2)} over the last 4 weeks.`,
    source: 'who2020',
  })];
}

// 3 — a muscle that was part of the routine has dropped out of it while
// training goes on (two workouts in the last 10 days: not a holiday).
function muscleGapRule(ws, layout, now) {
  const muscles = resistanceMuscles(layout);
  const last = new Map();
  ws.forEach((w) => w.entries.forEach((e) => {
    if (e.cardio || !e.sets.length) return;
    // only a PRIMARY muscle was trained: a chest press does not tick off
    // the triceps for this rule
    muscles.get(e.machineId)?.forEach(([mu, weight]) => { if (weight === 1) last.set(mu, w.startedAt); });
  }));
  if (ws.filter((w) => daysBetween(w.startedAt, now) < 10).length < 2) return [];
  return [...last].flatMap(([muscle, t]) => {
    const d = daysBetween(t, now);
    if (d < 10 || d >= 42) return [];
    return [insight('muscle-gap', d - 10, {
      text: `Train it this week — last trained ${d} days ago.`,
      source: 'schoenfeld2016',
      muscle,
    })];
  });
}

// 4 — one muscle gets far less weekly volume than the others.
function muscleVolumeRule(ws, layout, now) {
  if (daysBetween(ws[0].startedAt, now) < 28) return [];
  const means = [...muscleWeekly(ws, layout, { weeks: 5, now })]
    .map(([muscle, weeks]) => ({ muscle, mean: sum(weeks.slice(0, 4)) / 4 }))
    // a muscle the layout tags but nobody trains is not low volume, it is
    // untrained — nagging about it would never stop (tone rule)
    .filter((m) => m.mean > 0);
  if (means.length < 4) return [];
  const median = quantile(means.map((m) => m.mean).sort((a, b) => a - b), 0.5);
  const lowest = means.reduce((a, b) => (b.mean < a.mean ? b : a));
  // The plan's "≤ 25th percentile" clause is not checked: the minimum is
  // always at or below any percentile, so it could never decide anything.
  if (!(lowest.mean < median / 2)) return [];
  return [insight('muscle-volume', 9 * (1 - lowest.mean / (median / 2)), {
    text: `Add a set or two — ${num(lowest.mean)} sets/week, your median muscle gets ${num(median)}.`,
    source: 'schoenfeld2017',
    muscle: lowest.muscle,
  })];
}

// 5 — short rests across the recent live-logged workouts.
function restRule(ws) {
  const stamped = ws.filter((w) => w.entries.some((e) => e.sets.some((st) => finite(st.at)))).slice(-5);
  const gaps = stamped.flatMap(restGaps).sort((a, b) => a - b);
  if (gaps.length < 10) return [];
  const median = quantile(gaps, 0.5);
  if (!(median < 90)) return [];
  return [insight('rest', (90 - median) / 10, {
    text: `Hold 90 s — your median is ${Math.floor(median)} s (incl. the set).`,
    source: 'pmc11349676',
  })];
}

// 6 — the same walk back to a machine keeps recurring.
function routeRule(ws, layout) {
  const paths = ws.map((w) => ({ w, p: workoutPath(w, layout) })).filter((x) => x.p).slice(-8);
  const hits = new Map();
  paths.forEach(({ w, p }) => {
    const seen = new Set();
    backtrackLegs(p.stops).forEach(({ from, to }) => {
      const key = `${from}>${to}`;
      if (seen.has(key)) return;
      seen.add(key);
      const h = hits.get(key) ?? { from, to, ws: [] };
      h.ws.push(w);
      hits.set(key, h);
    });
  });
  const numOf = (id) => layout.machines.find((m) => m.id === id).num;
  return [...hits.values()].filter((h) => h.ws.length >= 3).map(({ from, to, ws: hw }) => {
    // the name these workouts go by most often; walked newest first, so a
    // tie goes to the name of the most recent workout
    const names = new Map();
    [...hw].reverse().forEach((w) => w.name && names.set(w.name, (names.get(w.name) ?? 0) + 1));
    const name = [...names].reduce((a, b) => (b[1] > a[1] ? b : a), [null, 0])[0];
    return insight('route', (hw.length - 3) * 2, {
      text: `Reorder — back to #${numOf(to)} after #${numOf(from)} in ${hw.length} workouts.`,
      source: 'own',
      machineId: to,
      workout: name, // the plan this belongs to goes by this name, or null
    });
  });
}

// 7 — a machine that keeps being busy at the same weekday and hour.
function busyRule(ws, layout, now) {
  const groups = new Map();
  ws.forEach((w) => {
  // one mark per workout per machine: three "Busy?" hops in one evening are
  // one busy evening, not a weekday pattern
  const marked = new Set();
  (w.visits ?? []).forEach((v) => {
    if (!v?.busy || !finite(v.in) || daysBetween(v.in, now) >= 56) return;
    if (marked.has(v.busy)) return;
    marked.add(v.busy);
    const d = new Date(v.in);
    const key = `${v.busy}|${d.getDay()}`;
    const g = groups.get(key) ?? { machineId: v.busy, day: d.getDay(), mins: [] };
    // wall-clock minutes, so a mark before and after a DST switch compare
    g.mins.push(d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60);
    groups.set(key, g);
  });
  });
  return [...groups.values()].flatMap(({ machineId, day, mins }) => {
    if (!inLayout(layout, machineId)) return [];
    mins.sort((a, b) => a - b);
    // the largest run of marks within a two-hour span
    let best = { n: 0 };
    for (let i = 0, j = 0; j < mins.length; j++) {
      while (mins[j] - mins[i] > 120) i++;
      if (j - i + 1 > best.n) best = { n: j - i + 1, lo: mins[i], hi: mins[j] };
    }
    if (best.n < 3) return [];
    const h0 = Math.floor(best.lo / 60);
    const h1 = Math.max(h0 + 1, Math.ceil(best.hi / 60));
    return [insight('busy', best.n - 3, {
      text: `Usually busy ${WEEKDAYS[day]}s ${h0}–${h1} h — start elsewhere.`,
      source: 'own',
      machineId,
      weekday: day,
      // the window the text names — the log screen shows the line only
      // around it, not on that weekday's morning
      h0,
      h1,
    })];
  });
}

// 8 — no new best estimated 1RM for six or more workouts on a machine that
// is still being trained.
function plateauRule(ws, settings, now, layout = null, plans = []) {
  const unit = settings?.unit ?? 'kg';
  return trainedPairs(ws).flatMap(({ machineId, exercise, grip }) => {
    const series = machineSeries(ws, machineId, exercise, grip);
    if (series[series.length - 1]?.kind === 'assisted') {
      return assistPlateau(series, assistGoalAt(ws, layout, plans, { machineId, exercise, grip }).goal, unit, now)
        .map((extra) => insight('plateau', extra.score, { ...extra.row, machineId, exercise, grip }));
    }
    const pts = series.filter((p) => p.kind === 'strength' && p.e1rm != null);
    if (pts.length < 8) return [];
    const best = Math.max(...pts.slice(0, -6).map((p) => p.e1rm));
    if (Math.max(...pts.slice(-6).map((p) => p.e1rm)) > best) return [];
    if (daysBetween(pts[pts.length - 1].t, now) >= RECENT_DAYS) return [];
    const since = pts.length - 1 - pts.findIndex((p) => p.e1rm === best);
    return [insight('plateau', since - 6, {
      text: `No new best in ${since} workouts (${num(best)} ${unit} e1RM) — vary reps or load.`,
      source: 'pmc11435939',
      machineId,
      exercise,
      grip,
    })];
  });
}

// 8, assisted — no e1RM to compare: the record is the LEAST assist
// (strength goal) or the MOST reps at the least assist (endurance goal),
// with the same windows: eight workouts, none of the last six past the best
// of the earlier ones, trained in the last 21 days.
function assistPlateau(series, goal, unit, now) {
  const pts = series.filter((p) => p.kind === 'assisted');
  if (pts.length < 8 || daysBetween(pts[pts.length - 1].t, now) >= RECENT_DAYS) return [];
  // unassisted already (0 kg): no lower to reach — not a plateau
  if (goal === 'strength' && pts.slice(-6).some((p) => p.top.weight === 0)) return [];
  // one number per workout where HIGHER is better
  const val = (p) => (goal === 'strength' ? -p.top.weight : p.top.reps);
  const best = Math.max(...pts.slice(0, -6).map(val));
  if (Math.max(...pts.slice(-6).map(val)) > best) return [];
  const since = pts.length - 1 - pts.findIndex((p) => val(p) === best);
  return [{
    score: since - 6,
    row: {
      text: goal === 'strength'
        ? `No new low in ${since} workouts (${num(-best)} ${unit} assist) — vary reps or assist.`
        : `No new rep best in ${since} workouts (${best} reps) — vary assist or reps.`,
      source: 'acsm2009',
    },
  }];
}

// Every observation that fires, as a one-line instruction (`text`, raw —
// the UI escapes) with its `source` key and its target (`machineId` +
// `exercise` + `grip`, `muscle`, `workout` name, `weekday`), ordered by kind weight
// plus a 0–9 magnitude, ties on the text. No cap and no one-per-machine
// pick: each screen shows only the rows about the thing on it, so a cap
// would silence the third machine. Nothing with fewer than three workouts.
// MEMOISED on everything a rule reads — the workouts, the layout, the unit
// and weight step, the plans and the DAY of `now` (every rule counts whole
// days). Callers re-read storage on every render, so a reference would
// never repeat; the serialised input does, and comparing it costs a
// fraction of the rules (measured: 435 workouts, 4.1 ms warm per call vs
// 0.85 ms on a hit). One entry is enough: the screens that ask twice in a
// row (log screen, then the rest overlay) ask the same question. The answer
// is FROZEN — every caller gets the same objects, so a caller that sorted
// or edited them in place would corrupt the next one's; it throws instead.
let memo = null;
export function insights(workouts, layout, settings, { now = Date.now(), plans = [] } = {}) {
  if (workouts.length < 3) return [];
  const key = [startOfDay(now).getTime(), settings?.unit, settings?.weightStep,
    JSON.stringify(layout ?? null), JSON.stringify(plans), JSON.stringify(workouts)].join('|');
  if (memo?.key === key) return memo.value;
  const value = Object.freeze(rules(workouts, layout, settings, now, plans).map(Object.freeze));
  memo = { key, value };
  return value;
}

function rules(workouts, layout, settings, now, plans) {
  const ws = byStart(workouts);
  return [
    ...progressRule(ws, settings, plans, now, layout),
    ...frequencyRule(ws, now),
    ...(layout ? muscleGapRule(ws, layout, now) : []),
    ...(layout ? muscleVolumeRule(ws, layout, now) : []),
    ...restRule(ws),
    ...(layout ? routeRule(ws, layout) : []),
    ...(layout ? busyRule(ws, layout, now) : []),
    ...plateauRule(ws, settings, now, layout, plans),
  ].sort((a, b) => b.score - a.score || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}
