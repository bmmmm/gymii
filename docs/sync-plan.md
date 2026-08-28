# Cross-device sync — the plan

Why: gymii is local-first with hard privacy promises ("data never leaves
the browser"). Sync between one user's own devices (phone at the gym,
laptop at home) must keep that identity: **opt-in, end-to-end encrypted,
the server never sees plaintext**, and manual export/import stays as the
zero-network fallback forever. `docs/sync-protocol.md` is the wire
contract; this file is the roadmap and the decision log.

## Architecture in one paragraph

The client encrypts a whole per-gym state (~200–350 KB per training
year — blob size is a non-issue) with WebCrypto (AES-256-GCM, key derived
via PBKDF2 from a generated passphrase) and PUTs it to a tiny self-hosted
Go server that stores opaque blobs with a monotonic revision counter.
Conflict handling at the transport is just "409 → pull → merge → re-push";
all merge intelligence lives client-side in `js/merge.js`. Client clocks
never order anything at the protocol level. Pairing a second device is one
"sync code" (server URL + device token + passphrase), shown once.

## Milestones

- **M0 — groundwork (DONE, no network)**: `updatedAt` stamps on every
  interactive write (absence = epoch 0, legacy loses), tombstone sidecars
  so deletes can't be resurrected, diff-aware `saveLayout` vs verbatim
  `restoreLayout`, crypto-random 16-char `uid()` (no device marker — ids
  travel into AI exports), backup envelope v2 (tombstones ride along, v1
  imports unchanged), pure `js/merge.js` pinned by the 18-case matrix in
  `test/merge.test.mjs`, and the protocol spec.
- **M1 — manual sync, E2E from day one (DONE 2026-08-27 — proven
  end-to-end: the real `js/sync.js` against the real `gymii-sync` binary,
  a fresh second device with its own gym id converging both ways)**: the
  `gymii-sync` Go server (own
  repo, stdlib, opaque blobs, bearer token per device, configurable CORS
  origin), `js/sync.js` (fetch + revision/ETag + 409 loop + WebCrypto +
  sync-code pairing), a Settings "Sync" card with a "Sync now" button,
  unit normalization at the wire, and the honest rewrite of every privacy
  claim (README, SECURITY.md, in-app copy, meta description — "never
  unencrypted / not unless you turn it on", never an unconditional
  "never leaves" again).
- **M2 — ambient sync (DONE 2026-08-28 — proven against the live nutc
  server: ambient edit-push, idle pulls that never bump the revision,
  visible-pull convergence, live blob DELETE)**: pull on app open /
  visibilitychange / before a workout starts; push on `finishWorkout` and
  debounced after gym/plan edits; offline `syncPending` + retry on the
  next trigger or `online`; Web-Locks multi-tab guard; a `dirty` flag so a
  304 without local edits ends the run (without it every ambient pull
  re-pushed and bumped the revision); convergence tests; local gym
  deletion queues the blob's `DELETE`. Deletion does NOT propagate — a
  paired device that still wants the gym re-pushes and keeps it
  (account-level registry is M3).
- **M3 — pairing polish**: QR code, device list + token revocation,
  gym discovery on a fresh device (listing the account's other blobs via
  `GET /v1/gyms`; single-gym pairing already works — the sync code carries
  the blob's gymId), a failure badge on the Settings tab.
- **M4 — only on demand**: live handoff of a running workout. Needs a UI
  decision ("already running on your phone — resume here?"), not merge
  logic; deliberately deferred.

## Merge rules (implemented in js/merge.js)

Union by id + whole-record last-writer-wins via `updatedAt` + tombstones,
per kind: workouts and plans as documents-per-id (no content dedupe of
back-logged twins — identity is the id); the gym hybrid (machines/shapes
per item so two offline workouts both keep their new machines; name/grid/
meta/outline as one structural blob); gyms as a registry (`activeId`
is device-local, healed only if its gym died); settings split by field
(user-scoped: `unit`, `weightStep`, `restSeconds`, `aiPrompt` — the rest
never leaves the device). An edit stamped after a delete un-deletes;
before it, the delete holds.

## Deployment: local network first

The sync server runs on the home LAN by default; a public domain is an
option, never a requirement.

- **Reference deployment is a Docker container**: multi-stage build
  (`golang:alpine` → `FROM scratch`), `CGO_ENABLED=0`, image in the
  single-digit MB range. Storage is the **filesystem**, not SQLite — one
  directory per account, blob + revision written via atomic rename. That
  keeps the binary pure-stdlib, the image scratch-compatible, and state a
  single volume mount. The bare binary stays a first-class artifact for
  docker-less users (`go build`, run anywhere).
- **Browser reality check for LAN hosting** (why the design must care):
  `crypto.subtle` only exists in secure contexts (https or localhost), an
  https page cannot fetch an `http://` LAN address (mixed content), and
  public-site → private-network requests trigger Chrome's Private Network
  Access preflight. Consequences, in order of preference:
  1. **Same-origin mode (recommended local setup)**: the server takes a
     flag (`-app-dir`) and serves gymii's static files itself — one
     container, one origin, zero CORS, zero PNA, zero mixed content.
     `docker compose up` and the whole app lives at one LAN address.
  2. **Behind the existing reverse proxy** with a real certificate on an
     internal domain: then the Pages-hosted app can sync against the LAN
     too — the server must answer the PNA preflight
     (`Access-Control-Allow-Private-Network: true`) next to its CORS
     headers.
  3. Plain `http://<lan-ip>` same-origin (the no-TLS docker-net setup):
     `crypto.subtle` is missing there, so E2E cannot run — since decision
     15 gymii offers the EXPLICIT unencrypted mode for exactly this case
     (note: no secure context also means no service worker, so no offline
     app shell — the server has to be reachable). E2E still requires
     option 1 or 2.
- **Going public later is a config change, not a code change**: same
  container, a public router rule, `SYNC_ALLOWED_ORIGIN` updated.

## Open decisions (recommendation first)

1. Gym merge granularity: per-item (recommended, implemented) vs whole-gym
   LWW — revisit only if the extra machinery ever bites.
2. Same-id concurrent edits lose one side whole-record — accepted; field
   merging would require inventing per-set/per-item ids.
3. Active workout stays device-local until finished — M4 only on demand.
4. `aiPrompt` synced as user-scoped content — confirm it doesn't feel
   device-ish in practice.
5. Unit strategy: normalize-then-merge over the existing converters
   (implemented direction); a canonical storage unit (kg/m internally) is
   the cleaner but much larger refactor, parked.
6. Generic storage (WebDAV/S3) stays a documented compatibility path, not
   v1 UI.
7. No account recovery: the sync code is the only key — losing every
   device and the code loses the account. Say it plainly in the UI.
8. Tombstone pruning: time-based TTL (~180 days) — "every device has seen
   it" is unprovable without a device registry.
9. The Go server lives in its own repo (`gymii-sync`); this repo stays
   static files only.
10. Sync is opt-in per gym; new gyms default to off; the demo gym never
    syncs.
11. Packaging: Docker as the reference deployment (scratch image,
    filesystem storage, compose + reverse-proxy labels) — decided; the
    bare binary remains supported.
12. Same-origin mode (`-app-dir` serving gymii itself) — recommended as
    THE local-first setup; it dissolves CORS/PNA/mixed-content entirely.
13. Token provisioning, M1: the server CLI mints ONE account token and the
    sync code carries it to every device — decided. Per-device tokens (and
    revocation) arrive with M3's device registry; the protocol's
    "one token per device" is the M3 target, not an M1 requirement.
14. The sync code carries the blob's gymId, and a paired device maps its
    LOCAL gym onto that blob via `remoteId` in its sync config — decided
    after the first end-to-end run proved the alternative broken: gym ids
    never travel (backups restore content, not identity), so without the
    id in the code a paired device pushed a second blob and never
    converged, while the UI said "Synced."
15. Unencrypted sync exists as an EXPLICIT mode, offered only where E2E is
    impossible (2026-08-28 — "not everyone runs split DNS"): a page served
    without a secure context has no `crypto.subtle`, so the Settings card
    offers clearly-labeled unencrypted sync there and nowhere else. Nothing
    goes unencrypted silently (`no-crypto`), no downgrade sits next to
    working crypto (`crypto-available`), envelope and sync code both name
    the mode, and mode mismatches error instead of guessing. The privacy
    claims carry the carve-out honestly (README, SECURITY, meta).
