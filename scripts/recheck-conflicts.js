#!/usr/bin/env node
/**
 * recheck-conflicts.js — GAP-03 deferred conflict check CronJob.
 *
 * Runs on a schedule (every 5 minutes via Helm CronJob).
 * Finds all knowledge_versions with status = PENDING_CONFLICT_CHECK and
 * re-runs conflict detection now that Graphiti may have recovered.
 *
 * Algorithm:
 *   1. Fetch up to BATCH_SIZE pending rows (oldest first)
 *   2. Ping Graphiti — if still unavailable, exit early (no point checking)
 *   3. For each row:
 *      a. Run detectConflict()
 *      b. If graphiti_unavailable again → break (Graphiti back down mid-run)
 *      c. If conflict detected → insert pending_decisions entry, leave as DRAFT
 *      d. If clean → promote to ACTIVE (or leave DRAFT for claude/reflect authors)
 *   4. Write audit log entry for each processed row
 *
 * Batch limit: 50 rows. At 5-minute cadence: 600 deferred checks/hour — enough
 * to drain a realistic outage queue within 1–2 runs after Graphiti recovers.
 */

import pg from 'pg'
import { fileURLToPath } from 'node:url'
import { detectConflict } from '../gateway/src/shared/governance/conflict.js'
import { KnowledgeStatus, TriggeredBy } from '../gateway/src/shared/graph/schema.js'

const BATCH_SIZE   = parseInt(process.env.RECHECK_BATCH_SIZE   ?? '50', 10)
const GRAPHITI_URL = process.env.GRAPHITI_URL                  ?? 'http://graphiti:8000'

// ── PostgreSQL connection ─────────────────────────────────────────────────────

const pgSsl = process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: true } : false

const pool = new pg.Pool({
  host:     process.env.POSTGRES_HOST     ?? 'localhost',
  port:     parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB       ?? 'quorum_audit',
  user:     process.env.POSTGRES_USER     ?? 'quorum',
  password: process.env.POSTGRES_PASSWORD ?? 'quorum_local',
  ssl:      pgSsl,
})

/**
 * Build the audit version_impact payload for a processed row.
 * @param {string | null} supersededVersionId
 * @returns {{ versions_created: never[], versions_superseded: Array<{ version_id: string }> }}
 */
export function buildVersionImpact(supersededVersionId) {
  return {
    versions_created:    [],
    versions_superseded: supersededVersionId ? [{ version_id: supersededVersionId }] : [],
  }
}

// ── Graphiti liveness check ───────────────────────────────────────────────────

/**
 * Perform a fast liveness ping against Graphiti.
 * @returns {Promise<boolean>} true if reachable
 */
async function pingGraphiti() {
  try {
    const res = await fetch(`${GRAPHITI_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Load the linked global catalogs for a project so deferred conflict checks use
 * the same federation scope as the live remember() path.
 * @param {import('pg').Pool} poolInstance
 * @param {string} qProjectId
 * @returns {Promise<string[]>}
 */
export async function getProjectGlobals(poolInstance, qProjectId) {
  const { rows } = await poolInstance.query(
    `SELECT pc.config_json
       FROM project_configs pc
      WHERE pc.q_project_id = $1
      ORDER BY pc.created_at DESC
      LIMIT 1`,
    [qProjectId],
  )

  return rows[0]?.config_json?.globals ?? []
}

/**
 * Look up the currently ACTIVE sibling for a pending row.
 * @param {import('pg').PoolClient} client
 * @param {{ q_project_id: string, q_key_id: string, version_id: string }} row
 * @returns {Promise<{ version_id: string, version: number, summary: string } | null>}
 */
async function getActiveSibling(client, row) {
  const { rows } = await client.query(
    `SELECT version_id, version, summary
       FROM knowledge_versions
      WHERE q_project_id = $1
        AND q_key_id = $2
        AND version_id <> $3
        AND status = $4
      ORDER BY version DESC
      LIMIT 1`,
    [row.q_project_id, row.q_key_id, row.version_id, KnowledgeStatus.ACTIVE],
  )

  return rows[0] ?? null
}

/**
 * Persist a reviewer-visible pending_decisions record for a deferred row that
 * turns out to conflict once Graphiti recovers.
 * @param {import('pg').PoolClient} client
 * @param {{ version_id: string, q_key_id: string, q_project_id: string, summary: string }} row
 * @param {{ version: number, summary: string } | null} activeSibling
 * @param {string | undefined} reason
 * @param {() => number} now
 * @returns {Promise<string>}
 */
async function insertRecheckPendingDecision(client, row, activeSibling, reason, now) {
  const conflictId = `recheck_conflict_${row.version_id}_${now()}`
  await client.query(
    `INSERT INTO pending_decisions
       (conflict_id, q_key_id, q_project_id, decision_type,
        active_version_at_creation, existing_content, incoming_content,
        conflict_reason, more_pending_same_key)
     VALUES ($1, $2, $3, 'conflict', $4, $5, $6, $7, 0)`,
    [
      conflictId,
      row.q_key_id,
      row.q_project_id,
      activeSibling?.version ?? null,
      activeSibling?.summary ?? null,
      row.summary,
      reason ?? 'Conflict detected by recheck job',
    ],
  )
  return conflictId
}

/**
 * Re-check one deferred knowledge_versions row and perform the appropriate
 * status transition.
 * @param {import('pg').Pool} poolInstance
 * @param {{ version_id: string, q_key_id: string, q_project_id: string, topic: string, key: string, version: number, summary: string, author: string, triggered_by: string }} row
 * @param {{ detectConflictFn?: typeof detectConflict, now?: () => number }} [deps]
 * @returns {Promise<{ outcome: 'promoted' | 'conflicted' | 'deferred', newStatus: string | null, conflictResult: Record<string, unknown>, supersededVersionId: string | null }>}
 */
export async function processPendingRow(poolInstance, row, deps = {}) {
  const detectConflictFn = deps.detectConflictFn ?? detectConflict
  const now = deps.now ?? Date.now
  const globals = await getProjectGlobals(poolInstance, row.q_project_id)

  const conflictResult = await detectConflictFn(
    row.summary,
    row.topic,
    row.key,
    row.topic,
    null,
    row.q_project_id,
    globals,
  ).catch(() => ({
    conflict: false,
    graphiti_unavailable: true,
  }))

  if (conflictResult.graphiti_unavailable) {
    return {
      outcome:             'deferred',
      newStatus:           null,
      conflictResult,
      supersededVersionId: null,
    }
  }

  if (conflictResult.conflict) {
    const client = await poolInstance.connect()
    try {
      await client.query('BEGIN')
      const activeSibling = await getActiveSibling(client, row)
      await client.query(
        `UPDATE knowledge_versions SET status = $1 WHERE version_id = $2`,
        [KnowledgeStatus.DRAFT, row.version_id],
      )
      await insertRecheckPendingDecision(client, row, activeSibling, conflictResult.reason, now)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return {
      outcome:             'conflicted',
      newStatus:           KnowledgeStatus.DRAFT,
      conflictResult,
      supersededVersionId: null,
    }
  }

  const isDraftAuthor =
    row.author === 'claude' ||
    row.author === 'anonymous' ||
    row.triggered_by === TriggeredBy.REFLECT

  const newStatus = isDraftAuthor ? KnowledgeStatus.DRAFT : KnowledgeStatus.ACTIVE
  let supersededVersionId = null

  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')

    if (newStatus === KnowledgeStatus.ACTIVE) {
      const { rows } = await client.query(
        `UPDATE knowledge_versions
            SET status = $1
          WHERE q_project_id = $2
            AND q_key_id = (
              SELECT q_key_id FROM knowledge_versions WHERE version_id = $3
            )
            AND status = $4
            AND version_id <> $3
        RETURNING version_id`,
        [KnowledgeStatus.SUPERSEDED, row.q_project_id, row.version_id, KnowledgeStatus.ACTIVE],
      )
      supersededVersionId = rows[0]?.version_id ?? null
    }

    await client.query(
      `UPDATE knowledge_versions SET status = $1 WHERE version_id = $2`,
      [newStatus, row.version_id],
    )

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  return {
    outcome:             'promoted',
    newStatus,
    conflictResult,
    supersededVersionId,
  }
}

/**
 * Write the lightweight audit entry emitted after each processed deferred row.
 * @param {import('pg').Pool} poolInstance
 * @param {{ version_id: string, topic: string, key: string, version: number }} row
 * @param {{ conflict: boolean }} conflictResult
 * @param {string | null} supersededVersionId
 * @param {() => number} [now]
 * @returns {Promise<void>}
 */
export async function writeRecheckAudit(poolInstance, row, conflictResult, supersededVersionId, now = Date.now) {
  await poolInstance.query(
    `INSERT INTO audit_log
       (entry_id, operation, tool, timestamp, author, author_role, content_hash,
        governance_json, outcome_json, version_impact, entry_hash, chain_position, q_project_id)
     SELECT
       $1, 'conflict_recheck_complete', 'recheck-conflicts', NOW(), 'system', 'system',
       content_hash,
       $2::jsonb, $3::jsonb, $4::jsonb,
       encode(sha256(($1 || content_hash)::bytea), 'hex'),
       COALESCE((SELECT MAX(chain_position) FROM audit_log), 0) + 1,
       q_project_id
     FROM knowledge_versions WHERE version_id = $5`,
    [
      `recheck_${row.version_id}_${now()}`,
      JSON.stringify({ topic: row.topic, key: row.key, version: row.version }),
      JSON.stringify({ conflict: conflictResult.conflict }),
      JSON.stringify(buildVersionImpact(supersededVersionId)),
      row.version_id,
    ],
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function main() {
  console.error('[recheck-conflicts] Starting deferred conflict re-check run')

  // Fetch pending rows
  const { rows: pending } = await pool.query(
    `SELECT version_id, q_key_id, topic, key, version, summary, author, triggered_by, q_project_id
     FROM knowledge_versions
     WHERE status = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [KnowledgeStatus.PENDING_CONFLICT_CHECK, BATCH_SIZE],
  )

  if (pending.length === 0) {
    console.error('[recheck-conflicts] No pending rows — nothing to do')
    return
  }

  console.error(`[recheck-conflicts] Found ${pending.length} row(s) to re-check`)

  // Quick liveness check before looping
  const alive = await pingGraphiti()
  if (!alive) {
    console.error('[recheck-conflicts] Graphiti still unavailable — exiting, will retry next run')
    return
  }

  let promoted = 0
  let deferred = 0
  let conflicted = 0

  for (const row of pending) {
    const result = await processPendingRow(pool, row)

    if (result.outcome === 'deferred') {
      // Graphiti went back down mid-run — stop processing, leave remaining as PENDING
      console.error('[recheck-conflicts] Graphiti became unavailable mid-run — stopping')
      deferred += pending.length - promoted - conflicted
      break
    }

    if (result.outcome === 'conflicted') {
      console.error(`[recheck-conflicts] CONFLICT found for ${row.topic}:${row.key} v${row.version} — set to DRAFT`)
      conflicted++
    } else {
      console.error(`[recheck-conflicts] ${row.topic}:${row.key} v${row.version} promoted to ${result.newStatus}`)
      promoted++
    }

    await writeRecheckAudit(pool, row, result.conflictResult, result.supersededVersionId)
  }

  console.error(`[recheck-conflicts] Done — promoted: ${promoted}, conflicted: ${conflicted}, deferred: ${deferred}`)
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  main()
    .catch((err) => {
      console.error('[recheck-conflicts] Fatal error:', err.message)
      process.exit(1)
    })
    .finally(() => pool.end())
}
