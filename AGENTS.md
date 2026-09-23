# gymii — agent notes

Minimal gym workout tracker. Vanilla HTML/CSS/JS (ES modules), **no build
step**, all data in localStorage. Mobile-first, dark-only.

**The app that ships stays dependency-free — nothing from `node_modules`
ever reaches the browser; its test infrastructure is not.** The one
dependency is `@playwright/test`, for the browser smoke suite in `smoke/`,
and two CI tripwires keep the line where it is: no shipped file may
mention `node_modules`, and the deploy job refuses to run if an install is
present in the publish directory.

## Run & verify

Full detail — what each suite covers, the localStorage/DOM stubs, Playwright
setup and sandbox notes — lives in [docs/testing.md](docs/testing.md). Read
it before writing or changing a test.

- Dev server: `python3 serve.py [port]` → http://localhost:8437 (sends
  `no-store`; plain `http.server` served stale modules — don't go back).
- Logic tests: `for f in test/*.test.mjs; do node "$f"; done` (CI runs the
  glob). `test/helpers/localstorage.mjs` must be a test's FIRST import. The
  stub DOM hands back EVERY selector — drive view switches explicitly.
- Browser smoke: `pnpm run smoke` (setup in docs/testing.md; `serve.py`
  cannot bind a port in the sandbox). A new browser spec goes in `smoke/`
  as `*.spec.mjs`, NEVER in `test/`. A spec that flakes twice in a month is
  rewritten or deleted. `grep -rn` needs `--exclude-dir=node_modules`.
- Dependabot: adopt locally via `pnpm add -D @playwright/test@latest`
  (respects the cooldown), never merge in the UI.
- Touch targets are 44px as real boxes (documented exceptions `.hm-cell`,
  `.linkish`); anything focusable and text-shaped stays ≥16px — split a
  `font:` shorthand, it silently beats that rule.
- UI changes: verify in a real browser (claude-in-chrome), editor
  interactions via scripted PointerEvents + localStorage asserts.
  `navigator.wakeLock` cannot be verified there (hidden window).
- Node ≥21 ships a global `navigator`: guard the specific API. `document`
  genuinely is undefined in Node.

## Architecture

Every module, its invariants and the reasons behind them live in
[docs/architecture.md](docs/architecture.md). Read the module's section
BEFORE changing it — the invariants there are test-pinned, and most of them
exist because breaking them was once a real bug.

- **Naming — one term per concept.** A **gym** is the container (layout,
  workouts, plans, history); a **layout** is the floor plan plus machine
  list inside one gym. Machines, never "stations"; workouts, never
  "sessions". The wire format keeps `gym` / `gym-template` — files in the
  wild read them that way. Don't "fix" that.
- `js/store.js` — the ONLY data layer (per-gym localStorage keys, lazy
  migrations, sync stamps + tombstones, shared invariant helpers, write
  failures announce AND rethrow). Shared invariants live as store helpers
  (`bindOrCreateMachine`, `newEntry`, `nameChipsFor`) — extend, never
  re-inline. `js/persist.js` — origin durability.
- Cross-module traps: sets are strength `{reps, weight}`, cardio
  `{distance, seconds}`, bodyweight = ADDED weight, and `at` is optional —
  every consumer guards (`st.reps * st.weight || 0`). Stored weights and
  distances are in the DISPLAY unit: a new such field must be converted by
  `setUnit()` too.
- `js/sync.js` + `js/merge.js` — cross-device sync (E2E, or explicit plain
  mode without a secure context); frozen public
  API; `docs/sync-protocol.md` is the wire contract.
- `js/app.js` — hash-router; `#gym` is deliberately NOT in the tabbar.
- `js/map.js` — shared floor-map renderer (imports only `esc`; every id
  into an attribute goes through `esc()` — template files are untrusted);
  `js/gym.js` — the editor (everything starts locked, every mutation via
  `save()`) and never imports from train.js/plan.js.
- `js/train.js` — hub, guided workout, rest timer (the rest belongs to the
  WORKOUT); `js/plan.js` — the plan builder, works without a gym.
- `js/history.js` — list, editor, back-logging; `js/ui.js` — shared helpers
  (formatting, steppers, keyboard centring, timer sound).
- `js/demo.js` — deterministic demo gym, found by its `demo` flag, never by
  name; `js/ai.js` — copy/paste export, deliberately NO AI API.
- `sw.js` — network-first PWA. A new static file goes into SHELL and bumps
  `CACHE` in the SAME commit (CI's `shell-list` checks the first half) —
  template files excepted: only `templates/index.json` is precached.

## Conventions (user-set, follow them)

- Everything in code English, incl. UI strings. German only in chat.
- Destructive/final actions: hidden + two-tap guard (never `confirm()` —
  it blocks browser automation). Frequent actions visually dominant. The
  set-row ✕ follows this rule too: it sits a thumb's width from the
  steppers and a logged set has no undo. Its first tap must NOT re-render,
  or the armed node dies before the second tap reaches it. History's editor
  keeps an unguarded ✕ — nothing there is written until Save.
- Icon row actions are 44px boxes (`.set-row .x`, `.plan-item-actions .x`).
- Enumerable input = tappable chips, never free text (typo avoidance).
- Keep the control you just used under the thumb. These views re-render by
  replacing whole subtrees, so any action that grows a list ABOVE its own
  control pushes that control off-screen (log a set, add a plan line, add a
  settings field / exercise, `+ Set`, `+ Machine`). Such a handler calls
  `keepInView(root, selector)` from ui.js after the re-render — instantly,
  never smooth, and with `focus: true` only for text fields likely to be
  filled again (never number inputs: the keyboard would pop and
  `initNumericOverwrite` would hand over an empty field). A re-render that a
  TEXT FIELD triggered is the sharper case — the field is a different node
  afterwards, so the keyboard drops and the caret is gone mid-word: wrap
  such a render in `preserveFocus(root, render)` (ui.js) and the field comes
  back focused with its selection intact, found again by its id. Both
  `renderProps()` (gym.js) and `renderSettings()` are wrapped whole, so
  every field inside them is covered once instead of per call site.
  THE KEYBOARD: `initFocusCentering()` (ui.js, wired once in app.js)
  centres every focused field in the VISIBLE band once `visualViewport`
  settles (a field-to-field hop fires no resize: focusin settles 300 ms
  later, skipping a field `preserveFocus` merely handed back) — with its context when that fits (`[data-focus-context]`, else
  the nearest `.card`; the log form carries the attribute so steppers AND
  the log button land together) — and pads #view by `--kb` while the
  keyboard is up, because #view is the only scroller and without that room
  iOS pans the window instead ("the page jumps"). `keepInView` switches to
  the same centring while the keyboard is up. A new form whose parts belong
  together gets `data-focus-context`, not a scroll handler of its own.
  Navigation is the
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

CI runs the logic tests, parses every shipped script (`static-checks` — the
one job that would catch a typo in js/app.js, since nothing else loads the
files) plus a `sw.js` SHELL cross-check, and deploys Pages
from main; every asset reference must stay RELATIVE (project subpath).
DONE = deployed, and a deploy says which build it is: any push to main that
touches `js/`, `css/`, `index.html` or `sw.js` must bump `APP_VERSION` in
`js/version.js` to the deploy date in the SAME push, or `static-checks` goes
red before Pages sees it — a second deploy on the same day takes a letter
(`2026-09-02b`), since the gate wants the FILE changed and two builds must
not share one name. Settings shows the string; a PWA updates itself in
the background, so it is the only way to tell what is installed.
Community template PRs are adopted locally like Dependabot ones, never merged
in the UI. The mechanics — workflow names, the Pages "Multiple artifacts"
trap, the template manifest and its gate — live in
[docs/publishing.md](docs/publishing.md); read it when the work IS about CI,
a release or a template PR.
