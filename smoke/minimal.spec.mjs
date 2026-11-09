import { test, expect } from '@playwright/test';
import { seedDemoGym, measure, findOverflow } from './fixtures.mjs';

// Minimal mode (app/js/minimal.js): the Train route as one screen. What the
// Node suite cannot see: the real router swapping the renderer in place, the
// tabbar actually gone, real taps through the fun layer, and the reduced
// motion media query.

const activeSets = (page) => page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => k.endsWith('.active'));
  const active = key ? JSON.parse(localStorage.getItem(key)) : null;
  return active ? active.entries.flatMap((e) => e.sets) : [];
});

test('the hub switches to Minimal and back; sets log with and without reps', async ({ page }) => {
  await seedDemoGym(page);
  await expect(page.locator('#tabbar')).toBeVisible();
  await page.locator('#minimal-toggle').click();
  await expect(page.locator('#min-view')).toBeVisible();
  await expect(page.locator('#tabbar'), 'one screen: no tabbar').toBeHidden();
  expect(page.url(), 'no navigation, the same route').toMatch(/#train$/);

  // "+ New" "Leg press" [Weight] — the demo HAS a #5 Leg press, so the name
  // picks that machine instead of minting a twin
  const machines = () => page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith('.layout'));
    return JSON.parse(localStorage.getItem(key)).machines.filter((m) => /^leg press$/i.test(m.label)).length;
  });
  expect(await machines()).toBe(1);
  await page.locator('#min-new').click();
  await page.locator('#min-new-name').fill('Leg press');
  await page.locator('#min-new-kind [data-kind="strength"]').click();
  await expect(page.locator('.min-title')).toContainText('Leg press');
  await expect(page.locator('#min-weight')).toBeVisible();
  await expect(page.locator('#min-reps'), 'one field: the weight').toHaveCount(0);
  expect(await machines(), 'no second Leg press').toBe(1);

  // two sets: {weight, at}, no reps key
  await page.locator('#min-log').click();
  await page.locator('#min-log').click();
  let sets = await activeSets(page);
  expect(sets).toHaveLength(2);
  sets.forEach((st) => expect(Object.keys(st).sort()).toEqual(['at', 'weight']));

  // + Reps, log: that set carries reps
  await page.locator('#min-extra').click();
  await expect(page.locator('#min-reps')).toBeVisible();
  await page.locator('#min-log').click();
  sets = await activeSets(page);
  expect(sets).toHaveLength(3);
  expect(Object.keys(sets[2]).sort()).toEqual(['at', 'reps', 'weight']);
  await expect(page.locator('#min-today .min-set')).toHaveCount(3);

  // the screen passes the house measures at this width
  expect(await page.evaluate(findOverflow)).toBeNull();
  expect(await page.evaluate(measure)).toEqual({ small: [], tiny: [] });

  // back to the full app: the running workout, with the tabbar
  await page.locator('#minimal-toggle').click();
  await expect(page.locator('#tabbar')).toBeVisible();
  await expect(page.locator('#min-view')).toHaveCount(0);
  await expect(page.locator('#log-set'), 'the full view continues the same workout').toBeVisible();
  await expect(page.locator('#sets-list')).not.toContainText('undefined');

  // finish it there, and History reads it without "undefined"
  await page.locator('#log-finish').click();
  await page.locator('#log-finish').click();
  await expect(page.locator('#hub-start')).toBeVisible();
  await expect(page.locator('#minimal-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#tabbar a[data-tab="history"]').click();
  await page.locator('#open-workouts').click();
  const newest = page.locator('#workout-list details.workout').first();
  await expect(newest).toContainText('Leg press');
  // two of its three sets have no reps: the volume is a lower bound, never a guess
  await expect(newest.locator('summary')).toContainText(/3 sets · ≥ \d/);
  await newest.locator('summary').click();
  // the history's weight prefilled all three: two bare weights, then one with reps
  await expect(newest.locator('.entry-line')).toContainText(/#5 .*Leg press/);
  await expect(newest.locator('.entry-line')).toContainText(/(\d+(?:\.\d+)?), \1, \1×10\b/);
  await expect(page.locator('#view')).not.toContainText('undefined');
});

test('the fun layer never takes a tap, and reduced motion moves nothing', async ({ page }) => {
  await seedDemoGym(page);
  await page.locator('#minimal-toggle').click();
  await page.locator('#min-new').click();
  await page.locator('#min-new-name').fill('Hip thrust');
  await page.locator('#min-new-kind [data-kind="strength"]').click();

  // a set starts an effect; the Log button stays tappable through it
  await page.locator('#min-log').click();
  const layer = page.locator('#fun-layer');
  await expect(layer).toHaveAttribute('aria-hidden', 'true');
  expect(await layer.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  await expect(layer.locator('.fun-sprite').first()).toBeAttached();
  await expect(layer.locator('.fun-line')).toBeAttached();
  // a trial tap is the hit test: it fails if anything covers the button
  await page.locator('#min-log').click({ trial: true, timeout: 2000 });
  await page.locator('#min-log').click({ timeout: 2000 });
  expect(await activeSets(page)).toHaveLength(2);
  // and every motif is gone again within the effect's ~2.5 s
  await expect(layer.locator('.fun-sprite')).toHaveCount(0, { timeout: 4000 });

  // reduced motion: the line alone, nothing that moves
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#min-log').click();
  await expect(layer.locator('.fun-line')).toBeAttached();
  await expect(layer.locator('.fun-sprite')).toHaveCount(0);
  const moving = await page.evaluate(() => document.getAnimations()
    .filter((a) => a.playState === 'running' && a.effect?.target?.closest?.('#fun-layer')).length);
  expect(moving, 'no running animation in the fun layer').toBe(0);
  expect(await activeSets(page)).toHaveLength(3);

  // fun off: neither motif nor line
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(layer.locator('.fun-line')).toHaveCount(0, { timeout: 4000 });
  await page.locator('#min-fun').click();
  await page.locator('#min-log').click();
  await expect(layer.locator('.fun-sprite, .fun-line')).toHaveCount(0);
  expect(await activeSets(page)).toHaveLength(4);
});

// keepAwake 'workout' holds the screen lock exactly as long as a workout
// runs. Minimal mode never calls renderTrain, where the lock used to be
// reconciled alone — a workout started here took no lock, and one finished
// here kept it. Chromium headless has no real wake lock to watch, so a stub
// counts the sentinels held.
test("keepAwake 'workout' takes the lock on Minimal's first set and drops it on Done", async ({ page }) => {
  await page.addInitScript(() => {
    window.__held = 0;
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          window.__held += 1;
          const listeners = [];
          let released = false;
          return {
            addEventListener: (type, fn) => { if (type === 'release') listeners.push(fn); },
            release: async () => {
              if (released) return;
              released = true;
              window.__held -= 1;
              listeners.forEach((fn) => fn());
            },
          };
        },
      },
    });
  });
  await seedDemoGym(page);
  await page.evaluate(async () => {
    const { getSettings, saveSettings } = await import('/js/store.js');
    saveSettings({ ...getSettings(), keepAwake: 'workout', minimal: true });
  });
  await page.reload();
  await expect(page.locator('#min-view')).toBeVisible();
  const held = () => page.evaluate(() => window.__held);
  expect(await held(), 'no workout yet, no lock').toBe(0);

  await page.locator('#min-new').click();
  await page.locator('#min-new-name').fill('Hip thrust');
  await page.locator('#min-new-kind [data-kind="strength"]').click();
  await page.locator('#min-log').click();
  expect(await activeSets(page)).toHaveLength(1);
  await expect.poll(held, { message: 'the first set started a workout: the lock is held' }).toBe(1);

  await page.locator('#min-done').click();
  await page.locator('#min-done').click();
  await expect(page.locator('#min-done')).toHaveCount(0);
  await expect.poll(held, { message: 'Done ended the workout: the lock is gone' }).toBe(0);
});

// Leaving the app mid-effect — the Home Screen gesture on an iPhone. Headless
// Chromium never reports a page hidden (another tab in front changes nothing),
// so the hide is told the way the browser tells it: visibilityState plus the
// event. The freeze is the real one, CDP's lifecycle state — what iOS does to
// a web app in the background: no JS, no timers, no frames. Either way the
// effect must neither replay on return nor stay stuck on screen.
// A pause or play lands on the next frame (until then playState already says
// "paused" while the clock still runs): wait for every animation's `ready`.
const funState = (page) => page.evaluate(async () => {
  const anims = document.getAnimations().filter((a) => a.effect?.target?.closest?.('#fun-layer'));
  await Promise.all(anims.map((a) => a.ready));
  return {
    sprites: document.querySelectorAll('#fun-layer .fun-sprite').length,
    states: [...new Set(anims.map((a) => a.playState))].sort(),
    time: Math.max(0, ...anims.map((a) => Number(a.currentTime) || 0)),
  };
});
const setHidden = (page, hidden) => page.evaluate((h) => {
  if (h) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  } else {
    delete document.hidden;
    delete document.visibilityState;
  }
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

test('leaving mid-effect pauses it, coming back finishes it, nothing replays', async ({ page }) => {
  await seedDemoGym(page);
  await page.locator('#minimal-toggle').click();
  await page.locator('#min-new').click();
  await page.locator('#min-new-name').fill('Hip thrust');
  await page.locator('#min-new-kind [data-kind="strength"]').click();

  // hidden: every animation of the layer paused, its sprites kept, time still
  await page.locator('#min-log').click();
  await expect(page.locator('#fun-layer .fun-sprite').first()).toBeAttached();
  await setHidden(page, true);
  const away = await funState(page);
  expect(away.sprites).toBeGreaterThan(0);
  expect(away.states, 'all paused while hidden').toEqual(['paused']);
  await page.waitForTimeout(3000); // longer than any effect runs
  const later = await funState(page);
  expect(later.sprites, 'nothing dropped, nothing added').toBe(away.sprites);
  expect(later.time, 'no time passed for a hidden effect').toBe(away.time);

  // visible again: it plays on from where it stood and ends; no second effect
  await setHidden(page, false);
  expect((await funState(page)).states).toEqual(['running']);
  await expect(page.locator('#fun-layer .fun-sprite')).toHaveCount(0, { timeout: 4000 });
  await expect(page.locator('#fun-layer .fun-line')).toHaveCount(0, { timeout: 4000 });
  expect(await activeSets(page)).toHaveLength(1);

  // frozen (the real lifecycle state) mid-effect, thawed after the effect's
  // length: it ends at once, never stuck, never replayed
  const cdp = await page.context().newCDPSession(page);
  await page.locator('#min-log').click();
  await expect(page.locator('#fun-layer .fun-sprite').first()).toBeAttached();
  const before = (await funState(page)).sprites;
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await page.waitForTimeout(3000);
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  expect((await funState(page)).sprites).toBeLessThanOrEqual(before);
  await expect(page.locator('#fun-layer .fun-sprite')).toHaveCount(0, { timeout: 4000 });
  await expect(page.locator('#fun-layer .fun-line')).toHaveCount(0, { timeout: 4000 });
  expect(await activeSets(page)).toHaveLength(2);

  // iOS may also drop the page and reload it: the effect is gone, not replayed
  await page.locator('#min-log').click();
  await expect(page.locator('#fun-layer .fun-sprite').first()).toBeAttached();
  await page.reload();
  await expect(page.locator('#min-view')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator('#fun-layer .fun-sprite, #fun-layer .fun-line')).toHaveCount(0);
  expect(await activeSets(page)).toHaveLength(3);
  await expect(page.locator('#min-today .min-set')).toHaveCount(3);
});
