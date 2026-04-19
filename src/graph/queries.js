/**
 * PostgreSQL queries for the knowledge_versions and version_audit_links tables.
 *
 * All writes are INSERT-only except transitionVersionStatus(), which is the
 * single permitted UPDATE path — status field transitions only.
 *
 * These queries operate on the secondary (compliance) store.
 * The primary (graph) store is managed via src/graph/client.js.
 */

import { KnowledgeStatus } from './schema.js'

/** Legal version status transitions. */
const LEGAL_TRANSITIONS = new Map([
  [`${KnowledgeStatus.DRAFT}->${KnowledgeStatus.ACTIVE}`, true],
  [`${KnowledgeStatus.DRAFT}->${KnowledgeStatus.REJECTED}`, true],
  [`${KnowledgeStatus.ACTIVE}->${KnowledgeStatus.SUPERSEDED}`, true],
  [`${KnowledgeStatus.ACTIVE}->${KnowledgeStatus.DEPRECATED}`, true],
])

/**
 * Get the currently ACTIVE version for a topic:key.
 * Returns null if no active version exists.
 * @param {import('pg').Pool} pg
 * @param {string} topic
 * @param {string} key
 * @param {string} [projectId='default'] - Project scope (enforced by gateway)
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getCurrentVersion(pg, topic, key, projectId = 'default') {
  const result = await pg.query(
    `SELECT * FROM knowledge_versions
     WHERE project_id = $1 AND topic = $2 AND key = $3 AND status = $4
     LIMIT 1`,
    [projectId, topic, key, KnowledgeStatus.ACTIVE],
  )
  return result.rows[0] ?? null
}

/**
 * Get the version that was ACTIVE on a specific date (point-in-time recall).
 * @param {import('pg').Pool} pg
 * @param {string} topic
 * @param {string} key
 * @param {string} date - ISO date string
 * @param {string} [projectId='default']
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getVersionAtDate(pg, topic, key, date, projectId = 'default') {
  const result = await pg.query(
    `SELECT * FROM knowledge_versions
     WHERE project_id = $1
       AND topic = $2
       AND key = $3
       AND created_at <= $4
       AND (
         status = 'ACTIVE'
         OR (
           status = 'SUPERSEDED'
           AND (superseded_at IS NULL OR superseded_at > $4)
         )
       )
     ORDER BY version DESC
     LIMIT 1`,
    [projectId, topic, key, date],
  )
  return result.rows[0] ?? null
}

/**
 * Get all versions for a topic:key, ordered newest first.
 * @param {import('pg').Pool} pg
 * @param {string} topic
 * @param {string} key
 * @param {string} [projectId='default']
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getVersionHistory(pg, topic, key, projectId = 'default') {
  const result = await pg.query(
    `SELECT * FROM knowledge_versions
     WHERE project_id = $1 AND topic = $2 AND key = $3
     ORDER BY version DESC`,
    [projectId, topic, key],
  )
  return result.rows
}

/**
 * Get a specific version number for a topic:key.
 * @param {import('pg').Pool} pg
 * @param {string} topic
 * @param {string} key
 * @param {number} version
 * @param {string} [projectId='default']
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getSpecificVersion(pg, topic, key, version, projectId = 'default') {
  const result = await pg.query(
    `SELECT * FROM knowledge_versions
     WHERE project_id = $1 AND topic = $2 AND key = $3 AND version = $4
     LIMIT 1`,
    [projectId, topic, key, version],
  )
  return result.rows[0] ?? null
}

/**
 * Get the next version number for a topic:key.
 * Returns 1 if no versions exist yet.
 * @param {import('pg').Pool} pg
 * @param {string} topic
 * @param {string} key
 * @param {string} [projectId='default']
 * @returns {Promise<number>}
 */
export async function getNextVersionNumber(pg, topic, key, projectId = 'default') {
  const result = await pg.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
     FROM knowledge_versions
     WHERE project_id = $1 AND topic = $2 AND key = $3`,
    [projectId, topic, key],
  )
  return result.rows[0].next_version
}

/**
 * Insert a new version record. Append-only — never call UPDATE.
 * @param {import('pg').Pool} pg
 * @param {Record<string, unknown>} record
 * @returns {Promise<Record<string, unknown>>}
 */
export async function insertVersion(pg, record) {
  const result = await pg.query(
    `INSERT INTO knowledge_versions (
      topic, key, version, status, content_hash, author, author_role,
      confidence, starting_confidence,
      created_at, created_by_audit, triggered_by, conflict_id,
      graphiti_episode_id,
      supersedes_version, supersedes_reason,
      superseded_by_version, superseded_by_author, superseded_at,
      tags, project_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    RETURNING *`,
    [
      record.topic,
      record.key,
      record.version,
      record.status,
      record.content_hash,
      record.author,
      record.author_role       ?? 'unknown',
      record.confidence        ?? 0.7,
      record.starting_confidence ?? record.confidence ?? 0.7,
      record.created_at,
      record.created_by_audit,
      record.triggered_by,
      record.conflict_id       ?? null,
      record.graphiti_episode_id ?? null,
      record.supersedes_version  ?? null,
      record.supersedes_reason   ?? null,
      record.superseded_by_version ?? null,
      record.superseded_by_author  ?? null,
      record.superseded_at         ?? null,
      record.tags ?? [],
      record.project_id ?? process.env.QUORUM_PROJECT_ID ?? 'default',
    ],
  )
  return result.rows[0]
}

/**
 * Get all ACTIVE versions that contain a specific tag (project-scoped).
 * Tag containment query uses the GIN index on the tags column.
 * @param {import('pg').Pool} pg
 * @param {string} tag - Normalized (lowercase, trimmed) tag to search for
 * @param {string} [projectId='default']
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getVersionsByTag(pg, tag, projectId = 'default') {
  const result = await pg.query(
    `SELECT * FROM knowledge_versions
     WHERE project_id = $1 AND $2 = ANY(tags) AND status = 'ACTIVE'
     ORDER BY created_at DESC`,
    [projectId, tag.toLowerCase().trim()],
  )
  return result.rows
}

/**
 * Transition a version's status and optionally set the forward link fields.
 * This is the ONLY permitted UPDATE on knowledge_versions.
 * Validates that the transition is legal before executing.
 *
 * @param {import('pg').Pool} pg
 * @param {string} topic
 * @param {string} key
 * @param {number} version
 * @param {string} newStatus
 * @param {{ supersededByVersion?: number, supersededByAuthor?: string } | null} [forwardLink]
 * @param {string} [projectId='default']
 * @returns {Promise<Record<string, unknown>>}
 */
export async function transitionVersionStatus(pg, topic, key, version, newStatus, forwardLink = null, projectId = 'default') {
  const current = await getSpecificVersion(pg, topic, key, version, projectId)
  if (!current) {
    throw new Error(`Version not found: ${topic}:${key} v${version}`)
  }

  const transitionKey = `${current.status}->${newStatus}`
  if (!LEGAL_TRANSITIONS.has(transitionKey)) {
    throw new Error(
      `Illegal status transition: ${current.status} → ${newStatus} for ${topic}:${key} v${version}`,
    )
  }

  const now = new Date().toISOString()

  if (forwardLink) {
    const result = await pg.query(
      `UPDATE knowledge_versions
       SET status = $1,
           superseded_by_version = $2,
           superseded_by_author = $3,
           superseded_at = $4
       WHERE topic = $5 AND key = $6 AND version = $7
       RETURNING *`,
      [newStatus, forwardLink.supersededByVersion, forwardLink.supersededByAuthor, now, topic, key, version],
    )
    return result.rows[0]
  }

  const result = await pg.query(
    `UPDATE knowledge_versions
     SET status = $1
     WHERE topic = $2 AND key = $3 AND version = $4
     RETURNING *`,
    [newStatus, topic, key, version],
  )
  return result.rows[0]
}

/**
 * Insert a version ↔ audit cross-reference link.
 * @param {import('pg').Pool} pg
 * @param {{ auditEntryId: string, topic: string, key: string, version: number, linkType: 'created'|'superseded' }} record
 */
export async function insertVersionAuditLink(pg, record) {
  await pg.query(
    `INSERT INTO version_audit_links (audit_entry_id, topic, key, version, link_type, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [record.auditEntryId, record.topic, record.key, record.version, record.linkType],
  )
}

/**
 * Get the latest DRAFT version for a topic:key (for review flow).
 * Returns null if no DRAFT exists.
 * @param {import('pg').Pool} pg
 * @param {string} topic
 * @param {string} key
 * @param {string} [projectId='default']
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getLatestDraftVersion(pg, topic, key, projectId = 'default') {
  const result = await pg.query(
    `SELECT * FROM knowledge_versions
     WHERE project_id = $1 AND topic = $2 AND key = $3 AND status = 'DRAFT'
     ORDER BY version DESC LIMIT 1`,
    [projectId, topic, key],
  )
  return result.rows[0] ?? null
}

/**
 * Get all versions matching a given status (for export).
 * @param {import('pg').Pool} pg
 * @param {string} status - KnowledgeStatus value
 * @param {{ topic?: string, projectId?: string }} [opts]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getVersionsByStatus(pg, status, { topic, projectId = 'default' } = {}) {
  if (topic) {
    const result = await pg.query(
      `SELECT * FROM knowledge_versions
       WHERE project_id = $1 AND topic = $2 AND status = $3
       ORDER BY topic, key`,
      [projectId, topic, status],
    )
    return result.rows
  }
  const result = await pg.query(
    `SELECT * FROM knowledge_versions
     WHERE project_id = $1 AND status = $2
     ORDER BY topic, key`,
    [projectId, status],
  )
  return result.rows
}

/**
 * Get version count grouped by status (for export stats).
 * @param {import('pg').Pool} pg
 * @param {{ topic?: string, projectId?: string }} [opts]
 * @returns {Promise<Record<string, number>>}
 */
export async function getVersionStatusCounts(pg, { topic, projectId = 'default' } = {}) {
  const result = topic
    ? await pg.query(
        `SELECT status, COUNT(*)::int AS count FROM knowledge_versions
         WHERE project_id = $1 AND topic = $2 GROUP BY status`,
        [projectId, topic],
      )
    : await pg.query(
        `SELECT status, COUNT(*)::int AS count FROM knowledge_versions
         WHERE project_id = $1 GROUP BY status`,
        [projectId],
      )
  return Object.fromEntries(result.rows.map((r) => [r.status, r.count]))
}

// ── pending_decisions queries ──────────────────────────────────────────────────

/**
 * Fetch pending decisions, optionally filtered by topic and status array.
 * @param {import('pg').Pool} pg
 * @param {{ topic?: string, statuses?: string[], decisionType?: string, projectId?: string }} opts
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getPendingDecisions(pg, { topic, statuses = ['pending'], decisionType = 'conflict', projectId = 'default' } = {}) {
  if (topic) {
    const result = await pg.query(
      `SELECT * FROM pending_decisions
       WHERE project_id = $1 AND status = ANY($2) AND decision_type = $3 AND conflict_topic = $4
       ORDER BY created_at ASC`,
      [projectId, statuses, decisionType, topic],
    )
    return result.rows
  }
  const result = await pg.query(
    `SELECT * FROM pending_decisions
     WHERE project_id = $1 AND status = ANY($2) AND decision_type = $3
     ORDER BY created_at ASC`,
    [projectId, statuses, decisionType],
  )
  return result.rows
}

/**
 * Get DRAFT knowledge versions awaiting review, optionally topic-filtered.
 * @param {import('pg').Pool} pg
 * @param {{ topic?: string, projectId?: string }} [opts]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getDraftVersions(pg, { topic, projectId = 'default' } = {}) {
  if (topic) {
    const result = await pg.query(
      `SELECT * FROM knowledge_versions
       WHERE project_id = $1 AND topic = $2 AND status = 'DRAFT'
       ORDER BY created_at ASC`,
      [projectId, topic],
    )
    return result.rows
  }
  const result = await pg.query(
    `SELECT * FROM knowledge_versions
     WHERE project_id = $1 AND status = 'DRAFT'
     ORDER BY created_at ASC`,
    [projectId],
  )
  return result.rows
}

/**
 * Mark a pending decision as stale and update the current active version.
 * @param {import('pg').Pool} pg
 * @param {string} conflictId
 * @param {string} staleWarning
 * @param {number} currentVersion
 */
export async function markPendingDecisionStale(pg, conflictId, staleWarning, currentVersion) {
  await pg.query(
    `UPDATE pending_decisions
     SET stale_warning = $1, current_active_version = $2, status = 'stale', updated_at = NOW()
     WHERE conflict_id = $3`,
    [staleWarning, currentVersion, conflictId],
  )
}

/**
 * Count pending decisions for a specific topic:key (ordering context).
 * @param {import('pg').Pool} pg
 * @param {string} topic
 * @param {string} key
 * @param {string} [projectId='default']
 * @returns {Promise<number>}
 */
export async function countPendingForKey(pg, topic, key, projectId = 'default') {
  const result = await pg.query(
    `SELECT COUNT(*)::int AS cnt FROM pending_decisions
     WHERE project_id = $1 AND conflict_topic = $2 AND conflict_key = $3 AND status = 'pending'`,
    [projectId, topic, key],
  )
  return result.rows[0]?.cnt ?? 0
}

/**
 * Fetch a single pending decision by conflict ID.
 * @param {import('pg').Pool} pg
 * @param {string} conflictId
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getPendingDecisionById(pg, conflictId) {
  const result = await pg.query(
    `SELECT * FROM pending_decisions WHERE conflict_id = $1 AND status = 'pending'`,
    [conflictId],
  )
  return result.rows[0] ?? null
}

/**
 * Insert a new pending decision record.
 * @param {import('pg').Pool} pg
 * @param {Record<string, unknown>} record
 */
export async function insertPendingDecision(pg, record) {
  await pg.query(
    `INSERT INTO pending_decisions
       (conflict_id, decision_type, conflict_topic, conflict_key,
        active_version_at_creation, existing_content, incoming_content,
        conflict_reason, enrichment, more_pending_same_key, project_id)
     VALUES ($1, 'conflict', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      record.conflict_id,
      record.conflict_topic,
      record.conflict_key,
      record.active_version_at_creation,
      record.existing_content ?? null,
      record.incoming_content,
      record.conflict_reason,
      typeof record.enrichment === 'string' ? record.enrichment : JSON.stringify(record.enrichment),
      record.more_pending_same_key ?? 0,
      record.project_id ?? 'default',
    ],
  )
}

/**
 * Resolve or update a pending decision (set status, note, resolution details).
 * @param {import('pg').Pool} pg
 * @param {string} conflictId
 * @param {{ status: string, resolution: string, note: string, resolvedBy: string, splitExistingKey?: string|null, splitIncomingKey?: string|null, mergedContent?: string|null }} updates
 */
export async function resolvePendingDecision(pg, conflictId, updates) {
  await pg.query(
    `UPDATE pending_decisions
     SET status = $1, resolution = $2, resolution_note = $3, resolved_by = $4,
         resolved_at = NOW(), updated_at = NOW(),
         split_existing_key = $5, split_incoming_key = $6, merged_content = $7
     WHERE conflict_id = $8`,
    [
      updates.status,
      updates.resolution,
      updates.note,
      updates.resolvedBy,
      updates.splitExistingKey ?? null,
      updates.splitIncomingKey ?? null,
      updates.mergedContent ?? null,
      conflictId,
    ],
  )
}

// ── Confidence lifecycle (GAP-04, GAP-24) ─────────────────────────────────────

/**
 * Update the confidence score for a specific knowledge version row (decay or bump).
 * Also resets last_accessed_at to now.
 * @param {import('pg').Pool} pg
 * @param {number} id - knowledge_versions.id (serial PK)
 * @param {number} newConfidence
 */
export async function updateConfidence(pg, id, newConfidence) {
  await pg.query(
    `UPDATE knowledge_versions
     SET confidence = $1, last_accessed_at = NOW()
     WHERE id = $2`,
    [newConfidence, id],
  )
}

/**
 * Reset last_accessed_at to now (called on every recall()).
 * @param {import('pg').Pool} pg
 * @param {string} topic
 * @param {string} key
 * @param {string} [projectId='default']
 */
export async function updateLastAccessed(pg, topic, key, projectId = 'default') {
  await pg.query(
    `UPDATE knowledge_versions
     SET last_accessed_at = NOW()
     WHERE project_id = $1 AND topic = $2 AND key = $3 AND status = 'ACTIVE'`,
    [projectId, topic, key],
  )
}

/**
 * Fetch all ACTIVE knowledge versions eligible for confidence decay.
 * Eligible = older than 7 days, confidence above floor (0.10).
 * @param {import('pg').Pool} pg
 * @param {string} [projectId='default']
 * @param {number} [batchSize=200]
 * @returns {Promise<Array<{ id: number, topic: string, key: string, confidence: number, starting_confidence: number, last_accessed_at: string | null, created_at: string }>>}
 */
export async function getDecayEligibleVersions(pg, projectId = 'default', batchSize = 200) {
  const result = await pg.query(
    `SELECT id, topic, key, confidence, starting_confidence, last_accessed_at, created_at
     FROM knowledge_versions
     WHERE project_id = $1
       AND status = 'ACTIVE'
       AND created_at < NOW() - INTERVAL '7 days'
       AND confidence > 0.10
     ORDER BY last_accessed_at ASC NULLS FIRST
     LIMIT $2`,
    [projectId, batchSize],
  )
  return result.rows
}

/**
 * Check the bump_log for the most recent bump by an author for a topic:key.
 * Returns null if no bump found, or the row if a cooldown-relevant bump exists.
 * @param {import('pg').Pool} pg
 * @param {string} author
 * @param {string} topic
 * @param {string} key
 * @param {string} projectId
 * @returns {Promise<{ bumped_at: string } | null>}
 */
export async function getLastBump(pg, author, topic, key, projectId) {
  const result = await pg.query(
    `SELECT bumped_at FROM bump_log
     WHERE author = $1 AND topic = $2 AND key = $3 AND project_id = $4
     ORDER BY bumped_at DESC LIMIT 1`,
    [author, topic, key, projectId],
  )
  return result.rows[0] ?? null
}

/**
 * Record a bump action in bump_log.
 * @param {import('pg').Pool} pg
 * @param {{ author: string, topic: string, key: string, projectId: string, role: string, deltaApplied: number }} record
 */
export async function insertBump(pg, record) {
  await pg.query(
    `INSERT INTO bump_log (author, topic, key, project_id, role, delta_applied)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [record.author, record.topic, record.key, record.projectId, record.role, record.deltaApplied],
  )
}
