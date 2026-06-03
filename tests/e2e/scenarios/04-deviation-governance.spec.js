/**
 * S-04 — Deviation Governance (J04)
 *
 * Journey: J04 — Deviation Recording and PE Governance
 * Pillars: Functional Correctness (S-04.1, S-04.6)
 *          Governance Integrity  (S-04.2, S-04.3, S-04.4, S-04.5)
 *          Data Integrity        (computed status — no status column updated directly)
 *          Dashboard Display     (S-04.7, S-04.8 — browser)
 *
 * Sub-scenarios:
 *   S-04.1  Deviation recording — idempotent upsert, severity derivation, OPEN status
 *   S-04.2  Validation guards — not_linked, not_found, missing fields
 *   S-04.3  PE accepts deviation — authority guard, accept happy path, ACCEPTED status
 *   S-04.4  PE denies deviation — reason guard, denial hint for PA-authored standards
 *   S-04.5  PE defers deviation — constitutional deadline validation, DEFERRED status
 *   S-04.6  Batch deviation recording — full success + partial success
 *   S-04.7  Deviations dashboard — filter rail, table display, action panel, accept (browser)
 *   S-04.8  Knowledge denial hint badge — ✕N badge + tooltip on global catalog entries (browser)
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
import { injectSession, DASHBOARD_URL } from '../helpers/browser.js'

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
// S-04.7 — Deviations Dashboard (browser)
//
// Seed: ACTIVE catalog entry in quorum-test-catalog + deviation in
// quorum-test-project with a uid-unique description for row scoping.
// The uid() in the description makes the specific row locatable even when
// multiple deviations exist from prior runs.
// ─────────────────────────────────────────────────────────────────────────────

describe('S-04.7 — Deviations Governance Dashboard', { tag: '@ui' }, () => {
  // Shared seed state (populated in beforeAll, read by all inner describes)
  let s047Description

  test.beforeAll(async () => {
    // Skip seed in local dev — no gateway running.
    if (!process.env.QUORUM_DASHBOARD_URL) return

    const key = uid('s047-dev')
    s047Description = `E2E S-04.7 — TLS enforcement deviation ${key}`

    // 1. Seed ACTIVE catalog entry in the global catalog.
    //    PA writes land as ACTIVE immediately — no approval step needed.
    await activeEntry({
      topic:   'security',
      key,
      content: 'All service-to-service communication must use TLS 1.3 or higher.',
      project: 'quorum-test-catalog',
      globalCatalog: true,
    })

    // 2. Record deviation from the test project against this catalog entry.
    //    deviation() upserts on (project_id, catalog_id, topic, key) — idempotent.
    await deviation({
      catalogId:   'quorum-test-catalog',
      topic:       'security',
      key,
      description: s047Description,
      project:     'quorum-test-project',
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-04.7.1 — Filter Rail
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-04.7.1 — Filter Rail', () => {
    test('step 1 — filter rail renders with status, topic, source, severity controls', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // Status select — first <select> in the filter rail
      // Default has 'OPEN' selected (the initial filter state)
      await expect(page.locator('select').first()).toBeVisible()

      // Topic text input
      await expect(page.getByPlaceholder('Topic…')).toBeVisible()

      // Source select — second <select> in filter rail.
      // Note: <option> elements inside a <select> are not individually visible
      // until the dropdown is opened — assert the <select> itself, not the option text.
      await expect(page.locator('select').nth(1)).toBeVisible()

      // Min severity label + number input
      await expect(page.getByText('Min severity')).toBeVisible()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-04.7.2 — Table Display
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-04.7.2 — Table Display', () => {
    test('step 1 — seeded OPEN deviation appears in table', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // The seeded deviation's description contains a uid-suffixed key — unique across runs.
      // Default filter is status='OPEN' so the OPEN deviation must be visible.
      await expect(page.getByText(s047Description)).toBeVisible()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-04.7.3 — Action Panel
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-04.7.3 — Action Panel', () => {
    test('step 1 — "Action" button expands panel with accept / deny / defer buttons', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // Locate the exact <tr> that contains our seeded deviation's description,
      // then click its "Action" button — scoped to avoid clicking another row's button.
      const deviationRow = page.locator('tr', { has: page.getByText(s047Description) })
      await deviationRow.getByRole('button', { name: /Action/ }).click()

      // The inline action panel expands as a sibling <tr> — all three action type
      // buttons must be visible after the toggle.
      await expect(page.getByRole('button', { name: 'accept' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'deny' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'defer' })).toBeVisible()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-04.7.4 — Reason Validation
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-04.7.4 — Reason Validation', () => {
    test('step 1 — reason < 10 chars blocks submit and shows character count error', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // Open action panel for our deviation
      const deviationRow = page.locator('tr', { has: page.getByText(s047Description) })
      await deviationRow.getByRole('button', { name: /Action/ }).click()

      // Select "accept" action type — reason textarea appears
      await page.getByRole('button', { name: 'accept' }).click()

      // Fill with an intentionally short reason (9 chars, below the 10-char minimum)
      const textarea = page.getByPlaceholder('Reason (required, minimum 10 characters)…')
      await textarea.fill('too short')

      // Error message: "Reason must be at least 10 characters (9/10)."
      await expect(page.getByText(/Reason must be at least 10 characters/)).toBeVisible()

      // Submit button must be disabled — Rule 3 (enforceReasonRequired) mirror in UI
      await expect(page.getByRole('button', { name: 'Submit accept' })).toBeDisabled()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-04.7.5 — Accept Action
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-04.7.5 — Accept Action', () => {
    test('step 1 — valid reason + submit removes deviation from OPEN filter view', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // Open action panel
      const deviationRow = page.locator('tr', { has: page.getByText(s047Description) })
      await deviationRow.getByRole('button', { name: /Action/ }).click()

      // Select "accept" action type
      await page.getByRole('button', { name: 'accept' }).click()

      // Fill a valid reason (≥ 10 chars, trimmed)
      const textarea = page.getByPlaceholder('Reason (required, minimum 10 characters)…')
      await textarea.fill('Accepted — deliberate architectural choice, documented and peer-reviewed.')

      // Submit — fires POST /api/deviations/:id/action { action_type: 'accept' }
      await page.getByRole('button', { name: 'Submit accept' }).click()

      // useDeviationAction.onSuccess calls qc.invalidateQueries(['deviations']).
      // The list refetches; ACCEPTED deviation is excluded from the default OPEN filter.
      // Assert the specific row is no longer in the DOM.
      await expect(page.getByText(s047Description)).not.toBeVisible()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-04.8 — Knowledge Denial Hint Badge (browser)
//
// Seed: ACTIVE catalog entry → deviation → deny action.
// Navigate as the global catalog project (is_global=true) so the gateway
// computes denial_hint_count in the GET /api/knowledge response.
// ─────────────────────────────────────────────────────────────────────────────

describe('S-04.8 — Knowledge Denial Hint Badge', { tag: '@ui' }, () => {
  let s048Key

  test.beforeAll(async () => {
    // Skip seed in local dev — no gateway running.
    if (!process.env.QUORUM_DASHBOARD_URL) return

    s048Key = uid('s048-dh')
    const s048Topic = 'security'

    // 1. Seed ACTIVE catalog entry in the global catalog.
    await activeEntry({
      topic:   s048Topic,
      key:     s048Key,
      content: 'Authentication tokens must be rotated every 24 hours in production.',
      project: 'quorum-test-catalog',
      globalCatalog: true,
    })

    // 2. Record a deviation from the test project against this standard.
    const { deviationId } = await deviation({
      catalogId:   'quorum-test-catalog',
      topic:       s048Topic,
      key:         s048Key,
      description: `E2E S-04.8 — token rotation deviation ${s048Key}`,
      project:     'quorum-test-project',
    })

    // 3. Deny the deviation — this increments denial_hint_count on the catalog entry.
    //    enforceDeviationActionAuthority: architect+ required — tokens.pe = PA.
    const client = api(tokens.pe, 'quorum-test-project')
    await client.post(`/api/deviations/${deviationId}/action`, {
      action_type: 'deny',
      reason:      'Token rotation at 24h is not feasible given our offline-first architecture.',
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-04.8.1 — Denial Badge Visible
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-04.8.1 — Denial Badge', () => {
    test('step 1 — ✕1 badge renders on global catalog entry after a denial', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')

      // Log in as the global catalog project — GET /api/knowledge returns
      // denial_hint_count only when the project has is_global === true.
      await injectSession(page, { project: 'quorum-test-catalog' })
      await page.goto(`${DASHBOARD_URL}/knowledge`)

      // Find the Key column <td> that contains our specific key text.
      // The key renders as <span class="text-blue-400">{key}</span> inside the <td>.
      // The denial badge <span>✕{count}</span> is a sibling in the same <td>.
      const keyCell = page.locator('td').filter({ has: page.getByText(s048Key, { exact: true }) })

      // Badge text: ✕1 (U+2715 MULTIPLICATION X followed by the count)
      await expect(keyCell.getByText('✕1')).toBeVisible()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-04.8.2 — Badge Tooltip
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-04.8.2 — Badge Tooltip', () => {
    test('step 1 — badge title attribute says "1 project has denied this standard"', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page, { project: 'quorum-test-catalog' })
      await page.goto(`${DASHBOARD_URL}/knowledge`)

      // The badge element carries a title attribute used as the tooltip:
      //   "1 project has denied this standard" (singular form when count === 1)
      // Scoped to the key cell to avoid false matches from other catalog entries.
      const keyCell = page.locator('td').filter({ has: page.getByText(s048Key, { exact: true }) })
      const badge   = keyCell.locator('[title*="denied this standard"]')

      await expect(badge).toBeVisible()
      await expect(badge).toHaveAttribute('title', '1 project has denied this standard')
    })
  })

}) // S-04.8 — Knowledge Denial Hint Badge

// ─────────────────────────────────────────────────────────────────────────────
// S-04.9 — Overdue Deferrals on Pending Page (browser)
//
// Seeds: ACTIVE catalog entry → deviation → past-dated defer action via
// POST /pg/deviation-actions (admin-only bypass — enforceValidDeferDeadline
// blocks past dates through the normal API path).
// Navigates to /pending and asserts the orange overdue-deferrals-section renders.
// ─────────────────────────────────────────────────────────────────────────────

describe('S-04.9 — Overdue Deferrals Browser', { tag: '@ui' }, () => {
  let s049Key
  let s049Description

  test.beforeAll(async () => {
    if (!process.env.QUORUM_DASHBOARD_URL) return

    s049Key         = uid('s049-ov')
    s049Description = `E2E S-04.9 overdue deviation ${s049Key}`
    const topic     = 'security'

    await activeEntry({
      topic,
      key:     s049Key,
      content: 'TLS 1.3 required on all internal service endpoints.',
      project: CATALOG,
      globalCatalog: true,
    })

    const { deviationId } = await deviation({
      catalogId:   CATALOG,
      topic,
      key:         s049Key,
      description: s049Description,
      project:     PROJECT,
    })

    // Seed a past-dated defer action — bypasses enforceValidDeferDeadline
    // so the computed status resolves to OVERDUE (DEFERRED + defer_until < NOW()).
    // E2E: POST /pg/deviation-actions is admin-only and exists solely for this seeding path.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    // actor/actor_role are derived from the admin JWT server-side — not accepted from body
    await api(tokens.admin, PROJECT).post('/pg/deviation-actions', {
      deviation_id: deviationId,
      defer_until:  yesterday,
      reason:       'Deferred past deadline for S-04.9 E2E overdue test',
    })
  })

  test('step 1 — /pending shows overdue-deferrals-section when OVERDUE deviations exist', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require QUORUM_DASHBOARD_URL')
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/pending`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByTestId('overdue-deferrals-section')).toBeVisible({ timeout: 8000 })
  })

  test('step 2 — overdue section contains the seeded deviation description', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require QUORUM_DASHBOARD_URL')
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/pending`)
    await page.waitForLoadState('networkidle')

    const section = page.getByTestId('overdue-deferrals-section')
    await expect(section).toBeVisible({ timeout: 8000 })
    await expect(section.getByText(s049Description)).toBeVisible({ timeout: 5000 })
  })
}) // S-04.9 — Overdue Deferrals Browser

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
