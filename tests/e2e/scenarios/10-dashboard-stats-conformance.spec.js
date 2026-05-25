/**
 * S-10 — Dashboard Stats & Conformance Display (J10)
 *
 * Journey: J10 — Executive Stats and Conformance Visibility (browser)
 * Pillars: Functional Correctness (S-10.1, S-10.2)
 *          Conformance Display    (S-10.3, S-10.4)
 *
 * Sub-scenarios:
 *   S-10.1  Stats page loads — 4 stat cards visible (Total domains, Active
 *           knowledge, Pending decisions, Oldest pending)
 *   S-10.2  ConformanceCard renders — "Conformance score" label appears
 *           for project with linked global catalogs (status may be UNCERTIFIED
 *           or CERTIFIED depending on scan state — we assert presence not value)
 *   S-10.3  UNCERTIFIED state — isolated project with no globals shows
 *           "UNCERTIFIED" text and "No linked global catalogs" sub-message
 *   S-10.4  ConformanceCard colour invariant — grey border/bg when UNCERTIFIED;
 *           score badge text is "UNCERTIFIED" not a numeric percentage
 *
 * Architecture notes:
 *   Stats page is at route "/" (default ProtectedRoute child).
 *   ConformanceCard renders only when useConformance() returns truthy data.
 *   GET /api/conformance always returns 200 — UNCERTIFIED or CERTIFIED object.
 *   UNCERTIFIED reasons (from ConformanceCard):
 *     - scan_count === 0         → "No scans run yet — use quorum:scan..."
 *     - catalogs.length === 0    → "No linked global catalogs — use quorum:onboard..."
 *     - coverage too sparse      → "Catalog coverage too sparse..."
 *   quorum-test-isolated-project: no globals in .quorum fixture → always UNCERTIFIED
 *     with "No linked global catalogs" message regardless of database state.
 *
 * Auth injection:
 *   injectSession() default: sub='test-pe', project='quorum-test-project', PA role
 *   For UNCERTIFIED tests: override project='quorum-test-isolated-project'
 *
 * All browser tests skip when QUORUM_DASHBOARD_URL is not set (local dev without
 * dashboard). Set QUORUM_DASHBOARD_URL=http://dashboard (Docker) to run them.
 */

import { test, expect } from '@playwright/test'

const { describe } = test
import { injectSession, DASHBOARD_URL } from '../helpers/browser.js'

// ─────────────────────────────────────────────────────────────────────────────
// S-10.1 — Stats Page Load
// ─────────────────────────────────────────────────────────────────────────────

describe('S-10.1 — Stats Page Load', () => {
  test('step 1 — stats page loads with 4 summary stat cards visible', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/`)

    // All 4 StatCard labels must appear (StatCard renders a .text-xs.uppercase label)
    await expect(page.getByText('Total domains')).toBeVisible()
    await expect(page.getByText('Active knowledge')).toBeVisible()
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
// S-10.2 — ConformanceCard Renders
// ─────────────────────────────────────────────────────────────────────────────

describe('S-10.2 — ConformanceCard Renders', () => {
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
// S-10.3 — UNCERTIFIED State (isolated project)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-10.3 — UNCERTIFIED State', () => {
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
// S-10.4 — ConformanceCard Score Badge Logic
// ─────────────────────────────────────────────────────────────────────────────

describe('S-10.4 — Conformance Score Badge', () => {
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
})
