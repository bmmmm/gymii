import { getGym, saveGym, newGym, uid, importData, defaultOutline } from './store.js';
import { esc } from './ui.js';

const SNAP = 1;
const snap = (v) => Math.round(v / SNAP) * SNAP;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The floor outline is a singleton, addressed by this pseudo item id.
const OUTLINE_ID = 'outline';

// --- shared renderer (also used by the Train mini-map) ---

export function drawGym(svg, gym, { selectedId = null, editor = false, selectedVertex = null } = {}) {
  svg.setAttribute('viewBox', `0 0 ${gym.grid.w} ${gym.grid.h}`);
  svg.style.aspectRatio = `${gym.grid.w} / ${gym.grid.h}`;
  const selected = selectedId && selectedId !== OUTLINE_ID ? findItem(gym, selectedId) : null;
  // the outline's tap target sits ABOVE zones/walls (which often touch the
  // outer wall) but below machines and the editing handles
  svg.innerHTML =
    outlineFloorSvg(gym.outline) +
    (editor ? gridSvg(gym.grid) : '') +
    gym.shapes.map(shapeSvg).join('') +
    (editor ? outlineHitSvg(gym.outline) : '') +
    gym.machines.map(machineSvg).join('') +
    (editor && selected ? selectionSvg(selected) : '') +
    (editor && selectedId === OUTLINE_ID ? outlineHandlesSvg(gym.outline, selectedVertex) : '');
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
function outlineHandlesSvg(outline, selectedVertex) {
  const mids = outline.map((p, i) => {
    const q = outline[(i + 1) % outline.length];
    return `<circle class="midpoint" data-mid="${i}"
      cx="${(p.x + q.x) / 2}" cy="${(p.y + q.y) / 2}" r="0.65"/>`;
  }).join('');
  const verts = outline.map((p, i) => `<rect class="vertex${i === selectedVertex ? ' sel' : ''}"
    data-vertex="${i}" x="${p.x - 0.8}" y="${p.y - 0.8}" width="1.6" height="1.6" rx="0.3"/>`).join('');
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
  return `<g class="shape" data-id="${s.id}">
    <rect class="shape-rect" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="0.3"/>
  </g>`;
}

function machineSvg(m) {
  const fs = clamp(Math.min(m.w, m.h) * 0.55, 1.2, 2.4);
  return `<g class="machine" data-id="${m.id}">
    <rect class="machine-box" x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" rx="0.4"/>
    <text class="machine-num" x="${m.x + m.w / 2}" y="${m.y + m.h / 2}" font-size="${fs}"
      text-anchor="middle" dominant-baseline="central" pointer-events="none">${m.num}</text>
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

function selectionSvg(item) {
  const b = bbox(item);
  const hx = item.x + item.w;
  const hy = item.y + item.h;
  return `<rect class="selected-outline" x="${b.x - 0.4}" y="${b.y - 0.4}"
      width="${b.w + 0.8}" height="${b.h + 0.8}" pointer-events="none"/>
    <rect class="handle" data-id="${item.id}" data-handle="1"
      x="${hx - 0.9}" y="${hy - 0.9}" width="1.8" height="1.8" rx="0.3"/>`;
}

// --- editor view ---

export function renderStudio(root) {
  let gym = getGym();
  if (!gym) {
    gym = newGym();
    saveGym(gym);
  }
  let selectedId = null;
  let selectedVertex = null; // outline corner index, for deletion
  let drag = null; // { mode: 'move'|'resize'|'vertex', item?, index?, offX, offY, moved }

  root.innerHTML = `
    <h1>Studio</h1>
    <div class="toolbar">
      <button id="add-room" class="btn">+ Room</button>
      <button id="add-wall" class="btn">+ Wall</button>
      <button id="add-machine" class="btn btn-primary">+ Machine</button>
    </div>
    <div class="floor-wrap"><svg id="floor" class="floor" xmlns="http://www.w3.org/2000/svg"></svg></div>
    <div id="props"></div>
  `;

  const svg = root.querySelector('#floor');
  const props = root.querySelector('#props');
  const redraw = () => drawGym(svg, gym, { selectedId, editor: true, selectedVertex });

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
      // clamp so the item's bounding box stays on the floor (works for
      // rects and for lines with negative w/h)
      it.x = clamp(snap(p.x - drag.offX), -Math.min(it.w, 0), gym.grid.w - Math.max(it.w, 0));
      it.y = clamp(snap(p.y - drag.offY), -Math.min(it.h, 0), gym.grid.h - Math.max(it.h, 0));
    } else if (it.kind === 'line') {
      it.w = clamp(snap(p.x - it.x), -it.x, gym.grid.w - it.x);
      it.h = clamp(snap(p.y - it.y), -it.y, gym.grid.h - it.y);
    } else {
      it.w = clamp(snap(p.x - it.x), 2, gym.grid.w - it.x);
      it.h = clamp(snap(p.y - it.y), 2, gym.grid.h - it.y);
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
      saveGym(gym);
      redraw();
    }
    drag = null;
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  function nextNum() {
    return gym.machines.reduce((mx, m) => Math.max(mx, m.num), 0) + 1;
  }

  function addItem(kind) {
    const g = gym.grid;
    const off = ((gym.shapes.length + gym.machines.length) % 6); // cascade new items
    let item;
    if (kind === 'machine') {
      const num = nextNum();
      item = {
        id: uid(), num, label: `Machine ${num}`,
        x: snap(g.w / 2 - 2 + off), y: snap(g.h / 2 - 1.5 + off),
        w: 4, h: 3, settingsFields: [],
      };
      gym.machines.push(item);
    } else if (kind === 'rect') {
      item = { id: uid(), kind: 'rect', x: snap(g.w / 2 - 6 + off), y: snap(g.h / 2 - 4 + off), w: 12, h: 8 };
      gym.shapes.push(item);
    } else {
      item = { id: uid(), kind: 'line', x: snap(g.w / 2 - 4 + off), y: snap(g.h / 2 + off), w: 8, h: 0 };
      gym.shapes.push(item);
    }
    saveGym(gym);
    select(item.id);
    redraw();
  }

  root.querySelector('#add-room').addEventListener('click', () => addItem('rect'));
  root.querySelector('#add-wall').addEventListener('click', () => addItem('line'));
  root.querySelector('#add-machine').addEventListener('click', () => addItem('machine'));

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
        saveGym(gym);
        redraw();
        renderProps();
      });
      props.querySelector('#reset-outline').addEventListener('click', () => {
        gym.outline = defaultOutline(gym.grid);
        selectedVertex = null;
        saveGym(gym);
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
          ${gym.machines.length || gym.shapes.length ? '' : `
            <button id="load-example" class="btn">Load example gym</button>
            <p class="muted" id="example-err"></p>`}
        </section>`;
      props.querySelector('#load-example')?.addEventListener('click', async () => {
        try {
          const res = await fetch('templates/example-gym.json');
          importData(await res.json());
          renderStudio(root);
        } catch {
          props.querySelector('#example-err').textContent =
            'Could not load the example template.';
        }
      });
      props.querySelector('#gym-name').addEventListener('change', (e) => {
        gym.name = e.target.value.trim() || 'My gym';
        saveGym(gym);
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
          saveGym(gym);
          redraw();
        });
      };
      onFloor('#floor-w', 'w');
      onFloor('#floor-h', 'h');
      return;
    }

    if (!item.kind) { // machine
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
          <label class="field"><span>Settings</span><input id="m-fields" type="text"
            placeholder="e.g. Seat, Back pad" value="${esc(item.settingsFields.join(', '))}"></label>
          <p class="muted">Settings are the machine's adjustable parts (seat height, pad position…).
          You log a value for each during workouts.</p>
          <button id="del-item" class="btn btn-danger">Delete machine</button>
        </section>`;
      props.querySelector('#m-num').addEventListener('change', (e) => {
        item.num = Math.max(1, Math.round(parseFloat(e.target.value) || 1));
        e.target.value = item.num;
        saveGym(gym);
        redraw();
      });
      props.querySelector('#m-label').addEventListener('change', (e) => {
        item.label = e.target.value.trim() || `Machine ${item.num}`;
        e.target.value = item.label;
        saveGym(gym);
      });
      props.querySelector('#m-fields').addEventListener('change', (e) => {
        item.settingsFields = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
        saveGym(gym);
      });
    } else {
      props.innerHTML = `
        <section class="card">
          <h2>${item.kind === 'line' ? 'Wall' : 'Room'}</h2>
          <button id="del-item" class="btn btn-danger">Delete</button>
        </section>`;
    }

    props.querySelector('#del-item').addEventListener('click', () => {
      gym.machines = gym.machines.filter((m) => m.id !== item.id);
      gym.shapes = gym.shapes.filter((s) => s.id !== item.id);
      saveGym(gym);
      select(null);
      redraw();
    });
  }

  redraw();
  renderProps();
}
