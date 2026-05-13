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
    const entry    = project
      ? profile.projects.find((p) => p.group_id === project) ?? null
      : null

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
