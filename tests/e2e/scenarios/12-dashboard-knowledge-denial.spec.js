/**
 * S-12 — Knowledge Page Denial Hint Count Badge (J12)
 *
 * Journey: J12 — Global Catalog Visibility (browser)
 * Pillars: Denial Badge      (S-12.1)
 *          Badge Tooltip     (S-12.2)
 *
 * Sub-scenarios:
 *   S-12.1  denial_hint_count badge (✕N) renders on global catalog Knowledge page
 *           when at least one project has denied that standard
 *   S-12.2  Badge title attribute states "N project has/have denied this standard"
 *           — confirms tooltip wording used by PAs to identify widely-denied entries
 *
 * Architecture notes:
 *   GET /api/knowledge only attaches denial_hint_count when the requesting project
 *   has is_global === true (batch subquery groups deviation_actions WHERE action_type='deny'
 *   by (topic, key)). Badge only shows when denial_hint_count > 0.
 *   Badge renders in the Key column: <span>✕{count}</span> adjacent to the key text.
 *   ✕ is U+2715 (MULTIPLICATION X), not the ASCII × or ×.
 *
 * Seed strategy:
 *   beforeAll:
 *     1. activeEntry() — ACTIVE catalog entry in quorum-test-catalog (PA write → ACTIVE)
 *     2. deviation() — record deviation from quorum-test-project against it
 *     3. POST /api/deviations/:id/action { action_type: 'deny' } — deny it
 *   Page navigation:
 *     injectSession(page, { project: 'quorum-test-catalog' }) — view as the global
 *     catalog project so the gateway sees is_global === true and computes denial counts.
 *
 * Auth:
 *   Seed: tokens.pe (test-pe = principal_architect) — member of both projects
 *   Browse: injectSession({ project: 'quorum-test-catalog' }) — needed for denial_hint_count
 *
 * All browser tests skip when QUORUM_DASHBOARD_URL is not set (local dev without
 * dashboard). Set QUORUM_DASHBOARD_URL=http://dashboard (Docker) to run them.
 */

import { test, expect } from '@playwright/test'

const { describe } = test
import { injectSession, DASHBOARD_URL } from '../helpers/browser.js'
import { api }    from '../helpers/api.js'
import { tokens } from '../helpers/jwt.js'
import { activeEntry, deviation, uid } from '../helpers/seed.js'

// ── Shared seed state ──────────────────────────────────────────────────────
let s12Key

// ─────────────────────────────────────────────────────────────────────────────
// S-12 — Knowledge Page Denial Hint (outer describe owns the beforeAll)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-12 — Knowledge Denial Hint Count Badge', () => {
  test.beforeAll(async () => {
    // Skip seed in local dev — no gateway running.
    if (!process.env.QUORUM_DASHBOARD_URL) return

    s12Key = uid('s12-dh')
    const s12Topic = 'security'

    // 1. Seed ACTIVE catalog entry in the global catalog.
    await activeEntry({
      topic:   s12Topic,
      key:     s12Key,
      content: 'Authentication tokens must be rotated every 24 hours in production.',
      project: 'quorum-test-catalog',
    })

    // 2. Record a deviation from the test project against this standard.
    const { deviationId } = await deviation({
      catalogId:   'quorum-test-catalog',
      topic:       s12Topic,
      key:         s12Key,
      description: `E2E S-12 — token rotation deviation ${s12Key}`,
      project:     'quorum-test-project',
    })

    // 3. Deny the deviation — this increments denial_hint_count on the catalog entry.
    //    The denial must originate from quorum-test-project (the project that deviated).
    //    enforceDeviationActionAuthority: architect+ required — tokens.pe = PA.
    const client = api(tokens.pe, 'quorum-test-project')
    await client.post(`/api/deviations/${deviationId}/action`, {
      action_type: 'deny',
      reason:      'Token rotation at 24h is not feasible given our offline-first architecture.',
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-12.1 — Denial Badge Visible
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-12.1 — Denial Badge', () => {
    test('step 1 — ✕1 badge renders on global catalog entry after a denial', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')

      // Log in as the global catalog project — GET /api/knowledge returns
      // denial_hint_count only when the project has is_global === true.
      await injectSession(page, { project: 'quorum-test-catalog' })
      await page.goto(`${DASHBOARD_URL}/knowledge`)

      // Find the Key column <td> that contains our specific key text.
      // The key renders as <span class="text-blue-400">{key}</span> inside the <td>.
      // The denial badge <span>✕{count}</span> is a sibling in the same <td>.
      const keyCell = page.locator('td').filter({ has: page.getByText(s12Key, { exact: true }) })

      // Badge text: ✕1 (U+2715 MULTIPLICATION X followed by the count)
      await expect(keyCell.getByText('✕1')).toBeVisible()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-12.2 — Badge Tooltip
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-12.2 — Badge Tooltip', () => {
    test('step 1 — badge title attribute says "1 project has denied this standard"', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page, { project: 'quorum-test-catalog' })
      await page.goto(`${DASHBOARD_URL}/knowledge`)

      // The badge element carries a title attribute used as the tooltip:
      //   "1 project has denied this standard" (singular form when count === 1)
      // Scoped to the key cell to avoid false matches from other catalog entries.
      const keyCell = page.locator('td').filter({ has: page.getByText(s12Key, { exact: true }) })
      const badge   = keyCell.locator('[title*="denied this standard"]')

      await expect(badge).toBeVisible()
      await expect(badge).toHaveAttribute('title', '1 project has denied this standard')
    })
  })
})
