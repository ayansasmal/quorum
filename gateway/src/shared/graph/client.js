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
 * ── Intentional divergence from the canonical quorum-mcp copy ──
 * This is the gateway's vendored copy. It runs INSIDE the gateway and reaches
 * Graphiti DIRECTLY on the trusted internal network — it never proxies through
 * the gateway's own /graphiti/* route (that route exists only for the external
 * MCP server). Consequently this copy deliberately omits two things the
 * canonical copy has: (1) the structured `log` import — the gateway has no
 * equivalent logger module; (2) the gateway-client JWT attach used by the MCP
 * in proxy mode. Keep these omissions when syncing; do not re-add them here.
 *
 * MCP session protocol (streamable-http transport):
 *   1. POST /mcp with method="initialize" → server returns Mcp-Session-Id header
 *   2. All subsequent tool calls include that header
 *   3. 400 responses indicate expired/invalid session → re-initialize and retry
 */

import { randomUUID } from 'crypto'

const GRAPHITI_URL = process.env.GRAPHITI_URL || 'http://graphiti:8000'

// NOTE: The gateway's shared Graphiti client calls Graphiti DIRECTLY (it does
// not proxy through itself). RediSearch — used internally by FalkorDB for
// Graphiti's tag/field filters — treats `-` as a NOT operator inside query
// strings. So group_ids containing hyphens (e.g. `platform-team`) silently
// return zero results. We normalize hyphen → underscore on every group_id
// before it is sent to Graphiti. The MCP proxy in routes/graphiti.js does
// the same thing for forwarded MCP calls; this helper handles the gateway's
// own outbound calls.

/**
 * Normalize a group_id for RediSearch compatibility.
 *
 * Graphiti accepts `^[a-zA-Z0-9_-]+$` but its internal queries through
 * FalkorDB/RediSearch reinterpret `-` as a NOT operator, silently filtering
 * out matching records. Replacing `-` with `_` keeps the ID stable, valid
 * under Graphiti's schema, and safe inside RediSearch tag filters.
 *
 * @param {string} id
 * @returns {string}
 */
export function normalizeGroupId(id) {
  return typeof id === 'string' ? id.replace(/-/g, '_') : id
}

/**
 * Dedicated Graphiti group ID for audit episodes.
 * Kept separate from project group_ids so audit records never appear in
 * normal knowledge searches (searchNodes / searchFacts).
 *
 * @type {string}
 */
export const AUDIT_GROUP_ID = 'quorum-audit'

/**
 * Returns the base URL for Graphiti calls.
 *
 * Routing precedence (first match wins):
 *   1. GRAPHITI_URL set → direct server-side access (gateway, job scripts).
 *      QUORUM_GATEWAY_URL is intentionally ignored: both vars can coexist in the
 *      same container environment (quorum.env is shared), but a process that has a
 *      direct Graphiti endpoint must never route through the external gateway proxy.
 *   2. QUORUM_GATEWAY_URL set → MCP client path: no direct Graphiti access, proxy
 *      all calls through <gatewayUrl>/graphiti (requires Bearer token).
 *   3. Neither set → fall back to GRAPHITI_URL default (http://graphiti:8000).
 *
 * @returns {{ baseUrl: string, useGateway: boolean }}
 */
function graphitiTarget() {
  if (process.env.GRAPHITI_URL) {
    return { baseUrl: process.env.GRAPHITI_URL, useGateway: false }
  }
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
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GraphitiConnectionError(
      `Graphiti session init failed (${res.status}): ${body}`)
  }
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

  const { baseUrl } = graphitiTarget()
  const endpoint = `${baseUrl}/mcp`

  // The gateway reaches Graphiti directly on the trusted internal network and
  // attaches no Authorization header. (A previous revision tried to import a
  // gateway-client module that does not exist in this package and swallowed the
  // resulting module-not-found error in an empty catch — that dead branch is
  // removed. Project isolation is enforced by the explicit group_id passed to
  // every call, not by a token here.)
  const authHeaders = {}

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
        signal: AbortSignal.timeout(30_000),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        // 400 usually means a malformed request; 404 is Graphiti's "Session not found"
        // (e.g. after the Graphiti container restarts and drops its in-memory session
        // store) — both invalidate our cached session so the next attempt re-initializes.
        if (response.status === 400 || response.status === 404) _sessionId = null
        throw new GraphitiResponseError(
          `Graphiti responded ${response.status} for tool '${tool}'`,
          response.status,
          body,
        )
      }

      return await parseMcpResponse(response)
    } catch (err) {
      if (err instanceof GraphitiResponseError) {
        // Retry on 400/404 (session re-init) but not on other 4xx errors
        if ((err.status === 400 || err.status === 404) && attempt < maxRetries) { lastError = err; continue }
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
 * @param {string} groupId - project isolation namespace (required)
 * @param {string} [database] - physical FalkorDB database override (see
 *   migrated_to_shared_graph in QuorumConfigSchema); omitted preserves the default
 *   per-group_id database, unchanged from prior behavior
 * @returns {Promise<{ episode_id: string }>}
 */
export async function addEpisode(content, metadata, groupId, database) {
  if (!groupId) throw new Error('addEpisode: groupId is required')
  // NOTE: do NOT pass uuid to add_memory. In Graphiti 0.29+, providing uuid
  // means "retrieve existing episode with this UUID" — if the node doesn't
  // exist in FalkorDB (e.g. after a volume wipe), add_episode raises
  // NodeNotFoundError and the episode is never created.
  // We generate a local tracking UUID and return it as episode_id; this is
  // stored in knowledge_versions.graphiti_episode_id but is NOT a real
  // Graphiti UUID. Semantic search uses searchNodes() by name, not this ID.
  //
  // normalizeGroupId: hyphens in group_id cause RediSearch (used by FalkorDB
  // under Graphiti) to interpret `-` as NOT, dropping matching records.
  const uuid = randomUUID()
  await callGraphiti('add_memory', {
    name:               metadata.key,
    episode_body:       content,
    group_id:           normalizeGroupId(groupId),
    source_description: metadata.source,
    ...(database !== undefined ? { database } : {}),
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
 * @param {string} groupId - project isolation namespace (required)
 * @param {string} [database] - physical FalkorDB database override, see addEpisode
 * @returns {Promise<{ episode_id: string }>}
 */
export async function addSupersedingEpisode(newContent, oldEpisodeId, metadata, groupId, database) {
  if (!groupId) throw new Error('addSupersedingEpisode: groupId is required')
  // Same reason as addEpisode — do not pass uuid; normalize group_id.
  const uuid = randomUUID()
  await callGraphiti('add_memory', {
    name:               metadata.key,
    episode_body:       `${newContent}\n\n[supersedes:${oldEpisodeId}] ${metadata.reason ?? 'updated'}`,
    group_id:           normalizeGroupId(groupId),
    source_description: metadata.source,
    ...(database !== undefined ? { database } : {}),
  })

  return { episode_id: uuid }
}

/**
 * Walk the SUPERSEDES edges from an episode back to the root, returning the
 * full organic evolution chain as an ordered array (newest first).
 * @param {string} episodeId
 * @param {string} groupId - project isolation namespace (required)
 * @returns {Promise<Array<{ episode_id: string, metadata: unknown }>>}
 */
export async function getEvolutionChain(episodeId, groupId) {
  if (!groupId) throw new Error('getEvolutionChain: groupId is required')
  const result = await callGraphiti('search_memory_facts', {
    query:     `supersedes evolution chain for ${episodeId}`,
    group_ids: [normalizeGroupId(groupId)],
  }).catch(() => ({ facts: [] }))

  return result.facts ?? []
}

/**
 * Search for knowledge nodes semantically.
 *
 * group_ids is normalized (hyphen → underscore) via normalizeGroupId before
 * being passed to Graphiti. RediSearch — used internally by FalkorDB — treats
 * `-` as a NOT operator, so an un-normalized hyphenated group_id silently
 * returns zero results. Normalization keeps project isolation working.
 *
 * @param {string} query
 * @param {{ limit?: number, groupIds?: string[], groupId?: string }} [options]
 * @returns {Promise<{ nodes: Array<unknown> }>}
 */
export async function searchNodes(query, options = {}) {
  const ids = options.groupIds ?? (options.groupId ? [options.groupId] : null)
  const normalizedIds = ids?.map(normalizeGroupId).filter(Boolean)
  return callGraphiti('search_nodes', {
    query,
    max_nodes: options.limit ?? 10,
    ...(normalizedIds?.length ? { group_ids: normalizedIds } : {}),
  })
}

/**
 * Search for relationships/edges across the knowledge graph.
 *
 * group_ids is normalized (hyphen → underscore) via normalizeGroupId — see
 * searchNodes for the rationale (RediSearch NOT-operator collision).
 *
 * @param {string} query
 * @param {{ groupIds?: string[], groupId?: string }} [options]
 * @returns {Promise<{ facts: Array<unknown> }>}
 */
export async function searchFacts(query, options = {}) {
  const ids = options.groupIds ?? (options.groupId ? [options.groupId] : null)
  const normalizedIds = ids?.map(normalizeGroupId).filter(Boolean)
  return callGraphiti('search_memory_facts', {
    query,
    ...(normalizedIds?.length ? { group_ids: normalizedIds } : {}),
  })
}

/**
 * List episodes in a group.
 *
 * Note: group_ids is intentionally NOT passed here. Graphiti's get_episodes
 * tool returns all episodes regardless; project isolation for this listing
 * is enforced upstream at the PostgreSQL layer (q_project_id). If we ever
 * pass group_ids here, the value must be run through normalizeGroupId() to
 * avoid the RediSearch hyphen-as-NOT issue (see searchNodes).
 *
 * @param {string} groupId - project isolation namespace (required for call-site
 *   symmetry with the other graph functions; isolation itself is enforced at
 *   the PostgreSQL q_project_id layer, so group_ids is not forwarded here).
 * @returns {Promise<{ episodes: Array<unknown> }>}
 */
export async function getEpisodes(groupId) {
  if (!groupId) throw new Error('getEpisodes: groupId is required')
  return callGraphiti('get_episodes', {})
}

/**
 * Soft-deprecate an episode by adding a new DEPRECATED marker episode.
 * Never calls Graphiti delete methods — constitutional rule enforced.
 * @param {string} episodeId
 * @param {{ key: string, reason: string, author: string }} meta
 * @param {string} groupId - project isolation namespace (required)
 */
export async function deleteEpisodeSoft(episodeId, meta, groupId) {
  if (!groupId) throw new Error('deleteEpisodeSoft: groupId is required')
  // NOTE: do NOT pass uuid to add_memory. In Graphiti 0.29+, providing uuid
  // triggers the "retrieve existing episode" path which raises
  // NodeNotFoundError when the episode doesn't exist in FalkorDB
  // (e.g. after a volume wipe). Matches quorum-mcp/src/graph/client.js.
  return callGraphiti('add_memory', {
    name:               `${meta.key}:deprecated`,
    episode_body:       `Knowledge deprecated by ${meta.author}. Reason: ${meta.reason}. Deprecated episode: ${episodeId}`,
    group_id:           normalizeGroupId(groupId),
    source_description: 'quorum:deprecation',
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
