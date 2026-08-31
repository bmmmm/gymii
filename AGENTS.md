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
  template validation, locker carry-over, sync groundwork: stamps,
  tombstones, v1/v2 backup compat), `merge` (the pure sync merge matrix —
  union by id, LWW, tombstones), `sync` (the client sync engine: protocol
  conformance over a stubbed fetch, WebCrypto roundtrip, sync-code parsing,
  wire unit conversion, synckey-never-in-backup, plain mode, and the M2
  ambient matrix — coalescing, suppression, dirty/304, offline replay,
  queued deletes, tab lock, throttle — plus M3 devices/discovery: fresh
  pairing tokens, revoke→401, last-token, adopt plain/with-pass/wrong-pass),
  `settings` (the Sync
  card's states over the stub DOM), `qr` (the encoder: pinned reference
  matrix, RS vectors, full decode round-trip, penalty rules, overflow), `train` (guided-plan
  construction, hub/start/plans navigation), `plan` (stored plans, the note parser/serialiser, AI
  import, binding, targets), `history` (name filter, muscle card + filter,
  full editor, back-logging), `gym` (editor rendering, collision),
  `demo` (generator determinism, entry invariants, weekday plan states,
  unit conversion, load-replaces-gym), `ai` (export plans section,
  paste-back new-vs-replace flow), `templates` (the community-library
  gate: manifest ↔ files ↔ real import validation). Modules import
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
- Node ≥21 ships a global `navigator` (without `wakeLock`, `vibrate` or
  `Audio`), so a headless guard must test the specific API — `typeof
  navigator === 'undefined'` is false here and asserting it fails. `document`
  genuinely is undefined: an unguarded `document.*` throws a ReferenceError
  no try/catch around a browser API will catch, which is what makes it the
  gate worth probing.

## Architecture

- **Naming — one term per concept.** A **gym** is the CONTAINER (its own
  layout, workouts, plans, history; what Settings lists under "Your gyms").
  A **layout** is the floor plan plus machine list inside one gym — what
  the Gym screen edits. Machines are called machines, never "stations";
  training sessions are called workouts, never "sessions". The ONE
  exception is the wire format: backup and template files keep the field
  `gym` and the kind `gym-template`, because files in the wild read them
  that way — see `exportGymTemplate()`. Don't "fix" that.
- `js/store.js` — the ONLY data layer. Gym registry `gymii.gyms`
  (`{v, list:[{id,name}], activeId}`); layout/workouts/active live under
  per-gym keys `gymii.<gid>.layout|workouts|active`, settings stay global
  (`gymii.settings`). Two historical shapes migrate lazily in
  `ensureGyms()`: the profile era (`gymii.profiles`, and a `gym` part per
  id) and pre-profile top-level keys. Parts move before the registry, so
  a crash mid-migration replays instead of orphaning a layout. Stored
  weights are always in the current display
  unit — `setUnit()` converts ALL gyms' data in one shot. Set shapes:
  strength `{reps, weight}`, cardio `{distance, seconds}` (distance in the
  display unit, m/mi via `distUnit()`; seconds unit-less), bodyweight
  reuses `{reps, weight}` with weight = ADDED weight. Live-logged sets also
  carry `at` (epoch ms, stamped at log time) — older sets lack it, and so
  must sets added by editing or back-logging; every consumer must guard.
  `saveWorkouts()` sorts by `startedAt`: chronological order is an
  INVARIANT (repeat-last reads the tail, `lastEntryFor` walks it
  backwards, history renders it reversed), and back-logging a workout or
  editing a date would silently break it. Workouts may carry an optional `name`
  (locker-style lifecycle: dropped when emptied; start screen groups
  routines by name when present). Machine type flags
  `cardio`/`bodyweight` are mutually exclusive and absent for strength;
  optional `machine.exercises: [string]` (deleted when emptied) splits a
  machine into per-exercise entries — `lastEntryFor(machineId, exercise)`.
  Other lazy migrations live in `getLayout()` (outline, meta).
  SYNC GROUNDWORK (docs/sync-protocol.md is the contract; js/merge.js the
  pure merge layer): every interactive write stamps `updatedAt`
  (`savePlan`, `updateWorkout`, `finishWorkout`, `workoutFromText`,
  `saveSettings`, `createGym`/`renameGym`); absence means epoch 0
  and is MEANINGFUL (legacy loses any merge), so there is deliberately no
  heal-on-read for it. Deletes leave tombstones — sidecar
  `gymii.<gid>.tombstones` (`{v, workouts, plans, machines, shapes}` via
  `get/saveTombstones`) and `gyms.deleted` — never in-object flags, so
  read functions keep their contracts. `saveLayout()` is diff-aware (stamps
  changed machines/shapes, tombstones vanished ids, one structural stamp
  for name/grid/meta/outline — the editor's mutate-then-save needs no change);
  bulk restore goes through `restoreLayout()` verbatim (imports, future sync
  apply — re-diffing would forge stamps). `uid()` is crypto-random, 16
  chars; legacy 8-char ids stay valid, and ids deliberately carry no
  device marker (they travel into AI exports). Backups are `v: 2`
  (tombstones included, deletes stay dead across restore); v1 files import
  unchanged. The future sync key (`gymii.<gid>.synckey`) must NEVER enter
  a backup.
  `suggestWorkoutNames(machineIds, layout)` proposes names from what was
  trained (each machine contributes ONE unit split across its muscles, so
  a three-muscle machine can't outvote two others; a Push/Pull/Leg split
  needs a ≥70% share, else it falls back to region names) and
  `recentWorkoutNames()` returns the names already in use — together they
  fill the name chips on the overview and in the builder. A name is
  proposed, never asked for. Pick lists:
  `MUSCLE_GROUPS`, `COMMON_SETTINGS`, `ZONE_LABELS` (its 'Cardio' string
  is a room label — unrelated to the `machine.cardio` flag). Stored plans
  live under `gymii.<gid>.plans`: `{id, name, createdAt, days?, skippedOn?,
  items:[{machineId?, name?, num?, exercise|null, target?}]}` with target
  `{sets,reps,weight}` or `{distance,seconds}`; `days` is getDay()-coded
  weekday ints (locker-style: dropped when emptied), today's plans sort
  first on the start screen; part of backups, wiped with the gym.
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
  workouts, ≥60% on one day) for the builder to offer.
  PLAN ITEM INVARIANT: an item carries a `machineId` (bound) or a `name`
  (UNBOUND — the movement is known, the machine isn't). Unbound items are
  what lets a plan exist before a gym does; `num` on one is a hint from
  its source note that prefills the bind prompt, never a binding. A bound
  item's type comes from its machine, an unbound one's from its target
  shape (`distance` ⇒ cardio) — `isUnbound()` is the check.
  SHARED INVARIANTS live as store helpers — extend these, never re-inline
  a copy: `bindOrCreateMachine(layout, num, name, target)` (an unknown num
  creates the machine under the item's own name, fallback `Machine ${num}`,
  and inherits `cardio: true` from a distance-shaped target; persists
  nothing — callers keep their own saveLayout timing; used by train's
  renderBind, the builder's bind and `workoutFromText`), `newEntry(machine,
  exercise, sets)` (THE entry snapshot shape incl. type flags; callers add
  settings prefills themselves) and `nameChipsFor(machineIds, layout,
  limit = 5)` (suggested + recent names, deduped — train/history pass one
  id per logged set for weighting, the builder passes item machineIds).
  `setUnit()` also converts a RUNNING workout's plan-slot targets
  (`active.plan[i].target` — startWorkoutFrom copies targets onto slots),
  not just stored plans; leaving them out silently turned an 80 kg goal
  into an 80 lbs one mid-workout.
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
  movement AT a machine — only a marked num unlocks that reading, or
  "Day A: Leg press" would lose half its name to a false heading.
- `js/sync.js` — the cross-device sync engine (M1; docs/sync-protocol.md
  is the wire contract, docs/sync-plan.md the decision log, gymii-sync the
  reference server in its own repo). Public API is a FROZEN contract the
  Settings Sync card consumes: `getSyncState`, `enableSync`,
  `pairWithCode`, `getSyncCode`, `syncNow`, `disableSync`. `syncNow` runs
  GET → decrypt → merge (js/merge.js) → apply → encrypt → PUT If-Match,
  with a max-3 re-merge loop on 409; merged state is applied through the
  bulk writers plus store's `restoreGymEntry`/`restoreSettings` — restore
  twins exist because re-stamping with Date.now() would forge edits that
  beat genuinely newer ones. Unit normalization happens at the wire, stamp-
  driven: the newer userSettings stamp picks the winning unit (remote wins
  ⇒ `setUnit()` converts local, local wins ⇒ the remote blob is converted
  in memory before merging). Crypto: AES-256-GCM, PBKDF2-SHA256 (600k
  iterations), per-gym salt in the outer envelope (a paired device adopts
  it from the blob), fresh 12-byte IV per push. Server URL + account token
  + passphrase + the blob's gymId travel as ONE sync code (`gymii-sync:v1:`
  + base64url JSON; M1 shares one account token — sync-plan decision 13).
  The gymId is load-bearing (decision 14): gym ids never travel between
  devices, so a paired device keeps its LOCAL id and maps onto the blob
  via `remoteId` in the sync config — every wire request speaks the remote
  id, the store only ever sees the local one. Config lives in
  `gymii.<gid>.sync`, key material in `gymii.<gid>.synckey` — both wiped
  with the gym and NEVER in a backup (test-pinned). The demo gym never
  syncs. PLAIN MODE (decision 15): pages without a secure context have no
  `crypto.subtle`, so `enableSync(gid, {…, plain: true})` runs sync
  unencrypted — envelope `{v:1, gymId, plain: <payload>}`, sync code
  carries `plain: true` and no passphrase, no synckey is stored. The mode
  is explicit on both ends: `no-crypto` (nothing silently unencrypted),
  `crypto-available` (no downgrade where E2E works), `mode-mismatch`
  (client mode vs envelope shape). The Settings card renders its
  unencrypted variant exactly when `e2eAvailable()` is false; pairing
  follows the code's mode either way.
  AMBIENT SYNC (M2): `initAmbientSync()` (called once from app.js) wires
  visibilitychange/online plus the store notifier; edits debounce 8 s into
  a push, pulls throttle to one per minute, `ambientFinished()` /
  `ambientWorkoutStart()` are called from train.js. One sync in flight per
  gym ever (a mid-run trigger sets `again`, the run repeats once); across
  tabs Web Locks picks one winner. THE DIRTY FLAG is load-bearing: raised
  by a module-load `onStoreChange` subscription on any interactive write
  (so manual "Sync now" sees edits too), lowered by a completed sync — a
  304 with the flag down ends the run, which is what keeps idle pulls
  from re-pushing and bumping the revision forever. reconcile brackets
  its synchronous apply with `applying` so its own bulk writes neither
  re-trigger nor re-dirty. Offline outcomes set `syncPending`
  (`getSyncState().pending`); `deleteGym` queues the blob's DELETE in
  `gymii.sync.pendingDeletes` BEFORE its sweep wipes the config, and the
  ambient layer drains it. Gym deletion does not propagate to other
  devices (documented in the protocol).
  DEVICES & DISCOVERY (M3): pairing mints a FRESH named token per device
  over `POST /v1/tokens` (`mintPairingCode`) — a device's own token never
  leaves it, revoking one (`revokeDevice`, Devices list in the Sync card)
  never cuts the others, and the server refuses the last token (409 →
  `last-token`). `self` in `listDevices` is server-computed. The QR on the
  pairing code is `js/qr.js` (hand-written encoder, byte mode, EC M, SVG
  string — hard black/white, cameras need the contrast) wrapping
  `<app-url>#pair=<code>`; app.js intercepts `#pair=` BEFORE the route
  lookup, parks the code via `setPendingPairCode` (the focusMachine
  handoff) and `location.replace('#settings')` so the credential never
  enters browser history — Settings prefills the field and never
  auto-pairs. Discovery (`listRemoteGyms`/`adoptRemoteGym`): unknown blobs
  probe-first — plain adopts directly, encrypted needs that gym's own
  passphrase (per-gym keys), a wrong one leaves no local state; the
  adopted placeholder entry is re-stamped to epoch 0 so the blob's real
  name wins the LWW merge instead of being pushed back out. The
  Settings-tab badge (`#sync-badge`, app.js `updateSyncBadge`) feeds on
  `syncHealth()`/`onSyncActivity` — accent = pending, danger = error.
- `js/app.js` — hash-router, renders views into `#view`. The `#gym`
  route is deliberately NOT in the tabbar (the map is a setup tool, not a
  daily surface — user decision); it is reached via links in onboarding,
  Settings and the Train hub's Gym tile. Don't re-add the tab. The
  tabbar shows an emoji icon over each label with a Material-style pill
  behind the active tab's icon — pure CSS off the existing `.active`
  toggle, no router logic involved.
- `js/map.js` — the shared floor-map renderer, split out of the editor so
  train.js/plan.js never import from gym.js. `drawLayout()` draws every
  map surface (editor, train mini-maps, builder); its `highlightId` opt
  marks one machine `.locate` (white stroke, CSS pulse) and dims the rest
  — visual machine state belongs here, never as post-render DOM pokes in
  train.js. Also exports `findMachineByNum`, the collision helpers
  (`overlapsSolid`/`fits`/`freeSpot`), `snapDoorToWall`, `FIXTURES`,
  `WALL_SNAPPED`, `ITEM_COLORS`. Its only import is `esc` from ui.js —
  keep it free of store/gym imports so the cycle cannot reappear.
  train.js additionally imports ONE thing straight from gym.js — the
  `focusMachine` edit handoff — which is fine exactly as long as
  gym.js never imports from train.js/plan.js (the direction the map
  split exists to prevent).
- `js/gym.js` — floor-plan editor (renderer imported from map.js).
  Polygon outline with vertex/midpoint editing; wall-snapped fixtures
  (entrance/door/window) glue to the nearest wall segment with rotation +
  flips. Find-by-number row above the map: a hit selects the machine
  (props open) and pulses it via `highlightId`; the next pointerdown on
  the map clears the pulse. `focusMachine(id)` is the in-memory handoff
  for the log screen's ✏️ button (same pattern as train's
  `openPlanBuilder`): the next `renderGym()` consumes it — selects the
  machine and pulses it via the same find mechanism, silently dropping a
  stale id. While a workout is active the header shows a "← Back to your
  workout" link, whichever way the Gym was reached; without one it
  shows a plain "‹ Train" back row to the hub instead. Undo/redo =
  snapshot history via the local `save()` wrapper — every mutation must
  go through `save()`, never `saveLayout()` directly.
- `js/train.js` — guided workout: `active.plan` is a list of slots
  `{machineId, exercise|null, target?}` (null = whole machine) — a repeat
  plans one slot per (machine, exercise) pair so "Next:" walks every
  exercise of a multi-exercise machine; overview hub, per-machine
  `restSeconds`, locker number, two-tap finish guard. The locker is asked
  where the workout actually starts: the start screen offers it up front
  (module state `pendingLocker`, no workout exists yet — the next
  `startWorkoutFrom` moves it onto the workout and clears it, whichever
  way the workout then starts), and the log screen shows the same
  one-line `.locker-ask` row (input + Skip) until the first set of the
  WORKOUT is logged, the number is noted, or Skip sets
  `active.lockerDismissed`
  (transient — `finishWorkout`'s allow-list never copies it out). The
  overview's locker card leads under the same condition; afterwards both
  collapse to a `details.locker` row at the bottom of the overview
  (directly above Finish, next to the `details.name-edit` row that
  replaced the old leading Name card — naming is optional bookkeeping, so
  it reads as "✏️ name" and expands to the same input + chips) — exactly
  one `#locker-num` input exists in whichever of the four states renders
  (start-screen note, log-screen ask, overview card, collapsed row), the
  log-screen 🔒 header badge is unaffected. Both "no set yet" checks
  share `workoutSetCount()`. Quick start
  (`#qs-label`/`#qs-start`) is wired once
  via `wireQuickStart()` — onboarding and the no-machines start screen
  share it, incl. the logged-sets backstop. The rest beep plays through ONE
  shared HTMLAudioElement (ui.js), deliberately NOT WebAudio: iOS mutes
  WebAudio with the ring/silent switch but treats media playback like
  music (YouTube keeps playing on silent), so the tones are rendered
  into tiny WAV blobs at runtime (`renderWav`, cached per sound — no
  audio assets ship) and played like a track. `primeAudio()` must
  run inside a user gesture — `startRest()` (the log-set click) primes so
  the element may be replayed when the timer fires ~90s later. It plays a
  SILENT wav (a zero-frequency note renders pure zeros, asserted in the
  tests): the earlier play-then-pause raced the `play()` promise and
  audibly leaked the first note, so a tone fired right after "Log set"
  and again at zero. The sound must only play at zero. The tone is `settings.timerSound`, picked from the
  data-driven `TIMER_SOUNDS` via `playTimerSound()` — the Settings chips
  preview each sound on tap (the tap is the gesture).
  `nextSetDefaults` is exported for the logic tests (same precedent as
  `nearbyAlternative`); its behavior contract is pinned by the
  "prefill matrix" block in test/train.test.mjs: once a set is logged
  this workout its last set is the prefill — history (or a plan target)
  only seeds the first set. Quick-switch chips on
  the log screen jump to the two most recently trained OTHER machines (by
  newest set `at`). Slots started from a stored plan carry its target:
  the log header shows it, the first-set prefill uses it (real logged sets
  then outrank it), and `slotDone` counts sets against `target.sets`, so
  "Next:" pulls the walk back to unfinished targets. The plan follower's
  happy path is one tap per set: the log button always names what it logs
  ("✓ Log set 2/3 — 50 kg × 10", steppers update it live), and once a
  slot's target is met the Next button takes over as the primary action
  (log button demoted). `targetTally()` reports plan-wide progress on the
  overview line and in the finish message. The Train tab's ROOT is a
  neutral bento hub (`renderHub`): a hero tile into the merged start flow
  (machine or plan — the start screen carries both) plus tiles to Plans,
  Gym (`#gym`) and History; module state `screen`
  (`'hub'|'start'|'plans'`, setters `goToHub`/`goToStart`/`goToPlans`
  exported for the tests) is the LOWEST layer of `screenKey(active,
  builder, screen)`'s priority — an active workout or open builder
  outranks it, which is exactly why the AI import needs no change.
  `finish()` resets `screen` to `'hub'`: the hub is the resting point
  after the loop closes. The hero's subtitle is `statusText()` —
  `statusLine()`'s plain-text twin (the hero is itself a `<button>`, so no
  markup and no nested skip button); with no dated plan it falls back to
  `lastWorkoutLabel()`, which the History tile always shows. Sub-screens
  carry a `.back-row` at the top ("‹ Train" on start/plans, "‹ Workout" on
  log/bind — bind's clears `active.binding` like Skip, never
  `currentMachineId`; the overview has none, Finish is its exit).
  The start screen is
  machine-first: the "Start at a machine" picker card leads — its action
  button says "Start training", because outside a workout a pick starts
  one; the same `machinePicker` renders "Add" on the overview via its
  `actionLabel` option, where a pick only appends to the running workout.
  Below the picker comes ONE stated sentence about today (`statusLine()`
  over `todayStatus()`): what is on, what was missed (with an inline
  "Skip this week"), that today's plan is already done, or that it is a
  rest day and when the next one lands. Saying "nothing today" is a
  feature, not an empty slot. The weekday status picks the primary plan
  (due, else missed) and a DONE plan deliberately hands its start button
  back rather than pushing the same workout twice; with no weekdays
  anywhere the old fallback applies (most recently done plan). Both plan
  buttons are plain `.btn` — deliberately demoted: still one tap, no
  longer the headline. The "Planned workouts" card is `planListCard()`,
  shared byte-identically with the hub's Plans screen (`renderPlans`) —
  markup and wiring live once.
  "Repeat last workout" moves below it and drops entirely
  when the last workout came from that plan. Stored plans list above
  history-derived routines. EVERY row is tappable (`.row-open` + chevron —
  a row that looks like a row must not be dead): a plan row opens its
  settings (the builder), a derived routine row opens the builder SEEDED
  from it (`planSeedFrom()` — one item per machine/exercise pair; targets
  still come from each machine's own latest workout, not the routine's,
  because planning wants the current working weight). Nothing persists
  until Save, so the seeded builder doubles as "what IS this routine?".
  A plan then OWNS its routine and the derived row is SKIPPED — matched
  either by name or by covering exactly the same machine set, which is
  what turning a routine into a plan produces.
  A slot whose `machineId` is null renders `renderBind()` instead of the
  log screen (`active.binding` = its plan index): one question, one number,
  bound via store's `bindOrCreateMachine` — so the gym grows out of the
  plan instead of gating it. The binding is written back into the stored
  plan via `active.planId` — asked once per exercise, not once per workout.
  `machine.cardio` flips the log screen to
  distance+time, `machine.bodyweight` to reps + extra weight; type flags
  and `exercise` are SNAPSHOTTED onto the entry (like num/label) —
  history/edit/chart/AI read the entry, never the live machine.
  Multi-exercise machines hold one entry per (machineId, exercise);
  `active.currentExercise` tracks the picked one and follows the slot on
  Next:/overview-row switches (null when arriving via the picker).
  The picker's mini-map is collapsed by default (`settings.pickerMap`,
  toggled + persisted via the 🗺 Map chip; Colors/Usage hide with it, the
  map draws lazily on first expand). 📍 buttons on the log screen
  (machine head + next-row) open `showMapOverlay()` — a fullscreen
  read-only map, target machine pulsing, others dimmed, any tap closes.
  The machine head's ✏️ button hands the machine to the Gym's full
  editor (`focusMachine` + `#gym`) — machines stay editable
  mid-workout, no Settings detour, and the Gym's back link returns to
  the running workout.
  `nearbyAlternative()` renders a "Busy? #N … is nearby" button under the
  next-row: the physically closest OTHER open machine (machine centers,
  current + plan-next excluded) as the busy-machine escape hatch —
  display-only, the skipped slot resurfaces via the wrap-around.
  The overview's "Muscles today" chips (muscles of machines with sets
  this workout, read live from the layout) double as navigation: a tap
  calls the picker's `setMuscle()` to filter machines for that muscle. Set-arithmetic must guard
  against other shapes (`st.reps * st.weight || 0`); only a `target.sets`
  target counts sets off (`setGoal`) — a cardio target is one bout, not a
  tally. Nothing to start = an onboarding screen led by ONE action: type
  in the plan you already have (`planFromText`), with quick start on a
  line below it and the Gym as a text link. The map is the reward for
  a gym that exists, never the toll gate before it — a saved plan also
  outranks onboarding, and the start screen falls back to quick start
  when the gym has no machines. The picker offers create-on-miss for
  unknown numbers via `store.addMachine()` — training never requires a
  gym visit first.
- `js/plan.js` — the plan builder: muscle-filtered machine picking, per-item
  targets, reorder, weekday chips. It renders INSIDE the Train tab via
  train.js's module state (`openPlanBuilder()`, which ai.js uses for import
  review); an active workout always outranks it. It runs WITHOUT a gym:
  unbound items get a `📍 Assign machine` prompt (number field prefilled
  from `item.num`, plus chips for the machines that exist), binding through
  store's `bindOrCreateMachine`, and a one-line `Add an exercise` field
  parsing the same note grammar as the onboarding note. List/Text chips
  switch between the stepper list and the plain note
  (`planToText`/`parsePlanText`); every switch AND `persist()` go through
  `fromText()`, so the text is authoritative while it is on screen. Nothing
  persists until Save — which is what lets an imported AI draft, or a
  routine seeded from history, be reviewed and trimmed before it sticks.
- `js/history.js` — month heatmap (per-machine filter), progress chart
  (`js/chart.js`), workout list with repeat, and full editing: per-set
  values, `+ Set` (copies the previous one, minus its `at` — it was not
  logged live), `+ Machine` (snapshots num/label/type flags like the log
  screen), remove set or whole machine, date + time (finishedAt moves
  with the start, keeping the duration) and name chips. `Log a past
  workout` reads the same note grammar via `workoutFromText()` — a past
  workout IS a plan that already happened, so `3x10 80` becomes three
  real sets — and reopens the result in edit mode (`openEditId`). It
  shows even on the empty screen: coming over from paper starts there.
  Shared display helpers live in ui.js: `pad2`/`dateValue`/`timeValue`
  build LOCAL-time input values (toISOString is UTC and shifts a
  past-midnight workout onto the previous day — ai.js dates its export
  via `dateValue` for the same reason) and `machineChain` is the deduping
  "#1 → #3" chain used by the start screen and the workout list alike.
  Workout-name chips at the top
  filter EVERYTHING: `workouts` is narrowed once, right after `getWorkouts()`,
  so heatmap, chart, machine lists and the list all follow. The filter is
  module state (`nameFilter`) because a save or delete re-renders the whole
  view, and it self-clears when its last workout is renamed or deleted.
  The Muscles card (store's `usageByMuscle`/`workoutsWithMuscle`) shows
  sets per muscle group as tappable bar rows that set a second filter
  (`muscleFilter`, ANDed after the name filter, same lifecycle incl.
  self-clear and the past-log reset). Muscles resolve against the LIVE gym
  — entries don't snapshot them — and a set on a two-muscle machine counts
  fully for both (usage is attribution; only naming votes split 1/n). The
  filter narrows WHOLE workouts, never entries, so the editor's Save can't
  drop non-matching machines; the card itself is computed over the
  name-only list so every muscle stays reachable while one is selected.
- `js/demo.js` — "Load test data" (Settings card): fills a separate "Demo"
  gym with a 16-machine gym (the example template plus cardio,
  bodyweight and a multi-exercise machine), ~8 weeks of Push/Pull/Legs
  history and three weekday plans built so `due`, `missed` and `done` all
  show at once, relative to the injected `now`. Fully deterministic —
  fixed `demo-*` ids, seeded PRNG, no `uid()`/`Date.now()` inside
  `buildDemoData` — so a reload REPLACES the Demo gym instead of
  duplicating it. The gym is found by its `demo` flag, NEVER by name
  (names are user-editable — matching one would let a reload overwrite a
  real gym called "Demo"), and stays deletable even as the last gym
  (Settings promises removal; the registry self-heals). Data is authored
  in kg/metres and converted in one pass through store's
  `convertWeight`/`convertDistance` when the display unit is lbs (plan
  targets included). Day maths goes through store's `startOfDay` +
  `setDate()`, never fixed 86400000-ms steps (DST). Generated sets never
  carry `at` (they were not logged live).
- `js/ai.js` — copy prompt+data / paste-import. Deliberately NO AI API.
  Export set tuples gain a third element (seconds offset from the
  workout's startedAt) when the set has `at`; old sets stay 2-tuples.
  Saved plans ride along in the export (same wire shape the prompt
  teaches for answers, plus their `id`) — measured at ~5% of a demo-sized
  export, omitted entirely when no plans exist. Pasting a `workout-plan`
  JSON saves the plan and opens the builder for review (mid-workout it
  just saves); an answer that KEEPS an exported id is a revision and
  replaces its original in place — but only behind a two-tap confirm
  naming the plan (`planFromImport` only reports `replacesId`, it never
  reuses an id itself; the Settings file-import path always creates new).
  The default prompt tells the LLM the exact plan shape to answer with.
- `sw.js` + `manifest.webmanifest` — PWA. Network-first with cache
  fallback (online always fresh, no cache bump per deploy). IMPORTANT:
  new static files (js modules, css, icons) must be added to the SHELL
  list in `sw.js` — EXCEPT template files: they are on-demand content the
  fetch handler caches on first load, only `templates/index.json` is
  precached (so a community template PR never touches sw.js). `settings.keepAwake` names the
  screen wake lock's SCOPE: `break` (default), `workout` (held while an
  active workout exists — battery cost, never the default) or `off`; a
  stored pre-scope boolean migrates in `getSettings()`. The lock lives in
  a module-level manager in train.js (two independent reasons —
  break/workout — reconciled via `syncWakeLock()`, so a re-render
  mid-break cannot drop it), is re-acquired on visibilitychange and
  released when nothing wants it; denial is silently ignored. There is no
  web API for device BRIGHTNESS, so dimming can only ever mean our own
  pixels: `settings.timerDim` (`10s` default, `now`, `off`) darkens the
  rest overlay via `.dim`, and the countdown ticks — each passing second
  adds `.lit` for ~130 ms, which signals a live timer at a fraction of
  the lit area. A touch buys 4 s of full brightness, the last 5 s never
  dim, and the same chips sit in the overlay itself. ±15s goes through
  `adjust()`: giving a FINISHED timer more time revives it (cancels the
  pending close, clears `done`, so the new zero sounds again) — the overlay
  lingers ~900 ms after the tone, and a tap in that window used to extend a
  countdown that was already scheduled to close. Both the close and the
  jerk-removal timers are held and cleared, never left to stack.

## Conventions (user-set, follow them)

- Everything in code English, incl. UI strings. German only in chat.
- Destructive/final actions: hidden + two-tap guard (never `confirm()` —
  it blocks browser automation). Frequent actions visually dominant.
- Enumerable input = tappable chips, never free text (typo avoidance).
- Keep the control you just used under the thumb. These views re-render by
  replacing whole subtrees, so any action that grows a list ABOVE its own
  control pushes that control off-screen (log a set, add a plan line, add a
  settings field / exercise, `+ Set`, `+ Machine`). Such a handler calls
  `keepInView(root, selector)` from ui.js after the re-render — instantly,
  never smooth, and with `focus: true` only for text fields likely to be
  filled again (never number inputs: the keyboard would pop and
  `initNumericOverwrite` would hand over an empty field). Navigation is the
  opposite case: the Train tab renders its screens (hub, start, plans,
  builder, bind, log, overview, onboarding) into one container, so
  `screenKey()` detects a screen CHANGE and resets the scroll to the top —
  an unchanged key means an in-place update whose scroll belongs to the user.
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

CI runs the logic tests plus a `sw.js` SHELL cross-check and deploys Pages
from main; every asset reference must stay RELATIVE (project subpath).
Community template PRs are adopted locally like Dependabot ones, never merged
in the UI. The mechanics — workflow names, the Pages "Multiple artifacts"
trap, the template manifest and its gate — live in
[docs/publishing.md](docs/publishing.md); read it when the work IS about CI,
a release or a template PR.
