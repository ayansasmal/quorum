/**
 * S-22 (UI) — Portfolio intelligence dashboard surfaces.
 *
 * Browser (@ui) sub-scenarios extracted from the gateway E2E suite. Pure
 * navigation tests over the portfolio page (rollup, table, search, status
 * filter). Gateway is a black box at QUORUM_DASHBOARD_URL.
 *
 *   S-22.5 — Portfolio page renders
 *   S-22.6 — Portfolio table rows
 *   S-22.7 — Portfolio search filter
 *   S-22.8 — Portfolio status filter
 */
import { test, expect } from '@playwright/test'

const { describe } = test
import { injectSession, DASHBOARD_URL } from '../../helpers/browser.js'

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
