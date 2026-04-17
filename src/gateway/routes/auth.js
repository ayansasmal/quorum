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

export default router
