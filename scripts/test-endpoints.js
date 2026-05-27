#!/usr/bin/env node
/**
 * Quorum Gateway — Endpoint smoke-test runner.
 *
 * Tests every documented endpoint in openapi.yaml against a live gateway.
 * Requires a valid JWT (see "Getting a fresh token" section in docs/e2e/TOKENS.md).
 *
 * Usage:
 *   node scripts/test-endpoints.js
 *
 * Environment variables:
 *   QUORUM_GATEWAY_URL  — gateway base URL (default: http://localhost:3001)
 *   QUORUM_TEST_JWT     — pre-issued JWT (see docs/e2e/TOKENS.md)
 *   QUORUM_GITHUB_TOKEN — GitHub OAuth token; used to obtain a JWT if QUORUM_TEST_JWT not set
 *   QUORUM_PROJECT_ID   — project slug to test against (default: amethyst-munchkin)
 *
 * Exit codes:
 *   0 — all tests passed
 *   1 — one or more tests failed
 */

import { createServer } from 'node:http'

// ── Config ────────────────────────────────────────────────────────────────────

const BASE     = (process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001').replace(/\/$/, '')
const PROJECT  = process.env.QUORUM_PROJECT_ID   ?? 'amethyst-munchkin'
let   JWT      = process.env.QUORUM_TEST_JWT      ?? ''

// ── Colour helpers ────────────────────────────────────────────────────────────

const C = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * Make an HTTP request and return { status, headers, body }.
 * @param {string} method
 * @param {string} path
 * @param {object} [opts]
 * @param {object} [opts.headers]
 * @param {object|string} [opts.body]
 * @returns {Promise<{status:number, headers:object, body:string, json:any}>}
 */
async function req(method, path, { headers = {}, body } = {}) {
  const url     = new URL(BASE + path)
  const payload = body ? JSON.stringify(body) : undefined
  const res     = await fetch(url.toString(), {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
      ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
    },
    body: payload,
    redirect: 'manual',
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }
  return { status: res.status, headers: Object.fromEntries(res.headers), body: text, json }
}

/** Authenticated helper — injects JWT + X-Quorum-Project. */
function authReq(method, path, opts = {}) {
  return req(method, path, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${JWT}`,
      'X-Quorum-Project': PROJECT,
      ...(opts.headers ?? {}),
    },
  })
}

// ── Test runner ───────────────────────────────────────────────────────────────

const results = []
let   current = null

/**
 * Declare a test case.
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
function test(name, fn) {
  results.push({ name, fn })
}

/**
 * Assert an expected HTTP status code.
 * @param {number} actual
 * @param {number} expected
 * @param {string} [hint]
 */
function expectStatus(actual, expected, hint = '') {
  if (actual !== expected) {
    throw new Error(`Expected HTTP ${expected}, got ${actual}${hint ? ` — ${hint}` : ''}`)
  }
}

/**
 * Assert a JSON response contains all expected keys.
 * @param {any} json
 * @param {string[]} keys
 */
function expectKeys(json, keys) {
  if (!json || typeof json !== 'object') throw new Error(`Response is not a JSON object: ${json}`)
  const missing = keys.filter((k) => !(k in json))
  if (missing.length) throw new Error(`Missing keys in response: ${missing.join(', ')}`)
}

/**
 * Assert a response is an array (optionally check element keys).
 * @param {any} json
 * @param {string[]} [elementKeys]
 */
function expectArray(json, elementKeys = []) {
  if (!Array.isArray(json)) throw new Error(`Expected array, got ${typeof json}`)
  if (elementKeys.length && json.length > 0) {
    const missing = elementKeys.filter((k) => !(k in json[0]))
    if (missing.length) throw new Error(`Array element missing keys: ${missing.join(', ')}`)
  }
}

// ── Obtain JWT if not provided ────────────────────────────────────────────────

async function ensureJwt() {
  if (JWT) return

  const ghToken = process.env.QUORUM_GITHUB_TOKEN
  if (!ghToken) {
    console.error(C.red('\n  Error: No JWT available.'))
    console.error(C.yellow('  Set QUORUM_TEST_JWT or QUORUM_GITHUB_TOKEN to proceed.\n'))
    console.error('  Quick options:')
    console.error(C.dim('    # Option 1 — GitHub CLI (recommended)'))
    console.error('    QUORUM_GITHUB_TOKEN=$(gh auth token) node scripts/test-endpoints.js\n')
    console.error(C.dim('    # Option 2 — use a pre-issued JWT'))
    console.error('    QUORUM_TEST_JWT=eyJ... node scripts/test-endpoints.js\n')
    console.error(C.dim('    # Option 3 — get a JWT via curl'))
    console.error('    curl -s -X POST http://localhost:3001/auth/token \\')
    console.error('      -H "Content-Type: application/json" \\')
    console.error('      -d \'{"github_token":"<PAT>","project_id":"amethyst-munchkin"}\' | jq -r .token\n')
    process.exit(1)
  }

  console.log(C.dim('  Obtaining JWT via POST /auth/token...'))
  const res = await req('POST', '/auth/token', {
    body: { github_token: ghToken, project_id: PROJECT },
  })
  if (res.status !== 200 || !res.json?.token) {
    console.error(C.red(`  Failed to get JWT: ${res.body}`))
    process.exit(1)
  }
  JWT = res.json.token
  console.log(C.green(`  JWT obtained for ${res.json.sub} (${res.json.role})`))
}

// ── Test definitions ──────────────────────────────────────────────────────────

// ── Public endpoints ──────────────────────────────────────────────────────────

test('GET /health → 200 with status+components', async () => {
  const { status, json } = await req('GET', '/health')
  expectStatus(status, 200)
  expectKeys(json, ['status', 'components'])
  if (json.status !== 'healthy') throw new Error(`Gateway unhealthy: ${JSON.stringify(json.components)}`)
})

test('GET /.well-known/jwks.json → 200 with keys array', async () => {
  const { status, json } = await req('GET', '/.well-known/jwks.json')
  expectStatus(status, 200)
  expectKeys(json, ['keys'])
  if (!Array.isArray(json.keys) || json.keys.length === 0) throw new Error('JWKS keys array empty')
})

test('GET /.well-known/oauth-authorization-server → 200 RFC8414 metadata', async () => {
  const { status, json } = await req('GET', '/.well-known/oauth-authorization-server')
  expectStatus(status, 200)
  expectKeys(json, ['issuer', 'authorization_endpoint', 'token_endpoint'])
})

test('GET /schema/config → 200 JSON Schema', async () => {
  const { status, json } = await req('GET', '/schema/config')
  expectStatus(status, 200)
  if (json?.error) throw new Error(`schema/config returned error: ${json.message}`)
  expectKeys(json, ['$schema', 'type', 'properties'])
  if (!json.properties?.group_id) throw new Error('Missing group_id in schema properties')
  if (!json.properties?.owner)    throw new Error('Missing owner in schema properties (v0.3 required field)')
})

test('POST /config/validate → 200 {valid:true} for valid config', async () => {
  const { status, json } = await req('POST', '/config/validate', {
    body: {
      owner:      'testuser',
      group_id:   'test-project',
      members:    [],
      roles:      { principal_architect: { base_confidence: 0.9 } },
      domains:    {},
      thresholds: {},
    },
  })
  expectStatus(status, 200)
  expectKeys(json, ['valid'])
  if (!json.valid) throw new Error(`Config validation failed: ${JSON.stringify(json.errors ?? json)}`)
})

test('POST /config/validate → 400 {valid:false} for config missing owner', async () => {
  const { status, json } = await req('POST', '/config/validate', {
    body: { group_id: 'test-project', members: [] },
  })
  // Route returns 400 (not 200) for invalid configs — valid:false is in the body
  expectStatus(status, 400)
  if (json.valid !== false) throw new Error('Expected valid:false in body')
  if (!Array.isArray(json.errors)) throw new Error('Expected errors array in body')
})

// ── Auth endpoints ────────────────────────────────────────────────────────────

test('GET /auth/projects → 410 Gone (retired in v0.3)', async () => {
  const { status } = await authReq('GET', '/auth/projects')
  expectStatus(status, 410)
})

test('POST /auth/switch → 410 Gone (retired in v0.3)', async () => {
  const { status } = await authReq('POST', '/auth/switch', {
    body: { project_id: PROJECT },
  })
  expectStatus(status, 410)
})

test('POST /auth/refresh → 200 with valid JWT (stateless refresh)', async () => {
  // /auth/refresh simply re-issues a new JWT from the existing one — no separate refresh token needed.
  // verifyJwt middleware validates the bearer token; if valid, a new JWT is issued.
  const { status, json } = await req('POST', '/auth/refresh', {
    headers: { Authorization: `Bearer ${JWT}` },
    body: {},
  })
  expectStatus(status, 200)
  expectKeys(json, ['token', 'expires_in', 'sub'])
})

// ── Config endpoints ──────────────────────────────────────────────────────────

test(`GET /config/${PROJECT} → 200 project config object`, async () => {
  const { status, json } = await authReq('GET', `/config/${PROJECT}`)
  expectStatus(status, 200)
  expectKeys(json, ['group_id', 'owner', 'members'])
  if (json.group_id !== PROJECT) throw new Error(`group_id mismatch: ${json.group_id}`)
  if (!json.owner) throw new Error('owner field missing (v0.3 required field)')
})

// ── v0.3 User profile ─────────────────────────────────────────────────────────

test('GET /user/profile/:username → 200 with projects array', async () => {
  const { status, json } = await req('GET', '/user/profile/ayansasmal', {
    headers: { Authorization: `Bearer ${JWT}` },
  })
  expectStatus(status, 200)
  expectKeys(json, ['github_username', 'projects'])
  if (!Array.isArray(json.projects)) throw new Error('projects field should be an array')
})

// ── PG routes ─────────────────────────────────────────────────────────────────

test('GET /pg/versions/drafts → 200 bare array', async () => {
  const { status, json } = await authReq('GET', '/pg/versions/drafts')
  expectStatus(status, 200)
  expectArray(json)
})

test('GET /pg/versions/status-counts → 200 object with status keys', async () => {
  const { status, json } = await authReq('GET', '/pg/versions/status-counts')
  expectStatus(status, 200)
  if (!json || typeof json !== 'object') throw new Error('Expected object')
  const validStatuses = ['ACTIVE', 'DRAFT', 'SUPERSEDED', 'DEPRECATED', 'PENDING_ACTIVE']
  const keys = Object.keys(json)
  if (keys.length === 0) throw new Error('status-counts returned empty object')
  const invalid = keys.filter((k) => !validStatuses.includes(k))
  if (invalid.length) throw new Error(`Unexpected status keys: ${invalid.join(', ')}`)
})

test('GET /pg/versions/by-status/ACTIVE → 200 bare array', async () => {
  const { status, json } = await authReq('GET', '/pg/versions/by-status/ACTIVE')
  expectStatus(status, 200)
  expectArray(json)
  if (json.length > 0) {
    expectKeys(json[0], ['topic', 'key', 'version', 'status', 'confidence', 'author'])
    if (json[0].status !== 'ACTIVE') throw new Error(`by-status/ACTIVE returned non-ACTIVE entry: ${json[0].status}`)
  }
})

test('GET /pg/versions/:topic/:key → 200 single version object (current ACTIVE)', async () => {
  // Returns the current ACTIVE version as a single object, not an array.
  // Use /pg/versions/:topic/:key/history for the full version array.
  const { json: activeEntries } = await authReq('GET', '/pg/versions/by-status/ACTIVE')
  if (!activeEntries?.length) {
    console.log(C.yellow('    (skipped — no ACTIVE entries in project)'))
    return
  }
  const { topic, key } = activeEntries[0]
  const { status, json } = await authReq('GET', `/pg/versions/${encodeURIComponent(topic)}/${encodeURIComponent(key)}`)
  expectStatus(status, 200)
  if (Array.isArray(json)) throw new Error('Expected single object, got array — use /history for version list')
  expectKeys(json, ['topic', 'key', 'version', 'status'])
  if (json.status !== 'ACTIVE') throw new Error(`Expected ACTIVE version, got ${json.status}`)
})

test('GET /pg/audit → 200 {entries:[...]}', async () => {
  const { status, json } = await authReq('GET', '/pg/audit')
  expectStatus(status, 200)
  expectKeys(json, ['entries'])
  expectArray(json.entries)
})

test('GET /pg/audit/lineage/:topic/:key → 200 {entries:[...]}', async () => {
  const { json: activeEntries } = await authReq('GET', '/pg/versions/by-status/ACTIVE')
  if (!activeEntries?.length) {
    console.log(C.yellow('    (skipped — no ACTIVE entries in project)'))
    return
  }
  const { topic, key } = activeEntries[0]
  const { status, json } = await authReq('GET', `/pg/audit/lineage/${encodeURIComponent(topic)}/${encodeURIComponent(key)}`)
  expectStatus(status, 200)
  expectKeys(json, ['entries'])
  expectArray(json.entries)
})

test('GET /pg/pending → 200 bare array', async () => {
  const { status, json } = await authReq('GET', '/pg/pending')
  expectStatus(status, 200)
  expectArray(json)
})

// ── Dashboard BFF routes ──────────────────────────────────────────────────────

test('GET /api/stats → 200 aggregated stats object', async () => {
  const { status, json } = await authReq('GET', '/api/stats')
  expectStatus(status, 200)
  expectKeys(json, ['activity', 'confidence', 'domains', 'pending'])
})

test('GET /api/graph → 200 {nodes,edges}', async () => {
  const { status, json } = await authReq('GET', '/api/graph')
  expectStatus(status, 200)
  expectKeys(json, ['nodes', 'edges'])
  if (!Array.isArray(json.nodes)) throw new Error('nodes should be array')
  if (!Array.isArray(json.edges)) throw new Error('edges should be array')
})

test('GET /api/knowledge → 200 paginated {items,page,pages,total}', async () => {
  const { status, json } = await authReq('GET', '/api/knowledge')
  expectStatus(status, 200)
  expectKeys(json, ['items', 'page', 'pages', 'total'])
  if (!Array.isArray(json.items)) throw new Error('items should be array')
})

test('GET /api/search?q=auth → 200 {results,source}', async () => {
  const { status, json } = await authReq('GET', '/api/search?q=auth')
  expectStatus(status, 200)
  expectKeys(json, ['results', 'source'])
  if (!Array.isArray(json.results)) throw new Error('results should be array')
  if (!['graphiti', 'postgres'].includes(json.source)) throw new Error(`Unexpected source: ${json.source}`)
})

test('GET /api/knowledge/:topic/:key → 404 for non-existent entry', async () => {
  const { status, json } = await authReq('GET', '/api/knowledge/nonexistent/no-such-key-xyz')
  expectStatus(status, 404)
  expectKeys(json, ['error'])
})

// ── Governance routes ─────────────────────────────────────────────────────────

test('POST /governance/detect-conflict → 503 when OpenAI not configured (or 200)', async () => {
  const { status } = await authReq('POST', '/governance/detect-conflict', {
    body: {
      topic: 'auth', key: 'token-strategy',
      existing: 'Use session tokens for all services',
      incoming: 'Use ES256 JWT for Lambda stateless auth',
    },
  })
  if (![200, 503].includes(status)) throw new Error(`Expected 200 or 503, got ${status}`)
})

test('POST /governance/enrich → 503 when OpenAI not configured (or 200)', async () => {
  const { status } = await authReq('POST', '/governance/enrich', {
    body: {
      conflict_id: 'cfl_test',
      existing:    { content: 'Use session tokens', author: 'alice', confidence: 0.85 },
      incoming:    { content: 'Use JWT tokens',     author: 'bob',   confidence: 0.70 },
    },
  })
  if (![200, 400, 503].includes(status)) throw new Error(`Expected 200/400/503, got ${status}`)
})

// ── Graphiti proxy ────────────────────────────────────────────────────────────

test('POST /graphiti/mcp → proxies to Graphiti MCP endpoint (expect 200 or 5xx)', async () => {
  // The graphiti proxy is POST /graphiti/*path — bare /graphiti returns 404 (empty path).
  // The MCP endpoint is /graphiti/mcp (maps to {GRAPHITI_URL}/mcp).
  const { status } = await authReq('POST', '/graphiti/mcp', {
    body: { method: 'get_memory_status', params: {} },
  })
  // 406 = Graphiti rejected the content type / method format — still a successful proxy
  if (![200, 400, 406, 422, 500, 503].includes(status)) throw new Error(`Unexpected status: ${status}`)
})

// ── Run all tests ─────────────────────────────────────────────────────────────

async function run() {
  await ensureJwt()

  console.log(C.bold(`\nQuorum Gateway Smoke Tests`))
  console.log(C.dim(`  Target: ${BASE}`))
  console.log(C.dim(`  Project: ${PROJECT}`))
  console.log(C.dim(`  JWT sub: ${JSON.parse(Buffer.from(JWT.split('.')[1], 'base64').toString()).sub}`))
  console.log()

  let passed = 0
  let failed = 0
  const failures = []

  for (const { name, fn } of results) {
    try {
      await fn()
      console.log(`  ${C.green('✓')} ${name}`)
      passed++
    } catch (err) {
      console.log(`  ${C.red('✗')} ${name}`)
      console.log(`    ${C.red(err.message)}`)
      failed++
      failures.push({ name, error: err.message })
    }
  }

  console.log()
  console.log(`  ${C.bold('Results:')} ${C.green(passed + ' passed')}, ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')} / ${results.length} total`)

  if (failures.length) {
    console.log()
    console.log(C.red(C.bold('  Failed tests:')))
    failures.forEach(({ name, error }) => {
      console.log(`  ${C.red('→')} ${name}`)
      console.log(`    ${C.dim(error)}`)
    })
    console.log()
    process.exit(1)
  } else {
    console.log(C.green('\n  All tests passed.\n'))
  }
}

run().catch((err) => {
  console.error(C.red(`\nFatal error: ${err.message}`))
  process.exit(1)
})
