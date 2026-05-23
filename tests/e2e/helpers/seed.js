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

import { api }            from './api.js'
import { tokens }         from './jwt.js'
import { graphitiSettle } from './graphiti.js'

/**
 * Generates a unique key for each test run.
 * Ensures PostgreSQL isolation between runs without needing teardown.
 *
 * @param {string} prefix - Human-readable prefix (e.g. 'auth-strategy')
 * @returns {string} e.g. 'auth-strategy-1716400000000'
 */
export const uid = (prefix) => `${prefix}-${Date.now()}`

/**
 * Creates an ACTIVE knowledge entry using the PA token.
 *
 * PA writes land as ACTIVE directly — no approval step required.
 * Use as prerequisite for scenarios that need an existing ACTIVE entry.
 *
 * @param {{ topic: string, key: string, content: string, entityType?: string, project?: string }} opts
 * @returns {Promise<{ topic: string, key: string, versionId: string }>}
 */
export async function activeEntry({ topic, key, content, entityType = 'Decision', project = 'quorum-test-project' }) {
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
 * Creates a conflict (pending decision) by writing a semantically similar entry
 * against an existing ACTIVE entry.
 *
 * Calls graphitiSettle() internally — callers do NOT need to manage timing.
 * Use as prerequisite for scenarios that need a conflict_id to act on.
 *
 * @param {{ topic: string, key: string, content: string, project?: string }} opts - the conflicting content
 * @returns {Promise<{ conflictId: string }>}
 */
export async function conflict({ topic, key, content, project = 'quorum-test-project' }) {
  const client = api(tokens.engineer, project)
  await client.post('/api/knowledge', { topic, key, content })
  await graphitiSettle()
  const pending = await client.get('/pg/pending')
  const entry = pending.data.decisions?.find(
    d => d.topic === topic && d.key === key
  )
  if (!entry) throw new Error(`seed.conflict: no conflict found for ${topic}/${key}`)
  return { conflictId: entry.decision_id }
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
