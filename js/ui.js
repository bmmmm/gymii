// Small shared UI helpers.

import { distUnit } from './store.js';

// Local-time values for the date/time inputs — toISOString would shift a
// late-evening workout onto the previous day for anyone west of UTC.
export const pad2 = (n) => String(n).padStart(2, '0');
export const dateValue = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
export const timeValue = (ts) => {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// Distinct machine nums of a workout's entries, in entry order — dedup so a
// workout with two exercises at one machine reads '#16', not '#16 → #16'.
export const machineChain = (workout) =>
  [...new Set(workout.entries.map((e) => `#${e.num}`))].join(' → ');

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

// A re-render replaces whole subtrees, so the control you JUST used drifts
// down whenever the list above it grew by a row — log a set and the log
// button walks off the bottom of the screen, add a plan line and the input
// does. Call this after such a render with that control's selector and it
// lands back in view. Instant, never smooth: this is a place-keeping
// correction, and an animation here fights the thumb that is already moving.
// `focus` is for text fields you are likely to fill again (a second plan
// line, another settings field) — never for number inputs, where it would
// pop the keyboard and hand the field to initNumericOverwrite empty.
// Guarded throughout: the logic tests' stub DOM has neither method.
export function keepInView(root, selector, { focus = false } = {}) {
  const el = root.querySelector?.(selector);
  if (!el) return;
  el.scrollIntoView?.({ block: 'center' });
  if (focus) el.focus?.();
}

// --- rest-timer sound ---
// Played through ONE shared HTMLAudioElement, deliberately NOT WebAudio:
// iOS mutes WebAudio with the ring/silent switch, but treats media-element
// playback like music (YouTube keeps playing on silent). The tones are
// rendered into tiny WAV blobs at runtime, so no audio assets ship.
let soundEl = null;
const wavUrls = new Map(); // sound name -> blob URL, rendered once

// Selectable timer sounds: label + sine notes as [start offset s, Hz].
// Every note shares one envelope (see renderWav), so a sound is pure
// data — a new entry here shows up in Settings by itself.
export const TIMER_SOUNDS = {
  double: { label: 'Double', notes: [[0, 880], [0.35, 880]] },
  triple: { label: 'Triple', notes: [[0, 880], [0.2, 880], [0.4, 880]] },
  rise: { label: 'Rise', notes: [[0, 660], [0.18, 880], [0.36, 1100]] },
  low: { label: 'Low', notes: [[0, 440], [0.35, 440]] },
};

// Renders notes into 16-bit mono PCM WAV bytes (44.1 kHz), with the same
// envelope the old WebAudio path shaped live: 20 ms attack to 0.35,
// exponential decay to ~0.001 at 250 ms, note over at 300 ms. Exported
// for the logic tests (audible output is device-only territory).
export function renderWav(notes) {
  const rate = 44100;
  const noteSecs = 0.3;
  const len = Math.ceil((Math.max(...notes.map(([at]) => at)) + noteSecs) * rate);
  const samples = new Float32Array(len);
  notes.forEach(([at, freq]) => {
    const start = Math.round(at * rate);
    for (let i = 0; i < noteSecs * rate && start + i < len; i++) {
      const t = i / rate;
      const amp = t < 0.02 ? 0.35 * (t / 0.02) : 0.35 * Math.exp(-25.5 * (t - 0.02));
      samples[start + i] += amp * Math.sin(2 * Math.PI * freq * t);
    }
  });
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const ascii = (off, str) => [...str].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  ascii(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, 'data'); v.setUint32(40, len * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return buf;
}

// Blob URL per sound, rendered on first use. Unknown names fall back to
// `double`, so a stale settings value can never mute the timer.
const soundUrl = (name) => {
  const key = TIMER_SOUNDS[name] ? name : 'double';
  if (!wavUrls.has(key)) {
    wavUrls.set(key, URL.createObjectURL(
      new Blob([renderWav(TIMER_SOUNDS[key].notes)], { type: 'audio/wav' })));
  }
  return wavUrls.get(key);
};

// Must be called from inside a user gesture: iOS only lets a media element
// START in one, but an element that has once played in a gesture may be
// replayed programmatically later — startRest() primes here in the log-set
// click so the timer can fire ~90s after the tap. The prime plays a short
// SILENT wav (a zero-frequency note renders pure zeros) to completion:
// pausing the real sound mid-play raced the play() promise and audibly
// leaked its first note; silent content cannot leak, whatever lands when.
let silenceUrl = null;
export function primeAudio() {
  try {
    if (!soundEl) soundEl = new Audio();
    if (!silenceUrl) {
      silenceUrl = URL.createObjectURL(
        new Blob([renderWav([[0, 0]])], { type: 'audio/wav' }));
    }
    soundEl.src = silenceUrl;
    soundEl.play().catch(() => {});
    return soundEl;
  } catch {
    return null; // audio is best-effort
  }
}

// Plays a TIMER_SOUNDS entry through the shared element. In a gesture
// (Settings preview chips) this works unprimed; the timer path relies on
// primeAudio having blessed the element inside the log-set tap.
export function playTimerSound(name) {
  try {
    if (!soundEl) soundEl = new Audio();
    const url = soundUrl(name);
    if (soundEl.src !== url) soundEl.src = url;
    soundEl.currentTime = 0;
    soundEl.play().catch(() => {});
  } catch {
    // audio is best-effort; browsers may block it before any interaction
  }
}

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
