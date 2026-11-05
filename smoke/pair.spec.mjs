// Pairing a gym that already holds records (Settings → Sync): the card asks
// before anything is sent — merge, keep separate, or replace — and the one
// that gives records up arms first. The pairing itself runs against a fake
// server in test/sync.test.mjs § 23 and test/settings.test.mjs; this is the
// browser half: the choice unfolds, holds the 320px rules, and nothing
// leaves the page before a choice is made.
import { test, expect } from '@playwright/test';
import { findOverflow, measure, watchForFailures } from './fixtures.mjs';

const CODE = `gymii-sync:v1:${Buffer.from(JSON.stringify({
  server: 'https://sync.example.org', token: 'tok_smoke', gymId: 'g_1', plain: true,
})).toString('base64url')}`;

test('a gym with records asks before it pairs; replace arms first', async ({ page }) => {
  const { consoleErrors } = watchForFailures(page);
  await page.setViewportSize({ width: 320, height: 640 });
  const sent = [];
  await page.context().route('https://sync.example.org/**', (r) => {
    sent.push(r.request().url());
    return r.abort();
  });
  await page.goto('/#settings');
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    store.saveWorkouts([{
      id: 'w1',
      startedAt: 1000,
      finishedAt: 2000,
      entries: [{
        machineId: null, num: 1, label: 'Row', settings: {}, sets: [{ reps: 10, weight: 40 }],
      }],
    }]);
  });
  await page.reload();

  await page.locator('#sync-code').fill(CODE);
  await page.locator('#sync-pair').click();
  await expect(page.locator('#sync-pair-choice')).toBeVisible();
  await expect(page.locator('#sync-pair-about')).toContainText('already holds 1 workout');
  await expect(page.locator('#sync-pair-server'))
    .toHaveText('This code joins a gym on https://sync.example.org — unencrypted.');
  expect(await page.evaluate(findOverflow), 'the open choice overflows at 320px').toBeNull();
  const { small, tiny } = await page.evaluate(measure);
  expect(small, 'undersized touch targets in the choice').toEqual([]);
  expect(tiny, 'fields iOS would zoom into with the choice open').toEqual([]);

  const replace = page.locator('#sync-pair-replace');
  await replace.click();
  await expect(replace).toHaveText('Tap again — backup first, then replace');
  await expect(replace).toHaveClass(/armed/);
  expect(sent, 'nothing goes out before a choice').toEqual([]);
  await expect(page.locator('#sync-enable')).toBeVisible(); // still unpaired
  expect(consoleErrors).toEqual([]);
});
