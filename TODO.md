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

## Open

- **Unbound items and the muscle filter.** An exercise with no machine has
  no muscles either, so it is invisible to the builder's muscle chips and
  contributes nothing to name suggestions until it binds. Fine as-is; only
  worth revisiting if plans commonly stay unbound for long.
- **Template browser filters.** Country/city already render per entry; a
  filter row (chips, like History's) only earns its place once the library
  holds enough templates that scanning the list stops working.
