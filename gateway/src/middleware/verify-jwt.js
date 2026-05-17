/**
 * Quorum Gateway — JWT verification middleware (v0.3).
 *
 * Two-step flow:
 *   1. Verify ES256 JWT signature → extract { sub, is_admin }
 *   2. Read X-Quorum-Project header → active project context
 *   3. Load user profile from Redis/DDB → role, base_confidence, is_owner for active project
 *   4. Attach to req.user = { sub, is_admin, project, role, base_confidence, is_owner }
 *
 * If X-Quorum-Project is absent, req.user.project is null (not an error — some routes
 * operate without a project scope, e.g. /user/profile, /admin/*).
 */

import { jwtVerify } from 'jose'
import { getKeys } from '../keys.js'
import { loadUserProfile } from '../config-cache.js'

/**
 * Resolve a q_project_id (e.g. 'q_p1') to its human-readable group_id by
 * querying q_projects. Post-Phase-3 MCP clients send q_p{n} in the
 * X-Quorum-Project header, but profile entries are keyed by group_id, so we
 * must translate before doing the profile lookup.
 *
 * Returns null if the project doesn't exist or pool is unavailable.
 *
 * @param {import('pg').Pool | undefined} pool
 * @param {string} qProjectId
 * @returns {Promise<string | null>}
 */
async function resolveGroupId(pool, qProjectId) {
  if (!pool) return null
  try {
    const { rows } = await pool.query(
      `SELECT group_id FROM q_projects WHERE q_project_id = $1 LIMIT 1`,
      [qProjectId],
    )
    return rows[0]?.group_id ?? null
  } catch {
    return null
  }
}

/**
 * Express middleware that verifies the Bearer JWT and enriches req.user
 * with profile data from the cache.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function verifyJwt(req, res, next) {
  const authHeader = req.headers['authorization'] ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    return res.status(401).json({
      error:   'missing_token',
      message: 'Authorization: Bearer <token> header required',
    })
  }

  try {
    const { publicKey } = getKeys()
    const { payload } = await jwtVerify(token, publicKey, {
      issuer:     'quorum-gateway',
      algorithms: ['ES256'],
    })

    const sub      = payload.sub
    const isAdmin  = payload.is_admin ?? false
    const project  = req.headers['x-quorum-project'] ?? null

    // Load profile from Redis/DDB — always succeeds (returns empty projects array on miss)
    const profile  = await loadUserProfile(sub)

    // Profile entries are keyed by group_id (the human-readable slug). Post-
    // Phase-3 MCP clients send q_p{n} in X-Quorum-Project, so we resolve
    // q_project_id → group_id via the DB before doing the find. We also
    // accept a direct group_id match in case a profile ever carries the
    // q_project_id alongside group_id.
    let entry = null
    if (project) {
      const isQProjectId = /^q_p\d+$/.test(project)
      if (isQProjectId) {
        const groupId = await resolveGroupId(req.app?.locals?.pool, project)
        entry = profile.projects.find((p) =>
          p.q_project_id === project || (groupId && p.group_id === groupId),
        ) ?? null
      } else {
        entry = profile.projects.find((p) => p.group_id === project) ?? null
      }
    }

    /** @type {{ sub: string, is_admin: boolean, project: string | null, role: string | null, base_confidence: number, is_owner: boolean }} */
    req.user = {
      sub,
      is_admin:        isAdmin,
      project,
      role:            entry?.role            ?? null,
      base_confidence: entry?.base_confidence ?? 0.5,
      is_owner:        entry?.is_owner        ?? false,
    }

    next()
  } catch (err) {
    const expired = err.code === 'ERR_JWT_EXPIRED'
    res.status(401).json({
      error:   expired ? 'token_expired' : 'invalid_token',
      message: expired
        ? 'JWT has expired — re-authenticate via POST /auth/token'
        : 'Invalid or malformed JWT',
    })
  }
}
