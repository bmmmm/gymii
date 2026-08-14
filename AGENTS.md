# gymii — agent notes

Minimal gym workout tracker. Vanilla HTML/CSS/JS (ES modules), **no build
step, zero dependencies**, all data in localStorage. Mobile-first, dark-only.

## Run & verify

- Dev server: `python3 serve.py [port]` → http://localhost:8437 (sends
  `Cache-Control: no-store`; plain `http.server` made Chrome serve stale
  modules — don't go back to it).
- Logic tests: `node test/store.test.mjs` (stubs localStorage, covers store
  roundtrips, outline migration, template validation, locker carry-over),
  `node test/train.test.mjs` (guided-plan construction) and
  `node test/plan.test.mjs` (stored plans, AI plan import, target flow);
  train.js imports fine in Node as long as no module touches the DOM at
  top level.
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
  reuses `{reps, weight}` with weight = ADDED weight. Live-logged sets also
  carry `at` (epoch ms, stamped at log time) — older sets lack it, every
  consumer must guard. Workouts may carry an optional `name`
  (locker-style lifecycle: dropped when emptied; start screen groups
  routines by name when present). Machine type flags
  `cardio`/`bodyweight` are mutually exclusive and absent for strength;
  optional `machine.exercises: [string]` (deleted when emptied) splits a
  station into per-exercise entries — `lastEntryFor(machineId, exercise)`.
  Other lazy migrations live in `getGym()` (outline, meta). Pick lists:
  `MUSCLE_GROUPS`, `COMMON_SETTINGS`, `ZONE_LABELS` (its 'Cardio' string
  is a room label — unrelated to the `machine.cardio` flag). Stored plans
  live under `gymii.<pid>.plans`: `{id, name, days?, items:[{machineId?,
  name?, num?, exercise|null, target?}]}` with target `{sets,reps,weight}`
  or `{distance,seconds}`; `days` is getDay()-coded weekday ints
  (locker-style: dropped when emptied), today's plans sort first on the
  start screen; part of backups, wiped with the profile.
  PLAN ITEM INVARIANT: an item carries a `machineId` (bound) or a `name`
  (UNBOUND — the movement is known, the station isn't). Unbound items are
  what lets a plan exist before a gym does; `num` on one is a hint from
  its source note that prefills the bind prompt, never a binding. A bound
  item's type comes from its machine, an unbound one's from its target
  shape (`distance` ⇒ cardio) — `isUnbound()` is the check.
  `parsePlanLine()`/`parsePlanText()` read a trainer's note ("Leg press
  3x10 80", "#7 Chest press 3x8-12 40kg", "Treadmill 20min"): set and
  weight terms are cut FIRST so a leftover leading number is unambiguous,
  and only a MARKED num (`#7`, `7.`, `7)`) counts — "45 degree leg press"
  keeps its 45. Rep ranges target the low end; foreign units convert.
  `planItemsFrom()` binds raw items against a gym (num, then exact label,
  then a SINGLE substring match) and leaves the rest unbound;
  `planFromText()` and `planFromImport()` both go through it, so a typed
  note and an AI `workout-plan` file behave identically. planFromImport
  returns `{plan, unbound}` — an unknown num no longer drops its item.
  `planToText()` is the exact inverse of `parsePlanText()` (bound items
  lead with `#num`, which is what makes the round-trip bind again) and
  backs the builder's Text view. `#2 Dumbbells: Biceps curls` names a
  movement AT a station — only a marked num unlocks that reading, or
  "Day A: Leg press" would lose half its name to a false heading.
- `js/app.js` — hash-router, renders views into `#view`. The `#studio`
  route is deliberately NOT in the tabbar (the map is a setup tool, not a
  daily surface — user decision); it is reached via links in onboarding
  and Settings. Don't re-add the tab.
- `js/studio.js` — floor-plan editor. `drawGym()` is the shared renderer
  (train mini-maps use it too); its `highlightId` opt marks one machine
  `.locate` (white stroke, CSS pulse) and dims the rest — visual machine
  state belongs here, never as post-render DOM pokes in train.js. Polygon outline with vertex/midpoint
  editing; `FIXTURES` registry; `WALL_SNAPPED` fixtures (entrance/door/
  window) glue to the nearest wall segment with rotation + flips.
  Undo/redo = snapshot history via the local `save()` wrapper — every
  mutation must go through `save()`, never `saveGym()` directly.
- `js/train.js` — guided workout: `active.plan` is a list of slots
  `{machineId, exercise|null, target?}` (null = whole station) — a repeat
  plans one slot per (machine, exercise) pair so "Next:" walks every
  exercise of a multi-exercise station; overview hub, per-machine
  `restSeconds`, locker number, two-tap finish guard. Quick-switch chips on
  the log screen jump to the two most recently trained OTHER stations (by
  newest set `at`). Slots started from a stored plan carry its target:
  the log header shows it, the first-set prefill uses it (real logged sets
  then outrank it), and `slotDone` counts sets against `target.sets`, so
  "Next:" pulls the walk back to unfinished targets. The plan follower's
  happy path is one tap per set: the log button always names what it logs
  ("✓ Log set 2/3 — 50 kg × 10", steppers update it live), and once a
  slot's target is met the Next button takes over as the primary action
  (log button demoted). `targetTally()` reports plan-wide progress on the
  overview line and in the finish message. The start screen is plan-first:
  the most relevant plan (today's weekday, else last done) gets the big
  primary button; "Repeat last workout" moves below it and drops entirely
  when the last workout came from that plan. Stored plans list (Start/Edit)
  above history-derived routines, and derived rows whose workout name
  matches a plan name are SKIPPED — a named plan owns its routine. The plan builder (`js/plan.js`, muscle-filtered machine
  picking, per-item targets, reorder) renders inside the Train tab via
  module state (`openPlanBuilder()` — used by ai.js for import review); an
  active workout always outranks it. The builder runs WITHOUT a gym —
  unbound items get a `📍 Assign machine` prompt (number field prefilled
  from `item.num`, plus chips for existing machines) and a one-line
  `Add an exercise` field that parses the same note grammar.
  List/Text chips switch between the stepper list and the plain note
  (`planToText`/`parsePlanText`); every switch AND `persist()` go through
  `fromText()`, so the text is authoritative while it is on screen.
  A slot whose `machineId` is null renders `renderBind()` instead of the
  log screen (`active.binding` = its plan index): one question, one
  number. An unknown number CREATES the machine under the item's own name
  (and marks it `cardio` when the target says so, or the target would be
  dropped as the wrong shape), so the gym grows out of the plan instead
  of gating it. The binding is written back into the stored plan via
  `active.planId` — asked once per exercise, not once per session.
  `machine.cardio` flips the log screen to
  distance+time, `machine.bodyweight` to reps + extra weight; type flags
  and `exercise` are SNAPSHOTTED onto the entry (like num/label) —
  history/edit/chart/AI read the entry, never the live machine.
  Multi-exercise stations hold one entry per (machineId, exercise);
  `active.currentExercise` tracks the picked one and follows the slot on
  Next:/overview-row switches (null when arriving via the picker).
  The picker's mini-map is collapsed by default (`settings.pickerMap`,
  toggled + persisted via the 🗺 Map chip; Colors/Usage hide with it, the
  map draws lazily on first expand). 📍 buttons on the log screen
  (machine head + next-row) open `showMapOverlay()` — a fullscreen
  read-only map, target machine pulsing, others dimmed, any tap closes.
  `nearbyAlternative()` renders a "Busy? #N … is nearby" button under the
  next-row: the physically closest OTHER open station (machine centers,
  current + plan-next excluded) as the busy-machine escape hatch —
  display-only, the skipped slot resurfaces via the wrap-around.
  The overview's "Muscles today" chips (muscles of machines with sets
  this session, read live from the gym) double as navigation: a tap
  calls the picker's `setMuscle()` to filter machines for that muscle. Set-arithmetic must guard
  against other shapes (`st.reps * st.weight || 0`); only a `target.sets`
  target counts sets off (`setGoal`) — a cardio target is one bout, not a
  tally. Nothing to start = an onboarding screen led by ONE action: type
  in the plan you already have (`planFromText`), with quick start on a
  line below it and the Studio as a text link. The map is the reward for
  a gym that exists, never the toll gate before it — a saved plan also
  outranks onboarding, and the start screen falls back to quick start
  when the gym has no machines. The picker offers create-on-miss for
  unknown numbers via `store.addMachine()` — training never requires a
  studio visit first.
- `js/history.js` — month heatmap (per-machine filter), progress chart
  (`js/chart.js`), workout list with repeat.
- `js/ai.js` — copy prompt+data / paste-import. Deliberately NO AI API.
  Export set tuples gain a third element (seconds offset from the
  workout's startedAt) when the set has `at`; old sets stay 2-tuples.
  Pasting a `workout-plan` JSON saves the plan and opens the builder for
  review (mid-workout it just saves); the default prompt tells the LLM the
  exact plan shape to answer with.
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
- Numeric inputs arm for overwrite on focus — old value greyed out in the
  placeholder as "(40)", empty field types fresh, blur without input
  restores it (`initNumericOverwrite()` in ui.js, delegated globally).
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

`.github/workflows/ci.yml` runs all four logic tests (`test/*.test.mjs`) and
cross-checks the `sw.js` SHELL list against `git ls-files`, then deploys the
repo root to Pages
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
