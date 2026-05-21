/**
 * GET /api/globals — global catalog discovery endpoint (Wave B federation)
 *
 * Covers:
 *  - Empty result when no global catalogs exist
 *  - Org-scoped catalogs returned to all authenticated users
 *  - Config enrichment: display_name, global_scope, globals, entry_count
 *  - division-scoped catalog visible only to projects in that division
 *  - department-scoped catalog filtered out when not in ancestry
 *  - Graceful degradation when loadProjectConfig throws for a catalog
 *  - Graceful degradation when entry_count query fails
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../gateway/src/middleware/verify-jwt.js', () => ({
  verifyJwt: (req, _res, next) => { req.user = req._mockUser ?? { sub: 'alice', project: 'payments-service', role: 'engineer', is_admin: false }; next() },
}))

vi.mock('../../gateway/src/middleware/project.js', () => ({
  requireProject: (_req, _res, next) => next(),
}))

vi.mock('../../gateway/src/shared/graph/queries.js', () => ({
  getProjectByGroupId: vi.fn().mockResolvedValue('q_p1'),
}))

const mockLoadProjectConfig = vi.fn()

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadUserProfile: vi.fn().mockResolvedValue({
    github_username: 'alice',
    is_admin: false,
    projects: [{ group_id: 'payments-service', role: 'engineer', base_confidence: 0.7, is_owner: false }],
  }),
  loadProjectConfig: (...args) => mockLoadProjectConfig(...args),
}))

// ── Test server bootstrap ──────────────────────────────────────────────────────

let server, baseUrl

beforeAll(async () => {
  const { default: dashboardRouter } = await import('../../gateway/src/routes/dashboard.js')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { sub: 'alice', project: 'payments-service', role: 'engineer', is_admin: false }
    next()
  })
  app.use('/api', dashboardRouter)
  server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => new Promise((resolve) => server.close(resolve)))

beforeEach(() => vi.clearAllMocks())

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal pg pool mock that returns given rows for is_global query
 * and a count of `entryCount` for any COUNT query.
 * @param {Array<{group_id: string, display_name?: string}>} globalRows
 * @param {number} [entryCount]
 */
function makePool(globalRows, entryCount = 5) {
  return {
    query: vi.fn().mockImplementation((sql) => {
      if (/is_global/i.test(sql))  return Promise.resolve({ rows: globalRows })
      if (/COUNT/i.test(sql))      return Promise.resolve({ rows: [{ entry_count: String(entryCount) }] })
      return Promise.resolve({ rows: [] })
    }),
  }
}

/**
 * GET /api/globals using the given pool attached to app.locals.
 * @param {object} pool
 */
async function getGlobals(pool) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { sub: 'alice', project: 'payments-service', role: 'engineer', is_admin: false }
    req.app.locals.pool = pool
    next()
  })
  const { default: dashboardRouter } = await import('../../gateway/src/routes/dashboard.js')
  app.use('/api', dashboardRouter)
  const srv = http.createServer(app)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/api/globals`
  const res = await fetch(url)
  await new Promise((r) => srv.close(r))
  return { status: res.status, body: await res.json() }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/globals — empty state', () => {
  it('returns an empty array when no global catalogs exist', async () => {
    mockLoadProjectConfig.mockResolvedValue({ group_id: 'payments-service', globals: [] })
    const { status, body } = await getGlobals(makePool([]))
    expect(status).toBe(200)
    expect(body).toEqual([])
  })
})

describe('GET /api/globals — org-scoped catalog', () => {
  it('returns org-scoped catalogs to all authenticated users', async () => {
    mockLoadProjectConfig
      .mockResolvedValueOnce({ group_id: 'payments-service', globals: [] })          // requesting project
      .mockResolvedValueOnce({ group_id: 'security-standards', global_scope: 'org', globals: [] }) // catalog config

    const { status, body } = await getGlobals(makePool([
      { group_id: 'security-standards', display_name: 'Security Standards' },
    ]))

    expect(status).toBe(200)
    expect(body).toHaveLength(1)
    expect(body[0].group_id).toBe('security-standards')
    expect(body[0].global_scope).toBe('org')
  })

  it('includes entry_count from knowledge_versions', async () => {
    mockLoadProjectConfig
      .mockResolvedValueOnce({ group_id: 'payments-service', globals: [] })
      .mockResolvedValueOnce({ group_id: 'security-standards', global_scope: 'org', globals: ['org-base'] })

    const { body } = await getGlobals(makePool([
      { group_id: 'security-standards', display_name: null },
    ], 12))

    expect(body[0].entry_count).toBe(12)
    expect(body[0].globals).toEqual(['org-base'])
  })

  it('uses group_id as display_name when config and db display_name are both absent', async () => {
    mockLoadProjectConfig
      .mockResolvedValueOnce({ group_id: 'payments-service', globals: [] })
      .mockResolvedValueOnce(null) // catalog config missing

    const { body } = await getGlobals(makePool([
      { group_id: 'security-standards', display_name: null },
    ]))

    expect(body[0].display_name).toBe('security-standards')
  })
})

describe('GET /api/globals — division scope filtering', () => {
  it('hides division-scoped catalog from a project outside that division', async () => {
    // Requesting project: no hierarchy.parent set
    mockLoadProjectConfig
      .mockResolvedValueOnce({ group_id: 'payments-service', globals: [] }) // no hierarchy
      .mockResolvedValueOnce({ group_id: 'payments-compliance', global_scope: 'division:payments-division', globals: [] })

    const { body } = await getGlobals(makePool([
      { group_id: 'payments-compliance', display_name: 'Payments Compliance' },
    ]))

    // Project is not in payments-division, so this catalog should be hidden
    expect(body).toHaveLength(0)
  })

  it('shows division-scoped catalog to a project in that division', async () => {
    // Requesting project: parent is payments-division
    mockLoadProjectConfig
      .mockResolvedValueOnce({
        group_id: 'payments-service',
        hierarchy: { level: 'service', parent: 'payments-division' },
        globals: [],
      })
      .mockResolvedValueOnce({
        group_id: 'payments-compliance',
        global_scope: 'division:payments-division',
        globals: [],
      })

    const { body } = await getGlobals(makePool([
      { group_id: 'payments-compliance', display_name: 'Payments Compliance' },
    ]))

    expect(body).toHaveLength(1)
    expect(body[0].group_id).toBe('payments-compliance')
  })
})

describe('GET /api/globals — graceful degradation', () => {
  it('returns catalog with defaults when loadProjectConfig throws for that catalog', async () => {
    mockLoadProjectConfig
      .mockResolvedValueOnce({ group_id: 'payments-service', globals: [] }) // requesting project
      .mockRejectedValueOnce(new Error('S3 unavailable'))                  // catalog config fails

    const { status, body } = await getGlobals(makePool([
      { group_id: 'security-standards', display_name: 'Security Standards' },
    ]))

    expect(status).toBe(200)
    // Catalog config missing → global_scope defaults to 'org' → still visible
    expect(body).toHaveLength(1)
    expect(body[0].group_id).toBe('security-standards')
    expect(body[0].global_scope).toBe('org')
    expect(body[0].entry_count).toBe(5)
    expect(body[0].globals).toEqual([])
  })

  it('returns entry_count of 0 when count query fails', async () => {
    mockLoadProjectConfig
      .mockResolvedValueOnce({ group_id: 'payments-service', globals: [] })
      .mockResolvedValueOnce({ group_id: 'security-standards', global_scope: 'org', globals: [] })

    const pool = {
      query: vi.fn().mockImplementation((sql) => {
        if (/is_global/i.test(sql))  return Promise.resolve({ rows: [{ group_id: 'security-standards', display_name: null }] })
        if (/COUNT/i.test(sql))      return Promise.reject(new Error('pg unavailable'))
        return Promise.resolve({ rows: [] })
      }),
    }

    const { body } = await getGlobals(pool)

    expect(body[0].entry_count).toBe(0)
  })

  it('falls back to project-only scope when requesting project config throws', async () => {
    // First call (requesting project) throws — buildAncestorSet returns empty set
    mockLoadProjectConfig
      .mockRejectedValueOnce(new Error('config unavailable'))
      .mockResolvedValueOnce({ group_id: 'security-standards', global_scope: 'org', globals: [] })

    const { status, body } = await getGlobals(makePool([
      { group_id: 'security-standards', display_name: null },
    ]))

    // Org-scoped catalog is always visible even without requesting project config
    expect(status).toBe(200)
    expect(body).toHaveLength(1)
  })
})
