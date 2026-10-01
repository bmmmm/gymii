import { test, expect } from '@playwright/test';
import {
  seedDemoGym, startWorkoutAt, ROUTES, findOverflow, measure,
} from './fixtures.mjs';

const NARROW = { width: 320, height: 640 }; // the smallest phone still in use

// Scenario 4.
test('no route scrolls sideways at 320px', async ({ page }) => {
  await page.setViewportSize(NARROW);
  await seedDemoGym(page);
  for (const route of ROUTES) {
    await page.goto(`/#${route}`);
    await expect(page.locator('#view h1, #view .tile')).not.toHaveCount(0);
    expect(await page.evaluate(findOverflow), `route #${route} overflows`).toBeNull();
  }
});

// Scenario 5. Exactly this regression — 48×43 on undo/redo, 65×43 on
// "+ Set" — was found by hand last round. The value of the test is that a
// third exception has to be entered in measure() (fixtures.mjs) DELIBERATELY.
test('every touch target is 44px and every field 16px', async ({ page }) => {
  await page.setViewportSize(NARROW);
  await seedDemoGym(page);
  for (const route of ROUTES) {
    await page.goto(`/#${route}`);
    await expect(page.locator('#view h1, #view .tile')).not.toHaveCount(0);
    const { small, tiny } = await page.evaluate(measure);
    expect(small, `undersized touch targets on #${route}`).toEqual([]);
    expect(tiny, `fields iOS would zoom into on #${route}`).toEqual([]);
  }
});

// The logging screen is where the thumb spends the workout, and it is not
// a route — only a started workout gets you there.
test('the logging screen holds the same rules', async ({ page }) => {
  await page.setViewportSize(NARROW);
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);
  expect(await page.evaluate(findOverflow), 'the log screen overflows').toBeNull();
  const { small, tiny } = await page.evaluate(measure);
  expect(small, 'undersized touch targets on the log screen').toEqual([]);
  expect(tiny, 'fields iOS would zoom into on the log screen').toEqual([]);
});
