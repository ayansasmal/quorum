/**
 * S-04 (UI) — Deviation Governance dashboard flows.
 *
 * Browser (@ui) sub-scenarios extracted from the gateway E2E suite. The gateway
 * is a black box: tests seed catalog entries + deviations over HTTP and drive the
 * React dashboard at QUORUM_DASHBOARD_URL.
 *
 *   S-04.7 — Deviations governance dashboard (filter rail, table, action panel)
 *   S-04.8 — Knowledge denial-hint badge
 *   S-04.9 — Overdue deferrals section on the pending page
 */
import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }      from '../../helpers/api.js'
import { tokens }   from '../../helpers/jwt.js'
import { uid, activeEntry, deviation } from '../../helpers/seed.js'
import { injectSession, DASHBOARD_URL } from '../../helpers/browser.js'

const CATALOG  = 'quorum-test-catalog'
const PROJECT  = 'quorum-test-project'

// ─────────────────────────────────────────────────────────────────────────────
// S-04.7 — Deviations Dashboard (browser)
//
// Seed: ACTIVE catalog entry in quorum-test-catalog + deviation in
// quorum-test-project with a uid-unique description for row scoping.
// The uid() in the description makes the specific row locatable even when
// multiple deviations exist from prior runs.
// ─────────────────────────────────────────────────────────────────────────────

describe('S-04.7 — Deviations Governance Dashboard', { tag: '@ui' }, () => {
  // Shared seed state (populated in beforeAll, read by all inner describes)
  let s047Description

  test.beforeAll(async () => {
    // Skip seed in local dev — no gateway running.
    if (!process.env.QUORUM_DASHBOARD_URL) return

    const key = uid('s047-dev')
    s047Description = `E2E S-04.7 — TLS enforcement deviation ${key}`

    // 1. Seed ACTIVE catalog entry in the global catalog.
    //    PA writes land as ACTIVE immediately — no approval step needed.
    await activeEntry({
      topic:   'security',
      key,
      content: 'All service-to-service communication must use TLS 1.3 or higher.',
      project: 'quorum-test-catalog',
      globalCatalog: true,
    })

    // 2. Record deviation from the test project against this catalog entry.
    //    deviation() upserts on (project_id, catalog_id, topic, key) — idempotent.
    await deviation({
      catalogId:   'quorum-test-catalog',
      topic:       'security',
      key,
      description: s047Description,
      project:     'quorum-test-project',
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-04.7.1 — Filter Rail
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-04.7.1 — Filter Rail', () => {
    test('step 1 — filter rail renders with status, topic, source, severity controls', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // Status select — first <select> in the filter rail
      // Default has 'OPEN' selected (the initial filter state)
      await expect(page.locator('select').first()).toBeVisible()

      // Topic text input
      await expect(page.getByPlaceholder('Topic…')).toBeVisible()

      // Source select — second <select> in filter rail.
      // Note: <option> elements inside a <select> are not individually visible
      // until the dropdown is opened — assert the <select> itself, not the option text.
      await expect(page.locator('select').nth(1)).toBeVisible()

      // Min severity label + number input
      await expect(page.getByText('Min severity')).toBeVisible()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-04.7.2 — Table Display
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-04.7.2 — Table Display', () => {
    test('step 1 — seeded OPEN deviation appears in table', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // The seeded deviation's description contains a uid-suffixed key — unique across runs.
      // Default filter is status='OPEN' so the OPEN deviation must be visible.
      await expect(page.getByText(s047Description)).toBeVisible()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-04.7.3 — Action Panel
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-04.7.3 — Action Panel', () => {
    test('step 1 — "Action" button expands panel with accept / deny / defer buttons', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // Locate the exact <tr> that contains our seeded deviation's description,
      // then click its "Action" button — scoped to avoid clicking another row's button.
      const deviationRow = page.locator('tr', { has: page.getByText(s047Description) })
      await deviationRow.getByRole('button', { name: /Action/ }).click()

      // The inline action panel expands as a sibling <tr> — all three action type
      // buttons must be visible after the toggle.
      await expect(page.getByRole('button', { name: 'accept' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'deny' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'defer' })).toBeVisible()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-04.7.4 — Reason Validation
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-04.7.4 — Reason Validation', () => {
    test('step 1 — reason < 10 chars blocks submit and shows character count error', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // Open action panel for our deviation
      const deviationRow = page.locator('tr', { has: page.getByText(s047Description) })
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
  // S-04.7.5 — Accept Action
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-04.7.5 — Accept Action', () => {
    test('step 1 — valid reason + submit removes deviation from OPEN filter view', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page)
      await page.goto(`${DASHBOARD_URL}/deviations`)

      // Open action panel
      const deviationRow = page.locator('tr', { has: page.getByText(s047Description) })
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
      await expect(page.getByText(s047Description)).not.toBeVisible()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-04.8 — Knowledge Denial Hint Badge (browser)
//
// Seed: ACTIVE catalog entry → deviation → deny action.
// Navigate as the global catalog project (is_global=true) so the gateway
// computes denial_hint_count in the GET /api/knowledge response.
// ─────────────────────────────────────────────────────────────────────────────

describe('S-04.8 — Knowledge Denial Hint Badge', { tag: '@ui' }, () => {
  let s048Key

  test.beforeAll(async () => {
    // Skip seed in local dev — no gateway running.
    if (!process.env.QUORUM_DASHBOARD_URL) return

    s048Key = uid('s048-dh')
    const s048Topic = 'security'

    // 1. Seed ACTIVE catalog entry in the global catalog.
    await activeEntry({
      topic:   s048Topic,
      key:     s048Key,
      content: 'Authentication tokens must be rotated every 24 hours in production.',
      project: 'quorum-test-catalog',
      globalCatalog: true,
    })

    // 2. Record a deviation from the test project against this standard.
    const { deviationId } = await deviation({
      catalogId:   'quorum-test-catalog',
      topic:       s048Topic,
      key:         s048Key,
      description: `E2E S-04.8 — token rotation deviation ${s048Key}`,
      project:     'quorum-test-project',
    })

    // 3. Deny the deviation — this increments denial_hint_count on the catalog entry.
    //    enforceDeviationActionAuthority: architect+ required — tokens.pe = PA.
    const client = api(tokens.pe, 'quorum-test-project')
    await client.post(`/api/deviations/${deviationId}/action`, {
      action_type: 'deny',
      reason:      'Token rotation at 24h is not feasible given our offline-first architecture.',
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-04.8.1 — Denial Badge Visible
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-04.8.1 — Denial Badge', () => {
    test('step 1 — ✕1 badge renders on global catalog entry after a denial', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')

      // Log in as the global catalog project — GET /api/knowledge returns
      // denial_hint_count only when the project has is_global === true.
      await injectSession(page, { project: 'quorum-test-catalog' })
      await page.goto(`${DASHBOARD_URL}/knowledge`)

      // Find the Key column <td> that contains our specific key text.
      // The key renders as <span class="text-blue-400">{key}</span> inside the <td>.
      // The denial badge <span>✕{count}</span> is a sibling in the same <td>.
      const keyCell = page.locator('td').filter({ has: page.getByText(s048Key, { exact: true }) })

      // Badge text: ✕1 (U+2715 MULTIPLICATION X followed by the count)
      await expect(keyCell.getByText('✕1')).toBeVisible()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-04.8.2 — Badge Tooltip
  // ─────────────────────────────────────────────────────────────────────────

  describe('S-04.8.2 — Badge Tooltip', () => {
    test('step 1 — badge title attribute says "1 project has denied this standard"', async ({ page }) => {
      test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
      await injectSession(page, { project: 'quorum-test-catalog' })
      await page.goto(`${DASHBOARD_URL}/knowledge`)

      // The badge element carries a title attribute used as the tooltip:
      //   "1 project has denied this standard" (singular form when count === 1)
      // Scoped to the key cell to avoid false matches from other catalog entries.
      const keyCell = page.locator('td').filter({ has: page.getByText(s048Key, { exact: true }) })
      const badge   = keyCell.locator('[title*="denied this standard"]')

      await expect(badge).toBeVisible()
      await expect(badge).toHaveAttribute('title', '1 project has denied this standard')
    })
  })

}) // S-04.8 — Knowledge Denial Hint Badge

// ─────────────────────────────────────────────────────────────────────────────
// S-04.9 — Overdue Deferrals on Pending Page (browser)
//
// Seeds: ACTIVE catalog entry → deviation → past-dated defer action via
// POST /pg/deviation-actions (admin-only bypass — enforceValidDeferDeadline
// blocks past dates through the normal API path).
// Navigates to /pending and asserts the orange overdue-deferrals-section renders.
// ─────────────────────────────────────────────────────────────────────────────

describe('S-04.9 — Overdue Deferrals Browser', { tag: '@ui' }, () => {
  let s049Key
  let s049Description

  test.beforeAll(async () => {
    if (!process.env.QUORUM_DASHBOARD_URL) return

    s049Key         = uid('s049-ov')
    s049Description = `E2E S-04.9 overdue deviation ${s049Key}`
    const topic     = 'security'

    await activeEntry({
      topic,
      key:     s049Key,
      content: 'TLS 1.3 required on all internal service endpoints.',
      project: CATALOG,
      globalCatalog: true,
    })

    const { deviationId } = await deviation({
      catalogId:   CATALOG,
      topic,
      key:         s049Key,
      description: s049Description,
      project:     PROJECT,
    })

    // Seed a past-dated defer action — bypasses enforceValidDeferDeadline
    // so the computed status resolves to OVERDUE (DEFERRED + defer_until < NOW()).
    // E2E: POST /pg/deviation-actions is admin-only and exists solely for this seeding path.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    // actor/actor_role are derived from the admin JWT server-side — not accepted from body
    await api(tokens.admin, PROJECT).post('/pg/deviation-actions', {
      deviation_id: deviationId,
      defer_until:  yesterday,
      reason:       'Deferred past deadline for S-04.9 E2E overdue test',
    })
  })

  test('step 1 — /pending shows overdue-deferrals-section when OVERDUE deviations exist', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require QUORUM_DASHBOARD_URL')
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/pending`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByTestId('overdue-deferrals-section')).toBeVisible({ timeout: 8000 })
  })

  test('step 2 — overdue section contains the seeded deviation description', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require QUORUM_DASHBOARD_URL')
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/pending`)
    await page.waitForLoadState('networkidle')

    const section = page.getByTestId('overdue-deferrals-section')
    await expect(section).toBeVisible({ timeout: 8000 })
    await expect(section.getByText(s049Description)).toBeVisible({ timeout: 5000 })
  })
}) // S-04.9 — Overdue Deferrals Browser
