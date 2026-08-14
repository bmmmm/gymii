# gymii 🏋️

Type in your plan. Log your sets. Watch the numbers climb. Your gym draws
itself along the way.

Everything lives in your browser — no account, no backend, no tracking, not
even a cookie banner.

**→ [bmmmm.github.io/gymii](https://bmmmm.github.io/gymii/)** — installable, works offline.

## What's inside

- 🗺️ **Studio** — a real floor-plan editor: walls, zones, doors, mirrors,
  lockers, and machines you can tap. Undo/redo included. Optional: draw it
  once your gym is in there and gymii can point you at the next machine.
- 💪 **Train** — repeat a past workout in order, or roam by number, map tap or
  muscle. Last session's numbers prefill every set. Cardio stations log
  distance + time, bodyweight stations reps + extra weight, and free-weight
  areas keep separate histories per named exercise. 📍 shows where the next
  machine stands, a busy one gets the closest open alternative, and a
  coverage row tracks which muscles you've hit today.
- 📋 **Plans** — start with the plan you already have: type it in the way
  it's written (`Leg press 3x10 80`, `#7 Chest press 3x8-12 40kg`,
  `Treadmill 20min`) and gymii reads it — no gym needed yet. At the machine
  it asks once which one this is, creates it under that name, and remembers.
  Edit as a list of steppers or as plain text, whichever is faster. Then just
  tick it off: today's plan is the big start button, every set is one tap
  ("✓ Log set 2/3 — 50 kg × 10"), and the workout keeps pulling you back to
  unfinished targets. Your LLM can draft one too; paste it in for review.
- ⏱️ **Rest timer** — starts itself, remembers per machine, keeps the screen
  awake, beeps when you're up.
- 📈 **History** — training heatmap, progress chart, one-tap repeat. Name a
  workout (gymii suggests one from the muscles you trained) and one tap
  filters everything down to it. Past workouts are fully editable — add or
  remove sets and machines, fix the date — and one you trained without your
  phone can be typed in after the fact.
- 🏨 **Profiles & units** — home gym, hotel gym, whatever. kg or lbs, switched
  in one go.
- 📦 **Templates** — export your gym as JSON, import someone else's.
- 🤖 **AI, on your terms** — copy a prompt plus your data into any LLM you
  trust, paste the answer back. gymii never talks to an AI service itself.

## Run it locally

```sh
python3 serve.py   # → http://localhost:8437
```

Any static file server does the job; `serve.py` just turns caching off so edits
show up on plain reload. No build step, no dependencies, no `node_modules`.

## Your data

localStorage, under `gymii.*` keys. That's the whole story — nothing syncs
anywhere, so export a backup before you switch devices or browsers.

## Contributing

Vanilla HTML/CSS/JS (ES modules), zero dependencies. Tests: one file per
module — `node test/store.test.mjs` (same for train, studio, plan). Notes
for contributors and agents live in [AGENTS.md](AGENTS.md).

Got a floor plan of your gym? Templates are meant to be shared —
`templates/index.json` is the manifest, pull requests welcome.

---

[Homepage](https://bmmmm.github.io/gymii/) · [GPL-3.0](LICENSE) · [ko-fi](https://ko-fi.com/bmabma)
