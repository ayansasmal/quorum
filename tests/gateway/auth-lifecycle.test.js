/**
 * Gateway: auth lifecycle endpoints
 *
 *   POST /auth/refresh   — issue a fresh JWT given a valid (still-valid) JWT
 *   GET  /auth/projects  — retired (410 Gone)
 *   POST /auth/switch    — retired (410 Gone)
 *   POST /auth/projects  — pre-JWT project discovery via GitHub token + DDB
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { SignJWT } from 'jose'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadProjectConfig: vi.fn(),
  loadUserProfile:   vi.fn().mockResolvedValue({
    github_username: 'alice',
    is_admin:        false,
    projects: [{ group_id: 'test-project', role: 'engineer', base_confidence: 0.7, is_owner: false, team: 'platform' }],
  }),
  isPlatformAdmin:   vi.fn().mockResolvedValue(false),
}))

vi.mock('../../gateway/src/ddb.js', () => ({
  getUserProjects: vi.fn(),
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { isPlatformAdmin } from '../../gateway/src/config-cache.js'
import { getUserProjects } from '../../gateway/src/ddb.js'
import { loadKeys }        from '../../gateway/src/keys.js'
import authRoutes          from '../../gateway/src/routes/auth.js'

/** @type {http.Server} */
let server
/** @type {number} */
let port
/** @type {string} */
let token

const app = express()
app.use(express.json())
app.use('/auth', authRoutes)

beforeAll(async () => {
  const { privateKey } = await loadKeys()
  token = await new SignJWT({ sub: 'alice', is_admin: false })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer('quorum-gateway')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
})

afterAll(() => server.close())

beforeEach(() => {
  vi.clearAllMocks()
  isPlatformAdmin.mockResolvedValue(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── HTTP helpers ──────────────────────────────────────────────────────────────

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
 * GET helper.
 * @param {string} path
 */
function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }) }
        catch { resolve({ status: res.statusCode, body: raw }) }
      })
    }).on('error', reject)
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /auth/refresh', () => {
  it('returns a fresh signed JWT when given a still-valid JWT', async () => {
    const { status, body } = await post('/auth/refresh', {}, {
      Authorization: `Bearer ${token}`,
    })

    expect(status).toBe(200)
    expect(typeof body.token).toBe('string')
    expect(body.token.split('.').length).toBe(3)
    expect(body.expires_in).toBe(3600)
    expect(body.sub).toBe('alice')
    expect(body.is_admin).toBe(false)
  })

  it('returns 401 when no Authorization header is present', async () => {
    const { status, body } = await post('/auth/refresh', {})
    expect(status).toBe(401)
    expect(body.error).toBe('missing_token')
  })

  it('concurrent refresh calls both succeed — stateless sliding-window design', async () => {
    // Two simultaneous refresh requests from the same client must both return 200.
    // Quorum uses a stateless sliding-window (access JWT = refresh token) — there is no
    // JTI blacklist so both are valid until expiry. This test documents the design intent
    // so a future engineer adding single-use JTI enforcement knows the contract changes.
    const [r1, r2] = await Promise.all([
      post('/auth/refresh', {}, { Authorization: `Bearer ${token}` }),
      post('/auth/refresh', {}, { Authorization: `Bearer ${token}` }),
    ])

    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    // Both return distinct tokens (different iat/jti) — not single-use
    expect(r1.body.token).not.toBe(r2.body.token)
    expect(r1.body.expires_in).toBeGreaterThan(0)
    expect(r2.body.expires_in).toBeGreaterThan(0)
  })
})

describe('GET /auth/projects — retired in v0.3', () => {
  it('returns 410 Gone with endpoint_retired error', async () => {
    const { status, body } = await get('/auth/projects')
    expect(status).toBe(410)
    expect(body.error).toBe('endpoint_retired')
  })
})

describe('POST /auth/switch — retired in v0.3', () => {
  it('returns 410 Gone with endpoint_retired error', async () => {
    const { status, body } = await post('/auth/switch', { project_id: 'whatever' })
    expect(status).toBe(410)
    expect(body.error).toBe('endpoint_retired')
  })
})

describe('POST /auth/projects — pre-JWT discovery', () => {
  it('returns projects list using GitHub token + DDB lookup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:         true,
      status:     200,
      statusText: 'OK',
      json:       async () => ({ login: 'alice' }),
    }))
    getUserProjects.mockResolvedValue([
      {
        project_id:   'q_p1',
        project_slug: 'platform-team',
        project_name: 'Platform Team',
        role:         'engineer',
        team:         'core',
      },
    ])

    const { status, body } = await post('/auth/projects', { github_token: 'ghp_valid' })

    expect(status).toBe(200)
    expect(body.github_login).toBe('alice')
    expect(body.source).toBe('ddb')
    expect(Array.isArray(body.projects)).toBe(true)
    expect(body.projects.length).toBe(1)
    expect(body.projects[0].id).toBe('q_p1')
    expect(body.projects[0].slug).toBe('platform-team')
    expect(body.projects[0].role).toBe('engineer')
  })

  it('returns 400 when github_token is missing', async () => {
    const { status, body } = await post('/auth/projects', {})
    expect(status).toBe(400)
    expect(body.error).toBe('missing_param')
  })

  it('returns 401 when GitHub rejects the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:         false,
      status:     401,
      statusText: 'Unauthorized',
      json:       async () => ({}),
    }))

    const { status, body } = await post('/auth/projects', { github_token: 'ghp_bad' })
    expect(status).toBe(401)
    expect(body.error).toBe('github_auth_failed')
  })
})
