/**
 * S-04 — Deviation Governance (J04)
 *
 * Journey: J04 — Deviation Recording and PE Governance
 * Pillars: Functional Correctness (S-04.1, S-04.6)
 *          Governance Integrity  (S-04.2, S-04.3, S-04.4, S-04.5)
 *          Data Integrity        (computed status — no status column updated directly)
 *          Dashboard Display     (S-04.7, S-04.8, S-04.9 — browser; MOVED to quorum-dash)
 *
 * Sub-scenarios:
 *   S-04.1  Deviation recording — idempotent upsert, severity derivation, OPEN status
 *   S-04.2  Validation guards — not_linked, not_found, missing fields
 *   S-04.3  PE accepts deviation — authority guard, accept happy path, ACCEPTED status
 *   S-04.4  PE denies deviation — reason guard, denial hint for PA-authored standards
 *   S-04.5  PE defers deviation — constitutional deadline validation, DEFERRED status
 *   S-04.6  Batch deviation recording — full success + partial success
 *   S-04.7  Deviations dashboard (browser) — MOVED to quorum-dash (04-deviation-governance-ui)
 *   S-04.8  Knowledge denial hint badge (browser) — MOVED to quorum-dash
 *
 * Architecture notes:
 *   - POST /api/deviations — catalog link validation, server-side severity, upsert on
 *     (q_project_id, catalog_id, topic, key). Always HTTP 200; status discriminator in body.
 *     Response: { status: 'recorded'|'not_linked'|'not_found', deviation_id?, severity?,
 *                 is_new?, message }
 *   - GET /api/deviations — list for requesting project; status computed via LATERAL join
 *     on deviation_actions (never stored directly). Response: { deviations: [...], total }
 *   - POST /api/deviations/:id/action — architect+ only (enforceDeviationActionAuthority);
 *     Rule 3 (reason ≥10 chars); VALID_DEFER_DAYS for defer.
 *     Response: { action_id, action_type, hint? }
 *   - Severity = confidence × authority_score(author_role); PA_AUTHORED_FLOOR = 0.70
 *     (test-pe has base_confidence=0.90 → PA entries have severity = 0.90 × 1.00 = 0.90)
 *   - Denial hint triggered when global entry confidence > 0.85 AND
 *     author_role = 'principal_architect'
 *   - quorum-test-catalog: test-pe (PA, base_confidence=0.90), test-architect (0.80)
 *   - quorum-test-project: globals: ['quorum-test-catalog'] — all test users present
 *
 * All keys are uid()-suffixed for run-to-run isolation without teardown.
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }      from '../helpers/api.js'
import { tokens }   from '../helpers/jwt.js'
import { uid, activeEntry, deviation } from '../helpers/seed.js'

const CATALOG  = 'quorum-test-catalog'
const PROJECT  = 'quorum-test-project'

describe('S-04 — Deviation Governance', () => {

// ─────────────────────────────────────────────────────────────────────────────
// S-04.1 — Deviation Recording
// ─────────────────────────────────────────────────────────────────────────────

describe('S-04.1 — Deviation Recording', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'security'
  let stdKey
  let deviationId
  const STD_CONTENT = 'All HTTP clients must use TLS 1.2 or higher. Plain HTTP is prohibited.'

  beforeAll(async () => {
    stdKey = uid('tls-standard')
    await activeEntry({ topic, key: stdKey, content: STD_CONTENT, project: CATALOG, globalCatalog: true })
  })

  test('step 1 — record deviation from project against catalog entry → recorded, is_new=true, severity set', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/api/deviations', {
      catalog_id:  CATALOG,
      topic,
      key:         stdKey,
      description: 'API client uses http:// scheme for internal service calls.',
      source:      'code-review',
    })
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('recorded')
    expect(res.data.is_new).toBe(true)
    expect(res.data.deviation_id).toBeDefined()
    // Severity = PA base_confidence (0.90) × PA authority score (1.00) = 0.90
    // PA floor is 0.70 — 0.90 ≥ floor, so no clamping
    expect(res.data.severity).toBeGreaterThan(0)
    expect(res.data.severity).toBeLessThanOrEqual(1)
    deviationId = res.data.deviation_id
  })

  test('step 2 — repeat call with same topic:key → is_new=false, same deviation_id (idempotent upsert)', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/api/deviations', {
      catalog_id:  CATALOG,
      topic,
      key:         stdKey,
      description: 'Same pattern detected again — last_seen_at should refresh.',
      source:      'code-review',
    })
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('recorded')
    expect(res.data.is_new).toBe(false)
    // Same record as step 1 — upsert updates last_seen_at, does not create new row
    expect(res.data.deviation_id).toBe(deviationId)
  })

  test('step 3 — GET /api/deviations shows the deviation with status=OPEN', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.get(`/api/deviations?catalog_id=${CATALOG}`)
    expect(res.status).toBe(200)
    expect(res.data.total).toBeGreaterThanOrEqual(1)
    const dev = (res.data.deviations ?? []).find(d => d.deviation_id === deviationId)
    expect(dev).toBeDefined()
    expect(dev.status).toBe('OPEN')
    expect(dev.topic).toBe(topic)
    expect(dev.key).toBe(stdKey)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-04.2 — Validation Guards
// ─────────────────────────────────────────────────────────────────────────────

describe('S-04.2 — Validation Guards', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'auth'
  let realKey
  const STD_CONTENT = 'Service-to-service calls must use mTLS with certificates from the internal CA.'

  beforeAll(async () => {
    // A real catalog entry — used for the "no ACTIVE version" variant indirectly
    realKey = uid('mtls-standard')
    await activeEntry({ topic, key: realKey, content: STD_CONTENT, project: CATALOG, globalCatalog: true })
  })

  test('step 1 — catalog not in project globals → HTTP 200, status=not_linked', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/api/deviations', {
      catalog_id:  'a-catalog-not-in-globals',  // not in quorum-test-project.globals
      topic,
      key:         realKey,
      description: 'Testing not_linked path.',
    })
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('not_linked')
    expect(res.data.catalog_id).toBe('a-catalog-not-in-globals')
    expect(res.data.message).toMatch(/globals/)
  })

  test('step 2 — topic:key does not exist in catalog → HTTP 200, status=not_found', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/api/deviations', {
      catalog_id:  CATALOG,
      topic,
      key:         uid('no-such-standard'),  // never seeded — will not be in catalog
      description: 'Testing not_found path.',
    })
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('not_found')
    expect(res.data.message).toBeDefined()
  })

  test('step 3 — missing required fields → 400', async () => {
    const client = api(tokens.engineer, PROJECT)
    // catalog_id present, but topic + key + description missing
    const res = await client.post('/api/deviations', {
      catalog_id: CATALOG,
    })
    expect(res.status).toBe(400)
    expect(res.data.error).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-04.3 — PE Accepts Deviation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-04.3 — Accept Deviation', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'reliability'
  let stdKey
  let deviationId
  const STD_CONTENT = 'All external HTTP calls must use a circuit breaker with a 30s timeout.'

  beforeAll(async () => {
    stdKey = uid('circuit-breaker-standard')
    await activeEntry({ topic, key: stdKey, content: STD_CONTENT, project: CATALOG, globalCatalog: true })
    // Record the deviation as engineer
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/api/deviations', {
      catalog_id:  CATALOG,
      topic,
      key:         stdKey,
      description: 'LegacyHttpClient has no circuit breaker — calls block indefinitely on downstream failure.',
      source:      'code-review',
    })
    deviationId = res.data.deviation_id
  })

  test('step 1 — engineer cannot action deviation (authority guard — 403 or constitutional error)', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post(`/api/deviations/${deviationId}/action`, {
      action_type: 'accept',
      reason:      'Accepted by engineer — should be blocked.',
    })
    // enforceDeviationActionAuthority throws for non-architect roles
    expect(res.status).not.toBe(200)
  })

  test('step 2 — PE accepts deviation with valid reason → action_id returned', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/deviations/${deviationId}/action`, {
      action_type: 'accept',
      reason:      'Legacy service being decommissioned next sprint — accepted as known debt.',
    })
    expect(res.status).toBe(200)
    expect(res.data.action_id).toBeDefined()
    expect(res.data.action_type).toBe('accept')
  })

  test('step 3 — GET /api/deviations shows deviation status=ACCEPTED', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/api/deviations?catalog_id=${CATALOG}`)
    expect(res.status).toBe(200)
    const dev = (res.data.deviations ?? []).find(d => d.deviation_id === deviationId)
    expect(dev).toBeDefined()
    expect(dev.status).toBe('ACCEPTED')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-04.4 — PE Denies Deviation (denial hint for PA-authored standard)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-04.4 — Deny Deviation', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'security'
  let stdKey
  let deviationId
  // PA-authored entry: test-pe has base_confidence=0.90 → 0.90 > 0.85 → denial hint expected
  const STD_CONTENT = 'All database queries must use parameterised statements — no string concatenation.'

  beforeAll(async () => {
    stdKey = uid('parameterised-queries')
    await activeEntry({ topic, key: stdKey, content: STD_CONTENT, project: CATALOG, globalCatalog: true })
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/api/deviations', {
      catalog_id:  CATALOG,
      topic,
      key:         stdKey,
      description: 'ReportBuilder uses string interpolation in SQL queries.',
      source:      'security-review',
    })
    deviationId = res.data.deviation_id
  })

  test('step 1 — reason shorter than 10 chars → non-200 (REASON_REQUIRED constitutional violation)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/deviations/${deviationId}/action`, {
      action_type: 'deny',
      reason:      'nope',  // 4 chars — below 10-char floor
    })
    expect(res.status).not.toBe(200)
  })

  test('step 2 — PE denies PA-authored high-confidence standard → denial hint in response', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/deviations/${deviationId}/action`, {
      action_type: 'deny',
      reason:      'ReportBuilder uses a legacy ORM that pre-dates this standard — migration scheduled.',
    })
    expect(res.status).toBe(200)
    expect(res.data.action_id).toBeDefined()
    expect(res.data.action_type).toBe('deny')
    // Catalog entry was authored by principal_architect with confidence=0.90 > 0.85
    // → denial hint must be present
    expect(res.data.hint).toBeDefined()
    expect(res.data.hint).toMatch(/principal_architect/)
  })

  test('step 3 — GET /api/deviations shows deviation status=DENIED', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/api/deviations?catalog_id=${CATALOG}`)
    expect(res.status).toBe(200)
    const dev = (res.data.deviations ?? []).find(d => d.deviation_id === deviationId)
    expect(dev).toBeDefined()
    expect(dev.status).toBe('DENIED')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-04.5 — PE Defers Deviation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-04.5 — Defer Deviation', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'reliability'
  let stdKey
  let deviationId
  const STD_CONTENT = 'Services must emit structured JSON logs at INFO level or above.'

  beforeAll(async () => {
    stdKey = uid('structured-logging')
    await activeEntry({ topic, key: stdKey, content: STD_CONTENT, project: CATALOG, globalCatalog: true })
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/api/deviations', {
      catalog_id:  CATALOG,
      topic,
      key:         stdKey,
      description: 'BatchProcessor emits unstructured text logs.',
      source:      'code-review',
    })
    deviationId = res.data.deviation_id
  })

  test('step 1 — invalid defer days (31) → non-200 (DEFER_DEADLINE constitutional violation)', async () => {
    const client = api(tokens.pe, PROJECT)
    const invalidDeadline = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString()
    const res = await client.post(`/api/deviations/${deviationId}/action`, {
      action_type: 'defer',
      reason:      'Deferred pending logging framework migration.',
      defer_until: invalidDeadline,
    })
    // enforceValidDeferDeadline requires exactly 30/45/60/90 days
    expect(res.status).not.toBe(200)
  })

  test('step 2 — defer without defer_until → 400', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/deviations/${deviationId}/action`, {
      action_type: 'defer',
      reason:      'Deferred pending logging framework migration.',
      // defer_until intentionally omitted
    })
    expect(res.status).toBe(400)
    expect(res.data.error).toMatch(/defer_until/)
  })

  test('step 3 — PE defers 30 days with valid reason → action_id returned', async () => {
    const client = api(tokens.pe, PROJECT)
    const deferUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    const res = await client.post(`/api/deviations/${deviationId}/action`, {
      action_type: 'defer',
      reason:      'Deferred pending logging framework migration — scheduled for Q3.',
      defer_until: deferUntil,
    })
    expect(res.status).toBe(200)
    expect(res.data.action_id).toBeDefined()
  })

  test('step 4 — GET /api/deviations shows deviation status=DEFERRED', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/api/deviations?catalog_id=${CATALOG}`)
    expect(res.status).toBe(200)
    const dev = (res.data.deviations ?? []).find(d => d.deviation_id === deviationId)
    expect(dev).toBeDefined()
    expect(dev.status).toBe('DEFERRED')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-04.6 — Batch Deviation Recording
// ─────────────────────────────────────────────────────────────────────────────

describe('S-04.6 — Batch Recording', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'auth'
  let keyA
  let keyB
  const CONTENT_A = 'JWT tokens must use RS256 or ES256 — HS256 is prohibited.'
  const CONTENT_B = 'Refresh tokens must be single-use and rotated on every use.'

  beforeAll(async () => {
    keyA = uid('jwt-algorithm-standard')
    keyB = uid('refresh-token-rotation')
    await Promise.all([
      activeEntry({ topic, key: keyA, content: CONTENT_A, project: CATALOG, globalCatalog: true }),
      activeEntry({ topic, key: keyB, content: CONTENT_B, project: CATALOG, globalCatalog: true }),
    ])
  })

  test('step 1 — batch two valid deviations → recorded=2, failed=0', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/api/deviations/batch', {
      deviations: [
        {
          catalog_id:  CATALOG,
          topic,
          key:         keyA,
          description: 'UserService signs JWTs with HS256 using a weak shared secret.',
          source:      'security-review',
        },
        {
          catalog_id:  CATALOG,
          topic,
          key:         keyB,
          description: 'RefreshTokenStore issues persistent tokens — no rotation on use.',
          source:      'security-review',
        },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.data.recorded).toBe(2)
    expect(res.data.failed).toBe(0)
    expect(Array.isArray(res.data.results)).toBe(true)
    expect(res.data.results).toHaveLength(2)
    expect(res.data.results.every(r => r.status === 'recorded')).toBe(true)
  })

  test('step 2 — partial success: one not_linked catalog → recorded=1, one result=not_linked', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/api/deviations/batch', {
      deviations: [
        {
          catalog_id:  CATALOG,
          topic,
          key:         keyA,
          description: 'Re-scanning same deviation — should update last_seen_at.',
        },
        {
          catalog_id:  'unlinked-catalog',  // not in quorum-test-project.globals
          topic,
          key:         keyB,
          description: 'Testing not_linked in batch.',
        },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.data.recorded).toBe(1)
    const notLinked = res.data.results.find(r => r.status === 'not_linked')
    expect(notLinked).toBeDefined()
    expect(notLinked.catalog_id).toBe('unlinked-catalog')
  })

  test('step 3 — empty deviations array → 400', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/api/deviations/batch', {
      deviations: [],
    })
    expect(res.status).toBe(400)
    expect(res.data.error).toBeDefined()
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// S-04.10 — Re-Actioning an Accepted Deviation + Cross-Project Guard (NEGATIVE)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-04.10 — Re-Actioning Accepted Deviation', () => {
  test.describe.configure({ mode: 'serial' })

  const PEER = 'quorum-test-peer-project'
  let s0410DeviationId
  let s0410CatalogKey

  beforeAll(async () => {
    s0410CatalogKey = uid('s0410-standard')
    // Seed a ACTIVE catalog entry and a deviation against it
    await activeEntry({ topic: 'auth', key: s0410CatalogKey, content: 'All inter-service calls must use mTLS.', project: CATALOG, globalCatalog: true })
    ;({ deviationId: s0410DeviationId } = await deviation({
      catalogId:   CATALOG,
      topic:       'auth',
      key:         s0410CatalogKey,
      description: `S-04.10 test deviation — service does not implement mTLS for legacy partner API: ${s0410CatalogKey}.`,
    }))

    // PA accepts the deviation
    await api(tokens.pe, PROJECT).post(`/api/deviations/${s0410DeviationId}/action`, {
      action: 'accept',
      reason: 'Legacy partner integration — mTLS rollout blocked by partner SLA. Accepted until Q3 migration.',
    })
  })

  test('step 1 — deviation is ACCEPTED after initial action', async () => {
    const res = await api(tokens.pe, PROJECT).get('/api/deviations')
    expect(res.status).toBe(200)
    const dev = res.data.find(d => d.deviation_id === s0410DeviationId)
    expect(dev).toBeDefined()
    expect(dev.status).toBe('ACCEPTED')
  })

  test('step 2 — re-actioning an already-ACCEPTED deviation returns non-200 (not OPEN)', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/deviations/${s0410DeviationId}/action`, {
      action: 'accept',
      reason: 'Attempting to re-accept an already accepted deviation — should be rejected.',
    })
    expect(res.status).not.toBe(200)
    expect(res.status).not.toBe(201)
  })

  test('step 3 — deviation status remains ACCEPTED after failed re-action', async () => {
    const res = await api(tokens.pe, PROJECT).get('/api/deviations')
    const dev = res.data.find(d => d.deviation_id === s0410DeviationId)
    expect(dev?.status).toBe('ACCEPTED')
  })

  test('step 4 — test-pe (engineer role in peer-project) cannot action a deviation in peer-project → 400 DEVIATION_ACTION_AUTHORITY', async () => {
    // Seed a deviation in peer-project scope (test-pe is engineer there; engineer role cannot action deviations)
    const peerKey = uid('s0410-peer-dev')
    await activeEntry({ topic: 'auth', key: peerKey, content: 'Peer project: only ES256 JWT accepted.', project: CATALOG, globalCatalog: true })
    const { deviationId: peerDevId } = await deviation({
      catalogId:   CATALOG,
      topic:       'auth',
      key:         peerKey,
      description: `S-04.10 peer deviation: ${peerKey}`,
      project:     PEER,
    })

    const res = await api(tokens.pe, PEER).post(`/api/deviations/${peerDevId}/action`, {
      action: 'accept',
      reason: 'Engineer attempting deviation action in peer-project — authority guard should block this.',
    })
    expect(res.status).toBe(400)
    expect(res.data.rule).toBe('DEVIATION_ACTION_AUTHORITY')
  })
})

}) // S-04 — Deviation Governance
