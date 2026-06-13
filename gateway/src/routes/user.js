/**
 * Quorum Gateway — User profile routes.
 *
 * GET /user/profile/:username
 *   Returns the full profile for a GitHub user: all projects, roles, ownership flags.
 *   This is the v0.3 replacement for GET /auth/projects and the JWT role claims.
 *
 *   Access rules:
 *     - Self: always allowed (200 even with zero projects — drives the dashboard
 *       self-serve onboarding flow; a projectless user discovers they have no
 *       memberships and is routed to the NoProjects welcome page)
 *     - Platform admin (is_admin): any user
 *     - Others: allowed only if requester shares at least one project with the target
 *
 *   A zero-project profile is treated as "not found" (404) ONLY for third-party
 *   lookups, to prevent username enumeration. For self, a zero-project profile is
 *   a valid 200 response carrying `projects: []`.
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

    // loadUserProfile never returns null — check projects[] to detect nonexistent users.
    // A user with zero project memberships has never been onboarded to Quorum.
    if (!targetProfile || targetProfile.projects.length === 0) {
      return res.status(404).json({ error: 'profile_not_found', message: `No profile found for '${username}'` })
    }

    if (!callerProfile || callerProfile.projects.length === 0) {
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
  // Self with zero projects is a valid 200 ({ projects: [] }) so the dashboard can
  // route to onboarding. Third parties still get 404 to prevent enumeration.
  if (!profile || (profile.projects.length === 0 && caller !== username)) {
    return res.status(404).json({ error: 'profile_not_found', message: `No profile found for '${username}'` })
  }

  const isTarget = await isPlatformAdminFromConfig(username)

  res.json({
    github_username: profile.github_username,
    is_admin:        isTarget,
    // role is per-project, not per-user — null at the profile level (resolved per X-Quorum-Project in middleware)
    role:            null,
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
