/**
 * GET /api/drafts and GET /api/drafts/stale — unit tests (GAP-015).
 *
 * Tests the ?max_age_days filter on GET /api/drafts and the new
 * GET /api/drafts/stale endpoint with ?threshold_days parameter.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import express from 'express'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../gateway/src/middleware/verify-jwt.js', () => ({
  verifyJwt: (req, _res, next) => {
    req.user = { sub: 'alice', project: 'eng', role: 'principal_architect', is_admin: false }
    next()
  },
}))

vi.mock('../../gateway/src/middleware/project.js', () => ({
  requireProject: (_req, _res, next) => next(),
}))

vi.mock('../../gateway/src/shared/graph/queries.js', () => ({
  getProjectByGroupId: vi.fn().mockResolvedValue('q_p1'),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const DRAFT_ROWS = [
  { version_id: 'v1', version: 1, topic: 'auth', key: 'token-draft', entity_type: 'Decision',
    confidence: 0.7, author: 'bob', author_role: 'engineer', tags: [], summary: 'Draft token strategy', created_at: new Date().toISOString(), status: 'DRAFT' },
  { version_id: 'v2', version: 1, topic: 'deploy', key: 'helm-draft', entity_type: 'Runbook',
    confidence: 0.6, author: 'carol', author_role: 'engineer', tags: [], summary: 'Draft helm config', created_at: new Date().toISOString(), status: 'DRAFT' },
]

/**
 * @param {object} opts
 * @param {string} opts.path - request path (e.g. '/api/drafts')
 * @param {Array}  opts.dbRows - rows returned by pool.query
 * @param {object} [opts.user]
 * @returns {Promise<{status: number, body: object}>}
 */
async function fetchRoute({ path, dbRows, user }) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = user ?? { sub: 'alice', project: 'eng', role: 'principal_architect', is_admin: false, access_denied: false }
    req.app.locals.pool = {
      query: vi.fn().mockImplementation((sql) => {
        if (/q_projects/.test(sql)) return Promise.resolve({ rows: [{ q_project_id: 'q_p1' }] })
        return Promise.resolve({ rows: dbRows })
      }),
    }
    next()
  })
  const { default: dashboardRouter } = await import('../../gateway/src/routes/dashboard.js')
  app.use('/api', dashboardRouter)
  const srv = http.createServer(app)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const res = await fetch(`http://127.0.0.1:${srv.address().port}${path}`)
  const body = await res.json()
  await new Promise((r) => srv.close(r))
  return { status: res.status, body }
}

// ── GET /api/drafts — max_age_days filter ─────────────────────────────────────

describe('GET /api/drafts — max_age_days filter', () => {
  it('returns all DRAFTs when max_age_days is not provided', async () => {
    const { status, body } = await fetchRoute({ path: '/api/drafts', dbRows: DRAFT_ROWS })
    expect(status).toBe(200)
    expect(Array.isArray(body.drafts)).toBe(true)
    expect(body.drafts.length).toBe(2)
  })

  it('returns 200 with filtered DRAFTs when max_age_days is a positive integer', async () => {
    const { status, body } = await fetchRoute({ path: '/api/drafts?max_age_days=7', dbRows: DRAFT_ROWS })
    expect(status).toBe(200)
    expect(Array.isArray(body.drafts)).toBe(true)
  })

  it('returns 400 when max_age_days is zero', async () => {
    const { status, body } = await fetchRoute({ path: '/api/drafts?max_age_days=0', dbRows: [] })
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_param')
  })

  it('returns 400 when max_age_days is non-numeric', async () => {
    const { status, body } = await fetchRoute({ path: '/api/drafts?max_age_days=abc', dbRows: [] })
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_param')
  })
})

// ── GET /api/drafts/stale — threshold_days filter ─────────────────────────────

describe('GET /api/drafts/stale — threshold_days filter', () => {
  it('returns stale_drafts array with default threshold_days=30', async () => {
    const { status, body } = await fetchRoute({ path: '/api/drafts/stale', dbRows: [] })
    expect(status).toBe(200)
    expect(Array.isArray(body.stale_drafts)).toBe(true)
    expect(body.threshold_days).toBe(30)
  })

  it('echoes the requested threshold_days in the response', async () => {
    const { status, body } = await fetchRoute({ path: '/api/drafts/stale?threshold_days=14', dbRows: DRAFT_ROWS })
    expect(status).toBe(200)
    expect(body.threshold_days).toBe(14)
    expect(Array.isArray(body.stale_drafts)).toBe(true)
  })

  it('returns stale_drafts entries with required fields', async () => {
    const { status, body } = await fetchRoute({ path: '/api/drafts/stale?threshold_days=1', dbRows: DRAFT_ROWS })
    expect(status).toBe(200)
    for (const d of body.stale_drafts) {
      expect(typeof d.topic).toBe('string')
      expect(typeof d.key).toBe('string')
      expect(typeof d.author).toBe('string')
      expect(typeof d.version).toBe('number')
      expect(d.status).toBe('DRAFT')
    }
  })

  it('returns 400 when threshold_days is zero', async () => {
    const { status, body } = await fetchRoute({ path: '/api/drafts/stale?threshold_days=0', dbRows: [] })
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_param')
  })

  it('returns 400 when threshold_days is non-numeric', async () => {
    const { status, body } = await fetchRoute({ path: '/api/drafts/stale?threshold_days=banana', dbRows: [] })
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_param')
  })
})
