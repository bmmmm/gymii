# Contributing to gymii

Two very different contributions land here: **gym templates** (no code, no
git skills needed) and **code**. Both are welcome.

## Share your gym template

The template library (`Studio → template library` in the app) is community
fed. Two ways in:

**Without git** — open a
[Submit a gym template](https://github.com/bmmmm/gymii/issues/new?template=01-gym-template.yml)
issue: export your gym in the app (**Settings → Export gym template**),
paste the JSON, name city and country. A maintainer turns it into a PR.

**As a PR** — exactly two files:

1. Add your export as `templates/<id>.json` (pick a short kebab-case id).
2. Add one entry to `templates/index.json`:
   `{"id", "name", "country", "city", "file"}` — country as a two-letter
   code, `file` as `templates/<id>.json`.
3. Run `node test/templates.test.mjs` — it validates the manifest against
   the files and every template against the app's real import validation.

Do **not** touch `sw.js`: template files are on-demand content the service
worker caches when first loaded; only the manifest is precached.

Templates are published under this repo's license (GPL-3.0). Please only
submit layouts you're comfortable sharing publicly, and keep machine
numbers matching what's physically posted in the gym.

## Code contributions

Vanilla HTML/CSS/JS (ES modules), **no build step, no dependencies** — that
is a feature, not an accident. Two more deliberate non-goals: no
accounts/sync/server (data lives in `localStorage` only), and no AI API
calls (the AI tab is copy out / paste back, by design).

- **Run tests:** `for f in test/*.test.mjs; do node "$f" || break; done` —
  one file per module, plain `node:assert`, no framework. CI runs the same
  glob, so a new module's tests need no workflow edit.
- **Module map and conventions:** [AGENTS.md](AGENTS.md) — written for
  coding agents, equally useful for humans: what each module owns, the
  invariants (chronological workouts, filter-narrows-whole-workouts,
  two-tap confirms), and the traps.
- **Compatibility promises** (the PR template asks about these): old export
  files keep importing (`gym-template`, `backup`, `workout-plan`), existing
  `gymii.*` localStorage keeps loading (migrate on read), the template
  manifest keeps its shape, and every new runtime asset goes into the
  `sw.js` SHELL list (CI enforces it; missing entries break offline only).

### Why the issue forms ask what they ask

- **Bug** — the hard-reload question is the router: gymii is an installed
  offline app, so "the service worker served you a stale version" and "the
  current version is wrong" are different fixes. Exact pasted input matters
  because the plan-note/AI parsers live and die by exact characters.
- **Template submission** — the "I imported it back myself" checkbox is the
  difference between an app export and hand-edited JSON; CI validates the
  rest mechanically.

### Mirror note

GitHub is a mirror; the source of truth is a private remote. PRs are
reviewed here, then adopted locally and pushed to both remotes — your
change may land rebased (with you as author) instead of through the merge
button. Nothing you need to do differently; just don't be surprised.
