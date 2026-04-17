/**
 * Audit Pipeline — The mandatory wrapper.
 *
 * Every MCP tool call flows through withAuditPipeline(). There is no code path
 * that bypasses it. The operation and the audit are the same thing.
 *
 * Flow per tool call:
 *   1. Input validation
 *   2. Constitutional rules check
 *   3. Pre-operation audit entry (INTENT) → secondary + primary
 *   4. Execute operation()
 *   5. Post-operation audit entry (OUTCOME) with version_impact
 *   6. Insert version_audit_links
 *   7. Return result
 *
 * If the operation fails, a FAILED_OUTCOME audit entry is written before rethrowing.
 * Pipeline writes go directly to secondary.writeAuditEntry — never recursive.
 */

import { v4 as uuidv4 } from 'uuid'
import * as secondary from './secondary.js'
import * as primary from './primary.js'
import { insertVersionAuditLink } from '../graph/queries.js'

/**
 * @typedef {Object} PipelineContext
 * @property {string} tool - MCP tool name (remember, recall, forget, etc.)
 * @property {string} author
 * @property {string} [authorRole]
 * @property {string} [sessionId]
 * @property {string} [topic]
 * @property {string} [key]
 * @property {string} [contentHash]
 * @property {Record<string, unknown>} [governanceData]
 */

/**
 * @typedef {Object} PipelineResult
 * @property {unknown} result - the operation's return value
 * @property {string} preAuditId - ID of the INTENT audit entry
 * @property {string} postAuditId - ID of the OUTCOME audit entry
 */

/**
 * Wrap an MCP tool operation in the full audit pipeline.
 *
 * @param {import('pg').Pool} pg
 * @param {PipelineContext} context
 * @param {() => Promise<{
 *   result: unknown,
 *   versionImpact?: { versions_created: unknown[], versions_superseded: unknown[] }
 * }>} operation
 * @returns {Promise<PipelineResult>}
 */
export async function withAuditPipeline(pg, context, operation) {
  const operationId = uuidv4()
  const timestamp = new Date().toISOString()

  // ── Step 3: Pre-operation INTENT entry ─────────────────────────────────────
  const preEntry = await secondary.writeAuditEntry(pg, {
    entry_id: `pre_${operationId}`,
    operation: 'INTENT',
    tool: context.tool,
    timestamp,
    author: context.author,
    author_role: context.authorRole ?? 'unknown',
    session_id: context.sessionId ?? null,
    content_hash: context.contentHash ?? null,
    governance_json: {
      operation_id: operationId,
      topic: context.topic,
      key: context.key,
      governance_data: context.governanceData ?? {},
    },
    outcome_json: { status: 'pending' },
    version_impact: { versions_created: [], versions_superseded: [] },
  })

  // Write intent to primary (non-fatal if fails)
  primary.writeEntry(preEntry).catch((err) => {
    primary.writeFailureCompensation(secondary, pg, preEntry.entry_id, err.message)
  })

  // ── Step 4: Execute operation ───────────────────────────────────────────────
  let operationResult
  try {
    operationResult = await operation()
  } catch (err) {
    // ── Failed outcome: still audit the failure ─────────────────────────────
    const failedEntry = await secondary.writeAuditEntry(pg, {
      entry_id: `fail_${operationId}`,
      operation: 'FAILED_OUTCOME',
      tool: context.tool,
      timestamp: new Date().toISOString(),
      author: context.author,
      author_role: context.authorRole ?? 'unknown',
      session_id: context.sessionId ?? null,
      content_hash: context.contentHash ?? null,
      governance_json: {
        operation_id: operationId,
        topic: context.topic,
        key: context.key,
        pre_audit_id: preEntry.entry_id,
      },
      outcome_json: {
        status: 'failed',
        error: err.message,
        error_type: err.constructor?.name ?? 'Error',
      },
      version_impact: { versions_created: [], versions_superseded: [] },
    }).catch(() => null) // Don't mask the original error

    if (failedEntry) {
      primary.writeEntry(failedEntry).catch(() => {})
    }

    throw err
  }

  const versionImpact = operationResult?.versionImpact ?? {
    versions_created: [],
    versions_superseded: [],
  }

  // ── Step 5: Post-operation OUTCOME entry ───────────────────────────────────
  const postEntry = await secondary.writeAuditEntry(pg, {
    entry_id: `post_${operationId}`,
    operation: 'OUTCOME',
    tool: context.tool,
    timestamp: new Date().toISOString(),
    author: context.author,
    author_role: context.authorRole ?? 'unknown',
    session_id: context.sessionId ?? null,
    content_hash: context.contentHash ?? null,
    governance_json: {
      operation_id: operationId,
      topic: context.topic,
      key: context.key,
      pre_audit_id: preEntry.entry_id,
    },
    outcome_json: {
      status: 'success',
      result_summary: summariseResult(operationResult?.result),
    },
    version_impact: versionImpact,
  })

  primary.writeEntry(postEntry).catch((err) => {
    primary.writeFailureCompensation(secondary, pg, postEntry.entry_id, err.message)
  })

  // ── Step 6: Insert version_audit_links ─────────────────────────────────────
  if (context.topic && context.key) {
    const linkPromises = []

    for (const v of versionImpact.versions_created) {
      linkPromises.push(
        insertVersionAuditLink(pg, {
          auditEntryId: postEntry.entry_id,
          topic: context.topic,
          key: context.key,
          version: v.version,
          linkType: 'created',
        }).catch(() => {}),
      )
    }

    for (const v of versionImpact.versions_superseded) {
      linkPromises.push(
        insertVersionAuditLink(pg, {
          auditEntryId: postEntry.entry_id,
          topic: context.topic,
          key: context.key,
          version: v.version,
          linkType: 'superseded',
        }).catch(() => {}),
      )
    }

    await Promise.all(linkPromises)
  }

  return {
    result: operationResult?.result,
    preAuditId: preEntry.entry_id,
    postAuditId: postEntry.entry_id,
  }
}

/**
 * Produce a compact summary of an operation result for the outcome JSON.
 * @param {unknown} result
 * @returns {unknown}
 */
function summariseResult(result) {
  if (result == null) return null
  if (typeof result === 'object') {
    const { content, ...rest } = result
    return rest
  }
  return result
}
