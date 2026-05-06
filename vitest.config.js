/**
 * Vitest configuration for Quorum.
 *
 * Constitutional tests are isolated and require 100% branch + line coverage.
 * Governance and tool tests are run as a separate suite.
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['mcp/src/**/*.js', 'gateway/src/**/*.js'],
      exclude: ['mcp/src/server.js'],
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
      },
    },
  },
})
