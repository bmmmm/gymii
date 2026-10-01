# Testing — logic suites, smoke suite, device notes

Split out of AGENTS.md so the always-read file stays a map (its budget is
~1500 words) while this detail loads when the work touches it — read it before writing or changing a test.
Moved verbatim. Tracked on purpose: `.claude/` is gitignored here, so a doc
there would be invisible to a fresh clone, to CI and to cloud agents.

- Dev server: `python3 serve.py [port]` → http://localhost:8437 (sends
  `Cache-Control: no-store`; plain `http.server` made Chrome serve stale
  modules — don't go back to it). It also raises the listen backlog from
  5 to 64: parallel local Playwright workers overflowed it, macOS refused
  the overflow, and ~half the specs failed on "Failed to fetch dynamically
  imported module" — local-only, CI never saw it.
- Logic tests: `for f in test/*.test.mjs; do node "$f"; done` — CI runs the
  glob, so a new `test/<module>.test.mjs` is picked up without a workflow
  edit. The localStorage stub lives ONCE, in
  `test/helpers/localstorage.mjs`: importing it installs it, which is why it
  must be a test's FIRST import — ESM evaluates a dependency completely
  before the importing module's own body runs, so the stub is in place ahead
  of every `await import('../js/store.js')`. It exports `mem` (the backing
  Map, a live binding) and `useStore(map)` to point the stub at another Map;
  one call is a device switch, which is how sync.test.mjs runs two devices in
  one process. `failWritesAfter(n)` lets `n` writes through and then throws
  a real `QuotaExceededError` from `setItem` (Infinity by default, so tests
  that ignore it see the plain stub); `removeItem` stays exempt, because
  deleting frees space and the store depends on that. The helper is deliberately outside the CI glob — neither the
  `helpers/` directory nor the name matches `test/*.test.mjs`, so it never
  runs as a suite of its own.
  `store` (store roundtrips, outline migration,
  template validation, locker carry-over, sync groundwork: stamps,
  tombstones, v1/v2 backup compat, the refused-write path and
  `storedBytes` across gyms), `persist` (origin durability over a stubbed
  StorageManager: no API, already-granted, ask-once, refusal, rejections), `merge` (the pure sync merge matrix —
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
  import, binding, targets), `history` (the two screens and the
  entry reset, name filter, week card, hints, progress chips/range/pick,
  walking paths, muscle card + filter, heatmap state, full editor,
  back-logging), `map` (the shared renderer: px-sized touch
  targets, viewBox clamping, wall/door geometry, the usage ramp, collision
  and placement, the walking-path overlay, and ids escaped into attributes), `chart` (tick math, the time axis, both
  charts' markup and the tap/scrub/keyboard selection over a stub container
  — chart.js imports nothing, so NO localStorage stub), `stats` (the pure
  History analytics: weekly buckets, series, route, every insight rule at
  its threshold and one step short; it imports the localStorage stub FIRST
  only because its DST pin compares its `startOfDay` copy with store.js's),
  `ui` (the shared
  helpers, incl. the four DOM-facing ones over hand-made stubs — the file
  runs under Pacific/Auckland, where local-vs-UTC actually differs),
  `gym` (editor wiring and drag integration),
  `demo` (generator determinism, entry invariants, weekday plan states,
  unit conversion, load-replaces-gym), `ai` (export plans section,
  paste-back new-vs-replace flow), `templates` (the community-library
  gate: manifest ↔ files ↔ real import validation), `sw` (the real
  `sw.js` run in a `node:vm` sandbox: method/origin gate, cache writes,
  offline fallback, and the stalled-network timeout — the sandbox owns
  `setTimeout`, so 2.5 s are proven in microseconds). Modules import
  fine in Node as long as none touches the DOM at top level; the stub DOM
  hands back EVERY selector, rendered or not, so a test must drive view
  switches explicitly rather than assume a branch was skipped.
- Browser smoke tests: `pnpm install` once, then `pnpm exec playwright
  install chromium` once (~170 MB, deliberately NOT an install script —
  Playwright is kept off `onlyBuiltDependencies`), then `pnpm run smoke`.
  Nine scenarios in `smoke/*.spec.mjs`: the app boots at all (js/app.js is
  loaded by no Node test and `static-checks` does not resolve imports), a
  logged set survives a reload, the rest keeps running inline after the
  overlay closes and across a reload, no route scrolls sideways at 320px,
  every touch target is 44px and every field 16px, the service worker
  registers and precaches every SHELL entry, a focused field lands centred
  above a stubbed `visualViewport` keyboard (the log form with its button,
  the locker field, a field-to-field hop, the last field on Settings; a
  re-focused field, a pinch-zoom and a too-tall field do NOT scroll, and
  --kb drops on keyboard close and on return to the app), and the
  standalone/PWA safe-area padding scales correctly under a CDP-emulated notch inset,
  and the History tab (`history.spec.mjs`, demo gym): a machine chip names
  the chart, a bar tap opens that week, the Workouts screen passes the same
  44px / 16px / no-overflow measures, and the path card draws a route.
  A NEW browser spec goes in
  `smoke/` as `*.spec.mjs`, NEVER in `test/` — `testMatch` is pinned
  because Playwright's collector imports whatever it matches and would run
  the Node suites as a side effect. Sandbox notes: `serve.py` cannot bind a
  port under the sandbox (run it un-sandboxed), and `registry.npmjs.org` /
  `cdn.playwright.dev` are unreachable (a sandboxed `playwright install`
  after a Dependabot bump stalls silently; run it un-sandboxed, ~1 min, and
  note it prunes the previous build). The suite itself needs the sandbox
  off too, as measured on 2026-10-01 from two independent runs: Chromium's
  launch dies with `bootstrap_check_in … Permission denied` (a mach-port
  check-in the Seatbelt profile refuses), before the app is ever loaded —
  a failure that reads like a broken browser and is neither the browser
  nor the app. The durable fix is two project-local switches in
  `.claude/settings.local.json` (gitignored, a user decision):
  `sandbox.network.allowLocalBinding: true` lets `serve.py` bind, and
  `sandbox.excludedCommands: ["pnpm run smoke *"]` runs the suite outside
  the sandbox — the suite call only, and only as a BARE command line: the
  pattern is matched against the whole line, so `pnpm run smoke > log;
  tail log` is not excluded and dies at the mach port again (both measured
  2026-10-01, no restart needed). An ad-hoc probe script still needs its
  own per-call bypass. OPERATING RULE: a spec that flakes twice in a month
  is rewritten or deleted — a quarantined smoke test is worse than none.
  Hygiene: `grep -rn` now needs `--exclude-dir=node_modules`. In a git
  WORKTREE never run `pnpm run smoke` against a symlinked `node_modules`:
  pnpm's pre-run dependency check decides the install is foreign and tries
  to purge the modules directory THROUGH the symlink — the main checkout's
  install was saved only by the missing TTY (2026-10-01,
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). Call the script's own
  command instead: `node_modules/.bin/playwright test -c <worktree>/playwright.config.mjs`.
- Dependabot watches the one dependency. A bot PR does NOT know
  `minimumReleaseAge` and `--frozen-lockfile` does not re-check it, so the
  existing repo rule (adopt locally, never merge in the UI) carries real
  weight here: adopt via `pnpm add -D @playwright/test@latest`, which does
  respect the cooldown.
- Touch targets are 44px, as real boxes (`min-height`/`min-width`), never
  as an invisible pseudo-element. Two documented exceptions, both commented
  in the stylesheet: `.hm-cell` (seven columns of a week don't fit 44px at
  320px — 34px still clears the 24px minimum, WCAG's essential-layout
  exception) and `.linkish` (a button reading as a word inside a sentence).
  Anything focusable and text-shaped stays ≥16px, or iOS zooms the page on
  focus — a `font:` shorthand silently beats that rule, so split it.
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

