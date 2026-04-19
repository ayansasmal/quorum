/**
 * Structured HTTP errors for the Quorum Gateway.
 *
 * Route handlers throw these instead of crafting raw responses.
 * The global error handler in server.js catches them and serialises safely —
 * stack traces and internal details never reach the client.
 */

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message - safe to send to the client
   * @param {string} [code] - machine-readable error code
   */
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const Errors = {
  unauthorized:  (msg) => new HttpError(401, msg, 'UNAUTHORIZED'),
  forbidden:     (msg) => new HttpError(403, msg, 'FORBIDDEN'),
  notFound:      (msg) => new HttpError(404, msg, 'NOT_FOUND'),
  conflict:      (msg) => new HttpError(409, msg, 'CONFLICT'),
  unprocessable: (msg) => new HttpError(422, msg, 'UNPROCESSABLE'),
  tooManyRequests: (msg) => new HttpError(429, msg, 'RATE_LIMITED'),
  internal:      (msg) => new HttpError(500, msg, 'INTERNAL_ERROR'),
}
