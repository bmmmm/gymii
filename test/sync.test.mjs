// Protocol-level tests for js/sync.js (M1): the wire contract from
// docs/sync-protocol.md against a stubbed fetch, a REAL WebCrypto
// encrypt->decrypt roundtrip (the test decrypts what the client pushed with
// its own independent implementation), the 409 loop, unit normalization at
// the wire, and the promise that sync credentials never enter a backup.
// Run with: node test/sync.test.mjs
import { mem, useStore } from './helpers/localstorage.mjs'; // FIRST: installs the stub
import { strict as assert } from 'node:assert';

// Two devices, one process: the store keeps no state of its own beyond
// localStorage, so pointing the stub at another Map IS another device.
// `mem` is an ESM live binding, so the seeding below always writes into
// whichever device useDevice() switched to last — same as the local `let`
// this replaced.
const devices = { A: new Map(), B: new Map() };
const useDevice = (d) => useStore(devices[d]);
useDevice('A');

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
    blob: null,
    revision: 0,
    log: [],
    mode: null,
    ignoreIfNoneMatch: false,
    hook: null,
    // set `tokens` ([{token, hash, mintedAt, name}]) to arm the M3 token
    // API plus real bearer checking; null keeps the M1/M2 behavior
    tokens: null,
    gymsList: null, // override for GET /v1/gyms (discovery listing)
    ...initial,
  };
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    const headers = lower(opts.headers);
    s.log.push({ url, method, headers, body: opts.body });
    if (s.mode === 'offline') throw new TypeError('fetch failed');
    if (s.mode === 'auth') return response(401);
    if (s.mode === 'boom') return response(500);
    if (s.tokens) {
      const holder = s.tokens.find((t) => headers.authorization === `Bearer ${t.token}`);
      if (!holder) return response(401);
      if (url.includes('/v1/tokens')) {
        if (method === 'GET') {
          return response(200, s.tokens.map(({ token, ...rest }) => ({
            ...rest, self: token === holder.token,
          })));
        }
        if (method === 'POST') {
          const body = JSON.parse(opts.body || '{}');
          const n = s.tokens.length + 1;
          const t = {
            token: `minted-${n}`,
            hash: '0'.repeat(60) + String(n).padStart(4, '0'),
            mintedAt: `2026-08-31T00:0${n}:00Z`,
            name: body.name ?? '',
          };
          s.tokens.push(t);
          const { token, ...rest } = t;
          return response(201, { token, ...rest });
        }
        if (method === 'DELETE') {
          const hash = url.split('/v1/tokens/')[1];
          const idx = s.tokens.findIndex((t) => t.hash === hash);
          if (idx === -1) return response(404);
          if (s.tokens.length === 1) return response(409);
          s.tokens.splice(idx, 1);
          return response(204);
        }
      }
      if (method === 'GET' && url.endsWith('/v1/gyms')) {
        return response(200, s.gymsList
          ?? (s.blob ? [{ gymId: s.blob.gymId, revision: s.revision, updatedAt: 'x' }] : []));
      }
    }
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
    if (method === 'DELETE') {
      s.blob = null;
      s.revision = 0; // the server forgets the revision (protocol: restart at 1)
      return response(204);
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
assert.equal(parsed.server, 'http://sync.local'); // normalized: no trailing slash
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
// Without local edits a 304 ends the sync: nothing pushed, revision never
// bumps (M2's dirty flag — without it every ambient pull would re-push).
srv.log.length = 0;
const cached = await sync.syncNow(gid);
assert.equal(cached.status, 'synced', '2: 304 counts as synced');
assert.deepEqual(methods(srv), ['GET'], '2: no edits, no push');
assert.equal(srv.log[0].headers['if-none-match'], '"1"', '2: If-None-Match carries the known revision');

// with the dirty flag up (an edit not yet pushed) the 304 still pushes
store.saveSyncConfig(gid, { ...store.getSyncConfig(gid), dirty: true });
srv.log.length = 0;
const dirtySync = await sync.syncNow(gid);
assert.equal(dirtySync.status, 'synced', '2: dirty 304 syncs');
assert.deepEqual(methods(srv), ['GET', 'PUT'], '2: dirty means push');
assert.equal(srv.log[1].headers['if-match'], '"1"', '2: If-Match carries the revision');
assert.equal(store.getSyncConfig(gid).dirty, false, '2: the push lowered the flag');

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
assert.equal(state.server, 'http://sync.local'); // normalized: no trailing slash
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

// --- 12. a bare domain means https; an explicit scheme is respected ---
// The reference deployment fronts the server with a real certificate, and
// the https-served app cannot fetch plain http anyway (mixed content) — so
// the field takes just the domain. http://localhost stays possible for dev
// and same-origin setups by typing the scheme out.
devices.E = new Map();
useDevice('E');
seedRegistry();
srv = fakeServer();
await sync.enableSync(gid, { server: 'sync.example.org/', token: 'tok-12' });
assert.ok(srv.log[0].url.startsWith('https://sync.example.org/v1/gyms/'),
  '12: bare domain got https:// and lost its trailing slash');
assert.equal(sync.getSyncState(gid).server, 'https://sync.example.org',
  '12: the normalized form is what the config stores');
sync.disableSync(gid);
srv.log.length = 0;
await sync.enableSync(gid, { server: 'http://localhost:8639', token: 'tok-12' });
assert.ok(srv.log[0].url.startsWith('http://localhost:8639/v1/gyms/'),
  '12: an explicit scheme is respected');
await assert.rejects(() => sync.enableSync(gid, { server: '   ', token: 'tok-12' }),
  /bad-server/, '12: whitespace is not a server');

// --- 13. the explicit unencrypted mode (plain-http docker-net setups) ---
// crypto.subtle only exists in secure contexts; on a plain-http page the
// browser refuses E2E. The mode is explicit on both ends: never silently
// unencrypted, never a downgrade where crypto works, and the envelope/code
// both say what they are.
const realCrypto = globalThis.crypto;
const insecureContext = () => Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) },
});
const secureContext = () => Object.defineProperty(globalThis, 'crypto', {
  configurable: true, value: realCrypto,
});

devices.F = new Map();
useDevice('F');
seedRegistry();
store.savePlans([{
  id: 'pF', name: 'Visible plan', createdAt: 500, updatedAt: 500, items: [],
}]);
srv = fakeServer();
assert.equal(sync.e2eAvailable(), true, '13: secure context detected');
await assert.rejects(() => sync.enableSync(gid, { server: 'http://box:8639', token: 't', plain: true }),
  /crypto-available/, '13: no downgrade next to working crypto');

insecureContext();
try {
  assert.equal(sync.e2eAvailable(), false, '13: insecure context detected');
  await assert.rejects(() => sync.enableSync(gid, { server: 'http://box:8639', token: 't' }),
    /no-crypto/, '13: nothing goes unencrypted silently');
  const plainEnable = await sync.enableSync(gid, {
    server: 'http://box:8639', token: 'tok-13', plain: true,
  });
  assert.equal(plainEnable.sync.status, 'synced', '13: plain enable syncs');
  assert.equal(srv.blob.ciphertext, undefined, '13: no ciphertext in the plain envelope');
  assert.equal(srv.blob.plain.kind, 'sync-gym', '13: the payload rides readably');
  assert.ok(srv.log.some((r) => String(r.body).includes('Visible plan')),
    '13: readable on the wire — that is the stated trade');
  const parsedPlain = JSON.parse(
    Buffer.from(plainEnable.code.slice('gymii-sync:v1:'.length), 'base64url').toString());
  assert.equal(parsedPlain.plain, true, '13: the code names the mode');
  assert.equal(parsedPlain.pass, undefined, '13: and carries no passphrase');
  assert.equal(sync.getSyncState(gid).plain, true, '13: state reports the mode');
  assert.equal(store.getSyncKey(gid), null, '13: no key material is stored');

  // an E2E code cannot pair where the browser refuses crypto
  await assert.rejects(() => sync.pairWithCode(gid, code), /no-crypto/,
    '13: an encrypted gym needs a secure context');

  // a second insecure device pairs with the plain code and receives data
  devices.G = new Map();
  useDevice('G');
  seedRegistry();
  const pairedPlain = await sync.pairWithCode(gid, plainEnable.code);
  assert.equal(pairedPlain.sync.status, 'synced', '13: plain pairing syncs');
  assert.ok(store.getPlans().some((p) => p.name === 'Visible plan'), "13: F's plan arrived on G");

  // a client whose mode disagrees with the blob says so instead of guessing
  srv.blob = {
    v: 1, gymId: gid, salt: 'c2FsdA==', iv: 'aXYxMjM0NTY3OA==', ciphertext: 'Y3Q=',
  };
  srv.revision += 1;
  const mismatch = await sync.syncNow(gid);
  assert.equal(mismatch.status, 'error', '13: mode mismatch is an error');
  assert.equal(mismatch.detail, 'mode-mismatch');
} finally {
  secureContext();
}

// the mode follows the blob: a plain code pairs plain even on a secure page
devices.H = new Map();
useDevice('H');
seedRegistry();
srv = fakeServer();
const plainCode = `gymii-sync:v1:${Buffer.from(JSON.stringify({
  server: 'http://box:8639', token: 'tok-13', gymId: gid, plain: true,
})).toString('base64url')}`;
const pairedSecure = await sync.pairWithCode(gid, plainCode);
assert.equal(pairedSecure.sync.status, 'synced', '13: plain code pairs on a secure page too');
assert.equal(sync.getSyncState(gid).plain, true, '13: and stays honestly plain');

// --- 14. ambient sync (M2): coalescing, suppression, offline, deletes ---
const puts = () => methods(srv).filter((m) => m === 'PUT').length;
devices.M = new Map();
useDevice('M');
seedRegistry();
srv = fakeServer();
await sync.initAmbientSync({ editDebounceMs: 0, pullThrottleMs: 0 });
const enabledM = await sync.enableSync(gid, { server: 'http://sync.local', token: 'tok-14' });
assert.equal(enabledM.sync.status, 'synced', '14: setup');
const passM = JSON.parse(
  Buffer.from(enabledM.code.slice('gymii-sync:v1:'.length), 'base64url').toString()).pass;

// a burst of edits coalesces: the run in flight absorbs later triggers
// into ONE follow-up instead of racing (debounce 0 = every edit fires)
srv.log.length = 0;
store.savePlan({ id: 'pm1', name: 'Burst 1', items: [] });
store.savePlan({ id: 'pm2', name: 'Burst 2', items: [] });
store.savePlan({ id: 'pm3', name: 'Burst 3', items: [] });
await sync.ambientSettled();
assert.ok(puts() >= 1 && puts() <= 2, `14: burst coalesced into <=2 pushes, got ${puts()}`);
const afterBurst = await decryptBlob(srv.blob, passM);
assert.equal(afterBurst.plans.length, 3, '14: every edit of the burst arrived');

// suppression: applying a pull must not echo into another push
devices.N = new Map();
useDevice('N');
seedRegistry();
srv.log.length = 0;
await sync.pairWithCode(gid, enabledM.code);
await sync.ambientSettled();
assert.equal(puts(), 0, "14: applying M's data on N triggered no echo push");
assert.equal(store.getPlans().length, 3, '14: and the data landed');

// idle visible: GET only, the revision never bumps
srv.log.length = 0;
const revBefore = srv.revision;
await sync.ambientVisible();
await sync.ambientSettled();
assert.deepEqual(methods(srv), ['GET'], '14: idle pull pushes nothing');
assert.equal(srv.revision, revBefore, '14: revision untouched');

// pull throttle: the visible above just stamped lastPull — with a real
// window set, the next visible makes no request at all
sync.initAmbientSync({ pullThrottleMs: 60000 }); // retune only, no re-wire
srv.log.length = 0;
await sync.ambientVisible();
await sync.ambientSettled();
assert.equal(srv.log.length, 0, '14: a visible inside the window is throttled');
sync.initAmbientSync({ pullThrottleMs: 0 });

// offline edit -> pending flag; back online -> replayed and cleared
srv.mode = 'offline';
store.savePlan({ id: 'pn1', name: 'Offline edit', items: [] });
await sync.ambientSettled();
assert.equal(sync.getSyncState(gid).pending, true, '14: offline edit is pending');
srv.mode = null;
await sync.ambientOnline();
await sync.ambientSettled();
assert.equal(sync.getSyncState(gid).pending, false, '14: replay cleared the flag');
assert.equal((await decryptBlob(srv.blob, passM)).plans.length, 4, '14: the offline edit arrived');

// a held cross-tab lock skips the run entirely
Object.defineProperty(globalThis.navigator, 'locks', {
  configurable: true,
  value: { request: async (_name, _opts, cb) => cb(null) }, // lock is taken
});
srv.log.length = 0;
await sync.ambientFinished();
await sync.ambientSettled();
assert.equal(srv.log.length, 0, '14: the losing tab makes no requests');
delete globalThis.navigator.locks;

// deleting the gym queues the server blob's DELETE and drains it
store.createGym('Keeper'); // deleteGym refuses to remove the last gym
assert.equal(store.deleteGym(gid), true, '14: gym deleted locally');
assert.equal(store.getPendingDeletes().length, 1, '14: blob delete queued');
assert.equal(store.getPendingDeletes()[0].remoteId, gid, '14: under the blob id');
srv.log.length = 0;
await sync.ambientOnline();
await sync.ambientSettled();
assert.ok(methods(srv).includes('DELETE'), '14: the queued DELETE went out');
assert.equal(store.getPendingDeletes().length, 0, '14: and left the queue');
assert.equal(srv.blob, null, '14: the blob is gone from the server');

// --- 15. devices & discovery (M3): per-device tokens, adopt-a-blob ---
devices.P = new Map();
useDevice('P');
seedRegistry();
srv = fakeServer({
  tokens: [{
    token: 'tok-15', hash: 'a'.repeat(64), mintedAt: '2026-08-31T00:00:00Z', name: 'first',
  }],
});
let activity = 0;
const offActivity = sync.onSyncActivity(() => { activity += 1; });
const en15 = await sync.enableSync(gid, { server: 'http://sync.local', token: 'tok-15' });
assert.equal(en15.sync.status, 'synced', '15: setup');
assert.ok(activity >= 1, '15: sync activity notified');
store.savePlan({ id: 'p15', name: 'Device plan', items: [] });
await sync.ambientSettled();

const devicesP = await sync.listDevices(gid);
assert.equal(devicesP.length, 1, '15: one device');
assert.equal(devicesP[0].self, true, '15: marked as this device');
assert.equal(devicesP[0].name, 'first');

// pairing mints a FRESH token — this device's own never leaves it
const minted = await sync.mintPairingCode(gid, 'phone');
const parsed15 = JSON.parse(
  Buffer.from(minted.code.slice('gymii-sync:v1:'.length), 'base64url').toString());
assert.equal(parsed15.token, 'minted-2', '15: the code carries the fresh token');
assert.notEqual(parsed15.token, 'tok-15', '15: never the minting device\'s own');
assert.ok(parsed15.pass, '15: passphrase rides along (E2E gym)');

devices.Q = new Map();
useDevice('Q');
seedRegistry();
const pairedQ = await sync.pairWithCode(gid, minted.code);
assert.equal(pairedQ.sync.status, 'synced', '15: fresh token pairs');
assert.ok(store.getPlans().some((p) => p.name === 'Device plan'), '15: data arrived on Q');
const devicesQ = await sync.listDevices(gid);
assert.equal(devicesQ.length, 2, '15: both devices listed');
assert.equal(devicesQ.find((d) => d.self)?.name, 'phone', '15: self follows the requester');

// revoking Q's token from P cuts Q off — and only Q
useDevice('P');
await sync.revokeDevice(gid, devicesQ.find((d) => d.self).hash);
useDevice('Q');
const cut = await sync.syncNow(gid);
assert.equal(cut.status, 'auth', '15: revoked device gets 401');
useDevice('P');
assert.equal((await sync.syncNow(gid)).status, 'synced', '15: the other device keeps syncing');

// the last token refuses to die (lockout guard)
await assert.rejects(() => sync.revokeDevice(gid, 'a'.repeat(64)), /last-token/,
  '15: the last token is protected');

// discovery: the account's other blobs, minus what is already mapped
srv.gymsList = [
  { gymId: gid, revision: srv.revision, updatedAt: 'x' },
  { gymId: 'otherblob0000001', revision: 3, updatedAt: 'y' },
];
const found = await sync.listRemoteGyms(gid);
assert.deepEqual(found.map((b) => b.gymId), ['otherblob0000001'],
  '15: only unmapped blobs are listed');

// adopt a PLAIN blob: one tap, no key needed
const gymCountBefore = store.getGyms().list.length;
const keepBlob = { blob: srv.blob, revision: srv.revision };
srv.blob = {
  v: 1,
  gymId: 'otherblob0000001',
  plain: {
    app: 'gymii',
    kind: 'sync-gym',
    v: 1,
    gym: null,
    workouts: [],
    plans: [{
      id: 'padopt', name: 'Adopted plan', createdAt: 5, updatedAt: 5, items: [],
    }],
    tombstones: {
      workouts: [], plans: [], machines: [], shapes: [],
    },
    gymEntry: { id: 'otherblob0000001', name: 'Garage gym', updatedAt: 7 },
    userSettings: { unit: 'kg', updatedAt: 0 },
  },
};
srv.revision = 3;
const adopted = await sync.adoptRemoteGym(gid, 'otherblob0000001', null);
assert.equal(adopted.sync.status, 'synced', '15: plain blob adopts without a key');
assert.equal(store.getGyms().list.length, gymCountBefore + 1, '15: a new local gym exists');
useDevice('P'); // adoption switched activeId to the new gym — stay explicit
store.setActiveGym(adopted.gid);
assert.ok(store.getPlans().some((p) => p.name === 'Adopted plan'), '15: its data arrived');
assert.equal(store.getGyms().list.find((g) => g.id === adopted.gid).name, 'Garage gym',
  '15: the real name arrived with the first pull');
assert.equal(store.getSyncConfig(adopted.gid).plain, true, '15: mode followed the blob');
store.setActiveGym(gid);

// adopting an ENCRYPTED blob needs that gym's own passphrase — and a wrong
// one leaves no local trace
const encPayload = { ...srv.blob.plain, gymEntry: { id: 'encblob000000001', name: 'Enc gym', updatedAt: 7 } };
const encSalt = b64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
srv.blob = await encryptBlob(encPayload, 'right-pass', encSalt, 'encblob000000001');
srv.revision = 4;
await assert.rejects(() => sync.adoptRemoteGym(gid, 'encblob000000001', null), /need-pass/,
  '15: encrypted blob demands the passphrase');
const before15 = store.getGyms().list.length;
await assert.rejects(() => sync.adoptRemoteGym(gid, 'encblob000000001', 'wrong-pass'), /decrypt/,
  '15: wrong passphrase is refused');
assert.equal(store.getGyms().list.length, before15, '15: and leaves nothing behind');
const adoptedEnc = await sync.adoptRemoteGym(gid, 'encblob000000001', 'right-pass');
assert.equal(adoptedEnc.sync.status, 'synced', '15: right passphrase adopts');
assert.equal(store.getSyncKey(adoptedEnc.gid).pass, 'right-pass', '15: key stored for the new gym');

// health aggregates worst-of across configured gyms
assert.deepEqual(sync.syncHealth(), { state: 'ok' }, '15: all quiet');
store.saveSyncConfig(adoptedEnc.gid, {
  ...store.getSyncConfig(adoptedEnc.gid), syncPending: true,
});
assert.deepEqual(sync.syncHealth(), { state: 'pending' }, '15: pending surfaces');
store.saveSyncConfig(adopted.gid, {
  ...store.getSyncConfig(adopted.gid), lastError: 'HTTP 500',
});
assert.deepEqual(sync.syncHealth(), { state: 'error' }, '15: error beats pending');
offActivity();
srv.blob = keepBlob.blob;
srv.revision = keepBlob.revision;

console.log('sync client: all assertions passed');
