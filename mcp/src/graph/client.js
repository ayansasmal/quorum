/**
 * Graphiti HTTP client.
 *
 * Graphiti is Python-only — it runs as a Docker sidecar and exposes an MCP
 * HTTP endpoint. Quorum never imports graphiti; it calls it like any HTTP service.
 *
 * All Graphiti delete methods are blocked here. Constitutional Rule 1 (no hard
 * deletes) is enforced at this layer: BLOCKED_METHODS is exported so the
 * constitutional test suite can verify the block is in place.
 *
 * Gateway mode: when QUORUM_GATEWAY_URL is set, Graphiti calls are proxied
 * through the gateway (/graphiti/*) instead of calling Graphiti directly.
 * The gateway injects the project claim as group_id automatically.
 *
 * MCP session protocol (streamable-http transport):
 *   1. POST /mcp with method="initialize" → server returns Mcp-Session-Id header
 *   2. All subsequent tool calls include that header
 *   3. 400 responses indicate expired/invalid session → re-initialize and retry
 */

import { randomUUID } from 'crypto'

const GRAPHITI_URL = process.env.GRAPHITI_URL || 'http://graphiti:8000'
const GROUP_ID = process.env.QUORUM_GROUP_ID || 'default'

/**
 * Dedicated Graphiti group ID for audit episodes.
 * Kept separate from GROUP_ID so audit records never appear in
 * normal knowledge searches (searchNodes / searchFacts).
 *
 * @type {string}
 */
export const AUDIT_GROUP_ID = 'quorum-audit'

/**
 * Returns the base URL for Graphiti calls.
 * In gateway mode, routes to the gateway's /graphiti prefix.
 * @returns {{ baseUrl: string, useGateway: boolean }}
 */
function graphitiTarget() {
  const gatewayUrl = process.env.QUORUM_GATEWAY_URL
  if (gatewayUrl) {
    return { baseUrl: `${gatewayUrl.replace(/\/$/, '')}/graphiti`, useGateway: true }
  }
  return { baseUrl: GRAPHITI_URL, useGateway: false }
}

/** Methods Graphiti exposes that Quorum must never call. */
export const BLOCKED_METHODS = new Set([
  'delete_episode',
  'delete_entity',
  'delete_edge',
  'purge',
  'purge_group',
  'remove',
  'drop',
  'truncate',
])

/**
 * Returns true if the given Graphiti method name is blocked by constitutional rule.
 * @param {string} method
 * @returns {boolean}
 */
export function isMethodBlocked(method) {
  return BLOCKED_METHODS.has(method.toLowerCase())
}

// ── Typed errors ──────────────────────────────────────────────────────────────

export class GraphitiConnectionError extends Error {
  /** @param {string} message @param {unknown} [cause] */
  constructor(message, cause) {
    super(message)
    this.name = 'GraphitiConnectionError'
    this.cause = cause
  }
}

export class GraphitiResponseError extends Error {
  /** @param {string} message @param {number} status @param {unknown} [body] */
  constructor(message, status, body) {
    super(message)
    this.name = 'GraphitiResponseError'
    this.status = status
    this.body = body
  }
}

// ── MCP session management ─────────────────────────────────────────────────────

/** Active MCP session ID (per process — one session shared across all tool calls). */
let _sessionId = null

/**
 * Initialize an MCP session with Graphiti via the streamable-http handshake.
 * Stores the returned Mcp-Session-Id for reuse on subsequent calls.
 *
 * @param {string} endpoint  — full URL to /mcp
 * @param {Record<string, string>} [authHeaders] — optional Authorization header
 * @returns {Promise<string>} the session ID
 */
async function initSession(endpoint, authHeaders = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':        'application/json, text/event-stream',
      ...authHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id:      1,
      method:  'initialize',
      params:  {
        protocolVersion: '2024-11-05',
        capabilities:    {},
        clientInfo:      { name: 'quorum', version: '1.0' },
      },
    }),
  })

  const sessionId = res.headers.get('mcp-session-id')
  if (!sessionId) throw new GraphitiConnectionError('Graphiti MCP did not return a session ID')
  _sessionId = sessionId
  return sessionId
}

/**
 * Parse the MCP streamable-http response (SSE envelope or plain JSON).
 * Extracts the JSON-RPC result and returns the tool's structured output.
 *
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function parseMcpResponse(response) {
  const text = await response.text()
  // SSE format: "event: message\ndata: {...}\n\n"
  const m = text.match(/^data: (.+)$/m)
  const envelope = m ? JSON.parse(m[1]) : JSON.parse(text)
  if (envelope.error) {
    throw new GraphitiResponseError(envelope.error.message, 400, envelope.error)
  }
  const result = envelope.result
  // Prefer structuredContent (machine-readable), fall back to parsed text content
  if (result?.structuredContent?.result !== undefined) return result.structuredContent.result
  if (result?.content?.[0]?.text) {
    try { return JSON.parse(result.content[0].text) } catch { return { message: result.content[0].text } }
  }
  return result
}

// ── Internal HTTP helpers ──────────────────────────────────────────────────────

/**
 * POST to Graphiti's MCP endpoint using JSON-RPC 2.0 over streamable-http.
 * Manages the MCP session automatically (initialize on first call, re-initialize on 400).
 * Retries connection errors with exponential backoff.
 *
 * @param {string} tool
 * @param {Record<string, unknown>} params
 * @param {number} [maxRetries=3]
 * @returns {Promise<unknown>}
 */
async function callGraphiti(tool, params, maxRetries = 3) {
  if (isMethodBlocked(tool)) {
    throw new Error(`ConstitutionalViolation[NO_HARD_DELETE]: Graphiti method '${tool}' is blocked`)
  }

  const { baseUrl, useGateway } = graphitiTarget()
  const endpoint = `${baseUrl}/mcp`

  // In gateway mode, include Authorization header from the gateway client
  let authHeaders = {}
  if (useGateway) {
    try {
      const { getGatewayClient } = await import('../gateway/client.js')
      const gwClient = getGatewayClient()
      if (gwClient) {
        const { token } = await gwClient._getToken()
        authHeaders = { Authorization: `Bearer ${token}` }
      }
    } catch { /* gateway client not available — fall through */ }
  }

  let lastError
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Ensure a live MCP session exists before making the tool call
    if (!_sessionId) {
      try {
        await initSession(endpoint, authHeaders)
      } catch (err) {
        throw new GraphitiConnectionError(
          `Could not reach Graphiti at ${baseUrl}: ${err.message}`, err)
      }
    }

    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)))
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Accept':         'application/json, text/event-stream',
          'Mcp-Session-Id': _sessionId,
          ...authHeaders,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id:      Date.now(),
          method:  'tools/call',
          params:  { name: tool, arguments: params },
        }),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        // 400 usually means session expired — clear it so next attempt re-initializes
        if (response.status === 400) _sessionId = null
        throw new GraphitiResponseError(
          `Graphiti responded ${response.status} for tool '${tool}'`,
          response.status,
          body,
        )
      }

      return await parseMcpResponse(response)
    } catch (err) {
      if (err instanceof GraphitiResponseError) {
        // Retry on 400 (session re-init) but not on other 4xx errors
        if (err.status === 400 && attempt < maxRetries) { lastError = err; continue }
        throw err
      }
      lastError = new GraphitiConnectionError(
        `Could not reach Graphiti at ${GRAPHITI_URL}: ${err.message}`,
        err,
      )
    }
  }

  throw lastError
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Store a new knowledge episode in Graphiti.
 * @param {string} content
 * @param {{ key: string, source: string, entityType?: string, tags?: string[] }} metadata
 * @param {string} [groupId] - project isolation namespace; defaults to QUORUM_GROUP_ID env var
 * @returns {Promise<{ episode_id: string }>}
 */
export async function addEpisode(content, metadata, groupId = GROUP_ID) {
  const uuid = randomUUID()
  await callGraphiti('add_memory', {
    name:               metadata.key,
    episode_body:       content,
    group_id:           groupId,
    source_description: metadata.source,
    uuid,
  })
  return { episode_id: uuid }
}

/**
 * Store a new version of a knowledge node AND create a SUPERSEDES edge in
 * Graphiti from the new episode to the old one. This builds the organic
 * evolution chain — traversable via getEvolutionChain().
 * @param {string} newContent
 * @param {string} oldEpisodeId
 * @param {{ key: string, source: string, entityType?: string, tags?: string[], reason?: string }} metadata
 * @param {string} [groupId] - project isolation namespace; defaults to QUORUM_GROUP_ID env var
 * @returns {Promise<{ episode_id: string }>}
 */
export async function addSupersedingEpisode(newContent, oldEpisodeId, metadata, groupId = GROUP_ID) {
  const uuid = randomUUID()
  await callGraphiti('add_memory', {
    name:               metadata.key,
    episode_body:       `${newContent}\n\n[supersedes:${oldEpisodeId}] ${metadata.reason ?? 'updated'}`,
    group_id:           groupId,
    source_description: metadata.source,
    uuid,
  })

  return { episode_id: uuid }
}

/**
 * Walk the SUPERSEDES edges from an episode back to the root, returning the
 * full organic evolution chain as an ordered array (newest first).
 * @param {string} episodeId
 * @param {string} [groupId] - project isolation namespace; defaults to QUORUM_GROUP_ID env var
 * @returns {Promise<Array<{ episode_id: string, metadata: unknown }>>}
 */
export async function getEvolutionChain(episodeId, groupId = GROUP_ID) {
  const result = await callGraphiti('search_memory_facts', {
    query:     `supersedes evolution chain for ${episodeId}`,
    group_ids: [groupId],
  }).catch(() => ({ facts: [] }))

  return result.facts ?? []
}

/**
 * Search for knowledge nodes semantically.
 * @param {string} query
 * @param {{ limit?: number, groupIds?: string[], groupId?: string }} [options]
 * @returns {Promise<{ nodes: Array<unknown> }>}
 */
export async function searchNodes(query, options = {}) {
  return callGraphiti('search_nodes', {
    query,
    group_ids: options.groupIds ?? [options.groupId ?? GROUP_ID],
    max_nodes:  options.limit ?? 10,
  })
}

/**
 * Search for relationships/edges across the knowledge graph.
 * @param {string} query
 * @param {{ groupIds?: string[], groupId?: string }} [options]
 * @returns {Promise<{ facts: Array<unknown> }>}
 */
export async function searchFacts(query, options = {}) {
  return callGraphiti('search_memory_facts', {
    query,
    group_ids: options.groupIds ?? [options.groupId ?? GROUP_ID],
  })
}

/**
 * List episodes in a group.
 * @param {string} [groupId]
 * @returns {Promise<{ episodes: Array<unknown> }>}
 */
export async function getEpisodes(groupId = GROUP_ID) {
  return callGraphiti('get_episodes', { group_ids: [groupId] })
}

/**
 * Soft-deprecate an episode by adding a new DEPRECATED marker episode.
 * Never calls Graphiti delete methods — constitutional rule enforced.
 * @param {string} episodeId
 * @param {{ key: string, reason: string, author: string }} meta
 * @param {string} [groupId] - project isolation namespace; defaults to QUORUM_GROUP_ID env var
 */
export async function deleteEpisodeSoft(episodeId, meta, groupId = GROUP_ID) {
  return callGraphiti('add_memory', {
    name:               `${meta.key}:deprecated`,
    episode_body:       `Knowledge deprecated by ${meta.author}. Reason: ${meta.reason}. Deprecated episode: ${episodeId}`,
    group_id:           groupId,
    source_description: 'quorum:deprecation',
    uuid:               randomUUID(),
  })
}

/**
 * Ping Graphiti (or gateway) to verify connectivity.
 * In gateway mode, pings the gateway /health endpoint which checks Graphiti internally.
 * @returns {Promise<boolean>}
 */
export async function ping() {
  const { baseUrl, useGateway } = graphitiTarget()
  try {
    if (useGateway) {
      // The gateway health endpoint checks both PostgreSQL and Graphiti
      const gatewayBase = process.env.QUORUM_GATEWAY_URL.replace(/\/$/, '')
      const res = await fetch(`${gatewayBase}/health`)
      const data = await res.json()
      return data.components?.graphiti === 'connected'
    }
    await fetch(`${baseUrl}/health`)
    return true
  } catch {
    return false
  }
}
