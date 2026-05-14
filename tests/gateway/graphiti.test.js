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

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../gateway/src/config-cache.js', () => ({
  loadUserProfile: vi.fn().mockResolvedValue({
    github_username: 'alice',
    is_admin: false,
    projects: [{ group_id: 'test-project', role: 'engineer', base_confidence: 0.7, is_owner: false, team: 'platform' }],
  }),
}))

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
  // v0.3 slim JWT — only sub + is_admin; project is sent via X-Quorum-Project header
  const { privateKey } = await loadKeys()
  token = await new SignJWT({ sub: 'alice', is_admin: false })
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
    // v0.3: project context sent via header; verify-jwt reads it and resolves role from profile
    headers['X-Quorum-Project'] = 'test-project'

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
 * Stub fetch to simulate a Graphiti response, capturing the forwarded request.
 * @param {{ capturedBody?: object, capturedHeaders?: object }} store - mutated on each call
 * @param {{ sessionId?: string|null, status?: number, contentType?: string }} [opts]
 */
function mockGraphiti(store = {}, { sessionId = null, status = 200, contentType = 'application/json' } = {}) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, fetchOpts) => {
    store.capturedBody    = JSON.parse(fetchOpts.body)
    store.capturedHeaders = fetchOpts.headers
    const headerMap = { 'content-type': contentType }
    if (sessionId) headerMap['mcp-session-id'] = sessionId
    return {
      ok:      status < 400,
      status,
      headers: { get: (name) => headerMap[name.toLowerCase()] ?? null },
      json:    async () => ({ result: 'ok' }),
      text:    async () => 'unexpected plain-text response',
    }
  }))
  return store
}

/**
 * POST to the test server, returning status, parsed body, and response headers.
 * Use instead of post() when the test needs to inspect response headers.
 * @param {string} path
 * @param {object} body
 * @param {string} [authToken]
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Promise<{ status: number, body: object | string, headers: http.IncomingHttpHeaders }>}
 */
function postFull(path, body, authToken = token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const headers = {
      'Content-Type':      'application/json',
      'Content-Length':    Buffer.byteLength(payload),
      'X-Quorum-Project':  'test-project',
      ...extraHeaders,
    }
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`

    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => {
          try   { resolve({ status: res.statusCode, body: JSON.parse(raw), headers: res.headers }) }
          catch { resolve({ status: res.statusCode, body: raw,             headers: res.headers }) }
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
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
    expect(store.capturedBody.params.group_id).toBe('test_project')
    expect(store.capturedBody.params.group_id).not.toBe('other-team')
  })

  it('injects group_id when the caller omits it entirely', async () => {
    const store = mockGraphiti()

    const { status } = await post('/graphiti/mcp', {
      method: 'search_memory_facts',
      params: { query: 'auth patterns' },
    })

    expect(status).toBe(200)
    expect(store.capturedBody.params.group_id).toBe('test_project')
  })

  it('overwrites a caller-supplied group_ids array with [JWT project claim]', async () => {
    const store = mockGraphiti()

    const { status } = await post('/graphiti/mcp', {
      method: 'search_memory_facts',
      params: { group_ids: ['other-team', 'yet-another'], query: 'auth patterns' },
    })

    expect(status).toBe(200)
    expect(store.capturedBody.params.group_ids).toEqual(['test_project'])
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

describe('POST /graphiti/*path — MCP session ID forwarding', () => {
  it('forwards Mcp-Session-Id from Graphiti response back to the caller', async () => {
    mockGraphiti({}, { sessionId: 'graphiti-session-abc123' })

    const { status, headers } = await postFull('/graphiti/mcp', { params: {} })

    expect(status).toBe(200)
    expect(headers['mcp-session-id']).toBe('graphiti-session-abc123')
  })

  it('always forwards Accept header upstream so Graphiti does not return 406', async () => {
    const store = mockGraphiti()

    await postFull('/graphiti/mcp', { params: {} }, token, {
      'Accept': 'application/json, text/event-stream',
    })

    expect(store.capturedHeaders['Accept']).toBe('application/json, text/event-stream')
  })

  it('falls back to the required Accept value when caller omits it', async () => {
    const store = mockGraphiti()

    await postFull('/graphiti/mcp', { params: {} })

    expect(store.capturedHeaders['Accept']).toBe('application/json, text/event-stream')
  })

  it('forwards caller Mcp-Session-Id upstream to Graphiti', async () => {
    const store = mockGraphiti()

    await postFull('/graphiti/mcp', { params: {} }, token, { 'Mcp-Session-Id': 'caller-session-xyz' })

    expect(store.capturedHeaders['Mcp-Session-Id']).toBe('caller-session-xyz')
  })

  it('does not inject Mcp-Session-Id upstream when the caller omits it', async () => {
    const store = mockGraphiti()

    await postFull('/graphiti/mcp', { params: {} })

    expect(store.capturedHeaders['Mcp-Session-Id']).toBeUndefined()
  })

  it('does not forward session ID when Graphiti response has none', async () => {
    mockGraphiti({})

    const { headers } = await postFull('/graphiti/mcp', { params: {} })

    expect(headers['mcp-session-id']).toBeUndefined()
  })

  it('proxies non-JSON Graphiti responses without crashing', async () => {
    // Graphiti's TransportSecurityMiddleware used to return "Invalid Host header" as
    // plain text. This caused response.json() to throw an unhandled SyntaxError.
    // The proxy must pass non-JSON through gracefully rather than crash.
    mockGraphiti({}, { status: 421, contentType: 'text/plain' })

    const { status } = await postFull('/graphiti/mcp', { params: {} })

    // 421 is forwarded as-is; the important thing is no unhandled exception
    expect(status).toBe(421)
  })
})
