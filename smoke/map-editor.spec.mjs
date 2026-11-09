import { test, expect } from '@playwright/test';
import { seedDemoGym, findOverflow, measure } from './fixtures.mjs';

// The floor plan editor on the smallest phone: a 3×2 machine is ~13×9 px
// there, smaller than the thumb that would have to land on it. The Gym
// opens on its page, the plan is a mode behind "Edit floor plan", and an
// unlocked item moves by the item bar's arrows or by a drag that starts
// ANYWHERE on the plan. Driven by real pointer events, asserted on storage.
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await seedDemoGym(page);
});

const machine = (page, num) => page.evaluate(async (n) => {
  const { getLayout } = await import('/js/store.js');
  const m = getLayout().machines.find((x) => x.num === n);
  return { id: m.id, x: m.x, y: m.y, w: m.w, h: m.h };
}, num);

const holdsTheRules = async (page, what) => {
  expect(await page.evaluate(findOverflow), `${what} overflows at 320px`).toBeNull();
  const { small, tiny } = await page.evaluate(measure);
  expect(small, `undersized touch targets in ${what}`).toEqual([]);
  expect(tiny, `fields iOS would zoom into in ${what}`).toEqual([]);
};

test('the Gym opens on its page; the plan is a card, the editor a mode without the tabbar', async ({ page }) => {
  await page.goto('/#gym');
  await expect(page.locator('#floor')).toBeHidden();
  await expect(page.locator('#floor-preview')).toBeVisible();
  await expect(page.locator('#machines-add')).toBeVisible();
  await holdsTheRules(page, 'the Gym page');

  // a tap on a machine in the preview opens its card on the page
  const m9 = await machine(page, 9);
  await page.locator(`#floor-preview [data-id="${m9.id}"]`).click();
  await expect(page.locator('#m-num')).toHaveValue('9');
  await expect(page.locator('#props-back')).toBeVisible();
  await page.locator('#props-map').click();
  await expect(page.locator('#tabbar')).toBeHidden();
  await expect(page.locator('#floor')).toBeVisible();
  await expect(page.locator('#item-bar .item-name')).toHaveText(/^#9/);

  await page.locator('#map-done').click();
  await expect(page.locator('#tabbar')).toBeVisible();
  await expect(page.locator('#floor-preview')).toBeVisible();

  // leaving the Gym from the editor never strands the app without its tabbar
  await page.locator('#map-open').click();
  await expect(page.locator('#tabbar')).toBeHidden();
  await page.evaluate(() => { location.hash = '#history'; });
  await expect(page.locator('#tabbar')).toBeVisible();
});

test('Move, the arrows and a drag from anywhere move a small machine', async ({ page }) => {
  await page.goto('/#gym');
  await page.locator('#map-open').click();
  const before = await machine(page, 9);
  // the find row selects it — no need to hit a 13 px box
  await page.locator('#find-num').fill('9');
  await page.locator('#find-go').click();
  await expect(page.locator('#item-move')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#item-move').click();
  await expect(page.locator('#item-move')).toHaveAttribute('aria-pressed', 'true');
  await holdsTheRules(page, 'the item bar');

  await page.locator('.dp-down').click();
  expect((await machine(page, 9)).y, 'one tap, one grid unit').toBe(before.y + 1);
  await page.locator('.dp-up').click();
  expect((await machine(page, 9)).y).toBe(before.y);

  // a drag that starts on empty floor below the machines moves #9 by the
  // finger's distance, through real PointerEvents
  const svg = await page.locator('#floor').boundingBox();
  const ppu = svg.width / (60 + 5); // demo grid 60 wide, editor pad 2.5 a side
  const sx = svg.x + svg.width * 0.3;
  const sy = svg.y + svg.height * 0.92;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx, sy + 2 * ppu, { steps: 6 });
  await page.mouse.up();
  const after = await machine(page, 9);
  expect(after.y - before.y, 'moved two units down from far away').toBe(2);
  expect(after.x).toBe(before.x);

  // a drag ON the machine itself moves it and keeps its size: the corner
  // handle's 44px hit circle used to cover the whole 22×18px box, so every
  // grab resized it instead
  await expect(page.locator('#floor .handle-hit')).toHaveCount(0);
  const box = await page.locator(`#floor g.machine[data-id="${before.id}"] .machine-box`).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 2 * ppu, { steps: 6 });
  await page.mouse.up();
  const grabbed = await machine(page, 9);
  expect([grabbed.x, grabbed.y, grabbed.w, grabbed.h], 'moved up two, same size')
    .toEqual([after.x, after.y - 2, after.w, after.h]);
  await page.locator('.dp-down').click();
  await page.locator('.dp-down').click();

  // Move off: the same drag moves nothing (and only deselects)
  await page.locator('#item-move').click();
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx, sy + 2 * ppu, { steps: 6 });
  await page.mouse.up();
  expect((await machine(page, 9)).y).toBe(after.y);
});
