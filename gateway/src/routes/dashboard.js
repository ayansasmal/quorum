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
  getProjectByGroupId,
  getOrCreateKey,
  getPendingDecisionById,
  getLatestDraftVersion,
  transitionVersionStatus,
  resolvePendingDecision,
  getCurrentVersion,
  getVersionForBump,
  getBumpLog,
  recordBump,
  updateConfidence,
  getNextVersionNumber,
  insertVersion,
} from '../shared/graph/queries.js'
import { searchNodes, searchFacts } from '../shared/graph/client.js'
import { writeAuditEntry } from '../shared/audit/secondary.js'
import { enforceNoSelfApproval, enforceReasonRequired } from '../shared/governance/constitutional.js'
import { validateKnowledgeInput, ValidationError } from '../shared/graph/validate.js'
import { createHash } from 'node:crypto'

const router = Router()

/**
 * Per-IP rate limiter for PE knowledge write endpoints (10 writes/min/IP).
 * Uses a simple in-memory sliding window — not cluster-safe but sufficient for
 * single-instance dashboard BFF usage.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export const peWriteLimit = (req, res, next) => {
  const ip = req.ip ?? 'unknown'
  const now = Date.now()
  const window = 60_000
  const max = 10
  if (!peWriteLimit._windows) peWriteLimit._windows = new Map()
  const hits = (peWriteLimit._windows.get(ip) ?? []).filter((t) => t > now - window)
  hits.push(now)
  peWriteLimit._windows.set(ip, hits)
  if (hits.length > max) {
    return res.status(429).json({ error: 'write_rate_limit', message: 'Too many write requests — 10/min per IP' })
  }
  next()
}

/**
 * Sends 403 if the request user is not a principal_architect.
 * Returns true if the check passed (caller should return if false).
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @returns {boolean}
 */
function requirePrincipalArchitect(req, res) {
  if (req.user.role !== 'principal_architect') {
    res.status(403).json({ error: 'forbidden', message: 'principal_architect role required' })
    return false
  }
  return true
}

/**
 * Resolve req.user.project (group_id) → q_project_id, sending a 404 if the
 * project is not registered. Returns the q_project_id string on success, or
 * `null` if the response has already been ended (caller should return).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<string | null>}
 */
async function resolveQProjectId(req, res) {
  const pool = req.app.locals.pool
  const header = req.user.project ?? 'default'
  // Fast path: header is already a q_project_id (post-Phase-3 MCP clients)
  if (header && /^q_p\d+$/.test(header)) return header
  // Slow path: header is a group_id slug → DB lookup
  const qProjectId = await getProjectByGroupId(pool, header)
  if (!qProjectId) {
    res.status(404).json({
      error: 'project_not_found',
      message: `Project '${header}' not registered`,
    })
    return null
  }
  return qProjectId
}

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

  try {
    const qProjectId = await resolveQProjectId(req, res)
    if (!qProjectId) return

    const [statsResult, activityResult] = await Promise.all([
      pool.query(
        `WITH domain_stats AS (
           SELECT topic AS domain,
                  COUNT(*) FILTER (WHERE status = 'ACTIVE')::int  AS active_count,
                  COUNT(*) FILTER (WHERE status = 'DRAFT')::int   AS draft_count,
                  ROUND(AVG(confidence) FILTER (WHERE status = 'ACTIVE')::numeric, 3)::float AS avg_confidence
           FROM knowledge_versions
           WHERE q_project_id = $1
           GROUP BY topic
         ),
         pending_stats AS (
           SELECT
             COUNT(*)::int                                           AS total,
             ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600)::numeric, 1)::float AS avg_age_hours,
             ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600)::numeric, 1)::float AS oldest_age_hours
           FROM pending_decisions
           WHERE q_project_id = $1 AND status = 'pending'
         ),
         confidence_buckets AS (
           SELECT
             COUNT(*) FILTER (WHERE confidence > 0.7)::int  AS high,
             COUNT(*) FILTER (WHERE confidence BETWEEN 0.4 AND 0.7)::int AS medium,
             COUNT(*) FILTER (WHERE confidence < 0.4)::int  AS low
           FROM knowledge_versions
           WHERE q_project_id = $1 AND status = 'ACTIVE'
         ),
         lowest_conf AS (
           SELECT topic, key, confidence, last_accessed_at
           FROM knowledge_versions
           WHERE q_project_id = $1 AND status = 'ACTIVE'
           ORDER BY confidence ASC
           LIMIT 10
         ),
         most_accessed AS (
           SELECT topic, key, confidence,
                  (SELECT COUNT(*)::int FROM audit_log
                   WHERE q_project_id = $1 AND tool = 'recall'
                   AND governance_json->>'topic' = knowledge_versions.topic
                   AND governance_json->>'key'   = knowledge_versions.key) AS access_count
           FROM knowledge_versions
           WHERE q_project_id = $1 AND status = 'ACTIVE'
           ORDER BY access_count DESC
           LIMIT 10
         )
         SELECT
           (SELECT json_agg(d) FROM domain_stats d)           AS domains,
           (SELECT row_to_json(p) FROM pending_stats p)       AS pending,
           (SELECT row_to_json(c) FROM confidence_buckets c)  AS confidence,
           (SELECT json_agg(l) FROM lowest_conf l)            AS lowest_confidence,
           (SELECT json_agg(m) FROM most_accessed m)          AS most_accessed`,
        [qProjectId],
      ),
      pool.query(
        `SELECT DATE(timestamp)::text AS date, COUNT(*)::int AS operation_count
         FROM audit_log
         WHERE q_project_id = $1 AND timestamp > NOW() - INTERVAL '30 days'
         GROUP BY DATE(timestamp)
         ORDER BY date ASC`,
        [qProjectId],
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
  const domain    = req.query.domain  // optional domain (= topic) filter

  try {
    const qProjectId = await resolveQProjectId(req, res)
    if (!qProjectId) return

    // Guard: require domain filter if graph would be too large
    if (!domain) {
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM knowledge_versions
         WHERE q_project_id = $1 AND status = 'ACTIVE'`,
        [qProjectId],
      )
      if (countResult.rows[0].cnt > 500) {
        return res.status(400).json({
          error: 'graph_too_large',
          message: `Graph has ${countResult.rows[0].cnt} nodes. Specify ?domain= to filter.`,
        })
      }
    }

    const params = domain ? [qProjectId, domain] : [qProjectId]
    const domainFilter = domain ? 'AND topic = $2' : ''

    const result = await pool.query(
      `SELECT version_id, topic, key, version, entity_type, confidence, author, summary,
              status, supersedes_version, tags
       FROM knowledge_versions
       WHERE q_project_id = $1 AND status = 'ACTIVE' ${domainFilter}
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

    // Tag-based RELATES_TO edges — connect nodes that share meaningful cross-cutting tags.
    //
    // Two noise filters:
    //   1. Exclude tags that appear on > 40% of nodes in the result set — these are
    //      domain-wide labels (e.g. "openai" in an ai-generation domain) that would
    //      create a near-fully-connected graph.
    //   2. Require ≥ 2 qualifying shared tags — a single shared tag is often coincidental.
    //
    // Also exclude the domain name itself as a tag.
    const domainTagSet = new Set(domain ? [domain] : [])
    const tagFreq = {}
    for (const row of rows) {
      for (const t of (row.tags ?? [])) {
        if (!domainTagSet.has(t)) tagFreq[t] = (tagFreq[t] ?? 0) + 1
      }
    }
    const nodeCount     = rows.length
    const maxFreq       = Math.max(1, nodeCount * 0.4)   // tags on > 40 % of nodes are noise
    const rareTagFilter = (t) => !domainTagSet.has(t) && (tagFreq[t] ?? 0) <= maxFreq

    for (let i = 0; i < rows.length; i++) {
      const tagsA = (rows[i].tags ?? []).filter(rareTagFilter)
      if (tagsA.length === 0) continue
      for (let j = i + 1; j < rows.length; j++) {
        const tagsB = (rows[j].tags ?? []).filter(rareTagFilter)
        const shared = tagsA.filter((t) => tagsB.includes(t))
        if (shared.length >= 2) {
          const srcId = `${rows[i].topic}:${rows[i].key}:${rows[i].version}`
          const tgtId = `${rows[j].topic}:${rows[j].key}:${rows[j].version}`
          edges.push({
            data: {
              id:          `tag:${srcId}→${tgtId}`,
              source:      srcId,
              target:      tgtId,
              type:        'RELATES_TO',
              shared_tags: shared,
            },
          })
        }
      }
    }

    // Central hub node — project or domain depending on filter
    const hubId    = domain ? `domain:${domain}` : `project:${qProjectId}`
    const hubLabel = domain ?? req.user.project ?? qProjectId
    const hubNode  = { data: { id: hubId, label: hubLabel, node_type: 'hub' } }

    // Spoke edges: every knowledge node → hub
    const spokeEdges = rows.map((r) => ({
      data: {
        id:     `spoke:${r.topic}:${r.key}:${r.version}`,
        source: `${r.topic}:${r.key}:${r.version}`,
        target: hubId,
        type:   'BELONGS_TO',
      },
    }))

    res.json({
      nodes: [
        hubNode,
        ...rows.map((r) => ({
          data: {
            id:          `${r.topic}:${r.key}:${r.version}`,
            topic:       r.topic,
            key:         r.key,
            entity_type: r.entity_type,
            confidence:  r.confidence,
            author:      r.author,
            summary:     r.summary || `${r.topic}:${r.key}`,
            status:      r.status,
            tags:        r.tags ?? [],
          },
        })),
      ],
      edges: [...edges, ...spokeEdges],
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

  const domain      = req.query.domain
  const tag         = req.query.tag
  const entityType  = req.query.entity_type
  const page        = Math.max(1, parseInt(req.query.page  ?? '1',  10))
  const limit       = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '20', 10)))
  const offset      = (page - 1) * limit

  try {
    const qProjectId = await resolveQProjectId(req, res)
    if (!qProjectId) return

    const conditions = ['q_project_id = $1', "status = 'ACTIVE'"]
    const params     = [qProjectId]
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

// ── GET /api/knowledge/:topic/:key ────────────────────────────────────────────

/**
 * Full detail for a single knowledge entry: PG metadata + Graphiti content.
 * Used by NodePanel (graph) and KnowledgeDetail (browser) when a node is clicked.
 */
router.get('/knowledge/:topic/:key', async (req, res, next) => {
  const pool      = req.app.locals.pool
  const { topic, key } = req.params

  try {
    const qProjectId = await resolveQProjectId(req, res)
    if (!qProjectId) return

    const pgResult = await pool.query(
      `SELECT topic, key, version, entity_type, confidence, author, author_role,
              tags, summary, status, created_at, supersedes_version, graphiti_episode_id
       FROM knowledge_versions
       WHERE q_project_id = $1 AND topic = $2 AND key = $3 AND status = 'ACTIVE'
       LIMIT 1`,
      [qProjectId, topic, key],
    )
    const row = pgResult.rows[0] ?? null

    if (!row) return res.status(404).json({ error: 'not_found' })

    // summary is the canonical content source (populated by insertVersion going forward).
    // For older entries where summary is empty, fall back to Graphiti node search.
    // Two search strategies are tried because hyphens in key names are treated as NOT
    // operators in RediSearch — "quoted terms" bypass that interpretation.
    // group_ids are omitted intentionally (hyphenated project IDs break RediSearch);
    // project isolation is enforced by the PostgreSQL WHERE clause above.
    let content = row.summary || null
    if (!content) {
      const runSearch = async (query) => {
        const result = await searchNodes(query, { limit: 5 }).catch(() => null)
        const nodes  = result?.nodes ?? []
        return nodes.find((n) => (n.name ?? '').includes(key)) ?? nodes[0] ?? null
      }

      // Strategy 1: quoted "topic:key" — treats hyphens as literals in RediSearch
      const match = (await runSearch(`"${topic}:${key}"`))
        // Strategy 2: quoted key alone, in case topic prefix confused the match
        ?? (await runSearch(`"${key}"`))

      content = match?.summary ?? null
    }

    res.json({
      topic:               row.topic,
      key:                 row.key,
      version:             row.version,
      entity_type:         row.entity_type,
      confidence:          row.confidence,
      author:              row.author,
      author_role:         row.author_role,
      tags:                row.tags ?? [],
      status:              row.status,
      created_at:          row.created_at,
      graphiti_episode_id: row.graphiti_episode_id,
      content,
    })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/search ────────────────────────────────────────────────────────────

/**
 * Combined semantic + keyword search.
 *
 * Runs Graphiti (semantic) and PostgreSQL (keyword: summary/key/topic/tags ILIKE)
 * in parallel via Promise.allSettled so a Graphiti outage never blocks tag/key
 * matches. Graphiti results are listed first; postgres-only matches are appended,
 * deduplicated on topic:key.
 *
 * Query params: q (required), domain (optional exact-match scope), limit (default 10)
 */
router.get('/search', async (req, res, next) => {
  const groupId   = req.user.project ?? 'default'
  const query     = req.query.q
  const domain    = req.query.domain
  const limit     = Math.min(50, Math.max(1, parseInt(req.query.limit ?? '10', 10)))

  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'query_required', message: 'q must be at least 2 characters' })
  }

  try {
    const pool       = req.app.locals.pool
    const qProjectId = await resolveQProjectId(req, res)
    if (!qProjectId) return

    const pattern = `%${query}%`
    const pgParams = domain ? [qProjectId, pattern, domain] : [qProjectId, pattern]
    const domainFilter = domain ? `AND topic = $3` : ''

    // Run Graphiti semantic search and postgres keyword search in parallel.
    // allSettled ensures a Graphiti failure never suppresses postgres results.
    const [graphitiOutcome, pgOutcome] = await Promise.allSettled([
      searchNodes(domain ? `[${domain}] ${query}` : query, { groupId, limit }),
      pool.query(
        `SELECT topic, key, entity_type, summary, tags, status, confidence, author, created_at
         FROM knowledge_versions
         WHERE q_project_id = $1
           AND (summary ILIKE $2 OR key ILIKE $2 OR topic ILIKE $2
                OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE $2))
           AND status NOT IN ('DRAFT','DEPRECATED','REJECTED')
           ${domainFilter}
         ORDER BY confidence DESC, created_at DESC
         LIMIT ${limit}`,
        pgParams,
      ),
    ])

    const graphitiNodes =
      graphitiOutcome.status === 'fulfilled'
        ? (graphitiOutcome.value?.nodes ?? graphitiOutcome.value?.results ?? [])
        : []

    const pgRows =
      pgOutcome.status === 'fulfilled' ? pgOutcome.value.rows : []

    // Build Graphiti results and track seen topic:key pairs for deduplication
    const seen = new Set()
    const results = graphitiNodes.map((n) => {
      const topicKey = `${n.topic ?? n.group_id ?? ''}:${n.key ?? n.name ?? ''}`
      seen.add(topicKey)
      return {
        topic:       n.topic       ?? n.group_id ?? '',
        key:         n.key         ?? n.name     ?? '',
        entity_type: n.entity_type ?? 'unknown',
        summary:     n.summary     ?? n.name     ?? '',
        tags:        n.tags        ?? [],
        confidence:  n.confidence  ?? null,
        score:       n.score       ?? n.distance ?? null,
        author:      n.author      ?? null,
        updated_at:  n.created_at  ?? n.updated_at ?? null,
      }
    })

    // Append postgres matches not already covered by Graphiti
    for (const r of pgRows) {
      const topicKey = `${r.topic}:${r.key}`
      if (!seen.has(topicKey)) {
        seen.add(topicKey)
        results.push({
          topic:       r.topic,
          key:         r.key,
          entity_type: r.entity_type ?? 'unknown',
          summary:     r.summary ?? '',
          tags:        r.tags ?? [],
          confidence:  r.confidence ?? null,
          score:       null,
          author:      r.author ?? null,
          updated_at:  r.created_at ?? null,
        })
      }
    }

    const source = graphitiNodes.length > 0 && pgRows.length > 0
      ? 'graphiti+postgres'
      : graphitiNodes.length > 0 ? 'graphiti' : 'postgres'

    res.json({ results, source })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/drafts ───────────────────────────────────────────────────────────

/**
 * Return all DRAFT knowledge versions for the current project, ordered oldest-first.
 * Used by the Pending page to surface non-PE DRAFT entries awaiting PE review.
 *
 * Separate from /pg/pending (which returns conflict decisions) — DRAFTs are
 * governance-pending entries, not conflict-queue entries.
 */
router.get('/drafts', async (req, res, next) => {
  try {
    const pool        = req.app.locals.pool
    const qProjectId  = await resolveQProjectId(req, res)
    if (!qProjectId) return

    const { rows } = await pool.query(
      `SELECT version_id, topic, key, entity_type, confidence, author, author_role,
              tags, summary AS content, created_at, status
       FROM knowledge_versions
       WHERE q_project_id = $1 AND status = 'DRAFT'
       ORDER BY created_at ASC`,
      [qProjectId],
    )

    res.json({ drafts: rows })
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
  // Only principal_architect can review (approve / reject / request_changes)
  if (!requirePrincipalArchitect(req, res)) return

  const pool       = req.app.locals.pool
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
    const qProjectId = await resolveQProjectId(req, res)
    if (!qProjectId) return

    const decision = await getPendingDecisionById(pool, conflictId)
    if (!decision) {
      return res.status(404).json({ error: 'not_found', message: `No pending decision with id ${conflictId}` })
    }

    // Scope check — conflict_id is globally unique but cross-project access is forbidden
    if (decision.q_project_id !== qProjectId) {
      return res.status(403).json({ error: 'forbidden', message: 'Decision belongs to a different project' })
    }

    // pending_decisions no longer carries (conflict_topic, conflict_key) — fetch
    // them from q_keys via the decision's q_key_id.
    const keyRow = await pool.query(
      `SELECT topic, key FROM q_keys WHERE q_key_id = $1 LIMIT 1`,
      [decision.q_key_id],
    )
    const conflictTopic = keyRow.rows[0]?.topic ?? null
    const conflictKey   = keyRow.rows[0]?.key   ?? null

    // ── Deprecation request branch ──────────────────────────────────────────────
    if (decision.decision_type === 'deprecation_request') {
      if (action === 'request_changes') {
        return res.status(400).json({
          error: 'invalid_action',
          message: "request_changes is not valid for deprecation requests. Reject it and ask the requestor to re-submit forget() with a clearer reason.",
        })
      }

      if (action === 'reject') {
        await resolvePendingDecision(pool, conflictId, {
          status: 'resolved', resolution: 'rejected',
          note, resolvedBy: reviewer,
        })
        await writeAuditEntry(pool, {
          operation:    'OUTCOME',
          tool:         'dashboard-review-deprecation',
          author:       reviewer,
          author_role:  reviewerRole,
          q_project_id: qProjectId,
          author_type:  'human',
          triggered_by: 'dashboard',
          governance_json: { action, note, request_id: conflictId },
          outcome_json:    { status: 'rejected', topic: conflictTopic, key: conflictKey },
          version_impact:  { versions_created: [], versions_superseded: [] },
        })
        return res.json({ status: 'rejected', request_id: conflictId, topic: conflictTopic, key: conflictKey, reviewer, note })
      }

      // approve — run deprecation transaction
      const currentEntry = await getCurrentVersion(pool, decision.q_key_id)
      if (!currentEntry) {
        await resolvePendingDecision(pool, conflictId, {
          status: 'resolved', resolution: 'rejected',
          note: 'Entry no longer ACTIVE at approval time.', resolvedBy: reviewer,
        })
        return res.status(404).json({ error: 'not_found', message: `${conflictTopic}:${conflictKey} is no longer ACTIVE.` })
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const currentVersionId = `${decision.q_key_id}_v${currentEntry.version}`
        await transitionVersionStatus(client, currentVersionId, 'DEPRECATED', null)
        await resolvePendingDecision(client, conflictId, {
          status: 'resolved', resolution: 'approved',
          note, resolvedBy: reviewer,
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
        tool:         'dashboard-review-deprecation',
        author:       reviewer,
        author_role:  reviewerRole,
        q_project_id: qProjectId,
        author_type:  'human',
        triggered_by: 'dashboard',
        governance_json: { action, note, request_id: conflictId },
        outcome_json:    { status: 'approved', topic: conflictTopic, key: conflictKey, version: currentEntry.version },
        version_impact:  {
          versions_created:    [],
          versions_superseded: [`${decision.q_key_id}_v${currentEntry.version}`],
        },
      })
      return res.json({ status: 'approved', request_id: conflictId, topic: conflictTopic, key: conflictKey, reviewer, note })
    }
    // ── End deprecation request branch ──────────────────────────────────────────

    // Get the DRAFT version to check authorship
    const draftVersion = await getLatestDraftVersion(pool, decision.q_key_id)

    // Constitutional Rule 4: no self-approval
    if (draftVersion?.author) {
      try {
        enforceNoSelfApproval(draftVersion.author, reviewer, 'review')
      } catch (err) {
        return res.status(403).json({ error: 'self_approval_blocked', message: err.message })
      }
    }

    // Staleness detection: has the ACTIVE version advanced since this decision was raised?
    const currentActive = await getCurrentVersion(pool, decision.q_key_id)
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
        q_project_id: qProjectId,
        governance_json: { action, note, conflict_id: conflictId },
        outcome_json:    { status: 'changes_requested', topic: conflictTopic, key: conflictKey },
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

      if (draftVersion) {
        const draftVersionId = `${decision.q_key_id}_v${draftVersion.version}`

        if (action === 'approve') {
          const forwardLink = {
            version: draftVersion.version,
            author:  reviewer,
            at:      new Date().toISOString(),
          }
          await transitionVersionStatus(client, draftVersionId, 'ACTIVE', forwardLink)
        } else if (action === 'reject') {
          await transitionVersionStatus(client, draftVersionId, 'REJECTED', null)
        }
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
      q_project_id: qProjectId,
      governance_json: { action, note, conflict_id: conflictId },
      outcome_json: {
        status:  action === 'approve' ? 'approved' : 'rejected',
        topic:   conflictTopic,
        key:     conflictKey,
        version: draftVersion?.version ?? null,
      },
      version_impact: {
        versions_created:    action === 'approve' && draftVersion ? [`${decision.q_key_id}_v${draftVersion.version}`] : [],
        versions_superseded: action === 'approve' && currentActive ? [`${decision.q_key_id}_v${currentActive.version}`] : [],
      },
    })

    res.json({
      status:      action === 'approve' ? 'approved' : 'rejected',
      conflict_id: conflictId,
      topic:       conflictTopic,
      key:         conflictKey,
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
  const groupId    = req.user.project ?? 'default'
  const caller     = req.user.sub
  const callerRole = req.user.role ?? 'engineer'
  const { topic, key } = req.params

  try {
    const qProjectId = await resolveQProjectId(req, res)
    if (!qProjectId) return
    const qKeyId = await getOrCreateKey(pool, qProjectId, topic, key)

    const existing = await getVersionForBump(pool, qKeyId)
    if (!existing) {
      return res.status(404).json({ error: 'not_found', message: `No ACTIVE knowledge at ${topic}:${key}` })
    }

    const weight       = BUMP_ROLE_WEIGHT[callerRole] ?? BUMP_ROLE_WEIGHT.engineer
    const delta        = BUMP_BASE_DELTA * weight
    const currentConf  = existing.confidence        ?? 0.7
    const startingConf = existing.starting_confidence ?? currentConf
    const newConf      = Math.min(startingConf, currentConf + delta)

    // Wrap cooldown read + insert + confidence update in a transaction to
    // prevent concurrent double-bumps from the same author.
    const client = await pool.connect()
    let payload
    try {
      await client.query('BEGIN')

      const bumpLogs = await getBumpLog(client, { qKeyId, author: caller, limit: 1 })
      const lastBump = bumpLogs[0] ?? null
      if (lastBump) {
        const elapsed = Date.now() - new Date(lastBump.bumped_at).getTime()
        if (elapsed < BUMP_COOLDOWN_MS) {
          await client.query('ROLLBACK')
          const nextAllowed = new Date(new Date(lastBump.bumped_at).getTime() + BUMP_COOLDOWN_MS).toISOString()
          return res.status(429).json({
            error:              'cooldown_active',
            message:            `Bump cooldown active — next allowed at ${nextAllowed}`,
            next_bump_allowed:  nextAllowed,
          })
        }
      }

      await recordBump(client, { qKeyId, author: caller, role: callerRole, delta })
      await updateConfidence(client, existing.version_id, newConf)
      await client.query('COMMIT')

      payload = {
        topic,
        key,
        project_id:          groupId,
        bumped_by:           caller,
        role:                callerRole,
        delta_applied:       parseFloat(delta.toFixed(4)),
        confidence_before:   parseFloat(currentConf.toFixed(4)),
        confidence_after:    parseFloat(newConf.toFixed(4)),
        starting_confidence: parseFloat(startingConf.toFixed(4)),
        clock_reset:         true,
        next_bump_allowed:   new Date(Date.now() + BUMP_COOLDOWN_MS).toISOString(),
      }
    } catch (txErr) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      throw txErr
    } finally {
      client.release()
    }

    res.json(payload)
  } catch (err) {
    next(err)
  }
})

// ── POST /api/knowledge ────────────────────────────────────────────────────────

/**
 * Create a knowledge entry. principal_architect → ACTIVE; all other roles → DRAFT.
 *
 * PE cannot create a duplicate ACTIVE entry — they must use the supersede route instead.
 * Non-PE can create a DRAFT even when an ACTIVE version already exists for the same key
 * (the DRAFT is a proposal for the PE to review and promote).
 *
 * Confidence is floored at req.user.base_confidence (role default: 0.7) to mirror the
 * MCP storeFirst() behaviour and enforce authority-weighted minimums.
 *
 * Server-side fields (never taken from req.body):
 *   author, author_type, triggered_by, content_hash, q_project_id, status, confidence floor
 *
 * @route POST /api/knowledge
 */
router.post('/knowledge', peWriteLimit, async (req, res, next) => {

  const bodyBytes = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8')
  if (bodyBytes > 4096) {
    return res.status(413).json({ error: 'payload_too_large', message: 'Request body must be under 4 KB' })
  }

  const body = req.body ?? {}
  const { topic, key, content, entity_type, tags, confidence } = body

  // Build fields object without undefined values so validateKnowledgeInput's
  // presence checks ('tags' in fields, 'confidence' in fields) behave correctly.
  const validationFields = { topic, key, content, entity_type }
  if ('tags' in body) validationFields.tags = tags
  if ('confidence' in body) validationFields.confidence = confidence

  try {
    validateKnowledgeInput(validationFields)
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: 'validation_error', field: err.field, message: err.message })
    }
    throw err
  }

  try {
    const pool = req.app.locals.pool
    const qProjectId = await resolveQProjectId(req, res)
    if (!qProjectId) return

    const qKeyId      = await getOrCreateKey(pool, qProjectId, topic, key)

    // PE cannot create a duplicate ACTIVE entry — they must supersede instead.
    // Non-PE creates DRAFTs, which can coexist alongside an existing ACTIVE version.
    const existing = await getCurrentVersion(pool, qKeyId)
    if (existing && req.user.role === 'principal_architect') {
      return res.status(409).json({
        error:   'already_exists',
        message: `An ACTIVE version already exists for ${topic}:${key}. Use supersede to update it.`,
      })
    }

    const nextVer     = await getNextVersionNumber(pool, qKeyId)
    const versionId   = `${qKeyId}_v${nextVer}`
    const contentHash = createHash('sha256').update(content).digest('hex')
    const author      = req.user.sub
    const authorRole  = req.user.role

    // Apply role-based confidence floor — mirrors MCP storeFirst() behaviour.
    const floor = req.user.base_confidence ?? 0.7

    const record = {
      version_id:   versionId,
      q_key_id:     qKeyId,
      q_project_id: qProjectId,
      topic,
      key,
      summary:      content,
      entity_type,
      tags:         tags ?? [],
      confidence:   Math.max(confidence ?? floor, floor),
      author,
      author_role:  authorRole,
      author_type:  'human',
      triggered_by: 'dashboard',
      content_hash: contentHash,
      version:      nextVer,
      status:       req.user.role === 'principal_architect' ? 'ACTIVE' : 'DRAFT',
    }

    const inserted = await insertVersion(pool, record)

    await writeAuditEntry(pool, {
      operation:    'WRITE',
      tool:         'dashboard-create',
      author,
      author_role:  authorRole,
      q_project_id: qProjectId,
      content_hash: contentHash,
      governance_json: { topic, key, entity_type, confidence: record.confidence },
      outcome_json:    { status: record.status, version: nextVer, version_id: versionId },
      version_impact:  { versions_created: [versionId], versions_superseded: [] },
    })

    res.status(201).json(inserted)
  } catch (err) {
    next(err)
  }
})

// ── POST /api/knowledge/:topic/:key/promote ────────────────────────────────────

/**
 * Promote a DRAFT version to ACTIVE (principal_architect only).
 *
 * @route POST /api/knowledge/:topic/:key/promote
 */
router.post('/knowledge/:topic/:key/promote', peWriteLimit, async (req, res, next) => {
  if (!requirePrincipalArchitect(req, res)) return

  const bodyBytes = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8')
  if (bodyBytes > 4096) {
    return res.status(413).json({ error: 'payload_too_large', message: 'Request body must be under 4 KB' })
  }

  const { topic, key } = req.params
  const { note } = req.body ?? {}

  // Validate note using the same rules as the shared reason validator.
  if (note == null || typeof note !== 'string' || note.trim().length === 0) {
    return res.status(400).json({ error: 'validation_error', field: 'note', message: 'note is required for this operation (min 10 chars)' })
  }
  if (note.trim().length < 10) {
    return res.status(400).json({ error: 'validation_error', field: 'note', message: `note must be at least 10 characters (got ${note.trim().length})` })
  }
  if (note.length > 500) {
    return res.status(400).json({ error: 'validation_error', field: 'note', message: `note must be at most 500 characters (got ${note.length})` })
  }
  if (note.includes('<') || note.includes('>')) {
    return res.status(400).json({ error: 'validation_error', field: 'note', message: 'note must not contain < or >' })
  }

  try {
    const pool = req.app.locals.pool
    const qProjectId = await resolveQProjectId(req, res)
    if (!qProjectId) return

    const qKeyId = await getOrCreateKey(pool, qProjectId, topic, key)
    const draft  = await getLatestDraftVersion(pool, qKeyId)

    if (!draft) {
      return res.status(404).json({ error: 'no_draft', message: `No DRAFT version found for ${topic}:${key}` })
    }

    const draftVersionId = `${qKeyId}_v${draft.version}`

    const client = await pool.connect()
    let promoted
    try {
      await client.query('BEGIN')
      const forwardLink = { version: draft.version, author: req.user.sub, at: new Date().toISOString(), note }
      promoted = await transitionVersionStatus(client, draftVersionId, 'ACTIVE', forwardLink)
      await client.query('COMMIT')
    } catch (txErr) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      throw txErr
    } finally {
      client.release()
    }

    await writeAuditEntry(pool, {
      operation:    'WRITE',
      tool:         'dashboard-promote',
      author:       req.user.sub,
      author_role:  req.user.role,
      q_project_id: qProjectId,
      governance_json: { topic, key, note, draft_version: draft.version },
      outcome_json:    { status: 'ACTIVE', version: draft.version, version_id: draftVersionId },
      version_impact:  { versions_created: [], versions_superseded: [] },
    })

    res.json({ promoted: true, version: draft.version, version_id: draftVersionId, topic, key })
  } catch (err) {
    next(err)
  }
})

// ── POST /api/knowledge/:topic/:key/supersede ──────────────────────────────────

/**
 * Replace the current ACTIVE version with a new version (atomic transaction).
 * principal_architect only.
 *
 * The old ACTIVE version is atomically transitioned to SUPERSEDED while the new
 * version is inserted as ACTIVE — both operations run in a single pg transaction
 * to guarantee consistency.
 *
 * @route POST /api/knowledge/:topic/:key/supersede
 */
router.post('/knowledge/:topic/:key/supersede', peWriteLimit, async (req, res, next) => {
  if (!requirePrincipalArchitect(req, res)) return

  const bodyBytes = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8')
  if (bodyBytes > 4096) {
    return res.status(413).json({ error: 'payload_too_large', message: 'Request body must be under 4 KB' })
  }

  const { topic, key } = req.params
  const body = req.body ?? {}
  const { content, entity_type, tags, confidence, reason } = body

  // Build fields object without undefined values so validateKnowledgeInput's
  // presence checks ('tags' in fields, 'confidence' in fields, 'reason' in fields)
  // behave correctly. topic/key always come from URL params.
  const validationFields = { topic, key, content, entity_type }
  if ('tags' in body) validationFields.tags = tags
  if ('confidence' in body) validationFields.confidence = confidence
  if ('reason' in body) validationFields.reason = reason

  try {
    validateKnowledgeInput(validationFields, { requireReason: true })
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: 'validation_error', field: err.field, message: err.message })
    }
    throw err
  }

  try {
    const pool = req.app.locals.pool
    const qProjectId = await resolveQProjectId(req, res)
    if (!qProjectId) return

    const qKeyId  = await getOrCreateKey(pool, qProjectId, topic, key)
    const current = await getCurrentVersion(pool, qKeyId)

    if (!current) {
      return res.status(404).json({ error: 'no_active', message: `No ACTIVE version found for ${topic}:${key}` })
    }

    const nextVer      = await getNextVersionNumber(pool, qKeyId)
    const newVersionId = `${qKeyId}_v${nextVer}`
    const oldVersionId = `${qKeyId}_v${current.version}`
    const contentHash  = createHash('sha256').update(content).digest('hex')
    const author       = req.user.sub
    const authorRole   = req.user.role

    const client = await pool.connect()
    let newVersion
    try {
      await client.query('BEGIN')

      newVersion = await insertVersion(client, {
        version_id:         newVersionId,
        q_key_id:           qKeyId,
        q_project_id:       qProjectId,
        topic,
        key,
        summary:            content,
        entity_type,
        tags:               tags ?? [],
        confidence:         confidence ?? 0.7,
        author,
        author_role:        authorRole,
        author_type:        'human',
        triggered_by:       'dashboard',
        content_hash:       contentHash,
        version:            nextVer,
        status:             'ACTIVE',
        supersedes_version: current.version,
        supersedes_reason:  reason,
      })

      const forwardLink = {
        version: nextVer,
        author,
        at:      new Date().toISOString(),
        reason,
      }
      await transitionVersionStatus(client, oldVersionId, 'SUPERSEDED', forwardLink)

      await client.query('COMMIT')
    } catch (txErr) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      throw txErr
    } finally {
      client.release()
    }

    await writeAuditEntry(pool, {
      operation:    'WRITE',
      tool:         'dashboard-supersede',
      author,
      author_role:  authorRole,
      q_project_id: qProjectId,
      content_hash: contentHash,
      governance_json: { topic, key, reason, entity_type, confidence: confidence ?? 0.7 },
      outcome_json:    { status: 'ACTIVE', new_version: nextVer, superseded_version: current.version },
      version_impact:  { versions_created: [newVersionId], versions_superseded: [oldVersionId] },
    })

    res.json({ new_version: newVersion, superseded_version: current.version })
  } catch (err) {
    next(err)
  }
})

// ── POST /api/knowledge/deprecate/bulk ─────────────────────────────────────────
// Registered BEFORE /knowledge/:topic/:key/deprecate to prevent Express matching
// the literal string "deprecate" as :topic.

/**
 * Bulk-deprecate ACTIVE knowledge entries (principal_architect only).
 * Processes each entry in its own transaction; partial success is allowed.
 *
 * @route POST /api/knowledge/deprecate/bulk
 */
router.post('/knowledge/deprecate/bulk', peWriteLimit, async (req, res, next) => {
  if (!requirePrincipalArchitect(req, res)) return

  const { entries, reason } = req.body ?? {}

  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'entries must be a non-empty array' })
  }

  try {
    enforceReasonRequired(reason, 'deprecate')
  } catch (err) {
    return res.status(400).json({ error: 'reason_required', message: err.message })
  }

  const pool        = req.app.locals.pool
  const author      = req.user.sub
  const authorRole  = req.user.role
  let qProjectId
  try {
    qProjectId = await resolveQProjectId(req, res)
  } catch (err) {
    return next(err)
  }
  if (!qProjectId) return

  const deprecated = []
  const errors     = []

  for (const { topic, key } of entries) {
    if (!topic || !key) {
      errors.push({ topic, key, message: 'topic and key are required' })
      continue
    }

    try {
      const qKeyId  = await getOrCreateKey(pool, qProjectId, topic, key)
      const current = await getCurrentVersion(pool, qKeyId)

      if (!current) {
        errors.push({ topic, key, message: `No ACTIVE version found for ${topic}:${key}` })
        continue
      }

      const versionId = `${qKeyId}_v${current.version}`
      const client    = await pool.connect()
      try {
        await client.query('BEGIN')
        await transitionVersionStatus(client, versionId, 'DEPRECATED', {
          reason,
          author,
          at: new Date().toISOString(),
        })
        await client.query('COMMIT')
      } catch (txErr) {
        try { await client.query('ROLLBACK') } catch { /* ignore */ }
        errors.push({ topic, key, message: txErr.message })
        continue
      } finally {
        client.release()
      }

      await writeAuditEntry(pool, {
        operation:    'WRITE',
        tool:         'dashboard-deprecate',
        author,
        author_role:  authorRole,
        author_type:  'human',
        triggered_by: 'dashboard',
        q_project_id: qProjectId,
        governance_json: { topic, key, reason },
        outcome_json:    { status: 'DEPRECATED', version: current.version, version_id: versionId },
        version_impact:  { versions_created: [], versions_superseded: [versionId] },
      })

      deprecated.push({ topic, key })
    } catch (err) {
      errors.push({ topic, key, message: err.message })
    }
  }

  res.json({ deprecated, errors })
})

// ── POST /api/knowledge/:topic/:key/deprecate ──────────────────────────────────

/**
 * Deprecate a single ACTIVE knowledge entry (principal_architect only).
 * Atomically transitions the current ACTIVE version to DEPRECATED.
 *
 * @route POST /api/knowledge/:topic/:key/deprecate
 */
router.post('/knowledge/:topic/:key/deprecate', peWriteLimit, async (req, res, next) => {
  if (!requirePrincipalArchitect(req, res)) return

  const { topic, key } = req.params
  const { reason }     = req.body ?? {}

  try {
    enforceReasonRequired(reason, 'deprecate')
  } catch (err) {
    return res.status(400).json({ error: 'reason_required', message: err.message })
  }

  try {
    const pool        = req.app.locals.pool
    const author      = req.user.sub
    const authorRole  = req.user.role
    const qProjectId  = await resolveQProjectId(req, res)
    if (!qProjectId) return

    const qKeyId  = await getOrCreateKey(pool, qProjectId, topic, key)
    const current = await getCurrentVersion(pool, qKeyId)

    if (!current) {
      return res.status(404).json({ error: 'not_found', message: `No ACTIVE version found for ${topic}:${key}` })
    }

    const versionId = `${qKeyId}_v${current.version}`
    const client    = await pool.connect()
    try {
      await client.query('BEGIN')
      await transitionVersionStatus(client, versionId, 'DEPRECATED', {
        reason,
        author,
        at: new Date().toISOString(),
      })
      await client.query('COMMIT')
    } catch (txErr) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      throw txErr
    } finally {
      client.release()
    }

    await writeAuditEntry(pool, {
      operation:    'WRITE',
      tool:         'dashboard-deprecate',
      author,
      author_role:  authorRole,
      author_type:  'human',
      triggered_by: 'dashboard',
      q_project_id: qProjectId,
      governance_json: { topic, key, reason },
      outcome_json:    { status: 'DEPRECATED', version: current.version, version_id: versionId },
      version_impact:  { versions_created: [], versions_superseded: [versionId] },
    })

    res.json({ deprecated: true, topic, key })
  } catch (err) {
    next(err)
  }
})

export default router
