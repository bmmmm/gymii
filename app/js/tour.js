// The guided tour (#tour): six short steps through what gymii is and where
// things live, shown once on a device's first start and again on request
// (Settings → Help, the first-run screen). A screen of its own, rendered
// into #view like every route — no overlay: nothing to trap focus in,
// nothing that blocks a tap on the app behind it. The tabbar stays usable
// throughout; the tab a step talks about pulses (`tour-spot`), and
// app.js clears that mark on every route change.
import { getSettings, saveSettings, setUnit } from './store.js';
import { esc } from './ui.js';

// `spots`: the tabs a step points at. Train hosts plans and the Gym tile
// too — the Gym is deliberately not a tab (docs/architecture.md § app.js).
export const TOUR_STEPS = [
  {
    icon: '👋', title: 'Welcome to gymii', spots: [],
    body: ['A workout log made for the gym floor: one machine at a time, a few taps per set.',
      'Everything stays on this phone — no account, no cloud. A one-minute look around, then you\'re training.'],
  },
  {
    icon: '🏋️', title: 'Train machine by machine', spots: ['train'],
    body: ['Every machine in your gym gets a number — the one on its sticker, or your own.'],
    flow: [
      ['#7', 'Type the number of the machine in front of you.'],
      ['− 20 +', 'Set weight and reps.'],
      ['✓ Log set', 'Saves the set — the rest timer starts by itself.'],
      ['Next ›', 'On to the next machine. 🏁 finishes the workout.'],
    ],
    after: 'A machine gymii doesn\'t know yet? Name it once and it joins your gym.',
  },
  {
    icon: '📋', title: 'Bring your plan', spots: ['train'],
    body: ['Type it the way it\'s written — "Leg press 3x10 80", one exercise per line. No setup first: the first time you reach an exercise, gymii asks which machine it is.',
      'Give a plan weekdays and Train shows what today is for.'],
  },
  {
    icon: '🗺', title: 'Your gym on a map — if you like', spots: ['train'],
    body: ['Draw the floor plan, or load a ready-made gym. Then gymii shows where each machine stands, finds a free one nearby when yours is busy, and traces your walking paths.',
      'Entirely optional — you can train without ever opening it. It lives under Train → Gym.'],
  },
  {
    icon: '📅', title: 'Watch yourself progress', spots: ['history', 'ai'],
    body: ['History keeps every workout: weekly totals, a progress chart per machine, the muscles you\'ve worked — and a short tip where one helps.',
      'AI copies your training as text for the chatbot of your choice. gymii itself sends nothing anywhere.'],
  },
  {
    icon: '⚙️', title: 'Make it yours', spots: ['settings'],
    body: ['Units, the rest timer and its sound, keeping the screen awake. Sync your devices end-to-end encrypted, or export a backup.',
      'This tour waits there too — Settings → Help.'],
  },
];

// Which step is on show. Module state, so an in-place re-render (a unit
// chip) keeps it; a route ENTRY starts over at the first step.
let step = 0;
// The unit question belongs to an empty install only (the caller says,
// app.js: train.js isFirstRun) — with data on the device it would offer
// to convert a whole history from inside a walkthrough.
let unitAsked = false;
// The weight step a fresh install starts with, per unit. setUnit converts
// a step like any weight (2.5 kg → 5.5 lbs, test-pinned) — right for one
// someone chose, odd for a default nobody touched yet.
const DEFAULT_STEP = { kg: 2.5, lbs: 5 };

// Marks the tabs a step points at; [] clears. A no-op without a DOM.
export function spotTabs(tabs = []) {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('#tabbar a').forEach((a) =>
    a.classList.toggle('tour-spot', tabs.includes(a.dataset.tab)));
}

/**
 * Renders the tour into `root`. `entry`: a route entry — back to step one.
 * `askUnit`: offer kg/lbs on step one (read on entry only).
 * `onExit`: called on Skip and after the last step (app.js routes to Train).
 * Opening it counts as seen: whoever leaves it by a tab tap has met it, and
 * the first-run screen offers it again anyway.
 */
export function renderTour(root, { entry = false, askUnit = false, onExit = () => {} } = {}) {
  if (entry) {
    step = 0;
    unitAsked = askUnit;
    const s = getSettings();
    // device-local: not in merge.js USER_SETTINGS, so no sync stamp moves
    if (!s.tourSeen) saveSettings({ ...s, tourSeen: true });
  }
  const i = Math.min(Math.max(step, 0), TOUR_STEPS.length - 1);
  const t = TOUR_STEPS[i];
  const last = i === TOUR_STEPS.length - 1;
  const unit = getSettings().unit;
  root.innerHTML = `
    <div class="tour">
      <div class="spread tour-head">
        <span class="muted">Step ${i + 1} of ${TOUR_STEPS.length}</span>
        ${last ? '' : '<button type="button" id="tour-skip" class="btn btn-inline btn-quiet">Skip tour</button>'}
      </div>
      <div class="tour-dots" aria-hidden="true">${TOUR_STEPS.map((_, k) =>
    `<span${k === i ? ' class="on"' : ''}></span>`).join('')}</div>
      <div class="tour-icon" aria-hidden="true">${t.icon}</div>
      <h1 id="tour-title" tabindex="-1">${esc(t.title)}</h1>
      ${t.body.map((p) => `<p>${esc(p)}</p>`).join('')}
      ${t.flow ? `<ol class="tour-flow">${t.flow.map(([chip, text]) => `
        <li><span class="tour-chip" aria-hidden="true">${esc(chip)}</span><span>${esc(text)}</span></li>`).join('')}
      </ol>` : ''}
      ${t.after ? `<p class="muted">${esc(t.after)}</p>` : ''}
      ${i === 0 && unitAsked ? `
      <section class="card">
        <h2>Kilograms or pounds?</h2>
        <div class="chip-select" id="tour-units">
          <button type="button" class="chip${unit === 'kg' ? ' sel' : ''}" data-unit="kg"
            aria-pressed="${unit === 'kg'}">kg · m</button>
          <button type="button" class="chip${unit === 'lbs' ? ' sel' : ''}" data-unit="lbs"
            aria-pressed="${unit === 'lbs'}">lbs · mi</button>
        </div>
        <p class="muted">Settings can switch it any time — logged weights convert along.</p>
      </section>` : ''}
      <div class="row tour-nav">
        ${i ? '<button type="button" id="tour-back" class="btn btn-inline">‹ Back</button>' : ''}
        <button type="button" id="tour-next" class="btn btn-primary">${last ? 'Let\'s go' : 'Next ›'}</button>
      </div>
    </div>`;
  spotTabs(t.spots);

  const go = (to) => {
    step = to;
    renderTour(root, { onExit });
    root.scrollTop = 0;
    // a screen reader hears the new step, not the button that moved it
    root.querySelector('#tour-title')?.focus?.({ preventScroll: true });
  };
  const done = () => {
    spotTabs([]);
    onExit();
  };
  root.querySelector('#tour-next').addEventListener('click', () => (last ? done() : go(i + 1)));
  root.querySelector('#tour-back')?.addEventListener('click', () => go(i - 1));
  root.querySelector('#tour-skip')?.addEventListener('click', done);
  root.querySelector('#tour-units')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const before = getSettings();
    setUnit(chip.dataset.unit); // nothing logged yet on a first start — but it converts if there is
    if (chip.dataset.unit !== before.unit && before.weightStep === DEFAULT_STEP[before.unit]) {
      saveSettings({ ...getSettings(), weightStep: DEFAULT_STEP[chip.dataset.unit] });
    }
    renderTour(root, { onExit });
  });
}
