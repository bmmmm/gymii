// Pins of the 2026-10-22 review fixes and open items, each one checked to
// FAIL on the build before them (8bc05d9) — not just to pass after.
import { test, expect } from '@playwright/test';
import { seedDemoGym, startWorkoutAt } from './fixtures.mjs';

test.beforeEach(async ({ page }) => { await seedDemoGym(page); });
const layout = (page) => page.evaluate(async () => (await import('/js/store.js')).getLayout());

test('gym: tapping the Floor width label does not press minus', async ({ page }) => {
  await page.goto('/#gym');
  const before = (await layout(page)).grid.w;
  await page.locator('label[for="floor-w"]').click();
  await page.waitForTimeout(200);
  expect((await layout(page)).grid.w).toBe(before);
  await expect(page.locator('#floor-w')).toBeFocused();
});

test('gym: floor cannot shrink under its machines, hint shows', async ({ page }) => {
  await page.goto('/#gym');
  const L = await layout(page);
  const extent = Math.max(...L.machines.map((m) => m.x + m.w), ...L.shapes.map((s) => s.x + s.w));
  const down = page.locator('#floor-w').locator('xpath=..').locator('.step-down');
  for (let i = 0; i < 40; i++) await down.click();
  const w = (await layout(page)).grid.w;
  expect(w).toBeGreaterThanOrEqual(extent);
  await expect(page.locator('#floor-msg')).toBeVisible();
});

test('gym: template load needs two taps even after opening the browser twice', async ({ page }) => {
  await page.goto('/#gym');
  await page.locator('#load-template').click();
  await page.locator('#load-template').click();
  const first = page.locator('.tpl-load').first();
  await first.waitFor();
  const name = (await layout(page)).name;
  await first.click();
  await page.waitForTimeout(400);
  expect((await layout(page)).name).toBe(name);
  await expect(page.locator('.tpl-load').first()).toContainText('Tap again');
});

test('plan builder: typed text survives a day-chip and name-chip tap', async ({ page }) => {
  await page.goto('/#train');
  await page.locator('#hub-plans').click();
  await page.locator('#plan-new').click();
  const ta = page.locator('#plan-text');
  if (!(await ta.isVisible())) await page.locator('#view-chips .chip[data-view="text"]').click();
  await ta.fill('Leg press 3x10 80\nTreadmill 20min');
  await page.locator('#day-chips .chip').first().click();
  await expect(page.locator('#plan-text')).toHaveValue(/Leg press 3x10 80/);
  await expect(page.locator('#plan-text')).toHaveValue(/Treadmill/);
  const chip = page.locator('#name-chips .chip').first();
  if (await chip.count()) {
    await chip.click();
    await expect(page.locator('#plan-text')).toHaveValue(/Leg press 3x10 80/);
  }
});

test('plan builder: draft survives a tab switch', async ({ page }) => {
  await page.goto('/#train');
  await page.locator('#hub-plans').click();
  await page.locator('#plan-new').click();
  const ta = page.locator('#plan-text');
  if (!(await ta.isVisible())) await page.locator('#view-chips .chip[data-view="text"]').click();
  await ta.fill('Leg press 3x10 80');
  await page.locator('#plan-name').fill('Draft check');
  await page.evaluate(() => { location.hash = '#history'; });
  await page.waitForTimeout(200);
  await page.evaluate(() => { location.hash = '#train'; });
  await expect(page.locator('#plan-name')).toHaveValue('Draft check');
  await expect(page.locator('#plan-text')).toHaveValue(/Leg press 3x10 80/);
});

test('router: #toString and a malformed #pair do not blank the app', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/#toString');
  await expect(page.locator('#hub-start, #plan-new').first()).toBeVisible();
  await page.goto('/#pair=%E0');
  await page.waitForTimeout(300);
  expect(page.url()).toContain('#settings');
  expect(errors).toEqual([]);
});

const skipRest = async (page) => {
  const skip = page.locator('#rest-skip-big');
  if (await skip.isVisible()) await skip.click();
};

test('Muscles today: trained first, open rows folded, toggle stays put, state persists', async ({ page }) => {
  await startWorkoutAt(page, 1);
  await page.locator('#log-set').click();
  await skipRest(page);
  await page.locator('#log-back').click();
  const fold = page.locator('#muscle-fold');
  await expect(fold).toHaveText(/^Show \d+ untrained$/);
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  const cov = page.locator('#muscle-coverage');
  await expect(cov.locator('.muscle-row.open')).toHaveCount(0);
  await expect(cov.locator('.muscle-row').first()).not.toHaveClass(/open/);
  await expect(cov).not.toContainText('Tap an open muscle');
  const h = await fold.boundingBox();
  expect(h.height).toBeGreaterThanOrEqual(44);
  await fold.scrollIntoViewIfNeeded();
  const before = { y: (await fold.boundingBox()).y, scroll: await page.evaluate(() => scrollY) };
  await fold.click();
  await expect(page.locator('#muscle-fold')).toHaveText('Hide untrained');
  const after = { y: (await page.locator('#muscle-fold').boundingBox()).y, scroll: await page.evaluate(() => scrollY) };
  expect(after).toEqual(before);
  await expect(cov.locator('.muscle-row.open').first()).toBeVisible();
  await expect(cov).toContainText('Tap an open muscle');
  // a tap on an open row still drives the picker
  const mu = await cov.locator('.muscle-row.open').first().getAttribute('data-muscle');
  await cov.locator('.muscle-row.open').first().click();
  await expect(page.locator('.pick-muscle')).toHaveValue(mu);
  await page.reload();
  await expect(page.locator('#muscle-fold')).toHaveText('Hide untrained');
  const stamp = await page.evaluate(async () => (await import('/js/store.js')).getSettings());
  expect(stamp.muscleFold).toBe('shown');
});

test('plan builder: a new cardio line takes the last logged level', async ({ page }) => {
  await startWorkoutAt(page, 13);
  await expect(page.locator('#set-level')).toBeVisible();
  await page.locator('#set-level').fill('5');
  await page.locator('#set-level').blur();
  await page.locator('#log-set').click();
  await skipRest(page);
  const last = await page.evaluate(async () => {
    const a = (await import('/js/store.js')).getActive();
    return a.entries.find((e) => e.sets.length && e.sets.at(-1).level != null)?.sets.at(-1).level;
  });
  expect(last).toBe(5);
  await page.locator('#log-finish').click();
  await page.locator('#log-finish').click();
  await page.waitForTimeout(300);
  await page.goto('/#train');
  await page.locator('#hub-plans').click();
  await page.locator('#plan-new').click();
  const list = page.locator('#view-chips .chip[data-view="list"]');
  if (await list.count()) await list.click();
  await page.locator('#machine-chips .chip', { hasText: 'Rowing' }).first().click();
  await page.locator('#view-chips .chip[data-view="text"]').click();
  await expect(page.locator('#plan-text')).toHaveValue(/Rowing machine.*\bL5\b/);
});
