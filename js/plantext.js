// Plan text: the trainer's note. Reads and writes plans (and back-logged
// workouts) as LINES of text; everything it persists goes through store.js.
// store.js imports planFromImport back for importData — a cycle that only
// ever crosses at call time (neither module calls the other while loading).
import {
  bindOrCreateMachine, convertDistance, convertWeight, distUnit, getLayout, getPlans,
  getSettings, M_PER_MI, newEntry, newLayout, numFields, saveLayout, uid,
} from './store.js';

// A plan arrives as LINES, not as a form — "Leg press 3x10 80", "#7 Chest
// press 3x8-12 40kg", "Treadmill 20min". Reading them is what makes a plan
// possible before a layout exists. Cutting order matters: set and weight
// terms come out FIRST, so a leftover leading number ("7. Leg press") is
// unambiguously a machine num and "20min Treadmill" never reads its 20 as
// one. Only a MARKED number (#7, 7., 7)) counts — a bare leading digit
// stays part of the name, where "45 degree leg press" belongs.

// sets × reps, with an optional rep range ("3x8-12" targets the low end —
// the number you are sure to hit is the better prefill).
// A rep RANGE ("3x8-12") takes a hyphen attached to the reps or a dash:
// "3x8 -25" is 8 reps at an assist of 25, the minus the app itself shows
// on an assisted machine — not a range of 8 to 25.
const SETS_REPS = /(\d+)\s*(?:sets?)?\s*[x×*]\s*(\d+)(?:-\s*\d+|\s*[–—]\s*\d+)?\s*(?:reps?)?/i;
// weight right after the sets term ("3x10 80", "3x10x80", "3x10 @ 40kg")
const TRAILING_WEIGHT = /^\s*(?:@|x|×|\*|-|with)?\s*[-−]?\s*(\d+(?:[.,]\d+)?)\s*(kgs?|lbs?|pounds?)?\b/i;
// …or anywhere, when it names its unit ("Chest press 40kg 3x10")
const UNIT_WEIGHT = /(\d+(?:[.,]\d+)?)\s*(kgs?|lbs?|pounds?)\b/i;
const DURATION = /(\d+(?:[.,]\d+)?)\s*(h|hrs?|hours?|min(?:ute)?s?|sec(?:ond)?s?)\b/i;
const DISTANCE = /(\d+(?:[.,]\d+)?)\s*(km|mi|miles?|m)\b/i;
// a cardio line's level — the machine's resistance step: "L5", "level 5",
// "lvl 5", a whole number
const LEVEL = /\b(?:level|lvl|l)\s*(\d+)\b/i;
const MARKED_NUM = /^(?:(?:nr|no)\.?\s*)?(?:#\s*(\d{1,3})|(\d{1,3})\s*[.)])\s*/i;

const num = (raw) => parseFloat(String(raw).replace(',', '.'));

// Weights and distances are stored in the display unit, so a note written
// in the other one converts on the way in (convertWeight/convertDistance
// carry the rounding, same as setUnit).
function toDisplayWeight(value, unit, settings) {
  if (!unit) return value;
  const imperial = /^(lbs?|pounds?)$/i.test(unit);
  if (imperial === (settings.unit === 'lbs')) return value;
  return convertWeight(value, settings.unit);
}

function toDisplayDistance(value, unit, settings) {
  const meters = /^km$/i.test(unit) ? value * 1000
    : /^m$/i.test(unit) ? value : value * M_PER_MI;
  return settings.unit === 'kg' ? Math.round(meters) : convertDistance(meters, 'lbs');
}

// Reads one line into a raw item ({ name, num?, target? }), or null when
// there is nothing to train on it (blank lines, "Day A:" headings, a bare
// set term with no movement to attach it to).
export function parsePlanLine(line, settings = getSettings()) {
  let rest = String(line).trim();
  if (!rest || /:$/.test(rest)) return null;

  // "[Rope]" names the grip — cut out FIRST, before any other term: '/' sits
  // in real names ("Lat pulldown / row"), '()' and "with" collide with the
  // trailing weight, '·' is not on a phone keyboard. Empty brackets: none.
  // The LAST group is the grip: a name from an AI file, a template or a sync
  // may carry brackets of its own ("Curl [EZ] [Rope]").
  let grip = null;
  const br = [...rest.matchAll(/\[([^[\]]*)\]/g)].at(-1);
  if (br) {
    grip = br[1].trim() || null;
    rest = (rest.slice(0, br.index) + rest.slice(br.index + br[0].length)).replace(/\s+/g, ' ').trim();
  }

  let target = null;
  const sr = SETS_REPS.exec(rest);
  if (sr) {
    const after = rest.slice(sr.index + sr[0].length);
    const tw = TRAILING_WEIGHT.exec(after);
    const uw = tw ? null : UNIT_WEIGHT.exec(rest);
    const w = tw ?? uw;
    target = {
      sets: Math.max(1, parseInt(sr[1], 10)),
      reps: Math.max(1, parseInt(sr[2], 10)),
      weight: w ? Math.max(0, toDisplayWeight(num(w[1]), w[2], settings)) : 0,
    };
    rest = (rest.slice(0, sr.index) + after.slice(tw ? tw[0].length : 0))
      .replace(uw ? uw[0] : '', '');
  } else {
    // no sets term — a duration or a distance makes it a cardio item. Its
    // level is cut out BEFORE the duration and distance are read, so
    // "Rower 20min L5" and "Rower L5 20min" read alike and "L5" never joins
    // the name; L0 names none, and a level alone makes no cardio line (the
    // token then stays in the name, visible — as on a strength line).
    const lv = LEVEL.exec(rest);
    const scan = lv ? rest.replace(lv[0], ' ') : rest;
    const dur = DURATION.exec(scan);
    const dist = DISTANCE.exec(scan);
    if (dur || dist) {
      const secs = dur ? num(dur[1]) * (/^(h|hrs?|hours?)$/i.test(dur[2]) ? 3600
        : /^sec/i.test(dur[2]) ? 1 : 60) : 0;
      const level = lv ? parseInt(lv[1], 10) : 0;
      target = {
        distance: dist ? toDisplayDistance(num(dist[1]), dist[2], settings) : 0,
        seconds: Math.round(secs),
        ...(level >= 1 ? { level } : {}),
      };
      rest = scan.replace(dur ? dur[0] : '', '').replace(dist ? dist[0] : '', '');
    }
  }

  let machineNum = null;
  const marked = MARKED_NUM.exec(rest.trim());
  if (marked) {
    machineNum = parseInt(marked[1] ?? marked[2], 10);
    rest = rest.trim().slice(marked[0].length);
  }

  // strip the punctuation that separated the terms we just cut out
  let name = rest.replace(/[\s,;:@×*x-]+$/i, '').replace(/^[\s,;:@-]+/, '')
    .replace(/\s+/g, ' ').trim();
  // "#2 Dumbbells: Biceps curls" names a movement AT a machine. Only a
  // MARKED num unlocks this reading — otherwise "Day A: Leg press" would
  // lose its exercise to a heading that merely looks like one.
  let exercise = null;
  if (machineNum && name.includes(':')) {
    const [head, ...tail] = name.split(':');
    const rhs = tail.join(':').trim();
    if (head.trim() && rhs) { name = head.trim(); exercise = rhs; }
  }
  if (!name) return null;
  return {
    name,
    ...(machineNum ? { num: machineNum } : {}),
    ...(exercise ? { exercise } : {}),
    ...(grip ? { grip } : {}),
    ...(target ? { target } : {}),
  };
}

// The whole note at once. Lines that carry nothing trainable are dropped.
export function parsePlanText(text, settings = getSettings()) {
  return String(text).split('\n')
    .map((line) => parsePlanLine(line, settings))
    .filter(Boolean);
}

// Binds one raw item to a machine when the layout allows it: a known num
// wins, else an exact label match, else a SINGLE substring match (an
// ambiguous one would bind the wrong machine, so it stays unbound). What
// cannot bind keeps its name and num — an unbound item is a full citizen,
// not a failed one.
function resolveItem(raw, layout) {
  const name = String(raw.name || '').trim();
  const machines = layout?.machines ?? [];
  let machine = raw.num != null ? machines.find((m) => m.num === raw.num) : null;
  if (!machine && name) {
    const n = name.toLowerCase();
    const matches = machines.filter((m) => String(m.label || '').toLowerCase() === n);
    const loose = matches.length ? matches : machines.filter((m) => {
      const label = String(m.label || '').toLowerCase();
      return label && (label.includes(n) || n.includes(label));
    });
    if (loose.length === 1) [machine] = loose;
  }
  return { machine, name: name || (raw.num != null ? `Machine ${raw.num}` : '') };
}

// Shapes a raw target against the item's type. Bound items take their type
// from the machine, unbound ones from the target's own shape.
function normalizeTarget(raw, cardio) {
  const int = (v, min, fb) => (Number.isFinite(v) ? Math.max(min, Math.round(v)) : fb);
  const pos = (v, fb) => (Number.isFinite(v) && v >= 0 ? v : fb);
  if (cardio) {
    // the level is optional: a whole number from 1 up stays, anything else
    // (a note's or an LLM's 0, junk) is none — absent, never 0
    const level = Number.isFinite(raw.level) ? Math.round(raw.level) : 0;
    return raw.distance != null || raw.seconds != null
      ? { distance: pos(raw.distance, 1000), seconds: int(raw.seconds, 0, 600), ...(level >= 1 ? { level } : {}) }
      : null;
  }
  return raw.sets != null || raw.reps != null || raw.weight != null
    ? { sets: int(raw.sets, 1, 3), reps: int(raw.reps, 1, 10), weight: pos(raw.weight, 0) } : null;
}

// Turns raw items ({num?, name?, exercise?, target?} — from an LLM file or
// a typed note) into plan items, binding what the layout already knows.
export function planItemsFrom(rawItems, layout) {
  return rawItems.map((item) => {
    // an unbound item's `num` lands in the bind prompt's value attribute: a
    // machine number or nothing (§ untrusted input) — 2.5 or -3 is no number
    // on a machine, and a bind would round it into a different one
    const raw = numFields(item, ['num']);
    if (raw.num != null && !(Number.isInteger(raw.num) && raw.num >= 1)) delete raw.num;
    const { machine, name } = resolveItem(raw, layout);
    const flat = raw.target ? { ...raw, ...raw.target } : raw;
    const cardio = machine ? !!machine.cardio : flat.distance != null || flat.seconds != null;
    const target = normalizeTarget(flat, cardio);
    if (machine) {
      // "Curl [EZ] 3x10" read "[EZ]" as the grip: if the machine knows no
      // such grip but does know the bracketed exercise, the brackets were
      // part of the name
      const joined = raw.exercise != null && raw.grip != null ? `${raw.exercise} [${raw.grip}]` : null;
      const nameBracket = !machine.grips?.includes(raw.grip) && !!machine.exercises?.includes(joined);
      const ex = nameBracket ? joined : raw.exercise;
      const exercise = machine.exercises?.includes(ex) ? ex : null;
      // a bound item keeps only a grip its machine offers
      const grip = machine.grips?.includes(raw.grip) ? raw.grip : null;
      return { machineId: machine.id, exercise, ...(grip ? { grip } : {}), ...(target ? { target } : {}) };
    }
    // neither a machine nor a name: nothing to train and nothing to bind
    if (!name) return null;
    // the exercise part survives on an unbound item too ("#2 Dumbbells:
    // Curls"): binding it makes it an exercise of that machine
    const exercise = typeof raw.exercise === 'string' && raw.exercise.trim()
      ? raw.exercise.trim() : null;
    // …and so does its grip: binding teaches it to the machine
    const grip = typeof raw.grip === 'string' && raw.grip.trim() ? raw.grip.trim() : null;
    return {
      machineId: null, name, exercise,
      ...(grip ? { grip } : {}),
      ...(raw.num != null ? { num: raw.num } : {}),
      ...(target ? { target } : {}),
    };
  }).filter(Boolean);
}

export const isUnbound = (item) => !item.machineId;

// The note a plan would have been written as — the exact inverse of
// parsePlanText, so the builder can offer text and list as two views of
// one plan. Bound items lead with their #num, which is what makes the
// round-trip bind again on the way back in.
export function planToText(items, layout, settings = getSettings()) {
  const du = distUnit(settings);
  return items.map((it) => {
    const machine = it.machineId ? layout?.machines.find((m) => m.id === it.machineId) : null;
    if (!machine && !isUnbound(it)) return null; // machine deleted since
    const num = machine?.num ?? it.num ?? null;
    const label = machine ? machine.label : it.name;
    // the LAST "[…]" is read back as the grip, so a name carrying brackets
    // of its own ("Curl [EZ]") and no grip gets empty ones: "[]" names none
    const named = `${label}${it.exercise ? `: ${it.exercise}` : ''}`;
    const head = `${num ? `#${num} ` : ''}${named}${
      it.grip ? ` [${it.grip}]` : /\[[^[\]]*\]/.test(named) ? ' []' : ''}`;
    const t = it.target;
    if (!t) return head;
    if (t.distance != null) {
      const dist = t.distance ? ` ${t.distance}${du}` : '';
      const time = t.seconds
        ? ` ${t.seconds % 60 ? `${t.seconds}s` : `${t.seconds / 60}min`}` : '';
      // the level only next to a distance or time: alone it would read
      // back as part of the name
      const level = (dist || time) && t.level ? ` L${t.level}` : '';
      return `${head}${dist}${time}${level}`;
    }
    return `${head} ${t.sets}x${t.reps}${t.weight ? ` ${t.weight}` : ''}`;
  }).filter(Boolean).join('\n');
}

// Reads a plan out of a typed note. No layout needed — that is the point.
export function planFromText(text, name = '', settings = getSettings()) {
  const raw = parsePlanText(text, settings);
  if (!raw.length) throw new Error('No exercises found — one per line, e.g. "Leg press 3x10 80"');
  return {
    id: uid(),
    name: String(name || '').trim(),
    items: planItemsFrom(raw, getLayout()),
  };
}

// Builds a PAST workout out of the same note grammar — the workout you
// forgot to log is a plan that already happened, so "3x10 80" means three
// sets of ten at eighty rather than a target of them. Lines naming a num
// the layout doesn't know create that machine (same deal as binding on the
// floor); lines with no findable machine are reported, not invented, so
// nothing lands in the layout that the note didn't actually name.
// Returns { workout, skipped } and persists ONLY the layout, not the workout.
export function workoutFromText(text, startedAt, settings = getSettings()) {
  const raw = parsePlanText(text, settings);
  if (!raw.length) throw new Error('No exercises found — one per line, e.g. "#14 Leg press 3x10 80"');
  const layout = getLayout() ?? newLayout();
  const entries = [];
  const skipped = [];
  raw.forEach((item) => {
    const [resolved] = planItemsFrom([item], layout);
    if (!resolved) return;
    let machine = resolved.machineId
      ? layout.machines.find((m) => m.id === resolved.machineId) : null;
    if (!machine && item.num) {
      machine = bindOrCreateMachine(layout, item.num, item.name, item.target);
    }
    if (!machine) { skipped.push(item.name); return; }
    const t = resolved.target;
    const sets = [];
    if (t?.distance != null) {
      sets.push({ distance: t.distance, seconds: t.seconds });
    } else {
      const count = t?.sets ?? 1;
      for (let i = 0; i < count; i++) sets.push({ reps: t?.reps ?? 10, weight: t?.weight ?? 0 });
    }
    entries.push(newEntry(machine, resolved.exercise, sets,
      machine.grips?.includes(item.grip) ? item.grip : null));
  });
  if (!entries.length) {
    throw new Error('No line named a machine gymii knows — put a #number in front of one');
  }
  saveLayout(layout);
  // no finishedAt: the duration of a workout logged after the fact is
  // simply unknown, and every consumer already guards for its absence
  return { workout: { id: uid(), startedAt, updatedAt: Date.now(), entries }, skipped };
}

// Resolves an LLM-produced workout-plan file against the current layout.
// Machines are referenced by their visible num — the only stable handle an
// LLM sees in the AI export. A num the layout doesn't know does NOT drop the
// item any more: the answer may arrive hours after the export (or before
// the layout exists at all), so it lands unbound and binds on first use.
// The plan always gets a FRESH id; when the file carries the id of an
// existing plan (a revision of an exported one), that id is only REPORTED
// as `replacesId` — replacing is a destructive choice the caller must
// confirm, never something a pasted file does on its own.
// Does not persist anything.
export function planFromImport(data) {
  if (!Array.isArray(data.items) || !data.items.length) throw new Error('Plan has no items');
  const items = planItemsFrom(data.items, getLayout());
  const days = Array.isArray(data.days)
    ? [...new Set(data.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
      .sort((a, b) => a - b)
    : [];
  return {
    plan: {
      id: uid(),
      name: String(data.name || '').trim(),
      ...(days.length ? { days } : {}),
      items,
    },
    unbound: items.filter(isUnbound).map((it) => it.name),
    replacesId: typeof data.id === 'string' && getPlans().some((p) => p.id === data.id)
      ? data.id : null,
  };
}
