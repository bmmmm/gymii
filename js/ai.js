// AI exchange view. gymii deliberately never calls any AI service —
// the user copies data out and pastes results back in, keeping full
// control over where their data goes.

import {
  getGym, getWorkouts, getSettings, saveSettings, importData, distUnit,
  getActive, planFromImport, savePlan,
} from './store.js';
import { openPlanBuilder } from './train.js';
import { twoTapConfirm } from './ui.js';

const DEFAULT_PROMPT = `You are my strength training coach. Below is my gym setup and my full workout log as JSON (sets are [weight, reps]; entries marked cardio:true use [distance, seconds] instead, distance in the unit given; for entries marked bodyweight:true the weight is ADDED weight on top of bodyweight, 0 = bodyweight only; an "exercise" field names one movement at a multi-exercise station like a free-weight area; a third tuple element, when present, is seconds since the workout started — sets without it predate timing and are excluded from time analysis).

Analyze my progress: trends per machine, plateaus, and muscle-group imbalances. Then suggest concrete targets for my next workout — weight × reps per machine — and one or two practical tips.

Using the timing offsets: join each entry's num against the gym's machines list to get its muscles, and flag same-muscle-group sets spaced too closely together — unless the alternation looks deliberate (a consistent A↔B or A→B→C rhythm reads as a superset/circuit, which is fine and worth calling out as such). Also comment on idle gaps between stations and on the overall density of the workout.

If you propose changes to my gym or machines, reply with a valid gymii gym-template JSON (exactly the structure the app exports) so I can paste it straight back into gymii.

If I ask you to PLAN a workout (e.g. "plan me a chest & shoulders session", possibly excluding some machines), pick suitable machines via their muscles field and reply with a gymii workout-plan JSON I can paste back:
{"app":"gymii","kind":"workout-plan","name":"<short name>","items":[{"num":<machine num>,"sets":3,"reps":10,"weight":50}]}
Use each machine's num exactly as listed, weights in my unit derived from my history (a slight progression where it looks earned), add "exercise" only for a movement at a multi-exercise station, and use {"num":…,"distance":…,"seconds":…} for cardio machines. An optional top-level "days":[1,4] tags weekdays (0 = Sunday).
For a movement my gym has no machine for, give {"name":"<exercise name>","sets":3,"reps":10,"weight":50} instead of a num — gymii keeps it and asks me which machine it is at the gym.`;

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
  root.querySelector('#ai-import-btn').addEventListener('click', () => {
    const raw = root.querySelector('#ai-import').value.trim();
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (data?.app === 'gymii' && data.kind === 'workout-plan') {
        // A plan import is a proposal, not a fact: save it, then hand it
        // to the builder for review (exclude machines, adjust targets) —
        // unless a workout is running, which outranks the builder screen.
        const { plan, unbound } = planFromImport(data);
        savePlan(plan);
        // machines the gym doesn't know are kept, not dropped — they bind
        // on the gym floor the first time they come up
        const skipNote = unbound.length
          ? ` (${unbound.length} exercise${unbound.length === 1 ? '' : 's'} still need a machine: ${unbound.join(', ')})` : '';
        if (getActive()) {
          importMsg.textContent = `Plan saved${skipNote} — find it on the Train tab after your workout.`;
        } else {
          openPlanBuilder(plan.id, `Imported from AI${skipNote} — review, adjust, save.`);
          location.hash = '#train';
        }
        return;
      }
      const kind = importData(data);
      importMsg.textContent = kind === 'backup'
        ? 'Backup imported — check Studio and History.'
        : 'Gym template imported — check Studio.';
      dataEl.value = buildAiExport();
    } catch (err) {
      importMsg.textContent = `Import failed: ${err.message}`;
    }
  });
}

// Compact, LLM-friendly snapshot: machines + full log, no floor layout.
export function buildAiExport() {
  const gym = getGym();
  const settings = getSettings();
  return JSON.stringify({
    app: 'gymii',
    kind: 'ai-export',
    unit: settings.unit,
    note: `sets are [weight, reps]; entries with cardio:true use [distance, seconds], distance in ${
      distUnit(settings)}; bodyweight:true entries log ADDED weight (0 = bodyweight only); ` +
      'a third element, when present, is seconds since the workout started (sets logged before ' +
      'timing was added lack it)',
    gym: gym ? {
      name: gym.name,
      machines: gym.machines.map((m) => ({
        num: m.num,
        label: m.label,
        ...(m.cardio ? { cardio: true } : {}),
        ...(m.bodyweight ? { bodyweight: true } : {}),
        ...(m.exercises?.length ? { exercises: m.exercises } : {}),
        settings: m.settingsFields,
        muscles: m.muscles?.length ? m.muscles : undefined,
        doc: m.docUrl || undefined,
      })),
    } : null,
    workouts: getWorkouts().map((w) => ({
      date: new Date(w.startedAt).toISOString().slice(0, 10),
      entries: w.entries.map((e) => ({
        machine: e.label,
        num: e.num,
        ...(e.exercise ? { exercise: e.exercise } : {}),
        ...(e.cardio ? { cardio: true } : {}),
        ...(e.bodyweight ? { bodyweight: true } : {}),
        ...(Object.keys(e.settings || {}).some((k) => String(e.settings[k]).trim() !== '')
          ? { settings: e.settings } : {}),
        sets: e.sets.map((st) => {
          const base = e.cardio ? [st.distance, st.seconds] : [st.weight, st.reps];
          if (st.at == null) return base;
          return [...base, Math.round((st.at - w.startedAt) / 1000)];
        }),
      })),
    })),
  }, null, 1);
}
