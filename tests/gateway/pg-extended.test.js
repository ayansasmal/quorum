/**
 * Extended tests for gateway/src/routes/pg.js
 *
 * Covers endpoints not included in the existing pg-routes.test.js and pg-search.test.js files.
 * All query functions are mocked. verifyJwt is stubbed.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

// Mutable so individual tests can elevate to principal_architect where the route requires it.
let mockUserRole = 'engineer'

vi.mock('../../gateway/src/middleware/verify-jwt.js', () => ({
  verifyJwt: (req, _res, next) => {
    req.user = {
      sub:        'alice',
      project:    'q_p1',   // already a q_p* id — skips slow-path DB lookup
      role:       mockUserRole,
      is_admin:   false,
      qProjectId: 'q_p1',
    }
    next()
  },
}))

vi.mock('../../gateway/src/shared/graph/queries.js', () => ({
  getProjectByGroupId:     vi.fn().mockResolvedValue('q_p1'),
  getOrCreateKey:          vi.fn().mockResolvedValue('q_k1'),
  getCurrentVersion:       vi.fn(),
  getVersionHistory:       vi.fn(),
  getVersionAtDate:        vi.fn(),
  getNextVersionNumber:    vi.fn(),
  getSpecificVersion:      vi.fn(),
  insertVersion:           vi.fn(),
  transitionVersionStatus: vi.fn(),
  insertVersionAuditLink:  vi.fn(),
  getVersionsByTag:        vi.fn(),
  getLatestDraftVersion:   vi.fn(),
  getVersionsByStatus:     vi.fn(),
  getVersionStatusCounts:  vi.fn(),
  getDraftVersions:        vi.fn(),
  getPendingDecisionById:  vi.fn(),
  countPendingForKey:      vi.fn(),
}))

vi.mock('../../gateway/src/shared/audit/secondary.js', () => ({
  writeAuditEntry: vi.fn(),
  getAuditEntry:   vi.fn(),
  getAllEntries:    vi.fn(),
  countEntries:    vi.fn(),
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import {
  getOrCreateKey,
  getCurrentVersion,
  getVersionHistory,
  getVersionAtDate,
  getNextVersionNumber,
  getSpecificVersion,
  insertVersion,
  transitionVersionStatus,
  insertVersionAuditLink,
  getVersionsByTag,
  getLatestDraftVersion,
  getVersionsByStatus,
  getVersionStatusCounts,
  getDraftVersions,
  getPendingDecisionById,
  countPendingForKey,
} from '../../gateway/src/shared/graph/queries.js'
import {
  writeAuditEntry,
  getAuditEntry,
  getAllEntries,
  countEntries,
} from '../../gateway/src/shared/audit/secondary.js'
import pgRoutes from '../../gateway/src/routes/pg.js'

/** @type {http.Server} */
let server
/** @type {number} */
let port

// fakePool supports both pool.query() (for raw SQL in pg.js routes) and
// pool.connect() (for transactional supersede route).
const fakeClient = {
  query:   vi.fn(),
  release: vi.fn(),
}
const fakePool = {
  query:   vi.fn(),
  connect: vi.fn().mockResolvedValue(fakeClient),
}

const app = express()
app.use(express.json())
app.locals.pool = fakePool
app.use('/pg', pgRoutes)
app.use((err, _req, res, _next) => {
  res.status(err.status ?? 500).json({ error: err.code ?? 'error', message: err.message })
})

beforeAll(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
})

afterAll(() => server.close())

beforeEach(() => {
  vi.clearAllMocks()
  mockUserRole = 'engineer'
  fakePool.query.mockReset()
  // Default: any unspecific pool.query() returns { rows: [] } so that the
  // SELECT is_global query in POST /pg/versions doesn't destructure undefined.
  fakePool.query.mockResolvedValue({ rows: [] })
  fakePool.connect.mockResolvedValue(fakeClient)
  fakeClient.query.mockReset()
  fakeClient.release.mockReset()
  getOrCreateKey.mockResolvedValue('q_k1')
  getCurrentVersion.mockResolvedValue(null)
})

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined
    const merged = {
      'Content-Type': 'application/json',
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...headers,
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: merged },
      (res) => {
        let raw = ''
        res.on('data', (c) => { raw += c })
        res.on('end', () => {
          try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }) }
          catch { resolve({ status: res.statusCode, body: raw }) }
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const get   = (path)       => request('GET',   path)
const post  = (path, body) => request('POST',  path, body)
const patch = (path, body) => request('PATCH', path, body)

// ── GET /pg/versions/:topic/:key ──────────────────────────────────────────────

describe('GET /pg/versions/:topic/:key', () => {
  it('returns null when no active version', async () => {
    getCurrentVersion.mockResolvedValue(null)
    const { status, body } = await get('/pg/versions/auth/jwt-rotation')
    expect(status).toBe(200)
    expect(body).toBeNull()
  })

  it('returns the active version', async () => {
    const row = { version_id: 'q_k1_v2', status: 'ACTIVE', summary: 'content' }
    getCurrentVersion.mockResolvedValue(row)
    const { status, body } = await get('/pg/versions/auth/jwt-rotation')
    expect(status).toBe(200)
    expect(body.status).toBe('ACTIVE')
  })
})

// ── GET /pg/versions/:topic/:key/history ──────────────────────────────────────

describe('GET /pg/versions/:topic/:key/history', () => {
  it('returns version history', async () => {
    const rows = [{ version_id: 'q_k1_v2' }, { version_id: 'q_k1_v1' }]
    getVersionHistory.mockResolvedValue(rows)
    const { status, body } = await get('/pg/versions/auth/jwt-rotation/history')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)
  })
})

// ── GET /pg/versions/:topic/:key/at ──────────────────────────────────────────

describe('GET /pg/versions/:topic/:key/at', () => {
  it('returns 400 when date param is missing', async () => {
    const { status } = await get('/pg/versions/auth/jwt-rotation/at')
    expect(status).toBe(400)
  })

  it('returns the version at the given date', async () => {
    const row = { version_id: 'q_k1_v1' }
    getVersionAtDate.mockResolvedValue(row)
    const { status, body } = await get('/pg/versions/auth/jwt-rotation/at?date=2024-01-01')
    expect(status).toBe(200)
    expect(body.version_id).toBe('q_k1_v1')
  })
})

// ── GET /pg/versions/:topic/:key/next-number ──────────────────────────────────

describe('GET /pg/versions/:topic/:key/next-number', () => {
  it('returns the next version number', async () => {
    getNextVersionNumber.mockResolvedValue(3)
    const { status, body } = await get('/pg/versions/auth/jwt-rotation/next-number')
    expect(status).toBe(200)
    expect(body.next_version).toBe(3)
  })
})

// ── GET /pg/versions/by-tag/:tag ─────────────────────────────────────────────

describe('GET /pg/versions/by-tag/:tag', () => {
  it('returns versions with the given tag', async () => {
    const rows = [{ version_id: 'q_k1_v1', tags: ['security'] }]
    getVersionsByTag.mockResolvedValue(rows)
    const { status, body } = await get('/pg/versions/by-tag/security')
    expect(status).toBe(200)
    expect(body).toHaveLength(1)
  })

  it('returns empty array when no versions have the tag', async () => {
    getVersionsByTag.mockResolvedValue([])
    const { status, body } = await get('/pg/versions/by-tag/unknown-tag')
    expect(status).toBe(200)
    expect(body).toEqual([])
  })
})

// ── GET /pg/versions/status-counts ────────────────────────────────────────────

describe('GET /pg/versions/status-counts', () => {
  it('returns status counts', async () => {
    getVersionStatusCounts.mockResolvedValue({ ACTIVE: 5, DRAFT: 2 })
    const { status, body } = await get('/pg/versions/status-counts')
    expect(status).toBe(200)
    expect(body.ACTIVE).toBe(5)
    expect(body.DRAFT).toBe(2)
  })
})

// ── GET /pg/versions/latest-draft/:topic/:key ──────────────────────────────

describe('GET /pg/versions/latest-draft/:topic/:key', () => {
  it('returns null when no draft exists', async () => {
    getLatestDraftVersion.mockResolvedValue(null)
    const { status, body } = await get('/pg/versions/latest-draft/auth/jwt-rotation')
    expect(status).toBe(200)
    expect(body).toBeNull()
  })

  it('returns the latest draft version', async () => {
    const row = { version_id: 'q_k1_v3', status: 'DRAFT' }
    getLatestDraftVersion.mockResolvedValue(row)
    const { status, body } = await get('/pg/versions/latest-draft/auth/jwt-rotation')
    expect(status).toBe(200)
    expect(body.status).toBe('DRAFT')
  })
})

// ── GET /pg/versions/:topic/:key/:version ──────────────────────────────────

describe('GET /pg/versions/:topic/:key/:version', () => {
  it('returns null when specific version not found', async () => {
    getSpecificVersion.mockResolvedValue(null)
    const { status, body } = await get('/pg/versions/auth/jwt-rotation/5')
    expect(status).toBe(200)
    expect(body).toBeNull()
  })

  it('returns the specific version row', async () => {
    const row = { version_id: 'q_k1_v2', version: 2 }
    getSpecificVersion.mockResolvedValue(row)
    const { status, body } = await get('/pg/versions/auth/jwt-rotation/2')
    expect(status).toBe(200)
    expect(body.version).toBe(2)
  })
})

// ── POST /pg/versions ─────────────────────────────────────────────────────────

describe('POST /pg/versions', () => {
  it('returns 400 when topic or key is missing', async () => {
    const { status } = await post('/pg/versions', { content: 'no topic or key' })
    expect(status).toBe(400)
  })

  it('inserts and returns a new version (201)', async () => {
    // getNextVersionNumber is called when version is not provided
    getNextVersionNumber.mockResolvedValue(1)
    const newRow = { version_id: 'q_k1_v1', status: 'DRAFT' }
    insertVersion.mockResolvedValue(newRow)
    const { status, body } = await post('/pg/versions', {
      topic:       'auth',
      key:         'jwt-rotation',
      summary:     'stored content',
      entity_type: 'Decision',
      status:      'DRAFT',
      author:      'alice',
    })
    expect(status).toBe(201)
    expect(body.version_id).toBe('q_k1_v1')
  })
})

// ── POST /pg/versions/supersede ───────────────────────────────────────────────

describe('POST /pg/versions/supersede', () => {
  it('returns 400 when new_version is missing', async () => {
    const { status } = await post('/pg/versions/supersede', { supersedes_version: 1 })
    expect(status).toBe(400)
  })

  it('returns 400 when supersedes_version is missing', async () => {
    const { status } = await post('/pg/versions/supersede', {
      new_version: { topic: 'auth', key: 'jwt', content: 'new', status: 'ACTIVE', author: 'alice' },
    })
    expect(status).toBe(400)
  })

  it('returns 400 when topic or key are missing from new_version', async () => {
    const { status } = await post('/pg/versions/supersede', {
      new_version:        { content: 'no topic or key' },
      supersedes_version: 1,
    })
    expect(status).toBe(400)
  })

  it('performs atomic supersede transaction', async () => {
    // The supersede route uses pool.connect() + client.query('BEGIN/COMMIT')
    // and calls insertVersion/transitionVersionStatus with the client (not pool).
    const newRow       = { version_id: 'q_k1_v2', status: 'ACTIVE' }
    const supersededRow = { version_id: 'q_k1_v1', status: 'SUPERSEDED' }
    insertVersion.mockResolvedValue(newRow)
    transitionVersionStatus.mockResolvedValue(supersededRow)
    // BEGIN / COMMIT queries on the transaction client
    fakeClient.query.mockResolvedValue({})

    const { status, body } = await post('/pg/versions/supersede', {
      new_version: {
        topic:       'auth',
        key:         'jwt-rotation',
        version:     2,
        summary:     'updated content',
        entity_type: 'Decision',
        status:      'ACTIVE',
        author:      'alice',
      },
      supersedes_version: 1,
      supersedes_reason:  'Updated approach',
    })

    expect(status).toBe(200)
    expect(body.new_version.version_id).toBe('q_k1_v2')
    expect(body.inserted).toBe(true)
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })
})

// ── PATCH /pg/versions/:topic/:key/:version ────────────────────────────────

describe('PATCH /pg/versions/:topic/:key/:version', () => {
  it('returns 400 when newStatus is missing', async () => {
    const { status } = await patch('/pg/versions/auth/jwt-rotation/1', {})
    expect(status).toBe(400)
  })

  it('transitions the version status (principal_architect required for ACTIVE)', async () => {
    mockUserRole = 'principal_architect'
    const updated = { version_id: 'q_k1_v1', status: 'ACTIVE' }
    transitionVersionStatus.mockResolvedValue(updated)
    const { status, body } = await patch('/pg/versions/auth/jwt-rotation/1', {
      newStatus: 'ACTIVE',
    })
    expect(status).toBe(200)
    expect(body.version_id).toBe('q_k1_v1')
  })

  it('returns 403 when engineer tries to transition to ACTIVE', async () => {
    const { status } = await patch('/pg/versions/auth/jwt-rotation/1', {
      newStatus: 'ACTIVE',
    })
    expect(status).toBe(403)
  })
})

// ── POST /pg/audit-links ──────────────────────────────────────────────────────

describe('POST /pg/audit-links', () => {
  it('inserts a version-audit link and returns 201', async () => {
    insertVersionAuditLink.mockResolvedValue(undefined)
    const { status, body } = await post('/pg/audit-links', {
      version_id: 'q_k1_v1',
      entry_id:   'audit-123',
      link_type:  'created_by',
    })
    expect(status).toBe(201)
    expect(body.ok).toBe(true)
    expect(insertVersionAuditLink).toHaveBeenCalledOnce()
  })
})

// ── POST /pg/audit ────────────────────────────────────────────────────────────

describe('POST /pg/audit', () => {
  it('writes and returns an audit entry with 201', async () => {
    const entry = { entry_id: 'e1', chain_position: 1 }
    writeAuditEntry.mockResolvedValue(entry)
    const { status, body } = await post('/pg/audit', {
      operation: 'remember',
      tool:      'remember',
      author:    'alice',
    })
    expect(status).toBe(201)
    expect(body.entry_id).toBe('e1')
  })
})

// ── GET /pg/audit/:id ─────────────────────────────────────────────────────────

describe('GET /pg/audit/:id', () => {
  it('returns a single audit entry when it belongs to the project', async () => {
    // The route checks entry.q_project_id === req.user.qProjectId
    const entry = { entry_id: 'e42', operation: 'recall', q_project_id: 'q_p1' }
    getAuditEntry.mockResolvedValue(entry)
    const { status, body } = await get('/pg/audit/e42')
    expect(status).toBe(200)
    expect(body.entry_id).toBe('e42')
  })

  it('returns 404 when entry belongs to a different project', async () => {
    const entry = { entry_id: 'e42', q_project_id: 'q_p_other' }
    getAuditEntry.mockResolvedValue(entry)
    const { status } = await get('/pg/audit/e42')
    expect(status).toBe(404)
  })

  it('returns null when entry not found', async () => {
    getAuditEntry.mockResolvedValue(null)
    const { status, body } = await get('/pg/audit/missing')
    expect(status).toBe(200)
    expect(body).toBeNull()
  })
})

// ── GET /pg/audit/count ───────────────────────────────────────────────────────

describe('GET /pg/audit/count', () => {
  it('returns the total count of audit entries', async () => {
    countEntries.mockResolvedValue(42)
    const { status, body } = await get('/pg/audit/count')
    expect(status).toBe(200)
    expect(body.count).toBe(42)
  })
})

// ── GET /pg/pending ───────────────────────────────────────────────────────────
//
// /pg/pending uses a raw pool.query() JOIN instead of a query-helper function.
// We mock fakePool.query to return the expected rows.

describe('GET /pg/pending', () => {
  it('returns pending decisions via raw pool query', async () => {
    const rows = [{ conflict_id: 'q_c1', status: 'pending', conflict_topic: 'auth', conflict_key: 'jwt' }]
    fakePool.query.mockResolvedValue({ rows })
    const { status, body } = await get('/pg/pending')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(1)
    expect(body[0].conflict_id).toBe('q_c1')
  })

  it('returns empty array when no pending decisions', async () => {
    fakePool.query.mockResolvedValue({ rows: [] })
    const { status, body } = await get('/pg/pending')
    expect(status).toBe(200)
    expect(body).toEqual([])
  })

  it('includes stale decisions when include_stale is set', async () => {
    const rows = [
      { conflict_id: 'q_c1', status: 'pending' },
      { conflict_id: 'q_c2', status: 'stale' },
    ]
    fakePool.query.mockResolvedValue({ rows })
    const { status, body } = await get('/pg/pending?include_stale=1')
    expect(status).toBe(200)
    expect(body).toHaveLength(2)
  })
})

// ── GET /pg/pending/count/:topic/:key ────────────────────────────────────────

describe('GET /pg/pending/count/:topic/:key', () => {
  it('returns count of pending decisions for topic:key', async () => {
    countPendingForKey.mockResolvedValue(3)
    const { status, body } = await get('/pg/pending/count/auth/jwt-rotation')
    expect(status).toBe(200)
    expect(body.count).toBe(3)
  })
})

// ── GET /pg/pending/:conflictId ───────────────────────────────────────────────

describe('GET /pg/pending/:conflictId', () => {
  it('returns a pending decision when it belongs to the project', async () => {
    // The route checks row.q_project_id === req.user.qProjectId
    const decision = { conflict_id: 'q_c7', status: 'pending', q_project_id: 'q_p1' }
    getPendingDecisionById.mockResolvedValue(decision)
    const { status, body } = await get('/pg/pending/q_c7')
    expect(status).toBe(200)
    expect(body.conflict_id).toBe('q_c7')
  })

  it('returns 404 when decision belongs to a different project', async () => {
    const decision = { conflict_id: 'q_c7', q_project_id: 'q_p_other' }
    getPendingDecisionById.mockResolvedValue(decision)
    const { status } = await get('/pg/pending/q_c7')
    expect(status).toBe(404)
  })

  it('returns null when not found', async () => {
    getPendingDecisionById.mockResolvedValue(null)
    const { status, body } = await get('/pg/pending/q_c999')
    expect(status).toBe(200)
    expect(body).toBeNull()
  })
})

// ── POST /pg/pending ──────────────────────────────────────────────────────────
//
// /pg/pending POST uses raw pool.query() to:
//   1. SELECT nextval('q_conflict_seq') — if conflict_id not provided
//   2. INSERT INTO pending_decisions RETURNING *

describe('POST /pg/pending', () => {
  it('returns 400 when q_key_id and topic+key are all missing', async () => {
    const { status } = await post('/pg/pending', { conflict_reason: 'no key info' })
    expect(status).toBe(400)
  })

  it('inserts and returns a pending decision (201)', async () => {
    const inserted = { conflict_id: 'q_c10', status: 'pending', q_key_id: 'q_k1', q_project_id: 'q_p1' }
    // First call: nextval sequence; second call: INSERT RETURNING
    fakePool.query
      .mockResolvedValueOnce({ rows: [{ n: 10 }] })
      .mockResolvedValueOnce({ rows: [inserted] })

    const { status, body } = await post('/pg/pending', {
      conflict_topic:  'auth',
      conflict_key:    'jwt-rotation',
      conflict_reason: 'contradicts existing pattern',
    })
    expect(status).toBe(201)
    expect(body.conflict_id).toBe('q_c10')
  })

  it('uses provided q_key_id and conflict_id directly (no nextval)', async () => {
    const inserted = { conflict_id: 'q_c99', status: 'pending' }
    fakePool.query.mockResolvedValueOnce({ rows: [inserted] })

    const { status, body } = await post('/pg/pending', {
      q_key_id:        'q_k5',
      conflict_id:     'q_c99',
      conflict_reason: 'explicit ids provided',
    })
    expect(status).toBe(201)
    expect(body.conflict_id).toBe('q_c99')
  })
})

// ── PATCH /pg/pending/:conflictId ─────────────────────────────────────────────
//
// PATCH /pg/pending/:conflictId uses raw pool.query() to UPDATE pending_decisions.
// It builds a dynamic SET clause from only the allowed column names in req.body.

describe('PATCH /pg/pending/:conflictId', () => {
  it('returns 400 when no updatable fields are provided', async () => {
    const { status } = await patch('/pg/pending/q_c7', { unknownField: 'val' })
    expect(status).toBe(400)
  })

  it('returns 404 when no row is updated', async () => {
    fakePool.query.mockResolvedValue({ rows: [] })
    const { status } = await patch('/pg/pending/q_c999', { status: 'stale' })
    expect(status).toBe(404)
  })

  it('updates the pending decision and returns it', async () => {
    const updated = { conflict_id: 'q_c7', status: 'resolved', resolution: 'supersede' }
    fakePool.query.mockResolvedValue({ rows: [updated] })

    const { status, body } = await patch('/pg/pending/q_c7', {
      status:          'resolved',
      resolution:      'supersede',
      resolution_note: 'incoming knowledge is more accurate and up to date',
      resolved_by:     'alice',
    })
    expect(status).toBe(200)
    expect(body.conflict_id).toBe('q_c7')
    expect(body.status).toBe('resolved')
  })
})

// ── GET /pg/search ────────────────────────────────────────────────────────────

describe('GET /pg/search', () => {
  it('returns 400 when q param is missing', async () => {
    const { status } = await get('/pg/search')
    expect(status).toBe(400)
  })

  it('returns search results from ILIKE query', async () => {
    fakePool.query.mockResolvedValue({
      rows: [{ topic: 'auth', key: 'jwt-rotation', summary: 'JWT is rotated', status: 'ACTIVE' }],
    })
    const { status, body } = await get('/pg/search?q=jwt')
    expect(status).toBe(200)
    expect(body.source).toBe('postgres-ilike')
    expect(body.results).toHaveLength(1)
    expect(body.total).toBe(1)
  })

  it('returns empty results when no matches', async () => {
    fakePool.query.mockResolvedValue({ rows: [] })
    const { status, body } = await get('/pg/search?q=zzznomatch')
    expect(status).toBe(200)
    expect(body.results).toEqual([])
    expect(body.total).toBe(0)
  })
})
