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
 *
 *   POST /pg/scans                            → record a scan run (project_scans table)
 */

import { createHash } from 'node:crypto'
import { Router } from 'express'
import { verifyJwt } from '../middleware/verify-jwt.js'
import { validateKnowledgeInput, ValidationError } from '../shared/graph/validate.js'
import { enforceReasonRequired } from '../shared/governance/constitutional.js'
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
import { verifyChain, ChainIntegrityViolation } from '../shared/audit/chain.js'

const router = Router()

// All pg routes require a valid JWT
router.use(verifyJwt)

// ── Admin-only unscoped routes — registered BEFORE project-scope middleware ───
// These operate on the global audit chain, not a project-scoped subset.

// GET /pg/audit/verify — server-side chain integrity verification (admin-only)
// E2E: tests/e2e/scenarios/10-audit-chain.spec.js — S-10.11 step 1+2 (chain verify + 403 gate)
router.get('/audit/verify', async (req, res, next) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'forbidden' })
  const pool = req.app.locals.pool
  try {
    const { rows } = await pool.query('SELECT * FROM audit_log ORDER BY chain_position ASC')
    try {
      const result = verifyChain(rows)
      res.json(result)
    } catch (err) {
      if (err instanceof ChainIntegrityViolation) {
        res.json({
          verified:  false,
          entries:   rows.length,
          broken_at: { position: err.position, expected: err.expected, actual: err.actual },
        })
      } else {
        next(err)
      }
    }
  } catch (err) { next(err) }
})

// GET /pg/audit/export?format=ndjson — compliance export (admin-only)
// Returns all audit entries as newline-delimited JSON. Suitable for archival,
// compliance handoff, and external chain verification tooling.
// E2E: tests/e2e/scenarios/10-audit-chain.spec.js — S-10.12 (NDJSON fields + admin gate)
router.get('/audit/export', async (req, res, next) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'forbidden' })
  const { format = 'ndjson' } = req.query
  if (format !== 'ndjson') {
    return res.status(400).json({ error: 'unsupported_format', message: 'Only format=ndjson is supported' })
  }
  const pool = req.app.locals.pool
  try {
    const { rows } = await pool.query('SELECT * FROM audit_log ORDER BY chain_position ASC')
    res.setHeader('Content-Type', 'application/x-ndjson')
    res.send(rows.map(r => JSON.stringify(r)).join('\n'))
  } catch (err) { next(err) }
})

// All pg routes are project-scoped — X-Quorum-Project header required.
// Non-members of private projects (access_denied set by verify-jwt.js) are blocked here.
router.use((req, res, next) => {
  if (!req.user.project) {
    return res.status(400).json({ error: 'X-Quorum-Project header required' })
  }
  if (req.user.access_denied) {
    return res.status(403).json({ error: 'forbidden', message: 'Access denied to this project' })
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
router.get('/search', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { q, domain, limit = 10 } = req.query

  if (!q) {
    return res.status(400).json({ error: 'missing_param', message: 'q required' })
  }

  try {
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
  } catch (err) {
    next(err)
  }
})

// ── Knowledge versions ─────────────────────────────────────────────────────────
//
// IMPORTANT: static-prefix routes must be registered BEFORE /versions/:topic/:key.
// Both /versions/by-status/:status and /versions/by-tag/:tag are 3-segment paths
// that Express would match as /:topic/:key if the wildcard route were first.

// GET /pg/versions/by-status/:status — versions with a given status (?topic=)
router.get('/versions/by-status/:status', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { status } = req.params
  const { topic } = req.query
  try {
    const rows = await getVersionsByStatus(pool, status, req.user.qProjectId, topic)
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// GET /pg/versions/by-tag/:tag — versions with this tag (project-scoped)
router.get('/versions/by-tag/:tag', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { tag } = req.params
  try {
    const versions = await getVersionsByTag(pool, tag, req.user.qProjectId)
    res.json(versions)
  } catch (err) {
    next(err)
  }
})

// GET /pg/versions/:topic/:key — current ACTIVE version (project-scoped)
router.get('/versions/:topic/:key', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  try {
    const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
    const version = await getCurrentVersion(pool, qKeyId)
    res.json(version)
  } catch (err) {
    next(err)
  }
})

// GET /pg/versions/:topic/:key/history — all versions
router.get('/versions/:topic/:key/history', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  try {
    const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
    const history = await getVersionHistory(pool, qKeyId)
    res.json(history)
  } catch (err) { next(err) }
})

// GET /pg/versions/:topic/:key/at?date=ISO — point-in-time version
router.get('/versions/:topic/:key/at', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  const { date } = req.query

  if (!date) return res.status(400).json({ error: 'date query param required' })
  try {
    const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
    const version = await getVersionAtDate(pool, qKeyId, date)
    res.json(version)
  } catch (err) { next(err) }
})

// GET /pg/versions/:topic/:key/next-number
router.get('/versions/:topic/:key/next-number', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  try {
    const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
    const nextNum = await getNextVersionNumber(pool, qKeyId)
    res.json({ next_version: nextNum })
  } catch (err) { next(err) }
})

// GET /pg/versions/drafts — all DRAFT versions (project-scoped, optional ?topic=)
router.get('/versions/drafts', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { topic } = req.query
  try {
    const rows = await getDraftVersions(pool, { qProjectId: req.user.qProjectId, topic })
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /pg/versions/status-counts — version counts grouped by status (?topic=)
router.get('/versions/status-counts', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { topic } = req.query
  try {
    const counts = await getVersionStatusCounts(pool, req.user.qProjectId, topic)
    res.json(counts)
  } catch (err) { next(err) }
})

// GET /pg/versions/latest-draft/:topic/:key — latest DRAFT version for topic:key
router.get('/versions/latest-draft/:topic/:key', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  try {
    const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
    const version = await getLatestDraftVersion(pool, qKeyId)
    res.json(version)
  } catch (err) { next(err) }
})

// GET /pg/versions/:topic/:key/:version — specific version
router.get('/versions/:topic/:key/:version', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { topic, key, version } = req.params
  try {
    const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
    const v = await getSpecificVersion(pool, qKeyId, parseInt(version, 10))
    res.json(v)
  } catch (err) { next(err) }
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
router.post('/versions/supersede', async (req, res, next) => {
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

  // Constitutional Rule 3: supersedes_reason must be meaningful (min 10 chars, no placeholder patterns)
  // E2E: tests/e2e/scenarios/15-reason-placeholder.spec.js — S-15 REASON_REQUIRED on pg-versions-supersede
  try {
    enforceReasonRequired(supersedesReason, 'pg-versions-supersede')
  } catch (err) {
    return next(err)
  }

  try {
    validateKnowledgeInput({
      topic:       newVersion.topic,
      key:         newVersion.key,
      content:     newVersion.summary,   // same field mapping: summary → content
      entity_type: newVersion.entity_type,
      ...('tags'        in newVersion && { tags:       newVersion.tags }),
      ...('confidence'  in newVersion && { confidence: newVersion.confidence }),
      ...(supersedesReason != null    && { reason:     supersedesReason }),
    }, { requireReason: true })
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: 'validation_error', field: err.field, message: err.message })
    }
    return next(err)
  }

  let client
  try {
    const qKeyId = await resolveKey(pool, qProjectId, topic, key)
    const version = newVersion.version
    const versionId = `${qKeyId}_v${version}`
    const oldVersionId = `${qKeyId}_v${supersedesVersion}`

    client = await pool.connect()
    await client.query('BEGIN')

    const supersedeContent = newVersion.summary ?? newVersion.content ?? ''
    const supersedeHash    = newVersion.content_hash ?? createHash('sha256').update(supersedeContent).digest('hex')

    const inserted = await insertVersion(client, {
      ...newVersion,
      content_hash:      supersedeHash,
      triggered_by:      newVersion.triggered_by ?? 'mcp',
      version_id:        versionId,
      q_key_id:          qKeyId,
      q_project_id:      qProjectId,
      version,
      supersedes_version: supersedesVersion,
      supersedes_reason:  supersedesReason ?? newVersion.supersedes_reason ?? null,
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
    if (client) { try { await client.query('ROLLBACK') } catch { /* swallow rollback failure */ } }
    next(err)
  } finally {
    if (client) client.release()
  }
})

// POST /pg/versions — insert new version (q_project_id resolved from JWT)
router.post('/versions', async (req, res, next) => {
  const pool = req.app.locals.pool
  const qProjectId = req.user.qProjectId
  const { topic, key } = req.body

  if (!topic || !key) {
    return res.status(400).json({ error: 'topic_key_required', message: 'topic and key required' })
  }

  // Validate supersedes_reason if provided — same Constitutional Rule 3 as the supersede route.
  if (req.body.supersedes_reason !== undefined && req.body.supersedes_reason !== null) {
    try {
      enforceReasonRequired(req.body.supersedes_reason, 'pg-versions-supersede')
    } catch (err) {
      return next(err)
    }
  }

  try {
    validateKnowledgeInput({
      topic:       req.body.topic,
      key:         req.body.key,
      content:     req.body.summary,   // MCP sends 'summary'; map to 'content' for validate
      entity_type: req.body.entity_type,
      ...('tags'       in req.body && { tags:       req.body.tags }),
      ...('confidence' in req.body && { confidence: req.body.confidence }),
    })
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: 'validation_error', field: err.field, message: err.message })
    }
    throw err
  }

  try {
    const qKeyId = await resolveKey(pool, qProjectId, topic, key)
    const version = req.body.version ?? await getNextVersionNumber(pool, qKeyId)
    const versionId = `${qKeyId}_v${version}`

    // Status authority — gateway derives status from role + project config.
    // Never accept status from the client; the gateway is the single authority.
    // E2E: tests/e2e/scenarios/05-rbac-boundary.spec.js — S-05.1 role-based status derivation
    const { rows: [projRow] } = await pool.query(
      'SELECT is_global FROM q_projects WHERE q_project_id = $1',
      [qProjectId],
    )
    const isGlobal  = projRow?.is_global === true
    const isAdmin   = req.user.is_admin === true
    const isPA      = req.user.role === 'principal_architect' || isAdmin
    const isReflect = (req.body.triggered_by ?? '') === 'reflect'

    // PENDING_CONFLICT_CHECK: MCP sends a flag (not a literal status) when
    // Graphiti was unavailable — the recheck-conflicts job will promote it later.
    //
    // Status derivation (MCP/pg path):
    //   reflect writes      → DRAFT (Graphiti-sourced, always needs human review)
    //   non-PA/non-admin    → DRAFT
    //   is_admin            → ACTIVE even for global catalogs (platform admin bootstrap)
    //   PA + global catalog → DRAFT  (self-approval prevention; dashboard path enforces same rule)
    //   PA + non-global     → ACTIVE
    // E2E: tests/e2e/scenarios/11-self-approval.spec.js — S-11.1 global catalog DRAFT enforcement
    const status = req.body.pending_conflict_check === true
      ? 'PENDING_CONFLICT_CHECK'
      : (isReflect || !isPA)       ? 'DRAFT'
      : isAdmin                    ? 'ACTIVE'
      : (isGlobal)                 ? 'DRAFT'
      : 'ACTIVE'

    // Whitelist allowed fields from req.body — never accept status, author,
    // author_role, chain_position, entry_hash, previous_hash, q_project_id, or q_key_id
    // from the client. author and author_role are always pinned to the JWT claims.
    const contentStr  = req.body.summary ?? req.body.content ?? ''
    const contentHash = req.body.content_hash ?? createHash('sha256').update(contentStr).digest('hex')

    const record = {
      content:      req.body.content      ?? undefined,
      summary:      req.body.summary      ?? req.body.content ?? undefined,
      topic:        req.body.topic,
      key:          req.body.key,
      domain:       req.body.domain       ?? undefined,
      tags:         req.body.tags         ?? undefined,
      confidence:   req.body.confidence   ?? undefined,
      agent_id:     req.body.agent_id     ?? null,
      session_id:   req.body.session_id   ?? null,
      author_type:  req.body.author_type  ?? 'agent',
      triggered_by: req.body.triggered_by ?? 'mcp',
      entity_type:  req.body.entity_type  ?? undefined,
      content_hash: contentHash,
      status,       // Server-side derived — always overrides any client-supplied value
      // Server-side — always override from JWT, never from body.
      // Exception: is_admin may override author/author_role for test seeding and bootstrapping.
      author:       isAdmin ? (req.body.author      ?? req.user.sub)              : req.user.sub,
      author_role:  isAdmin ? (req.body.author_role ?? req.user.role ?? 'engineer') : (req.user.role ?? 'engineer'),
      // Resolved server-side
      version_id:   versionId,
      q_key_id:     qKeyId,
      q_project_id: qProjectId,
      version,
    }

    const inserted = await insertVersion(pool, record)
    res.status(201).json(inserted)
  } catch (err) { next(err) }
})

// PATCH /pg/versions/:topic/:key/:version — transition status
const VALID_VERSION_STATUSES = ['ACTIVE', 'DRAFT', 'SUPERSEDED', 'DEPRECATED', 'PENDING_CONFLICT_CHECK']

router.patch('/versions/:topic/:key/:version', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { topic, key, version } = req.params
  const { newStatus, forwardLink } = req.body ?? {}

  if (!newStatus) return res.status(400).json({ error: 'newStatus required' })

  // Validate newStatus is a legal enum value
  if (!VALID_VERSION_STATUSES.includes(newStatus)) {
    return res.status(400).json({
      error: 'invalid_status',
      message: `newStatus must be one of: ${VALID_VERSION_STATUSES.join(', ')}`,
    })
  }

  // Only principal_architect or is_admin can transition a version to ACTIVE
  if (newStatus === 'ACTIVE') {
    const isPA    = req.user.role === 'principal_architect'
    const isAdmin = req.user.is_admin === true
    if (!isPA && !isAdmin) {
      return res.status(403).json({
        error:   'forbidden',
        message: 'principal_architect role required to set status ACTIVE',
      })
    }
  }

  try {
    const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
    const versionId = `${qKeyId}_v${parseInt(version, 10)}`
    const updated = await transitionVersionStatus(pool, versionId, newStatus, forwardLink ?? null)
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

// ── Version-audit links ────────────────────────────────────────────────────────

// POST /pg/audit-links
router.post('/audit-links', async (req, res, next) => {
  const pool = req.app.locals.pool
  try {
    await insertVersionAuditLink(pool, req.body)
    res.status(201).json({ ok: true })
  } catch (err) { next(err) }
})

// ── Audit log ─────────────────────────────────────────────────────────────────

// POST /pg/audit — write audit entry
router.post('/audit', async (req, res, next) => {
  const pool = req.app.locals.pool
  // Whitelist allowed fields — strip chain_position, entry_hash, previous_hash,
  // and any other fields that could be used to forge audit chain integrity.
  // author and author_role are always pinned to the JWT claims.
  const entry = {
    operation:       req.body.operation       ?? undefined,
    tool:            req.body.tool            ?? undefined,
    content_hash:    req.body.content_hash    ?? undefined,
    governance_json: req.body.governance_json ?? undefined,
    outcome_json:    req.body.outcome_json    ?? undefined,
    version_impact:  req.body.version_impact  ?? undefined,
    session_id:      req.body.session_id      ?? undefined,
    version_id:      req.body.version_id      ?? undefined,
    // Server-side — always override from JWT, never from body
    author:          req.user.sub,
    author_role:     req.user.role,
    q_project_id:    req.user.qProjectId,
  }
  try {
    const written = await writeAuditEntry(pool, entry)
    res.status(201).json(written)
  } catch (err) {
    next(err)
  }
})

// GET /pg/audit — all entries (project-scoped)
// E2E: tests/e2e/scenarios/09-audit-trail.spec.js
//   S-09.1 step 1 — write creates audit entries (tool=dashboard-create filter)
//   S-09.2 — entry shape (chain + metadata fields present)
//   S-09.3 — hash field structural integrity (64-char hex, non-negative chain_position)
//   S-09.4 — author filter (exact match)
//   S-09.5 — tool filter (exact match, not prefix)
//   S-09.6 — limit parameter
router.get('/audit', async (req, res, next) => {
  const pool = req.app.locals.pool
  const opts = { ...req.query, qProjectId: req.user.qProjectId }
  try {
    const entries = await getAllEntries(pool, opts)
    res.json({ entries })
  } catch (err) { next(err) }
})

// GET /pg/audit/count
// E2E: tests/e2e/scenarios/09-audit-trail.spec.js — S-09.1 step 2 (project-scoped count > 0)
router.get('/audit/count', async (req, res, next) => {
  const pool = req.app.locals.pool
  try {
    const count = await countEntries(pool, req.user.qProjectId)
    res.json({ count })
  } catch (err) { next(err) }
})

// GET /pg/audit/lineage/:topic/:key — ordered audit trail for a knowledge node
// E2E: tests/e2e/scenarios/09-audit-trail.spec.js — S-09.8 step 1
//   (dashboard writes don't populate version_audit_links → returns { entries: [] })
router.get('/audit/lineage/:topic/:key', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  try {
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
  } catch (err) { next(err) }
})

// GET /pg/audit/:id
// E2E: tests/e2e/scenarios/09-audit-trail.spec.js — S-09.7
//   (returns 200+entry for valid ID; 200+null for nonexistent UUID; 404 only for cross-project IDs)
router.get('/audit/:id', async (req, res, next) => {
  const pool = req.app.locals.pool
  try {
    const entry = await getAuditEntry(pool, req.params.id)
    // Only return if it belongs to this project
    if (entry && entry.q_project_id !== req.user.qProjectId) {
      return res.status(404).json(null)
    }
    res.json(entry)
  } catch (err) { next(err) }
})

// ── Pending decisions ─────────────────────────────────────────────────────────

// GET /pg/pending — fetch pending decisions for this project
router.get('/pending', async (req, res, next) => {
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
  try {
    const { rows } = await pool.query(query, params)
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /pg/pending — insert pending decision
router.post('/pending', async (req, res, next) => {
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
    try {
      qKeyId = await resolveKey(pool, qProjectId, topic, key)
    } catch (err) { return next(err) }
  }

  // Allocate conflict_id if not provided
  let conflictId = d.conflict_id
  try {
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
  } catch (err) { next(err) }
})

// PATCH /pg/pending/:conflictId — update pending decision (resolve / stale)
// Scoped to caller's project — engineers from another project cannot update a
// conflict they don't own even if they know the conflict_id.
router.patch('/pending/:conflictId', async (req, res, next) => {
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
  const params = [conflictId, req.user.qProjectId]

  for (const col of allowed) {
    if (Object.prototype.hasOwnProperty.call(updates, col)) {
      params.push(updates[col])
      setClauses.push(`${col} = $${params.length}`)
    }
  }
  if (setClauses.length === 0) return res.status(400).json({ error: 'No updatable fields provided' })

  setClauses.push(`updated_at = NOW()`)

  try {
    const { rows } = await pool.query(
      `UPDATE pending_decisions SET ${setClauses.join(', ')}
       WHERE conflict_id = $1 AND q_project_id = $2
       RETURNING *`,
      params,
    )
    if (!rows[0]) return res.status(404).json({ error: 'Pending decision not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// GET /pg/pending/count/:topic/:key — count pending for topic:key
router.get('/pending/count/:topic/:key', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { topic, key } = req.params
  try {
    const qKeyId = await resolveKey(pool, req.user.qProjectId, topic, key)
    const count = await countPendingForKey(pool, qKeyId)
    res.json({ count })
  } catch (err) { next(err) }
})

// GET /pg/pending/:conflictId — fetch single pending decision by conflict ID
router.get('/pending/:conflictId', async (req, res, next) => {
  const pool = req.app.locals.pool
  const { conflictId } = req.params
  try {
    const row = await getPendingDecisionById(pool, conflictId)
    if (row && row.q_project_id !== req.user.qProjectId) return res.status(404).json(null)
    res.json(row)
  } catch (err) { next(err) }
})

// POST /pg/scans — record a scan run in project_scans.
// Used by the quorum:scan skill (via MCP) and by E2E seed helpers to advance
// scan_count above 0 so getConformanceScore can produce a CERTIFIED result.
// E2E: tests/e2e/scenarios/05-conformance-scoring.spec.js — S-05.2 beforeAll (advances scan_count)
router.post('/scans', async (req, res, next) => {
  const pool       = req.app.locals.pool
  const qProjectId = req.user.qProjectId
  const d          = req.body ?? {}
  const scanType   = d.scan_type ?? 'full'
  if (!['full', 'incremental'].includes(scanType)) {
    return res.status(400).json({ error: 'invalid_scan_type', message: "scan_type must be 'full' or 'incremental'" })
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO project_scans
         (q_project_id, scan_type, triggered_by, files_scanned,
          deviations_new, deviations_confirmed, deviations_resolved, candidates_surfaced)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        qProjectId,
        scanType,
        d.triggered_by         ?? 'agent',
        d.files_scanned        ?? null,
        d.deviations_new       ?? 0,
        d.deviations_confirmed ?? 0,
        d.deviations_resolved  ?? 0,
        d.candidates_surfaced  ?? 0,
      ],
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// POST /pg/deviation-actions — test-only seeding endpoint: inserts a defer action with an
// arbitrary (past-dated) defer_until so E2E helpers can create OVERDUE state without
// triggering enforceValidDeferDeadline, which blocks past dates on the normal API path.
//
// Security hardening:
//   - Refused entirely in production (NODE_ENV === 'production' → 404)
//   - action_type restricted to 'defer' only — the only bypass this endpoint needs
//   - actor/actor_role derived from the JWT, never body-supplied (prevents audit forgery)
//   - Ownership check: deviation must belong to the requesting project
// E2E: tests/e2e/scenarios/04-deviation-governance.spec.js — S-04.9 overdue deferrals seeding
router.post('/deviation-actions', async (req, res, next) => {
  // Refuse in production — this endpoint exists solely for E2E test seeding
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'not_found' })
  }
  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'forbidden', message: 'admin required' })
  }
  const pool = req.app.locals.pool
  const { deviation_id, defer_until, reason } = req.body ?? {}
  if (!deviation_id || !defer_until || !reason) {
    return res.status(400).json({ error: 'missing_fields', message: 'deviation_id, defer_until, reason required' })
  }
  // actor/actor_role always derived from the JWT — never accepted from the body
  const actor      = req.user.sub
  const actor_role = req.user.role ?? 'principal_architect'
  try {
    // Ownership check: the deviation must belong to the requesting project
    const { rows: devRows } = await pool.query(
      'SELECT q_project_id FROM deviations WHERE deviation_id = $1',
      [deviation_id],
    )
    if (!devRows[0]) return res.status(404).json({ error: 'deviation_not_found' })
    if (devRows[0].q_project_id !== req.user.qProjectId) {
      return res.status(403).json({ error: 'forbidden', message: 'deviation belongs to a different project' })
    }
    const { rows } = await pool.query(
      `INSERT INTO deviation_actions (deviation_id, action_type, defer_until, actor, actor_role, reason)
       VALUES ($1, 'defer', $2, $3, $4, $5)
       RETURNING *`,
      [deviation_id, defer_until, actor, actor_role, reason],
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// ── Error handler for this router ─────────────────────────────────────────────

router.use((err, _req, res, _next) => {
  // Constitutional violations — always 400 with { rule, message }
  if (err.name === 'ConstitutionalViolation') {
    return res.status(400).json({ rule: err.rule, message: err.message })
  }
  const status = err.status ?? 500
  console.error('[Gateway/pg] Error:', err.message, err.stack)
  const message = status >= 500 ? 'Internal server error' : err.message
  res.status(status).json({ error: err.code?.toLowerCase() ?? 'internal_error', message })
})

export default router
