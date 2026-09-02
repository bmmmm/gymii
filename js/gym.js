import {
  getLayout, saveLayout, newLayout, uid, importData, defaultOutline, exportGymTemplate,
  getSettings, saveSettings, usageByMachine, getActive,
  MUSCLE_GROUPS, COMMON_SETTINGS, ZONE_LABELS, MACHINE_BRANDS, MAP_LAYERS,
} from './store.js';
import { esc, download, twoTapConfirm, keepInView, preserveFocus } from './ui.js';
import {
  drawLayout, usagePayload, findMachineByNum, findItem, fits, freeSpot,
  snapDoorToWall, snap, clamp, FIXTURES, WALL_SNAPPED, ITEM_COLORS, OUTLINE_ID,
} from './map.js';

// --- editor view ---

// Lets Train hand a machine over for the Gym to preselect before
// switching the hash to #gym (module state survives; the app never
// reloads between tabs).
let pendingFocus = null;

// The gym's address as one search string, in postal order — empty when
// nothing is filled in, which is what hides the link.
function osmQuery(meta = {}) {
  const town = [meta.postcode, meta.city].filter(Boolean).join(' ');
  return [meta.address, town, meta.country].filter(Boolean).join(', ');
}

// A search link, not a pin: gymii stores an address, never coordinates, so
// OpenStreetMap does the geocoding. Opens in a new tab (target=_blank),
// because losing an unsaved layout to a map lookup would be absurd.
// Exported for the logic tests (same precedent as train's nextSetDefaults).
export function osmUrl(meta = {}) {
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(osmQuery(meta))}`;
}

// Two taps on the same item within this window unlock it for editing.
// Deliberately generous: a thumb on a phone is slower than a mouse.
const DOUBLE_TAP_MS = 450;
// How far a contact may travel and still count as a TAP, in grid units
// (~2.5% of the floor width, so roughly a finger's worth of wobble). Beyond
// it the contact was a DRAG, and a drag must not pair with the next one into
// a double tap — otherwise pushing an item twice in quick succession would
// lock it again mid-arrangement.
const TAP_SLOP = 1.5;

export function focusMachine(id) {
  pendingFocus = id;
}

export function renderGym(root) {
  let layout = getLayout();
  if (!layout) {
    layout = newLayout();
    saveLayout(layout); // fresh layout: persist directly, history starts from it
  }
  let selectedId = null;
  let selectedVertex = null; // outline corner index, for deletion
  let drag = null; // { mode: 'move'|'resize'|'vertex', item?, index?, offX, offY, moved }
  let findHighlightId = null; // "find a machine by number" pulse — cleared on the next svg pointerdown
  // EVERYTHING STARTS LOCKED. A plain tap only selects an item and opens
  // its card; moving and resizing need a deliberate double tap on it first
  // (`lastTap` remembers the previous one). A tap that drifts a few pixels
  // used to shove a whole zone across the floor, and the resize handle sat
  // under the same thumb that pushes an item around. At most one item is
  // unlocked at a time, and nothing survives a re-entry into the editor —
  // opening the Gym is always a read-only starting point.
  let unlockedId = null;
  let lastTap = null; // { id, t, x, y } — the last contact that still counts as a tap

  root.innerHTML = `
    <div class="spread gym-head">
      <h1>Gym</h1>
      <div class="undo-group">
        <button id="undo" class="btn btn-inline" aria-label="Undo" disabled>↩</button>
        <button id="redo" class="btn btn-inline" aria-label="Redo" disabled>↪</button>
      </div>
    </div>
    ${getActive()
    ? '<p class="muted"><a href="#train">← Back to your workout</a></p>'
    : '<a href="#train" class="back-row">‹ Train</a>'}
    <div class="toolbar">
      <button id="add-room" class="btn">+ Zone</button>
      <button id="add-wall" class="btn">+ Wall</button>
      <button id="add-machine" class="btn btn-primary">+ Machine</button>
    </div>
    <div class="toolbar toolbar-sub">
      ${Object.entries(FIXTURES).map(([key, f]) =>
        `<button class="btn add-fixture" data-fixture="${key}">${f.icon} ${f.label}</button>`).join('')}
    </div>
    <div class="row">
      <input id="find-num" type="number" inputmode="numeric" min="1" placeholder="Machine #">
      <button id="find-go" class="btn btn-inline">Find</button>
    </div>
    <p class="muted" id="find-err"></p>
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
  const redraw = () => drawLayout(svg, layout, {
    selectedId, editor: true, selectedVertex,
    usage: usageOn() ? usagePayload(usageByMachine()) : null,
    highlightId: findHighlightId, unlockedId,
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
  const history = [JSON.stringify(layout)];
  let hIndex = 0;
  const undoBtn = root.querySelector('#undo');
  const redoBtn = root.querySelector('#redo');

  const updateUndoButtons = () => {
    undoBtn.disabled = hIndex === 0;
    redoBtn.disabled = hIndex === history.length - 1;
  };

  // every gym mutation goes through save(): persist + record history
  const save = () => {
    saveLayout(layout);
    history.length = hIndex + 1; // editing kills the redo branch
    history.push(JSON.stringify(layout));
    if (history.length > 60) history.shift();
    else hIndex++;
    updateUndoButtons();
  };

  const restore = (json) => {
    layout = JSON.parse(json);
    saveLayout(layout); // persist without recording — undo/redo just moves the pointer
    selectedId = null; // the selected item may not exist in this state
    selectedVertex = null;
    unlockedId = null;
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
    unlockedId = null; // one item at a time; picking another locks the old
    renderProps();
  }

  svg.addEventListener('pointerdown', (e) => {
    // any real editing gesture ends the "find #N" pulse so it doesn't
    // linger dimming other machines while the user works
    findHighlightId = null;
    // outline corner / midpoint handles sit on top of everything
    const handle = e.target.closest('[data-vertex], [data-mid]');
    // handles only render while the outline is unlocked; the guard also
    // stops a stale one from a render that raced the re-lock
    if (handle && unlockedId === OUTLINE_ID) {
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
        const p = layout.outline[i];
        const q = layout.outline[(i + 1) % layout.outline.length];
        layout.outline.splice(i + 1, 0, { x: snap((p.x + q.x) / 2), y: snap((p.y + q.y) / 2) });
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
      lastTap = null;
      if (selectedId !== null || selectedVertex !== null) {
        selectedId = null;
        selectedVertex = null;
        unlockedId = null;
        renderProps();
      }
      redraw();
      e.preventDefault(); // stop the browser from text-selecting on empty-area drags
      return;
    }
    if (target.dataset.id === OUTLINE_ID) {
      // the outline takes the same lock as every item — a tap on the outer
      // wall used to hand over draggable corners straight away
      const wasUnlocked = unlockedId === OUTLINE_ID;
      const t = Date.now();
      const dbl = lastTap?.id === OUTLINE_ID && t - lastTap.t < DOUBLE_TAP_MS;
      const q = svgPoint(e);
      lastTap = { id: OUTLINE_ID, t, x: q.x, y: q.y };
      if (selectedId !== OUTLINE_ID) {
        selectedId = OUTLINE_ID;
        selectedVertex = null;
        unlockedId = null;
      }
      if (dbl) {
        unlockedId = wasUnlocked ? null : OUTLINE_ID;
        lastTap = null;
      }
      renderProps();
      redraw();
      e.preventDefault();
      return;
    }
    const item = findItem(layout, target.dataset.id);
    if (!item) return;
    selectedVertex = null;
    // read the lock BEFORE select(), which re-locks on a selection change
    const wasUnlocked = unlockedId === item.id;
    const now = Date.now();
    const doubleTap = lastTap?.id === item.id && now - lastTap.t < DOUBLE_TAP_MS;
    lastTap = { id: item.id, t: now, x: svgPoint(e).x, y: svgPoint(e).y };
    select(item.id);
    if (doubleTap && !target.dataset.handle) {
      // the gesture TOGGLES: the same double tap that unlocked the item
      // locks it again, so getting back to a safe map never requires
      // hunting for empty floor to tap
      unlockedId = wasUnlocked ? null : item.id;
      lastTap = null; // a third tap opens a fresh pair, not a rolling toggle
      renderProps(); // the card's hint line names the state it just entered
    }
    // LOCKED IS THE DEFAULT: a single tap selects and opens the card, but
    // starts no drag at all — neither a move nor a resize. Reading the lock
    // from before select() also means a stale handle from a render that
    // raced the re-lock cannot stretch anything.
    if (!wasUnlocked) {
      drag = null;
      redraw();
      e.preventDefault();
      return;
    }
    const p = svgPoint(e);
    drag = target.dataset.handle
      ? { mode: 'resize', item, moved: false }
      : { mode: 'move', item, offX: p.x - item.x, offY: p.y - item.y, moved: false };
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ }
    redraw();
    e.preventDefault();
  });

  svg.addEventListener('pointermove', (e) => {
    // A contact that travels is a drag, not a tap — drop it from the
    // double-tap pairing. Checked before the drag guard, because a LOCKED
    // item starts no drag at all and would otherwise keep pairing.
    if (lastTap && Date.now() - lastTap.t < DOUBLE_TAP_MS) {
      const q = svgPoint(e);
      if (Math.hypot(q.x - lastTap.x, q.y - lastTap.y) > TAP_SLOP) lastTap = null;
    }
    if (!drag) return;
    const p = svgPoint(e);
    if (drag.mode === 'vertex') {
      const v = layout.outline[drag.index];
      const nx = clamp(snap(p.x), 0, layout.grid.w);
      const ny = clamp(snap(p.y), 0, layout.grid.h);
      if (nx === v.x && ny === v.y) return; // sub-snap wiggle: nothing changed
      layout.outline[drag.index] = { x: nx, y: ny };
      drag.moved = true;
      redraw();
      return;
    }
    const it = drag.item;
    const before = { x: it.x, y: it.y, w: it.w, h: it.h };
    if (drag.mode === 'move') {
      if (WALL_SNAPPED.has(it.fixture)) {
        // wall pieces ignore the grid and glue themselves to the nearest wall
        it.x = p.x - drag.offX;
        it.y = p.y - drag.offY;
        snapDoorToWall(layout, it);
      } else {
        // clamp so the item's bounding box stays on the floor (works for
        // rects and for lines with negative w/h)
        const nx = clamp(snap(p.x - drag.offX), -Math.min(it.w, 0), layout.grid.w - Math.max(it.w, 0));
        const ny = clamp(snap(p.y - drag.offY), -Math.min(it.h, 0), layout.grid.h - Math.max(it.h, 0));
        // when the target spot collides with another machine, try each
        // axis alone so the item slides along the neighbor's edge
        if (fits(layout, it, nx, ny, it.w, it.h)) {
          it.x = nx;
          it.y = ny;
        } else if (fits(layout, it, nx, it.y, it.w, it.h)) {
          it.x = nx;
        } else if (fits(layout, it, it.x, ny, it.w, it.h)) {
          it.y = ny;
        }
      }
    } else if (it.kind === 'line') {
      it.w = clamp(snap(p.x - it.x), -it.x, layout.grid.w - it.x);
      it.h = clamp(snap(p.y - it.y), -it.y, layout.grid.h - it.y);
    } else {
      const minSize = it.kind === 'fixture' ? 1 : 2; // mirrors etc. may be slim
      const nw = clamp(snap(p.x - it.x), minSize, layout.grid.w - it.x);
      const nh = clamp(snap(p.y - it.y), minSize, layout.grid.h - it.y);
      // growing into a neighboring machine is blocked per axis
      if (fits(layout, it, it.x, it.y, nw, nh)) {
        it.w = nw;
        it.h = nh;
      } else if (fits(layout, it, it.x, it.y, nw, it.h)) {
        it.w = nw;
      } else if (fits(layout, it, it.x, it.y, it.w, nh)) {
        it.h = nh;
      }
    }
    // sub-snap wiggles and fully blocked drags change nothing — don't
    // mark the drag as moved, or endDrag would record a no-op undo entry
    if (it.x === before.x && it.y === before.y && it.w === before.w && it.h === before.h) return;
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
    return layout.machines.reduce((mx, m) => Math.max(mx, m.num), 0) + 1;
  }

  function addItem(kind, fixtureType = null) {
    const g = layout.grid;
    const off = ((layout.shapes.length + layout.machines.length) % 6); // cascade new items
    let item;
    if (kind === 'machine') {
      const num = nextNum();
      const pos = freeSpot(layout, snap(g.w / 2 - 2 + off), snap(g.h / 2 - 1.5 + off), 4, 3);
      item = {
        id: uid(), num, label: `Machine ${num}`,
        x: pos.x, y: pos.y,
        w: 4, h: 3, settingsFields: [], muscles: [], docUrl: '',
      };
      layout.machines.push(item);
    } else if (kind === 'rect') {
      item = { id: uid(), kind: 'rect', label: '', x: snap(g.w / 2 - 6 + off), y: snap(g.h / 2 - 4 + off), w: 12, h: 8 };
      layout.shapes.push(item);
    } else if (kind === 'fixture') {
      const f = FIXTURES[fixtureType];
      const wx = snap(g.w / 2 - f.w / 2 + off);
      const wy = snap(g.h / 2 - f.h / 2 + off);
      // wall pieces snap to a wall anyway; solid furniture lands on a
      // free spot like machines do
      const pos = WALL_SNAPPED.has(fixtureType) ? { x: wx, y: wy } : freeSpot(layout, wx, wy, f.w, f.h);
      item = {
        id: uid(), kind: 'fixture', fixture: fixtureType,
        x: pos.x, y: pos.y,
        w: f.w, h: f.h,
      };
      if (WALL_SNAPPED.has(fixtureType)) snapDoorToWall(layout, item); // born on a wall
      layout.shapes.push(item);
    } else {
      item = { id: uid(), kind: 'line', x: snap(g.w / 2 - 4 + off), y: snap(g.h / 2 + off), w: 8, h: 0 };
      layout.shapes.push(item);
    }
    save();
    select(item.id);
    // you just created this on purpose, so it starts unlocked — otherwise
    // every new item would need a double tap before it could be placed
    unlockedId = item.id;
    lastTap = null;
    renderProps();
    redraw();
  }

  root.querySelector('#add-room').addEventListener('click', () => addItem('rect'));
  root.querySelector('#add-wall').addEventListener('click', () => addItem('line'));
  root.querySelector('#add-machine').addEventListener('click', () => addItem('machine'));
  root.querySelectorAll('.add-fixture').forEach((btn) => {
    btn.addEventListener('click', () => addItem('fixture', btn.dataset.fixture));
  });

  // "find a machine by number" — mirrors the Train picker's number lookup.
  // No enterkeyhint on the field: a type=number keypad has no return key on
  // iOS, so the hint would be a promise the keyboard can't keep — the Go
  // button beside it is the way in.
  const findInput = root.querySelector('#find-num');
  const findErr = root.querySelector('#find-err');
  const findGo = () => {
    const n = Math.round(parseFloat(findInput.value));
    if (!n || n < 1) return;
    const machine = findMachineByNum(layout, n);
    if (!machine) {
      findErr.textContent = `No machine #${n}`;
      return;
    }
    findErr.textContent = '';
    findHighlightId = machine.id;
    select(machine.id);
    redraw();
  };
  root.querySelector('#find-go').addEventListener('click', findGo);
  findInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') findGo(); });

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
      <p class="muted" id="tpl-msg">Loading a template replaces the current layout
      (workout history stays).</p>
      <p class="muted"><a class="linkish" target="_blank" rel="noopener"
        href="https://github.com/bmmmm/gymii/issues/new?template=01-gym-template.yml">Share
        your gym</a> — send in your floor plan and it becomes part of this library.</p>`;

    const msg = panel.querySelector('#tpl-msg');
    const apply = (data) => {
      importData(data);
      renderGym(root);
    };

    panel.addEventListener('click', async (e) => {
      const btn = e.target.closest('.tpl-load');
      if (!btn) return;
      if (!twoTapConfirm(btn, 'Tap again to replace current layout', btn.dataset.label)) return;
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

  // Layer chips, for every shape that can end up under another one: zones,
  // walls and free-standing furniture. Wall-snapped fixtures are left out —
  // they glue to a wall in their own layer, where stacking means nothing.
  // Machines are left out too: fits() keeps them from overlapping at all.
  const layerRow = (item) => `
    <div class="field-block"><span>Layer — what sits in front of what</span>
      <div class="chip-select" id="item-layer">
        ${MAP_LAYERS.map((l) => `<button type="button"
          class="chip${(item.z ?? 0) === l.z ? ' sel' : ''}" data-z="${l.z}">${esc(l.label)}</button>`).join('')}
      </div>
    </div>`;

  const wireLayerRow = (item) => {
    props.querySelector('#item-layer').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const z = parseInt(chip.dataset.z, 10);
      if (z) item.z = z;
      else delete item.z; // absent = Normal, so exports stay clean
      save();
      redraw();
      renderProps();
    });
  };

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

  // Every props re-render replaces the whole card, and a chip tap is a
  // re-render — so the text field you were typing in would lose the caret
  // and the keyboard mid-word. preserveFocus puts both back (the fields
  // stage their value on `input`, so nothing typed is lost either).
  function renderProps() {
    preserveFocus(props, renderPropsCard);
  }

  function renderPropsCard() {
    if (selectedId === OUTLINE_ID) {
      const canDelete = selectedVertex !== null && layout.outline.length > 3;
      props.innerHTML = `
        <section class="card">
          <h2>Floor outline</h2>
          <p class="muted">${layout.outline.length} corners. ${unlockedId === OUTLINE_ID
    ? '🔓 Unlocked — drag a white corner to reshape the floor, tap a hollow dot between two corners to add one. Double-tap the outline again to lock.'
    : '🔒 Locked so the floor cannot be reshaped by accident. Double-tap the outer wall to unlock its corners.'}</p>
          <button id="del-vertex" class="btn btn-danger" ${canDelete ? '' : 'disabled'}>
            ${selectedVertex === null
              ? 'Tap a corner to delete it'
              : canDelete ? 'Delete selected corner' : 'A floor needs at least 3 corners'}
          </button>
          <button id="reset-outline" class="btn">Reset outline to full rectangle</button>
        </section>`;
      props.querySelector('#del-vertex').addEventListener('click', () => {
        if (selectedVertex === null || layout.outline.length <= 3) return;
        layout.outline.splice(selectedVertex, 1);
        selectedVertex = null;
        save();
        redraw();
        renderProps();
      });
      props.querySelector('#reset-outline').addEventListener('click', () => {
        layout.outline = defaultOutline(layout.grid);
        selectedVertex = null;
        save();
        redraw();
        renderProps();
      });
      return;
    }

    const item = selectedId ? findItem(layout, selectedId) : null;

    if (!item) {
      props.innerHTML = `
        <section class="card">
          <h2>Layout</h2>
          <!-- "Layout name", not "Gym name": Settings owns the gym's own name
               (the one you switch between) — this one travels with the
               exported template. Two different names, so they say so. -->
          <label class="field"><span>Layout name</span><input id="gym-name" type="text" value="${esc(layout.name)}"></label>
          <label class="field"><span>Floor width</span>
            <div class="stepper" data-step="5" data-min="20">
              <button type="button" class="step-down">−</button>
              <input id="floor-w" type="number" inputmode="numeric" value="${layout.grid.w}">
              <button type="button" class="step-up">+</button>
            </div>
          </label>
          <label class="field"><span>Floor height</span>
            <div class="stepper" data-step="5" data-min="20">
              <button type="button" class="step-down">−</button>
              <input id="floor-h" type="number" inputmode="numeric" value="${layout.grid.h}">
              <button type="button" class="step-up">+</button>
            </div>
          </label>
          <p class="muted">Add rooms, walls and machines, then drag them into place.
          Everything on the plan is 🔒 locked: a tap only opens an item for
          editing. Double-tap an item to unlock it for moving and resizing,
          double-tap again to lock it. Tap the outer wall to reshape the floor
          outline.</p>
        </section>
        <section class="card">
          <h2>Location</h2>
          <label class="field"><span>Address</span><input id="gym-address" type="text"
            value="${esc(layout.meta?.address || '')}"></label>
          <label class="field"><span>Postcode</span><input id="gym-postcode" type="text"
            inputmode="numeric" autocomplete="postal-code"
            value="${esc(layout.meta?.postcode || '')}"></label>
          <label class="field"><span>City</span><input id="gym-city" type="text"
            value="${esc(layout.meta?.city || '')}"></label>
          <label class="field"><span>Country</span><input id="gym-country" type="text"
            value="${esc(layout.meta?.country || '')}"></label>
          <a id="gym-osm" class="linkish" target="_blank" rel="noopener"
            href="${esc(osmUrl(layout.meta))}" ${osmQuery(layout.meta) ? '' : 'hidden'}>Find
            this address on OpenStreetMap ↗</a>
          <p class="muted">Travels with the template so others can find this gym when you share it.</p>
        </section>
        <section class="card">
          <h2>Templates</h2>
          <button id="load-template" class="btn">Load template…</button>
          <button id="save-template" class="btn">Save as template</button>
          <div id="template-browser"></div>
        </section>`;

      // The card is not re-rendered on a meta edit (that would fight the
      // keyboard), so the link has to be refreshed by hand.
      const osmLink = props.querySelector('#gym-osm');
      const bindMeta = (sel, key) => {
        props.querySelector(sel).addEventListener('change', (e) => {
          layout.meta = { ...(layout.meta || {}), [key]: e.target.value.trim() };
          save();
          osmLink.href = osmUrl(layout.meta);
          osmLink.hidden = !osmQuery(layout.meta);
        });
      };
      bindMeta('#gym-address', 'address');
      bindMeta('#gym-postcode', 'postcode');
      bindMeta('#gym-city', 'city');
      bindMeta('#gym-country', 'country');

      props.querySelector('#save-template').addEventListener('click', () => {
        const slug = [layout.name, layout.meta?.city].filter(Boolean).join('-')
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'gym';
        download(`gymii-template-${slug}.json`, exportGymTemplate());
      });

      props.querySelector('#load-template').addEventListener('click', () => {
        openTemplateBrowser(props.querySelector('#template-browser'));
      });
      props.querySelector('#gym-name').addEventListener('change', (e) => {
        layout.name = e.target.value.trim() || 'My gym';
        save();
      });
      const onFloor = (inputId, key) => {
        props.querySelector(inputId).addEventListener('change', (e) => {
          const v = clamp(Math.round(parseFloat(e.target.value) || 20), 20, 200);
          e.target.value = v;
          layout.grid[key] = v;
          layout.outline.forEach((p) => { // keep the outline on the shrunk floor
            p.x = Math.min(p.x, layout.grid.w);
            p.y = Math.min(p.y, layout.grid.h);
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
      const brandOptions = [...new Set([...MACHINE_BRANDS, ...(item.brand ? [item.brand] : [])])];
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
          <div class="field-block"><span>Brand — tap to set, tap again to clear</span>
            <div class="chip-select" id="m-brands">
              ${brandOptions.map((b) => `<button type="button"
                class="chip${item.brand === b ? ' sel' : ''}" data-value="${esc(b)}">${esc(b)}</button>`).join('')}
            </div>
            <div class="row">
              <input id="m-brand-custom" type="text" enterkeyhint="done" placeholder="Other brand…">
              <button type="button" id="m-brand-set" class="btn btn-inline">Set</button>
            </div>
          </div>
          <label class="field"><span>Model</span><input id="m-model" type="text"
            placeholder="e.g. Selection Pro Chest Press" value="${esc(item.model || '')}"></label>
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
              <input id="m-field-custom" type="text" enterkeyhint="done" placeholder="Other setting…">
              <button type="button" id="m-field-add" class="btn btn-inline">Add</button>
            </div>
          </div>
          <div class="field-block"><span>Exercises — for free-weight or multi-exercise machines</span>
            <div class="chip-select" id="m-exercises">${chipRow(item.exercises ?? [], item.exercises ?? [])}</div>
            <div class="row">
              <input id="m-exercise-custom" type="text" enterkeyhint="done" placeholder="e.g. Biceps curls…">
              <button type="button" id="m-exercise-add" class="btn btn-inline">Add</button>
            </div>
          </div>
          <label class="field"><span>Doc link</span><input id="m-doc" type="text" inputmode="url"
            placeholder="https://…" value="${esc(item.docUrl || '')}"></label>
          <p class="muted">${unlockedId === item.id
    ? '🔓 Unlocked — drag it on the plan to move it, drag the handle to resize. Double-tap it again to lock.'
    : '🔒 Locked so it cannot be nudged by accident. Double-tap it on the plan to move or resize it.'}</p>
          <button id="del-item" class="btn btn-danger">Delete machine</button>
        </section>`;

      props.querySelector('#m-num').addEventListener('change', (e) => {
        item.num = Math.max(1, Math.round(parseFloat(e.target.value) || 1));
        e.target.value = item.num;
        save();
        redraw();
      });
      // Text fields commit on `change` — which only fires on blur or Enter,
      // while a chip tap right next to them re-renders the card. Staging
      // every keystroke into the item means the re-render prints back what
      // was typed instead of eating it; `change` still owns the undo
      // snapshot, the trim and the fallback.
      const stageText = (sel, onInput, onChange) => {
        const el = props.querySelector(sel);
        el.addEventListener('input', () => onInput(el.value));
        el.addEventListener('change', () => {
          el.value = onChange(el.value.trim()) ?? el.value;
          save();
        });
      };
      stageText('#m-label', (v) => { item.label = v; }, (v) => {
        item.label = v || `Machine ${item.num}`;
        return item.label;
      });
      // Absent, never empty: exports and templates stay clean, and
      // "has a brand" is a plain truthiness check everywhere else.
      const optionalText = (key) => (v) => {
        if (v) item[key] = v;
        else delete item[key];
        return v;
      };
      stageText('#m-model', (v) => { item.model = v; }, optionalText('model'));

      props.querySelector('#m-brands').addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        if (item.brand === chip.dataset.value) delete item.brand;
        else item.brand = chip.dataset.value;
        save();
        renderProps();
      });
      const setBrand = () => {
        const input = props.querySelector('#m-brand-custom');
        const v = input.value.trim();
        if (!v) return;
        item.brand = v;
        save();
        renderProps();
        // the chip row above grew by one — keep the field where it was
        keepInView(props, '#m-brand-custom');
      };
      props.querySelector('#m-brand-set').addEventListener('click', setBrand);
      props.querySelector('#m-brand-custom').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') setBrand();
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
        // the chip row above grew by one — keep the field where it was
        keepInView(props, '#m-field-custom', { focus: true });
      };
      props.querySelector('#m-field-add').addEventListener('click', addCustomField);
      props.querySelector('#m-field-custom').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addCustomField();
      });

      // Exercises: tap a chip to remove it, add via the text row. The field
      // is deleted when emptied so plain machines export without it.
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
        keepInView(props, '#m-exercise-custom', { focus: true });
      };
      props.querySelector('#m-exercise-add').addEventListener('click', addExercise);
      props.querySelector('#m-exercise-custom').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addExercise();
      });

      stageText('#m-doc', (v) => { item.docUrl = v; }, (v) => {
        item.docUrl = v;
        return v;
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
              <input id="z-custom" type="text" enterkeyhint="done" placeholder="Custom label…">
              <button type="button" id="z-set" class="btn btn-inline">Set</button>
            </div>
          </div>
          <div class="field-block"><span>Color on the plan</span>
            <div id="z-color">${colorRow(item.color)}</div>
          </div>
          ${layerRow(item)}
          <p class="muted">${unlockedId === item.id
    ? '🔓 Unlocked — drag it on the plan to move it, drag the handle to resize. Double-tap it again to lock.'
    : '🔒 Locked so it cannot be nudged by accident. Double-tap it on the plan to move or resize it.'}</p>
          <button id="del-item" class="btn btn-danger">Delete</button>
        </section>`;
      wireColorRow('#z-color', item);
      wireLayerRow(item);
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
      // doors/windows/entrances ride their own layer on the wall
      const stackable = !WALL_SNAPPED.has(item.fixture);
      props.innerHTML = `
        <section class="card">
          <h2>${item.kind === 'line' ? 'Wall' : (FIXTURES[item.fixture]?.label ?? 'Element')}</h2>
          ${isDoor ? `
            <button id="flip-swing" class="btn">Flip swing side (in/out)</button>
            <button id="flip-hinge" class="btn">Flip hinge side (left/right)</button>` : ''}
          ${isEntrance ? '<button id="flip-swing" class="btn">Flip direction (in/out)</button>' : ''}
          ${stackable ? layerRow(item) : ''}
          <button id="del-item" class="btn btn-danger">Delete</button>
        </section>`;
      if (stackable) wireLayerRow(item);
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
      layout.machines = layout.machines.filter((m) => m.id !== item.id);
      layout.shapes = layout.shapes.filter((s) => s.id !== item.id);
      save();
      select(null);
      redraw();
    });
  }

  // Train may have handed a machine over via focusMachine() before switching
  // tabs — preselect it here and reuse the find-by-number pulse to point it
  // out, then clear the handoff so it doesn't stick on the next render.
  if (pendingFocus) {
    if (findItem(layout, pendingFocus)) {
      selectedId = pendingFocus;
      findHighlightId = pendingFocus;
    }
    pendingFocus = null;
  }

  redraw();
  renderProps();
}
