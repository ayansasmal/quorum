/**
 * Quorum Gateway — S3 config cache.
 *
 * The gateway is the only component with S3 access. It loads project configs
 * from S3, validates them, and serves them to authenticated clients via
 * GET /config/:projectId.
 *
 * Configs are cached in-process with a TTL to avoid S3 calls on every request.
 * The cache is invalidated when a new config is uploaded (checked via ETag).
 */

import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { QuorumConfigSchema } from '../config/schema.js'
import { getConfig as ddbGetConfig, putConfig as ddbPutConfig, syncProjectMembers as ddbSyncProjectMembers } from './ddb.js'

const TTL_MS = 5 * 60 * 1000 // 5 minutes

/** @type {Map<string, { config: object, etag: string | null, loadedAt: number }>} */
const cache = new Map()

let s3Client = null

/**
 * Lazy S3Client singleton honouring AWS_ENDPOINT_URL (LocalStack) and AWS_REGION.
 * @returns {S3Client}
 */
function getS3() {
  if (!s3Client) {
    const endpoint = process.env.AWS_ENDPOINT_URL
    s3Client = new S3Client({
      region:         process.env.AWS_REGION ?? 'us-east-1',
      endpoint:       endpoint || undefined,
      forcePathStyle: !!endpoint,
      credentials:    endpoint
        ? {
            accessKeyId:     process.env.AWS_ACCESS_KEY_ID     ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          }
        : undefined,
    })
  }
  return s3Client
}

/**
 * Load a project config from S3 (with in-process caching).
 * Falls back to QUORUM_CONFIG_PATH local file if the env var is set (dev mode).
 * @param {string} projectId
 * @returns {Promise<object>} Validated config object
 */
export async function loadProjectConfig(projectId) {
  const localPath = process.env.QUORUM_CONFIG_PATH
  if (localPath) {
    return loadLocalConfig(localPath)
  }

  const bucket = process.env.QUORUM_CONFIG_BUCKET
  if (!bucket) {
    throw new Error('QUORUM_CONFIG_BUCKET not set and QUORUM_CONFIG_PATH not set')
  }

  const key = `${projectId}/config.json`
  const cached = cache.get(projectId)
  const now = Date.now()

  // Return cached value if still fresh
  if (cached && now - cached.loadedAt < TTL_MS) {
    return cached.config
  }

  // DDB read-through (fast path) — skips S3 entirely on hit.
  // DDB is best-effort: on any error we fall through to S3 silently.
  try {
    const ddbConfig = await ddbGetConfig(projectId)
    if (ddbConfig) {
      const validated = QuorumConfigSchema.parse(ddbConfig)
      cache.set(projectId, { config: validated, etag: null, loadedAt: now })
      return validated
    }
  } catch {
    // Cache miss / validation failure — fall through to S3
  }

  // Check ETag for conditional refresh
  if (cached) {
    try {
      const head = await getS3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      if (head.ETag === cached.etag) {
        // ETag unchanged — extend cache without re-parsing
        cache.set(projectId, { ...cached, loadedAt: now })
        return cached.config
      }
    } catch {
      // HEAD failed — fall through to full GET
    }
  }

  // Full GET from S3
  const response = await getS3().send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const body = await response.Body.transformToString()
  const raw = JSON.parse(body)
  const config = QuorumConfigSchema.parse(raw)

  cache.set(projectId, {
    config,
    etag: response.ETag ?? null,
    loadedAt: now,
  })

  // DDB write-back — best-effort. Build member rows from config.members + role floors.
  try {
    const members = (config.members ?? []).map((m) => ({
      github_username: m.github_username,
      role:            m.role,
      team:            m.team,
      base_confidence: m.role && config.roles?.[m.role]
        ? config.roles[m.role].base_confidence
        : 0.5,
    })).filter((m) => m.github_username)

    await ddbPutConfig(projectId, config, response.ETag ?? null)
    // Use group_id (the S3 key prefix and JWT claim) as the canonical slug.
    // config.project is an optional display name — falls back to group_id when absent.
    await ddbSyncProjectMembers(projectId, config.project ?? config.group_id ?? projectId, config.group_id ?? projectId, members)
  } catch (err) {
    console.error(`[Gateway] DDB write-back failed for ${projectId}: ${err.message}`)
  }

  return config
}

/**
 * List all project IDs visible in the config bucket.
 * Used by GET /projects to show what projects exist.
 * Returns an empty array if the bucket is not configured.
 * @returns {Promise<string[]>}
 */
export async function listProjectIds() {
  const bucket = process.env.QUORUM_CONFIG_BUCKET
  if (!bucket) return []

  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3')
  const response = await getS3().send(new ListObjectsV2Command({
    Bucket: bucket,
    Delimiter: '/',
  }))

  return (response.CommonPrefixes ?? [])
    .map((p) => p.Prefix?.replace(/\/$/, ''))
    .filter(Boolean)
}

/**
 * Load config from a local file path (dev mode — skips S3).
 * @param {string} filePath
 * @returns {Promise<object>}
 */
async function loadLocalConfig(filePath) {
  const { readFile } = await import('node:fs/promises')
  const body = await readFile(filePath, 'utf8')
  const raw = JSON.parse(body)
  return QuorumConfigSchema.parse(raw)
}

/**
 * Invalidate the cache for a specific project (after config update).
 * @param {string} projectId
 */
export function invalidateProject(projectId) {
  cache.delete(projectId)
}

/**
 * Resolve a project by its SHA-256 token hash (used by projectMiddleware).
 *
 * Queries the projects table directly — token hashes are stored in the DB,
 * not in S3. Returns null if no matching active project is found.
 *
 * @param {string} tokenHash - SHA-256 hex of the raw X-Quorum-Token header
 * @param {import('pg').Pool} pool
 * @returns {Promise<object | null>} Project row or null
 */
export async function getProjectByTokenHash(tokenHash, pool) {
  const { rows } = await pool.query(
    `SELECT id, slug, name, members, domains, governance, config_version
     FROM projects
     WHERE token_hash = $1 AND status = 'active'
     LIMIT 1`,
    [tokenHash],
  )
  return rows[0] ?? null
}
