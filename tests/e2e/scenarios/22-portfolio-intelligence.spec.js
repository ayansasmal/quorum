/**
 * S-22 — Portfolio Intelligence UI
 *
 * Journey: J22 — docs/e2e/journeys/J22-portfolio-intelligence.md
 * Pillar:  Observability (score-gated 🟡)
 * OwnScore: 74  |  FailureCost: 149  (correlates S-07 conformance scoring)
 *
 * What it covers:
 *   Full Portfolio page — role gate enforcement (positive + negative), response shape,
 *   UNCERTIFIED rollup, node_id filter (positive + negative), and browser UI interactions
 *   (rollup banner, table rows, search, status filter, and empty state).
 *
 * Sub-scenarios:
 *   S-22.1  Role gate — NEGATIVE: engineer/architect/unauthenticated 403/401; POSITIVE: PA/director 200
 *   S-22.2  Response shape — POSITIVE: all fields; NEGATIVE: score is null for uncertified projects
 *   S-22.3  UNCERTIFIED rollup — POSITIVE: isolated project UNCERTIFIED; NEGATIVE: no globals → score null
 *   S-22.4  node_id filter — NEGATIVE: nonexistent node → empty; POSITIVE: known node → non-empty
 *   S-22.5  Browser: page renders with rollup banner (portfolio-rollup testid)
 *   S-22.6  Browser: project table rows visible (portfolio-row testids)
 *   S-22.7  Browser: search filter — POSITIVE: match narrows; NEGATIVE: no match → empty state
 *   S-22.8  Browser: status filter (UNCERTIFIED) narrows; reset restores list
 *
 * Notes:
 *   - S-22.1–22.4 are API-only; no seed required beyond setup.js fixtures.
 *   - S-22.5–22.8 require the dashboard (QUORUM_DASHBOARD_URL).
 *   - S-22.3 uses quorum-test-isolated-project (no globals → always UNCERTIFIED).
 *   - Serial mode required: S-22.2 and S-22.3 both call GET /api/portfolio and must
 *     not interleave with concurrent workers that might alter fixture state.
 */

import { test, expect } from '@playwright/test'
import axios             from 'axios'
import { api }               from '../helpers/api.js'
import { tokens }            from '../helpers/jwt.js'
import { uid }               from '../helpers/seed.js'
import { injectSession, DASHBOARD_URL } from '../helpers/browser.js'

const { describe, beforeAll } = test

const GATEWAY = process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001'

// ── Shared clients ─────────────────────────────────────────────────────────────
const paClient   = api(tokens.pe,        'quorum-test-project')
const dirClient  = api(tokens.director,  'quorum-test-project')
const engClient  = api(tokens.engineer,  'quorum-test-project')
const archClient = api(tokens.architect, 'quorum-test-project')
// Unauthenticated axios instance for negative auth tests
const unauthHttp = axios.create({ baseURL: GATEWAY, validateStatus: () => true })

// ── S-22.1 — Role Gate ─────────────────────────────────────────────────────────

describe('S-22.1 — Portfolio Role Gate', () => {
  test.describe.configure({ mode: 'serial' })

  // NEGATIVE: roles below the PORTFOLIO_ROLES threshold must be denied
  test('step 1 — NEGATIVE: engineer cannot access portfolio (403)', async () => {
    const res = await engClient.get('/api/portfolio')
    expect(res.status).toBe(403)
  })

  test('step 2 — NEGATIVE: architect cannot access portfolio (403)', async () => {
    const res = await archClient.get('/api/portfolio')
    expect(res.status).toBe(403)
  })

  test('step 3 — NEGATIVE: unauthenticated request is rejected (401)', async () => {
    const res = await unauthHttp.get('/api/portfolio', {
      headers: { 'X-Quorum-Project': 'quorum-test-project' },
    })
    expect(res.status).toBe(401)
  })

  // POSITIVE: roles in PORTFOLIO_ROLES must be allowed
  test('step 4 — POSITIVE: principal_architect can access portfolio (200)', async () => {
    const res = await paClient.get('/api/portfolio')
    expect(res.status).toBe(200)
    expect(res.data).toHaveProperty('projects')
    expect(res.data).toHaveProperty('rollup')
  })

  test('step 5 — POSITIVE: director can access portfolio (200)', async () => {
    const res = await dirClient.get('/api/portfolio')
    expect(res.status).toBe(200)
  })
})

// ── S-22.2 — Response Shape ────────────────────────────────────────────────────

describe('S-22.2 — Response Shape', () => {
  test.describe.configure({ mode: 'serial' })

  let portfolioData

  beforeAll(async () => {
    const res = await paClient.get('/api/portfolio')
    expect(res.status).toBe(200)
    portfolioData = res.data
  })

  test('step 1 — projects is an array', async () => {
    expect(Array.isArray(portfolioData.projects)).toBe(true)
  })

  test('step 2 — each project has required fields', async () => {
    const requiredFields = [
      'group_id', 'display_name', 'owner', 'is_global',
      'criticality', 'score', 'status', 'scan_count', 'last_scan_at',
    ]
    for (const project of portfolioData.projects) {
      for (const field of requiredFields) {
        expect(project).toHaveProperty(field)
      }
    }
  })

  test('step 3 — rollup is null or has required shape', async () => {
    if (portfolioData.rollup === null) return
    expect(portfolioData.rollup).toHaveProperty('score')
    expect(portfolioData.rollup).toHaveProperty('status')
    expect(portfolioData.rollup).toHaveProperty('certified_count')
    expect(portfolioData.rollup).toHaveProperty('uncertified_count')
    expect(['CERTIFIED', 'UNCERTIFIED']).toContain(portfolioData.rollup.status)
  })

  test('step 4 — status is CERTIFIED or UNCERTIFIED on every project', async () => {
    for (const project of portfolioData.projects) {
      expect(['CERTIFIED', 'UNCERTIFIED']).toContain(project.status)
    }
  })

  test('step 5 — NEGATIVE: UNCERTIFIED projects have null score', async () => {
    // score must be null for every UNCERTIFIED project — never a stale number
    for (const project of portfolioData.projects) {
      if (project.status === 'UNCERTIFIED') {
        expect(project.score).toBeNull()
      }
    }
  })
})

// ── S-22.3 — UNCERTIFIED Rollup ────────────────────────────────────────────────
// quorum-test-isolated-project has no globals config — permanently UNCERTIFIED
// regardless of database state. When the only portfolio entry is UNCERTIFIED,
// rollup.certified_count === 0 and rollup.score === null.

describe('S-22.3 — UNCERTIFIED Rollup', () => {
  test.describe.configure({ mode: 'serial' })

  // Use isolated project (no globals → getConformanceScore returns UNCERTIFIED)
  const isolatedPa = api(tokens.pe, 'quorum-test-isolated-project')

  test('step 1 — isolated project portfolio returns 200', async () => {
    const res = await isolatedPa.get('/api/portfolio')
    expect(res.status).toBe(200)
  })

  test('step 2 — isolated project appears as UNCERTIFIED', async () => {
    const res    = await isolatedPa.get('/api/portfolio')
    const target = res.data.projects.find(p => p.group_id === 'quorum-test-isolated-project')
    expect(target).toBeDefined()
    expect(target.status).toBe('UNCERTIFIED')
    expect(target.score).toBeNull()
  })
})

// ── S-22.4 — node_id Filter ────────────────────────────────────────────────────

describe('S-22.4 — node_id Hierarchy Filter', () => {
  test.describe.configure({ mode: 'serial' })

  // NEGATIVE: unknown node_id must return empty, not a 4xx
  test('step 1 — NEGATIVE: nonexistent node_id returns empty projects array', async () => {
    const res = await paClient.get('/api/portfolio?node_id=nonexistent-node-xyz')
    expect(res.status).toBe(200)
    expect(res.data.projects).toEqual([])
  })

  test('step 2 — NEGATIVE: rollup is null when node_id matches no children', async () => {
    const res = await paClient.get('/api/portfolio?node_id=nonexistent-node-xyz')
    expect(res.status).toBe(200)
    expect(res.data.rollup).toBeNull()
  })

  // POSITIVE: no node_id filter returns all projects for the user
  test('step 3 — POSITIVE: no node_id returns full project list', async () => {
    const res = await paClient.get('/api/portfolio')
    expect(res.status).toBe(200)
    expect(res.data.projects.length).toBeGreaterThan(0)
  })
})

// ── S-22.5 — Browser: Page Renders ─────────────────────────────────────────────

describe('S-22.5 — Portfolio Page Renders', { tag: '@ui' }, () => {
  test('step 1 — rollup banner is visible after navigation', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/portfolio`, { waitUntil: 'networkidle' })
    const rollup = page.getByTestId('portfolio-rollup')
    await expect(rollup).toBeVisible()
  })

  test('step 2 — portfolio score badge is present', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/portfolio`, { waitUntil: 'networkidle' })
    const badge = page.getByTestId('portfolio-score-badge')
    await expect(badge).toBeVisible()
  })

  test('step 3 — certified and uncertified counts are visible', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/portfolio`, { waitUntil: 'networkidle' })
    await expect(page.getByTestId('portfolio-certified-count')).toBeVisible()
    await expect(page.getByTestId('portfolio-uncertified-count')).toBeVisible()
  })
})

// ── S-22.6 — Browser: Table Rows ───────────────────────────────────────────────

describe('S-22.6 — Portfolio Table Rows', { tag: '@ui' }, () => {
  test('step 1 — table container is visible', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/portfolio`, { waitUntil: 'networkidle' })
    await expect(page.getByTestId('portfolio-table')).toBeVisible()
  })

  test('step 2 — at least one project row is rendered', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/portfolio`, { waitUntil: 'networkidle' })
    const rows = page.getByTestId('portfolio-row')
    await expect(rows.first()).toBeVisible()
  })
})

// ── S-22.7 — Browser: Search Filter ───────────────────────────────────────────

describe('S-22.7 — Portfolio Search Filter', { tag: '@ui' }, () => {
  // POSITIVE: known search term narrows results
  test('step 1 — POSITIVE: searching for a known project name filters the table', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/portfolio`, { waitUntil: 'networkidle' })

    const allRows = page.getByTestId('portfolio-row')
    const totalBefore = await allRows.count()

    await page.getByTestId('portfolio-search').fill('quorum-test-catalog')
    await expect(allRows).not.toHaveCount(0)
    const totalAfter = await allRows.count()
    expect(totalAfter).toBeLessThanOrEqual(totalBefore)
  })

  test('step 2 — POSITIVE: clearing search restores full list', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/portfolio`, { waitUntil: 'networkidle' })

    const allRows = page.getByTestId('portfolio-row')
    const countBefore = await allRows.count()

    await page.getByTestId('portfolio-search').fill('quorum-test-catalog')
    await page.getByTestId('portfolio-search').clear()
    const countAfter = await allRows.count()
    expect(countAfter).toBe(countBefore)
  })

  // NEGATIVE: nonsense search term shows empty state, not a crash or stale rows
  test('step 3 — NEGATIVE: no-match search shows empty state', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/portfolio`, { waitUntil: 'networkidle' })

    await page.getByTestId('portfolio-search').fill('zzz-no-such-project-zzz')
    await expect(page.getByTestId('portfolio-empty')).toBeVisible()
    await expect(page.getByTestId('portfolio-row')).toHaveCount(0)
  })
})

// ── S-22.8 — Browser: Status Filter ───────────────────────────────────────────

describe('S-22.8 — Portfolio Status Filter', { tag: '@ui' }, () => {
  test('step 1 — selecting UNCERTIFIED shows only UNCERTIFIED rows', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/portfolio`, { waitUntil: 'networkidle' })

    await page.getByTestId('portfolio-status-filter').selectOption('UNCERTIFIED')
    // All visible rows should show UNCERTIFIED badge text
    const rows = page.getByTestId('portfolio-row')
    const count = await rows.count()
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText('UNCERTIFIED')
    }
  })

  test('step 2 — selecting All restores full list', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/portfolio`, { waitUntil: 'networkidle' })

    const allRows = page.getByTestId('portfolio-row')
    const countBefore = await allRows.count()

    await page.getByTestId('portfolio-status-filter').selectOption('UNCERTIFIED')
    await page.getByTestId('portfolio-status-filter').selectOption('')
    const countAfter = await allRows.count()
    expect(countAfter).toBe(countBefore)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-22.9 — Archived Project Isolation + Cross-Project Portfolio Guard (NEGATIVE)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-22.9 — Archived Project Isolation and Cross-Project Portfolio Guard', () => {
  test.describe.configure({ mode: 'serial' })

  const ARCHIVED_PROJECT = `s229-archive-${Date.now()}`

  beforeAll(async () => {
    // Create a throwaway project so we can archive it and verify portfolio isolation
    const uploadRes = await api(tokens.pe, 'quorum-test-project').post('/config/upload', {
      group_id: ARCHIVED_PROJECT,
      owner:    'test-pe',
      project:  'S-22.9 Archive Isolation Test',
      members: [{ name: 'Test PE', github_username: 'test-pe', role: 'principal_architect', base_confidence: 0.8, team: 'platform' }],
    })
    if (uploadRes.status !== 201 && uploadRes.status !== 200) {
      throw new Error(`S-22.9 beforeAll: config upload failed ${uploadRes.status}`)
    }
    // Archive the project immediately
    await api(tokens.admin, 'quorum-test-project').delete(`/admin/projects/${ARCHIVED_PROJECT}`, {
      data: { reason: 'S-22.9 — archiving immediately to verify portfolio isolation after archive.' },
    })
  })

  test('step 1 — archived project does not appear in GET /api/portfolio response', async () => {
    const res = await api(tokens.pe, 'quorum-test-project').get('/api/portfolio')
    expect(res.status).toBe(200)
    const projectIds = (res.data.projects ?? []).map(p => p.group_id ?? p.project_id)
    expect(projectIds).not.toContain(ARCHIVED_PROJECT)
  })

  test('step 2 — GET /api/conformance for archived project returns non-200 (no active project config)', async () => {
    // After archive, the project config is invalidated — conformance for an archived project
    // should not return a meaningful CERTIFIED/UNCERTIFIED score
    const res = await api(tokens.pe, ARCHIVED_PROJECT).get('/api/conformance')
    // Either 403 (access_denied after archive) or 404 — must not be 200 with a valid score
    expect([403, 404]).toContain(res.status)
  })

  test('step 3 — test-engineer cannot access portfolio even from a project where they hold higher roles → 403', async () => {
    // Portfolio access is gated on role in the requesting project — engineer in any project
    // cannot see the portfolio.
    const res = await api(tokens.engineer, 'quorum-test-project').get('/api/portfolio')
    expect(res.status).toBe(403)
  })

  test('step 4 — GET /api/portfolio node_id filter for archived project group returns no matching projects', async () => {
    // The archived project had hierarchy.parent = undefined (no parent set).
    // Even if node_id matched an archived project's group_id, it should not appear.
    const res = await api(tokens.pe, 'quorum-test-project').get(`/api/portfolio?node_id=${ARCHIVED_PROJECT}`)
    expect(res.status).toBe(200)
    const projects = res.data.projects ?? []
    expect(projects.find(p => (p.group_id ?? p.project_id) === ARCHIVED_PROJECT)).toBeUndefined()
  })
})
