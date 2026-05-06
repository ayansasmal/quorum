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

const router = Router();

const GRAPHITI_URL = () => process.env.GRAPHITI_URL ?? 'http://graphiti:8000';

// POST /graphiti/*path  — all Graphiti MCP calls (express@5: named wildcard required)
router.post('/*path', verifyJwt, async (req, res) => {
  const suffix = req.params.path || 'mcp';
  const target = `${GRAPHITI_URL()}/${suffix}`;

  // group_id is owned by the S3 project config and carried in the JWT — callers never control it.
  // Unconditional overwrite prevents confused-deputy attacks where a caller supplies their own value.
  const body = { ...(req.body ?? {}), params: { ...(req.body?.params ?? {}) } };
  body.params.group_id = req.user.project;
  if (body.params.group_ids !== undefined) body.params.group_ids = [req.user.project];

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
