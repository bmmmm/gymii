import { test, expect } from '@playwright/test';

// TODO.md, "On a real iPhone": "Safe area in standalone" is listed as a
// check no automation can settle, because a normal navigation always
// reports env(safe-area-inset-*) as 0 — the note on the entry is that the
// env(safe-area-inset-top) fix "in a browser can only be checked at inset
// 0, where it measured the expected 12 px". That's still true for the
// zero-inset case pinned below, but Chromium has since grown a CDP command,
// Emulation.setSafeAreaInsetsOverride, that reports a REAL nonzero inset —
// closing the gap for the CSS math, if not for the full iOS/WebKit,
// Add-to-Home-Screen round trip (playwright.config.mjs is explicit that
// this project's WebKit-specific risks stay on the device checklist).
//
// #view's padding is the exact rule the entry is about: calc(12px +
// env(safe-area-inset-top)) 16px calc(96px + env(safe-area-inset-bottom)).
// No source change came with this test — reading it back confirmed the fix
// already landed (commit f25e4d6, "Give the app the whole screen, safely")
// and still computes correctly; what was missing was proof beyond inset 0.

test('the base padding matches the documented 12px baseline at zero inset', async ({ page }) => {
  await page.goto('/');
  const style = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('view'));
    return { paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom };
  });
  expect(style.paddingTop, 'the 12px named in the TODO entry').toBe('12px');
  expect(style.paddingBottom).toBe('96px');
});

test('a real notch/Dynamic-Island inset adds on top of the 12px, not instead of it', async ({ page, context }) => {
  await page.goto('/');
  try {
    const cdp = await context.newCDPSession(page);
    // 59px top / 34px bottom: a Dynamic Island phone's status bar and home
    // indicator, roughly — the exact figures do not matter, only that a
    // nonzero inset is reflected at all and additively, not by replacement.
    await cdp.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: 59, topMax: 59, left: 0, leftMax: 0, right: 0, rightMax: 0, bottom: 34, bottomMax: 34 },
    });
  } catch (e) {
    // A non-Chromium project (or an older Chromium without this CDP command)
    // has no session to open at all, not just a command that fails —
    // newCDPSession() itself throws there, so it has to be inside this try.
    test.skip(true, `this engine cannot emulate safe-area insets (${e.message}) — inset 0 is all it can check`);
  }
  const style = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('view'));
    return { paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom };
  });
  expect(style.paddingTop, 'content now starts below the simulated status bar / Dynamic Island').toBe('71px');
  expect(style.paddingBottom, 'and above the simulated home indicator').toBe('130px');
});
