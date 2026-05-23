/**
 * E2E JWT generator — produces ES256 JWTs for all test users.
 *
 * Uses the committed P-256 test key pair in tests/e2e/fixtures/.
 * The gateway's verify-jwt middleware accepts these tokens when configured
 * with QUORUM_JWT_PUBLIC_KEY from docker-compose.test.yml.
 *
 * Role assignment is determined by the gateway from the project config
 * (X-Quorum-Project header → DDB/Redis lookup → member role). The JWT
 * itself only carries the `sub` (GitHub username) plus any extra fields.
 *
 * Two usage patterns are exported:
 *
 *   1. `tokens`      — static, minted at import time; fine for short runs.
 *                      Fails if a test suite exceeds 1 hour (token expiry).
 *
 *   2. Named factory functions (peToken, engineerToken, etc.) — mint a
 *                      fresh token on every call. Use these inside beforeAll /
 *                      beforeEach or whenever you need a token that is
 *                      guaranteed not to be expired at the moment of use.
 *
 * Example:
 *   import { tokens, engineerToken } from '../helpers/jwt.js'
 *
 *   // Static — safe for most specs (< 1h total run time):
 *   const client = api(tokens.pe)
 *
 *   // Fresh — safe for long beforeAll chains or retry-heavy CI:
 *   const client = api(engineerToken())
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import jwt from 'jsonwebtoken'

const __dir    = dirname(fileURLToPath(import.meta.url))
const PRIV_KEY = readFileSync(resolve(__dir, '../fixtures/test-private-key.pem'))
const KEY_ID   = 'test-key-1'

/**
 * Signs a minimal ES256 JWT for the given subject using the committed test key.
 *
 * The `issuer` claim MUST be 'quorum-gateway' — verify-jwt.js passes
 * `{ issuer: 'quorum-gateway' }` to jose's jwtVerify and it will reject any
 * token that is missing or mismatches this claim.
 *
 * @param {string} sub     - GitHub username of the test user (e.g. 'test-pe')
 * @param {object} [extra] - Additional payload fields (e.g. `{ is_admin: true }`)
 * @returns {string} Signed JWT
 */
export function token(sub, extra = {}) {
  return jwt.sign({ sub, ...extra }, PRIV_KEY, {
    algorithm: 'ES256',
    expiresIn: '1h',
    keyid:     KEY_ID,
    issuer:    'quorum-gateway',
  })
}

// ── Per-role factory functions ─────────────────────────────────────────────────
// Each function mints a fresh JWT at call time, so the token is always within
// its 1-hour TTL regardless of when the module was first imported.
//
// Role mapping (from fixture configs):
//   test-pe         → principal_architect  (writes land as ACTIVE, can approve)
//   test-architect  → architect            (global writes land as DRAFT)
//   test-engineer   → engineer             (writes land as DRAFT)
//   test-senior     → senior_engineer
//   test-compliance → compliance_officer
//   test-director   → director             (portfolio read-only)
//   test-vp         → vp_engineering       (portfolio read-only)
//   test-product    → product_owner
//   test-admin      → is_admin: true       (admin routes only — not a project member)
//
// Note: there is no test-pa user in the fixtures. test-pe IS the PA.

/** @returns {string} Fresh principal_architect JWT */
export const peToken         = () => token('test-pe')
/** @returns {string} Fresh architect JWT */
export const architectToken  = () => token('test-architect')
/** @returns {string} Fresh engineer JWT */
export const engineerToken   = () => token('test-engineer')
/** @returns {string} Fresh senior_engineer JWT */
export const seniorToken     = () => token('test-senior')
/** @returns {string} Fresh compliance_officer JWT */
export const complianceToken = () => token('test-compliance')
/** @returns {string} Fresh director JWT */
export const directorToken   = () => token('test-director')
/** @returns {string} Fresh vp_engineering JWT */
export const vpToken         = () => token('test-vp')
/** @returns {string} Fresh product_owner JWT */
export const productToken    = () => token('test-product')
/** @returns {string} Fresh admin JWT — payload includes is_admin:true */
export const adminToken      = () => token('test-admin', { is_admin: true })

// ── Static pre-built tokens ────────────────────────────────────────────────────
// Minted once at import time. Convenient for specs where the whole suite
// completes well within 1 hour. Use the factory functions above for anything
// that runs inside beforeAll chains or has retries that could push past 1h.

/**
 * Pre-built tokens for all test users.
 *
 * Note: there is no test-pa user in the fixtures. Use tokens.pe for
 * principal_architect operations — test-pe IS the PA in all fixture configs.
 */
export const tokens = {
  pe:         peToken(),
  architect:  architectToken(),
  engineer:   engineerToken(),
  senior:     seniorToken(),
  compliance: complianceToken(),
  director:   directorToken(),
  vp:         vpToken(),
  product:    productToken(),
  // is_admin:true payload — verify-jwt.js reads payload.is_admin ?? false.
  // Without it, admin routes return 403 even for test-admin.
  admin:      adminToken(),
}
