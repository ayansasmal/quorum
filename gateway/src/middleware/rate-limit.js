/**
 * Rate limiting middleware for the Quorum Gateway.
 *
 * Two tiers:
 *   authLimit     — 10 token requests/minute per IP (protects /auth/token brute-force)
 *   apiLimit      — 300 calls/minute per engineer (JWT subject after auth)
 *   graphitiLimit — 100 calls/minute per engineer (Graphiti is expensive)
 *
 * All limits use in-process state. For multi-replica deployments, swap the
 * store to rate-limit-redis using the FalkorDB instance already in the stack:
 *   store: new RedisStore({ client: redisClient })
 */

import { rateLimit } from 'express-rate-limit'

/** Resolves the rate-limit key from JWT subject (post-auth) or falls back to IP. */
const bySubject = (req) => req.auth?.sub ?? req.ip

export const authLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyGenerator: (req) => req.ip,
  message: { error: 'Too many auth requests — try again in a minute', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
})

export const apiLimit = rateLimit({
  windowMs: 60_000,
  max: 300,
  keyGenerator: bySubject,
  message: { error: 'API rate limit exceeded', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
})

export const graphitiLimit = rateLimit({
  windowMs: 60_000,
  max: 100,
  keyGenerator: bySubject,
  message: { error: 'Graphiti rate limit exceeded', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
})
