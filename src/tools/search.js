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
  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'search',
      author: input.author ?? 'unknown',
      sessionId: input.session_id,
      governanceData: { query: input.query, domain: input.domain },
    },
    async () => {
      const [nodesResult, factsResult] = await Promise.allSettled([
        searchNodes(input.query, { limit: input.limit * 2 }),
        searchFacts(input.query),
      ])

      const nodes = nodesResult.status === 'fulfilled' ? (nodesResult.value?.nodes ?? []) : []
      const facts = factsResult.status === 'fulfilled' ? (factsResult.value?.facts ?? []) : []

      // Filter out nodes with excluded statuses
      const filtered = nodes.filter((node) => {
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

      const results = domainFiltered.slice(0, input.limit).map((node) => ({
        topic_key: node.name ?? node.uuid,
        summary: node.summary ?? node.content,
        author: node.metadata?.author,
        confidence: node.metadata?.confidence,
        status: node.metadata?.status ?? 'ACTIVE',
        score: node.score ?? node.similarity,
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
