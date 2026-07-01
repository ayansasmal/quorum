/**
 * Unified Quorum E2E Playwright configuration.
 *
 * This config owns both API and UI scenarios through one shared helper,
 * fixture, reporter, and artifact surface under `quorum/e2e/`.
 */

import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir:    './scenarios',
  testMatch:  '**/*.spec.js',
  timeout:    30_000,
  retries:    1,
  workers:    4,
  fullyParallel: true,

  reporter: [
    ['./reporter/graph-reporter.js'],
    ['list'],
    ['html', { outputFolder: '../playwright-report', open: 'never' }],
  ],

  outputDir: '../test-results',

  use: {
    baseURL:      process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001',
    ...devices['Desktop Chrome'],
    screenshot:   { mode: 'on', fullPage: true },
    trace:        'on-first-retry',
    extraHTTPHeaders: {},
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    },
  },

  globalSetup: './helpers/setup.js',
  globalTeardown: './helpers/teardown.js',

  projects: [
    {
      name: 'api',
      testMatch: 'api/**/*.spec.js',
      use: { browserName: 'chromium' },
    },
    {
      name: 'ui',
      testMatch: 'ui/**/*.spec.js',
      use: { browserName: 'chromium' },
    },
  ],
})
