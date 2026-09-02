import { defineConfig, devices } from '@playwright/test';

const PORT = 8437;

export default defineConfig({
  testDir: './smoke',
  // Pinned, not defaulted. Playwright's collector IMPORTS everything it
  // matches, and the default pattern would match test/*.test.mjs — running
  // all 15 Node suites as a side effect of collection.
  testMatch: '**/*.spec.mjs',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    // 127.0.0.1, not localhost: a machine that resolves localhost to ::1
    // first spends a connect timeout per navigation before falling back.
    baseURL: `http://127.0.0.1:${PORT}`,
    // The app formats dates as en-GB and derives "today" from the local
    // day. Both are pinned so a spec can never depend on the runner's.
    locale: 'en-GB',
    timezoneId: 'Europe/Berlin',
    trace: 'on-first-retry',
  },
  // One project. What these specs check — the module graph loading, click
  // chains, box metrics, SW registration — is the same question on every
  // engine, and this repo's engine-specific risks are iOS Safari ones
  // (module workers before 16.4, the silent switch, wakeLock) that
  // Playwright's WebKit build does not answer. Those live on the device
  // checklist in TODO.md instead.
  projects: [{ name: 'mobile-chromium', use: { ...devices['Pixel 5'] } }],
  webServer: {
    command: `python3 serve.py ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    // locally this attaches to a dev server that is already up
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    timeout: 30_000,
  },
});
