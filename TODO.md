# TODO

- [ ] Set timestamps: stamp `at` (epoch ms) onto every set at log time — the
      raw source for rest gaps, station-switch times and muscle-group
      density. No extra tracking events: everything derives from set times.
      Old sets lack `at`, every consumer must guard.
- [ ] Superset quick-switch (builds on set timestamps): the log screen only
      offers "Next:" (skips done stations) — alternating two stations
      (triceps curls ↔ back extension, 3 rounds) costs an overview detour
      per switch. Add chips for the most recently trained OTHER stations
      (by newest set `at`, excluding current, max 2) next to the Next
      button: one tap to swing back; also covers 3-station circuits.
- [ ] AI coach with timing (builds on set timestamps): export per-set times
      as compact offsets from startedAt and teach the ai.js prompt to read
      them — flag same-muscle-group sets spaced too closely (join
      machine.muscles from the gym data), UNLESS the alternation pattern
      looks deliberate (superset/circuit: consistent A↔B rhythm); comment
      on idle gaps between stations and overall workout density.
- [ ] Optional workout names — named routines beat chain-derived rows on the
      start screen once chains collide (same machines, different exercises).
