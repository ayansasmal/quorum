/**
 * Quorum MCP Server entry point.
 *
 * Startup sequence:
 *   1. Connect PostgreSQL pool
 *   2. Verify SHA256 audit chain integrity (hard stop on violation)
 *   3. Load S3 config (or local path / env fallback)
 *   4. Resolve caller identity (4-layer chain)
 *   5. Validate MCP manifest has no delete-capable tools
 *   6. Start /health HTTP endpoint
 *   7. Connect MCP stdio transport
 *
 * Identity is resolved once and injected into every tool handler call.
 * Tool schemas do not accept author/reviewer as input — server-side only.
 */

// Apply .quorum project file defaults before any other initialization.
// This sets QUORUM_GATEWAY_URL and QUORUM_PROJECT_ID if not already set via env.
import { applyQuorumFileDefaults } from './quorum-file.js'
applyQuorumFileDefaults()

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from 'node:http'
import pg from 'pg'

import { verifyChain, ChainIntegrityViolation } from './audit/chain.js'
import { getAllEntries, countEntries } from './audit/secondary.js'
import { validateManifestHasNoDeleteTools } from './governance/constitutional.js'
import { ping as pingGraphiti } from './graph/client.js'
import { loadConfig, stopConfigPoller } from './config/loader.js'
import { resolveIdentity } from './identity/resolver.js'
import { getGatewayClient } from './gateway/client.js'

import * as remember from './tools/remember.js'
import * as recall from './tools/recall.js'
import * as search from './tools/search.js'
import * as forget from './tools/forget.js'
import * as history from './tools/history.js'
import * as review from './tools/review.js'
import * as reflect from './tools/reflect.js'
import * as exportTool from './tools/export.js'
import * as pending from './tools/pending.js'

// ── PostgreSQL pool or Gateway client ─────────────────────────────────────────
// In gateway mode (QUORUM_GATEWAY_URL set), the gateway client replaces the
// direct pg.Pool. Tool handlers are unaware of the difference — both expose
// the same interface for the operations they use.

const gatewayClient = getGatewayClient()

const pool = gatewayClient ?? new pg.Pool({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB ?? 'quorum_audit',
  user: process.env.POSTGRES_USER ?? 'quorum',
  password: process.env.POSTGRES_PASSWORD ?? 'quorum_local',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

if (gatewayClient) {
  console.error(`[Quorum] Gateway mode: routing DB + Graphiti through ${process.env.QUORUM_GATEWAY_URL}`)
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'quorum',
  version: '0.2.0',
})

const tools = [
  { name: 'remember',  def: remember },
  { name: 'recall',    def: recall },
  { name: 'search',    def: search },
  { name: 'forget',    def: forget },
  { name: 'history',   def: history },
  { name: 'review',    def: review },
  { name: 'reflect',   def: reflect },
  { name: 'export',    def: exportTool },
  { name: 'pending',   def: pending },
]

/**
 * Register all tools with the MCP server.
 * Identity is captured in the closure and injected into every handler call —
 * it is never sourced from tool input.
 * @param {import('./identity/resolver.js').ResolvedIdentity} identity
 */
function registerTools(identity) {
  for (const { name, def } of tools) {
    server.tool(name, def.schema.shape ?? def.schema, async (input) => {
      try {
        const result = await def.handler(pool, input, identity)
        return {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        }
      }
    })
  }
}

// ── Startup ────────────────────────────────────────────────────────────────────

async function verifyStoreSync() {
  // In gateway mode, count entries via gateway REST API
  const pgCount = gatewayClient
    ? await gatewayClient.countEntries().catch(() => -1)
    : await countEntries(pool).catch(() => -1)
  if (pgCount === -1) {
    console.error('[Quorum] WARNING: Could not reach audit store')
  }
}

async function startup() {
  console.error('[Quorum] Starting up...')

  // 1. Verify audit chain integrity — hard stop if broken
  try {
    const entries = await getAllEntries(pool).catch(() => [])
    if (entries.length > 0) {
      const result = verifyChain(entries)
      console.error(`[Quorum] ✓ Audit chain verified (${result.entries} entries)`)
    } else {
      console.error('[Quorum] ✓ Audit chain empty — fresh start')
    }
  } catch (err) {
    if (err instanceof ChainIntegrityViolation) {
      console.error(`[Quorum] FATAL: Audit chain integrity violation at position ${err.position}`)
      console.error(`[Quorum] Expected: ${err.expected}`)
      console.error(`[Quorum] Actual:   ${err.actual}`)
      process.exit(1)
    }
    console.error('[Quorum] WARNING: Could not verify audit chain:', err.message)
  }

  // 2. Verify stores are reachable
  await verifyStoreSync()

  // 3. Load config from S3 / local file / env fallback
  // Config must be loaded before identity resolution (identity maps roles from config)
  try {
    const config = await loadConfig(pool)
    console.error(`[Quorum] ✓ Config loaded (project: ${config.project}, members: ${config.members.length})`)
  } catch (err) {
    console.error(`[Quorum] WARNING: Config load failed — using env defaults: ${err.message}`)
  }

  // 4. Resolve caller identity — once per session, injected into all tool calls
  // In gateway mode, identity comes from the JWT (verified by the gateway).
  // In direct mode, identity is resolved locally via the 4-layer chain.
  const identity = gatewayClient
    ? await gatewayClient.getIdentity()
    : await resolveIdentity()
  console.error(`[Quorum] ✓ Identity resolved: ${identity.name} (method: ${identity.method}, role: ${identity.role ?? 'none'})`)

  // 5. Validate MCP manifest has no delete-capable tools
  validateManifestHasNoDeleteTools(tools.map((t) => ({ name: t.name })))
  console.error('[Quorum] ✓ Tool manifest validated (no delete tools)')

  // 6. Register tools with identity in closure
  registerTools(identity)

  // 7. Start health HTTP endpoint
  startHealthServer()

  // 8. Connect MCP transport
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[Quorum] ✓ MCP server connected via stdio')
  console.error(`[Quorum] Ready — ${tools.length} tools registered`)
}

// ── Health HTTP server ─────────────────────────────────────────────────────────

function startHealthServer() {
  const port = parseInt(process.env.QUORUM_PORT ?? '8000', 10)

  const httpServer = createServer(async (req, res) => {
    if (req.url !== '/health' && req.url !== '/') {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const [graphConnected, auditConnected] = await Promise.all([
      pingGraphiti(),
      pool.query('SELECT 1').then(() => true).catch(() => false),
    ])

    const status = graphConnected && auditConnected ? 'healthy' : 'degraded'
    const code = status === 'healthy' ? 200 : 503

    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status,
      graph: graphConnected ? 'connected' : 'unavailable',
      audit: auditConnected ? 'connected' : 'unavailable',
      timestamp: new Date().toISOString(),
    }))
  })

  httpServer.listen(port, () => {
    console.error(`[Quorum] ✓ Health endpoint: http://localhost:${port}/health`)
  })
}

// ── Graceful shutdown ──────────────────────────────────────────────────────────

async function shutdown() {
  console.error('[Quorum] Shutting down...')
  stopConfigPoller()
  if (!gatewayClient) {
    await pool.end().catch(() => {})
  }
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ── Run ────────────────────────────────────────────────────────────────────────

startup().catch((err) => {
  console.error('[Quorum] Startup failed:', err)
  process.exit(1)
})
