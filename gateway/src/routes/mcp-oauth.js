/**
 * Quorum Gateway — MCP OAuth 2.1 Authorization Server (BL-12).
 *
 * Implements the MCP spec 2025-03-26 Third-Party Authorization flow so that
 * quorum-mcp can authenticate with zero env vars. The gateway acts as both:
 *   - OAuth server  → MCP client (issues Gateway-MCP ES256 JWT)
 *   - OAuth client  → GitHub (verifies engineer identity)
 *
 * Routes (mounted at /oauth in server.js):
 *   POST /oauth/register    — RFC7591 dynamic client registration
 *   GET  /oauth/authorize   — start PKCE flow, redirect to GitHub
 *   GET  /oauth/callback    — GitHub callback; enrich claims; redirect to MCP
 *   POST /oauth/token       — exchange auth code + PKCE verifier → JWT
 *
 * Metadata discovery (mounted separately in server.js):
 *   GET  /.well-known/oauth-authorization-server — RFC8414 metadata
 *
 * Security properties:
 *   - PKCE S256 required — rejects plain method
 *   - state validated on callback (CSRF prevention)
 *   - GitHub token never stored or returned (used only to fetch github_login)
 *   - Auth codes are single-use and expire in 60 seconds
 *   - Existing POST /auth/token (PAT exchange) is untouched
 */

import { Router }     from 'express'
import { createHash, randomBytes } from 'node:crypto'
import { SignJWT }    from 'jose'
import { getKeys }    from '../keys.js'
import { loadProjectConfig } from '../config-cache.js'

const router = Router()

// ── In-memory stores (single-instance gateway, no Redis for v0.x) ─────────────

/** @type {Map<string, { redirect_uris: string[], created_at: number }>} */
const clientStore = new Map()

/** @type {Map<string, { code_challenge: string, client_id: string, redirect_uri: string, project_id: string|null, created_at: number }>} */
const pkceStore   = new Map()

/** @type {Map<string, { client_id: string, github_login: string, project_id: string|null, slug: string|null, role: string|null, team: string|null, base_confidence: number, code_challenge: string, redirect_uri: string, expires_at: number }>} */
const codeStore   = new Map()

const CODE_TTL_MS = 60_000        // auth codes expire in 60 s
const PKCE_TTL_MS = 5 * 60_000   // PKCE state expires in 5 min
const TOKEN_TTL_SECONDS = 3600

function pruneStores() {
  const now = Date.now()
  for (const [k, v] of pkceStore) if (now - v.created_at > PKCE_TTL_MS) pkceStore.delete(k)
  for (const [k, v] of codeStore) if (now > v.expires_at) codeStore.delete(k)
}

// ── Metadata handler (exported for server.js to mount at /.well-known) ────────

/**
 * RFC8414 Authorization Server Metadata.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function metadataHandler(req, res) {
  const base = process.env.QUORUM_GATEWAY_URL ?? `${req.protocol}://${req.get('host')}`
  res.json({
    issuer:                                `${base}`,
    authorization_endpoint:                `${base}/oauth/authorize`,
    token_endpoint:                        `${base}/oauth/token`,
    registration_endpoint:                 `${base}/oauth/register`,
    response_types_supported:              ['code'],
    grant_types_supported:                 ['authorization_code'],
    code_challenge_methods_supported:      ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  })
}

// ── POST /oauth/register — RFC7591 dynamic client registration ────────────────

router.post('/register', (req, res) => {
  const { redirect_uris } = req.body ?? {}
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return res.status(400).json({
      error:             'invalid_client_metadata',
      error_description: 'redirect_uris array required',
    })
  }

  const clientId = randomBytes(16).toString('base64url')
  clientStore.set(clientId, { redirect_uris, created_at: Date.now() })

  res.status(201).json({
    client_id:                  clientId,
    redirect_uris,
    grant_types:                ['authorization_code'],
    response_types:             ['code'],
    token_endpoint_auth_method: 'none',
  })
})

// ── GET /oauth/authorize — start PKCE flow ────────────────────────────────────

router.get('/authorize', (req, res) => {
  pruneStores()

  const {
    client_id, redirect_uri, state,
    code_challenge, code_challenge_method,
    response_type, project_id,
  } = req.query

  if (response_type !== 'code') {
    return res.status(400).json({ error: 'unsupported_response_type' })
  }
  if (!client_id || !redirect_uri || !state || !code_challenge) {
    return res.status(400).json({
      error:             'invalid_request',
      error_description: 'client_id, redirect_uri, state, code_challenge required',
    })
  }
  if (code_challenge_method !== 'S256') {
    return res.status(400).json({
      error:             'invalid_request',
      error_description: 'code_challenge_method must be S256',
    })
  }

  // Validate redirect_uri against registered client (if client was registered)
  const client = clientStore.get(client_id)
  if (client && !client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).json({
      error:             'invalid_request',
      error_description: 'redirect_uri not registered for this client',
    })
  }

  pkceStore.set(state, {
    code_challenge,
    client_id,
    redirect_uri,
    project_id: project_id ?? null,
    created_at: Date.now(),
  })

  const githubClientId = process.env.GITHUB_CLIENT_ID
  if (!githubClientId) {
    return res.status(503).json({
      error:             'server_error',
      error_description: 'GITHUB_CLIENT_ID not configured',
    })
  }

  const base        = process.env.QUORUM_GATEWAY_URL ?? `${req.protocol}://${req.get('host')}`
  const callbackUrl = `${base}/oauth/callback`

  const githubParams = new URLSearchParams({
    client_id:    githubClientId,
    redirect_uri: callbackUrl,
    scope:        'read:user',
    state,
  })

  res.redirect(`https://github.com/login/oauth/authorize?${githubParams}`)
})

// ── GET /oauth/callback — GitHub → gateway → MCP client ──────────────────────

router.get('/callback', async (req, res) => {
  const { code: githubCode, state, error: oauthError } = req.query

  if (oauthError) {
    const stored = pkceStore.get(state)
    if (stored) {
      pkceStore.delete(state)
      const errUrl = new URL(stored.redirect_uri)
      errUrl.searchParams.set('error', 'access_denied')
      errUrl.searchParams.set('state', state)
      return res.redirect(errUrl.toString())
    }
    return res.status(400).json({ error: 'access_denied' })
  }

  if (!state || !pkceStore.has(state)) {
    return res.status(400).json({
      error:             'invalid_state',
      error_description: 'Unknown or expired OAuth state',
    })
  }

  const { code_challenge, client_id, redirect_uri, project_id } = pkceStore.get(state)
  pkceStore.delete(state)

  const githubClientId     = process.env.GITHUB_CLIENT_ID
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET
  const base               = process.env.QUORUM_GATEWAY_URL ?? `${req.protocol}://${req.get('host')}`
  const callbackUrl        = `${base}/oauth/callback`

  // Exchange GitHub code → GitHub token (used ONLY to fetch github_login; never stored)
  let githubLogin
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept:         'application/json',
        'User-Agent':   'quorum-gateway/0.2.0',
      },
      body: JSON.stringify({
        client_id:     githubClientId,
        client_secret: githubClientSecret,
        code:          githubCode,
        redirect_uri:  callbackUrl,
      }),
    })
    const tokenData = await tokenRes.json()
    if (tokenData.error) throw new Error(tokenData.error_description ?? tokenData.error)

    const githubToken = tokenData.access_token

    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${githubToken}`, 'User-Agent': 'quorum-gateway/0.2.0' },
    })
    if (!userRes.ok) throw new Error(`GitHub API returned ${userRes.status}`)
    const userData = await userRes.json()
    githubLogin = userData.login
    // githubToken is intentionally not stored — identity confirmed, token dropped
  } catch (err) {
    console.error('[Gateway:mcp-oauth] GitHub identity exchange failed:', err.message)
    return res.status(502).json({
      error:             'github_exchange_failed',
      error_description: err.message,
    })
  }

  // Enrich with project config claims while we're still in the callback
  let role = null, team = null, baseConfidence = 0.5, slug = project_id
  if (project_id) {
    try {
      const config = await loadProjectConfig(project_id)
      const member = config.members?.find(
        (m) => m.github_username?.toLowerCase() === githubLogin.toLowerCase(),
      ) ?? null
      role           = member?.role ?? null
      team           = member?.team ?? null
      baseConfidence = role && config.roles?.[role] ? config.roles[role].base_confidence : 0.5
      slug           = config.group_id ?? project_id
    } catch {
      // project not found — issue token with minimal claims; token exchange will still succeed
    }
  }

  // Issue single-use auth code (60 s TTL)
  const authCode = randomBytes(32).toString('base64url')
  codeStore.set(authCode, {
    client_id,
    github_login:   githubLogin,
    project_id,
    slug,
    role,
    team,
    base_confidence: baseConfidence,
    code_challenge,
    redirect_uri,
    expires_at: Date.now() + CODE_TTL_MS,
  })

  const mcpRedirect = new URL(redirect_uri)
  mcpRedirect.searchParams.set('code',  authCode)
  mcpRedirect.searchParams.set('state', state)
  res.redirect(mcpRedirect.toString())
})

// ── POST /oauth/token — exchange auth code + PKCE verifier → JWT ──────────────

router.post('/token', async (req, res) => {
  const body = req.body ?? {}

  const grantType    = body.grant_type
  const code         = body.code
  const clientId     = body.client_id
  const redirectUri  = body.redirect_uri
  const codeVerifier = body.code_verifier

  if (grantType !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' })
  }
  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return res.status(400).json({
      error:             'invalid_request',
      error_description: 'code, client_id, redirect_uri, code_verifier required',
    })
  }

  const stored = codeStore.get(code)
  if (!stored || Date.now() > stored.expires_at) {
    codeStore.delete(code)
    return res.status(400).json({
      error:             'invalid_grant',
      error_description: 'Authorization code expired or invalid',
    })
  }

  if (stored.client_id !== clientId || stored.redirect_uri !== redirectUri) {
    return res.status(400).json({
      error:             'invalid_grant',
      error_description: 'client_id or redirect_uri mismatch',
    })
  }

  // Verify PKCE S256: base64url(SHA256(code_verifier)) === stored code_challenge
  const computed = createHash('sha256').update(codeVerifier).digest('base64url')
  if (computed !== stored.code_challenge) {
    return res.status(400).json({
      error:             'invalid_grant',
      error_description: 'PKCE code_verifier verification failed',
    })
  }

  // Single-use: delete immediately after verification
  codeStore.delete(code)

  const { github_login, slug, role, team, base_confidence, project_id } = stored

  const { privateKey, kid } = getKeys()
  const accessToken = await new SignJWT({
    sub:             github_login,
    project:         slug ?? project_id ?? null,
    role,
    team,
    method:          'oauth2_pkce',
    base_confidence,
    mcp_client_id:   clientId,
  })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .setIssuer('quorum-gateway')
    .sign(privateKey)

  res.json({
    access_token: accessToken,
    token_type:   'bearer',
    expires_in:   TOKEN_TTL_SECONDS,
  })
})

export default router
