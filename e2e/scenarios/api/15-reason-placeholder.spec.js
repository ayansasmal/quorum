/**
 * S-15 — Reason / Placeholder Rejection (J15)
 *
 * Journey: J15 — Reason / Placeholder Rejection (Constitutional Rule 3)
 * Pillars: Governance Integrity — 10 endpoints × 2 tests each (reject + accept)
 *
 * Constitutional Rule 3 (REASON_REQUIRED):
 *   enforceReasonRequired(reason, operation) throws ConstitutionalViolation('REASON_REQUIRED', ...)
 *   when reason is null, empty, < 10 chars, OR matches PLACEHOLDER_PATTERNS list:
 *     ['ok', 'yes', 'no', 'n/a', 'na', 'test', 'tbd', 'todo', 'fixme', '.', '!']
 *   Case-insensitive + trim-normalized: "  TBD  " is equivalent to "tbd"
 *
 * HTTP response: 400 { rule: 'REASON_REQUIRED', message: '...' }
 *   (ConstitutionalViolation → global error handler in server.js → 400 + { rule, message })
 *
 * Endpoint coverage matrix (from J15):
 *   1. POST /pg/versions  (supersede — MCP path)          reason: "tbd"
 *   2. POST /api/review/:id (conflict review)             note: "ok"
 *   3. POST /api/knowledge/:t/:k/promote                  note: "test"
 *   4. POST /api/knowledge/:t/:k/supersede                reason: "todo"
 *   5. POST /api/knowledge/:t/:k/deprecate                reason: "n/a"
 *   6. POST /api/deviations/:id/action                    reason: "."
 *   7. POST /admin/users                                  reason: "yes"
 *   8. POST /api/knowledge/deprecate/bulk                 reason: "na na na na" (matches "na" pattern)
 *   9. POST /config/transfer-ownership                    reason: "ok"
 *  10. POST /config/update-role                           reason: "tbd"
 *
 * Architecture notes:
 *   POST /pg/versions with supersede requires an existing entry to supersede. The route
 *   itself does NOT do conflict detection — it just inserts a new version.
 *
 *   POST /pg/versions supersede reason validation: `supersedes_reason` field is checked
 *   by enforceReasonRequired before the insert. Returns 400 { rule: 'REASON_REQUIRED' }.
 *
 *   POST /config/transfer-ownership and update-role: both now call enforceReasonRequired
 *   (fixed in this codebase — these previously returned { error: 'missing_param' }).
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api, catalogApi, assertConstitutionalViolation } from '../../helpers/api.js'
import { tokens }                                          from '../../helpers/jwt.js'
import { uid, activeEntry, draftEntry, deviation }        from '../../helpers/seed.js'

const PROJECT = 'quorum-test-project'
const CATALOG = 'quorum-test-catalog'

// State mutations are sequential; serial prevents interference.
test.describe.configure({ mode: 'serial' })

// Common valid reason strings for acceptance tests (≥ 10 chars, not placeholder)
const VALID_SUPERSEDE = 'Updated to reflect current service boundary decisions after Q3 review'
const VALID_REVIEW    = 'Incoming version addresses the identified edge case correctly'
const VALID_PROMOTE   = 'Entry reviewed and meets project quality standards for this context'
const VALID_DEPRECATE = 'Entry deprecated following team decision to remove the legacy pattern'
const VALID_DEFER     = 'Accepted deviation — migration tracked in JIRA-8821, target Q4 release'
const VALID_ADMIN     = 'Adding admin user to support expanded platform team operations this quarter'
const VALID_BULK_DEP  = 'Bulk deprecating legacy entries after platform migration completed successfully'
const VALID_TRANSFER  = 'Architecture team taking ownership after platform migration completion'
const VALID_ROLE_UPD  = 'Promoted after completing the platform migration project in Q3'

describe('S-15 — Reason Placeholder Rejection', () => {

// ─────────────────────────────────────────────────────────────────────────────
// 1. POST /pg/versions — supersedes_reason validation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-15.1 — POST /pg/versions supersede reason', () => {
  let topic, key

  beforeAll(async () => {
    topic = 'testing'
    key   = uid('placeholder-pg-supersede-s15')
    await activeEntry({ topic, key, content: `Baseline entry for pg-versions supersede test ${key}.`, project: PROJECT })
  })

  test('1a — placeholder reason "tbd" → 400 REASON_REQUIRED', async () => {
    const res = await api(tokens.pe, PROJECT).post('/pg/versions', {
      topic, key,
      summary:          `Updated content for supersede test — placeholder reason ${key}.`,
      entity_type:      'Decision',
      supersedes_reason: 'tbd',
    })
    assertConstitutionalViolation(res, 'REASON_REQUIRED')
  })

  test('1b — valid reason accepted → 201', async () => {
    const res = await api(tokens.pe, PROJECT).post('/pg/versions', {
      topic, key,
      summary:          `Updated content with valid reason ${key}.`,
      entity_type:      'Decision',
      supersedes_reason: VALID_SUPERSEDE,
    })
    expect(res.status).toBe(201)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. POST /api/review/:id — note validation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-15.2 — POST /api/review/:id review note', () => {
  let conflictId, topic, key

  beforeAll(async () => {
    topic = 'testing'
    key   = uid('placeholder-review-s15')
    await activeEntry({ topic, key, content: `Baseline for review note test ${key}.`, project: PROJECT })
    await draftEntry({ topic, key: uid(`draft-${key}`), content: `DRAFT for review ${key}.`, project: PROJECT })

    // Create pending_decision directly
    const pendingRes = await api(tokens.engineer, PROJECT).post('/pg/pending', {
      conflict_topic:   topic,
      conflict_key:     uid(`review-key-s15`),
      decision_type:    'conflict',
      existing_content: `Baseline for review note test ${key}.`,
      incoming_content: 'Conflicting DRAFT for placeholder review test.',
      conflict_reason:  'Review note placeholder test (S-15)',
    })
    expect(pendingRes.status).toBe(201)
    conflictId = pendingRes.data.conflict_id
  })

  test('2a — placeholder note "ok" → 400 REASON_REQUIRED', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/review/${conflictId}`, {
      action: 'approve',
      note:   'ok',
    })
    assertConstitutionalViolation(res, 'REASON_REQUIRED')
  })

  test('2b — valid note accepted → 200 approved', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/review/${conflictId}`, {
      action: 'approve',
      note:   VALID_REVIEW,
    })
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /api/knowledge/:t/:k/promote — note validation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-15.3 — POST /api/knowledge/:t/:k/promote note', () => {
  let topic, key

  beforeAll(async () => {
    topic = 'testing'
    key   = uid('placeholder-promote-s15')
    await draftEntry({ topic, key, content: `DRAFT for promote placeholder test ${key}.`, project: PROJECT })
  })

  test('3a — placeholder note "test" → 400 REASON_REQUIRED', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${key}/promote`, {
      note: 'test',
    })
    assertConstitutionalViolation(res, 'REASON_REQUIRED')
  })

  test('3b — valid note accepted → 200 ACTIVE', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${key}/promote`, {
      note: VALID_PROMOTE,
    })
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. POST /api/knowledge/:t/:k/supersede — reason validation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-15.4 — POST /api/knowledge/:t/:k/supersede reason', () => {
  let topic, key

  beforeAll(async () => {
    topic = 'testing'
    key   = uid('placeholder-supersede-s15')
    await activeEntry({ topic, key, content: `ACTIVE for supersede reason placeholder test ${key}.`, project: PROJECT })
  })

  test('4a — placeholder reason "todo" → 400 REASON_REQUIRED', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${key}/supersede`, {
      content:     `Updated content for ${key}`,
      entity_type: 'Decision',
      reason:      'todo',
    })
    assertConstitutionalViolation(res, 'REASON_REQUIRED')
  })

  test('4b — valid reason accepted → 200', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${key}/supersede`, {
      content:     `Updated content with valid reason for ${key}. Reflects new architecture.`,
      entity_type: 'Decision',
      reason:      VALID_SUPERSEDE,
    })
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. POST /api/knowledge/:t/:k/deprecate — reason validation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-15.5 — POST /api/knowledge/:t/:k/deprecate reason', () => {
  let topic, key

  beforeAll(async () => {
    topic = 'testing'
    key   = uid('placeholder-deprecate-s15')
    await activeEntry({ topic, key, content: `ACTIVE for deprecate reason placeholder test ${key}.`, project: PROJECT })
  })

  test('5a — placeholder reason "n/a" → 400 REASON_REQUIRED', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${key}/deprecate`, {
      reason: 'n/a',
    })
    assertConstitutionalViolation(res, 'REASON_REQUIRED')
  })

  test('5b — valid reason accepted → 200 DEPRECATED', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${key}/deprecate`, {
      reason: VALID_DEPRECATE,
    })
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. POST /api/deviations/:id/action — reason validation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-15.6 — POST /api/deviations/:id/action reason', () => {
  let deviationId

  beforeAll(async () => {
    // Seed an entry in the global catalog for the deviation to reference
    const devTopic = 'security'
    const devKey   = uid('placeholder-dev-action-s15')
    await activeEntry({ topic: devTopic, key: devKey, content: `Security standard for deviation action test ${devKey}.`, project: CATALOG, globalCatalog: true })

    // Record a deviation against the catalog entry
    const res = await deviation({
      catalogId:   CATALOG,
      topic:       devTopic,
      key:         devKey,
      description: 'Deviation for placeholder reason test S-15',
      project:     PROJECT,
    })
    deviationId = res.deviationId
  })

  test('6a — placeholder reason "." → 400 REASON_REQUIRED', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/deviations/${deviationId}/action`, {
      action_type: 'accept',
      reason:      '.',
    })
    assertConstitutionalViolation(res, 'REASON_REQUIRED')
  })

  test('6b — valid reason accepted → 200', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/deviations/${deviationId}/action`, {
      action_type: 'accept',
      reason:      VALID_DEFER,
    })
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. POST /admin/users — reason validation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-15.7 — POST /admin/users reason', () => {
  test('7a — placeholder reason "yes" → 400 REASON_REQUIRED', async () => {
    const res = await api(tokens.admin, PROJECT).post('/admin/users', {
      action:          'add',
      github_username: `test-admin-placeholder-s15-${Date.now()}`,
      reason:          'yes',
    })
    assertConstitutionalViolation(res, 'REASON_REQUIRED')
  })

  test('7b — valid reason accepted → 200 admin added', async () => {
    const newUser = `test-admin-valid-s15-${Date.now()}`
    const res = await api(tokens.admin, PROJECT).post('/admin/users', {
      action:          'add',
      github_username: newUser,
      reason:          VALID_ADMIN,
    })
    expect(res.status).toBe(200)

    // Cleanup — remove the user we just added
    await api(tokens.admin, PROJECT).post('/admin/users', {
      action:          'remove',
      github_username: newUser,
      reason:          'Removing test admin user added by S-15 placeholder validation test',
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. POST /api/knowledge/deprecate/bulk — reason validation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-15.8 — POST /api/knowledge/deprecate/bulk reason', () => {
  let topic, key

  beforeAll(async () => {
    topic = 'testing'
    key   = uid('placeholder-bulk-dep-s15')
    await activeEntry({ topic, key, content: `ACTIVE for bulk deprecate reason test ${key}.`, project: PROJECT })
  })

  test('8a — placeholder reason "na na na na" (matches "na" pattern) → 400 REASON_REQUIRED', async () => {
    // "na na na na" is ≥ 10 chars but matches the "na" placeholder pattern
    const res = await api(tokens.pe, PROJECT).post('/api/knowledge/deprecate/bulk', {
      entries: [{ topic, key }],
      reason:  'na na na na',
    })
    assertConstitutionalViolation(res, 'REASON_REQUIRED')
  })

  test('8b — valid reason accepted → 200 bulk deprecated', async () => {
    const res = await api(tokens.pe, PROJECT).post('/api/knowledge/deprecate/bulk', {
      entries: [{ topic, key }],
      reason:  VALID_BULK_DEP,
    })
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. POST /config/transfer-ownership — reason validation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-15.9 — POST /config/transfer-ownership reason', () => {
  test('9a — placeholder reason "ok" → 400 REASON_REQUIRED', async () => {
    const res = await api(tokens.pe, PROJECT).post('/config/transfer-ownership', {
      to:     'test-architect',
      reason: 'ok',
    })
    assertConstitutionalViolation(res, 'REASON_REQUIRED')
  })

  test('9b — valid reason accepted → 200 ownership transferred', async () => {
    const res = await api(tokens.pe, PROJECT).post('/config/transfer-ownership', {
      to:     'test-architect',
      reason: VALID_TRANSFER,
    })
    expect(res.status).toBe(200)
    expect(res.data.ok).toBe(true)

    // Transfer back to test-pe so subsequent tests still work
    const restoreRes = await api(tokens.architect, PROJECT).post('/config/transfer-ownership', {
      to:     'test-pe',
      reason: 'Restoring ownership to test-pe after S-15 transfer ownership test completed',
    })
    expect(restoreRes.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. POST /config/update-role — reason validation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-15.10 — POST /config/update-role reason', () => {
  test('10a — placeholder reason "tbd" → 400 REASON_REQUIRED', async () => {
    const res = await api(tokens.pe, PROJECT).post('/config/update-role', {
      github_username: 'test-engineer',
      role:            'architect',
      reason:          'tbd',
    })
    assertConstitutionalViolation(res, 'REASON_REQUIRED')
  })

  test('10b — valid reason accepted → 200 role updated', async () => {
    const res = await api(tokens.pe, PROJECT).post('/config/update-role', {
      github_username: 'test-engineer',
      role:            'architect',
      reason:          VALID_ROLE_UPD,
    })
    expect(res.status).toBe(200)
    expect(res.data.ok).toBe(true)

    // Restore original role
    await api(tokens.pe, PROJECT).post('/config/update-role', {
      github_username: 'test-engineer',
      role:            'engineer',
      reason:          'Restoring engineer role after S-15 update-role placeholder test completed',
    })
  })

}) // S-15 — Reason Placeholder Rejection

}) // outer describe — required by graph reporter extractScenarioId()
