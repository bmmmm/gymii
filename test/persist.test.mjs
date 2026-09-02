// Logic-level test for js/persist.js — the origin-durability layer.
// Its whole job is to survive browsers that answer differently (or not at
// all), so every case here is a different navigator.storage.
// Run with: node test/persist.test.mjs
import { strict as assert } from 'node:assert';

const url = new URL('../js/persist.js', import.meta.url).href;

// Each case installs its own StorageManager object: the module's one-ask
// guard hangs on that object's identity, so a fresh stub IS a fresh page
// load — no test-only reset needed.
const install = (value) => Object.defineProperty(globalThis.navigator, 'storage', {
  configurable: true, value,
});

// --- a browser without the API at all (Node is one) ---
install(undefined);
const { ensurePersisted, isPersisted, estimateOrigin } = await import(url);
assert.equal(await ensurePersisted(), null, 'no StorageManager: null, never a throw');
assert.equal(await isPersisted(), null);
assert.equal(await estimateOrigin(), null);

// --- already persistent: persist() must NOT be called ---
// Firefox asks the user here. Asking when the answer is already yes would
// raise a permission prompt for nothing.
{
  const log = { persist: 0 };
  install({
    persisted: async () => true,
    persist: async () => { log.persist += 1; return true; },
  });
  assert.equal(await ensurePersisted(), true, 'already persistent');
  assert.equal(log.persist, 0, 'and no permission prompt was raised for it');
}

// --- not persistent: ask once, and only once per load ---
{
  const log = { persist: 0 };
  install({
    persisted: async () => false,
    persist: async () => { log.persist += 1; return true; },
  });
  assert.equal(await ensurePersisted(), true, 'the browser grants it');
  assert.equal(await ensurePersisted(), false, 'a second ask this load reports "not granted"');
  assert.equal(log.persist, 1,
    'but does NOT prompt again — otherwise every finished workout raises a Firefox dialog');
}

// --- a browser that says no stays honest: no dead button ---
{
  install({ persisted: async () => false, persist: async () => false });
  assert.equal(await ensurePersisted(), false, 'a refused request reads as false, not as success');
}

// --- rejections are answers too, not unhandled crashes in a finish handler ---
{
  install({
    persisted: async () => { throw new Error('nope'); },
    persist: async () => true,
  });
  assert.equal(await ensurePersisted(), null, 'a rejecting persisted() yields null');
  assert.equal(await isPersisted(), null);
}
{
  install({
    persisted: async () => false,
    persist: async () => { throw new Error('nope'); },
  });
  assert.equal(await ensurePersisted(), null, 'a rejecting persist() yields null');
}

// --- estimate(): context, and only when it is real ---
{
  install({ estimate: async () => ({ usage: 1234, quota: 5678 }) });
  assert.deepEqual(await estimateOrigin(), { usage: 1234, quota: 5678 });
}
{
  install({ estimate: async () => ({}) });
  assert.equal(await estimateOrigin(), null,
    'a browser that answers with no numbers gives no numbers to render');
}
{
  install({ estimate: async () => { throw new Error('nope'); } });
  assert.equal(await estimateOrigin(), null, 'and a rejecting estimate() must not kill Settings');
}

console.log('persist: all assertions passed');
