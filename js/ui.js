// Small shared UI helpers.

import { distUnit } from './store.js';

// One delegated handler powers every .stepper on the page:
// <div class="stepper" data-step="2.5" data-min="0"><button class="step-down">−</button><input><button class="step-up">+</button></div>
export function initSteppers() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.step-up, .step-down');
    if (!btn) return;
    const wrap = btn.closest('.stepper');
    const input = wrap.querySelector('input');
    const step = parseFloat(wrap.dataset.step || '1');
    const min = wrap.dataset.min !== undefined ? parseFloat(wrap.dataset.min) : -Infinity;
    const dir = btn.classList.contains('step-up') ? 1 : -1;
    const next = (parseFloat(input.value) || 0) + dir * step;
    input.value = String(Math.max(min, Math.round(next * 100) / 100));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// Numeric inputs arm for overwrite on focus: the current value moves into
// the placeholder — greyed out as "(40)" for orientation — so the number
// pad starts on an empty field instead of appending digits to the old
// value. Leaving the field without typing restores it. Delegated like the
// steppers; blur fires before a stepper's click, so +/− still see a value.
export function initNumericOverwrite() {
  document.addEventListener('focusin', (e) => {
    const inp = e.target;
    if (inp.tagName !== 'INPUT' || inp.type !== 'number' || inp.value === '') return;
    inp.dataset.prevValue = inp.value;
    inp.dataset.prevPlaceholder = inp.placeholder;
    inp.placeholder = `(${inp.value})`;
    inp.value = '';
  });
  document.addEventListener('focusout', (e) => {
    const inp = e.target;
    if (inp.tagName !== 'INPUT' || inp.dataset.prevValue === undefined) return;
    if (inp.value === '') inp.value = inp.dataset.prevValue;
    inp.placeholder = inp.dataset.prevPlaceholder;
    delete inp.dataset.prevValue;
    delete inp.dataset.prevPlaceholder;
  });
}

export function download(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const fmtDate = (ts) =>
  new Date(ts).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// "3 sets", "1 workout" — count plus s-pluralized noun, in one spelling.
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const fmtDuration = (sec) => {
  const s = Math.max(0, Math.round(sec) || 0); // imported data may be fractional/absent
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Shared two-tap confirm for destructive actions (AGENTS.md convention).
// Call inside any click handler (works delegated too): arms the button on
// the first tap, returns true on the confirming second tap within 4 s.
export function twoTapConfirm(btn, armedLabel, restLabel) {
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = armedLabel;
    clearTimeout(btn._armTimer);
    btn._armTimer = setTimeout(() => {
      btn.classList.remove('armed');
      btn.textContent = restLabel;
    }, 4000);
    return false;
  }
  clearTimeout(btn._armTimer);
  btn.classList.remove('armed');
  // restore the label here too — callers that don't re-render afterwards
  // would otherwise keep showing the armed text forever
  btn.textContent = restLabel;
  return true;
}

// One labeled stepper row — the logging screen and the plan builder both
// render several and the markup is identical apart from label/id/step.
// Pairs with initSteppers()'s delegated +/− handling.
export const stepperField = (label, id, { step, min, value, mode = 'decimal' }) => `
  <div class="spread"><span class="label">${label}</span>
    <div class="stepper" data-step="${step}" data-min="${min}">
      <button type="button" class="step-down" aria-label="decrease ${label.toLowerCase()}">−</button>
      <input id="${id}" type="number" inputmode="${mode}" value="${value}">
      <button type="button" class="step-up" aria-label="increase ${label.toLowerCase()}">+</button>
    </div>
  </div>`;

// One set, rendered compactly; bodyweight shares {reps,weight}, so its
// flag is passed in rather than sniffed from the shape.
export const setStr = (st, settings, bodyweight = false) => (st.distance != null
  ? `${st.distance} ${distUnit(settings)} · ${fmtDuration(st.seconds)}`
  : bodyweight
    ? (st.weight ? `BW+${st.weight}×${st.reps}` : `BW×${st.reps}`)
    : `${st.weight}×${st.reps}`);

// "500 kg · 3.2 km"-style rollup of a workout's strength volume and cardio
// distance; parts appear only when non-zero so pure-cardio workouts don't
// read "0 kg".
export function workoutTotals(workout, settings) {
  const volume = workout.entries.reduce(
    (v, e) => v + e.sets.reduce((x, st) => x + (st.reps * st.weight || 0), 0), 0);
  const distance = workout.entries.reduce(
    (v, e) => v + e.sets.reduce((x, st) => x + (st.distance || 0), 0), 0);
  const parts = [];
  if (volume) parts.push(`${Math.round(volume)} ${settings.unit}`);
  if (distance) parts.push(`${Math.round(distance * 100) / 100} ${distUnit(settings)}`);
  return parts.join(' · ') || `0 ${settings.unit}`;
}
