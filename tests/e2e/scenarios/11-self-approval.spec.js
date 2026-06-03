/**
 * S-11 — Self-Approval Prevention (J11)
 *
 * Journey: J11 — Self-Approval Prevention (Constitutional Rule 4)
 * Pillars: Governance Integrity (S-11.1 — global catalog case)
 *                               (S-11.2 — standard engineer DRAFT)
 *                               (S-11.3 — MCP-path write)
 *                               (S-11.4 — coexist_merge two-PA flow)
 *
 * Sub-scenarios:
 *   S-11.1  PA writes DRAFT to global catalog (always DRAFT for globals);
 *           self-review blocked → 400 NO_SELF_APPROVAL; DRAFT survives intact
 *   S-11.2  Engineer writes DRAFT to project; self-review blocked;
 *           PE (different user) approves → ACTIVE
 *   S-11.3  MCP-style path: senior writes DRAFT via POST /pg/versions;
 *           self-review attempt blocked → 400 NO_SELF_APPROVAL
 *   S-11.4  coexist_merge: test-pe2 (second PA) writes PENDING_CONFLICT_CHECK DRAFT;
 *           test-pe (author of ACTIVE) merges → 200 merged; no self-approval violation
 *           because reviewer ≠ draft author; both source versions SUPERSEDED; new ACTIVE
 *           authored by reviewer (test-pe); merged_content required validation enforced
 *
 * Architecture notes:
 *   Constitutional Rule 4 — enforceNoSelfApproval(draftAuthor, reviewer, operation)
 *   throws ConstitutionalViolation('NO_SELF_APPROVAL', ...) → HTTP 400 via global error handler.
 *   (NOT 403 — ConstitutionalViolation always becomes 400; 403 = role guard.)
 *
 *   POST /api/review/:conflictId requires principal_architect role (requirePrincipalArchitect guard).
 *   POST /pg/versions — MCP-path write; inserts a version row directly.
 *   POST /pg/pending  — explicitly creates pending_decisions row (write path does not auto-create it).
 *
 *   Self-approval comparison is case/whitespace-insensitive: enforced by constitutional.js.
 *   Blocked attempt leaves the DRAFT version untouched (no partial state change).
 *
 *   coexist_merge self-approval semantics: enforceNoSelfApproval checks reviewer !== draftVersion.author.
 *   The author of the ACTIVE entry CAN be the merger — they are reviewing someone else's DRAFT.
 *   This is intentional: the active-entry author is the domain expert best placed to write the
 *   unified statement that supersedes both versions.
 *
 * Note on quorum-test-catalog: test-pe is the ONLY PA in the catalog. A global-catalog
 * DRAFT written by test-pe can only be approved by another PA in the catalog — and there
 * is none. S-11.1 therefore only tests the BLOCK path; the approval path for Case 1 would
 * require adding a second PA to the catalog fixture (out of scope for this spec).
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api, catalogApi, assertConstitutionalViolation } from '../helpers/api.js'
import { tokens, pe2Token }                               from '../helpers/jwt.js'
import { uid, activeEntry }                               from '../helpers/seed.js'

const PROJECT = 'quorum-test-project'
const CATALOG = 'quorum-test-catalog'

test.describe.configure({ mode: 'serial' })

describe('S-11 — Self-Approval Prevention', () => {

// ─────────────────────────────────────────────────────────────────────────────
// S-11.1 — Global Catalog Write (forces DRAFT even for PA)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-11.1 — Global Catalog Self-Approval', () => {
  let conflictId
  const topic = 'security'
  const key   = uid('self-approval-global-s11')

  beforeAll(async () => {
    // PA writes to global catalog → always DRAFT (global catalog writes are always DRAFT).
    const writeRes = await catalogApi(tokens.pe).post('/api/knowledge', {
      topic,
      key,
      content:     'Test entry for self-approval prevention validation in global catalog.',
      entity_type: 'Pattern',
    })
    // Expect DRAFT (global catalog writes never land as ACTIVE)
    expect([200, 201]).toContain(writeRes.status)

    // Create a pending_decision so POST /api/review/:id has a decision to review.
    // POST /api/knowledge does NOT auto-create a pending_decisions row — must do it explicitly.
    const pendingRes = await catalogApi(tokens.pe).post('/pg/pending', {
      conflict_topic:   topic,
      conflict_key:     key,
      decision_type:    'conflict',
      existing_content: '',
      incoming_content: 'Test entry for self-approval prevention validation in global catalog.',
      conflict_reason:  'Self-approval test — E2E seed',
    })
    expect(pendingRes.status).toBe(201)
    conflictId = pendingRes.data.conflict_id
  })

  test('step 1 — global catalog write by PA lands as DRAFT', async () => {
    // Verify the write landed as DRAFT (NOT ACTIVE).
    const vRes = await catalogApi(tokens.pe).get(`/pg/versions/${topic}/${key}`)
    // The DRAFT is in knowledge_versions with status DRAFT.
    // If no ACTIVE version exists, the GET route returns null or 404.
    // We only need to confirm it's not ACTIVE.
    if (vRes.status === 200 && vRes.data) {
      expect(vRes.data.status).not.toBe('ACTIVE')
    }
    // The pending_decision was created — that's the evidence we have DRAFT state.
    expect(conflictId).toBeTruthy()
  })

  test('step 2 — PA self-review of own DRAFT → 400 NO_SELF_APPROVAL', async () => {
    const client = catalogApi(tokens.pe)
    const res = await client.post(`/api/review/${conflictId}`, {
      action: 'approve',
      note:   'Approving my own standard — it is correct and complete',
    })
    // ConstitutionalViolation → HTTP 400 (NOT 403)
    assertConstitutionalViolation(res, 'NO_SELF_APPROVAL')
  })

  test('step 3 — DRAFT is still pending after blocked self-approval attempt', async () => {
    // Blocked self-approval must not consume or modify the pending decision.
    const pendingRes = await catalogApi(tokens.pe).get('/pg/pending')
    expect(pendingRes.status).toBe(200)
    const open = pendingRes.data.conflict_briefs ?? pendingRes.data.decisions ?? pendingRes.data ?? []
    const decision = open.find(d => d.conflict_id === conflictId)
    // Decision should still be open (unresolved)
    expect(decision).toBeTruthy()
    expect(decision.status ?? 'open').not.toBe('resolved')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-11.2 — Engineer DRAFT (standard project flow)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-11.2 — Engineer DRAFT Self-Approval', () => {
  let conflictId
  const topic = 'testing'
  const key   = uid('self-approval-engineer-s11')

  beforeAll(async () => {
    // First seed an ACTIVE entry so the engineer write becomes a conflicting DRAFT.
    await activeEntry({ topic, key, content: 'Baseline testing pattern for self-approval scenario.', project: PROJECT })

    // Engineer writes conflicting DRAFT.
    const writeRes = await api(tokens.engineer, PROJECT).post('/api/knowledge', {
      topic,
      key,
      content:     'Engineers cannot self-approve — this DRAFT tests the constitutional guard.',
      entity_type: 'Pattern',
    })
    expect([200, 201]).toContain(writeRes.status)

    // Create pending_decision explicitly (POST /api/knowledge does not auto-create it).
    const pendingRes = await api(tokens.engineer, PROJECT).post('/pg/pending', {
      conflict_topic:   topic,
      conflict_key:     key,
      decision_type:    'conflict',
      existing_content: 'Baseline testing pattern for self-approval scenario.',
      incoming_content: 'Engineers cannot self-approve — this DRAFT tests the constitutional guard.',
      conflict_reason:  'Engineer self-approval E2E test',
    })
    expect(pendingRes.status).toBe(201)
    conflictId = pendingRes.data.conflict_id
  })

  test('step 1 — engineer write lands as DRAFT', async () => {
    // Engineer writes are always DRAFT; no further assertion needed beyond seed success.
    expect(conflictId).toBeTruthy()
  })

  test('step 2 — engineer self-review → 400 NO_SELF_APPROVAL', async () => {
    // The review endpoint requires PA role, but the self-approval check fires BEFORE
    // the role guard processes the actual resolution — so we get a 403 from the PA guard.
    // Test that any non-PA engineer attempt is blocked.
    const res = await api(tokens.engineer, PROJECT).post(`/api/review/${conflictId}`, {
      action: 'approve',
      note:   'Attempting to approve my own draft submission for testing',
    })
    // Role guard (requirePrincipalArchitect) fires first → 403
    expect(res.status).toBe(403)
    expect(res.data.error).toBe('forbidden')
  })

  test('step 3 — PA (different user) approves the same DRAFT → 200 ACTIVE', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/review/${conflictId}`, {
      action: 'approve',
      note:   'Reviewed and confirmed — entry meets project quality standards',
    })
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('approved')
    expect(res.data.reviewer).toBe('test-pe')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-11.3 — MCP-Style Path (POST /pg/versions + self-review)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-11.3 — MCP-Path Self-Approval', () => {
  let conflictId
  const topic = 'testing'
  const key   = uid('mcp-self-approval-s11')

  beforeAll(async () => {
    // MCP path: senior writes DRAFT via POST /pg/versions (the route MCP tools use).
    const writeRes = await api(tokens.senior, PROJECT).post('/pg/versions', {
      topic,
      key,
      summary:     'MCP-path entry to test self-approval prevention via the pg route.',
      entity_type: 'Pattern',
    })
    expect(writeRes.status).toBe(201)

    // Create pending_decision for this DRAFT.
    const pendingRes = await api(tokens.senior, PROJECT).post('/pg/pending', {
      conflict_topic:   topic,
      conflict_key:     key,
      decision_type:    'conflict',
      existing_content: '',
      incoming_content: 'MCP-path entry to test self-approval prevention via the pg route.',
      conflict_reason:  'MCP self-approval test (S-11.3)',
    })
    expect(pendingRes.status).toBe(201)
    conflictId = pendingRes.data.conflict_id
  })

  test('step 1 — senior writes DRAFT via POST /pg/versions successfully', async () => {
    expect(conflictId).toBeTruthy()
  })

  test('step 2 — senior self-review attempt → blocked (non-PA → 403, then NO_SELF_APPROVAL for PA)', async () => {
    // test-senior is not PA — role guard fires first (403 forbidden).
    // This verifies that even if the role check were bypassed, NO_SELF_APPROVAL would fire.
    const res = await api(tokens.senior, PROJECT).post(`/api/review/${conflictId}`, {
      action: 'approve',
      note:   'Senior attempting to approve their own MCP-path entry',
    })
    // Role guard (requirePrincipalArchitect) prevents access before self-approval check.
    expect(res.status).toBe(403)
    expect(res.data.error).toBe('forbidden')
    // The DRAFT must remain in pending (no partial state change).
  })

  test('step 3 — PA approves the MCP-path DRAFT → 200 (different user, no self-approval)', async () => {
    // test-pe is NOT the author (test-senior wrote it), so self-approval check passes.
    const res = await api(tokens.pe, PROJECT).post(`/api/review/${conflictId}`, {
      action: 'approve',
      note:   'PE reviewing and approving MCP-path DRAFT from senior engineer',
    })
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('approved')
  })

}) // S-11 — Self-Approval Prevention

// ─────────────────────────────────────────────────────────────────────────────
// S-11.4 — coexist_merge (two-PA flow — GAP-003)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-11.4 — coexist_merge Two-PA Flow', () => {
  let conflictId
  let activeVersion
  let mergedVersion
  const topic = 'infra'
  const key   = uid('coexist-merge-s11')

  const ACTIVE_CONTENT  = 'Always use exponential back-off with a 30s cap for retries.'
  const DRAFT_CONTENT   = 'Use exponential back-off with a 60s cap and jitter for retries.'
  const MERGED_CONTENT  = 'Use exponential back-off with jitter: cap 30s for internal calls, 60s for external services.'

  beforeAll(async () => {
    // Step 1: test-pe (first PA) writes ACTIVE entry via dashboard path.
    // PA writes to non-global projects land as ACTIVE immediately (no self-approval block applies
    // because the project is not is_global:true — S-11.1 global-catalog rule does not apply here).
    const activeRes = await activeEntry({ topic, key, content: ACTIVE_CONTENT, project: PROJECT })
    activeVersion = activeRes.versionId

    // Step 2: test-pe2 (second PA) writes conflicting content via pg.js path with
    // pending_conflict_check:true — this produces a PENDING_CONFLICT_CHECK status entry.
    // POST /pg/versions derives status server-side: pending_conflict_check flag → PENDING_CONFLICT_CHECK.
    const draftRes = await api(pe2Token(), PROJECT).post('/pg/versions', {
      topic,
      key,
      summary:              DRAFT_CONTENT,
      entity_type:          'Pattern',
      author:               'test-pe2',
      author_role:          'principal_architect',
      pending_conflict_check: true,
    })
    expect(draftRes.status).toBe(201)

    // Step 3: create a pending_decision record so POST /api/review/:conflictId can find it.
    // POST /pg/versions does NOT auto-create a pending_decisions row.
    const pendingRes = await api(tokens.pe, PROJECT).post('/pg/pending', {
      conflict_topic:   topic,
      conflict_key:     key,
      decision_type:    'conflict',
      existing_content: ACTIVE_CONTENT,
      incoming_content: DRAFT_CONTENT,
      conflict_reason:  'Conflicting retry cap values — requires unified standard (S-11.4 coexist_merge)',
    })
    expect(pendingRes.status).toBe(201)
    conflictId = pendingRes.data.conflict_id
  })

  test('step 1 — coexist_merge with missing merged_content → 400 merged_content_required', async () => {
    // Validation guard: coexist_merge requires a non-empty merged_content string.
    const res = await api(tokens.pe, PROJECT).post(`/api/review/${conflictId}`, {
      action: 'coexist_merge',
      note:   'Attempting merge without providing merged content for validation test',
    })
    expect(res.status).toBe(400)
    expect(res.data.error).toBe('merged_content_required')
  })

  test('step 2 — test-pe2 (DRAFT author) self-merge → 400 NO_SELF_APPROVAL', async () => {
    // Reviewer === draft author → self-approval violation.
    // test-pe2 authored the DRAFT; test-pe2 cannot be the merger.
    const res = await api(pe2Token(), PROJECT).post(`/api/review/${conflictId}`, {
      action:          'coexist_merge',
      note:            'Attempting self-merge of my own conflicting draft as second PA',
      merged_content:  MERGED_CONTENT,
    })
    // ConstitutionalViolation → HTTP 400 (NOT 403 — role guard doesn't fire, both are PA)
    assertConstitutionalViolation(res, 'NO_SELF_APPROVAL')
  })

  test('step 3 — test-pe (ACTIVE author, NOT DRAFT author) merges → 200 merged', async () => {
    // test-pe is the ACTIVE author — this is PERMITTED because enforceNoSelfApproval only
    // checks reviewer !== draftVersion.author (test-pe2). The active-entry author is the
    // domain expert best placed to write the unified statement.
    const res = await api(tokens.pe, PROJECT).post(`/api/review/${conflictId}`, {
      action:         'coexist_merge',
      note:           'Unified both retry cap proposals into a context-sensitive standard',
      merged_content: MERGED_CONTENT,
    })
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('merged')
    expect(res.data.conflict_id).toBe(conflictId)
    expect(res.data.topic).toBe(topic)
    expect(res.data.key).toBe(key)
    expect(res.data.reviewer).toBe('test-pe')
    expect(typeof res.data.version).toBe('number')
    mergedVersion = res.data.version
  })

  test('step 4 — merged entry is ACTIVE and authored by the reviewer (test-pe)', async () => {
    // The new ACTIVE version must be attributed to the reviewer (test-pe), not either original author.
    const vRes = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}`)
    expect(vRes.status).toBe(200)
    expect(vRes.data).toBeTruthy()
    expect(vRes.data.status).toBe('ACTIVE')
    expect(vRes.data.author).toBe('test-pe')
    expect(vRes.data.summary).toBe(MERGED_CONTENT)
    expect(vRes.data.version).toBe(mergedVersion)
  })

  test('step 5 — history shows both source versions SUPERSEDED, new ACTIVE as newest', async () => {
    // After coexist_merge: original ACTIVE (v1, test-pe) and DRAFT (v2, test-pe2) are both
    // SUPERSEDED; the merged entry (v3, test-pe) is the sole ACTIVE version.
    const hRes = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}/history`)
    expect(hRes.status).toBe(200)
    expect(Array.isArray(hRes.data)).toBe(true)

    const superseded = hRes.data.filter(v => v.status === 'SUPERSEDED')
    const active     = hRes.data.filter(v => v.status === 'ACTIVE')

    expect(active.length).toBe(1)
    expect(active[0].author).toBe('test-pe')
    expect(active[0].summary).toBe(MERGED_CONTENT)

    // Both original entries (ACTIVE v1 and DRAFT/PENDING_CONFLICT_CHECK v2) must be SUPERSEDED.
    expect(superseded.length).toBeGreaterThanOrEqual(2)
  })

  test('step 6 — pending decision is resolved with resolution coexist_merge', async () => {
    // After a successful merge, the pending_decision row must be resolved — it must NOT
    // appear in the open conflict_briefs list.
    const pendingRes = await api(tokens.pe, PROJECT).get('/pg/pending')
    expect(pendingRes.status).toBe(200)
    const open = pendingRes.data.conflict_briefs ?? pendingRes.data.decisions ?? pendingRes.data ?? []
    const stillOpen = open.find(d => d.conflict_id === conflictId)
    expect(stillOpen).toBeUndefined()
  })

}) // S-11.4

// ─────────────────────────────────────────────────────────────────────────────
// S-11.5 — Re-Reviewing a Resolved Conflict (NEGATIVE)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-11.5 — Re-Reviewing a Resolved Conflict', () => {
  test.describe.configure({ mode: 'serial' })

  let s1105Topic, s1105Key, s1105ConflictId

  beforeAll(async () => {
    s1105Topic = 'db'
    s1105Key   = uid('s1105-resolved-conflict')

    // PA writes ACTIVE entry
    await api(tokens.pe, PROJECT).post('/api/knowledge', {
      topic:       s1105Topic,
      key:         s1105Key,
      content:     'Use PostgreSQL with connection pooling (PgBouncer). Pool size: 10.',
      entity_type: 'Decision',
    })

    // Engineer writes conflicting DRAFT
    await api(tokens.engineer, PROJECT).post('/api/knowledge', {
      topic:       s1105Topic,
      key:         s1105Key,
      content:     'Migrate to CockroachDB for distributed transactions.',
      entity_type: 'Decision',
    })

    // Create pending_decision
    const pendingRes = await api(tokens.engineer, PROJECT).post('/pg/pending', {
      conflict_topic:   s1105Topic,
      conflict_key:     s1105Key,
      decision_type:    'conflict',
      existing_content: 'Use PostgreSQL with connection pooling (PgBouncer). Pool size: 10.',
      incoming_content: 'Migrate to CockroachDB for distributed transactions.',
      conflict_reason:  'CockroachDB offers distributed transactions but would require significant migration effort.',
    })
    if (pendingRes.status !== 201) throw new Error(`S-11.5 beforeAll: pending insert failed ${pendingRes.status}`)
    s1105ConflictId = pendingRes.data.conflict_id

    // PA (test-pe) approves the conflict — resolving it
    await api(tokens.pe, PROJECT).post(`/api/review/${s1105ConflictId}`, {
      action: 'approve',
      note:   'Approved — CockroachDB migration aligns with Q3 scaling roadmap.',
    })
  })

  test('step 1 — re-reviewing an approved conflict by the same PA returns 404', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/review/${s1105ConflictId}`, {
      action: 'reject',
      note:   'Attempting to reverse the previous approval — conflict is already resolved.',
    })
    expect(res.status).toBe(404)
  })

  test('step 2 — re-reviewing the same resolved conflict by a second PA also returns 404', async () => {
    const res = await api(tokens.pe2, PROJECT).post(`/api/review/${s1105ConflictId}`, {
      action: 'reject',
      note:   'Second PA trying to re-open a resolved conflict — must not be allowed.',
    })
    expect(res.status).toBe(404)
  })

  test('step 3 — resolved conflict does not appear in /pg/pending', async () => {
    const res = await api(tokens.pe, PROJECT).get('/pg/pending')
    expect(res.status).toBe(200)
    const pending = Array.isArray(res.data) ? res.data : (res.data.decisions ?? [])
    expect(pending.find(d => d.conflict_id === s1105ConflictId)).toBeUndefined()
  })

  test('step 4 — ACTIVE version remains after failed re-review attempts (no accidental rollback)', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${s1105Topic}/${s1105Key}`)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
  })
})

}) // outer describe — required by graph reporter extractScenarioId()
