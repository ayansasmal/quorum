/**
 * Quorum Gateway — Authentication routes.
 *
 * POST /auth/token
 *   Exchange a GitHub personal access token for a short-lived ES256 JWT.
 *   v0.3: JWT contains only { sub, is_admin } — all project/role context
 *   is resolved per-request from the profile cache (see verify-jwt.js).
 *
 * POST /auth/refresh
 *   Extend a still-valid JWT without re-authenticating with GitHub.
 *
 * POST /auth/projects  (pre-JWT discovery — dashboard project selector)
 *   Return projects accessible to the caller using only a GitHub token.
 *
 * GET  /auth/projects  → 410 Gone (replaced by GET /user/profile/{sub})
 * POST /auth/switch    → 410 Gone (replaced by X-Quorum-Project header)
 */

import { Router } from 'express'
import { SignJWT } from 'jose'
import { randomUUID } from 'node:crypto'
import { getKeys } from '../keys.js'
import { loadProjectConfig, isPlatformAdmin } from '../config-cache.js'
import { verifyJwt } from '../middleware/verify-jwt.js'
import { getUserProjects } from '../ddb.js'

const router = Router()

const TOKEN_TTL_SECONDS = 3600 // 1 hour

/**
 * Verify a GitHub token by calling the GitHub user API.
 * @param {string} githubToken
 * @returns {Promise<string>} GitHub login
 */
async function verifyGitHubToken(githubToken) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      'User-Agent': 'quorum-gateway/0.3.0',
    },
  })

  if (!response.ok) {
    if (response.status === 401) throw new Error('Invalid or expired GitHub token')
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()
  if (!data.login) throw new Error('GitHub API returned no login')
  return data.login
}

/**
 * Find a member in the project config by their GitHub username.
 * @param {object} config
 * @param {string} githubUsername
 * @returns {object | null}
 */
function findMember(config, githubUsername) {
  return config.members.find(
    (m) => m.github_username?.toLowerCase() === githubUsername.toLowerCase(),
  ) ?? null
}

/**
 * Issue a slim ES256 JWT containing only { sub, is_admin }.
 * @param {string} sub
 * @param {boolean} isAdmin
 * @returns {Promise<string>} signed JWT
 */
async function issueToken(sub, isAdmin) {
  const { privateKey, kid } = getKeys()
  return new SignJWT({ sub, is_admin: isAdmin })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .setIssuer('quorum-gateway')
    .setJti(randomUUID())
    .sign(privateKey)
}

// POST /auth/token
router.post('/token', async (req, res) => {
  const { github_token, project_id } = req.body ?? {}

  if (!github_token) return res.status(400).json({ error: 'missing_param', message: 'github_token required' })
  if (!project_id)   return res.status(400).json({ error: 'missing_param', message: 'project_id required' })

  let githubLogin
  try {
    githubLogin = await verifyGitHubToken(github_token)
  } catch (err) {
    return res.status(401).json({ error: 'github_auth_failed', message: err.message })
  }

  let config
  try {
    config = await loadProjectConfig(project_id)
  } catch (err) {
    return res.status(404).json({
      error:   'project_not_found',
      message: `Project '${project_id}' not found or config load failed: ${err.message}`,
    })
  }

  const member = findMember(config, githubLogin)
  if (member === null && config.guest_access !== true) {
    return res.status(403).json({
      error:   'not_a_member',
      message: `You are not a member of project '${project_id}'`,
    })
  }

  const isAdmin = await isPlatformAdmin(githubLogin)
  const token   = await issueToken(githubLogin, isAdmin)

  // Response still includes role/team/project for backward-compatible clients.
  // These are derived from the project config — not embedded in the token itself.
  const role           = member?.role ?? null
  const team           = member?.team ?? null
  const baseConfidence = role && config.roles?.[role] ? config.roles[role].base_confidence : 0.5
  const slug           = config.group_id ?? project_id

  res.json({
    token,
    expires_in:      TOKEN_TTL_SECONDS,
    sub:             githubLogin,
    project:         slug,
    role,
    team,
    base_confidence: baseConfidence,
    is_admin:        isAdmin,
    member_found:    member !== null,
  })
})

// POST /auth/refresh
router.post('/refresh', verifyJwt, async (req, res) => {
  const { sub } = req.user
  const isAdmin = await isPlatformAdmin(sub)
  const token   = await issueToken(sub, isAdmin)
  res.json({ token, expires_in: TOKEN_TTL_SECONDS, sub, is_admin: isAdmin })
})

// POST /auth/projects — pre-JWT project discovery for dashboard project selector.
// Uses only a GitHub token — this is the step BEFORE JWT issuance.
router.post('/projects', async (req, res) => {
  const { github_token } = req.body ?? {}
  if (!github_token) return res.status(400).json({ error: 'missing_param', message: 'github_token required' })

  let githubLogin
  try {
    githubLogin = await verifyGitHubToken(github_token)
  } catch (err) {
    return res.status(401).json({ error: 'github_auth_failed', message: err.message })
  }

  try {
    const rows = await getUserProjects(githubLogin)
    const projects = rows.map((r) => ({
      id:       r.project_id,
      slug:     r.project_slug ?? r.project_id,
      name:     r.project_name ?? r.project_id,
      role:     r.role         ?? null,
      team:     r.team         ?? null,
      is_guest: false,
    }))
    res.json({ projects, github_login: githubLogin, source: 'ddb' })
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: err.message })
  }
})

// GET /auth/projects — retired in v0.3; use GET /user/profile/{sub}
router.get('/projects', (_req, res) => {
  res.status(410).json({
    error:   'endpoint_retired',
    message: 'GET /auth/projects was retired in v0.3. Use GET /user/profile/{sub} instead.',
  })
})

// POST /auth/switch — retired in v0.3; use X-Quorum-Project header
router.post('/switch', (_req, res) => {
  res.status(410).json({
    error:   'endpoint_retired',
    message: 'POST /auth/switch was retired in v0.3. Set X-Quorum-Project header instead.',
  })
})

export default router
