/**
 * E2E JWT generator — produces ES256 JWTs for all test users.
 *
 * Uses the committed P-256 test key pair in tests/e2e/fixtures/.
 * The gateway's verify-jwt middleware accepts these tokens when configured
 * with QUORUM_JWT_PUBLIC_KEY from docker-compose.test.yml.
 *
 * Role assignment is determined by the gateway from the project config
 * (X-Quorum-Project header → DDB/Redis lookup → member role). The JWT
 * itself only carries the `sub` (GitHub username).
 *
 * Usage:
 *   import { tokens } from '../helpers/jwt.js'
 *   const client = api(tokens.pe)   // test-pe is principal_architect in both fixtures
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
 * @param {string} sub    - GitHub username of the test user (e.g. 'test-pe')
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

/**
 * Pre-built tokens for all test users.
 *
 * Role mapping (from quorum-test-catalog.quorum.json and quorum-test-project.quorum.json):
 *   pe         → test-pe         → principal_architect  (writes land as ACTIVE, can approve)
 *   architect  → test-architect  → architect            (global writes land as DRAFT)
 *   engineer   → test-engineer   → engineer             (writes land as DRAFT)
 *   senior     → test-senior     → senior_engineer
 *   compliance → test-compliance → compliance_officer
 *   director   → test-director   → director             (portfolio read-only)
 *   vp         → test-vp         → vp_engineering       (portfolio read-only)
 *   product    → test-product    → product_owner
 *   admin      → test-admin      → is_admin: true       (admin routes only)
 *
 * Note: there is no test-pa user in the fixtures. Use tokens.pe for
 * principal_architect operations — test-pe IS the PA in all fixture configs.
 */
export const tokens = {
  pe:         token('test-pe'),
  architect:  token('test-architect'),
  engineer:   token('test-engineer'),
  senior:     token('test-senior'),
  compliance: token('test-compliance'),
  director:   token('test-director'),
  vp:         token('test-vp'),
  product:    token('test-product'),
  // is_admin:true payload needed — verify-jwt.js reads payload.is_admin ?? false.
  // Without it, admin routes (is_admin guard) return 403.
  admin:      token('test-admin', { is_admin: true }),
}
