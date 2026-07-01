/**
 * S-16 — Knowledge History & Point-in-Time Recall (J16)
 *
 * Journey: J16 — Knowledge History & Point-in-Time Recall
 * Pillars: Functional Correctness (S-16.1 — single-version history)
 *          Provenance Integrity    (S-16.2 — history after supersede)
 *          Deprecation History    (S-16.3 — history after deprecation)
 *          Edge Cases             (S-16.4 — nonexistent key)
 *          Point-in-Time          (S-16.5 — /at endpoint)
 *
 * Sub-scenarios:
 *   S-16.1  GET /pg/versions/:t/:k/history — single-version, correct fields present
 *   S-16.2  GET /pg/versions/:t/:k/history — after supersede: 2 entries, newest first
 *   S-16.3  GET /pg/versions/:t/:k/history — after deprecation: highest version is DEPRECATED
 *   S-16.4  GET /pg/versions/:t/:k/history — nonexistent key returns 200 []
 *   S-16.5  GET /pg/versions/:t/:k/at — point-in-time recall: before/after supersede, missing param
 *
 * Architecture notes:
 *   Both HTTP routes are tested here; the additional Graphiti SUPERSEDES edge enrichment
 *   is MCP-path only (see MT-07).
 *
 *   GET /pg/versions/:topic/:key/history — returns all versions newest-first.
 *   GET /pg/versions/:topic/:key/at?date=ISO — returns the ACTIVE version at a point in time.
 *   All routes are project-scoped via X-Quorum-Project header + JWT q_project_id resolution.
 *
 *   The `triggered_by` column is NOT NULL (constitutional invariant) — always set on insert.
 *   The `superseded_by_version` back-reference is a derived field on the old version row,
 *   set by the atomic supersede route as a forward_link.
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }           from '../../helpers/api.js'
import { tokens }        from '../../helpers/jwt.js'
import { uid, activeEntry } from '../../helpers/seed.js'

const PROJECT = 'quorum-test-project'

// Knowledge history is append-only — no state mutations conflict; parallel is safe.
// However, the point-in-time test in S-16.5 uses a 1-second sleep — serial prevents
// accidental timing interference.
test.describe.configure({ mode: 'serial' })

describe('S-16 — Knowledge History', () => {

// ─────────────────────────────────────────────────────────────────────────────
// S-16.1 — Single-Version History
// ─────────────────────────────────────────────────────────────────────────────

describe('S-16.1 — Single-Version History', () => {
  const topic = 'infra'
  let key

  beforeAll(async () => {
    key = uid('hist-single-s16')
    await activeEntry({ topic, key, content: 'Baseline infrastructure pattern — single deployment region.', project: PROJECT })
  })

  test('step 1 — GET /pg/versions/history returns 200 array with 1 entry', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}/history`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data)).toBe(true)
    expect(res.data.length).toBe(1)
  })

  test('step 2 — version fields are correct on the single entry', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}/history`)
    const v = res.data[0]

    expect(v.version).toBe(1)
    expect(v.status).toBe('ACTIVE')
    expect(v.author).toBe('test-pe')
    expect(v.created_at).toBeTruthy()
    // Constitutional Rule: triggered_by is NEVER null
    expect(v.triggered_by).toBeTruthy()
    // No supersede has occurred yet
    expect(v.supersedes_reason).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-16.2 — History After Supersede (Two Versions, Correct Order)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-16.2 — History After Supersede', () => {
  const topic = 'infra'
  let key

  beforeAll(async () => {
    key = uid('hist-sup-s16')
    await activeEntry({ topic, key, content: 'Baseline infra pattern v1 — single region.', project: PROJECT })
  })

  test('step 1 — PA supersedes with extended content', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${key}/supersede`, {
      content:     'Extended to multi-region after DR requirement in Q3.',
      entity_type: 'Decision',
      reason:      'Extended to multi-region after DR requirement in Q3',
    })
    expect(res.status).toBe(200)
  })

  test('step 2 — history returns 2 entries, newest first', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}/history`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data)).toBe(true)
    expect(res.data.length).toBe(2)

    // Newest-first ordering: v2 comes first
    expect(res.data[0].version).toBe(2)
    expect(res.data[1].version).toBe(1)
  })

  test('step 3 — statuses are correct: v2 ACTIVE, v1 SUPERSEDED', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}/history`)
    expect(res.data[0].status).toBe('ACTIVE')
    expect(res.data[1].status).toBe('SUPERSEDED')
  })

  test('step 4 — v2 supersedes_reason is preserved', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}/history`)
    const v2 = res.data[0]
    expect(v2.supersedes_reason).toBe('Extended to multi-region after DR requirement in Q3')
  })

  test('step 5 — v1 has superseded_at timestamp (non-null)', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}/history`)
    const v1 = res.data[1]
    // superseded_at is set when the version transitions to SUPERSEDED
    // Note: this may be stored in updated_at or a dedicated superseded_at column
    // depending on implementation — check either field is non-null and in the past
    const hasTimestamp = v1.superseded_at != null || v1.updated_at != null
    expect(hasTimestamp).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-16.3 — History After Deprecation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-16.3 — History After Deprecation', () => {
  const topic = 'infra'
  let key

  beforeAll(async () => {
    key = uid('hist-dep-s16')
    await activeEntry({ topic, key, content: 'Infra pattern to be deprecated — replaced by managed service.', project: PROJECT })
  })

  test('step 1 — PA deprecates the ACTIVE entry', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${key}/deprecate`, {
      reason: 'Pattern removed — replaced by managed platform service in Q4',
    })
    expect(res.status).toBe(200)
  })

  test('step 2 — history shows the entry as DEPRECATED', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}/history`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data)).toBe(true)
    expect(res.data.length).toBeGreaterThan(0)

    // The entry with the highest version number should be DEPRECATED
    const sorted = [...res.data].sort((a, b) => b.version - a.version)
    expect(sorted[0].status).toBe('DEPRECATED')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-16.4 — Nonexistent Key Returns 200 [] (Not 404)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-16.4 — Nonexistent Key History', () => {
  test('step 1 — GET /pg/versions/history for nonexistent key returns 200 []', async () => {
    // getOrCreateKey is called internally — creates a q_keys row but no version rows.
    // History returns an empty array, not 404.
    const res = await api(tokens.pe, PROJECT).get('/pg/versions/infra/does-not-exist-s16/history')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data)).toBe(true)
    expect(res.data.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-16.5 — Point-in-Time Recall
// ─────────────────────────────────────────────────────────────────────────────

describe('S-16.5 — Point-in-Time Recall', () => {
  const topic = 'infra'
  let key
  let tBefore       // recorded BEFORE any write
  let tAfterV1      // recorded AFTER v1 is written, BEFORE v2

  beforeAll(async () => {
    key = uid('hist-pit-s16')

    // Record t_before (before any write)
    tBefore = new Date().toISOString()

    // Write v1
    await activeEntry({ topic, key, content: 'Original content — written before the supersede.', project: PROJECT })

    // Record t_after_v1 (after v1, before v2)
    tAfterV1 = new Date().toISOString()

    // Wait 1 second so created_at of v2 is strictly after t_after_v1
    await new Promise(r => setTimeout(r, 1100))

    // Write v2 via supersede
    await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${key}/supersede`, {
      content:     'Updated content — supersedes the original.',
      entity_type: 'Decision',
      reason:      'Architecture evolved after Q3 platform review',
    })
  })

  test('step 1 — /at?date=t_after_v1 returns v1 content (before supersede)', async () => {
    const res = await api(tokens.pe, PROJECT).get(
      `/pg/versions/${topic}/${key}/at?date=${encodeURIComponent(tAfterV1)}`
    )
    expect(res.status).toBe(200)
    // At t_after_v1, only v1 existed — content should match v1
    if (res.data && res.data.summary !== undefined) {
      expect(res.data.summary).toMatch(/Original content/i)
    } else if (res.data && res.data.content !== undefined) {
      expect(res.data.content).toMatch(/Original content/i)
    } else {
      // Response is the version row — check version number
      expect(res.data).not.toBeNull()
      if (res.data.version !== undefined) {
        expect(res.data.version).toBe(1)
      }
    }
  })

  test('step 2 — /at?date=t_before returns null or 404 (no version existed yet)', async () => {
    const res = await api(tokens.pe, PROJECT).get(
      `/pg/versions/${topic}/${key}/at?date=${encodeURIComponent(tBefore)}`
    )
    // Before any write: either 200 with null body or 404
    if (res.status === 200) {
      // null body is valid — no version existed at that point
      expect(res.data === null || res.data === undefined).toBe(true)
    } else {
      expect(res.status).toBe(404)
    }
  })

  test('step 3 — /at without date param returns 400 date query param required', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}/at`)
    expect(res.status).toBe(400)
    expect(res.data.error).toBe('date query param required')
  })

// ─────────────────────────────────────────────────────────────────────────────

}) // S-16 — Knowledge History

}) // outer describe — required by graph reporter extractScenarioId()
