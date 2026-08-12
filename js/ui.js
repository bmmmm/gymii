// Small shared UI helpers.

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
