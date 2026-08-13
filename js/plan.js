// Plan builder — create or edit a stored workout plan: pick machines by
// muscle, order them, set per-machine targets. It renders inside the Train
// tab (train.js owns the open/close state). Nothing persists until Save,
// so an imported AI draft can be reviewed and trimmed before it sticks.

import {
  getGym, getPlans, savePlan, deletePlan, lastEntryFor, getSettings,
  uid, distUnit, gymMuscles,
} from './store.js';
import { drawGym } from './studio.js';
import { esc, twoTapConfirm, stepperField } from './ui.js';

// Seeds a fresh item's target from the last session on that machine so a
// new plan starts from reality, not from zero. Cross-type history (the
// machine's type flag changed since) is ignored, like renderLog does.
function targetDefaults(machine, exercise, s) {
  const last = lastEntryFor(machine.id, exercise ?? null);
  const typed = last
    && !!last.cardio === !!machine.cardio
    && !!last.bodyweight === !!machine.bodyweight ? last : null;
  const st = typed?.sets[typed.sets.length - 1];
  if (machine.cardio) {
    return {
      distance: st?.distance ?? (s.unit === 'kg' ? 1000 : 0.5),
      seconds: st?.seconds ?? 600,
    };
  }
  return {
    sets: typed?.sets.length || 3,
    reps: st?.reps ?? 10,
    weight: st?.weight ?? (machine.bodyweight ? 0 : 20),
  };
}

export function renderPlanBuilder(root, { planId = null, notice = '' } = {}, onClose) {
  const gym = getGym();
  if (!gym) { onClose(''); return; }
  const s = getSettings();
  const du = distUnit(s);
  const stored = planId ? getPlans().find((p) => p.id === planId) : null;
  // the draft is a deep copy — Cancel must leave the stored plan untouched
  const draft = stored
    ? JSON.parse(JSON.stringify(stored))
    : { id: uid(), name: '', items: [] };
  let muscle = ''; // active muscle filter, '' = all

  const machineFor = (id) => gym.machines.find((m) => m.id === id);
  // imported items may arrive target-less — give them one so the steppers
  // have something to edit
  draft.items.forEach((it) => {
    const m = machineFor(it.machineId);
    if (!it.target && m) it.target = targetDefaults(m, it.exercise, s);
  });
  const allMuscles = gymMuscles(gym);

  const itemRow = (it, i) => {
    const m = machineFor(it.machineId);
    if (!m) {
      // stale item (machine deleted since the plan was saved/imported)
      return `<div class="plan-item">
        <div class="plan-item-head">
          <span class="machine-badge sm">?</span>
          <span class="plan-label muted">Machine no longer exists</span>
          <span class="plan-item-actions">
            <button type="button" class="x it-remove" data-i="${i}" aria-label="Remove item ${i + 1}">✕</button>
          </span>
        </div>
      </div>`;
    }
    const t = it.target;
    return `<div class="plan-item">
      <div class="plan-item-head">
        <span class="machine-badge sm">${m.num}</span>
        <span class="plan-label">${esc(m.label)}</span>
        <span class="plan-item-actions">
          <button type="button" class="x it-up" data-i="${i}" aria-label="Move ${esc(m.label)} up">↑</button>
          <button type="button" class="x it-down" data-i="${i}" aria-label="Move ${esc(m.label)} down">↓</button>
          <button type="button" class="x it-remove" data-i="${i}" aria-label="Remove ${esc(m.label)}">✕</button>
        </span>
      </div>
      ${m.exercises?.length ? `
      <div class="chip-select">
        ${m.exercises.map((x) => `<button type="button" class="chip it-exercise${it.exercise === x ? ' sel' : ''}"
          data-i="${i}" data-exercise="${esc(x)}">${esc(x)}</button>`).join('')}
      </div>` : ''}
      <div class="plan-targets">
        ${m.cardio ? `
        ${stepperField(`Distance (${du})`, `t-distance-${i}`, { step: s.unit === 'kg' ? 100 : 0.1, min: 0, value: t.distance })}
        ${stepperField('Time (min)', `t-time-${i}`, { step: 1, min: 0, value: Math.round((t.seconds / 60) * 100) / 100 })}`
    : `
        ${stepperField('Sets', `t-sets-${i}`, { step: 1, min: 1, value: t.sets, mode: 'numeric' })}
        ${stepperField('Reps', `t-reps-${i}`, { step: 1, min: 1, value: t.reps, mode: 'numeric' })}
        ${stepperField(m.bodyweight ? 'Extra weight' : 'Weight', `t-weight-${i}`, { step: s.weightStep, min: 0, value: t.weight })}`}
      </div>
    </div>`;
  };

  function render() {
    const inPlan = new Set(draft.items.map((it) => it.machineId));
    const filtered = (muscle
      ? gym.machines.filter((m) => (m.muscles || []).includes(muscle))
      : gym.machines).slice().sort((a, b) => a.num - b.num);

    root.innerHTML = `
      <h1>${stored ? 'Edit plan' : 'Plan workout'}</h1>
      ${notice ? `<p class="notice" role="status">${esc(notice)}</p>` : ''}
      <section class="card">
        <h2>Name</h2>
        <div class="row">
          <input id="plan-name" type="text" placeholder="e.g. Push day" value="${esc(draft.name)}">
        </div>
        <p class="muted">A named plan owns its routine on the start screen —
          workouts you log from it group under this name.</p>
      </section>
      <section class="card">
        <h2>Machines &amp; targets</h2>
        <div id="plan-items">
          ${draft.items.map(itemRow).join('') || '<p class="muted">No machines yet — add some below.</p>'}
        </div>
      </section>
      <section class="card">
        <h2>Add machines</h2>
        ${allMuscles.length ? `
        <div class="chip-select" id="muscle-chips">
          <button type="button" class="chip${muscle === '' ? ' sel' : ''}" data-muscle="">All</button>
          ${allMuscles.map((x) => `<button type="button" class="chip${muscle === x ? ' sel' : ''}"
            data-muscle="${esc(x)}">${esc(x)}</button>`).join('')}
        </div>` : ''}
        <div class="chip-select" id="machine-chips">
          ${filtered.map((m) => `<button type="button" class="chip${inPlan.has(m.id) ? ' sel' : ''}"
            data-id="${m.id}">#${m.num} ${esc(m.label)}</button>`).join('')
            || '<p class="muted">No machines match this muscle.</p>'}
        </div>
        <div class="map-wrap"><svg xmlns="http://www.w3.org/2000/svg"></svg></div>
        <p class="muted">Tap a machine — chip or map — to add or remove it.</p>
      </section>
      <button id="plan-save" class="btn btn-primary btn-big">Save plan</button>
      ${stored ? '<button id="plan-delete" class="btn btn-danger">Delete plan</button>' : ''}
      <button id="plan-cancel" class="btn">Cancel</button>
      <p id="plan-msg" class="muted" role="status"></p>`;

    const svg = root.querySelector('svg');
    drawGym(svg, gym, {});
    if (muscle) { // dim non-matching machines like the picker's filter
      const ids = new Set(filtered.map((m) => m.id));
      svg.querySelectorAll('.machine').forEach((g) => {
        g.style.opacity = ids.has(g.dataset.id) ? '' : '0.22';
      });
    }

    root.querySelector('#plan-name').addEventListener('change', (e) => {
      draft.name = e.target.value.trim();
    });

    const toggleMachine = (id) => {
      if (!machineFor(id)) return;
      if (inPlan.has(id)) {
        draft.items = draft.items.filter((it) => it.machineId !== id);
      } else {
        draft.items.push({ machineId: id, exercise: null, target: targetDefaults(machineFor(id), null, s) });
      }
      render();
    };

    root.querySelector('#plan-items').addEventListener('click', (e) => {
      const btn = e.target.closest('.it-remove, .it-up, .it-down, .it-exercise');
      if (!btn) return;
      const i = parseInt(btn.dataset.i, 10);
      const it = draft.items[i];
      if (!it) return;
      if (btn.classList.contains('it-remove')) {
        draft.items.splice(i, 1);
      } else if (btn.classList.contains('it-up') || btn.classList.contains('it-down')) {
        const j = i + (btn.classList.contains('it-up') ? -1 : 1);
        if (j < 0 || j >= draft.items.length) return;
        [draft.items[i], draft.items[j]] = [draft.items[j], draft.items[i]];
      } else {
        // exercise chip: toggle between a scoped and a whole-station slot,
        // reseeding the target — weights differ per exercise
        const x = btn.dataset.exercise;
        it.exercise = it.exercise === x ? null : x;
        const m = machineFor(it.machineId);
        if (m) it.target = targetDefaults(m, it.exercise, s);
      }
      render();
    });

    root.querySelector('#plan-items').addEventListener('change', (e) => {
      const match = /^t-(sets|reps|weight|distance|time)-(\d+)$/.exec(e.target.id || '');
      if (!match) return;
      const t = draft.items[Number(match[2])]?.target;
      if (!t) return;
      const v = parseFloat(e.target.value) || 0;
      if (match[1] === 'sets') { t.sets = Math.max(1, Math.round(v)); e.target.value = t.sets; }
      else if (match[1] === 'reps') { t.reps = Math.max(1, Math.round(v)); e.target.value = t.reps; }
      else if (match[1] === 'weight') { t.weight = Math.max(0, v); e.target.value = t.weight; }
      else if (match[1] === 'distance') { t.distance = Math.max(0, v); e.target.value = t.distance; }
      else t.seconds = Math.max(0, Math.round(v * 60));
    });

    root.querySelector('#muscle-chips')?.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      muscle = chip.dataset.muscle ?? '';
      render();
    });

    root.querySelector('#machine-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) toggleMachine(chip.dataset.id);
    });

    svg.addEventListener('click', (e) => {
      const g = e.target.closest('.machine');
      if (g) toggleMachine(g.dataset.id);
    });

    root.querySelector('#plan-save').addEventListener('click', () => {
      draft.name = root.querySelector('#plan-name').value.trim();
      if (!draft.items.length) {
        root.querySelector('#plan-msg').textContent = 'Add at least one machine first.';
        return;
      }
      savePlan(draft);
      onClose(`Plan ${draft.name ? `"${draft.name}" ` : ''}saved.`);
    });

    const delBtn = root.querySelector('#plan-delete');
    delBtn?.addEventListener('click', () => {
      if (!twoTapConfirm(delBtn, 'Tap again to delete this plan', 'Delete plan')) return;
      deletePlan(draft.id);
      onClose('Plan deleted.');
    });

    root.querySelector('#plan-cancel').addEventListener('click', () => onClose(''));
  }

  render();
}
