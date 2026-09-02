# TODO

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

## Open

### On a real iPhone

Six checks no emulator settles. All against
<https://bmmmm.github.io/gymii/>, never `serve.py`: a service worker and
"Add to Home Screen" need https, and points 2–4 put exactly those on the
stand. An expectation that fails becomes an issue labelled `bug`.

- [ ] **Stepper on a focused, emptied field.** `initNumericOverwrite`
  clears a focused number field into its placeholder, and its comment
  claims `blur` fires before the stepper's click, "so +/− still see a
  value". *Do:* tap the weight field (placeholder reads "(40)"), then tap
  **+**. *Expect:* 45, not 5.
- [ ] **Beep in the background.** Start a 30 s rest, go straight to the
  Home Screen, wait. *Expect:* open — record whether the tone arrives at
  zero, arrives late, or never. The answer decides whether a notification
  is needed.
- [ ] **Keyboard over the log button.** Tap into the weight field.
  *Expect:* "✓ Log set …" stays visible, or is reachable without leaving
  the field.
- [ ] **Safe area in standalone.** Add to Home Screen, open from there.
  *Expect:* content starts below the status bar / Dynamic Island — the
  `env(safe-area-inset-top)` fix, which in a browser can only be checked
  at inset 0, where it measured the expected 12 px.
- [ ] **Scan a pairing QR with a real phone camera once** — the only step
  no automation can take; everything up to the prefilled field is
  verified. Device A shows the QR, device B's camera app scans it.
  *Expect:* gymii opens with the pairing field prefilled. Needs the
  `gymii-sync` server running.
- [ ] **The issue forms, signed in.** The chooser
  (`/issues/new/choose`) should show four forms + two contact links with
  "Blank issue" as maintainers-only, and the template form must block
  submit while required fields are empty. No API can check this
  (GraphQL `issueTemplates` returns `[]` even for working YAML forms;
  the chooser is login-gated) — it needs real clicks, then close the
  test issue.

### Still open

- **Unbound items and the muscle filter.** An exercise with no machine has
  no muscles either, so it is invisible to the builder's muscle chips and
  contributes nothing to name suggestions until it binds. Fine as-is; only
  worth revisiting if plans commonly stay unbound for long.
- **Template browser filters.** Country/city already render per entry; a
  filter row (chips, like History's) only earns its place once the library
  holds enough templates that scanning the list stops working.
