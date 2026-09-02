import { test, expect } from '@playwright/test';
import { seedDemoGym, startWorkoutAt, ROUTES } from './fixtures.mjs';

const NARROW = { width: 320, height: 640 }; // the smallest phone still in use

// Reports the first node that sticks out, with enough of itself to be
// findable — "the page scrolls sideways" alone is an unusable failure.
const findOverflow = () => {
  const limit = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth <= limit) return null;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > limit + 0.5) {
      return `<${el.tagName.toLowerCase()} class="${el.className}"> `
        + `right=${Math.round(r.right)} > ${limit} :: ${(el.textContent || '').trim().slice(0, 40)}`;
    }
  }
  return `scrollWidth ${document.documentElement.scrollWidth} > ${limit}, no single node blamed`;
};

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
// third exception has to be entered here DELIBERATELY.
const measure = () => {
  // Both documented in the stylesheet: seven columns of a week do not fit
  // 44px at 320px (34px still clears WCAG's 24px essential-layout
  // exception), and .linkish is a button that reads as a word in a
  // sentence.
  const ALLOWED = ['hm-cell', 'linkish'];
  const small = [];
  const tiny = [];
  const controls = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button]';
  for (const el of document.querySelectorAll(controls)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue; // not rendered
    const name = `<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ''} `
      + `class="${el.className}"> ${Math.round(r.width)}x${Math.round(r.height)}`
      + ` :: ${(el.textContent || el.value || '').trim().slice(0, 30)}`;
    if (!ALLOWED.some((c) => el.classList.contains(c)) && (r.width < 44 || r.height < 44)) {
      small.push(name);
    }
    // iOS zooms the page when a field under 16px takes focus
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
      && parseFloat(getComputedStyle(el).fontSize) < 16) {
      tiny.push(name);
    }
  }
  return { small, tiny };
};

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
