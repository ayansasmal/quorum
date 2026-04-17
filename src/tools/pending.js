/**
 * pending() — Return all unresolved conflict briefs and DRAFT knowledge awaiting review.
 *
 * Designed to be called by the LLM agent at session start so it can surface
 * pending decisions to the human without requiring a webhook or push mechanism.
 *
 * Stale detection (read-committed semantics):
 *   When a conflict was raised, `active_version_at_creation` records the ACTIVE
 *   version at that moment. If the active version has since advanced (because
 *   another conflict on the same topic:key was resolved first), this conflict's
 *   context is stale. We re-fetch the current active, set stale_warning, and
 *   update the row so the reviewer sees current state, not a stale snapshot.
 *
 * Output shape:
 *   {
 *     conflict_briefs: [...],   // pending conflict decisions, enriched + stale-aware
 *     draft_reviews:  [...],    // DRAFT knowledge entries awaiting approve/reject
 *     summary: { total_pending, conflicts, drafts }
 *   }
 */

import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { buildAuditVersionImpact } from '../governance/provenance.js'
import { getCurrentVersion, getPendingDecisions, getDraftVersions, markPendingDecisionStale } from '../graph/queries.js'
import { getConfig } from '../config/loader.js'

export const schema = z.object({
  topic: z.string().optional().describe('Filter by topic (e.g. auth, api, db)'),
  include_stale: z.boolean().optional().default(false).describe('Include already-stale decisions'),
  session_id: z.string().optional(),
})

/**
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {import('../identity/resolver.js').ResolvedIdentity} identity
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(pg, input, identity) {
  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'pending',
      author: identity?.name ?? 'anonymous',
      sessionId: input.session_id,
      governanceData: { topic: input.topic, include_stale: input.include_stale },
    },
    async () => {
      const [conflictBriefs, draftReviews] = await Promise.all([
        fetchConflictBriefs(pg, input),
        fetchDraftReviews(pg, input),
      ])

      return {
        result: {
          conflict_briefs: conflictBriefs,
          draft_reviews: draftReviews,
          summary: {
            total_pending: conflictBriefs.length + draftReviews.length,
            conflicts: conflictBriefs.length,
            drafts: draftReviews.length,
          },
        },
        versionImpact: buildAuditVersionImpact([], []),
      }
    },
  )

  return pipelineResult.result
}

// ── Conflict briefs ───────────────────────────────────────────────────────────

/**
 * Fetch pending conflict decisions, run stale detection, return enriched briefs.
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function fetchConflictBriefs(pg, input) {
  const statuses = input.include_stale ? ['pending', 'stale'] : ['pending']
  const rows = await getPendingDecisions(pg, { topic: input.topic, statuses, decisionType: 'conflict' })

  const results = []

  for (const row of rows) {
    // Stale detection: compare current active version vs version at conflict creation
    const currentActive = await getCurrentVersion(pg, row.conflict_topic, row.conflict_key)
    const currentVersion = currentActive?.version ?? null

    let staleWarning = row.stale_warning

    if (
      currentVersion !== null &&
      row.active_version_at_creation !== null &&
      currentVersion > row.active_version_at_creation &&
      !staleWarning
    ) {
      staleWarning = `Active version advanced from v${row.active_version_at_creation} to v${currentVersion} since this conflict was created. Review is now against the current active version.`

      // Persist the stale state
      await markPendingDecisionStale(pg, row.conflict_id, staleWarning, currentVersion)
    }

    results.push({
      conflict_id: row.conflict_id,
      topic: row.conflict_topic,
      key: row.conflict_key,
      created_at: row.created_at,
      stale_warning: staleWarning ?? null,
      current_active_version: currentVersion,
      active_version_at_creation: row.active_version_at_creation,
      more_pending_same_key: row.more_pending_same_key,
      brief: {
        existing: {
          content: row.existing_content,
          version: row.active_version_at_creation,
        },
        incoming: {
          content: row.incoming_content,
        },
        conflict_reason: row.conflict_reason,
        possible_split: row.enrichment?.possible_split ?? false,
        split_suggestion: row.enrichment?.split_suggestion ?? null,
        enrichment: row.enrichment ?? null,
      },
      options: ['supersede', 'coexist_split', 'coexist_merge', 'reject', 'escalate'],
    })
  }

  return results
}

// ── Draft reviews ─────────────────────────────────────────────────────────────

/**
 * Fetch DRAFT knowledge entries awaiting human review.
 * Includes `required_reviewer_teams` from domain config.
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function fetchDraftReviews(pg, input) {
  const rows = await getDraftVersions(pg, { topic: input.topic })

  let domainConfigs = {}
  try {
    const config = getConfig()
    domainConfigs = config.domains ?? {}
  } catch {
    // Config not loaded — no domain enforcement info available
  }

  return rows.map((row) => ({
    topic: row.topic,
    key: row.key,
    version: row.version,
    author: row.author,
    content_hash: row.content_hash,
    triggered_by: row.triggered_by,
    created_at: row.created_at,
    required_reviewer_teams: domainConfigs[row.topic]?.required_reviewer_teams ?? [],
  }))
}
