/**
 * Gateway rate limiting (GAP-14 + GAP-31).
 *
 * Two tiers — applied in order, both must pass:
 *
 *   1. Per-engineer (GAP-14): 300 req/min per JWT subject.
 *      Prevents a single engineer's runaway agent from flooding Graphiti.
 *
 *   2. Per-project (GAP-31): 1000 req/min per project_id.
 *      Prevents a large team (many concurrent engineers) from starving other projects
 *      sharing the same Graphiti instance. 1000/min gives headroom for a 3-engineer
 *      team at peak (900/min) without blocking smaller teams.
 *
 * Implementation: in-memory sliding window using a Map<key, number[]>.
 * Timestamps older than the window are pruned on each check.
 * No external dependency required — fits the project's zero-new-dependency rule.
 *
 * Trade-off: resets on gateway restart (acceptable for internal tool).
 * For production multi-replica deployments, replace with Redis-backed rate limiting.
 */

/** @type {Map<string, number[]>} Sliding window timestamps per rate-limit key. */
const windows = new Map()

/**
 * Sliding-window rate limiter.
 * Returns 429 if key has exceeded max requests within windowMs.
 *
 * @param {object} opts
 * @param {number} opts.windowMs - Window size in milliseconds
 * @param {number} opts.max - Max requests per window
 * @param {(req: import('express').Request) => string | null} opts.keyFn - Returns the rate-limit key
 * @param {string} opts.errorCode - Error code in JSON response
 * @param {string} opts.errorMessage - Human-readable error in JSON response
 * @returns {import('express').RequestHandler}
 */
function createLimiter({ windowMs, max, keyFn, errorCode, errorMessage }) {
  return (req, res, next) => {
    const key = keyFn(req)
    if (!key) return next()  // no key = no limit (e.g. unauthenticated route)

    const now = Date.now()
    const cutoff = now - windowMs

    // Prune expired timestamps and count hits in current window
    const hits = (windows.get(key) ?? []).filter((t) => t > cutoff)
    hits.push(now)
    windows.set(key, hits)

    const remaining = Math.max(0, max - hits.length)
    res.setHeader('X-RateLimit-Limit', max)
    res.setHeader('X-RateLimit-Remaining', remaining)
    res.setHeader('X-RateLimit-Reset', Math.ceil((now + windowMs) / 1000))

    if (hits.length > max) {
      return res.status(429).json({
        error: errorCode,
        message: errorMessage,
        retry_after_seconds: Math.ceil(windowMs / 1000),
      })
    }

    next()
  }
}

/**
 * Per-engineer rate limiter (GAP-14).
 * Key: JWT subject (github username). 300 req/min.
 * Applied to all authenticated gateway routes.
 */
export const engineerLimit = createLimiter({
  windowMs: 60_000,
  max: 300,
  keyFn: (req) => req.user?.sub ?? null,
  errorCode: 'ENGINEER_RATE_LIMIT',
  errorMessage: 'Rate limit exceeded — 300 requests/minute per engineer. Slow down your agent.',
})

/**
 * Per-project rate limiter (GAP-31).
 * Key: project_id resolved from JWT or project token. 1000 req/min.
 * Applied after the per-engineer limiter, on routes that resolve project context.
 *
 * Why 1000/min: 3 concurrent engineers at peak = 900/min (3 × 300).
 * 1000 gives headroom for bursts without blocking neighbouring projects.
 */
export const projectLimit = createLimiter({
  windowMs: 60_000,
  max: 1000,
  keyFn: (req) => req.user?.project ?? req.projectId ?? null,
  errorCode: 'PROJECT_RATE_LIMIT',
  errorMessage: 'Project rate limit exceeded — too many concurrent requests from this project. Back off and retry.',
})
