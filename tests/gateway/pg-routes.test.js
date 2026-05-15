/**
 * Gateway pg routes — regression guard.
 *
 * Asserts response shapes for endpoints added/fixed in feat/dashboard.
 * These tests should PASS on feat/dashboard already and continue to pass
 * after the feat/v03 merge is executed in Phase 4.
 *
 * Guards:
 *   - GET /pg/audit            → { entries: [...] } (not bare array)
 *   - GET /pg/versions/drafts  → array of DRAFT entries
 *   - GET /pg/versions/by-status/:status → filtered array
 *   - GET /pg/audit/lineage/:topic/:key  → { entries: [...] }
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../gateway/src/middleware/verify-jwt.js', () => ({
  verifyJwt: (req, _res, next) => {
    req.user = { sub: 'alice', project: 'test-project', role: 'engineer', is_admin: false }
    next()
  },
}))

vi.mock('../../gateway/src/shared/graph/queries.js', () => ({
  getProjectByGroupId:    vi.fn().mockResolvedValue('q_p1'),
  getOrCreateKey:         vi.fn().mockResolvedValue('q_k1'),
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
  countPendingForKey:     vi.fn(),
  resolvePendingDecision: vi.fn(),
}))

vi.mock('../../gateway/src/shared/audit/secondary.js', () => ({
  writeAuditEntry: vi.fn(),
  getAuditEntry:   vi.fn(),
  getAllEntries:    vi.fn(),
  countEntries:    vi.fn(),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import {
  getCurrentVersion,
  getDraftVersions,
  getVersionsByStatus,
} from '../../gateway/src/shared/graph/queries.js'
import { getAllEntries } from '../../gateway/src/shared/audit/secondary.js'
import pgRoutes from '../../gateway/src/routes/pg.js'

// ── Test server ────────────────────────────────────────────────────────────────

let server
let port

/** Fake pool — lineage query goes through pool.query() directly. */
const fakePool = {
  query: vi.fn(),
}

const app = express()
app.use(express.json())
app.locals.pool = fakePool
app.use('/pg', pgRoutes)

beforeAll(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
})

afterAll(() => server.close())
beforeEach(() => {
  vi.clearAllMocks()
  fakePool.query.mockReset()
  // Ensure the /versions/:topic/:key catch-all mock never throws (it's registered
  // before /versions/by-status/:status in the route file — Express picks it first).
  getCurrentVersion.mockResolvedValue(null)
})

// ── HTTP helper ───────────────────────────────────────────────────────────────

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

describe('GET /pg/audit', () => {
  it('wraps entries in { entries: [...] } object, not bare array', async () => {
    const mockEntries = [
      { entry_id: 'e1', operation: 'create', author: 'alice' },
      { entry_id: 'e2', operation: 'update', author: 'alice' },
    ]
    getAllEntries.mockResolvedValue(mockEntries)

    const { status, body } = await get('/pg/audit')

    expect(status).toBe(200)
    expect(body).toHaveProperty('entries')
    expect(Array.isArray(body.entries)).toBe(true)
    expect(body.entries).toHaveLength(2)
    expect(body.entries[0].entry_id).toBe('e1')
  })

  it('returns { entries: [] } when there are no audit entries', async () => {
    getAllEntries.mockResolvedValue([])

    const { status, body } = await get('/pg/audit')

    expect(status).toBe(200)
    expect(body).toEqual({ entries: [] })
  })
})

describe('GET /pg/versions/drafts', () => {
  it('returns an array of DRAFT entries', async () => {
    const mockDrafts = [
      { topic: 'infra', key: 'retry-policy', status: 'DRAFT', version: 2 },
      { topic: 'auth',  key: 'token-ttl',   status: 'DRAFT', version: 1 },
    ]
    getDraftVersions.mockResolvedValue(mockDrafts)

    const { status, body } = await get('/pg/versions/drafts')

    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.every((r) => r.status === 'DRAFT')).toBe(true)
  })

  it('calls getDraftVersions with the resolved q_project_id', async () => {
    getDraftVersions.mockResolvedValue([])

    await get('/pg/versions/drafts')

    expect(getDraftVersions).toHaveBeenCalledWith(
      fakePool,
      expect.objectContaining({ qProjectId: 'q_p1' }),
    )
  })
})

describe('GET /pg/versions/by-status/:status', () => {
  it('returns only entries matching the requested status', async () => {
    const mockRows = [
      { topic: 'infra', key: 'caching', status: 'ACTIVE', version: 3 },
    ]
    getVersionsByStatus.mockResolvedValue(mockRows)

    const { status, body } = await get('/pg/versions/by-status/ACTIVE')

    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].status).toBe('ACTIVE')
  })

  it('calls getVersionsByStatus with the status param and resolved q_project_id', async () => {
    getVersionsByStatus.mockResolvedValue([])

    await get('/pg/versions/by-status/SUPERSEDED')

    expect(getVersionsByStatus).toHaveBeenCalledWith(
      fakePool,
      'SUPERSEDED',
      'q_p1',
      undefined,
    )
  })
})

describe('GET /pg/audit/lineage/:topic/:key', () => {
  it('returns { entries: [...] } with the lineage chain', async () => {
    const mockRows = [
      { entry_id: 'a1', operation: 'create', version: 1, link_type: 'created_by' },
      { entry_id: 'a2', operation: 'update', version: 2, link_type: 'created_by' },
    ]
    fakePool.query.mockResolvedValue({ rows: mockRows })

    const { status, body } = await get('/pg/audit/lineage/infra/retry-policy')

    expect(status).toBe(200)
    expect(body).toHaveProperty('entries')
    expect(body.entries).toHaveLength(2)
    expect(body.entries[0].entry_id).toBe('a1')
  })

  it('returns { entries: [] } for a node with no audit history', async () => {
    fakePool.query.mockResolvedValue({ rows: [] })

    const { status, body } = await get('/pg/audit/lineage/infra/unknown-key')

    expect(status).toBe(200)
    expect(body).toEqual({ entries: [] })
  })
})
