import { test, expect } from '@playwright/test';
import { seedDemoGym, startWorkoutAt } from './fixtures.mjs';

// TODO.md, "On a real iPhone": tapping the weight field pops the keyboard,
// which shrinks the VISUAL viewport only — the page itself, and everything
// scrolled within it, does not move. #log-set sits a few rows below the
// weight/reps/rest steppers, close enough to the bottom of the screen that
// the keyboard can cover it entirely even though nothing on the page changed.
//
// Headless Chromium never renders a real on-screen keyboard, so this cannot
// reproduce the bug by actually opening one. What it CAN do is what a real
// keyboard does to layout: shrink visualViewport and fire its resize event
// — that is the one signal initKeyboardScroll (js/ui.js) reacts to, and
// reproducing exactly that signal is enough to prove the fix moves the
// button back into the visible area rather than leaving it wherever it was.
const KEYBOARD_UP_HEIGHT = 340; // roughly what a real iOS keyboard leaves on a 727px-tall phone

test('the log button is reachable once the keyboard covers it', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);

  await page.locator('#set-weight').focus();
  const before = await page.locator('#log-set').boundingBox();
  expect(before, 'the button is visible before the keyboard appears').not.toBeNull();

  // Shrinking the viewport is the same signal a real keyboard sends
  // (visualViewport resizes; window does not) — see initKeyboardScroll.
  await page.setViewportSize({ width: 393, height: KEYBOARD_UP_HEIGHT });
  // The resize handler runs off visualViewport's own event, not ours —
  // give the browser a tick to dispatch and run it.
  await page.waitForTimeout(100);

  const after = await page.locator('#log-set').boundingBox();
  expect(after, 'the button still exists once the viewport shrinks').not.toBeNull();
  expect(after.y, 'the button top is within the shrunk visible area').toBeGreaterThanOrEqual(0);
  expect(after.y + after.height, 'the button bottom is within the shrunk visible area, not under the keyboard')
    .toBeLessThanOrEqual(KEYBOARD_UP_HEIGHT + 0.5);

  // And the field the user is still typing into was not knocked out of
  // view by the correction — "reachable without leaving the field" from
  // the TODO entry means the field survives too, not just the button.
  const field = await page.locator('#set-weight').boundingBox();
  expect(field.y, 'the focused field also stays within the shrunk visible area').toBeGreaterThanOrEqual(0);
  expect(field.y, 'the focused field is not pushed below the shrunk visible area')
    .toBeLessThanOrEqual(KEYBOARD_UP_HEIGHT);
});
