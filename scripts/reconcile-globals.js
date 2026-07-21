/**
 * Re-ingest ACTIVE knowledge from global catalogs migrated to the shared physical
 * FalkorDB database into that shared database.
 *
 * Discovers global catalogs (q_projects.is_global = TRUE), loads each one's S3/Redis
 * config, and re-ingests the ACTIVE knowledge_versions rows of every catalog whose
 * config has migrated_to_shared_graph: true — via the `database` override added to
 * graphiti_core.Graphiti.add_episode (quorum-graphiti Task 1, commit 27d320c) and
 * threaded through add_memory (quorum-graphiti Task 2, commit bcebf6a). group_id is
 * unchanged; only the physical database the episode lands in changes.
 *
 * Run this once per catalog after flipping migrated_to_shared_graph: true in its
 * config, so existing knowledge already in Graphiti moves into the shared database
 * alongside future writes (which the gateway's Graphiti write path — routes/graphiti.js —
 * already routes there automatically going forward).
 *
 * Usage:
 *   GRAPHITI_URL=http://localhost:8001 node scripts/reconcile-globals.js [--dry-run] [--project <group_id>]
 *
 * Environment:
 *   GRAPHITI_URL                Graphiti MCP server URL (default: http://localhost:8001)
 *   QUORUM_SHARED_GRAPH_DATABASE  Shared physical database name (default: quorum_shared_globals)
 *   POSTGRES_HOST/PORT/DB/USER/PASSWORD  PostgreSQL connection (defaults: local dev)
 *   QUORUM_CONFIG_BUCKET, AWS_*, REDIS_URL  Required by loadProjectConfig (S3 + Redis)
 */

import pg from 'pg'
import { addEpisode } from '../gateway/src/shared/graph/client.js'
import { loadProjectConfig } from '../gateway/src/config-cache.js'

const DRY_RUN    = process.argv.includes('--dry-run')
const PROJECT_ID = (() => {
  const idx = process.argv.indexOf('--project')
  return idx !== -1 ? process.argv[idx + 1] : null
})()

const SHARED_DATABASE = process.env.QUORUM_SHARED_GRAPH_DATABASE ?? 'quorum_shared_globals'

const pool = new pg.Pool({
  host:     process.env.POSTGRES_HOST     ?? 'localhost',
  port:     parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB       ?? 'quorum_audit',
  user:     process.env.POSTGRES_USER     ?? 'quorum',
  password: process.env.POSTGRES_PASSWORD ?? 'quorum_local',
})

/**
 * Discover global catalog group_ids whose config has migrated_to_shared_graph: true.
 * is_global itself is queryable in PostgreSQL (q_projects.is_global, kept in sync by
 * POST /sync/configs); migrated_to_shared_graph is S3-config-only, so each candidate's
 * config is loaded individually via the gateway's existing config-loading helper.
 *
 * @returns {Promise<string[]>} group_ids to reconcile
 */
async function discoverMigratedGlobals() {
  const filter = PROJECT_ID ? 'AND group_id = $1' : ''
  const params = PROJECT_ID ? [PROJECT_ID] : []

  const { rows } = await pool.query(
    `SELECT group_id FROM q_projects WHERE is_global = TRUE ${filter} ORDER BY group_id`,
    params,
  )

  const migrated = []
  for (const row of rows) {
    const config = await loadProjectConfig(row.group_id).catch((err) => {
      console.error(`  SKIP ${row.group_id}  config load failed: ${err.message}`)
      return null
    })
    if (config?.migrated_to_shared_graph === true) {
      migrated.push(row.group_id)
    } else {
      console.log(`  SKIP ${row.group_id}  migrated_to_shared_graph not set`)
    }
  }
  return migrated
}

/**
 * Build a meaningful episode body from available metadata.
 * Used when `summary` is empty (pre-dates the durable content fix).
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

/**
 * Entry point: discover migrated global catalogs and re-ingest their ACTIVE
 * knowledge_versions rows into the shared physical database.
 * @returns {Promise<void>}
 */
async function main() {
  console.log(`Discovering global catalogs migrated to shared database '${SHARED_DATABASE}'...`)
  const groupIds = await discoverMigratedGlobals()

  if (groupIds.length === 0) {
    console.log('No global catalogs with migrated_to_shared_graph: true found.')
    await pool.end()
    return
  }

  console.log(`Found ${groupIds.length} migrated catalog(s): ${groupIds.join(', ')}`)

  const { rows } = await pool.query(
    `SELECT id, project_id, topic, key, summary, confidence, author, tags, entity_type
     FROM knowledge_versions
     WHERE status = 'ACTIVE'
       AND project_id = ANY($1)
     ORDER BY project_id, topic, key`,
    [groupIds],
  )

  if (rows.length === 0) {
    console.log('No ACTIVE entries found in migrated catalogs.')
    await pool.end()
    return
  }

  console.log(`\nFound ${rows.length} ACTIVE entries to reconcile.${DRY_RUN ? ' (dry-run)' : ''}`)

  const byProject = new Map()
  for (const row of rows) {
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, [])
    byProject.get(row.project_id).push(row)
  }

  let ingested = 0
  let failed   = 0

  for (const [projectId, entries] of byProject) {
    console.log(`\nCatalog: ${projectId} — ${entries.length} entries → database '${SHARED_DATABASE}'`)

    for (const row of entries) {
      const body   = row.summary?.trim() || buildFallbackBody(row)
      const source = row.summary?.trim() ? 'knowledge-registry' : 'knowledge-registry-metadata-only'

      if (DRY_RUN) {
        console.log(`  DRY  ${row.topic}:${row.key}  body: ${body.slice(0, 60).replace(/\n/g, ' ')}…`)
        ingested++
        continue
      }

      try {
        await addEpisode(
          body,
          { key: `${row.topic}:${row.key}`, source, entityType: row.entity_type, tags: row.tags },
          projectId,
          SHARED_DATABASE,
        )
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
