// Shared setup for the browser smoke tests.
//
// The fixture comes out of the APP's own module (js/demo.js, deterministic
// by design), never out of a literal here: a spec that spelled a storage
// shape of its own would keep passing after store.js changed it.

/** The five tab routes, in tab-bar order. */
export const ROUTES = ['train', 'gym', 'history', 'ai', 'settings'];

/**
 * Loads the deterministic Demo gym — 16 machines, 8 weeks of history,
 * three plans — and reboots the app on it.
 */
export async function seedDemoGym(page) {
  await page.goto('/#train');
  await page.evaluate(async () => {
    localStorage.clear();
    const { loadDemoData } = await import('/js/demo.js');
    loadDemoData();
  });
  // A hash change does NOT reload; the app has to boot on the seeded data.
  await page.reload();
}

/**
 * Collects console errors and failed responses from now on. Attach BEFORE
 * the navigation you want covered — that is the whole point of scenario 1.
 */
export function watchForFailures(page) {
  const consoleErrors = [];
  const badResponses = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('response', (res) => {
    if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url()}`);
  });
  return { consoleErrors, badResponses };
}

/** Starts a workout at one machine, by number, through the real picker. */
export async function startWorkoutAt(page, machineNum) {
  await page.locator('#hub-start').click();
  await page.locator('.pick-num').fill(String(machineNum));
  await page.locator('.pick-go').click();
  await page.locator('#log-set').waitFor();
}

// --- page probes, run via page.evaluate(): self-contained, no closure ---

// Reports the first node that sticks out, with enough of itself to be
// findable — "the page scrolls sideways" alone is an unusable failure.
export const findOverflow = () => {
  const limit = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth <= limit) return null;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > limit + 0.5) {
      return `<${el.tagName.toLowerCase()} class="${el.className}"> `
        + `right=${Math.round(r.right)} > ${limit} :: ${(el.textContent || '').trim().slice(0, 40)}`;
    }
  }
  return `scrollWidth ${document.documentElement.scrollWidth} > ${limit}, no single node blamed`;
};

/**
 * Every rendered control under 44px and every field under 16px, as
 * readable names — { small, tiny }, both empty when the screen is fine.
 */
export const measure = () => {
  // Both documented in the stylesheet: seven columns of a week do not fit
  // 44px at 320px (34px still clears WCAG's 24px essential-layout
  // exception), and .linkish is a button that reads as a word in a
  // sentence.
  const ALLOWED = ['hm-cell', 'linkish'];
  const small = [];
  const tiny = [];
  const controls = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button]';
  for (const el of document.querySelectorAll(controls)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue; // not rendered
    const name = `<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ''} `
      + `class="${el.className}"> ${Math.round(r.width)}x${Math.round(r.height)}`
      + ` :: ${(el.textContent || el.value || '').trim().slice(0, 30)}`;
    if (!ALLOWED.some((c) => el.classList.contains(c)) && (r.width < 44 || r.height < 44)) {
      small.push(name);
    }
    // iOS zooms the page when a field under 16px takes focus
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
      && parseFloat(getComputedStyle(el).fontSize) < 16) {
      tiny.push(name);
    }
  }
  return { small, tiny };
};
