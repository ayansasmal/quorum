/**
 * Quorum Gateway — Graphiti proxy route.
 *
 * POST /graphiti/*path
 *   JWT-authenticated transparent proxy to the central Graphiti sidecar.
 *   group_id is owned by the S3 project config and embedded in the JWT at issue
 *   time. Caller-supplied values are always discarded — the gateway enforces the
 *   S3-defined project boundary unconditionally before proxying to Graphiti.
 *
 *   Engineers never need the Graphiti URL or credentials — only the gateway URL.
 *
 * The proxy preserves the original path suffix, so:
 *   POST /graphiti/mcp  →  POST {GRAPHITI_URL}/mcp
 */

import { Router } from 'express';
import { verifyJwt } from '../middleware/verify-jwt.js';
import { loadProjectConfig } from '../config-cache.js';

const router = Router();

const GRAPHITI_URL = () => process.env.GRAPHITI_URL ?? 'http://graphiti:8000';

// POST /graphiti/*path  — all Graphiti MCP calls (express@5: named wildcard required)
router.post('/*path', verifyJwt, async (req, res) => {
  const suffix = req.params.path || 'mcp';
  const target = `${GRAPHITI_URL()}/${suffix}`;

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
  const sanitizedGlobals = (projectConfig?.globals ?? []).map((id) => id.replace(/-/g, '_'))

  // Detect read vs write MCP tool calls by inspecting params.name.
  // Read ops (search_nodes, search_memory_facts): inject all linked catalog group_ids.
  // Write ops (add_memory, etc.): restrict to the project group_id — cross-catalog writes are never allowed.
  const READ_TOOLS = new Set(['search_nodes', 'search_memory_facts'])
  const toolName = req.body?.params?.name ?? ''
  const isReadOp = READ_TOOLS.has(toolName)
  const injectedGroupIds = isReadOp
    ? [sanitizedProject, ...sanitizedGlobals]
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

  // Forward MCP protocol headers from the caller to Graphiti.
  // Accept is required: Graphiti's streamable-http transport returns 406 without it.
  // Mcp-Session-Id is required for session reuse on all calls after initialize.
  const upstreamHeaders = {
    'Content-Type': 'application/json',
    'Accept': req.headers['accept'] ?? 'application/json, text/event-stream',
  }
  const sessionId = req.headers['mcp-session-id']
  if (sessionId) upstreamHeaders['Mcp-Session-Id'] = sessionId

  let response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
  } catch (err) {
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
