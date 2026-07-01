/**
 * E2E seed helpers — prerequisite state creation.
 *
 * Creates prerequisite knowledge entries, conflicts, and deviations so each
 * scenario tests its own concern rather than re-implementing setup logic.
 *
 * All knowledge writes use uid() keys so PostgreSQL state is isolated between
 * parallel runs without requiring teardown.
 *
 * activeEntry() uses the PA token (tokens.pe) because PA writes land as ACTIVE
 * in one call — no approve step needed. This is the fastest way to get
 * prerequisite ACTIVE state for scenarios that need it.
 *
 * @module seed
 */

import { api }    from './api.js'
import { tokens } from './jwt.js'

/**
 * Generates a unique key for each test run.
 * Ensures PostgreSQL isolation between runs without needing teardown.
 *
 * @param {string} prefix - Human-readable prefix (e.g. 'auth-strategy')
 * @returns {string} e.g. 'auth-strategy-1716400000000'
 */
export const uid = (prefix) => `${prefix}-${Date.now()}`

/**
 * Creates an ACTIVE knowledge entry.
 *
 * For regular projects: uses the PA token (dashboard path) — PA writes land as ACTIVE.
 * For global catalog projects: uses the admin token (MCP/pg path) — admin bypasses the
 * global-catalog DRAFT rule that enforces self-approval prevention (S-11.1).
 *
 * @param {{ topic: string, key: string, content: string, entityType?: string, project?: string, globalCatalog?: boolean }} opts
 * @returns {Promise<{ topic: string, key: string, versionId: string }>}
 */
export async function activeEntry({ topic, key, content, entityType = 'Decision', project = 'quorum-test-project', globalCatalog = false }) {
  // Global catalog: use admin token + pg.js path — admin can seed ACTIVE entries in global catalogs.
  // The admin token overrides author/author_role so entries are still attributed to test-pe (PA)
  // for correct severity derivation (PA authority_score = 1.0).
  if (globalCatalog) {
    const client = api(tokens.admin, project)
    const res = await client.post('/pg/versions', {
      topic,
      key,
      summary:     content,
      entity_type: entityType,
      author:      'test-pe',
      author_role: 'principal_architect',
      confidence:  0.9,
    })
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`seed.activeEntry (globalCatalog) failed: ${res.status} ${JSON.stringify(res.data)}`)
    }
    return { topic, key, versionId: res.data.version_id ?? res.data.inserted?.version_id }
  }
  const client = api(tokens.pe, project)
  const res = await client.post('/api/knowledge', {
    topic,
    key,
    content,
    entity_type: entityType,
  })
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`seed.activeEntry failed: ${res.status} ${JSON.stringify(res.data)}`)
  }
  return { topic, key, versionId: res.data.version_id }
}

/**
 * Creates a DRAFT knowledge entry using the engineer token.
 *
 * Use as prerequisite for scenarios that need a pending decision to act on
 * (e.g. promote, self-approval prevention, state machine tests).
 *
 * @param {{ topic: string, key: string, content: string, entityType?: string, project?: string }} opts
 * @returns {Promise<{ topic: string, key: string, decisionId: string }>}
 */
export async function draftEntry({ topic, key, content, entityType = 'Decision', project = 'quorum-test-project' }) {
  const client = api(tokens.engineer, project)
  const res = await client.post('/api/knowledge', {
    topic,
    key,
    content,
    entity_type: entityType,
  })
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`seed.draftEntry failed: ${res.status} ${JSON.stringify(res.data)}`)
  }
  return { topic, key, decisionId: res.data.decision_id }
}

/**
 * Creates a conflict (pending decision) by:
 *   1. Writing a DRAFT version as engineer against an existing ACTIVE entry.
 *   2. Inserting a pending_decision record via POST /pg/pending so the PE can
 *      review it via POST /api/review/:conflictId.
 *
 * Two-step creation is required because POST /api/knowledge (dashboard route)
 * creates a DRAFT version in knowledge_versions but does NOT automatically
 * create a pending_decisions row. The review endpoint requires a pending_decisions
 * record, so we create it explicitly here.
 *
 * Use as prerequisite for scenarios that need a conflict_id to act on
 * (S-02.3 supersede, S-02.4 reject, S-02.5 escalate, S-02.6 split, S-02.7 merge).
 *
 * @param {{ topic: string, key: string, content: string, existingContent?: string, project?: string }} opts
 * @returns {Promise<{ conflictId: string }>}
 */
export async function conflict({ topic, key, content, existingContent = '', entityType = 'Decision', project = 'quorum-test-project' }) {
  // Step 1: engineer writes conflicting content → DRAFT version created in knowledge_versions
  const engClient = api(tokens.engineer, project)
  const writeRes = await engClient.post('/api/knowledge', { topic, key, content, entity_type: entityType })
  if (writeRes.status !== 201) {
    throw new Error(`seed.conflict: DRAFT write failed: ${writeRes.status} ${JSON.stringify(writeRes.data)}`)
  }

  // Step 2: create pending_decision record so /api/review/:conflictId can find it.
  // The conflict_id is auto-allocated by the gateway (q_conflict_seq).
  const pendingRes = await engClient.post('/pg/pending', {
    conflict_topic:    topic,
    conflict_key:      key,
    decision_type:     'conflict',
    existing_content:  existingContent,
    incoming_content:  content,
    conflict_reason:   'Conflicting entry detected (E2E test seed)',
  })
  if (pendingRes.status !== 201) {
    throw new Error(`seed.conflict: pending_decision insert failed: ${pendingRes.status} ${JSON.stringify(pendingRes.data)}`)
  }

  return { conflictId: pendingRes.data.conflict_id }
}

/**
 * Submits a deprecation request for an existing ACTIVE entry as the engineer user.
 *
 * Mirrors what the MCP `forget()` tool does when a non-PE tries to remove a knowledge
 * entry: instead of a hard delete, it queues a `deprecation_request` pending decision
 * for the PE/PA to review.
 *
 * The current active version is resolved first so that staleness detection works
 * correctly when the ACTIVE entry advances after the request is submitted.
 *
 * Use as prerequisite for scenarios testing POST /api/review/:conflictId with
 * decision_type='deprecation_request'.
 *
 * @param {{ topic: string, key: string, reason?: string, project?: string }} opts
 * @returns {Promise<{ requestId: string }>}
 */
export async function deprecationRequest({ topic, key, reason = 'Please deprecate this obsolete entry — no longer relevant.', project = 'quorum-test-project' }) {
  const client = api(tokens.engineer, project)

  // Capture the current active version for staleness baseline.
  const versionRes = await client.get(`/pg/versions/${topic}/${key}`)
  const activeVersion = versionRes.data?.version ?? null

  const pendingRes = await client.post('/pg/pending', {
    topic,
    key,
    decision_type:              'deprecation_request',
    conflict_reason:            reason,
    active_version_at_creation: activeVersion,
  })
  if (pendingRes.status !== 201) {
    throw new Error(`seed.deprecationRequest failed: ${pendingRes.status} ${JSON.stringify(pendingRes.data)}`)
  }
  return { requestId: pendingRes.data.conflict_id }
}

/**
 * Records a deviation against an entry in the global catalog.
 *
 * Use as prerequisite for scenarios testing POST /api/deviations/:id/action.
 *
 * @param {{ catalogId: string, topic: string, key: string, description: string, project?: string }} opts
 * @returns {Promise<{ deviationId: string }>}
 */
export async function deviation({ catalogId, topic, key, description, project = 'quorum-test-project' }) {
  const client = api(tokens.pe, project)
  const res = await client.post('/api/deviations', {
    catalog_id:  catalogId,
    topic,
    key,
    description,
    source:      'test',
  })
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`seed.deviation failed: ${res.status} ${JSON.stringify(res.data)}`)
  }
  return { deviationId: res.data.deviation_id }
}
