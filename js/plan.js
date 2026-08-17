// Plan builder — create or edit a stored workout plan: pick machines by
// muscle, order them, set per-machine targets. It renders inside the Train
// tab (train.js owns the open/close state). Nothing persists until Save,
// so an imported AI draft can be reviewed and trimmed before it sticks.
//
// It runs WITHOUT a gym: items typed from a trainer's note start unbound
// (a name and a target, no machine) and bind here or on the gym floor.

import {
  getGym, saveGym, newGym, bindOrCreateMachine, getPlans, savePlan, deletePlan,
  lastEntryFor, getSettings, getWorkouts, usualWeekday, uid, distUnit,
  gymMuscles, isUnbound,
  parsePlanText, planItemsFrom, planToText, nameChipsFor,
} from './store.js';
import { drawGym } from './studio.js';
import { esc, twoTapConfirm, stepperField, plural } from './ui.js';

// Weekday labels indexed by Date#getDay() (0 = Sunday); chips render
// Monday-first, like gym weeks are planned.
export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

// Seeds a fresh item's target from the last session on that machine so a
// new plan starts from reality, not from zero. Cross-type history (the
// machine's type flag changed since) is ignored, like renderLog does.
// machine null = an unbound item: no history to seed from, so the target
// falls back to the plain strength default (cardio unbound items keep the
// shape their note gave them).
function targetDefaults(machine, exercise, s) {
  if (!machine) return { sets: 3, reps: 10, weight: 20 };
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

// An item's type without needing its machine: bound items follow the
// station, unbound ones the shape their target arrived in.
const itemIsCardio = (item, machine) =>
  (machine ? !!machine.cardio : item.target?.distance != null);

export function renderPlanBuilder(
  root, { planId = null, notice = '', seed = null, seedName = '' } = {}, onClose,
) {
  let gym = getGym(); // may be null — a plan can exist before the gym does
  const s = getSettings();
  const du = distUnit(s);
  const stored = planId ? getPlans().find((p) => p.id === planId) : null;
  // the draft is a deep copy — Cancel must leave the stored plan (or the
  // routine a seed came from) untouched
  const draft = stored
    ? JSON.parse(JSON.stringify(stored))
    : {
      id: uid(),
      name: seedName,
      items: seed ? JSON.parse(JSON.stringify(seed)) : [],
    };
  let muscle = ''; // active muscle filter, '' = all
  let binding = null; // index of the item whose bind prompt is open
  // Two views of ONE plan: the list is precise (steppers, chips, binding),
  // the text is fast (reorder by moving a line, drop one by deleting it).
  // Switching either way goes through the parser/serialiser pair, so the
  // note stays the source of truth while it is on screen.
  // A plan from scratch opens in Text — writing one down IS typing it out.
  // Anything that arrives with items (edit, AI import, a note just read, a
  // routine turned into a plan) opens as a list: that is a review, not a
  // blank page.
  let view = draft.items.length ? 'list' : 'text';

  const machineFor = (id) => (id ? gym?.machines.find((m) => m.id === id) : null);

  // The bind prompt: which station is this movement? A known num binds, an
  // unknown one creates the machine under the item's own name — the gym
  // grows out of the plan instead of gating it.
  const bindBox = (it, i) => {
    const candidates = (gym?.machines ?? []).slice().sort((a, b) => a.num - b.num);
    return `<div class="plan-bind">
      <div class="row">
        <input class="bind-num" type="number" inputmode="numeric" min="1"
          placeholder="Machine #" value="${it.num ?? ''}">
        <button type="button" class="btn btn-inline bind-go" data-i="${i}">Assign</button>
      </div>
      ${candidates.length ? `<div class="chip-select bind-chips">
        ${candidates.map((m) => `<button type="button" class="chip bind-pick"
          data-i="${i}" data-id="${m.id}">#${m.num} ${esc(m.label)}</button>`).join('')}
      </div>` : ''}
      <p class="muted">Enter the number on the machine — gymii creates
        &ldquo;${esc(it.name || 'it')}&rdquo; under that number if it doesn't know it yet.</p>
      <button type="button" class="btn bind-cancel">Cancel</button>
    </div>`;
  };

  const itemRow = (it, i) => {
    const m = machineFor(it.machineId);
    if (!m && !isUnbound(it)) {
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
    const label = m ? m.label : it.name;
    const cardio = itemIsCardio(it, m);
    return `<div class="plan-item${m ? '' : ' unbound'}">
      <div class="plan-item-head">
        <span class="machine-badge sm">${m ? m.num : '?'}</span>
        <span class="plan-label">${esc(label)}</span>
        <span class="plan-item-actions">
          <button type="button" class="x it-up" data-i="${i}" aria-label="Move ${esc(label)} up">↑</button>
          <button type="button" class="x it-down" data-i="${i}" aria-label="Move ${esc(label)} down">↓</button>
          <button type="button" class="x it-remove" data-i="${i}" aria-label="Remove ${esc(label)}">✕</button>
        </span>
      </div>
      ${m ? '' : `<button type="button" class="btn btn-inline it-bind" data-i="${i}">📍 Assign machine</button>`}
      ${binding === i ? bindBox(it, i) : ''}
      ${m?.exercises?.length ? `
      <div class="chip-select">
        ${m.exercises.map((x) => `<button type="button" class="chip it-exercise${it.exercise === x ? ' sel' : ''}"
          data-i="${i}" data-exercise="${esc(x)}">${esc(x)}</button>`).join('')}
      </div>` : ''}
      <div class="plan-targets">
        ${cardio ? `
        ${stepperField(`Distance (${du})`, `t-distance-${i}`, { step: s.unit === 'kg' ? 100 : 0.1, min: 0, value: t.distance })}
        ${stepperField('Time (min)', `t-time-${i}`, { step: 1, min: 0, value: Math.round((t.seconds / 60) * 100) / 100 })}`
    : `
        ${stepperField('Sets', `t-sets-${i}`, { step: 1, min: 1, value: t.sets, mode: 'numeric' })}
        ${stepperField('Reps', `t-reps-${i}`, { step: 1, min: 1, value: t.reps, mode: 'numeric' })}
        ${stepperField(m?.bodyweight ? 'Extra weight' : 'Weight', `t-weight-${i}`, { step: s.weightStep, min: 0, value: t.weight })}`}
      </div>
    </div>`;
  };

  function render() {
    // imported, pasted and typed items may arrive target-less — give them
    // one so the steppers always have something to edit
    draft.items.forEach((it) => {
      if (!it.target) it.target = targetDefaults(machineFor(it.machineId), it.exercise, s);
    });
    const machines = gym?.machines ?? [];
    const allMuscles = gym ? gymMuscles(gym) : [];
    const inPlan = new Set(draft.items.map((it) => it.machineId).filter(Boolean));
    const unboundCount = draft.items.filter(isUnbound).length;
    // a rhythm gymii noticed but the plan doesn't state yet — offered, not
    // applied: the plan says when you INTEND to train, history only says when
    // you did
    const usual = usualWeekday(draft, getWorkouts());
    const rhythm = usual != null && !draft.days?.includes(usual) ? usual : null;
    // what this plan trains, plus names already in use — a nameless plan
    // is a plan nobody finds again
    const nameChips = nameChipsFor(draft.items.map((it) => it.machineId).filter(Boolean), gym);
    const filtered = (muscle
      ? machines.filter((m) => (m.muscles || []).includes(muscle))
      : machines).slice().sort((a, b) => a.num - b.num);

    root.innerHTML = `
      <h1>${stored ? 'Edit plan' : 'Plan workout'}</h1>
      ${notice ? `<p class="notice" role="status">${esc(notice)}</p>` : ''}
      <section class="card">
        <h2>Name</h2>
        <div class="row">
          <input id="plan-name" type="text" placeholder="e.g. Push day" value="${esc(draft.name)}">
        </div>
        ${nameChips.length ? `
        <div class="chip-select" id="name-chips">
          ${nameChips.map((n) => `<button type="button" class="chip${draft.name === n ? ' sel' : ''}"
            data-name="${esc(n)}">${esc(n)}</button>`).join('')}
        </div>` : ''}
        <p class="muted">A named plan owns its routine on the start screen —
          workouts you log from it group under this name.</p>
      </section>
      <section class="card">
        <h2>Days</h2>
        <div class="chip-select" id="day-chips">
          ${DAY_ORDER.map((d) => `<button type="button" class="chip${draft.days?.includes(d) ? ' sel' : ''}"
            data-day="${d}">${DAY_LABELS[d]}</button>`).join('')}
        </div>
        ${rhythm != null ? `<p class="muted">You mostly train this on
          ${DAY_FULL[rhythm]}s. <button type="button" id="day-rhythm" class="linkish">Set
          ${DAY_LABELS[rhythm]}</button></p>`
    : '<p class="muted">Optional — a tagged plan tells the start screen what today is for.</p>'}
      </section>
      <section class="card">
        <h2>Exercises &amp; targets</h2>
        <div class="chip-select" id="view-chips">
          <button type="button" class="chip${view === 'list' ? ' sel' : ''}" data-view="list">List</button>
          <button type="button" class="chip${view === 'text' ? ' sel' : ''}" data-view="text">Text</button>
        </div>
        ${view === 'text' ? `
        <textarea id="plan-text" rows="10"></textarea>
        <p class="muted">One exercise per line. Move a line to reorder, delete
          one to drop it. A <em>#number</em> keeps it tied to that machine.</p>`
    : `
        <div id="plan-items">
          ${draft.items.map(itemRow).join('') || '<p class="muted">Nothing planned yet — add exercises below.</p>'}
        </div>
        ${unboundCount ? `<p class="muted">${plural(unboundCount, 'exercise')}
          without a machine — assign ${unboundCount === 1 ? 'it' : 'them'} here, or let gymii
          ask at the gym when you get there.</p>` : ''}`}
      </section>
      ${view === 'text' ? '' : `
      <section class="card">
        <h2>Add an exercise</h2>
        <div class="row">
          <input id="add-line" type="text" placeholder="e.g. Leg press 3x10 80">
          <button type="button" id="add-line-go" class="btn btn-inline">Add</button>
        </div>
        <p class="muted">One line, like your plan is written: sets × reps and a
          weight, or a time like <em>20min</em> for cardio. No machine needed yet.</p>
      </section>`}
      ${view === 'list' && machines.length ? `
      <section class="card">
        <h2>Add from your gym</h2>
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
      </section>` : ''}
      <button id="plan-save" class="btn btn-primary btn-big">Save plan</button>
      <button id="plan-start" class="btn btn-next btn-big">Save &amp; start workout</button>
      ${stored ? '<button id="plan-delete" class="btn btn-danger">Delete plan</button>' : ''}
      <button id="plan-cancel" class="btn">Cancel</button>
      <p id="plan-msg" class="muted" role="status"></p>`;

    // textarea content goes in via value, never innerHTML — user data can
    // never break out of the markup that way
    const textArea = root.querySelector('#plan-text');
    if (textArea) textArea.value = planToText(draft.items, gym, s);

    const svg = view === 'list' && machines.length ? root.querySelector('svg') : null;
    if (svg) {
      drawGym(svg, gym, {});
      if (muscle) { // dim non-matching machines like the picker's filter
        const ids = new Set(filtered.map((m) => m.id));
        svg.querySelectorAll('.machine').forEach((g) => {
          g.style.opacity = ids.has(g.dataset.id) ? '' : '0.22';
        });
      }
    }

    root.querySelector('#plan-name').addEventListener('change', (e) => {
      draft.name = e.target.value.trim();
    });

    // tapping a chip names the plan; tapping the selected one clears it
    root.querySelector('#name-chips')?.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      draft.name = draft.name === chip.dataset.name ? '' : chip.dataset.name;
      render();
    });

    // Pulls the text view back into items. Returns false (and says why)
    // only when there IS text but none of it reads as an exercise —
    // emptying the note deliberately is a valid edit, caught by persist.
    const fromText = () => {
      const ta = root.querySelector('#plan-text');
      if (!ta) return true;
      const raw = parsePlanText(ta.value, s);
      if (!raw.length && ta.value.trim()) {
        root.querySelector('#plan-msg').textContent =
          'No exercise found in that text — one per line, e.g. "Leg press 3x10 80".';
        return false;
      }
      draft.items = planItemsFrom(raw, gym);
      return true;
    };

    root.querySelector('#view-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip || chip.dataset.view === view) return;
      if (view === 'text' && !fromText()) return;
      view = chip.dataset.view;
      binding = null;
      render();
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

    // Binds an unbound item to a station, creating the gym and/or the
    // machine when the number is new (store's bindOrCreateMachine): the gym
    // grows out of the plan instead of gating it.
    const bindItem = (i, machineId, wantedNum) => {
      const it = draft.items[i];
      if (!it) return;
      let machine = machineId ? machineFor(machineId) : null;
      if (!machine && wantedNum > 0) {
        gym = gym ?? newGym();
        machine = bindOrCreateMachine(gym, wantedNum, it.name, it.target);
        saveGym(gym);
      }
      if (!machine) return;
      it.machineId = machine.id;
      delete it.name;
      delete it.num;
      // a station of the other type needs a target of that shape
      if (!!machine.cardio !== (it.target?.distance != null)) {
        it.target = targetDefaults(machine, it.exercise, s);
      }
      binding = null;
      render();
    };

    root.querySelector('#plan-items')?.addEventListener('click', (e) => {
      const btn = e.target.closest(
        '.it-remove, .it-up, .it-down, .it-exercise, .it-bind, .bind-go, .bind-pick, .bind-cancel');
      if (!btn) return;
      if (btn.classList.contains('bind-cancel')) { binding = null; render(); return; }
      const i = parseInt(btn.dataset.i, 10);
      const it = draft.items[i];
      if (!it) return;
      if (btn.classList.contains('it-bind')) {
        binding = binding === i ? null : i;
      } else if (btn.classList.contains('bind-pick')) {
        bindItem(i, btn.dataset.id, 0);
        return;
      } else if (btn.classList.contains('bind-go')) {
        const field = root.querySelector('.bind-num');
        bindItem(i, null, Math.round(parseFloat(field?.value) || 0));
        return;
      } else if (btn.classList.contains('it-remove')) {
        draft.items.splice(i, 1);
        binding = null;
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

    root.querySelector('#plan-items')?.addEventListener('change', (e) => {
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

    root.querySelector('#machine-chips')?.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) toggleMachine(chip.dataset.id);
    });

    svg?.addEventListener('click', (e) => {
      const g = e.target.closest('.machine');
      if (g) toggleMachine(g.dataset.id);
    });

    // One typed line = one exercise, the same grammar the onboarding note
    // uses — so a plan can be extended without ever touching a machine list.
    const addLine = () => {
      const field = root.querySelector('#add-line');
      const raw = parsePlanText(field.value, s);
      if (!raw.length) {
        root.querySelector('#plan-msg').textContent =
          'Nothing to add — try "Leg press 3x10 80" or "Treadmill 20min".';
        return;
      }
      draft.items.push(...planItemsFrom(raw, gym));
      field.value = '';
      render();
    };
    root.querySelector('#add-line-go')?.addEventListener('click', addLine);
    root.querySelector('#add-line')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addLine();
    });

    root.querySelector('#day-rhythm')?.addEventListener('click', () => {
      draft.days = [...new Set([...(draft.days ?? []), rhythm])].sort((a, b) => a - b);
      render();
    });

    root.querySelector('#day-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const d = parseInt(chip.dataset.day, 10);
      const days = new Set(draft.days ?? []);
      if (days.has(d)) days.delete(d); else days.add(d);
      draft.days = [...days].sort((a, b) => a - b);
      render();
    });

    // shared by Save and Save & start; days follow the locker-style
    // lifecycle (key dropped when emptied)
    const persist = () => {
      if (!fromText()) return false; // text view is authoritative while open
      draft.name = root.querySelector('#plan-name').value.trim();
      if (!draft.days?.length) delete draft.days;
      if (!draft.items.length) {
        root.querySelector('#plan-msg').textContent = 'Add at least one exercise first.';
        return false;
      }
      savePlan(draft);
      return true;
    };

    root.querySelector('#plan-save').addEventListener('click', () => {
      if (persist()) onClose(`Plan ${draft.name ? `"${draft.name}" ` : ''}saved.`);
    });

    // hands the saved plan back so train.js starts it — plan.js cannot
    // import startWorkoutFrom without creating an import cycle
    root.querySelector('#plan-start').addEventListener('click', () => {
      if (persist()) onClose('', draft);
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
