/**
 * Quorum Gateway — Projects route (GAP-11).
 *
 * GET /projects
 *   Lists all projects the authenticated engineer has access to.
 *   "Access" means: their GitHub username appears as a member in that project's
 *   quorum.config.json stored in the S3 bucket.
 *
 *   Returns project_id + the member's role/team in each project.
 *   Used by engineers to discover which projects they can work on before
 *   running `quorum init` or setting QUORUM_PROJECT_ID.
 */

import { Router } from 'express'
import { verifyJwt } from '../middleware/verify-jwt.js'
import { listProjectIds, loadProjectConfig } from '../config-cache.js'

const router = Router()

// GET /projects — list projects accessible to the authenticated user
router.get('/', verifyJwt, async (req, res) => {
  const githubLogin = req.user.sub

  let projectIds
  try {
    projectIds = await listProjectIds()
  } catch (err) {
    return res.status(500).json({ error: 'list_failed', message: err.message })
  }

  // Check membership in each project concurrently
  const results = await Promise.all(
    projectIds.map(async (projectId) => {
      try {
        const config = await loadProjectConfig(projectId)
        const member = config.members.find(
          (m) => m.github_username?.toLowerCase() === githubLogin.toLowerCase(),
        )
        if (!member) return null
        return {
          project_id: projectId,
          project:    config.project,
          role:       member.role ?? null,
          team:       member.team ?? null,
        }
      } catch {
        return null // Config load failed — skip silently
      }
    }),
  )

  res.json({
    projects: results.filter(Boolean),
    github_login: githubLogin,
  })
})

export default router
