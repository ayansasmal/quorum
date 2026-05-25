/**
 * S-03 — Deprecation Workflow (J03)
 *
 * Journey: J03 — Knowledge Deprecation and Retirement
 * Pillars: Governance Integrity (S-03.1, S-03.2, S-03.4, S-03.5)
 *          Functional Correctness (S-03.3)
 *          Data Integrity (all — no hard deletes; ACTIVE→DEPRECATED only)
 *
 * Sub-scenarios:
 *   S-03.1  PE single deprecation (direct authority path)
 *   S-03.2  Deprecation validation guards (non-PE blocked, reason required, no ACTIVE)
 *   S-03.3  PE bulk deprecation (full success + partial success)
 *   S-03.4  Deprecation request: engineer submits → PE approves (entry deprecated)
 *   S-03.5  Deprecation request: engineer submits → PE rejects (entry unchanged)
 *
 * Architecture notes:
 *   - POST /api/knowledge/:topic/:key/deprecate — PE only; reason ≥10 chars
 *   - POST /api/knowledge/deprecate/bulk — PE only; partial success allowed
 *   - GET /pg/versions/:topic/:key returns HTTP 200 with null body when no ACTIVE
 *   - Deprecation request: engineer writes POST /pg/pending (decision_type='deprecation_request')
 *   - PE reviews via POST /api/review/:conflictId (approve → deprecates; reject → unchanged)
 *   - ACTIVE entries transition to DEPRECATED — never deleted (provenance preserved)
 *
 * All keys are uid()-suffixed for run-to-run isolation without teardown.
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }            from '../helpers/api.js'
import { tokens }         from '../helpers/jwt.js'
import { uid, activeEntry, deprecationRequest } from '../helpers/seed.js'

const PROJECT = 'quorum-test-project'

describe('S-03 — Deprecation Workflow', () => {

// ─────────────────────────────────────────────────────────────────────────────
// S-03.1 — PE Single Deprecation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-03.1 — Single Deprecation', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'security'
  let policyKey
  const CONTENT = 'Use SHA-1 for password hashing. (Deprecated — replaced by bcrypt policy.)'
  const REASON  = 'Superseded by updated password hashing standard using bcrypt with cost factor 12.'

  beforeAll(async () => {
    policyKey = uid('password-hash-policy')
    await activeEntry({ topic, key: policyKey, content: CONTENT })
  })

  test('step 1 — PE deprecates ACTIVE entry with valid reason', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/knowledge/${topic}/${policyKey}/deprecate`, {
      reason: REASON,
    })
    expect(res.status).toBe(200)
    expect(res.data.deprecated).toBe(true)
    expect(res.data.topic).toBe(topic)
    expect(res.data.key).toBe(policyKey)
  })

  test('step 2 — GET /pg/versions returns null (no ACTIVE version remains)', async () => {
    // After deprecation, there is no ACTIVE version — the route returns HTTP 200
    // with null body (not 404), because the key still exists in q_keys.
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${policyKey}`)
    expect(res.status).toBe(200)
    expect(res.data).toBeNull()
  })

  test('step 3 — version history shows DEPRECATED status (no hard delete)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${policyKey}/history`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data)).toBe(true)
    const deprecated = res.data.find(v => v.status === 'DEPRECATED')
    expect(deprecated).toBeDefined()
    expect(deprecated.summary).toBe(CONTENT)
    expect(deprecated.version).toBe(1)
  })

  test('step 4 — deprecated entry no longer appears in knowledge browser', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/knowledge')
    expect(res.status).toBe(200)
    const items = res.data.items ?? []
    // The browser only shows ACTIVE entries — DEPRECATED should not appear
    expect(items.some(e => e.topic === topic && e.key === policyKey)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-03.2 — Deprecation Validation Guards
// ─────────────────────────────────────────────────────────────────────────────

describe('S-03.2 — Deprecation Validation', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'security'
  let guardKey
  const CONTENT = 'Use TLS 1.0 for all internal service-to-service communication.'

  beforeAll(async () => {
    guardKey = uid('tls-policy')
    await activeEntry({ topic, key: guardKey, content: CONTENT })
  })

  test('step 1 — non-PE (engineer) cannot deprecate (403 forbidden)', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post(`/api/knowledge/${topic}/${guardKey}/deprecate`, {
      reason: 'TLS 1.0 is now deprecated per industry standards.',
    })
    expect(res.status).toBe(403)
    expect(res.data.error).toBeDefined()
  })

  test('step 2 — missing reason returns 400 (rule 3: reason required)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/knowledge/${topic}/${guardKey}/deprecate`, {})
    expect(res.status).toBe(400)
    expect(res.data.error).toBe('reason_required')
  })

  test('step 3 — reason shorter than 10 chars returns 400', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/knowledge/${topic}/${guardKey}/deprecate`, {
      reason: 'Too short',  // 9 chars
    })
    expect(res.status).toBe(400)
    expect(res.data.error).toBe('reason_required')
  })

  test('step 4 — deprecating non-existent key returns 404', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/knowledge/${topic}/${uid('nonexistent')}/deprecate`, {
      reason: 'Cleaning up orphaned governance entries from last quarter.',
    })
    // getOrCreateKey creates the key but getCurrentVersion returns null
    expect(res.status).toBe(404)
    expect(res.data.error).toBe('not_found')
  })

  test('step 5 — ACTIVE entry unchanged after all failed deprecation attempts', async () => {
    // The guard entry must still be ACTIVE — all prior requests failed
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${guardKey}`)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.summary).toBe(CONTENT)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-03.3 — Bulk Deprecation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-03.3 — Bulk Deprecation', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'auth'
  let keyA   // ACTIVE — will be deprecated
  let keyB   // ACTIVE — will be deprecated
  let keyC   // will NOT exist (bulk partial-success test)
  const CONTENT_A = 'Use HTTP Basic Auth for internal APIs. (Legacy)'
  const CONTENT_B = 'Use API key auth for service-to-service. (Legacy)'
  const BULK_REASON = 'Replacing all legacy auth patterns with OAuth2 PKCE as per the new auth standard.'

  beforeAll(async () => {
    keyA = uid('basic-auth-policy')
    keyB = uid('api-key-auth-policy')
    keyC = uid('nonexistent-auth-policy')  // not seeded — will produce an error
    await Promise.all([
      activeEntry({ topic, key: keyA, content: CONTENT_A }),
      activeEntry({ topic, key: keyB, content: CONTENT_B }),
    ])
  })

  test('step 1 — PE bulk-deprecates two ACTIVE entries (full success)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/api/knowledge/deprecate/bulk', {
      entries: [
        { topic, key: keyA },
        { topic, key: keyB },
      ],
      reason: BULK_REASON,
    })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.deprecated)).toBe(true)
    expect(Array.isArray(res.data.errors)).toBe(true)
    expect(res.data.deprecated).toHaveLength(2)
    expect(res.data.errors).toHaveLength(0)
    // Both entries returned in deprecated list
    const keys = res.data.deprecated.map(d => d.key)
    expect(keys).toContain(keyA)
    expect(keys).toContain(keyB)
  })

  test('step 2 — both entries are DEPRECATED (no ACTIVE version for either)', async () => {
    const client = api(tokens.pe, PROJECT)
    const [resA, resB] = await Promise.all([
      client.get(`/pg/versions/${topic}/${keyA}`),
      client.get(`/pg/versions/${topic}/${keyB}`),
    ])
    expect(resA.status).toBe(200)
    expect(resA.data).toBeNull()

    expect(resB.status).toBe(200)
    expect(resB.data).toBeNull()
  })

  test('step 3 — partial success: one missing entry returns error, others still deprecated', async () => {
    // Seed one more ACTIVE entry for the partial success test
    const keyD = uid('session-auth-policy')
    await activeEntry({ topic, key: keyD, content: 'Use session cookies for browser auth.' })

    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/api/knowledge/deprecate/bulk', {
      entries: [
        { topic, key: keyD },   // ACTIVE — will succeed
        { topic, key: keyC },   // not seeded — no ACTIVE → error
      ],
      reason: BULK_REASON,
    })
    expect(res.status).toBe(200)
    // keyD deprecated successfully
    expect(res.data.deprecated.map(d => d.key)).toContain(keyD)
    // keyC had no ACTIVE version — appears in errors
    expect(res.data.errors.length).toBeGreaterThan(0)
    const keyCError = res.data.errors.find(e => e.key === keyC)
    expect(keyCError).toBeDefined()
  })

  test('step 4 — non-PE (engineer) cannot bulk-deprecate (403)', async () => {
    const keyE = uid('engineer-bulk-attempt')
    await activeEntry({ topic, key: keyE, content: 'Test entry for non-PE bulk block.' })

    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/api/knowledge/deprecate/bulk', {
      entries: [{ topic, key: keyE }],
      reason:  'Attempting engineer bulk deprecation — must be blocked.',
    })
    expect(res.status).toBe(403)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-03.4 — Deprecation Request: Engineer Submits → PE Approves
// ─────────────────────────────────────────────────────────────────────────────

describe('S-03.4 — Deprecation Request: Approve', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'infra'
  let obsoleteKey
  let requestId
  const CONTENT = 'Deploy to on-prem servers. Maintenance window required.'
  const REQUEST_REASON = 'On-prem infrastructure decommissioned — all services migrated to cloud.'

  beforeAll(async () => {
    obsoleteKey = uid('on-prem-deploy')
    await activeEntry({ topic, key: obsoleteKey, content: CONTENT })
    ;({ requestId } = await deprecationRequest({
      topic,
      key:    obsoleteKey,
      reason: REQUEST_REASON,
    }))
  })

  test('step 1 — deprecation request appears in GET /pg/pending', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/pending')
    expect(res.status).toBe(200)
    const requests = Array.isArray(res.data) ? res.data : []
    const req = requests.find(d =>
      d.conflict_id === requestId &&
      d.decision_type === 'deprecation_request',
    )
    expect(req).toBeDefined()
    expect(req.conflict_reason).toBe(REQUEST_REASON)
  })

  test('step 2 — ACTIVE entry still intact before PE review', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${obsoleteKey}`)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.summary).toBe(CONTENT)
  })

  test('step 3 — PE approves deprecation request → entry deprecated', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/review/${requestId}`, {
      action: 'approve',
      note:   'Infrastructure decommissioned confirmed — safe to deprecate.',
    })
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('approved')
    expect(res.data.request_id).toBe(requestId)
    expect(res.data.reviewer).toBe('test-pe')
  })

  test('step 4 — entry is now DEPRECATED (no ACTIVE version)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${obsoleteKey}`)
    expect(res.status).toBe(200)
    expect(res.data).toBeNull()
  })

  test('step 5 — DEPRECATED version preserved in history (no hard delete)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${obsoleteKey}/history`)
    expect(res.status).toBe(200)
    const deprecated = res.data.find(v => v.status === 'DEPRECATED')
    expect(deprecated).toBeDefined()
    expect(deprecated.summary).toBe(CONTENT)
  })

  test('step 6 — resolved request no longer in GET /pg/pending', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/pending')
    expect(res.status).toBe(200)
    const open = Array.isArray(res.data) ? res.data : []
    expect(open.some(d => d.conflict_id === requestId)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-03.5 — Deprecation Request: Engineer Submits → PE Rejects
// ─────────────────────────────────────────────────────────────────────────────

describe('S-03.5 — Deprecation Request: Reject', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'infra'
  let activeKey
  let requestId
  const CONTENT = 'Deploy strategy: blue/green with automated rollback on P95 latency spike.'
  const REQUEST_REASON = 'This entry is outdated — no longer reflects our deployment approach.'

  beforeAll(async () => {
    activeKey = uid('bg-deploy-strategy')
    await activeEntry({ topic, key: activeKey, content: CONTENT })
    ;({ requestId } = await deprecationRequest({
      topic,
      key:    activeKey,
      reason: REQUEST_REASON,
    }))
  })

  test('step 1 — PE rejects deprecation request', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/review/${requestId}`, {
      action: 'reject',
      note:   'Entry still accurate — reflects current deployment policy after recent platform review.',
    })
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('rejected')
    expect(res.data.request_id).toBe(requestId)
    expect(res.data.reviewer).toBe('test-pe')
  })

  test('step 2 — ACTIVE entry unchanged after rejection (no deprecation)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${activeKey}`)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.summary).toBe(CONTENT)
    expect(res.data.version).toBe(1)
  })

  test('step 3 — rejected request no longer in GET /pg/pending', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/pending')
    expect(res.status).toBe(200)
    const open = Array.isArray(res.data) ? res.data : []
    expect(open.some(d => d.conflict_id === requestId)).toBe(false)
  })

  test('step 4 — entry appears in knowledge browser (still ACTIVE)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/knowledge')
    expect(res.status).toBe(200)
    const items = res.data.items ?? []
    expect(items.some(e => e.topic === topic && e.key === activeKey && e.status === 'ACTIVE')).toBe(true)
  })
})

}) // S-03 — Deprecation Workflow
