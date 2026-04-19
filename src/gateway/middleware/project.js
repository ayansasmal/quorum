/**
 * Quorum Gateway — project authentication middleware.
 *
 * Resolves the `X-Quorum-Token` header to a project row and attaches it to
 * `req.project`. Routes that require project context should mount this
 * middleware before their JWT-auth middleware.
 *
 * On success:  req.project = { id, slug, name, members, domains, governance, config_version }
 * On failure:  401 UNAUTHORIZED (missing token) or 403 FORBIDDEN (invalid token)
 *
 * Token hashing: SHA-256 hex of the raw token — same scheme used at project creation.
 */

import { createHash } from 'node:crypto'
import { getProjectByTokenHash } from '../config-cache.js'
import { Errors } from '../errors.js'

/**
 * Express middleware: resolve X-Quorum-Token → req.project.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function projectMiddleware(req, res, next) {
  const raw = req.headers['x-quorum-token']

  if (!raw) {
    return next(Errors.unauthorized('X-Quorum-Token header is required'))
  }

  const tokenHash = createHash('sha256').update(raw).digest('hex')
  const pool = req.app.locals.pool

  try {
    const project = await getProjectByTokenHash(tokenHash, pool)
    if (!project) {
      return next(Errors.forbidden('Invalid or expired project token'))
    }
    req.project = project
    next()
  } catch (err) {
    next(err)
  }
}
