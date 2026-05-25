/**
 * S-12 — Knowledge Status State Machine (J12)
 *
 * Journey: J12 — Knowledge Status State Machine
 * Pillars: Functional Correctness (S-12.1 — valid transitions)
 *          Governance Integrity   (S-12.2 — invalid transitions)
 *          Coexistence            (S-12.3 — non-PE DRAFT alongside ACTIVE)
 *          Immutability           (S-12.4 — terminal status enforcement)
 *          Listing                (S-12.5 — GET /api/drafts)
 *
 * Valid transitions:
 *   DRAFT  → ACTIVE      via promote (PA) or direct PA write
 *   DRAFT  → REJECTED    via review reject (PA)
 *   ACTIVE → SUPERSEDED  via supersede (new version becomes ACTIVE)
 *   ACTIVE → DEPRECATED  via deprecate (PA)
 *
 * Invalid transitions (must be rejected with correct error code):
 *   promote when no DRAFT exists      → 404 no_draft
 *   PA duplicate ACTIVE write         → 409 already_exists
 *   promote already-ACTIVE entry      → 404 no_draft
 *   supersede DEPRECATED entry        → 404 (no ACTIVE to supersede)
 *   promote DEPRECATED entry          → 404 no_draft
 *
 * Coexistence rule (CLAUDE.md):
 *   "PE 409s on duplicate ACTIVE, non-PE can DRAFT alongside an existing ACTIVE"
 *
 * Architecture notes:
 *   POST /api/knowledge (PA → ACTIVE; non-PA → DRAFT; duplicate ACTIVE by PA → 409)
 *   POST /api/knowledge/:t/:k/promote  (DRAFT → ACTIVE, PA only)
 *   POST /api/knowledge/:t/:k/supersede (ACTIVE → old:SUPERSEDED, new:ACTIVE, PA only)
 *   POST /api/knowledge/:t/:k/deprecate (ACTIVE → DEPRECATED, PA only)
 *   GET  /api/drafts  (returns all DRAFT entries for the current project)
 *   GET  /pg/versions/:t/:k  (returns the current ACTIVE version; null if none)
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }      from '../helpers/api.js'
import { tokens }   from '../helpers/jwt.js'
import { uid, activeEntry, draftEntry } from '../helpers/seed.js'

const PROJECT = 'quorum-test-project'

// State transitions are sequential — order matters for coexist and immutability tests.
test.describe.configure({ mode: 'serial' })

describe('S-12 — Knowledge State Machine', () => {

// ─────────────────────────────────────────────────────────────────────────────
// S-12.1 — Valid Transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('S-12.1 — Valid Transitions', () => {

  describe('DRAFT → ACTIVE via promote', () => {
    let topic, key

    beforeAll(async () => {
      topic = 'testing'
      key   = uid('state-draft-s12')
      // Engineer write → DRAFT
      await draftEntry({ topic, key, content: `Baseline draft content for promote test ${key}.`, project: PROJECT })
    })

    test('step 1 — engineer write lands as DRAFT', async () => {
      const client = api(tokens.engineer, PROJECT)
      const res = await client.get(`/pg/versions/${topic}/${key}`)
      // No ACTIVE version yet — may return null or 404
      if (res.status === 200 && res.data) {
        expect(res.data.status).not.toBe('ACTIVE')
      }
    })

    test('step 2 — PA promotes DRAFT → ACTIVE', async () => {
      const client = api(tokens.pe, PROJECT)
      const res = await client.post(`/api/knowledge/${topic}/${key}/promote`, {
        note: 'Reviewed and correct — meets project quality standards',
      })
      expect(res.status).toBe(200)
      expect(res.data.status).toBe('ACTIVE')
    })

    test('step 3 — promoted entry is now ACTIVE', async () => {
      const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}`)
      expect(res.status).toBe(200)
      expect(res.data.status).toBe('ACTIVE')
      expect(res.data.version).toBe(1)
    })
  })

  describe('DRAFT → REJECTED via review reject', () => {
    let topic, key, conflictId

    beforeAll(async () => {
      topic = 'testing'
      key   = uid('state-reject-s12')
      await draftEntry({ topic, key, content: `Draft for reject test ${key}.`, project: PROJECT })

      // Create pending_decision so review endpoint can find it
      const pendingRes = await api(tokens.engineer, PROJECT).post('/pg/pending', {
        conflict_topic:   topic,
        conflict_key:     key,
        decision_type:    'conflict',
        existing_content: '',
        incoming_content: `Draft for reject test ${key}.`,
        conflict_reason:  'State machine reject test (S-12)',
      })
      expect(pendingRes.status).toBe(201)
      conflictId = pendingRes.data.conflict_id
    })

    test('step 1 — PA rejects conflict → 200', async () => {
      const res = await api(tokens.pe, PROJECT).post(`/api/review/${conflictId}`, {
        action: 'reject',
        note:   'Does not meet quality standards for this project — needs revision',
      })
      expect(res.status).toBe(200)
      expect(res.data.status).toBe('rejected')
    })

    test('step 2 — GET /pg/versions returns no ACTIVE entry after reject', async () => {
      const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}`)
      // After reject, there is no ACTIVE version — route returns null or 404
      if (res.status === 200) {
        expect(res.data === null || res.data === undefined || res.data.status === 'REJECTED').toBe(true)
      } else {
        expect([404, 200]).toContain(res.status)
      }
    })
  })

  describe('ACTIVE → SUPERSEDED via supersede', () => {
    let topic, key

    beforeAll(async () => {
      topic = 'testing'
      key   = uid('state-supersede-s12')
      await activeEntry({ topic, key, content: `v1 ACTIVE content for supersede test ${key}.`, project: PROJECT })
    })

    test('step 1 — PA supersedes → v2 ACTIVE, v1 SUPERSEDED', async () => {
      const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${key}/supersede`, {
        content:     `v2 superseding content for ${key}. Updated after architecture review.`,
        entity_type: 'Decision',
        reason:      'Updated to reflect new architecture decisions after Q3 platform review',
      })
      expect(res.status).toBe(200)
    })

    test('step 2 — current version is v2 ACTIVE', async () => {
      const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}`)
      expect(res.status).toBe(200)
      expect(res.data.status).toBe('ACTIVE')
      expect(res.data.version).toBe(2)
    })

    test('step 3 — history shows both versions (no hard delete)', async () => {
      const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}/history`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.data)).toBe(true)
      expect(res.data.length).toBe(2)
      const statuses = res.data.map(v => v.status)
      expect(statuses).toContain('ACTIVE')
      expect(statuses).toContain('SUPERSEDED')
    })
  })

  describe('ACTIVE → DEPRECATED via deprecate', () => {
    let topic, key

    beforeAll(async () => {
      topic = 'testing'
      key   = uid('state-deprecate-s12')
      await activeEntry({ topic, key, content: `ACTIVE entry to be deprecated in state machine test ${key}.`, project: PROJECT })
    })

    test('step 1 — PA deprecates ACTIVE entry → 200 DEPRECATED', async () => {
      const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${key}/deprecate`, {
        reason: 'Entry superseded by new platform decision — no longer applicable after Q3',
      })
      expect(res.status).toBe(200)
    })

    test('step 2 — deprecated entry no longer returned as ACTIVE', async () => {
      const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}`)
      // No ACTIVE version — may return null or 404
      if (res.status === 200 && res.data) {
        expect(res.data.status).not.toBe('ACTIVE')
      }
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-12.2 — Invalid Transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('S-12.2 — Invalid Transitions', () => {
  test('promote when no DRAFT exists → 404 no_draft', async () => {
    const topic = 'testing'
    const key   = uid('no-draft-here-s12')
    // No DRAFT created — key does not exist
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${key}/promote`, {
      note: 'Promote attempt on non-existent DRAFT entry',
    })
    expect(res.status).toBe(404)
    expect(res.data.error).toBe('no_draft')
  })

  test('PA duplicate ACTIVE write → 409 already_exists', async () => {
    const topic = 'testing'
    const key   = uid('state-dup-s12')
    // First PA write → ACTIVE
    await activeEntry({ topic, key, content: `First ACTIVE write for duplicate test ${key}.`, project: PROJECT })

    // Second PA write with same topic:key → 409
    const res = await api(tokens.pe, PROJECT).post('/api/knowledge', {
      topic,
      key,
      content:     'Second attempt — should fail because ACTIVE already exists.',
      entity_type: 'Decision',
    })
    expect(res.status).toBe(409)
    expect(res.data.error).toBe('already_exists')
  })

  test('promote already-ACTIVE entry → 404 no_draft', async () => {
    const topic = 'testing'
    const key   = uid('state-promote-active-s12')
    await activeEntry({ topic, key, content: `Already-ACTIVE for promote-active test ${key}.`, project: PROJECT })

    // Promote with nothing to promote (already ACTIVE, no DRAFT)
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${key}/promote`, {
      note: 'Trying to promote an entry that is already ACTIVE',
    })
    expect(res.status).toBe(404)
    expect(res.data.error).toBe('no_draft')
  })

  test('supersede atomicity — exactly one ACTIVE version at any point', async () => {
    const topic = 'testing'
    const key   = uid('state-atomic-s12')
    await activeEntry({ topic, key, content: `Atomicity test v1 ${key}.`, project: PROJECT })

    // Supersede → v2 ACTIVE
    const supersedeRes = await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${key}/supersede`, {
      content:     `Atomicity test v2 ${key}. Updated pattern.`,
      entity_type: 'Decision',
      reason:      'Testing atomicity of supersede operation during state machine verification',
    })
    expect(supersedeRes.status).toBe(200)

    // Query history — exactly one ACTIVE, exactly one SUPERSEDED
    const historyRes = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}/history`)
    expect(historyRes.status).toBe(200)
    const activeVersions    = historyRes.data.filter(v => v.status === 'ACTIVE')
    const supersededVersions = historyRes.data.filter(v => v.status === 'SUPERSEDED')
    expect(activeVersions.length).toBe(1)
    expect(supersededVersions.length).toBe(1)
    expect(activeVersions[0].version).toBe(2)
    expect(supersededVersions[0].version).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-12.3 — Non-PE DRAFT Coexists with ACTIVE
// ─────────────────────────────────────────────────────────────────────────────

describe('S-12.3 — Non-PE DRAFT Alongside ACTIVE', () => {
  let topic, key

  beforeAll(async () => {
    topic = 'testing'
    key   = uid('coexist-s12')
    await activeEntry({ topic, key, content: `ACTIVE entry for coexistence test ${key}.`, project: PROJECT })
  })

  test('step 1 — PA write exists as ACTIVE v1', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}`)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.version).toBe(1)
  })

  test('step 2 — engineer write to same key returns DRAFT (NOT 409)', async () => {
    // Non-PA writes alongside existing ACTIVE → DRAFT (not 409)
    const res = await api(tokens.engineer, PROJECT).post('/api/knowledge', {
      topic,
      key,
      content:     `Engineer competing content for coexistence test — different approach ${key}.`,
      entity_type: 'Decision',
    })
    // Should succeed as DRAFT (HTTP 200 or 201)
    expect([200, 201]).toContain(res.status)
    expect(res.data.status).toBe('DRAFT')
  })

  test('step 3 — history shows both v1 ACTIVE and v2 DRAFT coexisting', async () => {
    const historyRes = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}/history`)
    expect(historyRes.status).toBe(200)
    expect(historyRes.data.length).toBe(2)

    const activeVersions = historyRes.data.filter(v => v.status === 'ACTIVE')
    const draftVersions  = historyRes.data.filter(v => v.status === 'DRAFT')
    // Exactly one ACTIVE, one DRAFT — they coexist
    expect(activeVersions.length).toBe(1)
    expect(draftVersions.length).toBe(1)
    expect(activeVersions[0].version).toBe(1)
    expect(draftVersions[0].version).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-12.4 — Terminal Status Immutability
// ─────────────────────────────────────────────────────────────────────────────

describe('S-12.4 — Terminal Status Immutability', () => {
  let supersedeTopic, supersedeKey   // v1 SUPERSEDED, v2 ACTIVE
  let deprecatedTopic, deprecatedKey // v1 DEPRECATED

  beforeAll(async () => {
    // Set up: superseded entry
    supersedeTopic = 'testing'
    supersedeKey   = uid('super-imm-s12')
    await activeEntry({ topic: supersedeTopic, key: supersedeKey, content: `Imm test v1 ${supersedeKey}.`, project: PROJECT })
    await api(tokens.pe, PROJECT).post(`/api/knowledge/${supersedeTopic}/${supersedeKey}/supersede`, {
      content:     `Imm test v2 ${supersedeKey}. Superseded.`,
      entity_type: 'Decision',
      reason:      'Superseded to set up immutability test for state machine verification',
    })

    // Set up: deprecated entry
    deprecatedTopic = 'testing'
    deprecatedKey   = uid('dep-imm-s12')
    await activeEntry({ topic: deprecatedTopic, key: deprecatedKey, content: `Deprecated entry ${deprecatedKey}.`, project: PROJECT })
    await api(tokens.pe, PROJECT).post(`/api/knowledge/${deprecatedTopic}/${deprecatedKey}/deprecate`, {
      reason: 'Deprecated to set up immutability test for state machine verification',
    })
  })

  test('step 1 — deprecate route on superseded key operates on ACTIVE v2 (or 404 if deprecated)', async () => {
    // The deprecate route targets the ACTIVE version (v2 in this case).
    // v1 (SUPERSEDED) is not affected.
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${supersedeTopic}/${supersedeKey}/deprecate`, {
      reason: 'Deprecating the ACTIVE version after supersede immutability test',
    })
    // Either deprecates v2 (200) or returns error — either way v1 SUPERSEDED is unchanged
    expect([200, 404]).toContain(res.status)

    // Verify v1 is still SUPERSEDED (not changed)
    const historyRes = await api(tokens.pe, PROJECT).get(`/pg/versions/${supersedeTopic}/${supersedeKey}/history`)
    expect(historyRes.status).toBe(200)
    const v1 = historyRes.data.find(v => v.version === 1)
    expect(v1).toBeTruthy()
    expect(v1.status).toBe('SUPERSEDED')
  })

  test('step 2 — supersede a DEPRECATED key → 404 (no ACTIVE version)', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${deprecatedTopic}/${deprecatedKey}/supersede`, {
      content:     'Attempting to supersede a deprecated entry.',
      entity_type: 'Decision',
      reason:      'Testing that supersede on deprecated entry fails gracefully',
    })
    // No ACTIVE version to supersede → 404
    expect(res.status).toBe(404)
  })

  test('step 3 — promote on DEPRECATED key → 404 no_draft', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${deprecatedTopic}/${deprecatedKey}/promote`, {
      note: 'Attempting to promote a deprecated entry',
    })
    expect(res.status).toBe(404)
    expect(res.data.error).toBe('no_draft')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-12.5 — GET /api/drafts Endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('S-12.5 — GET /api/drafts Endpoint', () => {
  let draftTopic, draftKey
  let activeTopic, activeKey

  beforeAll(async () => {
    draftTopic  = 'testing'
    draftKey    = uid('draft-listing-s12')
    activeTopic = 'testing'
    activeKey   = uid('active-not-a-draft-s12')

    // Seed a DRAFT entry
    await draftEntry({ topic: draftTopic, key: draftKey, content: `Draft for listing test ${draftKey}.`, project: PROJECT })
    // Seed an ACTIVE entry (PA write)
    await activeEntry({ topic: activeTopic, key: activeKey, content: `Active for drafts exclusion test ${activeKey}.`, project: PROJECT })
  })

  test('step 1 — GET /api/drafts returns the DRAFT entry', async () => {
    const res = await api(tokens.pe, PROJECT).get('/api/drafts')
    expect(res.status).toBe(200)

    const drafts = res.data.drafts ?? res.data ?? []
    expect(Array.isArray(drafts)).toBe(true)

    const found = drafts.find(d => d.key === draftKey)
    expect(found).toBeTruthy()
    expect(found.status).toBe('DRAFT')
    // Required fields must be present
    expect(typeof found.topic).toBe('string')
    expect(typeof found.key).toBe('string')
    expect(typeof found.author).toBe('string')
    expect(typeof found.version).toBe('number')
  })

  test('step 2 — GET /api/drafts does NOT include ACTIVE entries', async () => {
    const res = await api(tokens.pe, PROJECT).get('/api/drafts')
    expect(res.status).toBe(200)

    const drafts = res.data.drafts ?? res.data ?? []
    const activeFound = drafts.find(d => d.key === activeKey)
    expect(activeFound).toBeUndefined()
  })

  test('step 3 — PA promotes DRAFT → entry disappears from GET /api/drafts', async () => {
    const promoteRes = await api(tokens.pe, PROJECT).post(`/api/knowledge/${draftTopic}/${draftKey}/promote`, {
      note: 'Entry reviewed and meets project quality standards',
    })
    expect(promoteRes.status).toBe(200)

    const draftsRes = await api(tokens.pe, PROJECT).get('/api/drafts')
    const drafts = draftsRes.data.drafts ?? draftsRes.data ?? []
    const stillDraft = drafts.find(d => d.key === draftKey)
    expect(stillDraft).toBeUndefined()
  })

}) // S-12 — Knowledge State Machine

}) // outer describe — required by graph reporter extractScenarioId()
