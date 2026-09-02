import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { seedDemoGym, watchForFailures } from './fixtures.mjs';

// Scenario 1. js/app.js is loaded by NO Node test — it touches `document`
// and `navigator.serviceWorker` at the top level — and static-checks parses
// files without resolving their imports, so a renamed export is a
// link-time SyntaxError nothing in CI could see before this spec. This is
// the test that stands between a typo and a white page.
test('a fresh install boots into onboarding', async ({ page }) => {
  const { consoleErrors, badResponses } = watchForFailures(page);
  await page.goto('/');
  // an empty install has no gym yet, so Train opens on the welcome screen
  await expect(page.locator('#ob-read')).toBeVisible();
  await expect(page.locator('#tabbar a[data-tab="train"]')).toHaveAttribute('aria-current', 'page');
  expect(consoleErrors, 'a clean boot logs nothing').toEqual([]);
  expect(badResponses, 'every asset the page asks for exists').toEqual([]);
});

test('an install with data boots into the hub', async ({ page }) => {
  const { consoleErrors, badResponses } = watchForFailures(page);
  await seedDemoGym(page);
  await expect(page.locator('#hub-start')).toBeVisible();
  expect(consoleErrors, 'a clean boot logs nothing').toEqual([]);
  expect(badResponses, 'every asset the page asks for exists').toEqual([]);
});

test('every tab renders without an error', async ({ page }) => {
  const { consoleErrors } = watchForFailures(page);
  await seedDemoGym(page);
  for (const route of ['gym', 'history', 'ai', 'settings', 'train']) {
    await page.goto(`/#${route}`);
    await expect(page.locator('#view h1, #view .tile')).not.toHaveCount(0);
  }
  expect(consoleErrors).toEqual([]);
});

// Scenario 6. test/sw.test.mjs proves the LOGIC in a vm with a faked
// `caches`, and the shell-list CI job proves every shipped file is listed
// in SHELL — but nothing proved the reverse, that every SHELL entry points
// at a file that exists. One typo there makes addAll(SHELL) reject, and the
// app loses its offline mode without a word. This also covers Befund C:
// sw.js is registered as a CLASSIC worker, so an `import` in it would pass
// static-checks and only fail here.
test('the service worker registers, activates and precaches the shell', async ({ page }) => {
  const shell = [...readFileSync(new URL('../sw.js', import.meta.url), 'utf8')
    .match(/const SHELL = \[([\s\S]*?)\];/)[1]
    .matchAll(/'([^']+)'/g)].map((m) => m[1]);
  expect(shell.length, 'the SHELL list was parsed out of sw.js').toBeGreaterThan(10);

  await page.goto('/');
  const cached = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.active) return null;
    const names = await caches.keys();
    const name = names.find((n) => n.startsWith('gymii-'));
    if (!name) return null;
    const keys = await (await caches.open(name)).keys();
    return keys.map((r) => new URL(r.url).pathname);
  });
  expect(cached, 'the worker activated and opened its cache').not.toBeNull();

  const missing = shell
    .map((entry) => new URL(entry, 'http://127.0.0.1/').pathname)
    .filter((path) => !cached.includes(path));
  expect(missing, 'every SHELL entry resolved to a real file and was cached').toEqual([]);
});
