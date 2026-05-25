/**
 * playwright.config.js — Quorum E2E test configuration.
 *
 * Scenario ID convention (required by graph-reporter):
 *   Every spec file must wrap each scenario in a describe block whose title
 *   begins with the scenario ID, e.g.:
 *
 *     describe('S-05.1 — RBAC Knowledge Create', () => {
 *       test('engineer cannot POST /api/knowledge', ...)
 *     })
 *
 *   The graph reporter extracts the ID via /^S-\d+(?:\.\d+)?/ from the title
 *   path. Tests not inside a matching describe block are ignored by the reporter.
 *
 * T0 infrastructure probes run first via globalSetup. If T0 fails the suite is
 * stopped immediately — T0 failures are infrastructure problems, not application
 * bugs, and should not populate the fix_queue.
 */

import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir:    'tests/e2e/scenarios',
  testMatch:  '**/*.spec.js',
  timeout:    30_000,
  retries:    1,                    // 1 retry flags flaky; 2nd failure counts as failed
  workers:    4,                    // parallel scenarios — each is state-isolated via uid()
  fullyParallel: true,

  // Reporter stack:
  //   - graph-reporter: writes test-results/suite-graph.json (machine-readable DAG)
  //   - list: human-readable console output during the run
  //   - html:  full HTML report at playwright-report/ (test artifacts, screenshots)
  reporter: [
    ['./tests/e2e/reporter/graph-reporter.js'],
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  // Artifacts directory — graph reporter writes screenshots here too
  outputDir: 'test-results',

  use: {
    // Gateway base URL — override via QUORUM_GATEWAY_URL env
    baseURL:      process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001',

    // Dashboard base URL — override via QUORUM_DASHBOARD_URL env
    // Used by Playwright browser tests (J14 dashboard visual, J08, etc.)
    // If your dashboard runs elsewhere, override this.
    ...devices['Desktop Chrome'],

    // Attach a screenshot on failure — graph reporter surfaces these in logs[]
    screenshot:   'only-on-failure',
    trace:        'on-first-retry',

    // Per-test extra context (set project header, token, etc. in fixtures)
    extraHTTPHeaders: {},

    // Chromium launch flags required inside Docker containers:
    //   --no-sandbox          : Docker prevents kernel namespace isolation that
    //                           Chrome's sandbox needs — disabling it is safe
    //                           in an already-isolated container environment.
    //   --disable-dev-shm-usage : Docker limits /dev/shm to 64MB by default;
    //                           Chrome uses /dev/shm for IPC and crashes without
    //                           this flag. Uses /tmp instead.
    //   --disable-gpu         : No GPU in headless CI — avoids driver errors.
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      // Use system Chromium inside Docker (set via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH).
      // Playwright 1.60+ does not read this env var directly — must be wired here.
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    },
  },

  // T0 infrastructure probes run before any test.
  // Defined in tests/e2e/helpers/setup.js — must export a default function.
  globalSetup: './tests/e2e/helpers/setup.js',

  // No-op teardown — uid() key isolation means no cleanup is needed.
  // See tests/e2e/helpers/teardown.js for rationale.
  globalTeardown: './tests/e2e/helpers/teardown.js',

  // Projects (browser targets — most Quorum scenarios are API-only)
  projects: [
    {
      name: 'api',
      testMatch: '**/scenarios/**/*.spec.js',
      use: { browserName: 'chromium' },
    },
  ],
})
