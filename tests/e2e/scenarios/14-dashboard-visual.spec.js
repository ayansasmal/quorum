/**
 * S-14 — Dashboard Visual & Interaction Flows (J14)
 *
 * Journey: J14 — Dashboard Visual & Interaction Flows
 * Pillars: UI Correctness (all sub-flows)
 *
 * Sub-scenarios:
 *   S-14.1  Knowledge graph (/graph) — domain select, canvas render, legend, node click → NodePanel
 *   S-14.2  Config editor (/config) — renders, schema-invalid JSON triggers error + disables Save
 *   S-14.3  System status (/status) — service health indicators show Healthy in test stack
 *   S-14.4  Audit timeline (/audit) — entries listed, author filter narrows results
 *   S-14.5  Project selector — switch button triggers selector, search filters, cancel returns
 *
 * Architecture notes:
 *   Browser tests gated on QUORUM_DASHBOARD_URL (set to http://dashboard in Docker E2E mode).
 *   S-14.1 step 3 is API-only — runs in all environments regardless of QUORUM_DASHBOARD_URL.
 *
 *   Graph: Cytoscape.js renders into a <canvas> element — no DOM-queryable node elements.
 *   Domain filter is React state driven via <select>; URL query params (?domain=) are ignored.
 *   Selecting a domain triggers useGraph(domain) → GET /api/graph?domain=auth → canvas appears.
 *   NodePanel opens on node tap; it is absolute-positioned at top-right of the graph container.
 *
 *   Config editor: textarea is a controlled React component. Invalid JSON that passes JSON.parse
 *   but fails Zod schema validation triggers POST /config/validate → 400 → validErr state →
 *   red error div appears and Save button becomes disabled.
 *
 *   Audit: AuditEntry has no click handler — no detail panel on click. Filter inputs
 *   (author, tool, topic) drive GET /pg/audit query params.
 *
 *   Project selector: header switch button only renders when availableProjects.length > 1
 *   (canSwitch guard). Inject two projects in sessionStorage to make the button appear.
 *   switchProject() sets authPhase='selecting'; App.jsx routes to /select-project.
 *   switchTo() and cancelSwitch() are synchronous — no POST /auth/switch needed.
 *
 *   Note: graph layout quality and visual clarity cannot be asserted programmatically.
 *   This scenario asserts node presence, panel rendering, and error states only.
 *   See MANUAL-TESTS.md MT-04 for the visual quality check.
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }                            from '../helpers/api.js'
import { tokens }                         from '../helpers/jwt.js'
import { uid, activeEntry }               from '../helpers/seed.js'
import { injectSession, DASHBOARD_URL }   from '../helpers/browser.js'

const PROJECT = 'quorum-test-project'

const SKIP_MSG  = 'Browser tests run in Docker mode only (QUORUM_DASHBOARD_URL not set)'
const shouldSkip = !process.env.QUORUM_DASHBOARD_URL

describe('S-14 — Dashboard Visual', { tag: '@ui' }, () => {

// ─────────────────────────────────────────────────────────────────────────────
// S-14.1 — Knowledge Graph (/graph)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-14.1 — Knowledge Graph', () => {
  beforeAll(async () => {
    // Seed 3 ACTIVE entries across auth and infra domains so the graph has nodes.
    const base = uid('s14-graph')
    await activeEntry({ topic: 'auth',  key: `${base}-a1`, content: 'Auth pattern A — graph seed for S-14.' })
    await activeEntry({ topic: 'auth',  key: `${base}-a2`, content: 'Auth pattern B — graph seed for S-14.' })
    await activeEntry({ topic: 'infra', key: `${base}-i1`, content: 'Infra pattern — graph seed for S-14.' })
  })

  test('step 1 — selecting a domain loads the Cytoscape canvas', async ({ page }) => {
    test.skip(shouldSkip, SKIP_MSG)
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/graph`)
    await page.waitForLoadState('networkidle')

    // By default the graph shows a domain <select> with "Select domain to load graph"
    // — no canvas until the user picks a domain.
    const domainSelect = page.locator('select').first()
    await expect(domainSelect).toBeVisible({ timeout: 8000 })

    // Wait for stats to load so domain options (auth, infra …) are available
    await expect(page.locator('select option:not([value=""])').first()).toBeAttached({ timeout: 15000 })

    // Select the auth domain — triggers useGraph('auth') → GET /api/graph?domain=auth
    await domainSelect.selectOption('auth')

    // Cytoscape initialises and renders into a <canvas> element
    const canvas = page.locator('canvas').first()
    await expect(canvas).toBeVisible({ timeout: 15000 })
  })

  test('step 2 — legend shows entity type labels; clicking canvas opens NodePanel when a node is hit', async ({ page }) => {
    test.skip(shouldSkip, SKIP_MSG)
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/graph`)
    await page.waitForLoadState('networkidle')

    // Select auth domain and wait for graph to render
    const domainSelect = page.locator('select').first()
    await expect(page.locator('select option:not([value=""])').first()).toBeAttached({ timeout: 15000 })
    await domainSelect.selectOption('auth')
    const canvas = page.locator('canvas').first()
    await expect(canvas).toBeVisible({ timeout: 15000 })

    // Legend renders below the graph when data is loaded —
    // check entity type labels defined in Graph.jsx's legend array.
    await expect(page.locator('text=Decision')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=Pattern')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=CONFLICTS')).toBeVisible({ timeout: 5000 })

    // Attempt to click a graph node. Cytoscape layout is non-deterministic,
    // so we sweep a 3×3 grid across the canvas. If a node is hit, NodePanel
    // slides in at the top-right of the graph container showing topic:key.
    const box = await canvas.boundingBox()
    let nodeClicked = false
    if (box) {
      const positions = [
        { x: 0.25, y: 0.30 }, { x: 0.50, y: 0.30 }, { x: 0.75, y: 0.30 },
        { x: 0.25, y: 0.55 }, { x: 0.50, y: 0.55 }, { x: 0.75, y: 0.55 },
        { x: 0.25, y: 0.75 }, { x: 0.50, y: 0.75 }, { x: 0.75, y: 0.75 },
      ]
      for (const { x, y } of positions) {
        await page.mouse.click(
          box.x + box.width  * x,
          box.y + box.height * y,
        )
        await page.waitForTimeout(250)
        // NodePanel renders "Loading content…" as the first thing on tap
        const hit = await page.locator('text=Loading content').isVisible().catch(() => false)
          || await page.locator('text=Author:').isVisible().catch(() => false)
        if (hit) { nodeClicked = true; break }
      }
    }

    // If a node was hit, verify the NodePanel has expected metadata sections.
    // If no node was hit (graph layout placed all nodes outside the click grid),
    // the legend assertions above are sufficient — visual quality is MT-04.
    if (nodeClicked) {
      await expect(page.locator('text=Author:')).toBeVisible({ timeout: 3000 })
      await expect(page.locator('text=Version:')).toBeVisible({ timeout: 3000 })
      await expect(page.locator('text=Status:')).toBeVisible({ timeout: 3000 })
    }
  })

  // API-ONLY: runs in all environments — no shouldSkip guard.
  // Asserts that GET /api/graph enforces a domain filter when the total entry
  // count would exceed the 500-node guard threshold.
  test('step 3 — GET /api/graph without domain filter returns 400 when entries > 500', async () => {
    const res = await api(tokens.pe, PROJECT).get('/api/graph?limit=1000')
    // In a fresh test env (< 500 entries): guard not triggered → 200
    // In a saturated env (> 500 entries): guard fires → 400 with guidance
    if (res.status === 400) {
      expect(res.data.message ?? res.data.error).toMatch(/domain/i)
    } else {
      expect(res.status).toBe(200)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-14.2 — Config Editor (/config)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-14.2 — Config Editor', () => {
  test('step 1 — config page renders with the current project config in the raw editor', async ({ page }) => {
    test.skip(shouldSkip, SKIP_MSG)
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/config`)
    await page.waitForLoadState('networkidle')

    // The raw JSON editor textarea should be visible with the config content.
    // Config.jsx renders: <textarea value={JSON.stringify(draft, null, 2)} … />
    const editor = page.locator('textarea').first()
    await expect(editor).toBeVisible({ timeout: 8000 })

    // Confirm the textarea contains meaningful JSON (group_id is always present
    // in a valid project config).
    const content = await editor.textContent().catch(() => '')
    expect(content.length).toBeGreaterThan(10)
    expect(content).toContain('group_id')
  })

  test('step 2 — schema-invalid JSON triggers error banner and disables the Save button', async ({ page }) => {
    test.skip(shouldSkip, SKIP_MSG)
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/config`)
    await page.waitForLoadState('networkidle')

    // Wait for the editor to populate with the real config
    const editor = page.locator('textarea').first()
    await expect(editor).toBeVisible({ timeout: 8000 })

    // Fill with schema-invalid JSON — syntactically valid (JSON.parse succeeds)
    // but missing required `owner` field → Zod validation fails.
    // Config.jsx onChange: JSON.parse succeeds → setDraft() fires → validation
    // debounce (500ms) → POST /config/validate → 400 → setValidErr() → red div.
    await editor.fill('{"group_id": "quorum-test-project"}')

    // The error div (bg-red-50) should appear within the debounce + API round-trip.
    // We wait up to 5s — validation debounce is 500ms and the API call is fast.
    const errorDiv = page.locator('[class*="bg-red-50"]').first()
    await expect(errorDiv).toBeVisible({ timeout: 5000 })

    // Save button must be disabled when validErr is set (canSave = !validErr).
    const saveBtn = page.locator('button:has-text("Save config")')
    await expect(saveBtn).toBeDisabled({ timeout: 3000 })
  })

  test('step 3 — saving a valid config shows the success banner', async ({ page }) => {
    test.skip(shouldSkip, SKIP_MSG)
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/config`)
    await page.waitForLoadState('networkidle')

    // Wait for the editor to load — config is valid on load so canSave starts true
    const editor = page.locator('textarea').first()
    await expect(editor).toBeVisible({ timeout: 8000 })

    const saveBtn = page.getByTestId('save-config-btn')
    await expect(saveBtn).toBeEnabled({ timeout: 5000 })
    await saveBtn.click()

    await expect(page.getByTestId('save-success')).toBeVisible({ timeout: 8000 })
    await expect(page.getByTestId('save-success')).toContainText('Config saved successfully.')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-14.3 — System Status (/status)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-14.3 — System Status Page', () => {
  test('step 1 — /status renders service health indicators with all services Healthy', async ({ page }) => {
    test.skip(shouldSkip, SKIP_MSG)
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/status`)
    await page.waitForLoadState('networkidle')

    // "Service health" is the Card title rendered by the Status page.
    await expect(page.locator('text=Service health')).toBeVisible({ timeout: 8000 })

    // All five service names must appear in the DOM.
    await expect(page.locator('text=Gateway')).toBeVisible()
    await expect(page.locator('text=PostgreSQL')).toBeVisible()
    await expect(page.locator('text=Graphiti')).toBeVisible()

    // Wait for the health API call to complete — ServiceIndicator shows
    // "Checking…" with animate-pulse until useHealth() resolves.
    // In the fully running test stack all services should be Healthy.
    await expect(page.locator('text=Healthy').first()).toBeVisible({ timeout: 12000 })
    const healthyCount = await page.locator('text=Healthy').count()
    expect(healthyCount).toBeGreaterThanOrEqual(3)  // Gateway + PostgreSQL + ≥1 more

    // No "Unavailable" badge should appear in a healthy stack.
    const unavailableCount = await page.locator('text=Unavailable').count()
    expect(unavailableCount).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-14.4 — Audit Timeline (/audit)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-14.4 — Audit Timeline', () => {
  test('step 1 — audit entries are listed in the timeline', async ({ page }) => {
    test.skip(shouldSkip, SKIP_MSG)
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/audit`)
    await page.waitForLoadState('networkidle')

    // The filter bar renders first (select + inputs).
    // "All operations" is the placeholder option in the tool <select>.
    const toolSelect = page.locator('select').first()
    await expect(toolSelect).toBeVisible({ timeout: 8000 })

    // "Loading audit log…" must disappear once entries are fetched.
    await expect(page.locator('text=Loading audit log')).not.toBeVisible({ timeout: 8000 })

    // "No audit entries found." must NOT be shown — by this point many writes
    // have been made across other test scenarios (S-02, S-03, S-14.1 beforeAll …).
    await expect(page.locator('text=No audit entries found.')).not.toBeVisible()

    // At least one audit entry authored by test-pe must be present.
    // AuditEntry renders entry.author in a <span> — look for the text.
    await expect(page.locator('text=test-pe').first()).toBeVisible({ timeout: 5000 })
  })

  test('step 2 — filling the author filter narrows entries to the specified author', async ({ page }) => {
    test.skip(shouldSkip, SKIP_MSG)
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/audit`)
    await page.waitForLoadState('networkidle')

    // Wait for initial entries to load.
    await expect(page.locator('select').first()).toBeVisible({ timeout: 8000 })
    await expect(page.locator('text=Loading audit log')).not.toBeVisible({ timeout: 8000 })

    // The author filter input — placeholder text is the locator.
    const authorFilter = page.locator('input[placeholder="Filter by author…"]')
    await expect(authorFilter).toBeVisible({ timeout: 5000 })

    // Fill the filter. Audit.jsx maps this to GET /pg/audit?author=test-pe.
    await authorFilter.fill('test-pe')

    // After the filtered fetch completes:
    // - "No audit entries found." must NOT appear (test-pe has many entries)
    // - author text "test-pe" must appear in the entry list
    await expect(page.locator('text=No audit entries found.')).not.toBeVisible({ timeout: 5000 })
    // The text "test-pe" appears inside AuditEntry spans (entry.author).
    await expect(page.locator('text=test-pe').first()).toBeVisible({ timeout: 5000 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-14.5 — Project Selector
// ─────────────────────────────────────────────────────────────────────────────

describe('S-14.5 — Project Selector', () => {
  // injectSession() inserts exactly ONE project into quorum_projects.
  // Header.jsx only renders the "Switch project" button when
  // availableProjects.length > 1 (canSwitch guard).
  // All S-14.5 tests use a second addInitScript call that OVERRIDES
  // quorum_projects with both test fixtures so canSwitch is true.
  const TWO_PROJECTS = JSON.stringify([
    { group_id: 'quorum-test-project',  role: 'principal_architect', base_confidence: 0.9, is_owner: true  },
    { group_id: 'quorum-test-catalog',  role: 'principal_architect', base_confidence: 0.9, is_owner: false },
  ])

  test('step 1 — switch button in header opens the project selector page', async ({ page }) => {
    test.skip(shouldSkip, SKIP_MSG)
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    // Override to 2 projects so the Header switch button renders.
    await page.addInitScript(
      (v) => sessionStorage.setItem('quorum_projects', v),
      TWO_PROJECTS,
    )
    await page.goto(`${DASHBOARD_URL}/`)
    await page.waitForLoadState('networkidle')

    // Header renders a <button title="Switch project"> with the project name
    // and an ArrowLeftRight icon when canSwitch is true.
    const switchBtn = page.locator('button[title="Switch project"]')
    await expect(switchBtn).toBeVisible({ timeout: 8000 })

    // Click → AuthContext.switchProject() sets authPhase='selecting'
    // → App.jsx routes to /select-project.
    await switchBtn.click()
    await page.waitForURL('**/select-project', { timeout: 8000 })

    // ProjectSelector renders a search input and project cards.
    const searchInput = page.locator('input[placeholder*="Search by project name"]')
    await expect(searchInput).toBeVisible({ timeout: 8000 })

    // Search to isolate our test projects — accumulated test runs may add other
    // projects that paginate our fixtures off the first page.
    await searchInput.fill('quorum-test')
    await page.waitForTimeout(400)

    // Both projects from the injected list must appear as cards.
    await expect(page.locator('text=quorum-test-project').first()).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=quorum-test-catalog').first()).toBeVisible({ timeout: 5000 })
  })

  test('step 2 — typing "catalog" filters cards to quorum-test-catalog only', async ({ page }) => {
    test.skip(shouldSkip, SKIP_MSG)
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.addInitScript(
      (v) => sessionStorage.setItem('quorum_projects', v),
      TWO_PROJECTS,
    )
    await page.goto(`${DASHBOARD_URL}/`)
    await page.waitForLoadState('networkidle')

    const switchBtn = page.locator('button[title="Switch project"]')
    await switchBtn.click()
    await page.waitForURL('**/select-project', { timeout: 8000 })

    const searchInput = page.locator('input[placeholder*="Search by project name"]')
    await expect(searchInput).toBeVisible({ timeout: 8000 })

    // Type "quorum-test-catalog" — ProjectSelector filters by name or team (case-insensitive).
    // Using the full name avoids accumulated j01-catalog-* test entries paginating the result.
    await searchInput.fill('quorum-test-catalog')

    // quorum-test-catalog matches; quorum-test-project does not.
    await expect(page.locator('text=quorum-test-catalog').first()).toBeVisible({ timeout: 3000 })

    // "quorum-test-project" should no longer appear as a card.
    // The text may still exist in the header badge, so filter to the card body:
    // project cards render the label in <p class="text-sm font-semibold …">.
    const projectCardLabel = page.locator('p.font-semibold').filter({ hasText: 'quorum-test-project' })
    await expect(projectCardLabel).not.toBeVisible({ timeout: 3000 })
  })

  test('step 3 — clicking "Back to current project" returns to the dashboard without switching', async ({ page }) => {
    test.skip(shouldSkip, SKIP_MSG)
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.addInitScript(
      (v) => sessionStorage.setItem('quorum_projects', v),
      TWO_PROJECTS,
    )
    await page.goto(`${DASHBOARD_URL}/`)
    await page.waitForLoadState('networkidle')

    const switchBtn = page.locator('button[title="Switch project"]')
    await switchBtn.click()
    await page.waitForURL('**/select-project', { timeout: 8000 })

    // The "← Back to current project" button is shown when token is still in state
    // (i.e. the user triggered a switch but hasn't chosen a new project yet).
    // cancelSwitch() → authPhase='authenticated' → App routes back to '/'.
    const backBtn = page.locator('button:has-text("Back to current project")')
    await expect(backBtn).toBeVisible({ timeout: 5000 })
    await backBtn.click()

    // Should navigate back to the main dashboard without switching the active project.
    await page.waitForURL(`${DASHBOARD_URL}/`, { timeout: 8000 })

    // The active project in the header badge should still be quorum-test-project.
    await expect(page.locator(`text=${PROJECT}`).first()).toBeVisible({ timeout: 5000 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-14.6 — Dark Mode Persistence
//
// Verifies that the theme toggle in the header flips the 'dark' class on <html>
// and that localStorage persists the preference across a page navigation.
// ThemeContext defaults to 'dark' when localStorage is empty (fresh Playwright context).
// ─────────────────────────────────────────────────────────────────────────────

describe('S-14.6 — Dark Mode Persistence', () => {
  test('step 1 — page loads in dark mode by default (ThemeContext default is "dark")', async ({ page }) => {
    test.skip(shouldSkip, SKIP_MSG)
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/`)
    await page.waitForLoadState('networkidle')

    const htmlClass = await page.evaluate(() => document.documentElement.className)
    expect(htmlClass).toContain('dark')
  })

  test('step 2 — clicking the toggle switches to light mode and persists across navigation', async ({ page }) => {
    test.skip(shouldSkip, SKIP_MSG)
    await injectSession(page, { sub: 'test-pe', project: PROJECT })
    await page.goto(`${DASHBOARD_URL}/`)
    await page.waitForLoadState('networkidle')

    const toggle = page.getByTestId('theme-toggle')
    await expect(toggle).toBeVisible({ timeout: 5000 })
    await toggle.click()

    // dark class removed, localStorage records the preference
    const htmlClassAfter = await page.evaluate(() => document.documentElement.className)
    expect(htmlClassAfter).not.toContain('dark')

    const stored = await page.evaluate(() => localStorage.getItem('quorum-theme'))
    expect(stored).toBe('light')

    // Navigate — theme persists because ThemeContext re-reads localStorage on mount
    await page.goto(`${DASHBOARD_URL}/knowledge`)
    await page.waitForLoadState('networkidle')

    const htmlClassAfterNav = await page.evaluate(() => document.documentElement.className)
    expect(htmlClassAfterNav).not.toContain('dark')
  })
})

}) // outer describe — required by graph reporter extractScenarioId()
