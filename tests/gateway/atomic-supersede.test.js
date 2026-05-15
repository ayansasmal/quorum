/**
 * Gateway: POST /pg/versions/supersede — Gap 3 atomic supersession.
 *
 * Verifies the new atomic-supersession route inserts the new version and
 * transitions the old version to SUPERSEDED inside a single PostgreSQL
 * transaction, closing the race window where two ACTIVE rows could coexist
 * for the same topic:key.
 *
 * Patterns:
 *   - Real Express HTTP server on a random port
 *   - Mocked verify-jwt middleware to inject req.user
 *   - Fake pg.Pool with a transaction-capable client.query mock
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../gateway/src/middleware/verify-jwt.js', () => ({
  verifyJwt: (req, _res, next) => {
    req.user = req._injectedUser ?? { sub: 'alice', project: 'test-project', role: 'engineer', is_admin: false }
    next()
  },
}))

// The route uses shared queries for some helpers but supersede route uses
// pool.connect()/client.query directly — mock queries to be safe.
vi.mock('../../gateway/src/shared/graph/queries.js', () => ({
  getCurrentVersion:      vi.fn(),
  getVersionHistory:      vi.fn(),
  getVersionAtDate:       vi.fn(),
  getNextVersionNumber:   vi.fn(),
  getSpecificVersion:     vi.fn(),
  insertVersion:          vi.fn(),
  transitionVersionStatus: vi.fn(),
  insertVersionAuditLink: vi.fn(),
  getVersionsByTag:       vi.fn(),
  getLatestDraftVersion:  vi.fn(),
  getVersionsByStatus:    vi.fn(),
  getVersionStatusCounts: vi.fn(),
  getDraftVersions:       vi.fn(),
  getPendingDecisionById: vi.fn(),
  resolvePendingDecision: vi.fn(),
}))

vi.mock('../../gateway/src/shared/audit/secondary.js', () => ({
  writeAuditEntry: vi.fn(),
  getAuditEntry:   vi.fn(),
  getAllEntries:    vi.fn(),
  countEntries:    vi.fn(),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import pgRoutes from '../../gateway/src/routes/pg.js'

// ── Test server ────────────────────────────────────────────────────────────────

let server
let port

/**
 * Build a fake pool with a controllable client. The client.query mock can be
 * inspected to verify transaction calls (BEGIN/INSERT/UPDATE/COMMIT).
 * @param {(sql: string, params?: unknown[]) => { rowCount: number, rows: unknown[] }} queryImpl
 */
function makePool(queryImpl) {
  const client = {
    query: vi.fn(queryImpl),
    release: vi.fn(),
  }
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn(),
    _client: client,
  }
  return pool
}

let currentPool

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  // Allow tests to override the injected user per-request
  if (req.headers['x-test-no-project']) {
    req._injectedUser = { sub: 'alice', role: 'engineer', is_admin: false } // no project
  }
  next()
})
app.use((req, _res, next) => { req.app.locals.pool = currentPool; next() })
app.use('/pg', pgRoutes)

beforeAll(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  vi.clearAllMocks()
})

// ── HTTP helper ────────────────────────────────────────────────────────────────

function postJson(path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...extraHeaders,
    }

    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => {
          try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }) }
          catch { resolve({ status: res.statusCode, body: raw }) }
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ── Test cases ────────────────────────────────────────────────────────────────

const validNewVersion = {
  topic: 'auth',
  key: 'token-strategy',
  version: 2,
  status: 'ACTIVE',
  content_hash: 'abc123',
  author: 'alice',
  author_role: 'engineer',
  confidence: 0.8,
  starting_confidence: 0.8,
  created_at: new Date().toISOString(),
  created_by_audit: 'audit_001',
  triggered_by: 'engineer_decision',
  graphiti_episode_id: 'ep_002',
  supersedes_version: 1,
  supersedes_reason: 'switching to JWT',
  tags: ['auth'],
  entity_type: 'Decision',
  content: 'Use JWT',
}

describe('POST /pg/versions/supersede — atomic supersession', () => {
  it('runs INSERT and UPDATE in a single transaction (happy path)', async () => {
    currentPool = makePool((_sql, _params) => ({ rowCount: 1, rows: [] }))

    const { status, body } = await postJson('/pg/versions/supersede', {
      new_version: validNewVersion,
      supersedes_version: 1,
      supersedes_reason: 'switching to JWT',
      forward_link: { supersededByVersion: 2, supersededByAuthor: 'alice' },
    })

    expect(status).toBe(200)
    expect(body).toMatchObject({
      inserted: true,
      superseded_version: 1,
      rows_updated: 1,
    })

    const calls = currentPool._client.query.mock.calls.map((c) => c[0])
    // Transaction wrapping
    expect(calls[0]).toMatch(/BEGIN/i)
    expect(calls[calls.length - 1]).toMatch(/COMMIT/i)

    // INSERT present
    const insertCall = currentPool._client.query.mock.calls.find((c) => /INSERT INTO knowledge_versions/i.test(c[0]))
    expect(insertCall).toBeDefined()

    // UPDATE to SUPERSEDED present
    const updateCall = currentPool._client.query.mock.calls.find((c) => /UPDATE knowledge_versions/i.test(c[0]))
    expect(updateCall).toBeDefined()
    const updateParams = updateCall[1]
    expect(updateParams).toContain('SUPERSEDED')
    expect(updateParams).toContain('ACTIVE')         // guard on old row
    expect(updateParams).toContain('test-project')   // project_id scoping
    expect(updateParams).toContain(1)                // supersedes_version

    // Client released
    expect(currentPool._client.release).toHaveBeenCalled()
  })

  it('returns 200 with rows_updated:0 when old row is already superseded', async () => {
    // First call (BEGIN), second (INSERT), third (UPDATE with rowCount 0), fourth (COMMIT)
    let callIdx = 0
    currentPool = makePool((sql) => {
      callIdx += 1
      if (/UPDATE knowledge_versions/i.test(sql)) return { rowCount: 0, rows: [] }
      return { rowCount: 1, rows: [] }
    })

    const { status, body } = await postJson('/pg/versions/supersede', {
      new_version: validNewVersion,
      supersedes_version: 1,
      supersedes_reason: 'switching to JWT',
      forward_link: { supersededByVersion: 2, supersededByAuthor: 'alice' },
    })

    expect(status).toBe(200)
    expect(body.inserted).toBe(true)
    expect(body.rows_updated).toBe(0)
    expect(body.superseded_version).toBe(1)
    expect(callIdx).toBeGreaterThan(0)
  })

  it('returns 400 when new_version is missing', async () => {
    currentPool = makePool(() => ({ rowCount: 1, rows: [] }))

    const { status, body } = await postJson('/pg/versions/supersede', {
      supersedes_version: 1,
      supersedes_reason: 'switching to JWT',
      forward_link: null,
    })

    expect(status).toBe(400)
    expect(body.error).toBeTruthy()
  })

  it('returns 400 when supersedes_version is missing', async () => {
    currentPool = makePool(() => ({ rowCount: 1, rows: [] }))

    const { status, body } = await postJson('/pg/versions/supersede', {
      new_version: validNewVersion,
      supersedes_reason: 'switching to JWT',
      forward_link: null,
    })

    expect(status).toBe(400)
    expect(body.error).toBeTruthy()
  })

  it('returns 400 when project context is missing', async () => {
    currentPool = makePool(() => ({ rowCount: 1, rows: [] }))

    const { status } = await postJson(
      '/pg/versions/supersede',
      {
        new_version: validNewVersion,
        supersedes_version: 1,
        supersedes_reason: 'switching',
        forward_link: null,
      },
      { 'x-test-no-project': '1' },
    )

    expect(status).toBe(400)
  })
})
