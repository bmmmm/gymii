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
// auto-creates one on first visit.
export function createProfile(name) {
  const profiles = ensureProfiles();
  const id = uid();
  profiles.list.push({ id, name: String(name || '').trim() || 'New gym' });
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

// Refuses to delete the last remaining profile (returns false). Deleting
// the active profile switches to the first remaining one.
export function deleteProfile(id) {
  const profiles = ensureProfiles();
  if (profiles.list.length <= 1) return false;
  profiles.list = profiles.list.filter((p) => p.id !== id);
  if (profiles.activeId === id) profiles.activeId = profiles.list[0].id;
  write(KEYS.profiles, profiles);
  ['gym', 'workouts', 'active'].forEach((part) => localStorage.removeItem(scopedKey(id, part)));
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

export function saveWorkouts(list) {
  write(scopedKey(activeProfileId(), 'workouts'), list);
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
  };
  const list = getWorkouts();
  list.push(workout);
  saveWorkouts(list);
  return workout;
}

// --- settings ---

export function getSettings() {
  return {
    v: 1, restSeconds: 90, weightStep: 2.5, unit: 'kg', mapColors: 'custom',
    ...read(KEYS.settings, {}),
  };
}

// Distances pair with the weight unit: meters in metric, miles in imperial.
export const distUnit = (settings) => (settings.unit === 'kg' ? 'm' : 'mi');

// Stored weights and distances are always in the current display unit.
// Switching units therefore converts every stored value — across ALL
// profiles' histories and active workouts (unit is global, data is per
// profile) — plus the shared weight step. Weights round to the nearest 0.5
// in the target unit; distances to whole meters / hundredths of a mile.
// Seconds are unit-less and untouched.
export function setUnit(unit) {
  const s = getSettings();
  if (unit === s.unit) return;
  const wFactor = unit === 'lbs' ? 2.2046226218 : 1 / 2.2046226218;
  const roundW = (v) => Math.round(v * wFactor * 2) / 2;
  const roundD = unit === 'lbs'
    ? (v) => Math.round((v / 1609.344) * 100) / 100
    : (v) => Math.round(v * 1609.344);
  const convertSets = (entries) => entries.forEach((e) => e.sets.forEach((st) => {
    if (st.weight != null) st.weight = roundW(st.weight);
    if (st.distance != null) st.distance = roundD(st.distance);
  }));

  ensureProfiles().list.forEach((p) => {
    const workouts = read(scopedKey(p.id, 'workouts'), []);
    workouts.forEach((w) => convertSets(w.entries));
    write(scopedKey(p.id, 'workouts'), workouts);

    const active = read(scopedKey(p.id, 'active'), null);
    if (active) {
      convertSets(active.entries);
      write(scopedKey(p.id, 'active'), active);
    }
  });

  saveSettings({ ...s, unit, weightStep: Math.max(0.5, roundW(s.weightStep)) });
}

// Total sets per machine across all history — feeds the usage map view.
export function usageByMachine() {
  const usage = new Map();
  getWorkouts().forEach((w) => w.entries.forEach((e) => {
    usage.set(e.machineId, (usage.get(e.machineId) || 0) + e.sets.length);
  }));
  return usage;
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

// Returns the imported kind ('gym-template' | 'backup'), throws on bad input.
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
    saveSettings({ ...getSettings(), ...data.settings });
    return 'backup';
  }
  throw new Error('Unrecognized file kind');
}

// Full factory reset: every profile's data, the registry, and settings.
export function clearAll() {
  const profiles = read(KEYS.profiles, null);
  profiles?.list.forEach((p) => ['gym', 'workouts', 'active']
    .forEach((part) => localStorage.removeItem(scopedKey(p.id, part))));
  [KEYS.profiles, KEYS.settings, 'gymii.gym', 'gymii.workouts', 'gymii.active']
    .forEach((k) => localStorage.removeItem(k));
}
