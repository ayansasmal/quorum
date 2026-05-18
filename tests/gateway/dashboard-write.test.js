/**
 * Dashboard BFF write endpoint tests.
 *
 * Covers the three principal_architect-only knowledge write routes:
 *   POST /api/knowledge              — create new ACTIVE entry
 *   POST /api/knowledge/:topic/:key/promote   — promote DRAFT → ACTIVE
 *   POST /api/knowledge/:topic/:key/supersede — edit ACTIVE entry (atomic)
 *
 * All mocks are declared before any imports (vi.mock is hoisted by Vitest).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'

// ── Mocks ─────────────────────────────────────────────────────────────────────

/** Default user: principal_architect. Overridden per-test where needed. */
let mockUser = { sub: 'alice', project: 'q_p1', role: 'principal_architect', is_admin: false }

vi.mock('../../gateway/src/middleware/verify-jwt.js', () => ({
  verifyJwt: (req, _res, next) => {
    req.user = mockUser
    next()
  },
}))

vi.mock('../../gateway/src/shared/graph/queries.js', () => ({
  getProjectByGroupId:    vi.fn().mockResolvedValue('q_p1'),
  getOrCreateKey:         vi.fn().mockResolvedValue('q_k1'),
  getNextVersionNumber:   vi.fn().mockResolvedValue(1),
  insertVersion:          vi.fn().mockResolvedValue({ version_id: 'q_k1_v1', version: 1 }),
  transitionVersionStatus: vi.fn().mockResolvedValue({}),
  getLatestDraftVersion:  vi.fn().mockResolvedValue({ version: 2, author: 'bob' }),
  getCurrentVersion:      vi.fn().mockResolvedValue({ version: 1, confidence: 0.8 }),
  getPendingDecisionById: vi.fn(),
  resolvePendingDecision: vi.fn(),
  enforceNoSelfApproval:  vi.fn(),
  enforceReasonRequired:  vi.fn(),
  getVersionForBump:      vi.fn(),
  getBumpLog:             vi.fn(),
  recordBump:             vi.fn(),
  updateConfidence:       vi.fn(),
}))

vi.mock('../../gateway/src/shared/audit/secondary.js', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue(undefined),
  getAuditEntry:   vi.fn(),
  getAllEntries:    vi.fn(),
  countEntries:    vi.fn(),
}))

vi.mock('../../gateway/src/shared/graph/client.js', () => ({
  searchNodes: vi.fn().mockResolvedValue({ nodes: [] }),
  searchFacts: vi.fn().mockResolvedValue({ facts: [] }),
}))

vi.mock('../../gateway/src/shared/governance/constitutional.js', () => ({
  enforceNoSelfApproval: vi.fn(),
  enforceReasonRequired: vi.fn(),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import {
  getOrCreateKey,
  getNextVersionNumber,
  insertVersion,
  transitionVersionStatus,
  getLatestDraftVersion,
  getCurrentVersion,
} from '../../gateway/src/shared/graph/queries.js'
import { writeAuditEntry } from '../../gateway/src/shared/audit/secondary.js'
import { verifyJwt } from '../../gateway/src/middleware/verify-jwt.js'
import dashboardRoutes, { peWriteLimit } from '../../gateway/src/routes/dashboard.js'

// ── Test server ────────────────────────────────────────────────────────────────

let server
let port

/** Fake pool with connect() for transaction tests. */
const fakeClient = {
  query:   vi.fn().mockResolvedValue({ rows: [] }),
  release: vi.fn(),
}

const fakePool = {
  query:   vi.fn().mockResolvedValue({ rows: [] }),
  connect: vi.fn().mockResolvedValue(fakeClient),
}

const app = express()
app.use(express.json())
app.locals.pool = fakePool

// Mount with verifyJwt applied — mirrors server.js setup
app.use('/api', verifyJwt, dashboardRoutes)

beforeAll(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
})

afterAll(() => server.close())

beforeEach(() => {
  vi.clearAllMocks()
  fakePool.query.mockResolvedValue({ rows: [] })
  fakeClient.query.mockResolvedValue({ rows: [] })
  fakePool.connect.mockResolvedValue(fakeClient)

  // Reset rate limiter state so each test starts with a clean window
  if (peWriteLimit._windows) peWriteLimit._windows.clear()

  // Restore default mocks after clearAllMocks
  getOrCreateKey.mockResolvedValue('q_k1')
  getNextVersionNumber.mockResolvedValue(1)
  insertVersion.mockResolvedValue({ version_id: 'q_k1_v1', version: 1 })
  transitionVersionStatus.mockResolvedValue({})
  getLatestDraftVersion.mockResolvedValue({ version: 2, author: 'bob' })
  getCurrentVersion.mockResolvedValue({ version: 1, confidence: 0.8 })
  writeAuditEntry.mockResolvedValue(undefined)

  // Reset user to default PA
  mockUser = { sub: 'alice', project: 'q_p1', role: 'principal_architect', is_admin: false }
})

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/**
 * Send a JSON POST request to the test server.
 * @param {string} path
 * @param {object} body
 * @returns {Promise<{ status: number, body: object }>}
 */
function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
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
    req.write(payload)
    req.end()
  })
}

// ── POST /api/knowledge ────────────────────────────────────────────────────────

describe('POST /api/knowledge', () => {
  const validBody = {
    topic:       'infra',
    key:         'retry-policy',
    content:     'Use exponential backoff with jitter for all service calls.',
    entity_type: 'Pattern',
  }

  it('returns 403 when role is not principal_architect', async () => {
    mockUser = { sub: 'bob', project: 'q_p1', role: 'engineer', is_admin: false }

    const { status, body } = await post('/api/knowledge', validBody)

    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('returns 400 when content contains HTML chars', async () => {
    const { status, body } = await post('/api/knowledge', {
      ...validBody,
      content: '<script>alert(1)</script>',
    })

    expect(status).toBe(400)
    expect(body.error).toBe('validation_error')
    expect(body.field).toBe('content')
  })

  it('returns 400 when entity_type is invalid', async () => {
    const { status, body } = await post('/api/knowledge', {
      ...validBody,
      entity_type: 'Unknown',
    })

    expect(status).toBe(400)
    expect(body.error).toBe('validation_error')
    expect(body.field).toBe('entity_type')
  })

  it('returns 201 on valid input from a principal_architect', async () => {
    const { status, body } = await post('/api/knowledge', validBody)

    expect(status).toBe(201)
    expect(body).toMatchObject({ version_id: 'q_k1_v1', version: 1 })
  })

  it('sets author_type to human (never from body)', async () => {
    await post('/api/knowledge', validBody)

    expect(insertVersion).toHaveBeenCalledWith(
      fakePool,
      expect.objectContaining({ author_type: 'human', triggered_by: 'dashboard' }),
    )
  })

  it('writes an audit entry on success', async () => {
    await post('/api/knowledge', validBody)

    expect(writeAuditEntry).toHaveBeenCalledWith(
      fakePool,
      expect.objectContaining({ operation: 'WRITE', tool: 'dashboard-create' }),
    )
  })
})

// ── POST /api/knowledge/:topic/:key/promote ────────────────────────────────────

describe('POST /api/knowledge/:topic/:key/promote', () => {
  const validNote = { note: 'Reviewed and approved after staging validation.' }

  it('returns 403 for non-PE', async () => {
    mockUser = { sub: 'bob', project: 'q_p1', role: 'engineer', is_admin: false }

    const { status, body } = await post('/api/knowledge/infra/retry-policy/promote', validNote)

    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('returns 400 when note is missing', async () => {
    const { status, body } = await post('/api/knowledge/infra/retry-policy/promote', {})

    expect(status).toBe(400)
    expect(body.error).toBe('validation_error')
    expect(body.field).toBe('note')
  })

  it('returns 400 when note is too short', async () => {
    const { status, body } = await post('/api/knowledge/infra/retry-policy/promote', { note: 'Short' })

    expect(status).toBe(400)
    expect(body.error).toBe('validation_error')
    expect(body.field).toBe('note')
  })

  it('returns 404 when no DRAFT exists', async () => {
    getLatestDraftVersion.mockResolvedValue(null)

    const { status, body } = await post('/api/knowledge/infra/retry-policy/promote', validNote)

    expect(status).toBe(404)
    expect(body.error).toBe('no_draft')
  })

  it('returns 200 on successful promote', async () => {
    const { status, body } = await post('/api/knowledge/infra/retry-policy/promote', validNote)

    expect(status).toBe(200)
    expect(body).toMatchObject({
      promoted:   true,
      version:    2,
      topic:      'infra',
      key:        'retry-policy',
    })
  })

  it('calls transitionVersionStatus with ACTIVE', async () => {
    await post('/api/knowledge/infra/retry-policy/promote', validNote)

    expect(transitionVersionStatus).toHaveBeenCalledWith(
      fakePool,
      'q_k1_v2',
      'ACTIVE',
      expect.objectContaining({ version: 2 }),
    )
  })
})

// ── POST /api/knowledge/:topic/:key/supersede ──────────────────────────────────

describe('POST /api/knowledge/:topic/:key/supersede', () => {
  const validBody = {
    content:     'Use exponential backoff with full jitter — see runbook for parameters.',
    entity_type: 'Pattern',
    reason:      'Updated after load testing revealed original params caused thundering herd.',
  }

  it('returns 403 for non-PE', async () => {
    mockUser = { sub: 'bob', project: 'q_p1', role: 'engineer', is_admin: false }

    const { status, body } = await post('/api/knowledge/infra/retry-policy/supersede', validBody)

    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('returns 400 when reason is missing', async () => {
    const { content, entity_type } = validBody
    const { status, body } = await post('/api/knowledge/infra/retry-policy/supersede', { content, entity_type })

    expect(status).toBe(400)
    expect(body.error).toBe('validation_error')
    expect(body.field).toBe('reason')
  })

  it('returns 404 when no ACTIVE version exists', async () => {
    getCurrentVersion.mockResolvedValue(null)

    const { status, body } = await post('/api/knowledge/infra/retry-policy/supersede', validBody)

    expect(status).toBe(404)
    expect(body.error).toBe('no_active')
  })

  it('returns 200 with new_version and superseded_version on success', async () => {
    const { status, body } = await post('/api/knowledge/infra/retry-policy/supersede', validBody)

    expect(status).toBe(200)
    expect(body).toHaveProperty('new_version')
    expect(body).toHaveProperty('superseded_version')
    expect(body.superseded_version).toBe(1) // current.version from mock
  })

  it('performs atomic transaction: BEGIN + COMMIT', async () => {
    await post('/api/knowledge/infra/retry-policy/supersede', validBody)

    const calls = fakeClient.query.mock.calls.map((c) => c[0])
    expect(calls).toContain('BEGIN')
    expect(calls).toContain('COMMIT')
  })

  it('writes audit entry with dashboard-supersede tool', async () => {
    await post('/api/knowledge/infra/retry-policy/supersede', validBody)

    expect(writeAuditEntry).toHaveBeenCalledWith(
      fakePool,
      expect.objectContaining({ operation: 'WRITE', tool: 'dashboard-supersede' }),
    )
  })
})
