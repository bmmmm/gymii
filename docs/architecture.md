# Architecture — modules, invariants and why

Split out of AGENTS.md so the always-read file stays a map (its budget is
~1500 words) while this detail loads when the work touches it — read a module's section BEFORE changing that module.
Moved verbatim. Tracked on purpose: `.claude/` is gitignored here, so a doc
there would be invisible to a fresh clone, to CI and to cloud agents.

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
  a crash mid-migration replays instead of orphaning a layout.
  Untrusted input (§ untrusted input in the file): a backup, a gym
  template, an AI-pasted plan and a sync blob may come from someone else,
  and the views put stored ids, numbers, colors and the unit into
  innerHTML. So every entry point holds those fields to their shape —
  ids `^[\w-]+$` (every id ever minted passes), numbers finite, colors
  hex, unit `kg`/`lbs`. Files refuse what they cannot repair (a layout or
  a workout with a bad id: "Invalid gym template" / "Invalid backup"),
  repair numbers (`"40"` → 40, markup → dropped; a plan item's `num`
  survives `planItemsFrom` only as a whole number from 1 up), hold a
  workout to a finite `startedAt` (no record without one — the list sorts
  by it) and its text fields (`name`, `locker`, an entry's
  `label`/`exercise`/`grip`) to strings or nothing — a number there
  crashed History's `localeCompare` — drop bad plans as plans
  always were; sync drops bad records one by one (`cleanRemote` in
  sync.js) and gives a bad layout frame the local one — or a fresh
  layout's, never none: a gridless layout is not written, and the push
  back would empty the server's machines. The views escape the same
  fields anyway, for records stored before the checks (map.js draws
  geometry through `Number()`), and index.html's CSP keeps any inline
  handler that slips through from running. Pinned by test/untrusted.test.mjs and
  sync.test.mjs block 19. Stored
  weights are always in the current display
  unit — `setUnit()` converts ALL gyms' data in one shot. The unit is
  global and the data per gym, so a backup NEVER sets it: importData keeps
  the device's unit and converts the file's workouts, plan targets and
  weight step from the file's unit into it. `convertRecords()` is the ONE
  field-walk — setUnit, that import and sync's wire normalization share
  it, so a new unit-bearing field is added there once. Set shapes:
  strength `{reps, weight}`, cardio `{distance, seconds}` (distance in the
  display unit, m/mi via `distUnit()`; seconds unit-less), bodyweight
  reuses `{reps, weight}` with weight = ADDED weight, assisted with weight =
  the ASSIST of a counterweight machine (less is stronger; it counts as no
  volume anywhere — ui.js `workoutTotals`, stats.js `weeklyBuckets`, the
  heatmap; `setUnit` converts it like any weight). Live-logged sets also
  carry `at` (epoch ms, stamped at log time) — older sets lack it, and so
  must sets added by editing or back-logging; every consumer must guard.
  Strength, bodyweight and assisted sets may also carry `rir` (0..3, 3 = "3 or more";
  absent = not rated, never `null`), written only by `rateLastSet()`.
  Workouts may carry `visits: [{machineId, in, out, busy?}]` — the walking
  route: `in` is the moment that machine's log screen became current, `out`
  when it stopped being current, `busy` the plan's next machine that was
  skipped for this one. Visits are per MACHINE (a new exercise on the same
  machine moves none), absent rather than empty, and NEVER carry an `id`:
  sync's `canon()` sorts arrays whose items all have one before comparing,
  so a changed ORDER — the route itself — would look like no change.
  `switchMachine(active, machineId, exercise, {busy, now, grip, slot})` is THE one way
  to change the current machine (it closes the open visit and opens the
  next; `slot` = the plan index of the very block meant, kept as
  `active.chosenSlot` and dropped by any switch without one); `closeVisits(visits, now, entries)` runs in `finishWorkout()`, closes the
  open one at the finish and drops tap-throughs under 15 s unless they carry
  `busy` or a set stamped at that machine inside them (a burst-logger's
  stop stays in the route; the demo calls it without entries); `rateLastSet(active, rir)` rates the newest `at`-stamped non-cardio
  set (the same value again clears it) — picked by `newestStampedSet(active,
  keep)`, the ONE selection rule (newest `at`, a tie to the later set) that
  train.js's "Reps left?" rows use too; `shiftWorkout(w, delta)` moves every
  timestamp a workout holds — `startedAt`, `finishedAt`, each set's `at`,
  each visit's `in`/`out` — so the gaps between them survive a date edit
  (`updatedAt` is a sync stamp, not a moment, and stays).
  `saveWorkouts()` sorts by `startedAt`: chronological order is an
  INVARIANT (repeat-last reads the tail, `lastEntryFor` walks it
  backwards, history renders it reversed), and back-logging a workout or
  editing a date would silently break it. Workouts may carry an optional `name`
  (locker-style lifecycle: dropped when emptied; start screen groups
  routines by name when present). Machine type flags
  `cardio`/`bodyweight`/`assisted` are mutually exclusive and absent for
  strength (ui.js `entryKind` turns them into one kind, in that order); an
  assisted machine may carry `assistGoal` ('strength' = less assist,
  'endurance' = more reps at the same assist, `ASSIST_GOALS`), said on the
  log screen and written by `setAssistGoal(machineId, goal|null)` on the
  layout read in the tap — absent means "not said", and stats.js
  `assistGoal()` observes it instead. A file whose machine carries a
  non-boolean `assisted` or an unknown `assistGoal` is refused like a bad
  `grips`; SET GOALS: `setGoalFor(machine, exercise, settings)` is THE
  resolution of how many sets a visit holds — `machine.exerciseSets[exercise]`
  → `machine.targetSets` → `settings.defaultSets` (3; a `USER_SETTINGS`
  field, so it syncs) → 3, whole numbers from 1 up, and `null` for a cardio
  machine (a bout is one set, never a tally); `setTargetSets(machineId,
  exercise|null, n|null)` writes either field on the layout read in the
  tap (the `setAssistGoal` pattern), `null` deletes, an emptied
  `exerciseSets` is absent (locker-style; the gym editor prunes an
  exercise's entry when the exercise goes). A non-finite `targetSets` is
  refused like a bad `restSeconds`, an `exerciseSets` that is no plain
  object of finite numbers like a bad `grips`. A cardio set may carry
  `level` (its resistance step, a whole number from 1; absent = none,
  never 0 or null) — in `SET_NUMBERS`, so untrusted input repairs it, and
  unit-less, so `setUnit` leaves it alone; ui.js `setStr` trails it as
  "L5"; one flagged `bodyweight` AND `assisted` is healed to bodyweight
  (`healKind`) on sync (`cleanLayout`), template and backup import; an entry's non-true `assisted` is dropped;
  optional `machine.exercises: [string]` (deleted when emptied) splits a
  machine into per-exercise entries, `machine.secondaryMuscles: [string]`
  (the same lifecycle — absent when empty; older clients ignore it) holds
  the muscles a machine works LESS than its `muscles` (half a set in
  stats.js, "+ N secondary" on History's Muscles card, "½" on Train's
  "Muscles today" rows and log head, listed after the primary machines in the
  picker's muscle filter; the editors cycle a chip off → primary →
  secondary → off), and `machine.grips: [string]` (the
  same lifecycle; `COMMON_GRIPS` seeds the editor's chips) into per-grip
  ones — a rope and a V-bar carry different loads, so a grip is part of
  what was lifted. A SERIES is the triple (machineId, exercise, grip):
  `lastEntryFor(machineId, exercise, grip)` matches it strictly via stats.js's
  `sameSeries` (absent = null, so every entry from before grips is the
  gripless series and keeps its prefill) — with `{ anyGrip }` (passed by
  the log screen and the builder's target seed when the machine has NO
  grips left) a gripless lookup that finds nothing falls back to the
  newest entry of (machine, exercise) under any grip, so clearing a
  machine's grips does not reset its prefill to the default; `lastGripFor(machineId,
  exercise)` returns the grip last trained there, and `seriesKey()` is its
  one string form (a JSON triple — History's chip and heatmap keys).
  Readers write `m.grips ?? []`; `getLayout` heals nothing here.
  Other lazy migrations live in `getLayout()` (outline, meta).
  SYNC GROUNDWORK (docs/sync-protocol.md is the contract; js/merge.js the
  pure merge layer): every interactive write stamps `updatedAt`
  (`savePlan`, `updateWorkout`, `finishWorkout`, `workoutFromText`,
  `saveSettings` — only when a `USER_SETTINGS` field changed, a device-local
  key keeps the stamp it had — `createGym`/`renameGym`); absence means epoch 0
  and is MEANINGFUL (legacy loses any merge), so there is deliberately no
  heal-on-read for it. Deletes leave tombstones — sidecar
  `gymii.<gid>.tombstones` (`{v, workouts, plans, machines, shapes}` via
  `get/saveTombstones`) and `gyms.deleted` — never in-object flags, so
  read functions keep their contracts. `saveLayout()` is diff-aware (stamps
  changed machines/shapes, tombstones vanished ids, one structural stamp
  for name/grid/meta/outline — the editor's mutate-then-save needs no change);
  bulk restore goes through `restoreLayout()` verbatim (a backup, sync
  apply — re-diffing would forge stamps). A GYM TEMPLATE is not a restore
  but an edit that replaces the layout: importData hands a copy to
  `saveLayout()`, so the machines it drops are tombstoned, what it brings
  is stamped fresh and sync hears of it — restored verbatim, the next merge
  resurrected the old machines and the remote's older structure won.
  Because of that diff, A RENDER
  CLOSURE IS A DELETE COMMAND after an ambient pull: a screen's
  render-time layout lacks whatever synced in since (`restoreLayout`
  re-renders nothing), and saving it tombstones those machines on every
  device after the next merge. A tap that changes the layout reads it IN
  THE TAP — `ensureMachine(num, name, target)` (bind-or-create + save),
  `addMachineVariant(id, { exercises, grips })`, or `getLayout()` right there;
  the gym editor's `save()` and its undo/redo both read the stored layout IN
  THE TAP (`foreignOnly`/`applySide`, js/layoutdiff.js). `uid()` is crypto-random, 16
  chars; legacy 8-char ids stay valid, and ids deliberately carry no
  device marker (they travel into AI exports). Backups are `v: 2`
  (tombstones included, deletes stay dead across restore); v1 files import
  unchanged. A backup's tombstones MERGE with the local ones (max `at` per
  id) while every other part overwrites: a local tombstone may not be
  pushed yet, and replacing the sidecar brought an offline-deleted workout
  back on the next sync. The future sync key (`gymii.<gid>.synckey`) must NEVER enter
  a backup.
  `suggestWorkoutNames(machineIds, layout)` proposes names from what was
  trained (each machine contributes ONE unit split across its muscles, so
  a three-muscle machine can't outvote two others; a Push/Pull/Leg split
  needs a ≥70% share, else it falls back to region names) and
  `recentWorkoutNames()` returns the names already in use — together they
  fill the name chips on the overview and in the builder. A name is
  proposed, never asked for. Pick lists:
  `MUSCLE_REGIONS` (`{label, muscles}` per body region — the ONE source:
  `MUSCLE_GROUPS` is it flattened, and the name suggester's region table is
  derived from it, so a muscle can never sit in two regions),
  `COMMON_SETTINGS`, `ZONE_LABELS` (its 'Cardio' string
  is a room label — unrelated to the `machine.cardio` flag),
  `MACHINE_BRANDS`, `MAP_LAYERS` (map stacking as three named layers —
  `{z, label}`, stored as `shape.z`, absent = 0 = Normal). THE BRAND LIVES
  ON THE GYM: `layout.meta.brand` (optional); a machine's own `brand` is
  the exception for the odd rower or rack, and absent on the machine means
  "the gym's". `machineBrand(layout, machine)` resolves it (train's log
  header); `ownBrand(layout, machine)` is the machine's brand or '' when it
  follows the gym — INCLUDING a machine that carries the gym's brand by
  name (an imported template lists it per machine; the editors and the AI
  export treat that copy exactly like "none"). `setGymBrand(layout, brand)`
  sets or clears the gym's and TOUCHES NO MACHINE — folding the copies
  would sync as two separate parts (meta is one LWW blob, machines merge
  per id; a lost race would strip every folded machine of its brand) and a
  mis-tapped chip would erase overrides. `matchBrand(text, extra)` maps
  typed text onto the spelling already in use (pick list + the gym's
  brands), case-insensitively, so free text never produces a second chip
  that toggles the first. `model` stays per machine (absent when empty).
  `layout.meta` is thus `{address, postcode, city, country, brand?}` — meta
  lives INSIDE the layout, so template/backup/sync carry it for free (and
  merge.js needs no new structural field). Stored plans
  live under `gymii.<gid>.plans`: `{id, name, createdAt, days?, skippedOn?,
  items:[{machineId?, name?, num?, exercise|null, grip?, target?}]}` with target
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
  nothing — callers keep their own saveLayout timing; used by
  `workoutFromText` and, through `ensureMachine`, train's renderBind, the
  picker's create-on-miss and the builder's bind), `bindItemTo(items, i,
  machine, name)` (binds a slot or plan item; a SECOND line on one machine
  becomes a second exercise there — its own exercise part, else its name,
  and the machine's whole-machine siblings take its label, unless the
  machine was already trained whole (`machineTrainedWhole`): relabelling
  would cut those sets off their slot and their prefill, so there the line
  stays a whole-machine twin (the twins share the sets, § js/train.js) — or the two
  would be one slot twice: Next pointing at itself, "✓ 3/3" on both rows,
  the second target gone on restart; unbound items keep their exercise
  part for this; an unbound slot carries `itemIdx` so the write-back hits
  ITS OWN plan item when two lines share a name), `nextNum(layout)` (one
  past the highest — quick start used length + 1 and hit a synced
  number; the gym editor refuses a taken number outright), `newEntry(machine,
  exercise, sets)` (THE entry snapshot shape incl. type flags; callers add
  settings prefills themselves) and `nameChipsFor(machineIds, layout,
  limit = 5)` (suggested + recent names, deduped — train/history pass one
  id per logged set for weighting, the builder passes item machineIds).
  `setUnit()` also converts a RUNNING workout's plan-slot targets
  (`active.plan[i].target` — startWorkoutFrom copies targets onto slots),
  not just stored plans; leaving them out silently turned an 80 kg goal
  into an 80 lbs one mid-workout.
  The plan text lives in `js/plantext.js` (split off store.js; it writes
  only through store's helpers):
  `parsePlanLine()`/`parsePlanText()` read a trainer's note ("Leg press
  3x10 80", "#7 Chest press 3x8-12 40kg", "Treadmill 20min"): set and
  weight terms are cut FIRST so a leftover leading number is unambiguous,
  and only a MARKED num (`#7`, `7.`, `7)`) counts — "45 degree leg press"
  keeps its 45. Rep ranges target the low end; foreign units convert.
  A cardio line may carry its level — `L5`, `level 5`, `lvl 5`,
  case-insensitive, a whole number — before or after the duration/distance:
  in the cardio branch it is cut out FIRST, so neither term reads it and it
  never joins the name; it lands as `target.level`, `L0` names none, and a
  level alone makes no cardio line (the token stays in the name, visible,
  as on a strength line). `normalizeTarget` keeps a cardio level whole from
  1 up — a pasted `workout-plan` cardio item may carry `"level"` — and
  `planToText()` writes ` L5` after the distance/time, never alone (it
  would read back as a name).
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
  `#9 Cable tower: Triceps pushdown [Rope] 3x12 25` names the GRIP: the
  LAST `[…]` is cut out before anything else (empty brackets name none), so
  a name that carries brackets of its own — from an AI file, a template or
  a sync — keeps them (`Curl [EZ] [Rope]` = exercise `Curl [EZ]`, grip
  `Rope`). `planToText()` writes empty brackets after a bracketed name that
  has no grip, so an unbound `Curl [EZ]` survives List → Text → List (the
  LAST `[…]` is the grip, and `[]` names none). A bound item whose machine knows no such grip but does know
  `exercise [grip]` as an exercise gets that exercise back and no grip
  (`Curl [EZ] 3x10`).
  Every other separator was rejected — `/` sits in real names ("Lat
  pulldown / row"), `()` and "with" collide with the trailing weight, `·`
  is not on a phone keyboard — which is why the gym editor strips `[` and
  `]` from a typed grip. A bound item keeps a grip only if its machine
  offers it; an unbound one keeps it (and its exercise part), and binding
  teaches both to the machine (`bindItemTo` → `addMachineVariant`).
  Everywhere on screen a variant reads `Exercise · Grip` (ui.js
  `variantStr`, raw — the caller escapes).
  Grips need no sync protocol bump: `cleanLayout`/`cleanWorkout`/`cleanPlan`
  spread unknown fields and merge.js works on whole records, so an older
  client stores and passes them on untouched — it only shows a machine's
  grip series mixed (its prefill and charts ignore the grip), and its
  plan Text view would drop a `[grip]` it cannot parse. A non-string grip
  is repaired away on entry (entry and plan item), a machine whose
  `grips` is not a string array is refused like a bad `exercises`.
  WRITE FAILURES: every write goes through the one `write()` (a refused
  `setItem` — quota gone, private mode — is a synchronous `DOMException`).
  It ANNOUNCES over `onWriteError(fn)` and RETHROWS; do not "fix" that by
  swallowing it. A swallowed failure would let `touched()` hand the sync
  layer a state that is nowhere on disk, and let callers tidy up after
  data they never saved. Only the transition is announced, so a run of
  failing writes raises one banner and the next good write reports `null`;
  `getWriteError()` reads the current state. No retry, no queue, no second
  store — `js/app.js` shows `#storage-alert` and the user acts.
  ORDER INVARIANT in `finishWorkout()`: `saveWorkouts()` FIRST, then
  `clearActive()`. `removeItem` cannot fail, `setItem` can — the other
  order deletes a finished workout that never reached history. Same rule
  as the gym migrations (parts before the registry). Two writers stay
  knowingly outside it: `deleteWorkout` (tombstone before list — a half
  failure resolves to "deleted" on the next merge, which is what was
  wanted) and `setUnit` (writes across all gyms and can stop midway; the
  banner makes it visible, a transaction would be a framework).
  `storedBytes()` is the honest occupancy figure: every gymii key across
  EVERY gym plus the global ones (`gymii.sync.pendingDeletes` included —
  and `clearAll()` takes that queue too), `key.length + value.length` in
  UTF-16 units. It exists
  because `navigator.storage.estimate()` cannot answer it — that API
  covers IndexedDB and the Cache API and leaves Web Storage out of its
  numbers entirely, so it is shown as context beside this count, never
  instead of it.
- `js/geometry.js`, `js/weekday.js`, `js/plantext.js` — split off store.js
  (2026-10-22) so the data layer holds storage and its invariants, not
  every rule that happens to read a plan. geometry.js (placement:
  `WALL_SNAPPED`, `isSolid`, `overlapsSolid`, `SNAP`, `freeSpot`) and
  weekday.js (`startOfDay`, `dayKey`, `planDueDay`, `planNextDay`,
  `planDayState`, `todayStatus`, `usualWeekday`) are pure and import
  nothing; their one writer stays in store.js (`addMachine`,
  `skipPlanDay`). plantext.js reads and prints plan text and persists only
  through store's helpers; store.js imports `planFromImport` back for
  `importData` — an ES-module cycle that is safe because neither module
  calls the other while it loads. Keep it that way: no top-level call
  across the two.
- `js/persist.js` — origin DURABILITY, deliberately not part of store.js
  (that file is the localStorage layer; this one asks the browser to keep
  it, and stubs `navigator.storage` rather than `localStorage`). It
  imports nothing. Running out of room is not the risk — a workout costs
  ~890 bytes against a ~5 MB budget — being CLEARED is: WebKit's ITP wipes
  script-writable storage after seven days without interaction, on every
  site, and Home Screen web apps are the documented exemption. So
  `ensurePersisted()` is called from `finish()` in train.js, once a
  workout has actually been saved: the first moment something exists that
  cannot be reconstructed, and a user gesture, which Firefox's permission
  prompt requires — never on load, or Firefox prompts unasked. At most one
  `persist()` per page load, guarded on the StorageManager's IDENTITY, so
  a test stub is a fresh load for free. Everything returns `null` rather
  than throwing.
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
  from re-pushing and bumping the revision forever. It comes down ONLY if
  no edit landed after the pushed state was taken: the same subscription
  bumps a per-gym edit generation (module state, per tab), runSync reports
  the generation its payload was reconciled at, and syncNow compares —
  an edit made during the PUT's await kept the flag lowered over it
  before, and the follow-up run's 304 then never pushed it. ANOTHER TAB's
  edit moves the counter too, through the window `storage` event (fired
  in every other tab on a localStorage write — no extra write per edit):
  a `layout`/`workouts`/`plans`/`tombstones` key bumps its own gym,
  `gymii.settings`/`gymii.gyms` the active one, like the notifier; the
  bookkeeping keys (`sync`, `synckey`, the pending-deletes queue) and
  `active` (its writer does not notify) never count, or syncNow's own
  records would read as edits (test-pinned, sync block 22). The 304 check
  reads the flag fresh, not from the config the run started with.
  syncNow's bookkeeping writes (`rev`, `lastError`, …) never throw: a
  refused one is the store's banner, the caller still gets `{status}`.
  reconcile brackets
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
  `last-token`). `self` in `listDevices` is server-computed, and its
  `lastSeenAt`/`kind` pass through untouched. A minted pairing code carries
  `invite: true`; `getSyncCode` (this device's OWN token) never does — a
  redeemer like gymii-cli revokes an invite token once its own works, so a
  flag on an own code would cut a live device off (test-pinned). So a code
  can be dead when it arrives: `pairWithCode` keeps nothing when its first
  sync answers `auth` — config and key go back to what they were and it
  throws `code-used`, never a "paired" gym on a dead token. The Sync
  card's backup hint (settings.js `backupHint`) reads that list at most
  once per 10 min per gym, cached in module state so re-renders neither
  refetch nor drop it; only `kind:"backup"` ever triggers it. Both writers
  (the background refresh and the Devices list) write only into the cache
  slot that was current when their request went out — sync off empties it,
  so a late answer never comes back under a new setup — and paint only
  while their gym is still active. The QR on the
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
  Settings and the Train hub's Gym tile. Don't re-add the tab. A route is
  an OWN key of `routes` (`Object.hasOwn` — `#toString` found the
  prototype's and rendered blank), anything else is Train; a malformed
  `#pair=%E0` is caught (URIError) and scrubbed to `#settings` like a good
  one, instead of throwing before the first render. The
  tabbar shows an emoji icon over each label with a Material-style pill
  behind the active tab's icon — pure CSS off the existing `.active`
  toggle, no router logic involved. Before the first render it calls ui.js's
  `applyTheme(getSettings())`: `settings.theme === 'black'` (Settings →
  Display, "True black") stamps `html[data-theme="black"]`, whose CSS block
  only redefines `--bg`/`--surface`/`--surface-2`/`--border` (plus a black
  rest overlay) and paints `meta[name=theme-color]`; anything else is the
  default dark theme. Device-local — not in merge.js's `USER_SETTINGS`, so
  it neither syncs nor moves the settings stamp. Chart and map colors were
  re-validated against #0a0a0a and #000 (same single deutan WARN as on
  #171c22, covered by numbers and labels). The FIRST paint is covered by
  `js/theme-boot.js`, a classic (non-module) script loaded synchronously in
  `<head>` before the stylesheet: for `settings.theme === "black"` it stamps
  `html[data-theme="black"]` and paints `meta[name=theme-color]` `#000000`
  before the deferred app.js runs; any other value, corrupt JSON or blocked
  storage does nothing (never throws). It repeats ONE decision of
  `applyTheme`, which stays the owner; `test/sw.test.mjs` pins that both
  agree, so a new theme value must change both.
- `js/ui.js` — shared helpers; owns the keyboard. `initFocusCentering()`
  (wired once in app.js) centres every focused field in the VISIBLE band
  once `visualViewport` settles — a field-to-field hop fires no resize, so
  focusin settles 300 ms later, skipping a field `preserveFocus` merely
  handed back — with its context when that fits (`[data-focus-context]`,
  else the nearest `.card`; the log form carries the attribute so steppers
  AND the log button land together), and pads #view by `--kb` while the
  keyboard is up: #view is the only scroller, without that room iOS pans
  the window ("the page jumps"). `keepInView` switches to the same centring
  while the keyboard is up. The Train tab renders hub, start, plans,
  builder, bind, log, overview and onboarding into one container, so
  `screenKey()` detects a screen CHANGE and resets the scroll to the top;
  an unchanged key is an in-place update whose scroll belongs to the user.
  `hintHtml()` renders one stats.js hint (see § js/stats.js).
  `machineIcon(machine)` is the one glyph a machine is recognised by in
  every list — PRESENTATION, nothing stored, so it lives here and not in
  store.js (it imports `MUSCLE_REGIONS` from there; ui.js imported store.js
  already). Data-driven: a cardio machine by its label (`CARDIO_ICONS`,
  first pattern that matches wins — treadmill/run 🏃, bike/cycle/spin/
  ergometer 🚴, row 🚣, stair/step/climb 🪜, ski ⛷️, swim 🏊,
  elliptical/cross 🏃, none ❤️), a strength machine by the REGION of its
  FIRST primary muscle (`REGION_ICONS`: Chest 🫁, Back 🧗, Shoulders 🤷,
  Arms 💪, Core 🧘, Legs 🦵, Full body 🏋️ — the machine's own
  `muscles[0]`, never the pick list's order), with no muscle in the pick
  list bodyweight 🤸, else 🏋️. DECORATIVE: every surface renders it as
  `<span class="machine-icon" aria-hidden="true">` and keeps the number and
  the label as the information, so neither the 44px rule nor a text
  alternative applies. In a badge row it follows the badge (the overview's
  `.plan-row`, the builder's `.plan-item-head`, the list editor's row after
  the number field) and in History's entry lines the number ("#14 🦵 Leg
  press", read from the LIVE machine while it exists, else from the entry's
  own type flags — entries snapshot no muscles); on the log screen's
  `.machine-head` it opens the title LINE rather than standing as a fourth
  flex item (the head has ~70px of slack at 320px, and a word that no
  longer fits would scroll the route sideways); on the two sentence-like
  controls — the Next button and the ↩ quick-switch chips — it TRAILS the
  label, because "Next: #3 Leg press" is pinned as one text by a dozen
  tests and B's "Try next:" reads the same way. The Gym card's `<h2>`
  carries it too, so a chip tap shows the region change live.
- `js/map.js` — the shared floor-map renderer, split out of the editor so
  train.js/plan.js never import from gym.js. `drawLayout()` draws every
  map surface (editor, train mini-maps, builder); its `highlightId` opt
  marks one machine `.locate` (white stroke, CSS pulse) and dims the rest
  — visual machine state belongs here, never as post-render DOM pokes in
  train.js. STACKING ORDER of the floor shapes comes from each shape's own
  `z` (store's `MAP_LAYERS`), sorted stably so a shared layer keeps creation
  order — never from the array order, because merge.js's `mergeById` returns
  its items in unspecified order and a stack kept that way would not survive
  the first sync (pinned in test/merge.test.mjs). Machines are deliberately
  outside it: `fits()` keeps them from ever overlapping, and their number
  must stay readable above every zone. Wall-snapped fixtures keep their own
  layer on the wall. Layering also decides HIT-TESTING, which is the other
  half of the feature — `hitPadSvg` only pads items under 44px, so a small
  zone under a big one was unreachable until the big one moved back.
  Its `unlockedId` opt is the EDIT LOCK: a selected item draws its
  outline (dashed, `.selected-outline`) and nothing else; only the unlocked
  one gets the solid outline (`.unlocked`) and the corner handle, and the
  floor outline only hands out its vertex/midpoint handles while it is the
  unlocked one. On a phone a tap that drifts used to shove a whole zone
  across the floor, and the resize handle sat exactly where the thumb grabs
  an item — both now need a deliberate double tap first, and a second one
  takes it back (gym.js owns the gesture). Also exports `findMachineByNum`, the collision helpers
  (`fits`, plus `overlapsSolid`/`freeSpot`/`WALL_SNAPPED` re-exported from
  geometry.js, which owns the placement geometry because store.js's
  `addMachine` places machines too; `snap()` rounds to geometry.js's `SNAP`, the
  same constant `freeSpot` steps by, so a placed item lands where a drag
  would), `snapDoorToWall`, `FIXTURES`, `ITEM_COLORS`. Its `path` and `pathWeights` opts draw the
  walking-path overlay (view-only: the editor ignores them) — one line plus
  arrowhead polygon per leg from stats.js's `workoutPath`, or, with
  `pathWeights` (a `transitionCounts` map), one leg per transition whose
  width follows its count. Legs are clipped at the machine boxes and
  shifted to the right of travel so A→B and B→A run side by side. The
  colour `#c08327` and every presentation attribute are inline, so the
  overlay renders without the stylesheet; there is deliberately NO
  `<marker>` (`url(#id)` collides when two maps share a page) — the
  arrowhead is a plain polygon. In path mode machines drop custom colours,
  as in usage mode, and those off the path dim. The machine's icon (ui.js
  `machineIcon`, a constant glyph) sits as a small `<text>` in the box's
  top-left corner in EVERY mode — editor, colors, usage, path, highlight —
  at 0.55 × the number's font size, `pointer-events="none"`, and only where
  the box is at least 3 units on BOTH sides (a 2×2 box has no room beside
  its number). Its class is `.machine-glyph`, deliberately not the span's
  `.machine-icon`: that CSS rule's 18px font-size would size an SVG text in
  user units. It imports `esc` and `machineIcon` from ui.js and the
  placement geometry from geometry.js (which imports nothing) — keep it
  free of gym/train/plan imports so the cycle cannot reappear. Every id
  interpolated into an attribute goes through `esc()`, and so do colors
  and machine numbers; geometry is drawn from a `Number()` copy
  (`numericGeometry`): ids arrive from community template FILES off the
  network, and a layout stored before `isValidLayout()` checked them
  (store.js § untrusted input) may still hold one that ends the attribute.
  `snapDoorToWall` rounds its result to one decimal — an unrounded float
  would be a new value on every save, and `saveLayout` stamps what changed,
  so sync would see edits nobody made.
  train.js additionally imports ONE thing straight from gym.js — the
  `focusMachine` edit handoff — which is fine exactly as long as
  gym.js never imports from train.js/plan.js (the direction the map
  split exists to prevent).
- `js/gym.js` — floor-plan editor (renderer imported from map.js).
  Polygon outline with vertex/midpoint editing; wall-snapped fixtures
  (entrance/door/window) glue to the nearest wall segment with rotation +
  flips. EVERYTHING ON THE MAP STARTS LOCKED — machines, zones, walls,
  fixtures AND the floor outline. A single tap only selects an item and opens
  its card; `unlockedId` (TOGGLED by a double tap within `DOUBLE_TAP_MS` on
  the item BODY — the same gesture locks it again, so getting back to a safe
  map never means hunting for empty floor to tap; also cleared by `select()`
  on any selection change, and never persisted: re-entering the Gym is always
  a read-only starting point) drives map.js's handles AND the pointerdown
  guard, which starts no drag at all — neither move nor resize — on a locked
  item. A freshly added item is unlocked (`addItem`): you just made it on
  purpose. The props card's last line names the current state.
  A DRAG IS NOT A TAP: `lastTap` carries the down point and pointermove drops
  it once the contact travels past `TAP_SLOP`, or two quick drags on the same
  item would pair into a double tap and lock it again mid-arrangement.
  The Layer chips (`layerRow`/`wireLayerRow`, shared by the zone and
  wall/furniture cards) write `item.z` — deleted when Normal, so exports stay
  clean. Machines and wall-snapped fixtures deliberately have no layer row.
  The machine's text fields (the card's label, model and doc link; the
  list's label and model) stage every keystroke in `staged`
  (`${id}:${field}` → text), NOT in the machine, and commit on `change`
  through one table, `MACHINE_TEXT` (trimmed; an empty label falls back to
  "Machine N"; the model is absent when empty). A re-render prints the
  staged text back as typed, because a chip tap re-renders the card and iOS
  does not blur the field on it. `save()` commits every staged field first,
  so whichever control saves, a field is persisted exactly as its own
  `change` would write it, never `''` or untrimmed; the later `change` then
  changes nothing and records no undo step. Undo/redo drop staged text. A
  field abandoned without a blur keeps its raw text until its next `change`
  or an undo.
  BRAND: the Layout view's Machines card owns the `MACHINE_BRANDS` chips +
  free text (`#gym-brands`, writes through store's `setGymBrand`; typed
  text goes through `matchBrand`; a hint line counts the brands machines
  carry as their OWN — `ownBrand`, so a copy of the gym's is not listed).
  The Layout view re-renders itself now (brand chips, list edits), so the
  Templates card's browser comes back when it was open (`tplOpen`) — from
  the manifest fetched once per open (`tplManifest`; "Load template…"
  fetches afresh), and its panel is wired ONCE per node (`dataset.wired`,
  delegated click/change): a second click listener from a second fill
  armed AND confirmed a template in one tap. FLOOR SIZE: the width/height
  steppers (and the card's Number) are `numberStepper`s — a `<label for>`
  BESIDE the stepper, never a `<label>` around it, which handed a tap on
  the text to the "−" button; each ± carries an aria-label ("Decrease
  floor width"). The floor shrinks only down to what is on it
  (`itemsExtent`, min 20) — an item past the new edge was drawn off the
  floor where no tap reaches it — and `#floor-msg` says why in place.
  `redraw()` runs per pointermove, so it reads no storage: the map mode is
  closure state the Colors/Usage chips keep current, the Usage counts are
  computed once per editor render (`usageCache`). The
  machine card shows the resolved brand as ONE LINE (`.brand-line`) with a
  `.linkish` "Different brand?" inline; `brandOpen` (closure state, reset in
  `select()`) folds out a search field that filters the chips IN PLACE on
  `input` (no re-render — that would fight the keyboard) plus a Set button
  that stays `hidden` until the text matches no chip (case-insensitively —
  and the global `[hidden]{display:none !important}` rule in style.css
  exists because `.btn`/`.chip` set `display` and an author rule beats the
  UA's `[hidden]`, so the button and the filtered chips stayed visible).
  Typed text lands on an existing spelling (`matchBrand`); picking or typing
  the gym's own brand deletes the machine's field — absent, never a copy;
  a machine that already carries the gym's brand by name reads as the gym's
  (`ownBrand`). MUSCLES: one chip row
  per `MUSCLE_REGIONS` entry (`.chip-group`), muscles outside the pick list
  (an imported template's vocabulary) get an "Other" row so they stay
  toggleable. SET GOAL: the card's "Sets per visit" number field `#m-sets`
  (type number, a plain field and not a stepper — a ± could not say
  "inherit") is store's `machine.targetSets`: its placeholder "(3)" is the
  app default it inherits while empty, a whole number from 1 up pins it,
  empty (or anything else) deletes the key; committed on `change` through
  the local `save()` like `#m-num`, hidden for a cardio machine (no goal
  there). Typing can NOT empty it (an armed field restores its number on a
  blur without input), so a pinned goal shows "Set for this machine. Use
  the default (3)" (`#m-sets-pinned`, a `.linkish` `#m-sets-default`) —
  the way back to inheriting; field and line update in place, never
  through a card re-render (a `change` fires inside the next tap). Per-exercise goals (`exerciseSets`, written on the log screen's
  "Keep N sets for #7 · Curl") are only READ here, as one muted line "Per
  exercise: Curl 4 · Row 2"; removing an exercise chip prunes its entry
  and deletes the map when empty (locker-style, like the list itself).
  The list editor gets nothing of this. THE LIST EDITOR (`machineListHtml`/`wireMachineList`, behind
  the Machines card's "Edit all machines" button, `listOpen` survives map
  round-trips within one renderGym): every machine as one row — number and
  label inputs, Type and Brand `<select>`s (the empty brand option IS the
  gym's brand; the options are every brand in use anywhere in the gym plus
  the pick list; "Other…" reveals the row's own text field without a
  re-render, so the select keeps showing it, and the text typed there is
  staged in `otherText` (id → text) so a re-render from another row renders
  it back into ITS row, still open), a `model` field (staged like the
  card's fields, `MACHINE_TEXT`),
  its muscles as chips in ONE fixed order (the pick list's, `rowMuscles`)
  that a tap cycles primary → secondary ("½ ✕") → removed, named by the
  muscle alone (`aria-label`; `aria-pressed` says the state once — true =
  primary, mixed = secondary), so the chip stays under the thumb for its
  second tap,
  plus an add-`<select>` (adding a muscle as primary drops it from the
  secondary list) whose `<optgroup>`s are the regions (a region with
  nothing left to pick is no header). Four delegated listeners on
  `#machine-list` (input/change/click/keydown) instead of one per control,
  because a muscle change re-renders the whole list — followed by
  `keepInView` on that row's muscle select, which the grown chip row above
  would otherwise push down, and — only when the control HAD the focus (a
  keyboard or screen-reader user; a phone tap never focuses a chip, and a
  programmatic focus there could pop the picker or drop a typing keyboard)
  — by a FOCUS that would otherwise fall to `<body>`: after an add the
  select keeps it, after a tap the chip of the same muscle while it is
  still on the row, else the chip that moved into its place (else the
  select); the label is staged like the card's. Same flag/brand invariants as the card (flags deleted, never
  false), same `save()` — undo covers it. The
  Location card holds `meta.postcode` and an `#gym-osm` search link built by
  `osmUrl()` (exported for the tests) — the card is NOT re-rendered on a
  meta edit (that would fight the keyboard), so `bindMeta` refreshes the
  link's href and `hidden` by hand.
  Find-by-number row above the map: a hit selects the machine
  (props open) and pulses it via `highlightId`; the next pointerdown on
  the map clears the pulse. `focusMachine(id)` is the in-memory handoff
  for the log screen's ✏️ button (same pattern as train's
  `openPlanBuilder`): the next `renderGym()` consumes it — selects the
  machine and pulses it via the same find mechanism, silently dropping a
  stale id. While a workout is active the header shows a "← Back to your
  workout" link, whichever way the Gym was reached; without one it
  shows a plain "‹ Train" back row to the hub instead. Undo/redo =
  one entry per completed edit via the local `save()` wrapper — every
  mutation must go through `save()`, never `saveLayout()` directly. An
  entry is what the edit CHANGED (`layoutDiff`: each machine and shape by
  id, each of name/grid/meta/outline), never a snapshot. The engine —
  `layoutDiff`, `applySide`, `foreignOnly` — is `js/layoutdiff.js`, pure
  and import-free like merge.js, pinned directly by
  test/layoutdiff.test.mjs; gym.js owns only the history stack and when
  to call it. The editor's other pure helpers (`MACHINE_TEXT`, the
  colour/layer rows, the list editor's muscle/type helpers) sit at module
  scope above `renderGym`, which keeps only what closes over its state. `save()` first
  takes in what another writer stored since the editor's render (a sync
  pull, Train teaching a grip: `getLayout()` in the tap,
  `foreignOnly(layoutDiff(lastSaved, stored), changes)` applied with
  `applySide`), so the first edit after a pull no longer tombstones a
  machine the pull brought in; the edit's own keys win and its undo entry
  stays its own. When what it took in touches the open machine or a gym
  field, it re-renders the card too (a text field's `change` saves without
  re-rendering; renderProps never calls save(), so this cannot recurse) —
  but only once the gesture is over: a text field's `change` fires inside
  the NEXT tap's pointerdown (the focus moves there), and a card replaced
  right then detaches the control that tap is about to click or the field
  it is about to focus (tap lost, keyboard dropped). `requestCardRefresh`
  waits for the pointerup while a pointer is held on the card (a mouse),
  else for the end of the current event sequence via `setTimeout(0)`
  (touch raises pointerup BEFORE the synthesized mousedown that blurs the
  field); any explicit renderProps() in between satisfies it, so a chip
  tap that draws the card anyway causes no second render. The pointer is
  watched on `props` (it dies with the mount; `root` is the persistent
  #view, where a listener would outlive the editor and pile up per visit)
  and its release on `window` for the gesture only, so a mouse released
  outside the card still ends it. An
  edit to a machine another device deleted meanwhile brings it back — the
  edit wins (user decision 2026-10-13). Undo and redo read the stored
  layout IN THE TAP too and write only their parts, objects key by key (`applySide`): a machine
  another writer added since survives, a key it changed survives unless the
  edit changed that key, a machine it deleted stays deleted, and an undone
  delete comes back at its old index. A save that changes nothing writes
  nothing and records no step.
- `js/settings.js` — the Settings tab (units, gyms, backups, the Sync card
  — the sync half is docs/sync-plan.md). `renderSettings()` is wrapped
  whole in `preserveFocus` (every field in it is covered once). The Workout
  card's steppers write one settings key each on `change`: the rest timer
  (`#rest-seconds`, whole seconds from 0) and "Sets per exercise"
  (`#default-sets`, step 1, min 1 — `settings.defaultSets`, the last level
  of store's `setGoalFor`, so it syncs like `restSeconds`); a whole number
  from 1 up, unreadable text keeps the value it had, and the field is read
  through `fieldValue` like the weight step (an armed field left empty
  still means what it showed). The weight step is a decimal TEXT field
  (§ js/history.js, "12,5").
- `js/train.js` — guided workout; under the log screen's machine head sit
  the hints for THIS machine and exercise (progress) and this weekday
  (busy, via stats.js `inBusyWindow` — an hour either side of the window,
  reaching across midnight into the next weekday) — full width, not inside the head's flex row, where the 44px ↗
  would squeeze the text — the rest overlay the rest hint, a plan row "· reorder?" when its
  builder has a route hint (`planListCard`). `renderLog` reads the history
  ONCE per render and hands that list down — the prefill and grip default
  (store's `lastEntryIn`/`lastGripIn` — the walks behind `lastEntryFor`/
  `lastGripFor`, over a list already read), the hints,
  the assist goal, `finishedToday` and `suggestNext`; a test counts the
  storage reads. `active.plan` is a list of slots
  `{machineId, exercise|null, grip?, target?}` (null = whole machine; no
  grip = a WILDCARD that counts every grip, which is why old plans and
  slots need no migration) — a repeat plans one slot per (machine,
  exercise, grip) triple so "Next:" walks every exercise and grip, and a
  slot strictly broader than a sibling is dropped (it would count the same
  sets twice). The log screen's slot is the exact triple, else the
  gripless slot of that exercise, else the machine's first. The grip on
  screen is `active.currentGrip`: absent = unresolved (resolveEntry takes
  the first open slot here that names a grip, else `lastGripFor`, as long
  as the machine still offers it), null = deliberately none (the chosen
  chip tapped again), dies with the workout via `finishWorkout`'s
  allow-list. A grip the plan does not cover grows a slot after its
  siblings, like a fresh exercise; a grip switch is a new entry with its
  own prefill. "+ Grip" (every non-cardio log screen — a lone chip where
  the machine has no grips, else the Grip card's last chip) opens
  `COMMON_GRIPS` minus the machine's own plus an "Other grip…" field; a
  pick goes through `addMachineVariant` and becomes `currentGrip` in the
  same tap, so a grip never needs a detour through the gym editor; a typed
  name matching a known grip case-insensitively IS that grip. A cardio
  machine gets no "+ Grip", but grips it already has keep their card —
  resolveEntry still records them. The open picker is module state keyed
  by workout and machine id (`gripPicker`), dropped by any render
  elsewhere. Overview hub, per-machine
  `restSeconds` (changed mid-workout it lands on the WORKOUT, see the rest
  paragraph below), locker number, two-tap finish guard on TWO surfaces —
  the overview's Finish button and 🏁 in the machine header, because the
  last set is logged on the log screen and the overview is two taps away. The locker is asked
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
  only seeds the first set; a cardio set's `level` rides that same chain
  and stays ABSENT when its source has none (the stepper then shows 0).
  Quick-switch chips on
  the log screen jump to the two most recently trained OTHER machines (by
  newest set `at`). Slots started from a stored plan carry its target:
  the log header shows it, the first-set prefill uses it (real logged sets
  then outrank it). SET GOALS: every slot counts against a goal —
  `slotGoal(slot, layout, s)` = `slot.target?.sets`, else store's
  `setGoalFor(machine, slot.exercise, s)` (the exercise's, the machine's,
  the app default of 3) — COMPUTED, never stored (a stored goal would go
  stale when the setting changes mid-workout, and the tests pin the slot
  shape by `deepEqual`); null when the slot is unbound, its machine gone,
  or cardio (a bout is one set, never a tally). `slotDone` = goal ? count ≥
  goal : count > 0, so "Next:" pulls the walk back to unfinished goals in a
  free workout as much as in a planned one; every caller of
  `slotDone`/`twinShare` (the slot's set count; `nextOpenSlot`, `planSlotIndex`,
  `targetTally`, `resolveEntry`, the overview rows and picker, `renderLog`,
  the rest's `nextUpLabel`, `nearbyAlternative`'s and the Closer line's
  candidates) passes `layout` and the render's settings. `twinShare` deals
  unclaimed sets by the goal (one for a slot without one), `targetTally`
  counts every live slot with a goal (so a free workout's overview line
  and finish message read "6/9 target sets" too), the overview rows read
  "1/3 sets" / "✓ 3/3 sets" and the Exercises card header "2 of 5 done".
  On the log screen `setGoal` IS the slot's goal: the log button counts
  ("✓ Log set 1/3"), the head line reads "Target: 3 × 10 @ 50 kg · set 1/3"
  with a plan target and "Goal: 3 sets · set 1/3" (`#goal-line`) without
  one, and once the goal is met the Next button takes over as the primary
  action. A goal changed for THIS workout is the "Sets planned" stepper
  `#set-goal` under Rest (not for cardio): `change` writes
  `currentSlot.target = { ...target, sets: v }` on the WORKOUT via `saveLog`
  — a sets-only `{sets}` is a legal target shape (no reps, so no prefill
  from it; `fullTarget` is what the head line, the prefill and a twin's
  overview row require), and neither handler re-renders (the + is under the
  thumb): `paintGoal` refreshes the head line, the log label, the Keep link
  and the Log set / Next roles in place, like `refreshLogLabel`. The "Keep 4
  sets for #7 · Curl" link `#sets-keep` (`.linkish`, hidden while the value
  equals `setGoalFor(machine, exercise, s)`) writes it through store's
  `setTargetSets` — the exercise's when the slot has one, else the
  machine's — and a value equal to what the level ABOVE resolves to (the
  machine's goal for an exercise, the app default for the machine) DELETES
  that entry instead of pinning it: the rest link's rule, one level deeper,
  so a later change there still reaches it. TWINS — bound slots
  with the same (machine, exercise, grip) triple, e.g. `#14 Leg press 3x10
  80` plus `3x6 100` — see the same entries. Each logged set belongs to the
  slot on screen when it was logged: the log button records the set's `at`
  in `slot.logged` on every log, because a later bind can make any slot a
  twin. `twinShare` counts those claims first (one set per stamp) and deals
  only unclaimed sets in plan order (workouts started before the claims,
  sets without `at`): each twin fills up to its `target.sets` (one set
  without a target), the last one takes the surplus. So the heavy block may
  go first, and binding a line that becomes the earlier twin takes none of
  the sets already logged. `planSlotIndex` honours `active.chosenSlot`
  while that block is open or every twin is done; a done chosen block
  yields to the first open twin, because Next never offers a twin of the
  screen it is on. Otherwise it is the first OPEN twin (all done: the last
  one), so the second block's target takes over after the first — and its
  first set is prefilled from that target, not from the previous block's
  last set in the shared entry. A twin's overview row names its target
  ("Leg press · 3 × 6 @ 100 kg"), or two rows would read alike and the
  heavy one could not be told apart. `active.chosenSlot` is the plan index an
  overview row, a bind, Next or Busy? passes through `switchMachine`'s
  `slot` option (Next and Busy? hand on the index of the plan line they
  name, so a Next pointing at the later twin opens THAT block, not the first
  open one); any other switch forgets it, and it dies with the workout via
  `finishWorkout`'s allow-list. `nextOpenSlot` skips twins of the slot on screen, so
  "Next" and "Busy?" point past the machine you stand at — and it skips a
  FREE slot with no set: a slot grown by OPENING a machine (the log
  screen's push, the overview picker's, `startWorkoutFrom`'s
  `firstMachineId`, and a grip/exercise sibling spliced in after a free
  first slot) carries `free: true`, and with nothing logged it is where you
  merely stood, not a commitment (the overview still lists it as "open";
  slots built from a source — plan or repeat — carry no marker, and the
  tests pin both shapes by `deepEqual`). That is the user's ask of
  2026-10-21: "Next" in a free workout named whatever machine was opened
  last. The predicate is ONE helper, `idleFree(active, slot, layout, s)`
  (`slot.free` and a `twinShare` of 0), and "Busy?" (`nearbyAlternative`)
  and the "Closer:" candidates skip such a slot through it too (2026-10-22;
  the two once still offered a machine merely opened) — a set on it makes
  it a stop again for all three. `startWorkoutFrom` drops only exact repeats (same triple AND same
  target), so both blocks survive a restart. A plan whose FIRST
  slot has no machine yet starts with `binding: 0` — the workout opens on
  "which machine is this?" rather than on an overview of rows to assign;
  starting at a machine from the picker (`firstMachineId`) overrules it,
  and `renderBind`'s stale guard covers a plan edited in between. The plan follower's
  happy path is one tap per set: the log button always names what it logs
  ("✓ Log set 2/3 — 50 kg × 10", steppers update it live), and once a
  slot's target is met the Next button takes over as the primary action
  (log button demoted). `targetTally()` reports plan-wide progress on the
  overview line and in the finish message, which leads with the duration
  (`ui.js`'s `minsBetween()` — the overview line and History's `minsOf`
  share it). The Train tab's ROOT is a
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
  Its 🎲 chip (`surpriseMachine(layout, active, { rand })`, exported for the
  tests) only SUGGESTS: it fills the number field, highlights the machine
  on the map and says which of its muscles are still open — the start
  stays a tap on the action button; typing a different number clears the
  highlight and the 🎲 line (the handler redraws only the SVG). The draw: machines not trained yet
  TODAY (this workout plus the workouts finished today), narrowed to the
  picker's muscle filter while that leaves one, weighted by their open
  muscles (`trainedMuscles`; a machine
  without primary muscle tags counts as ONE open muscle — never starved to 0
  while tagged muscles are open, never above a machine known to work two); nearness to the last machine (else the entrance,
  else the floor's middle) adds under one muscle's weight, so it only tips
  the odds between equals; with every muscle trained it is a plain random
  pick among the untrained machines.
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
  a row that looks like a row must not be dead). The chevron lives INSIDE
  the `.row-open` button, not beside it: the delegated handler only sees
  `closest('.plan-start, .row-open')`, so a sibling chevron would be the one
  glyph advertising the tap that doesn't answer it (pinned in
  `test/plan.test.mjs`): a plan row opens its
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
  distance + time + Level (`#set-level`, a plain numeric stepper like reps —
  no keyboard special case; 0 = none: `readCardio` writes `level` only from
  1 up and an unreadable field keeps the prefill, like distance and time;
  `setWords` and `targetStr` trail it as "L5" like ui.js `setStr`, so the
  set list, the log button, the Target line and "Last:" all say it; the
  stepper's `change` refreshes the label like the other two), `machine.bodyweight` to reps + extra weight,
  `machine.assisted` to "Assist" + reps (sets, target and "Last:" read as a
  minus: "3 × 8 @ −25 kg", "unassisted" at 0; a Goal card offers "Less
  assist" / "More reps" from stats.js `assistGoalAt` — the one goal the
  progress and plateau hints use too — and says where an unsaid goal came
  from: the history's trend, the reps, or nothing yet; tapping the chip the
  history picked SAYS it, the chosen chip again unsays it). A typed or
  back-logged line reads the app's own minus back: "3x8 -25" is 8 reps at
  25 kg assist (a rep RANGE needs an attached hyphen or a dash, "3x8-12");
  type flags
  and `exercise` (and `grip`, `newEntry`'s 4th argument) are SNAPSHOTTED onto the entry (like num/label) —
  history/edit/chart/AI read the entry, never the live machine.
  Multi-exercise machines hold one entry per (machineId, exercise);
  `active.currentExercise` tracks the picked one and follows the slot on
  Next:/overview-row switches (null when arriving via the picker).
  The picker's mini-map is collapsed by default (`settings.pickerMap`,
  toggled + persisted via the 🗺 Map chip; Colors/Usage hide with it, the
  map draws lazily on first expand). 📍 buttons on the log screen
  (machine head + next-row) open `showMapOverlay()` — a fullscreen
  read-only map, target machine pulsing, others dimmed, any tap closes.
  The machine head's third button is 🏁: finish from where the work
  happens, two-tap like the overview's (🏁 and not ✓ — ✓ is the log-set
  icon). `twoTapConfirm` writes the label itself, so the armed button
  BECOMES the question ("Save?" / "Discard?") — which is what
  `.locate-btn.armed` styles for, a word instead of a glyph.
  The machine head's ✏️ button hands the machine to the Gym's full
  editor (`focusMachine` + `#gym`) — machines stay editable
  mid-workout, no Settings detour, and the Gym's back link returns to
  the running workout.
  `nearbyAlternative()` renders a "Busy? #N … is nearby" button under the
  next-row: the closest OTHER open machine by the WALK (stats.js
  `walksCached`, one flood for every machine of the layout, around walls
  and machines, which the "Closer:" line then reads from the memo; a
  machine no way leads to is none; straight lines only without a walkable
  floor grid (`walkableGrid`); current + plan-next
  excluded) as the busy-machine escape hatch —
  its tap switches to that machine and records the skipped next slot as
  `busy` on the new visit (store's `switchMachine`'s `busy` option), the
  skipped slot itself resurfaces via the wrap-around. That mark is the only
  stored trace of the button: no other state, and no `busy` on a plain Next.
  Under it, the RECOMMENDER (stats.js `closerStop`, docs/insights.md "Not
  a hint row") may add ONE hint line — "Closer: #7 Leg curl — half the
  walk." — when an open stop saves at least 30 % of the WALL-AWARE walk to
  Next, is not usually busy now nor marked busy in this workout, and is not
  the machine "Busy?" already offers; it never replaces Next, stores
  nothing and has no link (own data). Meters are out on purpose (no `layout.meta.scale`), so the
  saving is relative.
  THE SUGGESTION: when `nextOpenSlot` finds nothing, `suggestNext(active,
  layout, machine, { workouts, earlier })` (exported for the tests) names
  what to try next — candidates are the layout's machines not trained
  today (no set in this workout, none in a workout finished today via
  `finishedToday()`, not the current machine); the history's usual
  successor wins (stats.js `transitionCounts(workouts, layout)` from this
  machine, the highest count), else the candidate with the most OPEN
  primary muscles (`trainedMuscles`; a machine without tags counts as one,
  the 🎲 rule — so with every muscle hit it still names the nearest
  untrained machine); ties by the shorter walk (`walksCached`; straight
  lines between centres when `walkableGrid(layout)` is false; no way there
  sorts last), then by `num`; null with nothing left, and the log screen
  shows "Workout overview →" as before. It renders on the SAME
  `#next-machine` button as "Try next: #N Label →" with `data-suggested="1"`
  — no "Busy?" row, no "Closer:" hint (both describe a plan's next stop),
  the 📍 stays — and takes the primary role when the slot on screen is
  done, like a plan's Next; its tap pushes `{machineId, exercise: null,
  free: true}` when the machine has no slot yet and goes through
  `switchMachine`. The rest overlay's `nextUpLabel` says "try #N Label",
  so a resting user can tell a suggestion from a plan.
  WALKING ROUTE: every change of the current machine goes through store's
  `switchMachine` — nine call sites (the plan-slot tap, a bind, Busy? and Next pass `slot`): workout start (first machine), the
  plan-slot tap, the machine picker, binding an unbound slot, a machine
  deleted mid-workout (→ null), the quick-switch chips, Busy?, Next (a plan
  slot, or a suggestion taken — the same handler), and the
  back-to-overview tap (→ null). A bare `active.currentMachineId = …` would
  leave the visit list behind, so none exists.
  REPS IN RESERVE: after a set the rest overlay shows "Reps left?" chips
  (`#rir-opts`, 0 · 1 · 2 · 3+) when the newest stamped set is not cardio;
  a tap calls `rateLastSet` on the STORE's copy, saves, and re-renders the
  log screen. The re-render is required, not cosmetic: the log screen holds
  its own `active` object and saves it on the next Log set, so a rating
  left only in the store would be overwritten. The screen key is unchanged
  (no scroll reset) and the overlay lives on `body`, so it survives.
  With rest 0 there is no overlay: the same chips (`#rir-log`) sit above
  Log set while the newest set was logged on that very screen, and rate
  through the screen's own `active` — no re-render, the chip just toggles.
  The overview's "Muscles today" card is session progress as bar rows
  (`muscleProgress(active, layout)`, exported for the tests): one
  `.muscle-row` per muscle of `layoutMuscles(layout)` in `MUSCLE_REGIONS`
  order (muscles outside the pick list last, alphabetically), its value
  the sets this workout — a primary set 1, a secondary ½ (store's
  `usageByMuscle([active], layout)` gives both; History's Muscles card and
  stats.js weigh them the same) — read live from the layout (entries don't
  snapshot muscles; deleted machines contribute none). The bar is relative
  to the busiest muscle (History's rule, `.bar-track`/`.bar-fill`), the
  label reads "Chest · 3 sets" / "Hamstrings · 1½ sets" / "½ set" and
  "open" at 0 (`.open`: muted label, empty track); a line above the rows
  counts "4 of 9 muscles trained" (trained = value > 0). The CARD orders
  the rows, not `muscleProgress` (whose region order the tests pin):
  `muscleCardHtml(progress, shown)` (exported for the tests; user ask
  2026-10-22 — 14 rows on a gym that tags every muscle) puts the trained
  rows first, most sets first (a stable sort: ties keep region order),
  then ONE toggle row `button#muscle-fold.muscle-fold` ("Show N untrained"
  / "Hide untrained", `aria-expanded`, a full-width 44px box), then — only
  when unfolded — the untrained rows in region order. The fold is a view
  toggle ON the card, persisted as the device-local
  `settings.muscleFold` ('shown' | 'folded', absent = folded; not in
  merge.js `USER_SETTINGS`, so it never bumps the sync stamp). With
  nothing trained yet (or nothing untrained) there is no toggle and every
  row shows — folding them all would leave an empty card. The toggle sits
  ABOVE what it shows and hides, so a tap moves neither it nor anything
  above it: the handler swaps only `#muscle-coverage`'s content (no
  `renderTrain`, so the picker's state and the scroll stay), needs no
  `keepInView`, and refocuses the new toggle with `preventScroll`.
  `#muscle-coverage` keeps its id and ONE delegated click listener (it
  survives the swap); the rows double as navigation: a tap calls the
  picker's `setMuscle()` to filter machines for that muscle. The log screen's
  "Workout overview →" button (the no-Next variant only, `overviewButton`)
  carries the same count as a `.sub` ("4/9 muscles"), so the progress is
  one glance away without leaving the machine; no sub when the gym has no
  muscle tagged (the card hides then too). Set-arithmetic must guard
  against other shapes (`st.reps * st.weight || 0`); sets are counted off
  against the slot's goal (`setGoal` = `slotGoal`, see SET GOALS above) —
  a cardio target is one bout, not a tally, and has no goal. Nothing to
  start = an onboarding screen led by ONE action: type
  in the plan you already have (`planFromText`), with quick start on a
  line below it and the Gym as a text link. The map is the reward for
  a gym that exists, never the toll gate before it — a saved plan also
  outranks onboarding, and the start screen falls back to quick start
  when the gym has no machines. The picker offers create-on-miss for
  unknown numbers via `store.addMachine()` — training never requires a
  gym visit first. It places through `freeSpot` (a row of five from the top
  left as the preferred spot): the old modulo stacked a new machine onto
  whatever already stood there, and on a packed floor it may overlap but
  — as long as the grid holds the item at all — never lands on another
  solid item's exact spot.
- `js/plan.js` — the plan builder: muscle-filtered machine picking, per-item
  targets, reorder, weekday chips, and the route hint of the plan this
  name's workouts walk (above the items it reorders). It renders INSIDE the Train tab via
  train.js's module state (`openPlanBuilder()`, which ai.js uses for import
  review); an active workout always outranks it. It runs WITHOUT a gym:
  unbound items get a `📍 Assign machine` prompt (number field prefilled
  from `item.num`, plus chips for the machines that exist), binding through
  store's `bindOrCreateMachine` (a target the bind had to reset is said
  once — `bindNotice`, cleared after the next render; the caller's `notice`
  stays), and a one-line `Add an exercise` field
  parsing the same note grammar as the onboarding note. List/Text chips
  switch between the stepper list and the plain note
  (`planToText`/`parsePlanText`); every switch AND `persist()` go through
  `fromText()`, so the text is authoritative while it is on screen; the
  other re-renders reachable in Text view (name chips, day chips, "Set
  <day>") take the note in first via `pullText()` and print it back AS
  TYPED (`state.text`, kept on every `input`), never re-serialised. Nothing
  persists until Save — which is what lets an imported AI draft, or a
  routine seeded from history, be reviewed and trimmed before it sticks.
  The draft lives ON the caller's builder state (`opts.draftState`: draft,
  view, typed note — train.js's `builder` object, alive until Save/Cancel/
  Back), because a tab switch re-renders the Train tab from scratch: a
  fresh deep copy per render lost every edit. The name field writes the
  draft on `input` for the same reason. Target steppers and the bind
  number read through `fieldValue()`. A new line seeds its target from the
  last logged set there (`targetDefaults`) — a cardio line its distance,
  time AND `level` (absent when that set named none); the list view has
  no level stepper, the Text view shows and edits it.
- `js/history.js` — two screens in one module, switched by module state like
  train.js (no hash sub-routes; `#history` stays one route). The OVERVIEW is
  what a glance needs: This week (tiles, a bar chart of the last 12 weeks,
  that week's workouts READ-ONLY — repeat, and "Edit ›" into the editor on
  the Workouts screen — and the frequency hint between tiles and bars) →
  Progress (machine chips, range chips, `lineChart`, the plateau hint of
  the picked machine AND exercise in `#chart-note`) → Walking paths (the
  route of one workout, or all of them weighted, on the floor map) →
  Muscles (a muscle's gap or volume hint as a line UNDER its row — a
  sibling, never inside the button: a link in a button is no link). The WORKOUTS screen, one tap
  from the week card, holds the month heatmap (per-machine filter), the full
  workout list with repeat and the editor, and `Log a past workout`; its
  back row returns to the overview. A screen CHANGE resets the scroll to the
  top, an in-place update never does (the same rule as train.js's
  `screenKey`). `renderHistory(root, {entry})`: app.js passes `entry: true`
  when the tab is opened, which resets "where in time" (screen, picked
  week, path workout, heatmap month and machine, picked point, the expanded
  chip row, a pending `focusWorkoutId`); every other call — save, delete,
  filter change — omits it, so the screen, the picked machine/week/route
  and the heatmap stay put. The week list has no editor because a bar or
  tile tap rebuilds it: a draft open there died unannounced
  (`wireWorkoutList(…, { readOnly: true })` neither renders nor consumes an
  editor). A tile, chip or muscle row that redraws its own container goes
  through ui.js's `keepFocus`, so keyboard focus lands on the control's
  successor instead of `<body>` (a control that vanishes in its own tap —
  "+N more", "All muscles" — has no successor by `data-*`: `keepFocus` then
  hands the focus to the control at its old position in the container,
  clamped to the last, i.e. the first revealed chip or the list's first
  row); a muscle-row tap also `keepInView`s the
  row (Muscles is the last card, the view resizes above it), and "Log it"
  brings a `#past-msg` about skipped lines back on screen. The selected
  bar and its tile share ui.js's `fmtMetric` ("2:29 h", "3,873 kg"). The
  Workouts screen says "Workouts" once (its h1); an active filter shows as
  a "Showing: …" line on the list card. The path card's empty text blames
  a name or muscle filter when that is what hid every route. Module
  state surviving those re-renders: `screen`, `lastScreen`, `nameFilter`,
  `muscleFilter`, `pickedMachine` (a `seriesKey` — the JSON triple), `pickedT`,
  `pickedWeek`, `pathWorkoutId` (null = the latest, `'all'` = weighted),
  `hmMonth`, `hmMachineKey`, `machinesExpanded`; `focusWorkoutId` and
  `openEditId` are one-shot — `wireWorkoutList` consumes them on the render
  they were set for. The range chips and the metric tiles persist as
  `settings.historyRange` ('4w'|'12w'|'1y'|'all', default 12w) and
  `settings.historyMetric` ('workouts'|'sets'|'volume'|'minutes', default
  sets); both are device-local — deliberately NOT in merge.js's
  `USER_SETTINGS` — and validated on read (`rangeOf`/`metricOf`: any unknown
  value falls back to the default), store.js knows nothing of them. An
  assisted machine's chart plots its least ASSIST ("assist (kg) — lower is
  stronger", the line titled "Least assist") or, by the Assist/Reps chips
  under the range, the reps at it — `settings.historyAssistView`, device-local
  and validated the same way (`assistViewOf`). Past workouts are fully editable: per-set
  values, `+ Set` (copies the previous one, minus its `at` and `rir` — it
  was neither logged live nor rated), `+ Machine` (snapshots num/label/type
  flags like the log screen), remove set or whole machine, date + time and
  name chips. A cardio row's third field is `.edit-level` (number, whole
  from 1 up; empty, 0 or junk deletes `level` from the draft's set on
  `change` — never a stored 0 — and `+ Set` copies it with the rest). A grip chip whose change `gripTaken` refuses (a gripless twin
  of the same exercise exists) says so once under that entry's chips
  (`gripMsg`, cleared by the next render). The date goes through store's `shiftWorkout`, so the start,
  the finish, every set's `at` and every visit move together and the gaps
  between them (rest, time per machine) survive the edit. `Log a past
  workout` reads the same note grammar via `workoutFromText()` — a past
  workout IS a plan that already happened, so `3x10 80` becomes three
  real sets — and reopens the result in edit mode (`openEditId`). It
  shows even on the empty screen: coming over from paper starts there.
  Shared display helpers live in ui.js. `fmtDuration` serves TWO roles —
  a cardio duration and the rest countdown — so it names the hour only
  from 3600 s on: below that every string is unchanged (a 72 s rest is
  still `1:12`), above it a 90-minute ride reads `1:30:00` instead of
  claiming to be `90:00`. Its inverse is `parseDuration`: cardio time is
  TYPED as m:ss everywhere (log screen, builder targets, History's editor),
  and no iPhone pad has a colon — so time fields sit on the DIGIT pad
  (`inputmode="numeric"`) and type like a microwave: `clockDigits` inserts
  the colon on every `input` event, the last two digits are the seconds
  ("1230" shows 12:30), one or two digits are whole minutes. In a live
  field the listener drops every non-digit, so only digits count there;
  `parseDuration` itself still reads `:` `,` `.` as separators (stepper
  values, direct calls). The old decimal-minutes field read "12,30" as
  12.3 min, or as 12 where `type=number` dropped the comma.
  `parseDistance` takes a decimal comma, and in metres a separator before
  exactly three digits is a thousands mark ("2.000" = 2000 m). Both return
  `null` on unreadable input and the caller keeps the old value — so these
  fields are `type=text` with `data-kind` (stepperField's `kind`), which is
  what initSteppers/initNumericOverwrite key on. The log screen's WEIGHT is
  the same text field (`kind: 'decimal'`, read by `parseDistance(…, false)`):
  as `type=number`, Chromium turned a typed "12,5" into 125 kg and Firefox
  into an empty field. The builder's target weight, the History editor's
  set weight and Settings' weight step are the same decimal text field
  (measured 2026-10-13 in Chromium: "12,5" was stored as 125, "2,5" as 25).
  Reps and rest stay `type=number` — whole numbers.
  Every stepper field is READ through `fieldValue(input)`: a field the
  overwrite arming emptied on focus still means the value it showed
  (`dataset.prevValue`), because iOS can deliver the Log set tap before the
  blur that would restore it — read raw, that was a logged 0 kg × 1 with no
  rest. `pad2`/`dateValue`/`timeValue`
  build LOCAL-time input values (toISOString is UTC and shifts a
  past-midnight workout onto the previous day — ai.js dates its export
  via `dateValue` for the same reason) and `machineChain` is the deduping
  "#1 → #3" chain used by the start screen and the workout list alike.
  Workout-name chips at the top
  filter everything but the hints: `workouts` is narrowed once, right
  after `getWorkouts()`, so week, heatmap, chart, path and the list all
  follow; `ctx.hints` is computed once over `all`, because a rule like
  "strength days per week" means nothing for one routine. The filter is
  module state (`nameFilter`) because a save or delete re-renders the whole
  view, and it self-clears when its last workout is renamed or deleted.
  The Muscles card (store's `usageByMuscle`/`workoutsWithMuscle`) shows
  sets per muscle group as tappable bar rows that set a second filter
  (`muscleFilter`, ANDed after the name filter, same lifecycle incl.
  self-clear and the past-log reset). Muscles resolve against the LIVE gym
  — entries don't snapshot them — and a set on a two-muscle machine counts
  fully for both (usage is attribution; only naming votes split 1/n).
  Both count RESISTANCE machines only — a tagged treadmill neither fills a
  row nor turns up under its filter.
  Resistance machines only, like the hints (stats.js `resistanceMuscles`):
  a treadmill tagged Calves is no calf set, so the card never contradicts
  the hint under its row, and the "can't be attributed" note leaves cardio
  sets out (they never were muscle sets). The
  filter narrows WHOLE workouts, never entries, so the editor's Save can't
  drop non-matching machines; the card itself is computed over the
  name-only list so every muscle stays reachable while one is selected.
- `js/stats.js` — pure History analytics: weekly buckets, per-machine series
  with estimated 1RM, muscle sets per week, the walked route, transition
  counts, rest gaps, the floor's walking distance (`walksFrom`: one
  Dijkstra flood from a machine to all targets over whole grid points, 8
  neighbours — the outline, interior walls, machines and free-standing
  fixtures block, two touching items are a barrier (the floor's rim counts
  as a wall), a door or entrance in an
  interior wall opens it, a target is reached on or next to its box from a
  point whose straight step towards its centre crosses — up to a quarter
  unit into the box, the machine itself is no obstacle — no wall, outline
  slit or other solid (user decision: a machine cut by a wall stays
  reachable from its floor side); ring points tied on the flood distance
  take the shortest step to the centre; the walk starts at the rounded
  centre only where that point is on the floor with no wall to the true
  centre, else from the machine's ring the same way, so no walk joins two
  rooms through a partition (a true centre ON a wall is no good centre
  either) — and with a good centre also from the ring points a wall
  separates from the true centre, so a machine cut by a partition is left
  into both rooms as it is reached from both. Measured on editor-shaped
  floors with axis-aligned partitions and doors: 1 133 of 34 456 pairs
  walked one way only before, 0 after; walks from a machine no wall enters
  are unchanged, one a wall stub enters can get shorter. A wall between
  two points is `wallBetween`: `crosses`, strict with onSegment's 1e-9
  tolerance (a step through a wall's END touches it, and a rounding rest
  of 1e-15 once made that a crossing), plus the `joints` — a segment's end
  another segment shares or runs through (a room's corner, a partition in
  two strokes, a stub ending on a wall), which a step passes touching both
  walls at their ends only, so `crosses` alone lets it through (the flood's
  half-unit raster caught such a joint only on the half grid; a template's
  walls sit at tenths). The straight step reads walls from `wallBetween`
  alone, not from the raster (a half-unit sample rounding onto a wall's end
  blocked a machine that was left past that end). Measured against the
  build before on editor-shaped floors with flush pairs and single-stroke
  wall stubs with doors (3 × 11 250 pairs): 0.5–0.8 % of walks shorter,
  7–13 per 22 500 newly found, none lost, one-sided pairs 11→4, 30→24,
  11→4. What is left one-sided is structural: a walk
  LEAVES through the start's own body (its edges and seam points are free
  for it) but ARRIVES by a straight step, so a seam point with a flush
  neighbour or the corner three machines share can be left and not reached
  — 0.2–0.4 % of pairs with a diagonal partition and flush machines, a
  tenth of that axis-aligned; a symmetric arrival (no goal inside the
  start, or the start's own edges counting as seams) changes about 10 % of
  all walks and loses some, so it stays a decision (TODO.md);
  `walkableGrid` keeps the grid to 1–400
  units, else no walk; `floodCount` and `floodSettled` let the tests pin one flood
  per log screen and its early stop; the
  floor is rasterised once per geometry on a half-unit grid, walks are
  memoised per floor and pair (`walksCached`); null when no way exists; the
  walking-path card keeps its straight legs, user decision) with the
  recommender `closerStop` on top, and the hint rules (`insights()`: every observation
  that fires, as an instruction with a `source` and its target — no card,
  no cap; docs/insights.md says which screen shows which). `hintHtml()` in
  ui.js renders one: the text, a ↗ to the study, nothing from `own`. NO
  imports, like merge.js (history.js, train.js, plan.js and ui.js import it,
  never the other way) — workouts, layout, settings and `now` come in as
  arguments, so it tests
  without a clock or a browser. Every string it returns is RAW; the UI
  escapes. It reads time only as DIFFERENCES between stamps of the same kind
  (`at` to `at`, visit `in` to `out`), never `at − startedAt`: a workout
  whose date was edited before `shiftWorkout` existed moved `startedAt`
  alone, so that gap is garbage for it while `at`-to-`at` stays true. It
  keeps a COPY of weekday.js's `startOfDay` (weekday.js holds the definition;
  importing it would end the no-imports rule) and test/stats.test.mjs pins
  the two equal across a DST day. Weeks start on Monday and are stepped with
  `setDate()`, never 7 × 86400000. The rules, their thresholds and their
  sources live in docs/insights.md — change both together.
- `js/chart.js` — the History charts, `lineChart` (time on x, an optional
  dashed second series) and `barChart`; it imports nothing and escapes
  every caller string (labels, units, keys) itself. One point or column is
  selected at a time: tap, drag to scrub, or ArrowLeft/Right, and the
  selection STAYS when the finger lifts — there is no tooltip, since one
  vanishes with the finger; the value is drawn in the chart and `onSelect`
  hands the point back. The handlers are assigned as PROPERTIES of the
  container (`onpointerdown` …), because a redraw replaces them where
  `addEventListener` would stack one more set per redraw. The CONTAINER
  (`.chart-wrap`) is measured, never the svg — the svg is replaced on every
  selection change. An empty chart clears the handlers so a stale one cannot
  redraw the old chart over the empty text. A caller must never re-render the
  chart's ancestors from `onSelect`: the captured container would die.
  `niceTicks` and `timeTicks(x0, x1, span)` (Mondays up to six weeks, month
  starts beyond) are exported.
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
  targets included). Day maths goes through weekday.js's `startOfDay` +
  `setDate()`, never fixed 86400000-ms steps (DST). The last four weeks
  are stamped like a live-logged workout — `at` on every set, `visits`
  (one carries `busy`) and `rir` on strength sets — so the insight rules
  and the walking paths have something to show; older weeks stay bare (no
  `at`, no visits), which keeps the "older sets lack `at`" paths exercised.
  Five machines carry `secondaryMuscles` (chest press: Shoulders; seated row:
  Biceps; leg press: Hamstrings; pull-up bar: Upper back; dip station:
  Shoulders), only muscles the demo already trains as primaries, so the
  secondary UI shows there; `test/demo.test.mjs` strips them before the old
  layout digest pin.
- `js/ai.js` — copy prompt+data / paste-import. Deliberately NO AI API.
  Export set tuples are `[w, r]`, gain a third element (seconds offset from
  the workout's startedAt) when the set has `at`, and a fourth, `rir`, when a
  strength or bodyweight set was rated: `[w, r, sec|null, rir]` — `null`
  holds the third slot for a rated set without `at`; cardio never carries
  `rir`, its fourth element is the set's `level` instead — `[distance,
  seconds, sec|null, level]`, same null rule, absent without a level (one
  slot serves both because a cardio set is never rated). A pasted
  `workout-plan` cardio item may carry `"level"` (store's `normalizeTarget`
  keeps it). A workout with `visits` exports them as `[num, inSec, outSec,
  busyNum?]` (one num space: every num and label in the export — entries,
  visits and their busy marks — is the layout machine's CURRENT one, looked
  up by `machineId` (`machineName()`), so a renumbering or rename never
  leaves two numbers for one machine; only a machine deleted since falls
  back to the num and label the entry or visit was logged under, a visit
  neither layout nor entries know is dropped, an unknown busy mark only
  loses its slot; stored data is never rewritten, only the export;
  `visits` that is no list of objects — backups and sync pass it on
  unchecked — exports as none; absent rather than empty). The prompt and the export `note` teach all of it. The output is compact JSON
  (`compactJson`, WIDTH 160): whatever fits in 160 columns stays on one line,
  larger containers break one child per line (demo export 38.5k chars / 3300
  lines → 17.8k / 305); it is still plain JSON, `JSON.parse` reads it
  unchanged.
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
  fallback (online always fresh, no cache bump per deploy), capped by
  `NET_TIMEOUT_MS` (2.5 s) so a stalled gym wifi never spins forever: once
  the timer fires, a cached copy answers — but only one that EXISTS and
  does NOT carry `Cache-Control: no-store`, which keeps `serve.py` honest
  (a slow localhost is never masked by a stale module). With no usable hit
  the timeout promise never settles at all and the network wins, so first
  loads and on-demand template files still work on a slow line; a network
  REJECTION beats the timer immediately, so hard offline stays instant.
  IMPORTANT:
  new static files (js modules, css, icons) must be added to the SHELL
  list in `sw.js` — EXCEPT template files: they are on-demand content the
  fetch handler caches on first load, only `templates/index.json` is
  precached (so a community template PR never touches sw.js). CI's
  `shell-list` job goes red on a forgotten one, and the `CACHE` constant is
  bumped IN THE SAME COMMIT as any SHELL edit — the precache is filled once
  per cache name, so a new entry under the old name never gets fetched.
  `js/theme-boot.js` (the first-paint theme script, see app.js) is in SHELL
  too.
  The service worker deliberately imports nothing: a module worker
  (`register(..., { type: 'module' })`) fails on Safari < 16.4, so
  `js/version.js` is duplicated into SHELL as a plain path rather than
  shared as code. `settings.keepAwake` names the
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
  `adjustRest()`: giving a FINISHED timer more time revives it (cancels the
  pending close, clears `done`, so the new zero sounds again) — the overlay
  lingers ~900 ms after the tone, and a tap in that window used to extend a
  countdown that was already scheduled to close. Both the close and the
  jerk-removal timers are held and cleared, never left to stack.
- **The rest belongs to the WORKOUT, not to the rest screen.** The fact is
  `active.restUntil`, an epoch deadline that survives a reload and dies
  with the workout (`finishWorkout` is an allow-list). The overlay and the
  `.rest-inline` row above the log button are two views of it, painted by
  one `paintRest()` that looks `#cd`/`#rest-cd` up by id EVERY tick and
  never holds a node — `renderLog` replaces them. A tap on the backdrop
  calls `dismissRest()`: screen away, timer running (deliberately narrower
  than `showMapOverlay`'s "any tap closes" — every button in this overlay
  keeps its own job). Skip and zero call `endRest()`, which removes the
  inline row BY ID rather than re-rendering, so a half-typed field
  survives. `ensureRestTicking()` picks a live deadline up after a reload
  (no overlay, and the tone may be blocked without a gesture).
  `restUntil` has ONE writer on the log screen's side: `startRest`. Skip,
  the tone and ±15s change the STORE's copy (the overlay outlives the
  screen that opened it), so every other save from the log screen goes
  through `saveLog(active)`, which takes the deadline over from the store
  first — a plain `saveActive` of the screen's render-time object wrote a
  skipped rest back (countdown and tone returned) and undid a +15s. A set
  logged with rest 0 ends a running rest, and `finish()` stops the timer
  only AFTER `finishWorkout` succeeded, so a refused write leaves it
  running instead of frozen (`smoke/workout.spec.mjs` proves both: a
  stubbed quota error keeps `#rest-cd` ticking, a finish mid-rest leaves no
  timer and no tone). Whether the overlay may re-render Train
  (`onTrainTab`) is read off the tab pill `route()` marks active — after
  Browser Back under the overlay that pill belongs to another tab.
  `restNextUp()` is what the overlay promises next, set by `renderLog`
  from the values it already has and keyed on `slotDone`, not `targetDone`.
  A rest CHANGED mid-workout goes to `active.restOverrides[machineId]`,
  never straight to the machine: writing the machine per ± marked the gym
  dirty for sync on every tap. The "Keep 75 s for #3" link under the
  stepper is the only way it reaches `machine.restSeconds` — and back at
  the app default it DELETES that value instead of pinning it. Neither
  handler re-renders (the + is under the thumb).

