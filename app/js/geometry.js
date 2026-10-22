// Placement geometry for solid items on the floor map. Pure: no imports,
// no storage. store.js's addMachine places machines with it (quick start,
// the picker's create-on-miss) and map.js re-exports it for the editor —
// one rule, every caller.

// Fixtures that snap onto the nearest wall and render as floor-plan symbols.
export const WALL_SNAPPED = new Set(['entrance', 'door', 'window']);

// Machines and free-standing fixtures (reception, lockers, trash, …) are
// solid furniture nothing may overlap. Zones are areas items stand IN,
// wall pieces live ON walls — neither is solid.
export const isSolid = (it) => !it.kind || (it.kind === 'fixture' && !WALL_SNAPPED.has(it.fixture));

// Axis-aligned overlap between a proposed box and any solid item other
// than `item`. Edge-to-edge contact is fine (strict inequalities).
export function overlapsSolid(layout, item, x, y, w, h) {
  return [...layout.machines, ...layout.shapes.filter(isSolid)].some((m) => m !== item
    && x < m.x + m.w && x + w > m.x && y < m.y + m.h && y + h > m.y);
}

// The editor's snapping step, in grid units — map.js's snap() rounds to it
// and freeSpot steps by it, so a placed item lands where a drag would.
export const SNAP = 1;

// Placement for a new solid item: the preferred position if free, else
// the nearest non-overlapping spot (whole SNAP steps) so new
// items line up next to existing ones. A packed floor overlaps rather than
// refusing to add — but never on the exact spot of another solid item,
// where one would hide the other: the preferred spot if that is clear of
// such a twin, else the nearest one that is.
export function freeSpot(layout, x, y, w, h) {
  if (!overlapsSolid(layout, null, x, y, w, h)) return { x, y };
  const solids = [...layout.machines, ...layout.shapes.filter(isSolid)];
  const taken = (sx, sy) => solids.some((m) => m.x === sx && m.y === sy);
  let best = null;
  let loose = taken(x, y) ? null : { x, y, d: 0 };
  for (let sy = 0; sy + h <= layout.grid.h; sy += SNAP) {
    for (let sx = 0; sx + w <= layout.grid.w; sx += SNAP) {
      const d = (sx - x) ** 2 + (sy - y) ** 2;
      if (!overlapsSolid(layout, null, sx, sy, w, h)) {
        if (!best || d < best.d) best = { x: sx, y: sy, d };
      } else if (!taken(sx, sy) && (!loose || d < loose.d)) loose = { x: sx, y: sy, d };
    }
  }
  const spot = best ?? loose ?? { x, y };
  return { x: spot.x, y: spot.y };
}
