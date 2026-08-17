# gymii — agent notes

Minimal gym workout tracker. Vanilla HTML/CSS/JS (ES modules), **no build
step, zero dependencies**, all data in localStorage. Mobile-first, dark-only.

## Run & verify

- Dev server: `python3 serve.py [port]` → http://localhost:8437 (sends
  `Cache-Control: no-store`; plain `http.server` made Chrome serve stale
  modules — don't go back to it).
- Logic tests: `for f in test/*.test.mjs; do node "$f"; done` — CI runs the
  glob, so a new `test/<module>.test.mjs` is picked up without a workflow
  edit. `store` (localStorage stub, store roundtrips, outline migration,
  template validation, locker carry-over), `train` (guided-plan
  construction), `plan` (stored plans, the note parser/serialiser, AI
  import, binding, targets), `history` (name filter, muscle card + filter,
  full editor, back-logging), `studio` (editor rendering, collision),
  `demo` (generator determinism, entry invariants, weekday plan states,
  unit conversion, load-replaces-profile). Modules import
  fine in Node as long as none touches the DOM at top level; the stub DOM
  hands back EVERY selector, rendered or not, so a test must drive view
  switches explicitly rather than assume a branch was skipped.
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
  carry `at` (epoch ms, stamped at log time) — older sets lack it, and so
  must sets added by editing or back-logging; every consumer must guard.
  `saveWorkouts()` sorts by `startedAt`: chronological order is an
  INVARIANT (repeat-last reads the tail, `lastEntryFor` walks it
  backwards, history renders it reversed), and back-logging a session or
  editing a date would silently break it. Workouts may carry an optional `name`
  (locker-style lifecycle: dropped when emptied; start screen groups
  routines by name when present). Machine type flags
  `cardio`/`bodyweight` are mutually exclusive and absent for strength;
  optional `machine.exercises: [string]` (deleted when emptied) splits a
  station into per-exercise entries — `lastEntryFor(machineId, exercise)`.
  Other lazy migrations live in `getGym()` (outline, meta).
  `suggestWorkoutNames(machineIds, gym)` proposes names from what was
  trained (each machine contributes ONE unit split across its muscles, so
  a three-muscle station can't outvote two others; a Push/Pull/Leg split
  needs a ≥70% share, else it falls back to region names) and
  `recentWorkoutNames()` returns the names already in use — together they
  fill the name chips on the overview and in the builder. A name is
  proposed, never asked for. Pick lists:
  `MUSCLE_GROUPS`, `COMMON_SETTINGS`, `ZONE_LABELS` (its 'Cardio' string
  is a room label — unrelated to the `machine.cardio` flag). Stored plans
  live under `gymii.<pid>.plans`: `{id, name, createdAt, days?, skippedOn?,
  items:[{machineId?, name?, num?, exercise|null, target?}]}` with target
  `{sets,reps,weight}` or `{distance,seconds}`; `days` is getDay()-coded
  weekday ints (locker-style: dropped when emptied), today's plans sort
  first on the start screen; part of backups, wiped with the profile.
  `savePlan()` stamps `createdAt` on FIRST store only — weekday tracking
  must not report the Monday before a plan existed as missed; plans from
  backups carry none and count as always-there. Finished workouts carry
  `planId` (set by `finishWorkout` from `active.planId`), so "was this
  plan trained?" is exact; older workouts fall back to a name match.
  WEEKDAY STATE (`planDayState`, all pure date maths over an injectable
  `now`, so it tests without waiting for a Tuesday): `due` (today, open),
  `done` (today, trained), `missed`, `skipped`, `clear`. Two guards keep
  the tone reporting rather than nagging — a day before `createdAt` was
  never missed, and `missed` needs the PREVIOUS cycle to have been
  trained, so a plan never started (or dropped weeks ago) goes quiet
  instead of accusing every week. `skipPlanDay()` writes `skippedOn` for
  exactly one cycle. `todayStatus()` picks the one thing to say
  (due ▸ missed ▸ done ▸ rest). `usualWeekday()` spots a rhythm (≥3
  sessions, ≥60% on one day) for the builder to offer.
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
  overview line and in the finish message. The start screen opens with ONE
  stated sentence about today (`statusLine()` over `todayStatus()`): what
  is on, what was missed (with an inline "Skip this week"), that today's
  plan is already done, or that it is a rest day and when the next one
  lands. Saying "nothing today" is a feature, not an empty slot. It is
  plan-first: the weekday status picks the primary plan (due, else
  missed) and a DONE plan deliberately hands the big button back rather
  than pushing the same session twice; with no weekdays anywhere the old
  fallback applies (most recently done plan).
  "Repeat last workout" moves below it and drops entirely
  when the last workout came from that plan. Stored plans list above
  history-derived routines. EVERY row is tappable (`.row-open` + chevron —
  a row that looks like a row must not be dead): a plan row opens its
  settings (the builder), a derived routine row opens the builder SEEDED
  from it (`planSeedFrom()` — one item per machine/exercise pair; targets
  still come from each machine's own latest session, not the routine's,
  because planning wants the current working weight). Nothing persists
  until Save, so the seeded builder doubles as "what IS this routine?".
  A plan then OWNS its routine and the derived row is SKIPPED — matched
  either by name or by covering exactly the same machine set, which is
  what turning a routine into a plan produces.
  The plan builder (`js/plan.js`, muscle-filtered machine
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
  (`js/chart.js`), workout list with repeat, and full editing: per-set
  values, `+ Set` (copies the previous one, minus its `at` — it was not
  logged live), `+ Machine` (snapshots num/label/type flags like the log
  screen), remove set or whole station, date + time (finishedAt moves
  with the start, keeping the duration) and name chips. `Log a past
  workout` reads the same note grammar via `workoutFromText()` — a past
  workout IS a plan that already happened, so `3x10 80` becomes three
  real sets — and reopens the result in edit mode (`openEditId`). It
  shows even on the empty screen: coming over from paper starts there.
  Workout-name chips at the top
  filter EVERYTHING: `workouts` is narrowed once, right after `getWorkouts()`,
  so heatmap, chart, machine lists and the list all follow. The filter is
  module state (`nameFilter`) because a save or delete re-renders the whole
  view, and it self-clears when its last workout is renamed or deleted.
  The Muscles card (store's `usageByMuscle`/`workoutsWithMuscle`) shows
  sets per muscle group as tappable bar rows that set a second filter
  (`muscleFilter`, ANDed after the name filter, same lifecycle incl.
  self-clear and the past-log reset). Muscles resolve against the LIVE gym
  — entries don't snapshot them — and a set on a two-muscle station counts
  fully for both (usage is attribution; only naming votes split 1/n). The
  filter narrows WHOLE workouts, never entries, so the editor's Save can't
  drop non-matching stations; the card itself is computed over the
  name-only list so every muscle stays reachable while one is selected.
- `js/demo.js` — "Load test data" (Settings card): fills a separate "Demo"
  profile with a 16-machine gym (the example template plus cardio,
  bodyweight and a multi-exercise station), ~8 weeks of Push/Pull/Legs
  history and three weekday plans built so `due`, `missed` and `done` all
  show at once, relative to the injected `now`. Fully deterministic —
  fixed `demo-*` ids, seeded PRNG, no `uid()`/`Date.now()` inside
  `buildDemoData` — so a reload REPLACES the Demo profile instead of
  duplicating it. The profile is found by its `demo` flag, NEVER by name
  (names are user-editable — matching one would let a reload overwrite a
  real gym called "Demo"), and stays deletable even as the last profile
  (Settings promises removal; the registry self-heals). Data is authored
  in kg/metres and converted in one pass through store's
  `convertWeight`/`convertDistance` when the display unit is lbs (plan
  targets included). Day maths goes through store's `startOfDay` +
  `setDate()`, never fixed 86400000-ms steps (DST). Generated sets never
  carry `at` (they were not logged live).
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
