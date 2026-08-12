// All localStorage access lives here. Keys are versioned via a `v` field
// inside each object so future schema migrations have something to check.

const KEYS = {
  gym: 'gymii.gym',
  workouts: 'gymii.workouts',
  active: 'gymii.active',
  settings: 'gymii.settings',
};

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

// --- gym template ---

export function getGym() {
  const gym = read(KEYS.gym, null);
  if (gym && !Array.isArray(gym.outline)) gym.outline = defaultOutline(gym.grid); // pre-outline gyms
  if (gym && !gym.meta) gym.meta = {}; // pre-meta gyms
  return gym;
}

export function saveGym(gym) {
  write(KEYS.gym, gym);
}

export function defaultOutline(grid) {
  return [
    { x: 0, y: 0 },
    { x: grid.w, y: 0 },
    { x: grid.w, y: grid.h },
    { x: 0, y: grid.h },
  ];
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
  return read(KEYS.workouts, []);
}

export function saveWorkouts(list) {
  write(KEYS.workouts, list);
}

// Most recent entry with at least one set for this machine, or null.
export function lastEntryFor(machineId) {
  const workouts = getWorkouts();
  for (let i = workouts.length - 1; i >= 0; i--) {
    const entry = workouts[i].entries.find((e) => e.machineId === machineId);
    if (entry && entry.sets.length) return entry;
  }
  return null;
}

// --- active (in-progress) workout, saved after every set for crash safety ---

export function getActive() {
  return read(KEYS.active, null);
}

export function saveActive(workout) {
  write(KEYS.active, workout);
}

export function clearActive() {
  localStorage.removeItem(KEYS.active);
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
  };
  const list = getWorkouts();
  list.push(workout);
  saveWorkouts(list);
  return workout;
}

// --- settings ---

export function getSettings() {
  return { v: 1, restSeconds: 90, weightStep: 2.5, unit: 'kg', ...read(KEYS.settings, {}) };
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
    && gym.machines.every((m) => m.id && Number.isFinite(m.num))
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

export function clearAll() {
  Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
}
