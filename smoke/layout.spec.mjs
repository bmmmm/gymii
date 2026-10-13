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

// True black (Settings → Display): the chip flips html[data-theme], the
// choice survives a reload (device-local setting, applied before the first
// render), and every route keeps the same layout rules in it.
test('True black switches the theme and every route still holds the rules', async ({ page }) => {
  await page.setViewportSize(NARROW);
  await seedDemoGym(page);
  await page.goto('/#settings');
  await page.locator('#theme-chips .chip[data-theme="black"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(0, 0, 0)');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#000000');
  for (const route of ROUTES) {
    await page.goto(`/#${route}`);
    await expect(page.locator('#view h1, #view .tile')).not.toHaveCount(0);
    expect(await page.evaluate(findOverflow), `route #${route} overflows in True black`).toBeNull();
    const { small, tiny } = await page.evaluate(measure);
    expect(small, `undersized touch targets on #${route} in True black`).toEqual([]);
    expect(tiny, `fields iOS would zoom into on #${route} in True black`).toEqual([]);
  }
  await page.goto('/#settings');
  await page.locator('#theme-chips .chip[data-theme="dark"]').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'black');
});

// First paint: js/theme-boot.js (a classic script in <head>) stamps the theme
// BEFORE the deferred app.js module exists. Proof by subtraction — app.js is
// aborted, so nothing but the boot script can have set the attribute.
test('True black is on <html> without app.js, the default theme stays untouched', async ({ page }) => {
  await page.route('**/js/app.js', (route) => route.abort());
  const seed = (theme) => page.addInitScript((t) => {
    try { localStorage.setItem('gymii.settings', JSON.stringify({ theme: t })); } catch { /* about:blank */ }
  }, theme);
  await seed('black');
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#000000');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(0, 0, 0)');

  // a stored default theme is a no-op (this init script runs after the first
  // and overwrites it before the page's own scripts)
  await seed('dark');
  await page.goto('/?default');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0f1216');
});

// 🎲 in the machine picker: a 44px chip that fills the number and says
// why — and starts nothing (the start stays the action button's job).
test('the picker\'s 🎲 suggests a machine and starts nothing', async ({ page }) => {
  await page.setViewportSize(NARROW);
  await seedDemoGym(page);
  await page.locator('#hub-start').click();
  await page.locator('.pick-surprise').click();
  await expect(page.locator('.pick-num')).toHaveValue(/^\d+$/);
  await expect(page.locator('.pick-err')).toHaveText(/^🎲 #\d+ /);
  expect(await page.evaluate(() => Object.keys(localStorage).some((k) => k.endsWith('.active')
    && localStorage.getItem(k) !== 'null')), 'no workout was started').toBe(false);
  expect(await page.evaluate(findOverflow), 'the start screen overflows').toBeNull();
  const { small, tiny } = await page.evaluate(measure);
  expect(small, 'undersized touch targets on the start screen').toEqual([]);
  expect(tiny, 'fields iOS would zoom into on the start screen').toEqual([]);
});

// An assisted machine (the demo's #17): the log screen speaks assist, its
// Goal chips are 44px and a tap says the goal on the machine.
test('the assisted log screen holds the rules and its goal chips work', async ({ page }) => {
  await page.setViewportSize(NARROW);
  await seedDemoGym(page);
  await startWorkoutAt(page, 17);
  await expect(page.locator('.next-set .label').first()).toHaveText('Assist');
  await expect(page.locator('#assist-goal .chip.sel')).toHaveText('Less assist');
  expect(await page.evaluate(findOverflow), 'the assisted log screen overflows').toBeNull();
  const { small, tiny } = await page.evaluate(measure);
  expect(small, 'undersized touch targets on the assisted log screen').toEqual([]);
  expect(tiny, 'fields iOS would zoom into on the assisted log screen').toEqual([]);
  await page.locator('#assist-goal .chip[data-goal="endurance"]').click();
  await expect(page.locator('#assist-goal .chip.sel')).toHaveText('More reps');
  expect(await page.evaluate(async () => {
    const store = await import('/js/store.js');
    return store.getLayout().machines.find((m) => m.num === 17).assistGoal;
  })).toBe('endurance');
});
