import { test, expect } from '@playwright/test';
import { seedDemoGym, findOverflow, measure } from './fixtures.mjs';

// History on the demo gym: twelve weeks of bars, machine chips, a stamped
// last month (so there are routes), at the smallest phone width in use.
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await seedDemoGym(page);
  await page.goto('/#history');
  await page.locator('#week-chart svg').waitFor();
});

test('a machine chip redraws the progress chart for that machine', async ({ page }) => {
  const chip = page.locator('#machine-chips .chip').nth(1);
  const name = (await chip.textContent()).trim();
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('#chart svg').getAttribute('aria-label')).toContain(name);
});

test('a bar picks its week: title, tiles and list follow', async ({ page }) => {
  await page.locator('#week-chart .c-bar').nth(8).click();
  await expect(page.locator('#week-title')).toHaveText(/^Week of /);
  const n = Number(await page.locator('#week-tiles [data-metric="workouts"] .tile-value').textContent());
  expect(n, 'the demo trains in that week — an empty one would prove nothing').toBeGreaterThan(0);
  await expect(page.locator('#week-list details.workout')).toHaveCount(n);
});

test('the Workouts screen holds 44px targets, 16px fields, no sideways scroll', async ({ page }) => {
  await page.locator('#open-workouts').click();
  await expect(page.locator('#view h1')).toHaveText('Workouts');
  expect(await page.evaluate(findOverflow), 'the Workouts screen overflows').toBeNull();
  const { small, tiny } = await page.evaluate(measure);
  expect(small, 'undersized touch targets on the Workouts screen').toEqual([]);
  expect(tiny, 'fields iOS would zoom into on the Workouts screen').toEqual([]);
});

test('the walking-paths card draws the latest route', async ({ page }) => {
  await expect(page.locator('#path-chips .chip.sel')).toHaveText(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);
  await expect(page.locator('#path-map .path-leg')).not.toHaveCount(0);
});
