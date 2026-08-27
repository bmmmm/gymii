# gymii sync protocol (M1)

The contract between the gymii client (`js/sync.js`) and a sync server
(reference implementation: `gymii-sync`, a small self-hosted Go binary in
its own repo). The server is a **dumb store for opaque encrypted blobs** —
it never sees plaintext, never understands gymii's data model, and never
decides a conflict beyond "your revision is stale."

Status: implemented on both sides (M1). This document stays the source of
truth — change it first, then the implementations. The "pinned by the
reference server" block below records answers the first draft left open;
they were decided during implementation and are now part of the contract.

## Model

- One blob per `(account, gymId)` plus a server-assigned, monotonically
  increasing `revision` (int). The token identifies the account.
- Conflict ordering is ONLY the revision counter — client clocks never
  order anything at the protocol level. (`updatedAt` stamps are the
  merge layer's internal LWW tie-break, where a skewed clock can misorder
  one edit but never hijack the sync.)
- The active (in-progress) workout is device-local and never part of a
  blob; a workout enters sync when `finishWorkout` lands it in `workouts`.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/gyms` | list `{gymId, revision, updatedAt}` for the account (device discovery) |
| `GET` | `/v1/gyms/{id}` | returns the outer envelope; `ETag: "<revision>"`; 404 if never pushed; honors `If-None-Match` → 304 |
| `PUT` | `/v1/gyms/{id}` | requires `If-Match: "<revision>"` (`"0"` for first push); atomically bumps revision; **409** on stale revision |
| `DELETE` | `/v1/gyms/{id}` | mirrors a local gym deletion |

- Auth: `Authorization: Bearer <device-token>` — one token per device, all
  resolving to one account; revocable individually. Never in the URL.
  **M1 scope**: the server CLI mints one account token and the sync code
  shares it across devices; per-device tokens + revocation land with M3's
  device registry (sync-plan decision 13).
- CORS: allowed origin from server config (`SYNC_ALLOWED_ORIGIN`), plus
  `Access-Control-Expose-Headers: ETag`, `Allow-Headers: Authorization,
  If-Match, If-None-Match, Content-Type` (`If-None-Match` is required —
  without it the browser cannot do the 304 roundtrip cross-origin), and an
  OPTIONS preflight. Preflights are necessarily unauthenticated (browsers
  never send `Authorization` on them) — OPTIONS is exempt from auth.
  `Access-Control-Allow-Credentials` is deliberately NOT set (a Bearer
  header needs no credentials mode); responses carry `Vary: Origin`.
  A wildcard origin does
  not work with Authorization headers — the origin must be exact. For a
  LAN-hosted server reached from a publicly-hosted app, the preflight must
  also answer Chrome's Private Network Access:
  `Access-Control-Allow-Private-Network: true`.
- **Same-origin mode**: with `-app-dir <path>` the server additionally
  serves gymii's static files, so app and API share one origin — no CORS,
  no PNA, no mixed content. This is the recommended local-network setup
  (one container is the whole app). Note `crypto.subtle` needs a secure
  context: https via reverse proxy, or plain `http://localhost`; a bare
  `http://<lan-ip>` cannot do E2E.
- Server storage is the filesystem (one directory per account; blob and
  revision written via atomic rename) — no database, `CGO_ENABLED=0`,
  which keeps the reference Docker image `FROM scratch` and single-digit
  MB. Deployment reference: docs/sync-plan.md § Deployment.

### Pinned by the reference server

Answers the first draft left open, decided in gymii-sync and contractual
since:

- `PUT` success answers `200` with `{gymId, revision, updatedAt}` and the
  new `ETag`. `PUT` without `If-Match` answers `428 Precondition Required`;
  a malformed one `400`. A `409` carries the revision the server actually
  holds in its `ETag` (`"0"` when the gym does not exist).
- `DELETE` answers `204`, idempotent, and forgets the revision — a gym
  pushed again after a delete starts over at revision 1. Monotonicity holds
  per lifetime, not across a delete.
- `GET /v1/gyms` returns a bare JSON array sorted by id. Its `updatedAt`
  (and the one in `PUT` responses) is the SERVER's write time, RFC 3339
  UTC — not the client's per-record epoch-millis stamps, which the server
  cannot read.
- Bodies are capped at 4 MB (`413` above) and must be valid JSON; nothing
  beyond that is parsed. Gym ids and account names must match
  `^[A-Za-z0-9_-]{1,64}$` — they become path components; anything else
  (incl. `.`/`..` segments) answers `400`.

## Envelope

Outer (what the server stores, plaintext):

```json
{ "v": 1, "gymId": "…", "salt": "<base64>", "iv": "<base64, 12 bytes>", "ciphertext": "<base64>" }
```

Inner (exists only client-side, after decrypt) — the backup shape minus
settings, plus the sync-relevant sidecars:

```json
{ "app": "gymii", "kind": "sync-gym", "v": 1,
  "gym": …, "workouts": […], "plans": […],
  "tombstones": { "workouts": […], "plans": […], "machines": […], "shapes": […] },
  "gymEntry": { "id": "…", "name": "…", "updatedAt": … },
  "userSettings": { "unit": "kg", "weightStep": 2.5, "restSeconds": 90, "aiPrompt": "…", "updatedAt": … } }
```

- `gym` is the LAYOUT (the frozen backup wire field — see AGENTS.md's
  naming note); `gymEntry` is the registry entry riding next to it. The
  first draft used the key `gym` for both, which JSON cannot hold.
- `userSettings` carries ONLY the user-scoped fields (`USER_SETTINGS` in
  `js/merge.js`); device-scoped settings never leave the device.
- **Unit normalization**: weights/distances are stored in the display unit,
  so before merging, a client whose `unit` differs from the blob's converts
  the losing side via the existing `convertWeight`/`convertDistance`
  (store.js) into the winning unit. This is the transport's job, not the
  merge layer's.

## Crypto

- AES-256-GCM via WebCrypto; key = PBKDF2-SHA256, ≥600,000 iterations, from
  a **generated** passphrase (~128 bits, rendered readable) + the
  per-gym `salt` from the outer envelope. Fresh random 12-byte IV per
  encryption; GCM's auth tag rides inside `ciphertext` (WebCrypto default).
- Key material lives in `gymii.<gid>.synckey` — **excluded from
  `exportBackup()` by design** (backups travel casually; keys must not).
- Pairing: one "sync code" string = server URL + device token + passphrase
  + the blob's gymId, shown once (copy/QR). The gymId is load-bearing: a
  blob is keyed by (account, gymId), and without it a paired device would
  sync its own gym into a second blob and silently never converge. The
  paired device keeps its LOCAL gym id and maps onto the blob via
  `remoteId` in its sync config — ids never travel between devices, only
  the blob address does. No recovery: losing every device and the code
  means the account is gone — stated plainly in the pairing UI.

## Sync flow (client)

1. `GET` blob (or 304) → decrypt → `remote`.
2. If remote revision == last pushed revision: encrypt local, `PUT If-Match`.
   (On a 304 the M1 client re-pushes local state — it has no dirty flag yet,
   M2's offline queue brings one; a merge whose result equals the remote
   blob pushes nothing, so idle syncs never bump the revision.)
3. Else: `merge*` (js/merge.js) per kind → apply locally via the bulk
   writers (`restoreLayout`, `saveWorkouts`, `savePlans`, `saveTombstones`) →
   encrypt merged → `PUT If-Match: <remote revision>`.
4. On 409: re-GET, re-merge, re-PUT (the loop IS the conflict protocol).
5. Triggers: pull on app open / visibilitychange / before workout start;
   push on finishWorkout and debounced after gym/plan edits. Offline: a
   `syncPending` flag retries on the next trigger or `online` event.

## Open questions

Tracked in the sync plan (tombstone pruning TTL, per-gym opt-in,
generic WebDAV/S3 target in the UI, active-workout handoff). None block
M1 against this document.
