import { test, expect } from '@playwright/test';
import { seedDemoGym, findOverflow, measure } from './fixtures.mjs';

// The Gym's folded parts: the machine list editor and the machine card's
// brand fold-out. Neither is open on a plain route visit, so layout.spec's
// sweep never measures them — these did, once, by an ad-hoc script only.
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await seedDemoGym(page);
});

const holdsTheRules = async (page, what) => {
  expect(await page.evaluate(findOverflow), `${what} overflows at 320px`).toBeNull();
  const { small, tiny } = await page.evaluate(measure);
  expect(small, `undersized touch targets in ${what}`).toEqual([]);
  expect(tiny, `fields iOS would zoom into in ${what}`).toEqual([]);
};

test('the machine list editor holds 44px targets, 16px fields, no sideways scroll', async ({ page }) => {
  await page.goto('/#gym');
  await page.locator('#edit-machines').click();
  await expect(page.locator('#machine-list .mrow')).not.toHaveCount(0);
  await expect(page.locator('#machine-list .mrow-model').first()).toBeVisible();
  // a row's own "Other…" brand field and its Set button count too
  await page.locator('#machine-list .mrow').first().locator('select[data-field="brand"]').selectOption('__other');
  await expect(page.locator('#machine-list .mrow-other').first()).toBeVisible();
  await holdsTheRules(page, 'the list editor');
});

test('the machine card\'s brand fold-out holds the same rules', async ({ page }) => {
  await page.goto('/#history');
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    const gym = await import('/js/gym.js');
    gym.focusMachine(store.getLayout().machines[0].id);
  });
  await page.evaluate(() => { location.hash = '#gym'; }); // #gym is not in the tab bar
  await page.locator('#m-brand-other').click();
  await expect(page.locator('#m-brand-search')).toBeVisible();
  await expect(page.locator('#m-brands .chip')).not.toHaveCount(0);
  await holdsTheRules(page, 'the brand fold-out');
});
