/**
 * Quorum Gateway — JSON Schema endpoint.
 *
 * GET /schema/config
 *   Returns the canonical quorum.config.schema.json as JSON.
 *   No authentication required — the schema is public documentation.
 *
 *   Use this URL as the $schema value in any Quorum config file so that
 *   editors (VS Code, IntelliJ, etc.) can fetch it for inline validation
 *   and autocomplete without needing a local copy:
 *
 *     { "$schema": "http://localhost:3001/schema/config", "group_id": "my-project", ... }
 *
 *   In production, replace localhost:3001 with your gateway's public URL.
 *
 *   Response headers:
 *     Content-Type: application/schema+json (RFC 8927)
 *     Cache-Control: public, max-age=3600 (schema changes are infrequent)
 */

import { Router }   from 'express'
import { readFile } from 'node:fs/promises'
import { resolve }  from 'node:path'
import { fileURLToPath } from 'node:url'

const router = Router()

/** Absolute path to the schema file — lives in src/config/ alongside the Zod schema. */
const SCHEMA_PATH = resolve(
  fileURLToPath(import.meta.url),
  '../../../config/quorum.schema.json',
)

/** Cached schema object — loaded once on first request. */
let schemaCache = null

/**
 * Load and cache the schema from disk.
 * @returns {Promise<object>}
 */
async function loadSchema() {
  if (!schemaCache) {
    const raw = await readFile(SCHEMA_PATH, 'utf8')
    schemaCache = JSON.parse(raw)
  }
  return schemaCache
}

/**
 * GET /schema/config
 * Returns the quorum.config.schema.json for editor validation and autocomplete.
 * Public endpoint — no authentication required.
 */
router.get('/config', async (_req, res) => {
  try {
    const schema = await loadSchema()
    res
      .setHeader('Content-Type', 'application/schema+json')
      .setHeader('Cache-Control', 'public, max-age=3600')
      .json(schema)
  } catch (err) {
    res.status(500).json({
      error:   'schema_load_failed',
      message: `Could not load config schema: ${err.message}`,
    })
  }
})

export default router
