# Cross-device sync — the plan

Why: gymii is local-first with hard privacy promises ("data never leaves
the browser"). Sync between one user's own devices (phone at the gym,
laptop at home) must keep that identity: **opt-in, end-to-end encrypted,
the server never sees plaintext**, and manual export/import stays as the
zero-network fallback forever. `docs/sync-protocol.md` is the wire
contract; this file is the roadmap and the decision log.

## Architecture in one paragraph

The client encrypts a whole per-profile state (~200–350 KB per training
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
  so deletes can't be resurrected, diff-aware `saveGym` vs verbatim
  `restoreGym`, crypto-random 16-char `uid()` (no device marker — ids
  travel into AI exports), backup envelope v2 (tombstones ride along, v1
  imports unchanged), pure `js/merge.js` pinned by the 18-case matrix in
  `test/merge.test.mjs`, and the protocol spec.
- **M1 — manual sync, E2E from day one**: the `gymii-sync` Go server (own
  repo, stdlib, opaque blobs, bearer token per device, configurable CORS
  origin), `js/sync.js` (fetch + revision/ETag + 409 loop + WebCrypto +
  sync-code pairing), a Settings "Sync" card with a "Sync now" button,
  unit normalization at the wire, and the honest rewrite of every privacy
  claim (README, SECURITY.md, in-app copy, meta description — "never
  unencrypted / not unless you turn it on", never an unconditional
  "never leaves" again).
- **M2 — ambient sync**: pull on app open / visibilitychange / before a
  workout starts; push on `finishWorkout` and debounced after gym/plan
  edits; offline queue + retry; multi-tab guard; convergence tests.
- **M3 — pairing polish**: QR code, device list + token revocation,
  profile discovery on a fresh device, a failure badge on the Settings tab.
- **M4 — only on demand**: live handoff of a running workout. Needs a UI
  decision ("already running on your phone — resume here?"), not merge
  logic; deliberately deferred.

## Merge rules (implemented in js/merge.js)

Union by id + whole-record last-writer-wins via `updatedAt` + tombstones,
per kind: workouts and plans as documents-per-id (no content dedupe of
back-logged twins — identity is the id); the gym hybrid (machines/shapes
per item so two offline sessions both keep their new stations; name/grid/
meta/outline as one structural blob); profiles as a registry (`activeId`
is device-local, healed only if its profile died); settings split by field
(user-scoped: `unit`, `weightStep`, `restSeconds`, `aiPrompt` — the rest
never leaves the device). An edit stamped after a delete un-deletes;
before it, the delete holds.

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
10. Sync is opt-in per profile; new profiles default to off; the demo
    profile never syncs.
