/**
 * TDD Gate — v0.3 verify-jwt middleware behaviour.
 *
 * These tests define the EXPECTED behaviour of the async two-step middleware
 * introduced in Wave 1.6 of the v0.3 plan. They will FAIL against the current
 * v0.2 middleware (which reads project from JWT claim) and PASS once
 * gateway/src/middleware/verify-jwt.js is updated.
 *
 * v0.3 two-step flow:
 *   1. Verify JWT signature → extract { sub, is_admin }
 *   2. Read X-Quorum-Project header → active project
 *   3. loadUserProfile(sub) → { projects: [...] }
 *   4. Find project entry → role, base_confidence, is_owner
 *   5. Attach req.user = { sub, is_admin, project, role, base_confidence, is_owner }
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { SignJWT } from 'jose'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadUserProfile: vi.fn(),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { loadUserProfile }  from '../../gateway/src/config-cache.js'
import { loadKeys, getKeys } from '../../gateway/src/keys.js'
import { verifyJwt }         from '../../gateway/src/middleware/verify-jwt.js'

// ── Test server ────────────────────────────────────────────────────────────────

let server
let port

const app = express()
app.use(express.json())

// Probe route — returns req.user so tests can inspect what the middleware attached
app.get('/probe', verifyJwt, (req, res) => res.json(req.user))

beforeAll(async () => {
  await loadKeys()
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
})

afterAll(() => server.close())
beforeEach(() => vi.clearAllMocks())

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/**
 * GET /probe with optional Authorization and X-Quorum-Project headers.
 * @param {{ token?: string, project?: string }} opts
 * @returns {Promise<{ status: number, body: object }>}
 */
function getProbe({ token, project } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (token)   headers['Authorization']    = `Bearer ${token}`
    if (project) headers['X-Quorum-Project'] = project

    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/probe', method: 'GET', headers },
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

/**
 * Sign a test JWT with the gateway's private key.
 * @param {object} claims
 * @param {{ expiresIn?: string }} [opts]
 */
async function signToken(claims, { expiresIn = '1h' } = {}) {
  const { privateKey } = getKeys()
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer('quorum-gateway')
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey)
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROFILE = {
  username: 'alice',
  projects: [
    {
      group_id:        'my-project',
      role:            'engineer',
      base_confidence: 0.7,
      is_owner:        false,
    },
  ],
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('verifyJwt — v0.3 slim JWT + X-Quorum-Project header', () => {
  it('reads project from X-Quorum-Project header (not JWT claim)', async () => {
    loadUserProfile.mockResolvedValue(PROFILE)
    const token = await signToken({ sub: 'alice', is_admin: false })

    const { status, body } = await getProbe({ token, project: 'my-project' })

    expect(status).toBe(200)
    expect(body.project).toBe('my-project')
  })

  it('sets project to null when X-Quorum-Project header is absent', async () => {
    loadUserProfile.mockResolvedValue(PROFILE)
    const token = await signToken({ sub: 'alice', is_admin: false })

    const { status, body } = await getProbe({ token })

    expect(status).toBe(200)
    expect(body.project).toBeNull()
  })

  it('attaches is_admin from JWT claim', async () => {
    loadUserProfile.mockResolvedValue(PROFILE)
    const token = await signToken({ sub: 'admin-user', is_admin: true })

    const { status, body } = await getProbe({ token, project: 'my-project' })

    expect(status).toBe(200)
    expect(body.is_admin).toBe(true)
  })

  it('calls loadUserProfile with the JWT sub', async () => {
    loadUserProfile.mockResolvedValue(PROFILE)
    const token = await signToken({ sub: 'alice', is_admin: false })

    await getProbe({ token, project: 'my-project' })

    expect(loadUserProfile).toHaveBeenCalledWith('alice')
  })

  it('resolves role and base_confidence from profile, not JWT claim', async () => {
    loadUserProfile.mockResolvedValue(PROFILE)
    // JWT carries no role/base_confidence — they must come from the profile
    const token = await signToken({ sub: 'alice', is_admin: false })

    const { status, body } = await getProbe({ token, project: 'my-project' })

    expect(status).toBe(200)
    expect(body.role).toBe('engineer')
    expect(body.base_confidence).toBe(0.7)
  })

  it('returns role null for a project the user is not a member of', async () => {
    loadUserProfile.mockResolvedValue(PROFILE)
    const token = await signToken({ sub: 'alice', is_admin: false })

    const { status, body } = await getProbe({ token, project: 'unknown-project' })

    expect(status).toBe(200)
    expect(body.role).toBeNull()
  })

  it('returns 401 for an expired JWT', async () => {
    const token = await signToken({ sub: 'alice', is_admin: false }, { expiresIn: '-1s' })

    const { status, body } = await getProbe({ token, project: 'my-project' })

    expect(status).toBe(401)
    expect(body.error).toBe('token_expired')
  })

  it('returns 401 when Authorization header is missing', async () => {
    const { status, body } = await getProbe({})

    expect(status).toBe(401)
    expect(body.error).toBe('missing_token')
  })

  it('does not include project, role, or team inside the JWT payload itself', async () => {
    loadUserProfile.mockResolvedValue(PROFILE)
    const token = await signToken({ sub: 'alice', is_admin: false })

    // Decode JWT payload without verification — check raw claims
    const rawPayload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())

    expect(rawPayload.project).toBeUndefined()
    expect(rawPayload.role).toBeUndefined()
    expect(rawPayload.team).toBeUndefined()
    expect(rawPayload.base_confidence).toBeUndefined()
  })
})
