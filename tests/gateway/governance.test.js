/**
 * Gateway: governance endpoints — profile, role update, ownership transfer.
 *
 * Tests the v0.3 governance routes with an in-process Express server.
 * Uses the same http.request pattern as auth.test.js (avoids global fetch pollution).
 *
 * Mocks:
 *   - middleware/verify-jwt.js → injects req.user directly (JWT crypto tested in auth.test.js)
 *   - config-cache.js         → controls profile + config loading/saving + invalidation
 *   - ddb.js                  → controls membership record updates
 *   - shared/audit/governance.js → no-op audit writes (no Postgres in unit tests)
 *
 * Verifies:
 *   1. GET /user/profile/:username → returns profile with projects/roles (onboard flow)
 *   2. POST /config/update-role → updates role, calls invalidateProfile, next profile fetch is fresh
 *   3. POST /config/transfer-ownership → updates owner, invalidates both actors' profiles
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'

// ── Mocks (must precede imports) ───────────────────────────────────────────────

vi.mock('../../gateway/src/middleware/verify-jwt.js', () => ({
  /** Injects a controllable req.user — overridden per-test via mockImplementation. */
  verifyJwt: vi.fn((req, _res, next) => next()),
}))

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadProjectConfig: vi.fn(),
  saveProjectConfig: vi.fn().mockResolvedValue(undefined),
  invalidateProfile: vi.fn().mockResolvedValue(undefined),
  invalidateProject: vi.fn().mockResolvedValue(undefined),
  loadUserProfile:   vi.fn(),
  loadAdminConfig:   vi.fn().mockResolvedValue({ admins: [] }),
}))

vi.mock('../../gateway/src/ddb.js', () => ({
  updateMemberRecord: vi.fn().mockResolvedValue(undefined),
  getUserProjects:    vi.fn().mockResolvedValue([]),
  syncProjectMembers: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../gateway/src/shared/audit/governance.js', () => ({
  writeGovernanceAudit: vi.fn().mockResolvedValue(undefined),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { verifyJwt }                           from '../../gateway/src/middleware/verify-jwt.js'
import { loadProjectConfig, saveProjectConfig,
         invalidateProfile, loadUserProfile,
         loadAdminConfig }                     from '../../gateway/src/config-cache.js'
import { updateMemberRecord }                   from '../../gateway/src/ddb.js'
import { writeGovernanceAudit }                 from '../../gateway/src/shared/audit/governance.js'
import userRoutes                               from '../../gateway/src/routes/user.js'
import configRoutes                             from '../../gateway/src/routes/config.js'

// ── Test server ────────────────────────────────────────────────────────────────

/** @type {import('http').Server} */
let server
/** @type {number} */
let port

const app = express()
app.use(express.json())
// Expose a mock pool on app.locals (governance routes use req.app.locals.pool)
app.locals.pool = { query: vi.fn() }
app.use('/user',   userRoutes)
app.use('/config', configRoutes)
// Error handler matching server.js global handler
app.use((err, _req, res, _next) => {
  if (err.name === 'ConstitutionalViolation') {
    return res.status(400).json({ rule: err.rule, message: err.message })
  }
  const status = err.status ?? 500
  res.status(status).json({ error: err.code ?? 'internal_error', message: err.message })
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
  // Default: no-ops for mutations
  saveProjectConfig.mockResolvedValue(undefined)
  invalidateProfile.mockResolvedValue(undefined)
  updateMemberRecord.mockResolvedValue(undefined)
  writeGovernanceAudit.mockResolvedValue(undefined)
})

// ── HTTP helpers ───────────────────────────────────────────────────────────────

/**
 * Make a GET request via Node http module.
 * @param {string} path
 * @param {Record<string,string>} [headers]
 * @returns {Promise<{ status: number, body: object }>}
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
 * Make a POST request via Node http module.
 * @param {string} path
 * @param {object} body
 * @param {Record<string,string>} [headers]
 * @returns {Promise<{ status: number, body: object }>}
 */
function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
      },
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

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** Alice is the project owner. */
function asOwner() {
  verifyJwt.mockImplementation((req, _res, next) => {
    req.user = { sub: 'alice', is_admin: false, project: 'test-project', role: 'principal_architect', base_confidence: 0.9, is_owner: true }
    next()
  })
}

/** Carol is a platform admin but not the project owner. */
function asAdmin() {
  verifyJwt.mockImplementation((req, _res, next) => {
    req.user = { sub: 'carol', is_admin: true,  project: 'test-project', role: 'principal_architect', base_confidence: 0.9, is_owner: false }
    next()
  })
}

/** Bob is a regular member. */
function asMember() {
  verifyJwt.mockImplementation((req, _res, next) => {
    req.user = { sub: 'bob', is_admin: false, project: 'test-project', role: 'engineer', base_confidence: 0.7, is_owner: false }
    next()
  })
}

const PROJECT_CONFIG = {
  group_id: 'test-project',
  owner:    'alice',
  members: [
    { github_username: 'alice', role: 'principal_architect', team: 'platform', base_confidence: 0.9 },
    { github_username: 'bob',   role: 'engineer',            team: 'backend',  base_confidence: 0.7 },
  ],
  roles: {
    engineer:            { base_confidence: 0.70 },
    senior_engineer:     { base_confidence: 0.80 },
    principal_architect: { base_confidence: 0.90 },
  },
  thresholds: { conflict_threshold: 0.85, authority_threshold: 0.20 },
}

// ── Test 1: Onboard flow — GET /user/profile/:username ─────────────────────────

describe('GET /user/profile/:username — onboard flow', () => {
  it('returns the full profile for the requesting user (self access)', async () => {
    asMember()
    loadUserProfile.mockResolvedValue({
      github_username: 'bob',
      is_admin:        false,
      projects: [
        { group_id: 'test-project', role: 'engineer', base_confidence: 0.7, is_owner: false, team: 'backend' },
      ],
    })

    const { status, body } = await get('/user/profile/bob')

    expect(status).toBe(200)
    expect(body.github_username).toBe('bob')
    expect(body.is_admin).toBe(false)
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0].group_id).toBe('test-project')
    expect(body.projects[0].role).toBe('engineer')
    expect(body.projects[0].is_owner).toBe(false)
  })

  it('returns 404 when the user has no project memberships (self access)', async () => {
    // Bob accessing his own profile (self access) — skips shared-project check
    // so the null return hits the profile_not_found guard directly.
    verifyJwt.mockImplementation((req, _res, next) => {
      req.user = { sub: 'unknown', is_admin: false, project: null, role: null, base_confidence: null, is_owner: false }
      next()
    })
    loadUserProfile.mockResolvedValue(null)

    const { status, body } = await get('/user/profile/unknown')

    expect(status).toBe(404)
    expect(body.error).toBe('profile_not_found')
  })

  it('allows admin to fetch any user profile', async () => {
    asAdmin()
    loadUserProfile.mockResolvedValue({
      github_username: 'bob',
      is_admin: false,
      projects: [{ group_id: 'test-project', role: 'engineer', base_confidence: 0.7, is_owner: false, team: 'backend' }],
    })

    const { status, body } = await get('/user/profile/bob')

    expect(status).toBe(200)
    expect(body.github_username).toBe('bob')
  })
})

// ── Test 2: Role update + immediate cache invalidation ─────────────────────────

describe('POST /config/update-role → cache invalidation', () => {
  it('updates the role, invalidates profile, and the next fetch returns the new role', async () => {
    loadProjectConfig.mockResolvedValue(PROJECT_CONFIG)

    const bobProfile = (role, base_confidence) => ({
      github_username: 'bob',
      is_admin: false,
      projects: [{ group_id: 'test-project', role, base_confidence, is_owner: false, team: 'backend' }],
    })

    // GET before: bob fetches his own profile (self access — single loadUserProfile call)
    asMember()
    loadUserProfile.mockResolvedValueOnce(bobProfile('engineer', 0.7))
    const before = await get('/user/profile/bob')
    expect(before.body.projects[0].role).toBe('engineer')

    // Perform role update as owner
    asOwner()
    const { status, body } = await post('/config/update-role', {
      github_username: 'bob',
      role:            'senior_engineer',
      reason:          'Promoted after Q2 review cycle',
    })

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.github_username).toBe('bob')
    expect(body.role).toBe('senior_engineer')

    // Verify invalidateProfile was called for the updated user
    expect(invalidateProfile).toHaveBeenCalledWith('bob')
    // DDB record also updated
    expect(updateMemberRecord).toHaveBeenCalledWith('bob', 'test-project', expect.objectContaining({ role: 'senior_engineer' }))
    // Audit written
    expect(writeGovernanceAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'role_update', to: 'bob' }),
    )

    // Next profile fetch as bob (self) reflects new role — cache invalidated by update-role
    asMember()
    loadUserProfile.mockResolvedValueOnce(bobProfile('senior_engineer', 0.8))
    const after = await get('/user/profile/bob')
    expect(after.body.projects[0].role).toBe('senior_engineer')
    expect(after.body.projects[0].base_confidence).toBe(0.8)
  })

  it('returns 403 when caller is a regular member', async () => {
    asMember()
    loadProjectConfig.mockResolvedValue(PROJECT_CONFIG)

    const { status, body } = await post('/config/update-role', {
      github_username: 'alice',
      role:            'engineer',
      reason:          'Unauthorized attempt by regular member',
    })

    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
    expect(invalidateProfile).not.toHaveBeenCalled()
  })

  it('returns 400 when reason is too short', async () => {
    asOwner()

    const { status, body } = await post('/config/update-role', {
      github_username: 'bob',
      role:            'senior_engineer',
      reason:          'short',
    })

    expect(status).toBe(400)
    expect(body.rule).toBe('REASON_REQUIRED')
  })
})

// ── Test 3: Ownership transfer ─────────────────────────────────────────────────

describe('POST /config/transfer-ownership', () => {
  it('transfers ownership: updates config, invalidates both actors, returns from/to', async () => {
    asOwner()
    loadProjectConfig.mockResolvedValue(PROJECT_CONFIG)

    const { status, body } = await post('/config/transfer-ownership', {
      to:     'bob',
      reason: 'Bob taking over as project lead from next quarter',
    })

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.from).toBe('alice')
    expect(body.to).toBe('bob')
    expect(body.project).toBe('test-project')

    // Config saved with new owner
    expect(saveProjectConfig).toHaveBeenCalledWith(
      'test-project',
      expect.objectContaining({ owner: 'bob' }),
    )

    // is_owner flags updated in DDB for both old and new owner
    expect(updateMemberRecord).toHaveBeenCalledWith('alice', 'test-project', { is_owner: false })
    expect(updateMemberRecord).toHaveBeenCalledWith('bob',   'test-project', { is_owner: true  })

    // Profile caches invalidated for both (takes effect immediately)
    expect(invalidateProfile).toHaveBeenCalledWith('alice')
    expect(invalidateProfile).toHaveBeenCalledWith('bob')

    // Governance audit written
    expect(writeGovernanceAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ownership_transfer', from: 'alice', to: 'bob' }),
    )
  })

  it('returns 400 when the transfer target is not a project member', async () => {
    asOwner()
    loadProjectConfig.mockResolvedValue(PROJECT_CONFIG)

    const { status, body } = await post('/config/transfer-ownership', {
      to:     'unknown-user',
      reason: 'Attempting to transfer to non-member user',
    })

    expect(status).toBe(400)
    expect(body.error).toBe('not_a_member')
    expect(saveProjectConfig).not.toHaveBeenCalled()
    expect(invalidateProfile).not.toHaveBeenCalled()
  })

  it('returns 403 when an admin tries to transfer ownership to themselves', async () => {
    // carol is the admin — carol cannot transfer to herself
    asAdmin()
    loadProjectConfig.mockResolvedValue(PROJECT_CONFIG)

    const { status, body } = await post('/config/transfer-ownership', {
      to:     'carol',
      reason: 'Admin attempting to self-assign ownership',
    })

    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
    expect(saveProjectConfig).not.toHaveBeenCalled()
  })
})
