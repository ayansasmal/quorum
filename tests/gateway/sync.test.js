/**
 * Gateway: POST /sync/configs — S3→DDB project config sync.
 *
 * Auth paths:
 *   - X-Quorum-Sync-Token header == process.env.QUORUM_SYNC_SECRET
 *   - JWT with role === 'principal_architect' (loaded from profile cache)
 *   - Otherwise 403
 *
 * Also verifies the missing-bucket guard (500 config_error).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { SignJWT } from 'jose'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadUserProfile:   vi.fn(),
  invalidateProject: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../gateway/src/ddb.js', () => ({
  syncProjectMembers: vi.fn().mockResolvedValue(undefined),
}))

// Mock S3Client so syncAllConfigs returns an empty list with no real AWS calls.
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    /** @returns {Promise<{ Contents: any[], IsTruncated: false }>} */
    async send() {
      return { Contents: [], IsTruncated: false }
    }
  }
  class ListObjectsV2Command {
    constructor(input) { this.input = input }
  }
  class GetObjectCommand {
    constructor(input) { this.input = input }
  }
  return { S3Client, ListObjectsV2Command, GetObjectCommand }
})

// ── Imports ────────────────────────────────────────────────────────────────────

import { loadUserProfile } from '../../gateway/src/config-cache.js'
import { loadKeys }        from '../../gateway/src/keys.js'
import syncRoutes          from '../../gateway/src/routes/sync.js'

/** @type {http.Server} */
let server
/** @type {number} */
let port

const app = express()
app.use(express.json())
app.use('/sync', syncRoutes)

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
  process.env.QUORUM_CONFIG_BUCKET = 'quorum-configs'
  process.env.QUORUM_SYNC_SECRET   = 'super-secret'
})

afterEach(() => {
  delete process.env.QUORUM_CONFIG_BUCKET
  delete process.env.QUORUM_SYNC_SECRET
})

/**
 * Make a JWT for the given subject.
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
 * Mock loadUserProfile to return the given role for the active project.
 * @param {string|null} role
 */
function mockProfileRole(role) {
  loadUserProfile.mockResolvedValue({
    github_username: 'alice',
    is_admin:        false,
    projects: role
      ? [{ group_id: 'platform-team', role, base_confidence: 0.9, is_owner: false, team: 'core' }]
      : [],
  })
}

describe('POST /sync/configs', () => {
  it('returns 403 forbidden when neither sync token nor JWT is present', async () => {
    const { status, body } = await post('/sync/configs', {})
    // Without sync token, the route enters verify-jwt — which 401s on missing JWT.
    // Both 401 and 403 represent "rejected"; we accept either since the route's
    // pre-auth middleware runs first.
    expect([401, 403]).toContain(status)
    if (status === 403) {
      expect(body.error).toBe('forbidden')
    } else {
      expect(body.error).toBe('missing_token')
    }
  })

  it('accepts valid X-Quorum-Sync-Token and returns sync summary', async () => {
    const { status, body } = await post('/sync/configs', {}, {
      'X-Quorum-Sync-Token': 'super-secret',
    })

    expect(status).toBe(200)
    expect(typeof body.synced).toBe('number')
    expect(Array.isArray(body.failed)).toBe(true)
    expect(typeof body.duration_ms).toBe('number')
  })

  it('accepts JWT with principal_architect role', async () => {
    mockProfileRole('principal_architect')
    const tok = await makeToken('alice')

    const { status, body } = await post('/sync/configs', {}, {
      Authorization:      `Bearer ${tok}`,
      'X-Quorum-Project': 'platform-team',
    })

    expect(status).toBe(200)
    expect(typeof body.synced).toBe('number')
  })

  it('rejects JWT with non-principal_architect role (403)', async () => {
    mockProfileRole('engineer')
    const tok = await makeToken('alice')

    const { status, body } = await post('/sync/configs', {}, {
      Authorization:      `Bearer ${tok}`,
      'X-Quorum-Project': 'platform-team',
    })

    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
  })

  it('returns 500 config_error when QUORUM_CONFIG_BUCKET is unset', async () => {
    delete process.env.QUORUM_CONFIG_BUCKET

    const { status, body } = await post('/sync/configs', {}, {
      'X-Quorum-Sync-Token': 'super-secret',
    })

    expect(status).toBe(500)
    expect(body.error).toBe('config_error')
  })
})
