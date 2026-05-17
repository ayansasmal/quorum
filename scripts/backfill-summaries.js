/**
 * One-time backfill: populate empty summary column from Graphiti episodes.
 *
 * Before this fix, insertVersion used `record.summary ?? ''` and the MCP
 * passed `content` (not `summary`), so all existing entries have summary=''.
 * This script fetches every Graphiti episode per project group, then updates
 * PostgreSQL rows where summary='' and graphiti_episode_id matches.
 *
 * NOTE: This script only works when Graphiti still has the episodes. If FalkorDB
 * was wiped (e.g. via `setup.sh docker clean --volumes`), Graphiti will return 0
 * episodes and the content cannot be recovered. The `insertVersion` fix in
 * gateway/src/shared/graph/queries.js ensures all new entries persist content
 * correctly going forward.
 *
 * Usage:
 *   GRAPHITI_URL=http://localhost:8001 node scripts/backfill-summaries.js [--dry-run] [--project <project_id>]
 */

import pg from 'pg'
import { getEpisodes } from '../gateway/src/shared/graph/client.js'

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

async function main() {
  // 1. Find all rows with empty summary and a graphiti_episode_id
  const projectFilter = PROJECT_ID ? 'AND project_id = $1' : ''
  const params = PROJECT_ID ? [PROJECT_ID] : []

  const { rows: targets } = await pool.query(
    `SELECT id, project_id, topic, key, version, graphiti_episode_id
     FROM knowledge_versions
     WHERE (summary = '' OR summary IS NULL)
       AND graphiti_episode_id IS NOT NULL
       ${projectFilter}
     ORDER BY project_id, id`,
    params,
  )

  if (targets.length === 0) {
    console.log('Nothing to backfill — all summaries already populated.')
    await pool.end()
    return
  }

  console.log(`Found ${targets.length} entries to backfill.${DRY_RUN ? ' (dry-run)' : ''}`)

  // 2. Group targets by project_id to minimise Graphiti round-trips
  const byProject = new Map()
  for (const row of targets) {
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, [])
    byProject.get(row.project_id).push(row)
  }

  let updated = 0
  let missing = 0

  for (const [projectId, rows] of byProject) {
    console.log(`\nProject: ${projectId} — ${rows.length} entries`)

    // 3. Fetch all episodes for this group from Graphiti
    let episodes = []
    try {
      const result = await getEpisodes(projectId)
      episodes = result?.episodes ?? result?.results ?? result ?? []
      if (!Array.isArray(episodes)) {
        // Some Graphiti versions wrap differently
        episodes = Object.values(episodes).flat().filter((e) => typeof e === 'object')
      }
      console.log(`  Fetched ${episodes.length} episodes from Graphiti`)
    } catch (err) {
      console.error(`  ERROR fetching episodes: ${err.message}`)
      missing += rows.length
      continue
    }

    // 4. Build UUID → episode_body map
    const episodeMap = new Map()
    for (const ep of episodes) {
      const uuid = ep.uuid ?? ep.episode_id ?? ep.id
      const body = ep.episode_body ?? ep.content ?? ep.body ?? ep.summary ?? null
      if (uuid && body) episodeMap.set(uuid, body)
    }

    // 5. Update each row
    for (const row of rows) {
      const content = episodeMap.get(row.graphiti_episode_id)
      if (!content) {
        console.log(`  MISS  ${row.topic}:${row.key} v${row.version} (uuid ${row.graphiti_episode_id})`)
        missing++
        continue
      }

      if (DRY_RUN) {
        console.log(`  DRY   ${row.topic}:${row.key} v${row.version} → ${content.slice(0, 60)}…`)
        updated++
        continue
      }

      await pool.query(
        `UPDATE knowledge_versions SET summary = $1 WHERE id = $2`,
        [content, row.id],
      )
      console.log(`  OK    ${row.topic}:${row.key} v${row.version}`)
      updated++
    }
  }

  console.log(`\nDone. Updated: ${updated}, Not found in Graphiti: ${missing}`)
  await pool.end()
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
