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

## Open

- **Plans in the AI export.** `buildAiExport()` still ships gym + history
  only, so "tighten up my push plan" means pasting the plan in by hand.
  The plan shape is already in the prompt for the answer — the question is
  whether the request should carry it too, and whether that is worth the
  extra tokens in every export.
- **Unbound items and the muscle filter.** An exercise with no machine has
  no muscles either, so it is invisible to the builder's muscle chips and
  contributes nothing to name suggestions until it binds. Fine as-is; only
  worth revisiting if plans commonly stay unbound for long.
- **Community templates** (carried over): the PR flow for
  `templates/index.json` as the manifest "database" with country/city
  metadata.
