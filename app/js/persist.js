// Origin durability — a different question from what store.js answers.
// store.js is the localStorage LAYER (keys, shapes, migrations); this file
// only asks the browser to keep that storage around. It imports nothing.
//
// Why it matters more than running out of room: the measured cost of a
// workout is ~890 bytes, so a lifetime of training fits in the ~5 MB every
// browser grants. Being CLEARED is the real risk. WebKit's ITP wipes
// script-writable storage — localStorage included — after seven days
// without interaction, on every site, not just trackers. Web apps added to
// the Home Screen are explicitly exempt, which is why the UI recommends
// installing and does not stop at calling an API.

// Guarded via globalThis, never `typeof navigator === 'undefined'`: Node has
// a navigator, it just has no storage manager.
const sm = () => globalThis.navigator?.storage ?? null;

// One ask per page load. The guard hangs on the StorageManager's IDENTITY
// rather than a boolean, because Firefox shows a permission PROMPT here:
// asking twice would pop it twice. In a test each stub is a fresh object,
// so every case starts clean without a test-only reset hatch.
let askedFor = null;

/**
 * Ask the browser to keep this origin's storage, at most once per load.
 * Returns true/false once known, or null when the browser cannot say.
 * Never throws — a rejected promise here must not break the caller.
 */
export async function ensurePersisted() {
  const storage = sm();
  if (!storage?.persist || !storage.persisted) return null;
  try {
    if (await storage.persisted()) return true;
    // Already asked this load: a second persist() would prompt again in
    // Firefox, and the answer cannot have changed without a reload.
    if (askedFor === storage) return false;
    askedFor = storage;
    return await storage.persist();
  } catch {
    return null;
  }
}

/** Whether the origin is already persistent, or null if unknowable. */
export async function isPersisted() {
  const storage = sm();
  if (!storage?.persisted) return null;
  try {
    return await storage.persisted();
  } catch {
    return null;
  }
}

/**
 * The browser's own view of the whole origin: { usage, quota } or null.
 * Deliberately NOT the number the Storage card leads with — estimate()
 * reports IndexedDB and the Cache API only, so gymii's own localStorage
 * bytes are not in it. It is context, next to the honest count.
 */
export async function estimateOrigin() {
  const storage = sm();
  if (!storage?.estimate) return null;
  try {
    const { usage, quota } = await storage.estimate();
    return typeof usage === 'number' && typeof quota === 'number' ? { usage, quota } : null;
  } catch {
    return null;
  }
}
