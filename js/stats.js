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

// machineId -> muscles, for RESISTANCE machines only: a treadmill tagged
// Calves is not a calf set. Resolved against the live layout, like store's
// usageByMuscle (entries don't snapshot muscles).
const resistanceMuscles = (layout) => new Map((layout?.machines ?? [])
  .filter((m) => !m.cardio && m.muscles?.length)
  .map((m) => [m.id, m.muscles]));

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
      b.volume += sum(e.sets.map(setVolume));
      muscles.get(e.machineId)?.forEach((mu) => {
        b.muscles.set(mu, (b.muscles.get(mu) ?? 0) + e.sets.length);
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

const kindOf = (e) => (e.cardio ? 'cardio' : e.bodyweight ? 'bodyweight' : 'strength');

// The heaviest set, then the most reps; a tie goes to the LATER set (the
// more fatigued one — its rating is the honest one).
const topSet = (sets) => sets.reduce((a, st) => ((st.weight || 0) > (a.weight || 0)
  || ((st.weight || 0) === (a.weight || 0) && (st.reps || 0) >= (a.reps || 0)) ? st : a));
// The longest distance, then the shorter time.
const topCardio = (sets) => sets.reduce((a, st) => ((st.distance || 0) > (a.distance || 0)
  || ((st.distance || 0) === (a.distance || 0) && (st.seconds || 0) < (a.seconds || 0)) ? st : a));

// [{w, e, kind}] ascending: the first entry with sets per workout matching
// (machineId, exercise) — exercise null matches entries without one — kept
// only when it has the NEWEST entry's kind (a machine's type can be toggled
// over time; history.js's chart plots the latest shape the same way).
function seriesEntries(workouts, machineId, exercise = null) {
  const ex = exercise ?? null;
  const rel = byStart(workouts)
    .map((w) => ({
      w, e: w.entries.find((e) => e.machineId === machineId && (e.exercise ?? null) === ex && e.sets.length),
    }))
    .filter((x) => x.e);
  if (!rel.length) return [];
  const kind = kindOf(rel[rel.length - 1].e);
  return rel.filter((x) => kindOf(x.e) === kind).map((x) => ({ ...x, kind }));
}

// One point per workout for a machine's progress chart. `volume` is
// reps × weight (cardio: total distance); `e1rm` the best valid estimate
// across the sets, strength only; `rir` the top set's rating when it has one.
export function machineSeries(workouts, machineId, exercise = null) {
  return seriesEntries(workouts, machineId, exercise).map(({ w, e, kind }) => {
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
    const top = topSet(e.sets);
    const est = kind === 'strength'
      ? e.sets.map((st) => e1rm(st.weight, st.reps)).filter((v) => v != null) : [];
    return {
      t: w.startedAt, workoutId: w.id, kind,
      top: { weight: top.weight || 0, reps: top.reps || 0 },
      e1rm: est.length ? Math.max(...est) : null,
      volume: sum(e.sets.map(setVolume)),
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
  [...new Set([...resistanceMuscles(layout).values()].flat())]
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
// straight lines in grid units (walls ignored, like train.js's
// nearbyAlternative) — relative, never metres. Machines no longer in the
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
export function transitionCounts(workouts) {
  const counts = new Map();
  workouts.forEach((w) => {
    const stops = collapse(rawStops(w));
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

// "#2 Lat pulldown" (· exercise) — from the live layout, else the entry snapshot.
function machineName(layout, machineId, entry = null, exercise = null) {
  const m = layout?.machines?.find((x) => x.id === machineId) ?? entry;
  if (!m) return null;
  return `#${m.num} ${m.label}${exercise ? ` · ${exercise}` : ''}`;
}

// Every (machineId, exercise) pair trained, with one entry for its name.
function trainedPairs(workouts) {
  const pairs = new Map();
  workouts.forEach((w) => w.entries.forEach((e) => {
    if (!e.sets.length) return;
    const key = `${e.machineId} ${e.exercise ?? ''}`;
    pairs.set(key, { machineId: e.machineId, exercise: e.exercise ?? null, entry: e });
  }));
  return [...pairs.values()];
}

// The plan's target reps for this machine: the plan the latest session came
// from first, else the first plan that targets it.
function targetReps(plans, machineId, exercise, planId) {
  const item = (p) => p.items?.find((it) => it.machineId === machineId
    && (it.exercise ?? null) === exercise && it.target?.reps > 0);
  const own = plans.find((p) => p.id === planId);
  const hit = (own && item(own)) || plans.map(item).find(Boolean);
  return hit ? hit.target.reps : null;
}

// 1 — the target is beaten twice at the same load: time to add weight.
function progressRule(ws, layout, settings, plans) {
  const unit = settings?.unit ?? 'kg';
  const step = settings?.weightStep ?? 2.5;
  return trainedPairs(ws).flatMap(({ machineId, exercise, entry }) => {
    const series = seriesEntries(ws, machineId, exercise);
    if (series.length < 2 || series[0].kind !== 'strength') return [];
    const [p, q] = series.slice(-2);
    const W = topSet(q.e.sets).weight;
    if (!(W > 0) || topSet(p.e.sets).weight !== W) return [];
    const T = targetReps(plans, machineId, exercise, q.w.planId) ?? 12;
    const repsAt = (e) => Math.max(...e.sets.filter((st) => st.weight === W).map((st) => st.reps || 0));
    const beaten = (e) => repsAt(e) >= T + 2
      || e.sets.some((st) => st.weight === W && st.reps >= T && st.rir >= 2);
    if (!beaten(p.e) || !beaten(q.e)) return [];
    const reps = Math.min(repsAt(p.e), repsAt(q.e));
    const next = step > 0.1 * W ? 'add 1–2 reps first' : `try ${num(W + step, 2)} ${unit}`;
    return [insight('progress', reps - T, {
      text: `${machineName(layout, machineId, entry, exercise)}: ${reps} × ${num(W, 2)} ${unit} twice — ${next}.`,
      why: 'ACSM: add load once the target is beaten by 1–2 reps.',
      source: 'acsm2009',
      machineId,
    })];
  });
}

// 2 — fewer than two strength days a week over the last four full weeks.
function frequencyRule(ws, now) {
  if (daysBetween(ws[0].startedAt, now) < 28) return [];
  const mean = sum(weeklyBuckets(ws, { weeks: 5, now }).slice(0, 4).map((b) => b.strengthDays)) / 4;
  if (!(mean < 2)) return [];
  return [insight('frequency', (2 - mean) * 4.5, {
    text: `Last 4 weeks: ${num(mean, 2)} strength days/week.`,
    why: 'WHO: strength training on 2 or more days a week.',
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
    muscles.get(e.machineId)?.forEach((mu) => last.set(mu, w.startedAt));
  }));
  if (ws.filter((w) => daysBetween(w.startedAt, now) < 10).length < 2) return [];
  return [...last].flatMap(([muscle, t]) => {
    const d = daysBetween(t, now);
    if (d < 10 || d >= 42) return [];
    return [insight('muscle-gap', d - 10, {
      text: `${muscle}: last trained ${d} days ago.`,
      why: 'Training a muscle twice a week beats once at equal volume.',
      source: 'schoenfeld2016',
      muscle,
    })];
  });
}

// 4 — one muscle gets far less weekly volume than the others.
function muscleVolumeRule(ws, layout, now) {
  if (daysBetween(ws[0].startedAt, now) < 28) return [];
  const means = [...muscleWeekly(ws, layout, { weeks: 5, now })]
    .map(([muscle, weeks]) => ({ muscle, mean: sum(weeks.slice(0, 4)) / 4 }));
  if (means.length < 4) return [];
  const median = quantile(means.map((m) => m.mean).sort((a, b) => a - b), 0.5);
  const lowest = means.reduce((a, b) => (b.mean < a.mean ? b : a));
  // The plan's "≤ 25th percentile" clause is not checked: the minimum is
  // always at or below any percentile, so it could never decide anything.
  if (!(lowest.mean < median / 2)) return [];
  return [insight('muscle-volume', 9 * (1 - lowest.mean / (median / 2)), {
    text: `${lowest.muscle}: ${num(lowest.mean)} sets/week — your median muscle gets ${num(median)}.`,
    why: 'Each extra weekly set adds growth, with diminishing returns.',
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
    text: `Median ${Math.floor(median)} s between sets (incl. the set).`,
    why: 'Rests longer than 60–90 s help strength gains.',
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
    const body = `back to #${numOf(to)} after #${numOf(from)} in ${hw.length} workouts — reorder the plan?`;
    return insight('route', (hw.length - 3) * 2, {
      text: name ? `${name}: ${body}` : body[0].toUpperCase() + body.slice(1),
      why: 'From your own route: walking back costs time between sets.',
      source: 'own',
      machineId: to,
    });
  });
}

// 7 — a machine that keeps being busy at the same weekday and hour.
function busyRule(ws, layout, now) {
  const groups = new Map();
  ws.forEach((w) => (w.visits ?? []).forEach((v) => {
    if (!v?.busy || !finite(v.in) || daysBetween(v.in, now) >= 56) return;
    const d = new Date(v.in);
    const key = `${v.busy}|${d.getDay()}`;
    const g = groups.get(key) ?? { machineId: v.busy, day: d.getDay(), mins: [] };
    // wall-clock minutes, so a mark before and after a DST switch compare
    g.mins.push(d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60);
    groups.set(key, g);
  }));
  return [...groups.values()].flatMap(({ machineId, day, mins }) => {
    const name = machineName(layout, machineId);
    if (!name) return [];
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
      text: `${name} busy ${best.n}× on ${WEEKDAYS[day]}s ${h0}–${h1} h.`,
      why: 'From your own busy marks: this machine tends to be taken then.',
      source: 'own',
      machineId,
    })];
  });
}

// 8 — no new best estimated 1RM for six or more workouts on a machine that
// is still being trained.
function plateauRule(ws, layout, settings, now) {
  const unit = settings?.unit ?? 'kg';
  return trainedPairs(ws).flatMap(({ machineId, exercise, entry }) => {
    const pts = machineSeries(ws, machineId, exercise).filter((p) => p.kind === 'strength' && p.e1rm != null);
    if (pts.length < 8) return [];
    const best = Math.max(...pts.slice(0, -6).map((p) => p.e1rm));
    if (Math.max(...pts.slice(-6).map((p) => p.e1rm)) > best) return [];
    if (daysBetween(pts[pts.length - 1].t, now) >= 21) return [];
    const since = pts.length - 1 - pts.findIndex((p) => p.e1rm === best);
    return [insight('plateau', since - 6, {
      text: `${machineName(layout, machineId, entry, exercise)}: no new best in ${since} workouts (${num(best)} ${unit} e1RM).`,
      why: 'Estimated 1RM (Epley) compared per exercise, valid up to 10 reps.',
      source: 'pmc11435939',
      machineId,
    })];
  });
}

// At most `max` observations worth a look, ranked by kind weight plus a
// 0–9 magnitude; one per kind (progress: two), one per machine or muscle,
// ties broken on the text. Nothing with fewer than three workouts.
export function insights(workouts, layout, settings, { now = Date.now(), plans = [], max = 3 } = {}) {
  if (workouts.length < 3) return [];
  const ws = byStart(workouts);
  const candidates = [
    ...progressRule(ws, layout, settings, plans),
    ...frequencyRule(ws, now),
    ...(layout ? muscleGapRule(ws, layout, now) : []),
    ...(layout ? muscleVolumeRule(ws, layout, now) : []),
    ...restRule(ws),
    ...(layout ? routeRule(ws, layout) : []),
    ...(layout ? busyRule(ws, layout, now) : []),
    ...plateauRule(ws, layout, settings, now),
  ].sort((a, b) => b.score - a.score || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  const out = [];
  const perKind = new Map();
  const targets = new Set();
  for (const c of candidates) {
    if (out.length >= max) break;
    const k = perKind.get(c.kind) ?? 0;
    if (k >= (c.kind === 'progress' ? 2 : 1)) continue;
    const target = c.machineId ? `m:${c.machineId}` : c.muscle ? `u:${c.muscle}` : null;
    if (target && targets.has(target)) continue;
    out.push(c);
    perKind.set(c.kind, k + 1);
    if (target) targets.add(target);
  }
  return out;
}
