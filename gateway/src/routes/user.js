/**
 * Quorum Gateway — User profile routes.
 *
 * GET /user/profile/:username
 *   Returns the full profile for a GitHub user: all projects, roles, ownership flags.
 *   This is the v0.3 replacement for GET /auth/projects and the JWT role claims.
 *
 *   Access rules:
 *     - Self: always allowed
 *     - Platform admin (is_admin): any user
 *     - Others: allowed only if requester shares at least one project with the target
 */

import { Router } from 'express'
import { verifyJwt } from '../middleware/verify-jwt.js'
import { loadUserProfile, loadAdminConfig } from '../config-cache.js'

const router = Router()

// GET /user/profile/:username
router.get('/profile/:username', verifyJwt, async (req, res) => {
  const { username } = req.params
  const caller       = req.user.sub
  const isAdmin      = req.user.is_admin ?? false

  // Access check — self or admin always allowed
  if (caller !== username && !isAdmin) {
    const [callerProfile, targetProfile] = await Promise.all([
      loadUserProfile(caller),
      loadUserProfile(username),
    ])

    if (!callerProfile || !targetProfile) {
      return res.status(403).json({ error: 'forbidden', message: 'You can only view profiles of users in shared projects' })
    }

    const callerProjects = new Set(callerProfile.projects.map((p) => p.group_id))
    const sharesProject  = targetProfile.projects.some((p) => callerProjects.has(p.group_id))

    if (!sharesProject) {
      return res.status(403).json({
        error:   'forbidden',
        message: 'You can only view profiles of users in shared projects',
      })
    }
  }

  const profile = await loadUserProfile(username)
  if (!profile) {
    return res.status(404).json({ error: 'profile_not_found', message: `No profile found for '${username}'` })
  }

  const isTarget = await isPlatformAdminFromConfig(username)

  res.json({
    github_username: profile.github_username,
    is_admin:        isTarget,
    projects:        profile.projects,
  })
})

/**
 * Check if a username appears in the admin:platform config.
 * @param {string} username
 * @returns {Promise<boolean>}
 */
async function isPlatformAdminFromConfig(username) {
  const config = await loadAdminConfig()
  return config?.admins?.some((a) => a.github_username === username) ?? false
}

export default router
