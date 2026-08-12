# gymii 🏋️

Draw your gym. Number the machines. Log your sets. Watch the numbers climb.

Everything lives in your browser — no account, no backend, no tracking, not
even a cookie banner.

**→ [bmmmm.github.io/gymii](https://bmmmm.github.io/gymii/)** — installable, works offline.

## What's inside

- 🗺️ **Studio** — a real floor-plan editor: walls, zones, doors, mirrors,
  lockers, and machines you can tap. Undo/redo included.
- 💪 **Train** — repeat a past workout in order, or roam by number, map tap or
  muscle. Last session's numbers prefill every set.
- ⏱️ **Rest timer** — starts itself, remembers per machine, keeps the screen
  awake, beeps when you're up.
- 📈 **History** — training heatmap, progress chart, one-tap repeat.
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

Vanilla HTML/CSS/JS (ES modules), zero dependencies. Tests:
`node test/store.test.mjs`. Notes for contributors and agents live in
[AGENTS.md](AGENTS.md).

Got a floor plan of your gym? Templates are meant to be shared —
`templates/index.json` is the manifest, pull requests welcome.

---

[Homepage](https://bmmmm.github.io/gymii/) · [GPL-3.0](LICENSE) · [ko-fi](https://ko-fi.com/bmabma)
