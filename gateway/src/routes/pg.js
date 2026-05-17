/**
 * Quorum Gateway — PostgreSQL REST API.
 *
 * Exposes the same operations as src/graph/queries.js and src/audit/secondary.js
 * as JWT-authenticated REST endpoints. The gateway enforces q_project_id (resolved
 * from the JWT's group_id claim) on every query — engineers cannot access other
 * teams' data.
 *
 * Route paths still use the human-readable (topic, key) addressing, but every
 * handler resolves these to a q_key_id via getOrCreateKey() before issuing the
 * underlying SQL.
 *
 * Route structure:
 *   GET  /pg/versions/:topic/:key             → getCurrentVersion
 *   GET  /pg/versions/:topic/:key/history     → getVersionHistory
 *   GET  /pg/versions/:topic/:key/at          → getVersionAtDate (?date=ISO)
 *   GET  /pg/versions/:topic/:key/next-number → getNextVersionNumber
 *   GET  /pg/versions/:topic/:key/:version    → getSpecificVersion
 *   POST /pg/versions                         → insertVersion
 *   POST /pg/versions/supersede               → atomic insert + transition (Gap 3)
 *   PATCH /pg/versions/:topic/:key/:version   → transitionVersionStatus
 *   GET  /pg/versions/by-tag/:tag             → getVersionsByTag
 *   GET  /pg/versions/latest-draft/:topic/:key → getLatestDraftVersion
 *   GET  /pg/versions/by-status/:status       → getVersionsByStatus
 *   GET  /pg/versions/status-counts           → getVersionStatusCounts
 *   GET  /pg/versions/drafts                  → getDraftVersions
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
 *   GET  /pg/pending/count/:topic/:key        → count pending for topic:key
 *   GET  /pg/pending/:conflictId              → getPendingDecisionById
 *   POST /pg/pending                          → insert pending decision
 *   PATCH /pg/pending/:conflictId             → update pending decision
 */

import { Router } from 'express'
import { verifyJwt } from '../middleware/verify-jwt.js'
import {
  getProjectByGroupId,
  getOrCreateKey,
  getCurrentVersion,
  getVersionHistory,
  getVersionAtDate,
  getNextVersionNumber,
  getSpecificVersion,
  insertVersion,
  transitionVersionStatus,
  insertVersionAuditLink,
  getVersionsByTag,
  getLatestDraftVersion,
  getVersionsByStatus,
  getVersionStatusCounts,
  getDraftVersions,
  getPendingDecisionById,
  countPendingForKey,
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

// All pg routes are project-scoped — X-Quorum-Project header required
router.use((req, res, next) => {
  if (!req.user.project) {
    return res.status(400).json({ error: 'X-Quorum-Project header required' })
  }
  next()
})

// Resolve group_id (req.user.project) → q_project_id once per request and stash
// it on req.user.qProjectId. All subsequent handlers use the q_* id directly.
router.use(async (req, res, next) => {
  const pool = req.app.locals.pool
  const header = req.user.project
  try {
    // Fast path: header already carries a q_project_id (post-Phase-3 MCP clients)
    if (header && /^q_p\d+$/.test(header)) {
      req.user.qProjectId = header
      return next()
    }
    // Slow path: header is a group_id slug — resolve via DB (pre-Phase-3 clients)
    const qProjectId = await getProjectByGroupId(pool, header)
    if (!qProjectId) {
      return res.status(404).json({
        error: 'project_not_found',
        message: `Project '${header}' not registered`,
      })
    }
    req.user.qProjectId = qProjectId
    next()
  } catch (err) {
    next(err)
  }
})

/**
 * Resolve a (topic, key) pair to its q_key_id within the request's project.
 * Idempotent — creates the q_keys row on first reference.
 *
 * @param {import('pg').Pool} pool
 * @param {string} qProjectId
 * @param {string} topic
 * @param {string} key
 * @returns {Promise<string>} q_key_id (e.g. 'q_k198')
 */
async function resolveKey(pool, qProjectId, topic, key) {
  return getOrCreateKey(pool, qProjectId, topic, key)
}

// ── Keyword search (ILIKE fallback) ────────────────────────────────────────────
//
// GET /pg/search — keyword ILIKE fallback over knowledge_versions.summary/topic/key.
// Used by the MCP search tool when Graphiti returns 0 results (e.g. after a
// FalkorDB volume wipe). Scoped by req.user.qProjectId; excludes DRAFT/DEPRECATED/REJECTED.
//
// Must be declared before any /:topic/:key parameterised routes to prevent the
// wildcard route from shadowing `search` as a topic name.
/**
 * GET /pg/search?q=<query>&domain=<topic>&limit=<n>
 * @returns {{ results: Array<object>, total: number, source: 'postgres-ilike' }}
 */
router.get('/search', async (req, res) => {
  const pool = req.app.locals.pool
  const { q, domain, limit = 10 } = req.query

  if (!q) {
    return res.status(400).json({ error: 'missing_param', message: 'q required' })
  }

  const pattern = `%${q}%`
  const params = [req.user.qProjectId, pattern]
  let domainClause = ''
  if (domain) {
    params.push(domain)
    domainClause = `AND topic = $${params.length}`
  }
  params.push(parseInt(limit, 10) || 10)

  const { rows } = await pool.query(
    `SELECT topic, key, summary, status, confidence, author, updated_at
     FROM knowledge_versions
     WHERE q_project_id = $1
       AND (key ILIKE $2 OR topic ILIKE $2 OR summary ILIKE $2)
       AND status NOT IN ('DRAFT','DEPRECATED','REJECTED')
       ${domainClause}
     ORDER BY confidence DESC, updated_at DESC
     LIMIT $${params.length}`,
    params,
  )

  res.json({ results: rows, total: rows.length, source: 'postgres-ilike' })
})

// ── Knowledge versions ─────────────────────────────────────────────────────────
//
// IMPORTANT: static-prefix routes must be registered BEFORE /versions/:topic/:key.
// Both /versions/by-status/:status and /versions/by-tag/:tag are 3-segment paths
// that Express would match as /:topic/:key if the wildcard route were first.

// GET /pg/versions/by-status/:status — versions with a given status (?topic=)
router.get('/versions/by-status/:status', async (req, res) => {
  const pool = req.app.locals.pool
  const { status } = req.params
  const { topic } = req.query
  const rows = await getVersionsByStatus(pool, status, req.user.qProjectId, topic)
  res.json(rows)
})

// GET /pg/versions/by-tag/:tag — versions with this tag (project-scoped)
router.get('/versions/by-tag/:tag', async (req, res) => {
  const pool = req.app.locals.pool
  const { tag } = req.params

  const versions = await getVersionsByTag(pool, tag, req.user.qProjectId)
  res.json(versions)
})

// GET /pg/versions/:topic/:key — current ACTIVE version (project-scoped)
router.get('/versions/:topic/:key', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params

  const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
  const version = await getCurrentVersion(pool, qKeyId)
  res.json(version)
})

// GET /pg/versions/:topic/:key/history — all versions
router.get('/versions/:topic/:key/history', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params

  const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
  const history = await getVersionHistory(pool, qKeyId)
  res.json(history)
})

// GET /pg/versions/:topic/:key/at?date=ISO — point-in-time version
router.get('/versions/:topic/:key/at', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  const { date } = req.query

  if (!date) return res.status(400).json({ error: 'date query param required' })
  const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
  const version = await getVersionAtDate(pool, qKeyId, date)
  res.json(version)
})

// GET /pg/versions/:topic/:key/next-number
router.get('/versions/:topic/:key/next-number', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params

  const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
  const next = await getNextVersionNumber(pool, qKeyId)
  res.json({ next_version: next })
})

// GET /pg/versions/drafts — all DRAFT versions (project-scoped, optional ?topic=)
router.get('/versions/drafts', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic } = req.query
  const rows = await getDraftVersions(pool, { qProjectId: req.user.qProjectId, topic })
  res.json(rows)
})

// GET /pg/versions/status-counts — version counts grouped by status (?topic=)
router.get('/versions/status-counts', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic } = req.query
  const counts = await getVersionStatusCounts(pool, req.user.qProjectId, topic)
  res.json(counts)
})

// GET /pg/versions/latest-draft/:topic/:key — latest DRAFT version for topic:key
router.get('/versions/latest-draft/:topic/:key', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
  const version = await getLatestDraftVersion(pool, qKeyId)
  res.json(version)
})

// GET /pg/versions/:topic/:key/:version — specific version
router.get('/versions/:topic/:key/:version', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key, version } = req.params

  const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
  const v = await getSpecificVersion(pool, qKeyId, parseInt(version, 10))
  res.json(v)
})

// POST /pg/versions/supersede — atomic insert + transition (Gap 3)
//
// Runs in a single PostgreSQL transaction:
//   1. INSERT the new version row (via insertVersion)
//   2. transitionVersionStatus the old row → SUPERSEDED with a forward_link
// transitionVersionStatus' WHERE clause keys on version_id (q_k{n}_v{m}), which
// is globally unique, so the previous (topic, key, project) triple guard is
// no longer needed.
//
// Must be registered before /versions to avoid the wildcard /:topic/:key route
// shadowing the literal `supersede` segment.
router.post('/versions/supersede', async (req, res) => {
  const pool = req.app.locals.pool
  const qProjectId = req.user.qProjectId
  const {
    new_version: newVersion,
    supersedes_version: supersedesVersion,
    supersedes_reason: supersedesReason,
    forward_link: forwardLink,
  } = req.body ?? {}

  if (!newVersion || typeof newVersion !== 'object') {
    return res.status(400).json({ error: 'new_version_required', message: 'new_version object required' })
  }
  if (supersedesVersion === undefined || supersedesVersion === null) {
    return res.status(400).json({ error: 'supersedes_version_required', message: 'supersedes_version required' })
  }

  const topic = newVersion.topic
  const key = newVersion.key
  if (!topic || !key) {
    return res.status(400).json({ error: 'topic_key_required', message: 'new_version.topic and new_version.key required' })
  }

  const qKeyId = await resolveKey(pool, qProjectId, topic, key)
  const version = newVersion.version
  const versionId = `${qKeyId}_v${version}`
  const oldVersionId = `${qKeyId}_v${supersedesVersion}`

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const inserted = await insertVersion(client, {
      ...newVersion,
      version_id: versionId,
      q_key_id: qKeyId,
      q_project_id: qProjectId,
      version,
      supersedes_version: supersedesVersion,
      supersedes_reason: supersedesReason ?? newVersion.supersedes_reason ?? null,
    })

    const transitioned = await transitionVersionStatus(
      client,
      oldVersionId,
      'SUPERSEDED',
      forwardLink ?? { version, author: newVersion.author, at: new Date().toISOString() },
    )

    await client.query('COMMIT')

    res.json({
      inserted: true,
      new_version: inserted,
      superseded_version: supersedesVersion,
      rows_updated: transitioned ? 1 : 0,
    })
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* swallow rollback failure */ }
    throw err
  } finally {
    client.release()
  }
})

// POST /pg/versions — insert new version (q_project_id resolved from JWT)
router.post('/versions', async (req, res) => {
  const pool = req.app.locals.pool
  const qProjectId = req.user.qProjectId
  const { topic, key } = req.body

  if (!topic || !key) {
    return res.status(400).json({ error: 'topic_key_required', message: 'topic and key required' })
  }

  const qKeyId = await resolveKey(pool, qProjectId, topic, key)
  const version = req.body.version ?? await getNextVersionNumber(pool, qKeyId)
  const versionId = `${qKeyId}_v${version}`

  const record = {
    ...req.body,
    version_id: versionId,
    q_key_id: qKeyId,
    q_project_id: qProjectId,
    version,
    agent_id:    req.body.agent_id    ?? null,
    session_id:  req.body.session_id  ?? null,
    author_type: req.body.author_type ?? 'agent',
  }

  const inserted = await insertVersion(pool, record)
  res.status(201).json(inserted)
})

// PATCH /pg/versions/:topic/:key/:version — transition status
router.patch('/versions/:topic/:key/:version', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key, version } = req.params
  const { newStatus, forwardLink } = req.body ?? {}

  if (!newStatus) return res.status(400).json({ error: 'newStatus required' })

  const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
  const versionId = `${qKeyId}_v${parseInt(version, 10)}`
  const updated = await transitionVersionStatus(pool, versionId, newStatus, forwardLink ?? null)
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
  const entry = { ...req.body, q_project_id: req.user.qProjectId }
  const written = await writeAuditEntry(pool, entry)
  res.status(201).json(written)
})

// GET /pg/audit — all entries (project-scoped)
router.get('/audit', async (req, res) => {
  const pool = req.app.locals.pool
  const opts = { ...req.query, qProjectId: req.user.qProjectId }
  const entries = await getAllEntries(pool, opts)
  res.json({ entries })
})

// GET /pg/audit/count
router.get('/audit/count', async (req, res) => {
  const pool = req.app.locals.pool
  const count = await countEntries(pool, req.user.qProjectId)
  res.json({ count })
})

// GET /pg/audit/lineage/:topic/:key — ordered audit trail for a knowledge node
router.get('/audit/lineage/:topic/:key', async (req, res) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params

  const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)

  const { rows } = await pool.query(
    `SELECT al.entry_id, al.operation, al.author, al.timestamp,
            al.outcome_json, al.governance_json, al.chain_position,
            val.version_id, val.link_type
     FROM audit_log al
     JOIN version_audit_links val ON al.entry_id = val.audit_entry_id
     WHERE val.q_key_id = $1 AND al.q_project_id = $2
     ORDER BY al.chain_position ASC`,
    [qKeyId, req.user.qProjectId],
  )
  res.json({ entries: rows })
})

// GET /pg/audit/:id
router.get('/audit/:id', async (req, res) => {
  const pool = req.app.locals.pool
  const entry = await getAuditEntry(pool, req.params.id)
  // Only return if it belongs to this project
  if (entry && entry.q_project_id !== req.user.qProjectId) {
    return res.status(404).json(null)
  }
  res.json(entry)
})

// ── Pending decisions ─────────────────────────────────────────────────────────

// GET /pg/pending — fetch pending decisions for this project
router.get('/pending', async (req, res) => {
  const pool = req.app.locals.pool
  const qProjectId = req.user.qProjectId
  const { topic, include_stale } = req.query

  // Always JOIN q_keys so we can expose conflict_topic/conflict_key on every
  // pending decision row — the MCP pending.js tool reads these for staleness
  // checks. pending_decisions has no topic/key columns of its own.
  let query = `SELECT pd.*, qk.topic AS conflict_topic, qk.key AS conflict_key
               FROM pending_decisions pd
               JOIN q_keys qk ON pd.q_key_id = qk.q_key_id`
  const params = [qProjectId]
  const conditions = [`pd.q_project_id = $1`]

  if (include_stale) {
    params.push(['pending', 'stale'])
  } else {
    params.push(['pending'])
  }
  conditions.push(`pd.status = ANY($${params.length})`)

  if (topic) {
    params.push(topic)
    conditions.push(`qk.topic = $${params.length}`)
  }

  query += ` WHERE ${conditions.join(' AND ')} ORDER BY pd.created_at ASC`
  const { rows } = await pool.query(query, params)
  res.json(rows)
})

// POST /pg/pending — insert pending decision
router.post('/pending', async (req, res) => {
  const pool = req.app.locals.pool
  const qProjectId = req.user.qProjectId
  const d = { ...req.body }

  // Accept either q_key_id directly, or resolve from (conflict_topic, conflict_key)
  let qKeyId = d.q_key_id
  if (!qKeyId) {
    const topic = d.conflict_topic ?? d.topic
    const key = d.conflict_key ?? d.key
    if (!topic || !key) {
      return res.status(400).json({ error: 'topic_key_required', message: 'q_key_id or (conflict_topic, conflict_key) required' })
    }
    qKeyId = await resolveKey(pool, qProjectId, topic, key)
  }

  // Allocate conflict_id if not provided
  let conflictId = d.conflict_id
  if (!conflictId) {
    const seq = await pool.query(`SELECT nextval('q_conflict_seq') AS n`)
    conflictId = `q_c${seq.rows[0].n}`
  }

  const { rows } = await pool.query(
    `INSERT INTO pending_decisions (
       conflict_id, q_key_id, q_project_id, decision_type, status,
       active_version_at_creation, existing_content, incoming_content, conflict_reason,
       enrichment, more_pending_same_key
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      conflictId,
      qKeyId,
      qProjectId,
      d.decision_type ?? 'conflict',
      'pending',
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
// conflict_id (q_c{n}) is globally unique — no project scope needed.
router.patch('/pending/:conflictId', async (req, res) => {
  const pool = req.app.locals.pool
  const { conflictId } = req.params
  const updates = req.body ?? {}

  // Build dynamic UPDATE — only set columns that are provided
  const allowed = [
    'status', 'resolution', 'resolution_note', 'resolved_by', 'resolved_at',
    'split_existing_key', 'split_incoming_key', 'split_existing_content', 'split_incoming_content',
    'merged_content', 'stale_warning', 'current_active_version', 'more_pending_same_key',
  ]
  const setClauses = []
  const params = [conflictId]

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
     WHERE conflict_id = $1
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
  const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
  const count = await countPendingForKey(pool, qKeyId)
  res.json({ count })
})

// GET /pg/pending/:conflictId — fetch single pending decision by conflict ID
router.get('/pending/:conflictId', async (req, res) => {
  const pool = req.app.locals.pool
  const { conflictId } = req.params
  const row = await getPendingDecisionById(pool, conflictId)
  if (row && row.q_project_id !== req.user.qProjectId) return res.status(404).json(null)
  res.json(row)
})

// ── Error handler for this router ─────────────────────────────────────────────

router.use((err, _req, res, _next) => {
  console.error('[Gateway/pg] Error:', err.message)
  res.status(500).json({ error: 'internal_error', message: err.message })
})

export default router
