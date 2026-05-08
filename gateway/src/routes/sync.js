/**
 * Quorum Gateway — S3 → DynamoDB sync route.
 *
 * POST /sync/configs
 *   Reload every project config from S3 and replicate it into DynamoDB.
 *   Drives both the config cache (quorum-configs) and the membership index
 *   (quorum-user-projects).
 *
 *   Auth (either is sufficient):
 *     - X-Quorum-Sync-Token header == process.env.QUORUM_SYNC_SECRET (EventBridge)
 *     - Authorization: Bearer <JWT> with role === 'principal_architect' (manual)
 *
 *   Idempotent — safe to call repeatedly. No hard deletes; only adds/updates.
 *
 *   Response: { synced: n, failed: [{project_id, error}], duration_ms: n }
 */

import { Router } from 'express'
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { QuorumConfigSchema } from '../shared/config/schema.js'
import { putConfig, syncProjectMembers } from '../ddb.js'
import { verifyJwt } from '../middleware/verify-jwt.js'

const router = Router()

const SYNC_CONCURRENCY = 5

let s3Client = null

/**
 * Lazy S3Client honouring AWS_ENDPOINT_URL (LocalStack) and AWS_REGION.
 * Mirrors the client construction pattern from config-cache.js / health probe.
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
 * Authorise a sync request. Accepts either a sync-token header or a JWT
 * with the principal_architect role. Sync token wins when both are present.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function authSync(req) {
  const syncSecret = process.env.QUORUM_SYNC_SECRET
  if (syncSecret && req.headers['x-quorum-sync-token'] === syncSecret) return true
  if (req.user?.role === 'principal_architect') return true
  return false
}

/**
 * Process an array in fixed-size concurrent batches, gathering all results.
 * @template T, R
 * @param {T[]} items
 * @param {number} size
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function inBatches(items, size, fn) {
  const results = []
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size)
    const batch = await Promise.all(slice.map(fn))
    results.push(...batch)
  }
  return results
}

/**
 * Sync a single project's config + membership from S3 to DDB.
 * @param {string} bucket
 * @param {string} projectId
 * @returns {Promise<{ project_id: string, ok: true } | { project_id: string, ok: false, error: string }>}
 */
async function syncOneProject(bucket, projectId) {
  try {
    const obj = await getS3().send(new GetObjectCommand({
      Bucket: bucket,
      Key:    `${projectId}.quorum.json`,
    }))
    const body = await obj.Body.transformToString()
    const raw  = JSON.parse(body)
    const config = QuorumConfigSchema.parse(raw)

    const members = (config.members ?? []).map((m) => ({
      github_username: m.github_username,
      role:            m.role,
      team:            m.team,
      base_confidence: m.role && config.roles?.[m.role]
        ? config.roles[m.role].base_confidence
        : 0.5,
    })).filter((m) => m.github_username)

    await putConfig(projectId, config, obj.ETag ?? null)
    // group_id is the canonical slug (S3 key prefix, JWT claim).
    // config.project is an optional display name — falls back to group_id when absent.
    await syncProjectMembers(projectId, config.project ?? config.group_id ?? projectId, config.group_id ?? projectId, members)

    return { project_id: projectId, ok: true }
  } catch (err) {
    return { project_id: projectId, ok: false, error: err.message }
  }
}

// ── Middleware: verify JWT only if no sync token header ─────────────────────────
//
// EventBridge sends X-Quorum-Sync-Token without a Bearer JWT. We must NOT 401
// those requests at the JWT step. Manual callers supply Bearer JWT and reach
// authSync() with req.user populated.
router.use((req, res, next) => {
  if (req.headers['x-quorum-sync-token']) return next()
  return verifyJwt(req, res, next)
})

/**
 * Sync all project configs from S3 to DynamoDB.
 * Exported so startup() can call it directly without going through HTTP.
 * Non-fatal — logs errors but never throws.
 * @returns {Promise<{ synced: number, failed: Array<{project_id: string, error: string}>, duration_ms: number }>}
 */
export async function syncAllConfigs() {
  const bucket = process.env.QUORUM_CONFIG_BUCKET
  if (!bucket) {
    console.error('[Gateway] syncAllConfigs: QUORUM_CONFIG_BUCKET not set — skipping')
    return { synced: 0, failed: [], duration_ms: 0 }
  }

  const startedAt = Date.now()

  // 1. List all <group_id>.quorum.json keys (flat bucket — no subdirectories)
  let projectIds = []
  try {
    let token
    do {
      const result = await getS3().send(new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: token,
      }))
      for (const obj of result.Contents ?? []) {
        const m = obj.Key?.match(/^([^/]+)\.quorum\.json$/)
        if (m) projectIds.push(m[1])
      }
      token = result.IsTruncated ? result.NextContinuationToken : undefined
    } while (token)
  } catch (err) {
    console.error(`[Gateway] syncAllConfigs: S3 list failed — ${err.message}`)
    return { synced: 0, failed: [], duration_ms: Date.now() - startedAt }
  }

  // 2. Sync each project (concurrency 5)
  const results = await inBatches(projectIds, SYNC_CONCURRENCY, (id) => syncOneProject(bucket, id))

  const failed = results.filter((r) => !r.ok).map((r) => ({ project_id: r.project_id, error: r.error }))
  const synced = results.length - failed.length

  return { synced, failed, duration_ms: Date.now() - startedAt }
}

// POST /sync/configs
router.post('/configs', async (req, res) => {
  if (!authSync(req)) {
    return res.status(403).json({
      error:   'forbidden',
      message: 'Sync requires X-Quorum-Sync-Token or principal_architect JWT',
    })
  }

  if (!process.env.QUORUM_CONFIG_BUCKET) {
    return res.status(500).json({
      error:   'config_error',
      message: 'QUORUM_CONFIG_BUCKET not set',
    })
  }

  const result = await syncAllConfigs()

  res.json(result)
})

export default router
