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
import crypto from 'node:crypto'
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { QuorumConfigSchema } from '../shared/config/schema.js'
import { syncProjectMembers } from '../ddb.js'
import { invalidateProject } from '../config-cache.js'
import { verifyJwt } from '../middleware/verify-jwt.js'

const router = Router()

const SYNC_CONCURRENCY = 5

let s3Client = null

/**
 * Lazy S3Client honouring AWS_ENDPOINT_URL (LocalStack) and AWS_REGION.
 * Exported so config.js can reuse the same client for the upload endpoint.
 * @returns {S3Client}
 */
export function getS3() {
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
  if (syncSecret) {
    const headerBuf = Buffer.from(req.headers['x-quorum-sync-token'] ?? '')
    const secretBuf = Buffer.from(syncSecret)
    const valid = headerBuf.length === secretBuf.length && crypto.timingSafeEqual(headerBuf, secretBuf)
    if (valid) return true
  }
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
 * Exported so config.js can call it after a new project config is uploaded.
 *
 * On success, returns the parsed config alongside { ok: true } so that
 * syncAllConfigs can build an is_global map for cross-catalog globals validation
 * without additional S3 round-trips.
 *
 * @param {string} bucket
 * @param {string} projectId
 * @returns {Promise<
 *   { project_id: string, ok: true,  config: import('../shared/config/schema.js').QuorumConfig } |
 *   { project_id: string, ok: false, error: string }
 * >}
 */
export async function syncOneProject(bucket, projectId) {
  try {
    const obj = await getS3().send(new GetObjectCommand({
      Bucket: bucket,
      Key:    `${projectId}.quorum.json`,
    }))
    const body = await obj.Body.transformToString()
    const raw  = JSON.parse(body)
    const config = QuorumConfigSchema.parse(raw)

    // Self-reference guard: a project cannot list itself in its own globals array.
    // A project reading from itself is a no-op but signals a misconfigured .quorum file.
    const canonicalId = config.group_id ?? projectId
    if ((config.globals ?? []).includes(canonicalId)) {
      return {
        project_id: projectId,
        ok:         false,
        error:      `globals self-reference: '${canonicalId}' cannot link to itself`,
      }
    }

    const owner = config.owner ?? null
    const members = (config.members ?? []).map((m) => ({
      github_username: m.github_username,
      role:            m.role,
      team:            m.team,
      // Precedence: per-member override → role-level default → hardcoded floor.
      // Per-member base_confidence was added to MemberSchema and must take priority
      // over the role-level config so individual contributor overrides are honoured.
      base_confidence: m.base_confidence
        ?? (m.role && config.roles?.[m.role] ? config.roles[m.role].base_confidence : null)
        ?? 0.5,
      is_owner:        owner !== null && m.github_username === owner,
    })).filter((m) => m.github_username)

    // Invalidate Redis config cache — next load will re-fetch from S3 fresh.
    await invalidateProject(projectId)
    await syncProjectMembers(projectId, config.project ?? config.group_id ?? projectId, config.group_id ?? projectId, members)

    return { project_id: projectId, ok: true, config }
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
/**
 * @param {import('pg').Pool | null} [pool] - optional; when provided, updates q_projects.is_global
 */
export async function syncAllConfigs(pool = null) {
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

  // 3. Cross-catalog globals validation.
  // Build an is_global map from all successfully synced configs (no extra S3 calls needed —
  // each syncOneProject result carries the parsed config). Then verify that every entry in
  // a project's globals list actually has is_global: true in the synced set.
  // Unknown catalog IDs (not in this sync batch) are skipped — they may be valid but just
  // not synced this run. Only entries whose is_global is explicitly false are flagged.
  const isGlobalMap = new Map()
  for (const r of results) {
    if (r.ok && r.config) {
      isGlobalMap.set(r.config.group_id ?? r.project_id, r.config.is_global === true)
    }
  }

  const globalsWarnings = []
  for (const r of results) {
    if (!r.ok || !(r.config?.globals?.length)) continue
    for (const catalogId of r.config.globals) {
      if (isGlobalMap.has(catalogId) && !isGlobalMap.get(catalogId)) {
        globalsWarnings.push({
          project_id: r.project_id,
          catalog_id: catalogId,
          warning:    `globals references '${catalogId}' which is not a global catalog (is_global: false)`,
        })
      }
    }
  }

  // 4. Update q_projects.is_global for all successfully synced global configs.
  // This ensures that GET /api/globals discovers the right projects even if the row was
  // created before the is_global field was added to the schema.
  if (pool) {
    const globalIds = results
      .filter((r) => r.ok && r.config?.is_global === true)
      .map((r) => r.config.group_id ?? r.project_id)
    if (globalIds.length > 0) {
      await pool.query(
        `UPDATE q_projects SET is_global = true WHERE group_id = ANY($1)`,
        [globalIds],
      ).catch((err) => console.error(`[Gateway] syncAllConfigs: q_projects is_global update failed — ${err.message}`))
    }
  }

  return { synced, failed, globals_warnings: globalsWarnings, duration_ms: Date.now() - startedAt }
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

  const result = await syncAllConfigs(req.app.locals.pool ?? null)

  res.json(result)
})

export default router
