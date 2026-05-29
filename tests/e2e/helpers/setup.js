/**
 * Playwright globalSetup — T0 infrastructure probes.
 *
 * Runs once before any test. If any probe fails the suite is stopped
 * immediately — T0 failures are infrastructure problems, not application bugs,
 * and must not populate the fix_queue.
 *
 * Responsibilities:
 *   1. Wait until the gateway is healthy (T0.1).
 *   2. Upload both fixture project configs so every scenario can use
 *      quorum-test-catalog and quorum-test-project (idempotent: 409 = already uploaded, OK).
 *   3. JWT round-trip — sign with test key, assert gateway accepts it (T0.2).
 *   4. Config probe — GET /api/globals and GET /user/profile/test-pe both 200 (T0.3).
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import axios from 'axios'
import jwt from 'jsonwebtoken'

const __dir   = dirname(fileURLToPath(import.meta.url))
const GATEWAY = process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001'
const PRIV    = readFileSync(resolve(__dir, '../fixtures/test-private-key.pem'))
const KEY_ID  = 'test-key-1'

/**
 * Signs a minimal test JWT. MUST include issuer: 'quorum-gateway' — verify-jwt.js
 * passes { issuer: 'quorum-gateway' } to jose jwtVerify and rejects on mismatch.
 *
 * @param {string} sub
 */
function makeToken(sub) {
  return jwt.sign({ sub }, PRIV, {
    algorithm: 'ES256',
    expiresIn: '1h',
    keyid:     KEY_ID,
    issuer:    'quorum-gateway',
  })
}

/** Polls /health until the gateway is ready or timeout elapses. */
async function waitForGateway(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const r = await axios.get(`${GATEWAY}/health`, { validateStatus: () => true })
      if (r.status === 200) return
      last = `HTTP ${r.status}`
    } catch (err) {
      last = err.message
    }
    await new Promise(r => setTimeout(r, 2_000))
  }
  throw new Error(`T0.1 FAIL — gateway not healthy after ${timeoutMs / 1000}s. Last error: ${last}`)
}

/**
 * Upload (or update) a fixture config. Returns the response.
 * 201 = fresh upload. 200 = config updated (upserted).
 * Any other status is a setup failure.
 *
 * POST /config/upload is a true upsert: 201 on first upload, 200 on subsequent
 * calls. This ensures fixture changes (e.g. new members) are always reflected
 * in the running test environment without requiring an env restart.
 *
 * @param {string} configPath - absolute path to the .quorum.json fixture
 * @param {string} peToken    - PA JWT (test-pe is PA in both fixtures)
 */
async function uploadFixture(configPath, peToken) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const res = await axios.post(
    `${GATEWAY}/config/upload`,
    config,
    {
      headers: { Authorization: `Bearer ${peToken}`, 'Content-Type': 'application/json' },
      validateStatus: () => true,
    },
  )
  if (res.status === 201 || res.status === 200) return res
  throw new Error(
    `T0 setup FAIL — config upload for '${config.group_id}': HTTP ${res.status} — ${JSON.stringify(res.data)}`,
  )
}

/**
 * Playwright globalSetup entry point.
 * @param {import('@playwright/test').FullConfig} _config
 */
export default async function setup(_config) {
  // ── T0.1: gateway health ────────────────────────────────────────────────────
  console.log('[setup] T0.1 waiting for gateway...')
  await waitForGateway()
  console.log('[setup] T0.1 gateway healthy ✓')

  // ── Fixture upload (idempotent) ─────────────────────────────────────────────
  // All fixture configs must be in DDB before any test runs. 409 is accepted
  // (already onboarded from a previous run — configs are unchanged).
  //
  // Each fixture is uploaded with the token of its owner (who must be a PA in
  // that project's member list). quorum-test-peer-project uses the architect
  // token because test-architect is the owner/PA there; test-pe is only an
  // engineer in that fixture — the cross-project role inversion is intentional.
  const peToken        = makeToken('test-pe')
  const architectToken = makeToken('test-architect')
  const fixDir         = resolve(__dir, '../fixtures')

  /** @type {Array<[string, string]>} [filename, uploaderToken] */
  const fixtures = [
    ['quorum-test-catalog.quorum.json',          peToken],
    ['quorum-test-project.quorum.json',          peToken],
    ['quorum-test-isolated-project.quorum.json', peToken],
    ['quorum-test-peer-project.quorum.json',     architectToken],
    ['quorum-test-division-catalog.quorum.json', peToken],
    ['quorum-test-division-project.quorum.json', peToken],
  ]

  for (const [file, token] of fixtures) {
    const res = await uploadFixture(resolve(fixDir, file), token)
    const label = res.status === 201 ? 'uploaded ✓' : 'updated ✓'
    console.log(`[setup] fixture ${file} — ${label}`)
  }

  // ── T0.2: JWT round-trip ────────────────────────────────────────────────────
  const rtRes = await axios.get(
    `${GATEWAY}/api/knowledge`,
    {
      headers: {
        Authorization:      `Bearer ${peToken}`,
        'X-Quorum-Project': 'quorum-test-project',
      },
      validateStatus: () => true,
    },
  )
  if (rtRes.status !== 200) {
    throw new Error(`T0.2 FAIL — JWT round-trip: HTTP ${rtRes.status} — ${JSON.stringify(rtRes.data)}`)
  }
  console.log('[setup] T0.2 JWT round-trip ✓')

  // ── T0.3: config probe ──────────────────────────────────────────────────────
  const [globalsRes, profileRes] = await Promise.all([
    axios.get(
      `${GATEWAY}/api/globals`,
      {
        headers: {
          Authorization:      `Bearer ${peToken}`,
          'X-Quorum-Project': 'quorum-test-project',
        },
        validateStatus: () => true,
      },
    ),
    axios.get(`${GATEWAY}/user/profile/test-pe`, {
      headers: { Authorization: `Bearer ${peToken}` },
      validateStatus: () => true,
    }),
  ])

  if (globalsRes.status !== 200) {
    throw new Error(`T0.3 FAIL — GET /api/globals: HTTP ${globalsRes.status}`)
  }
  if (profileRes.status !== 200) {
    throw new Error(`T0.3 FAIL — GET /user/profile/test-pe: HTTP ${profileRes.status}`)
  }
  console.log('[setup] T0.3 config probe ✓')
  console.log('[setup] All T0 probes passed — suite starting.')
}
