// The shared floor map. `drawLayout()` paints a layout into an SVG for the Gym
// editor, the Train mini-maps/overlay and the plan builder alike, together
// with the fixture registry, the SVG symbol builders and the geometry and
// collision helpers all three surfaces share. Nothing here imports the
// editor: the dependency runs one way, gym.js -> map.js.
import { esc } from './ui.js';

// Map furniture beyond machines. Entrances, doors and windows snap onto
// the nearest wall and render as floor-plan symbols; the rest are boxes.
export const FIXTURES = {
  entrance: { icon: '🚶', label: 'Entrance', w: 3.6, h: 1.2 },
  door: { icon: '🚪', label: 'Door', w: 2.4, h: 1.2 },
  window: { icon: '🪟', label: 'Window', w: 4, h: 1 },
  counter: { icon: '🛎️', label: 'Reception', w: 5, h: 2 },
  mirror: { icon: '🪞', label: 'Mirror', w: 6, h: 1 },
  locker: { icon: '🔒', label: 'Lockers', w: 3, h: 2 },
  water: { icon: '🚰', label: 'Water', w: 2, h: 2 },
  trash: { icon: '🗑️', label: 'Trash', w: 2, h: 2 },
};

export const WALL_SNAPPED = new Set(['entrance', 'door', 'window']);

// Item accent colors — categorical palette validated (dataviz checks)
// against surface #171c22; identity never rides on color alone (machines
// carry numbers, zones carry labels), which covers the deutan WARN band.
export const ITEM_COLORS = [
  '#35a273', '#bf5f9f', '#3f7fd1', '#c08327', '#22a8b0', '#c65454', '#ab5fd6',
];

// All wall segments a door can live on: outline edges + interior walls.
function wallSegments(layout) {
  const segments = [];
  const o = layout.outline || [];
  for (let i = 0; i < o.length; i++) {
    segments.push([o[i], o[(i + 1) % o.length]]);
  }
  layout.shapes.filter((s) => s.kind === 'line').forEach((l) => {
    segments.push([{ x: l.x, y: l.y }, { x: l.x + l.w, y: l.y + l.h }]);
  });
  return segments;
}

// Projects the door's center onto the nearest wall segment and aligns
// its rotation with that wall.
export function snapDoorToWall(layout, door) {
  const cx = door.x + door.w / 2;
  const cy = door.y + door.h / 2;
  let best = null;
  wallSegments(layout).forEach(([a, b]) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (!len2) return;
    const t = clamp(((cx - a.x) * dx + (cy - a.y) * dy) / len2, 0, 1);
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const d2 = (px - cx) ** 2 + (py - cy) ** 2;
    if (!best || d2 < best.d2) {
      best = { px, py, d2, angle: Math.round((Math.atan2(dy, dx) * 180) / Math.PI) };
    }
  });
  if (!best) return;
  door.x = Math.round((best.px - door.w / 2) * 10) / 10;
  door.y = Math.round((best.py - door.h / 2) * 10) / 10;
  door.rot = best.angle;
}

const SNAP = 1;
export const snap = (v) => Math.round(v / SNAP) * SNAP;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The floor outline is a singleton, addressed by this pseudo item id.
export const OUTLINE_ID = 'outline';

// Editor touch targets are sized in real CSS px (see pxPerUnit), not grid
// units, so they stay finger-sized regardless of grid size and window
// width. Values follow the ~44px mobile touch-target guideline.
const HANDLE_VISIBLE_PX = 26; // resize-handle icon diameter
const HANDLE_HIT_PX = 44; // resize-handle invisible tap circle
const VERTEX_VISIBLE_PX = 20; // outline corner square
const VERTEX_HIT_PX = 40;
const MID_VISIBLE_PX = 14; // outline midpoint dot
const MID_HIT_PX = 36;
const ITEM_MIN_HIT_PX = 44; // minimum tap area for small items
const WALL_HIT_PX = 28; // tap strip across walls/doors — full 44 would swallow neighbors

// Assumed phone-ish width used only while the SVG can't be measured yet
// (e.g. a hidden container) — self-corrects on the next redraw.
const ASSUMED_SVG_PX = 340;

function pxPerUnit(svg, viewBoxWidth) {
  const width = svg.getBoundingClientRect().width || ASSUMED_SVG_PX;
  return width / viewBoxWidth;
}

// --- shared renderer (also used by the Train mini-map) ---

export function drawLayout(svg, layout, {
  selectedId = null, editor = false, selectedVertex = null, usage = null,
  highlightId = null, unlockedId = null,
} = {}) {
  // Margin around the floor: outline handles and wall-snapped fixtures
  // straddle the boundary — without it they are clipped and only
  // half-tappable exactly where the SVG ends. The viewer needs just
  // enough to not clip doors/windows; the editor needs finger room.
  const pad = editor ? 2.5 : 1;
  const vw = layout.grid.w + 2 * pad;
  const vh = layout.grid.h + 2 * pad;
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${vw} ${vh}`);
  svg.style.aspectRatio = `${vw} / ${vh}`;
  const selected = selectedId && selectedId !== OUTLINE_ID ? findItem(layout, selectedId) : null;
  // px-per-unit only matters for editor touch targets — skip the layout
  // measurement for the read-only Train mini-map.
  const ppu = editor ? pxPerUnit(svg, vw) : 1;
  // small free-standing items get invisible tap padding; wall-snapped
  // fixtures and wall lines keep their own .hit shapes
  const padded = editor
    ? [...layout.shapes.filter((s) => s.kind !== 'line' && !WALL_SNAPPED.has(s.fixture)), ...layout.machines]
    : [];
  // the outline's tap target sits ABOVE zones/walls (which often touch the
  // outer wall) but below wall-snapped fixtures (doors/windows live ON the
  // outline — under it they'd be impossible to tap), machines and the
  // editing handles; tap pads sit below the machines so a visible machine
  // always wins hit-testing over a neighbor's padding
  const wallPieces = layout.shapes.filter((s) => WALL_SNAPPED.has(s.fixture));
  // Stacking order comes from each shape's own `z` (store's MAP_LAYERS),
  // never from the array order — mergeById hands its items back in
  // unspecified order, so array order does not survive a sync. Sort is
  // stable, so shapes sharing a layer keep the order they were created in.
  // Machines are deliberately NOT in here: fits() keeps them from ever
  // overlapping, and their number has to stay readable above everything.
  const floorPieces = layout.shapes
    .filter((s) => !WALL_SNAPPED.has(s.fixture))
    .sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const shapePpu = editor ? ppu : null;
  svg.innerHTML =
    outlineFloorSvg(layout.outline) +
    (editor ? gridSvg(layout.grid) : '') +
    floorPieces.map((s) => shapeSvg(s, shapePpu)).join('') +
    (editor ? outlineHitSvg(layout.outline) : '') +
    wallPieces.map((s) => shapeSvg(s, shapePpu)).join('') +
    (editor ? hitPadSvg(padded, ppu) : '') +
    layout.machines.map((m) => machineSvg(m, usage, highlightId)).join('') +
    (editor && selected
      ? selectionSvg(selected, ppu, layout.grid, pad, unlockedId === selected.id) : '') +
    // the floor outline locks like every item: its corner handles only
    // appear once it has been double-tapped
    (editor && selectedId === OUTLINE_ID && unlockedId === OUTLINE_ID
      ? outlineHandlesSvg(layout.outline, selectedVertex, ppu, layout.grid, pad) : '');
}

// Builds the usage payload for drawLayout from all-time set counts.
export function usagePayload(counts) {
  return { counts, max: Math.max(1, ...counts.values()) };
}

const outlinePath = (outline) => `M${outline.map((p) => `${p.x} ${p.y}`).join('L')}Z`;

function outlineFloorSvg(outline) {
  if (!Array.isArray(outline) || outline.length < 3) return '';
  return `<path class="outline-floor" d="${outlinePath(outline)}" pointer-events="none"/>`;
}

function outlineHitSvg(outline) {
  if (!Array.isArray(outline) || outline.length < 3) return '';
  return `<path class="hit" data-id="${OUTLINE_ID}" d="${outlinePath(outline)}" fill="none"/>`;
}

// Corner handles plus hollow midpoint dots that insert a new corner.
// Visible markers stay exactly on the true corner/midpoint (they ARE the
// geometry); only the invisible hit shapes' centers clamp into the padded
// viewBox so corners on the floor boundary stay fully tappable. Vertex
// hits render last and therefore win over midpoint hits nearby.
function outlineHandlesSvg(outline, selectedVertex, ppu, grid, pad) {
  const midVisR = MID_VISIBLE_PX / ppu / 2;
  const midHitR = MID_HIT_PX / ppu / 2;
  const vertVis = VERTEX_VISIBLE_PX / ppu;
  const vertHit = VERTEX_HIT_PX / ppu;
  const clampX = (x, r) => clamp(x, r - pad, grid.w + pad - r);
  const clampY = (y, r) => clamp(y, r - pad, grid.h + pad - r);
  const mids = outline.map((p, i) => {
    const q = outline[(i + 1) % outline.length];
    const cx = (p.x + q.x) / 2;
    const cy = (p.y + q.y) / 2;
    return `<circle class="tap-hit mid-hit" data-mid="${i}"
        cx="${clampX(cx, midHitR)}" cy="${clampY(cy, midHitR)}" r="${midHitR}"/>
      <circle class="midpoint" cx="${cx}" cy="${cy}" r="${midVisR}" pointer-events="none"/>`;
  }).join('');
  const verts = outline.map((p, i) => {
    const hx = clampX(p.x, vertHit / 2);
    const hy = clampY(p.y, vertHit / 2);
    return `<rect class="tap-hit vertex-hit" data-vertex="${i}"
        x="${hx - vertHit / 2}" y="${hy - vertHit / 2}" width="${vertHit}" height="${vertHit}"/>
      <rect class="vertex${i === selectedVertex ? ' sel' : ''}" pointer-events="none"
        x="${p.x - vertVis / 2}" y="${p.y - vertVis / 2}" width="${vertVis}" height="${vertVis}"
        rx="${vertVis * 0.18}"/>`;
  }).join('');
  return mids + verts;
}

export function findMachineByNum(layout, num) {
  return layout.machines.find((m) => m.num === num) || null;
}

export function findItem(layout, id) {
  return layout.machines.find((m) => m.id === id) || layout.shapes.find((s) => s.id === id) || null;
}

// Machines and free-standing fixtures (reception, lockers, trash, …) are
// solid furniture nothing may overlap. Zones are areas items stand IN,
// wall pieces live ON walls — neither is solid.
const isSolid = (it) => !it.kind || (it.kind === 'fixture' && !WALL_SNAPPED.has(it.fixture));

// Axis-aligned overlap between a proposed box and any solid item other
// than `item`. Edge-to-edge contact is fine (strict inequalities).
export function overlapsSolid(layout, item, x, y, w, h) {
  return [...layout.machines, ...layout.shapes.filter(isSolid)].some((m) => m !== item
    && x < m.x + m.w && x + w > m.x && y < m.y + m.h && y + h > m.y);
}

// Whether an item may occupy the proposed box. Only solid items are
// exclusive — and only when they start from a non-overlapping spot, so
// layouts saved before this rule stay fully editable and can be
// untangled.
export function fits(layout, it, x, y, w, h) {
  if (!isSolid(it)) return true;
  if (overlapsSolid(layout, it, it.x, it.y, it.w, it.h)) return true;
  return !overlapsSolid(layout, it, x, y, w, h);
}

// Placement for a new solid item: the preferred position if free, else
// the nearest non-overlapping spot so new items line up next to existing
// ones; a packed floor falls back to the preferred spot (overlapping
// beats refusing to add).
export function freeSpot(layout, x, y, w, h) {
  if (!overlapsSolid(layout, null, x, y, w, h)) return { x, y };
  let best = null;
  for (let sy = 0; sy + h <= layout.grid.h; sy += SNAP) {
    for (let sx = 0; sx + w <= layout.grid.w; sx += SNAP) {
      if (overlapsSolid(layout, null, sx, sy, w, h)) continue;
      const d = (sx - x) ** 2 + (sy - y) ** 2;
      if (!best || d < best.d) best = { x: sx, y: sy, d };
    }
  }
  return best ? { x: best.x, y: best.y } : { x, y };
}

function gridSvg(grid) {
  let d = '';
  for (let x = 0; x <= grid.w; x += 5) d += `M${x} 0V${grid.h}`;
  for (let y = 0; y <= grid.h; y += 5) d += `M0 ${y}H${grid.w}`;
  return `<path class="grid-line" d="${d}" pointer-events="none"/>`;
}

// ppu is set in the editor (finger-sized, px-based hit strips) and null
// in the read-only mini-map, which keeps the old fixed-unit hit sizes.
function shapeSvg(s, ppu = null) {
  if (s.kind === 'line') {
    const x2 = s.x + s.w;
    const y2 = s.y + s.h;
    // second, invisible fat line makes thin walls tappable; the inline
    // stroke-width overrides the .hit default from the stylesheet
    const hitStroke = ppu ? ` stroke-width="${WALL_HIT_PX / ppu}"` : '';
    return `<g class="shape" data-id="${s.id}">
      <line class="shape-line" x1="${s.x}" y1="${s.y}" x2="${x2}" y2="${y2}"/>
      <line class="hit" x1="${s.x}" y1="${s.y}" x2="${x2}" y2="${y2}"${hitStroke}/>
    </g>`;
  }
  if (s.kind === 'fixture') {
    if (s.fixture === 'door') return doorSvg(s, ppu);
    if (s.fixture === 'entrance') return entranceSvg(s, ppu);
    if (s.fixture === 'window') return windowSvg(s, ppu);
    const icon = FIXTURES[s.fixture]?.icon ?? '❓';
    const fs = clamp(Math.min(s.w, s.h) * 0.7, 0.8, 2.2);
    return `<g class="shape" data-id="${s.id}">
      <rect class="fixture-box" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="0.3"/>
      <text class="fixture-icon" x="${s.x + s.w / 2}" y="${s.y + s.h / 2}" font-size="${fs}"
        text-anchor="middle" dominant-baseline="central" pointer-events="none">${icon}</text>
    </g>`;
  }
  const zoneStyle = s.color
    ? ` style="fill:${s.color};fill-opacity:0.13;stroke:${s.color};stroke-opacity:0.55"` : '';
  return `<g class="shape" data-id="${s.id}">
    <rect class="shape-rect" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="0.3"${zoneStyle}/>
    ${s.label ? `<text class="zone-label" x="${s.x + 1}" y="${s.y + 2.1}" font-size="1.4"
      pointer-events="none">${esc(s.label)}</text>` : ''}
  </g>`;
}

function machineSvg(m, usage = null, highlightId = null) {
  const fs = clamp(Math.min(m.w, m.h) * 0.55, 1.2, 2.4);
  let box = ''; // style-attribute body of the rect
  let numStyle = '';
  if (usage) {
    // sequential green ramp by all-time sets; unused machines fade out
    const sets = usage.counts.get(m.id) || 0;
    if (!sets) {
      box = 'fill:#1c232c;stroke:#38424e';
      numStyle = ' style="fill:#5f6d7d"';
    } else {
      const t = sets / usage.max;
      const c = t > 0.75 ? '#35a273' : t > 0.5 ? '#2c7d55' : t > 0.25 ? '#23593f' : '#183b2b';
      box = `fill:${c};stroke:${c}`;
      if (t > 0.75) numStyle = ' style="fill:#06130c"';
    }
  } else if (m.color) {
    box = `fill:${m.color};stroke:${m.color}`;
    numStyle = ' style="fill:#0c1116"';
  }
  // "where is it?" highlight: the target carries .locate (CSS pulses its
  // stroke) and an inline white stroke so it wins over custom colors set
  // just above; every other machine dims
  const locate = highlightId != null && m.id === highlightId;
  if (locate) box += `${box ? ';' : ''}stroke:#fff`;
  const dim = highlightId != null && !locate ? ' opacity="0.35"' : '';
  return `<g class="machine${locate ? ' locate' : ''}" data-id="${m.id}"${dim}>
    <rect class="machine-box" x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" rx="0.4"${box ? ` style="${box}"` : ''}/>
    <text class="machine-num" x="${m.x + m.w / 2}" y="${m.y + m.h / 2}" font-size="${fs}"
      text-anchor="middle" dominant-baseline="central" pointer-events="none"${numStyle}>${m.num}</text>
  </g>`;
}

// Invisible tap padding for items smaller than the touch-target guideline.
// Must be painted in its own layer BEFORE the visible machines (see
// drawLayout) so a tap on any visible machine always resolves to that
// machine, never to a neighbor's padding; padding only catches taps on
// otherwise-empty floor near a small item.
function hitPadSvg(items, ppu) {
  const minSize = ITEM_MIN_HIT_PX / ppu;
  return items.map((it) => {
    const b = bbox(it);
    if (b.w >= minSize && b.h >= minSize) return '';
    const w = Math.max(b.w, minSize);
    const h = Math.max(b.h, minSize);
    return `<rect class="tap-hit" data-id="${it.id}"
      x="${b.x + (b.w - w) / 2}" y="${b.y + (b.h - h) / 2}" width="${w}" height="${h}"/>`;
  }).join('');
}

// Tap rect for a wall-snapped fixture, centered on the piece in its
// local (unrotated) frame: finger-sized in the editor, the old fixed
// strip in the mini-map. Uses the fill-based tap-hit class — a
// stroke-based .hit rect this large would only be hittable on its rim.
function wallHitSvg(s, ppu) {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const w = ppu ? Math.max(s.w, ITEM_MIN_HIT_PX / ppu) : s.w;
  const h = ppu ? WALL_HIT_PX / ppu : 2.6;
  return `<rect class="tap-hit" x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}"/>`;
}

// Classic floor-plan door: a gap punched through the wall stroke, a
// door leaf, and its dashed swing arc. Rotated to match the wall.
function doorSvg(s, ppu) {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const w = s.w;
  const hx = cx - w / 2; // hinge
  // flipH mirrors the hinge side, flipV the swing side; both happen in the
  // door's local (unrotated) frame, then the wall rotation applies
  const fx = s.flipH ? -1 : 1;
  const fy = s.flipV ? -1 : 1;
  return `<g class="shape" data-id="${s.id}" transform="rotate(${s.rot || 0} ${cx} ${cy})
      translate(${cx} ${cy}) scale(${fx} ${fy}) translate(${-cx} ${-cy})">
    ${wallHitSvg(s, ppu)}
    <rect class="door-gap" x="${hx}" y="${cy - 0.4}" width="${w}" height="0.8"/>
    <path class="door-arc" d="M ${hx} ${cy - w} A ${w} ${w} 0 0 1 ${cx + w / 2} ${cy}"/>
    <line class="door-leaf" x1="${hx}" y1="${cy}" x2="${hx}" y2="${cy - w}"/>
  </g>`;
}

// Entrance: a wide wall opening with an inward arrow. flipV points it
// the other way when the inside is on the other side of the wall.
function entranceSvg(s, ppu) {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const fy = s.flipV ? -1 : 1;
  return `<g class="shape" data-id="${s.id}" transform="rotate(${s.rot || 0} ${cx} ${cy})
      translate(${cx} ${cy}) scale(1 ${fy}) translate(${-cx} ${-cy})">
    ${wallHitSvg(s, ppu)}
    <rect class="door-gap" x="${s.x}" y="${cy - 0.45}" width="${s.w}" height="0.9"/>
    <path class="entrance-arrow" d="M ${cx} ${cy + 1.7} L ${cx} ${cy - 1.3}
      M ${cx - 0.7} ${cy - 0.5} L ${cx} ${cy - 1.3} L ${cx + 0.7} ${cy - 0.5}"/>
  </g>`;
}

// Window: the classic double line inside the wall stroke.
function windowSvg(s, ppu) {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  return `<g class="shape" data-id="${s.id}" transform="rotate(${s.rot || 0} ${cx} ${cy})">
    ${wallHitSvg(s, ppu)}
    <rect class="window-gap" x="${s.x}" y="${cy - 0.35}" width="${s.w}" height="0.7"/>
    <line class="window-line" x1="${s.x}" y1="${cy - 0.18}" x2="${s.x + s.w}" y2="${cy - 0.18}"/>
    <line class="window-line" x1="${s.x}" y1="${cy + 0.18}" x2="${s.x + s.w}" y2="${cy + 0.18}"/>
  </g>`;
}

function bbox(item) {
  return {
    x: Math.min(item.x, item.x + item.w),
    y: Math.min(item.y, item.y + item.h),
    w: Math.abs(item.w),
    h: Math.abs(item.h),
  };
}

// `unlocked` is the double-tap arming. Everything on the map starts LOCKED:
// a selected item shows a dashed outline and nothing else, and gym.js
// refuses to drag it at all. On a phone a tap that drifts a few pixels used
// to shove a whole zone across the floor, and the resize handle sat exactly
// where the thumb grabs an item. One deliberate double tap unlocks THAT
// item — solid outline, resize handle, draggable — see gym.js's
// `unlockedId`. Wall pieces glue to a wall and have no handle, but they get
// the same lock treatment (and the same visual tell).
function selectionSvg(item, ppu, grid, pad, unlocked = false) {
  const cls = `selected-outline${unlocked ? ' unlocked' : ''}`;
  if (WALL_SNAPPED.has(item.fixture)) { // wall pieces rotate along and have no resize handle
    const cx = item.x + item.w / 2;
    const cy = item.y + item.h / 2;
    return `<rect class="${cls}" x="${item.x - 0.4}" y="${cy - 1.2}"
      width="${item.w + 0.8}" height="2.4" pointer-events="none"
      transform="rotate(${item.rot || 0} ${cx} ${cy})"/>`;
  }
  const b = bbox(item);
  const outline = `<rect class="${cls}" x="${b.x - 0.4}" y="${b.y - 0.4}"
    width="${b.w + 0.8}" height="${b.h + 0.8}" pointer-events="none"/>`;
  if (!unlocked) return outline;
  const visR = HANDLE_VISIBLE_PX / ppu / 2;
  const hitR = HANDLE_HIT_PX / ppu / 2;
  // Clamp the handle center (visible + hit together — it is a UI
  // affordance, not real geometry) into the padded viewBox so items flush
  // against the floor edge keep a fully visible, fully tappable handle;
  // anything beyond is clipped by .floor-wrap's overflow:hidden.
  const hx = clamp(item.x + item.w, hitR - pad, grid.w + pad - hitR);
  const hy = clamp(item.y + item.h, hitR - pad, grid.h + pad - hitR);
  const a = visR * 0.5; // diagonal arrow half-length
  const t = visR * 0.32; // arrowhead tick length
  return `${outline}
    <circle class="tap-hit handle-hit" data-id="${item.id}" data-handle="1"
      cx="${hx}" cy="${hy}" r="${hitR}"/>
    <circle class="handle" cx="${hx}" cy="${hy}" r="${visR}"
      pointer-events="none" stroke-width="${visR * 0.08}"/>
    <path class="handle-icon" pointer-events="none" stroke-width="${visR * 0.16}"
      d="M${hx - a} ${hy - a} L${hx + a} ${hy + a}
         M${hx - a} ${hy - a + t} V${hy - a} H${hx - a + t}
         M${hx + a} ${hy + a - t} V${hy + a} H${hx + a - t}"/>`;
}
