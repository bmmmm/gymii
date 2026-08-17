# Publishing — CI, Pages and community templates

Split out of AGENTS.md so the always-read file carries the daily rule
(push both remotes) while these mechanics load only when the work is
actually about CI, a release or a template PR. Tracked on purpose:
`.claude/` is gitignored here, so a doc there would be invisible to a
fresh clone, to CI and to cloud agents.

## CI and the Pages deploy

`.github/workflows/ci.yml` runs all logic tests (`test/*.test.mjs`) and
cross-checks the `sw.js` SHELL list against `git ls-files`, then deploys the
repo root to Pages (<https://bmmmm.github.io/gymii/>) once both pass on main.
`security.yml` (gitleaks + forbidden files + token grep) and `shellcheck.yml`
(only on `scripts/**`) round out the checkers.

The site lives on a project subpath, so every asset reference must stay
RELATIVE (`css/style.css`, not `/css/style.css`) — index.html, the manifest
and the SHELL list already are.

When a Pages deploy fails, dispatch a fresh run
(`gh workflow run ci.yml --ref main`) — never `gh run rerun --failed`. The
replay uploads a second `github-pages` artifact into the same run and
`deploy-pages` then aborts on "Multiple artifacts named github-pages", which
looks like a workflow bug and isn't.

## Community templates

`templates/index.json` is the manifest "database" (id, name, country, city,
file); `test/templates.test.mjs` is the gate — every entry must exist, import
cleanly and have ≥1 machine, and every file must be listed.

Intake is either the "Submit a gym template" issue form (non-git users paste
their export, a maintainer makes the PR) or a two-file PR
(`.github/PULL_REQUEST_TEMPLATE.md` carries the checklist); CONTRIBUTING.md
is the contributor-facing version of the same thing.

Community PRs are adopted like Dependabot ones: apply locally, gate on the
tests, push BOTH remotes, close the PR with a comment — never merge in the
GitHub UI.
