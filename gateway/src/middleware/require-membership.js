/**
 * Public-project write-membership guard.
 *
 * Public projects are readable by authenticated non-members, but mutating
 * requests require either a resolved project role or platform-admin status.
 */

/** @type {ReadonlySet<string>} */
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

/**
 * Reject mutating requests from roleless non-members.
 *
 * Mount after JWT verification has populated `req.user`.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireMembership(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next()
  if (req.user?.is_admin === true) return next()
  if (req.user?.role == null) {
    return res.status(403).json({
      error:   'not_a_member',
      message: 'Writing to this project requires membership. Public projects are read-only for non-members.',
    })
  }
  next()
}
