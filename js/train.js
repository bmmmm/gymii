import {
  getLayout, saveLayout, getSettings, saveSettings, getActive, saveActive, finishWorkout,
  lastEntryFor, getWorkouts, getPlans, savePlan, planFromText, uid,
  usageByMachine, layoutMuscles, distUnit, newLayout, addMachine,
  bindOrCreateMachine, newEntry, nameChipsFor, todayStatus, skipPlanDay,
} from './store.js';
import { drawLayout, usagePayload, findMachineByNum } from './map.js';
import { ambientWorkoutStart, ambientFinished } from './sync.js';
import { renderPlanBuilder, DAY_LABELS } from './plan.js';
import { focusMachine } from './gym.js';
import {
  esc, fmtDuration, workoutTotals, setStr, twoTapConfirm, stepperField, plural, machineChain,
  primeAudio, playTimerSound, keepInView,
} from './ui.js';

// Active workout shape:
//   { v: 2, id, startedAt, plan: [{machineId, exercise|null, target?}…],
//     currentMachineId|null, currentExercise|null, entries: [] }
// plan is the guided order — one slot per (machine, exercise) pair when
// repeating a workout (so "Next:" walks every exercise of a multi-exercise
// machine), growing as machines are opened in a free workout. exercise null
// means the slot covers the whole machine. currentMachineId null shows the
// workout overview hub instead of a machine's logging screen. Slots started
// from a stored plan may carry a target ({sets,reps,weight} or
// {distance,seconds}) — older/free slots simply lack the key.
// Each entry.sets item ({ reps, weight } or { distance, seconds }) also
// carries `at` — epoch ms stamped via `Date.now()` when the set is logged.
// Sets logged before this feature lack `at`; consumers must guard for it.

// Train-tab internal screen state: when set, the start screen yields to
// the plan builder ({ planId|null, notice }). An active workout still
// outranks it — a mid-workout AI import just saves the plan silently.
let builder = null;

// Lets ai.js hand an imported plan over for review before switching the
// hash to #train (module state survives; the app never reloads between tabs).
export function openPlanBuilder(planId, notice = '') {
  builder = { planId, notice };
}

// Which non-workout, non-builder screen the Train tab shows. Layered UNDER
// builder/active in screenKey's priority — exactly like builder already
// sits under active — so the AI-import and mid-workout paths never consult
// it. Exported setters, not the variable, so the tests (and any future
// caller) can navigate without reaching into module internals.
let screen = 'hub'; // 'hub' | 'start' | 'plans'

export function goToHub() { screen = 'hub'; }
export function goToStart() { screen = 'start'; }
export function goToPlans() { screen = 'plans'; }

// Locker number noted on the start screen, before any workout exists —
// consumed by the next startWorkoutFrom, whichever way the workout then
// starts (machine pick, plan button, repeat, quick start), so the number
// lives on the workout itself from its first second.
let pendingLocker = '';

// One plan item per (machine, exercise) pair of a past workout, deduped —
// the seed for "turn this routine into a plan". Targets are NOT set here;
// the builder seeds them from the machine's own history, which is exactly
// what this routine last did.
function planSeedFrom(workout, layout) {
  const pairs = workout.entries
    .filter((e) => e.sets.length)
    .map((e) => {
      const machine = layout.machines.find((m) => m.id === e.machineId);
      return machine ? {
        machineId: e.machineId,
        exercise: machine.exercises?.includes(e.exercise) ? e.exercise : null,
      } : null;
    })
    .filter(Boolean);
  return pairs.filter((p, i) => pairs.findIndex(
    (q) => q.machineId === p.machineId && q.exercise === p.exercise) === i);
}

// Which screen of the Train tab is on show. The tab renders its screens
// into one container, so a changed key means NAVIGATION (hub → start →
// log → bind → overview) and the new screen must start at the top; an
// unchanged key means an in-place update, where the scroll position
// belongs to the user and must be left alone. Without this you arrive on
// a fresh screen still scrolled to wherever the previous one stood.
// Exported for the tests.
export const screenKey = (active, builder, screen) => {
  if (active) {
    if (active.binding != null) return `bind:${active.binding}`;
    return active.currentMachineId
      ? `log:${active.currentMachineId}:${active.currentExercise ?? ''}`
      : 'overview';
  }
  return builder ? `builder:${builder.planId ?? 'new'}` : (screen ?? 'hub');
};

let lastScreenKey = null;

export function renderTrain(root, message = '') {
  const layout = getLayout();
  const active = getActive();
  // Reset BEFORE the render: the old (tall) content is still in place, so
  // the container can actually scroll to the top, and replacing the markup
  // afterwards leaves it there.
  const key = screenKey(active, builder, screen);
  if (key !== lastScreenKey && root.scrollTop) root.scrollTop = 0;
  lastScreenKey = key;
  // 'workout' scope: the lock lives exactly as long as the workout does.
  // renderTrain runs after every state change here, so finishing or
  // discarding a workout releases it on the next render.
  lockForWorkout = getSettings().keepAwake === 'workout' && !!active;
  syncWakeLock();
  // An in-progress workout outranks onboarding: machines can be wiped
  // mid-workout by an import or a gym edit, and the quick start must
  // never overwrite logged sets. The plan builder outranks it too — a plan
  // is exactly what someone without a gym starts with — and so does a
  // SAVED plan: once one exists there is something to start, and sending
  // its owner back to the first-run screen would hide it.
  if (!active && !builder && !getPlans().length && (!layout || !layout.machines.length)) {
    renderOnboarding(root, message);
    return;
  }
  if (active) {
    if (!active.plan) { // migrate a pre-plan active workout
      active.plan = active.queue || active.entries.map((e) => e.machineId);
      saveActive(active);
    }
    if (active.plan.some((p) => typeof p === 'string')) { // machineIds → slots
      active.plan = active.plan.map((p) =>
        (typeof p === 'string' ? { machineId: p, exercise: null } : p));
      saveActive(active);
    }
    // an unbound slot answers "which machine is this?" before it can log
    if (active.binding != null) renderBind(root, layout, active);
    else if (active.currentMachineId) renderLog(root, layout, active);
    else renderOverview(root, layout, active);
  } else if (builder) {
    // the second onClose arg is a plan to start right away (Save & start —
    // plan.js can't call startWorkoutFrom without an import cycle)
    renderPlanBuilder(root, builder, (message2 = '', startPlan = null) => {
      builder = null;
      if (startPlan) {
        startWorkoutFrom({
          planId: startPlan.id,
          ...(startPlan.name ? { name: startPlan.name } : {}),
          entries: startPlan.items,
        });
      }
      renderTrain(root, startPlan ? '' : message2);
    });
  } else if (screen === 'plans') {
    renderPlans(root, layout, message);
  } else if (screen === 'start') {
    renderStart(root, layout, message);
  } else {
    renderHub(root, layout, message);
  }
}

// Start a guided workout from a past one (or empty/free with one machine).
// Exported so History can offer "repeat this workout" too.
export function startWorkoutFrom(source, firstMachineId = null) {
  // freshen from the other devices before training starts — fire and
  // forget, a workout must never wait for the network (M2)
  ambientWorkoutStart();
  let layout = getLayout();
  // A plan of unbound items can be started before any gym exists; every
  // screen below this point assumes one, so it gets created empty here
  // (the gym does the same on first visit) and grows as slots bind.
  if (!layout) { layout = newLayout(); saveLayout(layout); }
  // One plan slot per (machine, exercise) pair, deduped — the guided flow
  // then walks every exercise of a multi-exercise machine. An exercise the
  // machine no longer offers falls back to a whole-machine slot, and such
  // machine slots are dropped again when exercise slots for the same
  // machine exist (the overview would double-report their sets).
  // Unbound items pass through untouched: they carry a name instead of a
  // machine and are deduped by nothing — two "Leg press" lines are two
  // real slots until each is bound.
  const pairs = (source?.entries ?? [])
    .map((e) => {
      if (!e.machineId) {
        return e.name
          ? {
            machineId: null, name: e.name, exercise: null,
            ...(e.num != null ? { num: e.num } : {}),
            ...(e.target ? { target: e.target } : {}),
          } : null;
      }
      const machine = layout.machines.find((m) => m.id === e.machineId);
      if (!machine) return null;
      const exercise = machine.exercises?.includes(e.exercise) ? e.exercise : null;
      // a stored plan's items carry their target through to the slot
      return { machineId: e.machineId, exercise, ...(e.target ? { target: e.target } : {}) };
    })
    .filter(Boolean);
  const plan = pairs
    .filter((p, i) => !p.machineId || pairs.findIndex(
      (q) => q.machineId === p.machineId && q.exercise === p.exercise) === i)
    .filter((p) => !p.machineId || p.exercise
      || !pairs.some((q) => q.machineId === p.machineId && q.exercise));
  if (firstMachineId && !plan.some((p) => p.machineId === firstMachineId)) {
    plan.push({ machineId: firstMachineId, exercise: null });
  }
  saveActive({
    v: 2, id: uid(), startedAt: Date.now(),
    // repeating a named workout keeps its identity — without this the
    // routine group would split into a named and an unnamed half
    ...(source?.name ? { name: source.name } : {}),
    // the plan this came from, so a slot bound on the floor can be
    // written back into it (asked once, not once per workout)
    ...(source?.planId ? { planId: source.planId } : {}),
    // a locker noted on the start screen moves onto the workout
    ...(pendingLocker ? { locker: pendingLocker } : {}),
    plan,
    currentMachineId: firstMachineId ?? plan[0]?.machineId ?? null,
    currentExercise: firstMachineId ? null : plan[0]?.exercise ?? null,
    entries: [],
  });
  pendingLocker = '';
}

const weekdayName = (date) => date.toLocaleDateString('en-GB', { weekday: 'long' });

const soon = (date) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return date.toDateString() === tomorrow.toDateString()
    ? 'tomorrow' : `on ${weekdayName(date)}`;
};

// "what today is about", in one stated sentence. Never scolds: a missed
// day is reported like a fact, and a day with nothing on it is told as
// the good news it is, not as an empty slot.
function statusLine(status) {
  const name = status.plan.name ? esc(status.plan.name) : 'Your plan';
  if (status.state === 'due') {
    return `<p class="day-status">${weekdayName(status.due)} — <strong>${name}</strong> is on.</p>`;
  }
  if (status.state === 'done') {
    return `<p class="day-status done">✓ <strong>${name}</strong> done today.${status.next
      ? ` Next one ${soon(status.next)}.` : ''}</p>`;
  }
  if (status.state === 'missed') {
    return `<p class="day-status missed"><strong>${name}</strong> was on
      ${weekdayName(status.due)}.
      <button type="button" id="skip-day" class="linkish">Skip this week</button></p>`;
  }
  // rest
  return `<p class="day-status">Rest day. <strong>${name}</strong> is next,
    ${soon(status.next)}.</p>`;
}

// statusLine's plain-text twin for surfaces that cannot carry markup or a
// nested control — the hub's hero tile is itself a <button>, so no
// <strong> and no inline skip button. Returns an UNESCAPED string; the
// caller escapes at interpolation time.
function statusText(status) {
  const name = status.plan.name || 'Your plan';
  if (status.state === 'due') return `${weekdayName(status.due)} — ${name} is on`;
  if (status.state === 'done') {
    return `✓ ${name} done today${status.next ? ` · next ${soon(status.next)}` : ''}`;
  }
  if (status.state === 'missed') return `${name} was on ${weekdayName(status.due)}`;
  return `Rest day — ${name} is next ${soon(status.next)}`;
}

// --- start screen ---

// Distinct machine nums of a plan, in item order — the plan-list twin of
// machineChain (which reads a workout's entries).
const planChain = (plan, layout) => [...new Set(plan.items
  .map((it) => layout?.machines.find((m) => m.id === it.machineId))
  .filter(Boolean).map((m) => `#${m.num}`))].join(' → ');

// "last done" for a plan comes from history via its name
const planLastDone = (workouts, p) => (p.name
  ? workouts.findLast((w) => w.name === p.name) ?? null : null);

// plans tagged with today's weekday float to the top (stable sort keeps
// the stored order within each group)
const isTodayPlan = (p) => (p.days?.includes(new Date().getDay()) ? 1 : 0);
const sortPlansToday = (plans) => plans.slice().sort((a, b) => isTodayPlan(b) - isTodayPlan(a));

const lastWorkoutLabel = (w) => `last: ${w.name ? w.name : machineChain(w)} · ${new Date(w.startedAt)
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;

const startPlanWorkout = (root, plan) => {
  startWorkoutFrom({
    planId: plan.id,
    ...(plan.name ? { name: plan.name } : {}),
    entries: plan.items,
  });
  renderTrain(root);
};

// Shared "Planned workouts" card — the start screen and the hub's Plans
// screen render the identical list, so its markup and wiring live once.
function planListCard(layout, plans, workouts) {
  const sortedPlans = sortPlansToday(plans);
  const html = `
    <section class="card">
      <h2>Planned workouts</h2>
      <div id="plan-list">
        ${sortedPlans.map((p) => {
    const done = planLastDone(workouts, p);
    // counted as exercises, not machines: an unbound item is a real part
    // of the plan that simply has no machine yet
    const count = p.items.length;
    const open = p.items.filter((it) => !it.machineId).length;
    return `<div class="recent-row">
          <button type="button" class="recent-info row-open" data-pid="${p.id}">
            <strong>${p.name ? esc(p.name) : planChain(p, layout) || 'Unnamed plan'}${isTodayPlan(p)
    ? ' <span class="muted">· today</span>' : ''}</strong>
            <span class="muted">${p.name && planChain(p, layout) ? `${planChain(p, layout)} · ` : ''}${plural(count, 'exercise')}${open
    ? ` · ${open} to assign` : ''}${p.days?.length
    ? ` · ${p.days.map((d) => DAY_LABELS[d]).join(' ')}` : ''}${done
    ? ` · last: ${new Date(done.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}</span>
          </button>
          <span class="row-chevron" aria-hidden="true">›</span>
          <button class="btn btn-inline plan-start" data-pid="${p.id}">Start</button>
        </div>`;
  }).join('')}
      </div>
      <button id="plan-new" class="btn">+ Plan a workout</button>
      ${plans.length ? '' : `<p class="muted">Write down the workout you already
        have — one exercise per line — or pick machines by muscle. Set target
        sets × reps × weight, then start it any day.
        (Your AI can draft one too, via the AI tab.)</p>`}
    </section>`;
  const wire = (root) => {
    // delegated: the stubbed test DOM (and less wiring) both prefer one
    // listener on the list over one per row
    // tapping the row itself opens the plan's settings; the button starts it
    root.querySelector('#plan-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.plan-start, .row-open');
      if (!btn) return;
      const plan = plans.find((p) => p.id === btn.dataset.pid);
      if (!plan) return;
      if (btn.classList.contains('row-open')) {
        builder = { planId: plan.id, notice: '' };
        renderTrain(root);
        return;
      }
      startPlanWorkout(root, plan);
    });
    root.querySelector('#plan-new').addEventListener('click', () => {
      builder = { planId: null, notice: '' };
      renderTrain(root);
    });
  };
  return { html, wire };
}

// --- train hub ---

// The tab's neutral landing: one hero into the merged start flow (machine
// or plan — renderStart carries both) plus small tiles to the areas that
// used to hide further down the page or behind Settings. Deliberately
// nothing else — the hub navigates, the screens behind it do the work.
function renderHub(root, layout, message) {
  const plans = getPlans();
  const workouts = getWorkouts();
  const last = workouts[workouts.length - 1] ?? null;
  const status = todayStatus(plans, workouts);
  const heroSub = status ? statusText(status)
    : last ? lastWorkoutLabel(last)
      : 'Tap to start your first workout';

  root.innerHTML = `
    <h1>Train</h1>
    ${message ? `<p class="notice" role="status">${esc(message)}</p>` : ''}
    <div class="tile-grid">
      <button type="button" class="tile hero" id="hub-start">
        <span class="tile-icon">▶</span>
        <span class="tile-title">Start training</span>
        <span class="tile-sub">${esc(heroSub)}</span>
      </button>
      <button type="button" class="tile" id="hub-plans">
        <span class="tile-icon">📋</span>
        <span class="tile-title">Plans</span>
        <span class="tile-sub">${plural(plans.length, 'plan')}</span>
      </button>
      <button type="button" class="tile" id="hub-gym">
        <span class="tile-icon">🗺</span>
        <span class="tile-title">Gym</span>
        <span class="tile-sub">${layout?.machines.length
    ? plural(layout.machines.length, 'machine') : 'Draw your gym'}</span>
      </button>
      <button type="button" class="tile wide" id="hub-history">
        <span class="tile-icon">📅</span>
        <span class="tile-title">History</span>
        <span class="tile-sub">${last ? esc(lastWorkoutLabel(last)) : 'No workouts yet'}</span>
      </button>
    </div>`;

  root.querySelector('#hub-start').addEventListener('click', () => {
    screen = 'start';
    renderTrain(root);
  });
  root.querySelector('#hub-plans').addEventListener('click', () => {
    screen = 'plans';
    renderTrain(root);
  });
  // real route changes — the hash router takes it from here
  root.querySelector('#hub-gym').addEventListener('click', () => { location.hash = '#gym'; });
  root.querySelector('#hub-history').addEventListener('click', () => { location.hash = '#history'; });
}

// The Plans tile's own screen: just the shared card, nothing of the start
// screen — the hero and the Plans tile must lead to distinct places.
function renderPlans(root, layout, message) {
  const { html, wire } = planListCard(layout, getPlans(), getWorkouts());
  root.innerHTML = `
    <button type="button" id="back-hub" class="back-row">‹ Train</button>
    <h1>Plans</h1>
    ${message ? `<p class="notice" role="status">${esc(message)}</p>` : ''}
    ${html}`;
  root.querySelector('#back-hub').addEventListener('click', () => {
    screen = 'hub';
    renderTrain(root);
  });
  wire(root);
}

function renderStart(root, layout, message) {
  const workouts = getWorkouts();
  const last = workouts[workouts.length - 1];
  const s = getSettings();
  const plans = getPlans();
  // A plan OWNS its routine, so the derived row never duplicates it. Two
  // ways it can: by name (workouts logged from it carry the plan's name)
  // or by covering exactly the same machines — which is what happens the
  // moment a routine is turned INTO a plan.
  const planNames = new Set(plans.map((p) => p.name).filter(Boolean));
  const machineSetKey = (ids) => [...new Set(ids.filter(Boolean))].sort().join('|');
  const planMachineSets = new Set(
    plans.map((p) => machineSetKey(p.items.map((it) => it.machineId))).filter(Boolean));

  // Easy starting points: the latest workout gets the big button, and
  // every DIFFERENT machine set in history (a push/pull/legs rotation,
  // say) gets its own start row — routines emerge from the log, no
  // manual routine management. Keyed on machine IDs, not the displayed
  // #num chain, so renumbering in the gym doesn't split a routine.
  // An optional workout name outranks that chain: two routines on the
  // same machines but with different exercises stay apart once named.
  const routineKey = (w) => (w.name
    ? `name:${w.name}`
    : [...new Set(w.entries.map((e) => e.machineId))].join('|'));
  const routines = [];
  const seen = new Set(last ? [routineKey(last)] : []);
  for (let i = workouts.length - 2; i >= 0 && routines.length < 4; i--) {
    const w = workouts[i];
    const key = routineKey(w);
    if (seen.has(key) || (w.name && planNames.has(w.name))
      || planMachineSets.has(machineSetKey(w.entries.map((e) => e.machineId)))) continue;
    seen.add(key);
    routines.push(w);
  }

  const sortedPlans = sortPlansToday(plans);

  // What today is about, if any plan carries weekdays at all.
  const status = todayStatus(plans, workouts);

  // Plan-first: for a plan follower the most relevant plan IS the workout.
  // The weekday status decides it when there is one — what's due today, or
  // what was missed this cycle. Otherwise (no weekdays anywhere) it falls
  // back to the most recently done plan. It gets the big button; "Repeat
  // last workout" yields, and drops entirely when the last workout came
  // from that same plan (it would start the same thing).
  const statusPlan = status && (status.state === 'due' || status.state === 'missed')
    ? status.plan : null;
  const primaryPlan = statusPlan
    ?? (status ? null : sortedPlans.slice().sort((a, b) =>
      (planLastDone(workouts, b)?.startedAt ?? 0) - (planLastDone(workouts, a)?.startedAt ?? 0))[0])
    ?? null;
  const repeatIsPrimaryPlan = !!(primaryPlan?.name && last?.name === primaryPlan.name);
  const primaryDone = primaryPlan ? planLastDone(workouts, primaryPlan) : null;
  const planCard = planListCard(layout, plans, workouts);

  // Machine-first: the screen leads with the picker — a workout starts at
  // the machine in front of you. Today's plan and the repeat follow below as
  // the calmer options, not the headline.
  root.innerHTML = `
    <button type="button" id="back-hub" class="back-row">‹ Train</button>
    <h1>Train</h1>
    ${message ? `<p class="notice" role="status">${esc(message)}</p>` : ''}
    <div class="row locker-ask">
      <input id="locker-num" type="text" inputmode="numeric" placeholder="🔒 Locker #"
        value="${esc(pendingLocker)}">
    </div>
    ${layout?.machines.length ? `
    <section class="card">
      <h2>Start at a machine</h2>
      <div id="picker"></div>
      <p class="muted">This starts your workout — finish it any time from the
        workout overview.</p>
    </section>`
    // no machines yet (a plan-first start): the way in is naming the one
    // in front of you, exactly as on the first-run screen
    : `
    <section class="card">
      <h2>Start at a machine</h2>
      <p class="muted">Your gym has no machines yet — name the one in front of
        you and gymii adds it.</p>
      <div class="row">
        <input id="qs-label" type="text" placeholder="e.g. Chest press">
        <button id="qs-start" class="btn btn-inline">Start</button>
      </div>
    </section>`}
    ${status ? statusLine(status) : ''}
    ${primaryPlan ? `<button id="plan-primary" class="btn">▶ Start
      ${primaryPlan.name ? esc(primaryPlan.name) : 'your plan'}
      <span class="sub">${[
    isTodayPlan(primaryPlan) ? 'today' : '',
    planChain(primaryPlan, layout),
    primaryPlan.items.filter((it) => !it.machineId).length
      ? `${primaryPlan.items.filter((it) => !it.machineId).length} to assign` : '',
    primaryDone
      ? `last: ${new Date(primaryDone.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : '',
  ].filter(Boolean).join(' · ')}</span></button>` : ''}
    ${last && !repeatIsPrimaryPlan ? `<button id="repeat" class="btn">Repeat last workout
      <span class="sub">${new Date(last.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
      · ${last.name ? `${esc(last.name)} · ` : ''}${machineChain(last)}</span></button>` : ''}
    ${planCard.html}
    ${routines.length ? `
    <section class="card">
      <h2>Start another routine</h2>
      <div id="routine-list">
        ${routines.map((w) => `
        <div class="recent-row">
          <button type="button" class="recent-info row-open" data-wid="${w.id}">
            <strong>${w.name ? esc(w.name) : machineChain(w)}</strong>
            <span class="muted">${w.name ? `${machineChain(w)} · ` : ''}last: ${new Date(w.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              · ${workoutTotals(w, s)}</span>
          </button>
          <span class="row-chevron" aria-hidden="true">›</span>
          <button class="btn btn-inline repeat-w" data-wid="${w.id}">Repeat</button>
        </div>`).join('')}
      </div>
      <p class="muted">These come from what you've logged. Tap one to make it a
        real plan — targets, a name, weekdays.</p>
    </section>` : ''}`;

  root.querySelector('#back-hub').addEventListener('click', () => {
    screen = 'hub';
    renderTrain(root);
  });

  // noted before the workout exists — startWorkoutFrom carries it over
  root.querySelector('#locker-num').addEventListener('change', (e) => {
    pendingLocker = e.target.value.trim();
  });

  root.querySelector('#plan-primary')?.addEventListener('click', () => startPlanWorkout(root, primaryPlan));

  // "not this week" — one tap, no confirmation and no tally: the day stops
  // being outstanding until that weekday comes round again
  root.querySelector('#skip-day')?.addEventListener('click', () => {
    skipPlanDay(status.plan.id);
    renderTrain(root);
  });

  root.querySelector('#repeat')?.addEventListener('click', () => {
    startWorkoutFrom(last);
    renderTrain(root);
  });

  planCard.wire(root);

  // A derived routine has no settings of its own — so tapping it opens the
  // plan builder seeded with its machines. Nothing persists until Save, so
  // this doubles as "what exactly is this routine?" without committing.
  root.querySelector('#routine-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.repeat-w, .row-open');
    if (!btn) return;
    const workout = workouts.find((w) => w.id === btn.dataset.wid);
    if (!workout) return;
    if (btn.classList.contains('row-open')) {
      const seed = planSeedFrom(workout, layout);
      if (!seed.length) return; // every machine of it has been deleted
      builder = {
        planId: null,
        notice: 'From a routine you already train — set targets, name it, save.',
        seed,
        seedName: workout.name ?? '',
      };
      renderTrain(root);
      return;
    }
    startWorkoutFrom(workout);
    renderTrain(root);
  });

  if (layout?.machines.length) {
    machinePicker(root.querySelector('#picker'), layout, (machineId) => {
      startWorkoutFrom(null, machineId);
      renderTrain(root);
    }, { actionLabel: 'Start training' });
  } else {
    wireQuickStart(root);
  }
}

// Quick start: name the machine in front of you, gymii adds it and starts
// logging there. The start screen (layout without machines) and the first-run
// screen offer the same two controls, so they share one wiring — the two
// copies had already drifted apart over the backstop below.
function wireQuickStart(root) {
  const start = () => {
    const label = root.querySelector('#qs-label').value.trim();
    if (!label) return;
    // backstop: never clobber a workout that already has logged sets
    if (getActive()?.entries.some((e) => e.sets.length)) return;
    const layout = getLayout() ?? newLayout();
    const machine = addMachine(layout, layout.machines.length + 1, label);
    saveLayout(layout);
    startWorkoutFrom(null, machine.id);
    renderTrain(root);
  };
  root.querySelector('#qs-start').addEventListener('click', start);
  root.querySelector('#qs-label').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') start();
  });
}

// First-run screen. ONE action leads: type in the plan you already have —
// on paper, in a chat, from a trainer — and gymii reads it into exercises
// that don't need a gym yet. The other two ways in (a machine in front of
// you right now, drawing the floor plan) stay, one line each. The map is
// the reward for a gym that exists, never the toll gate before it.
function renderOnboarding(root, message) {
  root.innerHTML = `
    <h1>Welcome to gymii</h1>
    ${message ? `<p class="notice" role="status">${esc(message)}</p>` : ''}
    <section class="card">
      <h2>Type in your plan</h2>
      <p class="muted">One exercise per line, the way it's written on your
        plan. Machines come later — gymii asks which is which at the layout.</p>
      <textarea id="ob-plan" rows="5"
        placeholder="Leg press 3x10 80&#10;Lat pulldown 3x12 45&#10;Chest press 3x8-12 40kg&#10;Treadmill 20min"></textarea>
      <button id="ob-read" class="btn btn-primary btn-big">Read my plan</button>
      <p id="ob-msg" class="muted" role="status"></p>
    </section>
    <section class="card">
      <h2>At the gym right now?</h2>
      <p class="muted">Name the machine in front of you and start logging.</p>
      <div class="row">
        <input id="qs-label" type="text" placeholder="e.g. Chest press">
        <button id="qs-start" class="btn btn-inline">Start</button>
      </div>
    </section>
    <p class="muted">Prefer to set up first? Draw the floor plan or load a
      ready-made gym in the <a href="#gym">Gym</a>, or import a backup
      in <a href="#settings">Settings</a>.</p>`;

  const readPlan = () => {
    const text = root.querySelector('#ob-plan').value;
    const msg = root.querySelector('#ob-msg');
    let plan;
    try {
      plan = planFromText(text);
    } catch (err) {
      msg.textContent = err.message;
      return;
    }
    savePlan(plan);
    // straight into review: names and targets are editable there, and
    // machines can be assigned now or left for the gym floor
    openPlanBuilder(plan.id, `${plural(plan.items.length, 'exercise')}
      read — adjust anything, then save.`);
    renderTrain(root);
  };
  root.querySelector('#ob-read').addEventListener('click', readPlan);

  wireQuickStart(root);
}

// Number input, muscle filter and a tappable mini-map; calls
// onPick(machineId). The action button says what a pick actually does here —
// "Start training" on the start screen, "Add" mid-workout — because the same
// picker starts a whole workout in one place and only appends in the other.
// The map is collapsed by default (settings.pickerMap) — number and muscle
// are the picker's primary inputs, the map is the on-demand answer to
// "where?", not the main navigation surface.
function machinePicker(container, layout, onPick, { actionLabel = 'Open' } = {}) {
  const allMuscles = layoutMuscles(layout);

  container.innerHTML = `
    <div class="row">
      <input class="pick-num" type="number" inputmode="numeric" min="1" placeholder="Machine #">
      <button class="btn btn-inline pick-go">${esc(actionLabel)}</button>
    </div>
    ${allMuscles.length ? `
    <select class="pick-muscle" aria-label="Filter by muscle">
      <option value="">All muscles</option>
      ${allMuscles.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}
    </select>
    <div class="pick-chips"></div>` : ''}
    <div class="map-wrap"><svg xmlns="http://www.w3.org/2000/svg"></svg></div>
    <div class="map-mode pick-mode">
      <button type="button" class="chip map-toggle">🗺 Map</button>
      <button type="button" class="chip" data-mode="custom">Colors</button>
      <button type="button" class="chip" data-mode="usage">Usage</button>
    </div>
    <p class="pick-err muted">Enter a machine number — or pick by muscle or map.</p>`;

  const svg = container.querySelector('svg');
  // drawn lazily on first expand — most picks go via number or muscle
  const drawMap = () => drawLayout(svg, layout, {
    usage: getSettings().mapColors === 'usage' ? usagePayload(usageByMachine()) : null,
  });

  const modeBar = container.querySelector('.pick-mode');
  const updateModeBar = () => modeBar.querySelectorAll('.chip[data-mode]').forEach((c) =>
    c.classList.toggle('sel', (c.dataset.mode === 'usage') === (getSettings().mapColors === 'usage')));
  updateModeBar();

  // Collapse state lives in settings (one global preference, both picker
  // instances follow it). Colors/Usage only make sense with a visible map.
  const mapWrap = container.querySelector('.map-wrap');
  const mapToggle = modeBar.querySelector('.map-toggle');
  const applyMapState = () => {
    const shown = getSettings().pickerMap === 'shown';
    mapWrap.style.display = shown ? '' : 'none';
    modeBar.querySelectorAll('.chip[data-mode]').forEach((c) => {
      c.style.display = shown ? '' : 'none';
    });
    mapToggle.classList.toggle('sel', shown);
    if (shown && !svg.childElementCount) { // not drawn yet
      drawMap();
      applyMuscleFilter(); // map may open with a muscle filter already set
    }
  };
  mapToggle.addEventListener('click', () => {
    const cur = getSettings();
    saveSettings({ ...cur, pickerMap: cur.pickerMap === 'shown' ? 'hidden' : 'shown' });
    applyMapState();
  });

  const input = container.querySelector('.pick-num');
  const err = container.querySelector('.pick-err');

  const go = () => {
    const num = Math.round(parseFloat(input.value));
    if (!num || num < 1) return;
    const machine = findMachineByNum(layout, num);
    if (!machine) {
      // create-on-miss: standing at a real machine whose number gymii
      // doesn't know yet, one tap adds it — rename/arrange later in Gym
      err.innerHTML = `No machine #${num} yet — <button type="button"
        class="btn btn-inline pick-create">Create #${num} &amp; ${esc(actionLabel.toLowerCase())}</button>`;
      err.querySelector('.pick-create').addEventListener('click', () => {
        const created = addMachine(layout, num, `Machine ${num}`);
        saveLayout(layout);
        onPick(created.id);
      });
      return;
    }
    onPick(machine.id);
  };
  container.querySelector('.pick-go').addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  svg.addEventListener('click', (e) => {
    const g = e.target.closest('.machine');
    if (g) onPick(g.dataset.id);
  });

  const muscleSelect = container.querySelector('.pick-muscle');
  const chips = container.querySelector('.pick-chips');
  const applyMuscleFilter = () => {
    const muscle = muscleSelect?.value || '';
    const matching = muscle
      ? layout.machines.filter((m) => (m.muscles || []).includes(muscle))
      : [];
    const matchIds = new Set(matching.map((m) => m.id));
    svg.querySelectorAll('.machine').forEach((g) => {
      g.style.opacity = !muscle || matchIds.has(g.dataset.id) ? '' : '0.22';
    });
    if (chips) {
      chips.innerHTML = matching
        .sort((a, b) => a.num - b.num)
        .map((m) => `<button class="chip" data-id="${m.id}">#${m.num} ${esc(m.label)}</button>`)
        .join('');
    }
  };
  muscleSelect?.addEventListener('change', applyMuscleFilter);
  chips?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) onPick(chip.dataset.id);
  });

  modeBar.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip[data-mode]'); // not the map toggle
    if (!chip) return;
    saveSettings({ ...getSettings(), mapColors: chip.dataset.mode });
    updateModeBar();
    drawMap();
    applyMuscleFilter(); // redraw resets the dimming, so re-apply it
  });

  applyMapState();

  // small outside API: the overview's muscle-coverage chips drive the
  // picker's filter ("Legs still open" → tap → leg machines listed here)
  return {
    setMuscle(muscle) {
      if (!muscleSelect) return;
      muscleSelect.value = muscle;
      applyMuscleFilter();
      container.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    },
  };
}

// Fullscreen read-only floor map with one machine highlighted — answers
// "where is it?", the map's one job during training. Any tap closes it.
function showMapOverlay(layout, machine) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay map-overlay';
  overlay.innerHTML = `
    <div class="machine-head">
      <span class="machine-badge">${machine.num}</span>
      <div class="title">${esc(machine.label)}</div>
    </div>
    <div class="map-wrap"><svg xmlns="http://www.w3.org/2000/svg"></svg></div>
    <div class="muted">Tap anywhere to close</div>`;
  document.body.appendChild(overlay);
  drawLayout(overlay.querySelector('svg'), layout, { highlightId: machine.id });
  overlay.addEventListener('click', () => overlay.remove());
}

// --- workout overview hub ---

// Exact-match lookup for the logging screen (exercise-scoped entries at
// multi-exercise machines); slotEntries aggregates a whole machine when the
// slot's exercise is null. A slot is done once any of its entries has sets.
const entryFor = (active, machineId, exercise = null) =>
  active.entries.find((e) => e.machineId === machineId && (e.exercise ?? null) === exercise);
const slotEntries = (active, slot) =>
  active.entries.filter((e) => e.machineId === slot.machineId
    && (!slot.exercise || (e.exercise ?? null) === slot.exercise));
const slotSetCount = (active, slot) =>
  slotEntries(active, slot).reduce((n, e) => n + e.sets.length, 0);
// Done means any set logged — or, when the slot carries a plan target,
// the target's set count reached: the "Next" walk then keeps pulling the
// workout back to machines with unfinished targets.
const slotDone = (active, slot) => (slot.target?.sets
  ? slotSetCount(active, slot) >= slot.target.sets
  : slotEntries(active, slot).some((e) => e.sets.length));

// Target progress across the whole plan — the overview line and the
// finish message share it. total 0 = no targeted slots.
function targetTally(active) {
  const goals = active.plan.filter((p) => p.target?.sets);
  return {
    total: goals.reduce((n, p) => n + p.target.sets, 0),
    hit: goals.reduce((n, p) => n + Math.min(slotSetCount(active, p), p.target.sets), 0),
  };
}

// Sets logged anywhere in the active workout — the "has it actually begun?"
// signal that both locker asks (overview card, log-screen row) key on.
const workoutSetCount = (active) => active.entries.reduce((n, e) => n + e.sets.length, 0);

function renderOverview(root, layout, active) {
  const s = getSettings();
  const sets = workoutSetCount(active);
  const mins = Math.max(1, Math.round((Date.now() - active.startedAt) / 60000));

  // Muscle coverage today: muscles of every machine with ≥1 set this
  // workout, read live from the layout (entries don't snapshot muscles;
  // deleted machines contribute none). The chips double as navigation —
  // tapping one drives the picker's muscle filter below.
  const allMuscles = layoutMuscles(layout);
  const trained = new Set(active.entries
    .filter((e) => e.sets.length)
    .flatMap((e) => layout.machines.find((m) => m.id === e.machineId)?.muscles ?? []));

  // Name suggestions: what was actually trained (one id per logged set,
  // so the dominant region wins) plus the names already in use. Offered as
  // a compact edit row above Finish rather than a leading card — naming is
  // optional bookkeeping, and this is the screen you pass through on the
  // way out, so it costs a tap, not a step.
  const nameChips = nameChipsFor(
    active.entries.flatMap((e) => e.sets.map(() => e.machineId)), layout);

  // The locker number is a start-of-workout errand: you note it once, on
  // the way in — usually on the first machine's log screen, which asks the
  // same question. Once the first set is logged (or the ask was skipped
  // there) the screen belongs to the next machine and the next reps, so the
  // card collapses into one row above Finish — still reachable (and the
  // input identical), just no longer in the way of the thing being done.
  const lockerInput = `<div class="row">
        <input id="locker-num" type="text" inputmode="numeric" placeholder="Locker #"
          value="${esc(active.locker ?? '')}">
      </div>`;
  const lockerLeads = !sets && !active.lockerDismissed;

  const rows = active.plan.map((slot, i) => {
    const machine = layout.machines.find((m) => m.id === slot.machineId);
    const entries = slotEntries(active, slot);
    // an unbound slot has no machine and no entries yet — it still gets a
    // row, because assigning it IS the next action
    if (!machine && !slot.name) {
      if (!entries.length) return '';
    } else if (!machine) {
      return `<button class="plan-row unbound" data-i="${i}">
        <span class="machine-badge sm">?</span>
        <span class="plan-label">${esc(slot.name)}</span>
        <span class="plan-status">assign</span>
      </button>`;
    }
    const num = machine?.num ?? entries[0].num;
    const label = machine?.label ?? entries[0].label;
    const slotSets = entries.reduce((n, e) => n + e.sets.length, 0);
    const done = slotDone(active, slot);
    const goal = slot.target?.sets;
    // with a target the status counts progress against it ("1/3 sets")
    const status = !slotSets && !done ? 'open'
      : `${done ? '✓ ' : ''}${slotSets}${goal ? `/${goal}` : ''} set${(goal ?? slotSets) === 1 ? '' : 's'}`;
    return `<button class="plan-row" data-i="${i}" ${machine ? '' : 'disabled'}>
      <span class="machine-badge sm">${num}</span>
      <span class="plan-label">${esc(label)}${slot.exercise
        ? ` <span class="muted">· ${esc(slot.exercise)}</span>` : ''}</span>
      <span class="plan-status${done ? ' done' : ''}">${status}</span>
    </button>`;
  }).join('');

  root.innerHTML = `
    <h1>Workout</h1>
    <p class="muted">${mins} min · ${plural(sets, 'set')} · ${workoutTotals(active, s)}${(() => {
    const tally = targetTally(active);
    return tally.total ? ` · ${tally.hit}/${tally.total} target sets` : '';
  })()}</p>
    ${lockerLeads ? `
    <section class="card">
      <h2>Locker</h2>
      ${lockerInput}
      <p class="muted">Note where your stuff is — handy if the key goes missing.</p>
    </section>` : ''}
    <section class="card">
      <h2>Exercises</h2>
      ${rows || '<p class="muted">Nothing logged yet — pick your first machine below.</p>'}
    </section>
    ${allMuscles.length ? `
    <section class="card">
      <h2>Muscles today</h2>
      <div class="chip-select" id="muscle-coverage">
        ${allMuscles.map((m) => `<button type="button" class="chip${trained.has(m)
    ? ' sel done' : ''}" data-muscle="${esc(m)}">${esc(m)}</button>`).join('')}
      </div>
      <p class="muted">Tap an open muscle to find a machine for it below.</p>
    </section>` : ''}
    <section class="card">
      <h2>Add machine</h2>
      <div id="picker"></div>
    </section>
    <details class="name-edit">
      <summary>✏️ ${active.name ? esc(active.name) : 'Name this workout'}</summary>
      <div class="row">
        <input id="workout-name" type="text" placeholder="e.g. Push day"
          value="${esc(active.name ?? '')}">
      </div>
      ${nameChips.length ? `
      <div class="chip-select" id="name-chips">
        ${nameChips.map((n) => `<button type="button" class="chip${active.name === n ? ' sel' : ''}"
          data-name="${esc(n)}">${esc(n)}</button>`).join('')}
      </div>` : ''}
      <p class="muted">A named workout gets its own start row, so two routines
        on the same machines stay apart — and it stays findable in History.</p>
    </details>
    ${lockerLeads ? '' : `
    <details class="locker">
      <summary>🔒 ${active.locker ? esc(active.locker) : 'Locker'}</summary>
      ${lockerInput}
    </details>`}
    <button id="finish" class="btn">Finish workout</button>`;

  root.querySelector('#workout-name').addEventListener('change', (e) => {
    active.name = e.target.value.trim();
    saveActive(active);
  });

  // tapping a chip names the workout; tapping the selected one clears it
  root.querySelector('#name-chips')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    active.name = active.name === chip.dataset.name ? '' : chip.dataset.name;
    saveActive(active);
    renderTrain(root);
  });

  // one #locker-num either way — the card and the collapsed row render the
  // same input, so this wiring holds in both states
  root.querySelector('#locker-num').addEventListener('change', (e) => {
    active.locker = e.target.value.trim();
    saveActive(active);
  });

  root.querySelectorAll('.plan-row').forEach((row) => {
    row.addEventListener('click', () => {
      const i = parseInt(row.dataset.i, 10);
      const slot = active.plan[i];
      if (!slot.machineId) { // unbound — ask which machine before logging
        active.binding = i;
        saveActive(active);
        renderTrain(root);
        return;
      }
      active.currentMachineId = slot.machineId;
      active.currentExercise = slot.exercise;
      saveActive(active);
      renderTrain(root);
    });
  });

  const picker = machinePicker(root.querySelector('#picker'), layout, (machineId) => {
    if (!active.plan.some((p) => p.machineId === machineId)) {
      active.plan.push({ machineId, exercise: null });
    }
    active.currentMachineId = machineId;
    active.currentExercise = null;
    saveActive(active);
    renderTrain(root);
  }, { actionLabel: 'Add' });

  root.querySelector('#muscle-coverage')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) picker.setMuscle(chip.dataset.muscle);
  });

  // two-tap guard: finishing only happens once, at the very end
  const finishBtn = root.querySelector('#finish');
  finishBtn.addEventListener('click', () => {
    const armedLabel = sets
      ? 'Tap again to finish & save'
      : 'Tap again to discard (no sets logged)';
    if (!twoTapConfirm(finishBtn, armedLabel, 'Finish workout')) return;
    finish(root, active);
  });
}

// --- binding a planned exercise to a real machine ---

// The moment the gym builds itself. Standing at the machine, one number
// turns "Leg press" from a line in a trainer's note into machine #14 —
// created under the note's own name when gymii doesn't know that number
// yet. The binding is written back into the stored plan, so the question
// is asked once per exercise, not once per workout.
function renderBind(root, layout, active) {
  const i = active.binding;
  const slot = active.plan[i];
  if (!slot || slot.machineId) { // stale (already bound, or plan edited)
    delete active.binding;
    saveActive(active);
    renderTrain(root);
    return;
  }
  const name = slot.name ?? '';
  const n = name.toLowerCase();
  const machines = layout.machines.slice().sort((a, b) => a.num - b.num);
  // machines whose label looks like this exercise come first — in a gym
  // that already exists, binding a second plan is taps, not typing
  const likely = machines.filter((m) => {
    const label = String(m.label || '').toLowerCase();
    return label && n && (label.includes(n) || n.includes(label));
  });
  const chips = (list) => list.map((m) => `<button type="button" class="chip bind-pick"
    data-id="${m.id}">#${m.num} ${esc(m.label)}</button>`).join('');

  root.innerHTML = `
    <button type="button" id="bind-back" class="back-row">‹ Workout</button>
    <h1>${esc(name)}</h1>
    <p class="muted">Which machine is this? Enter the number on it — gymii
      adds it to your gym under this name.</p>
    <section class="card">
      <div class="row">
        <input id="bind-num" type="number" inputmode="numeric" min="1"
          placeholder="Machine #" value="${slot.num ?? ''}">
        <button id="bind-go" class="btn btn-primary btn-inline">That's it</button>
      </div>
    </section>
    ${likely.length ? `
    <section class="card">
      <h2>Looks like</h2>
      <div class="chip-select" id="bind-likely">${chips(likely)}</div>
    </section>` : ''}
    ${machines.length ? `
    <section class="card">
      <h2>Or pick from your gym</h2>
      <div class="chip-select" id="bind-all">${chips(machines)}</div>
    </section>` : ''}
    <button id="bind-skip" class="btn">Skip for now</button>`;

  const bindSlot = (machine) => {
    slot.machineId = machine.id;
    delete slot.name;
    delete slot.num;
    // a machine of the other type can't honour this target's shape
    if (!!machine.cardio !== (slot.target?.distance != null)) delete slot.target;
    // write the binding back into the stored plan: asked once, not every
    // workout (matched by name — the item this slot was built from)
    if (active.planId) {
      const plan = getPlans().find((p) => p.id === active.planId);
      const item = plan?.items.find((it) => !it.machineId && it.name === name);
      if (item) {
        item.machineId = machine.id;
        delete item.name;
        delete item.num;
        if (!!machine.cardio !== (item.target?.distance != null)) delete item.target;
        savePlan(plan);
      }
    }
    delete active.binding;
    active.currentMachineId = machine.id;
    active.currentExercise = null;
    saveActive(active);
    renderTrain(root);
  };

  root.querySelector('#bind-go').addEventListener('click', () => {
    const wanted = Math.round(parseFloat(root.querySelector('#bind-num').value) || 0);
    if (wanted < 1) return;
    // an unknown number creates the machine under the item's own name,
    // inheriting the target's type — see bindOrCreateMachine
    const machine = bindOrCreateMachine(layout, wanted, name, slot.target);
    saveLayout(layout);
    bindSlot(machine);
  });

  root.querySelectorAll('.bind-pick').forEach((chip) => {
    chip.addEventListener('click', () => {
      const machine = layout.machines.find((m) => m.id === chip.dataset.id);
      if (machine) bindSlot(machine);
    });
  });

  root.querySelector('#bind-skip').addEventListener('click', () => {
    delete active.binding;
    saveActive(active);
    renderTrain(root);
  });

  // same move as Skip — binding is the top of screenKey's priority, so
  // leaving the screen means clearing it, never currentMachineId
  root.querySelector('#bind-back').addEventListener('click', () => {
    delete active.binding;
    saveActive(active);
    renderTrain(root);
  });
}

// Next unfinished plan slot after the current one, wrapping around so a
// skipped (busy) machine comes up again at the end. Another exercise at
// the SAME machine is a valid next stop — only the current slot is out.
function nextOpenSlot(active, afterId, afterExercise = null) {
  const idx = planSlotIndex(active, afterId, afterExercise);
  const order = [...active.plan.slice(idx + 1), ...active.plan.slice(0, Math.max(idx, 0))];
  return order.find((slot) => !slotDone(active, slot)) ?? null;
}

// The plan index the logging screen is at: the exact (machine, exercise)
// slot when one exists, else the machine's first slot (pick pending).
function planSlotIndex(active, machineId, exercise = null) {
  const exact = active.plan.findIndex(
    (p) => p.machineId === machineId && (p.exercise ?? null) === (exercise ?? null));
  return exact !== -1 ? exact
    : active.plan.findIndex((p) => p.machineId === machineId);
}

// The physically closest OTHER machine with an open slot — the escape
// hatch when the plan's next machine is busy. The user stands at
// `machine` (its center is the location proxy); the plan-ordered walk
// stays untouched, this is pure display logic with no stored state: a
// skipped slot stays open and resurfaces via nextOpenSlot's wrap-around.
// First open slot per machine wins (plan order = exercise order there).
// Exported for the logic tests.
export function nearbyAlternative(active, layout, machine, excludeMachineId = null) {
  const center = (m) => [m.x + m.w / 2, m.y + m.h / 2];
  const [fx, fy] = center(machine);
  const seen = new Set();
  let best = null;
  for (const slot of active.plan) {
    if (slot.machineId === machine.id || slot.machineId === excludeMachineId) continue;
    if (seen.has(slot.machineId) || slotDone(active, slot)) continue;
    seen.add(slot.machineId);
    const m = layout.machines.find((mm) => mm.id === slot.machineId);
    if (!m) continue;
    const [cx, cy] = center(m);
    const d = (cx - fx) ** 2 + (cy - fy) ** 2;
    if (!best || d < best.d) best = { slot, machine: m, d };
  }
  return best;
}

// The plan target that applies at this logging position, if any.
const planTargetFor = (active, machineId, exercise = null) => {
  const idx = planSlotIndex(active, machineId, exercise);
  return idx === -1 ? null : active.plan[idx].target ?? null;
};

// "3 × 10 @ 50 kg" / "3 × 10 @ BW+5 kg" / "1000 m · 10:00" / "20:00"
// A cardio target may name only one of the two — "Treadmill 20min" sets no
// distance, and "0 m ·" in front of it is noise, not information.
const targetStr = (t, type, s) => (type === 'cardio'
  ? [t.distance ? `${t.distance} ${distUnit(s)}` : '',
    t.seconds ? fmtDuration(t.seconds) : ''].filter(Boolean).join(' · ') || '—'
  : type === 'bodyweight'
    ? `${t.sets} × ${t.reps}${t.weight ? ` @ BW+${t.weight} ${s.unit}` : ''}`
    : `${t.sets} × ${t.reps} @ ${t.weight} ${s.unit}`);

// --- logging screen ---

// Resolves which entry the logging screen edits. At multi-exercise
// machines (free weights) each exercise gets its own entry; until one is
// picked (pickPending) there is no entry and no logging UI. Entries are
// created eagerly so settings edits stick; set-less ones are dropped again
// when the workout is finished. The snapshot itself (num/label, type flags,
// exercise) is store's newEntry. `last` is the previous workout's entry for
// set prefills.
function resolveEntry(machine, active) {
  const exercises = machine.exercises ?? [];
  const exercise = exercises.includes(active.currentExercise) ? active.currentExercise : null;
  const pickPending = exercises.length > 0 && !exercise;
  if (pickPending) return { exercises, exercise, pickPending, entry: null, last: null };

  const last = lastEntryFor(machine.id, exercise);
  let entry = entryFor(active, machine.id, exercise);
  if (!entry) {
    entry = newEntry(machine, exercise);
    machine.settingsFields.forEach((f) => { entry.settings[f] = last?.settings?.[f] ?? ''; });
    active.entries.push(entry);
    saveActive(active);
  } else if (!entry.sets.length
    && (!!entry.cardio !== !!machine.cardio || !!entry.bodyweight !== !!machine.bodyweight)) {
    // machine type was toggled in the gym before any set was logged
    if (machine.cardio) entry.cardio = true; else delete entry.cardio;
    if (machine.bodyweight) entry.bodyweight = true; else delete entry.bodyweight;
    saveActive(active);
  }
  return { exercises, exercise, pickPending, entry, last };
}

// `reveal` names a selector to scroll back into view once the markup is
// rebuilt — passed by the actions that grow the set list above the inputs.
function renderLog(root, layout, active, reveal = null) {
  const machine = layout.machines.find((m) => m.id === active.currentMachineId);
  if (!machine) { // machine was deleted in the gym mid-workout
    active.currentMachineId = null;
    active.currentExercise = null;
    saveActive(active);
    renderTrain(root);
    return;
  }

  const { exercises, exercise, pickPending, entry, last } = resolveEntry(machine, active);

  const machineSlots = active.plan.filter((p) => p.machineId === machine.id);
  if (!machineSlots.length) { // free workouts grow the plan
    active.plan.push({ machineId: machine.id, exercise: null });
    saveActive(active);
  } else if (exercise && !machineSlots.some((p) => !p.exercise)
    && !machineSlots.some((p) => p.exercise === exercise)) {
    // a fresh exercise at a machine whose slots are exercise-scoped gets
    // its own slot (after its siblings) so the overview and "Next:" see
    // it; a whole-machine slot already aggregates it otherwise
    const lastIdx = active.plan.findLastIndex((p) => p.machineId === machine.id);
    active.plan.splice(lastIdx + 1, 0, { machineId: machine.id, exercise });
    saveActive(active);
  }

  const s = getSettings();
  // entry flags rule the screen — sets stay homogeneous per entry
  const type = entry?.cardio ? 'cardio' : entry?.bodyweight ? 'bodyweight' : 'strength';
  const cardio = type === 'cardio';
  const du = distUnit(s);
  // A last entry of another type (flag toggled since) is useless as a
  // set prefill or "Last:" line; machine settings still carry over above.
  const lastSets = last
    && !!last.cardio === !!entry?.cardio
    && !!last.bodyweight === !!entry?.bodyweight ? last : null;
  // Plan target for this slot — dropped when its shape no longer matches
  // the machine's type (flag toggled since the plan was made).
  const rawTarget = pickPending ? null : planTargetFor(active, machine.id, exercise);
  const target = rawTarget
    && (cardio ? rawTarget.distance != null : rawTarget.reps != null) ? rawTarget : null;
  const def = pickPending ? null : nextSetDefaults(entry, lastSets, type, s, target);
  const restSeconds = machine.restSeconds ?? s.restSeconds;
  const slotIdx = planSlotIndex(active, machine.id, exercise);
  const planPos = `${slotIdx + 1}/${active.plan.length}`;
  // one-tap flow state: which target set is up, and is the target met —
  // once it is, the Next button takes over as the primary action
  const currentSlot = slotIdx === -1 ? null : active.plan[slotIdx];
  const targetDone = !!(target && currentSlot && slotDone(active, currentSlot));
  // only a {sets,reps,weight} target can be counted off — a cardio target
  // is one bout, not a tally, and has no `sets` to count against
  const setGoal = target?.sets ?? null;
  const setPos = setGoal && currentSlot
    ? Math.min(slotSetCount(active, currentSlot) + 1, setGoal) : null;
  // the log button always says what one tap will log
  const setLabel = (d) => (cardio
    ? `${d.distance} ${du} · ${fmtDuration(d.seconds)}`
    : type === 'bodyweight'
      ? (d.weight ? `BW+${d.weight} ${s.unit} × ${d.reps}` : `BW × ${d.reps}`)
      : `${d.weight} ${s.unit} × ${d.reps}`);
  const logLabel = (d) =>
    `✓ Log set${setGoal && !targetDone ? ` ${setPos}/${setGoal}` : ''} — ${setLabel(d)}`;
  const nextSlot = nextOpenSlot(active, machine.id, exercise);
  const nextMachine = nextSlot?.machineId
    ? layout.machines.find((m) => m.id === nextSlot.machineId) : null;
  // an unbound next stop is still a next stop — it just asks which
  // machine it is before it can log anything
  const nextUnbound = !nextMachine && nextSlot?.name ? nextSlot : null;
  // offered only when it differs from the plan's next (excludeMachineId)
  const nearby = nextMachine ? nearbyAlternative(active, layout, machine, nextMachine.id) : null;

  // Quick-switch: the OTHER machines most recently trained this workout,
  // ranked by their newest `at`-stamped set. Superset workouts swing
  // between machines constantly — one tap back beats an overview detour,
  // and this stays visible even at the superset end-game where every slot
  // is done and no Next button shows.
  const otherMachines = new Map(); // machineId -> { at, exercise }
  active.entries.forEach((e) => {
    if (e.machineId === machine.id) return;
    e.sets.forEach((st) => {
      if (typeof st.at !== 'number') return;
      const cur = otherMachines.get(e.machineId);
      if (!cur || st.at > cur.at) otherMachines.set(e.machineId, { at: st.at, exercise: e.exercise ?? null });
    });
  });
  const quickSwitch = [...otherMachines].map(([machineId, v]) => ({
    machineId, ...v, m: layout.machines.find((mm) => mm.id === machineId),
  })).filter((c) => c.m).sort((a, b) => b.at - a.at).slice(0, 2);

  // Locker ask: a machine-first workout never sees the overview before the
  // first set, so the one start-of-workout errand is asked here — a single
  // row, gone once a set is logged or it's skipped, never nagging after.
  const lockerAsk = !active.locker && !active.lockerDismissed && !workoutSetCount(active);

  root.innerHTML = `
    <button type="button" id="log-back" class="back-row">‹ Workout</button>
    <div class="machine-head">
      <span class="machine-badge">${machine.num}</span>
      <div>
        <div class="title">${esc(machine.label)} <span class="muted">${planPos}</span>
          ${active.locker ? `<span class="muted">· 🔒 ${esc(active.locker)}</span>` : ''}</div>
        <div class="muted">${pickPending
    ? 'Pick an exercise below'
    : lastSets
      ? `Last: ${setsSummary(lastSets.sets, s, !!lastSets.bodyweight)}`
      : `First time on this ${exercise ? 'exercise' : 'machine'}`}</div>
        ${target ? `<div class="muted">Target: ${targetStr(target, type, s)}${targetDone
    ? ' · ✓ done' : setGoal ? ` · set ${setPos}/${setGoal}` : ''}</div>` : ''}
        ${machine.muscles?.length ? `<div class="muted">${machine.muscles.map(esc).join(' · ')}</div>` : ''}
        ${machine.brand || machine.model
    ? `<div class="muted">${[machine.brand, machine.model].filter(Boolean).map(esc).join(' · ')}</div>`
    : ''}
        ${machine.docUrl ? `<a class="doc-link" href="${esc(machine.docUrl)}"
          target="_blank" rel="noopener">Machine docs ↗</a>` : ''}
      </div>
      <button type="button" id="edit-machine" class="locate-btn"
        aria-label="Edit this machine">✏️</button>
      <button type="button" id="locate-current" class="locate-btn"
        aria-label="Show this machine on the map">📍</button>
    </div>

    ${lockerAsk ? `
    <div class="row locker-ask">
      <input id="locker-num" type="text" inputmode="numeric" placeholder="🔒 Locker #">
      <button type="button" id="locker-skip" class="btn btn-inline">Skip</button>
    </div>` : ''}

    ${exercises.length ? `
    <section class="card">
      <h2>Exercise</h2>
      <div class="chip-select" id="exercise-chips">
        ${exercises.map((x) => {
    const done = (entryFor(active, machine.id, x)?.sets.length ?? 0) > 0;
    return `<button type="button" class="chip${x === exercise ? ' sel' : ''}${done ? ' done' : ''}"
          data-exercise="${esc(x)}">${esc(x)}</button>`;
  }).join('')}
      </div>
      ${pickPending ? '<p class="muted">Pick an exercise to start logging.</p>' : ''}
    </section>` : ''}

    ${pickPending ? '' : `
    ${machine.settingsFields.length ? `
    <section class="card">
      <h2>Machine settings</h2>
      ${machine.settingsFields.map((f) => `
        <label class="field"><span>${esc(f)}</span>
          <input type="text" class="m-setting" data-field="${esc(f)}"
            value="${esc(entry.settings[f] ?? '')}">
        </label>`).join('')}
    </section>` : ''}

    <section class="card">
      <h2>Sets</h2>
      <div id="sets-list">
        ${entry.sets.map((st, i) => `
          <div class="set-row">
            <span>Set ${i + 1}</span>
            <span>${cardio
    ? `${st.distance} ${du} · ${fmtDuration(st.seconds)}`
    : type === 'bodyweight'
      ? (st.weight ? `BW+${st.weight} ${s.unit} × ${st.reps}` : `BW × ${st.reps}`)
      : `${st.weight} ${s.unit} × ${st.reps}`}</span>
            <button class="x" data-i="${i}" aria-label="Remove set ${i + 1}">✕</button>
          </div>`).join('') || '<p class="muted">No sets logged yet.</p>'}
      </div>
      <div class="next-set">
        ${cardio ? `
        ${stepperField(`Distance (${du})`, 'set-distance', { step: s.unit === 'kg' ? 100 : 0.1, min: 0, value: def.distance })}
        ${stepperField('Time (min)', 'set-time', { step: 1, min: 0, value: Math.round((def.seconds / 60) * 100) / 100 })}`
    : type === 'bodyweight' ? `
        ${stepperField('Reps', 'set-reps', { step: 1, min: 1, value: def.reps, mode: 'numeric' })}
        ${stepperField('Extra weight', 'set-weight', { step: s.weightStep, min: 0, value: def.weight })}`
      : `
        ${stepperField('Weight', 'set-weight', { step: s.weightStep, min: 0, value: def.weight })}
        ${stepperField('Reps', 'set-reps', { step: 1, min: 1, value: def.reps, mode: 'numeric' })}`}
        ${stepperField('Rest (s)', 'set-rest', { step: 15, min: 0, value: restSeconds, mode: 'numeric' })}
        <button id="log-set" class="btn ${targetDone && nextMachine ? '' : 'btn-primary '}btn-big">${logLabel(def)}</button>
      </div>
    </section>`}

    ${quickSwitch.length ? `
    <div class="quick-switch">
      ${quickSwitch.map((c) => `<button type="button" class="chip" data-machine="${esc(c.machineId)}">
        ↩ #${c.m.num} ${esc(c.m.label)}</button>`).join('')}
    </div>` : ''}

    ${nextMachine
    ? `<div class="next-row">
        <button id="next-machine" class="btn ${targetDone ? 'btn-primary' : 'btn-next'} btn-big">Next: #${nextMachine.num}
          ${esc(nextMachine.label)}${nextSlot.exercise ? ` · ${esc(nextSlot.exercise)}` : ''} →</button>
        <button type="button" id="locate-next" class="btn btn-next btn-big locate-next"
          aria-label="Show the next machine on the map">📍</button>
      </div>
      ${nearby ? `<button id="nearby-machine" class="btn">Busy? #${nearby.machine.num}
        ${esc(nearby.machine.label)} is nearby →</button>` : ''}
      <button id="change-machine" class="btn">Change machine / overview</button>`
    : nextUnbound
      ? `<button id="next-unbound" class="btn ${targetDone ? 'btn-primary' : 'btn-next'} btn-big">Next:
          ${esc(nextUnbound.name)} <span class="sub">tap to say which machine</span></button>
        <button id="change-machine" class="btn">Change machine / overview</button>`
      : '<button id="change-machine" class="btn btn-next btn-big">Workout overview →</button>'}
  `;

  root.querySelector('#exercise-chips')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    active.currentExercise = chip.dataset.exercise;
    saveActive(active);
    renderLog(root, layout, active);
  });

  // Everything below the exercise picker only exists once an entry is
  // resolved — hence the optional chaining on the pick-pending screen.
  root.querySelectorAll('.m-setting').forEach((inp) => {
    inp.addEventListener('change', () => {
      entry.settings[inp.dataset.field] = inp.value.trim();
      saveActive(active);
    });
  });

  root.querySelector('#sets-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.x');
    if (!btn) return;
    entry.sets.splice(parseInt(btn.dataset.i, 10), 1);
    saveActive(active);
    renderLog(root, layout, active, '.next-set');
  });

  // per-machine rest override, remembered on the machine itself
  root.querySelector('#set-rest')?.addEventListener('change', (e) => {
    const v = Math.max(0, Math.round(parseFloat(e.target.value) || 0));
    e.target.value = v;
    machine.restSeconds = v;
    saveLayout(layout);
  });

  root.querySelector('#log-set')?.addEventListener('click', () => {
    const rest = Math.max(0, Math.round(parseFloat(root.querySelector('#set-rest').value) || 0));
    if (cardio) {
      const distance = Math.max(0, parseFloat(root.querySelector('#set-distance').value) || 0);
      const seconds = Math.max(0, Math.round((parseFloat(root.querySelector('#set-time').value) || 0) * 60));
      entry.sets.push({ distance, seconds, at: Date.now() });
    } else {
      const weight = Math.max(0, parseFloat(root.querySelector('#set-weight').value) || 0);
      const reps = Math.max(1, Math.round(parseFloat(root.querySelector('#set-reps').value) || 1));
      entry.sets.push({ reps, weight, at: Date.now() });
    }
    saveActive(active);
    // the set list just grew a row above the inputs — put them back under
    // the thumb, so the next set is one tap and not a scroll away
    renderLog(root, layout, active, '.next-set');
    startRest(rest);
  });

  // the steppers update the one-tap label live, so the button never lies
  if (!pickPending) {
    const refreshLogLabel = () => {
      const btn = root.querySelector('#log-set');
      if (!btn) return;
      const d = cardio
        ? {
          distance: Math.max(0, parseFloat(root.querySelector('#set-distance').value) || 0),
          seconds: Math.max(0, Math.round((parseFloat(root.querySelector('#set-time').value) || 0) * 60)),
        }
        : {
          weight: Math.max(0, parseFloat(root.querySelector('#set-weight').value) || 0),
          reps: Math.max(1, Math.round(parseFloat(root.querySelector('#set-reps').value) || 1)),
        };
      btn.textContent = logLabel(d);
    };
    (cardio ? ['#set-distance', '#set-time'] : ['#set-weight', '#set-reps']).forEach((sel) =>
      root.querySelector(sel)?.addEventListener('change', refreshLogLabel));
  }

  root.querySelector('.quick-switch')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const c = quickSwitch.find((x) => x.machineId === chip.dataset.machine);
    if (!c) return;
    active.currentMachineId = c.machineId;
    active.currentExercise = c.exercise ?? null;
    saveActive(active);
    renderTrain(root);
  });

  root.querySelector('#locate-current').addEventListener('click',
    () => showMapOverlay(layout, machine));
  root.querySelector('#locate-next')?.addEventListener('click',
    () => showMapOverlay(layout, nextMachine));

  // hands the machine to the Gym's editor — the full one, not a copy
  root.querySelector('#edit-machine').addEventListener('click', () => {
    focusMachine(machine.id);
    location.hash = '#gym';
  });

  root.querySelector('#locker-num')?.addEventListener('change', (e) => {
    active.locker = e.target.value.trim();
    saveActive(active);
    renderLog(root, layout, active); // collapse the row right away — noted, done
  });
  root.querySelector('#locker-skip')?.addEventListener('click', () => {
    active.lockerDismissed = true;
    saveActive(active);
    renderLog(root, layout, active);
  });

  // same move as a Next tap, just to the nearby machine instead
  root.querySelector('#nearby-machine')?.addEventListener('click', () => {
    active.currentMachineId = nearby.slot.machineId;
    active.currentExercise = nearby.slot.exercise;
    saveActive(active);
    renderTrain(root);
  });

  root.querySelector('#next-machine')?.addEventListener('click', () => {
    active.currentMachineId = nextSlot.machineId;
    active.currentExercise = nextSlot.exercise;
    saveActive(active);
    renderTrain(root);
  });

  root.querySelector('#next-unbound')?.addEventListener('click', () => {
    active.binding = active.plan.indexOf(nextUnbound);
    saveActive(active);
    renderTrain(root);
  });

  const toOverview = () => {
    active.currentMachineId = null;
    active.currentExercise = null;
    saveActive(active);
    renderTrain(root);
  };
  root.querySelector('#change-machine').addEventListener('click', toOverview);
  root.querySelector('#log-back').addEventListener('click', toOverview);

  if (reveal) keepInView(root, reveal);
}

// Default for the next set: the set just done this workout, else the first
// set of the previous workout. Once a set is logged, this workout is the
// truth — history seeds only the opener. `last` and `target` must already
// be type-matched to the entry (caller gates on the flags). A plan target
// is the goal for THIS workout: it beats history as the first-set prefill,
// but never what was actually just lifted — after a deviation (50 instead
// of the planned 55) the prefill follows the real working weight.
// Exported for the logic tests (same reason as nearbyAlternative): the
// precedence matrix is pure logic and pinning it through the stub DOM would
// only test the renderer.
export function nextSetDefaults(entry, last, type, s, target = null) {
  if (target) {
    if (entry.sets.length) return entry.sets[entry.sets.length - 1];
    return type === 'cardio'
      ? { distance: target.distance, seconds: target.seconds }
      : { reps: target.reps, weight: target.weight };
  }
  if (entry.sets.length) return entry.sets[entry.sets.length - 1];
  if (last?.sets?.length) return last.sets[0];
  if (type === 'cardio') return { distance: s.unit === 'kg' ? 1000 : 0.5, seconds: 600 };
  if (type === 'bodyweight') return { reps: 10, weight: 0 };
  return { reps: 10, weight: 20 };
}

// Joins ui.js's setStr per set; the weight unit is appended once when any
// weight was actually moved.
const setsSummary = (sets, s, bodyweight = false) => {
  const body = sets.map((st) => setStr(st, s, bodyweight)).join(', ');
  const suffix = sets.every((st) => st.distance == null) && sets.some((st) => st.weight)
    ? ` ${s.unit}` : '';
  return body + suffix;
};

function finish(root, active) {
  // the hub is the resting point after the loop closes — not whatever
  // sub-screen the workout happened to start from
  screen = 'hub';
  // target tally must run BEFORE finishWorkout clears the active state
  const { total: goalTotal, hit: goalHit } = targetTally(active);
  const saved = finishWorkout(active);
  ambientFinished(); // the workout just landed — push it now, not in 8 s
  if (!saved) {
    renderTrain(root, 'Workout discarded — no sets were logged.');
    return;
  }
  const sets = saved.entries.reduce((n, e) => n + e.sets.length, 0);
  // count machines, not entries — several exercises at one machine still
  // add up to a single machine trained
  const machines = new Set(saved.entries.map((e) => e.machineId)).size;
  renderTrain(root, `Workout saved: ${plural(machines, 'machine')}, `
    + `${plural(sets, 'set')}, ${workoutTotals(saved, getSettings())} total`
    + `${goalTotal ? `, ${goalHit}/${goalTotal} target sets` : ''}.`);
}

// --- screen wake lock ---
// Module-level, because its scope may outlive the rest overlay: with
// settings.keepAwake = 'workout' the lock is held for the whole workout,
// with 'break' only while the timer runs. Two reasons can want it, so they
// are tracked separately and reconciled — a re-render mid-break must not
// drop the break's lock. Guarded for Node (the logic tests have no
// document/navigator at all).
let wakeLock = null;
let wakeLockPending = false;
let wakeLockWanted = false;
let wakeLockWired = false;
let lockForBreak = false;
let lockForWorkout = false;

async function applyWakeLock() {
  if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
  if (!wakeLockWanted) {
    const held = wakeLock;
    wakeLock = null;
    held?.release().catch(() => {});
    return;
  }
  if (wakeLock || wakeLockPending) return;
  wakeLockPending = true;
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    // the want may have ended while the request was in flight — an
    // unreleased sentinel would keep the screen awake forever
    if (!wakeLockWanted) { sentinel.release().catch(() => {}); return; }
    wakeLock = sentinel;
    sentinel.addEventListener('release', () => {
      if (wakeLock === sentinel) wakeLock = null;
    });
  } catch { /* unsupported or denied */ } finally {
    wakeLockPending = false;
  }
}

function syncWakeLock() {
  wakeLockWanted = lockForBreak || lockForWorkout;
  // the browser drops the lock whenever the tab hides — take it again on
  // return. Wired once, on first want.
  if (wakeLockWanted && !wakeLockWired && typeof document !== 'undefined') {
    wakeLockWired = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') applyWakeLock();
    });
  }
  applyWakeLock();
}

// --- rest timer ---
// The audio machinery (shared media element, TIMER_SOUNDS, playTimerSound)
// lives in ui.js — Settings previews the same sounds with the same code.

// When the rest screen dims itself, in seconds after the break starts.
// Exported for the logic tests.
export const dimDelaySeconds = (mode) => (mode === 'off' ? Infinity : mode === 'now' ? 0 : 10);

// A touch brings the screen back to full brightness for this long.
const DIM_WAKE_MS = 4000;
// How long a passing second lights the countdown up.
const DIM_LIT_MS = 130;
// The last seconds before zero are never dimmed — look up, the tone is next.
const DIM_ENDGAME_SECS = 5;

function startRest(secs) {
  if (!secs) return; // 0 = rest timer off
  // Prime silently while the tap that logged the set is still the gesture —
  // the sound itself only plays when the countdown reaches zero.
  primeAudio();

  const dimChips = (sel) => [['off', 'Never'], ['10s', 'After 10 s'], ['now', 'Now']]
    .map(([v, label]) => `<button type="button" class="chip sm${v === sel ? ' sel' : ''}"
      data-dim="${v}">${label}</button>`).join('');

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="muted">REST</div>
    <div class="countdown" id="cd"></div>
    <div class="row">
      <button class="btn" id="rest-minus">−15s</button>
      <button class="btn" id="rest-plus">+15s</button>
    </div>
    <div class="row"><button class="btn btn-primary" id="rest-skip">Skip</button></div>
    <div class="rest-opts" id="dim-opts">
      <span class="muted">🌙 Darken</span>${dimChips(getSettings().timerDim)}
    </div>`;
  document.body.appendChild(overlay);

  let endsAt = Date.now() + secs * 1000;
  let done = false;
  const cd = overlay.querySelector('#cd');

  // Dimming: the overlay darkens itself once `dimAt` passes — the screen
  // stays ON (that is the wake lock's job), it just stops glaring in a dark
  // gym. The countdown remains readable and TICKS: every passing second
  // jerks it brighter for a moment, which is what says the timer is alive
  // without lighting the whole screen. Any touch buys DIM_WAKE_MS of full
  // brightness, and the endgame seconds never dim.
  let dimAt = Date.now() + dimDelaySeconds(getSettings().timerDim) * 1000;
  let shownRem = null;
  const brighten = () => { dimAt = Date.now() + DIM_WAKE_MS; };
  overlay.addEventListener('pointerdown', brighten);

  overlay.querySelector('#dim-opts').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    saveSettings({ ...getSettings(), timerDim: chip.dataset.dim });
    overlay.querySelector('#dim-opts').innerHTML =
      `<span class="muted">🌙 Darken</span>${dimChips(chip.dataset.dim)}`;
    dimAt = Date.now() + dimDelaySeconds(chip.dataset.dim) * 1000;
  });

  // The break wants the screen awake unless the setting says never; the
  // module-level manager owns the lock (with 'workout' scope it is already
  // held and simply stays).
  lockForBreak = getSettings().keepAwake !== 'off';
  syncWakeLock();

  // Both timers are held so they can be taken back: the countdown may be
  // revived by a ±15s tap (see adjust), and a stale removal would otherwise
  // cut the next jerk short or close a running timer.
  let closeTimer = null;
  let litTimer = null;

  const close = () => {
    clearInterval(interval);
    clearTimeout(closeTimer);
    clearTimeout(litTimer);
    lockForBreak = false;
    syncWakeLock(); // a 'workout'-scoped lock survives this
    overlay.remove();
  };
  const tick = () => {
    const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    cd.textContent = fmtDuration(rem);
    overlay.classList.toggle('dim', Date.now() >= dimAt && rem > DIM_ENDGAME_SECS);
    if (rem !== shownRem) { // a second passed: jerk the countdown brighter
      shownRem = rem;
      cd.classList.add('lit');
      clearTimeout(litTimer); // one pending removal, so every jerk lasts its full length
      litTimer = setTimeout(() => cd.classList.remove('lit'), DIM_LIT_MS);
    }
    if (rem === 0 && !done) {
      done = true;
      cd.classList.add('done');
      playTimerSound(getSettings().timerSound);
      navigator.vibrate?.(200);
      closeTimer = setTimeout(close, 900);
    }
  };
  const interval = setInterval(tick, 200);
  tick();

  // ±15s. Giving a finished timer more time REVIVES it — the overlay lingers
  // ~900ms after the tone, and a tap in that window used to extend a
  // countdown that was already scheduled to close (the extra time was
  // silently thrown away, and the new zero would never have sounded).
  const adjust = (ms) => {
    endsAt += ms;
    if (done && endsAt > Date.now()) {
      clearTimeout(closeTimer);
      closeTimer = null;
      done = false;
      cd.classList.remove('done');
    }
    tick();
  };

  overlay.querySelector('#rest-skip').addEventListener('click', close);
  overlay.querySelector('#rest-minus').addEventListener('click', () => adjust(-15000));
  overlay.querySelector('#rest-plus').addEventListener('click', () => adjust(15000));
}
