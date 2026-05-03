/**
 * Quorum Gateway — JWT verification middleware.
 *
 * Verifies ES256-signed JWTs issued by this gateway's POST /auth/token endpoint.
 * On success, attaches the decoded claims to req.user:
 *   { sub, project, role, team, method }
 *
 * On failure, returns 401 with a structured JSON error — never leaks key material.
 */

import { jwtVerify } from 'jose'
import { getKeys } from '../keys.js'

/**
 * Express middleware that verifies the Bearer JWT from the Authorization header.
 * Attaches req.user with the JWT claims on success.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function verifyJwt(req, res, next) {
  const authHeader = req.headers['authorization'] ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    return res.status(401).json({
      error: 'missing_token',
      message: 'Authorization: Bearer <token> header required',
    })
  }

  const { publicKey } = getKeys()

  jwtVerify(token, publicKey, {
    issuer: 'quorum-gateway',
    algorithms: ['ES256'],
  })
    .then(({ payload }) => {
      /** @type {{ sub: string, project: string, role: string | null, team: string | null, method: string }} */
      req.user = {
        sub:             payload.sub,
        project:         payload.project,
        role:            payload.role            ?? null,
        team:            payload.team            ?? null,
        method:          payload.method          ?? 'jwt',
        base_confidence: payload.base_confidence ?? 0.5,
      }
      next()
    })
    .catch((err) => {
      const expired = err.code === 'ERR_JWT_EXPIRED'
      res.status(401).json({
        error: expired ? 'token_expired' : 'invalid_token',
        message: expired
          ? 'JWT has expired — re-authenticate via POST /auth/token'
          : 'Invalid or malformed JWT',
      })
    })
}
