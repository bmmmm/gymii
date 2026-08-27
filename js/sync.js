// Cross-device sync transport (M1). docs/sync-protocol.md is the contract:
// js/merge.js decides WHAT the reconciled state is, this module decides when
// and moves the bytes — GET blob (ETag) → decrypt → merge per kind → apply
// through the BULK writers → encrypt → PUT (If-Match), with the 409 loop as
// the entire conflict protocol. The server is a dumb store for opaque
// blobs; it never sees plaintext and never resolves a conflict beyond
// "your revision is stale".
//
// No DOM here (the module imports cleanly in Node, which is what makes the
// protocol testable) and no localStorage either: js/store.js stays THE data
// layer, sync only ever calls into it.
//
// Envelope note: the inner envelope in docs/sync-protocol.md lists `gym`
// twice — an editing artifact, JSON cannot hold both. `gym` keeps the
// backup meaning (the LAYOUT — the frozen wire field, see exportBackup) and
// the gym's registry entry travels next to it as `gymEntry`.

import {
  getGyms, setActiveGym, restoreGymEntry,
  getLayout, restoreLayout,
  getWorkouts, saveWorkouts,
  getPlans, savePlans,
  getTombstones, saveTombstones,
  getSettings, restoreSettings, setUnit, convertWeight, convertDistance,
  getSyncConfig, saveSyncConfig, getSyncKey, saveSyncKey,
} from './store.js';
import {
  stamp, mergeWorkouts, mergePlans, mergeLayout, mergeSettings, USER_SETTINGS,
} from './merge.js';

const CODE_PREFIX = 'gymii-sync:v1:';
// OWASP's floor for PBKDF2-SHA256; ~100 ms on a laptop, and the derived key
// is cached per (salt, passphrase) so a sync never pays it twice.
const PBKDF2_ITERATIONS = 600000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
// GET → merge → PUT, and at most two more rounds when someone else pushed
// in between. A third 409 means the server is busier than a personal
// account ever is — report it instead of spinning.
const MAX_ATTEMPTS = 3;

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- small encodings (browser + Node, no Buffer) ---

function bytesToB64(bytes) {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

const b64url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => s.replace(/-/g, '+').replace(/_/g, '/');
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// --- the generated passphrase ---
// 32 unambiguous characters (no i/l/o/0), so a byte modulo the alphabet is
// unbiased (256 / 32 = 8). Seven groups of four = 140 bits, printed in
// readable groups because a human copies this by hand at least once.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz123456789';
const PASS_GROUPS = 7;
const PASS_GROUP_SIZE = 4;

function generatePassphrase() {
  const chars = Array.from(
    randomBytes(PASS_GROUPS * PASS_GROUP_SIZE), (b) => ALPHABET[b % ALPHABET.length]);
  return Array.from({ length: PASS_GROUPS },
    (_, g) => chars.slice(g * PASS_GROUP_SIZE, (g + 1) * PASS_GROUP_SIZE).join('')).join('-');
}

// --- crypto (AES-256-GCM, key from PBKDF2 over passphrase + per-gym salt) ---

const keyCache = new Map();

function aesKey(pass, salt) {
  const cacheKey = `${salt}:${pass}`;
  if (!keyCache.has(cacheKey)) {
    const derived = globalThis.crypto.subtle
      .importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey'])
      .then((base) => globalThis.crypto.subtle.deriveKey(
        {
          name: 'PBKDF2', salt: b64ToBytes(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256',
        },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
      ));
    // a failed derivation must not poison the cache
    derived.catch(() => keyCache.delete(cacheKey));
    keyCache.set(cacheKey, derived);
  }
  return keyCache.get(cacheKey);
}

async function encryptPayload(payload, pass, salt, gymId) {
  const key = await aesKey(pass, salt);
  const iv = randomBytes(IV_BYTES); // fresh per encryption, never reused
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
  return {
    v: 1,
    gymId,
    salt,
    iv: bytesToB64(iv),
    ciphertext: bytesToB64(new Uint8Array(ct)), // GCM's auth tag rides inside
  };
}

async function decryptEnvelope(envelope, pass) {
  const key = await aesKey(pass, envelope.salt);
  const plain = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(envelope.iv) }, key, b64ToBytes(envelope.ciphertext));
  return JSON.parse(dec.decode(plain));
}

// --- sync code: server + token + passphrase, shown once ---
// M1 shares ONE account token across devices (sync-plan decision 13);
// per-device tokens land with M3's device registry. The per-gym salt is
// deliberately NOT in the code: it lives in the outer envelope, so a paired
// device adopts it from the first blob it pulls.

export function getSyncCode(gid) {
  const cfg = getSyncConfig(gid);
  const key = getSyncKey(gid);
  if (!cfg || !key?.pass) return null;
  const body = JSON.stringify({ server: cfg.server, token: cfg.token, pass: key.pass });
  return CODE_PREFIX + b64url(bytesToB64(enc.encode(body)));
}

function parseSyncCode(code) {
  const raw = String(code ?? '').trim();
  if (!raw.startsWith(CODE_PREFIX)) throw new Error('bad-code');
  let data;
  try {
    data = JSON.parse(dec.decode(b64ToBytes(unb64url(raw.slice(CODE_PREFIX.length)))));
  } catch {
    throw new Error('bad-code');
  }
  const { server, token, pass } = data ?? {};
  if (!server || !token || !pass) throw new Error('bad-code');
  return { server: String(server), token: String(token), pass: String(pass) };
}

// --- talking to the server ---

class SyncFail extends Error {
  constructor(status, detail) {
    super(detail || status);
    this.status = status;
    this.detail = detail;
  }
}

const blobUrl = (cfg, gid) => `${String(cfg.server).replace(/\/+$/, '')}/v1/gyms/${encodeURIComponent(gid)}`;

// A thrown fetch is a dead network, never a server verdict — the whole
// point of the offline status.
async function request(url, opts) {
  try {
    return await fetch(url, opts);
  } catch {
    throw new SyncFail('offline');
  }
}

function guardAuth(res) {
  if (res.status === 401 || res.status === 403) throw new SyncFail('auth', `HTTP ${res.status}`);
}

// ETag is the revision, quoted (and possibly weak). No ETag = revision 0.
function revisionOf(res) {
  const tag = res.headers?.get?.('ETag') ?? res.headers?.get?.('etag');
  const n = parseInt(String(tag ?? '').replace(/^W\//, '').replace(/"/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function pull(cfg, gid, knownRev) {
  const headers = { Authorization: `Bearer ${cfg.token}` };
  if (knownRev > 0) headers['If-None-Match'] = `"${knownRev}"`;
  const res = await request(blobUrl(cfg, gid), { method: 'GET', headers });
  guardAuth(res);
  if (res.status === 304) return { kind: 'unchanged' };
  if (res.status === 404) return { kind: 'absent' }; // never pushed
  if (!res.ok) throw new SyncFail('error', `HTTP ${res.status}`);
  let envelope;
  try {
    envelope = await res.json();
  } catch {
    throw new SyncFail('error', 'bad-envelope');
  }
  if (!envelope || envelope.v !== 1 || !envelope.ciphertext || !envelope.iv || !envelope.salt) {
    throw new SyncFail('error', 'bad-envelope');
  }
  return { kind: 'blob', envelope, revision: revisionOf(res) };
}

async function push(cfg, gid, rev, envelope) {
  const res = await request(blobUrl(cfg, gid), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
      'If-Match': `"${rev}"`, // "0" is the first push
    },
    body: JSON.stringify(envelope),
  });
  guardAuth(res);
  // the protocol says 409; a strict HTTP server may answer 412 to a failed
  // If-Match — both mean "you are stale", which is the same loop
  if (res.status === 409 || res.status === 412) return { kind: 'conflict' };
  if (!res.ok) throw new SyncFail('error', `HTTP ${res.status}`);
  return { kind: 'ok', revision: revisionOf(res) || rev + 1 };
}

// --- local state, always for ONE gym ---
// The store's readers and bulk writers address the ACTIVE gym; sync works on
// a named one. Every block below is synchronous, so the swap is never
// observable from outside (no await between switch and restore).
function withGym(gid, fn) {
  const { activeId } = getGyms();
  if (activeId === gid) return fn();
  setActiveGym(gid);
  try {
    return fn();
  } finally {
    setActiveGym(activeId);
  }
}

const EMPTY_LAYOUT = { machines: [], shapes: [] };
const EMPTY_TOMBSTONES = {
  workouts: [], plans: [], machines: [], shapes: [],
};

const userSettingsOf = (settings) => {
  const out = { updatedAt: stamp(settings) };
  USER_SETTINGS.forEach((k) => { if (k in settings) out[k] = settings[k]; });
  return out;
};

// Canonical form for "is the merged state already what the server holds?" —
// key order and the order of id-keyed collections are not information.
function canon(value) {
  if (Array.isArray(value)) {
    const items = value.map(canon);
    if (value.every((i) => i && typeof i === 'object' && !Array.isArray(i) && 'id' in i)) {
      items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    }
    return items;
  }
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach((k) => {
      if (value[k] !== undefined) out[k] = canon(value[k]);
    });
    return out;
  }
  return value;
}

const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// Unit normalization at the wire (docs/sync-protocol.md § Envelope): stored
// weights and distances are in the DISPLAY unit, so the losing side is
// converted before anything merges. This is the transport's job — merge.js
// compares records, it does not know what a kilogram is.
function convertBout(o, unit) {
  if (o.weight != null) o.weight = convertWeight(o.weight, unit);
  if (o.distance != null) o.distance = convertDistance(o.distance, unit);
}

function normalizeUnits(remote, unit) {
  if (!remote || (remote.userSettings?.unit ?? unit) === unit) return remote;
  const copy = JSON.parse(JSON.stringify(remote));
  (copy.workouts ?? []).forEach((w) => (w.entries ?? []).forEach(
    (e) => (e.sets ?? []).forEach((s) => convertBout(s, unit))));
  (copy.plans ?? []).forEach((p) => (p.items ?? []).forEach(
    (i) => { if (i.target) convertBout(i.target, unit); }));
  copy.userSettings = { ...copy.userSettings, unit };
  if (copy.userSettings.weightStep != null) {
    copy.userSettings.weightStep = Math.max(0.5, convertWeight(copy.userSettings.weightStep, unit));
  }
  return copy;
}

// The heart: merge every kind, write the winners back through the bulk
// writers (never the interactive ones — incoming state owns its stamps),
// and hand back the payload that should be on the server.
function reconcile(gid, remote) {
  return withGym(gid, () => {
    // 1. settings decide the unit, so they go first
    const before = getSettings();
    const settings = mergeSettings(before, remote?.userSettings ?? {});
    // stamp-driven, not value-driven: adopting a newer remote stamp even
    // when every field already matches is what stops two devices from
    // pushing the same settings back and forth forever
    if (stamp(remote?.userSettings ?? {}) > stamp(before)) {
      const unit = settings.merged.unit ?? before.unit;
      // converts EVERY gym's stored values plus the weight step (unit is
      // global, data is per gym) — the local side is the loser here
      if (unit !== before.unit) setUnit(unit);
      const next = { ...getSettings() };
      USER_SETTINGS.forEach((k) => {
        if (k in settings.merged) next[k] = settings.merged[k];
        else delete next[k];
      });
      // an absent aiPrompt is a reset and wins; an absent `unit` is a
      // malformed blob, and dropping it would leave every stored weight
      // labelled with the default unit
      if (!('unit' in next)) next.unit = unit;
      // verbatim: the remote stamp travels with the record it explains
      restoreSettings({ ...next, updatedAt: stamp(settings.merged) });
    }
    // 2. whatever unit the local side now speaks, the remote must match
    const rem = normalizeUnits(remote, getSettings().unit);

    // 3. merge per kind
    const localTomb = getTombstones();
    const remoteTomb = { ...EMPTY_TOMBSTONES, ...(rem?.tombstones ?? {}) };
    const workouts = mergeWorkouts(
      getWorkouts(), rem?.workouts ?? [], localTomb.workouts, remoteTomb.workouts);
    const plans = mergePlans(
      getPlans(), rem?.plans ?? [], localTomb.plans, remoteTomb.plans);
    const localLayout = getLayout();
    const layout = mergeLayout(
      localLayout ?? EMPTY_LAYOUT, rem?.gym ?? EMPTY_LAYOUT, localTomb, remoteTomb);
    const tombstones = {
      v: 1,
      workouts: workouts.tombstones,
      plans: plans.tombstones,
      machines: layout.tombstones.machines,
      shapes: layout.tombstones.shapes,
    };

    // 4. apply — bulk writers only
    if (workouts.changed) saveWorkouts(workouts.items);
    if (plans.changed) savePlans(plans.items);
    // a layout without a grid is not a layout (both sides empty): writing
    // one would break getLayout's outline healing
    const hasLayout = !!layout.merged.grid;
    if (layout.changed && hasLayout) restoreLayout(layout.merged);
    if (!same(tombstones, localTomb)) saveTombstones(tombstones);

    // 5. the gym's registry entry (name); id is local by definition, the
    // `demo` flag and activeId never travel
    const entry = getGyms().list.find((g) => g.id === gid) ?? { id: gid, name: '' };
    let mergedEntry = entry;
    if (rem?.gymEntry && stamp(rem.gymEntry) > stamp(entry)) {
      mergedEntry = { ...entry, name: rem.gymEntry.name, updatedAt: rem.gymEntry.updatedAt };
      restoreGymEntry(mergedEntry);
    }

    return {
      app: 'gymii',
      kind: 'sync-gym',
      v: 1,
      gym: hasLayout ? layout.merged : null, // wire field: the LAYOUT
      workouts: workouts.items,
      plans: plans.items,
      tombstones: {
        workouts: tombstones.workouts,
        plans: tombstones.plans,
        machines: tombstones.machines,
        shapes: tombstones.shapes,
      },
      gymEntry: { id: gid, name: mergedEntry.name ?? '', updatedAt: stamp(mergedEntry) },
      userSettings: userSettingsOf(getSettings()),
    };
  });
}

// --- the flow ---

async function runSync(gid, cfg, keyMaterial) {
  const { pass } = keyMaterial;
  let rev = cfg.rev ?? 0;
  let salt = keyMaterial.salt || null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // only the first round may be answered with 304: after a 409 our
    // revision is known-stale and the blob is exactly what we need
    // eslint-disable-next-line no-await-in-loop
    const got = await pull(cfg, gid, attempt === 0 ? rev : 0);
    let remote = null;
    if (got.kind === 'blob') {
      salt = got.envelope.salt; // the per-gym salt lives in the envelope
      rev = got.revision;
      try {
        // eslint-disable-next-line no-await-in-loop
        remote = await decryptEnvelope(got.envelope, pass);
      } catch {
        throw new SyncFail('decrypt');
      }
    } else if (got.kind === 'absent') {
      rev = 0;
    }
    // a device that paired but never pulled a blob has no salt yet
    if (!salt) salt = bytesToB64(randomBytes(SALT_BYTES));

    const payload = reconcile(gid, remote);
    // 304 says the blob is unchanged since our last pull, not that our
    // local side is unchanged — M1 has no dirty flag (M2's offline queue
    // brings one), so it re-pushes rather than sit on unsynced edits.
    if (remote && same(payload, remote)) return { rev, salt };

    // eslint-disable-next-line no-await-in-loop
    const envelope = await encryptPayload(payload, pass, salt, gid);
    // eslint-disable-next-line no-await-in-loop
    const put = await push(cfg, gid, rev, envelope);
    if (put.kind === 'ok') return { rev: put.revision, salt };
    // 409: someone else pushed. Re-GET, re-merge, re-PUT — that loop IS
    // the conflict protocol.
  }
  throw new SyncFail('error', 'conflict');
}

// --- public API (frozen: the Settings card is built against these) ---

// Everything the UI needs without touching the network.
export function getSyncState(gid) {
  const cfg = getSyncConfig(gid);
  if (!cfg) return { configured: false };
  return {
    configured: true,
    server: cfg.server,
    lastSyncAt: cfg.lastSyncAt ?? null,
    lastError: cfg.lastError ?? null,
  };
}

// { status: 'synced' | 'offline' | 'auth' | 'decrypt' | 'error', detail? }
// 'synced' covers the nothing-changed case. rev/lastSyncAt/lastError are
// written back so getSyncState can answer without a round trip.
export async function syncNow(gid) {
  const cfg = getSyncConfig(gid);
  if (!cfg) return { status: 'error', detail: 'not-configured' };
  const keyMaterial = getSyncKey(gid);
  const record = (patch) => {
    const current = getSyncConfig(gid);
    if (current) saveSyncConfig(gid, { ...current, ...patch });
  };
  if (!keyMaterial?.pass) {
    record({ lastError: 'no-key' });
    return { status: 'error', detail: 'no-key' };
  }
  if (!getGyms().list.some((g) => g.id === gid)) {
    record({ lastError: 'unknown-gym' });
    return { status: 'error', detail: 'unknown-gym' };
  }
  try {
    const { rev, salt } = await runSync(gid, cfg, keyMaterial);
    if (salt !== keyMaterial.salt) saveSyncKey(gid, { ...keyMaterial, salt });
    record({ rev, lastSyncAt: Date.now(), lastError: null });
    return { status: 'synced' };
  } catch (e) {
    const status = e instanceof SyncFail ? e.status : 'error';
    const detail = (e instanceof SyncFail ? e.detail : e?.message) || undefined;
    record({ lastError: detail || status });
    return detail ? { status, detail } : { status };
  }
}

// First device: mint the passphrase and the per-gym salt, then sync once so
// the blob exists. The code is shown ONCE — there is no recovery.
export async function enableSync(gid, { server, token } = {}) {
  const gym = getGyms().list.find((g) => g.id === gid);
  if (!gym) throw new Error('unknown-gym');
  if (gym.demo) throw new Error('demo-gym'); // sync-plan decision 10
  const url = String(server ?? '').trim();
  const bearer = String(token ?? '').trim();
  if (!url || !bearer) throw new Error('bad-server');
  saveSyncKey(gid, { v: 1, pass: generatePassphrase(), salt: bytesToB64(randomBytes(SALT_BYTES)) });
  saveSyncConfig(gid, {
    v: 1, server: url, token: bearer, rev: 0, lastSyncAt: null, lastError: null,
  });
  return { code: getSyncCode(gid), sync: await syncNow(gid) };
}

// Second device: the code carries server, token and passphrase; the salt
// arrives with the first blob. M1 pairs a gym that already carries the
// remote gym's id (a blob is keyed by (account, gymId)) — discovering
// another device's gyms via GET /v1/gyms is M3.
export async function pairWithCode(gid, code) {
  const gym = getGyms().list.find((g) => g.id === gid);
  if (!gym) throw new Error('unknown-gym');
  if (gym.demo) throw new Error('demo-gym');
  const { server, token, pass } = parseSyncCode(code);
  saveSyncKey(gid, { v: 1, pass, salt: null });
  saveSyncConfig(gid, {
    v: 1, server, token, rev: 0, lastSyncAt: null, lastError: null,
  });
  return { code: getSyncCode(gid), sync: await syncNow(gid) };
}

// Turning sync off drops the credentials, never the data.
export function disableSync(gid) {
  const key = getSyncKey(gid);
  if (key) keyCache.delete(`${key.salt}:${key.pass}`);
  saveSyncConfig(gid, null);
  saveSyncKey(gid, null);
}
