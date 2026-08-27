// Protocol-level tests for js/sync.js (M1): the wire contract from
// docs/sync-protocol.md against a stubbed fetch, a REAL WebCrypto
// encrypt->decrypt roundtrip (the test decrypts what the client pushed with
// its own independent implementation), the 409 loop, unit normalization at
// the wire, and the promise that sync credentials never enter a backup.
// Run with: node test/sync.test.mjs
import { strict as assert } from 'node:assert';

// Two devices, one process: the store keeps no state of its own beyond
// localStorage, so pointing the stub at another Map IS another device.
const devices = { A: new Map(), B: new Map() };
let mem = devices.A;
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const useDevice = (d) => { mem = devices[d]; };

const store = await import(new URL('../js/store.js', import.meta.url).href);
const sync = await import(new URL('../js/sync.js', import.meta.url).href);

// --- an independent implementation of the crypto half of the contract ---
const PBKDF2_ITERATIONS = 600000;
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const keys = new Map();

function keyFor(pass, salt) {
  const ck = `${salt} ${pass}`;
  if (!keys.has(ck)) {
    keys.set(ck, globalThis.crypto.subtle
      .importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey'])
      .then((base) => globalThis.crypto.subtle.deriveKey(
        {
          name: 'PBKDF2', salt: unb64(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256',
        },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
      )));
  }
  return keys.get(ck);
}

async function decryptBlob(envelope, pass) {
  const key = await keyFor(pass, envelope.salt);
  const plain = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(envelope.iv) }, key, unb64(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function encryptBlob(payload, pass, salt, gymId) {
  const key = await keyFor(pass, salt);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return {
    v: 1, gymId, salt, iv: b64(iv), ciphertext: b64(new Uint8Array(ct)),
  };
}

// --- the fake blob server ---
const lower = (headers = {}) => Object.fromEntries(
  Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

const response = (status, body, revision) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (n) => (n.toLowerCase() === 'etag' && revision != null ? `"${revision}"` : null),
  },
  json: async () => {
    if (body == null) throw new Error('no body');
    return JSON.parse(JSON.stringify(body));
  },
});

function fakeServer(initial = {}) {
  const s = {
    blob: null, revision: 0, log: [], mode: null, ignoreIfNoneMatch: false, hook: null, ...initial,
  };
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    const headers = lower(opts.headers);
    s.log.push({ url, method, headers, body: opts.body });
    if (s.mode === 'offline') throw new TypeError('fetch failed');
    if (s.mode === 'auth') return response(401);
    if (s.mode === 'boom') return response(500);
    if (method === 'GET') {
      if (!s.blob) return response(404);
      if (!s.ignoreIfNoneMatch && headers['if-none-match'] === `"${s.revision}"`) {
        return response(304, null, s.revision);
      }
      return response(200, s.blob, s.revision);
    }
    if (method === 'PUT') {
      if (s.hook) { const h = s.hook; s.hook = null; await h(s); }
      if (s.mode === 'conflict' || headers['if-match'] !== `"${s.revision}"`) {
        return response(409, null, s.revision);
      }
      s.blob = JSON.parse(opts.body);
      s.revision += 1;
      return response(200, null, s.revision);
    }
    return response(405);
  };
  return s;
}

const methods = (srv) => srv.log.map((r) => r.method);

// --- device A: a gym with a layout, a workout and a plan ---
const gid = 'gymshared0000001'; // both devices sync the SAME gym id (M1)
const seedRegistry = (name = 'Home gym') => {
  mem.set('gymii.gyms', JSON.stringify({
    v: 1, list: [{ id: gid, name, updatedAt: 100 }], activeId: gid,
  }));
};

const workout = (id, at, weight = 40) => ({
  id,
  startedAt: at,
  finishedAt: at + 1000,
  updatedAt: at,
  entries: [{
    machineId: 'm1', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight }],
  }],
});

useDevice('A');
seedRegistry();
const layout = store.newLayout('Home layout');
layout.machines.push({
  id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Chest'],
});
store.saveLayout(layout);
store.saveWorkouts([workout('wA', 1000)]);
store.savePlans([{
  id: 'pA', name: 'Push', createdAt: 500, updatedAt: 500, items: [{ machineId: 'm1' }],
}]);

// --- 1. enableSync: first push claims revision 0 ---
let srv = fakeServer();
const first = await sync.enableSync(gid, { server: 'http://sync.local/', token: 'tok-1' });
assert.equal(first.sync.status, 'synced', '1: first sync succeeds');
assert.deepEqual(methods(srv), ['GET', 'PUT'], '1: GET then PUT');
assert.equal(srv.log[0].url, 'http://sync.local/v1/gyms/gymshared0000001', '1: /v1/gyms/{id}');
assert.equal(srv.log[0].headers.authorization, 'Bearer tok-1', '1: bearer token on the GET');
assert.equal(srv.log[0].headers['if-none-match'], undefined, '1: no revision yet, nothing to revalidate');
assert.equal(srv.log[1].headers.authorization, 'Bearer tok-1', '1: bearer token on the PUT');
assert.equal(srv.log[1].headers['if-match'], '"0"', '1: "0" is the first push');
assert.equal(srv.revision, 1, '1: the server bumped the revision');

// the envelope is exactly what the protocol specs, and it is opaque
assert.deepEqual(Object.keys(srv.blob).sort(), ['ciphertext', 'gymId', 'iv', 'salt', 'v']);
assert.equal(srv.blob.v, 1);
assert.equal(srv.blob.gymId, gid);
assert.equal(unb64(srv.blob.iv).length, 12, '1: 12-byte IV');
assert.equal(unb64(srv.blob.salt).length, 16, '1: 16-byte per-gym salt');
assert.equal(srv.log[1].body.includes('Chest press'), false, '1: no plaintext on the wire');

// the sync code: prefix + base64url({server, token, pass})
const { code } = first;
assert.ok(code.startsWith('gymii-sync:v1:'), '1: sync code prefix');
const parsed = JSON.parse(Buffer.from(code.slice('gymii-sync:v1:'.length), 'base64url').toString());
assert.equal(parsed.server, 'http://sync.local/');
assert.equal(parsed.token, 'tok-1');
assert.equal(parsed.gymId, gid, '1: the code carries the blob id — pairing depends on it');
assert.match(parsed.pass, /^[a-z1-9]{4}(-[a-z1-9]{4}){6}$/, '1: ~140 bits in readable groups');
assert.equal(code, sync.getSyncCode(gid), '1: getSyncCode rebuilds the same code');

// real crypto roundtrip: decrypt the pushed blob with an independent impl
const pushed = await decryptBlob(srv.blob, parsed.pass);
assert.equal(pushed.kind, 'sync-gym');
assert.equal(pushed.v, 1);
assert.equal(pushed.workouts[0].id, 'wA');
assert.equal(pushed.plans[0].id, 'pA');
assert.equal(pushed.gym.machines[0].label, 'Chest press', 'the layout rides as the `gym` wire field');
assert.equal(pushed.gymEntry.name, 'Home gym');
assert.equal(pushed.userSettings.unit, 'kg');
assert.equal('timerSound' in pushed.userSettings, false, 'device-scoped settings never leave the device');
assert.equal('keepAwake' in pushed.userSettings, false);

// --- 2. nothing changed ---
// 304 on the conditional GET: the blob is unchanged, so the client falls
// back to pushing local state under the revision it knows.
srv.log.length = 0;
const cached = await sync.syncNow(gid);
assert.equal(cached.status, 'synced', '2: 304 counts as synced');
assert.deepEqual(methods(srv), ['GET', 'PUT'], '2: 304 -> push');
assert.equal(srv.log[0].headers['if-none-match'], '"1"', '2: If-None-Match carries the known revision');
assert.equal(srv.log[1].headers['if-match'], '"1"', '2: If-Match carries it too');

// a full 200 whose content already matches the merge result pushes nothing
srv.log.length = 0;
srv.ignoreIfNoneMatch = true;
const quiet = await sync.syncNow(gid);
srv.ignoreIfNoneMatch = false;
assert.equal(quiet.status, 'synced', '2: identical state is still "synced"');
assert.deepEqual(methods(srv), ['GET'], '2: nothing to push, nothing pushed');

// --- 3. device B pairs with the code and receives everything ---
useDevice('B');
seedRegistry();
srv.log.length = 0;
const paired = await sync.pairWithCode(gid, code);
assert.equal(paired.sync.status, 'synced', '3: pairing syncs');
assert.deepEqual(methods(srv), ['GET'], '3: a receiving device has nothing to push');
assert.equal(store.getWorkouts().length, 1, "3: A's history arrived");
assert.equal(store.getLayout().machines[0].label, 'Chest press', "3: A's layout arrived");
assert.equal(store.getPlans()[0].id, 'pA', "3: A's plan arrived");
assert.equal(store.getSyncKey(gid).salt, srv.blob.salt, '3: the per-gym salt is adopted from the envelope');
assert.equal(paired.code, code, '3: both devices show the same code');

// --- 3b. a device with its OWN gym id pairs onto the same blob ---
// The code carries the blob's gymId; the local id stays local and the wire
// only ever sees the remote one (config `remoteId`). Without this, pairing
// would write a second blob and silently never converge.
devices.C = new Map();
useDevice('C');
const gidC = 'gymlocalphone001';
mem.set('gymii.gyms', JSON.stringify({
  v: 1, list: [{ id: gidC, name: 'Home gym', updatedAt: 100 }], activeId: gidC,
}));
srv.log.length = 0;
const pairedC = await sync.pairWithCode(gidC, code);
assert.equal(pairedC.sync.status, 'synced', '3b: pairing under a different local id syncs');
assert.ok(srv.log.length > 0 && srv.log.every((r) => r.url.endsWith(`/v1/gyms/${gid}`)),
  '3b: every request addresses the BLOB id, never the local one');
assert.equal(store.getLayout().machines[0].label, 'Chest press', "3b: A's layout arrived");
assert.equal(store.getGyms().activeId, gidC, '3b: the local gym keeps its id');
assert.equal(pairedC.code, code, '3b: the re-shown code still carries the blob id');

// --- 4. the 409 loop actually re-merges ---
useDevice('B');
store.saveWorkouts([...store.getWorkouts(), workout('wB', 2000)]);
const thirdParty = {
  ...pushed,
  workouts: [...pushed.workouts, workout('wC', 3000)],
};
srv.log.length = 0;
srv.hook = async (s) => {
  // another device pushed between our GET and our PUT
  s.blob = await encryptBlob(thirdParty, parsed.pass, s.blob.salt, gid);
  s.revision += 1;
};
const raced = await sync.syncNow(gid);
assert.equal(raced.status, 'synced', '4: the loop resolves the conflict');
assert.deepEqual(methods(srv), ['GET', 'PUT', 'GET', 'PUT'], '4: 409 -> re-GET -> re-PUT');
assert.equal(srv.log[3].headers['if-match'], `"${srv.revision - 1}"`, "4: the retry uses the server's revision");
assert.deepEqual(store.getWorkouts().map((w) => w.id).sort(), ['wA', 'wB', 'wC'],
  '4: the re-merge kept both sides');
const settled = await decryptBlob(srv.blob, parsed.pass);
assert.deepEqual(settled.workouts.map((w) => w.id).sort(), ['wA', 'wB', 'wC'],
  '4: and pushed the union');

// --- 5. a server that only ever conflicts gives up after 3 attempts ---
srv.log.length = 0;
srv.mode = 'conflict';
store.saveWorkouts([...store.getWorkouts(), workout('wD', 4000)]);
const stuck = await sync.syncNow(gid);
srv.mode = null;
assert.equal(stuck.status, 'error', '5: a permanent conflict is an error');
assert.equal(stuck.detail, 'conflict');
assert.equal(methods(srv).length, 6, '5: three GET/PUT rounds, then stop');
assert.equal(sync.getSyncState(gid).lastError, 'conflict', '5: the error is recorded for the UI');

// --- 6. auth, offline, decrypt ---
srv.mode = 'auth';
assert.deepEqual(await sync.syncNow(gid), { status: 'auth', detail: 'HTTP 401' }, '6: 401 is an auth failure');
srv.mode = 'offline';
assert.deepEqual(await sync.syncNow(gid), { status: 'offline' }, '6: a dead network is not an error');
srv.mode = 'boom';
assert.deepEqual(await sync.syncNow(gid), { status: 'error', detail: 'HTTP 500' }, '6: 500 is an error');
srv.mode = null;

const foreign = await encryptBlob(pushed, 'wrong-pass', srv.blob.salt, gid);
const goodBlob = srv.blob;
srv.blob = foreign;
srv.revision += 1;
assert.deepEqual(await sync.syncNow(gid), { status: 'decrypt' }, '6: a blob we cannot open says so');
srv.blob = goodBlob;

// state survives a bad round: the config still knows the server
const state = sync.getSyncState(gid);
assert.equal(state.configured, true);
assert.equal(state.server, 'http://sync.local/');
assert.equal(state.lastError, 'decrypt', '6: the last failure is kept');

// --- 7. unit normalization at the wire ---
useDevice('A');
store.setUnit('lbs'); // the device now displays pounds; its data converted
const kgPayload = {
  app: 'gymii',
  kind: 'sync-gym',
  v: 1,
  gym: null,
  workouts: [{
    id: 'wK',
    startedAt: 5000,
    updatedAt: 5000,
    entries: [
      { machineId: 'm1', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 5, weight: 100 }] },
      { machineId: 'm2', num: 2, label: 'Treadmill', settings: {}, sets: [{ distance: 5000, seconds: 600 }] },
    ],
  }],
  plans: [{
    id: 'pK', name: 'Kg plan', createdAt: 500, updatedAt: 5000, items: [{ machineId: 'm1', target: { sets: 3, reps: 10, weight: 60 } }],
  }],
  tombstones: {
    workouts: [], plans: [], machines: [], shapes: [],
  },
  gymEntry: { id: gid, name: 'Home gym', updatedAt: 100 },
  userSettings: {
    unit: 'kg', weightStep: 2.5, restSeconds: 90, updatedAt: 1000,
  },
};
srv = fakeServer({ revision: 42 });
srv.blob = await encryptBlob(kgPayload, parsed.pass, goodBlob.salt, gid);
assert.equal((await sync.syncNow(gid)).status, 'synced', '7: a kg blob syncs onto an lbs device');
const converted = store.getWorkouts().find((w) => w.id === 'wK');
assert.equal(converted.entries[0].sets[0].weight, store.convertWeight(100, 'lbs'), '7: 100 kg arrived as 220.5 lbs');
assert.equal(converted.entries[0].sets[0].weight, 220.5);
assert.equal(converted.entries[1].sets[0].distance, store.convertDistance(5000, 'lbs'), '7: metres arrived as miles');
assert.equal(converted.entries[1].sets[0].seconds, 600, '7: seconds are unit-less');
assert.equal(store.getPlans().find((p) => p.id === 'pK').items[0].target.weight, 132.5, '7: plan targets convert too');
assert.equal(store.getSettings().unit, 'lbs', '7: the newer local unit held');
const rePushed = await decryptBlob(srv.blob, parsed.pass);
assert.equal(rePushed.userSettings.unit, 'lbs', '7: the winning unit goes back on the wire');
assert.equal(rePushed.workouts.find((w) => w.id === 'wK').entries[0].sets[0].weight, 220.5);

// the other direction: a NEWER remote unit converts the local side
const kgWins = {
  ...rePushed,
  userSettings: { ...rePushed.userSettings, unit: 'kg', weightStep: 2.5, updatedAt: Date.now() + 60000 },
};
srv.blob = await encryptBlob(kgWins, parsed.pass, goodBlob.salt, gid);
srv.revision += 1;
assert.equal((await sync.syncNow(gid)).status, 'synced', '7: the reverse direction syncs');
assert.equal(store.getSettings().unit, 'kg', '7: the newer remote unit won');
assert.equal(store.getSettings().weightStep, 2.5, '7: and brought its weight step');
assert.equal(store.getWorkouts().find((w) => w.id === 'wK').entries[0].sets[0].weight, 100,
  '7: local data converted back to kg');
assert.equal(store.getWorkouts().find((w) => w.id === 'wA').entries[0].sets[0].weight, 40,
  '7: including data that never left this device');

// --- 8. tombstones travel and are applied through the bulk writers ---
const withDelete = {
  ...(await decryptBlob(srv.blob, parsed.pass)),
  tombstones: {
    workouts: [{ id: 'wA', at: Date.now() }], plans: [{ id: 'pA', at: Date.now() }], machines: [], shapes: [],
  },
};
srv.blob = await encryptBlob(withDelete, parsed.pass, goodBlob.salt, gid);
srv.revision += 1;
assert.equal((await sync.syncNow(gid)).status, 'synced', '8: a delete syncs');
assert.equal(store.getWorkouts().some((w) => w.id === 'wA'), false, '8: the remote delete removed the workout');
assert.equal(store.getPlans().some((p) => p.id === 'pA'), false, '8: and the plan');
assert.equal(store.getTombstones().workouts.some((t) => t.id === 'wA'), true, '8: the tombstone was stored locally');
assert.equal(store.getWorkouts().some((w) => w.id === 'wK'), true, '8: untouched records stay');

// --- 9. sync credentials never enter a backup ---
const backup = store.exportBackup();
const asFile = JSON.stringify(backup);
assert.equal('sync' in backup, false, '9: no sync config field');
assert.equal('synckey' in backup, false, '9: no key field');
assert.equal(asFile.includes(parsed.pass), false, '9: the passphrase is not in a backup');
assert.equal(asFile.includes('tok-1'), false, '9: the server token is not in a backup');
assert.equal(asFile.includes(store.getSyncKey(gid).salt), false, '9: not even the salt');
assert.ok(store.getSyncConfig(gid), '9: while the config itself is very much there');

// --- 10. bad input, the demo gym, and the reachable states ---
await assert.rejects(() => sync.pairWithCode(gid, 'nope'), /bad-code/, '10: no prefix');
await assert.rejects(() => sync.pairWithCode(gid, 'gymii-sync:v1:@@@@'), /bad-code/, '10: not base64');
await assert.rejects(
  () => sync.pairWithCode(gid, `gymii-sync:v1:${Buffer.from(JSON.stringify({ server: 'x' })).toString('base64url')}`),
  /bad-code/, '10: fields missing');
await assert.rejects(
  () => sync.pairWithCode(gid, `gymii-sync:v1:${Buffer.from(JSON.stringify({ server: 'x', token: 't', pass: 'p' })).toString('base64url')}`),
  /bad-code/, '10: incomplete payload',
);
const demoId = store.createGym('Demo', { demo: true });
store.setActiveGym(gid);
await assert.rejects(() => sync.enableSync(demoId, { server: 'http://x', token: 't' }), /demo-gym/,
  '10: the demo gym never syncs');
await assert.rejects(() => sync.pairWithCode(demoId, code), /demo-gym/);
assert.deepEqual(sync.getSyncState(demoId), { configured: false }, '10: and stays unconfigured');
assert.equal(sync.getSyncCode(demoId), null);
assert.deepEqual(await sync.syncNow(demoId), { status: 'error', detail: 'not-configured' });

const live = sync.getSyncState(gid);
assert.equal(live.configured, true);
assert.ok(live.lastSyncAt > 0, '10: a successful sync is dated');
assert.equal(live.lastError, null, '10: and clears the last error');

// --- 11. deleteGym and clearAll take the credentials with them ---
const otherId = store.createGym('Other');
store.saveSyncConfig(otherId, {
  server: 'http://x', token: 't', rev: 3, lastSyncAt: 1, lastError: null,
});
store.saveSyncKey(otherId, { pass: 'a-b', salt: b64(new Uint8Array(16)) });
assert.ok(store.getSyncConfig(otherId) && store.getSyncKey(otherId));
assert.equal(store.deleteGym(otherId), true);
assert.equal(store.getSyncConfig(otherId), null, '11: deleteGym drops the sync config');
assert.equal(store.getSyncKey(otherId), null, '11: and the key');

// disabling sync keeps the data and only drops the credentials
const before = store.getWorkouts().length;
sync.disableSync(gid);
assert.deepEqual(sync.getSyncState(gid), { configured: false }, '11: disabled');
assert.equal(sync.getSyncCode(gid), null);
assert.equal(store.getSyncKey(gid), null);
assert.equal(store.getWorkouts().length, before, '11: local data untouched');

store.saveSyncConfig(gid, { server: 'http://x', token: 't' });
store.saveSyncKey(gid, { pass: 'x-y', salt: b64(new Uint8Array(16)) });
store.clearAll();
assert.equal(store.getSyncConfig(gid), null, '11: clearAll wipes the sync config');
assert.equal(store.getSyncKey(gid), null, '11: clearAll wipes the key');

console.log('sync client: all assertions passed');
