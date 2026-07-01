/**
 * S-20 (UI) — Cross-catalog search interaction.
 *
 * Browser (@ui) sub-scenario extracted from the gateway E2E suite. Seeds a global
 * catalog entry over HTTP, then drives the dashboard knowledge search and asserts
 * the source-global badge behaviour. Gateway is a black box at QUORUM_DASHBOARD_URL.
 *
 *   S-20.8 — Search UI interaction (global-source badge, browse/search modes)
 */
import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }                          from '../../helpers/api.js'
import { tokens }                       from '../../helpers/jwt.js'
import { uid, activeEntry }             from '../../helpers/seed.js'
import { injectSession, DASHBOARD_URL } from '../../helpers/browser.js'

const PROJECT          = 'quorum-test-project'
const CATALOG          = 'quorum-test-catalog'

// S-20.8 — Search UI Interaction (browser)
//
// Verifies that the Knowledge browser search input is wired to GET /api/search,
// that global results carry the source-global-badge, and that clearing the input
// restores browse mode (badge disappears since isSearching becomes false).
// ─────────────────────────────────────────────────────────────────────────────

describe('S-20.8 — Search UI Interaction', { tag: '@ui' }, () => {
  let s208Token
  let s208Key

  test.beforeAll(async () => {
    if (!process.env.QUORUM_DASHBOARD_URL) return

    s208Token = uid('s208')
    s208Key   = `${s208Token}-key`

    // Seed a global entry — it must appear in search results with source:'global' badge.
    await activeEntry({
      topic:   'reliability',
      key:     s208Key,
      content: `E2E S-20.8 global search target ${s208Token}.`,
      project: CATALOG,
      globalCatalog: true,
    })
  })

  test('step 1 — typing ≥2 chars triggers search and hides pagination controls', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require QUORUM_DASHBOARD_URL')
    // PROJECT has globals:[CATALOG] so cross-catalog search is active.
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/knowledge`)
    await page.waitForLoadState('networkidle')

    const searchInput = page.getByTestId('knowledge-search')
    await expect(searchInput).toBeVisible({ timeout: 5000 })
    await searchInput.fill(s208Token)

    // Seeded key row should appear in search results
    await expect(page.getByText(s208Key).first()).toBeVisible({ timeout: 8000 })

    // Pagination hidden in search mode (Knowledge.jsx: !isSearching && data?.pages > 1)
    await expect(page.locator('button:has-text("Prev")')).not.toBeVisible()
  })

  test('step 2 — global results carry the source-global-badge', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require QUORUM_DASHBOARD_URL')
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/knowledge`)
    await page.waitForLoadState('networkidle')

    await page.getByTestId('knowledge-search').fill(s208Token)
    await expect(page.getByText(s208Key).first()).toBeVisible({ timeout: 8000 })

    // source-global-badge renders in the key column for global-sourced search results
    const keyCell = page.locator('td').filter({ has: page.getByText(s208Key, { exact: true }) })
    await expect(keyCell.getByTestId('source-global-badge')).toBeVisible({ timeout: 5000 })
  })

  test('step 3 — clearing the search drops browse mode; source-global-badge disappears', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require QUORUM_DASHBOARD_URL')
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/knowledge`)
    await page.waitForLoadState('networkidle')

    const searchInput = page.getByTestId('knowledge-search')
    await searchInput.fill(s208Token)
    await expect(page.getByText(s208Key).first()).toBeVisible({ timeout: 8000 })

    // Clear search — isSearching becomes false when query.trim().length < 2
    await searchInput.fill('')

    // source-global-badge is only rendered when isSearching === true (Knowledge.jsx).
    // Its absence confirms the page switched back to browse mode.
    await expect(page.getByTestId('source-global-badge').first()).not.toBeVisible({ timeout: 3000 })
  })
}) // S-20.8 — Search UI Interaction
