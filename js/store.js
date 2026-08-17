// All localStorage access lives here. Keys are versioned via a `v` field
// inside each object so future schema migrations have something to check.

const KEYS = {
  profiles: 'gymii.profiles',
  settings: 'gymii.settings',
};

// Gym, workouts and the active workout are stored per profile ("one gym,
// one history"); settings stay global.
const scopedKey = (pid, part) => `gymii.${pid}.${part}`;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const uid = () => Math.random().toString(36).slice(2, 10);

// --- gym profiles ---
// gymii.profiles = { v:1, list:[{id,name}], activeId }. Created lazily; a
// pre-profile install's gymii.gym|workouts|active keys are moved (as raw
// strings) under a new default profile on first access.

function ensureProfiles() {
  let profiles = read(KEYS.profiles, null);
  if (profiles) return profiles;
  const id = uid();
  let name = 'My gym';
  const legacyGym = localStorage.getItem('gymii.gym');
  if (legacyGym) {
    try { name = JSON.parse(legacyGym).name || name; } catch { /* keep default */ }
  }
  ['gym', 'workouts', 'active'].forEach((part) => {
    const raw = localStorage.getItem(`gymii.${part}`);
    if (raw != null) {
      localStorage.setItem(scopedKey(id, part), raw);
      localStorage.removeItem(`gymii.${part}`);
    }
  });
  profiles = { v: 1, list: [{ id, name }], activeId: id };
  write(KEYS.profiles, profiles);
  return profiles;
}

const activeProfileId = () => ensureProfiles().activeId;

export function getProfiles() {
  return ensureProfiles();
}

// Creates a profile and makes it active. It starts without a gym; Studio
// auto-creates one on first visit. `extra` lets a caller stamp identity
// onto the profile (demo.js marks its profile `demo: true` — names are
// user-editable and must never be an identity).
export function createProfile(name, extra = {}) {
  const profiles = ensureProfiles();
  const id = uid();
  profiles.list.push({ id, name: String(name || '').trim() || 'New gym', ...extra });
  profiles.activeId = id;
  write(KEYS.profiles, profiles);
  return id;
}

export function renameProfile(id, name) {
  const profiles = ensureProfiles();
  const p = profiles.list.find((x) => x.id === id);
  const trimmed = String(name || '').trim();
  if (!p || !trimmed) return;
  p.name = trimmed;
  write(KEYS.profiles, profiles);
}

export function setActiveProfile(id) {
  const profiles = ensureProfiles();
  if (!profiles.list.some((p) => p.id === id)) return;
  profiles.activeId = id;
  write(KEYS.profiles, profiles);
}

// Refuses to delete the last remaining profile (returns false) — except
// the demo profile: Settings promises it can always be removed, so as the
// sole survivor it takes the registry with it and the next access
// self-heals into a fresh default (same recovery clearAll relies on).
// Deleting the active profile switches to the first remaining one.
export function deleteProfile(id) {
  const profiles = ensureProfiles();
  const profile = profiles.list.find((p) => p.id === id);
  if (!profile) return false;
  if (profiles.list.length <= 1 && !profile.demo) return false;
  profiles.list = profiles.list.filter((p) => p.id !== id);
  if (!profiles.list.length) {
    localStorage.removeItem(KEYS.profiles);
  } else {
    if (profiles.activeId === id) profiles.activeId = profiles.list[0].id;
    write(KEYS.profiles, profiles);
  }
  ['gym', 'workouts', 'active', 'plans'].forEach((part) => localStorage.removeItem(scopedKey(id, part)));
  return true;
}

// Canonical pick lists — selectable chips beat free text (fewer typos).
export const MUSCLE_GROUPS = [
  'Chest', 'Upper back', 'Lower back', 'Lats', 'Shoulders', 'Traps',
  'Biceps', 'Triceps', 'Forearms', 'Abs', 'Obliques',
  'Quads', 'Hamstrings', 'Glutes', 'Calves', 'Adductors', 'Abductors',
  'Full body',
];

export const ZONE_LABELS = [
  'Machines', 'Free weights', 'Cardio', 'Functional', 'Stretching',
  'Turf', 'Entrance', 'Changing room',
];

export const COMMON_SETTINGS = [
  'Seat', 'Seat angle', 'Back pad', 'Chest pad', 'Thigh pad', 'Shin pad',
  'Ankle pad', 'Arm pads', 'Pad height', 'Pulley height', 'Handle position',
  'Foot plate',
];

// --- gym template ---

export function getGym() {
  const gym = read(scopedKey(activeProfileId(), 'gym'), null);
  if (gym && !Array.isArray(gym.outline)) gym.outline = defaultOutline(gym.grid); // pre-outline gyms
  if (gym && !gym.meta) gym.meta = {}; // pre-meta gyms
  // heal machines from hand-edited/AI-produced imports — a missing
  // settingsFields would otherwise throw across Train and Studio
  gym?.machines.forEach((m) => {
    if (!Array.isArray(m.settingsFields)) m.settingsFields = [];
    if (!Array.isArray(m.muscles)) m.muscles = [];
  });
  return gym;
}

export function saveGym(gym) {
  write(scopedKey(activeProfileId(), 'gym'), gym);
}

export function defaultOutline(grid) {
  return [
    { x: 0, y: 0 },
    { x: grid.w, y: 0 },
    { x: grid.w, y: grid.h },
    { x: 0, y: grid.h },
  ];
}

// Appends a machine near the grid center (loosely mirroring the studio's
// placement). Quick start and the picker's create-on-miss use this, so a
// gym can grow without ever opening the studio — arranging is optional.
export function addMachine(gym, num, label) {
  // 5 per row, next row below, wrapping inside the grid — plain modulo
  // would stack machine 1/6/11 on the same spot
  const n = gym.machines.length;
  const machine = {
    id: uid(), num, label,
    x: Math.round(2 + (n % 5) * 5) % Math.max(1, gym.grid.w - 4),
    y: Math.round(2 + Math.floor(n / 5) * 4) % Math.max(1, gym.grid.h - 3),
    w: 4, h: 3, settingsFields: [], muscles: [], docUrl: '',
  };
  gym.machines.push(machine);
  return machine;
}

export function newGym(name = 'My gym') {
  const grid = { w: 60, h: 40 };
  return {
    v: 1, name, grid,
    meta: { address: '', city: '', country: '' },
    outline: defaultOutline(grid),
    shapes: [], machines: [],
  };
}

// --- workout history ---

export function getWorkouts() {
  return read(scopedKey(activeProfileId(), 'workouts'), []);
}

// Chronological order is an INVARIANT of this list: "repeat last workout"
// reads the tail, lastEntryFor walks it backwards, and history renders it
// reversed. Logging a session after the fact or editing a workout's date
// would otherwise silently misplace it, so sorting happens here — once,
// for every writer — instead of at each call site.
export function saveWorkouts(list) {
  write(scopedKey(activeProfileId(), 'workouts'),
    list.slice().sort((a, b) => a.startedAt - b.startedAt));
}

// Deletes a workout by id; no-op if unknown.
export function deleteWorkout(id) {
  saveWorkouts(getWorkouts().filter((w) => w.id !== id));
}

// Replaces a workout's fields by id (inline history edits). Entries with
// zero sets are dropped, mirroring finishWorkout(); if none remain the
// whole workout is removed. Returns the updated workout, or null.
export function updateWorkout(patch) {
  const list = getWorkouts();
  const idx = list.findIndex((w) => w.id === patch.id);
  if (idx === -1) return null;
  const entries = patch.entries.filter((e) => e.sets.length);
  if (!entries.length) {
    list.splice(idx, 1);
    saveWorkouts(list);
    return null;
  }
  const next = { ...list[idx], ...patch, entries };
  // a spread merge can't express key removal — an emptied locker or name
  // would otherwise silently resurrect from the stored workout
  if (!patch.locker) delete next.locker;
  if (!patch.name) delete next.name;
  list[idx] = next;
  saveWorkouts(list);
  return next;
}

// Most recent entry with at least one set for this machine — and, at
// multi-exercise stations, for this exercise (null matches entries logged
// without one). Returns null if nothing matches.
export function lastEntryFor(machineId, exercise = null) {
  const workouts = getWorkouts();
  for (let i = workouts.length - 1; i >= 0; i--) {
    const entry = workouts[i].entries.find(
      (e) => e.machineId === machineId && (e.exercise ?? null) === exercise);
    if (entry && entry.sets.length) return entry;
  }
  return null;
}

// --- workout plans ---
// A plan is an explicitly saved routine: ordered slots plus an optional
// per-slot target. Starting one feeds it straight into the guided flow
// (train.js startWorkoutFrom), so plans and repeats share one execution
// path. Shape:
//   { id, name, items: [{ machineId?, name?, num?, exercise|null,
//     target?: {sets,reps,weight} | {distance,seconds} }] }
// INVARIANT: an item carries a machineId (bound — it knows which station)
// or a name (unbound — it knows the movement but not the station yet), or
// both. Unbound items are what lets a plan exist before the gym does: a
// trainer's note is typed in, and each item binds to a machine the first
// time it is trained (train.js renderBind). `num` on an unbound item is a
// hint from the source note, not a binding — it prefills the bind prompt.
// A bound item's type comes from its machine; an unbound one's from the
// shape of its target (distance/seconds = cardio).

export function getPlans() {
  return read(scopedKey(activeProfileId(), 'plans'), []);
}

export function savePlans(list) {
  write(scopedKey(activeProfileId(), 'plans'), list);
}

// Upserts by id so the builder saves new and edited plans alike. A plan
// stamps `createdAt` the first time it is stored: weekday tracking must
// not report the Monday before a plan existed as a missed one. Plans from
// before this (and from backups) carry none and count as always-there.
export function savePlan(plan) {
  const list = getPlans();
  const idx = list.findIndex((p) => p.id === plan.id);
  if (idx === -1) list.push({ createdAt: Date.now(), ...plan });
  else list[idx] = plan;
  savePlans(list);
  return plan;
}

export function deletePlan(id) {
  savePlans(getPlans().filter((p) => p.id !== id));
}

// --- weekday plans: what is due, what was missed, what today is for ---
// A plan tagged with weekdays turns the start screen into an answer to
// "what today is about" — including the answer "nothing", which is a real
// one. Tone is stated, never scolding: gymii reports, it does not nag.
// All of this is pure date maths over `now`, so it is testable without
// waiting for a Tuesday.

// Local midnight as a Date — THE day-boundary definition (demo.js imports
// it too; day arithmetic goes through setDate(), never DAY_MS multiples,
// which drift an hour across DST transitions).
export const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};
export const dayKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// The plan's most recent due day at or before `now` (today counts), or
// null when it carries no weekdays.
export function planDueDay(plan, now = Date.now()) {
  if (!plan.days?.length) return null;
  for (let back = 0; back < 7; back++) {
    const d = startOfDay(now);
    d.setDate(d.getDate() - back);
    if (plan.days.includes(d.getDay())) return d;
  }
  return null;
}

// The next due day strictly after today.
export function planNextDay(plan, now = Date.now()) {
  if (!plan.days?.length) return null;
  for (let ahead = 1; ahead <= 7; ahead++) {
    const d = startOfDay(now);
    d.setDate(d.getDate() + ahead);
    if (plan.days.includes(d.getDay())) return d;
  }
  return null;
}

// Was this plan trained since `since`? New workouts carry planId; older
// ones are matched by name, which is how a plan owned its routine before.
const planTrainedSince = (plan, workouts, since) => workouts.some((w) =>
  (w.planId === plan.id || (plan.name && w.name === plan.name))
  && w.startedAt >= since.getTime());

// How this plan stands right now: 'due' (today, not trained yet), 'done'
// (today, already trained), 'missed' (an earlier day this cycle went by),
// 'skipped', or 'clear' (nothing outstanding). Missed days only reach back
// to the previous occurrence of that weekday — a skipped Tuesday stops
// mattering next Tuesday, so a holiday never becomes a backlog.
export function planDayState(plan, workouts, now = Date.now()) {
  const due = planDueDay(plan, now);
  if (!due) return { state: 'clear', due: null, next: null };
  const next = planNextDay(plan, now);
  const isToday = due.getTime() === startOfDay(now).getTime();
  // a day that passed before this plan existed was never missed
  if (plan.createdAt && due.getTime() < startOfDay(plan.createdAt).getTime()) {
    return { state: 'clear', due, next };
  }
  if (planTrainedSince(plan, workouts, due)) {
    return { state: isToday ? 'done' : 'clear', due, next };
  }
  if (plan.skippedOn === dayKey(due)) return { state: 'skipped', due, next };
  if (isToday) return { state: 'due', due, next };
  // A day only counts as MISSED while the rhythm is alive — the cycle
  // before it was trained. A plan never started, or dropped weeks ago, is
  // not missed every single week; it just isn't running, and saying so
  // every Monday would be nagging rather than reminding.
  const prevCycle = new Date(due);
  prevCycle.setDate(prevCycle.getDate() - 7);
  if (!planTrainedSince(plan, workouts, prevCycle)) return { state: 'clear', due, next };
  return { state: 'missed', due, next };
}

// The one thing the start screen should say about today. Plans are scanned
// in stored order and the most actionable state wins: something due today
// beats a missed day, which beats "done", which beats a rest day.
export function todayStatus(plans, workouts, now = Date.now()) {
  const dated = plans.filter((p) => p.days?.length);
  if (!dated.length) return null;
  const states = dated.map((p) => ({ plan: p, ...planDayState(p, workouts, now) }));
  const pick = (state) => states.find((x) => x.state === state) ?? null;
  const hit = pick('due') ?? pick('missed') ?? pick('done');
  if (hit) return hit;
  // nothing outstanding: name the next plan that comes up, soonest first
  const upcoming = states.filter((x) => x.next)
    .sort((a, b) => a.next - b.next)[0];
  return upcoming ? { ...upcoming, state: 'rest' } : null;
}

// Marks this cycle's due day as deliberately skipped — it stops being
// outstanding until that weekday comes round again. Locker-style: the key
// disappears when there is nothing to skip.
export function skipPlanDay(planId, now = Date.now()) {
  const plan = getPlans().find((p) => p.id === planId);
  const due = plan ? planDueDay(plan, now) : null;
  if (!due) return null;
  plan.skippedOn = dayKey(due);
  savePlan(plan);
  return plan;
}

// The weekday this plan actually gets trained on, when there is a clear
// one (at least 3 sessions, and 60% of them on the same day). Lets gymii
// notice a rhythm instead of asking for one.
export function usualWeekday(plan, workouts) {
  const mine = workouts.filter((w) =>
    w.planId === plan.id || (plan.name && w.name === plan.name));
  if (mine.length < 3) return null;
  const counts = new Map();
  mine.forEach((w) => {
    const d = new Date(w.startedAt).getDay();
    counts.set(d, (counts.get(d) || 0) + 1);
  });
  const [day, hits] = [...counts].sort((a, b) => b[1] - a[1])[0];
  return hits / mine.length >= 0.6 ? day : null;
}

// --- active (in-progress) workout, saved after every set for crash safety ---

export function getActive() {
  return read(scopedKey(activeProfileId(), 'active'), null);
}

export function saveActive(workout) {
  write(scopedKey(activeProfileId(), 'active'), workout);
}

export function clearActive() {
  localStorage.removeItem(scopedKey(activeProfileId(), 'active'));
}

// Moves the active workout into history; entries without sets are dropped.
export function finishWorkout(active) {
  const entries = active.entries.filter((e) => e.sets.length);
  clearActive();
  if (!entries.length) return null;
  const workout = {
    id: active.id,
    startedAt: active.startedAt,
    finishedAt: Date.now(),
    entries,
    ...(active.locker ? { locker: active.locker } : {}),
    ...(active.name ? { name: active.name } : {}),
    // which plan this came from — lets weekday tracking ask "was this plan
    // trained?" exactly, instead of inferring it from a matching name
    ...(active.planId ? { planId: active.planId } : {}),
  };
  const list = getWorkouts();
  list.push(workout);
  saveWorkouts(list);
  return workout;
}

// --- settings ---

export function getSettings() {
  return {
    v: 1, restSeconds: 90, weightStep: 2.5, unit: 'kg', mapColors: 'custom', pickerMap: 'hidden',
    ...read(KEYS.settings, {}),
  };
}

// Distances pair with the weight unit: meters in metric, miles in imperial.
export const distUnit = (settings) => (settings.unit === 'kg' ? 'm' : 'mi');

const LB_PER_KG = 2.2046226218;
const M_PER_MI = 1609.344;

// THE unit conversion, rounding included: weights to the nearest 0.5 in
// the target unit, distances to whole meters / hundredths of a mile.
// Every converter (setUnit below, demo.js's authored-in-kg data) must go
// through these or values drift between surfaces. `unit` is the TARGET
// display unit; the value is assumed to be in the other one.
export const convertWeight = (v, unit) =>
  Math.round((unit === 'lbs' ? v * LB_PER_KG : v / LB_PER_KG) * 2) / 2;
export const convertDistance = (v, unit) => (unit === 'lbs'
  ? Math.round((v / M_PER_MI) * 100) / 100
  : Math.round(v * M_PER_MI));

// Stored weights and distances are always in the current display unit.
// Switching units therefore converts every stored value — across ALL
// profiles' histories, active workouts and plan targets (unit is global,
// data is per profile) — plus the shared weight step. Seconds are
// unit-less and untouched.
export function setUnit(unit) {
  const s = getSettings();
  if (unit === s.unit) return;
  // one field-walk for everything that stores {weight, distance}
  const convert = (o) => {
    if (o.weight != null) o.weight = convertWeight(o.weight, unit);
    if (o.distance != null) o.distance = convertDistance(o.distance, unit);
  };
  const convertSets = (entries) => entries.forEach((e) => e.sets.forEach(convert));

  ensureProfiles().list.forEach((p) => {
    const workouts = read(scopedKey(p.id, 'workouts'), []);
    workouts.forEach((w) => convertSets(w.entries));
    write(scopedKey(p.id, 'workouts'), workouts);

    const active = read(scopedKey(p.id, 'active'), null);
    if (active) {
      convertSets(active.entries);
      // a running workout's slots carry their OWN copy of the plan targets
      // (train.js startWorkoutFrom) — the log screen's header and its
      // first-set prefill read that copy, so skipping it would turn an 80 kg
      // goal into an 80 lbs one the moment the unit is switched mid-session.
      // Legacy plans are bare machineId strings; they have no target.
      active.plan?.forEach((slot) => slot?.target && convert(slot.target));
      write(scopedKey(p.id, 'active'), active);
    }

    // plan targets are stored in the display unit too — leaving them out
    // would silently turn a 80 kg target into an 80 lbs one
    const plans = read(scopedKey(p.id, 'plans'), []);
    if (plans.length) {
      plans.forEach((pl) => pl.items?.forEach((it) => it.target && convert(it.target)));
      write(scopedKey(p.id, 'plans'), plans);
    }
  });

  saveSettings({ ...s, unit, weightStep: Math.max(0.5, convertWeight(s.weightStep, unit)) });
}

// Sorted list of every muscle assigned across the gym's machines — feeds
// the picker's filter, the overview's coverage chips and the plan builder.
export const gymMuscles = (gym) => [...new Set(gym.machines.flatMap((m) => m.muscles || []))]
  .sort((a, b) => a.localeCompare(b));

// --- naming a workout ---
// A name is what makes a session findable later, so gymii proposes one
// instead of asking for one: the muscles of the machines actually trained
// say what this workout was. Chips, not free text — the house rule for
// anything enumerable, and one tap beats typing "Push day" for the ninth
// time. Free text stays available for everything these can't guess.

const MUSCLE_REGION = {
  Chest: 'Chest',
  'Upper back': 'Back',
  'Lower back': 'Back',
  Lats: 'Back',
  Traps: 'Back',
  Shoulders: 'Shoulders',
  Biceps: 'Arms',
  Triceps: 'Arms',
  Forearms: 'Arms',
  Abs: 'Core',
  Obliques: 'Core',
  Quads: 'Legs',
  Hamstrings: 'Legs',
  Glutes: 'Legs',
  Calves: 'Legs',
  Adductors: 'Legs',
  Abductors: 'Legs',
  'Full body': 'Full body',
};
const PUSH = new Set(['Chest', 'Shoulders', 'Triceps']);
const PULL = new Set(['Lats', 'Upper back', 'Lower back', 'Traps', 'Biceps']);

// Names this set of machines could plausibly go by, most specific first.
// Pass one id per set (or per plan item) — repeats are the weighting.
export function suggestWorkoutNames(machineIds, gym) {
  const hits = new Map(); // muscle -> weight
  let total = 0;
  machineIds.forEach((id) => {
    const machine = gym?.machines.find((m) => m.id === id);
    const muscles = machine?.muscles ?? [];
    if (!muscles.length) return;
    // each machine contributes ONE unit, split across its muscles — a
    // station tagged with three leg muscles must not outvote two others
    const unit = 1 / muscles.length;
    muscles.forEach((mu) => hits.set(mu, (hits.get(mu) || 0) + unit));
    total += 1;
  });
  if (!total) return [];
  const share = (group) => [...hits]
    .reduce((n, [mu, c]) => n + (group.has(mu) ? c : 0), 0) / total;
  const regions = new Map();
  hits.forEach((c, mu) => {
    const region = MUSCLE_REGION[mu];
    if (region) regions.set(region, (regions.get(region) || 0) + c);
  });
  const ranked = [...regions].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  const names = [];
  // a classic split only when the session really is one — a stray
  // machine from another region should not rename the whole workout
  if (share(PUSH) >= 0.7) names.push('Push day');
  if (share(PULL) >= 0.7) names.push('Pull day');
  if ((regions.get('Legs') ?? 0) / total >= 0.7) names.push('Leg day');
  if (ranked[0]) names.push(ranked[0]);
  if (ranked[1]) names.push(`${ranked[0]} & ${ranked[1]}`);
  return [...new Set(names)].slice(0, 4);
}

// Names already in use, newest first — reusing one keeps a routine
// together on the start screen instead of splitting it in two.
export function recentWorkoutNames(limit = 3) {
  const workouts = getWorkouts();
  const names = [];
  for (let i = workouts.length - 1; i >= 0 && names.length < limit; i--) {
    const name = workouts[i].name;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// Total sets per machine across all history — feeds the usage map view.
export function usageByMachine() {
  const usage = new Map();
  getWorkouts().forEach((w) => w.entries.forEach((e) => {
    usage.set(e.machineId, (usage.get(e.machineId) || 0) + e.sets.length);
  }));
  return usage;
}

// Muscles live on the MACHINE, never on the entry, so history resolves
// them against the gym as it is today — a deleted or untagged machine
// simply contributes to no muscle.
const muscleIndex = (gym) => new Map((gym?.machines ?? []).map((m) => [m.id, m.muscles ?? []]));

// Sets per muscle over `workouts` (the caller passes its filtered list).
// A set on a two-muscle station counts fully for BOTH: this answers "how
// many sets worked this muscle", not "what should this session be called"
// — suggestWorkoutNames splits 1/n because naming is a vote, usage isn't.
// → Map<muscle, {sets, workouts}>
export function usageByMuscle(workouts, gym) {
  const muscles = muscleIndex(gym);
  const usage = new Map();
  workouts.forEach((w) => {
    const seen = new Set(); // count each workout once per muscle
    w.entries.forEach((e) => muscles.get(e.machineId)?.forEach((mu) => {
      const u = usage.get(mu) ?? { sets: 0, workouts: 0 };
      u.sets += e.sets.length;
      if (!seen.has(mu)) { u.workouts += 1; seen.add(mu); }
      usage.set(mu, u);
    }));
  });
  return usage;
}

// The workouts that touched `muscle` — WHOLE workouts on purpose: history
// edits a full workout, so narrowing entries would let Save silently drop
// the stations that didn't match.
export function workoutsWithMuscle(workouts, gym, muscle) {
  const muscles = muscleIndex(gym);
  return workouts.filter((w) =>
    w.entries.some((e) => muscles.get(e.machineId)?.includes(muscle)));
}

export function saveSettings(settings) {
  write(KEYS.settings, settings);
}

// --- import / export ---

export function exportGymTemplate() {
  return { app: 'gymii', kind: 'gym-template', v: 1, gym: getGym() };
}

export function exportBackup() {
  return {
    app: 'gymii',
    kind: 'backup',
    v: 1,
    gym: getGym(),
    workouts: getWorkouts(),
    plans: getPlans(),
    settings: getSettings(),
  };
}

function isValidGym(gym) {
  return gym && typeof gym === 'object'
    && gym.grid && Number.isFinite(gym.grid.w) && Number.isFinite(gym.grid.h)
    && Array.isArray(gym.shapes) && Array.isArray(gym.machines)
    && gym.machines.every((m) => m.id && Number.isFinite(m.num)
      && (m.exercises === undefined
        || (Array.isArray(m.exercises) && m.exercises.every((x) => typeof x === 'string'))))
    && (gym.outline === undefined || (Array.isArray(gym.outline) && gym.outline.length >= 3
      && gym.outline.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))));
}

// --- plan text: the trainer's note ---
// A plan arrives as LINES, not as a form — "Leg press 3x10 80", "#7 Chest
// press 3x8-12 40kg", "Treadmill 20min". Reading them is what makes a plan
// possible before a gym exists. Cutting order matters: set and weight
// terms come out FIRST, so a leftover leading number ("7. Leg press") is
// unambiguously a machine num and "20min Treadmill" never reads its 20 as
// one. Only a MARKED number (#7, 7., 7)) counts — a bare leading digit
// stays part of the name, where "45 degree leg press" belongs.

// sets × reps, with an optional rep range ("3x8-12" targets the low end —
// the number you are sure to hit is the better prefill).
const SETS_REPS = /(\d+)\s*(?:sets?)?\s*[x×*]\s*(\d+)(?:\s*[-–—]\s*\d+)?\s*(?:reps?)?/i;
// weight right after the sets term ("3x10 80", "3x10x80", "3x10 @ 40kg")
const TRAILING_WEIGHT = /^\s*(?:@|x|×|\*|-|with)?\s*(\d+(?:[.,]\d+)?)\s*(kgs?|lbs?|pounds?)?\b/i;
// …or anywhere, when it names its unit ("Chest press 40kg 3x10")
const UNIT_WEIGHT = /(\d+(?:[.,]\d+)?)\s*(kgs?|lbs?|pounds?)\b/i;
const DURATION = /(\d+(?:[.,]\d+)?)\s*(h|hrs?|hours?|min(?:ute)?s?|sec(?:ond)?s?)\b/i;
const DISTANCE = /(\d+(?:[.,]\d+)?)\s*(km|mi|miles?|m)\b/i;
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
    // no sets term — a duration or a distance makes it a cardio item
    const dur = DURATION.exec(rest);
    const dist = DISTANCE.exec(rest);
    if (dur || dist) {
      const secs = dur ? num(dur[1]) * (/^(h|hrs?|hours?)$/i.test(dur[2]) ? 3600
        : /^sec/i.test(dur[2]) ? 1 : 60) : 0;
      target = {
        distance: dist ? toDisplayDistance(num(dist[1]), dist[2], settings) : 0,
        seconds: Math.round(secs),
      };
      rest = rest.replace(dur ? dur[0] : '', '').replace(dist ? dist[0] : '', '');
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
  // "#2 Dumbbells: Biceps curls" names a movement AT a station. Only a
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
    ...(target ? { target } : {}),
  };
}

// The whole note at once. Lines that carry nothing trainable are dropped.
export function parsePlanText(text, settings = getSettings()) {
  return String(text).split('\n')
    .map((line) => parsePlanLine(line, settings))
    .filter(Boolean);
}

// Binds one raw item to a machine when the gym allows it: a known num
// wins, else an exact label match, else a SINGLE substring match (an
// ambiguous one would bind the wrong station, so it stays unbound). What
// cannot bind keeps its name and num — an unbound item is a full citizen,
// not a failed one.
function resolveItem(raw, gym) {
  const name = String(raw.name || '').trim();
  const machines = gym?.machines ?? [];
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
    return raw.distance != null || raw.seconds != null
      ? { distance: pos(raw.distance, 1000), seconds: int(raw.seconds, 0, 600) } : null;
  }
  return raw.sets != null || raw.reps != null || raw.weight != null
    ? { sets: int(raw.sets, 1, 3), reps: int(raw.reps, 1, 10), weight: pos(raw.weight, 0) } : null;
}

// Turns raw items ({num?, name?, exercise?, target?} — from an LLM file or
// a typed note) into plan items, binding what the gym already knows.
export function planItemsFrom(rawItems, gym) {
  return rawItems.map((raw) => {
    const { machine, name } = resolveItem(raw, gym);
    const flat = raw.target ? { ...raw, ...raw.target } : raw;
    const cardio = machine ? !!machine.cardio : flat.distance != null || flat.seconds != null;
    const target = normalizeTarget(flat, cardio);
    if (machine) {
      const exercise = machine.exercises?.includes(raw.exercise) ? raw.exercise : null;
      return { machineId: machine.id, exercise, ...(target ? { target } : {}) };
    }
    // neither a station nor a name: nothing to train and nothing to bind
    if (!name) return null;
    return {
      machineId: null, name, exercise: null,
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
export function planToText(items, gym, settings = getSettings()) {
  const du = distUnit(settings);
  return items.map((it) => {
    const machine = it.machineId ? gym?.machines.find((m) => m.id === it.machineId) : null;
    if (!machine && !isUnbound(it)) return null; // machine deleted since
    const num = machine?.num ?? it.num ?? null;
    const label = machine ? machine.label : it.name;
    const head = `${num ? `#${num} ` : ''}${label}${it.exercise ? `: ${it.exercise}` : ''}`;
    const t = it.target;
    if (!t) return head;
    if (t.distance != null) {
      const dist = t.distance ? ` ${t.distance}${du}` : '';
      const time = t.seconds
        ? ` ${t.seconds % 60 ? `${t.seconds}s` : `${t.seconds / 60}min`}` : '';
      return `${head}${dist}${time}`;
    }
    return `${head} ${t.sets}x${t.reps}${t.weight ? ` ${t.weight}` : ''}`;
  }).filter(Boolean).join('\n');
}

// Reads a plan out of a typed note. No gym needed — that is the point.
export function planFromText(text, name = '', settings = getSettings()) {
  const raw = parsePlanText(text, settings);
  if (!raw.length) throw new Error('No exercises found — one per line, e.g. "Leg press 3x10 80"');
  return {
    id: uid(),
    name: String(name || '').trim(),
    items: planItemsFrom(raw, getGym()),
  };
}

// Builds a PAST workout out of the same note grammar — the session you
// forgot to log is a plan that already happened, so "3x10 80" means three
// sets of ten at eighty rather than a target of them. Lines naming a num
// the gym doesn't know create that machine (same deal as binding on the
// floor); lines with no findable machine are reported, not invented, so
// nothing lands in the gym that the note didn't actually name.
// Returns { workout, skipped } and persists ONLY the gym, not the workout.
export function workoutFromText(text, startedAt, settings = getSettings()) {
  const raw = parsePlanText(text, settings);
  if (!raw.length) throw new Error('No exercises found — one per line, e.g. "#14 Leg press 3x10 80"');
  const gym = getGym() ?? newGym();
  const entries = [];
  const skipped = [];
  raw.forEach((item) => {
    const [resolved] = planItemsFrom([item], gym);
    if (!resolved) return;
    let machine = resolved.machineId
      ? gym.machines.find((m) => m.id === resolved.machineId) : null;
    if (!machine && item.num) {
      machine = addMachine(gym, item.num, item.name);
      if (item.target?.distance != null) machine.cardio = true;
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
    entries.push({
      machineId: machine.id,
      num: machine.num,
      label: machine.label,
      ...(machine.cardio ? { cardio: true } : {}),
      ...(machine.bodyweight ? { bodyweight: true } : {}),
      ...(resolved.exercise ? { exercise: resolved.exercise } : {}),
      settings: {},
      sets,
    });
  });
  if (!entries.length) {
    throw new Error('No line named a machine gymii knows — put a #number in front of one');
  }
  saveGym(gym);
  // no finishedAt: the duration of a workout logged after the fact is
  // simply unknown, and every consumer already guards for its absence
  return { workout: { id: uid(), startedAt, entries }, skipped };
}

// Resolves an LLM-produced workout-plan file against the current gym.
// Machines are referenced by their visible num — the only stable handle an
// LLM sees in the AI export. A num the gym doesn't know does NOT drop the
// item any more: the answer may arrive hours after the export (or before
// the gym exists at all), so it lands unbound and binds on first use.
// The plan always gets a FRESH id; when the file carries the id of an
// existing plan (a revision of an exported one), that id is only REPORTED
// as `replacesId` — replacing is a destructive choice the caller must
// confirm, never something a pasted file does on its own.
// Does not persist anything.
export function planFromImport(data) {
  if (!Array.isArray(data.items) || !data.items.length) throw new Error('Plan has no items');
  const items = planItemsFrom(data.items, getGym());
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

// Returns the imported kind ('gym-template' | 'backup' | 'workout-plan'),
// throws on bad input.
export function importData(data) {
  if (!data || data.app !== 'gymii') throw new Error('Not a gymii file');
  if (data.kind === 'gym-template') {
    if (!isValidGym(data.gym)) throw new Error('Invalid gym template');
    saveGym(data.gym);
    return 'gym-template';
  }
  if (data.kind === 'backup') {
    if (!isValidGym(data.gym) || !Array.isArray(data.workouts)) throw new Error('Invalid backup');
    saveGym(data.gym);
    saveWorkouts(data.workouts);
    if (Array.isArray(data.plans)) {
      savePlans(data.plans.filter((p) => p && p.id && Array.isArray(p.items)));
    }
    saveSettings({ ...getSettings(), ...data.settings });
    return 'backup';
  }
  if (data.kind === 'workout-plan') {
    savePlan(planFromImport(data).plan);
    return 'workout-plan';
  }
  throw new Error('Unrecognized file kind');
}

// Full factory reset: every profile's data, the registry, and settings.
export function clearAll() {
  const profiles = read(KEYS.profiles, null);
  profiles?.list.forEach((p) => ['gym', 'workouts', 'active', 'plans']
    .forEach((part) => localStorage.removeItem(scopedKey(p.id, part))));
  [KEYS.profiles, KEYS.settings, 'gymii.gym', 'gymii.workouts', 'gymii.active']
    .forEach((k) => localStorage.removeItem(k));
}
