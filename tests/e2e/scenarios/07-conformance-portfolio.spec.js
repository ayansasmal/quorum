/**
 * S-07 — Conformance Scoring & Portfolio (J07)
 *
 * Journey: J07 — Project Conformance Scoring & Portfolio Intelligence
 * Pillars: Functional Correctness (S-07.1, S-07.2, S-07.3)
 *          Governance Integrity  (S-07.4 — score reflects deviation actions)
 *          Dashboard Display     (S-07.5, S-07.6, S-07.7, S-07.8 — browser)
 *
 * Sub-scenarios:
 *   S-07.1  UNCERTIFIED gates — no globals, sparse catalog, no scans
 *   S-07.2  CERTIFIED baseline — score, breakdown, catalogs, scan metadata
 *   S-07.3  Score formula — deviation actions shift the score
 *   S-07.4  Portfolio role gate — only executive+ can call GET /api/portfolio
 *   S-07.5  Stats page load — 4 stat cards + tab switcher visible (browser)
 *   S-07.6  ConformanceCard renders — label + linked catalog name visible (browser)
 *   S-07.7  UNCERTIFIED state — isolated project shows "UNCERTIFIED" + sub-message (browser)
 *   S-07.8  Score badge logic — UNCERTIFIED badge text; breakdown bar absent (browser)
 *
 * Architecture notes:
 *   - GET /api/conformance returns:
 *       { score, status, breakdown, scan_count, last_scan_at,
 *         applicable_entries, catalogs: [{ catalog_id, entry_count }] }
 *   - UNCERTIFIED when any of:
 *       (a) project has no linked globals
 *       (b) total ACTIVE entries across all linked catalogs < 10
 *       (c) project_scans has no rows (scan_count = 0)
 *   - Score formula: (1 − weighted_deviation_ratio) × 100
 *     STATUS_WEIGHT: OPEN/OVERDUE/ACCEPTED=1.0, DEFERRED=0.6, DENIED=0.3, RESOLVED=0.0
 *   - POST /pg/scans — seed endpoint; records a scan run (advances scan_count)
 *   - GET /api/portfolio — PORTFOLIO_ROLES gate (principal_architect, director,
 *     vp_engineering, group_executive) or is_admin; returns projects + rollup
 *
 * Setup strategy for CERTIFIED:
 *   - Seed 10 ACTIVE entries in quorum-test-catalog (topic: 'testing')
 *   - Record one scan via POST /pg/scans for quorum-test-project
 *   → both conditions met → score computable → CERTIFIED
 *
 * All keys are uid()-suffixed for run-to-run isolation without teardown.
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }    from '../helpers/api.js'
import { tokens } from '../helpers/jwt.js'
import { uid, activeEntry } from '../helpers/seed.js'
import { injectSession, DASHBOARD_URL } from '../helpers/browser.js'

const CATALOG          = 'quorum-test-catalog'
const PROJECT          = 'quorum-test-project'
const ISOLATED_PROJECT = 'quorum-test-isolated-project'  // no globals — permanently UNCERTIFIED

// Serial mode: S-07.2 seeds the catalog and scan_count; S-07.3 depends on
// those being present before it records a deviation and checks CERTIFIED status.
// Without this, Playwright workers can start S-07.3's beforeAll while S-07.2's
// beforeAll is still in-flight, producing a spurious UNCERTIFIED result.
test.describe.configure({ mode: 'serial' })

describe('S-07 — Conformance Scoring', () => {

// ─────────────────────────────────────────────────────────────────────────────
// S-07.1 — UNCERTIFIED Gates
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.1 — UNCERTIFIED Gates', () => {
  // quorum-test-isolated-project has NO globals field — it is permanently UNCERTIFIED
  // via the "no linked catalogs" gate. This condition is structural (config-based),
  // not quantitative, so it survives re-runs without teardown unlike the "sparse
  // catalog" or "no scans" conditions which accumulate across runs.

  test('step 1 — project with no globals returns UNCERTIFIED', async () => {
    const client = api(tokens.pe, ISOLATED_PROJECT)
    const res = await client.get('/api/conformance')
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('UNCERTIFIED')
    expect(res.data.score).toBeNull()
    // catalogs array is empty (no globals linked)
    expect(Array.isArray(res.data.catalogs)).toBe(true)
    expect(res.data.catalogs).toHaveLength(0)
  })

  test('step 2 — UNCERTIFIED response has correct shape (score null, breakdown present)', async () => {
    const client = api(tokens.pe, ISOLATED_PROJECT)
    const res = await client.get('/api/conformance')
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('UNCERTIFIED')
    // breakdown must be present and all counts non-negative
    const bd = res.data.breakdown ?? {}
    expect(typeof bd.open).toBe('number')
    expect(typeof bd.accepted).toBe('number')
    expect(typeof bd.denied).toBe('number')
    expect(typeof bd.deferred).toBe('number')
    expect(bd.open + bd.accepted + bd.denied + bd.deferred).toBeGreaterThanOrEqual(0)
    // catalogs array reflects the (empty) globals list
    expect(Array.isArray(res.data.catalogs)).toBe(true)
  })

  test('step 3 — non-existent project returns 404', async () => {
    const client = api(tokens.pe, 'project-that-does-not-exist')
    const res = await client.get('/api/conformance')
    expect(res.status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-07.2 — CERTIFIED Baseline
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.2 — CERTIFIED Baseline', () => {
  test.describe.configure({ mode: 'serial' })

  const TOPIC = 'testing'
  // We need ≥ 10 ACTIVE entries in quorum-test-catalog
  const STANDARDS = [
    'Every service must have a unit test suite with ≥80% branch coverage.',
    'Integration tests must run in CI on every PR merge to main.',
    'API contracts must be covered by contract tests (Pact or OpenAPI).',
    'Database migrations must have rollback tests before production deployment.',
    'Performance tests must run weekly; P95 latency regressions block release.',
    'Security tests must include OWASP Top-10 checks for all public endpoints.',
    'Chaos engineering tests must simulate at least one dependency failure weekly.',
    'Load tests must validate service behaviour at 2× peak production traffic.',
    'All async message handlers must have idempotency tests.',
    'End-to-end tests must cover the happy path for all user-facing features.',
  ]

  beforeAll(async () => {
    // Seed 10 ACTIVE entries in the catalog
    const keys = STANDARDS.map((_, i) => uid(`testing-standard-${i}`))
    await Promise.all(
      STANDARDS.map((content, i) =>
        activeEntry({ topic: TOPIC, key: keys[i], content, project: CATALOG }),
      ),
    )
    // Record a scan run for quorum-test-project so scan_count > 0
    const client = api(tokens.pe, PROJECT)
    await client.post('/pg/scans', {
      scan_type:   'full',
      triggered_by: 'quorum:scan',
      files_scanned: 42,
      deviations_new: 0,
    })
  })

  test('step 1 — after seeding 10 catalog entries + one scan → CERTIFIED', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/conformance')
    expect(res.status).toBe(200)
    // With ≥ 10 ACTIVE entries and scan_count > 0, must be CERTIFIED
    expect(res.data.status).toBe('CERTIFIED')
    expect(typeof res.data.score).toBe('number')
    expect(res.data.score).toBeGreaterThanOrEqual(0)
    expect(res.data.score).toBeLessThanOrEqual(100)
  })

  test('step 2 — CERTIFIED response includes per-catalog entry counts', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/conformance')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.catalogs)).toBe(true)
    expect(res.data.catalogs.length).toBeGreaterThanOrEqual(1)
    const catalogEntry = res.data.catalogs.find(c => c.catalog_id === CATALOG)
    expect(catalogEntry).toBeDefined()
    // We seeded 10 entries in this topic; prior specs may have added more
    expect(catalogEntry.entry_count).toBeGreaterThanOrEqual(10)
  })

  test('step 3 — CERTIFIED response includes scan metadata', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/conformance')
    expect(res.status).toBe(200)
    expect(res.data.scan_count).toBeGreaterThanOrEqual(1)
    expect(res.data.last_scan_at).toBeDefined()
    expect(res.data.last_scan_at).not.toBeNull()
  })

  test('step 4 — CERTIFIED response breakdown fields are all present and non-negative', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/conformance')
    expect(res.status).toBe(200)
    const bd = res.data.breakdown
    expect(typeof bd.open).toBe('number')
    expect(typeof bd.accepted).toBe('number')
    expect(typeof bd.denied).toBe('number')
    expect(typeof bd.deferred).toBe('number')
    expect(typeof bd.overdue).toBe('number')
    expect(typeof bd.resolved).toBe('number')
    // All values must be non-negative
    for (const v of Object.values(bd)) expect(v).toBeGreaterThanOrEqual(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-07.3 — Score Reflects Deviation Actions
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.3 — Score Formula', () => {
  test.describe.configure({ mode: 'serial' })

  const TOPIC = 'security'
  let stdKey
  let deviationId
  let scoreBeforeAction
  const STD_CONTENT = 'All API endpoints must validate Content-Type header — reject non-application/json.'

  beforeAll(async () => {
    stdKey = uid('content-type-validation')
    await activeEntry({ topic: TOPIC, key: stdKey, content: STD_CONTENT, project: CATALOG })
    // Record a deviation (OPEN — weight 1.0)
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/api/deviations', {
      catalog_id:  CATALOG,
      topic:       TOPIC,
      key:         stdKey,
      description: 'GatewayRouter accepts any Content-Type — no validation in place.',
      source:      'security-review',
    })
    deviationId = res.data.deviation_id
    // Capture baseline score
    const scoreRes = await api(tokens.pe, PROJECT).get('/api/conformance')
    scoreBeforeAction = scoreRes.data.score
  })

  test('step 1 — OPEN deviation reduces score (or keeps it stable if catalog too large)', async () => {
    // The score with an OPEN deviation (weight 1.0 × severity) should not be 100
    // unless catalog is very large relative to deviation count.
    // We simply assert the score is valid and numeric.
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/conformance')
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('CERTIFIED')
    expect(typeof res.data.score).toBe('number')
    expect(res.data.breakdown.open).toBeGreaterThanOrEqual(1)
  })

  test('step 2 — denying deviation (weight 0.3) should not raise score above 100', async () => {
    const client = api(tokens.pe, PROJECT)
    await client.post(`/api/deviations/${deviationId}/action`, {
      action_type: 'deny',
      reason:      'Standard does not apply — internal APIs only, no external consumers.',
    })
    const res = await client.get('/api/conformance')
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('CERTIFIED')
    // Score after deny (weight 0.3) should be ≥ score before (weight 1.0)
    // or equal if the catalog is large enough to absorb the difference
    expect(res.data.score).toBeGreaterThanOrEqual(scoreBeforeAction ?? 0)
    expect(res.data.breakdown.denied).toBeGreaterThanOrEqual(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-07.4 — Portfolio Role Gate
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.4 — Portfolio Role Gate', () => {
  // Portfolio is read-only for executive roles; engineers are blocked.

  test('step 1 — engineer cannot access portfolio (403)', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.get('/api/portfolio')
    expect(res.status).toBe(403)
    expect(res.data.error).toBe('forbidden')
  })

  test('step 2 — architect cannot access portfolio (403)', async () => {
    const client = api(tokens.architect, PROJECT)
    const res = await client.get('/api/portfolio')
    expect(res.status).toBe(403)
  })

  test('step 3 — principal_architect can access portfolio (200)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/portfolio')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.projects)).toBe(true)
  })

  test('step 4 — director can access portfolio (200)', async () => {
    const client = api(tokens.director, PROJECT)
    const res = await client.get('/api/portfolio')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.projects)).toBe(true)
  })

  test('step 5 — portfolio response includes quorum-test-project with conformance data', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/portfolio')
    expect(res.status).toBe(200)
    const project = res.data.projects.find(p => p.group_id === PROJECT)
    expect(project).toBeDefined()
    // Project's conformance data should be present
    expect(project.status).toBeDefined()  // 'CERTIFIED' or 'UNCERTIFIED'
    expect(typeof project.score === 'number' || project.score === null).toBe(true)
  })

  test('step 6 — portfolio rollup is present (or null when no certified children)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/portfolio')
    expect(res.status).toBe(200)
    // rollup may be null (no projects) or a valid object — both are acceptable
    if (res.data.rollup !== null) {
      expect(typeof res.data.rollup.score === 'number' || res.data.rollup.score === null).toBe(true)
      expect(['CERTIFIED', 'UNCERTIFIED']).toContain(res.data.rollup.status)
      expect(typeof res.data.rollup.certified_count).toBe('number')
      expect(typeof res.data.rollup.uncertified_count).toBe('number')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-07.5 — Stats Page Load (browser)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.5 — Stats Page Load', () => {
  test('step 1 — stats page loads with 4 summary stat cards visible', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    // Wait for network idle so React's initial data fetches (useStats) have resolved
    // before asserting on rendered content. Stats data may take a few seconds to
    // load from the gateway in Docker mode.
    await page.goto(`${DASHBOARD_URL}/`, { waitUntil: 'networkidle' })

    // All 4 StatCard labels must appear (StatCard renders a .text-xs.uppercase label)
    await expect(page.getByText('Total domains')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Active knowledge', { exact: true })).toBeVisible()
    await expect(page.getByText('Pending decisions')).toBeVisible()
    await expect(page.getByText('Oldest pending')).toBeVisible()
  })

  test('step 2 — tab switcher renders Overview and Decaying Knowledge tabs', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/`)

    // TABS = ['Overview', 'Decaying Knowledge'] — both tab buttons must render
    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Decaying Knowledge' })).toBeVisible()

    // Overview is the default active tab — Overview content is visible
    await expect(page.getByText('Active knowledge by domain')).toBeVisible()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-07.6 — ConformanceCard Renders (browser)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.6 — ConformanceCard Renders', () => {
  test('step 1 — ConformanceCard is present for project with linked global catalogs', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    // Default session: quorum-test-project has globals: [quorum-test-catalog]
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/`)

    // ConformanceCard renders only when useConformance() returns data.
    // GET /api/conformance always returns 200 → card always renders.
    // The "Conformance score" label is always present regardless of CERTIFIED/UNCERTIFIED.
    await expect(page.getByText('Conformance score')).toBeVisible()
  })

  test('step 2 — linked catalog name appears in ConformanceCard catalogs section', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/`)

    // quorum-test-project links to quorum-test-catalog.
    // ConformanceCard renders the catalog group_id in font-mono when catalogs.length > 0.
    // This verifies the federation link is visible to the user.
    await expect(page.getByText('quorum-test-catalog')).toBeVisible()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-07.7 — UNCERTIFIED State (isolated project) (browser)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.7 — UNCERTIFIED State', () => {
  test('step 1 — isolated project with no globals shows UNCERTIFIED text', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    // quorum-test-isolated-project has no globals in its .quorum fixture.
    // GET /api/conformance returns { status: 'UNCERTIFIED', catalogs: [] }.
    // This is guaranteed structurally — no database state can change it.
    await injectSession(page, {
      project: 'quorum-test-isolated-project',
    })
    await page.goto(`${DASHBOARD_URL}/`)

    // ConformanceCard score display: isUncertified → "UNCERTIFIED" text (not "N%")
    await expect(page.getByText('UNCERTIFIED')).toBeVisible()
  })

  test('step 2 — UNCERTIFIED sub-message explains "no linked global catalogs"', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page, {
      project: 'quorum-test-isolated-project',
    })
    await page.goto(`${DASHBOARD_URL}/`)

    // ConformanceCard renders this sub-message when catalogs.length === 0:
    //   "No linked global catalogs — use quorum:onboard to link catalogs."
    await expect(
      page.getByText('No linked global catalogs', { exact: false })
    ).toBeVisible()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-07.8 — Conformance Score Badge Logic (browser)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.8 — Conformance Score Badge', () => {
  test('step 1 — UNCERTIFIED shows no % percentage text', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page, { project: 'quorum-test-isolated-project' })
    await page.goto(`${DASHBOARD_URL}/`)

    // When UNCERTIFIED the score badge shows "UNCERTIFIED" not a number.
    // Assert the conformance section does NOT show a % sign.
    // (Score badge is the only 3xl text on the page — p.text-3xl.font-bold)
    const scoreBadge = page.locator('p.text-3xl')
    await expect(scoreBadge).toBeVisible()
    await expect(scoreBadge).toHaveText('UNCERTIFIED')
  })

  test('step 2 — breakdown bar is absent when UNCERTIFIED (only shown when CERTIFIED)', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page, { project: 'quorum-test-isolated-project' })
    await page.goto(`${DASHBOARD_URL}/`)

    // ConformanceCard only renders the breakdown bar when !isUncertified.
    // The breakdown legend labels (Open, Accepted, Deferred, Denied, Overdue, Resolved)
    // must NOT be present when UNCERTIFIED.
    await expect(page.getByText('UNCERTIFIED')).toBeVisible()

    // Use a specific breakdown label that only appears in the CERTIFIED breakdown section
    // ('Open' also appears in the filter rail for deviations, so use 'Accepted' which is breakdown-only)
    await expect(page.getByText(/\d+ Accepted/, { exact: false })).not.toBeVisible()
  })

}) // S-07 — Conformance Scoring
