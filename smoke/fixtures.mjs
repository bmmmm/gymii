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
