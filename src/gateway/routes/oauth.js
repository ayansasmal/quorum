/**
 * Quorum Gateway — GitHub OAuth routes.
 *
 * GET  /auth/github    — Redirect browser to GitHub OAuth authorization page.
 * GET  /auth/callback  — Exchange code for access token; redirect dashboard
 *                        to the login page with the OAuth token in the URL
 *                        fragment so the dashboard can complete the flow via
 *                        the existing POST /auth/token endpoint.
 *
 * The access token is placed in the URL fragment (#oauth=<token>) rather
 * than a query parameter — fragments are never sent to servers or logged
 * in access logs.
 *
 * Required env vars:
 *   GITHUB_CLIENT_ID        — OAuth App client ID
 *   GITHUB_CLIENT_SECRET    — OAuth App client secret
 *   GITHUB_CALLBACK_URL     — Must match the callback URL registered on
 *                             the OAuth App (default: http://localhost:3002/auth/callback)
 *   DASHBOARD_URL           — Where to redirect after the OAuth dance
 *                             (default: http://localhost:3002)
 */

import { Router } from 'express'
import { randomBytes } from 'node:crypto'

const router = Router()

// ── In-memory CSRF state store ─────────────────────────────────────────────────
// Short-lived: each entry expires after 10 minutes.
// This is intentionally simple — for production, use Redis or a signed state JWT.

/** @type {Map<string, number>} state → created_at (ms) */
const pendingStates = new Map()
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
 * @returns {{ clientId: string, clientSecret: string, callbackUrl: string, dashboardUrl: string }}
 * @throws if GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET are not set
 */
function getOAuthConfig() {
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
    callbackUrl:  process.env.GITHUB_CALLBACK_URL ?? 'http://localhost:3002/auth/callback',
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

// ── GET /auth/callback ─────────────────────────────────────────────────────────

/**
 * GitHub OAuth callback.
 * Exchanges the code for an OAuth access token and redirects the browser
 * back to the dashboard login page with the token in the URL fragment.
 *
 * The dashboard reads the fragment, shows the project selector, and calls
 * POST /auth/token { github_token: <oauth_token>, project_id: <id> } to
 * complete authentication and receive a Quorum JWT.
 */
router.get('/callback', async (req, res) => {
  let cfg
  try {
    cfg = getOAuthConfig()
  } catch (err) {
    return res.status(err.status ?? 503).json({ error: err.code, message: err.message })
  }

  const { code, state, error: oauthError } = req.query

  // ── User denied access on GitHub ──────────────────────────────────────────
  if (oauthError) {
    const loginUrl = new URL(`${cfg.dashboardUrl}/login`)
    loginUrl.searchParams.set('error', oauthError === 'access_denied'
      ? 'GitHub login was cancelled.'
      : `GitHub OAuth error: ${oauthError}`)
    return res.redirect(loginUrl.toString())
  }

  // ── Validate state (CSRF protection) ──────────────────────────────────────
  if (!state || !pendingStates.has(state)) {
    const loginUrl = new URL(`${cfg.dashboardUrl}/login`)
    loginUrl.searchParams.set('error', 'Invalid or expired login session. Please try again.')
    return res.redirect(loginUrl.toString())
  }
  pendingStates.delete(state)

  // Decode the state payload to recover optional project_id
  let projectId = ''
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'))
    projectId = decoded.projectId ?? ''
  } catch {
    // state decode failed — continue without project_id
  }

  // ── Exchange code for OAuth access token ──────────────────────────────────
  let oauthToken
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept:         'application/json',
        'User-Agent':   'quorum-gateway/0.2.0',
      },
      body: JSON.stringify({
        client_id:     cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri:  cfg.callbackUrl,
      }),
    })

    const tokenData = await tokenRes.json()

    if (tokenData.error) {
      throw new Error(tokenData.error_description ?? tokenData.error)
    }
    if (!tokenData.access_token) {
      throw new Error('No access_token in GitHub response')
    }

    oauthToken = tokenData.access_token
  } catch (err) {
    console.error('[Gateway:oauth] Token exchange failed:', err.message)
    const loginUrl = new URL(`${cfg.dashboardUrl}/login`)
    loginUrl.searchParams.set('error', `GitHub authentication failed: ${err.message}`)
    return res.redirect(loginUrl.toString())
  }

  // ── Redirect to dashboard with OAuth token in URL fragment ────────────────
  // Fragment (#) is never sent to the server — safer than a query param.
  // The dashboard reads it, clears it from the URL, and calls POST /auth/token.
  const fragment = new URLSearchParams({ oauth: oauthToken })
  if (projectId) fragment.set('project_id', projectId)

  res.redirect(`${cfg.dashboardUrl}/login#${fragment.toString()}`)
})

export default router
