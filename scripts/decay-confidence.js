/**
 * Confidence decay script (GAP-04).
 *
 * Runs weekly (Sunday 2am UTC via Helm CronJob).
 * Decays confidence on all ACTIVE knowledge_versions older than 7 days
 * that have not been accessed recently.
 *
 * Decay formula (from src/governance/confidence.js):
 *   newConfidence = current - (0.005 × weeksSinceAccess)
 *
 * Floor: max(0.10, starting_confidence × 0.30)
 *   A node that started at 0.9 (PA ADR) floors at 0.27 — not 0.10.
 *   A node at 0.5 (engineer note) floors at 0.15.
 *   This preserves relative authority even at minimum confidence.
 *
 * Usage:
 *   node scripts/decay-confidence.js [--project <project_id>] [--dry-run]
 */

import pg from 'pg'
import { onAgeDecay } from '../gateway/src/shared/governance/confidence.js'
import { getDecayEligibleVersions, updateConfidence } from '../gateway/src/shared/graph/queries.js'

const DRY_RUN    = process.argv.includes('--dry-run')
const PROJECT_ID = (() => {
  const idx = process.argv.indexOf('--project')
  return idx !== -1 ? process.argv[idx + 1] : (process.env.QUORUM_PROJECT_ID ?? 'default')
})()

const BATCH_SIZE      = 200
const MS_PER_WEEK     = 7 * 24 * 60 * 60 * 1000
const ABSOLUTE_FLOOR  = 0.10

const pool = new pg.Pool({
  host:     process.env.POSTGRES_HOST     ?? 'localhost',
  port:     parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB       ?? 'quorum_audit',
  user:     process.env.POSTGRES_USER     ?? 'quorum',
  password: process.env.POSTGRES_PASSWORD ?? 'quorum_local',
})

/**
 * Compute the decay floor for a given starting_confidence.
 * Floor = max(ABSOLUTE_FLOOR, startingConfidence × 0.30) — preserves relative authority.
 * @param {number} startingConfidence
 * @returns {number}
 */
export function decayFloor(startingConfidence) {
  return Math.max(ABSOLUTE_FLOOR, startingConfidence * 0.30)
}

/**
 * Weeks since a given timestamp (or NOW() if null).
 * @param {string | Date | null} accessedAt
 * @returns {number}
 */
function weeksSince(accessedAt) {
  const ref = accessedAt ? new Date(accessedAt) : new Date()
  return (Date.now() - ref.getTime()) / MS_PER_WEEK
}

/**
 * Apply time-based confidence decay, clamped to the starting-confidence floor.
 * This is the combined formula used by the weekly cron: Math.max(floor, onAgeDecay(current, weeks)).
 * Exported for unit testing — the cron's run() uses this exact logic inline.
 * @param {number} current           - current confidence [0,1]
 * @param {number} startingConfidence - the entry's original confidence (used for floor)
 * @param {number} weeksSinceAccess  - weeks since last access
 * @returns {number} new confidence, clamped to floor
 */
export function computeDecay(current, startingConfidence, weeksSinceAccess) {
  const floor = decayFloor(startingConfidence)
  return Math.max(floor, onAgeDecay(current, weeksSinceAccess))
}

async function run() {
  console.error(`[decay] Starting confidence decay | project=${PROJECT_ID} | dry-run=${DRY_RUN}`)

  let decayed = 0
  let skipped = 0

  const rows = await getDecayEligibleVersions(pool, PROJECT_ID, BATCH_SIZE)
  console.error(`[decay] Found ${rows.length} eligible nodes`)

  for (const row of rows) {
    const weeks    = weeksSince(row.last_accessed_at)
    const floor    = decayFloor(row.starting_confidence)
    const newScore = Math.max(floor, onAgeDecay(row.confidence, weeks))

    if (newScore >= row.confidence) {
      skipped++
      continue
    }

    if (!DRY_RUN) {
      await updateConfidence(pool, row.id, newScore)
    }

    console.error(
      `[decay] ${DRY_RUN ? '(dry) ' : ''}${row.topic}:${row.key} ` +
      `${row.confidence.toFixed(3)} → ${newScore.toFixed(3)} (${weeks.toFixed(1)}w since access)`,
    )
    decayed++
  }

  console.error(`[decay] Done — decayed: ${decayed}, skipped: ${skipped}`)
  await pool.end()
}

run().catch((err) => {
  console.error('[decay] Fatal:', err.message)
  process.exit(1)
})
