/**
 * Quorum Gateway — GitHub OAuth routes (dashboard flow).
 *
 * GET  /auth/github   — Redirect browser to GitHub OAuth authorization page.
 *                       Stores state in pendingStates (exported) so the single
 *                       gateway callback handler (GET /oauth/callback in
 *                       mcp-oauth.js) can distinguish dashboard states from
 *                       MCP PKCE states.
 *
 * The actual callback (GET /oauth/callback) lives in mcp-oauth.js — it is the
 * single registered GitHub OAuth App callback URL for all flows.  After the
 * code exchange it issues a Quorum JWT directly and redirects to the dashboard
 * login page with the token in the URL fragment (#token=<jwt>).
 *
 * Required env vars:
 *   GITHUB_CLIENT_ID        — OAuth App client ID
 *   GITHUB_CLIENT_SECRET    — OAuth App client secret
 *   GITHUB_CALLBACK_URL     — Must match the callback URL registered on
 *                             the OAuth App (default: http://localhost:3001/oauth/callback)
 *   DASHBOARD_URL           — Where to redirect after the OAuth dance
 *                             (default: http://localhost:3002)
 */

import { Router } from 'express'
import { randomBytes } from 'node:crypto'

const router = Router()

// ── In-memory CSRF state store ─────────────────────────────────────────────────
// Short-lived: each entry expires after 10 minutes.
// This is intentionally simple — for production, use Redis or a signed state JWT.

/**
 * CSRF state store shared with mcp-oauth.js so the single /oauth/callback
 * handler can tell dashboard states from MCP PKCE states.
 * @type {Map<string, number>} state → created_at (ms)
 */
export const pendingStates = new Map()
const STATE_TTL_MS  = 10 * 60 * 1000 // 10 minutes

/**
 * Remove expired states to prevent unbounded memory growth.
 */
function pruneStates() {
  const now = Date.now()
  for (const [state, createdAt] of pendingStates) {
    if (now - createdAt > STATE_TTL_MS) pendingStates.delete(state)
  }
}

// ── Config helpers ─────────────────────────────────────────────────────────────

/**
 * Returns GitHub OAuth config from environment.  Exported so mcp-oauth.js can
 * perform the server-side code exchange for the dashboard flow.
 * @returns {{ clientId: string, clientSecret: string, callbackUrl: string, dashboardUrl: string }}
 * @throws if GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET are not set
 */
export function getOAuthConfig() {
  const clientId     = process.env.GITHUB_CLIENT_ID
  const clientSecret = process.env.GITHUB_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw Object.assign(
      new Error('GitHub OAuth not configured — set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET'),
      { status: 503, code: 'OAUTH_NOT_CONFIGURED' },
    )
  }

  return {
    clientId,
    clientSecret,
    callbackUrl:  process.env.GITHUB_CALLBACK_URL ?? 'http://localhost:3001/oauth/callback',
    dashboardUrl: process.env.DASHBOARD_URL        ?? 'http://localhost:3002',
  }
}

// ── GET /auth/github ───────────────────────────────────────────────────────────

/**
 * Initiate the GitHub OAuth flow.
 * Redirects the browser to the GitHub authorization page.
 *
 * Optional query params:
 *   project_id — project to pre-select after login (passed through state)
 */
router.get('/github', (req, res) => {
  let cfg
  try {
    cfg = getOAuthConfig()
  } catch (err) {
    return res.status(err.status ?? 503).json({ error: err.code, message: err.message })
  }

  pruneStates()

  // State = random token (CSRF) + optional project_id, base64-encoded
  const nonce     = randomBytes(16).toString('hex')
  const projectId = req.query.project_id ? String(req.query.project_id) : ''
  const statePayload = Buffer.from(JSON.stringify({ nonce, projectId })).toString('base64url')

  pendingStates.set(statePayload, Date.now())

  const authUrl = new URL('https://github.com/login/oauth/authorize')
  authUrl.searchParams.set('client_id',    cfg.clientId)
  authUrl.searchParams.set('redirect_uri', cfg.callbackUrl)
  authUrl.searchParams.set('scope',        'read:user')
  authUrl.searchParams.set('state',        statePayload)

  res.redirect(authUrl.toString())
})

export default router
