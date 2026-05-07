import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/gateway/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['gateway/src/**/*.js'],
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
      },
    },
  },
})
