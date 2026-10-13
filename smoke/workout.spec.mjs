import { test, expect } from '@playwright/test';
import { seedDemoGym, startWorkoutAt } from './fixtures.mjs';

// Scenario 2. Five real click handlers across three render* functions, real
// event bubbling, real localStorage, the real hash router. The Node stub
// DOM "hands back EVERY selector, rendered or not", so a logic test there
// can hit a handler a re-render replaced long ago; here it cannot.
test('a logged set survives a reload', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);

  const label = await page.locator('#log-set').textContent();
  const weight = await page.locator('#set-weight').inputValue();
  await page.locator('#log-set').click();

  // the set reached storage, through the app's own writer
  const sets = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith('.active'));
    return JSON.parse(localStorage.getItem(key)).entries.flatMap((e) => e.sets);
  });
  expect(sets).toHaveLength(1);
  expect(String(sets[0].weight)).toBe(weight);
  expect(label).toContain(weight);

  // and it is still there after a cold boot — the crash-safety promise
  await page.reload();
  await expect(page.locator('#log-set')).toBeVisible();
  const afterReload = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith('.active'));
    return JSON.parse(localStorage.getItem(key)).entries.flatMap((e) => e.sets).length;
  });
  expect(afterReload).toBe(1);
});

// Scenario 3. The core of the last round, and structurally invisible to the
// Node suite: runRest() returns immediately when there is no `document`, so
// headless only ever sees the bare `restUntil` fact.
test('the rest keeps running after the overlay is closed', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);
  await page.locator('#log-set').click();

  const overlay = page.locator('.overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('#cd')).not.toBeEmpty();

  // tapping the backdrop closes the SCREEN, not the timer
  await overlay.click({ position: { x: 5, y: 5 } });
  await expect(overlay).toHaveCount(0);
  const inline = page.locator('#rest-cd');
  await expect(inline).toBeVisible();

  // The one deliberate wait in the suite: the app's own display is measured
  // against itself over real time, so a stopped timer is the only way to
  // fail it.
  const before = await inline.textContent();
  await page.waitForTimeout(2500);
  const after = await inline.textContent();
  expect(toSeconds(after), `the countdown moved on from ${before}`)
    .toBeLessThan(toSeconds(before));

  // a reload mid-rest must pick the deadline back up (ensureRestTicking):
  // the countdown comes back where it was — never restarted, never gone —
  // and keeps moving
  await page.reload();
  const resumed = page.locator('#rest-cd');
  await expect(resumed).toBeVisible();
  const afterReload = toSeconds(await resumed.textContent());
  expect(afterReload, 'the rest resumed rather than restarting')
    .toBeLessThanOrEqual(toSeconds(after));
  await page.waitForTimeout(2500);
  expect(toSeconds(await resumed.textContent()), 'and is still ticking after the reload')
    .toBeLessThan(afterReload);
});

// D5: finishWorkout() writes history BEFORE it clears the active workout,
// and finish() stops the rest only after both landed. A refused write must
// therefore leave the workout — and its countdown — running, not frozen.
test('a finish refused by full storage leaves the countdown running', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);
  await page.locator('#log-set').click();
  await page.locator('.overlay').click({ position: { x: 5, y: 5 } });
  const inline = page.locator('#rest-cd');
  await expect(inline).toBeVisible();
  await page.evaluate(() => {
    Storage.prototype.setItem = function setItem() {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  });
  await page.locator('#log-finish').click();
  await page.locator('#log-finish').click();
  await expect(page.locator('#log-set'), 'the workout is still on').toBeVisible();
  const before = toSeconds(await inline.textContent());
  await page.waitForTimeout(2500);
  expect(toSeconds(await inline.textContent()), 'and its countdown still ticks').toBeLessThan(before);
});

// "Reps left?" lives in the overlay only, which the Node suite never sees.
test('a RIR chip in the rest overlay rates the set just logged', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);
  await page.locator('#log-set').click();
  const chip = page.locator('.overlay #rir-opts .chip[data-rir="2"]');
  const lastRir = () => page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith('.active'));
    return JSON.parse(localStorage.getItem(key)).entries.flatMap((e) => e.sets).at(-1).rir ?? null;
  });
  await chip.click();
  await expect(chip).toHaveClass(/\bsel\b/);
  expect(await lastRir()).toBe(2);
  await expect(page.locator('.overlay'), 'a rating does not close the rest').toBeVisible();
  await chip.click();
  await expect(chip).not.toHaveClass(/\bsel\b/);
  expect(await lastRir(), 'the same chip again clears it').toBeNull();
});

// Finishing mid-rest ends the rest with the workout: no countdown in the hub
// and no tone at the old zero. A 5 s rest makes "the old zero" observable.
test('finishing during a rest ends it: no timer and no tone in the hub', async ({ page }) => {
  await seedDemoGym(page);
  await startWorkoutAt(page, 1);
  await page.evaluate(() => {
    window.plays = [];
    HTMLMediaElement.prototype.play = function play() {
      window.plays.push(this.src);
      return Promise.resolve();
    };
  });
  await page.locator('#set-rest').fill('5');
  await page.locator('#log-set').click();
  await page.locator('.overlay').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('#rest-cd')).toBeVisible();
  // the rest must still be running when Finish lands, or the tone would
  // already be counted and the wait below would prove nothing
  expect(toSeconds(await page.locator('#rest-cd').textContent())).toBeGreaterThan(1);
  await page.locator('#log-finish').click();
  await page.locator('#log-finish').click();
  await expect(page.locator('#hub-start')).toBeVisible();
  await expect(page.locator('#rest-cd')).toHaveCount(0);
  const plays = await page.evaluate(() => window.plays.length);
  await page.waitForTimeout(6000);
  expect(await page.evaluate(() => window.plays.length), 'no tone where the rest would have ended').toBe(plays);
  await expect(page.locator('.overlay')).toHaveCount(0);
});

const toSeconds = (text) => {
  const parts = text.trim().split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
};

// The rest hint (stats.js rule 5) lives only in the overlay, and the
// overlay only exists in a browser: runRest() returns before any DOM when
// there is no `document`, so the Node suite never sees this markup.
test('the rest overlay carries the rest hint with its 44px ↗', async ({ page }) => {
  await seedDemoGym(page);
  // five workouts in the last hours with 60 s between stamped sets: a
  // median under 90 s, from ten or more gaps
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    const now = Date.now();
    const short = [1, 2, 3, 4, 5].map((n) => {
      const t0 = now - n * 3600e3 - 1800e3;
      return {
        id: `short${n}`, startedAt: t0, finishedAt: t0 + 900e3,
        entries: [{ machineId: 'lat-pulldown', num: 2, label: 'Lat pulldown', settings: {},
          // five sets, four 60 s gaps each: enough to outweigh the demo's own
          // pull day (the newest stamped workout) whatever machines it holds
          sets: [0, 1, 2, 3, 4].map((k) => ({ reps: 10, weight: 50, at: t0 + 100e3 + k * 60e3 })) }],
      };
    });
    store.saveWorkouts([...store.getWorkouts(), ...short]);
  });
  await startWorkoutAt(page, 1);
  await page.locator('#log-set').click();
  const hint = page.locator('.overlay .rest-hint');
  await expect(hint).toHaveText(/^Hold 90 s — your median is 60 s \(incl\. the set\)\.↗$/);
  const box = await hint.locator('a').boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await expect(hint.locator('a')).toHaveAttribute('href', /PMC11349676/);
  // the ↗ opens the study in a new tab — the rest screen stays (the
  // backdrop's close skips `button, a`)
  // the study answers locally: the deploy gate must not wait on NCBI
  await page.context().route('https://pmc.ncbi.nlm.nih.gov/**', (r) => r.fulfill({ body: '' }));
  const [study] = await Promise.all([page.waitForEvent('popup'), hint.locator('a').click()]);
  await study.close();
  await expect(page.locator('.overlay'), 'tapping the ↗ is no backdrop tap').toBeVisible();
});

// The rest overlay lives on body and survives a route change. Browser Back
// under it used to let a backdrop tap (or a RIR chip) render the workout
// into #view while the History pill stayed lit.
test('closing the rest overlay after Back never paints Train under another tab', async ({ page }) => {
  await seedDemoGym(page);
  await page.goto('/#history');
  await page.locator('#tabbar a[data-tab="train"]').click();
  await startWorkoutAt(page, 1);
  await page.locator('#log-set').click();
  const overlay = page.locator('.overlay');
  await expect(overlay).toBeVisible();

  await page.evaluate(() => history.back());
  await expect(page.locator('#tabbar a.active')).toHaveAttribute('data-tab', 'history');
  await overlay.click({ position: { x: 5, y: 5 } });
  await expect(overlay).toHaveCount(0);
  await expect(page.locator('#tabbar a.active')).toHaveAttribute('data-tab', 'history');
  await expect(page.locator('#view #log-set')).toHaveCount(0);
});

// Grips, end to end in a real browser: two grips on one exercise are two
// entries, and History names both.
test('a grip switch logs a second entry, and History names both grips', async ({ page }) => {
  await seedDemoGym(page);
  await page.locator('#hub-start').click();
  await page.locator('.pick-num').fill('9');
  await page.locator('.pick-go').click();
  await page.locator('#exercise-chips .chip[data-exercise="Triceps pushdown"]').click();
  const grip = (g) => page.locator(`#grip-chips .chip[data-grip="${g}"]`);
  const pick = async (g) => {
    if (!(await grip(g).getAttribute('class')).split(' ').includes('sel')) await grip(g).click();
    await expect(grip(g)).toHaveClass(/\bsel\b/);
  };
  const logOne = async () => {
    await page.locator('#log-set').click();
    const overlay = page.locator('.overlay');
    if (await overlay.count()) await overlay.click({ position: { x: 5, y: 5 } });
    await expect(overlay).toHaveCount(0);
  };
  await pick('Rope');
  await logOne();
  await pick('V-bar');
  await logOne();

  const entries = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith('.active'));
    return JSON.parse(localStorage.getItem(key)).entries
      .filter((e) => e.sets.length).map((e) => [e.exercise, e.grip, e.sets.length]);
  });
  expect(entries).toEqual([['Triceps pushdown', 'Rope', 1], ['Triceps pushdown', 'V-bar', 1]]);

  await page.locator('#log-finish').click();
  await page.locator('#log-finish').click();
  await page.locator('#tabbar a[data-tab="history"]').click();
  await page.locator('#open-workouts').click();
  const latest = page.locator('#workout-list .workout').first();
  await latest.click();
  await expect(latest).toContainText('#9 Cable tower · Triceps pushdown · Rope');
  await expect(latest).toContainText('#9 Cable tower · Triceps pushdown · V-bar');
});
