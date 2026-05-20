/**
 * Tests for gateway/src/routes/projects.js
 *
 * POST   /projects
 * GET    /projects
 * GET    /projects/:id
 * PATCH  /projects/:id
 * POST   /projects/:id/token/rotate
 * DELETE /projects/:id
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { SignJWT } from 'jose'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadUserProfile:  vi.fn(),
  invalidateProject: vi.fn().mockResolvedValue(undefined),
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { loadUserProfile, invalidateProject } from '../../gateway/src/config-cache.js'
import { loadKeys } from '../../gateway/src/keys.js'
import projectsRoutes from '../../gateway/src/routes/projects.js'

/** @type {http.Server} */
let server
/** @type {number} */
let port
const mockPool = { query: vi.fn() }

const app = express()
app.use(express.json())
app.locals.pool = mockPool
app.use('/projects', projectsRoutes)
// Error handler matching server.js
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
})

// ── Helpers ────────────────────────────────────────────────────────────────────

async function makeToken(sub = 'alice', is_admin = false) {
  const { privateKey } = await loadKeys()
  return new SignJWT({ sub, is_admin })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer('quorum-gateway')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

function mockProfile(sub = 'alice', is_admin = false) {
  loadUserProfile.mockResolvedValue({
    github_username: sub,
    is_admin,
    projects:        [],
  })
}

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : undefined
    const merged = {
      'Content-Type':   'application/json',
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

const get    = (path, headers = {}) => request('GET',    path, null, headers)
const post   = (path, body, headers = {}) => request('POST',   path, body, headers)
const patch  = (path, body, headers = {}) => request('PATCH',  path, body, headers)
const del    = (path, body = null, headers = {}) => request('DELETE', path, body, headers)

// ── POST /projects ─────────────────────────────────────────────────────────────

describe('POST /projects', () => {
  it('returns 401 when no Authorization header', async () => {
    const { status } = await post('/projects', { name: 'Test', slug: 'test' })
    expect(status).toBe(401)
  })

  it('returns 400 when name is missing', async () => {
    mockProfile()
    const tok = await makeToken()
    const { status, body } = await post('/projects', { slug: 'test' }, { Authorization: `Bearer ${tok}` })
    expect(status).toBe(400)
    expect(body.error).toBe('unprocessable')
    expect(body.message).toMatch(/name/)
  })

  it('returns 400 when slug is invalid (uppercase / special chars)', async () => {
    mockProfile()
    const tok = await makeToken()
    const { status, body } = await post(
      '/projects',
      { name: 'Test', slug: 'Invalid_Slug!' },
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(400)
    expect(body.error).toBe('unprocessable')
    expect(body.message).toMatch(/slug/)
  })

  it('returns 201 and token on success', async () => {
    mockProfile()
    const tok = await makeToken('alice')
    mockPool.query.mockResolvedValueOnce({ rows: [] }) // INSERT succeeds

    const { status, body } = await post(
      '/projects',
      { name: 'My Project', slug: 'my-project' },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(201)
    expect(typeof body.token).toBe('string')
    expect(body.token).toHaveLength(64)     // 32 random bytes → 64 hex chars
    expect(body.slug).toBe('my-project')
    expect(body.name).toBe('My Project')
    // Creator auto-enrolled as principal_architect
    expect(body.members[0].github_username).toBe('alice')
    expect(body.members[0].role).toBe('principal_architect')
  })

  it('returns 409 when slug is already taken (unique violation)', async () => {
    mockProfile()
    const tok = await makeToken('alice')
    const uniqueViolation = new Error('duplicate key')
    uniqueViolation.code = '23505'
    mockPool.query.mockRejectedValueOnce(uniqueViolation)

    const { status, body } = await post(
      '/projects',
      { name: 'My Project', slug: 'taken-slug' },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(409)
    expect(body.error).toBe('conflict')
  })
})

// ── GET /projects ──────────────────────────────────────────────────────────────

describe('GET /projects', () => {
  it('returns 401 when no Authorization header', async () => {
    const { status } = await get('/projects')
    expect(status).toBe(401)
  })

  it('returns empty list when user has no projects', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query.mockResolvedValueOnce({ rows: [] })

    const { status, body } = await get('/projects', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(200)
    expect(body.projects).toEqual([])
    expect(body.github_login).toBe('alice')
  })

  it('returns projects with caller role resolved', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id:             'proj-abc',
        slug:           'my-proj',
        name:           'My Proj',
        status:         'ACTIVE',
        config_version: 1,
        created_at:     '2024-01-01T00:00:00Z',
        members: [{ github_username: 'alice', role: 'principal_architect', team: 'platform' }],
      }],
    })

    const { status, body } = await get('/projects', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(200)
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0].role).toBe('principal_architect')
    expect(body.projects[0].team).toBe('platform')
  })
})

// ── GET /projects/:id ──────────────────────────────────────────────────────────

describe('GET /projects/:id', () => {
  it('returns 401 when no Authorization header', async () => {
    const { status } = await get('/projects/proj-1')
    expect(status).toBe(401)
  })

  it('returns 404 when project does not exist', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query.mockResolvedValueOnce({ rows: [] })

    const { status, body } = await get('/projects/proj-missing', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(404)
    expect(body.error).toBe('not_found')
  })

  it('returns 403 when caller is not a member', async () => {
    mockProfile('charlie')
    const tok = await makeToken('charlie')
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id:      'proj-1',
        slug:    'p1',
        name:    'P1',
        status:  'ACTIVE',
        members: [{ github_username: 'alice', role: 'principal_architect' }],
      }],
    })

    const { status, body } = await get('/projects/proj-1', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('returns project config with caller_role when user is a member', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id:      'proj-1',
        slug:    'p1',
        name:    'P1',
        status:  'ACTIVE',
        members: [{ github_username: 'alice', role: 'engineer' }],
        domains: [],
        governance: {},
      }],
    })

    const { status, body } = await get('/projects/proj-1', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(200)
    expect(body.caller_role).toBe('engineer')
    expect(body.id).toBe('proj-1')
  })
})

// ── PATCH /projects/:id ────────────────────────────────────────────────────────

describe('PATCH /projects/:id', () => {
  it('returns 401 when no Authorization header', async () => {
    const { status } = await patch('/projects/proj-1', { config_version: 0 })
    expect(status).toBe(401)
  })

  it('returns 400 when config_version is missing', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    const { status, body } = await patch(
      '/projects/proj-1',
      { members: [] },
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(400)
    expect(body.message).toMatch(/config_version/)
  })

  it('returns 404 when project does not exist', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query.mockResolvedValueOnce({ rows: [] }) // SELECT returns nothing

    const { status, body } = await patch(
      '/projects/proj-missing',
      { config_version: 0, members: [{ github_username: 'alice', role: 'principal_architect' }] },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(404)
    expect(body.error).toBe('not_found')
  })

  it('returns 403 when caller is not principal_architect', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        members: [{ github_username: 'alice', role: 'engineer' }],
        config_version: 0,
      }],
    })

    const { status, body } = await patch(
      '/projects/proj-1',
      { config_version: 0, members: [{ github_username: 'alice', role: 'engineer' }] },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('returns 409 on optimistic lock version mismatch', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        members: [{ github_username: 'alice', role: 'principal_architect' }],
        config_version: 5, // DB has version 5 but caller sent 3
      }],
    })

    const { status, body } = await patch(
      '/projects/proj-1',
      {
        config_version: 3,
        members: [{ github_username: 'alice', role: 'principal_architect' }],
      },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(409)
    expect(body.error).toBe('conflict')
    expect(body.message).toMatch(/version/)
  })

  it('returns 400 when new members list has no principal_architect', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        members: [{ github_username: 'alice', role: 'principal_architect' }],
        config_version: 0,
      }],
    })

    const { status, body } = await patch(
      '/projects/proj-1',
      {
        config_version: 0,
        members: [{ github_username: 'alice', role: 'engineer' }], // no PA!
      },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(400)
    expect(body.message).toMatch(/principal_architect/)
  })

  it('returns 400 when no updatable fields are provided', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        members: [{ github_username: 'alice', role: 'principal_architect' }],
        config_version: 0,
      }],
    })

    const { status, body } = await patch(
      '/projects/proj-1',
      { config_version: 0 }, // no updatable fields
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(400)
    expect(body.message).toMatch(/No updatable fields/)
  })

  it('updates project and invalidates cache on success', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          members: [{ github_username: 'alice', role: 'principal_architect' }],
          config_version: 0,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id:             'proj-1',
          slug:           'p1',
          name:           'P1',
          config_version: 1,
          members:        [{ github_username: 'alice', role: 'principal_architect' }],
          domains:        [],
          governance:     {},
        }],
      })

    const { status, body } = await patch(
      '/projects/proj-1',
      {
        config_version: 0,
        members:        [{ github_username: 'alice', role: 'principal_architect' }],
      },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(200)
    expect(body.config_version).toBe(1)
    expect(invalidateProject).toHaveBeenCalledWith('proj-1')
  })
})

// ── POST /projects/:id/token/rotate ──────────────────────────────────────────

describe('POST /projects/:id/token/rotate', () => {
  it('returns 401 when no Authorization header', async () => {
    const { status } = await post('/projects/proj-1/token/rotate', {})
    expect(status).toBe(401)
  })

  it('returns 404 when project does not exist', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query.mockResolvedValueOnce({ rows: [] })

    const { status, body } = await post(
      '/projects/proj-missing/token/rotate',
      {},
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(404)
    expect(body.error).toBe('not_found')
  })

  it('returns 403 when caller is not principal_architect', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query.mockResolvedValueOnce({
      rows: [{ members: [{ github_username: 'alice', role: 'engineer' }] }],
    })

    const { status, body } = await post(
      '/projects/proj-1/token/rotate',
      {},
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('rotates token and returns new plaintext token', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ members: [{ github_username: 'alice', role: 'principal_architect' }] }],
      })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE token_hash

    const { status, body } = await post(
      '/projects/proj-1/token/rotate',
      {},
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(200)
    expect(typeof body.token).toBe('string')
    expect(body.token).toHaveLength(64)
    expect(body.id).toBe('proj-1')
    expect(invalidateProject).toHaveBeenCalledWith('proj-1')
  })
})

// ── DELETE /projects/:id ──────────────────────────────────────────────────────

describe('DELETE /projects/:id', () => {
  it('returns 401 when no Authorization header', async () => {
    const { status } = await del('/projects/proj-1')
    expect(status).toBe(401)
  })

  it('returns 400 when reason is missing', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    const { status, body } = await del('/projects/proj-1', {}, { Authorization: `Bearer ${tok}` })
    expect(status).toBe(400)
    expect(body.error).toBe('unprocessable')
  })

  it('returns 400 when reason is too short', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    const { status, body } = await del('/projects/proj-1', { reason: 'short' }, { Authorization: `Bearer ${tok}` })
    expect(status).toBe(400)
    expect(body.error).toBe('unprocessable')
  })

  it('returns 404 when project does not exist', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query.mockResolvedValueOnce({ rows: [] })

    const { status, body } = await del('/projects/proj-missing', { reason: 'project is being decommissioned' }, { Authorization: `Bearer ${tok}` })
    expect(status).toBe(404)
    expect(body.error).toBe('not_found')
  })

  it('returns 403 when caller is neither owner nor admin', async () => {
    mockProfile('bob')
    const tok = await makeToken('bob')
    mockPool.query.mockResolvedValueOnce({
      rows: [{ members: [{ github_username: 'bob', role: 'engineer' }], created_by: 'alice' }],
    })

    const { status, body } = await del('/projects/proj-1', { reason: 'project is being decommissioned' }, { Authorization: `Bearer ${tok}` })
    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('archives project and deprecates ACTIVE versions (owner)', async () => {
    mockProfile('alice')
    const tok = await makeToken('alice')
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ members: [], created_by: 'alice' }],
      })
      .mockResolvedValueOnce({ rowCount: 3, rows: [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }] }) // UPDATE knowledge_versions
      .mockResolvedValueOnce({ rows: [] }) // UPDATE projects SET status=ARCHIVED

    const { status, body } = await del('/projects/proj-1', { reason: 'project is being decommissioned' }, { Authorization: `Bearer ${tok}` })

    expect(status).toBe(200)
    expect(body.status).toBe('ARCHIVED')
    expect(body.versions_deprecated).toBe(3)
    expect(body.archived_by).toBe('alice')
    expect(invalidateProject).toHaveBeenCalledWith('proj-1')
  })

  it('allows platform admin to archive a project they are not a member of', async () => {
    mockProfile('superadmin', true)
    const tok = await makeToken('superadmin', true)
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ members: [{ github_username: 'alice', role: 'principal_architect' }], created_by: 'alice' }],
      })
      .mockResolvedValueOnce({ rowCount: 2, rows: [{ id: 'v1' }, { id: 'v2' }] })
      .mockResolvedValueOnce({ rows: [] })

    const { status, body } = await del('/projects/proj-1', { reason: 'admin-initiated decommission' }, { Authorization: `Bearer ${tok}` })

    expect(status).toBe(200)
    expect(body.status).toBe('ARCHIVED')
    expect(body.archived_by).toBe('superadmin')
  })
})
