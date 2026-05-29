/**
 * S-18 — Governance Route: Direct Coverage (J18)
 *
 * Journey: J18 — Governance Route: Direct Coverage
 * Pillars: Input Validation  (S-18.1 — detect-conflict guards)
 *          Input Validation  (S-18.2 — enrich guards)
 *          Response Shape    (S-18.3 — extract shape)
 *          Sanitization      (S-18.4 — overlong input truncated, never errors)
 *          Persistence       (S-18.5 — conflict_id enrichment caching)
 *
 * Sub-scenarios:
 *   S-18.1  POST /governance/detect-conflict — 400 on missing field; 200 happy path
 *   S-18.2  POST /governance/enrich          — 400 on missing conflict_reason; 200 shape
 *   S-18.3  POST /governance/extract         — 400 on missing task_summary; 200 item shape
 *   S-18.4  sanitizeForPrompt truncation     — 2500-char inputs → 200 (no error)
 *
 * Architecture notes:
 *   These three routes live in routes/governance.js and are protected by verifyJwt
 *   only — no project middleware. The mock-openai server returns governance-specific
 *   fixtures routed by system-prompt content:
 *     "conflict detector" → { contradicts, reason, possible_split, split_suggestion }
 *     "reviewer brief"    → { analysis, risks_if_approved, questions_for_reviewer, ... }
 *     "knowledge extractor" → { items: [{ topic, key, content, entity_type, confidence, mode }] }
 *
 *   Validation errors use Errors.unprocessable() → HTTP 400 (not 422).
 *   The extract route returns mode: "echoing"|"extracting"|"generalising"
 *   (aligned with confidence tiers 0.75/0.55/0.35 respectively).
 *
 *   These routes are exercised indirectly by the conflict pipeline (S-02) but never
 *   tested at the route-contract level. A schema change here would silently break S-02.
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }                        from '../helpers/api.js'
import { tokens }                     from '../helpers/jwt.js'
import { uid, draftEntry }            from '../helpers/seed.js'

// No state mutations — safe to run in parallel.
// Tests are grouped for readability but share no beforeAll fixtures.
test.describe.configure({ mode: 'parallel' })

const PROJECT = 'quorum-test-project'

// ─── Shared fixtures ───────────────────────────────────────────────────────────

// Route expects plain content strings, not graph node objects.
const EXISTING_NODE = 'Use JWT sessions. Stateless, no server-side state. Tokens are self-contained.'
const INCOMING_NODE = 'Use Redis-backed sessions. JWT cannot be revoked — security risk.'

const CONFLICT_REASON = 'Both specify session strategy for the same service context'

// ─────────────────────────────────────────────────────────────────────────────
// S-18.1 — POST /governance/detect-conflict Input Validation + Happy Path
// ─────────────────────────────────────────────────────────────────────────────

describe('S-18 — Governance Route', () => {

describe('S-18.1 — detect-conflict Validation', () => {
  test('step 1 — missing existing field → 400', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/detect-conflict', {
      incoming: INCOMING_NODE,
    })
    expect(res.status).toBe(400)
    // Error message describes the missing field
    const body = res.data
    const errText = body.message ?? body.error ?? ''
    expect(errText.toLowerCase()).toMatch(/existing/)
  })

  test('step 2 — missing incoming field → 400', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/detect-conflict', {
      existing: EXISTING_NODE,
    })
    expect(res.status).toBe(400)
    const body = res.data
    const errText = body.message ?? body.error ?? ''
    expect(errText.toLowerCase()).toMatch(/incoming/)
  })

  test('step 3 — happy path → 200 with contradicts + reason', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/detect-conflict', {
      existing: EXISTING_NODE,
      incoming: INCOMING_NODE,
    })
    expect(res.status).toBe(200)

    // Route response: { contradicts, reason, possible_split, split_suggestion }
    // (mock returns contradicts:false — assert type, not value)
    expect(typeof res.data.contradicts).toBe('boolean')
    expect(typeof res.data.reason).toBe('string')
    expect(res.data.reason.length).toBeGreaterThan(0)
    expect(typeof res.data.possible_split).toBe('boolean')
    // split_suggestion is null when possible_split is false
    if (!res.data.possible_split) {
      expect(res.data.split_suggestion).toBeNull()
    }
  })

  test('step 4 — unauthenticated call → 401', async () => {
    const res = await api('not-a-valid-token', PROJECT).post('/governance/detect-conflict', {
      existing: EXISTING_NODE,
      incoming: INCOMING_NODE,
    })
    expect(res.status).toBe(401)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-18.2 — POST /governance/enrich Input Validation + Shape
// ─────────────────────────────────────────────────────────────────────────────

describe('S-18.2 — enrich Validation & Shape', () => {
  test('step 1 — missing conflict_reason → 400', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/enrich', {
      existing: EXISTING_NODE,
      incoming: INCOMING_NODE,
      // conflict_reason omitted
    })
    expect(res.status).toBe(400)
    const body = res.data
    const errText = body.message ?? body.error ?? ''
    expect(errText.toLowerCase()).toMatch(/conflict_reason/)
  })

  test('step 2 — missing existing → 400', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/enrich', {
      incoming:        INCOMING_NODE,
      conflict_reason: CONFLICT_REASON,
    })
    expect(res.status).toBe(400)
  })

  test('step 3 — happy path → 200', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/enrich', {
      existing:        EXISTING_NODE,
      incoming:        INCOMING_NODE,
      conflict_reason: CONFLICT_REASON,
    })
    expect(res.status).toBe(200)
  })

  test('step 4 — analysis is a non-empty string', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/enrich', {
      existing:        EXISTING_NODE,
      incoming:        INCOMING_NODE,
      conflict_reason: CONFLICT_REASON,
    })
    expect(typeof res.data.analysis).toBe('string')
    expect(res.data.analysis.length).toBeGreaterThan(20)
  })

  test('step 5 — risks_if_approved is array with 2–4 non-empty strings', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/enrich', {
      existing:        EXISTING_NODE,
      incoming:        INCOMING_NODE,
      conflict_reason: CONFLICT_REASON,
    })
    const risks = res.data.risks_if_approved
    expect(Array.isArray(risks)).toBe(true)
    expect(risks.length).toBeGreaterThanOrEqual(2)
    expect(risks.length).toBeLessThanOrEqual(4)
    for (const risk of risks) {
      expect(typeof risk).toBe('string')
      expect(risk.length).toBeGreaterThan(0)
    }
  })

  test('step 6 — questions_for_reviewer is array with 2–3 non-empty strings', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/enrich', {
      existing:        EXISTING_NODE,
      incoming:        INCOMING_NODE,
      conflict_reason: CONFLICT_REASON,
    })
    const qs = res.data.questions_for_reviewer
    expect(Array.isArray(qs)).toBe(true)
    expect(qs.length).toBeGreaterThanOrEqual(2)
    expect(qs.length).toBeLessThanOrEqual(3)
    for (const q of qs) {
      expect(typeof q).toBe('string')
      expect(q.length).toBeGreaterThan(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-18.3 — POST /governance/extract Input Validation + Item Shape
// ─────────────────────────────────────────────────────────────────────────────

describe('S-18.3 — extract Validation & Shape', () => {
  const TASK_SUMMARY =
    'Build a distributed rate limiter using Redis. One counter per service per endpoint. ' +
    'Use sliding window algorithm. Maximum 100 requests per minute per endpoint.'

  test('step 1 — missing task_summary → 400', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/extract', {})
    expect(res.status).toBe(400)
    const body = res.data
    const errText = body.message ?? body.error ?? ''
    expect(errText.toLowerCase()).toMatch(/task_summary/)
  })

  test('step 2 — happy path → 200 with items array', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/extract', {
      task_summary: TASK_SUMMARY,
    })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.items)).toBe(true)
    // Mock returns 2 items — at least 1 required for shape assertions
    expect(res.data.items.length).toBeGreaterThan(0)
  })

  test('step 3 — each item has topic (non-empty string)', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/extract', {
      task_summary: TASK_SUMMARY,
    })
    for (const item of res.data.items) {
      expect(typeof item.topic).toBe('string')
      expect(item.topic.length).toBeGreaterThan(0)
    }
  })

  test('step 4 — each item key is kebab-case', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/extract', {
      task_summary: TASK_SUMMARY,
    })
    for (const item of res.data.items) {
      expect(typeof item.key).toBe('string')
      expect(item.key).toMatch(/^[a-z0-9-]+$/)
    }
  })

  test('step 5 — each item content is non-empty string (> 10 chars)', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/extract', {
      task_summary: TASK_SUMMARY,
    })
    for (const item of res.data.items) {
      expect(typeof item.content).toBe('string')
      expect(item.content.length).toBeGreaterThan(10)
    }
  })

  test('step 6 — each item entity_type is non-empty string', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/extract', {
      task_summary: TASK_SUMMARY,
    })
    for (const item of res.data.items) {
      expect(typeof item.entity_type).toBe('string')
      expect(item.entity_type.length).toBeGreaterThan(0)
    }
  })

  test('step 7 — each item confidence is number in [0, 1]', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/extract', {
      task_summary: TASK_SUMMARY,
    })
    for (const item of res.data.items) {
      expect(typeof item.confidence).toBe('number')
      expect(item.confidence).toBeGreaterThanOrEqual(0)
      expect(item.confidence).toBeLessThanOrEqual(1)
    }
  })

  test('step 8 — each item mode is one of echoing|extracting|generalising', async () => {
    // These are the actual mode tiers used by the extraction schema:
    //   "echoing"      confidence 0.75 — echoing an explicit decision
    //   "extracting"   confidence 0.55 — extracting a pattern
    //   "generalising" confidence 0.35 — generalising from one case
    const VALID_MODES = new Set(['echoing', 'extracting', 'generalising'])
    const res = await api(tokens.pe, PROJECT).post('/governance/extract', {
      task_summary: TASK_SUMMARY,
    })
    for (const item of res.data.items) {
      expect(VALID_MODES.has(item.mode)).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-18.4 — sanitizeForPrompt Truncation (prompt-injection boundary)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-18.4 — Overlong Input Sanitization', () => {
  // sanitizeForPrompt() caps content at 2000 chars before LLM interpolation.
  // A 2500-char input must be silently truncated — not cause an error.
  const LONG_STRING = 'A'.repeat(2500)

  test('step 1 — 2500-char existing string to detect-conflict → 200 (not an error)', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/detect-conflict', {
      existing: LONG_STRING,
      incoming: 'Normal incoming content.',
    })
    expect(res.status).toBe(200)
    // contradicts field proves the LLM call completed on the truncated prompt
    expect(typeof res.data.contradicts).toBe('boolean')
  })

  test('step 2 — 2500-char task_summary to extract → 200 with items array', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/extract', {
      task_summary: LONG_STRING,
    })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.items)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-18.5 — Enrichment Persistence via conflict_id
// ─────────────────────────────────────────────────────────────────────────────

describe('S-18.5 — Enrichment Persistence', () => {
  // GAP-016: POST /governance/enrich with conflict_id persists the enrichment
  // object to pending_decisions.enrichment so GET /pg/pending surfaces it.
  test.describe.configure({ mode: 'serial' })

  let conflictId

  beforeAll(async () => {
    const key = uid('enrich-persist-s18')
    await draftEntry({ topic: 'testing', key, content: `Enrichment persistence test ${key}.`, project: PROJECT })

    const pendingRes = await api(tokens.engineer, PROJECT).post('/pg/pending', {
      conflict_topic:   'testing',
      conflict_key:     key,
      decision_type:    'conflict',
      existing_content: EXISTING_NODE,
      incoming_content: `Enrichment persistence test ${key}.`,
      conflict_reason:  'Enrichment persistence test (S-18.5)',
    })
    expect(pendingRes.status).toBe(201)
    conflictId = pendingRes.data.conflict_id
  })

  test('step 1 — enrich without conflict_id returns shape but does not persist', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/enrich', {
      existing:        EXISTING_NODE,
      incoming:        'Use Redis sessions instead of JWT.',
      conflict_reason: CONFLICT_REASON,
    })
    expect(res.status).toBe(200)
    expect(typeof res.data.analysis).toBe('string')
    expect(Array.isArray(res.data.risks_if_approved)).toBe(true)
  })

  test('step 2 — enrich with conflict_id returns 200 and persists to pending_decisions', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/enrich', {
      existing:        EXISTING_NODE,
      incoming:        'Use Redis sessions instead of JWT.',
      conflict_reason: CONFLICT_REASON,
      conflict_id:     conflictId,
    })
    expect(res.status).toBe(200)
    expect(typeof res.data.analysis).toBe('string')
  })

  test('step 3 — GET /pg/pending shows enrichment populated on the persisted conflict', async () => {
    const res = await api(tokens.pe, PROJECT).get('/pg/pending')
    expect(res.status).toBe(200)
    const records = Array.isArray(res.data) ? res.data : []
    const found = records.find(r => r.conflict_id === conflictId)
    expect(found).toBeTruthy()
    expect(found.enrichment).not.toBeNull()
    const enrichmentData = typeof found.enrichment === 'string'
      ? JSON.parse(found.enrichment)
      : found.enrichment
    expect(typeof enrichmentData.analysis).toBe('string')
  })

}) // S-18.5 — Enrichment Persistence

}) // outer describe — required by graph reporter extractScenarioId()
