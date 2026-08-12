# gymii — agent notes

Minimal gym workout tracker. Vanilla HTML/CSS/JS (ES modules), **no build
step, zero dependencies**, all data in localStorage. Mobile-first, dark-only.

## Run & verify

- Dev server: `python3 serve.py` → http://localhost:8437 (sends
  `Cache-Control: no-store`; plain `http.server` made Chrome serve stale
  modules — don't go back to it).
- Logic tests: `node test/store.test.mjs` (stubs localStorage, covers store
  roundtrips, outline migration, template validation, locker carry-over).
- UI changes: verify in a real browser (claude-in-chrome). Editor
  interactions are best tested with scripted PointerEvents + localStorage
  asserts — pixel coordinates shift with window size. `setPointerCapture`
  is wrapped in try/catch so synthetic events work.

## Architecture

- `js/store.js` — the ONLY data layer. Profile registry `gymii.profiles`
  (`{v, list:[{id,name}], activeId}`); gym/workouts/active live under
  per-profile keys `gymii.<pid>.gym|workouts|active`, settings stay global
  (`gymii.settings`). Legacy top-level keys migrate lazily in
  `ensureProfiles()`. Stored weights are always in the current display
  unit — `setUnit()` converts ALL profiles' data in one shot. Other lazy
  migrations live in `getGym()` (outline, meta). Pick lists:
  `MUSCLE_GROUPS`, `COMMON_SETTINGS`, `ZONE_LABELS`.
- `js/app.js` — hash-router, renders views into `#view`.
- `js/studio.js` — floor-plan editor. `drawGym()` is the shared renderer
  (train mini-maps use it too). Polygon outline with vertex/midpoint
  editing; `FIXTURES` registry; `WALL_SNAPPED` fixtures (entrance/door/
  window) glue to the nearest wall segment with rotation + flips.
  Undo/redo = snapshot history via the local `save()` wrapper — every
  mutation must go through `save()`, never `saveGym()` directly.
- `js/train.js` — guided workout: `active.plan` (machine order), overview
  hub, per-machine `restSeconds`, locker number, two-tap finish guard.
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

## Publish plan (not done yet — do on request only)

new-mirrored-repo flow (Forgejo origin + GitHub mirror), Pages CI +
dependabot from web-project skill references, LICENSE per licensing.md,
sitemap.xml/robots.txt with the real URL, then the community-template PR
flow (`templates/index.json` is the manifest "database" with
country/city metadata).
