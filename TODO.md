# TODO

## Plan rework — serve the "just follow my plan" user (2026-08-14)

User verdict on the current plans feature: not discoverable enough, and the
flow is too heavy for the core persona — someone who trains strictly by a
plan and only wants to log exercises fast, with zero navigation. Rework
around that persona; power features (roam, quick-switch, overview) stay but
must never be in the plan follower's way.

1. **Plan-first start screen.** When plans exist, the most relevant one
   (today's weekday match, else the most recently used) becomes THE big
   primary button ("▶ Push day · today"); "Repeat last workout" moves below
   it — and is dropped entirely when the last workout came from that same
   plan (it would be a duplicate).
2. **One-tap set logging.** On the log screen of a slot with a target, a
   single big button logs the target set as-is ("✓ 50 kg × 10") — steppers
   stay available below for deviations, but the happy path is one tap per
   set, then the rest timer.
3. **Per-set progress in the header.** "Set 2/3" for the current station
   (and plan-wide progress, e.g. "12/24 sets"), not just the slot position.
4. **Auto-advance.** When a slot's target sets are done, offer/jump to the
   next open slot right after the rest timer instead of requiring the Next
   tap. (Decide: automatic vs. one confirming tap.)

Open questions to settle with the user before building:
- Focus mode as a REDUCED screen (set + ✓ + next only, settings/chips
  hidden behind a toggle) vs. the existing log screen plus the big ✓ button?
- Auto-advance fully automatic or confirm-with-one-tap?
- Does the plan follower ever see the overview hub, or only at the end?
