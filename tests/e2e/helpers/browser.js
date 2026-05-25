/**
 * Browser test helpers — Quorum dashboard session injection and navigation.
 *
 * The dashboard uses GitHub OAuth which cannot be automated in headless tests.
 * This module bypasses OAuth by writing the three sessionStorage keys that
 * AuthContext.jsx reads during its useState() initializers:
 *
 *   quorum_session         { token: string, user: object }
 *   quorum_active_project  group_id string
 *   quorum_projects        array of project membership objects
 *
 * Use page.addInitScript() to inject before React boots — it fires before any
 * JavaScript executes on the page, so AuthContext sees a valid session on its
 * very first render cycle.
 *
 * @module browser
 */

import jwt from 'jsonwebtoken'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir    = dirname(fileURLToPath(import.meta.url))
const PRIV_KEY = readFileSync(resolve(__dir, '../fixtures/test-private-key.pem'))
const KEY_ID   = 'test-key-1'

/**
 * Dashboard base URL.
 * In Docker E2E mode: set via QUORUM_DASHBOARD_URL=http://dashboard env var.
 * In local dev mode: defaults to http://localhost:3002.
 */
export const DASHBOARD_URL = process.env.QUORUM_DASHBOARD_URL ?? 'http://localhost:3002'

/**
 * Inject a Quorum session into a Playwright page's sessionStorage before React
 * initializes, bypassing GitHub OAuth entirely.
 *
 * Must be called BEFORE page.goto(). The init script is registered once and
 * fires on every subsequent navigation within the same page object.
 *
 * AuthContext.readStoredSession() validates:
 *   - token must be present
 *   - user must be present
 *   - (user.exp ?? 0) * 1000 > Date.now() — token must not be expired
 *
 * isGuest check in App.jsx:
 *   - availableProjects must include an entry with group_id === selectedProject
 *   - that entry must have role !== null
 *   (otherwise MemberRoute redirects to /)
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} [opts]
 * @param {string} [opts.sub='test-pe']         GitHub username
 * @param {string} [opts.project='quorum-test-project'] Active project group_id
 * @param {string} [opts.role='principal_architect']    Member role in project
 * @param {number} [opts.base_confidence=0.9]           PA confidence floor
 * @param {boolean} [opts.is_admin=false]               Platform admin flag
 */
export async function injectSession(page, {
  sub             = 'test-pe',
  project         = 'quorum-test-project',
  role            = 'principal_architect',
  base_confidence = 0.9,
  is_admin        = false,
} = {}) {
  // Mint a fresh 1-hour JWT so AuthContext expiry check passes even if the test
  // runner took a long time to reach this point. The private key is the committed
  // test key that the gateway (docker-compose.e2e.yml QUORUM_JWT_PUBLIC_KEY) trusts.
  const jwtString = jwt.sign(
    { sub, ...(is_admin ? { is_admin: true } : {}) },
    PRIV_KEY,
    { algorithm: 'ES256', expiresIn: '1h', keyid: KEY_ID, issuer: 'quorum-gateway' },
  )

  // Decode the payload to extract exp/iat for the user object in sessionStorage.
  // The dashboard's AuthContext stores the enriched user object alongside the raw JWT.
  const [, payloadB64] = jwtString.split('.')
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))

  const user = {
    sub,
    project,
    role,
    base_confidence,
    is_admin,
    exp: payload.exp,
    iat: payload.iat,
  }

  // The projects list is what AuthContext uses to resolve `currentProjectData`.
  // Without an entry here whose group_id matches selectedProject, the app
  // treats the session as a guest (isGuest = true) and MemberRoute redirects to /.
  const projects = [{
    group_id:        project,
    role,
    base_confidence,
    is_owner:        role === 'principal_architect',
  }]

  // page.addInitScript() runs before every navigation in this page object — the
  // browser context executes this script before any page JavaScript. We pass the
  // values as a serialised argument (the init script function runs in the browser
  // VM, not Node.js, so closures over Node variables are not available).
  await page.addInitScript(
    ({ sk, sv, pk, pv, lk, lv }) => {
      sessionStorage.setItem(sk, sv)
      sessionStorage.setItem(pk, pv)
      sessionStorage.setItem(lk, lv)
    },
    {
      sk: 'quorum_session',
      sv: JSON.stringify({ token: jwtString, user }),
      pk: 'quorum_active_project',
      pv: project,
      lk: 'quorum_projects',
      lv: JSON.stringify(projects),
    },
  )
}
