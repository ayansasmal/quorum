/**
 * Quorum Gateway — Graphiti proxy route.
 *
 * POST /graphiti/*path
 *   JWT-authenticated transparent proxy to the central Graphiti sidecar.
 *   Injects the project claim from the JWT into the request body as group_id
 *   so Graphiti namespaces all operations to the engineer's project.
 *
 *   Engineers never need the Graphiti URL or credentials — only the gateway URL.
 *
 * The proxy preserves the original path suffix, so:
 *   POST /graphiti/mcp  →  POST {GRAPHITI_URL}/mcp
 */

import { Router } from 'express';
import { verifyJwt } from '../middleware/verify-jwt.js';

const router = Router();

const GRAPHITI_URL = () => process.env.GRAPHITI_URL ?? 'http://graphiti:8000';

// POST /graphiti/*path  — all Graphiti MCP calls (express@5: named wildcard required)
router.post('/*path', verifyJwt, async (req, res) => {
  const suffix = req.params.path || 'mcp';
  const target = `${GRAPHITI_URL()}/${suffix}`;

  // Inject project as group_id so Graphiti namespaces to this project
  const body = { ...(req.body ?? {}), params: { ...(req.body?.params ?? {}) } };
  if (!body.params.group_id) {
    body.params.group_id = req.user.project;
  }

  let response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  res.status(response.status).set('Content-Type', contentType).json(data);
});

export default router;
