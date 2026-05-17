/**
 * Tests for gateway/src/routes/admin.js
 *
 * GET  /admin/config
 * POST /admin/users
 *
 * Uses a real Express app on port 0, with mocked config-cache and governance audit.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { SignJWT } from 'jose'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadAdminConfig:  vi.fn(),
  saveAdminConfig:  vi.fn().mockResolvedValue(undefined),
  loadUserProfile:  vi.fn(),
}))

vi.mock('../../gateway/src/shared/audit/governance.js', () => ({
  writeGovernanceAudit: vi.fn().mockResolvedValue(undefined),
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { loadAdminConfig, saveAdminConfig, loadUserProfile } from '../../gateway/src/config-cache.js'
import { writeGovernanceAudit } from '../../gateway/src/shared/audit/governance.js'
import { loadKeys } from '../../gateway/src/keys.js'
import adminRoutes from '../../gateway/src/routes/admin.js'

/** @type {http.Server} */
let server
/** @type {number} */
let port

const app = express()
app.use(express.json())
app.locals.pool = { query: vi.fn() }
app.use('/admin', adminRoutes)
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

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/**
 * Make a signed JWT for the given user.
 * @param {string} sub
 * @param {boolean} [is_admin]
 */
async function makeToken(sub = 'alice', is_admin = true) {
  const { privateKey } = await loadKeys()
  return new SignJWT({ sub, is_admin })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer('quorum-gateway')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

/**
 * Make a GET request.
 */
function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
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
    req.end()
  })
}

/**
 * Make a POST request.
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

/** loadUserProfile mock for admin user. */
function mockAdminProfile(sub = 'alice') {
  loadUserProfile.mockResolvedValue({
    github_username: sub,
    is_admin:        true,
    projects:        [],
  })
}

/** loadUserProfile mock for non-admin user. */
function mockNonAdminProfile(sub = 'bob') {
  loadUserProfile.mockResolvedValue({
    github_username: sub,
    is_admin:        false,
    projects:        [],
  })
}

// ── GET /admin/config ─────────────────────────────────────────────────────────

describe('GET /admin/config', () => {
  it('returns 401 when no Authorization header', async () => {
    const { status } = await get('/admin/config')
    expect(status).toBe(401)
  })

  it('returns 403 when user is not a platform admin', async () => {
    mockNonAdminProfile()
    const tok = await makeToken('bob', false)
    const { status, body } = await get('/admin/config', { Authorization: `Bearer ${tok}` })
    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('returns 404 when admin config is not seeded', async () => {
    mockAdminProfile()
    loadAdminConfig.mockResolvedValue(null)

    const tok = await makeToken('alice', true)
    const { status, body } = await get('/admin/config', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(404)
    expect(body.error).toBe('not_found')
  })

  it('returns admin config when user is admin and config exists', async () => {
    mockAdminProfile()
    loadAdminConfig.mockResolvedValue({
      admins:  [{ github_username: 'alice', added_at: '2024-01-01T00:00:00Z', added_by: 'system' }],
      version: 1,
    })

    const tok = await makeToken('alice', true)
    const { status, body } = await get('/admin/config', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(200)
    expect(Array.isArray(body.admins)).toBe(true)
    expect(body.admins[0].github_username).toBe('alice')
  })
})

// ── POST /admin/users ─────────────────────────────────────────────────────────

describe('POST /admin/users', () => {
  it('returns 401 when no Authorization header', async () => {
    const { status } = await post('/admin/users', {})
    expect(status).toBe(401)
  })

  it('returns 403 when user is not a platform admin', async () => {
    mockNonAdminProfile()
    const tok = await makeToken('bob', false)
    const { status, body } = await post('/admin/users', { action: 'add', github_username: 'charlie', reason: 'long enough reason' }, { Authorization: `Bearer ${tok}` })
    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('returns 400 when action is missing', async () => {
    mockAdminProfile()
    const tok = await makeToken('alice', true)
    const { status, body } = await post(
      '/admin/users',
      { github_username: 'charlie', reason: 'long enough reason here' },
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(400)
    expect(body.error).toBe('missing_param')
    expect(body.message).toMatch(/action/)
  })

  it('returns 400 when action is invalid', async () => {
    mockAdminProfile()
    const tok = await makeToken('alice', true)
    const { status, body } = await post(
      '/admin/users',
      { action: 'update', github_username: 'charlie', reason: 'long enough reason here' },
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(400)
    expect(body.error).toBe('missing_param')
  })

  it('returns 400 when github_username is missing', async () => {
    mockAdminProfile()
    const tok = await makeToken('alice', true)
    const { status, body } = await post(
      '/admin/users',
      { action: 'add', reason: 'long enough reason here' },
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(400)
    expect(body.error).toBe('missing_param')
    expect(body.message).toMatch(/github_username/)
  })

  it('returns 400 when reason is too short (< 10 chars)', async () => {
    mockAdminProfile()
    const tok = await makeToken('alice', true)
    const { status, body } = await post(
      '/admin/users',
      { action: 'add', github_username: 'charlie', reason: 'short' },
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(400)
    expect(body.error).toBe('missing_param')
    expect(body.message).toMatch(/reason/)
  })

  it('returns 500 when admin config is not seeded', async () => {
    mockAdminProfile()
    loadAdminConfig.mockResolvedValue(null)

    const tok = await makeToken('alice', true)
    const { status, body } = await post(
      '/admin/users',
      { action: 'add', github_username: 'charlie', reason: 'this is a long enough reason' },
      { Authorization: `Bearer ${tok}` },
    )
    expect(status).toBe(500)
    expect(body.error).toBe('config_error')
  })

  it('adds a user and returns ok when action=add', async () => {
    mockAdminProfile()
    loadAdminConfig.mockResolvedValue({
      admins:  [{ github_username: 'alice', added_at: '2024-01-01T00:00:00Z', added_by: 'system' }],
      version: 1,
    })

    const tok = await makeToken('alice', true)
    const { status, body } = await post(
      '/admin/users',
      { action: 'add', github_username: 'charlie', reason: 'charlie is trusted enough for admin' },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.action).toBe('add')
    expect(body.github_username).toBe('charlie')
    expect(saveAdminConfig).toHaveBeenCalledOnce()
    expect(writeGovernanceAudit).toHaveBeenCalledOnce()
  })

  it('returns 409 when adding a user who is already an admin', async () => {
    mockAdminProfile()
    loadAdminConfig.mockResolvedValue({
      admins:  [{ github_username: 'alice', added_at: '2024-01-01T00:00:00Z', added_by: 'system' }],
      version: 1,
    })

    const tok = await makeToken('alice', true)
    const { status, body } = await post(
      '/admin/users',
      { action: 'add', github_username: 'alice', reason: 'alice is already an admin anyway' },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(409)
    expect(body.error).toBe('already_admin')
  })

  it('removes a user and returns ok when action=remove', async () => {
    mockAdminProfile()
    loadAdminConfig.mockResolvedValue({
      admins: [
        { github_username: 'alice', added_at: '2024-01-01T00:00:00Z', added_by: 'system' },
        { github_username: 'bob',   added_at: '2024-01-01T00:00:00Z', added_by: 'alice' },
      ],
      version: 2,
    })

    const tok = await makeToken('alice', true)
    const { status, body } = await post(
      '/admin/users',
      { action: 'remove', github_username: 'bob', reason: 'bob left the organisation last week' },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.action).toBe('remove')
  })

  it('returns 404 when removing a user who is not an admin', async () => {
    mockAdminProfile()
    loadAdminConfig.mockResolvedValue({
      admins:  [{ github_username: 'alice', added_at: '2024-01-01T00:00:00Z', added_by: 'system' }],
      version: 1,
    })

    const tok = await makeToken('alice', true)
    const { status, body } = await post(
      '/admin/users',
      { action: 'remove', github_username: 'charlie', reason: 'charlie was never an admin here' },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(404)
    expect(body.error).toBe('not_found')
  })

  it('returns 409 when removing the last platform admin', async () => {
    mockAdminProfile()
    loadAdminConfig.mockResolvedValue({
      admins:  [{ github_username: 'alice', added_at: '2024-01-01T00:00:00Z', added_by: 'system' }],
      version: 1,
    })

    const tok = await makeToken('alice', true)
    const { status, body } = await post(
      '/admin/users',
      { action: 'remove', github_username: 'alice', reason: 'alice is leaving the company today' },
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(409)
    expect(body.error).toBe('last_admin')
  })
})
