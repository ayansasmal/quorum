/**
 * Quorum seed data.
 *
 * Writes knowledge entries directly to PostgreSQL using the gateway shared
 * modules. Does not go through the MCP protocol. Full audit trail, version
 * history, and status transitions are applied.
 *
 * Includes:
 *   - auth:token-strategy with 3 versions to demonstrate history CLI
 *   - 13 other knowledge nodes across auth, api, db, infra, testing
 *   - One deliberate contradiction pair for conflict detection demo
 *
 * Idempotency:
 *   Skips gracefully if seed data already exists.
 *   Pass --force to clear seed data and re-seed from scratch.
 *
 * Usage:
 *   node scripts/seed.js            # skip if already seeded
 *   node scripts/seed.js --force    # clear and re-seed
 */

import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import {
  getCurrentVersion,
  getNextVersionNumber,
  getOrCreateKey,
  insertVersion,
  transitionVersionStatus,
} from '../gateway/src/shared/graph/queries.js'
import { writeAuditEntry } from '../gateway/src/shared/audit/secondary.js'

const FORCE = process.argv.includes('--force')

const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB ?? 'quorum_audit',
  user: process.env.POSTGRES_USER ?? 'quorum',
  password: process.env.POSTGRES_PASSWORD ?? 'quorum_local',
})

/** Seed sentinel — if this topic:key exists at v1, the seed has already run. */
const SENTINEL = { topic: 'auth', key: 'token-strategy' }

/**
 * @returns {Promise<boolean>}
 */
async function isAlreadySeeded() {
  const { rows } = await pool.query(
    `SELECT 1 FROM knowledge_versions
     WHERE topic = $1 AND key = $2 AND version = 1
     LIMIT 1`,
    [SENTINEL.topic, SENTINEL.key],
  )
  return rows.length > 0
}

async function clearSeedData() {
  const seedTopicKeys = [
    ['auth', 'token-strategy'],
    ['auth', 'delegation-flow'],
    ['auth', 'rate-limiting'],
    ['api',  'error-standards'],
    ['api',  'versioning'],
    ['api',  'pagination'],
    ['db',   'connection-pooling'],
    ['db',   'migration-strategy'],
    ['db',   'naming-conventions'],
    ['infra','secrets-management'],
    ['infra','retry-strategy'],
    ['testing','unit-strategy'],
    ['testing','integration-scope'],
  ]

  for (const [topic, key] of seedTopicKeys) {
    await pool.query(
      `DELETE FROM knowledge_versions WHERE topic = $1 AND key = $2`,
      [topic, key],
    )
  }
}

/**
 * Write a knowledge entry to PostgreSQL with version history and audit trail.
 * Replicates core remember logic without MCP protocol overhead.
 *
 * Uses v0.3 q_* ID resolution: getOrCreateKey → q_key_id, then composes
 * version_id as `${q_key_id}_v${version}` before calling insertVersion.
 *
 * @param {string} qProjectId - resolved q_project_id (e.g. 'q_p0')
 * @param {{ topic: string, key: string, content: string, author: string,
 *            confidence?: number, reason?: string, entity_type?: string,
 *            tags?: string[] }} params
 */
async function remember(qProjectId, params) {
  const {
    topic,
    key,
    content,
    author,
    confidence = 0.7,
    reason = 'seed data',
    entity_type = 'Decision',
    tags = [],
  } = params

  try {
    const contentHash = createHash('sha256').update(content).digest('hex')
    const now = new Date().toISOString()
    const triggeredBy = randomUUID()

    // v0.3: resolve q_key_id first, then use it for all version lookups
    const qKeyId = await getOrCreateKey(pool, qProjectId, topic, key)

    const [nextVersion, active] = await Promise.all([
      getNextVersionNumber(pool, qKeyId),
      getCurrentVersion(pool, qKeyId),
    ])

    const versionId = `${qKeyId}_v${nextVersion}`

    const record = await insertVersion(pool, {
      version_id: versionId,
      q_key_id: qKeyId,
      q_project_id: qProjectId,
      topic,
      key,
      version: nextVersion,
      status: 'ACTIVE',
      content_hash: contentHash,
      author,
      author_role: 'unknown',
      confidence,
      starting_confidence: confidence,
      created_at: now,
      created_by_audit: triggeredBy,
      triggered_by: triggeredBy,
      conflict_id: null,
      graphiti_episode_id: null,
      supersedes_version: active?.version ?? null,
      supersedes_reason: active ? reason : null,
      superseded_by_version: null,
      superseded_by_author: null,
      superseded_at: null,
      tags,
      entity_type,
      summary: content.slice(0, 200),
    })

    if (active) {
      const oldVersionId = `${qKeyId}_v${active.version}`
      await transitionVersionStatus(pool, oldVersionId, 'SUPERSEDED', {
        version: nextVersion,
        author,
        at: now,
      })
    }

    await writeAuditEntry(pool, {
      entry_id: triggeredBy,
      operation: 'remember',
      tool: 'seed',
      author,
      author_role: 'unknown',
      content_hash: contentHash,
      q_project_id: qProjectId,
      version_id: record.version_id,
      governance_json: { reason, tags, entity_type },
      version_impact: {
        versions_created: [record.version_id],
        versions_superseded: active ? [`${qKeyId}_v${active.version}`] : [],
      },
    })

    const status = active ? `v${active.version} → v${nextVersion}` : `v${nextVersion} (new)`
    console.log(`  ✓  ${topic}:${key} → ${status}`)
  } catch (err) {
    console.error(`  ✗  ${topic}:${key} → ${err.message}`)
  }
}

async function seed() {
  console.log('\n── Seeding Quorum knowledge ─────────────────────────────\n')

  if (await isAlreadySeeded()) {
    if (!FORCE) {
      console.log('  Already seeded — skipping. Pass --force to re-seed.\n')
      console.log('── Seed skipped ──────────────────────────────────────────\n')
      return
    }
    console.log('  --force: clearing existing seed data...')
    await clearSeedData()
    console.log('  Cleared. Re-seeding...\n')
  }

  // v0.3: seed data lives under the global project (q_p0)
  const Q_PROJECT_ID = 'q_p0'

  // auth:token-strategy — 3 versions to demonstrate history CLI
  console.log('auth domain...')

  await remember(Q_PROJECT_ID, {
    topic: 'auth',
    key: 'token-strategy',
    content: 'Use session tokens for all services. Session tokens allow revocation and work well for our monolithic application architecture.',
    author: 'junior-dev',
    confidence: 0.6,
    entity_type: 'Decision',
    tags: ['auth', 'session', 'tokens'],
  })

  await remember(Q_PROJECT_ID, {
    topic: 'auth',
    key: 'token-strategy',
    content: 'Use JWT for all services. JWTs are stateless, scalable, and work across all deployment types including serverless.',
    author: 'senior-architect',
    confidence: 0.85,
    reason: 'Lambda services do not support session tokens — stateless JWT required',
    entity_type: 'Decision',
    tags: ['auth', 'jwt', 'lambda'],
  })

  await remember(Q_PROJECT_ID, {
    topic: 'auth',
    key: 'token-strategy',
    content: 'Use JWT for Lambda-based services (payment-svc, notification-svc). Use session tokens for ECS-based internal services (auth-svc, admin-svc) where revocation is needed. The split follows deployment type, not service domain.',
    author: 'ayan',
    confidence: 0.9,
    reason: 'ADR-042 nuanced after Lambda constraint discovered in payment-svc — blanket JWT was too broad',
    entity_type: 'Decision',
    tags: ['auth', 'jwt', 'session', 'lambda', 'ecs', 'adr-042'],
  })

  await remember(Q_PROJECT_ID, {
    topic: 'auth',
    key: 'delegation-flow',
    content: 'Internal service-to-service auth uses mTLS with certificates issued by our internal CA. External-facing APIs use OAuth 2.0 client credentials. Never use API keys for service-to-service — they cannot be rotated without downtime.',
    author: 'senior-architect',
    confidence: 0.9,
    entity_type: 'Decision',
    tags: ['auth', 'mtls', 'oauth', 'service-to-service'],
  })

  await remember(Q_PROJECT_ID, {
    topic: 'auth',
    key: 'rate-limiting',
    content: 'Rate limiting is applied at the API gateway level, not per service. Limits: 100 req/s per authenticated user, 10 req/s for unauthenticated. Use sliding window algorithm. Exceeded limits return 429 with Retry-After header.',
    author: 'engineer',
    confidence: 0.8,
    entity_type: 'Constraint',
    tags: ['auth', 'rate-limiting', 'api-gateway'],
  })

  console.log('api domain...')

  await remember(Q_PROJECT_ID, {
    topic: 'api',
    key: 'error-standards',
    content: 'All API errors return JSON with shape: { error: { code: string, message: string, request_id: string } }. HTTP status codes follow RFC 7807. Never expose internal stack traces. Log errors server-side with request_id for correlation.',
    author: 'senior-architect',
    confidence: 0.95,
    entity_type: 'Pattern',
    tags: ['api', 'errors', 'rfc-7807'],
  })

  await remember(Q_PROJECT_ID, {
    topic: 'api',
    key: 'versioning',
    content: 'API versioning uses URL path prefix: /v1/, /v2/. Minor version changes (new optional fields) are backwards compatible and do not increment major version. Deprecation notice period is minimum 6 months. Breaking changes require new major version.',
    author: 'senior-architect',
    confidence: 0.9,
    entity_type: 'Decision',
    tags: ['api', 'versioning', 'deprecation'],
  })

  await remember(Q_PROJECT_ID, {
    topic: 'api',
    key: 'pagination',
    content: 'Use cursor-based pagination for all list endpoints. Response includes: { data: [], next_cursor: string | null, has_more: boolean }. Cursor is opaque — clients must not parse it. Max page size is 100. Default page size is 20.',
    author: 'engineer',
    confidence: 0.85,
    entity_type: 'Pattern',
    tags: ['api', 'pagination', 'cursor'],
  })

  console.log('db domain...')

  await remember(Q_PROJECT_ID, {
    topic: 'db',
    key: 'connection-pooling',
    content: 'PostgreSQL connection pool size: 10 connections per service instance. Pool per service, not per request. Use pg.Pool with idleTimeoutMillis: 30000. Never exceed 100 total connections across all instances — database max_connections is 200 with 100 reserved for admin.',
    author: 'senior-architect',
    confidence: 0.85,
    entity_type: 'Constraint',
    tags: ['db', 'postgresql', 'connection-pool'],
  })

  await remember(Q_PROJECT_ID, {
    topic: 'db',
    key: 'migration-strategy',
    content: 'Database migrations run automatically on service startup using node-pg-migrate. Migrations are append-only in development. Production migrations require: (1) backwards-compatible schema change, (2) code deploy, (3) cleanup migration if needed. Never DROP COLUMN in same release as code change.',
    author: 'senior-architect',
    confidence: 0.9,
    entity_type: 'Runbook',
    tags: ['db', 'migrations', 'postgresql'],
  })

  await remember(Q_PROJECT_ID, {
    topic: 'db',
    key: 'naming-conventions',
    content: 'Table names: snake_case plural (users, api_keys, audit_logs). Column names: snake_case. Primary keys: id (serial or uuid). Foreign keys: <table_singular>_id. Timestamps: created_at, updated_at (timestamptz). Boolean columns: is_ or has_ prefix.',
    author: 'engineer',
    confidence: 0.8,
    entity_type: 'Pattern',
    tags: ['db', 'naming', 'conventions'],
  })

  console.log('infra domain...')

  await remember(Q_PROJECT_ID, {
    topic: 'infra',
    key: 'secrets-management',
    content: 'Secrets are stored in AWS Secrets Manager. Never in environment variables committed to git. Never in .env files in production. Services retrieve secrets on startup via SDK — not via env injection. Secret rotation is automated via Lambda rotators. Rotation period: 90 days for API keys, 30 days for DB passwords.',
    author: 'senior-architect',
    confidence: 0.95,
    entity_type: 'Constraint',
    tags: ['infra', 'secrets', 'aws', 'security'],
  })

  await remember(Q_PROJECT_ID, {
    topic: 'infra',
    key: 'retry-strategy',
    content: 'Use exponential backoff with jitter for all external service calls. Base delay: 1s. Max delay: 30s. Max retries: 3. Jitter: ±20%. Do not retry on 4xx (client errors). Always retry on 5xx and connection timeouts. Implement circuit breaker at 50% failure rate over 1 minute window.',
    author: 'engineer',
    confidence: 0.8,
    entity_type: 'Pattern',
    tags: ['infra', 'retry', 'circuit-breaker', 'resilience'],
  })

  console.log('testing domain...')

  await remember(Q_PROJECT_ID, {
    topic: 'testing',
    key: 'unit-strategy',
    content: 'Unit test pure business logic — calculations, transformations, validations. Do not unit test framework wiring, trivial getters/setters, or code that only makes sense as integration. Coverage target: 80% on business logic files. Use Vitest. Mock at service boundaries, not inside services.',
    author: 'senior-engineer',
    confidence: 0.85,
    entity_type: 'Pattern',
    tags: ['testing', 'unit', 'vitest', 'coverage'],
  })

  await remember(Q_PROJECT_ID, {
    topic: 'testing',
    key: 'integration-scope',
    content: 'Integration tests run against real PostgreSQL and real Redis (via docker-compose in CI). Never mock the database — we burned a release when mocked tests passed but prod migration failed. API tests use real HTTP client against running server. External services (Stripe, AWS) are stubbed at the HTTP level only.',
    author: 'senior-engineer',
    confidence: 0.9,
    entity_type: 'Constraint',
    tags: ['testing', 'integration', 'postgresql', 'no-mocks'],
  })

  // Deliberate contradiction for conflict detection demo:
  // db:connection-pooling says pool size 10; this says 50 for batch services.
  console.log('\nAdding deliberate contradiction (conflict detection demo)...')

  await remember(Q_PROJECT_ID, {
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
  console.log('  node scripts/audit-cli.js stats')
  console.log('  node scripts/audit-cli.js lineage auth token-strategy\n')
}

seed()
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
  .finally(() => pool.end())
