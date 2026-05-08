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
 *   GET  /auth/github                   — initiate GitHub OAuth flow
 *   GET  /auth/callback                 — GitHub OAuth callback → redirect dashboard with token
 *   POST /auth/token                    — GitHub OAuth/PAT token + project_id → signed ES256 JWT
 *   POST /auth/refresh                  — renew JWT without re-auth (Bearer JWT → new JWT)
 *   GET  /.well-known/jwks.json         — public key for local JWT verification
 *   GET  /.well-known/oauth-authorization-server — RFC8414 OAuth metadata (MCP auth)
 *   POST /oauth/register                — RFC7591 dynamic client registration
 *   GET  /oauth/authorize               — start PKCE S256 flow → GitHub
 *   GET  /oauth/callback                — GitHub callback → issue auth code
 *   POST /oauth/token                   — exchange auth code + PKCE verifier → JWT
 *   POST /graphiti/*                    — JWT-authenticated Graphiti proxy
 *   GET|POST|PATCH /pg/*                — JWT-authenticated PostgreSQL REST API
 *   GET  /config/:projectId             — project config from S3
 *   POST /config/validate               — validate config JSON (no auth)
 *   GET  /projects                      — list projects the user is a member of
 *   POST /bump/:topic/:key              — MCP server confidence bump (X-Quorum-Token auth)
 *   GET  /api/stats                     — dashboard: aggregated metrics
 *   GET  /api/graph                     — dashboard: Cytoscape.js graph data
 *   GET  /api/knowledge                 — dashboard: paginated knowledge browser
 *   GET  /api/search                    — dashboard: semantic search via Graphiti
 *   POST /api/review/:id                — dashboard: approve / reject / request_changes
 *   POST /api/bump/:topic/:key          — dashboard: confidence bump (JWT auth)
 *   POST /sync/configs                  — trigger full S3→DDB sync (sync token or principal_architect JWT)
 *   GET  /schema/config                 — quorum.config.schema.json for editor validation (no auth)
 *   POST /governance/detect-conflict    — LLM contradiction check between two knowledge nodes (JWT auth)
 *   POST /governance/enrich             — LLM reviewer brief for a confirmed conflict (JWT auth)
 *   POST /governance/extract            — LLM knowledge extraction from a task summary (JWT auth)
 *   GET  /health                        — health check
 */

import express from 'express'
import pg      from 'pg'
import net     from 'net'
import { loadKeys } from './keys.js'
import authRoutes      from './routes/auth.js'
import oauthRoutes     from './routes/oauth.js'
import mcpOauthRouter, { metadataHandler } from './routes/mcp-oauth.js'
import jwksRoutes      from './routes/jwks.js'
import graphitiRoutes  from './routes/graphiti.js'
import pgRoutes        from './routes/pg.js'
import configRoutes    from './routes/config.js'
import projectsRoutes  from './routes/projects.js'
import bumpRoutes      from './routes/bump.js'
import dashboardRoutes from './routes/dashboard.js'
import syncRoutes, { syncAllConfigs } from './routes/sync.js'
import schemaRoutes from './routes/schema.js'
import governanceRoutes from './routes/governance.js'
import { verifyJwt }   from './middleware/verify-jwt.js'
import { engineerLimit, projectLimit } from './middleware/rate-limit.js'

const PORT = parseInt(process.env.QUORUM_GATEWAY_PORT ?? '3001', 10)

// ── PostgreSQL pool ────────────────────────────────────────────────────────────

// GAP-11: native PostgreSQL SSL — set POSTGRES_SSL=true in production.
// Certificate verification is enforced when enabled (no self-signed certs in prod).
const pgSsl = process.env.POSTGRES_SSL === 'true'
  ? { rejectUnauthorized: true }
  : false

const pool = new pg.Pool({
  host:                    process.env.POSTGRES_HOST     ?? 'localhost',
  port:                    parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database:                process.env.POSTGRES_DB       ?? 'quorum_audit',
  user:                    process.env.POSTGRES_USER     ?? 'quorum',
  password:                process.env.POSTGRES_PASSWORD ?? 'quorum_local',
  ssl:                     pgSsl,
  max:                     20,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 5000,
})

// ── Express app ────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: false }))

// Make pool accessible to route handlers
app.locals.pool = pool

// ── Routes ─────────────────────────────────────────────────────────────────────

app.use('/auth',                              oauthRoutes)  // GET /auth/github, GET /auth/callback
app.use('/auth',                              authRoutes)   // POST /auth/token
app.get('/.well-known/oauth-authorization-server', metadataHandler)  // RFC8414 MCP OAuth metadata
app.use('/oauth',                             mcpOauthRouter)  // MCP OAuth 2.1 Authorization Server
app.use('/.well-known/jwks.json',            jwksRoutes)
// JWT-gated routes: per-engineer + per-project rate limits applied (GAP-14, GAP-31)
app.use('/graphiti', verifyJwt, engineerLimit, projectLimit, graphitiRoutes)
app.use('/pg',       verifyJwt, engineerLimit, projectLimit, pgRoutes)
app.use('/config',                            configRoutes)
app.use('/projects', verifyJwt, engineerLimit,              projectsRoutes)
app.use('/bump',                              bumpRoutes)  // MCP server path (X-Quorum-Token)
app.use('/api',      verifyJwt, engineerLimit, projectLimit, dashboardRoutes) // dashboard BFF
// Sync route handles its own auth (sync token OR JWT principal_architect)
app.use('/sync',                              syncRoutes)
// Schema endpoint — public, no auth (editor validation + autocomplete)
app.use('/schema',                            schemaRoutes)
// Governance LLM endpoints — JWT auth (MCP GatewayClient sends Bearer token)
app.use('/governance',                        governanceRoutes)

// ── Health endpoint ────────────────────────────────────────────────────────────

/**
 * TCP reachability check — returns true if a TCP connection can be established.
 * Used to probe FalkorDB (Redis protocol, port 6379) without a full Redis client.
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<boolean>}
 */
function tcpReachable(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => { socket.destroy(); resolve(true)  })
    socket.on('error',   () => { socket.destroy(); resolve(false) })
    socket.on('timeout', () => { socket.destroy(); resolve(false) })
    socket.connect(port, host)
  })
}

app.get('/health', async (_req, res) => {
  const GRAPHITI_URL  = process.env.GRAPHITI_URL              ?? 'http://graphiti:8000'
  const FALKORDB_HOST = process.env.FALKORDB_HOST             ?? 'falkordb'
  const FALKORDB_PORT = parseInt(process.env.FALKORDB_PORT    ?? '6379', 10)
  const S3_BUCKET     = process.env.QUORUM_CONFIG_BUCKET      ?? 'quorum-configs'
  const S3_ENDPOINT   = process.env.AWS_ENDPOINT_URL

  /**
   * Run a single health probe and return { ok, error }.
   * Never throws — all failures are captured and logged.
   * @param {string} name
   * @param {() => Promise<void>} probe
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async function probe(name, fn) {
    try {
      await fn()
      return { ok: true }
    } catch (err) {
      const msg = err.message ?? String(err)
      console.error(`[Gateway] Health probe failed — ${name}: ${msg}`)
      return { ok: false, error: msg }
    }
  }

  const [pg, graphiti, falkordb, s3] = await Promise.all([
    probe('postgresql', () => pool.query('SELECT 1')),

    probe('graphiti', async () => {
      const r = await fetch(`${GRAPHITI_URL}/health`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
    }),

    probe('falkordb', async () => {
      const ok = await tcpReachable(FALKORDB_HOST, FALKORDB_PORT)
      if (!ok) throw new Error(`TCP connect failed (${FALKORDB_HOST}:${FALKORDB_PORT})`)
    }),

    probe('s3', async () => {
      const { S3Client, HeadBucketCommand } = await import('@aws-sdk/client-s3')
      const s3Client = new S3Client({
        region:         process.env.AWS_REGION ?? 'us-east-1',
        endpoint:       S3_ENDPOINT,
        forcePathStyle: !!S3_ENDPOINT,
        credentials:    S3_ENDPOINT
          ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' }
          : undefined,
      })
      await s3Client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }))
    }),
  ])

  const allOk  = pg.ok && graphiti.ok && falkordb.ok && s3.ok
  const status = allOk ? 'healthy' : 'degraded'

  /** @param {{ ok: boolean, error?: string }} result */
  function componentStatus({ ok, error }) {
    if (ok) return 'connected'
    return error ? `unavailable: ${error}` : 'unavailable'
  }

  res.status(allOk ? 200 : 503).json({
    status,
    components: {
      postgresql: componentStatus(pg),
      graphiti:   componentStatus(graphiti),
      falkordb:   componentStatus(falkordb),
      s3:         componentStatus(s3),
    },
    config: {
      s3_bucket:    S3_BUCKET,
      s3_endpoint:  S3_ENDPOINT ?? 'aws (real)',
      graphiti_url: GRAPHITI_URL,
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
app.use((err, _req, res, _next) => {
  const status = err.status ?? 500
  const code   = err.code   ?? 'INTERNAL_ERROR'
  if (status >= 500) console.error('[Gateway] Unhandled error:', err.message)
  res.status(status).json({ error: code.toLowerCase(), message: err.message })
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

  // 3. Sync S3 configs → DynamoDB (non-fatal — warms the cache on restart)
  try {
    const { synced, failed, duration_ms } = await syncAllConfigs()
    console.error(`[Gateway] ✓ DDB sync — ${synced} synced, ${failed.length} failed (${duration_ms}ms)`)
    for (const f of failed) console.error(`[Gateway]   ✗ ${f.project_id}: ${f.error}`)
  } catch (err) {
    console.error(`[Gateway] DDB sync failed (non-fatal): ${err.message}`)
  }

  // 4. Start HTTP server
  app.listen(PORT, () => {
    console.error(`[Gateway] ✓ Listening on port ${PORT}`)
    console.error(`[Gateway] JWKS: http://localhost:${PORT}/.well-known/jwks.json`)
    console.error(`[Gateway] OAuth metadata: http://localhost:${PORT}/.well-known/oauth-authorization-server`)
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
