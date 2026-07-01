/**
 * S-16 (UI) — Knowledge history drawer.
 *
 * Browser (@ui) sub-scenario extracted from the gateway E2E suite. Seeds a
 * two-version history over HTTP, then asserts the dashboard detail panel renders
 * the version timeline. Gateway is a black box at QUORUM_DASHBOARD_URL.
 *
 *   S-16.6 — Knowledge history drawer (version timeline)
 */
import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }           from '../../helpers/api.js'
import { tokens }        from '../../helpers/jwt.js'
import { uid, activeEntry } from '../../helpers/seed.js'
import { injectSession, DASHBOARD_URL } from '../../helpers/browser.js'

const PROJECT = 'quorum-test-project'

// S-16.6 — Knowledge History Drawer (browser)
//
// Seeds a key with v1 (ACTIVE) then supersedes it to create v2 (ACTIVE) / v1 (SUPERSEDED).
// Clicks the row in the Knowledge browser to open KnowledgeDetail, then asserts
// version-timeline renders with ≥2 version-rows including ACTIVE and SUPERSEDED entries.
// ─────────────────────────────────────────────────────────────────────────────

describe('S-16.6 — Knowledge History Drawer Browser', { tag: '@ui' }, () => {
  let s166Topic
  let s166Key

  test.beforeAll(async () => {
    if (!process.env.QUORUM_DASHBOARD_URL) return

    s166Topic = 'infra'
    s166Key   = uid('s166-hist')

    await activeEntry({
      topic:   s166Topic,
      key:     s166Key,
      content: 'E2E S-16.6 v1 — original infra pattern.',
      project: PROJECT,
    })

    // Supersede with v2 to create a two-version history visible in the drawer
    await api(tokens.pe, PROJECT).post(`/api/knowledge/${s166Topic}/${s166Key}/supersede`, {
      content:     'E2E S-16.6 v2 — updated infra pattern.',
      entity_type: 'Pattern',
      reason:      'S-16.6 E2E supersede for version history drawer test',
    })
  })

  test('step 1 — clicking a knowledge row opens the detail panel', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require QUORUM_DASHBOARD_URL')
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/knowledge`)
    await page.waitForLoadState('networkidle')

    // Search to bring the seeded key to the first page of results
    const searchInput = page.getByTestId('knowledge-search')
    await expect(searchInput).toBeVisible({ timeout: 5000 })
    await searchInput.fill(s166Key)

    const row = page.locator('tr').filter({ has: page.getByText(s166Key, { exact: true }) }).first()
    await expect(row).toBeVisible({ timeout: 8000 })
    await row.click()

    await expect(page.getByTestId('knowledge-detail-panel')).toBeVisible({ timeout: 5000 })
  })

  test('step 2 — detail panel shows version-timeline with ≥2 version-rows (ACTIVE + SUPERSEDED)', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require QUORUM_DASHBOARD_URL')
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/knowledge`)
    await page.waitForLoadState('networkidle')

    const searchInput = page.getByTestId('knowledge-search')
    await searchInput.fill(s166Key)
    const row = page.locator('tr').filter({ has: page.getByText(s166Key, { exact: true }) }).first()
    await expect(row).toBeVisible({ timeout: 8000 })
    await row.click()

    const timeline = page.getByTestId('version-timeline')
    await expect(timeline).toBeVisible({ timeout: 5000 })

    const versionRows = page.getByTestId('version-row')
    // v1 SUPERSEDED + v2 ACTIVE = 2 rows
    await expect(versionRows).toHaveCount(2, { timeout: 5000 })

    // Both statuses must be visible in the timeline text
    await expect(timeline.getByText('ACTIVE')).toBeVisible()
    await expect(timeline.getByText('SUPERSEDED')).toBeVisible()
  })

  test('step 3 — clicking Close dismisses the detail panel', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require QUORUM_DASHBOARD_URL')
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/knowledge`)
    await page.waitForLoadState('networkidle')

    const searchInput = page.getByTestId('knowledge-search')
    await searchInput.fill(s166Key)
    const row = page.locator('tr').filter({ has: page.getByText(s166Key, { exact: true }) }).first()
    await expect(row).toBeVisible({ timeout: 8000 })
    await row.click()

    await expect(page.getByTestId('knowledge-detail-panel')).toBeVisible({ timeout: 5000 })

    // Close via the X button (aria-label="Close" on the header button in KnowledgeDetail)
    await page.getByRole('button', { name: 'Close' }).first().click()
    await expect(page.getByTestId('knowledge-detail-panel')).not.toBeVisible({ timeout: 3000 })
  })
}) // S-16.6 — Knowledge History Drawer Browser
