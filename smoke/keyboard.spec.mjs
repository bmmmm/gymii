import { test, expect } from '@playwright/test';
import { seedDemoGym, startWorkoutAt } from './fixtures.mjs';

// TODO.md, "On a real iPhone": tapping a field pops the keyboard, which
// shrinks the VISUAL viewport only — the LAYOUT viewport (innerHeight, and
// everything getBoundingClientRect measures against) never moves. The
// contract (initFocusCentering, js/ui.js): once the keyboard has settled,
// the focused field sits in the middle of what is still visible, together
// with its context when that fits — on the log screen the whole form,
// steppers AND the log button.
//
// Headless Chromium never renders a real on-screen keyboard, and —
// crucially — `page.setViewportSize` is NOT a stand-in for one: that
// resizes the LAYOUT viewport too, which no phone does. What a keyboard
// actually changes is `visualViewport.height`/`offsetTop` alone, so this
// stubs exactly those two accessors on the real (unchanged) page and
// dispatches visualViewport's own resize event.
const openKeyboard = (page, height) => page.evaluate((h) => {
  const vv = window.visualViewport;
  Object.defineProperty(vv, 'height', { get: () => h, configurable: true });
  Object.defineProperty(vv, 'offsetTop', { get: () => 0, configurable: true });
  vv.dispatchEvent(new Event('resize'));
}, height);

const KEYBOARD_UP_HEIGHT = 340; // roughly what a real iOS keyboard leaves on a 727px-tall phone
const MIDDLE = KEYBOARD_UP_HEIGHT / 2;

const rectOf = (page, selector) => page.evaluate((sel) => {
  const r = document.querySelector(sel).getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, centre: (r.top + r.bottom) / 2 };
}, selector);

// Poll, not sleep: the hop case settles on a 300 ms timer, not an event.
const expectCentred = (page, selector, what) => expect.poll(
  async () => Math.round(Math.abs((await rectOf(page, selector)).centre - MIDDLE)),
  { message: `${what} should sit in the middle of the visible band` },
).toBeLessThanOrEqual(2);

test('the log form lands centred above the keyboard, field and button together', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);
  const btnBefore = await rectOf(page, '#log-set');
  expect(btnBefore.bottom, 'this fixture only proves something if the keyboard would cover the button')
    .toBeGreaterThan(KEYBOARD_UP_HEIGHT);

  await page.locator('#set-weight').focus();
  await openKeyboard(page, KEYBOARD_UP_HEIGHT);

  await expectCentred(page, '.next-set', 'the log form (data-focus-context)');
  const form = await rectOf(page, '.next-set');
  expect(form.top, 'the whole form is visible').toBeGreaterThanOrEqual(0);
  expect(form.bottom).toBeLessThanOrEqual(KEYBOARD_UP_HEIGHT);
  expect(await page.evaluate(() => window.scrollY), 'the document itself never scrolls').toBe(0);

});

// The locker field sits ABOVE the log form on a fresh workout. The old,
// button-anchored scroll had to exclude it (it would have dragged the
// field off-screen); field-anchored centring needs no exclusion: the field
// being typed into is what lands in the middle.
test('the locker field lands centred above the keyboard', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);
  const locker = page.locator('#locker-num');
  await expect(locker, 'lockerAsk is true on a fresh, unlogged workout').toBeVisible();

  await locker.focus();
  await openKeyboard(page, KEYBOARD_UP_HEIGHT);
  await expectCentred(page, '#locker-num', 'the locker field');

  // A hop to another field with the keyboard already up fires no
  // visualViewport resize — the focusin timer is what settles it, and the
  // log form (a different context) must move into the middle.
  await page.locator('#set-weight').focus();
  await expectCentred(page, '.next-set', 'the log form after a field-to-field hop');
});

// A field at the very end of a long screen: without extra room (--kb
// padding on #view) the scroller simply cannot lift it above the keyboard,
// which is when iOS pans the window instead and the page "jumps".
test('the last field on a long screen still reaches the middle', async ({ page }) => {
  await seedDemoGym(page);
  await page.goto('/#settings');
  const field = page.locator('#gym-new-name');
  await field.evaluate((el) => {
    const view = document.getElementById('view');
    view.scrollTop = view.scrollHeight; // parked at the bottom, behind any keyboard
  });
  await field.focus();
  await openKeyboard(page, KEYBOARD_UP_HEIGHT);
  // Its .card is centred when it fits the band (font metrics differ between
  // machines, so the fixture cannot know which), else the field itself.
  await expect.poll(() => field.evaluate((el, band) => {
    const card = el.closest('.card')?.getBoundingClientRect();
    const r = card && card.height <= band ? card : el.getBoundingClientRect();
    return Math.round(Math.abs((r.top + r.bottom) / 2 - band / 2));
  }, KEYBOARD_UP_HEIGHT), { message: 'the new-gym field (or its card) should sit in the middle' })
    .toBeLessThanOrEqual(2);
  const r = await rectOf(page, '#gym-new-name');
  expect(r.top, 'the field itself is in sight').toBeGreaterThanOrEqual(0);
  expect(r.bottom).toBeLessThanOrEqual(KEYBOARD_UP_HEIGHT);
});
