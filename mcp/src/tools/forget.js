/**
 * forget() — Deprecate knowledge. Never hard delete.
 *
 * Creates a new DEPRECATED version — never modifies the existing ACTIVE node.
 * Requires a reason (Constitutional Rule 3).
 * Calls enforceNoHardDelete() to verify the constitutional check runs (Rule 1).
 */

import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { enforceNoHardDelete, enforceReasonRequired } from '../governance/constitutional.js'
import { buildVersionRecord, buildAuditVersionImpact, hashContent } from '../governance/provenance.js'
import { TriggeredBy, KnowledgeStatus } from '../graph/schema.js'
import { deleteEpisodeSoft } from '../graph/client.js'
import { getCurrentVersion, getNextVersionNumber, insertVersion, transitionVersionStatus } from '../graph/queries.js'

export const schema = z.object({
  topic: z.string().min(1),
  key: z.string().min(1),
  reason: z.string().min(1).describe('Required: why this knowledge is being deprecated'),
  author: z.string().min(1),
  session_id: z.string().optional(),
})

/**
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(pg, input) {
  // Constitutional rules checked before pipeline wrapping
  enforceNoHardDelete('forget')
  enforceReasonRequired(input.reason, 'forget')

  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'forget',
      author: input.author,
      sessionId: input.session_id,
      topic: input.topic,
      key: input.key,
      governanceData: { reason: input.reason },
    },
    async () => {
      const existing = await getCurrentVersion(pg, input.topic, input.key)
      if (!existing) {
        return {
          result: { status: 'not_found', topic: input.topic, key: input.key },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      const nextVersion = await getNextVersionNumber(pg, input.topic, input.key)

      // Soft-deprecate in Graphiti (writes deprecation episode — never deletes)
      if (existing.graphiti_episode_id) {
        await deleteEpisodeSoft(existing.graphiti_episode_id, {
          key: `${input.topic}:${input.key}`,
          reason: input.reason,
          author: input.author,
        }).catch(() => {})
      }

      // Create new DEPRECATED version record
      const deprecationContent = `[DEPRECATED] ${input.reason}`
      const versionRecord = buildVersionRecord({
        topic: input.topic,
        key: input.key,
        version: nextVersion,
        content: deprecationContent,
        author: input.author,
        triggeredBy: TriggeredBy.ENGINEER_DECISION,
        auditEntryId: 'pre_pending',
        supersedesVersion: existing.version,
        supersedesReason: input.reason,
        status: KnowledgeStatus.DEPRECATED,
      })

      await insertVersion(pg, versionRecord)
      await transitionVersionStatus(
        pg, input.topic, input.key, existing.version,
        KnowledgeStatus.DEPRECATED,
        { supersededByVersion: nextVersion, supersededByAuthor: input.author },
      )

      return {
        result: {
          status: 'deprecated',
          topic: input.topic,
          key: input.key,
          deprecated_version: existing.version,
          deprecation_version: nextVersion,
          reason: input.reason,
        },
        versionImpact: buildAuditVersionImpact(
          [{ version: nextVersion, status: KnowledgeStatus.DEPRECATED, triggered_by: TriggeredBy.ENGINEER_DECISION }],
          [{ version: existing.version, status_before: existing.status }],
        ),
      }
    },
  )

  return pipelineResult.result
}
