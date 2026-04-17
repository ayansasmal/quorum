/**
 * review() — Approve, reject, or request changes on DRAFT knowledge.
 *
 * v0.2 changes:
 *   - `reviewer` removed from input schema — injected from resolved identity
 *   - required_reviewer_teams enforced: reviewer must be from an approved team
 *     for domains that have team restrictions in the S3 config
 *   - staleness detection: if the ACTIVE version has advanced since the DRAFT
 *     was created, a stale_warning is returned so the reviewer knows context
 *
 * Constitutional invariants enforced:
 *   - Rule 3: note/reason required (enforceReasonRequired)
 *   - Rule 4: reviewer cannot be the author (enforceNoSelfApproval)
 *
 * State transitions:
 *   approve          → DRAFT → ACTIVE
 *   reject           → DRAFT → REJECTED
 *   request_changes  → stays DRAFT, note stored in audit
 */

import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { enforceNoSelfApproval, enforceReasonRequired } from '../governance/constitutional.js'
import { buildAuditVersionImpact } from '../governance/provenance.js'
import { KnowledgeStatus } from '../graph/schema.js'
import { getCurrentVersion, getSpecificVersion, transitionVersionStatus, getLatestDraftVersion } from '../graph/queries.js'
import { getConfig } from '../config/loader.js'

export const schema = z.object({
  action: z.enum(['approve', 'reject', 'request_changes']),
  topic: z.string().min(1),
  key: z.string().min(1),
  note: z.string().min(1).describe('Required: reason for this decision'),
  version: z.number().int().positive().optional().describe('Specific version to review (defaults to latest DRAFT)'),
  session_id: z.string().optional(),
})

/**
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {import('../identity/resolver.js').ResolvedIdentity} identity
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(pg, input, identity) {
  const reviewer = identity?.name ?? 'anonymous'
  const reviewerTeam = identity?.team ?? null

  // Constitutional Rule 3: note required — checked before pipeline
  enforceReasonRequired(input.note, 'review')

  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'review',
      author: reviewer,
      sessionId: input.session_id,
      topic: input.topic,
      key: input.key,
      governanceData: { action: input.action, note: input.note },
    },
    async () => {
      // ── Resolve target version ────────────────────────────────────────────
      let targetVersion
      if (input.version != null) {
        targetVersion = await getSpecificVersion(pg, input.topic, input.key, input.version)
      } else {
        const current = await getCurrentVersion(pg, input.topic, input.key)
        if (current?.status === KnowledgeStatus.DRAFT) {
          targetVersion = current
        } else {
            targetVersion = await getLatestDraftVersion(pg, input.topic, input.key)
        }
      }

      if (!targetVersion) {
        return {
          result: { status: 'not_found', message: `No DRAFT version found for ${input.topic}:${input.key}` },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      if (targetVersion.status !== KnowledgeStatus.DRAFT) {
        return {
          result: { status: 'invalid_state', message: `Version ${targetVersion.version} is ${targetVersion.status}, not DRAFT` },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      // Constitutional Rule 4: no self-approval — checked after we have the author
      enforceNoSelfApproval(targetVersion.author, reviewer, 'review')

      // ── Domain team enforcement ───────────────────────────────────────────
      const teamViolation = enforceReviewerTeam(input.topic, reviewerTeam)
      if (teamViolation) {
        return {
          result: { status: 'unauthorized', message: teamViolation },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      // ── Staleness detection ───────────────────────────────────────────────
      // If the ACTIVE version has advanced since this DRAFT was created (e.g. another
      // path activated a different version), warn the reviewer so they have current context.
      const currentActive = await getCurrentVersion(pg, input.topic, input.key)
      let staleWarning = null
      if (
        currentActive &&
        currentActive.status === KnowledgeStatus.ACTIVE &&
        currentActive.version > targetVersion.version
      ) {
        staleWarning = `Active version is now v${currentActive.version} (created ${currentActive.created_at?.toISOString?.() ?? currentActive.created_at}). This DRAFT (v${targetVersion.version}) was written against an older context. Review with current active version in mind.`
      }

      // ── request_changes: stays DRAFT ──────────────────────────────────────
      if (input.action === 'request_changes') {
        return {
          result: {
            status: 'changes_requested',
            topic: input.topic,
            key: input.key,
            version: targetVersion.version,
            reviewer,
            note: input.note,
            stale_warning: staleWarning,
          },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      // ── approve / reject: state transition ───────────────────────────────
      const newStatus = input.action === 'approve' ? KnowledgeStatus.ACTIVE : KnowledgeStatus.REJECTED
      await transitionVersionStatus(pg, input.topic, input.key, targetVersion.version, newStatus)

      return {
        result: {
          status: input.action === 'approve' ? 'approved' : 'rejected',
          topic: input.topic,
          key: input.key,
          version: targetVersion.version,
          new_status: newStatus,
          reviewer,
          note: input.note,
          stale_warning: staleWarning,
        },
        versionImpact: buildAuditVersionImpact(
          input.action === 'approve'
            ? [{ version: targetVersion.version, status: KnowledgeStatus.ACTIVE, triggered_by: 'review_approval' }]
            : [],
          input.action === 'reject'
            ? [{ version: targetVersion.version, status_before: KnowledgeStatus.DRAFT }]
            : [],
        ),
      }
    },
  )

  return pipelineResult.result
}

// ── Domain team enforcement ────────────────────────────────────────────────────

/**
 * Check whether the reviewer's team is permitted to review knowledge in this domain.
 * Returns an error message string if blocked, null if permitted.
 *
 * Empty required_reviewer_teams → any team may review.
 * Config not loaded → no enforcement (permissive fallback).
 *
 * @param {string} topic
 * @param {string | null} reviewerTeam
 * @returns {string | null} Error message or null if permitted
 */
function enforceReviewerTeam(topic, reviewerTeam) {
  let requiredTeams
  try {
    const config = getConfig()
    requiredTeams = config.domains[topic]?.required_reviewer_teams
  } catch {
    return null // config not loaded — permissive
  }

  if (!requiredTeams || requiredTeams.length === 0) return null
  if (!reviewerTeam) {
    return `Domain '${topic}' requires reviewer from team(s): ${requiredTeams.join(', ')}. Reviewer team is unknown (anonymous identity).`
  }

  const normalizedReviewerTeam = reviewerTeam.toLowerCase().trim()
  const allowed = requiredTeams.some((t) => t.toLowerCase().trim() === normalizedReviewerTeam)

  if (!allowed) {
    return `Domain '${topic}' requires reviewer from team(s): ${requiredTeams.join(', ')}. Reviewer is from team '${reviewerTeam}'.`
  }

  return null
}
