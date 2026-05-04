/**
 * Gateway: POST /graphiti/*path  — group_id isolation enforcement
 *
 * Verifies that the Graphiti proxy unconditionally overwrites group_id (and
 * group_ids if present) with the JWT project claim, regardless of what the
 * caller supplies in the request body. This is the confused-deputy fix (BL-01).
 *
 * Pattern mirrors auth.test.js:
 *   - Real Express HTTP server on a random port
 *   - Test client uses Node http.request (not fetch) so vi.stubGlobal('fetch')
 *     only intercepts the route's outbound Graphiti call
 *   - JWT signed with the same ephemeral key pair loaded by loadKeys()
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import { SignJWT } from 'jose'

// ── Imports ────────────────────────────────────────────────────────────────────

import { loadKeys }     from '../../gateway/src/keys.js'
import graphitiRoutes   from '../../gateway/src/routes/graphiti.js'

// ── Test server ────────────────────────────────────────────────────────────────

/** @type {http.Server} */
let server
/** @type {number} */
let port
/** @type {string} */
let token

const app = express()
app.use(express.json())
app.use('/graphiti', graphitiRoutes)

beforeAll(async () => {
  const { privateKey } = await loadKeys()
  token = await new SignJWT({ sub: 'alice', project: 'test-project', role: 'engineer', team: 'platform', base_confidence: 0.7 })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer('quorum-gateway')
    .setExpirationTime('1h')
    .sign(privateKey)

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

// ── HTTP helpers ───────────────────────────────────────────────────────────────

/**
 * POST to the test server using Node http.request (avoids global fetch contamination).
 * @param {string} path
 * @param {object} body
 * @param {string} [authToken]
 * @returns {Promise<{ status: number, body: object | string }>}
 */
function post(path, body, authToken = token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
    }
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`

    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => { raw += chunk })
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
 * Stub fetch to simulate a Graphiti response, capturing the forwarded request body.
 * @param {{ capturedBody?: object }} store - mutated with the parsed body the route forwards
 */
function mockGraphiti(store = {}) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, opts) => {
    store.capturedBody = JSON.parse(opts.body)
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ result: 'ok' }),
    }
  }))
  return store
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /graphiti/*path — group_id isolation', () => {
  it('overwrites a caller-supplied group_id with the JWT project claim', async () => {
    const store = mockGraphiti()

    const { status } = await post('/graphiti/mcp', {
      method: 'search_memory_facts',
      params: { group_id: 'other-team', query: 'auth patterns' },
    })

    expect(status).toBe(200)
    expect(store.capturedBody.params.group_id).toBe('test-project')
    expect(store.capturedBody.params.group_id).not.toBe('other-team')
  })

  it('injects group_id when the caller omits it entirely', async () => {
    const store = mockGraphiti()

    const { status } = await post('/graphiti/mcp', {
      method: 'search_memory_facts',
      params: { query: 'auth patterns' },
    })

    expect(status).toBe(200)
    expect(store.capturedBody.params.group_id).toBe('test-project')
  })

  it('overwrites a caller-supplied group_ids array with [JWT project claim]', async () => {
    const store = mockGraphiti()

    const { status } = await post('/graphiti/mcp', {
      method: 'search_memory_facts',
      params: { group_ids: ['other-team', 'yet-another'], query: 'auth patterns' },
    })

    expect(status).toBe(200)
    expect(store.capturedBody.params.group_ids).toEqual(['test-project'])
  })

  it('does not add group_ids when the caller did not include it', async () => {
    const store = mockGraphiti()

    await post('/graphiti/mcp', {
      method: 'search_memory_facts',
      params: { query: 'auth patterns' },
    })

    expect(store.capturedBody.params.group_ids).toBeUndefined()
  })

  it('returns 401 when no Authorization header is present', async () => {
    const { status, body } = await post('/graphiti/mcp', { params: {} }, null)

    expect(status).toBe(401)
    expect(body.error).toBe('missing_token')
  })

  it('returns 502 when Graphiti is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const { status, body } = await post('/graphiti/mcp', { params: {} })

    expect(status).toBe(502)
    expect(body.error).toBe('graphiti_unavailable')
  })
})
