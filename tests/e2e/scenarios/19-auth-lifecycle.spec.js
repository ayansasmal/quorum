/**
 * S-19 — Authentication Lifecycle & Boundary Enforcement (J19)
 *
 * Journey: J19 — Authentication Lifecycle & Boundary Enforcement
 * Pillars: JWT Validation        (S-19.1 — all invalid-token paths)
 *          JWKS Structure        (S-19.2 — public key endpoint contract)
 *          Project Scope         (S-19.3 — X-Quorum-Project resolution)
 *          Token Refresh         (S-19.4 — POST /auth/refresh sliding window)
 *          PAT Authentication    (S-19.5 — pre-minted JWT vs bogus string)
 *
 * Architecture notes:
 *   verify-jwt.js (two-step middleware):
 *     1. jwtVerify(token, publicKey, { issuer: 'quorum-gateway', algorithms: ['ES256'] })
 *     2. loadUserProfile(sub) → project membership + role resolution
 *   Expiry → ERR_JWT_EXPIRED → 401 { error: 'token_expired' }
 *   All other verify failures → 401 { error: 'invalid_token' }
 *   HS256 rejected because algorithms list is ['ES256'] only — algorithm confusion is impossible.
 *
 *   POST /auth/refresh uses verifyJwt (the access JWT IS the refresh token — sliding window).
 *   X-Quorum-Project missing on pg/* routes → 400 { error: 'X-Quorum-Project header required' }
 *
 *   Note: pg/* routes with a project the user is not a member of resolve role=null.
 *   Role-gated routes (e.g. GET /api/portfolio) return 403 when role=null.
 *
 *   Manual tests: MT-11 (GitHub OAuth browser flow), MT-12 (PKCE OAuth 2.1 end-to-end).
 */

import { test, expect } from '@playwright/test'
import axios from 'axios'

const { describe } = test
import {
  tokens,
  token,
  expiredToken,
  buildTamperedToken,
  generateHs256Token,
} from '../helpers/jwt.js'
import { api } from '../helpers/api.js'

const PROJECT = 'quorum-test-project'
const BASE    = process.env.QUORUM_GATEWAY_URL || 'http://localhost:3001'

/**
 * Bare axios instance — no default headers. Used for tests that deliberately
 * omit the Authorization or X-Quorum-Project header.
 *
 * @param {object} [headers]
 * @returns {import('axios').AxiosInstance}
 */
function bare(headers = {}) {
  return axios.create({
    baseURL: BASE,
    headers,
    validateStatus: () => true,
  })
}

// All sub-scenarios test the same auth layer but with different tokens/headers.
// Serial prevents false positives from rate-limit overlap on the probe routes.
test.describe.configure({ mode: 'serial' })

// ─────────────────────────────────────────────────────────────────────────────
// S-19.1 — JWT Validation Boundaries
// ─────────────────────────────────────────────────────────────────────────────

describe('S-19 — Authentication Lifecycle', () => {

describe('S-19.1 — JWT Validation Boundaries', () => {
  // GET /pg/versions/:topic/:key — project-scoped probe: auth passes → 200 or 404 (key not found).
  // 401 means auth failed. 400 means missing project header (not relevant for these tests since
  // we send X-Quorum-Project in every call here).
  const PROBE = '/pg/versions/auth/any-key-s19'

  test('step 1 — valid JWT → 200 or 404 (not 401)', async () => {
    const res = await api(tokens.pe, PROJECT).get(PROBE)
    expect(res.status).not.toBe(401)
    // 200 (key found) or 404 (key not found) — both mean auth passed
    expect([200, 404]).toContain(res.status)
  })

  test('step 2 — missing Authorization header → 401 missing_token', async () => {
    const res = await bare({ 'X-Quorum-Project': PROJECT }).get(PROBE)
    expect(res.status).toBe(401)
    expect(res.data.error).toBe('missing_token')
  })

  test('step 3 — expired JWT → 401 token_expired', async () => {
    const expired = expiredToken('test-pe')
    const res = await bare({
      Authorization:      `Bearer ${expired}`,
      'X-Quorum-Project': PROJECT,
    }).get(PROBE)
    expect(res.status).toBe(401)
    expect(res.data.error).toBe('token_expired')
  })

  test('step 4 — tampered JWT (modified payload, original signature) → 401 invalid_token', async () => {
    const tampered = buildTamperedToken(tokens.pe)
    const res = await bare({
      Authorization:      `Bearer ${tampered}`,
      'X-Quorum-Project': PROJECT,
    }).get(PROBE)
    expect(res.status).toBe(401)
    expect(res.data.error).toBe('invalid_token')
  })

  test('step 5 — HS256-signed JWT → 401 (algorithm enforcement: only ES256 accepted)', async () => {
    const hs256 = generateHs256Token({ sub: 'test-pe', iss: 'quorum-gateway' })
    const res = await bare({
      Authorization:      `Bearer ${hs256}`,
      'X-Quorum-Project': PROJECT,
    }).get(PROBE)
    expect(res.status).toBe(401)
    // Confirm the error field is present — do not assert exact message to avoid
    // leaking which algorithm was expected.
    expect(res.data.error).toBeTruthy()
  })

  test('step 6 — valid JWT but non-member of private project → 403 (access denied)', async () => {
    const unknownSub = token('no-such-user-s19')
    const res = await bare({
      Authorization:      `Bearer ${unknownSub}`,
      'X-Quorum-Project': PROJECT,
    }).get(PROBE)
    // loadUserProfile returns { projects: [] } on DDB miss — auth does NOT fail on unknown sub.
    // But verify-jwt.js checks is_public on non-member access.
    // quorum-test-project does NOT have is_public: true, so access_denied = true.
    // pg.js middleware returns 403 when access_denied is set.
    expect(res.status).toBe(403)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-19.2 — JWKS Endpoint Structure
// ─────────────────────────────────────────────────────────────────────────────

describe('S-19.2 — JWKS Endpoint Structure', () => {
  // GET /.well-known/jwks.json is public — no Authorization header required.
  // MCP clients and external verifiers use it to validate tokens issued by the gateway.

  test('step 1 — GET /.well-known/jwks.json → 200 with keys array', async () => {
    const res = await bare().get('/.well-known/jwks.json')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.keys)).toBe(true)
    expect(res.data.keys.length).toBeGreaterThanOrEqual(1)
  })

  test('step 2 — key type is EC (Elliptic Curve, not RSA)', async () => {
    const res = await bare().get('/.well-known/jwks.json')
    expect(res.data.keys[0].kty).toBe('EC')
  })

  test('step 3 — key alg is ES256 or curve is P-256', async () => {
    const res = await bare().get('/.well-known/jwks.json')
    const key  = res.data.keys[0]
    const isEs256   = key.alg === 'ES256'
    const isP256crv = key.crv === 'P-256'
    expect(isEs256 || isP256crv).toBe(true)
  })

  test('step 4 — use is "sig" (signing key, not encryption)', async () => {
    const res = await bare().get('/.well-known/jwks.json')
    expect(res.data.keys[0].use).toBe('sig')
  })

  test('step 5 — kid (key ID) is present', async () => {
    const res = await bare().get('/.well-known/jwks.json')
    expect(res.data.keys[0].kid).toBeTruthy()
  })

  test('step 6 — no HS256 or RSA keys present', async () => {
    const res  = await bare().get('/.well-known/jwks.json')
    const keys = res.data.keys
    const hasHs256 = keys.some((k) => k.alg === 'HS256')
    const hasRsa   = keys.some((k) => k.kty === 'RSA')
    expect(hasHs256).toBe(false)
    expect(hasRsa).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-19.3 — Project-Scoped Role Resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('S-19.3 — Project-Scoped Role Resolution', () => {
  test('step 1 — member project → 200 (role resolved, access granted)', async () => {
    // test-pe is a principal_architect in quorum-test-project.
    // GET /api/knowledge is a read that succeeds for any authenticated member.
    const res = await api(tokens.pe, PROJECT).get('/api/knowledge?limit=1')
    expect(res.status).toBe(200)
  })

  test('step 2 — non-member project → 403 on role-gated route (role resolves to null)', async () => {
    // test-pe is NOT a member of 'not-a-member-project-s19'.
    // verify-jwt resolves role=null for this project.
    // GET /api/portfolio is guarded by PORTFOLIO_ROLES — role=null → 403.
    const res = await api(tokens.pe, 'not-a-member-project-s19').get('/api/portfolio')
    expect(res.status).toBe(403)
  })

  test('step 3 — missing X-Quorum-Project on pg/* route → 400', async () => {
    // pg.js enforces project header at the router level (line 82-83):
    //   if (!req.user.project) return res.status(400)...
    const res = await bare({
      Authorization: `Bearer ${tokens.pe}`,
      // X-Quorum-Project deliberately omitted
    }).get('/pg/versions/auth/any-key-s19')
    expect(res.status).toBe(400)
    // Error body mentions the missing header
    const errText = JSON.stringify(res.data)
    expect(errText.toLowerCase()).toMatch(/x-quorum-project|project/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-19.4 — Token Refresh (Sliding Window)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-19.4 — Token Refresh', () => {
  // POST /auth/refresh uses verifyJwt middleware — it takes a valid access JWT
  // in the Authorization header and issues a fresh one with a new expiry.
  // The access JWT IS the refresh token (sliding window, no separate refresh_token).

  test('step 1 — valid JWT → POST /auth/refresh → 200 with new token', async () => {
    const res = await bare({
      Authorization: `Bearer ${tokens.pe}`,
      // No X-Quorum-Project required — /auth/refresh is not project-scoped
    }).post('/auth/refresh')
    expect(res.status).toBe(200)
    expect(typeof res.data.token).toBe('string')
    expect(res.data.token.length).toBeGreaterThan(0)
  })

  test('step 2 — new JWT has matching sub', async () => {
    const res = await bare({ Authorization: `Bearer ${tokens.pe}` }).post('/auth/refresh')
    expect(res.data.sub).toBe('test-pe')
  })

  test('step 3 — new JWT expires_in is in the future', async () => {
    const res = await bare({ Authorization: `Bearer ${tokens.pe}` }).post('/auth/refresh')
    // expires_in is seconds from now (e.g. 3600). Must be > 0.
    expect(typeof res.data.expires_in).toBe('number')
    expect(res.data.expires_in).toBeGreaterThan(0)
  })

  test('step 4 — expired JWT → POST /auth/refresh → 401 token_expired', async () => {
    const expired = expiredToken('test-pe')
    const res = await bare({ Authorization: `Bearer ${expired}` }).post('/auth/refresh')
    expect(res.status).toBe(401)
    expect(res.data.error).toBe('token_expired')
  })

  test('step 5 — invalid string → POST /auth/refresh → 401', async () => {
    const res = await bare({ Authorization: 'Bearer not-a-jwt-at-all' }).post('/auth/refresh')
    expect(res.status).toBe(401)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-19.5 — PAT (Personal Access Token) Authentication
// ─────────────────────────────────────────────────────────────────────────────

describe('S-19.5 — PAT Authentication', () => {
  // In the test environment, "PAT authentication" means using a pre-minted ES256 JWT
  // in the Authorization header (same as a regular token — PAT exchange via POST /auth/token
  // would require a real GitHub token and API call).
  // A bogus non-JWT string must be rejected with 401.

  test('step 1 — valid pre-minted JWT (as PAT) → 200 or 404 (auth passes)', async () => {
    // Using tokens.engineer to represent a pre-minted PAT for a CI agent.
    const res = await api(tokens.engineer, PROJECT).get('/pg/versions/auth/any-key-s19')
    expect([200, 404]).toContain(res.status)
    expect(res.status).not.toBe(401)
  })

  test('step 2 — bogus PAT string → 401 (invalid token rejected)', async () => {
    const res = await bare({
      Authorization:      'Bearer invalidpat-not-a-real-token',
      'X-Quorum-Project': PROJECT,
    }).get('/pg/versions/auth/any-key-s19')
    expect(res.status).toBe(401)
  })
})

}) // outer describe — required by graph reporter extractScenarioId()
