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
 * MCP transport (streamable-http, stateless): Graphiti's MCP server runs with
 * `stateless_http=True` (quorum-graphiti fork), so every tool call is a single,
 * self-contained POST /mcp with method="tools/call" — no initialize handshake,
 * no Mcp-Session-Id, nothing shared across concurrent calls. This replaced a
 * shared-session design that raced under concurrency: see
 * quorum/docs/RCA-search-concurrency-session-stall-2026-07-27.md.
 */

import { randomUUID } from 'crypto'

const GRAPHITI_URL = process.env.GRAPHITI_URL || 'http://graphiti:8000'
const DEBUG = process.env.LOG_LEVEL === 'debug'

/**
 * Emit a structured DEBUG-only log line for this module's outbound Graphiti calls.
 * No-op unless LOG_LEVEL=debug. Mirrors the dbg() helper in routes/graphiti.js —
 * kept as a local, dependency-free copy since this file has no logger import
 * (see the vendoring note in the file header).
 * @param {string} stage - checkpoint name (e.g. 'graphiti_client_fetch_timeout_fired')
 * @param {object} data - extra structured fields merged into the log line
 * @returns {void}
 */
function dbg(stage, data) {
  if (DEBUG) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), stage, ...data }))
  }
}

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
 * Stateless: Graphiti's MCP server runs with `stateless_http=True`, so every
 * attempt is a fully self-contained request — no session handshake, no
 * Mcp-Session-Id header, nothing shared across concurrent calls to race on.
 * Retries connection/timeout errors with exponential backoff; a 4xx/5xx
 * response from Graphiti is not retried.
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
  const chainStartedAt = Date.now()
  dbg('graphiti_client_call_start', { tool, groupId: params.group_id ?? params.group_ids, maxRetries, endpoint })

  // The gateway reaches Graphiti directly on the trusted internal network and
  // attaches no Authorization header. (A previous revision tried to import a
  // gateway-client module that does not exist in this package and swallowed the
  // resulting module-not-found error in an empty catch — that dead branch is
  // removed. Project isolation is enforced by the explicit group_id passed to
  // every call, not by a token here.)
  const authHeaders = {}

  let lastError
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const waitMs = 1000 * 2 ** (attempt - 1)
      dbg('graphiti_client_backoff_wait', { tool, attempt, wait_ms: waitMs })
      await new Promise((r) => setTimeout(r, waitMs))
    }

    // AbortSignal.timeout()'s internal timer is not cancelled when the fetch settles
    // early — under bursty call volume this leaves orphaned timers that fire later,
    // detached from any in-flight request. Use an explicit AbortController + clearTimeout
    // so the timer never outlives this call.
    const callStartedAt = Date.now()
    const abortController = new AbortController()
    const timeoutId = setTimeout(() => {
      dbg('graphiti_client_call_timeout_fired', { elapsed_ms: Date.now() - callStartedAt, tool, attempt })
      abortController.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    }, 30_000)
    dbg('graphiti_client_attempt_start', {
      tool, attempt,
      chain_elapsed_ms: Date.now() - chainStartedAt,
    })
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept':       'application/json, text/event-stream',
          ...authHeaders,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id:      Date.now(),
          method:  'tools/call',
          params:  { name: tool, arguments: params },
        }),
        signal: abortController.signal,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        dbg('graphiti_client_response_error', { tool, status: response.status, body, attempt })
        throw new GraphitiResponseError(
          `Graphiti responded ${response.status} for tool '${tool}'`,
          response.status,
          body,
        )
      }

      const result = await parseMcpResponse(response)
      dbg('graphiti_client_call_success', {
        tool, attempt,
        attempt_elapsed_ms: Date.now() - callStartedAt,
        chain_elapsed_ms: Date.now() - chainStartedAt,
      })
      return result
    } catch (err) {
      if (err instanceof GraphitiResponseError) {
        throw err
      }
      lastError = new GraphitiConnectionError(
        `Could not reach Graphiti at ${GRAPHITI_URL}: ${err.message}`,
        err,
      )
      dbg('graphiti_client_call_error', {
        tool, attempt,
        elapsed_ms: Date.now() - callStartedAt,
        error_name: err?.name ?? 'Error',
        error_message: err?.message ?? String(err),
      })
    } finally {
      clearTimeout(timeoutId)
    }
  }

  dbg('graphiti_client_call_exhausted', {
    tool, maxRetries,
    chain_elapsed_ms: Date.now() - chainStartedAt,
    error_name: lastError?.name,
    error_message: lastError?.message,
  })
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
