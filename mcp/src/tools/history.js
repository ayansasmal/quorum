/**
 * history() — Full version timeline for a knowledge node.
 *
 * Merges two data sources:
 *   1. PostgreSQL knowledge_versions — compliance metadata (triggered_by, audit refs, reasons)
 *   2. Graphiti SUPERSEDES edges — organic evolution chain traversal
 *
 * The SQL gives the authoritative compliance record.
 * The graph gives the navigable evolution structure.
 */

import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { getVersionHistory } from '../graph/queries.js'
import { getEvolutionChain } from '../graph/client.js'
import { buildAuditVersionImpact } from '../governance/provenance.js'

export const schema = z.object({
  topic: z.string().min(1),
  key: z.string().min(1),
  author: z.string().optional().default('unknown'),
  session_id: z.string().optional(),
})

/**
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function handler(pg, input) {
  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'history',
      author: input.author ?? 'unknown',
      sessionId: input.session_id,
      topic: input.topic,
      key: input.key,
    },
    async () => {
      const versions = await getVersionHistory(pg, input.topic, input.key)

      if (versions.length === 0) {
        return {
          result: null,
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      // Get evolution chain from Graphiti for the current (active/latest) episode
      const latestVersion = versions[0] // newest first from getVersionHistory
      let evolutionChain = []
      if (latestVersion.graphiti_episode_id) {
        evolutionChain = await getEvolutionChain(latestVersion.graphiti_episode_id).catch(() => [])
      }

      // Build episode ID map from graph chain for enrichment
      const graphitiEpisodeMap = new Map(
        evolutionChain.map((ep) => [ep.episode_id, ep]),
      )

      const formattedVersions = versions.map((v) => {
        const graphEpisode = graphitiEpisodeMap.get(v.graphiti_episode_id)
        return {
          version: v.version,
          status: v.status,
          author: v.author,
          created_at: v.created_at,
          triggered_by: v.triggered_by,
          supersedes_version: v.supersedes_version,
          supersedes_reason: v.supersedes_reason,
          superseded_by_version: v.superseded_by_version,
          superseded_by_author: v.superseded_by_author,
          superseded_at: v.superseded_at,
          audit_entry: v.created_by_audit,
          graphiti_episode_id: v.graphiti_episode_id,
          // Enrich with graph metadata if available
          graph_linked: !!graphEpisode,
        }
      })

      return {
        result: {
          topic: input.topic,
          key: input.key,
          versions: formattedVersions,
          formatted: formatTimeline(input.topic, input.key, versions),
        },
        versionImpact: buildAuditVersionImpact([], []),
      }
    },
  )

  return pipelineResult.result
}

/**
 * Format version history as the CLI timeline display.
 * @param {string} topic
 * @param {string} key
 * @param {Array<Record<string, unknown>>} versions - newest first
 * @returns {string}
 */
function formatTimeline(topic, key, versions) {
  const lines = [
    `${topic}:${key} — Version History`,
    '─'.repeat(54),
    '',
  ]

  for (const v of versions) {
    const active = v.status === 'ACTIVE'
    const marker = active ? '●' : ' '
    const date = new Date(v.created_at).toDateString()

    lines.push(`v${v.version} ${marker} ${String(v.status).padEnd(10)} @${v.author.padEnd(20)} ${date}`)

    if (v.supersedes_reason) {
      lines.push(`   Reason: ${v.supersedes_reason}`)
    }
    lines.push(`   Triggered by: ${v.triggered_by}`)
    if (v.conflict_id) {
      lines.push(`   Conflict: ${v.conflict_id}`)
    }
    if (v.superseded_by_version) {
      const supersededDate = v.superseded_at ? new Date(v.superseded_at).toDateString() : 'unknown'
      lines.push(`   Superseded by v${v.superseded_by_version} on ${supersededDate} | Audit: ${v.created_by_audit}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
