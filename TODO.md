# TODO

Shipped 2026-08-14, in five waves: plans that exist before the gym does
(typed note → unbound items → bind on the floor), the builder's text view,
proposed workout names, the history name filter, and a complete workout
editor incl. logging a workout after the fact. See AGENTS.md for how the
pieces fit; README for what they do.

Shipped 2026-08-16: "Load test data" (Settings) fills a deterministic Demo
gym — 16 machines, 8 weeks of history, three weekday plans covering
due/missed/done — so manual testing never starts from an empty gym; the
History tab gained a Muscles card (sets per group as tappable bar rows that
filter the whole view); and setUnit now converts plan targets too (they
were silently left in the old unit).

Shipped 2026-08-17: the AI export carries saved plans (same wire shape the
prompt teaches for answers, ~5% of a demo-sized export, measured), and a
pasted answer that keeps an exported plan id replaces that plan in place
behind a two-tap confirm — "tighten up my push plan" is a real roundtrip
now instead of a duplicate. Plus a review sweep: the demo gym is
identified by a `demo` flag instead of its user-editable name (a real gym
called "Demo" can no longer be overwritten), demo day maths is DST-safe,
and the unit converters live in store.js once.

Also 2026-08-17 — community templates: `test/templates.test.mjs` gates
manifest ↔ files ↔ real import validation on every PR; template files left
the sw.js precache (on-demand content, only the manifest stays — a template
PR is two files and never touches sw.js); intake via the "Submit a gym
template" issue form (paste the export, no git needed) plus PR template,
CONTRIBUTING.md and SECURITY.md (private vulnerability reporting enabled);
the Gym template browser links to the form ("Share your gym").

Also 2026-08-17 — orchestrated sweep (4 waves, 6 agents, all merged
green): the locker card steps aside once the first set is logged
(collapsed details row above Finish — focus stays on the next machine);
the rest beep reuses an AudioContext created inside the log-set gesture
(iOS suspends gesture-less contexts — the timer was silent there); the
Gym finds a machine by number (select + locate pulse); the AI export
dates workouts in local time (was UTC — off-by-one past midnight); and a
real setUnit bug is fixed: a RUNNING workout's plan-slot targets kept
their number across a unit switch (80 kg goal became an 80 lbs one
mid-workout). Plus consolidation: store helpers `bindOrCreateMachine` /
`newEntry` / `nameChipsFor`, shared ui.js date/chain helpers, the map
renderer extracted to `js/map.js` (sw.js cache v6), a "prefill matrix"
test block pinning the prefill contract, and the typed-0 weight-step
edge.

Browser-verified 2026-08-18 (Chrome, 400×800), and one more bug out of it:
the scroll fix measured A/B — the log button drifted 492→762 px over six
sets with the correction neutralised, and pins at 552 px with it; a screen
change resets the scroll (210→0) while logging does not; the locker card
collapses exactly once a set exists; Gym find-by-number selects and
pulses (15 of 16 machines dimmed); the rest screen darkens on schedule and
its jerk ticks at 999–1010 ms. The "+15 s, is that correct?" question then
exposed a real defect: a finished timer's pending close was never
cancelled, so extending inside that ~900 ms window was swallowed and the
new zero would never have sounded — ±15 s now revives the timer, and the
dim setting's labels name their reference point ("10 s into the break").
Timer sounds were confirmed on a real iPhone 2026-08-17, audible with the
ring/silent switch ON.

Shipped 2026-08-27 — sync M1, orchestrated (2 waves + a parallel server
agent, all merged green): `js/sync.js` (E2E crypto, 409 re-merge loop,
stamp-driven wire unit conversion, sync-code pairing), the Settings Sync
card (opt-in per gym, show-once code, two-tap off), the honest privacy
rewrite (README/SECURITY/meta: "never unencrypted / not unless you turn it
on"), and the `gymii-sync` Go server in its own Forgejo repo (fs store with
single-file atomic records, token-mint CLI, CORS/PNA, same-origin
`-app-dir` mode, scratch Docker image). docs/sync-protocol.md now carries
the decisions both implementations pinned. The first end-to-end run (real
client, real binary) then caught what both test suites could not: gym ids
never travel, so pairing wrote a second blob and never converged — the
sync code now carries the blob's gymId and a paired device maps its local
gym via `remoteId` (decision 14). E2E proven both ways with a fresh
second device.

## Open

- **A backup of a layout-less gym cannot be imported.** `exportBackup()`
  writes `gym: getLayout()`, which is `null` until the Gym editor ever
  ran — and `importData` then refuses the file as an invalid backup.
  Surfaced by the sync E2E run (pre-existing, not introduced by M1): a
  user who only logs workouts against a plan, never drawing a floor plan,
  exports a backup that won't restore. Either export a valid empty layout
  or accept `gym: null` on import.
- **Verify the issue forms in a signed-in browser.** The chooser
  (`/issues/new/choose`) should show four forms + two contact links with
  "Blank issue" as maintainers-only, and the template form must block
  submit while required fields are empty. No API can check this
  (GraphQL `issueTemplates` returns `[]` even for working YAML forms;
  the chooser is login-gated) — it needs real clicks, then close the
  test issue.
- **test/map.test.mjs split.** test/gym.test.mjs now covers both the
  renderer (map.js) and the editor; if the test layout should mirror the
  module split, its renderer/collision half moves out. Cosmetic — the
  file passes as one.
- **Unbound items and the muscle filter.** An exercise with no machine has
  no muscles either, so it is invisible to the builder's muscle chips and
  contributes nothing to name suggestions until it binds. Fine as-is; only
  worth revisiting if plans commonly stay unbound for long.
- **Template browser filters.** Country/city already render per entry; a
  filter row (chips, like History's) only earns its place once the library
  holds enough templates that scanning the list stops working.
