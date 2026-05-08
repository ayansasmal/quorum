/**
 * Quorum Gateway — Config routes.
 *
 * GET  /config/:projectId
 *   Returns the current quorum.config.json for a project.
 *   Requires JWT. Caller can only fetch configs for their own project
 *   (unless they have no project claim — anonymous).
 *
 * POST /config/validate
 *   Validates a config JSON body against the QuorumConfigSchema.
 *   Does NOT require authentication — team leads can validate before uploading.
 *   Returns a summary on success or Zod validation errors on failure.
 */

import { Router } from 'express'
import { verifyJwt } from '../middleware/verify-jwt.js'
import { loadProjectConfig, invalidateProject } from '../config-cache.js'
import { QuorumConfigSchema } from '../shared/config/schema.js'

const router = Router()

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

export default router
