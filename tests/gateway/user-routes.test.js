/**
 * Tests for gateway/src/routes/user.js
 *
 * GET /user/profile/:username
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { SignJWT } from 'jose'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadUserProfile:  vi.fn(),
  loadAdminConfig:  vi.fn(),
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { loadUserProfile, loadAdminConfig } from '../../gateway/src/config-cache.js'
import { loadKeys } from '../../gateway/src/keys.js'
import userRoutes from '../../gateway/src/routes/user.js'

/** @type {http.Server} */
let server
/** @type {number} */
let port

const app = express()
app.use(express.json())
app.use('/user', userRoutes)
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

beforeEach(() => vi.clearAllMocks())

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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GET /user/profile/:username', () => {
  it('returns 401 when no Authorization header', async () => {
    const { status } = await get('/user/profile/alice')
    expect(status).toBe(401)
  })

  it('returns own profile without restriction (self access)', async () => {
    const tok = await makeToken('alice')
    loadUserProfile.mockResolvedValue({
      github_username: 'alice',
      is_admin:        false,
      projects:        [{ group_id: 'proj-1', role: 'engineer' }],
    })
    loadAdminConfig.mockResolvedValue({ admins: [] })

    const { status, body } = await get('/user/profile/alice', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(200)
    expect(body.github_username).toBe('alice')
    // loadUserProfile called once (for own profile)
    expect(loadUserProfile).toHaveBeenCalledWith('alice')
  })

  it('allows admin to view any profile', async () => {
    const tok = await makeToken('admin-user', true)
    loadUserProfile.mockResolvedValue({
      github_username: 'bob',
      is_admin:        false,
      projects:        [{ group_id: 'proj-bob', role: 'engineer' }],
    })
    loadAdminConfig.mockResolvedValue({ admins: [{ github_username: 'bob' }] })

    const { status, body } = await get('/user/profile/bob', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(200)
    expect(body.github_username).toBe('bob')
    // Admin flag from config (bob is in admin list)
    expect(body.is_admin).toBe(true)
  })

  it('returns 404 when profile does not exist (self)', async () => {
    const tok = await makeToken('nobody')
    loadUserProfile.mockResolvedValue(null)
    loadAdminConfig.mockResolvedValue({ admins: [] })

    const { status, body } = await get('/user/profile/nobody', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(404)
    expect(body.error).toBe('profile_not_found')
  })

  it('returns 403 when caller and target share no projects', async () => {
    const tok = await makeToken('alice')
    // Alice's profile — project X
    // Bob's profile — project Y (different)
    // verifyJwt calls loadUserProfile('alice') first
    loadUserProfile
      .mockResolvedValueOnce({ github_username: 'alice', projects: [{ group_id: 'proj-x' }] }) // verifyJwt
      .mockResolvedValueOnce({ github_username: 'alice', projects: [{ group_id: 'proj-x' }] }) // Promise.all caller
      .mockResolvedValueOnce({ github_username: 'bob',   projects: [{ group_id: 'proj-y' }] }) // Promise.all target

    const { status, body } = await get('/user/profile/bob', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('returns profile when caller and target share a project', async () => {
    const tok = await makeToken('alice')
    // Call order with verifyJwt middleware included:
    //   1. verifyJwt calls loadUserProfile('alice')
    //   2. Promise.all → loadUserProfile('alice') (access check)
    //   3. Promise.all → loadUserProfile('bob')   (access check)
    //   4. loadUserProfile('bob') — final load
    const aliceProfile = { github_username: 'alice', projects: [{ group_id: 'proj-shared' }] }
    const bobProfile   = { github_username: 'bob',   projects: [{ group_id: 'proj-shared' }] }
    loadUserProfile
      .mockResolvedValueOnce(aliceProfile)  // verifyJwt
      .mockResolvedValueOnce(aliceProfile)  // Promise.all caller
      .mockResolvedValueOnce(bobProfile)    // Promise.all target
      .mockResolvedValueOnce(bobProfile)    // final load
    loadAdminConfig.mockResolvedValue({ admins: [] })

    const { status, body } = await get('/user/profile/bob', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(200)
    expect(body.github_username).toBe('bob')
    expect(body.is_admin).toBe(false)
  })

  it('returns 403 when either caller or target profile is missing (non-self)', async () => {
    const tok = await makeToken('alice')
    // verifyJwt calls first, then Promise.all for the access check
    loadUserProfile
      .mockResolvedValueOnce({ github_username: 'alice', projects: [] }) // verifyJwt
      .mockResolvedValueOnce(null) // Promise.all caller profile → null triggers 403
      .mockResolvedValueOnce({ github_username: 'bob', projects: [{ group_id: 'proj-bob' }] }) // Promise.all target (valid — passes target check)

    const { status, body } = await get('/user/profile/bob', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('is_admin is false when username is not in admin config', async () => {
    const tok = await makeToken('alice')
    loadUserProfile.mockResolvedValue({
      github_username: 'alice',
      projects: [{ group_id: 'proj-alice', role: 'engineer' }],
    })
    loadAdminConfig.mockResolvedValue({ admins: [{ github_username: 'bob' }] })

    const { status, body } = await get('/user/profile/alice', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(200)
    expect(body.is_admin).toBe(false)
  })

  it('is_admin is false when admin config returns null', async () => {
    const tok = await makeToken('alice')
    loadUserProfile.mockResolvedValue({ github_username: 'alice', projects: [{ group_id: 'proj-alice', role: 'engineer' }] })
    loadAdminConfig.mockResolvedValue(null)

    const { status, body } = await get('/user/profile/alice', { Authorization: `Bearer ${tok}` })

    expect(status).toBe(200)
    expect(body.is_admin).toBe(false)
  })
})
