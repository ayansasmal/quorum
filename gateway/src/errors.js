/**
 * Errors — structured HTTP error factory for Express gateway routes.
 *
 * Each method returns an Error instance with `status` and `code` attached.
 * The gateway's error-handling middleware reads these to send the correct
 * HTTP response — callers just do `return next(Errors.notFound(...))`.
 *
 * @example
 *   return next(Errors.notFound(`Project not found: ${id}`))
 *   return next(Errors.forbidden('Only a principal_architect may do this'))
 *   return next(Errors.conflict('Concurrent modification — re-fetch and retry'))
 *   return next(Errors.unprocessable('slug is required'))
 */

/**
 * Build a structured Error with HTTP status metadata.
 * @param {string} message
 * @param {number} status   HTTP status code
 * @param {string} code     Machine-readable error code
 * @returns {Error & { status: number, code: string }}
 */
function make(message, status, code) {
  const err = new Error(message)
  err.status = status
  err.code   = code
  return err
}

export const Errors = {
  /** 400 — malformed or semantically invalid input */
  unprocessable: (message) => make(message, 400, 'UNPROCESSABLE'),

  /** 403 — authenticated but not authorised */
  forbidden: (message) => make(message, 403, 'FORBIDDEN'),

  /** 404 — resource does not exist */
  notFound: (message) => make(message, 404, 'NOT_FOUND'),

  /** 401 — no valid credentials provided */
  unauthorized: (message) => make(message, 401, 'UNAUTHORIZED'),

  /** 409 — state conflict (duplicate slug, optimistic lock failure, etc.) */
  conflict: (message) => make(message, 409, 'CONFLICT'),

  /** 500 — unexpected server error */
  internal: (message) => make(message, 500, 'INTERNAL_ERROR'),
}
