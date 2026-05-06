/**
 * Quorum MCP Server entry point.
 *
 * Startup sequence:
 *   1. Set QUORUM_GATEWAY_URL default (http://localhost:3001)
 *   2. Verify SHA256 audit chain integrity via gateway (non-fatal if not yet authenticated)
 *   3. Load S3 config (or local path / env fallback)
 *   4. Resolve caller identity (from JWT via gateway)
 *   5. Validate MCP manifest has no delete-capable tools
 *   6. Start /health HTTP endpoint
 *   7. Connect MCP stdio transport
 *
 * The MCP always communicates with a Quorum gateway over HTTP — never directly
 * to PostgreSQL or Graphiti. Default gateway: http://localhost:3001 (local dev).
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

import { verifyChain, ChainIntegrityViolation } from './audit/chain.js'
import { getAllEntries, countEntries } from './audit/secondary.js'
import { validateManifestHasNoDeleteTools } from './governance/constitutional.js'
import { ping as pingGraphiti } from './graph/client.js'
import { loadConfig, stopConfigPoller } from './config/loader.js'
import { resolveIdentity } from './identity/resolver.js'
import { getGatewayClient } from './gateway/client.js'
import * as authenticate from './tools/authenticate.js'

import * as remember from './tools/remember.js'
import * as recall from './tools/recall.js'
import * as search from './tools/search.js'
import * as forget from './tools/forget.js'
import * as history from './tools/history.js'
import * as review from './tools/review.js'
import * as reflect from './tools/reflect.js'
import * as exportTool from './tools/export.js'
import * as pending from './tools/pending.js'

// ── Gateway URL default ────────────────────────────────────────────────────────
// The MCP always communicates with a Quorum gateway over HTTP.
// Engineers running the local Docker stack get http://localhost:3001 by default.
// Enterprise teams set QUORUM_GATEWAY_URL to their central Quorum instance.
// The .quorum project file may also set this before we reach this line.
process.env.QUORUM_GATEWAY_URL ??= 'http://localhost:3001'
console.error(`[Quorum] Gateway: ${process.env.QUORUM_GATEWAY_URL}`)
if (!process.env.QUORUM_GITHUB_TOKEN) {
  console.error('[Quorum] ℹ  No token at startup — call authenticate() to log in via GitHub OAuth')
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'quorum',
  version: '0.2.0',
})

const tools = [
  { name: 'remember',     def: remember },
  { name: 'recall',       def: recall },
  { name: 'search',       def: search },
  { name: 'forget',       def: forget },
  { name: 'history',      def: history },
  { name: 'review',       def: review },
  { name: 'reflect',      def: reflect },
  { name: 'export',       def: exportTool },
  { name: 'pending',      def: pending },
  { name: 'authenticate', def: authenticate },
]

/**
 * Register all tools with the MCP server.
 * Identity is captured in the closure and injected into every handler call —
 * it is never sourced from tool input.
 *
 * Pool resolution is deferred to call time (not startup) so that the
 * authenticate() tool can inject a token at runtime and subsequent tool calls
 * transparently pick up the new gateway client.
 *
 * @param {import('./identity/resolver.js').ResolvedIdentity} identity
 */
function registerTools(identity) {
  for (const { name, def } of tools) {
    server.tool(name, def.schema.shape ?? def.schema, async (input) => {
      try {
        // Resolve at call time — picks up any token injected by authenticate()
        const activePool = getGatewayClient()

        // In gateway mode, if no client exists yet, only authenticate() is allowed
        if (process.env.QUORUM_GATEWAY_URL && !getGatewayClient() && name !== 'authenticate') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error:   'not_authenticated',
                message: 'Quorum is in gateway mode but no auth token is available. Call authenticate() first.',
                hint:    'Ask Claude to run the Quorum OAuth login flow using mcp-playwright.',
              }),
            }],
            isError: true,
          }
        }

        const result = await def.handler(activePool, input, identity)
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
  const gw = getGatewayClient()
  if (!gw) return  // not yet authenticated — skip
  const count = await gw.countEntries().catch(() => -1)
  if (count === -1) {
    console.error('[Quorum] WARNING: Could not reach audit store via gateway')
  }
}

async function startup() {
  console.error('[Quorum] Starting up...')

  // 1. Verify audit chain integrity — via gateway (non-fatal if not yet authenticated)
  try {
    const gw = getGatewayClient()
    const entries = gw ? await gw.getAllEntries({}).catch(() => []) : []
    if (entries.length > 0) {
      const result = verifyChain(entries)
      console.error(`[Quorum] ✓ Audit chain verified (${result.entries} entries)`)
    } else {
      console.error('[Quorum] ✓ Audit chain empty — fresh start or not yet authenticated')
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

  // 2. Verify gateway is reachable (skip if not yet authenticated)
  await verifyStoreSync()

  // 3. Load config from S3 / local file / env fallback
  // Config must be loaded before identity resolution (identity maps roles from config)
  try {
    const config = await loadConfig(null)
    console.error(`[Quorum] ✓ Config loaded (project: ${config.project}, members: ${config.members.length})`)
  } catch (err) {
    console.error(`[Quorum] WARNING: Config load failed — using env defaults: ${err.message}`)
  }

  // 4. Resolve caller identity — once per session, injected into all tool calls
  // Identity comes from the JWT (verified by the gateway).
  // Falls back to local resolution if not yet authenticated.
  const activeGatewayClient = getGatewayClient()
  const identity = activeGatewayClient
    ? await activeGatewayClient.getIdentity()
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
      getGatewayClient()?.ping().then(() => true).catch(() => false) ?? false,
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
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ── Run ────────────────────────────────────────────────────────────────────────

startup().catch((err) => {
  console.error('[Quorum] Startup failed:', err)
  process.exit(1)
})
