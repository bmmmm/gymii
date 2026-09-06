import { test, expect } from '@playwright/test';
import { seedDemoGym, startWorkoutAt } from './fixtures.mjs';

// TODO.md, "On a real iPhone": tapping the weight field pops the keyboard,
// which shrinks the VISUAL viewport only — the LAYOUT viewport (innerHeight,
// and everything getBoundingClientRect measures against) never moves.
// #log-set sits a few rows below the weight/reps/rest steppers, close
// enough to the bottom of the screen for the keyboard to cover it entirely.
//
// Headless Chromium never renders a real on-screen keyboard, and —
// crucially — `page.setViewportSize` is NOT a stand-in for one: that
// resizes the LAYOUT viewport too, which no phone does, and made an
// earlier, `scrollIntoView`-based version of this fix look correct only
// because the test shrank a viewport nothing on a real device shrinks.
// What a keyboard actually changes is `visualViewport.height`/`offsetTop`
// alone, so this stubs exactly those two accessors on the real (unchanged)
// page and dispatches visualViewport's own resize event — the one signal
// initKeyboardScroll (js/ui.js) reacts to.
const openKeyboard = (page, height) => page.evaluate((h) => {
  const vv = window.visualViewport;
  Object.defineProperty(vv, 'height', { get: () => h, configurable: true });
  Object.defineProperty(vv, 'offsetTop', { get: () => 0, configurable: true });
  vv.dispatchEvent(new Event('resize'));
}, height);

const KEYBOARD_UP_HEIGHT = 340; // roughly what a real iOS keyboard leaves on a 727px-tall phone

test('the log button is reachable once the keyboard covers it', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);
  await page.locator('#set-weight').focus();

  // A fresh, first-machine workout has almost nothing below .next-set (no
  // quick-switch yet) — #view's OWN scrollable range can be shorter than
  // the keyboard's overlap, so "fully visible" is not always achievable no
  // matter what scrolls it. Compute the fix's actual contract from the
  // page's real metrics instead of assuming there is always room: scroll
  // exactly enough to clear the keyboard, or to #view's own limit — the
  // TODO entry's "reachable without leaving the field" is this floor.
  const before = await page.evaluate(() => {
    const view = document.getElementById('view');
    return {
      scrollTop: view.scrollTop,
      maxScroll: view.scrollHeight - view.clientHeight,
      btnBottom: document.getElementById('log-set').getBoundingClientRect().bottom,
    };
  });
  const covered = Math.max(before.btnBottom - KEYBOARD_UP_HEIGHT, 0);
  const expectedScrollTop = Math.min(before.scrollTop + covered, before.maxScroll);
  expect(covered, 'this fixture only proves something if the keyboard actually covers the button').toBeGreaterThan(0);

  await openKeyboard(page, KEYBOARD_UP_HEIGHT);

  // The correction is a plain, synchronous scroll, not an animation — but a
  // poll survives a slow CI runner without a fixed sleep either way.
  await expect.poll(() => page.evaluate(() => document.getElementById('view').scrollTop),
    { message: `expected #view to settle at scrollTop ${expectedScrollTop} `
      + '(clear the keyboard, or as far as the page\'s own content allows)' })
    .toBeGreaterThanOrEqual(Math.round(expectedScrollTop) - 1);
  const finalScrollTop = await page.evaluate(() => document.getElementById('view').scrollTop);
  expect(finalScrollTop, 'and not scrolled past what the keyboard actually requires')
    .toBeLessThanOrEqual(expectedScrollTop + 1);

  // And the field the user is still typing into was not knocked out of
  // view by the correction — "reachable without leaving the field" from
  // the TODO entry means the field survives too, not just the button.
  const field = await page.locator('#set-weight').boundingBox();
  expect(field.y, 'the focused field stays within the shrunk visible area').toBeGreaterThanOrEqual(0);
  expect(field.y).toBeLessThanOrEqual(KEYBOARD_UP_HEIGHT);
});

// The log screen also carries the locker-number field (shown before the
// first set of a workout is logged) and, for a machine with any, its
// settings fields — both plain text inputs sharing the screen with
// #log-set but outside .next-set. Focusing one must not scroll the log
// form at all: initKeyboardScroll is scoped to .next-set precisely so it
// does not drag the field the user is actually typing into off-screen.
//
// This uses a real `setViewportSize`, not the `openKeyboard` stub above —
// deliberately, since a real resize is what actually moved the field in
// the original repro (top 574→232, →-95 at 400px): it is the one signal
// that also exercises the OLD, unscoped scrollIntoView mechanism, so this
// test tells the guard apart from the scroll math, which the stub cannot.
test('the locker field does not trigger the log-form keyboard scroll', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);

  const locker = page.locator('#locker-num');
  await expect(locker, 'lockerAsk is true on a fresh, unlogged workout').toBeVisible();
  const lockerTopBefore = (await locker.boundingBox()).y;

  const view = page.locator('#view');
  const scrollBefore = await view.evaluate((el) => el.scrollTop);

  await locker.focus();
  await page.setViewportSize({ width: 393, height: 400 });
  // Wait for the resize to actually reach visualViewport — only then has
  // any resize handler had its chance to run.
  await expect.poll(() => page.evaluate(() => window.visualViewport.height))
    .toBeLessThanOrEqual(400);

  const scrollAfter = await view.evaluate((el) => el.scrollTop);
  expect(scrollAfter, 'the log form never scrolled — the locker field is outside .next-set')
    .toBe(scrollBefore);
  const lockerTopAfter = (await locker.boundingBox()).y;
  expect(lockerTopAfter, 'and the field being typed into was not dragged off-screen')
    .toBe(lockerTopBefore);
});
