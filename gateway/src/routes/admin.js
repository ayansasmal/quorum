/**
 * Quorum Gateway — Platform admin routes.
 *
 * GET  /admin/config
 *   Returns the platform admin config (admins list + version).
 *   Auth: platform admin (is_admin) only.
 *
 * POST /admin/users
 *   Add or remove a user from the platform admin list.
 *   Auth: platform admin only.
 *   Audited in PostgreSQL.
 *
 * GET  /admin/projects
 *   Returns all projects (ACTIVE + ARCHIVED) across the platform.
 *   Auth: platform admin only.
 */

import { Router } from 'express'
import { verifyJwt } from '../middleware/verify-jwt.js'
import { loadAdminConfig, saveAdminConfig, invalidateProject } from '../config-cache.js'
import { syncProjectMembers } from '../ddb.js'
import { writeGovernanceAudit } from '../shared/audit/governance.js'
import { enforceReasonRequired } from '../shared/governance/constitutional.js'

const router = Router()

/** Reject non-admins with 403. */
function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: 'forbidden', message: 'Platform admin access required' })
  }
  next()
}

// GET /admin/config
router.get('/config', verifyJwt, requireAdmin, async (_req, res) => {
  const config = await loadAdminConfig()
  if (!config) {
    return res.status(404).json({
      error:   'not_found',
      message: 'Admin config not yet seeded. Run setup.sh to initialise.',
    })
  }
  res.json(config)
})

// POST /admin/users
// E2E: tests/e2e/scenarios/09-admin-operations.spec.js — S-09 admin user management
// E2E: tests/e2e/scenarios/15-reason-placeholder.spec.js — S-15 REASON_REQUIRED on admin/users
router.post('/users', verifyJwt, requireAdmin, async (req, res, next) => {
  const { action, github_username, reason } = req.body ?? {}
  const actor = req.user.sub
  const pool  = req.app.locals.pool

  if (!action || !['add', 'remove'].includes(action)) {
    return res.status(400).json({ error: 'missing_param', message: 'action must be "add" or "remove"' })
  }
  if (!github_username) {
    return res.status(400).json({ error: 'missing_param', message: 'github_username required' })
  }
  // Constitutional Rule 3: reason must be meaningful (min 10 chars, no placeholder patterns)
  try {
    enforceReasonRequired(reason, 'admin-users')
  } catch (err) {
    return next(err)
  }

  const config = await loadAdminConfig()
  if (!config) {
    return res.status(500).json({ error: 'config_error', message: 'Admin config not yet seeded' })
  }

  const admins = config.admins ?? []

  if (action === 'add') {
    const exists = admins.some((a) => a.github_username === github_username)
    if (exists) {
      return res.status(409).json({ error: 'already_admin', message: `${github_username} is already a platform admin` })
    }
    admins.push({
      github_username,
      added_at: new Date().toISOString(),
      added_by: actor,
    })
  } else {
    // remove — cannot self-remove last admin
    const idx = admins.findIndex((a) => a.github_username === github_username)
    if (idx === -1) {
      return res.status(404).json({ error: 'not_found', message: `${github_username} is not a platform admin` })
    }
    if (admins.length === 1) {
      return res.status(409).json({ error: 'last_admin', message: 'Cannot remove the last platform admin' })
    }
    admins.splice(idx, 1)
  }

  const updated = { ...config, admins, version: (config.version ?? 0) + 1, updated_at: new Date().toISOString() }
  await saveAdminConfig(updated)

  await writeGovernanceAudit(pool, {
    actor,
    actor_type: 'admin',
    action:     action === 'add' ? 'admin_add' : 'admin_remove',
    project:    null,
    to:         action === 'add'    ? github_username : undefined,
    from:       action === 'remove' ? github_username : undefined,
    reason,
  })

  res.json({ ok: true, action, github_username })
})

// GET /admin/projects — all projects across the platform
// E2E: tests/e2e/scenarios/09-admin-operations.spec.js — S-09.3 admin project listing
router.get('/projects', verifyJwt, requireAdmin, async (req, res, next) => {
  const pool = req.app.locals.pool
  try {
    const { rows } = await pool.query(
      `SELECT group_id, display_name, owner, is_global,
              jsonb_array_length(members) AS member_count,
              created_at
       FROM q_projects
       ORDER BY created_at DESC`,
    )
    res.json({ projects: rows })
  } catch (err) {
    next(err)
  }
})

// DELETE /admin/projects/:groupId — soft-archive a project (admin-only)
// Sets is_archived=TRUE + archived_at/by on q_projects, bulk-deprecates ACTIVE knowledge.
// GOVERNANCE: intentionally admin/dashboard-only — MCP must never expose this.
// E2E: tests/e2e/scenarios/09-admin-operations.spec.js — S-09.8 (archive + guard)
router.delete('/projects/:groupId', verifyJwt, requireAdmin, async (req, res, next) => {
  const { groupId } = req.params
  const { reason }  = req.body ?? {}
  const pool        = req.app.locals.pool

  try {
    enforceReasonRequired(reason, 'archive-project')
  } catch (err) {
    return next(err)
  }

  try {
    const found = await pool.query(
      `SELECT q_project_id FROM q_projects WHERE group_id = $1 AND is_archived = FALSE`,
      [groupId],
    )
    if (!found.rows[0]) {
      return res.status(404).json({ error: 'project_not_found', message: `Project '${groupId}' not found or already archived` })
    }
    const qProjectId = found.rows[0].q_project_id

    // Bulk-deprecate all ACTIVE knowledge versions in this project
    const deprecated = await pool.query(
      `UPDATE knowledge_versions SET status = 'DEPRECATED'
       WHERE q_project_id = $1 AND status = 'ACTIVE'
       RETURNING version_id`,
      [qProjectId],
    )

    // Soft-archive the project
    await pool.query(
      `UPDATE q_projects SET is_archived = TRUE, archived_at = NOW(), archived_by = $1
       WHERE q_project_id = $2`,
      [req.user.sub, qProjectId],
    )

    // Invalidate config cache so subsequent requests see the archived state
    await invalidateProject(groupId)

    // Flush DDB membership rows so the project disappears from every user's project selector
    await syncProjectMembers(groupId, '', '', [])

    await writeGovernanceAudit(pool, {
      actor:      req.user.sub,
      actor_type: 'admin',
      action:     'project_archive',
      project:    null,
      to:         groupId,
      reason,
    })

    res.json({
      group_id:            groupId,
      archived:            true,
      archived_by:         req.user.sub,
      versions_deprecated: deprecated.rowCount,
    })
  } catch (err) {
    next(err)
  }
})

export default router
