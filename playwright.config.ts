import { defineConfig } from '@playwright/test';

const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests/e2e',
  // A test may launch Electron twice (close and relaunch). Cold starts on shared CI runners
  // have taken close to 40 s before the first paint, so the budget is generous there.
  timeout: ci ? 120_000 : 30_000,
  expect: { timeout: ci ? 15_000 : 5_000 },
  retries: ci ? 1 : 0,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
