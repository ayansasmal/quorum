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

// The supersede route delegates the INSERT and status transition to
// insertVersion() and transitionVersionStatus() inside a single transaction.
// Mock both so the test can assert on their calls.
vi.mock('../../gateway/src/shared/graph/queries.js', () => ({
  getProjectByGroupId:    vi.fn().mockResolvedValue('q_p1'),
  getOrCreateKey:         vi.fn().mockResolvedValue('q_k1'),
  getCurrentVersion:      vi.fn(),
  getVersionHistory:      vi.fn(),
  getVersionAtDate:       vi.fn(),
  getNextVersionNumber:   vi.fn(),
  getSpecificVersion:     vi.fn(),
  insertVersion:          vi.fn().mockResolvedValue({ version_id: 'q_k1_v2' }),
  transitionVersionStatus: vi.fn().mockResolvedValue({ version_id: 'q_k1_v1', status: 'SUPERSEDED' }),
  insertVersionAuditLink: vi.fn(),
  getVersionsByTag:       vi.fn(),
  getLatestDraftVersion:  vi.fn(),
  getVersionsByStatus:    vi.fn(),
  getVersionStatusCounts: vi.fn(),
  getDraftVersions:       vi.fn(),
  getPendingDecisionById: vi.fn(),
  countPendingForKey:     vi.fn(),
  resolvePendingDecision: vi.fn(),
  incrementDomainStat:    vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../gateway/src/shared/audit/secondary.js', () => ({
  writeAuditEntry: vi.fn(),
  getAuditEntry:   vi.fn(),
  getAllEntries:    vi.fn(),
  countEntries:    vi.fn(),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import {
  insertVersion,
  transitionVersionStatus,
} from '../../gateway/src/shared/graph/queries.js'
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
  summary: 'Use JWT',
}

describe('POST /pg/versions/supersede — atomic supersession', () => {
  it('runs insertVersion and transitionVersionStatus in a single transaction (happy path)', async () => {
    currentPool = makePool((_sql, _params) => ({ rowCount: 1, rows: [] }))

    const { status, body } = await postJson('/pg/versions/supersede', {
      new_version: validNewVersion,
      supersedes_version: 1,
      supersedes_reason: 'switching to JWT',
      forward_link: { version: 2, author: 'alice' },
    })

    expect(status).toBe(200)
    expect(body).toMatchObject({
      inserted: true,
      superseded_version: 1,
      rows_updated: 1,
    })

    const calls = currentPool._client.query.mock.calls.map((c) => c[0])
    // Transaction wrapping is still done on the client
    expect(calls[0]).toMatch(/BEGIN/i)
    expect(calls[calls.length - 1]).toMatch(/COMMIT/i)

    // insertVersion called with the client (not pool) and the new q_* identifiers
    expect(insertVersion).toHaveBeenCalledWith(
      currentPool._client,
      expect.objectContaining({
        version_id:   'q_k1_v2',
        q_key_id:     'q_k1',
        q_project_id: 'q_p1',
        version:      2,
      }),
    )

    // transitionVersionStatus called with the old version_id and SUPERSEDED
    expect(transitionVersionStatus).toHaveBeenCalledWith(
      currentPool._client,
      'q_k1_v1',
      'SUPERSEDED',
      expect.objectContaining({ version: 2, author: 'alice' }),
    )

    // Client released
    expect(currentPool._client.release).toHaveBeenCalled()
  })

  it('returns 200 with rows_updated:0 when transitionVersionStatus reports no row updated', async () => {
    // Simulate concurrent supersession — old row already gone from ACTIVE
    transitionVersionStatus.mockResolvedValueOnce(null)
    currentPool = makePool(() => ({ rowCount: 1, rows: [] }))

    const { status, body } = await postJson('/pg/versions/supersede', {
      new_version: validNewVersion,
      supersedes_version: 1,
      supersedes_reason: 'switching to JWT',
      forward_link: { version: 2, author: 'alice' },
    })

    expect(status).toBe(200)
    expect(body.inserted).toBe(true)
    expect(body.rows_updated).toBe(0)
    expect(body.superseded_version).toBe(1)
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
