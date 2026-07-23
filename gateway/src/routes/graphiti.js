/**
 * Quorum Gateway — Graphiti proxy route.
 *
 * POST /graphiti/*path
 *   JWT-authenticated transparent proxy to the central Graphiti sidecar.
 *   group_id is owned by the S3 project config and embedded in the JWT at issue
 *   time. Caller-supplied group_ids are honored only when they fall entirely
 *   within the authorized set (project + its linked globals, from S3 config) —
 *   anything outside that set is dropped, never granted. An unscoped read call
 *   gets the full authorized set; this lets per-catalog attribution calls stay
 *   scoped to one catalog instead of always fanning out to every linked global.
 *
 *   Engineers never need the Graphiti URL or credentials — only the gateway URL.
 *
 * The proxy preserves the original path suffix, so:
 *   POST /graphiti/mcp  →  POST {GRAPHITI_URL}/mcp
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { verifyJwt } from '../middleware/verify-jwt.js';
import { loadProjectConfig } from '../config-cache.js';

const router = Router();

const GRAPHITI_URL = () => process.env.GRAPHITI_URL ?? 'http://graphiti:8000';
const DEBUG = process.env.LOG_LEVEL === 'debug';

/**
 * Emit a structured DEBUG-only log line for the gateway→Graphiti hop.
 * No-op unless LOG_LEVEL=debug — never active in production by default.
 * @param {string} traceId - correlation ID shared with quorum-mcp and graphiti
 * @param {string} stage - checkpoint name (e.g. 'graphiti_proxy_entry')
 * @param {object} data - extra structured fields merged into the log line
 * @returns {void}
 */
function dbg(traceId, stage, data) {
  if (DEBUG) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      trace_id: traceId,
      stage,
      ...data,
    }));
  }
}

// POST /graphiti/*path  — all Graphiti MCP calls (express@5: named wildcard required)
router.post('/*path', verifyJwt, async (req, res) => {
  const startedAt = Date.now();
  const suffix = req.params.path || 'mcp';
  const target = `${GRAPHITI_URL()}/${suffix}`;
  const entryToolName = req.body?.params?.name ?? '';
  const requestedGroupIdsRaw = req.body?.params?.arguments?.group_ids
    ?? req.body?.params?.group_ids
    ?? [];
  const inboundTraceId = req.headers['x-quorum-trace-id'];
  const traceId = Array.isArray(inboundTraceId)
    ? (inboundTraceId[0] ?? randomUUID())
    : (inboundTraceId ?? randomUUID());
  res.set('X-Quorum-Trace-Id', traceId);

  dbg(traceId, 'graphiti_proxy_entry', {
    tool: entryToolName,
    project: req.user.project ?? null,
    requested_group_ids: requestedGroupIdsRaw,
  });

  if (!req.user.project) {
    return res.status(400).json({ error: 'X-Quorum-Project header required' })
  }

  // group_id is owned by the S3 project config and carried in the JWT — callers never control it.
  // Unconditional overwrite prevents confused-deputy attacks where a caller supplies their own value.
  //
  // sanitizeGroupId: FalkorDB uses group_id as a database/graph name. Graphiti's internal
  // RediSearch queries embed the database name in tag filters — hyphens are NOT operators in
  // RediSearch, causing syntax errors for any project with a hyphenated group_id. Replace
  // hyphens with underscores so the graph name is safe. PostgreSQL project_id is never modified.
  const sanitizedProject = req.user.project.replace(/-/g, '_');

  // Wave B: load linked global catalogs for cross-catalog read injection.
  // Uses the raw project ID for S3/Redis config lookup (configs stored with original hyphens).
  // Falls back to empty globals if config is unavailable — call proceeds project-scoped only.
  const projectConfig = await loadProjectConfig(req.user.project).catch(() => null)
  dbg(traceId, 'graphiti_proxy_config_loaded', {
    elapsed_ms: Date.now() - startedAt,
    has_project_config: projectConfig !== null,
    globals_count: projectConfig?.globals?.length ?? 0,
  });
  const sanitizedGlobals = (projectConfig?.globals ?? []).map((id) => id.replace(/-/g, '_'))

  // Detect read vs write MCP tool calls by inspecting params.name.
  // Read ops (search_nodes, search_memory_facts): scope to whatever the caller asked for,
  // as long as it's inside the authorized set (project + its linked globals) — this preserves
  // per-catalog attribution calls (quorum-mcp/src/tools/search.js fires one search_nodes per
  // linked catalog so results can be tagged with the correct catalog_id). An unscoped call
  // (no group_ids on the request) still gets the full federated set, matching prior behavior.
  // Write ops (add_memory, etc.): restrict to the project group_id — cross-catalog writes are never allowed.
  const READ_TOOLS = new Set(['search_nodes', 'search_memory_facts'])
  const toolName = req.body?.params?.name ?? ''
  const isReadOp = READ_TOOLS.has(toolName)

  const authorizedGroupIds = new Set([sanitizedProject, ...sanitizedGlobals])
  const requestedGroupIds = (
    req.body?.params?.arguments?.group_ids ?? req.body?.params?.group_ids ?? []
  ).map((id) => String(id).replace(/-/g, '_')).filter((id) => authorizedGroupIds.has(id))

  // Confused-deputy guard: only ever narrow to a caller-supplied subset that is fully inside
  // the authorized set (never expand it). Anything requested outside that set is silently
  // dropped by the .filter() above rather than granting access to it.
  const injectedGroupIds = isReadOp
    ? (requestedGroupIds.length > 0 ? requestedGroupIds : [sanitizedProject, ...sanitizedGlobals])
    : [sanitizedProject]

  // Deep-copy params.arguments: MCP protocol nests tool arguments inside body.params.arguments,
  // not at body.params level. The previous group_id override never reached Graphiti's tool
  // arguments (it was setting body.params.group_id, not body.params.arguments.group_id).
  // Override at both levels: params level for backward compat; arguments level for MCP protocol.
  const body = {
    ...(req.body ?? {}),
    params: {
      ...(req.body?.params ?? {}),
      arguments: { ...(req.body?.params?.arguments ?? {}) },
    },
  }

  body.params.group_id = sanitizedProject
  body.params.arguments.group_id = sanitizedProject
  body.params.group_ids = injectedGroupIds
  body.params.arguments.group_ids = injectedGroupIds

  // Write ops on a global catalog migrated to a shared physical database (see
  // migrated_to_shared_graph in QuorumConfigSchema): override which physical FalkorDB
  // database the write lands in, independent of group_id. Uses the `database` param
  // added to graphiti_core.Graphiti.add_episode (quorum-graphiti Task 1, commit
  // 27d320c) and threaded through add_memory (quorum-graphiti Task 2, commit bcebf6a).
  // Read ops are unaffected — global catalogs are still read via group_ids scoping
  // regardless of physical database placement.
  if (!isReadOp && projectConfig?.migrated_to_shared_graph === true) {
    const sharedDatabase = process.env.QUORUM_SHARED_GRAPH_DATABASE ?? 'quorum_shared_globals'
    body.params.database = sharedDatabase
    body.params.arguments.database = sharedDatabase
  }

  // Forward MCP protocol headers from the caller to Graphiti.
  // Accept is required: Graphiti's streamable-http transport returns 406 without it.
  // Mcp-Session-Id is required for session reuse on all calls after initialize.
  const upstreamHeaders = {
    'Content-Type': 'application/json',
    'Accept': req.headers['accept'] ?? 'application/json, text/event-stream',
    'X-Quorum-Trace-Id': traceId,
  }
  const sessionId = req.headers['mcp-session-id']
  if (sessionId) upstreamHeaders['Mcp-Session-Id'] = sessionId

  let response;
  const fetchStartedAt = Date.now();
  dbg(traceId, 'graphiti_proxy_fetch_start', {
    elapsed_ms: fetchStartedAt - startedAt,
    target,
    tool: entryToolName,
  });
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(100_000),
    });
    dbg(traceId, 'graphiti_proxy_fetch_complete', {
      fetch_ms: Date.now() - fetchStartedAt,
      total_ms: Date.now() - startedAt,
      status: response.status,
      ok: response.ok,
    });
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    dbg(traceId, 'graphiti_proxy_fetch_error', {
      fetch_ms: Date.now() - fetchStartedAt,
      total_ms: Date.now() - startedAt,
      error_type: isTimeout ? 'timeout' : 'network_error',
      error_name: err?.name ?? 'Error',
      error_message: err?.message ?? String(err),
    });
    return res.status(502).json({
      error: 'graphiti_unavailable',
      message: `Cannot reach Graphiti at ${GRAPHITI_URL()}: ${err.message}`,
    });
  }

  const contentType =
    response.headers.get('content-type') ?? 'application/json';
  const data = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  // Forward MCP session ID from Graphiti back to the caller so it can reuse the session.
  const returnedSessionId = response.headers.get('mcp-session-id')
  if (returnedSessionId) res.set('Mcp-Session-Id', returnedSessionId)

  res.status(response.status).set('Content-Type', contentType).json(data);
});

export default router;
