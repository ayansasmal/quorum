import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: [
      'tests/gateway/**/*.test.js',
      'tests/scripts/**/*.test.js',
      'crossplane/tests/**/*.test.js',
    ],
    coverage: {
      provider: 'v8',
      include: ['gateway/src/**/*.js'],
      exclude: [
        'gateway/src/server.js',               // entry point — not unit-testable
        'gateway/src/middleware/rate-limit.js', // express-rate-limit wrapper
        'gateway/src/routes/dashboard.js',      // complex BFF — integration territory
        'gateway/src/routes/mcp-oauth.js',      // full OAuth dance — integration territory
        'gateway/src/routes/oauth.js',          // browser redirect OAuth — integration territory
        'gateway/src/shared/config/migrations.js', // DB schema migrations — integration territory
        'gateway/src/llm.js',                   // OpenAI API wrapper — integration territory
        'gateway/src/ddb.js',                   // DynamoDB AWS client — integration territory
      ],
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 75,
        branches: 75,
        functions: 75,
      },
    },
  },
})
