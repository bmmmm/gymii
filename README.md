# gymii 🏋️

Type in your plan. Log your sets. Watch the numbers climb. Your gym draws
itself along the way.

Everything lives in your browser — no account, no backend, no tracking, not
even a cookie banner.

**→ [bmmmm.github.io/gymii](https://bmmmm.github.io/gymii/)** — installable, works offline.

## What's inside

- 🗺️ **Studio** — a real floor-plan editor: walls, zones, doors, mirrors,
  lockers, and machines you can tap. Undo/redo included, and typing a machine
  number lights it up on the plan. Optional: draw it once your gym is in there
  and gymii can point you at the next machine.
- 💪 **Train** — repeat a past workout in order, or roam by number, map tap or
  muscle. Last session's numbers prefill every set. Cardio stations log
  distance + time, bodyweight stations reps + extra weight, and free-weight
  areas keep separate histories per named exercise. 📍 shows where the next
  machine stands, a busy one gets the closest open alternative, and a
  coverage row tracks which muscles you've hit today. Your locker number has a
  home too — noted at the start, out of the way once you're logging.
- 📋 **Plans** — start with the plan you already have: type it in the way
  it's written (`Leg press 3x10 80`, `#7 Chest press 3x8-12 40kg`,
  `Treadmill 20min`) and gymii reads it — no gym needed yet. At the machine
  it asks once which one this is, creates it under that name, and remembers.
  Edit as a list of steppers or as plain text, whichever is faster. Then just
  tick it off: today's plan is one tap on the start screen, every set is one tap
  ("✓ Log set 2/3 — 50 kg × 10"), and the workout keeps pulling you back to
  unfinished targets. Your LLM can draft one too; paste it in for review.
- 📅 **Weekdays, without the nagging** — tag a plan with the days you train
  and the start screen says what today is about: what's on, what you already
  did, or that it's a rest day and when the next one comes. A day that went
  by is stated once, never tallied, and "skip this week" settles it. gymii
  also notices when you keep training something on Tuesdays and offers to
  write that down.
- ⏱️ **Rest timer** — starts itself and remembers per machine. The screen
  stays awake (just the break, or the whole workout — your call) and dims
  itself so a dark gym stays dark: the countdown ticks one brighter beat per
  second, any touch brings it back, and the last seconds are bright again.
  Four tones to pick from, each one audible before you commit — and they play
  like music, so an iPhone's silent switch doesn't swallow them.
- 📈 **History** — training heatmap, progress chart, one-tap repeat. Name a
  workout (gymii suggests one from the muscles you trained) and one tap
  filters everything down to it. A muscle card shows how many sets each
  group got — tap a row and the whole view narrows to that muscle, neglected
  groups collect at the bottom. Past workouts are fully editable — add or
  remove sets and machines, fix the date — and one you trained without your
  phone can be typed in after the fact.
- 🏨 **Profiles & units** — home gym, hotel gym, whatever. kg or lbs, switched
  in one go.
- 📦 **Templates** — export your gym as JSON, import someone else's. Want to
  poke around first? Settings → "Load test data" fills a separate Demo gym
  with eight weeks of history and three plans — your own gyms stay untouched.
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

Vanilla HTML/CSS/JS (ES modules), zero dependencies. Tests are plain `node`,
no runner — `for f in test/*.test.mjs; do node "$f"; done`. Notes for
contributors and agents live in [AGENTS.md](AGENTS.md).

Got a floor plan of your gym? Templates are meant to be shared — export it
(Settings → Export gym template) and either open a
[Submit a gym template](https://github.com/bmmmm/gymii/issues/new?template=01-gym-template.yml)
issue (no git needed, paste the JSON) or send a two-file PR against
`templates/`. Details in [CONTRIBUTING.md](CONTRIBUTING.md); CI validates
every template against the app's real import path.

---

[Homepage](https://bmmmm.github.io/gymii/) · [GPL-3.0](LICENSE) · [ko-fi](https://ko-fi.com/bmabma)
