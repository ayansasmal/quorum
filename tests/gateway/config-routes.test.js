/**
 * Tests for gateway/src/routes/config.js
 *
 * POST /config/validate    — no auth required
 * GET  /config/:projectId  — JWT required, project-scoped
 * POST /config/:projectId/invalidate — JWT required, project-scoped
 * POST /config/upload       — upload new project (sync-token or JWT)
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { SignJWT } from 'jose'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadProjectConfig:  vi.fn(),
  saveProjectConfig:  vi.fn().mockResolvedValue(undefined),
  invalidateProject:  vi.fn(),
  invalidateProfile:  vi.fn().mockResolvedValue(undefined),
  loadUserProfile:    vi.fn(),
}))

vi.mock('../../gateway/src/ddb.js', () => ({
  updateMemberRecord: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../gateway/src/shared/audit/governance.js', () => ({
  writeGovernanceAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../gateway/src/shared/graph/queries.js', () => ({
  createProject:      vi.fn().mockResolvedValue('q_p1'),
  getProjectByGroupId: vi.fn().mockResolvedValue(null),
}))

// Mock S3 client so no real AWS calls happen
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    async send(cmd) {
      if (cmd._type === 'head') {
        const err = new Error('Not Found')
        err.name = 'NotFound'
        err.$metadata = { httpStatusCode: 404 }
        throw err
      }
      return {}
    }
  }
  class HeadObjectCommand {
    constructor(i) { this.input = i; this._type = 'head' }
  }
  class PutObjectCommand {
    constructor(i) { this.input = i; this._type = 'put' }
  }
  return { S3Client, HeadObjectCommand, PutObjectCommand, GetObjectCommand: class {} }
})

// Mock sync module to avoid real S3 calls in syncOneProject
vi.mock('../../gateway/src/routes/sync.js', async (importOriginal) => {
  const orig = await importOriginal()
  return {
    ...orig,
    getS3: vi.fn(() => ({
      send: vi.fn(async (cmd) => {
        if (cmd._type === 'head') {
          const err = new Error('Not Found')
          err.name = 'NotFound'
          err.$metadata = { httpStatusCode: 404 }
          throw err
        }
        return {}
      }),
    })),
    syncOneProject: vi.fn().mockResolvedValue({ ok: true }),
  }
})

// ── Imports ────────────────────────────────────────────────────────────────────

import { loadProjectConfig, loadUserProfile, invalidateProject } from '../../gateway/src/config-cache.js'
import { createProject, getProjectByGroupId } from '../../gateway/src/shared/graph/queries.js'
import { loadKeys } from '../../gateway/src/keys.js'
import configRoutes from '../../gateway/src/routes/config.js'

/** @type {http.Server} */
let server
/** @type {number} */
let port

const app = express()
app.use(express.json())
app.locals.pool = { query: vi.fn() }
app.use('/config', configRoutes)
app.use((err, _req, res, _next) => {
  const status = err.status ?? 500
  const code   = err.code   ?? 'INTERNAL_ERROR'
  res.status(status).json({ error: code.toLowerCase(), message: err.message })
})

beforeAll(async () => {
  await loadKeys()
  process.env.QUORUM_CONFIG_BUCKET = 'quorum-configs'
  process.env.QUORUM_SYNC_SECRET   = 'sync-secret'
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
})

afterAll(() => {
  delete process.env.QUORUM_CONFIG_BUCKET
  delete process.env.QUORUM_SYNC_SECRET
  server.close()
})

beforeEach(() => vi.clearAllMocks())

// ── Helpers ────────────────────────────────────────────────────────────────────

async function makeToken(sub = 'alice', overrides = {}) {
  const { privateKey } = await loadKeys()
  return new SignJWT({ sub, is_admin: false, ...overrides })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer('quorum-gateway')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

function mockProfile(sub = 'alice', projectId = 'my-project', role = 'engineer') {
  loadUserProfile.mockResolvedValue({
    github_username: sub,
    is_admin:        false,
    projects:        [{ group_id: projectId, role, base_confidence: 0.7, is_owner: false }],
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

const get  = (path, headers = {}) => request('GET',  path, null, headers)
const post = (path, body, headers = {}) => request('POST', path, body, headers)
const put  = (path, body, headers = {}) => request('PUT',  path, body, headers)

// ── POST /config/validate ─────────────────────────────────────────────────────

describe('POST /config/validate', () => {
  const VALID_CONFIG = {
    group_id: 'my-project',
    owner:    'alice',
    members:  [{ name: 'Alice', github_username: 'alice', role: 'principal_architect', team: 'platform' }],
  }

  it('returns valid:true with summary for a valid config', async () => {
    const { status, body } = await post('/config/validate', VALID_CONFIG)
    expect(status).toBe(200)
    expect(body.valid).toBe(true)
    expect(body.summary.project).toBe('my-project')
    expect(body.summary.members).toBe(1)
  })

  it('returns valid:false with errors for an invalid config', async () => {
    const { status, body } = await post('/config/validate', { invalid: true })
    expect(status).toBe(400)
    expect(body.valid).toBe(false)
    expect(Array.isArray(body.errors)).toBe(true)
  })

  it('includes domain and role counts in summary', async () => {
    const config = {
      ...VALID_CONFIG,
      domains: { auth: { conflict_threshold: 0.9 } },
    }
    const { status, body } = await post('/config/validate', config)
    expect(status).toBe(200)
    expect(body.summary.domains).toBe(1)
  })
})

// ── GET /config/:projectId ────────────────────────────────────────────────────

describe('GET /config/:projectId', () => {
  it('returns 401 when no Authorization header', async () => {
    const { status } = await get('/config/my-project')
    expect(status).toBe(401)
  })

  it('returns 403 when JWT project does not match requested projectId', async () => {
    mockProfile('alice', 'other-project')
    const tok = await makeToken('alice')
    const { status, body } = await get(
      '/config/my-project',
      { Authorization: `Bearer ${tok}`, 'X-Quorum-Project': 'other-project' },
    )
    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('returns project config when JWT matches projectId', async () => {
    mockProfile('alice', 'my-project', 'principal_architect')
    const tok = await makeToken('alice')
    loadProjectConfig.mockResolvedValue({ group_id: 'my-project', owner: 'alice', members: [] })

    const { status, body } = await get(
      '/config/my-project',
      { Authorization: `Bearer ${tok}`, 'X-Quorum-Project': 'my-project' },
    )
    expect(status).toBe(200)
    expect(body.group_id).toBe('my-project')
  })

  it('returns 404 when loadProjectConfig throws', async () => {
    mockProfile('alice', 'missing-project')
    const tok = await makeToken('alice')
    loadProjectConfig.mockRejectedValue(new Error('config not found'))

    const { status, body } = await get(
      '/config/missing-project',
      { Authorization: `Bearer ${tok}`, 'X-Quorum-Project': 'missing-project' },
    )
    expect(status).toBe(404)
    expect(body.error).toBe('config_not_found')
  })
})

// ── POST /config/:projectId/invalidate ────────────────────────────────────────

describe('POST /config/:projectId/invalidate', () => {
  it('returns 401 when no Authorization header', async () => {
    const { status } = await post('/config/my-project/invalidate', {})
    expect(status).toBe(401)
  })

  it('returns 403 when JWT project does not match', async () => {
    mockProfile('alice', 'other-project')
    const tok = await makeToken('alice')
    const { status } = await post(
      '/config/my-project/invalidate',
      {},
      { Authorization: `Bearer ${tok}`, 'X-Quorum-Project': 'other-project' },
    )
    expect(status).toBe(403)
  })

  it('invalidates cache and returns ok', async () => {
    mockProfile('alice', 'my-project', 'principal_architect')
    const tok = await makeToken('alice')

    const { status, body } = await post(
      '/config/my-project/invalidate',
      {},
      { Authorization: `Bearer ${tok}`, 'X-Quorum-Project': 'my-project' },
    )
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(invalidateProject).toHaveBeenCalledWith('my-project')
  })
})

// ── POST /config/upload ────────────────────────────────────────────────────────

describe('POST /config/upload', () => {
  const VALID_CONFIG = {
    group_id: 'new-project',
    owner:    'alice',
    members:  [{ name: 'Alice', github_username: 'alice', role: 'principal_architect', team: 'platform' }],
  }

  it('returns 401 when no auth and no sync token', async () => {
    // Without sync token, verifyJwt runs and rejects with 401
    const { status } = await post('/config/upload', VALID_CONFIG)
    expect(status).toBe(401)
  })

  it('returns 500 when QUORUM_CONFIG_BUCKET is not set', async () => {
    delete process.env.QUORUM_CONFIG_BUCKET
    const { status, body } = await post(
      '/config/upload',
      VALID_CONFIG,
      { 'X-Quorum-Sync-Token': 'sync-secret' },
    )
    expect(status).toBe(500)
    expect(body.error).toBe('config_error')
    process.env.QUORUM_CONFIG_BUCKET = 'quorum-configs'
  })

  it('returns 400 when config fails schema validation', async () => {
    const { status, body } = await post(
      '/config/upload',
      { invalid: 'config without required fields' },
      { 'X-Quorum-Sync-Token': 'sync-secret' },
    )
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_config')
    expect(Array.isArray(body.errors)).toBe(true)
  })

  it('accepts sync token and creates project (happy path)', async () => {
    const { syncOneProject } = await import('../../gateway/src/routes/sync.js')
    syncOneProject.mockResolvedValue({ ok: true })

    const { status, body } = await post(
      '/config/upload',
      VALID_CONFIG,
      { 'X-Quorum-Sync-Token': 'sync-secret' },
    )

    expect(status).toBe(201)
    expect(body.project_id).toBe('new-project')
  })

  it('returns 409 and does not overwrite when project already exists in S3', async () => {
    const send = vi.fn(async (cmd) => {
      if (cmd._type === 'head') return {}
      throw new Error('PutObject must not run for an existing namespace')
    })

    // Override S3 mock for this test: HeadObject succeeds (project exists).
    const { getS3 } = await import('../../gateway/src/routes/sync.js')
    getS3.mockReturnValueOnce({ send })

    const { status, body } = await post(
      '/config/upload',
      VALID_CONFIG,
      { 'X-Quorum-Sync-Token': 'sync-secret' },
    )

    expect(status).toBe(409)
    expect(body.error).toBe('already_onboarded')
    expect(body.project_id).toBe('new-project')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('allows bootstrap upload when JWT user is principal_architect in config', async () => {
    mockProfile('alice', 'bootstrap-project', 'principal_architect')
    const tok = await makeToken('alice')
    const { syncOneProject } = await import('../../gateway/src/routes/sync.js')
    syncOneProject.mockResolvedValue({ ok: true })

    const config = {
      group_id: 'bootstrap-project',
      owner:    'alice',
      members:  [{ name: 'Alice', github_username: 'alice', role: 'principal_architect', team: 'platform' }],
    }

    const { status, body } = await post(
      '/config/upload',
      config,
      { Authorization: `Bearer ${tok}` },
    )

    expect(status).toBe(201)
    expect(body.project_id).toBe('bootstrap-project')
  })

  it('updates an existing config through PUT and re-registers a missing project row', async () => {
    mockProfile('alice', 'new-project', 'principal_architect')
    getProjectByGroupId.mockResolvedValueOnce(null)
    createProject.mockResolvedValueOnce('q_recreated')
    const tok = await makeToken('alice')

    const { status, body } = await put(
      '/config/new-project',
      VALID_CONFIG,
      {
        Authorization:      `Bearer ${tok}`,
        'X-Quorum-Project': 'new-project',
      },
    )

    expect(status).toBe(200)
    expect(body.q_project_id).toBe('q_recreated')
    expect(createProject).toHaveBeenCalledWith(
      app.locals.pool,
      'new-project',
      'alice',
      VALID_CONFIG.members,
      { domains: {} },
      expect.objectContaining({ createdBy: 'alice' }),
    )
  })
})
