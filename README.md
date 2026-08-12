# gymii

Minimal gym workout tracker as a static web app. Build a floor plan of your
gym, number the machines, log sets against them, and watch your progress —
all data stays in your browser (localStorage). No accounts, no backend, no
tracking.

**Live: <https://bmmmm.github.io/gymii/>** — installable as a PWA, works offline.

## Features

- **Studio** — a real floor-plan editor (SVG, touch + mouse, undo/redo):
  polygon floor outline with spline-style corner editing, labeled + colorable
  zones, walls, and fixtures for orientation — entrance, doors and windows
  snap onto walls (doors flip their swing/hinge side), plus reception,
  mirrors, lockers, water and trash. Machines carry number, label, muscle
  tags (tap-to-toggle chips), settings fields, a docs link and an accent
  color; a Colors/Usage toggle on the map shades machines by all-time use.
  Treadmills, rowers & co. get a cardio flag — they log distance + time
  instead of weight × reps. Pull-up bars and the like get a bodyweight
  flag (reps + optional extra weight, shown as "BW+10"), and free-weight
  areas can carry a list of named exercises (biceps curls, shoulder
  press, …) so one station keeps separate histories per movement.
- **Train** — guided workouts: repeat any past workout in its machine order
  ("Next: #5 Leg press" skips finished machines and wraps around busy ones),
  or train freely by number, map tap or muscle filter. Previous session
  values prefill every set; each set auto-starts a rest timer remembered per
  machine (±15 s, skip, beep). A workout hub shows done/open machines, holds
  your locker number, and guards Finish behind a two-tap confirm.
- **History** — monthly training heatmap (filterable per machine), an SVG
  progress chart of top-set weight, and a workout list with machine chains,
  locker numbers and one-tap repeat. Past workouts can be edited inline
  (set weights/reps, locker) or deleted behind a two-tap guard.
- **Templates** — export/import your gym as JSON ("machines are the same
  everywhere"), plus a full-backup format. The Studio has a small template
  library: `templates/index.json` is the manifest ("the database"), each
  template carries location metadata (address, city, country). Load from the
  library or from a local file; save your own gym as a shareable template.
  The long-term idea: community-contributed floor plans per country/city via
  pull requests, so you can pick your actual gym off the shelf.
- **AI exchange** — copy an editable prompt + compact data snapshot into any
  LLM you trust, and paste gymii JSON produced by the LLM back in. gymii
  deliberately never talks to an AI service itself — your data, your choice.
- **Gym profiles & units** — multiple gyms, each with its own floor plan and
  history (a home gym, a hotel gym, …); settings are shared. Metric (kg) is
  the default; switching to lbs converts all stored weights in one shot.
- **Installable & offline** — a PWA with a network-first service worker:
  online you always get the freshest code, offline the app still opens with
  your data. The rest timer holds a screen wake lock so the display stays on.

## Run locally

```sh
python3 serve.py
# open http://localhost:8437
```

Any static file server works (ES modules need http, not `file://`) —
`serve.py` just disables caching so code changes show up on plain reload.

## Data & privacy

Everything lives in localStorage under `gymii.*` keys, versioned with a `v`
field for future migrations. Export a full backup before switching devices
or browsers.

## Stack

Vanilla HTML/CSS/JS (ES modules), zero dependencies, no build step.
Logic tests: `node test/store.test.mjs`. Agent/contributor notes: `AGENTS.md`.

## Roadmap

- Community-contributed gym templates per country/city via pull requests
  (`templates/index.json` is the manifest)

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
