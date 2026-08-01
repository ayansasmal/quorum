/**
 * Re-ingest PostgreSQL knowledge entries into Graphiti/FalkorDB.
 *
 * Use this after a FalkorDB wipe (e.g. `setup.sh docker clean --volumes`)
 * to restore the Graphiti graph from the durable PostgreSQL store.
 *
 * For entries with a non-empty `summary`, the full content is re-ingested.
 * For entries with an empty `summary` (pre-dates durable summary fix), the
 * episode body is reconstructed from metadata (topic:key + tags) so that
 * semantic search can at least find entries by name and tag terms.
 *
 * After ingestion, `graphiti_episode_id` in PostgreSQL is updated to the
 * new UUID so `recall()` → `detail` endpoint can find the Graphiti node.
 *
 * Usage:
 *   GRAPHITI_URL=http://localhost:8001 node scripts/reingest-to-graphiti.js [--dry-run] [--project <project_id>]
 *
 * Environment:
 *   GRAPHITI_URL        Graphiti MCP server URL (default: http://localhost:8001)
 *   POSTGRES_HOST/PORT/DB/USER/PASSWORD  PostgreSQL connection (defaults: local dev)
 */

import pg from 'pg'
import { addEpisode } from '../gateway/src/shared/graph/client.js'

const DRY_RUN    = process.argv.includes('--dry-run')
const PROJECT_ID = (() => {
  const idx = process.argv.indexOf('--project')
  return idx !== -1 ? process.argv[idx + 1] : null
})()

const pool = new pg.Pool({
  host:     process.env.POSTGRES_HOST     ?? 'localhost',
  port:     parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB       ?? 'quorum_audit',
  user:     process.env.POSTGRES_USER     ?? 'quorum',
  password: process.env.POSTGRES_PASSWORD ?? 'quorum_local',
})

/**
 * Build a meaningful episode body from available metadata.
 * Used when `summary` is empty (pre-dates the durable content fix).
 * The key name and tags carry enough semantic signal for embedding.
 *
 * @param {{ topic: string, key: string, tags: string[], entity_type: string }} row
 * @returns {string}
 */
function buildFallbackBody(row) {
  const tagStr = (row.tags ?? []).join(', ')
  return [
    `${row.topic}:${row.key}`,
    row.entity_type && row.entity_type !== 'unknown' ? `Type: ${row.entity_type}` : null,
    tagStr ? `Tags: ${tagStr}` : null,
    `Domain: ${row.topic}`,
  ].filter(Boolean).join('\n')
}

async function main() {
  // Only re-ingest ACTIVE versions — latest state per entry
  // project_id here is q_projects.group_id — the value Graphiti actually
  // scopes episodes by (addEpisode's groupId param). q_project_id (e.g.
  // "q_p1") is an internal PK and must never be passed to addEpisode.
  const projectFilter = PROJECT_ID ? 'AND qp.group_id = $1' : ''
  const params        = PROJECT_ID ? [PROJECT_ID] : []

  const { rows } = await pool.query(
    `SELECT kv.version_id AS id, qp.group_id AS project_id, kv.topic, kv.key, kv.summary, kv.confidence, kv.author, kv.tags, kv.entity_type
     FROM knowledge_versions kv
     JOIN q_projects qp ON qp.q_project_id = kv.q_project_id
     WHERE kv.status = 'ACTIVE'
       ${projectFilter}
     ORDER BY qp.group_id, kv.topic, kv.key`,
    params,
  )

  if (rows.length === 0) {
    console.log('No ACTIVE entries found.')
    await pool.end()
    return
  }

  console.log(`Found ${rows.length} ACTIVE entries to re-ingest.${DRY_RUN ? ' (dry-run)' : ''}`)

  // Group by project for clear progress reporting
  const byProject = new Map()
  for (const row of rows) {
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, [])
    byProject.get(row.project_id).push(row)
  }

  let ingested = 0
  let failed   = 0

  for (const [projectId, entries] of byProject) {
    console.log(`\nProject: ${projectId} — ${entries.length} entries`)

    for (const row of entries) {
      const body   = row.summary?.trim() || buildFallbackBody(row)
      const source = row.summary?.trim() ? 'knowledge-registry' : 'knowledge-registry-metadata-only'

      if (DRY_RUN) {
        console.log(`  DRY  ${row.topic}:${row.key}  body: ${body.slice(0, 60).replace(/\n/g, ' ')}…`)
        ingested++
        continue
      }

      try {
        // addEpisode does NOT pass uuid to Graphiti (Graphiti 0.29+ treats uuid
        // as a retrieve-key, not an assign-key — passing it for a non-existent
        // node raises NodeNotFoundError). The returned episode_id is a local
        // tracking UUID only; Graphiti assigns its own UUID internally.
        await addEpisode(
          body,
          { key: `${row.topic}:${row.key}`, source, entityType: row.entity_type, tags: row.tags },
          projectId,
        )
        // graphiti_episode_id in PG is intentionally left as-is (old local UUID)
        // since add_memory returns no UUID and the field is not used for lookups.

        const contentFlag = row.summary?.trim() ? '(full)' : '(metadata-only)'
        console.log(`  OK   ${row.topic}:${row.key}  ${contentFlag}`)
        ingested++
      } catch (err) {
        console.error(`  ERR  ${row.topic}:${row.key}  ${err.message}`)
        failed++
      }

      // Brief pause to avoid overwhelming Graphiti's OpenAI embedding calls
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  console.log(`\nDone. Ingested: ${ingested}, Failed: ${failed}`)
  await pool.end()
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
