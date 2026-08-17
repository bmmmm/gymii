<!-- One heads-up before anything else: GitHub is a MIRROR of this repo.
     Your PR is welcome — it gets reviewed here, then adopted into the
     source-of-truth repo and pushed back, so it may land rebased with you
     as author rather than via the merge button. -->

## Adding a gym template?

Then this PR should touch **exactly two files** — your `templates/<id>.json`
and one entry in `templates/index.json` — and nothing else (in particular
not `sw.js`; templates are cached on demand). Check these, delete the rest
of this template, done:

- [ ] The template file is an unmodified **Settings → Export gym template** export
- [ ] `templates/index.json` gained one entry (unique `id`, `name`, `country`, `city`, `file`)
- [ ] `node test/templates.test.mjs` passes locally

## Claims

<!-- One bullet per user-visible behaviour change, `symbols`/`files` in
     backticks, issues as #N — written so a reviewer can check each claim
     against the diff instead of inferring intent. -->

-

## Verification

<!-- Paste real command output. "Should work" is not verification. -->

```
for f in test/*.test.mjs; do node "$f" || break; done
```

## Tests

<!-- Name the specific test covering this change, and confirm it fails
     without the change (run it against main if in doubt). -->

- Test:
- [ ] It goes red without this change

## Public contracts

<!-- gymii's compatibility promises. Tick what this PR keeps true. -->

- [ ] Old export files still import: `gym-template`, `backup`, `workout-plan` and the AI answer shapes are backwards compatible (or a read-time migration handles them)
- [ ] `localStorage` under `gymii.*` keeps loading for existing users (schema changes migrate on read, like profiles did)
- [ ] `templates/index.json` keeps its manifest shape (`id`, `name`, `country`, `city`, `file`)
- [ ] Any NEW runtime asset (js/css/icons, not templates) is in the `sw.js` SHELL list — CI checks this, but it breaks offline-only, so think about it here

## Out of scope

<!-- What this PR deliberately does not do, so nobody reviews it for that. -->

-

## AI assistance

- [ ] I reviewed every line of this diff and can explain it
- [ ] I ran the verification commands myself
