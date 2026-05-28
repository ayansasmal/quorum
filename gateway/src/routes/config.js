/**
 * Quorum Gateway — Config routes.
 *
 * GET  /config/:projectId
 *   Returns the current quorum.config.json for a project.
 *   Requires JWT. Caller can only fetch configs for their own project.
 *
 * POST /config/upload
 *   Onboard a new project — uploads config to S3 and syncs to DDB.
 *   Idempotent-fails: returns 409 if the project already exists in S3.
 *   This is a one-time operation per project. To update an existing project
 *   config, use the dashboard Config editor or POST /sync/configs.
 *   Auth: X-Quorum-Sync-Token header OR principal_architect JWT.
 *
 * POST /config/validate
 *   Validates a config JSON body against the QuorumConfigSchema.
 *   Does NOT require authentication — useful for CI / pre-upload checks.
 */

import { Router }                        from 'express'
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { verifyJwt }                     from '../middleware/verify-jwt.js'
import { loadProjectConfig, saveProjectConfig, invalidateProject, invalidateProfile } from '../config-cache.js'
import { QuorumConfigSchema }            from '../shared/config/schema.js'
import { getS3, syncOneProject }         from './sync.js'
import { updateMemberRecord }            from '../ddb.js'
import { writeGovernanceAudit }          from '../shared/audit/governance.js'
import { enforceReasonRequired }         from '../shared/governance/constitutional.js'
import { createProject, getProjectByGroupId } from '../shared/graph/queries.js'

const router = Router()

// ── Auth helpers for upload ────────────────────────────────────────────────────

/**
 * Accepts either a sync-token header (EventBridge / setup scripts), a
 * principal_architect JWT, or a bootstrap upload where the authenticated
 * GitHub user is listed as principal_architect in the config being uploaded.
 *
 * The bootstrap case solves the onboarding catch-22: a new user has role 'none'
 * because they are not yet a member of any project, but they need to upload the
 * config to become a member. The config itself is the proof of membership —
 * if the JWT sub matches a principal_architect entry in the uploaded members
 * array, the upload is self-authorising for a brand-new project.
 *
 * This is safe because:
 *   1. The JWT is verified before this check (GitHub identity confirmed).
 *   2. The endpoint returns 409 if the project already exists — bootstrap
 *      only applies to net-new projects.
 *   3. Full schema validation still runs before anything is written to S3.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function authUpload(req) {
  const syncSecret = process.env.QUORUM_SYNC_SECRET
  if (syncSecret && req.headers['x-quorum-sync-token'] === syncSecret) return true
  if (req.user?.role === 'principal_architect') return true

  // Bootstrap: uploader is listed as principal_architect in the config they are uploading.
  // Only applies to new projects — existing projects return 409 before any write.
  const githubUser = req.user?.sub
  const members    = req.body?.members
  if (githubUser && Array.isArray(members)) {
    const isBootstrapArchitect = members.some(
      m => m.github_username === githubUser && m.role === 'principal_architect',
    )
    if (isBootstrapArchitect) return true
  }

  return false
}

// POST /config/upload — onboard a new project (verify JWT unless sync-token present)
router.use('/upload', (req, res, next) => {
  if (req.headers['x-quorum-sync-token']) return next()
  return verifyJwt(req, res, next)
})

/**
 * Upload a new project config to S3 and sync to DDB.
 * Fails with 409 if the project already exists — onboarding is a one-time operation.
 * To update an existing project config use the dashboard Config editor or POST /sync/configs.
 */
router.post('/upload', async (req, res) => {
  if (!authUpload(req)) {
    return res.status(403).json({
      error:   'forbidden',
      message: 'Config upload requires X-Quorum-Sync-Token, a principal_architect JWT, or a JWT whose GitHub username is listed as principal_architect in the uploaded config (bootstrap onboarding).',
    })
  }

  const bucket = process.env.QUORUM_CONFIG_BUCKET
  if (!bucket) {
    return res.status(500).json({ error: 'config_error', message: 'QUORUM_CONFIG_BUCKET not set' })
  }

  // Validate against schema
  const result = QuorumConfigSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({
      error:  'invalid_config',
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }

  const config  = result.data
  const groupId = config.group_id
  const key     = `${groupId}.quorum.json`

  // Idempotency check — reject if the project is already onboarded in S3
  try {
    await getS3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    const qProjId = await getProjectByGroupId(req.app.locals.pool, groupId).catch(() => null)
    return res.status(409).json({
      error:        'already_onboarded',
      message:      `Project '${groupId}' is already onboarded. Use POST /sync/configs to refresh an existing project config.`,
      project_id:   groupId,
      q_project_id: qProjId,
    })
  } catch (err) {
    // 404 / NoSuchKey → project does not exist yet; proceed
    if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
      console.error(`[Gateway:config] HeadObject failed for ${key}: ${err.message}`)
      return res.status(502).json({ error: 'storage_error', message: 'Failed to check S3 for existing project config' })
    }
  }

  // Upload config to S3
  try {
    await getS3().send(new PutObjectCommand({
      Bucket:      bucket,
      Key:         key,
      Body:        JSON.stringify(config, null, 2),
      ContentType: 'application/json',
    }))
  } catch (err) {
    console.error(`[Gateway:config] PutObject failed for ${key}: ${err.message}`)
    return res.status(502).json({ error: 'storage_error', message: 'Failed to upload config to S3' })
  }

  // Sync S3 → DDB (reads back what we just wrote; populates quorum-configs + quorum-user-projects)
  const syncResult = await syncOneProject(bucket, groupId)
  if (!syncResult.ok) {
    console.error(`[Gateway:config] DDB sync failed for ${groupId}: ${syncResult.error}`)
    // Config is in S3 — caller can retry by calling POST /sync/configs
    return res.status(207).json({
      error:      'partial_success',
      message:    `Config uploaded to S3 but DDB sync failed. Call POST /sync/configs to complete. Error: ${syncResult.error}`,
      project_id: groupId,
    })
  }

  // Register project in PostgreSQL (q_projects) — allocates q_project_id if new.
  const pool = req.app.locals.pool
  let qProjectId = null
  try {
    qProjectId = await getProjectByGroupId(pool, groupId)
    if (!qProjectId) {
      qProjectId = await createProject(
        pool,
        groupId,
        config.owner,
        config.members ?? [],
        { domains: config.domains },
        {
          displayName: config.project ?? null,
          createdBy:   req.user?.sub ?? 'system',
          isGlobal:    config.is_global ?? false,
        },
      )
    } else if (config.is_global === true) {
      // Update is_global when re-uploading a config that declares itself global.
      // The initial onboard may have created the row before is_global was in the schema.
      await pool.query(
        `UPDATE q_projects SET is_global = true WHERE group_id = $1`,
        [groupId],
      )
    }
  } catch (err) {
    console.error(`[Gateway:config] q_projects register failed for ${groupId}: ${err.message}`)
  }

  res.status(201).json({
    project_id:   groupId,
    q_project_id: qProjectId,
    message:      `Project '${groupId}' onboarded successfully.`,
  })
})

// GET /config/:projectId — fetch project config (JWT required)
router.get('/:projectId', verifyJwt, async (req, res) => {
  const { projectId } = req.params

  // Engineers can only fetch their own project config
  if (req.user.project !== projectId) {
    return res.status(403).json({
      error: 'forbidden',
      message: `Your JWT grants access to project '${req.user.project}', not '${projectId}'`,
    })
  }

  try {
    const config = await loadProjectConfig(projectId)
    res.json(config)
  } catch (err) {
    res.status(404).json({
      error: 'config_not_found',
      message: err.message,
    })
  }
})

// POST /config/:projectId/invalidate — invalidate cache after upload (JWT required)
router.post('/:projectId/invalidate', verifyJwt, (req, res) => {
  const { projectId } = req.params
  if (req.user.project !== projectId) {
    return res.status(403).json({
      error: 'forbidden',
      message: `Your JWT grants access to project '${req.user.project}', not '${projectId}'`,
    })
  }
  invalidateProject(projectId)
  res.json({ ok: true, message: `Config cache invalidated for project '${projectId}'` })
})

// POST /config/validate — validate config JSON (no auth required — useful for CI)
router.post('/validate', (req, res) => {
  const result = QuorumConfigSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({
      valid: false,
      errors: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    })
  }

  const config = result.data
  res.json({
    valid: true,
    summary: {
      project:       config.project ?? config.group_id,
      members:       config.members.length,
      roles:         Object.keys(config.roles ?? {}).length,
      domains:       Object.keys(config.domains ?? {}).length,
      member_names:  config.members.map((m) => m.name),
      role_names:    Object.keys(config.roles ?? {}),
      domain_names:  Object.keys(config.domains ?? {}),
      thresholds: {
        conflict:  config.thresholds?.conflict_threshold,
        authority: config.thresholds?.authority_threshold,
      },
    },
  })
})

// ── Governance endpoints ───────────────────────────────────────────────────────

/**
 * Determine if the actor may transfer ownership.
 * Owner can transfer to anyone; admin can transfer to anyone except themselves.
 * @param {string} actor
 * @param {string} newOwner
 * @param {boolean} isOwner
 * @param {boolean} isAdmin
 * @returns {boolean}
 */
function canTransferOwnership(actor, newOwner, isOwner, isAdmin) {
  if (isOwner) return true
  if (isAdmin && newOwner !== actor) return true
  return false
}

// POST /config/transfer-ownership
router.post('/transfer-ownership', verifyJwt, async (req, res, next) => {
  const { to, reason } = req.body ?? {}
  const actor   = req.user.sub
  const project = req.user.project
  const pool    = req.app.locals.pool

  if (!project) return res.status(400).json({ error: 'missing_header', message: 'X-Quorum-Project header required' })
  if (!to)      return res.status(400).json({ error: 'missing_param',  message: 'to (new owner username) required' })
  try {
    enforceReasonRequired(reason, 'transfer-ownership')
  } catch (err) {
    return next(err)
  }

  const config = await loadProjectConfig(project)
  const from   = config.owner

  if (!canTransferOwnership(actor, to, req.user.is_owner, req.user.is_admin)) {
    return res.status(403).json({
      error:   'forbidden',
      message: 'Only the current owner or a platform admin (not to themselves) can transfer ownership',
    })
  }

  // Verify target is a project member
  const targetMember = (config.members ?? []).find((m) => m.github_username === to)
  if (!targetMember) {
    return res.status(400).json({ error: 'not_a_member', message: `'${to}' is not a member of project '${project}'` })
  }

  const updatedConfig = { ...config, owner: to }
  await saveProjectConfig(project, updatedConfig)

  // Update DDB is_owner flags for both old and new owner
  await Promise.all([
    updateMemberRecord(from, project, { is_owner: false }),
    updateMemberRecord(to,   project, { is_owner: true  }),
  ])

  // Invalidate profiles for both actors so the change is visible immediately
  await Promise.all([
    invalidateProfile(from),
    invalidateProfile(to),
    invalidateProfile(actor),
  ])

  await writeGovernanceAudit(pool, {
    actor,
    actor_type: req.user.is_admin && !req.user.is_owner ? 'admin' : 'owner',
    action:     'ownership_transfer',
    project,
    from,
    to,
    reason,
  })

  res.json({ ok: true, project, from, to })
})

// POST /config/update-role
router.post('/update-role', verifyJwt, async (req, res, next) => {
  const { github_username, role, reason } = req.body ?? {}
  const actor   = req.user.sub
  const project = req.user.project
  const pool    = req.app.locals.pool

  if (!project)        return res.status(400).json({ error: 'missing_header', message: 'X-Quorum-Project header required' })
  if (!github_username) return res.status(400).json({ error: 'missing_param', message: 'github_username required' })
  if (!role)           return res.status(400).json({ error: 'missing_param', message: 'role required' })
  try {
    enforceReasonRequired(reason, 'update-role')
  } catch (err) {
    return next(err)
  }

  if (!req.user.is_owner && !req.user.is_admin) {
    return res.status(403).json({ error: 'forbidden', message: 'Only the project owner or a platform admin can update roles' })
  }

  const config = await loadProjectConfig(project)

  // Only reject the role when the config explicitly defines a roles map (non-empty).
  // Zod defaults roles:null → {} so we check Object.keys().length to avoid false positives.
  if (config.roles && Object.keys(config.roles).length > 0 && !config.roles[role]) {
    return res.status(400).json({
      error:   'invalid_role',
      message: `Role '${role}' is not defined in project config. Valid roles: ${Object.keys(config.roles).join(', ')}`,
    })
  }

  const memberIdx = (config.members ?? []).findIndex((m) => m.github_username === github_username)
  if (memberIdx === -1) {
    return res.status(400).json({ error: 'not_a_member', message: `'${github_username}' is not a member of project '${project}'` })
  }

  // Update member role in S3 config
  const updatedMembers  = [...config.members]
  updatedMembers[memberIdx] = { ...updatedMembers[memberIdx], role }
  const updatedConfig   = { ...config, members: updatedMembers }
  await saveProjectConfig(project, updatedConfig)

  // Update DDB membership record
  const newBaseConfidence = config.roles?.[role]?.base_confidence ?? 0.5
  await updateMemberRecord(github_username, project, { role, base_confidence: newBaseConfidence })

  // Invalidate the affected user's profile cache — takes effect on next request
  await invalidateProfile(github_username)

  await writeGovernanceAudit(pool, {
    actor,
    actor_type: req.user.is_admin && !req.user.is_owner ? 'admin' : 'owner',
    action:     'role_update',
    project,
    to:         github_username,
    reason,
    extra:      { new_role: role },
  })

  res.json({ ok: true, project, github_username, role })
})

export default router
