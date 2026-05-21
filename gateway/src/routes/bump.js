/**
 * Quorum Gateway — Knowledge bump endpoint (GAP-24).
 *
 * POST /bump/:topic/:key
 *
 * Endorses an existing ACTIVE knowledge node, restoring confidence lost to
 * decay and resetting the decay clock. Used by the dashboard's "Decaying
 * Knowledge" panel.
 *
 * Auth: JWT (verifyJwt) — project scope resolved from JWT `project` claim.
 *
 * Cooldown: 7 days per author per topic:key. Enforced via bump_log.
 * Delta: role-weighted (+0.025 to +0.050), capped at starting_confidence.
 *
 * Role weights:
 *   engineer            → 0.50  (delta +0.025)
 *   senior_engineer     → 0.70  (delta +0.035)
 *   tech_lead           → 0.70  (delta +0.035)
 *   architect           → 0.85  (delta +0.042)
 *   principal_architect → 1.00  (delta +0.050)
 *   business_analyst    → 0.65  (delta +0.033)
 *   product_owner       → 0.85  (delta +0.042)
 *   compliance_officer  → 0.90  (delta +0.045)
 */

import { Router } from 'express'
import { verifyJwt } from '../middleware/verify-jwt.js'
import { projectMiddleware } from '../middleware/project.js'
import { Errors } from '../errors.js'
import {
  getProjectByGroupId,
  getOrCreateKey,
  getVersionForBump,
  getBumpLog,
  recordBump,
  updateConfidence,
} from '../shared/graph/queries.js'

const router = Router()

const COOLDOWN_MS   = 7 * 24 * 60 * 60 * 1000  // 7 days
const BASE_DELTA    = 0.05

/** Role weight used for the bump delta. Matches authority.js role weights. */
const ROLE_WEIGHT = {
  // Engineering roles
  engineer:            0.50,
  senior_engineer:     0.70,
  tech_lead:           0.70,
  architect:           0.85,
  principal_architect: 1.00,
  // Business roles
  business_analyst:    0.65,
  product_owner:       0.85,
  compliance_officer:  0.90,
}

/**
 * POST /bump/:topic/:key
 *
 * Bumps the confidence of a ACTIVE knowledge node. Requires a valid JWT and
 * a valid project token (X-Quorum-Token) so the project scope is unambiguous.
 */
router.post('/:topic/:key', verifyJwt, projectMiddleware, async (req, res, next) => {
  const { topic, key } = req.params
  const caller      = req.user.sub
  const callerRole  = req.user.role ?? 'engineer'
  const projectId   = req.project.id
  const pool        = req.app.locals.pool

  try {
    // Resolve group_id → q_project_id, then (topic, key) → q_key_id
    const qProjectId = await getProjectByGroupId(pool, projectId)
    if (!qProjectId) {
      return next(Errors.notFound(`Project '${projectId}' not registered`))
    }
    const qKeyId = await getOrCreateKey(pool, qProjectId, topic, key)

    // Load the current ACTIVE version
    const existing = await getVersionForBump(pool, qKeyId)
    if (!existing) {
      return next(Errors.notFound(`No ACTIVE knowledge at ${topic}:${key} in this project`))
    }

    // Calculate role-weighted delta, capped at starting_confidence
    const weight        = ROLE_WEIGHT[callerRole] ?? ROLE_WEIGHT.engineer
    const delta         = BASE_DELTA * weight
    const currentConf   = existing.confidence ?? 0.7
    const startingConf  = existing.starting_confidence ?? currentConf
    const newConfidence = Math.min(startingConf, currentConf + delta)

    // Wrap cooldown read, insert, and confidence update in a single transaction
    // to prevent concurrent double-bumps from the same author.
    const client = await pool.connect()
    let responsePayload
    try {
      await client.query('BEGIN')

      // Cooldown check — 7 days per author (inside the transaction to prevent races)
      const bumpLogs = await getBumpLog(client, { qKeyId, author: caller, limit: 1 })
      const lastBump = bumpLogs[0] ?? null
      if (lastBump) {
        const elapsed = Date.now() - new Date(lastBump.bumped_at).getTime()
        if (elapsed < COOLDOWN_MS) {
          await client.query('ROLLBACK')
          const daysLeft = ((COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000)).toFixed(1)
          return next(Errors.conflict(
            `Bump cooldown active — ${daysLeft} day(s) remaining. You bumped this entry ${Math.floor(elapsed / (24 * 60 * 60 * 1000))} day(s) ago.`,
          ))
        }
      }

      // INSERT bump_log row (ON CONFLICT DO NOTHING as a secondary guard)
      await recordBump(client, { qKeyId, author: caller, role: callerRole, delta })
      await updateConfidence(client, existing.version_id, newConfidence)

      await client.query('COMMIT')

      responsePayload = {
        topic,
        key,
        project_id:          projectId,
        bumped_by:           caller,
        role:                callerRole,
        delta_applied:       parseFloat(delta.toFixed(4)),
        confidence_before:   parseFloat(currentConf.toFixed(4)),
        confidence_after:    parseFloat(newConfidence.toFixed(4)),
        starting_confidence: parseFloat(startingConf.toFixed(4)),
        cooldown_resets_at:  new Date(Date.now() + COOLDOWN_MS).toISOString(),
      }
    } catch (txErr) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      throw txErr
    } finally {
      client.release()
    }

    res.json(responsePayload)
  } catch (err) {
    next(err)
  }
})

export default router
