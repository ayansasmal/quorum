/**
 * Provenance record builders — pure functions, no side effects.
 *
 * These functions construct the structured records that link versions to
 * audit entries and capture the full lineage of every knowledge write.
 */

import { createHash } from 'node:crypto'
import { KnowledgeStatus } from '../graph/schema.js'

/**
 * SHA256 hash of content string. Stored in version record so tampering is detectable.
 * @param {string} content
 * @returns {string}
 */
export function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Build a complete version record for insertion into knowledge_versions.
 *
 * Forward link fields (superseded_by_*) are initialised to null here —
 * they are populated by transitionVersionStatus() when the next version arrives.
 *
 * @param {{
 *   topic: string,
 *   key: string,
 *   version: number,
 *   content: string,
 *   author: string,
 *   triggeredBy: string,
 *   auditEntryId: string,
 *   graphitiEpisodeId?: string,
 *   supersedesVersion?: number,
 *   supersedesReason?: string,
 *   conflictId?: string,
 *   status?: string,
 * }} params
 * @returns {Record<string, unknown>}
 */
export function buildVersionRecord(params) {
  return {
    topic: params.topic,
    key: params.key,
    version: params.version,
    status: params.status ?? KnowledgeStatus.ACTIVE,
    content_hash: hashContent(params.content),
    author: params.author,
    created_at: new Date().toISOString(),
    created_by_audit: params.auditEntryId,
    triggered_by: params.triggeredBy,
    conflict_id: params.conflictId ?? null,
    graphiti_episode_id: params.graphitiEpisodeId ?? null,
    // Backward link — set at creation time
    supersedes_version: params.supersedesVersion ?? null,
    supersedes_reason: params.supersedesReason ?? null,
    // Forward link — null at creation; set by transitionVersionStatus()
    superseded_by_version: null,
    superseded_by_author: null,
    superseded_at: null,
  }
}

/**
 * Build the forward link data passed to transitionVersionStatus()
 * when creating version N, to back-fill version N-1's forward link fields.
 *
 * @param {{ supersededByVersion: number, supersededByAuthor: string }} params
 * @returns {{ supersededByVersion: number, supersededByAuthor: string }}
 */
export function buildForwardLink(params) {
  return {
    supersededByVersion: params.supersededByVersion,
    supersededByAuthor: params.supersededByAuthor,
  }
}

/**
 * Build the version_impact object included in audit entries.
 * @param {Array<{ version: number, status: string, content_hash?: string, triggered_by?: string }>} versionsCreated
 * @param {Array<{ version: number, status_before: string }>} versionsSuperseded
 * @returns {{ versions_created: unknown[], versions_superseded: unknown[] }}
 */
export function buildAuditVersionImpact(versionsCreated, versionsSuperseded) {
  return {
    versions_created: versionsCreated,
    versions_superseded: versionsSuperseded,
  }
}
