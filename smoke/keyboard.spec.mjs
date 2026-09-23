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

// preserveFocus hands a field back after a re-render (same id, new node),
// and a chip tap on iOS never blurs it — the user may have scrolled to that
// chip. Re-centring then would pull the chip from under the thumb, so a
// field that merely came back must leave the scroll alone.
test('a field re-focused after a re-render does not re-centre', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);
  await page.locator('#locker-num').focus();
  await openKeyboard(page, KEYBOARD_UP_HEIGHT);
  await expectCentred(page, '#locker-num', 'the locker field');

  const scrolled = await page.evaluate(() => {
    const view = document.getElementById('view');
    view.scrollTop += 120; // the user scrolls down toward something else
    const el = document.getElementById('locker-num');
    const twin = el.cloneNode(true); // what a re-render leaves behind
    el.replaceWith(twin);
    twin.focus();
    return view.scrollTop;
  });
  await page.waitForTimeout(500); // past the 300 ms hop settle
  expect(await page.evaluate(() => document.getElementById('view').scrollTop),
    'the user\'s own scroll survives the hand-back').toBe(scrolled);
});

// Pinch-zoom shrinks visualViewport.height exactly like a keyboard does;
// only the scale tells them apart. And a keyboard going down must take its
// --kb padding with it.
test('a pinch-zoom is not a keyboard, and closing the keyboard drops --kb', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);
  await page.locator('#set-weight').focus();
  const kb = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--kb').trim());

  await openKeyboard(page, KEYBOARD_UP_HEIGHT);
  expect(await kb(), 'the keyboard pads #view').not.toBe('0px');

  const innerHeight = await page.evaluate(() => innerHeight);
  await openKeyboard(page, innerHeight); // keyboard down
  expect(await kb(), 'and the padding goes with it').toBe('0px');

  const before = await page.evaluate(() => document.getElementById('view').scrollTop);
  await page.evaluate((h) => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'scale', { get: () => 2, configurable: true });
    Object.defineProperty(vv, 'height', { get: () => h / 2, configurable: true });
    vv.dispatchEvent(new Event('resize'));
  }, innerHeight);
  expect(await kb(), 'a zoomed viewport is no keyboard').toBe('0px');
  expect(await page.evaluate(() => document.getElementById('view').scrollTop), 'and nothing scrolls')
    .toBe(before);
});

// A keyboard that vanished while the app was in the background may never
// deliver its resize; coming back must still drop the padding.
test('returning to the app drops a stale --kb', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);
  await page.locator('#set-weight').focus();
  await openKeyboard(page, KEYBOARD_UP_HEIGHT);
  const kb = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--kb').trim());
  expect(await kb()).not.toBe('0px');
  await page.evaluate(() => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { get: () => innerHeight, configurable: true }); // no resize event
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await kb(), 'the visibility settle noticed the keyboard is gone').toBe('0px');
});

// A field taller than the visible band keeps whatever iOS did to show its
// caret: centring its middle would put the caret behind the keyboard.
test('a field taller than the visible band is left alone', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);
  const before = await page.evaluate(() => {
    const ta = document.createElement('textarea');
    ta.id = 'tall-probe';
    ta.style.cssText = 'display:block;height:400px;width:100%';
    document.getElementById('view').append(ta);
    ta.scrollIntoView({ block: 'end' });
    ta.focus();
    return document.getElementById('view').scrollTop;
  });
  await openKeyboard(page, KEYBOARD_UP_HEIGHT);
  await page.waitForTimeout(400); // past the focusin settle as well
  expect(await page.evaluate(() => document.getElementById('view').scrollTop), 'no centring scroll')
    .toBe(before);
});
