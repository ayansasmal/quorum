/**
 * S-09 (UI) — Platform admin dashboard visibility.
 *
 * Browser sub-scenario extracted from the gateway E2E suite. Pure navigation:
 * asserts the dashboard /admin panel renders for an is_admin JWT and is gated for
 * a non-admin PE. Gateway is a black box at QUORUM_DASHBOARD_URL.
 *
 *   S-09.5 — Dashboard admin panel visibility
 */
import { test, expect } from '@playwright/test'

const { describe } = test
import { injectSession, DASHBOARD_URL } from '../../helpers/browser.js'

const PROJECT = 'quorum-test-project'

// ─────────────────────────────────────────────────────────────────────────────
// S-09.5 — Dashboard Admin Panel (browser-only)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.5 — Dashboard Admin Panel Visibility', { tag: '@ui' }, () => {
  test('step 1 — /admin page renders when is_admin:true JWT injected', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'Browser tests run in Docker mode only (QUORUM_DASHBOARD_URL not set)')

    await injectSession(page, { sub: 'test-admin', is_admin: true, project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/admin`)

    // Admin panel should render — not redirected to home or shown permission-denied
    await page.waitForLoadState('networkidle')
    const url = page.url()
    expect(url).not.toMatch(/\/$/)
    // Admin-specific content present (heading or section)
    const heading = await page.locator('h1, h2').first().textContent()
    expect(heading.toLowerCase()).toMatch(/admin/)
  })

  test('step 2 — /admin page not accessible to non-admin PE', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'Browser tests run in Docker mode only (QUORUM_DASHBOARD_URL not set)')

    await injectSession(page, { sub: 'test-pe', role: 'principal_architect', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/admin`)

    await page.waitForLoadState('networkidle')
    // Should be redirected away from /admin (no admin access for non-admin PE)
    const url = page.url()
    // Either redirected to root or shows an error state
    const notAdmin = url.endsWith('/') || url.endsWith('/admin') === false ||
      (await page.locator('[data-testid="forbidden"], .forbidden, .permission-denied').count()) > 0
    expect(notAdmin || !url.includes('/admin') || url.endsWith('/')).toBe(true)
  })
})
