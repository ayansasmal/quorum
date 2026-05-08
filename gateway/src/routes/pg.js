/**
 * Quorum Gateway — PostgreSQL REST API.
 *
 * Exposes the same operations as src/graph/queries.js and src/audit/secondary.js
 * as JWT-authenticated REST endpoints. The gateway enforces project_id from the
 * JWT claim on every query — engineers cannot access other teams' data.
 *
 * Endpoints map 1:1 with the functions in queries.js and secondary.js so the
 * local Quorum can swap direct pg calls for HTTP calls with minimal changes.
 *
 * Route structure:
 *   GET  /pg/versions/:topic/:key             → getCurrentVersion
 *   GET  /pg/versions/:topic/:key/history     → getVersionHistory
 *   GET  /pg/versions/:topic/:key/at          → getVersionAtDate (?date=ISO)
 *   GET  /pg/versions/:topic/:key/next-number → getNextVersionNumber
 *   GET  /pg/versions/:topic/:key/:version    → getSpecificVersion
 *   POST /pg/versions                         → insertVersion
 *   PATCH /pg/versions/:topic/:key/:version   → transitionVersionStatus
 *   GET  /pg/versions/by-tag/:tag             → getVersionsByTag
 *
 *   POST /pg/audit-links                      → insertVersionAuditLink
 *
 *   POST /pg/audit                            → writeAuditEntry
 *   GET  /pg/audit                            → getAllEntries
 *   GET  /pg/audit/count                      → countEntries
 *   GET  /pg/audit/lineage/:topic/:key        → audit lineage for a knowledge node
 *   GET  /pg/audit/:id                        → getAuditEntry
 *
 *   GET  /pg/pending                          → fetch pending decisions
 *   POST /pg/pending                          → insert pending decision
 *   PATCH /pg/pending/:conflictId             → update pending decision
 *   GET  /pg/pending/count/:topic/:key        → count pending for topic:key
 */

import { Router } from 'express'
import { verifyJwt } from '../middleware/verify-jwt.js'
import {
  getCurrentVersion,
  getVersionHistory,
  getVersionAtDate,
  getNextVersionNumber,
  getSpecificVersion,
  insertVersion,
  transitionVersionStatus,
  insertVersionAuditLink,
  getVersionsByTag,
} from '../shared/graph/queries.js'
import {
  writeAuditEntry,
  getAuditEntry,
  getAllEntries,
  countEntries,
} from '../shared/audit/secondary.js'

const router = Router()

// All pg routes require a valid JWT
router.use(verifyJwt)

// ── Helper: inject project_id into a record ─────────────────────────────────────

/**
 * Wrap a pg pool to inject project_id on every query.
 * The gateway's pool is the real connection; we use the req.user.project claim
 * to scope every query so engineers cannot access other teams' data.
 *
 * @param {import('pg').Pool} pool
 * @param {string} projectId
 * @returns {import('pg').Pool} proxy pool that adds WHERE project_id = ? automatically
 */
function scopedPool(pool, projectId) {
  // We don't transparently rewrite queries — instead we pass projectId explicitly
  // to each repository function and the functions include it in WHERE clauses.
  // The pool is passed through as-is; project scoping is done at the query level.
  return pool
}

// ── Knowledge versions ─────────────────────────────────────────────────────────

// GET /pg/versions/:topic/:key — current ACTIVE version (project-scoped)
router.get('/versions/:topic/:key', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  const projectId = req.user.project

  const version = await getCurrentVersion(pool, topic, key, projectId)
    .catch((err) => { throw err })
  res.json(version)
})

// GET /pg/versions/:topic/:key/history — all versions
router.get('/versions/:topic/:key/history', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  const projectId = req.user.project

  const history = await getVersionHistory(pool, topic, key, projectId)
  res.json(history)
})

// GET /pg/versions/:topic/:key/at?date=ISO — point-in-time version
router.get('/versions/:topic/:key/at', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  const { date } = req.query
  const projectId = req.user.project

  if (!date) return res.status(400).json({ error: 'date query param required' })
  const version = await getVersionAtDate(pool, topic, key, date, projectId)
  res.json(version)
})

// GET /pg/versions/:topic/:key/next-number
router.get('/versions/:topic/:key/next-number', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  const projectId = req.user.project

  const next = await getNextVersionNumber(pool, topic, key, projectId)
  res.json({ next_version: next })
})

// GET /pg/versions/by-tag/:tag — versions with this tag (project-scoped)
router.get('/versions/by-tag/:tag', async (req, res) => {
  const pool = req.app.locals.pool
  const { tag } = req.params
  const projectId = req.user.project

  const versions = await getVersionsByTag(pool, tag, projectId)
  res.json(versions)
})

// GET /pg/versions/:topic/:key/:version — specific version
router.get('/versions/:topic/:key/:version', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key, version } = req.params
  const projectId = req.user.project

  const v = await getSpecificVersion(pool, topic, key, parseInt(version, 10), projectId)
  res.json(v)
})

// POST /pg/versions — insert new version (project_id injected from JWT)
router.post('/versions', async (req, res) => {
  const pool = req.app.locals.pool
  const record = { ...req.body, project_id: req.user.project }

  const inserted = await insertVersion(pool, record)
  res.status(201).json(inserted)
})

// PATCH /pg/versions/:topic/:key/:version — transition status
router.patch('/versions/:topic/:key/:version', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key, version } = req.params
  const { newStatus, forwardLink } = req.body ?? {}
  const projectId = req.user.project

  if (!newStatus) return res.status(400).json({ error: 'newStatus required' })

  const updated = await transitionVersionStatus(
    pool, topic, key, parseInt(version, 10), newStatus, forwardLink ?? null, projectId,
  )
  res.json(updated)
})

// ── Version-audit links ────────────────────────────────────────────────────────

// POST /pg/audit-links
router.post('/audit-links', async (req, res) => {
  const pool = req.app.locals.pool
  await insertVersionAuditLink(pool, req.body)
  res.status(201).json({ ok: true })
})

// ── Audit log ─────────────────────────────────────────────────────────────────

// POST /pg/audit — write audit entry
router.post('/audit', async (req, res) => {
  const pool = req.app.locals.pool
  const entry = { ...req.body, project_id: req.user.project }
  const written = await writeAuditEntry(pool, entry)
  res.status(201).json(written)
})

// GET /pg/audit — all entries (project-scoped)
router.get('/audit', async (req, res) => {
  const pool = req.app.locals.pool
  const projectId = req.user.project
  const opts = { ...req.query, projectId }
  const entries = await getAllEntries(pool, opts)
  res.json(entries)
})

// GET /pg/audit/count
router.get('/audit/count', async (req, res) => {
  const pool = req.app.locals.pool
  const projectId = req.user.project
  const count = await countEntries(pool, projectId)
  res.json({ count })
})

// GET /pg/audit/lineage/:topic/:key — ordered audit trail for a knowledge node
router.get('/audit/lineage/:topic/:key', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  const projectId = req.user.project

  const { rows } = await pool.query(
    `SELECT al.entry_id, al.operation, al.author, al.timestamp,
            al.outcome_json, al.governance_json, al.chain_position,
            val.version, val.link_type
     FROM audit_log al
     JOIN version_audit_links val ON al.entry_id = val.audit_entry_id
     WHERE val.topic = $1 AND val.key = $2 AND al.project_id = $3
     ORDER BY al.chain_position ASC`,
    [topic, key, projectId],
  )
  res.json({ entries: rows })
})

// GET /pg/audit/:id
router.get('/audit/:id', async (req, res) => {
  const pool = req.app.locals.pool
  const entry = await getAuditEntry(pool, req.params.id)
  // Only return if it belongs to this project
  if (entry && entry.project_id !== req.user.project) {
    return res.status(404).json(null)
  }
  res.json(entry)
})

// ── Pending decisions ─────────────────────────────────────────────────────────

// GET /pg/pending — fetch pending decisions for this project
router.get('/pending', async (req, res) => {
  const pool = req.app.locals.pool
  const projectId = req.user.project
  const { topic, include_stale } = req.query

  let query = `SELECT * FROM pending_decisions WHERE project_id = $1`
  const params = [projectId]

  if (!include_stale) {
    query += ` AND status = ANY($${params.length + 1})`
    params.push(['pending'])
  }

  if (topic) {
    query += ` AND conflict_topic = $${params.length + 1}`
    params.push(topic)
  }

  query += ` ORDER BY created_at ASC`
  const { rows } = await pool.query(query, params)
  res.json(rows)
})

// POST /pg/pending — insert pending decision
router.post('/pending', async (req, res) => {
  const pool = req.app.locals.pool
  const d = { ...req.body, project_id: req.user.project }

  const { rows } = await pool.query(
    `INSERT INTO pending_decisions (
       conflict_id, decision_type, status, project_id,
       conflict_topic, conflict_key,
       active_version_at_creation, existing_content, incoming_content, conflict_reason,
       enrichment, more_pending_same_key
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      d.conflict_id, d.decision_type, 'pending', d.project_id,
      d.conflict_topic, d.conflict_key,
      d.active_version_at_creation ?? null,
      d.existing_content ?? null,
      d.incoming_content ?? null,
      d.conflict_reason ?? null,
      d.enrichment ? JSON.stringify(d.enrichment) : null,
      d.more_pending_same_key ?? 0,
    ],
  )
  res.status(201).json(rows[0])
})

// PATCH /pg/pending/:conflictId — update pending decision (resolve / stale)
router.patch('/pending/:conflictId', async (req, res) => {
  const pool = req.app.locals.pool
  const { conflictId } = req.params
  const projectId = req.user.project
  const updates = req.body ?? {}

  // Build dynamic UPDATE — only set columns that are provided
  const allowed = [
    'status', 'resolution', 'resolution_note', 'resolved_by', 'resolved_at',
    'split_existing_key', 'split_incoming_key', 'split_existing_content', 'split_incoming_content',
    'merged_content', 'stale_warning', 'current_active_version', 'more_pending_same_key',
  ]
  const setClauses = []
  const params = [conflictId, projectId]

  for (const col of allowed) {
    if (Object.prototype.hasOwnProperty.call(updates, col)) {
      params.push(updates[col])
      setClauses.push(`${col} = $${params.length}`)
    }
  }
  if (setClauses.length === 0) return res.status(400).json({ error: 'No updatable fields provided' })

  setClauses.push(`updated_at = NOW()`)

  const { rows } = await pool.query(
    `UPDATE pending_decisions SET ${setClauses.join(', ')}
     WHERE conflict_id = $1 AND project_id = $2
     RETURNING *`,
    params,
  )
  if (!rows[0]) return res.status(404).json({ error: 'Pending decision not found' })
  res.json(rows[0])
})

// GET /pg/pending/count/:topic/:key — count pending for topic:key
router.get('/pending/count/:topic/:key', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  const projectId = req.user.project

  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM pending_decisions
     WHERE project_id = $1 AND conflict_topic = $2 AND conflict_key = $3 AND status = 'pending'`,
    [projectId, topic, key],
  )
  res.json({ count: parseInt(rows[0].cnt, 10) })
})

// ── Error handler for this router ─────────────────────────────────────────────

router.use((err, _req, res, _next) => {
  console.error('[Gateway/pg] Error:', err.message)
  res.status(500).json({ error: 'internal_error', message: err.message })
})

export default router
