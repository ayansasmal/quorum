/**
 * S-11 — Deviations Page Governance Actions (J11)
 *
 * Journey: J11 — PE/Architect Deviation Governance (browser)
 * Pillars: Filter Rail      (S-11.1)
 *          Table Display    (S-11.2)
 *          Action Panel     (S-11.3, S-11.4)
 *          Accept Action    (S-11.5)
 *
 * Sub-scenarios:
 *   S-11.1  Filter rail renders — status, topic, source, min-severity controls visible
 *   S-11.2  Seeded OPEN deviation appears in table with its unique description text
 *   S-11.3  Action panel opens — "Action" button reveals accept / deny / defer buttons
 *   S-11.4  Reason validation — reason < 10 chars blocks submit; error message shown
 *   S-11.5  Accept action — valid reason → row removed from OPEN filter view
 *
 * Architecture notes:
 *   /deviations is a MemberRoute — requires auth + project membership.
 *   Default filter: status='OPEN'. Accepted deviations fall out of this filter view.
 *   "Action" button only renders for ACTIONABLE_ROLES (architect, principal_architect,
 *   product_owner, compliance_officer). injectSession() default is PA — always actionable.
 *   After accept the mutation calls invalidateQueries(['deviations']) → list refetches
 *   and the ACCEPTED deviation drops out of the OPEN filter.
 *   seed.deviation() requires the catalog entry to exist first (uses topic:key to
 *   look up the global catalog entry for severity computation).
 *
 * Seed strategy:
 *   beforeAll: ACTIVE entry in quorum-test-catalog (PA writes are immediately ACTIVE),
 *   then record deviation from quorum-test-project against it. uid() in description
 *   makes the specific row locatable even when other deviations exist from prior runs.
 *
 * Row locator pattern:
 *   page.locator('tr', { has: page.getByText(s11Description) }) — scopes the "Action"
 *   button click to the exact row without depending on row index or other fragile selectors.
 *
 * Auth: injectSession() default — sub='test-pe', project='quorum-test-project', PA role.
 *
 * All browser tests skip when QUORUM_DASHBOARD_URL is not set (local dev without
 * dashboard). Set QUORUM_DASHBOARD_URL=http://dashboard (Docker) to run them.
 */

import { test, expect } from '@playwright/test'

const { describe } = test
import { injectSession, DASHBOARD_URL } from '../helpers/browser.js'
import { activeEntry, deviation, uid } from '../helpers/seed.js'

// ── Shared seed state (populated in beforeAll, read by all inner describes) ──
let s11Description

// ─────────────────────────────────────────────────────────────────────────────
// S-11 — Deviations Page Governance (outer describe owns the beforeAll)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-11 — Deviations Governance', () => {
  test.beforeAll(async () => {
    // Skip seed in local dev — no gateway running.
    // The seed only needs to succeed when QUORUM_DASHBOARD_URL is set (Docker mode).
    if (!process.env.QUORUM_DASHBOARD_URL) return

    const key = uid('s11-dev')
    s11Description = `E2E S-11 — TLS enforcement deviation ${key}`

    // 1. Seed ACTIVE catalog entry in the global catalog.
    //    PA writes land as ACTIVE immediately — no approval step needed.
    await activeEntry({
      topic:   'security',
      key,
      content: 'All service-to-service communication must use TLS 1.3 or higher.',
      project: 'quorum-test-catalog',
    })

    // 2. Record deviation from the test project against this catalog entry.
    //    deviation() upserts on (project_id, catalog_id, topic, key) — idempotent.
    await deviation({
      catalogId:   'quorum-test-catalog',
      topic:       'security',
      key,
      description: s11Description,
      project:     'quorum-test-project',
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-11.1 — Filter Rail
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-11.1 — Filter Rail', () => {
    test('step 1 — filter rail renders with status, topic, source, severity controls', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // Status select — first <select> in the filter rail
      // Default has 'OPEN' selected (the initial filter state)
      await expect(page.locator('select').first()).toBeVisible()

      // Topic text input
      await expect(page.getByPlaceholder('Topic…')).toBeVisible()

      // Source select — contains 'All sources' default option
      await expect(page.getByText('All sources')).toBeVisible()

      // Min severity label + number input
      await expect(page.getByText('Min severity')).toBeVisible()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-11.2 — Table Display
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-11.2 — Table Display', () => {
    test('step 1 — seeded OPEN deviation appears in table', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // The seeded deviation's description contains a uid-suffixed key — unique across runs.
      // Default filter is status='OPEN' so the OPEN deviation must be visible.
      await expect(page.getByText(s11Description)).toBeVisible()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-11.3 — Action Panel
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-11.3 — Action Panel', () => {
    test('step 1 — "Action" button expands panel with accept / deny / defer buttons', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // Locate the exact <tr> that contains our seeded deviation's description,
      // then click its "Action" button — scoped to avoid clicking another row's button.
      const deviationRow = page.locator('tr', { has: page.getByText(s11Description) })
      await deviationRow.getByRole('button', { name: /Action/ }).click()

      // The inline action panel expands as a sibling <tr> — all three action type
      // buttons must be visible after the toggle.
      await expect(page.getByRole('button', { name: 'accept' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'deny' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'defer' })).toBeVisible()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-11.4 — Reason Validation
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-11.4 — Reason Validation', () => {
    test('step 1 — reason < 10 chars blocks submit and shows character count error', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // Open action panel for our deviation
      const deviationRow = page.locator('tr', { has: page.getByText(s11Description) })
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
  // S-11.5 — Accept Action
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-11.5 — Accept Action', () => {
    test('step 1 — valid reason + submit removes deviation from OPEN filter view', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // Open action panel
      const deviationRow = page.locator('tr', { has: page.getByText(s11Description) })
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
      await expect(page.getByText(s11Description)).not.toBeVisible()
    })
  })
})
