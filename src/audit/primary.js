/**
 * Primary audit store — Graphiti graph DB.
 *
 * Audit episodes are written to a dedicated '_quorum_audit' group, separate
 * from user knowledge groups. This allows lineage queries via graph traversal:
 * walk from any knowledge node → connected audit nodes.
 *
 * If Graphiti is unavailable, a compensating AUDIT_WRITE_FAILED entry is
 * written to the secondary store and the error is rethrown — operation fails.
 */

import { addEpisode, AUDIT_GROUP_ID } from '../graph/client.js'

// Re-export AUDIT_GROUP_ID so tests can reference it without importing graph/client
export { AUDIT_GROUP_ID }

/**
 * Write an audit entry to the Graphiti graph as an episode in the audit group.
 * @param {Record<string, unknown>} entry - the complete audit entry (already chain-hashed)
 * @returns {Promise<{ episode_id: string }>}
 */
export async function writeEntry(entry) {
  const body = `[AUDIT] ${entry.operation} by ${entry.author} | tool: ${entry.tool} | pos: ${entry.chain_position}`

  return addEpisode(body, {
    key: `audit:${entry.entry_id}`,
    source: 'quorum:audit',
    groupId: AUDIT_GROUP_ID,
    metadata: {
      entry_id: entry.entry_id,
      operation: entry.operation,
      tool: entry.tool,
      author: entry.author,
      chain_position: entry.chain_position,
      entry_hash: entry.entry_hash,
      version_impact: entry.version_impact,
    },
  })
}

/**
 * Write a failure compensation entry to mark that the primary store write failed.
 * This does NOT re-attempt the graph write — it records the failure fact.
 * @param {import('./secondary.js')} secondary
 * @param {import('pg').Pool} pg
 * @param {string} originalEntryId
 * @param {string} error
 */
export async function writeFailureCompensation(secondary, pg, originalEntryId, error) {
  await secondary.writeAuditEntry(pg, {
    operation: 'AUDIT_WRITE_FAILED',
    tool: 'internal',
    author: 'system',
    governance_json: { original_entry_id: originalEntryId, error: String(error) },
    outcome_json: { status: 'primary_store_unavailable' },
    version_impact: { versions_created: [], versions_superseded: [] },
  }).catch(() => {
    // If the secondary write also fails, we can only log — don't throw again
    console.error('[Quorum] CRITICAL: Both primary and secondary audit writes failed', {
      originalEntryId,
      error,
    })
  })
}
