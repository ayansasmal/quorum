/**
 * search() — Semantic search across the knowledge graph.
 *
 * Uses Graphiti's hybrid search (semantic + BM25 + graph traversal).
 * Filters out DRAFT, DEPRECATED, and REJECTED nodes from results.
 * Audited: what Claude searched for is part of the audit trail.
 */

import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { searchNodes, searchFacts } from '../graph/client.js'
import { buildAuditVersionImpact } from '../governance/provenance.js'
import { KnowledgeStatus } from '../graph/schema.js'

const EXCLUDED_STATUSES = new Set([
  KnowledgeStatus.DRAFT,
  KnowledgeStatus.DEPRECATED,
  KnowledgeStatus.REJECTED,
])

export const schema = z.object({
  query: z.string().min(1).describe('Semantic search query'),
  domain: z.string().optional().describe('Optional domain filter (e.g. auth, api, db)'),
  limit: z.number().int().min(1).max(20).optional().default(5).describe('Max results (default 5)'),
  author: z.string().optional().default('unknown'),
  session_id: z.string().optional(),
})

/**
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(pg, input) {
  const projectId = process.env.QUORUM_GROUP_ID ?? 'default'
  const includeGlobal = projectId !== 'global'

  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'search',
      author: input.author ?? 'unknown',
      sessionId: input.session_id,
      governanceData: { query: input.query, domain: input.domain },
    },
    async () => {
      // GAP-27: Run project search + global search in parallel, then merge.
      // Global results are always included (read-unrestricted) unless we ARE global.
      const searches = [
        searchNodes(input.query, { limit: input.limit * 2, groupId: projectId }),
        searchFacts(input.query, { groupId: projectId }),
        includeGlobal
          ? searchNodes(input.query, { limit: input.limit, groupId: 'global' })
          : Promise.resolve({ nodes: [] }),
      ]

      const [nodesResult, factsResult, globalNodesResult] = await Promise.allSettled(searches)

      const projectNodes = nodesResult.status === 'fulfilled' ? (nodesResult.value?.nodes ?? []) : []
      const globalNodes  = globalNodesResult.status === 'fulfilled' ? (globalNodesResult.value?.nodes ?? []) : []
      const facts        = factsResult.status === 'fulfilled' ? (factsResult.value?.facts ?? []) : []

      // Tag source on each node before merging
      const taggedProject = projectNodes.map((n) => ({ ...n, _source: 'project' }))
      const taggedGlobal  = globalNodes.map((n) => ({ ...n, _source: 'global' }))

      // Merge + deduplicate by episode UUID (project wins over global on tie)
      const seen = new Set()
      const merged = [...taggedProject, ...taggedGlobal].filter((node) => {
        const id = node.uuid ?? node.episode_id ?? node.name
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })

      // Filter out nodes with excluded statuses
      const filtered = merged.filter((node) => {
        const status = node.metadata?.status ?? node.status
        return !status || !EXCLUDED_STATUSES.has(status)
      })

      // Apply domain filter if provided
      const domainFiltered = input.domain
        ? filtered.filter((node) => {
            const nodeDomain = node.metadata?.domain ?? node.domain ?? ''
            const nodeName = node.name ?? ''
            return nodeDomain.includes(input.domain) || nodeName.startsWith(input.domain)
          })
        : filtered

      // Sort: project-local first on equal score, then by score descending
      const sorted = domainFiltered.sort(
        (a, b) => (b.score ?? b.similarity ?? 0) - (a.score ?? a.similarity ?? 0)
          || (a._source === 'project' ? -1 : 1),
      )

      const results = sorted.slice(0, input.limit).map((node) => ({
        topic_key: node.name ?? node.uuid,
        summary: node.summary ?? node.content,
        author: node.metadata?.author,
        confidence: node.metadata?.confidence,
        status: node.metadata?.status ?? 'ACTIVE',
        score: node.score ?? node.similarity,
        source: node._source,  // 'project' | 'global'
        episode_id: node.uuid ?? node.episode_id,
        related_facts: facts
          .filter((f) => f.source_node_uuid === node.uuid || f.target_node_uuid === node.uuid)
          .slice(0, 3)
          .map((f) => f.fact),
      }))

      return {
        result: { results, total: results.length, query: input.query },
        versionImpact: buildAuditVersionImpact([], []),
      }
    },
  )

  return pipelineResult.result
}
