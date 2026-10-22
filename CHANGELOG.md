# Changelog

What shipped, newest first — one section per deploy day; each entry names
the `APP_VERSION` it went out as where it had one (Settings shows the
installed build). Moved verbatim out of TODO.md on 2026-10-23, which now
holds open work only.

## 2026-10-23

Shipped 2026-10-23 (`2026-10-23b`): the repo restructured, no behaviour
change. Everything that ships moved to `app/`, the only directory the
deploy uploads — until now Pages served AGENTS.md, TODO.md, every test and
`serve.py` next to the app; URLs, the service worker and stored data stay
as they were, since `app/` is the site root. Tooling: pnpm 12.14, Playwright
1.64.1, `pnpm test` on Node's built-in runner, `.node-version` (24),
Biome as a lint-only fifth deploy gate (`biome.jsonc` says why each rule it
turns off is off), `.editorconfig`. Docs: this CHANGELOG.md out of TODO.md,
docs/architecture.md in one section per module, docs/decisions/ and
docs/media/.

Shipped 2026-10-23 (`2026-10-23`): the first start, reworked — a guided
tour (`js/tour.js`, route `#tour`, six steps with the tab each one talks
about pulsing in the real tabbar) opens once on a device's first start
and asks kg or lbs there (an untouched step follows: 5 lbs, not 5.5);
Settings → Help and the first-run screen repeat it. The first-run screen
leads with one sentence and trades its prose links for an "Other ways
in" card (demo gym, tour, Gym, backup/sync); an empty gym floor says
what to do on the floor itself. New: `test/tour.test.mjs`,
`smoke/tour.spec.mjs`.

## 2026-10-22

Shipped 2026-10-22 (`2026-10-22c`): the open items — "Busy?" and "Closer:"
skip a free slot with no set (one `idleFree` predicate with nextOpenSlot);
"Muscles today" lists trained muscles first and folds the open ones behind
"Show N untrained" (device-local `settings.muscleFold`, the "tap an open
muscle" hint only while an open row shows); a new cardio builder line takes
the last set's `level`; another tab's edit during a push keeps the sync
dirty flag (window `storage` event, no extra write); gym.js's undo engine
moved to the pure `js/layoutdiff.js` with its own tests, plus the
closure-free helpers out of `renderGym`. New smoke spec
`smoke/review.spec.mjs` (8 browser pins, each failing on `8bc05d9`).

Shipped 2026-10-22 (`2026-10-22b`): store.js split — the placement
geometry (`js/geometry.js`) and the weekday date maths (`js/weekday.js`),
both pure and import-free, and the plan-text parser/printer
(`js/plantext.js`) left the data layer (1995 → 1513 lines); the writers
(`addMachine`, `skipPlanDay`) stay in store.js. No behaviour change.

Shipped 2026-10-22 (`2026-10-22`): a code review across all modules, fixed
in three parallel worktrees (data, editor, train/history). Sync: an edit
landing during a push is no longer marked clean (per-gym edit generation),
syncNow never throws on a full quota; imports: a backup keeps the device's
unit and converts into it (`convertRecords`, shared with `setUnit`),
untrusted workouts lose non-finite stamps and non-string names, backup
tombstones MERGE with local ones, a template import is an edit (tombstones,
stamps, pushed); editor: a label tap no longer presses the stepper's "−",
the template browser wires once (two taps again), the floor can't shrink
under its items, "Use the default (N)" clears a machine's set goal, the plan
builder keeps typed text across chip taps and its draft across tab
switches, unknown/malformed hashes route safely; train/history: one routine
row per machine set, NaN-safe machine centres, one history read per log
render, a content memo for `insights()`, the Muscles card and its filter
count resistance machines only, like the hints.

## 2026-10-21

Shipped 2026-10-21 (`2026-10-21`), orchestrated (a foundation commit, then
four agents in parallel worktrees — icons, set goals + Next, muscle bars,
cardio levels — merged B, D, C, A with the test-file tails resolved by
hand; brief in docs/decisions/plan-2026-10-21.md): every machine carries a glyph for
its first muscle's region or its cardio type (ui.js `machineIcon`, in every
list, on the log head and in its box on the floor map); every slot counts
against a SET GOAL — `settings.defaultSets` (3, synced) → the machine's
"Sets per visit" (Gym card) → per exercise, resolved by store's
`setGoalFor`, so "✓ Log set 2/3", the Next takeover and the overview's
"1/3 sets" / "2 of 5 done" work in free workouts too, with a "Sets planned"
stepper and a "Keep N sets for #7 · Curl" link on the log screen; a machine
merely opened is a `free` slot that "Next" skips while it has no set, and
with nothing left in the plan the log screen suggests what to try next
(`suggestNext`: the usual successor from history, else the most open
muscles, nearer on a tie — "Try next: #4 Leg curl →"); "Muscles today" is
bar rows (sets per muscle, a secondary ½, "4 of 9 muscles trained", the
same count on the overview button); a cardio set takes a `level` (log
stepper, History editor, `Rower 20min L5` in a plan line, the fourth tuple
element of a cardio set in the AI export). Also: the picker's 🎲 chip is a
44px box on a narrow emoji font (Linux Chromium measured it 38px).

## 2026-10-01

Shipped 2026-10-01 (`2026-10-01b` + `2026-10-01c`): the History redesign —
an overview (This week tiles + twelve weekly bars, a draggable Progress
chart with machine and range chips, the Walking paths card on the floor
map, Muscles) and a Workouts
drill-down screen; `js/stats.js` holds the hint rules (docs/insights.md) —
since `2026-10-01e` each hint is an instruction with a ↗ to its study,
shown where you act (log screen, rest overlay, under the chart, under a
muscle row, plan builder), no card; a
workout now records machine visits (`visits`, with `busy` marks from the
"Busy?" button) and per-set reps-in-reserve chips (`rir`) after a set; the
date editor shifts set and visit timestamps; the demo gym carries stamps,
visits and ratings for its last four weeks.

## 2026-09-02

Shipped 2026-09-02, in four waves: a mobile sweep (no field under 16px, so
iOS stops zooming on focus; 44px targets everywhere with two commented
exceptions; safe-area padding, scrollable overlays, one tap-highlight rule
instead of eleven, a plan builder that fits 320px), the rest/log flow (the
rest deadline belongs to the WORKOUT — dismiss the screen and it keeps
running inline; 🏁 finishes from the log screen; a rest changed mid-workout
no longer rewrites the machine; a plan with an unbound first stop opens on
that question; the set ✕ arms first), a service worker that stops waiting
for a stalled gym wifi after 2.5 s (and its first test at all, running the
real sw.js in node:vm), and dev-side work: History leads with the workouts,
one localStorage stub for every test, CI parses every shipped script
(`node --check` alone does NOT — it silently passes broken ESM) and blocks
a deploy that ships changes without bumping `js/version.js`.

Shipped 2026-09-02, wave C — the first dependency, and the line it may not
cross: `@playwright/test` drives six browser smoke scenarios in `smoke/`
against Chromium in CI, while the app that ships stays dependency-free (two
tripwires enforce it — no shipped file may name `node_modules`, and the
deploy job refuses to run with an install present). The first run found
what a hand sweep had missed: `.btn` was 43px everywhere, and `.doc-link`
51x34.

Also 2026-09-02, waves T/B/D — test/gym.test.mjs was a map.js test under
the wrong name; split out, and the gaps it hid (snapDoorToWall had zero
coverage) closed. js/ui.js got its first test file, ids in map.js are
escaped into attributes, fmtDuration names the hour past 3600 s, and
CONTRIBUTING/SECURITY/the issue forms stopped calling sync a non-goal.

Shipped 2026-09-02, wave A — storage that survives: finishWorkout() wrote
history BEFORE clearing the active workout (the other order loses a
finished workout when a write is refused), write() gained an error channel
that announces and rethrows instead of letting callers believe they saved,
a banner says so, and Settings gained a Storage card with the honest
occupancy count plus the ask for persistent storage — which gymii raises
in finish(), the first user gesture after something irreplaceable exists.

## 2026-08-31

Shipped 2026-08-31 — sync M3, pairing polish: per-device tokens (pairing
mints a fresh named token over the new `/v1/tokens` API; a device's own
token never leaves it; revocation per device with a last-token lockout
guard), the Devices list, QR pairing (hand-written zero-dep encoder in
`js/qr.js`, mutation-tested 28/28 and bit-for-bit against two independent
oracles; the QR wraps `<app-url>#pair=<code>` — the camera opens gymii
with the field prefilled, the fragment is scrubbed from history, pairing
still needs the tap), gym discovery with full adoption (plain one-tap,
encrypted by that gym's own passphrase, wrong keys leave no trace), and
the Settings-tab sync badge. Proven live against nutc end-to-end;
QR/#pair/badge verified in a real browser. All three sync milestones
(M1-M3) are now done — M4 (live workout handoff) stays deliberately
on-demand only.

## 2026-08-28

Shipped 2026-08-28 — sync M2, ambient: edits debounce into a push, coming
into view throttles into a pull, finishing a workout pushes immediately;
offline edits set `syncPending` and replay on `online`; Web-Locks multi-tab
guard; a load-bearing `dirty` flag (raised by any interactive write via the
new store notifier, lowered by a completed sync) so idle pulls never
re-push — the first test run proved they otherwise bump the revision
forever; deleting a gym queues the server blob's DELETE (drained by the
ambient layer; deletion deliberately does not propagate to other devices).
Proven against the live nutc server both ways, including the live DELETE →
404. Also fixed: a backup of a layout-less gym (`gym: null`) now imports.

## 2026-08-27

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

## 2026-08-18

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

## 2026-08-17

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

## 2026-08-16

Shipped 2026-08-16: "Load test data" (Settings) fills a deterministic Demo
gym — 16 machines, 8 weeks of history, three weekday plans covering
due/missed/done — so manual testing never starts from an empty gym; the
History tab gained a Muscles card (sets per group as tappable bar rows that
filter the whole view); and setUnit now converts plan targets too (they
were silently left in the old unit).

## 2026-08-14

Shipped 2026-08-14, in five waves: plans that exist before the gym does
(typed note → unbound items → bind on the floor), the builder's text view,
proposed workout names, the history name filter, and a complete workout
editor incl. logging a workout after the fact. See docs/architecture.md for how the
pieces fit; README for what they do.
