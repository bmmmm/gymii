# Security policy

gymii is a local-first PWA: no server, no accounts, no network calls beyond
fetching its own static files. Your data lives in your browser's
`localStorage` and never leaves it unless you export it.

## Report privately

Please use GitHub's
[private vulnerability reporting](https://github.com/bmmmm/gymii/security/advisories/new)
— do not open a public issue for anything exploitable. You'll get a
response within a week.

## In scope

- **Injection through data**: anything where imported or pasted content
  (backups, gym templates, workout-plan JSON, AI answers, plan notes) can
  execute script or break out of its rendering context. All user data is
  supposed to pass through `esc()` / `.value` sinks — a path that doesn't
  is a bug we want to hear about privately.
- **Community templates**: a crafted `templates/*.json` that does more than
  describe a floor plan when loaded.
- **Service worker**: cache behaviour that lets one origin's content stand
  in for gymii's, or keeps a known-vulnerable version pinned.

## Out of scope

- Anything requiring access to the victim's device or browser profile
  (localStorage is readable by design to whoever owns the browser).
- Privacy of data the user explicitly exports or pastes into a third-party
  LLM — that flow is manual and user-controlled by design.
- Denial of service against a static GitHub Pages site.
