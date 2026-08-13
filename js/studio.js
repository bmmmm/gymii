import {
  getGym, saveGym, newGym, uid, importData, defaultOutline, exportGymTemplate,
  getSettings, saveSettings, usageByMachine,
  MUSCLE_GROUPS, COMMON_SETTINGS, ZONE_LABELS,
} from './store.js';
import { esc, download, twoTapConfirm } from './ui.js';

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

const WALL_SNAPPED = new Set(['entrance', 'door', 'window']);

// Item accent colors — categorical palette validated (dataviz checks)
// against surface #171c22; identity never rides on color alone (machines
// carry numbers, zones carry labels), which covers the deutan WARN band.
export const ITEM_COLORS = [
  '#35a273', '#bf5f9f', '#3f7fd1', '#c08327', '#22a8b0', '#c65454', '#ab5fd6',
];

// All wall segments a door can live on: outline edges + interior walls.
function wallSegments(gym) {
  const segments = [];
  const o = gym.outline || [];
  for (let i = 0; i < o.length; i++) {
    segments.push([o[i], o[(i + 1) % o.length]]);
  }
  gym.shapes.filter((s) => s.kind === 'line').forEach((l) => {
    segments.push([{ x: l.x, y: l.y }, { x: l.x + l.w, y: l.y + l.h }]);
  });
  return segments;
}

// Projects the door's center onto the nearest wall segment and aligns
// its rotation with that wall.
function snapDoorToWall(gym, door) {
  const cx = door.x + door.w / 2;
  const cy = door.y + door.h / 2;
  let best = null;
  wallSegments(gym).forEach(([a, b]) => {
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
const snap = (v) => Math.round(v / SNAP) * SNAP;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The floor outline is a singleton, addressed by this pseudo item id.
const OUTLINE_ID = 'outline';

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

// Assumed phone-ish width used only while the SVG can't be measured yet
// (e.g. a hidden container) — self-corrects on the next redraw.
const ASSUMED_SVG_PX = 340;

function pxPerUnit(svg, viewBoxWidth) {
  const width = svg.getBoundingClientRect().width || ASSUMED_SVG_PX;
  return width / viewBoxWidth;
}

// --- shared renderer (also used by the Train mini-map) ---

export function drawGym(svg, gym, {
  selectedId = null, editor = false, selectedVertex = null, usage = null,
} = {}) {
  // Margin around the floor: outline handles and wall-snapped fixtures
  // straddle the boundary — without it they are clipped and only
  // half-tappable exactly where the SVG ends. The viewer needs just
  // enough to not clip doors/windows; the editor needs finger room.
  const pad = editor ? 2.5 : 1;
  const vw = gym.grid.w + 2 * pad;
  const vh = gym.grid.h + 2 * pad;
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${vw} ${vh}`);
  svg.style.aspectRatio = `${vw} / ${vh}`;
  const selected = selectedId && selectedId !== OUTLINE_ID ? findItem(gym, selectedId) : null;
  // px-per-unit only matters for editor touch targets — skip the layout
  // measurement for the read-only Train mini-map.
  const ppu = editor ? pxPerUnit(svg, vw) : 1;
  // small free-standing items get invisible tap padding; wall-snapped
  // fixtures and wall lines keep their own .hit shapes
  const padded = editor
    ? [...gym.shapes.filter((s) => s.kind !== 'line' && !WALL_SNAPPED.has(s.fixture)), ...gym.machines]
    : [];
  // the outline's tap target sits ABOVE zones/walls (which often touch the
  // outer wall) but below wall-snapped fixtures (doors/windows live ON the
  // outline — under it they'd be impossible to tap), machines and the
  // editing handles; tap pads sit below the machines so a visible machine
  // always wins hit-testing over a neighbor's padding
  const wallPieces = gym.shapes.filter((s) => WALL_SNAPPED.has(s.fixture));
  const floorPieces = gym.shapes.filter((s) => !WALL_SNAPPED.has(s.fixture));
  svg.innerHTML =
    outlineFloorSvg(gym.outline) +
    (editor ? gridSvg(gym.grid) : '') +
    floorPieces.map(shapeSvg).join('') +
    (editor ? outlineHitSvg(gym.outline) : '') +
    wallPieces.map(shapeSvg).join('') +
    (editor ? hitPadSvg(padded, ppu) : '') +
    gym.machines.map((m) => machineSvg(m, usage)).join('') +
    (editor && selected ? selectionSvg(selected, ppu, gym.grid, pad) : '') +
    (editor && selectedId === OUTLINE_ID ? outlineHandlesSvg(gym.outline, selectedVertex, ppu, gym.grid, pad) : '');
}

// Builds the usage payload for drawGym from all-time set counts.
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

export function findMachineByNum(gym, num) {
  return gym.machines.find((m) => m.num === num) || null;
}

function findItem(gym, id) {
  return gym.machines.find((m) => m.id === id) || gym.shapes.find((s) => s.id === id) || null;
}

function gridSvg(grid) {
  let d = '';
  for (let x = 0; x <= grid.w; x += 5) d += `M${x} 0V${grid.h}`;
  for (let y = 0; y <= grid.h; y += 5) d += `M0 ${y}H${grid.w}`;
  return `<path class="grid-line" d="${d}" pointer-events="none"/>`;
}

function shapeSvg(s) {
  if (s.kind === 'line') {
    const x2 = s.x + s.w;
    const y2 = s.y + s.h;
    // second, invisible fat line makes thin walls tappable
    return `<g class="shape" data-id="${s.id}">
      <line class="shape-line" x1="${s.x}" y1="${s.y}" x2="${x2}" y2="${y2}"/>
      <line class="hit" x1="${s.x}" y1="${s.y}" x2="${x2}" y2="${y2}"/>
    </g>`;
  }
  if (s.kind === 'fixture') {
    if (s.fixture === 'door') return doorSvg(s);
    if (s.fixture === 'entrance') return entranceSvg(s);
    if (s.fixture === 'window') return windowSvg(s);
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

function machineSvg(m, usage = null) {
  const fs = clamp(Math.min(m.w, m.h) * 0.55, 1.2, 2.4);
  let boxStyle = '';
  let numStyle = '';
  if (usage) {
    // sequential green ramp by all-time sets; unused machines fade out
    const sets = usage.counts.get(m.id) || 0;
    if (!sets) {
      boxStyle = ' style="fill:#1c232c;stroke:#38424e"';
      numStyle = ' style="fill:#5f6d7d"';
    } else {
      const t = sets / usage.max;
      const c = t > 0.75 ? '#35a273' : t > 0.5 ? '#2c7d55' : t > 0.25 ? '#23593f' : '#183b2b';
      boxStyle = ` style="fill:${c};stroke:${c}"`;
      if (t > 0.75) numStyle = ' style="fill:#06130c"';
    }
  } else if (m.color) {
    boxStyle = ` style="fill:${m.color};stroke:${m.color}"`;
    numStyle = ' style="fill:#0c1116"';
  }
  return `<g class="machine" data-id="${m.id}">
    <rect class="machine-box" x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" rx="0.4"${boxStyle}/>
    <text class="machine-num" x="${m.x + m.w / 2}" y="${m.y + m.h / 2}" font-size="${fs}"
      text-anchor="middle" dominant-baseline="central" pointer-events="none"${numStyle}>${m.num}</text>
  </g>`;
}

// Invisible tap padding for items smaller than the touch-target guideline.
// Must be painted in its own layer BEFORE the visible machines (see
// drawGym) so a tap on any visible machine always resolves to that
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

// Classic floor-plan door: a gap punched through the wall stroke, a
// door leaf, and its dashed swing arc. Rotated to match the wall.
function doorSvg(s) {
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
    <rect class="door-hit hit" x="${hx}" y="${cy - 1.3}" width="${w}" height="2.6"/>
    <rect class="door-gap" x="${hx}" y="${cy - 0.4}" width="${w}" height="0.8"/>
    <path class="door-arc" d="M ${hx} ${cy - w} A ${w} ${w} 0 0 1 ${cx + w / 2} ${cy}"/>
    <line class="door-leaf" x1="${hx}" y1="${cy}" x2="${hx}" y2="${cy - w}"/>
  </g>`;
}

// Entrance: a wide wall opening with an inward arrow. flipV points it
// the other way when the inside is on the other side of the wall.
function entranceSvg(s) {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const fy = s.flipV ? -1 : 1;
  return `<g class="shape" data-id="${s.id}" transform="rotate(${s.rot || 0} ${cx} ${cy})
      translate(${cx} ${cy}) scale(1 ${fy}) translate(${-cx} ${-cy})">
    <rect class="door-hit hit" x="${s.x}" y="${cy - 1.3}" width="${s.w}" height="2.6"/>
    <rect class="door-gap" x="${s.x}" y="${cy - 0.45}" width="${s.w}" height="0.9"/>
    <path class="entrance-arrow" d="M ${cx} ${cy + 1.7} L ${cx} ${cy - 1.3}
      M ${cx - 0.7} ${cy - 0.5} L ${cx} ${cy - 1.3} L ${cx + 0.7} ${cy - 0.5}"/>
  </g>`;
}

// Window: the classic double line inside the wall stroke.
function windowSvg(s) {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  return `<g class="shape" data-id="${s.id}" transform="rotate(${s.rot || 0} ${cx} ${cy})">
    <rect class="door-hit hit" x="${s.x}" y="${cy - 1.3}" width="${s.w}" height="2.6"/>
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

function selectionSvg(item, ppu, grid, pad) {
  if (WALL_SNAPPED.has(item.fixture)) { // wall pieces rotate along and have no resize handle
    const cx = item.x + item.w / 2;
    const cy = item.y + item.h / 2;
    return `<rect class="selected-outline" x="${item.x - 0.4}" y="${cy - 1.2}"
      width="${item.w + 0.8}" height="2.4" pointer-events="none"
      transform="rotate(${item.rot || 0} ${cx} ${cy})"/>`;
  }
  const b = bbox(item);
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
  return `<rect class="selected-outline" x="${b.x - 0.4}" y="${b.y - 0.4}"
      width="${b.w + 0.8}" height="${b.h + 0.8}" pointer-events="none"/>
    <circle class="tap-hit handle-hit" data-id="${item.id}" data-handle="1"
      cx="${hx}" cy="${hy}" r="${hitR}"/>
    <circle class="handle" cx="${hx}" cy="${hy}" r="${visR}"
      pointer-events="none" stroke-width="${visR * 0.08}"/>
    <path class="handle-icon" pointer-events="none" stroke-width="${visR * 0.16}"
      d="M${hx - a} ${hy - a} L${hx + a} ${hy + a}
         M${hx - a} ${hy - a + t} V${hy - a} H${hx - a + t}
         M${hx + a} ${hy + a - t} V${hy + a} H${hx + a - t}"/>`;
}

// --- editor view ---

export function renderStudio(root) {
  let gym = getGym();
  if (!gym) {
    gym = newGym();
    saveGym(gym); // fresh gym: persist directly, history starts from it
  }
  let selectedId = null;
  let selectedVertex = null; // outline corner index, for deletion
  let drag = null; // { mode: 'move'|'resize'|'vertex', item?, index?, offX, offY, moved }

  root.innerHTML = `
    <div class="spread studio-head">
      <h1>Studio</h1>
      <div class="undo-group">
        <button id="undo" class="btn btn-inline" aria-label="Undo" disabled>↩</button>
        <button id="redo" class="btn btn-inline" aria-label="Redo" disabled>↪</button>
      </div>
    </div>
    <div class="toolbar">
      <button id="add-room" class="btn">+ Zone</button>
      <button id="add-wall" class="btn">+ Wall</button>
      <button id="add-machine" class="btn btn-primary">+ Machine</button>
    </div>
    <div class="toolbar toolbar-sub">
      ${Object.entries(FIXTURES).map(([key, f]) =>
        `<button class="btn add-fixture" data-fixture="${key}">${f.icon} ${f.label}</button>`).join('')}
    </div>
    <div class="floor-wrap"><svg id="floor" class="floor" xmlns="http://www.w3.org/2000/svg"></svg></div>
    <div class="map-mode" id="map-mode">
      <button type="button" class="chip" data-mode="custom">Colors</button>
      <button type="button" class="chip" data-mode="usage">Usage</button>
    </div>
    <div id="props"></div>
  `;

  const svg = root.querySelector('#floor');
  const props = root.querySelector('#props');
  const usageOn = () => getSettings().mapColors === 'usage';
  const redraw = () => drawGym(svg, gym, {
    selectedId, editor: true, selectedVertex,
    usage: usageOn() ? usagePayload(usageByMachine()) : null,
  });
  // Touch targets are sized from the SVG's on-screen width, so re-render
  // on resize/orientation change. Observing the element (not window)
  // means the observer dies with it on the next route change.
  new ResizeObserver(redraw).observe(svg);

  const modeBar = root.querySelector('#map-mode');
  const updateModeBar = () => modeBar.querySelectorAll('.chip').forEach((c) =>
    c.classList.toggle('sel', (c.dataset.mode === 'usage') === usageOn()));
  modeBar.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    saveSettings({ ...getSettings(), mapColors: chip.dataset.mode });
    updateModeBar();
    redraw();
  });
  updateModeBar();

  // --- undo/redo: one snapshot per completed edit ---
  const history = [JSON.stringify(gym)];
  let hIndex = 0;
  const undoBtn = root.querySelector('#undo');
  const redoBtn = root.querySelector('#redo');

  const updateUndoButtons = () => {
    undoBtn.disabled = hIndex === 0;
    redoBtn.disabled = hIndex === history.length - 1;
  };

  // every studio mutation goes through save(): persist + record history
  const save = () => {
    saveGym(gym);
    history.length = hIndex + 1; // editing kills the redo branch
    history.push(JSON.stringify(gym));
    if (history.length > 60) history.shift();
    else hIndex++;
    updateUndoButtons();
  };

  const restore = (json) => {
    gym = JSON.parse(json);
    saveGym(gym); // persist without recording — undo/redo just moves the pointer
    selectedId = null; // the selected item may not exist in this state
    selectedVertex = null;
    redraw();
    renderProps();
    updateUndoButtons();
  };

  undoBtn.addEventListener('click', () => {
    if (hIndex === 0) return;
    hIndex--;
    restore(history[hIndex]);
  });
  redoBtn.addEventListener('click', () => {
    if (hIndex === history.length - 1) return;
    hIndex++;
    restore(history[hIndex]);
  });

  function svgPoint(e) {
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  }

  function select(id) {
    if (selectedId === id) return;
    selectedId = id;
    renderProps();
  }

  svg.addEventListener('pointerdown', (e) => {
    // outline corner / midpoint handles sit on top of everything
    const handle = e.target.closest('[data-vertex], [data-mid]');
    if (handle) {
      if (handle.dataset.vertex !== undefined) {
        const i = parseInt(handle.dataset.vertex, 10);
        if (selectedVertex !== i) {
          selectedVertex = i;
          renderProps();
        }
        drag = { mode: 'vertex', index: i, moved: false };
      } else {
        // tapping a midpoint inserts a corner there and starts dragging it
        const i = parseInt(handle.dataset.mid, 10);
        const p = gym.outline[i];
        const q = gym.outline[(i + 1) % gym.outline.length];
        gym.outline.splice(i + 1, 0, { x: snap((p.x + q.x) / 2), y: snap((p.y + q.y) / 2) });
        selectedVertex = i + 1;
        drag = { mode: 'vertex', index: i + 1, moved: true };
        renderProps();
      }
      try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ }
      redraw();
      e.preventDefault();
      return;
    }

    const target = e.target.closest('[data-id]');
    if (!target) {
      if (selectedId !== null || selectedVertex !== null) {
        selectedId = null;
        selectedVertex = null;
        renderProps();
      }
      redraw();
      e.preventDefault(); // stop the browser from text-selecting on empty-area drags
      return;
    }
    if (target.dataset.id === OUTLINE_ID) {
      if (selectedId !== OUTLINE_ID) {
        selectedId = OUTLINE_ID;
        selectedVertex = null;
        renderProps();
      }
      redraw();
      e.preventDefault();
      return;
    }
    const item = findItem(gym, target.dataset.id);
    if (!item) return;
    selectedVertex = null;
    select(item.id);
    const p = svgPoint(e);
    drag = target.dataset.handle
      ? { mode: 'resize', item, moved: false }
      : { mode: 'move', item, offX: p.x - item.x, offY: p.y - item.y, moved: false };
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ }
    redraw();
    e.preventDefault();
  });

  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = svgPoint(e);
    if (drag.mode === 'vertex') {
      gym.outline[drag.index] = {
        x: clamp(snap(p.x), 0, gym.grid.w),
        y: clamp(snap(p.y), 0, gym.grid.h),
      };
      drag.moved = true;
      redraw();
      return;
    }
    const it = drag.item;
    if (drag.mode === 'move') {
      if (WALL_SNAPPED.has(it.fixture)) {
        // wall pieces ignore the grid and glue themselves to the nearest wall
        it.x = p.x - drag.offX;
        it.y = p.y - drag.offY;
        snapDoorToWall(gym, it);
      } else {
        // clamp so the item's bounding box stays on the floor (works for
        // rects and for lines with negative w/h)
        it.x = clamp(snap(p.x - drag.offX), -Math.min(it.w, 0), gym.grid.w - Math.max(it.w, 0));
        it.y = clamp(snap(p.y - drag.offY), -Math.min(it.h, 0), gym.grid.h - Math.max(it.h, 0));
      }
    } else if (it.kind === 'line') {
      it.w = clamp(snap(p.x - it.x), -it.x, gym.grid.w - it.x);
      it.h = clamp(snap(p.y - it.y), -it.y, gym.grid.h - it.y);
    } else {
      const minSize = it.kind === 'fixture' ? 1 : 2; // mirrors etc. may be slim
      it.w = clamp(snap(p.x - it.x), minSize, gym.grid.w - it.x);
      it.h = clamp(snap(p.y - it.y), minSize, gym.grid.h - it.y);
    }
    drag.moved = true;
    redraw();
  });

  const endDrag = () => {
    if (!drag) return;
    const it = drag.item;
    if (it && drag.mode === 'resize' && it.kind === 'line' && Math.abs(it.w) < 1 && Math.abs(it.h) < 1) {
      it.w = 3; // never leave an invisible zero-length wall behind
    }
    if (drag.moved) {
      save();
      redraw();
    }
    drag = null;
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  function nextNum() {
    return gym.machines.reduce((mx, m) => Math.max(mx, m.num), 0) + 1;
  }

  function addItem(kind, fixtureType = null) {
    const g = gym.grid;
    const off = ((gym.shapes.length + gym.machines.length) % 6); // cascade new items
    let item;
    if (kind === 'machine') {
      const num = nextNum();
      item = {
        id: uid(), num, label: `Machine ${num}`,
        x: snap(g.w / 2 - 2 + off), y: snap(g.h / 2 - 1.5 + off),
        w: 4, h: 3, settingsFields: [], muscles: [], docUrl: '',
      };
      gym.machines.push(item);
    } else if (kind === 'rect') {
      item = { id: uid(), kind: 'rect', label: '', x: snap(g.w / 2 - 6 + off), y: snap(g.h / 2 - 4 + off), w: 12, h: 8 };
      gym.shapes.push(item);
    } else if (kind === 'fixture') {
      const f = FIXTURES[fixtureType];
      item = {
        id: uid(), kind: 'fixture', fixture: fixtureType,
        x: snap(g.w / 2 - f.w / 2 + off), y: snap(g.h / 2 - f.h / 2 + off),
        w: f.w, h: f.h,
      };
      if (WALL_SNAPPED.has(fixtureType)) snapDoorToWall(gym, item); // born on a wall
      gym.shapes.push(item);
    } else {
      item = { id: uid(), kind: 'line', x: snap(g.w / 2 - 4 + off), y: snap(g.h / 2 + off), w: 8, h: 0 };
      gym.shapes.push(item);
    }
    save();
    select(item.id);
    redraw();
  }

  root.querySelector('#add-room').addEventListener('click', () => addItem('rect'));
  root.querySelector('#add-wall').addEventListener('click', () => addItem('line'));
  root.querySelector('#add-machine').addEventListener('click', () => addItem('machine'));
  root.querySelectorAll('.add-fixture').forEach((btn) => {
    btn.addEventListener('click', () => addItem('fixture', btn.dataset.fixture));
  });

  async function openTemplateBrowser(panel) {
    panel.innerHTML = '<p class="muted">Loading library…</p>';
    let list = [];
    try {
      const idx = await fetch('templates/index.json', { cache: 'no-store' }).then((r) => r.json());
      list = idx.templates || [];
    } catch { /* no manifest reachable — file import below still works */ }

    panel.innerHTML = `
      ${list.map((t) => {
        const where = [t.city, t.country].filter(Boolean).join(', ');
        return `<button class="btn tpl-load" data-file="${esc(t.file)}"
          data-label="${esc(t.name)}${where ? ` — ${where}` : ''}">
          ${esc(t.name)}${where ? `<span class="sub">${esc(where)}</span>` : ''}</button>`;
      }).join('') || '<p class="muted">Library is empty.</p>'}
      <button class="btn" id="tpl-file-btn">From file…</button>
      <input type="file" hidden accept=".json,application/json" id="tpl-file-input">
      <p class="muted" id="tpl-msg">Loading a template replaces the current gym layout
      (workout history stays).</p>`;

    const msg = panel.querySelector('#tpl-msg');
    const apply = (data) => {
      importData(data);
      renderStudio(root);
    };

    panel.addEventListener('click', async (e) => {
      const btn = e.target.closest('.tpl-load');
      if (!btn) return;
      if (!twoTapConfirm(btn, 'Tap again to replace current gym', btn.dataset.label)) return;
      try {
        apply(await fetch(btn.dataset.file, { cache: 'no-store' }).then((r) => r.json()));
      } catch (err) {
        msg.textContent = `Load failed: ${err.message}`;
      }
    });

    panel.querySelector('#tpl-file-btn').addEventListener('click', () => {
      panel.querySelector('#tpl-file-input').click();
    });
    panel.querySelector('#tpl-file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        apply(JSON.parse(await file.text()));
      } catch (err) {
        msg.textContent = `Import failed: ${err.message}`;
      }
    });
  }

  // Swatch row for picking an item accent color (empty = default look).
  const colorRow = (current) => `<div class="swatch-row">
    <button type="button" class="swatch none${!current ? ' sel' : ''}" data-color="" aria-label="default color"></button>
    ${ITEM_COLORS.map((c) => `<button type="button" class="swatch${current === c ? ' sel' : ''}"
      data-color="${c}" style="background:${c}" aria-label="color ${c}"></button>`).join('')}
  </div>`;

  const wireColorRow = (sel, item) => {
    props.querySelector(sel).addEventListener('click', (e) => {
      const sw = e.target.closest('.swatch');
      if (!sw) return;
      if (sw.dataset.color) item.color = sw.dataset.color;
      else delete item.color;
      save();
      redraw();
      renderProps();
    });
  };

  function renderProps() {
    if (selectedId === OUTLINE_ID) {
      const canDelete = selectedVertex !== null && gym.outline.length > 3;
      props.innerHTML = `
        <section class="card">
          <h2>Floor outline</h2>
          <p class="muted">${gym.outline.length} corners. Drag a white corner to reshape the floor;
          tap a hollow dot between two corners to add a new one.</p>
          <button id="del-vertex" class="btn btn-danger" ${canDelete ? '' : 'disabled'}>
            ${selectedVertex === null
              ? 'Tap a corner to delete it'
              : canDelete ? 'Delete selected corner' : 'A floor needs at least 3 corners'}
          </button>
          <button id="reset-outline" class="btn">Reset outline to full rectangle</button>
        </section>`;
      props.querySelector('#del-vertex').addEventListener('click', () => {
        if (selectedVertex === null || gym.outline.length <= 3) return;
        gym.outline.splice(selectedVertex, 1);
        selectedVertex = null;
        save();
        redraw();
        renderProps();
      });
      props.querySelector('#reset-outline').addEventListener('click', () => {
        gym.outline = defaultOutline(gym.grid);
        selectedVertex = null;
        save();
        redraw();
        renderProps();
      });
      return;
    }

    const item = selectedId ? findItem(gym, selectedId) : null;

    if (!item) {
      props.innerHTML = `
        <section class="card">
          <h2>Gym</h2>
          <label class="field"><span>Name</span><input id="gym-name" type="text" value="${esc(gym.name)}"></label>
          <label class="field"><span>Floor width</span>
            <div class="stepper" data-step="5" data-min="20">
              <button type="button" class="step-down">−</button>
              <input id="floor-w" type="number" inputmode="numeric" value="${gym.grid.w}">
              <button type="button" class="step-up">+</button>
            </div>
          </label>
          <label class="field"><span>Floor height</span>
            <div class="stepper" data-step="5" data-min="20">
              <button type="button" class="step-down">−</button>
              <input id="floor-h" type="number" inputmode="numeric" value="${gym.grid.h}">
              <button type="button" class="step-up">+</button>
            </div>
          </label>
          <p class="muted">Add rooms, walls and machines, then drag them into place.
          Tap an item to edit it; drag the white corner handle to resize.
          Tap the outer wall to reshape the floor outline.</p>
        </section>
        <section class="card">
          <h2>Location</h2>
          <label class="field"><span>Address</span><input id="gym-address" type="text"
            value="${esc(gym.meta?.address || '')}"></label>
          <label class="field"><span>City</span><input id="gym-city" type="text"
            value="${esc(gym.meta?.city || '')}"></label>
          <label class="field"><span>Country</span><input id="gym-country" type="text"
            value="${esc(gym.meta?.country || '')}"></label>
          <p class="muted">Travels with the template so others can find this gym when you share it.</p>
        </section>
        <section class="card">
          <h2>Templates</h2>
          <button id="load-template" class="btn">Load template…</button>
          <button id="save-template" class="btn">Save as template</button>
          <div id="template-browser"></div>
        </section>`;

      const bindMeta = (sel, key) => {
        props.querySelector(sel).addEventListener('change', (e) => {
          gym.meta = { ...(gym.meta || {}), [key]: e.target.value.trim() };
          save();
        });
      };
      bindMeta('#gym-address', 'address');
      bindMeta('#gym-city', 'city');
      bindMeta('#gym-country', 'country');

      props.querySelector('#save-template').addEventListener('click', () => {
        const slug = [gym.name, gym.meta?.city].filter(Boolean).join('-')
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'gym';
        download(`gymii-template-${slug}.json`, exportGymTemplate());
      });

      props.querySelector('#load-template').addEventListener('click', () => {
        openTemplateBrowser(props.querySelector('#template-browser'));
      });
      props.querySelector('#gym-name').addEventListener('change', (e) => {
        gym.name = e.target.value.trim() || 'My gym';
        save();
      });
      const onFloor = (inputId, key) => {
        props.querySelector(inputId).addEventListener('change', (e) => {
          const v = clamp(Math.round(parseFloat(e.target.value) || 20), 20, 200);
          e.target.value = v;
          gym.grid[key] = v;
          gym.outline.forEach((p) => { // keep the outline on the shrunk floor
            p.x = Math.min(p.x, gym.grid.w);
            p.y = Math.min(p.y, gym.grid.h);
          });
          save();
          redraw();
        });
      };
      onFloor('#floor-w', 'w');
      onFloor('#floor-h', 'h');
      return;
    }

    if (!item.kind) { // machine
      const muscles = item.muscles || [];
      const muscleOptions = [...MUSCLE_GROUPS, ...muscles.filter((m) => !MUSCLE_GROUPS.includes(m))];
      const settingsOptions = [...new Set([...COMMON_SETTINGS, ...item.settingsFields])];
      const chipRow = (options, selected) => options.map((o) =>
        `<button type="button" class="chip${selected.includes(o) ? ' sel' : ''}"
          data-value="${esc(o)}">${esc(o)}</button>`).join('');

      props.innerHTML = `
        <section class="card">
          <h2>Machine</h2>
          <label class="field"><span>Number</span>
            <div class="stepper" data-step="1" data-min="1">
              <button type="button" class="step-down">−</button>
              <input id="m-num" type="number" inputmode="numeric" value="${item.num}">
              <button type="button" class="step-up">+</button>
            </div>
          </label>
          <label class="field"><span>Label</span><input id="m-label" type="text" value="${esc(item.label)}"></label>
          <div class="field-block"><span>Type</span>
            <div class="chip-select">
              <button type="button" id="m-cardio"
                class="chip${item.cardio ? ' sel' : ''}">Cardio — distance + time</button>
              <button type="button" id="m-bodyweight"
                class="chip${item.bodyweight ? ' sel' : ''}">Bodyweight — reps + extra weight</button>
            </div>
          </div>
          <div class="field-block"><span>Color on the plan</span>
            <div id="m-color">${colorRow(item.color)}</div>
          </div>
          <div class="field-block"><span>Muscles — tap to toggle</span>
            <div class="chip-select" id="m-muscles">${chipRow(muscleOptions, muscles)}</div>
          </div>
          <div class="field-block"><span>Settings — the machine's adjustable parts</span>
            <div class="chip-select" id="m-fields">${chipRow(settingsOptions, item.settingsFields)}</div>
            <div class="row">
              <input id="m-field-custom" type="text" placeholder="Other setting…">
              <button type="button" id="m-field-add" class="btn btn-inline">Add</button>
            </div>
          </div>
          <div class="field-block"><span>Exercises — for free-weight or multi-exercise stations</span>
            <div class="chip-select" id="m-exercises">${chipRow(item.exercises ?? [], item.exercises ?? [])}</div>
            <div class="row">
              <input id="m-exercise-custom" type="text" placeholder="e.g. Biceps curls…">
              <button type="button" id="m-exercise-add" class="btn btn-inline">Add</button>
            </div>
          </div>
          <label class="field"><span>Doc link</span><input id="m-doc" type="text" inputmode="url"
            placeholder="https://…" value="${esc(item.docUrl || '')}"></label>
          <button id="del-item" class="btn btn-danger">Delete machine</button>
        </section>`;

      props.querySelector('#m-num').addEventListener('change', (e) => {
        item.num = Math.max(1, Math.round(parseFloat(e.target.value) || 1));
        e.target.value = item.num;
        save();
        redraw();
      });
      props.querySelector('#m-label').addEventListener('change', (e) => {
        item.label = e.target.value.trim() || `Machine ${item.num}`;
        e.target.value = item.label;
        save();
      });

      // The two type flags are mutually exclusive; absent = strength
      // machine, and flags are deleted (not set false) to keep exports clean.
      props.querySelector('#m-cardio').addEventListener('click', () => {
        if (item.cardio) delete item.cardio;
        else { item.cardio = true; delete item.bodyweight; }
        save();
        renderProps();
      });
      props.querySelector('#m-bodyweight').addEventListener('click', () => {
        if (item.bodyweight) delete item.bodyweight;
        else { item.bodyweight = true; delete item.cardio; }
        save();
        renderProps();
      });

      wireColorRow('#m-color', item);

      const toggleIn = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
      props.querySelector('#m-muscles').addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        item.muscles = toggleIn(muscles, chip.dataset.value);
        save();
        renderProps();
      });
      props.querySelector('#m-fields').addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        item.settingsFields = toggleIn(item.settingsFields, chip.dataset.value);
        save();
        renderProps();
      });

      const addCustomField = () => {
        const input = props.querySelector('#m-field-custom');
        const v = input.value.trim();
        if (!v) return;
        if (!item.settingsFields.includes(v)) item.settingsFields.push(v);
        save();
        renderProps();
      };
      props.querySelector('#m-field-add').addEventListener('click', addCustomField);
      props.querySelector('#m-field-custom').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addCustomField();
      });

      // Exercises: tap a chip to remove it, add via the text row. The field
      // is deleted when emptied so plain stations export without it.
      props.querySelector('#m-exercises').addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        const next = (item.exercises ?? []).filter((x) => x !== chip.dataset.value);
        if (next.length) item.exercises = next;
        else delete item.exercises;
        save();
        renderProps();
      });
      const addExercise = () => {
        const input = props.querySelector('#m-exercise-custom');
        const v = input.value.trim();
        if (!v) return;
        item.exercises = item.exercises ?? [];
        if (!item.exercises.includes(v)) item.exercises.push(v);
        save();
        renderProps();
      };
      props.querySelector('#m-exercise-add').addEventListener('click', addExercise);
      props.querySelector('#m-exercise-custom').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addExercise();
      });

      props.querySelector('#m-doc').addEventListener('change', (e) => {
        item.docUrl = e.target.value.trim();
        save();
      });
    } else if (item.kind === 'rect') {
      const zoneOptions = [...ZONE_LABELS,
        ...(item.label && !ZONE_LABELS.includes(item.label) ? [item.label] : [])];
      props.innerHTML = `
        <section class="card">
          <h2>Zone</h2>
          <div class="field-block"><span>Label — tap to set, tap again to clear</span>
            <div class="chip-select" id="z-labels">
              ${zoneOptions.map((z) => `<button type="button"
                class="chip${item.label === z ? ' sel' : ''}" data-value="${esc(z)}">${esc(z)}</button>`).join('')}
            </div>
            <div class="row">
              <input id="z-custom" type="text" placeholder="Custom label…">
              <button type="button" id="z-set" class="btn btn-inline">Set</button>
            </div>
          </div>
          <div class="field-block"><span>Color on the plan</span>
            <div id="z-color">${colorRow(item.color)}</div>
          </div>
          <button id="del-item" class="btn btn-danger">Delete</button>
        </section>`;
      wireColorRow('#z-color', item);
      props.querySelector('#z-labels').addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        item.label = item.label === chip.dataset.value ? '' : chip.dataset.value;
        save();
        redraw();
        renderProps();
      });
      const setCustom = () => {
        const v = props.querySelector('#z-custom').value.trim();
        if (!v) return;
        item.label = v;
        save();
        redraw();
        renderProps();
      };
      props.querySelector('#z-set').addEventListener('click', setCustom);
      props.querySelector('#z-custom').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') setCustom();
      });
    } else {
      const isDoor = item.fixture === 'door';
      const isEntrance = item.fixture === 'entrance';
      props.innerHTML = `
        <section class="card">
          <h2>${item.kind === 'line' ? 'Wall' : (FIXTURES[item.fixture]?.label ?? 'Element')}</h2>
          ${isDoor ? `
            <button id="flip-swing" class="btn">Flip swing side (in/out)</button>
            <button id="flip-hinge" class="btn">Flip hinge side (left/right)</button>` : ''}
          ${isEntrance ? '<button id="flip-swing" class="btn">Flip direction (in/out)</button>' : ''}
          <button id="del-item" class="btn btn-danger">Delete</button>
        </section>`;
      if (isDoor || isEntrance) {
        props.querySelector('#flip-swing').addEventListener('click', () => {
          item.flipV = !item.flipV;
          save();
          redraw();
        });
      }
      if (isDoor) {
        props.querySelector('#flip-hinge').addEventListener('click', () => {
          item.flipH = !item.flipH;
          save();
          redraw();
        });
      }
    }

    // two-tap even though undo exists — fat fingers happen faster than
    // people notice the undo button
    const delBtn = props.querySelector('#del-item');
    delBtn.addEventListener('click', () => {
      if (!twoTapConfirm(delBtn, 'Tap again to delete', delBtn.textContent)) return;
      gym.machines = gym.machines.filter((m) => m.id !== item.id);
      gym.shapes = gym.shapes.filter((s) => s.id !== item.id);
      save();
      select(null);
      redraw();
    });
  }

  redraw();
  renderProps();
}
