/**
 * remember() — Store engineering knowledge with full governance pipeline.
 *
 * v0.2 changes:
 *   - `author` removed from input schema — injected server-side from resolved identity
 *   - `domain` added — used for per-domain conflict thresholds and reviewer team enforcement
 *   - tags are normalized (lowercase + trim) before storage
 *   - confidence floor applied from role config before storing
 *   - when conflict requires human decision: enrichment is generated immediately and
 *     stored in pending_decisions so reviewers get analysis with zero extra latency
 *   - resolution of pending conflicts: called again with conflict_id + resolution
 *     (coexist_split forks into two keys; coexist_merge writes a combined entry)
 *
 * Flow:
 *   1. Validate inputs (author injected from identity)
 *   2. Apply confidence floor from role config
 *   3. Normalize tags
 *   4. If conflict_id present → resolve pending conflict, return
 *   5. Check for existing ACTIVE version at topic:key
 *   6. If exists → conflict detection (domain-scoped threshold)
 *   7. If conflict and human_required → generate enrichment + store in pending_decisions
 *   8. If conflict and auto_supersede → supersede directly
 *   9. If no conflict → supersede (reason required)
 *  10. If first version → store directly (DRAFT for claude/reflect)
 *  11. All writes wrapped in withAuditPipeline
 */

import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { detectConflict, resolveConflict, generateEnrichment, normalizeTags } from '../governance/conflict.js'
import { enforceReasonRequired } from '../governance/constitutional.js'
import { buildVersionRecord, buildForwardLink, buildAuditVersionImpact, hashContent } from '../governance/provenance.js'
import { initialConfidence } from '../governance/confidence.js'
import { resolveAuthorConfidence } from '../governance/authority.js'
import { TriggeredBy, KnowledgeStatus } from '../graph/schema.js'
import { addEpisode, addSupersedingEpisode } from '../graph/client.js'
import { getConfig } from '../config/loader.js'
import {
  getCurrentVersion, getNextVersionNumber, insertVersion, transitionVersionStatus,
  countPendingForKey, insertPendingDecision, getPendingDecisionById, resolvePendingDecision,
} from '../graph/queries.js'

// ── Global namespace constant (GAP-27) ────────────────────────────────────────
const GLOBAL_PROJECT_ID = 'global'

export const schema = z.object({
  topic: z.string().min(1).describe('Knowledge domain (e.g. auth, api, db)'),
  key: z.string().min(1).describe('Unique identifier within the topic (e.g. token-strategy)'),
  content: z.string().min(1).describe('The knowledge content to store'),
  domain: z.string().optional().describe('Domain name for per-domain conflict thresholds (defaults to topic)'),
  confidence: z.number().min(0).max(1).optional().describe('Confidence score 0-1 (role floor applied automatically)'),
  tags: z.array(z.string()).optional().describe('Searchable tags/aliases (normalized to lowercase)'),
  reason: z.string().optional().describe('Required when superseding existing knowledge'),
  entity_type: z.string().optional().describe('Entity type: Decision, Pattern, Constraint, Runbook, Requirement'),
  triggered_by: z.string().optional().describe('What triggered this write (default: engineer_decision)'),
  // Conflict resolution fields — used when responding to a pending conflict brief
  conflict_id: z.string().optional().describe('Conflict ID from pending() — resolves a pending decision'),
  resolution: z.enum(['supersede', 'coexist_split', 'coexist_merge', 'reject', 'escalate']).optional(),
  split_existing_key: z.string().optional().describe('New scoped key for existing entry (coexist_split)'),
  split_incoming_key: z.string().optional().describe('New scoped key for incoming entry (coexist_split)'),
  split_existing_content: z.string().optional().describe('Optional refined content for split A (coexist_split)'),
  split_incoming_content: z.string().optional().describe('Optional refined content for split B (coexist_split)'),
  merged_content: z.string().optional().describe('Combined knowledge entry content (coexist_merge)'),
  session_id: z.string().optional(),
})

/**
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {import('../identity/resolver.js').ResolvedIdentity} identity
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(pg, input, identity) {
  const author = identity?.name ?? 'anonymous'
  const domain = input.domain ?? input.topic
  const rawConfidence = initialConfidence(input.confidence)
  const confidence = identity ? resolveAuthorConfidence(rawConfidence, identity) : rawConfidence
  const triggeredBy = input.triggered_by ?? TriggeredBy.ENGINEER_DECISION
  const tags = normalizeTags(input.tags)
  const projectId = process.env.QUORUM_GROUP_ID ?? 'default'

  // ── GAP-27: Global namespace write guard ────────────────────────────────────
  // The 'global' project is readable by all projects but writable only by
  // principal_architect. Every global write enters DRAFT — no auto-activation.
  if (projectId === GLOBAL_PROJECT_ID) {
    if (identity?.role !== 'principal_architect') {
      return {
        status: 'forbidden',
        message: `Only principal_architect role can write to the global namespace. Your role: ${identity?.role ?? 'unknown'}.`,
        hint: 'Global knowledge is company-wide policy. Ask a principal_architect to submit or approve.',
      }
    }
  }

  // ── Resolve a pending conflict ──────────────────────────────────────────────
  if (input.conflict_id && input.resolution) {
    return resolveConflictDecision(pg, input, identity, author, confidence, tags, triggeredBy)
  }

  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'remember',
      author,
      sessionId: input.session_id,
      topic: input.topic,
      key: input.key,
      contentHash: hashContent(input.content),
    },
    async () => {
      const existing = await getCurrentVersion(pg, input.topic, input.key)

      // ── Superseding existing knowledge ──────────────────────────────────────
      if (existing) {
        enforceReasonRequired(input.reason, 'remember (supersede)')

        const conflictResult = await detectConflict(input.content, input.topic, input.key, domain)

        // GAP-03: Graphiti was unavailable — store as PENDING_CONFLICT_CHECK for deferred re-check
        if (conflictResult.graphiti_unavailable) {
          return storePendingConflictCheck(pg, input, author, confidence, tags, triggeredBy, identity?.role, projectId)
        }

        if (conflictResult.conflict) {
          const resolution = resolveConflict(
            { content: input.content, author, confidence, created_at: new Date().toISOString() },
            existing,
            conflictResult.reason,
            { possible_split: conflictResult.possible_split, split_suggestion: conflictResult.split_suggestion },
          )

          if (resolution.action === 'human_required') {
            const conflictId = `conflict_${uuidv4()}`

            // Generate enrichment at conflict creation time — not at review time
            const enrichment = await generateEnrichment(
              existing.content ?? existing.summary ?? '',
              input.content,
              conflictResult.reason,
              conflictResult.possible_split ?? false,
              conflictResult.split_suggestion,
            )

            // Count other pending decisions for same topic:key (ordering context)
            const morePendingSameKey = await countPendingForKey(pg, input.topic, input.key)

            await insertPendingDecision(pg, {
              conflict_id: conflictId,
              conflict_topic: input.topic,
              conflict_key: input.key,
              active_version_at_creation: existing.version,
              existing_content: existing.content ?? null,
              incoming_content: input.content,
              conflict_reason: conflictResult.reason,
              enrichment,
              more_pending_same_key: morePendingSameKey,
            })

            // GAP-17: Fire webhook notification asynchronously — must never block write
            fireWebhookAsync({ conflictId, input, conflictResult, author })

            return {
              result: {
                status: 'conflict_detected',
                conflict_id: conflictId,
                possible_split: conflictResult.possible_split ?? false,
                split_suggestion: conflictResult.split_suggestion ?? null,
                brief: resolution.brief,
                message: 'Human decision required. Call remember() again with conflict_id + resolution (supersede | coexist_split | coexist_merge | reject | escalate) + mandatory reason.',
              },
              versionImpact: buildAuditVersionImpact([], []),
            }
          }
          // auto_supersede falls through to the supersession logic below
        }

        return supersede(pg, input, existing, author, confidence, tags, triggeredBy, identity?.role, projectId)
      }

      // ── First version ───────────────────────────────────────────────────────
      return storeFirst(pg, input, author, confidence, tags, triggeredBy, identity?.role, projectId)
    },
  )

  return pipelineResult.result
}

// ── Supersession helper ───────────────────────────────────────────────────────

/**
 * Insert new version and atomically transition old one to SUPERSEDED.
 * For global project: new version enters DRAFT, old version stays ACTIVE
 * (supersession completes only after a reviewer approves via review()).
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {Record<string, unknown>} existing
 * @param {string} author
 * @param {number} confidence
 * @param {string[]} tags
 * @param {string} triggeredBy
 * @param {string} [authorRole]
 * @param {string} [projectId='default']
 */
async function supersede(pg, input, existing, author, confidence, tags, triggeredBy, authorRole, projectId = 'default') {
  const isGlobal = projectId === GLOBAL_PROJECT_ID
  const nextVersion = await getNextVersionNumber(pg, input.topic, input.key)

  const graphitiResult = await addSupersedingEpisode(input.content, existing.graphiti_episode_id, {
    key: `${input.topic}:${input.key}`,
    source: `quorum:remember:${author}`,
    entityType: input.entity_type,
    tags,
    confidence,
    reason: input.reason,
  })

  // Global writes always enter DRAFT — supersession only finalises after review approval
  const newStatus = isGlobal ? KnowledgeStatus.DRAFT : KnowledgeStatus.ACTIVE

  const versionRecord = buildVersionRecord({
    topic: input.topic,
    key: input.key,
    version: nextVersion,
    content: input.content,
    author,
    authorRole: authorRole ?? 'unknown',
    confidence,
    tags,
    triggeredBy,
    auditEntryId: 'pre_pending',
    graphitiEpisodeId: graphitiResult.episode_id,
    supersedesVersion: existing.version,
    supersedesReason: input.reason,
    status: newStatus,
  })

  await insertVersion(pg, { ...versionRecord, tags })

  // For non-global: atomically supersede old version now.
  // For global: old ACTIVE stays until a reviewer approves the DRAFT.
  if (!isGlobal) {
    const forwardLink = buildForwardLink({ supersededByVersion: nextVersion, supersededByAuthor: author })
    await transitionVersionStatus(pg, input.topic, input.key, existing.version, KnowledgeStatus.SUPERSEDED, forwardLink)
  }

  return {
    result: {
      status: isGlobal ? 'pending_review' : 'stored',
      topic: input.topic,
      key: input.key,
      version: nextVersion,
      knowledge_status: newStatus,
      episode_id: graphitiResult.episode_id,
      superseded_version: isGlobal ? null : existing.version,
      ...(isGlobal && {
        message: 'Global namespace write entered DRAFT. A second principal_architect must approve before it becomes active.',
        pending_supersedes_version: existing.version,
      }),
    },
    versionImpact: buildAuditVersionImpact(
      [{ version: nextVersion, status: newStatus, triggered_by: triggeredBy }],
      isGlobal ? [] : [{ version: existing.version, status_before: KnowledgeStatus.ACTIVE }],
    ),
  }
}

// ── First-version helper ──────────────────────────────────────────────────────

/**
 * Store the first version of a topic:key (no existing knowledge).
 * Claude-authored, reflect-triggered, and global-namespace writes always enter as DRAFT.
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {string} author
 * @param {number} confidence
 * @param {string[]} tags
 * @param {string} triggeredBy
 * @param {string} [authorRole]
 * @param {string} [projectId='default']
 */
async function storeFirst(pg, input, author, confidence, tags, triggeredBy, authorRole, projectId = 'default') {
  const isGlobal = projectId === GLOBAL_PROJECT_ID

  const graphitiResult = await addEpisode(input.content, {
    key: `${input.topic}:${input.key}`,
    source: `quorum:remember:${author}`,
    entityType: input.entity_type,
    tags,
    confidence,
  })

  const status =
    isGlobal ||
    author === 'claude' ||
    author === 'anonymous' ||
    triggeredBy === TriggeredBy.REFLECT
      ? KnowledgeStatus.DRAFT
      : KnowledgeStatus.ACTIVE

  const versionRecord = buildVersionRecord({
    topic: input.topic,
    key: input.key,
    version: 1,
    content: input.content,
    author,
    authorRole: authorRole ?? 'unknown',
    confidence,
    tags,
    triggeredBy,
    auditEntryId: 'pre_pending',
    graphitiEpisodeId: graphitiResult.episode_id,
    status,
  })

  await insertVersion(pg, { ...versionRecord, tags })

  return {
    result: {
      status: 'stored',
      topic: input.topic,
      key: input.key,
      version: 1,
      knowledge_status: status,
      episode_id: graphitiResult.episode_id,
    },
    versionImpact: buildAuditVersionImpact(
      [{ version: 1, status, triggered_by: triggeredBy }],
      [],
    ),
  }
}

// ── Graphiti downtime fallback (GAP-03) ──────────────────────────────────────

/**
 * Store a version with PENDING_CONFLICT_CHECK status when Graphiti is unavailable.
 * The recheck-conflicts CronJob will promote it to ACTIVE or trigger the
 * conflict workflow once Graphiti recovers.
 *
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {string} author
 * @param {number} confidence
 * @param {string[]} tags
 * @param {string} triggeredBy
 * @param {string} [authorRole]
 * @param {string} [projectId='default']
 */
async function storePendingConflictCheck(pg, input, author, confidence, tags, triggeredBy, authorRole, projectId = 'default') {
  const existing = await getCurrentVersion(pg, input.topic, input.key, projectId)
  const version = existing ? (existing.version + 1) : 1

  const versionRecord = buildVersionRecord({
    topic: input.topic,
    key: input.key,
    version,
    content: input.content,
    author,
    authorRole: authorRole ?? 'unknown',
    confidence,
    tags,
    triggeredBy,
    auditEntryId: 'pre_pending',
    graphitiEpisodeId: null,      // episode not stored — Graphiti was unavailable
    status: KnowledgeStatus.PENDING_CONFLICT_CHECK,
    supersedes_version: existing?.version ?? null,
    supersedes_reason: input.reason ?? null,
    project_id: projectId,
  })

  await insertVersion(pg, { ...versionRecord, tags, project_id: projectId })

  console.error(`[Quorum:remember] Graphiti unavailable — stored ${input.topic}:${input.key} v${version} as PENDING_CONFLICT_CHECK for deferred re-check`)

  return {
    result: {
      status: 'stored',
      topic: input.topic,
      key: input.key,
      version,
      knowledge_status: KnowledgeStatus.PENDING_CONFLICT_CHECK,
      episode_id: null,
      warning: 'Conflict check deferred — Graphiti unavailable. Entry stored as PENDING_CONFLICT_CHECK and will be re-checked automatically when Graphiti recovers.',
    },
    versionImpact: buildAuditVersionImpact(
      [{ version, status: KnowledgeStatus.PENDING_CONFLICT_CHECK, triggered_by: triggeredBy }],
      [],
    ),
  }
}

// ── Conflict resolution handler ───────────────────────────────────────────────

/**
 * Resolve a pending conflict decision.
 * Called when remember() receives conflict_id + resolution.
 *
 * supersede      → incoming replaces existing, normal supersession flow
 * coexist_split  → fork: two new entries under scoped keys, original superseded
 * coexist_merge  → merge: one new entry with merged_content, original superseded
 * reject         → close the conflict, existing stays ACTIVE, incoming discarded
 * escalate       → mark as escalated, leave for wider team
 *
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {import('../identity/resolver.js').ResolvedIdentity} identity
 * @param {string} author
 * @param {number} confidence
 * @param {string[]} tags
 * @param {string} triggeredBy
 */
async function resolveConflictDecision(pg, input, identity, author, confidence, tags, triggeredBy) {
  enforceReasonRequired(input.reason, `conflict resolution (${input.resolution})`)

  const decision = await getPendingDecisionById(pg, input.conflict_id)
  if (!decision) {
    return { status: 'not_found', message: `No pending conflict found with ID ${input.conflict_id}` }
  }

  const topic = decision.conflict_topic
  const key = decision.conflict_key
  const existing = await getCurrentVersion(pg, topic, key)

  if (input.resolution === 'reject' || input.resolution === 'escalate') {
    await resolvePendingDecision(pg, input.conflict_id, {
      status: 'resolved',
      resolution: input.resolution,
      note: input.reason,
      resolvedBy: author,
    })
    return {
      status: 'resolved',
      resolution: input.resolution,
      conflict_id: input.conflict_id,
      message: input.resolution === 'reject'
        ? 'Incoming knowledge rejected. Existing entry stands.'
        : 'Conflict escalated. Existing entry unchanged pending architecture discussion.',
    }
  }

  if (input.resolution === 'supersede') {
    if (!existing) return { status: 'error', message: `No ACTIVE version found for ${topic}:${key}` }
    const result = await supersede(pg, { ...input, topic, key, reason: input.reason }, existing, author, confidence, tags, TriggeredBy.CONFLICT_RESOLUTION)
    await closeConflict(pg, input.conflict_id, 'supersede', input.reason, author, null, null)
    return { ...result.result, conflict_id: input.conflict_id }
  }

  if (input.resolution === 'coexist_split') {
    if (!input.split_existing_key || !input.split_incoming_key) {
      return { status: 'error', message: 'coexist_split requires split_existing_key and split_incoming_key' }
    }

    // Create entry A: existing knowledge under new scoped key
    const contentA = input.split_existing_content ?? decision.existing_content
    const episodeA = await addEpisode(contentA, {
      key: `${topic}:${input.split_existing_key}`,
      source: `quorum:split:${author}`,
      tags: normalizeTags([...tags, key]),
    })
    const recordA = buildVersionRecord({
      topic, key: input.split_existing_key, version: 1,
      content: contentA, author, confidence, tags: normalizeTags([...tags, key]),
      triggeredBy: TriggeredBy.CONFLICT_RESOLUTION, auditEntryId: 'pre_pending',
      graphitiEpisodeId: episodeA.episode_id,
    })
    await insertVersion(pg, { ...recordA, tags: normalizeTags([...tags, key]) })

    // Create entry B: incoming knowledge under new scoped key
    const contentB = input.split_incoming_content ?? decision.incoming_content
    const episodeB = await addEpisode(contentB, {
      key: `${topic}:${input.split_incoming_key}`,
      source: `quorum:split:${author}`,
      tags: normalizeTags([...tags, key]),
    })
    const recordB = buildVersionRecord({
      topic, key: input.split_incoming_key, version: 1,
      content: contentB, author, confidence, tags: normalizeTags([...tags, key]),
      triggeredBy: TriggeredBy.CONFLICT_RESOLUTION, auditEntryId: 'pre_pending',
      graphitiEpisodeId: episodeB.episode_id,
    })
    await insertVersion(pg, { ...recordB, tags: normalizeTags([...tags, key]) })

    // Supersede original with reason pointing to both new keys
    if (existing) {
      const splitReason = `Split into ${topic}:${input.split_existing_key} and ${topic}:${input.split_incoming_key} — ${input.reason}`
      const forwardLink = buildForwardLink({ supersededByVersion: existing.version + 1, supersededByAuthor: author })
      await transitionVersionStatus(pg, topic, key, existing.version, KnowledgeStatus.SUPERSEDED, forwardLink)
      void splitReason // used in audit note below
    }

    await closeConflict(pg, input.conflict_id, 'coexist_split', input.reason, author,
      input.split_existing_key, input.split_incoming_key)

    return {
      status: 'resolved',
      resolution: 'coexist_split',
      conflict_id: input.conflict_id,
      split_a: { topic, key: input.split_existing_key, version: 1 },
      split_b: { topic, key: input.split_incoming_key, version: 1 },
      original_superseded: Boolean(existing),
    }
  }

  if (input.resolution === 'coexist_merge') {
    if (!input.merged_content) {
      return { status: 'error', message: 'coexist_merge requires merged_content' }
    }
    if (!existing) return { status: 'error', message: `No ACTIVE version found for ${topic}:${key}` }

    const mergeResult = await supersede(
      pg,
      { ...input, topic, key, content: input.merged_content, reason: input.reason },
      existing, author, confidence, tags, TriggeredBy.CONFLICT_RESOLUTION,
    )

    await closeConflict(pg, input.conflict_id, 'coexist_merge', input.reason, author, null, null,
      input.merged_content)

    return { ...mergeResult.result, conflict_id: input.conflict_id, resolution: 'coexist_merge' }
  }

  return { status: 'error', message: `Unknown resolution: ${input.resolution}` }
}

/**
 * Mark a pending_decisions row as resolved and record the resolution details.
 * @param {import('pg').Pool} pg
 * @param {string} conflictId
 * @param {string} resolution
 * @param {string} note
 * @param {string} resolvedBy
 * @param {string|null} splitExistingKey
 * @param {string|null} splitIncomingKey
 * @param {string|null} [mergedContent]
 */
async function closeConflict(pg, conflictId, resolution, note, resolvedBy, splitExistingKey, splitIncomingKey, mergedContent = null) {
  await resolvePendingDecision(pg, conflictId, {
    status: 'resolved',
    resolution,
    note,
    resolvedBy,
    splitExistingKey,
    splitIncomingKey,
    mergedContent,
  })
}

// ── GAP-17: Webhook notification ──────────────────────────────────────────────

/**
 * Fire a webhook notification when a conflict enters the human review queue.
 * Runs asynchronously and swallows all errors — notification failure must never
 * block the write operation. Teams wire the webhook_url to Slack, email relay,
 * or PagerDuty in quorum.config.json → notifications.webhook_url.
 *
 * @param {{ conflictId: string, input: object, conflictResult: object, author: string }} params
 */
async function fireWebhookAsync({ conflictId, input, conflictResult, author }) {
  try {
    const config = getConfig()
    const url = config?.notifications?.webhook_url
    if (!url) return

    const dashboardBase = config?.notifications?.dashboard_url
      ?? process.env.QUORUM_DASHBOARD_URL
      ?? null

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'conflict.pending_review',
        topic: input.topic,
        key: input.key,
        conflict_id: conflictId,
        conflict_reason: conflictResult.reason,
        possible_split: conflictResult.possible_split ?? false,
        incoming_author: author,
        dashboard_url: dashboardBase
          ? `${dashboardBase}/pending/${conflictId}`
          : null,
      }),
    })
  } catch {
    // Swallow — webhook failure is non-fatal. The pending decision is already stored.
  }
}
