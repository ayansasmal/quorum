/**
 * Quorum Gateway — Projects API (GAP-20, GAP-25, GAP-26, GAP-29, GAP-32).
 *
 * POST   /projects                    — create project (token returned once)
 * GET    /projects                    — list projects the caller is a member of (GAP-32)
 * GET    /projects/:id                — get project config + members
 * PATCH  /projects/:id                — update members/domains/governance (optimistic lock GAP-25)
 * POST   /projects/:id/token/rotate   — rotate project token (new token returned once)
 * DELETE /projects/:id                — archive project (soft-delete, GAP-29)
 *
 * Auth: all routes require a valid JWT (verifyJwt). Routes that mutate project
 * config additionally require the caller to be a project member with a
 * principal_architect role (enforced per-route, not in middleware, so that
 * POST /projects can bootstrap without an existing project).
 */

import { Router }      from 'express'
import { randomBytes, createHash } from 'node:crypto'
import { verifyJwt }   from '../middleware/verify-jwt.js'
import { invalidateProject } from '../config-cache.js'
import { Errors }      from '../errors.js'

const router = Router()

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a new plaintext project token and its SHA-256 hash. */
function generateToken() {
  const plain = randomBytes(32).toString('hex')
  const hash  = createHash('sha256').update(plain).digest('hex')
  return { plain, hash }
}

/**
 * Resolve the calling user's role within a project.
 * Returns null if the caller is not a member.
 * @param {object[]} members
 * @param {string} githubLogin
 * @returns {string | null}
 */
function callerRole(members, githubLogin) {
  const m = members.find(
    (m) => m.github_username?.toLowerCase() === githubLogin.toLowerCase(),
  )
  return m?.role ?? null
}

/**
 * Validate that a members array retains at least one principal_architect.
 * @param {object[]} members
 * @returns {boolean}
 */
function hasPrincipalArchitect(members) {
  return members.some((m) => m.role === 'principal_architect')
}

// ── POST /projects ────────────────────────────────────────────────────────────

/**
 * Create a new project. Creator is auto-enrolled as principal_architect (GAP-26).
 * Returns the plaintext token once — never stored, never retrievable again.
 */
router.post('/', verifyJwt, async (req, res, next) => {
  const { name, slug, members = [], domains = [], governance = {}, github_org, github_repo, jira_project, slack_channel } = req.body
  const caller = req.user.sub

  if (!name || typeof name !== 'string') {
    return next(Errors.unprocessable('name is required'))
  }
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return next(Errors.unprocessable('slug is required and must match [a-z0-9-]+'))
  }

  // GAP-26: bootstrap — ensure creator is enrolled as principal_architect
  const callerEntry = {
    github_username: caller,
    role:            'principal_architect',
    team:            req.user.team ?? 'platform',
    base_confidence: 0.8,
  }
  const mergedMembers = [
    callerEntry,
    ...members.filter((m) => m.github_username?.toLowerCase() !== caller.toLowerCase()),
  ]

  const id           = `proj-${randomBytes(8).toString('hex')}`
  const { plain, hash } = generateToken()
  const pool         = req.app.locals.pool

  try {
    await pool.query(
      `INSERT INTO projects
         (id, slug, name, created_by, members, domains, governance,
          github_org, github_repo, jira_project, slack_channel, token_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id, slug, name, caller,
        JSON.stringify(mergedMembers),
        JSON.stringify(domains),
        JSON.stringify(governance),
        github_org  ?? null,
        github_repo ?? null,
        jira_project ?? null,
        slack_channel ?? null,
        hash,
      ],
    )
  } catch (err) {
    if (err.code === '23505') {
      // Unique violation — slug already taken
      return next(Errors.conflict(`Project slug '${slug}' is already in use`))
    }
    return next(err)
  }

  res.status(201).json({
    id,
    slug,
    name,
    token: plain,           // returned ONCE — store immediately
    token_note: 'This token is shown once. Store it securely — it cannot be retrieved again.',
    members: mergedMembers,
    domains,
    governance,
    config_version: 0,
  })
})

// ── GET /projects ─────────────────────────────────────────────────────────────

/**
 * List all projects the authenticated user is a member of.
 * Uses GIN-indexed JSONB @> containment query (GAP-32).
 */
router.get('/', verifyJwt, async (req, res, next) => {
  const caller = req.user.sub
  const pool   = req.app.locals.pool

  try {
    const result = await pool.query(
      `SELECT id, slug, name, status, config_version, created_at, members
       FROM projects
       WHERE status = 'ACTIVE'
         AND members @> $1::jsonb`,
      [JSON.stringify([{ github_username: caller }])],
    )

    const projects = result.rows.map((row) => {
      const member = row.members.find(
        (m) => m.github_username?.toLowerCase() === caller.toLowerCase(),
      )
      return {
        id:             row.id,
        slug:           row.slug,
        name:           row.name,
        status:         row.status,
        config_version: row.config_version,
        created_at:     row.created_at,
        role:           member?.role ?? null,
        team:           member?.team ?? null,
      }
    })

    res.json({ projects, github_login: caller })
  } catch (err) {
    next(err)
  }
})

// ── GET /projects/:id ─────────────────────────────────────────────────────────

/**
 * Get full project config. Caller must be a member.
 */
router.get('/:id', verifyJwt, async (req, res, next) => {
  const { id } = req.params
  const caller = req.user.sub
  const pool   = req.app.locals.pool

  try {
    const result = await pool.query(
      `SELECT id, slug, name, status, members, domains, governance,
              schema_version, config_version, config_updated_at, config_updated_by,
              github_org, github_repo, jira_project, slack_channel, created_at, created_by
       FROM projects
       WHERE id = $1 AND status = $2`,
      [id, 'ACTIVE'],
    )

    if (!result.rows[0]) {
      return next(Errors.notFound(`Project not found: ${id}`))
    }

    const row  = result.rows[0]
    const role = callerRole(row.members, caller)
    if (!role) {
      return next(Errors.forbidden('You are not a member of this project'))
    }

    res.json({ ...row, caller_role: role })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /projects/:id ───────────────────────────────────────────────────────

/**
 * Update project config. Requires principal_architect role.
 * Implements optimistic locking via config_version (GAP-25).
 * Enforces last-PA guard before committing member changes (GAP-26).
 */
router.patch('/:id', verifyJwt, async (req, res, next) => {
  const { id }     = req.params
  const caller     = req.user.sub
  const pool       = req.app.locals.pool
  const { config_version, members, domains, governance, github_org, github_repo, jira_project, slack_channel } = req.body

  if (config_version === undefined || config_version === null) {
    return next(Errors.unprocessable('config_version is required for optimistic locking'))
  }

  try {
    // Fetch current row for auth + version check
    const current = await pool.query(
      `SELECT members, config_version FROM projects WHERE id = $1 AND status = $2`,
      [id, 'ACTIVE'],
    )
    if (!current.rows[0]) {
      return next(Errors.notFound(`Project not found: ${id}`))
    }

    const row = current.rows[0]

    // Role check — must be principal_architect
    const role = callerRole(row.members, caller)
    if (role !== 'principal_architect') {
      return next(Errors.forbidden('Only a principal_architect may update project config'))
    }

    // GAP-25: optimistic lock
    if (row.config_version !== config_version) {
      return next(Errors.conflict(
        `Config was modified by another actor (expected version ${config_version}, got ${row.config_version}). Re-fetch and retry.`,
      ))
    }

    // GAP-26: PA guard — new members list must retain at least one PA
    const newMembers = members ?? row.members
    if (!hasPrincipalArchitect(newMembers)) {
      return next(Errors.unprocessable(
        'At least one principal_architect must remain in the project',
      ))
    }

    // Build SET clause dynamically — only patch provided fields
    const updates  = []
    const values   = []
    let   idx      = 1

    if (members   !== undefined) { updates.push(`members = $${idx++}`);   values.push(JSON.stringify(members)) }
    if (domains   !== undefined) { updates.push(`domains = $${idx++}`);   values.push(JSON.stringify(domains)) }
    if (governance !== undefined) { updates.push(`governance = $${idx++}`); values.push(JSON.stringify(governance)) }
    if (github_org    !== undefined) { updates.push(`github_org = $${idx++}`);    values.push(github_org) }
    if (github_repo   !== undefined) { updates.push(`github_repo = $${idx++}`);   values.push(github_repo) }
    if (jira_project  !== undefined) { updates.push(`jira_project = $${idx++}`);  values.push(jira_project) }
    if (slack_channel !== undefined) { updates.push(`slack_channel = $${idx++}`); values.push(slack_channel) }

    if (!updates.length) {
      return next(Errors.unprocessable('No updatable fields provided'))
    }

    // Always bump config_version and record who changed it
    updates.push(`config_version = config_version + 1`)
    updates.push(`config_updated_at = NOW()`)
    updates.push(`config_updated_by = $${idx++}`)
    values.push(caller)

    // WHERE includes config_version for atomic optimistic lock (double-guard)
    values.push(id, config_version)
    const updateResult = await pool.query(
      `UPDATE projects SET ${updates.join(', ')}
       WHERE id = $${idx++} AND config_version = $${idx++}
       RETURNING id, slug, name, config_version, members, domains, governance`,
      values,
    )

    if (!updateResult.rows[0]) {
      // Race condition: another write landed between our check and UPDATE
      return next(Errors.conflict('Concurrent modification detected — re-fetch and retry'))
    }

    // Bust the in-process config cache for this project
    invalidateProject(id)

    res.json({ ...updateResult.rows[0], updated_by: caller })
  } catch (err) {
    next(err)
  }
})

// ── POST /projects/:id/token/rotate ──────────────────────────────────────────

/**
 * Rotate the project token. Requires principal_architect role.
 * Old token is immediately invalidated (hash replaced in DB).
 * New plaintext token is returned once.
 */
router.post('/:id/token/rotate', verifyJwt, async (req, res, next) => {
  const { id } = req.params
  const caller = req.user.sub
  const pool   = req.app.locals.pool

  try {
    const current = await pool.query(
      `SELECT members FROM projects WHERE id = $1 AND status = $2`,
      [id, 'ACTIVE'],
    )
    if (!current.rows[0]) {
      return next(Errors.notFound(`Project not found: ${id}`))
    }

    const role = callerRole(current.rows[0].members, caller)
    if (role !== 'principal_architect') {
      return next(Errors.forbidden('Only a principal_architect may rotate the project token'))
    }

    const { plain, hash } = generateToken()

    await pool.query(
      `UPDATE projects SET token_hash = $1 WHERE id = $2`,
      [hash, id],
    )

    // Bust cache — config-cache keyed by token_hash must not serve stale lookups
    invalidateProject(id)

    res.json({
      id,
      token:      plain,
      token_note: 'Previous token is now invalid. Store this token securely — it cannot be retrieved again.',
    })
  } catch (err) {
    next(err)
  }
})

// ── DELETE /projects/:id ──────────────────────────────────────────────────────

/**
 * Archive a project (soft-delete).
 * Allowed for: project owner (created_by) OR platform admin (is_admin).
 * Sets project status to ARCHIVED and bulk-deprecates all ACTIVE knowledge versions.
 * Body: { reason } (required, ≥ 10 chars)
 */
router.delete('/:id', verifyJwt, async (req, res, next) => {
  const { id }     = req.params
  const { reason } = req.body ?? {}
  const caller     = req.user.sub
  const isAdmin    = req.user.is_admin
  const pool       = req.app.locals.pool

  if (!reason || reason.length < 10) {
    return next(Errors.unprocessable('reason must be at least 10 characters'))
  }

  try {
    const current = await pool.query(
      `SELECT members, created_by FROM projects WHERE id = $1 AND status = $2`,
      [id, 'ACTIVE'],
    )
    if (!current.rows[0]) {
      return next(Errors.notFound(`Project not found: ${id}`))
    }

    const isOwner = current.rows[0].created_by?.toLowerCase() === caller.toLowerCase()
    if (!isOwner && !isAdmin) {
      return next(Errors.forbidden('Only the project owner or a platform admin may archive a project'))
    }

    // Bulk soft-deprecate all ACTIVE knowledge versions in this project
    const deprecateResult = await pool.query(
      `UPDATE knowledge_versions
       SET status = 'DEPRECATED'
       WHERE project_id = $1 AND status = 'ACTIVE'
       RETURNING id`,
      [id],
    )

    // Soft-delete the project itself
    await pool.query(
      `UPDATE projects SET status = 'ARCHIVED' WHERE id = $1`,
      [id],
    )

    invalidateProject(id)

    res.json({
      id,
      status:              'ARCHIVED',
      versions_deprecated: deprecateResult.rowCount,
      archived_by:         caller,
    })
  } catch (err) {
    next(err)
  }
})

export default router
