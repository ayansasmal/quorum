/**
 * Quorum Gateway — Central microservice entry point.
 *
 * The Quorum Gateway is the only component that holds raw infrastructure
 * credentials (PostgreSQL, S3, Graphiti URL). Engineers only need:
 *   - QUORUM_GATEWAY_URL  — where this server lives
 *   - QUORUM_GITHUB_TOKEN — their personal GitHub token
 *
 * Startup sequence:
 *   1. Load ES256 key pair (from env vars, or generate ephemeral in dev)
 *   2. Connect PostgreSQL pool
 *   3. Mount all routes
 *   4. Start HTTP server
 *
 * API surface:
 *   POST /auth/token                    — GitHub token → signed ES256 JWT
 *   GET  /.well-known/jwks.json         — public key for local JWT verification
 *   POST /graphiti/*                    — JWT-authenticated Graphiti proxy
 *   GET|POST|PATCH /pg/*                — JWT-authenticated PostgreSQL REST API
 *   GET  /config/:projectId             — project config from S3
 *   POST /config/validate               — validate config JSON (no auth)
 *   GET  /projects                      — list projects the user is a member of
 *   GET  /health                        — health check
 */

import express from 'express'
import pg from 'pg'
import { loadKeys } from './keys.js'
import { HttpError } from './errors.js'
import { authLimit, apiLimit, graphitiLimit } from './middleware/rate-limit.js'
import authRoutes     from './routes/auth.js'
import jwksRoutes     from './routes/jwks.js'
import graphitiRoutes from './routes/graphiti.js'
import pgRoutes       from './routes/pg.js'
import configRoutes   from './routes/config.js'
import projectsRoutes from './routes/projects.js'

const PORT = parseInt(process.env.QUORUM_GATEWAY_PORT ?? '3001', 10)

// ── PostgreSQL pool ────────────────────────────────────────────────────────────

const pool = new pg.Pool({
  host:                  process.env.POSTGRES_HOST     ?? 'localhost',
  port:                  parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database:              process.env.POSTGRES_DB       ?? 'quorum_audit',
  user:                  process.env.POSTGRES_USER     ?? 'quorum',
  password:              process.env.POSTGRES_PASSWORD ?? 'quorum_local',
  max:                   20,
  idleTimeoutMillis:     30000,
  connectionTimeoutMillis: 5000,
})

// ── Express app ────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: '2mb' }))

// Make pool accessible to route handlers
app.locals.pool = pool

// ── Routes ─────────────────────────────────────────────────────────────────────

app.use('/auth',              authLimit, authRoutes)
app.use('/.well-known/jwks.json', jwksRoutes)
app.use('/graphiti',          graphitiLimit, graphitiRoutes)
app.use('/pg',                apiLimit, pgRoutes)
app.use('/config',            apiLimit, configRoutes)
app.use('/projects',          apiLimit, projectsRoutes)

// ── Health endpoint ────────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  const [pgOk, graphitiOk] = await Promise.all([
    pool.query('SELECT 1').then(() => true).catch(() => false),
    fetch(`${process.env.GRAPHITI_URL ?? 'http://graphiti:8000'}/health`)
      .then((r) => r.ok)
      .catch(() => false),
  ])

  const status = pgOk && graphitiOk ? 'healthy' : 'degraded'
  res.status(status === 'healthy' ? 200 : 503).json({
    status,
    components: {
      postgresql: pgOk      ? 'connected' : 'unavailable',
      graphiti:   graphitiOk ? 'connected' : 'unavailable',
    },
    timestamp: new Date().toISOString(),
  })
})

// ── 404 fallback ───────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Route not found' })
})

// ── Global error handler ───────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err instanceof HttpError ? err.status : (err.status ?? err.statusCode ?? 500)

  // Log 5xx with method + path for diagnostics — never log req.body (may contain tokens)
  if (status >= 500) {
    console.error(`[Gateway] ${req.method} ${req.path} → ${status}: ${err.message}`)
  }

  // Safe response — stack traces, SQL errors, and AWS details stay server-side
  res.status(status).json({
    error: status < 500 ? err.message : 'Internal server error',
    ...(err.code && { code: err.code }),
  })
})

// ── Startup ────────────────────────────────────────────────────────────────────

async function startup() {
  console.error('[Gateway] Starting Quorum Gateway...')

  // 1. Load signing keys
  await loadKeys()
  console.error('[Gateway] ✓ ES256 signing keys loaded')

  // 2. Verify PostgreSQL connection
  try {
    await pool.query('SELECT 1')
    console.error('[Gateway] ✓ PostgreSQL connected')
  } catch (err) {
    console.error('[Gateway] FATAL: Cannot connect to PostgreSQL:', err.message)
    process.exit(1)
  }

  // 3. Start HTTP server
  app.listen(PORT, () => {
    console.error(`[Gateway] ✓ Listening on port ${PORT}`)
    console.error(`[Gateway] JWKS: http://localhost:${PORT}/.well-known/jwks.json`)
    console.error(`[Gateway] Health: http://localhost:${PORT}/health`)
  })
}

// ── Graceful shutdown ──────────────────────────────────────────────────────────

async function shutdown() {
  console.error('[Gateway] Shutting down...')
  await pool.end().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

startup().catch((err) => {
  console.error('[Gateway] Startup failed:', err)
  process.exit(1)
})
