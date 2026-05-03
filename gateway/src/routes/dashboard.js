/**
 * Quorum Gateway — Dashboard BFF routes.
 *
 * All routes are mounted under /api and require a valid JWT (applied by server.js).
 * Project scope is resolved from req.user.project (JWT claim).
 *
 * Routes:
 *   GET  /api/stats                    — aggregated dashboard metrics
 *   GET  /api/graph?domain=X           — knowledge graph in Cytoscape.js format
 *   GET  /api/knowledge                — paginated knowledge browser
 *   GET  /api/search?q=X               — semantic search via Graphiti
 *   POST /api/review/:conflictId       — approve / reject / request_changes
 *   POST /api/bump/:topic/:key         — confidence endorsement (dashboard version)
 */

import { Router } from 'express'
import {
  getPendingDecisionById,
  getLatestDraftVersion,
  transitionVersionStatus,
  resolvePendingDecision,
  getCurrentVersion,
  getLastBump,
  insertBump,
  updateConfidence,
} from '@as-quorum/mcp/graph/queries'
import { searchNodes } from '@as-quorum/mcp/graph/client'
import { writeAuditEntry } from '@as-quorum/mcp/audit/secondary'
import { enforceNoSelfApproval, enforceReasonRequired } from '@as-quorum/mcp/governance/constitutional'

const router = Router()

const BUMP_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
const BUMP_BASE_DELTA  = 0.05
const BUMP_ROLE_WEIGHT = {
  engineer:            0.50,
  senior_engineer:     0.70,
  tech_lead:           0.70,
  architect:           0.85,
  principal_architect: 1.00,
}

// ── GET /api/stats ─────────────────────────────────────────────────────────────

/**
 * Aggregated health metrics for the dashboard stats panel.
 * Single multi-CTE PostgreSQL query to minimise round-trips.
 */
router.get('/stats', async (req, res, next) => {
  const pool      = req.app.locals.pool
  const projectId = req.user.project ?? 'default'

  try {
    const [statsResult, activityResult] = await Promise.all([
      pool.query(
        `WITH domain_stats AS (
           SELECT topic AS domain,
                  COUNT(*) FILTER (WHERE status = 'ACTIVE')::int  AS active_count,
                  COUNT(*) FILTER (WHERE status = 'DRAFT')::int   AS draft_count,
                  ROUND(AVG(confidence) FILTER (WHERE status = 'ACTIVE')::numeric, 3)::float AS avg_confidence
           FROM knowledge_versions
           WHERE project_id = $1
           GROUP BY topic
         ),
         pending_stats AS (
           SELECT
             COUNT(*)::int                                           AS total,
             ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600)::numeric, 1)::float AS avg_age_hours,
             ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600)::numeric, 1)::float AS oldest_age_hours
           FROM pending_decisions
           WHERE project_id = $1 AND status = 'pending'
         ),
         confidence_buckets AS (
           SELECT
             COUNT(*) FILTER (WHERE confidence > 0.7)::int  AS high,
             COUNT(*) FILTER (WHERE confidence BETWEEN 0.4 AND 0.7)::int AS medium,
             COUNT(*) FILTER (WHERE confidence < 0.4)::int  AS low
           FROM knowledge_versions
           WHERE project_id = $1 AND status = 'ACTIVE'
         ),
         lowest_conf AS (
           SELECT topic, key, confidence, last_accessed_at
           FROM knowledge_versions
           WHERE project_id = $1 AND status = 'ACTIVE'
           ORDER BY confidence ASC
           LIMIT 10
         ),
         most_accessed AS (
           SELECT topic, key, confidence,
                  (SELECT COUNT(*)::int FROM audit_log
                   WHERE project_id = $1 AND tool = 'recall'
                   AND governance_json->>'topic' = knowledge_versions.topic
                   AND governance_json->>'key'   = knowledge_versions.key) AS access_count
           FROM knowledge_versions
           WHERE project_id = $1 AND status = 'ACTIVE'
           ORDER BY access_count DESC
           LIMIT 10
         )
         SELECT
           (SELECT json_agg(d) FROM domain_stats d)           AS domains,
           (SELECT row_to_json(p) FROM pending_stats p)       AS pending,
           (SELECT row_to_json(c) FROM confidence_buckets c)  AS confidence,
           (SELECT json_agg(l) FROM lowest_conf l)            AS lowest_confidence,
           (SELECT json_agg(m) FROM most_accessed m)          AS most_accessed`,
        [projectId],
      ),
      pool.query(
        `SELECT DATE(timestamp)::text AS date, COUNT(*)::int AS operation_count
         FROM audit_log
         WHERE project_id = $1 AND timestamp > NOW() - INTERVAL '30 days'
         GROUP BY DATE(timestamp)
         ORDER BY date ASC`,
        [projectId],
      ),
    ])

    const row = statsResult.rows[0]
    res.json({
      domains:           row.domains           ?? [],
      pending:           row.pending           ?? { total: 0, avg_age_hours: 0, oldest_age_hours: 0 },
      activity:          activityResult.rows,
      confidence:        row.confidence        ?? { high: 0, medium: 0, low: 0 },
      lowest_confidence: row.lowest_confidence ?? [],
      most_accessed:     row.most_accessed     ?? [],
    })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/graph ─────────────────────────────────────────────────────────────

/**
 * Knowledge graph in Cytoscape.js format.
 * Node IDs: `${topic}:${key}:${version}`
 * Edges derived from supersedes_version column (SUPERSEDES).
 *
 * Returns 400 if node count > 500 and no domain filter is provided.
 */
router.get('/graph', async (req, res, next) => {
  const pool      = req.app.locals.pool
  const projectId = req.user.project ?? 'default'
  const domain    = req.query.domain  // optional domain (= topic) filter

  try {
    // Guard: require domain filter if graph would be too large
    if (!domain) {
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM knowledge_versions
         WHERE project_id = $1 AND status = 'ACTIVE'`,
        [projectId],
      )
      if (countResult.rows[0].cnt > 500) {
        return res.status(400).json({
          error: 'graph_too_large',
          message: `Graph has ${countResult.rows[0].cnt} nodes. Specify ?domain= to filter.`,
        })
      }
    }

    const params = domain ? [projectId, domain] : [projectId]
    const domainFilter = domain ? 'AND topic = $2' : ''

    const result = await pool.query(
      `SELECT id, topic, key, version, entity_type, confidence, author, summary,
              status, supersedes_version
       FROM knowledge_versions
       WHERE project_id = $1 AND status = 'ACTIVE' ${domainFilter}
       ORDER BY topic, key, version`,
      params,
    )

    const rows = result.rows

    // Build a lookup: topic:key:version → node
    const nodeMap = new Map(rows.map((r) => [`${r.topic}:${r.key}:${r.version}`, r]))

    // Build edges from supersedes_version — join within the result set
    // Each ACTIVE node that has supersedes_version points back to the version it replaced.
    // We include SUPERSEDED edges even if the superseded node is not in the result set
    // (it may be filtered out as SUPERSEDED status), but we only emit the edge if both
    // ends exist in the current node set.
    const edges = []
    for (const row of rows) {
      if (row.supersedes_version != null) {
        const targetId = `${row.topic}:${row.key}:${row.supersedes_version}`
        if (nodeMap.has(targetId)) {
          edges.push({
            data: {
              id:     `${row.topic}:${row.key}:${row.version}→${row.supersedes_version}`,
              source: `${row.topic}:${row.key}:${row.version}`,
              target: targetId,
              type:   'SUPERSEDES',
            },
          })
        }
      }
    }

    res.json({
      nodes: rows.map((r) => ({
        data: {
          id:          `${r.topic}:${r.key}:${r.version}`,
          topic:       r.topic,
          key:         r.key,
          entity_type: r.entity_type,
          confidence:  r.confidence,
          author:      r.author,
          summary:     r.summary || `${r.topic}:${r.key}`,
          status:      r.status,
        },
      })),
      edges,
    })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/knowledge ─────────────────────────────────────────────────────────

/**
 * Paginated knowledge browser with optional filters.
 *
 * Query params: domain, tag, entity_type, page (default 1), limit (default 20, max 100)
 */
router.get('/knowledge', async (req, res, next) => {
  const pool      = req.app.locals.pool
  const projectId = req.user.project ?? 'default'

  const domain      = req.query.domain
  const tag         = req.query.tag
  const entityType  = req.query.entity_type
  const page        = Math.max(1, parseInt(req.query.page  ?? '1',  10))
  const limit       = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '20', 10)))
  const offset      = (page - 1) * limit

  try {
    const conditions = ['project_id = $1', "status = 'ACTIVE'"]
    const params     = [projectId]
    let   idx        = 2

    if (domain) {
      conditions.push(`topic = $${idx++}`)
      params.push(domain)
    }
    if (entityType) {
      conditions.push(`entity_type = $${idx++}`)
      params.push(entityType)
    }
    if (tag) {
      conditions.push(`$${idx++} = ANY(tags)`)
      params.push(tag.toLowerCase().trim())
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `SELECT topic, key, entity_type, confidence, author, tags, created_at AS updated_at, version
         FROM knowledge_versions
         WHERE ${where}
         ORDER BY confidence DESC, created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM knowledge_versions WHERE ${where}`,
        params,
      ),
    ])

    const total = countResult.rows[0].total
    res.json({
      items: dataResult.rows,
      total,
      page,
      pages: Math.ceil(total / limit),
    })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/search ────────────────────────────────────────────────────────────

/**
 * Semantic search via Graphiti. Maps Graphiti node results to dashboard format.
 */
router.get('/search', async (req, res, next) => {
  const projectId = req.user.project ?? 'default'
  const query     = req.query.q
  const domain    = req.query.domain
  const limit     = Math.min(50, Math.max(1, parseInt(req.query.limit ?? '10', 10)))

  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'query_required', message: 'q must be at least 2 characters' })
  }

  try {
    const graphitiResult = await searchNodes(
      domain ? `[${domain}] ${query}` : query,
      { groupId: projectId, limit },
    )

    const nodes = graphitiResult?.nodes ?? graphitiResult?.results ?? []

    res.json({
      results: nodes.map((n) => ({
        topic:       n.topic       ?? n.group_id ?? '',
        key:         n.key         ?? n.name     ?? '',
        entity_type: n.entity_type ?? 'unknown',
        summary:     n.summary     ?? n.name     ?? '',
        confidence:  n.confidence  ?? null,
        score:       n.score       ?? n.distance ?? null,
        author:      n.author      ?? null,
        updated_at:  n.created_at  ?? n.updated_at ?? null,
      })),
    })
  } catch (err) {
    next(err)
  }
})

// ── POST /api/review/:conflictId ───────────────────────────────────────────────

/**
 * Full review flow — approve, reject, or request changes on a pending decision.
 *
 * Constitutional guarantees enforced:
 *   - Rule 3: note required (min 10 chars)
 *   - Rule 4: reviewer cannot be the author of the DRAFT version
 *
 * All state transitions (pending_decisions + knowledge_versions) run in a single
 * pg client transaction so they are atomic.
 */
router.post('/review/:conflictId', async (req, res, next) => {
  const pool       = req.app.locals.pool
  const projectId  = req.user.project ?? 'default'
  const reviewer   = req.user.sub
  const reviewerRole = req.user.role ?? 'engineer'
  const { conflictId } = req.params
  const { action, note } = req.body

  // Validate inputs
  if (!['approve', 'reject', 'request_changes'].includes(action)) {
    return res.status(400).json({ error: 'invalid_action', message: 'action must be approve | reject | request_changes' })
  }

  try {
    // Constitutional Rule 3: note required
    enforceReasonRequired(note, 'review')
  } catch (err) {
    return res.status(400).json({ error: 'note_required', message: err.message })
  }

  try {
    const decision = await getPendingDecisionById(pool, conflictId)
    if (!decision) {
      return res.status(404).json({ error: 'not_found', message: `No pending decision with id ${conflictId}` })
    }

    // Scope check
    if (decision.project_id !== projectId) {
      return res.status(403).json({ error: 'forbidden', message: 'Decision belongs to a different project' })
    }

    // Get the DRAFT version to check authorship
    const draftVersion = await getLatestDraftVersion(pool, decision.conflict_topic, decision.conflict_key, projectId)

    // Constitutional Rule 4: no self-approval
    if (draftVersion?.author) {
      try {
        enforceNoSelfApproval(draftVersion.author, reviewer, 'review')
      } catch (err) {
        return res.status(403).json({ error: 'self_approval_blocked', message: err.message })
      }
    }

    // Staleness detection: has the ACTIVE version advanced since this decision was raised?
    const currentActive = await getCurrentVersion(pool, decision.conflict_topic, decision.conflict_key, projectId)
    const staleWarning = (
      currentActive &&
      decision.active_version_at_creation != null &&
      currentActive.version > decision.active_version_at_creation
    )
      ? `Active version is now v${currentActive.version}; this decision was raised against v${decision.active_version_at_creation}.`
      : null

    const resolutionMap = {
      approve:         'supersede',
      reject:          'reject',
      request_changes: null,
    }

    if (action === 'request_changes') {
      // Does not resolve — stays PENDING, note stored in stale_warning field
      await pool.query(
        `UPDATE pending_decisions
         SET stale_warning = $1, updated_at = NOW()
         WHERE conflict_id = $2`,
        [`[${reviewer}] ${note}`, conflictId],
      )
      await writeAuditEntry(pool, {
        operation:    'OUTCOME',
        tool:         'review',
        author:       reviewer,
        author_role:  reviewerRole,
        project_id:   projectId,
        governance_json: { action, note, conflict_id: conflictId },
        outcome_json:    { status: 'changes_requested', topic: decision.conflict_topic, key: decision.conflict_key },
        version_impact:  { versions_created: [], versions_superseded: [] },
      })
      return res.json({
        status:      'changes_requested',
        conflict_id: conflictId,
        reviewer,
        note,
        stale_warning: staleWarning,
      })
    }

    // approve / reject — run in a transaction
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      if (action === 'approve' && draftVersion) {
        const forwardLink = {
          superseded_by_version: draftVersion.version,
          superseded_by_author:  reviewer,
          superseded_at:         new Date().toISOString(),
        }
        await transitionVersionStatus(
          client,
          decision.conflict_topic,
          decision.conflict_key,
          draftVersion.version,
          'ACTIVE',
          forwardLink,
          projectId,
        )
      } else if (action === 'reject' && draftVersion) {
        await transitionVersionStatus(
          client,
          decision.conflict_topic,
          decision.conflict_key,
          draftVersion.version,
          'REJECTED',
          null,
          projectId,
        )
      }

      await resolvePendingDecision(client, conflictId, {
        status:     'resolved',
        resolution: resolutionMap[action],
        note,
        resolvedBy: reviewer,
      })

      await client.query('COMMIT')
    } catch (txErr) {
      await client.query('ROLLBACK')
      throw txErr
    } finally {
      client.release()
    }

    await writeAuditEntry(pool, {
      operation:    'OUTCOME',
      tool:         'review',
      author:       reviewer,
      author_role:  reviewerRole,
      project_id:   projectId,
      governance_json: { action, note, conflict_id: conflictId },
      outcome_json: {
        status:  action === 'approve' ? 'approved' : 'rejected',
        topic:   decision.conflict_topic,
        key:     decision.conflict_key,
        version: draftVersion?.version ?? null,
      },
      version_impact: {
        versions_created:    action === 'approve' ? [`${decision.conflict_topic}:${decision.conflict_key}:${draftVersion?.version}`] : [],
        versions_superseded: action === 'approve' && currentActive ? [`${decision.conflict_topic}:${decision.conflict_key}:${currentActive.version}`] : [],
      },
    })

    res.json({
      status:      action === 'approve' ? 'approved' : 'rejected',
      conflict_id: conflictId,
      topic:       decision.conflict_topic,
      key:         decision.conflict_key,
      version:     draftVersion?.version ?? null,
      reviewer,
      note,
      stale_warning: staleWarning,
    })
  } catch (err) {
    next(err)
  }
})

// ── POST /api/bump/:topic/:key ─────────────────────────────────────────────────

/**
 * Dashboard bump endpoint — reads project from JWT claim (no X-Quorum-Token needed).
 * Matches the mechanic in routes/bump.js but uses req.user.project for scope.
 */
router.post('/bump/:topic/:key', async (req, res, next) => {
  const pool       = req.app.locals.pool
  const projectId  = req.user.project ?? 'default'
  const caller     = req.user.sub
  const callerRole = req.user.role ?? 'engineer'
  const { topic, key } = req.params

  try {
    const existing = await getCurrentVersion(pool, topic, key, projectId)
    if (!existing) {
      return res.status(404).json({ error: 'not_found', message: `No ACTIVE knowledge at ${topic}:${key}` })
    }

    const lastBump = await getLastBump(pool, caller, topic, key, projectId)
    if (lastBump) {
      const elapsed = Date.now() - new Date(lastBump.bumped_at).getTime()
      if (elapsed < BUMP_COOLDOWN_MS) {
        const nextAllowed = new Date(new Date(lastBump.bumped_at).getTime() + BUMP_COOLDOWN_MS).toISOString()
        return res.status(429).json({
          error:              'cooldown_active',
          message:            `Bump cooldown active — next allowed at ${nextAllowed}`,
          next_bump_allowed:  nextAllowed,
        })
      }
    }

    const weight       = BUMP_ROLE_WEIGHT[callerRole] ?? BUMP_ROLE_WEIGHT.engineer
    const delta        = BUMP_BASE_DELTA * weight
    const currentConf  = existing.confidence        ?? 0.7
    const startingConf = existing.starting_confidence ?? currentConf
    const newConf      = Math.min(startingConf, currentConf + delta)

    await Promise.all([
      insertBump(pool, { author: caller, topic, key, projectId, role: callerRole, deltaApplied: delta }),
      updateConfidence(pool, existing.id, newConf),
    ])

    res.json({
      topic,
      key,
      project_id:          projectId,
      bumped_by:           caller,
      role:                callerRole,
      delta_applied:       parseFloat(delta.toFixed(4)),
      confidence_before:   parseFloat(currentConf.toFixed(4)),
      confidence_after:    parseFloat(newConf.toFixed(4)),
      starting_confidence: parseFloat(startingConf.toFixed(4)),
      clock_reset:         true,
      next_bump_allowed:   new Date(Date.now() + BUMP_COOLDOWN_MS).toISOString(),
    })
  } catch (err) {
    next(err)
  }
})

export default router
