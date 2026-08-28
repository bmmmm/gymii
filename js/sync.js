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
  onStoreChange, getPendingDeletes, savePendingDeletes,
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

// crypto.subtle only exists in secure contexts (https or localhost). On a
// plain-http page — the one-container docker-net setup with no TLS and no
// internal DNS — the browser refuses E2E entirely; the explicit unencrypted
// mode below is what keeps sync possible there (sync-plan decision 15).
// Checked at call time so tests can simulate an insecure context. Exported
// so the Settings card can offer the unencrypted mode exactly where E2E is
// impossible — and never anywhere else.
export const e2eAvailable = () => !!globalThis.crypto?.subtle;

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

// --- sync code: server + token + passphrase + blob id, shown once ---
// M1 shares ONE account token across devices (sync-plan decision 13);
// per-device tokens land with M3's device registry. The per-gym salt is
// deliberately NOT in the code: it lives in the outer envelope, so a paired
// device adopts it from the first blob it pulls. The code DOES carry the
// blob's gymId — a blob is keyed by (account, gymId), and without the id a
// paired device would sync its own gym into a second blob and silently
// never converge. The paired device keeps its LOCAL gym id and maps to the
// blob via `remoteId` in the sync config.

export function getSyncCode(gid) {
  const cfg = getSyncConfig(gid);
  if (!cfg) return null;
  if (cfg.plain) {
    const body = JSON.stringify({
      server: cfg.server, token: cfg.token, gymId: cfg.remoteId ?? gid, plain: true,
    });
    return CODE_PREFIX + b64url(bytesToB64(enc.encode(body)));
  }
  const key = getSyncKey(gid);
  if (!key?.pass) return null;
  const body = JSON.stringify({
    server: cfg.server, token: cfg.token, pass: key.pass, gymId: cfg.remoteId ?? gid,
  });
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
  const {
    server, token, pass, gymId, plain,
  } = data ?? {};
  // The mode rides in the code: a plain code carries no passphrase — there
  // is deliberately no key material that could later pretend to be E2E.
  if (!server || !token || !gymId || (!pass && plain !== true)) throw new Error('bad-code');
  return {
    server: String(server),
    token: String(token),
    pass: pass ? String(pass) : null,
    gymId: String(gymId),
    plain: plain === true,
  };
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
  const encrypted = envelope?.ciphertext && envelope?.iv && envelope?.salt;
  const plain = envelope?.plain && typeof envelope.plain === 'object';
  if (!envelope || envelope.v !== 1 || (!encrypted && !plain)) {
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
function reconcile(gid, remote, rid) {
  // reconcile writes through the same bulk writers user actions end in, so
  // the store notifier would echo every sync back into the ambient layer.
  // The flag brackets exactly this SYNCHRONOUS block — a real user edit can
  // only land between awaits, where the flag is down again.
  applying = true;
  try {
    return reconcileInner(gid, remote, rid);
  } finally {
    applying = false;
  }
}

function reconcileInner(gid, remote, rid) {
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
      // the blob speaks in its OWN id (the key it lives under) — a paired
      // device's local gym id stays local
      gymEntry: { id: rid, name: mergedEntry.name ?? '', updatedAt: stamp(mergedEntry) },
      userSettings: userSettingsOf(getSettings()),
    };
  });
}

// --- the flow ---

async function runSync(gid, cfg, keyMaterial) {
  const plainMode = cfg.plain === true;
  const pass = keyMaterial?.pass;
  // the blob's address on the server — the paired device's local id and the
  // blob id differ, and the wire only ever sees the latter
  const rid = cfg.remoteId ?? gid;
  let rev = cfg.rev ?? 0;
  let salt = keyMaterial?.salt || null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // only the first round may be answered with 304: after a 409 our
    // revision is known-stale and the blob is exactly what we need
    // eslint-disable-next-line no-await-in-loop
    const got = await pull(cfg, rid, attempt === 0 ? rev : 0);
    // 304 with no local edits since the last push (the ambient layer's
    // dirty flag, M2): both sides are where they were — done. Without the
    // flag every visibility pull would re-push and bump the revision,
    // making the other devices re-download an unchanged blob forever.
    if (got.kind === 'unchanged' && cfg.dirty !== true) return { rev, salt };
    let remote = null;
    if (got.kind === 'blob') {
      rev = got.revision;
      // the mode is per blob and travels in the sync code — a client whose
      // config disagrees with the envelope must say so, not guess
      if (plainMode !== !!got.envelope.plain) {
        throw new SyncFail('error', 'mode-mismatch');
      }
      if (plainMode) {
        remote = got.envelope.plain;
      } else {
        salt = got.envelope.salt; // the per-gym salt lives in the envelope
        try {
          // eslint-disable-next-line no-await-in-loop
          remote = await decryptEnvelope(got.envelope, pass);
        } catch {
          throw new SyncFail('decrypt');
        }
      }
    } else if (got.kind === 'absent') {
      rev = 0;
    }
    // a device that paired but never pulled a blob has no salt yet
    if (!plainMode && !salt) salt = bytesToB64(randomBytes(SALT_BYTES));

    const payload = reconcile(gid, remote, rid);
    // a 304 with the dirty flag up still lands here: the blob is
    // unchanged but the local side is not, so the edit gets pushed
    if (remote && same(payload, remote)) return { rev, salt };

    // eslint-disable-next-line no-await-in-loop
    const envelope = plainMode
      ? { v: 1, gymId: rid, plain: payload }
      : await encryptPayload(payload, pass, salt, rid);
    // eslint-disable-next-line no-await-in-loop
    const put = await push(cfg, rid, rev, envelope);
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
    plain: cfg.plain === true, // unencrypted mode — the card must say so
    pending: cfg.syncPending === true, // offline edits waiting for a retry
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
  if (!cfg.plain && !keyMaterial?.pass) {
    record({ lastError: 'no-key' });
    return { status: 'error', detail: 'no-key' };
  }
  if (!getGyms().list.some((g) => g.id === gid)) {
    record({ lastError: 'unknown-gym' });
    return { status: 'error', detail: 'unknown-gym' };
  }
  try {
    const { rev, salt } = await runSync(gid, cfg, keyMaterial);
    if (keyMaterial && salt !== keyMaterial.salt) saveSyncKey(gid, { ...keyMaterial, salt });
    // a completed run means local state is on the server (or unchanged) —
    // the dirty flag the ambient triggers raise comes down here
    record({
      rev, lastSyncAt: Date.now(), lastError: null, dirty: false,
    });
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
// `plain: true` is the explicit unencrypted mode for a page the browser
// serves without a secure context (plain-http docker-net, no TLS): E2E is
// impossible there, so the server stores readable blobs — the user's own
// server, the user's explicit call. Where crypto works, plain is refused:
// a downgrade must never sit next to working encryption.
export async function enableSync(gid, { server, token, plain } = {}) {
  const gym = getGyms().list.find((g) => g.id === gid);
  if (!gym) throw new Error('unknown-gym');
  if (gym.demo) throw new Error('demo-gym'); // sync-plan decision 10
  // A bare domain means https — the reference deployment fronts the server
  // with a real certificate, and the https-served app cannot reach plain
  // http anyway (mixed content). An explicit scheme is respected: that is
  // what keeps http://localhost and the same-origin docker-net setup working.
  const raw = String(server ?? '').trim().replace(/\/+$/, '');
  const url = !raw ? '' : (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  const bearer = String(token ?? '').trim();
  if (!url || !bearer) throw new Error('bad-server');
  if (plain === true && e2eAvailable()) throw new Error('crypto-available');
  if (plain !== true && !e2eAvailable()) throw new Error('no-crypto');
  if (plain === true) {
    saveSyncKey(gid, null);
    saveSyncConfig(gid, {
      v: 1,
      server: url,
      token: bearer,
      remoteId: gid,
      plain: true,
      rev: 0,
      lastSyncAt: null,
      lastError: null,
    });
  } else {
    saveSyncKey(gid, { v: 1, pass: generatePassphrase(), salt: bytesToB64(randomBytes(SALT_BYTES)) });
    saveSyncConfig(gid, {
      v: 1, server: url, token: bearer, remoteId: gid, rev: 0, lastSyncAt: null, lastError: null,
    });
  }
  return { code: getSyncCode(gid), sync: await syncNow(gid) };
}

// Second device: the code carries server, token, passphrase and the blob's
// gymId; the salt arrives with the first blob. The local gym keeps its own
// id — `remoteId` maps it onto the blob, so pairing binds whichever gym the
// user picked to the shared one. Discovering a fresh device's other gyms
// via GET /v1/gyms is M3.
export async function pairWithCode(gid, code) {
  const gym = getGyms().list.find((g) => g.id === gid);
  if (!gym) throw new Error('unknown-gym');
  if (gym.demo) throw new Error('demo-gym');
  const {
    server, token, pass, gymId, plain,
  } = parseSyncCode(code);
  // The mode was decided when the blob was first enabled and travels in the
  // code: a plain code pairs plain even on a secure page (the blob IS
  // readable — pretending otherwise here would be theater), and an E2E code
  // cannot pair where the browser refuses crypto.
  if (!plain && !e2eAvailable()) throw new Error('no-crypto');
  if (plain) {
    saveSyncKey(gid, null);
    saveSyncConfig(gid, {
      v: 1,
      server,
      token,
      remoteId: gymId,
      plain: true,
      rev: 0,
      lastSyncAt: null,
      lastError: null,
    });
  } else {
    saveSyncKey(gid, { v: 1, pass, salt: null });
    saveSyncConfig(gid, {
      v: 1, server, token, remoteId: gymId, rev: 0, lastSyncAt: null, lastError: null,
    });
  }
  return { code: getSyncCode(gid), sync: await syncNow(gid) };
}

// Turning sync off drops the credentials, never the data.
export function disableSync(gid) {
  const key = getSyncKey(gid);
  if (key) keyCache.delete(`${key.salt}:${key.pass}`);
  saveSyncConfig(gid, null);
  saveSyncKey(gid, null);
}

// --- ambient sync (M2) ---
// Sync without a button: edits debounce into a push, coming into view
// throttles into a pull, finishing a workout pushes immediately, offline
// outcomes set `syncPending` and replay on the next trigger or `online`
// event. Everything funnels through ambientSync(): one sync in flight per
// gym EVER — a trigger landing mid-run sets `again` instead of racing, and
// the run repeats once after finishing. Across tabs the Web Locks API
// picks one winner (both tabs share localStorage, so the loser loses
// nothing); without the API (Node, old browsers) the guard is a no-op.

const AMBIENT = {
  // 8 s of quiet after the last edit — long enough to swallow a burst of
  // logging, short enough that the phone is still unlocked when it fires
  editDebounceMs: 8000,
  // pulls (visible / workout start) at most once a minute
  pullThrottleMs: 60000,
};

let applying = false;
let ambientWired = false;
let debounceTimer = null;
let lastPullAt = 0;
const inFlight = new Map(); // gid -> { again }

// The dirty flag is raised by ANY interactive write, subscribed at module
// load — a manual "Sync now" must see local edits even in a session where
// the ambient wiring never ran. reconcile's echoes through the bulk
// writers are filtered by the same `applying` flag that guards the
// ambient debounce.
onStoreChange(() => {
  if (applying) return;
  const { activeId } = getGyms();
  const cfg = getSyncConfig(activeId);
  if (cfg && cfg.dirty !== true) saveSyncConfig(activeId, { ...cfg, dirty: true });
});

async function withTabLock(fn) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return fn();
  return locks.request('gymii-sync', { ifAvailable: true }, async (lock) => {
    if (!lock) return null; // another tab holds it and syncs the same storage
    return fn();
  });
}

async function ambientSync(gid) {
  if (!gid || !getSyncConfig(gid)) return;
  const running = inFlight.get(gid);
  if (running) { running.again = true; return; }
  const state = { again: false };
  inFlight.set(gid, state);
  try {
    await withTabLock(async () => {
      const r = await syncNow(gid);
      const cfg = getSyncConfig(gid);
      if (cfg) {
        if (r.status === 'offline' && cfg.syncPending !== true) {
          saveSyncConfig(gid, { ...cfg, syncPending: true });
        } else if (r.status === 'synced' && cfg.syncPending) {
          saveSyncConfig(gid, { ...cfg, syncPending: false });
        }
      }
      if (r.status === 'synced') await flushPendingDeletes();
    });
  } finally {
    inFlight.delete(gid);
  }
  if (state.again) await ambientSync(gid);
}

// deleteGym queued these while the config was still readable; 2xx and 404
// both mean "gone". HTTP failures retry a few times (a revoked token never
// succeeds — the cap is what stops it); a dead network keeps the entry
// without counting, the queue itself is capped in the store.
async function flushPendingDeletes() {
  const queue = getPendingDeletes();
  if (!queue.length) return;
  const keep = [];
  for (const entry of queue) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(
        `${String(entry.server).replace(/\/+$/, '')}/v1/gyms/${encodeURIComponent(entry.remoteId)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${entry.token}` } },
      );
      if (!res.ok && res.status !== 404 && (entry.tries ?? 0) + 1 < 5) {
        keep.push({ ...entry, tries: (entry.tries ?? 0) + 1 });
      }
    } catch {
      keep.push(entry);
    }
  }
  savePendingDeletes(keep);
}

// The triggers are exported so train.js and the tests call policies, not
// fake DOM events. A debounce of 0 runs synchronously into the returned
// promise — that is what makes the ambient tests awaitable.
export function ambientEdited() {
  if (applying) return null; // reconcile echoing through the bulk writers
  const { activeId } = getGyms();
  if (!getSyncConfig(activeId)) return null;
  if (AMBIENT.editDebounceMs <= 0) return ambientSync(activeId);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => ambientSync(activeId), AMBIENT.editDebounceMs);
  return null;
}

export function ambientVisible() {
  const now = Date.now();
  if (AMBIENT.pullThrottleMs > 0 && now - lastPullAt < AMBIENT.pullThrottleMs) return null;
  lastPullAt = now;
  return ambientSync(getGyms().activeId);
}

// Same policy as becoming visible: freshen before the workout, never block it.
export const ambientWorkoutStart = () => ambientVisible();

export function ambientFinished() {
  clearTimeout(debounceTimer); // the finish push covers any pending edits
  return ambientSync(getGyms().activeId);
}

export async function ambientOnline() {
  // the queue must drain even when no gym has a config anymore (the last
  // synced gym may be exactly what was deleted)
  await ambientSync(getGyms().activeId);
  await flushPendingDeletes();
}

// Waits until no ambient run is in flight — the tests' (and a future UI's)
// way to observe "the dust settled" without reaching into module state.
export async function ambientSettled() {
  // eslint-disable-next-line no-await-in-loop
  while (inFlight.size) await new Promise((resolve) => { setTimeout(resolve, 0); });
}

export function initAmbientSync({ editDebounceMs, pullThrottleMs } = {}) {
  if (editDebounceMs != null) AMBIENT.editDebounceMs = editDebounceMs;
  if (pullThrottleMs != null) AMBIENT.pullThrottleMs = pullThrottleMs;
  if (ambientWired) return undefined; // re-calls may retune, never re-wire
  ambientWired = true;
  onStoreChange(() => ambientEdited());
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') ambientVisible();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => ambientOnline());
  }
  return ambientOnline(); // initial kick: sync the active gym, drain the queue
}
