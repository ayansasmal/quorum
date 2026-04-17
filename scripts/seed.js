/**
 * Quorum seed data.
 *
 * Calls remember() tool directly (not via MCP) so the full audit trail,
 * governance pipeline, and version chain are created correctly.
 *
 * Includes:
 *   - auth:token-strategy with 3 versions to demonstrate history CLI
 *   - 13 other knowledge nodes across auth, api, db, infra, testing
 *   - One deliberate contradiction pair for conflict detection demo
 */

import pg from 'pg'
import { handler as rememberHandler } from '../src/tools/remember.js'

const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB ?? 'quorum_audit',
  user: process.env.POSTGRES_USER ?? 'quorum',
  password: process.env.POSTGRES_PASSWORD ?? 'quorum_local',
})

async function remember(params) {
  try {
    const result = await rememberHandler(pool, params)
    const label = `${params.topic}:${params.key} (v?)`
    if (result?.status === 'conflict_detected') {
      console.log(`  ⚠️  ${params.topic}:${params.key} → conflict detected (expected for demo)`)
    } else {
      console.log(`  ✓  ${params.topic}:${params.key} → ${result?.status ?? 'ok'} v${result?.version ?? '?'}`)
    }
    return result
  } catch (err) {
    console.error(`  ✗  ${params.topic}:${params.key} → ${err.message}`)
    return null
  }
}

async function seed() {
  console.log('\n── Seeding Quorum knowledge ─────────────────────────────\n')

  // ── auth:token-strategy — 3 versions to demonstrate history CLI ─────────────
  console.log('auth domain...')

  await remember({
    topic: 'auth',
    key: 'token-strategy',
    content: 'Use session tokens for all services. Session tokens allow revocation and work well for our monolithic application architecture.',
    author: 'junior-dev',
    confidence: 0.6,
    entity_type: 'Decision',
    tags: ['auth', 'session', 'tokens'],
  })

  await remember({
    topic: 'auth',
    key: 'token-strategy',
    content: 'Use JWT for all services. JWTs are stateless, scalable, and work across all deployment types including serverless.',
    author: 'senior-architect',
    confidence: 0.85,
    reason: 'Lambda services do not support session tokens — stateless JWT required',
    entity_type: 'Decision',
    tags: ['auth', 'jwt', 'lambda'],
  })

  await remember({
    topic: 'auth',
    key: 'token-strategy',
    content: 'Use JWT for Lambda-based services (payment-svc, notification-svc). Use session tokens for ECS-based internal services (auth-svc, admin-svc) where revocation is needed. The split follows deployment type, not service domain.',
    author: 'ayan',
    confidence: 0.9,
    reason: 'ADR-042 nuanced after Lambda constraint discovered in payment-svc — blanket JWT was too broad',
    entity_type: 'Decision',
    tags: ['auth', 'jwt', 'session', 'lambda', 'ecs', 'adr-042'],
  })

  await remember({
    topic: 'auth',
    key: 'delegation-flow',
    content: 'Internal service-to-service auth uses mTLS with certificates issued by our internal CA. External-facing APIs use OAuth 2.0 client credentials. Never use API keys for service-to-service — they cannot be rotated without downtime.',
    author: 'senior-architect',
    confidence: 0.9,
    entity_type: 'Decision',
    tags: ['auth', 'mtls', 'oauth', 'service-to-service'],
  })

  await remember({
    topic: 'auth',
    key: 'rate-limiting',
    content: 'Rate limiting is applied at the API gateway level, not per service. Limits: 100 req/s per authenticated user, 10 req/s for unauthenticated. Use sliding window algorithm. Exceeded limits return 429 with Retry-After header.',
    author: 'engineer',
    confidence: 0.8,
    entity_type: 'Constraint',
    tags: ['auth', 'rate-limiting', 'api-gateway'],
  })

  // ── api domain ─────────────────────────────────────────────────────────────
  console.log('api domain...')

  await remember({
    topic: 'api',
    key: 'error-standards',
    content: 'All API errors return JSON with shape: { error: { code: string, message: string, request_id: string } }. HTTP status codes follow RFC 7807. Never expose internal stack traces. Log errors server-side with request_id for correlation.',
    author: 'senior-architect',
    confidence: 0.95,
    entity_type: 'Pattern',
    tags: ['api', 'errors', 'rfc-7807'],
  })

  await remember({
    topic: 'api',
    key: 'versioning',
    content: 'API versioning uses URL path prefix: /v1/, /v2/. Minor version changes (new optional fields) are backwards compatible and do not increment major version. Deprecation notice period is minimum 6 months. Breaking changes require new major version.',
    author: 'senior-architect',
    confidence: 0.9,
    entity_type: 'Decision',
    tags: ['api', 'versioning', 'deprecation'],
  })

  await remember({
    topic: 'api',
    key: 'pagination',
    content: 'Use cursor-based pagination for all list endpoints. Response includes: { data: [], next_cursor: string | null, has_more: boolean }. Cursor is opaque — clients must not parse it. Max page size is 100. Default page size is 20.',
    author: 'engineer',
    confidence: 0.85,
    entity_type: 'Pattern',
    tags: ['api', 'pagination', 'cursor'],
  })

  // ── db domain ──────────────────────────────────────────────────────────────
  console.log('db domain...')

  await remember({
    topic: 'db',
    key: 'connection-pooling',
    content: 'PostgreSQL connection pool size: 10 connections per service instance. Pool per service, not per request. Use pg.Pool with idleTimeoutMillis: 30000. Never exceed 100 total connections across all instances — database max_connections is 200 with 100 reserved for admin.',
    author: 'senior-architect',
    confidence: 0.85,
    entity_type: 'Constraint',
    tags: ['db', 'postgresql', 'connection-pool'],
  })

  await remember({
    topic: 'db',
    key: 'migration-strategy',
    content: 'Database migrations run automatically on service startup using node-pg-migrate. Migrations are append-only in development. Production migrations require: (1) backwards-compatible schema change, (2) code deploy, (3) cleanup migration if needed. Never DROP COLUMN in same release as code change.',
    author: 'senior-architect',
    confidence: 0.9,
    entity_type: 'Runbook',
    tags: ['db', 'migrations', 'postgresql'],
  })

  await remember({
    topic: 'db',
    key: 'naming-conventions',
    content: 'Table names: snake_case plural (users, api_keys, audit_logs). Column names: snake_case. Primary keys: id (serial or uuid). Foreign keys: <table_singular>_id. Timestamps: created_at, updated_at (timestamptz). Boolean columns: is_ or has_ prefix.',
    author: 'engineer',
    confidence: 0.8,
    entity_type: 'Pattern',
    tags: ['db', 'naming', 'conventions'],
  })

  // ── infra domain ───────────────────────────────────────────────────────────
  console.log('infra domain...')

  await remember({
    topic: 'infra',
    key: 'secrets-management',
    content: 'Secrets are stored in AWS Secrets Manager. Never in environment variables committed to git. Never in .env files in production. Services retrieve secrets on startup via SDK — not via env injection. Secret rotation is automated via Lambda rotators. Rotation period: 90 days for API keys, 30 days for DB passwords.',
    author: 'senior-architect',
    confidence: 0.95,
    entity_type: 'Constraint',
    tags: ['infra', 'secrets', 'aws', 'security'],
  })

  await remember({
    topic: 'infra',
    key: 'retry-strategy',
    content: 'Use exponential backoff with jitter for all external service calls. Base delay: 1s. Max delay: 30s. Max retries: 3. Jitter: ±20%. Do not retry on 4xx (client errors). Always retry on 5xx and connection timeouts. Implement circuit breaker at 50% failure rate over 1 minute window.',
    author: 'engineer',
    confidence: 0.8,
    entity_type: 'Pattern',
    tags: ['infra', 'retry', 'circuit-breaker', 'resilience'],
  })

  // ── testing domain ─────────────────────────────────────────────────────────
  console.log('testing domain...')

  await remember({
    topic: 'testing',
    key: 'unit-strategy',
    content: 'Unit test pure business logic — calculations, transformations, validations. Do not unit test framework wiring, trivial getters/setters, or code that only makes sense as integration. Coverage target: 80% on business logic files. Use Vitest. Mock at service boundaries, not inside services.',
    author: 'senior-engineer',
    confidence: 0.85,
    entity_type: 'Pattern',
    tags: ['testing', 'unit', 'vitest', 'coverage'],
  })

  await remember({
    topic: 'testing',
    key: 'integration-scope',
    content: 'Integration tests run against real PostgreSQL and real Redis (via docker-compose in CI). Never mock the database — we burned a release when mocked tests passed but prod migration failed. API tests use real HTTP client against running server. External services (Stripe, AWS) are stubbed at the HTTP level only.',
    author: 'senior-engineer',
    confidence: 0.9,
    entity_type: 'Constraint',
    tags: ['testing', 'integration', 'postgresql', 'no-mocks'],
  })

  // ── Deliberate contradiction for conflict detection demo ───────────────────
  // db:connection-pooling says pool size 10.
  // This new entry contradicts it for high-concurrency scenarios.
  console.log('\nAdding deliberate contradiction (conflict detection demo)...')

  await remember({
    topic: 'db',
    key: 'connection-pooling',
    content: 'For high-concurrency batch processing services, use connection pool size of 50. Standard pool size of 10 is a bottleneck under load.',
    author: 'junior-dev',
    confidence: 0.5,
    entity_type: 'Constraint',
    tags: ['db', 'postgresql', 'connection-pool', 'performance'],
  })

  console.log('\n── Seed complete ─────────────────────────────────────────')
  console.log('\nTo verify:')
  console.log('  node cli.js history auth:token-strategy')
  console.log('  node cli.js audit verify')
  console.log('  node cli.js audit stats\n')
}

seed()
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
  .finally(() => pool.end())
