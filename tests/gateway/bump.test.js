/**
 * Gateway: POST /bump/:topic/:key — confidence endorsement endpoint.
 *
 * Verifies:
 *   1. Happy path returns delta_applied, confidence_before/after, cooldown_resets_at
 *   2. Role-weighted delta (engineer 0.025, principal_architect 0.050)
 *   3. Cap at starting_confidence
 *   4. 7-day cooldown returns 409
 *   5. Missing ACTIVE version → 404
 *   6. Missing JWT → 401
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { SignJWT } from 'jose'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadProjectConfig: vi.fn(),
  loadUserProfile:   vi.fn(),
}))

vi.mock('../../gateway/src/middleware/project.js', () => ({
  projectMiddleware: (req, _res, next) => {
    req.project = { id: 'platform-team', groupId: 'platform-team' }
    next()
  },
}))

vi.mock('../../gateway/src/shared/graph/queries.js', () => ({
  getProjectByGroupId: vi.fn(),
  getOrCreateKey:      vi.fn(),
  getVersionForBump:   vi.fn(),
  getBumpLog:          vi.fn(),
  recordBump:          vi.fn().mockResolvedValue(undefined),
  updateConfidence:    vi.fn().mockResolvedValue(undefined),
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { loadUserProfile } from '../../gateway/src/config-cache.js'
import {
  getProjectByGroupId,
  getOrCreateKey,
  getVersionForBump,
  getBumpLog,
} from '../../gateway/src/shared/graph/queries.js'
import { loadKeys } from '../../gateway/src/keys.js'
import bumpRoutes   from '../../gateway/src/routes/bump.js'

/** @type {http.Server} */
let server
/** @type {number} */
let port

/**
 * Build a JWT for the given subject.
 * @param {string} sub
 */
async function makeToken(sub = 'alice') {
  const { privateKey } = await loadKeys()
  return new SignJWT({ sub, is_admin: false })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer('quorum-gateway')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

const mockClient = {
  query:   vi.fn().mockResolvedValue({}),
  release: vi.fn(),
}

const app = express()
app.use(express.json())
app.locals.pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(mockClient) }
app.use('/bump', bumpRoutes)
// Error handler mirroring server.js
app.use((err, _req, res, _next) => {
  const status = err.status ?? 500
  const code   = err.code   ?? 'INTERNAL_ERROR'
  res.status(status).json({ error: code.toLowerCase(), message: err.message })
})

beforeAll(async () => {
  await loadKeys()
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
})

afterAll(() => server.close())

beforeEach(() => {
  vi.clearAllMocks()
  // Sensible defaults
  getProjectByGroupId.mockResolvedValue('q_p1')
  getOrCreateKey.mockResolvedValue('q_k1')
  getBumpLog.mockResolvedValue([])
  mockClient.query.mockResolvedValue({})
  app.locals.pool.connect.mockResolvedValue(mockClient)
})

/**
 * POST helper.
 * @param {string} path
 * @param {object} body
 * @param {Record<string,string>} [headers]
 */
function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const merged = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...headers,
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: merged },
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
    req.write(payload)
    req.end()
  })
}

/**
 * Configure loadUserProfile to return a member with the given role.
 * @param {string} role
 */
function mockProfileRole(role) {
  loadUserProfile.mockResolvedValue({
    github_username: 'alice',
    is_admin:        false,
    projects: [{ group_id: 'platform-team', role, base_confidence: 0.7, is_owner: false, team: 'core' }],
  })
}

describe('POST /bump/:topic/:key', () => {
  it('returns 401 when no Authorization header is present', async () => {
    const { status, body } = await post('/bump/auth/jwt-rotation', {})
    expect(status).toBe(401)
    expect(body.error).toBe('missing_token')
  })

  it('happy path — principal_architect bumps and gets full delta', async () => {
    mockProfileRole('principal_architect')
    getVersionForBump.mockResolvedValue({
      version_id:           'v1',
      confidence:           0.7,
      starting_confidence:  0.9,
    })

    const tok = await makeToken('alice')
    const { status, body } = await post('/bump/auth/jwt-rotation', {}, {
      Authorization:     `Bearer ${tok}`,
      'X-Quorum-Project': 'platform-team',
    })

    expect(status).toBe(200)
    expect(body.topic).toBe('auth')
    expect(body.key).toBe('jwt-rotation')
    expect(body.role).toBe('principal_architect')
    expect(body.delta_applied).toBeCloseTo(0.05, 4)
    expect(body.confidence_before).toBeCloseTo(0.7, 4)
    expect(body.confidence_after).toBeCloseTo(0.75, 4)
    expect(typeof body.cooldown_resets_at).toBe('string')
  })

  it('engineer role delta is 0.025 (0.05 * 0.50)', async () => {
    mockProfileRole('engineer')
    getVersionForBump.mockResolvedValue({
      version_id:           'v1',
      confidence:           0.5,
      starting_confidence:  0.9,
    })

    const tok = await makeToken('alice')
    const { status, body } = await post('/bump/auth/jwt-rotation', {}, {
      Authorization:      `Bearer ${tok}`,
      'X-Quorum-Project': 'platform-team',
    })

    expect(status).toBe(200)
    expect(body.delta_applied).toBeCloseTo(0.025, 4)
    expect(body.confidence_after).toBeCloseTo(0.525, 4)
  })

  it('caps new confidence at starting_confidence', async () => {
    mockProfileRole('principal_architect')
    getVersionForBump.mockResolvedValue({
      version_id:           'v1',
      confidence:           0.95,
      starting_confidence:  0.95,
    })

    const tok = await makeToken('alice')
    const { status, body } = await post('/bump/auth/jwt-rotation', {}, {
      Authorization:      `Bearer ${tok}`,
      'X-Quorum-Project': 'platform-team',
    })

    expect(status).toBe(200)
    expect(body.confidence_after).toBeCloseTo(0.95, 4)
    expect(body.confidence_before).toBeCloseTo(0.95, 4)
  })

  it('returns 409 conflict when cooldown is still active', async () => {
    mockProfileRole('engineer')
    getVersionForBump.mockResolvedValue({
      version_id:          'v1',
      confidence:          0.7,
      starting_confidence: 0.9,
    })
    // Last bump was 1 day ago — well within 7-day cooldown
    getBumpLog.mockResolvedValue([
      { bumped_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
    ])

    const tok = await makeToken('alice')
    const { status, body } = await post('/bump/auth/jwt-rotation', {}, {
      Authorization:      `Bearer ${tok}`,
      'X-Quorum-Project': 'platform-team',
    })

    expect(status).toBe(409)
    expect(body.error).toBe('conflict')
    expect(body.message).toMatch(/cooldown/i)
  })

  it('returns 404 when there is no ACTIVE version at topic:key', async () => {
    mockProfileRole('engineer')
    getVersionForBump.mockResolvedValue(null)

    const tok = await makeToken('alice')
    const { status, body } = await post('/bump/auth/nonexistent', {}, {
      Authorization:      `Bearer ${tok}`,
      'X-Quorum-Project': 'platform-team',
    })

    expect(status).toBe(404)
    expect(body.error).toBe('not_found')
  })

  it('returns 404 when project is not registered (getProjectByGroupId returns null)', async () => {
    mockProfileRole('engineer')
    getProjectByGroupId.mockResolvedValue(null)

    const tok = await makeToken('alice')
    const { status } = await post('/bump/auth/jwt-rotation', {}, {
      Authorization:      `Bearer ${tok}`,
      'X-Quorum-Project': 'platform-team',
    })

    expect(status).toBe(404)
  })

  it('propagates unexpected errors as 500 via next(err)', async () => {
    mockProfileRole('engineer')
    getProjectByGroupId.mockRejectedValue(new Error('DB connection lost'))

    const tok = await makeToken('alice')
    const { status } = await post('/bump/auth/jwt-rotation', {}, {
      Authorization:      `Bearer ${tok}`,
      'X-Quorum-Project': 'platform-team',
    })

    expect(status).toBe(500)
  })
})
