# TODO

Open work only — what shipped, and when, is in [CHANGELOG.md](CHANGELOG.md).

## Open

### On a real iPhone

Fifteen checks no emulator settles. All against
<https://bmmmm.github.io/gymii/>, never `serve.py`: a service worker and
"Add to Home Screen" need https, and points 2–4 put exactly those on the
stand. An expectation that fails becomes an issue labelled `bug`.

- [x] **Stepper on a focused, emptied field.** `initNumericOverwrite`
  clears a focused number field into its placeholder, and its comment
  claims `blur` fires before the stepper's click, "so +/− still see a
  value". *Do:* tap the weight field (placeholder reads "(40)"), then tap
  **+**. *Expect:* 45, not 5. Fixed: on iOS the blur is not guaranteed
  before the click, so the stepper now falls back to the value
  `initNumericOverwrite` stashed instead of reading the emptied field.
- [ ] **Beep in the background.** Start a 30 s rest, go straight to the
  Home Screen, wait. *Expect:* open — record whether the tone arrives at
  zero, arrives late, or never. The answer decides whether a notification
  is needed.
- [x] **Keyboard: the field stays centred.** Tap into the weight field,
  then the locker field, then a field at the bottom of Settings, in the
  browser AND the Home Screen app. *Expect:* each lands in the middle of
  what the keyboard leaves visible — on the log screen with the steppers
  and "✓ Log set …" in sight — and nothing jumps to the top while typing.
  `initFocusCentering` (js/ui.js) centres on `visualViewport`'s resize
  (or a late focusin settle for a field-to-field hop), reading
  `visualViewport.height`/`offsetTop` directly rather than `scrollIntoView`
  (which measures against the unshrunk LAYOUT viewport), and pads #view by
  the keyboard height so the last fields have room to rise.
  `smoke/keyboard.spec.mjs` proves the mechanism headlessly by
  stubbing `visualViewport` directly, since Chromium has no real on-screen
  keyboard to shrink it. Confirmed on a real iPhone on 2026-09-24.
- [ ] **Safe area in standalone.** Add to Home Screen, open from there.
  *Expect:* content starts below the status bar / Dynamic Island — the
  `env(safe-area-inset-top)` fix, which in a browser can only be checked
  at inset 0, where it measured the expected 12 px. No code bug found: the
  fix (commit f25e4d6) is intact and still measures exactly 12px/96px at
  inset 0 — `smoke/safe-area.spec.mjs` now pins that, plus a second case
  Chromium can newly fake via CDP (`Emulation.setSafeAreaInsetsOverride`):
  a real nonzero inset does scale in additively (71px/130px for a 59/34
  notch+indicator), proven red against a deliberately flattened rule and
  green against the real one. Left unchecked: that only proves the CSS
  math, not the WebKit/iOS Add-to-Home-Screen round trip itself — the
  actual device check this item describes is still open.
- [ ] **Scan a pairing QR with a real phone camera once** — the only step
  no automation can take; everything up to the prefilled field is
  verified. Device A shows the QR, device B's camera app scans it.
  *Expect:* gymii opens with the pairing field prefilled. Needs the
  `gymii-sync` server running.
- [ ] **Weight tapped, then Log set at once.** On the log screen tap the
  weight field and immediately tap "✓ Log set". *Expect:* the value the
  field showed is logged, not 0.
- [ ] **A finish refused by full storage.** Hard to stage on purpose; if it
  ever happens: *Expect:* the banner names the problem and the rest
  countdown keeps running (proven in Chromium by `smoke/workout.spec.mjs`).
- [ ] **Gym list editor, "+ Muscle".** Open Edit all machines, pick a muscle
  from a row's "+ Muscle", then tap a muscle chip's ✕. *Expect:* the picker
  closes once and does not reopen; the ✕ removes the muscle without popping
  any picker or keyboard.
- [ ] **A grip switch mid-set.** With the weight field focused, tap another
  grip chip. *Expect:* the keyboard stays up.
- [ ] **"+ Grip" on a machine with no grips.** On the log screen tap
  "+ Grip", pick a common grip (or type one), log a set, switch to another
  machine and back. *Expect:* the grip is selected, taught to the machine,
  and still there.
- [ ] **Twin rows.** Start a plan with `#14 Leg press 3x10 80` and
  `#14 Leg press 3x6 100`; on the overview tap the second Leg press block.
  *Expect:* "Target: 3 × 6 @ 100 kg" and "Log set 1/3 — 100 kg × 6",
  still so after a reload; after 3 sets the screen moves to the 3x10 80
  block.
- [ ] **Keyboard focus after "+N more" / "All muscles".** In History, Tab
  to either (hardware keyboard) and press Enter. *Expect:* the focus ring
  sits on the first revealed chip / the list's first row, not the page top.
- [ ] **Gym editor: label field, then a chip, no blur.** Type a label with
  a trailing space, tap a muscle chip straight away. *Expect:* the trimmed
  label is saved, never an empty one.
- [ ] **True black from the home screen.** With True black on, launch the
  Home Screen app. *Expect:* black from the first frame, no dark-grey flash
  before the app paints.
- [ ] **The issue forms, signed in.** The chooser
  (`/issues/new/choose`) should show four forms + two contact links with
  "Blank issue" as maintainers-only, and the template form must block
  submit while required fields are empty. No API can check this
  (GraphQL `issueTemplates` returns `[]` even for working YAML forms;
  the chooser is login-gated) — it needs real clicks, then close the
  test issue.

### Closed (user decision 2026-10-13)

Unbound items and the muscle filter: fine as is. Template browser filters:
the library holds one template.

The review leftovers of the 2026-10-13 round are all worked off (2026-10-13m:
twins via Next / Busy?, editor grips case-insensitive, the open card after a
foreign change, a red-capable AI-export test, a cut machine left into both
rooms). Decided: `assistGoal` is per machine and travels in gym templates
like `restSeconds`; metres and kcal stay out; a machine cut by a wall is
reached from its floor side; an editor edit beats another device's delete
(it brings the machine back); busy marks either side of midnight do not
cluster; a machine entirely outside the outline gets no walk (an editor
error); two identical blocks (same target) stay one slot. The half-unit
raster's tolerances (wall ends, slits, 1-unit lanes) are accepted.

### Review leftovers of 2026-10-13m (reviewer P2s, built on request)

- **Routing, one-sided pairs (decision).** Two tolerance bugs fixed on
  2026-10-13 (a rounding rest at a wall's end, a raster sample on it); what
  is left is structural: a walk leaves through the start's own body but
  arrives by a straight step, so a seam point with a flush neighbour or a
  corner three machines share is left and not reached — 0.2–0.4 % of pairs
  with a diagonal partition and flush machines, 0.04–0.2 % axis-aligned
  (docs/architecture.md § stats.js). A symmetric arrival changes about
  10 % of all walks (flush neighbours walk around their seam instead of
  through it) and loses a few walks. Ship that, or keep the asymmetry?
- **Gym editor, two fingers on the card** (reviewer P2, 2026-10-13n). The
  deferred card refresh ends with the first pointerup of a gesture, not
  per pointer: lifting one of two fingers lets the re-render land while
  the other finger's tap is still to come — that tap is lost once. Rare.

### 2026-10-22 — left open (review, deliberately)

- The four long render closures (`renderGym` ~1450 lines, `renderLog`,
  `renderSettingsView`, `renderPlanBuilder`) — splitting them is a refactor
  of its own, best done when a module is touched anyway.

### History — open (review findings, built on request)

- Plan "Offen", deliberately left out (user decision 2026-10-13):
  `layout.meta.scale` → metres in the path card; `settings.bodyKg` → kcal.
