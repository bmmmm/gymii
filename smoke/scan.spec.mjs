// The pairing scanner (Settings → Sync → "Scan QR code"), end to end in a
// real browser: getUserMedia → <video> → canvas → js/qrscan.js → the field.
// The camera is a canvas filmed by captureStream(), standing in for
// getUserMedia — deterministic, and it films exactly the QR a test draws.
// test/qrscan.test.mjs holds the decoder's hard cases (angles, noise, a
// terminal's half blocks); test/settings.test.mjs the camera's refusals.
import { test, expect } from '@playwright/test';
import { findOverflow, measure, watchForFailures } from './fixtures.mjs';

const CODE = 'gymii-sync:v1:eyJzZXJ2ZXIiOiJodHRwczovL3N5bmMuZXhhbXBsZS5vcmciLCJ0b2tlbiI6InRva19zbW9rZSIsInBhc3MiOiJhbWJlci12aW9sZXQtb3JiaXQiLCJneW1JZCI6ImdfMSIsImludml0ZSI6dHJ1ZX0';
const LINK = `https://bmmmm.github.io/gymii/#pair=${encodeURIComponent(CODE)}`;

// Swaps the camera for a canvas showing `text` as a QR — a light screen on
// a dark desk — redrawn every frame like a live picture. Every stream handed
// out is kept on window.__streams, so a test can ask whether it was stopped.
async function fakeCamera(page, text) {
  await page.evaluate(async (t) => {
    const { qrMatrix } = await import('/js/qr.js');
    const m = qrMatrix(t);
    const px = 5;
    const side = (m.length + 8) * px;
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, 640, 480);
      const x0 = (640 - side) / 2;
      const y0 = (480 - side) / 2;
      ctx.fillStyle = '#eee';
      ctx.fillRect(x0, y0, side, side);
      ctx.fillStyle = '#111';
      m.forEach((row, r) => row.forEach((dark, c) => {
        if (dark) ctx.fillRect(x0 + (c + 4) * px, y0 + (r + 4) * px, px, px);
      }));
      requestAnimationFrame(draw);
    };
    draw();
    window.__streams = [];
    navigator.mediaDevices.getUserMedia = async () => {
      const stream = canvas.captureStream(15);
      window.__streams.push(stream);
      return stream;
    };
  }, text);
}

const cameraState = (page) => page.evaluate(() => (window.__streams ?? [])
  .map((s) => s.getTracks().every((tr) => tr.readyState === 'ended')));

test('a pairing QR fills the field and stops the camera — it never pairs by itself', async ({ page }) => {
  const { consoleErrors } = watchForFailures(page);
  await page.goto('/#settings');
  await fakeCamera(page, LINK);
  await page.locator('#sync-scan').click();
  await expect(page.locator('#sync-code')).toHaveValue(CODE);
  await expect(page.locator('#sync-msg')).toContainText('tap Pair');
  await expect(page.locator('#sync-scanner')).toBeHidden();
  await expect(page.locator('#sync-scan')).toBeVisible();
  expect(await cameraState(page), 'one stream, stopped').toEqual([true]);
  // still unpaired: the card offers "Turn on sync" exactly as before
  await expect(page.locator('#sync-enable')).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('another QR keeps it looking; Cancel turns the camera off', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/#settings');
  await fakeCamera(page, 'https://example.org/menu');
  await page.locator('#sync-scan').click();
  await expect(page.locator('#sync-scan-video')).toBeVisible();
  await expect(page.locator('#sync-scan-hint')).toContainText('not a gymii sync code');
  expect(await cameraState(page), 'the camera is still running').toEqual([false]);
  // the open panel holds the layout rules at 320px like every other card
  expect(await page.evaluate(findOverflow), 'the open scanner overflows at 320px').toBeNull();
  const { small, tiny } = await page.evaluate(measure);
  expect(small, 'undersized touch targets with the scanner open').toEqual([]);
  expect(tiny, 'fields iOS would zoom into with the scanner open').toEqual([]);
  await page.locator('#sync-scan-cancel').click();
  await expect(page.locator('#sync-scanner')).toBeHidden();
  expect(await cameraState(page), 'Cancel stops it').toEqual([true]);
  await expect(page.locator('#sync-code')).toHaveValue('');
});

test('leaving the tab mid-scan turns the camera off', async ({ page }) => {
  await page.goto('/#settings');
  await fakeCamera(page, 'https://example.org/menu');
  await page.locator('#sync-scan').click();
  await expect(page.locator('#sync-scan-hint')).toContainText('not a gymii sync code');
  await page.locator('#tabbar a[data-tab="history"]').click();
  await expect.poll(() => cameraState(page), { message: 'the scan loop notices its video is gone' })
    .toEqual([true]);
});
