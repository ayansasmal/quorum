/**
 * Quorum config loader.
 *
 * Resolution order (first match wins):
 *   1. QUORUM_CONFIG_PATH  — local file path (dev override; never used in production)
 *   2. S3                  — s3://${QUORUM_CONFIG_BUCKET}/${QUORUM_PROJECT_ID}/config.json
 *   3. DB snapshot         — last known-good snapshot from governance_config table (S3 fallback)
 *   4. Env-var defaults    — bare minimum from QUORUM_* env vars (no member registry)
 *
 * Once loaded, config is cached as module state and polled for changes
 * every QUORUM_CONFIG_POLL_INTERVAL seconds (0 = load once, no polling).
 */

import { readFileSync } from 'node:fs'
import { QuorumConfigSchema } from './schema.js'

// ── Module-level cache ────────────────────────────────────────────────────────

/** @type {import('./schema.js').QuorumConfig | null} */
let _config = null

/** @type {string | null} Last S3 ETag seen — skip re-parse if unchanged. */
let _lastETag = null

/** @type {ReturnType<typeof setInterval> | null} */
let _pollTimer = null

// ── S3 loader (optional — only if @aws-sdk/client-s3 is installed) ────────────

/**
 * Attempt to load config from S3. Returns null if S3 is not configured or unavailable.
 * Uses dynamic import so the server still starts without @aws-sdk/client-s3 installed.
 * @param {string} bucket
 * @param {string} projectId
 * @param {string | null} [ifNoneMatch] - ETag for conditional GET (skip if unchanged)
 * @returns {Promise<{ config: import('./schema.js').QuorumConfig, etag: string } | null | 'not_modified'>}
 */
async function loadFromS3(bucket, projectId, ifNoneMatch = null) {
  let S3Client, GetObjectCommand
  try {
    const mod = await import('@aws-sdk/client-s3')
    S3Client = mod.S3Client
    GetObjectCommand = mod.GetObjectCommand
  } catch {
    console.error('[Quorum:config] @aws-sdk/client-s3 not installed — S3 config unavailable')
    return null
  }

  try {
    const client = new S3Client({
      region: process.env.AWS_REGION ?? 'ap-southeast-2',
    })

    const params = {
      Bucket: bucket,
      Key: `${projectId}/config.json`,
    }
    if (ifNoneMatch) params.IfNoneMatch = ifNoneMatch

    const response = await client.send(new GetObjectCommand(params))
    const body = await response.Body.transformToString('utf8')
    const raw = JSON.parse(body)
    const config = QuorumConfigSchema.parse(raw)

    const etag = response.ETag ?? null
    console.error(`[Quorum:config] Loaded from S3 s3://${bucket}/${projectId}/config.json (ETag: ${etag})`)
    return { config, etag }
  } catch (err) {
    if (err.name === 'NotModifiedException') return 'not_modified'
    console.error(`[Quorum:config] S3 load failed: ${err.message}`)
    return null
  }
}

/**
 * Load config from a local file path.
 * @param {string} filePath
 * @returns {import('./schema.js').QuorumConfig | null}
 */
function loadFromFile(filePath) {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    const config = QuorumConfigSchema.parse(raw)
    console.error(`[Quorum:config] Loaded from local file: ${filePath}`)
    return config
  } catch (err) {
    console.error(`[Quorum:config] Local file load failed (${filePath}): ${err.message}`)
    return null
  }
}

/**
 * Load last known-good config snapshot from PostgreSQL.
 * Falls back to this when S3 is unreachable.
 * @param {import('pg').Pool} pg
 * @returns {Promise<import('./schema.js').QuorumConfig | null>}
 */
async function loadFromDB(pg) {
  if (!pg) return null
  try {
    const result = await pg.query(
      `SELECT config_json FROM governance_config ORDER BY loaded_at DESC LIMIT 1`,
    )
    if (!result.rows[0]) return null
    const config = QuorumConfigSchema.parse(result.rows[0].config_json)
    console.error('[Quorum:config] Loaded from DB snapshot (S3 unavailable)')
    return config
  } catch {
    return null
  }
}

/**
 * Build a minimal config from environment variables alone.
 * Used when no config file or S3 bucket is configured.
 * @returns {import('./schema.js').QuorumConfig}
 */
function buildEnvFallback() {
  console.error('[Quorum:config] WARNING: No config source found — using env var defaults. No member registry.')
  return QuorumConfigSchema.parse({
    project: process.env.QUORUM_PROJECT_ID ?? 'default',
    group_id: process.env.QUORUM_GROUP_ID ?? 'default',
    members: [],
    roles: {},
    domains: {},
    thresholds: {
      conflict_threshold: parseFloat(process.env.QUORUM_CONFLICT_THRESHOLD ?? '0.85'),
      authority_threshold: parseFloat(process.env.QUORUM_AUTHORITY_THRESHOLD ?? '0.20'),
    },
  })
}

/**
 * Persist a config snapshot to PostgreSQL for fallback use.
 * Append-only: never updates or deletes rows.
 * @param {import('pg').Pool} pg
 * @param {import('./schema.js').QuorumConfig} config
 * @param {string} source - 's3' | 'file' | 'db' | 'env'
 * @param {string | null} [etag]
 */
async function snapshotToDB(pg, config, source, etag = null) {
  if (!pg) return
  try {
    await pg.query(
      `INSERT INTO governance_config (config_json, source, s3_etag, loaded_at)
       VALUES ($1, $2, $3, NOW())`,
      [JSON.stringify(config), source, etag],
    )
  } catch (err) {
    console.error(`[Quorum:config] Failed to snapshot config to DB: ${err.message}`)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load and cache the Quorum config. Must be called once at startup.
 *
 * @param {import('pg').Pool | null} pg - PostgreSQL pool (for DB snapshot fallback)
 * @returns {Promise<import('./schema.js').QuorumConfig>}
 */
export async function loadConfig(pg = null) {
  const localPath = process.env.QUORUM_CONFIG_PATH
  const bucket = process.env.QUORUM_CONFIG_BUCKET
  const projectId = process.env.QUORUM_PROJECT_ID ?? process.env.QUORUM_GROUP_ID ?? 'default'
  const pollInterval = parseInt(process.env.QUORUM_CONFIG_POLL_INTERVAL ?? '300', 10)

  let config = null
  let source = 'env'
  let etag = null

  if (localPath) {
    config = loadFromFile(localPath)
    source = 'file'
  } else if (bucket) {
    const s3Result = await loadFromS3(bucket, projectId)
    if (s3Result && s3Result !== 'not_modified') {
      config = s3Result.config
      etag = s3Result.etag
      source = 's3'
    } else if (!s3Result) {
      config = await loadFromDB(pg)
      source = 'db'
    }
  }

  if (!config) {
    config = buildEnvFallback()
    source = 'env'
  }

  _config = config
  _lastETag = etag

  await snapshotToDB(pg, config, source, etag)

  // Start polling for live updates (S3 only — not for local file or env fallback)
  if (bucket && pollInterval > 0 && !localPath) {
    _pollTimer = setInterval(() => pollConfig(pg, bucket, projectId), pollInterval * 1000)
    _pollTimer.unref() // don't keep the process alive just for polling
    console.error(`[Quorum:config] Polling S3 config every ${pollInterval}s`)
  }

  return _config
}

/**
 * Poll S3 for config changes. Skips re-parse if ETag unchanged.
 * Called by the interval timer started in loadConfig().
 * @param {import('pg').Pool | null} pg
 * @param {string} bucket
 * @param {string} projectId
 */
async function pollConfig(pg, bucket, projectId) {
  const result = await loadFromS3(bucket, projectId, _lastETag)
  if (!result || result === 'not_modified') return

  _config = result.config
  _lastETag = result.etag
  console.error('[Quorum:config] Config reloaded from S3 (changed)')
  await snapshotToDB(pg, result.config, 's3', result.etag)
}

/**
 * Get the currently loaded config.
 * Throws if loadConfig() has not been called yet.
 * @returns {import('./schema.js').QuorumConfig}
 */
export function getConfig() {
  if (!_config) throw new Error('[Quorum:config] Config not loaded — call loadConfig() at startup')
  return _config
}

/**
 * Stop the config polling timer. Call on graceful shutdown.
 */
export function stopConfigPoller() {
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
}
