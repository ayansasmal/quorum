/**
 * S-23.3 — Dashboard welcome state for authenticated users with no projects.
 */

import { test, expect } from '@playwright/test'
import { DASHBOARD_URL, injectSession } from '../../helpers/browser.js'

test.describe('S-23.3 — Dashboard zero-projects welcome', () => {
  test('a projectless user sees onboarding guidance instead of login', async ({ page }) => {
    await injectSession(page, {
      sub:      's23-newbie',
      project:  null,
      role:     null,
      projects: [],
    })

    await page.goto(DASHBOARD_URL)

    await expect(page.getByRole('heading', { name: /no Quorum projects accessible to you/i })).toBeVisible()
    await expect(page.getByText('quorum config_upload', { exact: true })).toBeVisible()
    await expect(page).not.toHaveURL(/\/login(?:[/?#]|$)/)
  })
})
