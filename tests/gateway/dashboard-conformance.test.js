/**
 * Conformance + portfolio routes — Wave E+F
 *
 * GET /api/conformance   — project scorecard (UNCERTIFIED gate, CERTIFIED score, catalogs)
 * GET /api/portfolio     — portfolio view (role gate, project list, weighted rollup)
 *
 * Covers:
 *  - UNCERTIFIED when project has no linked globals
 *  - UNCERTIFIED propagated from getConformanceScore
 *  - CERTIFIED: score, breakdown, catalogs
 *  - per-catalog entry counts populated from pool.query
 *  - portfolio: 403 for non-executive role
 *  - portfolio: returns all projects with scores
 *  - portfolio: node_id filter (hierarchy.parent match)
 *  - portfolio: weighted rollup over CERTIFIED children
 *  - portfolio: rollup is null when no projects
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../gateway/src/middleware/verify-jwt.js', () => ({
  verifyJwt: vi.fn((_req, _res, next) => next()),
}))

vi.mock('../../gateway/src/middleware/project.js', () => ({
  requireProject: (_req, _res, next) => next(),
}))

const mockGetProjectByGroupId   = vi.fn()
const mockGetConformanceScore   = vi.fn()
const mockGetPortfolioScores    = vi.fn()

vi.mock('../../gateway/src/shared/graph/queries.js', () => ({
  getProjectByGroupId:   (...a) => mockGetProjectByGroupId(...a),
  getConformanceScore:   (...a) => mockGetConformanceScore(...a),
  getPortfolioScores:    (...a) => mockGetPortfolioScores(...a),
  // Stubs for routes this file doesn't test
  getCurrentVersion:           vi.fn(),
  getOrCreateKey:              vi.fn(),
  getPendingDecisionById:      vi.fn(),
  getLatestDraftVersion:       vi.fn(),
  transitionVersionStatus:     vi.fn(),
  resolvePendingDecision:      vi.fn(),
  getVersionForBump:           vi.fn(),
  getBumpLog:                  vi.fn(),
  recordBump:                  vi.fn(),
  updateConfidence:            vi.fn(),
  getNextVersionNumber:        vi.fn(),
  insertVersion:               vi.fn(),
  getKeyId:                    vi.fn(),
  upsertDeviation:             vi.fn(),
  batchUpsertDeviations:       vi.fn(),
  getDeviationsByProject:      vi.fn(),
  insertDeviationAction:       vi.fn(),
}))

const mockLoadProjectConfig = vi.fn()

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadProjectConfig: (...a) => mockLoadProjectConfig(...a),
}))

vi.mock('../../gateway/src/shared/audit/secondary.js', () => ({
  writeAuditEntry: vi.fn(),
}))

vi.mock('../../gateway/src/shared/graph/client.js', () => ({
  searchNodes: vi.fn().mockResolvedValue([]),
  searchFacts: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../gateway/src/shared/governance/constitutional.js', () => ({
  enforceNoSelfApproval:           vi.fn(),
  enforceReasonRequired:           vi.fn(),
  enforceDeviationActionAuthority: vi.fn(),
  enforceValidDeferDeadline:       vi.fn(),
}))

vi.mock('../../gateway/src/shared/graph/validate.js', () => ({
  validateKnowledgeInput: vi.fn(),
  ValidationError:        class ValidationError extends Error { constructor(msg) { super(msg); this.status = 422 } },
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import dashboardRouter from '../../gateway/src/routes/dashboard.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

const UNCERTIFIED_SCORE = {
  score: null, status: 'UNCERTIFIED', applicable_entries: 0,
  scan_count: 0, last_scan_at: null,
  breakdown: { open: 0, accepted: 0, denied: 0, deferred: 0, overdue: 0, resolved: 0 },
}

const CERTIFIED_SCORE = {
  score: 82, status: 'CERTIFIED', applicable_entries: 15,
  scan_count: 3, last_scan_at: '2026-05-01T10:00:00Z',
  breakdown: { open: 1, accepted: 2, denied: 0, deferred: 1, overdue: 0, resolved: 3 },
}

/**
 * Build an Express test app with a mock pool.
 * @param {{ role?: string, is_admin?: boolean, project?: string }} [userOpts]
 * @param {{ query?: Function }} [poolOpts]
 */
function makeServer(userOpts = {}, poolOpts = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      sub: 'alice', project: userOpts.project ?? 'payments-service',
      role: userOpts.role ?? 'architect', is_admin: userOpts.is_admin ?? false,
    }
    next()
  })

  const mockPool = {
    query: poolOpts.query ?? vi.fn().mockResolvedValue({ rows: [] }),
  }
  app.locals.pool = mockPool
  app.use('/api', dashboardRouter)
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message, code: err.code })
  })
  return app
}

async function request(app, method, path, body) {
  const { default: http } = await import('node:http')
  return new Promise((resolve) => {
    const server = http.createServer(app)
    server.listen(0, () => {
      const port = server.address().port
      const opts = {
        hostname: '127.0.0.1', port,
        path, method,
        headers: { 'Content-Type': 'application/json' },
      }
      const req = http.request(opts, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          server.close()
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }) }
          catch { resolve({ status: res.statusCode, body }) }
        })
      })
      if (body) req.write(JSON.stringify(body))
      req.end()
    })
  })
}

// ── GET /api/conformance ───────────────────────────────────────────────────────

describe('GET /api/conformance', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockGetProjectByGroupId.mockResolvedValue('q_p1')
  })

  it('returns UNCERTIFIED when project has no linked globals', async () => {
    mockLoadProjectConfig.mockResolvedValue({ globals: [] })
    mockGetConformanceScore.mockResolvedValue({ ...UNCERTIFIED_SCORE })

    const app = makeServer()
    const { status, body } = await request(app, 'GET', '/api/conformance')

    expect(status).toBe(200)
    expect(body.status).toBe('UNCERTIFIED')
    expect(body.score).toBeNull()
    expect(body.catalogs).toEqual([])
  })

  it('propagates UNCERTIFIED when getConformanceScore returns UNCERTIFIED', async () => {
    mockLoadProjectConfig.mockResolvedValue({ globals: ['security-standards'] })
    mockGetConformanceScore.mockResolvedValue({ ...UNCERTIFIED_SCORE, applicable_entries: 5 })

    const mockQuery = vi.fn().mockResolvedValue({ rows: [
      { catalog_id: 'security-standards', entry_count: 5 },
    ]})
    const app = makeServer({}, { query: mockQuery })
    const { status, body } = await request(app, 'GET', '/api/conformance')

    expect(status).toBe(200)
    expect(body.status).toBe('UNCERTIFIED')
  })

  it('returns CERTIFIED score with breakdown and catalogs', async () => {
    mockLoadProjectConfig.mockResolvedValue({ globals: ['security-standards', 'payments-compliance'] })
    mockGetConformanceScore.mockResolvedValue({ ...CERTIFIED_SCORE })

    const mockQuery = vi.fn().mockResolvedValue({ rows: [
      { catalog_id: 'security-standards',   entry_count: 10 },
      { catalog_id: 'payments-compliance',  entry_count:  5 },
    ]})
    const app = makeServer({}, { query: mockQuery })
    const { status, body } = await request(app, 'GET', '/api/conformance')

    expect(status).toBe(200)
    expect(body.score).toBe(82)
    expect(body.status).toBe('CERTIFIED')
    expect(body.breakdown.open).toBe(1)
    expect(body.catalogs).toHaveLength(2)
    expect(body.catalogs[0]).toMatchObject({ catalog_id: 'security-standards', entry_count: 10 })
  })

  it('passes globals to getConformanceScore', async () => {
    const globals = ['security-standards']
    mockLoadProjectConfig.mockResolvedValue({ globals })
    mockGetConformanceScore.mockResolvedValue({ ...UNCERTIFIED_SCORE })

    const app = makeServer()
    await request(app, 'GET', '/api/conformance')

    expect(mockGetConformanceScore).toHaveBeenCalledWith(
      expect.anything(), 'q_p1', globals,
    )
  })

  it('returns 404 when project not registered', async () => {
    mockGetProjectByGroupId.mockResolvedValue(null)
    const app = makeServer()
    const { status } = await request(app, 'GET', '/api/conformance')
    expect(status).toBe(404)
  })
})

// ── GET /api/portfolio ─────────────────────────────────────────────────────────

describe('GET /api/portfolio', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 403 for non-executive engineer role', async () => {
    const app = makeServer({ role: 'engineer' })
    const { status, body } = await request(app, 'GET', '/api/portfolio')
    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('returns 403 for senior_engineer role', async () => {
    const app = makeServer({ role: 'senior_engineer' })
    const { status } = await request(app, 'GET', '/api/portfolio')
    expect(status).toBe(403)
  })

  it('is_admin bypasses role gate', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] })
    mockLoadProjectConfig.mockResolvedValue({})
    mockGetPortfolioScores.mockResolvedValue([])

    const app = makeServer({ role: 'engineer', is_admin: true }, { query: mockQuery })
    const { status, body } = await request(app, 'GET', '/api/portfolio')
    expect(status).toBe(200)
    expect(body.projects).toEqual([])
    expect(body.rollup).toBeNull()
  })

  it('allows principal_architect role', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] })
    mockLoadProjectConfig.mockResolvedValue({})
    mockGetPortfolioScores.mockResolvedValue([])

    const app = makeServer({ role: 'principal_architect' }, { query: mockQuery })
    const { status } = await request(app, 'GET', '/api/portfolio')
    expect(status).toBe(200)
  })

  it('allows director role', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] })
    mockLoadProjectConfig.mockResolvedValue({})
    mockGetPortfolioScores.mockResolvedValue([])

    const app = makeServer({ role: 'director' }, { query: mockQuery })
    const { status } = await request(app, 'GET', '/api/portfolio')
    expect(status).toBe(200)
  })

  it('returns projects list with rollup', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [
        { q_project_id: 'q_p1', group_id: 'payments-service' },
        { q_project_id: 'q_p2', group_id: 'auth-service' },
      ],
    })
    mockLoadProjectConfig.mockResolvedValue({ globals: [], hierarchy: { criticality: 2 } })
    mockGetPortfolioScores.mockResolvedValue([
      { groupId: 'payments-service', qProjectId: 'q_p1', displayName: 'Payments', hierarchyLevel: 'service',
        criticality: 2, score: 90, status: 'CERTIFIED',
        breakdown: { open: 0, accepted: 1, denied: 0, deferred: 0, overdue: 0, resolved: 0 },
        scan_count: 1, last_scan_at: '2026-05-01T00:00:00Z' },
      { groupId: 'auth-service', qProjectId: 'q_p2', displayName: 'Auth', hierarchyLevel: 'service',
        criticality: 1, score: 60, status: 'CERTIFIED',
        breakdown: { open: 2, accepted: 0, denied: 0, deferred: 0, overdue: 0, resolved: 0 },
        scan_count: 2, last_scan_at: '2026-05-02T00:00:00Z' },
    ])

    const app = makeServer({ role: 'principal_architect' }, { query: mockQuery })
    const { status, body } = await request(app, 'GET', '/api/portfolio')

    expect(status).toBe(200)
    expect(body.projects).toHaveLength(2)
    expect(body.projects[0].group_id).toBe('payments-service')
    expect(body.projects[0].score).toBe(90)

    // Weighted rollup: (90×2 + 60×1) / (2+1) = 240/3 = 80
    expect(body.rollup).toBeTruthy()
    expect(body.rollup.score).toBe(80)
    expect(body.rollup.status).toBe('CERTIFIED')
    expect(body.rollup.certified_count).toBe(2)
    expect(body.rollup.uncertified_count).toBe(0)
  })

  it('rollup is null when no projects returned', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] })
    mockLoadProjectConfig.mockResolvedValue({})
    mockGetPortfolioScores.mockResolvedValue([])

    const app = makeServer({ role: 'principal_architect' }, { query: mockQuery })
    const { status, body } = await request(app, 'GET', '/api/portfolio')
    expect(status).toBe(200)
    expect(body.rollup).toBeNull()
  })

  it('node_id filter excludes projects whose hierarchy.parent does not match', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [
        { q_project_id: 'q_p1', group_id: 'payments-service' },
        { q_project_id: 'q_p2', group_id: 'auth-service' },
      ],
    })
    // payments-service is child of payments-dept; auth-service is child of platform-dept
    mockLoadProjectConfig.mockImplementation((groupId) => {
      if (groupId === 'payments-service') return Promise.resolve({ globals: [], hierarchy: { parent: 'payments-dept', criticality: 1 } })
      return Promise.resolve({ globals: [], hierarchy: { parent: 'platform-dept', criticality: 1 } })
    })
    mockGetPortfolioScores.mockResolvedValue([
      { groupId: 'payments-service', qProjectId: 'q_p1', displayName: 'Payments',
        hierarchyLevel: 'service', criticality: 1, score: 70, status: 'CERTIFIED',
        breakdown: {}, scan_count: 1, last_scan_at: null },
    ])

    const app = makeServer({ role: 'principal_architect' }, { query: mockQuery })
    const { status, body } = await request(app, 'GET', '/api/portfolio?node_id=payments-dept')
    expect(status).toBe(200)
    // Only payments-service passed the filter
    expect(mockGetPortfolioScores).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.objectContaining({ groupId: 'payments-service' })]),
    )
    expect(mockGetPortfolioScores).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.objectContaining({ groupId: 'auth-service' })]),
    )
  })

  it('UNCERTIFIED children excluded from rollup, counted separately', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{ q_project_id: 'q_p1', group_id: 'svc-a' }],
    })
    mockLoadProjectConfig.mockResolvedValue({ globals: [] })
    mockGetPortfolioScores.mockResolvedValue([
      { groupId: 'svc-a', qProjectId: 'q_p1', displayName: 'Svc A',
        hierarchyLevel: null, criticality: 1, score: null, status: 'UNCERTIFIED',
        breakdown: {}, scan_count: 0, last_scan_at: null },
    ])

    const app = makeServer({ role: 'director' }, { query: mockQuery })
    const { status, body } = await request(app, 'GET', '/api/portfolio')
    expect(status).toBe(200)
    expect(body.rollup.score).toBeNull()
    expect(body.rollup.status).toBe('UNCERTIFIED')
    expect(body.rollup.uncertified_count).toBe(1)
    expect(body.rollup.certified_count).toBe(0)
  })
})
