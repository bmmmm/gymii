// The localStorage stub every logic test needs, in one place.
//
// js/store.js keeps no state of its own beyond localStorage, so a Map behind
// the stub IS a device's storage — which is also what makes two devices in
// one process possible (useStore).
//
// It installs itself ON IMPORT, and that is the whole contract: a test must
// list it as its FIRST import. ESM evaluates every dependency completely
// before the importing module's own body runs, so by the time a test reaches
// `await import('../js/store.js')` the stub is already in place — but among
// several static imports, declaration order decides, so a helper listed
// second would still be fine while one listed after a module that touches
// storage at load time would not.
//
// Deliberately outside the CI glob `test/*.test.mjs`: neither the directory
// nor the name matches, so the helper is never run as a suite of its own.

/** The Map the stub reads and writes. Reassigned by useStore(). */
export let mem = new Map();

/**
 * Point the stub at another Map and return it — one call is a device switch.
 * Tests that only need storage to exist never touch this.
 */
export const useStore = (map) => {
  mem = map;
  return map;
};

/**
 * Let the next `n` writes through, then make every further setItem throw the
 * real thing a browser throws when the quota is gone. Infinity by default,
 * so a test that never calls this sees the plain stub.
 *
 * removeItem stays untouched on purpose: deleting frees space, and the store
 * relies on that (finishWorkout clears the active workout AFTER saving it).
 */
export const failWritesAfter = (n = Infinity) => { writesLeft = n; };

let writesLeft = Infinity;

globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => {
    if (writesLeft <= 0) {
      throw new DOMException(
        `Failed to execute 'setItem' on 'Storage': quota exceeded (${k})`,
        'QuotaExceededError');
    }
    writesLeft -= 1;
    mem.set(k, String(v));
  },
  removeItem: (k) => mem.delete(k),
};
