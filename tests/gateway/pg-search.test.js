/**
 * Gateway pg search route — keyword ILIKE fallback.
 *
 * Verifies GET /pg/search behaviour used by the MCP search tool when
 * Graphiti returns 0 results. Scoped by req.user.project (from JWT);
 * excludes DRAFT/DEPRECATED/REJECTED statuses.
 *
 * Guards:
 *   - GET /pg/search?q=auth                       → matching rows
 *   - GET /pg/search?q=auth&domain=api            → topic filter applied
 *   - GET /pg/search?q=auth&limit=3               → LIMIT respected
 *   - GET /pg/search                              → 400 missing q
 *   - GET /pg/search?q=auth (no project header)   → 400 missing project
 *   - excluded statuses                           → not returned (SQL guard)
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Project header is read from req.user.project — toggle via mutable flag so we
// can simulate the missing-project case in one test.
let _includeProject = true

vi.mock('../../gateway/src/middleware/verify-jwt.js', () => ({
  verifyJwt: (req, _res, next) => {
    req.user = _includeProject
      ? { sub: 'alice', project: 'test-project', role: 'engineer', is_admin: false }
      : { sub: 'alice', role: 'engineer', is_admin: false }
    next()
  },
}))

vi.mock('../../gateway/src/shared/graph/queries.js', () => ({
  getProjectByGroupId:    vi.fn().mockResolvedValue('q_p1'),
  getOrCreateKey:         vi.fn().mockResolvedValue('q_k1'),
  getCurrentVersion:      vi.fn().mockResolvedValue(null),
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
  countPendingForKey:     vi.fn(),
}))

vi.mock('../../gateway/src/shared/audit/secondary.js', () => ({
  writeAuditEntry: vi.fn(),
  getAuditEntry:   vi.fn(),
  getAllEntries:   vi.fn(),
  countEntries:    vi.fn(),
}))

import pgRoutes from '../../gateway/src/routes/pg.js'

// ── Test server ────────────────────────────────────────────────────────────────

let server
let port
const fakePool = { query: vi.fn() }

const app = express()
app.use(express.json())
app.locals.pool = fakePool
app.use('/pg', pgRoutes)

beforeAll(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  port = server.address().port
})

afterAll(() => server.close())

beforeEach(() => {
  vi.clearAllMocks()
  fakePool.query.mockReset()
  _includeProject = true
})

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let raw = ''
        res.on('data', (c) => { raw += c })
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }) }
          catch { resolve({ status: res.statusCode, body: raw }) }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /pg/search', () => {
  it('returns matching rows from knowledge_versions', async () => {
    const rows = [
      { topic: 'auth', key: 'token-strategy', summary: 'use JWT', status: 'ACTIVE', confidence: 0.9, author: 'alice', updated_at: '2026-05-15T00:00:00Z' },
      { topic: 'auth', key: 'session-ttl',    summary: '1h ttl',  status: 'ACTIVE', confidence: 0.8, author: 'bob',   updated_at: '2026-05-14T00:00:00Z' },
    ]
    fakePool.query.mockResolvedValue({ rows })

    const { status, body } = await get('/pg/search?q=auth')

    expect(status).toBe(200)
    expect(body).toHaveProperty('results')
    expect(body.results).toHaveLength(2)
    expect(body.total).toBe(2)
    expect(body.source).toBe('postgres-ilike')
    expect(body.results[0].topic).toBe('auth')

    // SQL was called with q_project_id ($1) and the ILIKE pattern ($2)
    const callArgs = fakePool.query.mock.calls[0]
    expect(callArgs[1][0]).toBe('q_p1')
    expect(callArgs[1][1]).toBe('%auth%')
  })

  it('applies topic filter when domain is provided', async () => {
    fakePool.query.mockResolvedValue({ rows: [] })

    await get('/pg/search?q=auth&domain=api')

    const [sql, params] = fakePool.query.mock.calls[0]
    expect(sql).toMatch(/AND topic = \$3/)
    // params: [q_project_id, pattern, domain, limit]
    expect(params).toEqual(['q_p1', '%auth%', 'api', 10])
  })

  it('respects the limit param', async () => {
    fakePool.query.mockResolvedValue({ rows: [] })

    await get('/pg/search?q=auth&limit=3')

    const [, params] = fakePool.query.mock.calls[0]
    // limit is the last bound parameter
    expect(params[params.length - 1]).toBe(3)
  })

  it('returns 400 when q is missing', async () => {
    const { status, body } = await get('/pg/search')
    expect(status).toBe(400)
    expect(body.error).toBe('missing_param')
    expect(fakePool.query).not.toHaveBeenCalled()
  })

  it('returns 400 when X-Quorum-Project is missing', async () => {
    _includeProject = false
    const { status } = await get('/pg/search?q=auth')
    // The shared middleware rejects with 400 when req.user.project is unset
    expect(status).toBe(400)
    expect(fakePool.query).not.toHaveBeenCalled()
  })

  it('SQL excludes DRAFT/DEPRECATED/REJECTED statuses', async () => {
    fakePool.query.mockResolvedValue({ rows: [] })

    await get('/pg/search?q=auth')

    const [sql] = fakePool.query.mock.calls[0]
    expect(sql).toMatch(/status NOT IN \('DRAFT','DEPRECATED','REJECTED'\)/)
  })
})
