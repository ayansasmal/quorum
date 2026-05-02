/**
 * Quorum Gateway — Authentication route.
 *
 * POST /auth/token
 *   Exchange a GitHub personal access token for a short-lived ES256 JWT.
 *
 *   The gateway verifies the GitHub token server-side (GET /user API call) so
 *   the username cannot be self-asserted. It then looks up the username in the
 *   project's quorum.config.json to determine role + team.
 *
 *   Engineers never need raw DB credentials — only this JWT.
 *
 * Response: { token, expires_in, sub, project, role, team }
 *
 * Token TTL: 1 hour. No refresh tokens — re-auth via GitHub token at each
 * MCP server startup (cheap: one HTTP call per session).
 */

import { Router } from 'express'
import { SignJWT } from 'jose'
import { getKeys } from '../keys.js'
import { loadProjectConfig } from '../config-cache.js'
import { verifyJwt } from '../middleware/verify-jwt.js'
import { getUserProjects } from '../ddb.js'

const router = Router()

const TOKEN_TTL_SECONDS = 3600 // 1 hour

/**
 * Verify a GitHub token by calling the GitHub user API.
 * Returns the verified GitHub login (username) — never trusts caller-supplied name.
 * @param {string} githubToken
 * @returns {Promise<string>} GitHub login (username)
 */
async function verifyGitHubToken(githubToken) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      'User-Agent': 'quorum-gateway/0.2.0',
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
 * Returns the member record or null if not found.
 * @param {object} config
 * @param {string} githubUsername
 * @returns {{ name: string, team: string | null, role: string | null, github_username?: string } | null}
 */
function findMember(config, githubUsername) {
  return config.members.find(
    (m) => m.github_username?.toLowerCase() === githubUsername.toLowerCase(),
  ) ?? null
}

// POST /auth/token
router.post('/token', async (req, res) => {
  const { github_token, project_id } = req.body ?? {}

  if (!github_token) {
    return res.status(400).json({ error: 'missing_param', message: 'github_token required' })
  }
  if (!project_id) {
    return res.status(400).json({ error: 'missing_param', message: 'project_id required' })
  }

  // 1. Verify GitHub token — username cannot be self-asserted
  let githubLogin
  try {
    githubLogin = await verifyGitHubToken(github_token)
  } catch (err) {
    return res.status(401).json({ error: 'github_auth_failed', message: err.message })
  }

  // 2. Load project config — determines role + team
  let config
  try {
    config = await loadProjectConfig(project_id)
  } catch (err) {
    return res.status(404).json({
      error: 'project_not_found',
      message: `Project '${project_id}' not found or config load failed: ${err.message}`,
    })
  }

  // 3. Look up member — anonymous if not in config (read-only access, all writes DRAFT)
  const member = findMember(config, githubLogin)
  const role   = member?.role ?? null
  const team   = member?.team ?? null

  // Base confidence from role (used by local Quorum's authority resolution)
  const baseConfidence = role && config.roles?.[role]
    ? config.roles[role].base_confidence
    : 0.5

  // 4. Sign ES256 JWT
  const { privateKey, kid } = getKeys()

  const token = await new SignJWT({
    sub:             githubLogin,
    project:         project_id,
    role,
    team,
    method:          'github_token',
    base_confidence: baseConfidence,
  })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .setIssuer('quorum-gateway')
    .sign(privateKey)

  res.json({
    token,
    expires_in:      TOKEN_TTL_SECONDS,
    sub:             githubLogin,
    project:         project_id,
    role,
    team,
    base_confidence: baseConfidence,
    member_found:    member !== null,
  })
})

// POST /auth/projects
// Discover all projects the caller belongs to using only a GitHub OAuth token.
// Intentionally sits outside JWT auth — this is the step BEFORE JWT issuance.
// Used by the dashboard project selector to populate cards after OAuth.
router.post('/projects', async (req, res) => {
  const { github_token } = req.body ?? {}

  if (!github_token) {
    return res.status(400).json({ error: 'missing_param', message: 'github_token required' })
  }

  // Verify GitHub token server-side — caller cannot self-assert their username
  let githubLogin
  try {
    githubLogin = await verifyGitHubToken(github_token)
  } catch (err) {
    return res.status(401).json({ error: 'github_auth_failed', message: err.message })
  }

  // Fast path — DDB lookup. On any failure or empty result, fall through to PostgreSQL.
  // Normalize to the same shape the PostgreSQL path returns so the frontend
  // doesn't need to know which store answered.
  try {
    const ddbProjects = await getUserProjects(githubLogin)
    if (ddbProjects && ddbProjects.length > 0) {
      const projects = ddbProjects.map((p) => ({
        id:           p.project_id,
        slug:         p.project_slug ?? p.project_id,
        name:         p.project_name ?? p.project_id,
        role:         p.role         ?? null,
        team:         p.team         ?? null,
        member_count: null,   // not stored in DDB — omit gracefully
      }))
      return res.json({ projects, github_login: githubLogin, source: 'ddb' })
    }
  } catch {
    // Fall through to PostgreSQL
  }

  const pool = req.app.locals.pool
  try {
    const result = await pool.query(
      `SELECT id, slug, name, status, config_version, created_at, members
       FROM projects
       WHERE status = 'ACTIVE'
         AND members @> $1::jsonb`,
      [JSON.stringify([{ github_username: githubLogin }])],
    )

    const projects = result.rows.map((row) => {
      const member = row.members.find(
        (m) => m.github_username?.toLowerCase() === githubLogin.toLowerCase(),
      )
      return {
        id:           row.id,
        slug:         row.slug,
        name:         row.name,
        role:         member?.role  ?? null,
        team:         member?.team  ?? null,
        member_count: row.members.length,
        created_at:   row.created_at,
      }
    })

    res.json({ projects, github_login: githubLogin, source: 'db' })
  } catch (err) {
    res.status(500).json({ error: 'db_error', message: err.message })
  }
})

// POST /auth/switch
// Switch the active project scope without re-authenticating with GitHub.
// The existing JWT proves identity; this issues a new JWT scoped to the target project.
// Verifies membership in the target project before issuing.
router.post('/switch', verifyJwt, async (req, res) => {
  const { project_id } = req.body ?? {}
  const caller         = req.user.sub

  if (!project_id) {
    return res.status(400).json({ error: 'missing_param', message: 'project_id required' })
  }

  const pool = req.app.locals.pool
  let row
  try {
    const result = await pool.query(
      `SELECT id, slug, name, members
       FROM projects
       WHERE (id = $1 OR slug = $1) AND status = 'ACTIVE'`,
      [project_id],
    )
    row = result.rows[0]
  } catch (err) {
    return res.status(500).json({ error: 'db_error', message: err.message })
  }

  if (!row) {
    return res.status(404).json({
      error:   'project_not_found',
      message: `Project '${project_id}' not found`,
    })
  }

  const member = row.members.find(
    (m) => m.github_username?.toLowerCase() === caller.toLowerCase(),
  )
  if (!member) {
    return res.status(403).json({
      error:   'not_a_member',
      message: `You are not a member of project '${project_id}'`,
    })
  }

  const role           = member.role ?? null
  const team           = member.team ?? null
  const baseConfidence = member.base_confidence ?? 0.7

  const { privateKey, kid } = getKeys()
  const token = await new SignJWT({
    sub:             caller,
    project:         row.slug,
    role,
    team,
    method:          'jwt_switch',
    base_confidence: baseConfidence,
  })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .setIssuer('quorum-gateway')
    .sign(privateKey)

  res.json({
    token,
    expires_in:      TOKEN_TTL_SECONDS,
    sub:             caller,
    project:         row.slug,
    role,
    team,
    base_confidence: baseConfidence,
  })
})

// POST /auth/refresh
// Exchange a still-valid Quorum JWT for a fresh one — no GitHub re-auth needed.
// The existing JWT IS the proof of identity; we just extend the expiry.
// Rate-limited by the per-engineer limit applied in server.js.
router.post('/refresh', verifyJwt, async (req, res) => {
  const { sub, project, role, team, method, base_confidence } = req.user
  const { privateKey, kid } = getKeys()

  const token = await new SignJWT({
    sub,
    project,
    role,
    team,
    method: method ?? 'jwt',
    base_confidence,
  })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .setIssuer('quorum-gateway')
    .sign(privateKey)

  res.json({
    token,
    expires_in:      TOKEN_TTL_SECONDS,
    sub,
    project,
    role,
    team,
    base_confidence,
  })
})

export default router
