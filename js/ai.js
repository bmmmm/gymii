// AI exchange view. gymii deliberately never calls any AI service —
// the user copies data out and pastes results back in, keeping full
// control over where their data goes.

import {
  getLayout, getWorkouts, getSettings, saveSettings, importData, distUnit,
  getActive, getPlans, planFromImport, savePlan, ownBrand,
} from './store.js';
import { openPlanBuilder } from './train.js';
import { twoTapConfirm, plural, dateValue } from './ui.js';

export const DEFAULT_PROMPT = `You are my strength training coach. Below is my gym setup and my full workout log as JSON (sets are [weight, reps]; entries marked cardio:true use [distance, seconds] instead, distance in the unit given; for entries marked bodyweight:true the weight is ADDED weight on top of bodyweight, 0 = bodyweight only; for entries marked assisted:true (a counterweight machine like an assisted pull-up) the weight is the ASSISTANCE — less is stronger, 0 = unassisted — and the machine's "assistGoal", when present, says whether I train there for less assistance ("strength") or more reps at the same assistance ("endurance"); an "exercise" field names one movement at a multi-exercise machine like a free-weight area; a machine's "secondaryMuscles" are worked less than its "muscles" (count a set as half for them); a "grip" field names the attachment or grip it was done with (a rope and a V-bar on one cable tower are separate progressions — never mix their numbers); a third tuple element, when present, is seconds since the workout started — sets without it predate timing and are excluded from time analysis, and null there means the set has no timestamp; a fourth element, when present, is RIR, reps in reserve, 0–3, 3 = three or more; absent = not rated — except on cardio entries, where the fourth element is the level, the machine's resistance step (a whole number from 1; absent = none logged), so a cardio set reads [distance, seconds, seconds-offset or null, level]). A workout's "visits", when present, is the route I walked: [num, seconds in, seconds out] per machine, in order, seconds since the workout started; a fourth element is the num of a machine I skipped because it was busy.

Analyze my progress: trends per machine, plateaus, and muscle-group imbalances. Then suggest concrete targets for my next workout — weight × reps per machine — and one or two practical tips.

Using the timing offsets: join each entry's num against the gym's machines list to get its muscles, and flag same-muscle-group sets spaced too closely together — unless the alternation looks deliberate (a consistent A↔B or A→B→C rhythm reads as a superset/circuit, which is fine and worth calling out as such). Also comment on idle gaps between machines and on the overall density of the workout.

If you propose changes to my gym or machines, reply with a valid gymii gym-template JSON (exactly the structure the app exports) so I can paste it straight back into gymii.

If I ask you to PLAN a workout (e.g. "plan me a chest & shoulders workout", possibly excluding some machines), pick suitable machines via their muscles field and reply with a gymii workout-plan JSON I can paste back:
{"app":"gymii","kind":"workout-plan","name":"<short name>","items":[{"num":<machine num>,"sets":3,"reps":10,"weight":50}]}
Use each machine's num exactly as listed, weights in my unit derived from my history (a slight progression where it looks earned), add "exercise" only for a movement at a multi-exercise machine, add "grip" only with a value from that machine's "grips" list, and use {"num":…,"distance":…,"seconds":…} for cardio machines, with an optional "level" (the machine's resistance step, a whole number from 1). An optional top-level "days":[1,4] tags weekdays (0 = Sunday).
For a movement my gym has no machine for, give {"name":"<exercise name>","sets":3,"reps":10,"weight":50} instead of a num — gymii keeps it and asks me which machine it is at the gym.
My saved plans, when present, are included as "plans" in that same shape. If I ask you to revise one, reply with the full revised plan and KEEP its "id" — that lets gymii update the plan in place (it asks me before replacing). Omit "id" for a brand-new plan.`;

export function renderAi(root) {
  const settings = getSettings();
  const prompt = settings.aiPrompt ?? DEFAULT_PROMPT;

  root.innerHTML = `
    <h1>AI</h1>
    <p class="muted">gymii never talks to an AI service itself. You copy your data to the LLM
    you trust and paste its results back — your data, your choice.</p>

    <section class="card">
      <h2>Copy for AI</h2>
      <label class="stack"><span class="muted">Prompt — editable, saved for next time</span>
        <textarea id="ai-prompt" rows="7"></textarea></label>
      <label class="stack"><span class="muted">Your data — editable before copying</span>
        <textarea id="ai-data" rows="12"></textarea></label>
      <button id="ai-copy" class="btn btn-primary">Copy prompt + data</button>
      <button id="ai-reset" class="btn">Reset prompt to default</button>
      <p id="ai-msg" class="muted" role="status"></p>
    </section>

    <section class="card">
      <h2>Import from AI</h2>
      <p class="muted">Paste a gymii gym-template, backup or workout-plan JSON produced by your LLM.</p>
      <label class="stack">
        <textarea id="ai-import" rows="6"
          placeholder='{"app": "gymii", "kind": "gym-template", …}'></textarea></label>
      <button id="ai-import-btn" class="btn">Import pasted JSON</button>
      <p id="ai-import-msg" class="muted" role="status"></p>
    </section>`;

  // textareas get their content via value, not innerHTML, so user data
  // can never break out of the markup
  const promptEl = root.querySelector('#ai-prompt');
  const dataEl = root.querySelector('#ai-data');
  promptEl.value = prompt;
  dataEl.value = buildAiExport();

  const msg = root.querySelector('#ai-msg');

  promptEl.addEventListener('change', () => {
    saveSettings({ ...getSettings(), aiPrompt: promptEl.value });
  });

  // two-tap: a hand-edited prompt has no undo anywhere on this page
  const resetBtn = root.querySelector('#ai-reset');
  resetBtn.addEventListener('click', () => {
    if (!twoTapConfirm(resetBtn,
      'Tap again to discard your edited prompt', 'Reset prompt to default')) return;
    const { aiPrompt, ...rest } = getSettings();
    saveSettings(rest);
    promptEl.value = DEFAULT_PROMPT;
    msg.textContent = 'Prompt reset.';
  });

  root.querySelector('#ai-copy').addEventListener('click', async () => {
    const text = `${promptEl.value}\n\n${dataEl.value}`;
    try {
      await navigator.clipboard.writeText(text);
      msg.textContent = `Copied ${text.length.toLocaleString('en')} characters — paste them into your LLM.`;
    } catch {
      msg.textContent = 'Clipboard blocked by the browser — select the text above and copy manually.';
    }
  });

  const importMsg = root.querySelector('#ai-import-msg');
  const importBtn = root.querySelector('#ai-import-btn');
  importBtn.addEventListener('click', () => {
    const raw = root.querySelector('#ai-import').value.trim();
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (data?.app === 'gymii' && data.kind === 'workout-plan') {
        // A plan import is a proposal, not a fact: save it, then hand it
        // to the builder for review (exclude machines, adjust targets) —
        // unless a workout is running, which outranks the builder screen.
        const { plan: parsed, unbound, replacesId } = planFromImport(data);
        let plan = parsed;
        if (replacesId) {
          // a revision of an exported plan — replacing is destructive, so
          // it two-taps like every other destructive action, named after
          // the plan that would be overwritten
          const existing = getPlans().find((p) => p.id === replacesId);
          if (!twoTapConfirm(importBtn,
            `Tap again to replace plan "${existing.name || parsed.name || 'unnamed'}"`,
            'Import pasted JSON')) return;
          // replace content, keep identity: createdAt survives for
          // missed-day tracking; days and name survive when the revision
          // leaves them out
          plan = {
            ...existing, ...parsed, id: replacesId, name: parsed.name || existing.name,
          };
        }
        savePlan(plan);
        // machines the gym doesn't know are kept, not dropped — they bind
        // on the gym floor the first time they come up
        const skipNote = unbound.length
          ? ` (${plural(unbound.length, 'exercise')} still need a machine: ${unbound.join(', ')})` : '';
        if (getActive()) {
          dataEl.value = buildAiExport(); // the export carries the plan now
          importMsg.textContent = `Plan saved${skipNote} — find it on the Train tab after your workout.`;
        } else {
          openPlanBuilder(plan.id, `Imported from AI${skipNote} — review, adjust, save.`);
          location.hash = '#train';
        }
        return;
      }
      const kind = importData(data);
      importMsg.textContent = kind === 'backup'
        ? 'Backup imported — check Gym and History.'
        : 'Gym template imported — check Gym.';
      dataEl.value = buildAiExport();
    } catch (err) {
      importMsg.textContent = `Import failed: ${err.message}`;
    }
  });
}

// One num space: the export names a machine by its CURRENT layout num,
// looked up by machineId while the machine exists. Entries and visits carry
// the num they were logged under, which drifts after a renumbering; a
// machine deleted since is the only case where that snapshot is still the
// best name there is. Stored data is never touched — only the export.
function machineName(layout, machineId, snapshot) {
  const m = machineId ? layout?.machines.find((x) => x.id === machineId) : null;
  return { num: m ? m.num : snapshot?.num ?? null, label: m ? m.label : snapshot?.label };
}

// A workout's route as [num, inSec, outSec, busyNum?] — numbers, not ids
// (the LLM joins on num), seconds since the start like the set tuples. A
// visit names a machine id; the layout knows its current num, else the
// workout's own entry snapshot does, and a machine neither knows is dropped.
// `visits` arrives through backups and sync unchecked, so anything that is
// not a list of objects counts as no route — never a dead AI tab.
function visitTuples(w, layout) {
  if (!Array.isArray(w.visits)) return [];
  const numOf = (id) => machineName(layout, id, w.entries.find((e) => e.machineId === id)).num;
  const sec = (t) => (Number.isFinite(t) ? Math.round((t - w.startedAt) / 1000) : null);
  return w.visits.flatMap((v) => {
    const num = v && typeof v === 'object' ? numOf(v.machineId) : null;
    if (num == null) return [];
    const busy = v.busy ? numOf(v.busy) : null;
    return [[num, sec(v.in), sec(v.out), ...(busy != null ? [busy] : [])]];
  });
}

// JSON.stringify(…, null, 1) puts every number of every set on its own line
// (~3300 lines for the demo gym). Same valid JSON, but whatever fits within
// WIDTH columns stays on one line — tuples, machines, entries — and only
// containers that do not fit break, one child per line. Exported for the
// logic tests.
const WIDTH = 160;
export function compactJson(v, indent = '') {
  const flat = JSON.stringify(v);
  if (flat === undefined || flat.length + indent.length <= WIDTH || v === null || typeof v !== 'object') return flat;
  const inner = `${indent} `;
  if (Array.isArray(v)) {
    return `[\n${v.map((x) => inner + compactJson(x, inner)).join(',\n')}\n${indent}]`;
  }
  const rows = Object.entries(v).filter(([, x]) => x !== undefined && typeof x !== 'function')
    .map(([k, x]) => `${inner}${JSON.stringify(k)}: ${compactJson(x, inner)}`);
  return `{\n${rows.join(',\n')}\n${indent}}`;
}

// Compact, LLM-friendly snapshot: machines + saved plans + full log, no
// floor layout.
export function buildAiExport() {
  const layout = getLayout();
  const settings = getSettings();
  const plans = getPlans();
  return compactJson({
    app: 'gymii',
    kind: 'ai-export',
    unit: settings.unit,
    note: `every num is the machine's current num in gym.machines (a machine deleted since keeps ` +
      `the num it was logged under); sets are [weight, reps]; entries with cardio:true use [distance, seconds], distance in ${
      distUnit(settings)}; bodyweight:true entries log ADDED weight (0 = bodyweight only); ` +
      'assisted:true entries log the ASSISTANCE (less = stronger, 0 = unassisted); ' +
      'a third element, when present, is seconds since the workout started (sets logged before ' +
      'timing was added lack it; null = no timestamp); a fourth element, when present, is RIR ' +
      '(reps in reserve, 0-3, 3 = three or more; absent = not rated) — on a cardio entry it is the ' +
      'level instead (the machine\'s resistance step, a whole number from 1; absent = none logged); ' +
      'a workout\'s visits are ' +
      '[num, seconds in, seconds out, busy num?] — the machines walked to, in order, seconds since ' +
      'the workout started, the fourth the num of a machine skipped as busy',
    // `gym` is the frozen wire name for the layout — the prompt teaches it
    // and pasted-back answers use it (see store.js exportGymTemplate)
    gym: layout ? {
      name: layout.name,
      // the gym's own brand; a machine lists one only where it differs
      ...(layout.meta?.brand ? { brand: layout.meta.brand } : {}),
      machines: layout.machines.map((m) => ({
        num: m.num,
        label: m.label,
        ...(ownBrand(layout, m) ? { brand: m.brand } : {}),
        ...(m.model ? { model: m.model } : {}),
        ...(m.cardio ? { cardio: true } : {}),
        ...(m.bodyweight ? { bodyweight: true } : {}),
        ...(m.assisted ? { assisted: true, ...(m.assistGoal ? { assistGoal: m.assistGoal } : {}) } : {}),
        ...(m.exercises?.length ? { exercises: m.exercises } : {}),
        ...(m.grips?.length ? { grips: m.grips } : {}),
        settings: m.settingsFields,
        muscles: m.muscles?.length ? m.muscles : undefined,
        secondaryMuscles: m.secondaryMuscles?.length ? m.secondaryMuscles : undefined,
        doc: m.docUrl || undefined,
      })),
    } : null,
    // saved plans, in the same wire shape the prompt teaches for answers —
    // the id is what lets a revised plan replace its original on paste-back
    ...(plans.length ? {
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.days?.length ? { days: p.days } : {}),
        items: p.items.map((it) => {
          const m = it.machineId ? layout?.machines.find((x) => x.id === it.machineId) : null;
          if (it.machineId && !m) return null; // machine deleted since
          return {
            ...(m ? { num: m.num } : { name: it.name, ...(it.num ? { num: it.num } : {}) }),
            ...(it.exercise ? { exercise: it.exercise } : {}),
            ...(it.grip ? { grip: it.grip } : {}),
            ...(it.target ?? {}),
          };
        }).filter(Boolean),
      })),
    } : {}),
    workouts: getWorkouts().map((w) => {
      const visits = visitTuples(w, layout);
      return {
        date: dateValue(w.startedAt),
        ...(visits.length ? { visits } : {}), // absent rather than empty
        entries: w.entries.map((e) => {
          const { num, label } = machineName(layout, e.machineId, e);
          return {
            machine: label,
            num,
            ...(e.exercise ? { exercise: e.exercise } : {}),
            ...(e.grip ? { grip: e.grip } : {}),
            ...(e.cardio ? { cardio: true } : {}),
            ...(e.bodyweight ? { bodyweight: true } : {}),
            ...(e.assisted ? { assisted: true } : {}),
            ...(Object.keys(e.settings || {}).some((k) => String(e.settings[k]).trim() !== '')
              ? { settings: e.settings } : {}),
            // the fourth element is a strength set's rating and a cardio
            // set's level — one slot serves both, since a cardio set is
            // never rated; null holds the third slot when the set has no `at`
            sets: e.sets.map((st) => {
              const base = e.cardio ? [st.distance, st.seconds] : [st.weight, st.reps];
              const fourth = e.cardio ? (st.level >= 1 ? st.level : null)
                : st.rir != null ? st.rir : null;
              if (st.at == null && fourth == null) return base;
              const sec = st.at == null ? null : Math.round((st.at - w.startedAt) / 1000);
              return fourth == null ? [...base, sec] : [...base, sec, fourth];
            }),
          };
        }),
      };
    }),
  });
}
