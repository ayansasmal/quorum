/**
 * S-08 — Confidence Endorsement (J08)
 *
 * Journey: J08 — Confidence Endorsement Lifecycle
 * Pillars: Functional Correctness (S-08.1, S-08.2)
 *          Governance Integrity   (S-08.3, S-08.4)
 *          Validation Guards      (S-08.5)
 *
 * Sub-scenarios:
 *   S-08.1  Happy path — valid bump returns full response shape (all 11 fields)
 *   S-08.2  Role-weighted delta — engineer produces smaller delta than PA
 *   S-08.3  Confidence cap — confidence_after is always ≤ starting_confidence
 *   S-08.4  Cooldown enforcement — same user cannot bump twice within 7 days (429);
 *           different user on same entry is unaffected
 *   S-08.5  Validation guards — 404 on non-existent key; 404 when only DRAFT exists
 *
 * Architecture notes:
 *   POST /api/bump/:topic/:key (dashboard BFF route in dashboard.js):
 *     - Auth: JWT (verifyJwt middleware) — project resolved from req.user.project
 *     - Delta formula: BASE_DELTA (0.05) × ROLE_WEIGHT[role]
 *       ROLE_WEIGHT: engineer=0.50, architect=0.85, principal_architect=1.00
 *     - Cap: newConf = Math.min(startingConf, currentConf + delta)
 *     - Cooldown: 7 days per author per topic:key (bump_log table, inside a transaction)
 *     - Cooldown HTTP status: 429 (not 409) — error='cooldown_active'
 *     - Response: { topic, key, project_id, bumped_by, role, delta_applied,
 *                   confidence_before, confidence_after, starting_confidence,
 *                   clock_reset, next_bump_allowed }
 *
 * Test strategy:
 *   Active entries are seeded with activeEntry() (PA write → confidence = PA base_confidence).
 *   Since PA base_confidence ≈ starting_confidence, bumped entries hit the cap immediately —
 *   confidence_after === confidence_before. This tests the cap invariant correctly.
 *   delta_applied is always non-zero regardless of cap, making role-weight assertions valid.
 *
 *   Serial mode: S-08.4 requires first-bump to complete before second-bump test fires.
 *   File-level serial is used for simplicity since S-08 has only 11 tests.
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }                           from '../../helpers/api.js'
import { tokens }                        from '../../helpers/jwt.js'
import { uid, activeEntry, draftEntry }  from '../../helpers/seed.js'

const PROJECT = 'quorum-test-project'  // has all 8 test users including test-engineer + test-architect

// Delta formula: BASE_DELTA = 0.05; engineer weight = 0.50; architect = 0.85; PA = 1.00
const PA_DELTA       = 0.05            // 1.00 × 0.05
const ENG_DELTA      = 0.025           // 0.50 × 0.05
const ARCH_DELTA     = 0.0425          // 0.85 × 0.05

const SEVEN_DAYS_MS  = 7 * 24 * 60 * 60 * 1000

// S-08.4 first-bump must complete before second-bump fires — serial enforces ordering.
test.describe.configure({ mode: 'serial' })

describe('S-08 — Confidence Endorsement', () => {

// ─────────────────────────────────────────────────────────────────────────────
// S-08.1 — Happy Path
// ─────────────────────────────────────────────────────────────────────────────

describe('S-08.1 — Happy Path', () => {
  let happyTopic, happyKey

  beforeAll(async () => {
    const token = uid('s08-happy')
    happyTopic  = 'auth'
    happyKey    = token
    await activeEntry({ topic: happyTopic, key: happyKey, content: `Bump happy-path entry ${token}.` })
  })

  test('step 1 — valid bump by PA returns 200', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/bump/${happyTopic}/${happyKey}`, {})
    expect(res.status).toBe(200)
  })

  test('step 2 — response contains all required fields', async () => {
    // Seed a fresh entry (separate key) so the second bump is not blocked by cooldown from step 1.
    const token = uid('s08-shape')
    const topic = 'auth'
    const key   = token
    await activeEntry({ topic, key, content: `Bump shape test entry ${token}.` })

    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/bump/${topic}/${key}`, {})
    expect(res.status).toBe(200)

    // All 11 response fields must be present.
    expect(typeof res.data.topic).toBe('string')
    expect(typeof res.data.key).toBe('string')
    expect(typeof res.data.project_id).toBe('string')
    expect(typeof res.data.bumped_by).toBe('string')
    expect(typeof res.data.role).toBe('string')
    expect(typeof res.data.delta_applied).toBe('number')
    expect(typeof res.data.confidence_before).toBe('number')
    expect(typeof res.data.confidence_after).toBe('number')
    expect(typeof res.data.starting_confidence).toBe('number')
    expect(res.data.clock_reset).toBe(true)
    expect(typeof res.data.next_bump_allowed).toBe('string')

    // Identity and project echo correctly
    expect(res.data.topic).toBe(topic)
    expect(res.data.key).toBe(key)
    expect(res.data.project_id).toBe(PROJECT)
    expect(res.data.bumped_by).toBe('test-pe')
    expect(res.data.role).toBe('principal_architect')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-08.2 — Role-Weighted Delta
// ─────────────────────────────────────────────────────────────────────────────

describe('S-08.2 — Role-Weighted Delta', () => {
  let engKey, archKey, paKey

  beforeAll(async () => {
    // Three separate entries, one for each role, so cooldowns don't interfere.
    const base = uid('s08-delta')
    engKey  = `${base}-eng`
    archKey = `${base}-arch`
    paKey   = `${base}-pa`
    await activeEntry({ topic: 'reliability', key: engKey,  content: `Delta test engineer entry ${base}.` })
    await activeEntry({ topic: 'reliability', key: archKey, content: `Delta test architect entry ${base}.` })
    await activeEntry({ topic: 'reliability', key: paKey,   content: `Delta test pa entry ${base}.` })
  })

  test('step 1 — engineer bump delta_applied is smaller than PA bump delta_applied', async () => {
    const engClient = api(tokens.engineer, PROJECT)
    const paClient  = api(tokens.pe, PROJECT)

    const engRes = await engClient.post(`/api/bump/reliability/${engKey}`, {})
    const paRes  = await paClient.post(`/api/bump/reliability/${paKey}`, {})

    expect(engRes.status).toBe(200)
    expect(paRes.status).toBe(200)

    // Role weights: engineer(0.50) < PA(1.00) → deltas differ
    expect(engRes.data.delta_applied).toBeLessThan(paRes.data.delta_applied)
  })

  test('step 2 — delta_applied matches expected formula for each role', async () => {
    const archClient = api(tokens.architect, PROJECT)
    const archRes    = await archClient.post(`/api/bump/reliability/${archKey}`, {})
    expect(archRes.status).toBe(200)

    // Engineer: BASE_DELTA × 0.50 = 0.025
    const engClient = api(tokens.engineer, PROJECT)
    const freshToken = uid('s08-delta-verify')
    await activeEntry({ topic: 'reliability', key: freshToken, content: `Delta verify ${freshToken}.` })
    const engRes = await engClient.post(`/api/bump/reliability/${freshToken}`, {})

    expect(engRes.status).toBe(200)
    expect(engRes.data.delta_applied).toBeCloseTo(ENG_DELTA, 3)

    // Architect: BASE_DELTA × 0.85 = 0.0425
    expect(archRes.data.delta_applied).toBeCloseTo(ARCH_DELTA, 3)

    // PA (from step 1 bump) confirmed via constant above
    expect(engRes.data.delta_applied).toBeLessThan(archRes.data.delta_applied)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-08.3 — Confidence Cap
// ─────────────────────────────────────────────────────────────────────────────

describe('S-08.3 — Confidence Cap', () => {
  let capTopic, capKey

  beforeAll(async () => {
    const token = uid('s08-cap')
    capTopic    = 'security'
    capKey      = token
    // PA write lands at PA base_confidence (≈0.90) = starting_confidence.
    // Bump will try to add delta but hit Math.min(startingConf, currentConf + delta) = startingConf.
    await activeEntry({ topic: capTopic, key: capKey, content: `Cap invariant entry ${token}.` })
  })

  test('step 1 — confidence_after is always ≤ starting_confidence (cap invariant)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/bump/${capTopic}/${capKey}`, {})
    expect(res.status).toBe(200)

    // Core cap invariant: cannot bump above starting confidence
    expect(res.data.confidence_after).toBeLessThanOrEqual(res.data.starting_confidence)
  })

  test('step 2 — next_bump_allowed is approximately 7 days from now', async () => {
    // Fetch the bump log from a fresh entry to check timing — use a dedicated bump entry
    const token = uid('s08-timing')
    await activeEntry({ topic: 'security', key: token, content: `Timing entry ${token}.` })

    const client = api(tokens.pe, PROJECT)
    const before = Date.now()
    const res = await client.post(`/api/bump/security/${token}`, {})
    const after = Date.now()
    expect(res.status).toBe(200)

    const nextAllowed = new Date(res.data.next_bump_allowed).getTime()
    const expectedLow  = before + SEVEN_DAYS_MS - 5000  // 5s tolerance
    const expectedHigh = after  + SEVEN_DAYS_MS + 5000

    expect(nextAllowed).toBeGreaterThan(expectedLow)
    expect(nextAllowed).toBeLessThan(expectedHigh)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-08.4 — Cooldown Enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe('S-08.4 — Cooldown Enforcement', () => {
  let cooldownTopic, cooldownKey

  beforeAll(async () => {
    const token  = uid('s08-cooldown')
    cooldownTopic = 'auth'
    cooldownKey   = token
    await activeEntry({ topic: cooldownTopic, key: cooldownKey, content: `Cooldown test entry ${token}.` })
  })

  test('step 1 — first bump by PA succeeds (200)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/bump/${cooldownTopic}/${cooldownKey}`, {})
    expect(res.status).toBe(200)
    expect(res.data.clock_reset).toBe(true)
  })

  test('step 2 — second bump by same PA within 7 days returns 429 cooldown_active', async () => {
    // PA already bumped in step 1 — cooldown is active.
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/bump/${cooldownTopic}/${cooldownKey}`, {})
    expect(res.status).toBe(429)
    expect(res.data.error).toBe('cooldown_active')
    // next_bump_allowed field tells the caller when they can bump again
    expect(typeof res.data.next_bump_allowed).toBe('string')
  })

  test('step 3 — different user (engineer) can still bump the same entry (per-author cooldown)', async () => {
    // Cooldown is scoped per author — a different user on the same entry is unaffected.
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post(`/api/bump/${cooldownTopic}/${cooldownKey}`, {})
    expect(res.status).toBe(200)
    expect(res.data.bumped_by).toBe('test-engineer')
    expect(res.data.role).toBe('engineer')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-08.5 — Validation Guards
// ─────────────────────────────────────────────────────────────────────────────

describe('S-08.5 — Validation Guards', () => {
  test('step 1 — bumping a non-existent key returns 404 not_found', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/api/bump/auth/totally-nonexistent-key-s08', {})
    expect(res.status).toBe(404)
    expect(res.data.error).toBe('not_found')
  })

  test('step 2 — bumping a key that only has a DRAFT version returns 404 (no ACTIVE)', async () => {
    // getVersionForBump queries status = 'ACTIVE' only. A DRAFT-only key has no ACTIVE → 404.
    const token = uid('s08-draft-bump')
    await draftEntry({ topic: 'auth', key: token, content: `Draft-only entry for bump guard test ${token}.` })

    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/bump/auth/${token}`, {})
    expect(res.status).toBe(404)
    expect(res.data.error).toBe('not_found')
  })

}) // S-08.5 — Validation Guards

// ─────────────────────────────────────────────────────────────────────────────
// S-08.6 — Endorsement History
// ─────────────────────────────────────────────────────────────────────────────

describe('S-08.6 — Endorsement History', () => {
  // GAP-010: GET /api/endorsements/:topic/:key exposes bump_log rows for audit.
  // Without this, a PA cannot verify whether a high-confidence score reflects
  // genuine team consensus or a single user bumping across multiple accounts.
  let historyKey

  beforeAll(async () => {
    historyKey = uid('endorsement-history')
    await activeEntry({ topic: 'auth', key: historyKey, content: `Endorsement history test entry ${historyKey}` })
    // Two different users bump the same entry
    await api(tokens.pe,       PROJECT).post(`/api/bump/auth/${historyKey}`, {})
    await api(tokens.architect, PROJECT).post(`/api/bump/auth/${historyKey}`, {})
  })

  test('step 1 — GET /api/endorsements returns endorsement list after bumps', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/api/endorsements/auth/${historyKey}`)
    expect(res.status).toBe(200)
    expect(res.data.topic).toBe('auth')
    expect(res.data.key).toBe(historyKey)
    expect(Array.isArray(res.data.endorsements)).toBe(true)
    expect(res.data.endorsements.length).toBeGreaterThanOrEqual(2)
  })

  test('step 2 — each endorsement entry has author, role, delta, bumped_at', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/api/endorsements/auth/${historyKey}`)
    expect(res.status).toBe(200)
    for (const e of res.data.endorsements) {
      expect(typeof e.author).toBe('string')
      expect(typeof e.role).toBe('string')
      expect(typeof e.delta).toBe('string')   // NUMERIC → string from pg driver
      expect(typeof e.bumped_at).toBe('string')
    }
  })

  test('step 3 — both authors (test-pe and test-architect) appear in endorsement list', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/api/endorsements/auth/${historyKey}`)
    const authors = res.data.endorsements.map(e => e.author)
    expect(authors).toContain('test-pe')
    expect(authors).toContain('test-architect')
  })

  test('step 4 — non-existent key returns 404', async () => {
    const res = await api(tokens.pe, PROJECT).get('/api/endorsements/auth/totally-nonexistent-key-s08-6')
    expect(res.status).toBe(404)
    expect(res.data.error).toBe('not_found')
  })
}) // S-08.6 — Endorsement History

// ─────────────────────────────────────────────────────────────────────────────
// S-08.7 — Wrong-Order Bump Attempts (NEGATIVE)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-08.7 — Wrong-Order Bump Attempts', () => {
  test.describe.configure({ mode: 'serial' })

  const PEER = 'quorum-test-peer-project'
  let deprecatedKey
  let peerKey

  beforeAll(async () => {
    // Seed an entry in test-project, then deprecate it
    deprecatedKey = uid('s087-deprecated')
    await activeEntry({ topic: 'auth', key: deprecatedKey, content: `S-08.7 entry to deprecate: ${deprecatedKey}.` })
    await api(tokens.pe, PROJECT).post(`/api/knowledge/auth/${deprecatedKey}/deprecate`, {
      reason: 'S-08.7 — deprecating to test bump-of-deprecated guard.',
    })

    // Seed an entry in peer-project (only exists in peer scope)
    peerKey = uid('s087-peer')
    await api(tokens.architect, PEER).post('/api/knowledge', {
      topic:       'auth',
      key:         peerKey,
      content:     `S-08.7 peer-only entry: ${peerKey}.`,
      entity_type: 'Decision',
    })
  })

  test('step 1 — bumping a DEPRECATED entry returns 404 (getVersionForBump queries ACTIVE only)', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/bump/auth/${deprecatedKey}`, {})
    expect(res.status).toBe(404)
    expect(res.data.error).toBe('not_found')
  })

  test('step 2 — GET /api/endorsements for a DEPRECATED key returns 404', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/api/endorsements/auth/${deprecatedKey}`)
    expect(res.status).toBe(404)
    expect(res.data.error).toBe('not_found')
  })

  test('step 3 — bumping a peer-project entry using test-project header returns 404 (cross-project isolation)', async () => {
    // The entry exists in peer-project; the test-project scope must not find it
    const res = await api(tokens.pe, PROJECT).post(`/api/bump/auth/${peerKey}`, {})
    expect(res.status).toBe(404)
    expect(res.data.error).toBe('not_found')
  })

  test('step 4 — test-pe (engineer in peer-project) can bump the peer-project entry using peer-project scope', async () => {
    // Engineers can bump — role-weighted delta applies
    const res = await api(tokens.pe, PEER).post(`/api/bump/auth/${peerKey}`, {})
    expect(res.status).toBe(200)
    expect(res.data.topic).toBe('auth')
    expect(res.data.key).toBe(peerKey)
  })
})

}) // S-08 — Confidence Endorsement
