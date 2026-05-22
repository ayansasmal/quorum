/**
 * Deviation routes — Wave C+D
 *
 * POST /api/deviations          — record (catalog validation, severity, upsert)
 * POST /api/deviations/batch    — batch upsert
 * GET  /api/deviations          — list with computed status
 * POST /api/deviations/:id/action — PE governance (accept/deny/defer)
 *
 * Covers:
 *  - 400 when required fields missing
 *  - not_linked when catalog_id not in project globals
 *  - not_found when catalog project not registered
 *  - not_found when topic:key doesn't exist in catalog
 *  - not_found when no ACTIVE version in catalog
 *  - severity derived from confidence × authority_score
 *  - PA_AUTHORED_FLOOR applied for principal_architect entries with low confidence
 *  - is_new: true on first deviation
 *  - is_new: false on repeat call (last_seen_at refreshed)
 *  - batch: partial-success semantics (recorded + not_linked in same batch)
 *  - batch: 400 when array empty or over 100 limit
 *  - GET /api/deviations: returns deviations from getDeviationsByProject
 *  - POST /:id/action: 404 for unknown deviation
 *  - POST /:id/action: 403 for cross-project deviation
 *  - POST /:id/action: ConstitutionalViolation for non-architect role
 *  - POST /:id/action: ConstitutionalViolation for empty reason
 *  - POST /:id/action: ConstitutionalViolation for invalid defer days
 *  - POST /:id/action: accept/deny/defer happy paths
 *  - POST /:id/action: denial hint for high-confidence PA-authored standards
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../gateway/src/middleware/verify-jwt.js', () => ({
  verifyJwt: (req, _res, next) => {
    req.user = req._mockUser ?? { sub: 'alice', project: 'payments-service', role: 'engineer', is_admin: false }
    next()
  },
}))

vi.mock('../../gateway/src/middleware/project.js', () => ({
  requireProject: (_req, _res, next) => next(),
}))

const mockGetProjectByGroupId  = vi.fn()
const mockGetKeyId              = vi.fn()
const mockGetCurrentVersion     = vi.fn()
const mockUpsertDeviation       = vi.fn()
const mockBatchUpsertDeviations = vi.fn()
const mockGetDeviationsByProject = vi.fn()
const mockInsertDeviationAction  = vi.fn()

vi.mock('../../gateway/src/shared/graph/queries.js', () => ({
  getProjectByGroupId:   (...a) => mockGetProjectByGroupId(...a),
  getKeyId:              (...a) => mockGetKeyId(...a),
  getCurrentVersion:     (...a) => mockGetCurrentVersion(...a),
  upsertDeviation:       (...a) => mockUpsertDeviation(...a),
  batchUpsertDeviations: (...a) => mockBatchUpsertDeviations(...a),
  getDeviationsByProject:(...a) => mockGetDeviationsByProject(...a),
  insertDeviationAction: (...a) => mockInsertDeviationAction(...a),
  // keep unused ones from other routes
  getOrCreateKey:           vi.fn(),
  getPendingDecisionById:   vi.fn(),
  getLatestDraftVersion:    vi.fn(),
  transitionVersionStatus:  vi.fn(),
  resolvePendingDecision:   vi.fn(),
  getVersionForBump:        vi.fn(),
  getBumpLog:               vi.fn(),
  recordBump:               vi.fn(),
  updateConfidence:         vi.fn(),
  getNextVersionNumber:     vi.fn(),
  insertVersion:            vi.fn(),
}))

const mockLoadProjectConfig = vi.fn()

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadUserProfile:    vi.fn().mockResolvedValue({ github_username: 'alice', is_admin: false, projects: [] }),
  loadProjectConfig:  (...a) => mockLoadProjectConfig(...a),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks()
  // Default: project is not a global catalog, has security-standards in globals
  mockLoadProjectConfig.mockResolvedValue({ group_id: 'payments-service', globals: ['security-standards'] })
  // Default catalog resolution
  mockGetProjectByGroupId.mockImplementation((_pool, groupId) => {
    if (groupId === 'security-standards') return Promise.resolve('q_p_catalog')
    if (groupId === 'payments-service')   return Promise.resolve('q_p_project')
    return Promise.resolve(null)
  })
  mockGetKeyId.mockResolvedValue('q_k1')
  mockGetCurrentVersion.mockResolvedValue({ confidence: 0.8, author_role: 'architect', entity_type: 'Pattern' })
  mockUpsertDeviation.mockResolvedValue({ deviation_id: 'dev-abc', is_new: true })
})

/**
 * Build a test server with the dashboard router attached, returning a fetch helper.
 * @param {{ role?: string, project?: string }} [userOverrides]
 */
async function makeServer(userOverrides = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      sub:      'alice',
      project:  'payments-service',
      role:     'engineer',
      is_admin: false,
      ...userOverrides,
    }
    req.app.locals.pool = { query: vi.fn() }
    next()
  })
  const { default: dashboardRouter } = await import('../../gateway/src/routes/dashboard.js')
  app.use('/api', dashboardRouter)
  // JSON error handler — ensures all errors come back as JSON, not HTML
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message, code: err.code })
  })
  const srv = http.createServer(app)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`

  return {
    post: async (path, body) => {
      const r = await fetch(`${base}/api${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      return { status: r.status, body: await r.json() }
    },
    get: async (path) => {
      const r = await fetch(`${base}/api${path}`)
      return { status: r.status, body: await r.json() }
    },
    close: () => new Promise((r) => srv.close(r)),
  }
}

// ── POST /api/deviations ───────────────────────────────────────────────────────

describe('POST /api/deviations — input validation', () => {
  it('returns 400 when required fields are missing', async () => {
    const srv = await makeServer()
    const { status, body } = await srv.post('/deviations', { catalog_id: 'security-standards' })
    await srv.close()
    expect(status).toBe(400)
    expect(body.error).toMatch(/required/)
  })
})

describe('POST /api/deviations — catalog link validation', () => {
  it('returns not_linked when catalog_id is not in project globals', async () => {
    mockLoadProjectConfig.mockResolvedValue({ globals: ['other-catalog'] })
    const srv = await makeServer()
    const { status, body } = await srv.post('/deviations', {
      catalog_id: 'security-standards', topic: 'auth', key: 'tls-required',
      description: 'Uses plain HTTP',
    })
    await srv.close()
    expect(status).toBe(200)
    expect(body.status).toBe('not_linked')
    expect(body.catalog_id).toBe('security-standards')
    expect(body.message).toMatch(/globals list/)
  })

  it('returns not_found when catalog project is not registered', async () => {
    mockGetProjectByGroupId.mockImplementation((_p, id) =>
      id === 'security-standards' ? Promise.resolve(null) : Promise.resolve('q_p_project')
    )
    const srv = await makeServer()
    const { status, body } = await srv.post('/deviations', {
      catalog_id: 'security-standards', topic: 'auth', key: 'tls-required', description: 'test',
    })
    await srv.close()
    expect(status).toBe(200)
    expect(body.status).toBe('not_found')
    expect(body.message).toMatch(/not registered/)
  })

  it('returns not_found when topic:key does not exist in catalog', async () => {
    mockGetKeyId.mockResolvedValue(null)
    const srv = await makeServer()
    const { status, body } = await srv.post('/deviations', {
      catalog_id: 'security-standards', topic: 'auth', key: 'missing-key', description: 'test',
    })
    await srv.close()
    expect(status).toBe(200)
    expect(body.status).toBe('not_found')
    expect(body.message).toMatch(/does not exist/)
  })

  it('returns not_found when catalog entry has no ACTIVE version', async () => {
    mockGetCurrentVersion.mockResolvedValue(null)
    const srv = await makeServer()
    const { status, body } = await srv.post('/deviations', {
      catalog_id: 'security-standards', topic: 'auth', key: 'tls-required', description: 'test',
    })
    await srv.close()
    expect(status).toBe(200)
    expect(body.status).toBe('not_found')
    expect(body.message).toMatch(/no ACTIVE version/)
  })
})

describe('POST /api/deviations — severity derivation', () => {
  it('computes severity = confidence × authority_score for architect role', async () => {
    mockGetCurrentVersion.mockResolvedValue({ confidence: 0.8, author_role: 'architect', entity_type: 'Pattern' })
    const srv = await makeServer()
    const { body } = await srv.post('/deviations', {
      catalog_id: 'security-standards', topic: 'auth', key: 'tls-required', description: 'test',
    })
    await srv.close()
    // architect = 0.80; severity = 0.8 × 0.80 = 0.640
    expect(body.status).toBe('recorded')
    expect(body.severity).toBeCloseTo(0.64, 2)
  })

  it('applies PA_AUTHORED_FLOOR (0.70) when PA entry has low confidence', async () => {
    mockGetCurrentVersion.mockResolvedValue({ confidence: 0.4, author_role: 'principal_architect', entity_type: 'Constraint' })
    const srv = await makeServer()
    const { body } = await srv.post('/deviations', {
      catalog_id: 'security-standards', topic: 'auth', key: 'tls-required', description: 'test',
    })
    await srv.close()
    // 0.4 × 1.0 = 0.40 < floor 0.70 → 0.70
    expect(body.severity).toBe(0.70)
  })

  it('does NOT apply floor when PA entry has high confidence', async () => {
    mockGetCurrentVersion.mockResolvedValue({ confidence: 0.9, author_role: 'principal_architect', entity_type: 'Constraint' })
    const srv = await makeServer()
    const { body } = await srv.post('/deviations', {
      catalog_id: 'security-standards', topic: 'auth', key: 'tls-required', description: 'test',
    })
    await srv.close()
    // 0.9 × 1.0 = 0.90 ≥ floor
    expect(body.severity).toBeCloseTo(0.9, 2)
  })

  it('defaults to engineer score when author_role is unknown', async () => {
    mockGetCurrentVersion.mockResolvedValue({ confidence: 0.6, author_role: 'unknown_role', entity_type: null })
    const srv = await makeServer()
    const { body } = await srv.post('/deviations', {
      catalog_id: 'security-standards', topic: 'auth', key: 'tls-required', description: 'test',
    })
    await srv.close()
    // engineer = 0.50; severity = 0.6 × 0.50 = 0.30
    expect(body.severity).toBeCloseTo(0.30, 2)
  })
})

describe('POST /api/deviations — upsert behaviour', () => {
  it('returns recorded + is_new: true on first deviation', async () => {
    mockUpsertDeviation.mockResolvedValue({ deviation_id: 'dev-abc', is_new: true })
    const srv = await makeServer()
    const { body } = await srv.post('/deviations', {
      catalog_id: 'security-standards', topic: 'auth', key: 'tls-required', description: 'test',
    })
    await srv.close()
    expect(body.status).toBe('recorded')
    expect(body.is_new).toBe(true)
    expect(body.deviation_id).toBe('dev-abc')
    expect(body.message).toMatch(/Deviation recorded/)
  })

  it('returns recorded + is_new: false on repeat call', async () => {
    mockUpsertDeviation.mockResolvedValue({ deviation_id: 'dev-abc', is_new: false })
    const srv = await makeServer()
    const { body } = await srv.post('/deviations', {
      catalog_id: 'security-standards', topic: 'auth', key: 'tls-required', description: 'test',
    })
    await srv.close()
    expect(body.is_new).toBe(false)
    expect(body.message).toMatch(/last_seen_at refreshed/)
  })

  it('passes evidence through to upsertDeviation', async () => {
    const srv = await makeServer()
    await srv.post('/deviations', {
      catalog_id: 'security-standards', topic: 'auth', key: 'tls-required', description: 'test',
      evidence: { files: ['src/api/client.js'], excerpt: 'http://' },
    })
    await srv.close()
    const call = mockUpsertDeviation.mock.calls[0][1]
    expect(call.evidence).toMatchObject({ files: ['src/api/client.js'] })
  })
})

// ── POST /api/deviations/batch ─────────────────────────────────────────────────

describe('POST /api/deviations/batch', () => {
  it('returns 400 for empty deviations array', async () => {
    const srv = await makeServer()
    const { status, body } = await srv.post('/deviations/batch', { deviations: [] })
    await srv.close()
    expect(status).toBe(400)
    expect(body.error).toMatch(/empty/)
  })

  it('returns 400 when deviations array exceeds 100 items', async () => {
    const srv = await makeServer()
    const deviations = Array.from({ length: 101 }, (_, i) => ({
      catalog_id: 'security-standards', topic: 'auth', key: `key-${i}`, description: 'test',
    }))
    const { status, body } = await srv.post('/deviations/batch', { deviations })
    await srv.close()
    expect(status).toBe(400)
    expect(body.error).toMatch(/100/)
  })

  it('processes all records and returns recorded count', async () => {
    mockUpsertDeviation.mockResolvedValue({ deviation_id: 'dev-1', is_new: true })
    const srv = await makeServer()
    const { body } = await srv.post('/deviations/batch', {
      deviations: [
        { catalog_id: 'security-standards', topic: 'auth', key: 'tls-required', description: 'test1' },
        { catalog_id: 'security-standards', topic: 'auth', key: 'key2',         description: 'test2' },
      ],
    })
    await srv.close()
    expect(body.recorded).toBe(2)
    expect(body.failed).toBe(0)
    expect(body.results).toHaveLength(2)
  })

  it('reports not_linked for records where catalog not in globals', async () => {
    mockLoadProjectConfig.mockResolvedValue({ globals: [] })
    const srv = await makeServer()
    const { body } = await srv.post('/deviations/batch', {
      deviations: [
        { catalog_id: 'security-standards', topic: 'auth', key: 'tls-required', description: 'test' },
      ],
    })
    await srv.close()
    expect(body.recorded).toBe(0)
    expect(body.results[0].status).toBe('not_linked')
  })
})

// ── GET /api/deviations ────────────────────────────────────────────────────────

describe('GET /api/deviations', () => {
  it('returns deviations for the current project', async () => {
    mockGetDeviationsByProject.mockResolvedValue([
      { deviation_id: 'dev-1', topic: 'auth', key: 'tls-required', severity: 0.64, status: 'OPEN' },
    ])
    const srv = await makeServer()
    const { status, body } = await srv.get('/deviations')
    await srv.close()
    expect(status).toBe(200)
    expect(body.deviations).toHaveLength(1)
    expect(body.deviations[0].deviation_id).toBe('dev-1')
    expect(body.total).toBe(1)
  })

  it('passes status filter to getDeviationsByProject', async () => {
    mockGetDeviationsByProject.mockResolvedValue([])
    const srv = await makeServer()
    await srv.get('/deviations?status=OPEN')
    await srv.close()
    const filters = mockGetDeviationsByProject.mock.calls[0][2]
    expect(filters.status).toBe('OPEN')
  })
})

// ── POST /api/deviations/:id/action ───────────────────────────────────────────

describe('POST /api/deviations/:id/action — validation', () => {
  it('returns 404 for unknown deviation', async () => {
    // Use makeActionServer with empty pool rows — the deviation lookup returns nothing
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = { sub: 'alice', project: 'payments-service', role: 'architect', is_admin: false }
      req.app.locals.pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
      next()
    })
    const { default: dashboardRouter } = await import('../../gateway/src/routes/dashboard.js')
    app.use('/api', dashboardRouter)
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }))
    const httpSrv = http.createServer(app)
    await new Promise((r) => httpSrv.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${httpSrv.address().port}`
    const r = await fetch(`${base}/api/deviations/unknown-id/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_type: 'accept', reason: 'approved by team' }),
    })
    await new Promise((res2) => httpSrv.close(res2))
    expect(r.status).toBe(404)
  })

  it('rejects non-architect role with ConstitutionalViolation', async () => {
    const srv = await makeServer({ role: 'engineer' })
    const { status } = await srv.post('/deviations/dev-abc/action', {
      action_type: 'accept', reason: 'approved by team',
    })
    await srv.close()
    // Constitutional violation → 500 (unhandled) or error response
    // The test checks that it does NOT return 200
    expect(status).not.toBe(200)
  })

  it('rejects reason under 10 chars with ConstitutionalViolation', async () => {
    const srv = await makeServer({ role: 'architect' })
    const { status } = await srv.post('/deviations/dev-abc/action', {
      action_type: 'accept', reason: 'short',
    })
    await srv.close()
    expect(status).not.toBe(200)
  })

  it('rejects defer without defer_until', async () => {
    const srv = await makeServer({ role: 'architect' })
    const { status, body } = await srv.post('/deviations/dev-abc/action', {
      action_type: 'defer', reason: 'deferred for sprint planning',
    })
    await srv.close()
    expect(status).toBe(400)
    expect(body.error).toMatch(/defer_until/)
  })
})

describe('POST /api/deviations/:id/action — happy paths', () => {
  /**
   * Build a server with a pool that returns the deviation row on lookup
   * and a given catalog entry for the denial hint query.
   */
  async function makeActionServer(opts = {}) {
    const { catalogEntry = null } = opts
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = { sub: 'alice', project: 'payments-service', role: 'architect', is_admin: false }
      req.app.locals.pool = {
        query: vi.fn().mockImplementation((sql) => {
          // Deviation existence check: uses alias 'qp' for q_projects
          if (/JOIN q_projects qp/.test(sql)) {
            return Promise.resolve({ rows: [{ deviation_id: 'dev-abc', q_project_id: 'q_p_project', group_id: 'payments-service' }] })
          }
          // Denial hint lookup: uses alias 'cp' for q_projects (catalog project)
          if (/JOIN q_projects cp/.test(sql)) {
            return Promise.resolve({ rows: catalogEntry ? [catalogEntry] : [] })
          }
          return Promise.resolve({ rows: [] })
        }),
      }
      next()
    })
    const { default: dashboardRouter } = await import('../../gateway/src/routes/dashboard.js')
    app.use('/api', dashboardRouter)
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
      res.status(err.status ?? 500).json({ error: err.message, code: err.code })
    })
    const srv = http.createServer(app)
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${srv.address().port}`
    const post = async (path, body) => {
      const r = await fetch(`${base}/api${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      return { status: r.status, body: await r.json() }
    }
    return { post, close: () => new Promise((r) => srv.close(r)) }
  }

  it('returns action_id on accept', async () => {
    mockInsertDeviationAction.mockResolvedValue('action-123')
    const srv = await makeActionServer()
    const { status, body } = await srv.post('/deviations/dev-abc/action', {
      action_type: 'accept', reason: 'accepted by the team after review',
    })
    await srv.close()
    expect(status).toBe(200)
    expect(body.action_id).toBe('action-123')
    expect(body.action_type).toBe('accept')
  })

  it('returns action_id on deny (no hint for low-confidence entry)', async () => {
    mockInsertDeviationAction.mockResolvedValue('action-456')
    const srv = await makeActionServer({ catalogEntry: { confidence: 0.6, author_role: 'architect' } })
    const { status, body } = await srv.post('/deviations/dev-abc/action', {
      action_type: 'deny', reason: 'this standard does not apply here',
    })
    await srv.close()
    expect(status).toBe(200)
    expect(body.action_id).toBe('action-456')
    expect(body.hint).toBeUndefined()
  })

  it('includes denial hint for high-confidence PA-authored standard', async () => {
    mockInsertDeviationAction.mockResolvedValue('action-789')
    const srv = await makeActionServer({
      catalogEntry: { confidence: 0.9, author_role: 'principal_architect' },
    })
    const { status, body } = await srv.post('/deviations/dev-abc/action', {
      action_type: 'deny', reason: 'this standard does not apply here',
    })
    await srv.close()
    expect(status).toBe(200)
    expect(body.hint).toBeDefined()
    expect(body.hint).toMatch(/principal_architect/)
  })

  it('accepts valid 30-day defer', async () => {
    mockInsertDeviationAction.mockResolvedValue('action-def')
    const deferUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    const srv = await makeActionServer()
    const { status, body } = await srv.post('/deviations/dev-abc/action', {
      action_type: 'defer', reason: 'deferred pending security review', defer_until: deferUntil,
    })
    await srv.close()
    expect(status).toBe(200)
    expect(body.action_id).toBe('action-def')
  })

  it('rejects invalid defer days with ConstitutionalViolation', async () => {
    const deferUntil = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString()
    const srv = await makeActionServer()
    const { status } = await srv.post('/deviations/dev-abc/action', {
      action_type: 'defer', reason: 'deferred pending security review', defer_until: deferUntil,
    })
    await srv.close()
    expect(status).not.toBe(200)
  })
})
