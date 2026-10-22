// The first start, end to end: the tour on a device's first boot (once),
// every step of it at 320px, the unit it asks for, its repeat from
// Settings → Help, the first-run screen's other ways in, and the empty gym
// floor that explains itself. test/tour.test.mjs holds the logic half.
import { test, expect } from '@playwright/test';
import { seedDemoGym, findOverflow, measure } from './fixtures.mjs';

const NARROW = { width: 320, height: 640 };
const settings = (page) => page.evaluate(async () => (await import('/js/store.js')).getSettings());
const spots = (page) => page.locator('#tabbar a.tour-spot')
  .evaluateAll((els) => els.map((a) => a.dataset.tab));

const holdsTheRules = async (page, what) => {
  expect(await page.evaluate(findOverflow), `${what} overflows at 320px`).toBeNull();
  const { small, tiny } = await page.evaluate(measure);
  expect(small, `undersized touch targets in ${what}`).toEqual([]);
  expect(tiny, `fields iOS would zoom into in ${what}`).toEqual([]);
};

test('a first start opens the tour once, and Skip lands on the welcome screen', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/#tour$/);
  await expect(page.locator('#tour-title')).toHaveText('Welcome to gymii');
  await page.locator('#tour-skip').click();
  await expect(page).toHaveURL(/#train$/);
  await expect(page.locator('#ob-read')).toBeVisible();
  await page.reload();
  await expect(page.locator('#ob-read')).toBeVisible();
  await expect(page).toHaveURL(/#train$/, { timeout: 1000 });
});

test('every tour step and the welcome screen hold the layout rules; the unit sticks', async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.goto('/');
  await page.locator('#tour-units .chip[data-unit="lbs"]').click();
  await expect(page.locator('#tour-units .chip[data-unit="lbs"]')).toHaveAttribute('aria-pressed', 'true');
  const expected = [[], ['train'], ['train'], ['train'], ['history', 'ai'], ['settings']];
  for (let i = 0; i < expected.length; i++) {
    await expect(page.locator('.tour-head .muted')).toHaveText(`Step ${i + 1} of 6`);
    expect(await spots(page), `step ${i + 1} marks its tabs`).toEqual(expected[i]);
    await holdsTheRules(page, `tour step ${i + 1}`);
    await page.locator('#tour-next').click();
  }
  await expect(page.locator('#ob-read')).toBeVisible();
  expect(await spots(page), 'no mark outlives the tour').toEqual([]);
  await holdsTheRules(page, 'the welcome screen');
  const s = await settings(page);
  expect(s.unit).toBe('lbs');
  expect(s.weightStep, 'a fresh lbs install steps by 5').toBe(5);
  expect(s.tourSeen).toBe(true);
});

test('Settings → Help repeats the tour; data on the device never auto-opens it', async ({ page }) => {
  await seedDemoGym(page);
  await expect(page.locator('#hub-start')).toBeVisible();
  await page.goto('/#settings');
  await page.locator('#tour-again').click();
  await expect(page).toHaveURL(/#tour$/);
  await expect(page.locator('.tour-head .muted')).toHaveText('Step 1 of 6');
  await expect(page.locator('#tour-units'), 'a device with data is asked no unit').toHaveCount(0);
  await page.locator('#tour-next').click();
  await page.locator('#tour-back').click();
  await expect(page.locator('.tour-head .muted')).toHaveText('Step 1 of 6');
  // leaving by a tab tap takes the marks along
  await page.locator('#tour-next').click();
  expect(await spots(page)).toEqual(['train']);
  await page.locator('#tabbar a[data-tab="history"]').click();
  await expect(page.locator('#view h1')).toHaveText('History');
  expect(await spots(page)).toEqual([]);
  // the whole way through ends on Train
  await page.goto('/#settings');
  await page.locator('#tour-again').click();
  for (let i = 0; i < 6; i++) await page.locator('#tour-next').click();
  await expect(page.locator('#hub-start')).toBeVisible();
});

test('the welcome screen loads the demo gym into the hub', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tour-skip').click();
  await page.locator('#ob-demo').click();
  await expect(page.locator('#hub-start')).toBeVisible();
  await expect(page.locator('#view .notice')).toContainText('Demo gym');
});

test('an empty gym floor explains itself until the first item, without moving the toolbar', async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.goto('/');
  await page.locator('#tour-skip').click();
  await page.locator('#view a[href="#gym"]').click();
  await expect(page.locator('#floor-empty')).toBeVisible();
  await holdsTheRules(page, 'the empty gym');
  // the hint and its button fit inside the floor, which clips
  const fits = await page.evaluate(() => {
    const wrap = document.querySelector('.floor-wrap').getBoundingClientRect();
    const btn = document.getElementById('floor-empty-tpl').getBoundingClientRect();
    return btn.top >= wrap.top && btn.bottom <= wrap.bottom;
  });
  expect(fits, 'the template button is not clipped by the floor').toBe(true);
  await page.locator('#floor-empty-tpl').click();
  await expect(page.locator('#template-browser .tpl-load, #template-browser p').first()).toBeVisible();

  const y = async () => (await page.locator('#add-machine').boundingBox()).y;
  await page.evaluate(() => document.getElementById('view').scrollTo(0, 0));
  const before = await y();
  await page.locator('#add-machine').click();
  await expect(page.locator('#floor-empty')).toBeHidden();
  expect(await y(), '+ Machine stays under the thumb').toBe(before);
  await page.locator('#undo').click();
  await expect(page.locator('#floor-empty'), 'an undo back to nothing brings it back').toBeVisible();
});
