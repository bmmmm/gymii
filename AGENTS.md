# gymii — agent notes

Minimal gym workout tracker. Vanilla HTML/CSS/JS (ES modules), **no build
step, zero dependencies**, all data in localStorage. Mobile-first, dark-only.

## Run & verify

- Dev server: `python3 serve.py` → http://localhost:8437 (sends
  `Cache-Control: no-store`; plain `http.server` made Chrome serve stale
  modules — don't go back to it).
- Logic tests: `node test/store.test.mjs` (stubs localStorage, covers store
  roundtrips, outline migration, template validation, locker carry-over) and
  `node test/train.test.mjs` (guided-plan construction; train.js imports
  fine in Node as long as no module touches the DOM at top level).
- UI changes: verify in a real browser (claude-in-chrome). Editor
  interactions are best tested with scripted PointerEvents + localStorage
  asserts — pixel coordinates shift with window size. `setPointerCapture`
  is wrapped in try/catch so synthetic events work.
- `navigator.wakeLock` cannot be verified via claude-in-chrome (the
  automation window is hidden → NotAllowedError); verify the denial path
  live and the acquire/release logic by review.

## Architecture

- `js/store.js` — the ONLY data layer. Profile registry `gymii.profiles`
  (`{v, list:[{id,name}], activeId}`); gym/workouts/active live under
  per-profile keys `gymii.<pid>.gym|workouts|active`, settings stay global
  (`gymii.settings`). Legacy top-level keys migrate lazily in
  `ensureProfiles()`. Stored weights are always in the current display
  unit — `setUnit()` converts ALL profiles' data in one shot. Set shapes:
  strength `{reps, weight}`, cardio `{distance, seconds}` (distance in the
  display unit, m/mi via `distUnit()`; seconds unit-less), bodyweight
  reuses `{reps, weight}` with weight = ADDED weight. Machine type flags
  `cardio`/`bodyweight` are mutually exclusive and absent for strength;
  optional `machine.exercises: [string]` (deleted when emptied) splits a
  station into per-exercise entries — `lastEntryFor(machineId, exercise)`.
  Other lazy migrations live in `getGym()` (outline, meta). Pick lists:
  `MUSCLE_GROUPS`, `COMMON_SETTINGS`, `ZONE_LABELS` (its 'Cardio' string
  is a room label — unrelated to the `machine.cardio` flag).
- `js/app.js` — hash-router, renders views into `#view`.
- `js/studio.js` — floor-plan editor. `drawGym()` is the shared renderer
  (train mini-maps use it too). Polygon outline with vertex/midpoint
  editing; `FIXTURES` registry; `WALL_SNAPPED` fixtures (entrance/door/
  window) glue to the nearest wall segment with rotation + flips.
  Undo/redo = snapshot history via the local `save()` wrapper — every
  mutation must go through `save()`, never `saveGym()` directly.
- `js/train.js` — guided workout: `active.plan` is a list of slots
  `{machineId, exercise|null}` (null = whole station) — a repeat plans one
  slot per (machine, exercise) pair so "Next:" walks every exercise of a
  multi-exercise station; overview hub, per-machine `restSeconds`, locker
  number, two-tap finish guard. `machine.cardio` flips the log screen to
  distance+time, `machine.bodyweight` to reps + extra weight; type flags
  and `exercise` are SNAPSHOTTED onto the entry (like num/label) —
  history/edit/chart/AI read the entry, never the live machine.
  Multi-exercise stations hold one entry per (machineId, exercise);
  `active.currentExercise` tracks the picked one and follows the slot on
  Next:/overview-row switches (null when arriving via the picker). Set-arithmetic must guard
  against other shapes (`st.reps * st.weight || 0`). No machines = an
  onboarding screen (studio / quick start / template), and the picker
  offers create-on-miss for unknown numbers via `store.addMachine()` —
  training never requires a studio visit first.
- `js/history.js` — month heatmap (per-machine filter), progress chart
  (`js/chart.js`), workout list with repeat.
- `js/ai.js` — copy prompt+data / paste-import. Deliberately NO AI API.
- `sw.js` + `manifest.webmanifest` — PWA. Network-first with cache
  fallback (online always fresh, no cache bump per deploy). IMPORTANT:
  new static files (js modules, css, icons) must be added to the SHELL
  list in `sw.js`. Rest timer holds a screen wake lock (auto re-acquired
  on visibilitychange; denial is silently ignored).

## Conventions (user-set, follow them)

- Everything in code English, incl. UI strings. German only in chat.
- Destructive/final actions: hidden + two-tap guard (never `confirm()` —
  it blocks browser automation). Frequent actions visually dominant.
- Enumerable input = tappable chips, never free text (typo avoidance).
- View toggles live ON the object they affect (e.g. Colors/Usage on the
  map), persisted in settings — not buried in the Settings tab.
- Chart/map colors must pass the dataviz palette validator against
  surface `#171c22` (see comments in chart.js / ITEM_COLORS).

## Published — dual remote

`origin` = Forgejo (private, source of truth), `github` = GitHub (public
mirror), plus a pre-push leak gate that only scans pushes to `github`.
Push both or the mirror drifts: `git push origin main && git push github main`.
Dependabot/CodeQL PRs on GitHub are signals only — fix locally and push to
both remotes, never merge in the GitHub UI.

`.github/workflows/ci.yml` runs `node test/store.test.mjs` and cross-checks the
`sw.js` SHELL list against `git ls-files`, then deploys the repo root to Pages
(<https://bmmmm.github.io/gymii/>) once both pass on main. `security.yml`
(gitleaks + forbidden files + token grep) and `shellcheck.yml` (only on
`scripts/**`) round out the checkers. The site lives on a project subpath, so
every asset reference must stay RELATIVE (`css/style.css`, not
`/css/style.css`) — index.html, manifest and the SHELL list already are.

When a Pages deploy fails, dispatch a fresh run
(`gh workflow run ci.yml --ref main`) — never `gh run rerun --failed`. The
replay uploads a second `github-pages` artifact into the same run and
`deploy-pages` then aborts on "Multiple artifacts named github-pages", which
looks like a workflow bug and isn't.

Open: the community-template PR flow (`templates/index.json` is the manifest
"database" with country/city metadata).
