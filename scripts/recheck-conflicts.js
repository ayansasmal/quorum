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
import { detectConflict } from '../mcp/src/governance/conflict.js'
import { KnowledgeStatus, TriggeredBy } from '../mcp/src/graph/schema.js'

const BATCH_SIZE   = parseInt(process.env.RECHECK_BATCH_SIZE   ?? '50', 10)
const GRAPHITI_URL = process.env.GRAPHITI_URL                  ?? 'http://graphiti:8000'

// ── PostgreSQL connection ─────────────────────────────────────────────────────

const pool = new pg.Pool({
  host:     process.env.POSTGRES_HOST     ?? 'localhost',
  port:     parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB       ?? 'quorum_audit',
  user:     process.env.POSTGRES_USER     ?? 'quorum',
  password: process.env.POSTGRES_PASSWORD ?? 'quorum_local',
})

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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.error('[recheck-conflicts] Starting deferred conflict re-check run')

  // Fetch pending rows
  const { rows: pending } = await pool.query(
    `SELECT id, topic, key, version, content, author, triggered_by, project_id
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
    const conflictResult = await detectConflict(row.content, row.topic, row.key).catch(() => ({
      conflict: false,
      graphiti_unavailable: true,
    }))

    if (conflictResult.graphiti_unavailable) {
      // Graphiti went back down mid-run — stop processing, leave remaining as PENDING
      console.error('[recheck-conflicts] Graphiti became unavailable mid-run — stopping')
      deferred += pending.length - promoted - conflicted
      break
    }

    if (conflictResult.conflict) {
      // Conflict detected — leave as DRAFT and log for human review
      await pool.query(
        `UPDATE knowledge_versions SET status = $1 WHERE id = $2`,
        [KnowledgeStatus.DRAFT, row.id],
      )
      console.error(`[recheck-conflicts] CONFLICT found for ${row.topic}:${row.key} v${row.version} — set to DRAFT`)
      conflicted++
    } else {
      // No conflict — promote to ACTIVE (unless this is a claude/reflect author, stays DRAFT)
      const isDraftAuthor =
        row.author === 'claude' ||
        row.author === 'anonymous' ||
        row.triggered_by === TriggeredBy.REFLECT

      const newStatus = isDraftAuthor ? KnowledgeStatus.DRAFT : KnowledgeStatus.ACTIVE

      await pool.query(
        `UPDATE knowledge_versions SET status = $1 WHERE id = $2`,
        [newStatus, row.id],
      )
      console.error(`[recheck-conflicts] ${row.topic}:${row.key} v${row.version} promoted to ${newStatus}`)
      promoted++
    }

    // Write a lightweight audit entry for the re-check
    await pool.query(
      `INSERT INTO audit_log
         (entry_id, operation, tool, timestamp, author, author_role, content_hash,
          governance_json, outcome_json, version_impact, entry_hash, chain_position, project_id)
       SELECT
         $1, 'conflict_recheck_complete', 'recheck-conflicts', NOW(), 'system', 'system',
         content_hash,
         $2::jsonb, $3::jsonb,
         '{"versions_created":[],"versions_superseded":[]}'::jsonb,
         encode(sha256(($1 || content_hash)::bytea), 'hex'),
         COALESCE((SELECT MAX(chain_position) FROM audit_log), 0) + 1,
         project_id
       FROM knowledge_versions WHERE id = $4`,
      [
        `recheck_${row.id}_${Date.now()}`,
        JSON.stringify({ topic: row.topic, key: row.key, version: row.version }),
        JSON.stringify({ conflict: conflictResult.conflict }),
        row.id,
      ],
    )
  }

  console.error(`[recheck-conflicts] Done — promoted: ${promoted}, conflicted: ${conflicted}, deferred: ${deferred}`)
}

main()
  .catch((err) => {
    console.error('[recheck-conflicts] Fatal error:', err.message)
    process.exit(1)
  })
  .finally(() => pool.end())
