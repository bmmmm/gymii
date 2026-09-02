import { test, expect } from '@playwright/test';
import { seedDemoGym, startWorkoutAt } from './fixtures.mjs';

// Scenario 2. Five real click handlers across three render* functions, real
// event bubbling, real localStorage, the real hash router. The Node stub
// DOM "hands back EVERY selector, rendered or not", so a logic test there
// can hit a handler a re-render replaced long ago; here it cannot.
test('a logged set survives a reload', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);

  const label = await page.locator('#log-set').textContent();
  const weight = await page.locator('#set-weight').inputValue();
  await page.locator('#log-set').click();

  // the set reached storage, through the app's own writer
  const sets = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith('.active'));
    return JSON.parse(localStorage.getItem(key)).entries.flatMap((e) => e.sets);
  });
  expect(sets).toHaveLength(1);
  expect(String(sets[0].weight)).toBe(weight);
  expect(label).toContain(weight);

  // and it is still there after a cold boot — the crash-safety promise
  await page.reload();
  await expect(page.locator('#log-set')).toBeVisible();
  const afterReload = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith('.active'));
    return JSON.parse(localStorage.getItem(key)).entries.flatMap((e) => e.sets).length;
  });
  expect(afterReload).toBe(1);
});

// Scenario 3. The core of the last round, and structurally invisible to the
// Node suite: runRest() returns immediately when there is no `document`, so
// headless only ever sees the bare `restUntil` fact.
test('the rest keeps running after the overlay is closed', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);
  await page.locator('#log-set').click();

  const overlay = page.locator('.overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('#cd')).not.toBeEmpty();

  // tapping the backdrop closes the SCREEN, not the timer
  await overlay.click({ position: { x: 5, y: 5 } });
  await expect(overlay).toHaveCount(0);
  const inline = page.locator('#rest-cd');
  await expect(inline).toBeVisible();

  // The one deliberate wait in the suite: the app's own display is measured
  // against itself over real time, so a stopped timer is the only way to
  // fail it.
  const before = await inline.textContent();
  await page.waitForTimeout(2500);
  const after = await inline.textContent();
  expect(toSeconds(after), `the countdown moved on from ${before}`)
    .toBeLessThan(toSeconds(before));

  // a reload mid-rest must pick the deadline back up (ensureRestTicking):
  // the countdown comes back where it was — never restarted, never gone —
  // and keeps moving
  await page.reload();
  const resumed = page.locator('#rest-cd');
  await expect(resumed).toBeVisible();
  const afterReload = toSeconds(await resumed.textContent());
  expect(afterReload, 'the rest resumed rather than restarting')
    .toBeLessThanOrEqual(toSeconds(after));
  await page.waitForTimeout(2500);
  expect(toSeconds(await resumed.textContent()), 'and is still ticking after the reload')
    .toBeLessThan(afterReload);
});

const toSeconds = (text) => {
  const parts = text.trim().split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
};
