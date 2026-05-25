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
  getKeyId,
  upsertDeviation,
  batchUpsertDeviations,
  getDeviationsByProject,
  insertDeviationAction,
  getConformanceScore,
  getPortfolioScores,
} from '../shared/graph/queries.js'
import { DEFAULT_ROLE_SCORES } from '../shared/governance/authority.js'
import { searchNodes, searchFacts, normalizeGroupId } from '../shared/graph/client.js'
import { writeAuditEntry } from '../shared/audit/secondary.js'
import { loadProjectConfig } from '../config-cache.js'
import {
  enforceNoSelfApproval,
  enforceReasonRequired,
  enforceGlobalWriteAuthority,
  enforceDeviationActionAuthority,
  enforceValidDeferDeadline,
} from '../shared/governance/constitutional.js'
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
  // Bypass in test mode — parallel E2E workers share the same Docker bridge IP
  // and their seed functions generate legitimate burst writes that exceed the
  // production 10/min threshold. The limit protects production, not test infra.
  if (process.env.NODE_ENV === 'test') return next()

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

    // Resolve canonical group_id from DB — used as the hub node label so the
    // graph always shows the authoritative project identity, not the header value.
    const { rows: projectRows } = await pool.query(
      'SELECT group_id FROM q_projects WHERE q_project_id = $1 LIMIT 1',
      [qProjectId],
    )
    const groupId = projectRows[0]?.group_id ?? req.user.project ?? qProjectId

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
    const hubLabel = domain ?? groupId
    const hubNode  = { data: { id: hubId, label: hubLabel, node_type: 'hub', group_id: groupId } }

    const keyNodes = rows.map((r) => ({
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
    }))

    let topicNodes = []
    let spokeEdges = []

    if (domain) {
      // Domain-filtered view: hub IS the topic — connect keys directly to hub
      spokeEdges = rows.map((r) => ({
        data: {
          id:     `spoke:${r.topic}:${r.key}:${r.version}`,
          source: `${r.topic}:${r.key}:${r.version}`,
          target: hubId,
          type:   'BELONGS_TO',
        },
      }))
    } else {
      // Full project view: hub → topic → key (3 levels)
      const uniqueTopics = [...new Set(rows.map((r) => r.topic))]

      topicNodes = uniqueTopics.map((t) => ({
        data: { id: `topic:${t}`, label: t, node_type: 'topic' },
      }))

      // topic → hub
      const topicHubEdges = uniqueTopics.map((t) => ({
        data: {
          id:     `spoke:topic:${t}`,
          source: `topic:${t}`,
          target: hubId,
          type:   'BELONGS_TO',
        },
      }))

      // key → topic
      const keyTopicEdges = rows.map((r) => ({
        data: {
          id:     `spoke:${r.topic}:${r.key}:${r.version}`,
          source: `${r.topic}:${r.key}:${r.version}`,
          target: `topic:${r.topic}`,
          type:   'BELONGS_TO',
        },
      }))

      spokeEdges = [...topicHubEdges, ...keyTopicEdges]
    }

    res.json({
      nodes: [hubNode, ...topicNodes, ...keyNodes],
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
        `SELECT topic, key, status, entity_type, confidence, author, tags, created_at AS updated_at, version
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

    // For global catalog projects, annotate each entry with denial_hint_count —
    // the number of distinct projects that have denied a deviation against this standard.
    // One batch query replaces N per-row subqueries.
    const projectConfig = await loadProjectConfig(req.user.project).catch(() => null)
    let denialMap = new Map()   // "topic:key" → count
    if (projectConfig?.is_global === true && dataResult.rows.length > 0) {
      const catalogGroupId = req.user.project
      const { rows: denialRows } = await pool.query(
        `SELECT d.topic, d.key, COUNT(DISTINCT d.q_project_id)::int AS denial_count
         FROM deviation_actions da
         JOIN deviations d ON da.deviation_id = d.deviation_id
         WHERE d.catalog_id = $1
           AND da.action_type = 'deny'
         GROUP BY d.topic, d.key`,
        [catalogGroupId],
      )
      for (const r of denialRows) denialMap.set(`${r.topic}:${r.key}`, r.denial_count)
    }

    res.json({
      items: dataResult.rows.map((row) => ({
        ...row,
        denial_hint_count: denialMap.get(`${row.topic}:${row.key}`) ?? 0,
      })),
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
  const groupId = req.user.project ?? 'default'
  const query   = req.query.q
  const domain  = req.query.domain
  const limit   = Math.min(50, Math.max(1, parseInt(req.query.limit ?? '10', 10)))

  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'query_required', message: 'q must be at least 2 characters' })
  }

  try {
    const pool       = req.app.locals.pool
    const qProjectId = await resolveQProjectId(req, res)
    if (!qProjectId) return

    // Load project config to resolve linked global catalogs.
    // Graceful fallback: if config is unavailable, search remains project-scoped.
    const projectConfig = await loadProjectConfig(req.user.project).catch(() => null)
    const globals       = projectConfig?.globals ?? []

    // All group_id slugs to search across (project + every linked global catalog).
    // E2E: tests/e2e/scenarios/07-cross-catalog-search.spec.js
    //   S-07.3 step 1 — PROJECT (globals:[CATALOG]) finds global entry
    //   S-07.4 step 3 — ISOLATED_PROJECT (no globals) cannot find global entries
    const allGroupIds = [groupId, ...globals]

    // Reverse map for annotation: normalizedGroupId → original group_id slug.
    // Needed because Graphiti stores nodes under the normalised form (hyphens → underscores).
    const globalIdMap = new Map(globals.map(g => [normalizeGroupId(g), g]))

    const graphitiQuery = domain ? `[${domain}] ${query}` : query
    const pattern       = `%${query}%`
    const domainFilter  = domain ? 'AND kv.topic = $3' : ''
    const pgParams      = domain ? [allGroupIds, pattern, domain] : [allGroupIds, pattern]

    // Run Graphiti semantic search and postgres keyword search in parallel.
    // allSettled ensures a Graphiti failure never suppresses postgres results.
    const [graphitiOutcome, pgOutcome] = await Promise.allSettled([
      searchNodes(graphitiQuery, { groupIds: allGroupIds, limit }),
      pool.query(
        // JOIN q_projects to resolve source_group_id for catalog annotation.
        // WHERE qp.group_id = ANY($1) covers project + all linked global catalogs in one query.
        `SELECT kv.topic, kv.key, kv.entity_type, kv.summary, kv.tags,
                kv.confidence, kv.author, kv.created_at, qp.group_id AS source_group_id
         FROM knowledge_versions kv
         JOIN q_projects qp ON qp.q_project_id = kv.q_project_id
         WHERE qp.group_id = ANY($1)
           AND (kv.summary ILIKE $2 OR kv.key ILIKE $2 OR kv.topic ILIKE $2
                OR EXISTS (SELECT 1 FROM unnest(kv.tags) t WHERE t ILIKE $2))
           AND kv.status NOT IN ('DRAFT','DEPRECATED','REJECTED') -- E2E: S-07.5 step 1 (DRAFT exclusion)
           ${domainFilter} -- E2E: S-07.6 step 1 (domain filter narrows to exact topic)
         ORDER BY kv.confidence DESC, kv.created_at DESC
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

    // Build results annotated with source (project vs global) and catalog_id.
    // Deduplication: Graphiti results take precedence; postgres fills gaps.
    const seen = new Set()
    const results = graphitiNodes.map((n) => {
      const topicKey    = `${n.topic ?? ''}:${n.key ?? n.name ?? ''}`
      seen.add(topicKey)
      const nodeGroupId = n.group_id ?? ''
      const catalogId   = globalIdMap.get(nodeGroupId) ?? null
      return {
        topic:       n.topic       ?? '',
        key:         n.key         ?? n.name ?? '',
        entity_type: n.entity_type ?? 'unknown',
        summary:     n.summary     ?? n.name ?? '',
        tags:        n.tags        ?? [],
        confidence:  n.confidence  ?? null,
        score:       n.score       ?? n.distance ?? null,
        author:      n.author      ?? null,
        updated_at:  n.created_at  ?? n.updated_at ?? null,
        source:      catalogId ? 'global' : 'project',
        catalog_id:  catalogId,
      }
    })

    // Append postgres matches not already covered by Graphiti.
    for (const r of pgRows) {
      const topicKey = `${r.topic}:${r.key}`
      if (!seen.has(topicKey)) {
        seen.add(topicKey)
        const catalogId = globals.includes(r.source_group_id) ? r.source_group_id : null
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
          source:      catalogId ? 'global' : 'project',
          catalog_id:  catalogId,
        })
      }
    }

    const backend = graphitiNodes.length > 0 && pgRows.length > 0
      ? 'graphiti+postgres'
      : graphitiNodes.length > 0 ? 'graphiti' : 'postgres'

    res.json({ results, source: backend })
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
    // E2E: tests/e2e/scenarios/11-self-approval.spec.js — S-11 NO_SELF_APPROVAL on review
    if (draftVersion?.author) {
      try {
        enforceNoSelfApproval(draftVersion.author, reviewer, 'review')
      } catch (err) {
        return next(err)
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

          // Atomically supersede the old ACTIVE so there is never more than one
          // ACTIVE version for a given topic:key after conflict approval.
          if (currentActive) {
            const currentActiveId = `${decision.q_key_id}_v${currentActive.version}`
            await transitionVersionStatus(client, currentActiveId, 'SUPERSEDED', {
              version: draftVersion.version,
              author:  reviewer,
              at:      new Date().toISOString(),
            })
          }
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
    // E2E: tests/e2e/scenarios/08-confidence-endorsement.spec.js — S-08.3 (cap: confidence_after ≤ starting_confidence)
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
        // E2E: tests/e2e/scenarios/08-confidence-endorsement.spec.js — S-08.4 step 2 (429 on re-bump within 7 days)
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

    // Constitutional: only architect+ may write to a global catalog.
    // Roles not in GLOBAL_WRITE_ROLES (engineer, senior_engineer, director, vp_engineering)
    // and non-members (role: null) are blocked with GLOBAL_WRITE_AUTHORITY.
    // E2E: tests/e2e/scenarios/05-rbac-boundary.spec.js — S-05.4 global catalog write authority
    const projectConfig = await loadProjectConfig(req.user.project).catch(() => null)
    enforceGlobalWriteAuthority(req.user, req.user.project, projectConfig?.is_global === true)

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

  // Constitutional Rule 3: note must be meaningful (min 10 chars, no placeholder patterns)
  // E2E: tests/e2e/scenarios/15-reason-placeholder.spec.js — S-15 REASON_REQUIRED on promote
  try {
    enforceReasonRequired(note, 'promote')
  } catch (err) {
    return next(err)
  }
  // Structural checks not covered by enforceReasonRequired
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

  // Constitutional Rule 3: reason must be meaningful (min 10 chars, no placeholder patterns)
  // E2E: tests/e2e/scenarios/15-reason-placeholder.spec.js — S-15 REASON_REQUIRED on supersede
  try {
    enforceReasonRequired(reason, 'supersede')
  } catch (err) {
    return next(err)
  }

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
    return next(err)
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

  // Constitutional Rule 3: reason must be meaningful (min 10 chars, no placeholder patterns)
  // E2E: tests/e2e/scenarios/15-reason-placeholder.spec.js — S-15 REASON_REQUIRED on deprecate
  try {
    enforceReasonRequired(reason, 'deprecate')
  } catch (err) {
    return next(err)
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

// ── GET /api/globals ───────────────────────────────────────────────────────────

/**
 * Return all global catalogs visible to the requesting project.
 *
 * Discovers projects with is_global = TRUE from PostgreSQL, enriches each
 * with metadata from S3/Redis config (global_scope, globals, display_name),
 * and filters by global_scope:
 *   'org' (or absent) → visible to all authenticated users.
 *   'division:<id>'  → visible only if the requesting project's hierarchy
 *                      parent chain includes that division id (Wave B: omitted
 *                      for org-scoped catalogs; full hierarchy scoping in v0.5).
 *   'department:<id>' → same, narrower.
 *
 * Response: Array of { group_id, display_name, global_scope, entry_count, globals }
 * Used by quorum:onboard to present catalog choices during project setup.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
router.get('/globals', async (req, res, next) => {
  try {
    const pool = req.app.locals.pool

    // Load the requesting project's config for hierarchy-based scope filtering.
    // Falls back to null (no hierarchy) so org-scoped catalogs are still returned.
    const requestingConfig = await loadProjectConfig(req.user.project).catch(() => null)
    const requestingParents = buildAncestorSet(requestingConfig)

    // Discover all global catalogs from PostgreSQL.
    const { rows: globalRows } = await pool.query(
      `SELECT qp.group_id, qp.display_name
         FROM q_projects qp
        WHERE qp.is_global = TRUE
        ORDER BY qp.group_id`,
    )

    if (globalRows.length === 0) {
      return res.json([])
    }

    // Enrich each catalog with S3/Redis config metadata and ACTIVE entry count.
    // Config fetch + count query are issued in parallel per catalog.
    const catalogs = await Promise.all(
      globalRows.map(async (row) => {
        const [config, countResult] = await Promise.all([
          loadProjectConfig(row.group_id).catch(() => null),
          pool.query(
            `SELECT COUNT(*) AS entry_count
               FROM knowledge_versions kv
               JOIN q_keys qk ON kv.q_key_id = qk.q_key_id
               JOIN q_projects qp ON qk.q_project_id = qp.q_project_id
              WHERE qp.group_id = $1
                AND kv.status = 'ACTIVE'`,
            [row.group_id],
          ).catch(() => null),
        ])

        const globalScope = config?.global_scope ?? 'org'
        const entryCount  = parseInt(countResult?.rows?.[0]?.entry_count ?? '0', 10)

        return {
          group_id:     row.group_id,
          display_name: config?.hierarchy?.display_name ?? row.display_name ?? row.group_id,
          global_scope: globalScope,
          entry_count:  entryCount,
          globals:      config?.globals ?? [],
        }
      }),
    )

    // Filter by global_scope — only return catalogs visible to the requesting project.
    const visible = catalogs.filter((c) => isScopeVisible(c.global_scope, requestingParents))

    res.json(visible)
  } catch (err) {
    next(err)
  }
})

/**
 * Build the set of hierarchy ancestor IDs for a project config.
 * Returns a Set of all parent/ancestor group_ids derived from the config.
 * Used for global_scope filtering (division:<id> / department:<id>).
 * @param {object | null} config
 * @returns {Set<string>}
 */
function buildAncestorSet(config) {
  const ancestors = new Set()
  if (!config?.hierarchy?.parent) return ancestors
  // Walk the parent chain. In Wave B configs are shallow (one parent), so a single
  // level is sufficient. Full multi-level ancestry traversal is a v0.5 concern.
  let current = config.hierarchy.parent
  while (current) {
    ancestors.add(current)
    // Prevent infinite loops from misconfigured circular hierarchies.
    break
  }
  return ancestors
}

/**
 * Return true if a catalog's global_scope is visible to the requesting project.
 * @param {string} scope  - 'org' | 'division:<id>' | 'department:<id>'
 * @param {Set<string>} requestingParents - ancestor group_ids of the requesting project
 * @returns {boolean}
 */
function isScopeVisible(scope, requestingParents) {
  if (!scope || scope === 'org') return true
  const match = scope.match(/^(?:division|department):(.+)$/)
  if (!match) return true  // unknown scope format — default to visible
  return requestingParents.has(match[1])
}

// ── Minimum severity for PA-authored catalog entries (cold-start floor) ────────
const PA_AUTHORED_FLOOR = 0.70

// ── Deviation routes ───────────────────────────────────────────────────────────

/**
 * POST /api/deviations
 * Record a single deviation from a linked global catalog entry.
 * All business logic (catalog validation, severity derivation, upsert) runs here.
 *
 * Returns:
 *   200 { status: 'not_linked', catalog_id, message }
 *   200 { status: 'not_found', catalog_id, topic, key, message }
 *   200 { status: 'recorded', deviation_id, catalog_id, topic, key, severity, is_new, message }
 *   400 on missing required fields
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
router.post('/deviations', async (req, res, next) => {
  try {
    const pool = req.app.locals.pool
    const { catalog_id, topic, key, description, evidence, source = 'agent', author = 'unknown' } = req.body ?? {}

    if (!catalog_id || !topic || !key || !description) {
      return res.status(400).json({ error: 'catalog_id, topic, key, and description are required' })
    }

    // ── 1. Verify catalog is in this project's linked globals list ────────────
    const projectConfig = await loadProjectConfig(req.user.project).catch(() => null)
    const globals = projectConfig?.globals ?? []

    if (!globals.includes(catalog_id)) {
      return res.json({
        status:     'not_linked',
        catalog_id,
        message:    `Catalog '${catalog_id}' is not in this project's globals list. ` +
                    `Add it to your .quorum file before recording deviations against it.`,
      })
    }

    // ── 2. Resolve internal IDs for the global catalog entry ─────────────────
    const catalogQProjectId = await getProjectByGroupId(pool, catalog_id)
    if (!catalogQProjectId) {
      return res.json({
        status:     'not_found',
        catalog_id,
        topic,
        key,
        message:    `Global catalog '${catalog_id}' is not registered in this Quorum instance.`,
      })
    }

    const catalogQKeyId = await getKeyId(pool, catalogQProjectId, topic, key)
    if (!catalogQKeyId) {
      return res.json({
        status:     'not_found',
        catalog_id,
        topic,
        key,
        message:    `Entry '${topic}:${key}' does not exist in catalog '${catalog_id}'.`,
      })
    }

    const globalEntry = await getCurrentVersion(pool, catalogQKeyId)
    if (!globalEntry) {
      return res.json({
        status:     'not_found',
        catalog_id,
        topic,
        key,
        message:    `Entry '${topic}:${key}' has no ACTIVE version in catalog '${catalog_id}'.`,
      })
    }

    // ── 3. Derive severity server-side ────────────────────────────────────────
    // severity = confidence × authority_score(author_role)
    // PA_AUTHORED_FLOOR prevents meaningless severity on cold-start global entries.
    const confidence    = globalEntry.confidence ?? 0.5
    const authorRole    = globalEntry.author_role ?? 'engineer'
    const authorityScore = DEFAULT_ROLE_SCORES[authorRole] ?? DEFAULT_ROLE_SCORES.engineer
    let severity = parseFloat((confidence * authorityScore).toFixed(3))
    if (authorRole === 'principal_architect' && severity < PA_AUTHORED_FLOOR) {
      severity = PA_AUTHORED_FLOOR
    }

    // ── 4. Resolve the calling project's q_project_id ────────────────────────
    const projectQProjectId = await getProjectByGroupId(pool, req.user.project)
    if (!projectQProjectId) {
      return res.status(400).json({ error: `Project '${req.user.project}' is not registered in this Quorum instance` })
    }

    // ── 5. Upsert the deviation record ────────────────────────────────────────
    const { deviation_id, is_new } = await upsertDeviation(pool, {
      qProjectId:  projectQProjectId,
      catalogId:   catalog_id,
      topic,
      key,
      description,
      evidence:    evidence ?? null,
      severity,
      source,
      entityType:  globalEntry.entity_type ?? null,
      createdBy:   author,
    })

    return res.json({
      status:      'recorded',
      deviation_id,
      catalog_id,
      topic,
      key,
      severity,
      is_new,
      message:     is_new
        ? `Deviation recorded (severity ${severity.toFixed(3)}).`
        : `Deviation updated — last_seen_at refreshed (severity ${severity.toFixed(3)}).`,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/deviations/batch
 * Batch upsert of deviations — used by quorum:scan after a full file scan.
 * Each record is validated and processed identically to POST /api/deviations.
 * Partial success is allowed — failed records are included in the response.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
router.post('/deviations/batch', async (req, res, next) => {
  try {
    const pool = req.app.locals.pool
    const { deviations } = req.body ?? {}

    if (!Array.isArray(deviations) || deviations.length === 0) {
      return res.status(400).json({ error: 'deviations array is required and must not be empty' })
    }
    if (deviations.length > 100) {
      return res.status(400).json({ error: 'batch size limit is 100 deviations per request' })
    }

    const projectConfig   = await loadProjectConfig(req.user.project).catch(() => null)
    const globals         = projectConfig?.globals ?? []
    const projectQProjId  = await getProjectByGroupId(pool, req.user.project)
    if (!projectQProjId) {
      return res.status(400).json({ error: `Project '${req.user.project}' is not registered in this Quorum instance` })
    }

    const results = await Promise.allSettled(deviations.map(async (d) => {
      const { catalog_id, topic, key, description, evidence, source = 'agent', author = 'unknown' } = d
      if (!catalog_id || !topic || !key || !description) {
        throw new Error('catalog_id, topic, key, and description are required')
      }
      if (!globals.includes(catalog_id)) {
        return { status: 'not_linked', catalog_id, topic, key }
      }
      const catalogQProjId = await getProjectByGroupId(pool, catalog_id)
      if (!catalogQProjId) return { status: 'not_found', catalog_id, topic, key }
      const catalogQKeyId  = await getKeyId(pool, catalogQProjId, topic, key)
      if (!catalogQKeyId)  return { status: 'not_found', catalog_id, topic, key }
      const globalEntry    = await getCurrentVersion(pool, catalogQKeyId)
      if (!globalEntry)    return { status: 'not_found', catalog_id, topic, key }

      const confidence     = globalEntry.confidence ?? 0.5
      const authorRole     = globalEntry.author_role ?? 'engineer'
      const authorityScore = DEFAULT_ROLE_SCORES[authorRole] ?? DEFAULT_ROLE_SCORES.engineer
      let severity = parseFloat((confidence * authorityScore).toFixed(3))
      if (authorRole === 'principal_architect' && severity < PA_AUTHORED_FLOOR) severity = PA_AUTHORED_FLOOR

      const { deviation_id, is_new } = await upsertDeviation(pool, {
        qProjectId: projectQProjId,
        catalogId:  catalog_id,
        topic,
        key,
        description,
        evidence:   evidence ?? null,
        severity,
        source,
        entityType: globalEntry.entity_type ?? null,
        createdBy:  author,
      })
      return { status: 'recorded', deviation_id, catalog_id, topic, key, severity, is_new }
    }))

    const processed = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { status: 'error', catalog_id: deviations[i]?.catalog_id, topic: deviations[i]?.topic,
            key: deviations[i]?.key, error: r.reason?.message ?? 'Unknown error' }
    )
    const recorded  = processed.filter((r) => r.status === 'recorded').length
    const failed    = processed.filter((r) => r.status === 'error').length

    return res.json({ recorded, failed, results: processed })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/deviations
 * List deviations for the current project with computed status.
 * Supports filters: status, catalog_id, topic, severity_min, source, limit, offset.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
router.get('/deviations', async (req, res, next) => {
  try {
    const pool = req.app.locals.pool
    const qProjectId = await getProjectByGroupId(pool, req.user.project)
    if (!qProjectId) {
      return res.status(400).json({ error: `Project '${req.user.project}' is not registered in this Quorum instance` })
    }

    const filters = {
      status:      req.query.status,
      catalogId:   req.query.catalog_id,
      topic:       req.query.topic,
      severityMin: req.query.severity_min !== undefined ? parseFloat(req.query.severity_min) : undefined,
      source:      req.query.source,
      limit:       req.query.limit  !== undefined ? parseInt(req.query.limit,  10) : 50,
      offset:      req.query.offset !== undefined ? parseInt(req.query.offset, 10) : 0,
    }

    const deviations = await getDeviationsByProject(pool, qProjectId, filters)
    return res.json({ deviations, total: deviations.length })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/deviations/:id/action
 * PE/Architect actions a deviation: accept, deny, or defer.
 * Constitutional checks: role gate (architect+), reason ≥10 chars, valid defer days.
 *
 * Body: { action_type: 'accept'|'deny'|'defer', reason: string, defer_until?: string }
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
router.post('/deviations/:id/action', async (req, res, next) => {
  try {
    const pool = req.app.locals.pool
    const deviationId = req.params.id
    const { action_type, reason, defer_until } = req.body ?? {}
    const actorRole = req.user.role

    // ── Constitutional enforcement ────────────────────────────────────────────
    enforceDeviationActionAuthority(actorRole, action_type)
    enforceReasonRequired(reason)

    if (action_type === 'defer') {
      if (!defer_until) {
        return res.status(400).json({ error: 'defer_until is required for defer action' })
      }
      enforceValidDeferDeadline(defer_until)
    }

    // Verify the deviation exists and belongs to this project
    const { rows: devRows } = await pool.query(
      `SELECT d.deviation_id, d.q_project_id, qp.group_id
       FROM deviations d
       JOIN q_projects qp ON d.q_project_id = qp.q_project_id
       WHERE d.deviation_id = $1`,
      [deviationId],
    )
    if (devRows.length === 0) {
      return res.status(404).json({ error: `Deviation '${deviationId}' not found` })
    }
    if (devRows[0].group_id !== req.user.project) {
      return res.status(403).json({ error: 'Cannot action a deviation belonging to a different project' })
    }

    const actionId = await insertDeviationAction(pool, {
      deviationId,
      actionType: action_type,
      actor:      req.user.sub,
      actorRole,
      reason,
      deferUntil: defer_until ?? null,
    })

    // Contextual note when denying a high-confidence PA-authored standard
    let denialHint
    if (action_type === 'deny') {
      const { rows: entryRows } = await pool.query(
        `SELECT kv.confidence, kv.author_role
         FROM deviations d
         JOIN q_projects cp    ON d.catalog_id = cp.group_id
         JOIN q_keys qk        ON qk.q_project_id = cp.q_project_id
                               AND qk.topic = d.topic AND qk.key = d.key
         JOIN knowledge_versions kv ON kv.q_key_id = qk.q_key_id AND kv.status = 'ACTIVE'
         WHERE d.deviation_id = $1`,
        [deviationId],
      )
      const entry = entryRows[0]
      if (entry?.author_role === 'principal_architect' && entry?.confidence > 0.85) {
        denialHint = 'This global standard was authored by a principal_architect with high confidence. ' +
                     'Consider adding a project-level knowledge entry to document your reasoning for this exception.'
      }
    }

    return res.json({ action_id: actionId, deviation_id: deviationId, action_type, ...(denialHint ? { hint: denialHint } : {}) })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/conformance ──────────────────────────────────────────────────────

/**
 * Project conformance scorecard.
 *
 * Returns the project's weighted conformance score (0–100) across all linked
 * global catalogs, plus a per-catalog entry count and scan metadata.
 *
 * Returns `{ status: 'UNCERTIFIED' }` (no numeric score) when:
 *   - The project has no linked global catalogs
 *   - Total ACTIVE entries across all linked catalogs is fewer than 10
 *   - No scan has been run yet (scan_count = 0)
 *
 * Response shape:
 *   {
 *     score:             number | null,
 *     status:            'CERTIFIED' | 'UNCERTIFIED',
 *     applicable_entries: number,
 *     scan_count:        number,
 *     last_scan_at:      string | null,
 *     breakdown:         { open, accepted, denied, deferred, overdue, resolved },
 *     catalogs:          [{ catalog_id, entry_count }],
 *   }
 */
router.get('/conformance', async (req, res, next) => {
  const pool = req.app.locals.pool

  try {
    const qProjectId = await resolveQProjectId(req, res)
    if (!qProjectId) return

    const projectConfig = await loadProjectConfig(req.user.project).catch(() => null)
    const globals       = projectConfig?.globals ?? []

    const score = await getConformanceScore(pool, qProjectId, globals)

    // Per-catalog ACTIVE entry counts (batch query, zero round-trips per catalog).
    let catalogs = []
    if (globals.length > 0) {
      const { rows } = await pool.query(
        `SELECT qp.group_id AS catalog_id, COUNT(*)::int AS entry_count
         FROM knowledge_versions kv
         JOIN q_keys qk ON kv.q_key_id = qk.q_key_id
         JOIN q_projects qp ON qk.q_project_id = qp.q_project_id
         WHERE qp.group_id = ANY($1)
           AND kv.status = 'ACTIVE'
         GROUP BY qp.group_id`,
        [globals],
      )
      catalogs = rows.map((r) => ({ catalog_id: r.catalog_id, entry_count: r.entry_count }))
    }

    return res.json({ ...score, catalogs })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/portfolio ────────────────────────────────────────────────────────

/**
 * Portfolio conformance view — all accessible projects with their conformance
 * scores, optionally scoped to a hierarchy node.
 *
 * Auth: is_admin OR principal_architect OR director OR vp_engineering OR group_executive.
 *
 * Query params:
 *   node_id?  — hierarchy group_id to scope; filters to projects whose
 *               config.hierarchy.parent === node_id (direct children only).
 *               Omit to return all accessible projects.
 *
 * Response shape:
 *   {
 *     projects: [{
 *       group_id, display_name, hierarchy_level, criticality,
 *       score, status, breakdown, scan_count, last_scan_at
 *     }],
 *     rollup: { score, status, certified_count, uncertified_count } | null,
 *   }
 */
const PORTFOLIO_ROLES = new Set(['principal_architect', 'director', 'vp_engineering', 'group_executive'])

router.get('/portfolio', async (req, res, next) => {
  const pool = req.app.locals.pool

  try {
    // Role gate: admin or senior role only
    if (!req.user.is_admin && !PORTFOLIO_ROLES.has(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', message: 'Portfolio view requires architect-level or executive role.' })
    }

    const nodeId = req.query.node_id ?? null

    // Fetch all registered projects from PostgreSQL
    const { rows: projectRows } = await pool.query(
      `SELECT q_project_id, group_id FROM q_projects ORDER BY group_id`,
    )

    // Load configs in parallel (graceful fallback to empty config on miss)
    const projectInfos = (
      await Promise.all(
        projectRows.map(async ({ q_project_id, group_id }) => {
          const cfg = await loadProjectConfig(group_id).catch(() => null)
          // Apply node_id filter: include only projects whose hierarchy.parent === node_id
          if (nodeId && cfg?.hierarchy?.parent !== nodeId) return null
          return {
            groupId:        group_id,
            qProjectId:     q_project_id,
            catalogGroupIds: cfg?.globals ?? [],
            criticality:    cfg?.hierarchy?.criticality ?? 1,
            displayName:    cfg?.hierarchy?.display_name ?? cfg?.project ?? group_id,
            hierarchyLevel: cfg?.hierarchy?.level ?? null,
          }
        }),
      )
    ).filter(Boolean)

    // Compute conformance scores in parallel
    const scores = await getPortfolioScores(pool, projectInfos)

    // Weighted rollup over CERTIFIED projects only
    const certified = scores.filter((p) => p.status === 'CERTIFIED')
    let rollup = null
    if (certified.length > 0) {
      const weightedSum = certified.reduce((s, p) => s + (p.score ?? 0) * p.criticality, 0)
      const totalWeight = certified.reduce((s, p) => s + p.criticality, 0)
      rollup = {
        score:             totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null,
        status:            'CERTIFIED',
        certified_count:   certified.length,
        uncertified_count: scores.length - certified.length,
      }
    } else if (scores.length > 0) {
      rollup = { score: null, status: 'UNCERTIFIED', certified_count: 0, uncertified_count: scores.length }
    }

    return res.json({
      projects: scores.map((p) => ({
        group_id:        p.groupId,
        display_name:    p.displayName,
        hierarchy_level: p.hierarchyLevel,
        criticality:     p.criticality,
        score:           p.score,
        status:          p.status,
        breakdown:       p.breakdown,
        scan_count:      p.scan_count,
        last_scan_at:    p.last_scan_at,
      })),
      rollup,
    })
  } catch (err) {
    next(err)
  }
})

export default router
