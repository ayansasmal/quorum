/**
 * Quorum identity resolution.
 *
 * Resolves the caller's identity from execution context — never from tool input.
 * The 4-layer chain (first match wins):
 *
 *   1. QUORUM_GITHUB_TOKEN  — verified via GitHub API (GET /user), most authoritative
 *   2. git config user.email — subprocess read, weaker but tied to SSH key in practice
 *   3. QUORUM_AUTHOR        — explicit env var, intended for CI (e.g. github.actor)
 *   4. anonymous            — no signal resolved or identity not in config
 *
 * Identity is resolved once per server session and cached as module state.
 * Every audit entry records the resolution method ('identity_method').
 *
 * Security properties:
 *   - Developers cannot assert their own identity from tool input
 *   - GitHub API issues and verifies the token — not the caller
 *   - Anonymous writes are always DRAFT regardless of content
 *   - The resolution method is recorded in every audit entry
 */

import { execFileSync } from 'node:child_process'
import { getConfig } from '../config/loader.js'

// ── TTL cache ─────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes

/**
 * @type {Map<string, { identity: ResolvedIdentity, expiresAt: number }>}
 * Keyed by token string (or 'anonymous' / 'git_email' / 'env_var' for non-token paths).
 */
const _cache = new Map()

/**
 * @typedef {Object} ResolvedIdentity
 * @property {string}  name            - Display name from config, or raw signal
 * @property {string | null} team      - Team from config (null when anonymous)
 * @property {string | null} role      - Role from config (null when anonymous)
 * @property {number}  base_confidence - Confidence floor: 0.5 (anon) or from role config
 * @property {'github_token' | 'git_email' | 'env_var' | 'anonymous'} method
 */

// ── GitHub token resolution ───────────────────────────────────────────────────

/**
 * Verify a GitHub personal access token by calling the GitHub API.
 * Returns the verified username on success, null on failure.
 * @param {string} token
 * @returns {Promise<string | null>}
 */
async function verifyGitHubToken(token) {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'quorum-mcp-server',
      },
    })
    if (!response.ok) {
      console.error(`[Quorum:identity] GitHub token verification failed: HTTP ${response.status}`)
      return null
    }
    const data = await response.json()
    return data.login ?? null
  } catch (err) {
    console.error(`[Quorum:identity] GitHub API unavailable: ${err.message}`)
    return null
  }
}

// ── Git email resolution ──────────────────────────────────────────────────────

/**
 * Read git user.email from global git config via subprocess.
 * Uses execFileSync (no shell) to prevent command injection.
 * Returns the email string on success, null on failure.
 * @returns {string | null}
 */
function readGitEmail() {
  try {
    const email = execFileSync('git', ['config', '--global', 'user.email'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return email || null
  } catch {
    return null
  }
}

// ── Member lookup ─────────────────────────────────────────────────────────────

/**
 * Look up a member in the loaded config by GitHub username.
 * Returns the member record or null if not found.
 * @param {string} githubUsername
 * @returns {import('../config/schema.js').MemberSchema | null}
 */
function findMemberByGitHubUsername(githubUsername) {
  try {
    const config = getConfig()
    return config.members.find(
      (m) => m.github_username?.toLowerCase() === githubUsername.toLowerCase(),
    ) ?? null
  } catch {
    return null
  }
}

/**
 * Look up a member in the loaded config by git committer email.
 * @param {string} email
 * @returns {import('../config/schema.js').MemberSchema | null}
 */
function findMemberByGitEmail(email) {
  try {
    const config = getConfig()
    return config.members.find(
      (m) => m.git_email?.toLowerCase() === email.toLowerCase(),
    ) ?? null
  } catch {
    return null
  }
}

/**
 * Look up a member in the loaded config by name (case-insensitive).
 * Used for QUORUM_AUTHOR env var matching.
 * @param {string} name
 * @returns {import('../config/schema.js').MemberSchema | null}
 */
function findMemberByName(name) {
  try {
    const config = getConfig()
    return config.members.find(
      (m) => m.name.toLowerCase() === name.toLowerCase(),
    ) ?? null
  } catch {
    return null
  }
}

/**
 * Get the base_confidence floor for a role from config.
 * Falls back to 0.7 when role is not defined in roles map.
 * @param {string} role
 * @returns {number}
 */
function getRoleConfidenceFloor(role) {
  try {
    const config = getConfig()
    return config.roles[role]?.base_confidence ?? 0.7
  } catch {
    return 0.7
  }
}

/**
 * Build a ResolvedIdentity from a member record + resolution method.
 * @param {import('../config/schema.js').MemberSchema} member
 * @param {'github_token' | 'git_email' | 'env_var'} method
 * @returns {ResolvedIdentity}
 */
function identityFromMember(member, method) {
  return {
    name: member.name,
    team: member.team,
    role: member.role,
    base_confidence: getRoleConfidenceFloor(member.role),
    method,
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve the caller's identity from execution context.
 * Runs the 4-layer chain once; result is cached for the session.
 *
 * @param {{ forceRefresh?: boolean }} [options]
 * @returns {Promise<ResolvedIdentity>}
 */
export async function resolveIdentity({ forceRefresh = false } = {}) {
  const githubToken = process.env.QUORUM_GITHUB_TOKEN
  const cacheKey = githubToken ?? 'no-token'

  if (!forceRefresh) {
    const hit = _cache.get(cacheKey)
    if (hit && hit.expiresAt > Date.now()) return hit.identity
  }

  /** @param {ResolvedIdentity} identity */
  const cache = (identity) => {
    _cache.set(cacheKey, { identity, expiresAt: Date.now() + CACHE_TTL_MS })
    return identity
  }

  // ── Layer 1: QUORUM_GITHUB_TOKEN ──────────────────────────────────────────
  if (githubToken) {
    const username = await verifyGitHubToken(githubToken)
    if (username) {
      const member = findMemberByGitHubUsername(username)
      if (member) {
        const identity = identityFromMember(member, 'github_token')
        console.error(`[Quorum:identity] Resolved via GitHub token: ${identity.name} (${identity.role})`)
        return cache(identity)
      }
      // Verified GitHub user but not in config — named but ungoverned
      const identity = { name: username, team: null, role: null, base_confidence: 0.5, method: 'github_token' }
      console.error(`[Quorum:identity] GitHub user @${username} not in config — anonymous confidence applied`)
      return cache(identity)
    }
    // Token present but rejected by GitHub API — revoked or invalid
    console.error('[Quorum:identity] GitHub token rejected — falling through to next layer')
  }

  // ── Layer 2: git config user.email ────────────────────────────────────────
  const gitEmail = readGitEmail()
  if (gitEmail) {
    const member = findMemberByGitEmail(gitEmail)
    if (member) {
      const identity = identityFromMember(member, 'git_email')
      console.error(`[Quorum:identity] Resolved via git email (${gitEmail}): ${identity.name} (${identity.role})`)
      return cache(identity)
    }
    const identity = { name: gitEmail, team: null, role: null, base_confidence: 0.5, method: 'git_email' }
    console.error(`[Quorum:identity] Git email ${gitEmail} not in config — anonymous confidence applied`)
    return cache(identity)
  }

  // ── Layer 3: QUORUM_AUTHOR env var ────────────────────────────────────────
  const quorumAuthor = process.env.QUORUM_AUTHOR
  if (quorumAuthor) {
    const member = findMemberByName(quorumAuthor)
    if (member) {
      const identity = identityFromMember(member, 'env_var')
      console.error(`[Quorum:identity] Resolved via QUORUM_AUTHOR: ${identity.name} (${identity.role})`)
      return cache(identity)
    }
    const identity = { name: quorumAuthor, team: null, role: null, base_confidence: 0.5, method: 'env_var' }
    console.error(`[Quorum:identity] QUORUM_AUTHOR=${quorumAuthor} not in config — anonymous confidence applied`)
    return cache(identity)
  }

  // ── Layer 4: Anonymous ────────────────────────────────────────────────────
  const identity = { name: 'anonymous', team: null, role: null, base_confidence: 0.5, method: 'anonymous' }
  console.error('[Quorum:identity] WARNING: No identity signal resolved — all writes will be DRAFT with base_confidence 0.5')
  return cache(identity)
}

/**
 * Get the currently resolved identity.
 * Returns null if resolveIdentity() has not been called yet.
 * @returns {ResolvedIdentity | null}
 */
export function getIdentity() {
  const token = process.env.QUORUM_GITHUB_TOKEN ?? 'no-token'
  const hit = _cache.get(token)
  return hit && hit.expiresAt > Date.now() ? hit.identity : null
}

/**
 * Clear the identity cache. Primarily for testing.
 */
export function clearIdentityCache() {
  _cache.clear()
}

/**
 * Apply the role-based confidence floor to a caller-provided confidence value.
 * If the caller-provided value is below the role floor, the floor is used instead.
 *
 * @param {number} providedConfidence - Confidence supplied by the caller (0–1)
 * @param {ResolvedIdentity} identity - The resolved identity for this session
 * @returns {number} The effective confidence after applying the floor
 */
export function applyConfidenceFloor(providedConfidence, identity) {
  return Math.max(providedConfidence, identity.base_confidence)
}
