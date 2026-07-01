/**
 * S-02 (UI) — Knowledge Governance dashboard flows.
 *
 * Browser (@ui) sub-scenarios extracted from the gateway E2E suite. The gateway
 * is a black box here: tests seed state over HTTP (helpers/seed.js) and drive the
 * React dashboard at QUORUM_DASHBOARD_URL.
 *
 *   S-02.8  — Dashboard conflict review (pending diff panel + review form)
 *   S-02.12 — Stale warning badge after request_changes
 */
import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }            from '../../helpers/api.js'
import { tokens }         from '../../helpers/jwt.js'
import { uid, activeEntry, conflict } from '../../helpers/seed.js'
import { injectSession, DASHBOARD_URL } from '../../helpers/browser.js'

const PROJECT = 'quorum-test-project'

// ─────────────────────────────────────────────────────────────────────────────
// S-02.8 — Dashboard Conflict Review (UI)
// ─────────────────────────────────────────────────────────────────────────────
//
// These are full-browser Playwright tests that exercise the React dashboard.
// They require the dashboard service to be running (QUORUM_DASHBOARD_URL).
//
// Auth injection: injectSession() bypasses GitHub OAuth by writing the three
// sessionStorage keys that AuthContext.jsx reads during its useState() init.
// Must be called before page.goto() so the init script fires before React boots.
//
// Shared state across all 5 steps (serial mode):
//   beforeAll seeds ONE ACTIVE entry and ONE conflict for the entire describe.
//   Steps 1–3 do not resolve the conflict.
//   Step 4 approves it — the card disappears.
//   Step 5 verifies the resolution appears in the audit timeline.
//
// Architecture notes:
//   DecisionCard header: span.font-mono.text-blue-400 shows conflict_topic:conflict_key
//   ConflictDiff: "Existing (ACTIVE)" / "Incoming (DRAFT)" labels in the expanded body
//   ReviewForm: radio labels "Approve" / "Reject" / "Request changes"; submit disabled
//     when note.trim().length < 10; useReview() onSuccess invalidates ['pending']
//   After approve: TanStack Query refetches pending — card disappears from DOM.
//
// E2E: tests/e2e/scenarios/02-knowledge-governance.spec.js
//   S-02.8.1 — conflict card visible + diff panel expanded
//   S-02.8.2 — submit blocked at UI when note < 10 chars
//   S-02.8.3 — request_changes keeps conflict in pending
//   S-02.8.4 — approve removes card + transitions entry to ACTIVE
//   S-02.8.5 — audit page shows 'review' tool entries after resolution

describe('S-02.8 — Dashboard UI', { tag: '@ui' }, () => {
  test.describe.configure({ mode: 'serial' })

  let s028Topic, s028Key
  const EXISTING_CONTENT = 'Existing ADR: use connection pools with max 10 connections per node.'
  const INCOMING_CONTENT = 'Proposed: increase connection pool to 25 for high-throughput read endpoints.'

  beforeAll(async () => {
    const token = uid('s028-ui')
    s028Topic   = 'db'
    s028Key     = token

    // Seed an ACTIVE entry that the engineer's draft will conflict with.
    await activeEntry({ topic: s028Topic, key: s028Key, content: EXISTING_CONTENT })

    // Seed the conflict: engineer writes conflicting DRAFT + pending_decisions row.
    // The conflict_id is not used directly — we find the card by topic:key in the UI.
    await conflict({
      topic:           s028Topic,
      key:             s028Key,
      content:         INCOMING_CONTENT,
      existingContent: EXISTING_CONTENT,
    })
  })

  test('step 1 — pending page shows conflict brief with both content versions', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/pending`)

    // Card header: conflict_topic:conflict_key in font-mono span
    await expect(page.getByText(`${s028Topic}:${s028Key}`)).toBeVisible()

    // Click the header to expand the card body
    await page.getByText(`${s028Topic}:${s028Key}`).click()

    // ConflictDiff renders two panels with these exact labels
    await expect(page.getByText('Existing (ACTIVE)')).toBeVisible()
    await expect(page.getByText('Incoming (DRAFT)')).toBeVisible()

    // Both content strings are rendered in the <pre> diff panels
    await expect(page.getByText(EXISTING_CONTENT)).toBeVisible()
    await expect(page.getByText(INCOMING_CONTENT)).toBeVisible()
  })

  test('step 2 — request_changes with < 10 chars is blocked at UI level', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/pending`)

    // Expand the conflict card
    await page.getByText(`${s028Topic}:${s028Key}`).click()

    // Open the review form
    await page.getByRole('button', { name: 'Review this decision' }).click()

    // Select "Request changes" action
    await page.getByText('Request changes').click()

    // Fill a note shorter than 10 characters
    const textarea = page.getByPlaceholder('Required: reason for this decision (min 10 chars)')
    await textarea.fill('too short')

    // Submit button is disabled when note.trim().length < 10 (ReviewForm.jsx:90)
    await expect(page.getByRole('button', { name: 'Submit review' })).toBeDisabled()
  })

  test('step 3 — valid request_changes note keeps conflict in pending', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/pending`)

    await page.getByText(`${s028Topic}:${s028Key}`).click()
    await page.getByRole('button', { name: 'Review this decision' }).click()
    await page.getByText('Request changes').click()

    const textarea = page.getByPlaceholder('Required: reason for this decision (min 10 chars)')
    await textarea.fill('Need more context and evidence before this can be approved.')

    await page.getByRole('button', { name: 'Submit review' }).click()

    // request_changes does NOT resolve the conflict — it stays in pending_decisions
    // with resolved_at = null. TanStack Query refetches and the card reappears.
    await expect(page.getByText(`${s028Topic}:${s028Key}`)).toBeVisible()
  })

  test('step 4 — approve via dashboard removes conflict and transitions to ACTIVE', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/pending`)

    await page.getByText(`${s028Topic}:${s028Key}`).click()
    await page.getByRole('button', { name: 'Review this decision' }).click()

    // "Approve" is the default selected action — no radio change needed
    const textarea = page.getByPlaceholder('Required: reason for this decision (min 10 chars)')
    await textarea.fill('Approved — connection pool increase is justified for current load.')

    await page.getByRole('button', { name: 'Submit review' }).click()

    // After approve, useReview() onSuccess invalidates ['pending'] — refetch removes
    // the resolved conflict from the response. Card disappears from DOM.
    await expect(page.getByText(`${s028Topic}:${s028Key}`)).not.toBeVisible()

    // Verify via API that the knowledge entry is now ACTIVE (DRAFT superseded → ACTIVE)
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${s028Topic}/${s028Key}`)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
  })

  test('step 5 — audit timeline shows review tool entries after resolution', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/audit`)

    // Filter by "review" tool using the select dropdown (Audit.jsx TOOLS array)
    await page.getByRole('combobox').selectOption('review')

    // At least one audit entry rendered by AuditEntry.jsx should show 'review' as tool
    // (text-amber-400 span per TOOL_COLOR map)
    const reviewBadge = page.locator('span').filter({ hasText: /^review$/ }).first()
    await expect(reviewBadge).toBeVisible()

    // The PE who approved (test-pe) should appear as the author in the entry
    await expect(page.getByText('test-pe').first()).toBeVisible()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-02.12 — Stale Warning Badge (UI)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-02.12 — Stale Warning Badge', { tag: '@ui' }, () => {
  // GAP-017: request_changes sets stale_warning on a pending decision.
  // The Pending page must show data-testid="stale-warning-badge" when the field is present.
  test.describe.configure({ mode: 'serial' })

  let s0212Topic, s0212Key, s0212ConflictId
  const EXISTING = 'Existing policy: always use TLS 1.3 for all inter-service communication.'
  const INCOMING = 'Proposed: allow TLS 1.2 for legacy clients on a per-service opt-in basis.'
  const REQUEST_CHANGES_NOTE = 'This needs a risk assessment from the security team before consideration.'

  beforeAll(async () => {
    const token  = uid('s0212-stale')
    s0212Topic   = 'security'
    s0212Key     = token

    // Seed ACTIVE entry + conflict (engineer DRAFT + pending_decision)
    await activeEntry({ topic: s0212Topic, key: s0212Key, content: EXISTING })
    const { conflictId } = await conflict({
      topic:           s0212Topic,
      key:             s0212Key,
      content:         INCOMING,
      existingContent: EXISTING,
    })
    s0212ConflictId = conflictId

    // PA does request_changes → stores note in stale_warning; conflict stays pending
    await api(tokens.pe, PROJECT).post(`/api/review/${s0212ConflictId}`, {
      action: 'request_changes',
      note:   REQUEST_CHANGES_NOTE,
    })
  })

  test('step 1 — stale_warning is set on the pending_decision after request_changes', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/pending/${s0212ConflictId}`)
    expect(res.status).toBe(200)
    expect(res.data.stale_warning).toBeTruthy()
  })

  test('step 2 — pending page shows stale warning badge when card is expanded', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/pending`)

    // Expand the conflict card by clicking on the topic:key label
    const cardHeader = page.getByText(`${s0212Topic}:${s0212Key}`).first()
    await expect(cardHeader).toBeVisible()
    await cardHeader.click()

    // Scroll the badge into view — the expanded body may extend below the viewport
    const badge = page.getByTestId('stale-warning-badge').first()
    await badge.scrollIntoViewIfNeeded()
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('Stale warning')
  })
})
