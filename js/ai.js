// AI exchange view. gymii deliberately never calls any AI service —
// the user copies data out and pastes results back in, keeping full
// control over where their data goes.

import { getGym, getWorkouts, getSettings, saveSettings, importData } from './store.js';
import { esc } from './ui.js';

const DEFAULT_PROMPT = `You are my strength training coach. Below is my gym setup and my full workout log as JSON (sets are [weight, reps]).

Analyze my progress: trends per machine, plateaus, and muscle-group imbalances. Then suggest concrete targets for my next workout — weight × reps per machine — and one or two practical tips.

If you propose changes to my gym or machines, reply with a valid gymii gym-template JSON (exactly the structure the app exports) so I can paste it straight back into gymii.`;

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
      <p class="muted">Paste a gymii gym-template or backup JSON produced by your LLM.</p>
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

  root.querySelector('#ai-reset').addEventListener('click', () => {
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
      const kind = importData(JSON.parse(raw));
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
function buildAiExport() {
  const gym = getGym();
  const settings = getSettings();
  return JSON.stringify({
    app: 'gymii',
    kind: 'ai-export',
    unit: settings.unit,
    note: 'sets are [weight, reps]',
    gym: gym ? {
      name: gym.name,
      machines: gym.machines.map((m) => ({
        num: m.num,
        label: m.label,
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
        ...(Object.keys(e.settings || {}).some((k) => String(e.settings[k]).trim() !== '')
          ? { settings: e.settings } : {}),
        sets: e.sets.map((st) => [st.weight, st.reps]),
      })),
    })),
  }, null, 1);
}
