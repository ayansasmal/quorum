/**
 * Quorum Gateway — S3 config cache and user profile cache.
 *
 * Config cache (Redis → S3):
 *   key: config:{group_id}   TTL: QUORUM_CONFIG_CACHE_TTL (default 300s)
 *
 * Profile cache (Redis → DDB quorum-user-projects):
 *   key: profile:{username}  TTL: QUORUM_PROFILE_CACHE_TTL (default 300s)
 *
 * Admin config cache (Redis → S3 configs/.quorum):
 *   key: admin:platform      TTL: QUORUM_ADMIN_CACHE_TTL (default 300s)
 *
 * All three caches use write-through invalidation + pub/sub for multi-instance consistency.
 */

import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { QuorumConfigSchema } from './shared/config/schema.js'
import { getUserProjects, getUserProjectsStrict } from './ddb.js'
import { getRedis } from './redis.js'

const CONFIG_TTL  = Number(process.env.QUORUM_CONFIG_CACHE_TTL  ?? 300)
const PROFILE_TTL = Number(process.env.QUORUM_PROFILE_CACHE_TTL ?? 300)
const ADMIN_TTL   = Number(process.env.QUORUM_ADMIN_CACHE_TTL   ?? 300)

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

// ── Config cache ──────────────────────────────────────────────────────────────

/**
 * Load a project config from Redis (hot path) or S3 (cold path).
 * Falls back to QUORUM_CONFIG_PATH local file if set (dev mode).
 * @param {string} projectId
 * @returns {Promise<object>} Validated config object
 */
export async function loadProjectConfig(projectId) {
  if (process.env.QUORUM_CONFIG_PATH) {
    return loadLocalConfig(process.env.QUORUM_CONFIG_PATH)
  }

  const bucket = process.env.QUORUM_CONFIG_BUCKET
  if (!bucket) throw new Error('QUORUM_CONFIG_BUCKET not set and QUORUM_CONFIG_PATH not set')

  const redis    = getRedis()
  const cacheKey = `config:${projectId}`

  // Redis hit
  const cached = await redis.get(cacheKey)
  if (cached) {
    try { return QuorumConfigSchema.parse(JSON.parse(cached)) } catch { /* fall through */ }
  }

  // S3 full GET
  const s3Key   = `${projectId}.quorum.json`
  const response = await getS3().send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }))
  const body     = await response.Body.transformToString()
  const config   = QuorumConfigSchema.parse(JSON.parse(body))

  await redis.set(cacheKey, JSON.stringify(config), 'EX', CONFIG_TTL)

  return config
}

/**
 * Write a project config back to S3 and invalidate the Redis cache.
 * @param {string} projectId
 * @param {object} config  Validated config object
 */
export async function saveProjectConfig(projectId, config) {
  const bucket = process.env.QUORUM_CONFIG_BUCKET
  if (!bucket) throw new Error('QUORUM_CONFIG_BUCKET not set')

  const s3Key = `${projectId}.quorum.json`
  await getS3().send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         s3Key,
    Body:        JSON.stringify(config, null, 2),
    ContentType: 'application/json',
  }))

  await invalidateProject(projectId)
}

/**
 * List all project IDs visible in the config bucket.
 * @returns {Promise<string[]>}
 */
export async function listProjectIds() {
  const bucket = process.env.QUORUM_CONFIG_BUCKET
  if (!bucket) return []

  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3')
  const ids = []
  let token
  do {
    const response = await getS3().send(new ListObjectsV2Command({
      Bucket:            bucket,
      ContinuationToken: token,
    }))
    for (const obj of response.Contents ?? []) {
      const m = obj.Key?.match(/^([^/]+)\.quorum\.json$/)
      if (m) ids.push(m[1])
    }
    token = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (token)

  return ids
}

/**
 * Invalidate the config cache for a project.
 * @param {string} projectId
 */
export async function invalidateProject(projectId) {
  const redis    = getRedis()
  const cacheKey = `config:${projectId}`
  await redis.del(cacheKey)
  await redis.publish('quorum:invalidate', cacheKey)
}

/**
 * Load config from a local file path (dev mode — skips S3 and Redis).
 * @param {string} filePath
 * @returns {Promise<object>}
 */
async function loadLocalConfig(filePath) {
  const { readFile } = await import('node:fs/promises')
  const body = await readFile(filePath, 'utf8')
  return QuorumConfigSchema.parse(JSON.parse(body))
}

/**
 * Resolve a project by its SHA-256 token hash (used by projectMiddleware).
 * @param {string} tokenHash
 * @param {import('pg').Pool} pool
 * @returns {Promise<object | null>}
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

// ── Profile cache ─────────────────────────────────────────────────────────────

/**
 * Load a user profile from Redis (hot path) or DDB quorum-user-projects (cold path).
 *
 * Profile shape:
 * {
 *   github_username: string,
 *   projects: Array<{ group_id, role, base_confidence, is_owner, team }>
 * }
 *
 * @param {string} username  GitHub username
 * @returns {Promise<object>} User profile (always returns a valid shape; empty projects on miss)
 */
export async function loadUserProfile(username) {
  const redis    = getRedis()
  const cacheKey = `profile:${username}`

  const buildProfile = (rows) => ({
    github_username: username,
    projects: rows.map((r) => ({
      group_id:       r.project_id,
      role:           r.role            ?? null,
      base_confidence: r.base_confidence ?? 0.5,
      is_owner:       r.is_owner        ?? false,
      team:           r.team            ?? null,
    })),
  })

  const cached = await redis.get(cacheKey)

  if (cached) {
    // Hot path with stale-while-revalidate: try a fresh DDB read; if it fails,
    // prefer the stale cached entry over caching an empty (and thus role-less)
    // profile. See Gap 7.
    try {
      const rows    = await getUserProjectsStrict(username)
      const profile = buildProfile(rows)
      await redis.set(cacheKey, JSON.stringify(profile), 'EX', PROFILE_TTL)
      return profile
    } catch (err) {
      console.warn(`[Gateway] loadUserProfile(${username}): DDB failed, serving stale cache: ${err.message}`)
      try { return JSON.parse(cached) } catch { /* fall through to cold path */ }
    }
  }

  // Cold path — no cache to fall back on. getUserProjects returns [] on error
  // and emits its own warn log; that empty result is cached only briefly via
  // PROFILE_TTL and a subsequent successful read will overwrite it.
  const rows    = await getUserProjects(username)
  const profile = buildProfile(rows)
  await redis.set(cacheKey, JSON.stringify(profile), 'EX', PROFILE_TTL)
  return profile
}

/**
 * Invalidate the profile cache for a user.
 * @param {string} username
 */
export async function invalidateProfile(username) {
  const redis    = getRedis()
  const cacheKey = `profile:${username}`
  await redis.del(cacheKey)
  await redis.publish('quorum:invalidate', cacheKey)
}

// ── Admin config cache ────────────────────────────────────────────────────────

const ADMIN_S3_KEY = 'configs/.quorum'

/**
 * Load the platform admin config from Redis or S3.
 * @returns {Promise<object | null>} Admin config or null if not yet seeded
 */
export async function loadAdminConfig() {
  const bucket = process.env.QUORUM_CONFIG_BUCKET
  if (!bucket) return null

  const redis    = getRedis()
  const cacheKey = 'admin:platform'

  // Redis hit
  const cached = await redis.get(cacheKey)
  if (cached) {
    try { return JSON.parse(cached) } catch { /* fall through */ }
  }

  // S3 cold path
  try {
    const response = await getS3().send(new GetObjectCommand({ Bucket: bucket, Key: ADMIN_S3_KEY }))
    const body     = await response.Body.transformToString()
    const config   = JSON.parse(body)
    await redis.set(cacheKey, JSON.stringify(config), 'EX', ADMIN_TTL)
    return config
  } catch (err) {
    if (err.name === 'NoSuchKey') return null
    console.error(`[Gateway] loadAdminConfig failed: ${err.message}`)
    return null
  }
}

/**
 * Save the platform admin config to S3 and invalidate Redis.
 * @param {object} config
 */
export async function saveAdminConfig(config) {
  const bucket = process.env.QUORUM_CONFIG_BUCKET
  if (!bucket) throw new Error('QUORUM_CONFIG_BUCKET not set')

  await getS3().send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         ADMIN_S3_KEY,
    Body:        JSON.stringify(config, null, 2),
    ContentType: 'application/json',
  }))

  const redis = getRedis()
  await redis.del('admin:platform')
  await redis.publish('quorum:invalidate', 'admin:platform')
}

/**
 * Check if a GitHub username is a platform admin.
 * @param {string} username
 * @returns {Promise<boolean>}
 */
export async function isPlatformAdmin(username) {
  const config = await loadAdminConfig()
  if (!config?.admins) return false
  return config.admins.some((a) => a.github_username === username)
}
