/**
 * Gateway: POST /auth/token
 *
 * Tests the authentication route by spinning up a real test HTTP server.
 * Test requests use Node's built-in http module (NOT fetch) so vi.stubGlobal('fetch')
 * only intercepts the route's internal GitHub API call — not the test client itself.
 *
 * Mocks:
 *   - global fetch      → controls GitHub /user API responses (route's internal calls)
 *   - config-cache.js   → controls project config loading
 *
 * Verifies:
 *   1. Valid GitHub token + known project → 200 with a signed JWT
 *   2. Invalid GitHub token (GitHub 401) → 401 gateway error
 *   3. Missing github_token in body → 400
 *   4. Missing project_id in body → 400
 *   5. Project not found → 404
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import express from 'express'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadProjectConfig:  vi.fn(),
  isPlatformAdmin:    vi.fn().mockResolvedValue(false),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { loadProjectConfig } from '../../gateway/src/config-cache.js'
import { loadKeys }          from '../../gateway/src/keys.js'
import authRoutes            from '../../gateway/src/routes/auth.js'

// ── Test server ────────────────────────────────────────────────────────────────

/** @type {http.Server} */
let server
/** @type {number} */
let port

const app = express()
app.use(express.json())
app.use('/auth', authRoutes)

beforeAll(async () => {
  await loadKeys()
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * Make a POST request using Node's http module (avoids global fetch contamination).
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
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) })
          } catch {
            resolve({ status: res.statusCode, body: raw })
          }
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT_CONFIG = {
  project:  'test-project',
  group_id: 'test-project',
  owner:    'alice',
  members: [
    { github_username: 'alice', role: 'engineer', team: 'platform', base_confidence: 0.7 },
  ],
  roles:      { engineer: { base_confidence: 0.7 } },
  domains:    {},
  thresholds: { conflict_threshold: 0.85, authority_threshold: 0.20 },
}

/**
 * Stub the global fetch to simulate a GitHub /user API response.
 * Only the route module's internal `fetch` calls are affected.
 * Test requests use http.request above, so they are unaffected.
 * @param {{ ok: boolean, status?: number, login?: string }} opts
 */
function mockGitHub({ ok, status = 200, login = 'alice' }) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Unauthorized',
    json: async () => (ok ? { login } : {}),
  }))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /auth/token', () => {
  it('returns a signed JWT for a valid GitHub token and known project', async () => {
    mockGitHub({ ok: true, login: 'alice' })
    loadProjectConfig.mockResolvedValue(PROJECT_CONFIG)

    const { status, body } = await post('/auth/token', {
      github_token: 'ghp_valid',
      project_id:   'test-project',
    })

    expect(status).toBe(200)
    expect(body.token).toBeTruthy()
    expect(body.sub).toBe('alice')
    expect(body.project).toBe('test-project')
    expect(body.role).toBe('engineer')
    expect(body.team).toBe('platform')
    expect(body.expires_in).toBe(900)
    expect(body.member_found).toBe(true)
    // Verify it is a 3-part JWT
    expect(body.token.split('.').length).toBe(3)
  })

  it('returns 401 when GitHub rejects the token', async () => {
    mockGitHub({ ok: false, status: 401 })

    const { status, body } = await post('/auth/token', {
      github_token: 'ghp_bad',
      project_id:   'test-project',
    })

    expect(status).toBe(401)
    expect(body.error).toBe('github_auth_failed')
  })

  it('returns 400 when github_token is absent from the request body', async () => {
    const { status, body } = await post('/auth/token', {
      project_id: 'test-project',
    })

    expect(status).toBe(400)
    expect(body.error).toBe('missing_param')
    expect(body.message).toMatch(/github_token/)
  })

  it('returns 400 when project_id is absent from the request body', async () => {
    const { status, body } = await post('/auth/token', {
      github_token: 'ghp_valid',
    })

    expect(status).toBe(400)
    expect(body.error).toBe('missing_param')
    expect(body.message).toMatch(/project_id/)
  })

  it('returns 404 when the project does not exist', async () => {
    mockGitHub({ ok: true, login: 'alice' })
    loadProjectConfig.mockRejectedValue(new Error('project not found'))

    const { status, body } = await post('/auth/token', {
      github_token: 'ghp_valid',
      project_id:   'unknown-project',
    })

    expect(status).toBe(404)
    expect(body.error).toBe('project_not_found')
  })
})

// ── v0.3 TDD Gates — will FAIL against v0.2, PASS once Wave 1.5 is implemented ──

describe('POST /auth/token — v0.3 slim JWT (Wave 1.5)', () => {
  it('JWT payload contains only sub, is_admin, jti, exp, iat — no project/role/team', async () => {
    mockGitHub({ ok: true, login: 'alice' })
    loadProjectConfig.mockResolvedValue(PROJECT_CONFIG)

    const { status, body } = await post('/auth/token', {
      github_token: 'ghp_valid',
      project_id:   'test-project',
    })

    expect(status).toBe(200)
    expect(body.token).toBeTruthy()

    // Decode JWT payload without verification
    const rawPayload = JSON.parse(
      Buffer.from(body.token.split('.')[1], 'base64').toString(),
    )

    // Slim JWT: must carry identity claims only
    expect(rawPayload.sub).toBe('alice')
    expect(rawPayload.is_admin).toBeDefined()

    // Rich claims must NOT be in the token — they belong in the response body only
    expect(rawPayload.project).toBeUndefined()
    expect(rawPayload.role).toBeUndefined()
    expect(rawPayload.team).toBeUndefined()
    expect(rawPayload.base_confidence).toBeUndefined()

    // Response body may still carry them for backward compatibility
    expect(body.project).toBe('test-project')
    expect(body.role).toBe('engineer')
  })
})

describe('GET /auth/projects — retired in v0.3 (Wave 1.5)', () => {
  it('returns 410 Gone with a redirect message', async () => {
    const res = await new Promise((resolve, reject) => {
      http.get(
        { hostname: '127.0.0.1', port, path: '/auth/projects' },
        (r) => {
          let raw = ''
          r.on('data', (c) => { raw += c })
          r.on('end', () => {
            try { resolve({ status: r.statusCode, body: JSON.parse(raw) }) }
            catch { resolve({ status: r.statusCode, body: raw }) }
          })
        },
      ).on('error', reject)
    })

    expect(res.status).toBe(410)
    expect(res.body.error).toBe('endpoint_retired')
  })
})

describe('POST /auth/switch — retired in v0.3 (Wave 1.5)', () => {
  it('returns 410 Gone with a redirect message', async () => {
    const { status, body } = await post('/auth/switch', { project_id: 'some-project' })

    expect(status).toBe(410)
    expect(body.error).toBe('endpoint_retired')
  })
})
