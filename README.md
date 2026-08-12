# gymii

Minimal gym workout tracker as a static web app. Build a floor plan of your
gym, number the machines, log sets against them, and watch your progress —
all data stays in your browser (localStorage). No accounts, no backend, no
tracking.

## Features

- **Studio** — draw your gym: rooms, walls and numbered machines on a snapped
  grid (SVG editor, touch + mouse). Each machine can carry settings fields
  (seat height, pad position, …) that are logged with every workout.
- **Train** — repeat the last workout (same machine order) or train freely by
  machine number / map tap. The previous session's values prefill every set;
  logging a set auto-starts a configurable rest timer (±15 s, skip, beep).
- **History** — workout list with per-machine details and an SVG chart of
  top-set weight over time.
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

## Roadmap

- GitHub Pages deploy (CI workflow)
- PWA/offline manifest, wake lock during the rest timer
- Multiple gym profiles, lbs support, polygon floor outlines
- Delete/edit workouts in history
