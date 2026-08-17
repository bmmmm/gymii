# TODO

Shipped 2026-08-14, in five waves: plans that exist before the gym does
(typed note → unbound items → bind on the floor), the builder's text view,
proposed workout names, the history name filter, and a complete workout
editor incl. logging a session after the fact. See AGENTS.md for how the
pieces fit; README for what they do.

Shipped 2026-08-16: "Load test data" (Settings) fills a deterministic Demo
profile — 16 machines, 8 weeks of history, three weekday plans covering
due/missed/done — so manual testing never starts from an empty gym; the
History tab gained a Muscles card (sets per group as tappable bar rows that
filter the whole view); and setUnit now converts plan targets too (they
were silently left in the old unit).

Shipped 2026-08-17: the AI export carries saved plans (same wire shape the
prompt teaches for answers, ~5% of a demo-sized export, measured), and a
pasted answer that keeps an exported plan id replaces that plan in place
behind a two-tap confirm — "tighten up my push plan" is a real roundtrip
now instead of a duplicate. Plus a review sweep: the demo profile is
identified by a `demo` flag instead of its user-editable name (a real gym
called "Demo" can no longer be overwritten), demo day maths is DST-safe,
and the unit converters live in store.js once.

Also 2026-08-17 — community templates: `test/templates.test.mjs` gates
manifest ↔ files ↔ real import validation on every PR; template files left
the sw.js precache (on-demand content, only the manifest stays — a template
PR is two files and never touches sw.js); intake via the "Submit a gym
template" issue form (paste the export, no git needed) plus PR template,
CONTRIBUTING.md and SECURITY.md (private vulnerability reporting enabled);
the Studio template browser links to the form ("Share your gym").

Also 2026-08-17 — orchestrated sweep (4 waves, 6 agents, all merged
green): the locker card steps aside once the first set is logged
(collapsed details row above Finish — focus stays on the next machine);
the rest beep reuses an AudioContext created inside the log-set gesture
(iOS suspends gesture-less contexts — the timer was silent there); the
Studio finds a machine by number (select + locate pulse); the AI export
dates workouts in local time (was UTC — off-by-one past midnight); and a
real setUnit bug is fixed: a RUNNING workout's plan-slot targets kept
their number across a unit switch (80 kg goal became an 80 lbs one
mid-session). Plus consolidation: store helpers `bindOrCreateMachine` /
`newEntry` / `nameChipsFor`, shared ui.js date/chain helpers, the map
renderer extracted to `js/map.js` (sw.js cache v6), a "prefill matrix"
test block pinning the prefill contract, and the typed-0 weight-step
edge.

## Open

- **Verify the issue forms in a signed-in browser.** The chooser
  (`/issues/new/choose`) should show four forms + two contact links with
  "Blank issue" as maintainers-only, and the template form must block
  submit while required fields are empty. No API can check this
  (GraphQL `issueTemplates` returns `[]` even for working YAML forms;
  the chooser is login-gated) — it needs real clicks, then close the
  test issue.
- **Browser smoke of the 2026-08-17 sweep.** Locker collapse (spacing +
  summary tap target — the CSS has not been seen rendered) and the
  Studio find-by-number pulse, plus how the dimmed rest screen *feels* —
  the per-second brightness jerk is timing, which no test judges (does the
  clock stay readable at 22%, is the 130 ms flash too subtle in daylight?).
  The timer sounds are DONE: verified on a
  real iPhone 2026-08-17, audible with the ring/silent switch ON — the
  media-element path (runtime-rendered WAV blobs) does what it was
  built for.
- **test/map.test.mjs split.** test/studio.test.mjs now covers both the
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
