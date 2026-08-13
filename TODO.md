# TODO

- [ ] Guided repeat at multi-exercise stations: carry (machineId, exercise)
      pairs from the source workout so "Next:" walks every exercise, not just
      the station. Today the chips show a ✓ per logged exercise, but the
      station counts as done after the first one.
- [ ] Optional workout names — named routines beat chain-derived rows on the
      start screen once chains collide (same machines, different exercises).
- [ ] renderLog readability: extract entry resolution (resolveEntry helper)
      the next time a real change touches it (~240 lines today).
