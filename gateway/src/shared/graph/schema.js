/**
 * Quorum entity and edge type definitions for Graphiti.
 * Passed as hints to Graphiti's add_episode so LLM extraction
 * uses engineering-domain labels rather than generic ones.
 */

/** @type {Record<string, {description: string, properties: string[]}>} */
export const QuorumEntityTypes = {
  Decision: {
    description: 'An architectural or technical decision made by the team',
    properties: ['rationale', 'alternatives_considered', 'status', 'domain'],
  },
  Pattern: {
    description: 'A reusable code or design pattern adopted by the team',
    properties: ['implementation', 'when_to_use', 'when_not_to_use', 'domain'],
  },
  Constraint: {
    description: 'A non-functional requirement or technical constraint',
    properties: ['type', 'source', 'impact', 'domain'],
  },
  Runbook: {
    description: 'An operational procedure or how-to guide',
    properties: ['steps', 'triggers', 'rollback', 'domain'],
  },
  Requirement: {
    description: 'A business or technical requirement',
    properties: ['acceptance_criteria', 'priority', 'source', 'domain'],
  },
}

/** @type {Record<string, string>} */
export const QuorumEdgeTypes = {
  SUPERSEDES: 'This knowledge replaces previous knowledge',
  DEPENDS_ON: 'This knowledge requires the other to be true',
  CONFLICTS_WITH: 'This knowledge contradicts the other (unresolved)',
  INFORMED_BY: 'This knowledge was derived from the other',
  RELATES_TO: 'General semantic relationship',
}

/**
 * What workflow produced a given knowledge version.
 * Every version record must have a triggered_by value — never null.
 */
export const TriggeredBy = /** @type {const} */ ({
  ENGINEER_DECISION: 'engineer_decision',
  CONFLICT_RESOLUTION: 'conflict_resolution',
  PR_MERGE: 'pr_merge',
  ATLASSIAN_SYNC: 'atlassian_sync',
  CONFIDENCE_DECAY: 'confidence_decay',
  REFLECT: 'reflect',
})

/**
 * All valid statuses for a knowledge version.
 * Only one ACTIVE version may exist per topic:key at any time.
 */
export const KnowledgeStatus = /** @type {const} */ ({
  ACTIVE: 'ACTIVE',
  DRAFT: 'DRAFT',
  SUPERSEDED: 'SUPERSEDED',
  DEPRECATED: 'DEPRECATED',
  REJECTED: 'REJECTED',
  /**
   * Graphiti was unavailable when this version was stored.
   * Conflict check is deferred — the recheck-conflicts CronJob will
   * promote this to ACTIVE or CONFLICT_DETECTED once Graphiti recovers.
   */
  PENDING_CONFLICT_CHECK: 'PENDING_CONFLICT_CHECK',
})

/**
 * Graphiti group used for audit episodes — kept separate from
 * user knowledge groups so audit trail doesn't pollute search results.
 */
export const AUDIT_GROUP_ID = '_quorum_audit'
