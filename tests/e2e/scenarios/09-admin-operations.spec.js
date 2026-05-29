/**
 * S-09 — Platform Admin Operations (J09)
 *
 * Journey: J09 — Platform Admin Operations
 * Pillars: Functional Correctness (S-09.1, S-09.2, S-09.3)
 *          Validation Guards      (S-09.4)
 *          Dashboard Visibility   (S-09.5 — browser-only)
 *          User Profile           (S-09.6)
 *
 * Sub-scenarios:
 *   S-09.1  Admin config — GET /admin/config (admin-only, PE blocked)
 *   S-09.2  User management — add/remove admin users
 *   S-09.3  Project listing — GET /admin/projects returns all projects
 *   S-09.4  Reason guard — short reason on admin/users → 400 REASON_REQUIRED
 *   S-09.5  Dashboard admin panel visible only with is_admin:true JWT (browser)
 *   S-09.6  User profile — GET /user/profile/:username (any authenticated user)
 *   S-09.7  Admin filtered audit log — GET /pg/audit?tool=role_update (GAP-021)
 *   S-09.8  Project archive — DELETE /admin/projects/:groupId soft-archives; guards 400+403 (GAP-022)
 *
 * Architecture notes:
 *   Admin routes (/admin/*) gate on req.user.is_admin (from JWT is_admin claim).
 *   Principal_architect role does NOT grant admin access.
 *   POST /admin/users calls enforceReasonRequired → ConstitutionalViolation → 400 { rule, message }.
 *   POST /auth/refresh (verifyJwt middleware) issues a fresh JWT without calling GitHub.
 *   GET /user/profile/:username resolves from Redis cache → DDB on miss.
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }                      from '../helpers/api.js'
import { tokens }                   from '../helpers/jwt.js'
import { injectSession, DASHBOARD_URL } from '../helpers/browser.js'

const PROJECT = 'quorum-test-project'
const CATALOG = 'quorum-test-catalog'

// Unique throwaway project for S-09.8 archive test — never conflicts with other runs.
const THROWAWAY_PROJECT = `s09-archive-test-${Date.now()}`

// All admin state mutations are sequential; serial prevents race conditions.
test.describe.configure({ mode: 'serial' })

// Unique username for add/remove so parallel runs don't conflict.
const NEW_ADMIN = `test-new-admin-s09-${Date.now()}`

describe('S-09 — Admin Operations', () => {

// ─────────────────────────────────────────────────────────────────────────────
// S-09.1 — Admin Config
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.1 — Admin Config', () => {
  test('step 1 — GET /admin/config as admin returns 200 with admins list', async () => {
    const client = api(tokens.admin, PROJECT)
    const res = await client.get('/admin/config')
    expect(res.status).toBe(200)
    expect(res.data).toHaveProperty('admins')
    expect(Array.isArray(res.data.admins)).toBe(true)
  })

  test('step 2 — GET /admin/config as PA (not admin) returns 403', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/admin/config')
    expect(res.status).toBe(403)
    expect(res.data.error).toBe('forbidden')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-09.2 — User Management
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.2 — User Management', () => {
  test('step 1 — POST /admin/users add → user appears in admin list', async () => {
    const client = api(tokens.admin, PROJECT)
    const res = await client.post('/admin/users', {
      action:          'add',
      github_username: NEW_ADMIN,
      reason:          'Platform expansion requires additional administrator for team coverage',
    })
    expect(res.status).toBe(200)

    // Verify the user now appears in the admin config
    const configRes = await client.get('/admin/config')
    expect(configRes.status).toBe(200)
    const admins = configRes.data.admins ?? []
    expect(admins.some(a => a.github_username === NEW_ADMIN)).toBe(true)
  })

  test('step 2 — POST /admin/users remove → user no longer in admin list', async () => {
    const client = api(tokens.admin, PROJECT)
    const res = await client.post('/admin/users', {
      action:          'remove',
      github_username: NEW_ADMIN,
      reason:          'Admin removed after team restructure completed in Q3',
    })
    expect(res.status).toBe(200)

    // Verify removal took effect
    const configRes = await client.get('/admin/config')
    expect(configRes.status).toBe(200)
    const admins = configRes.data.admins ?? []
    expect(admins.some(a => a.github_username === NEW_ADMIN)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-09.3 — Project Listing
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.3 — Project Listing', () => {
  test('step 1 — GET /admin/projects returns both test projects', async () => {
    const client = api(tokens.admin, PROJECT)
    const res = await client.get('/admin/projects')
    expect(res.status).toBe(200)

    // Response is an array of project objects or an object with a projects array.
    const projects = Array.isArray(res.data) ? res.data : (res.data.projects ?? [])
    const ids = projects.map(p => p.group_id ?? p.id ?? p.project_id ?? p)

    expect(ids).toContain(PROJECT)
    expect(ids).toContain(CATALOG)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-09.4 — Reason Guard
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.4 — Reason Guard on Admin User Management', () => {
  test('step 1 — POST /admin/users with reason < 10 chars → 400 REASON_REQUIRED', async () => {
    const client = api(tokens.admin, PROJECT)
    const res = await client.post('/admin/users', {
      action:          'add',
      github_username: 'someone-s09',
      reason:          'short',
    })
    expect(res.status).toBe(400)
    expect(res.data.rule).toBe('REASON_REQUIRED')
  })

  test('step 2 — POST /admin/users with placeholder reason → 400 REASON_REQUIRED', async () => {
    const client = api(tokens.admin, PROJECT)
    // "yes" is a placeholder pattern in PLACEHOLDER_PATTERNS — 3 chars but matches pattern
    const res = await client.post('/admin/users', {
      action:          'add',
      github_username: 'someone-s09',
      reason:          'yes',
    })
    expect(res.status).toBe(400)
    expect(res.data.rule).toBe('REASON_REQUIRED')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-09.5 — Dashboard Admin Panel (browser-only)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.5 — Dashboard Admin Panel Visibility', () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// S-09.6 — User Profile Endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.6 — User Profile', () => {
  test('step 1 — GET /user/profile/test-pe returns profile with required fields', async () => {
    // Any authenticated user can read any user profile
    const client = api(tokens.engineer, PROJECT)
    const res = await client.get('/user/profile/test-pe')
    expect(res.status).toBe(200)
    expect(res.data.github_username).toBe('test-pe')
    expect(typeof res.data.role === 'string' || res.data.role === null).toBe(true)
    // base_confidence is resolved from a project context; may be null if no project in header
    // The profile object must at minimum carry github_username and is_admin
    expect(typeof res.data.is_admin).toBe('boolean')
    expect(Array.isArray(res.data.projects)).toBe(true)
    // test-pe is a member of at least quorum-test-project
    const testProjectMembership = res.data.projects.find(p => p.group_id === PROJECT)
    expect(testProjectMembership).toBeTruthy()
    expect(testProjectMembership.role).toBe('principal_architect')
  })

  test('step 2 — GET /user/profile/:nonexistent returns 404 (not 500)', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.get('/user/profile/user-does-not-exist-s09-xyz')
    expect(res.status).toBe(404)
    expect(res.data.error).toBe('profile_not_found')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-09.7 — Admin Filtered Audit Log (GAP-021)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.7 — Admin Filtered Audit Log', () => {
  // GAP-021: Governance operations (role_update, admin_add) write to the shared
  // audit_log table. role_update is project-scoped so it is queryable via
  // GET /pg/audit?tool=role_update — giving admins an isolated governance event view.
  //
  // admin_add/admin_remove have project=null and are NOT in the project-scoped log.
  // That is intentional — platform-level events are cross-project by nature.

  test('step 1 — POST /config/update-role writes a role_update audit entry', async () => {
    // Change test-architect from architect → senior (then restore in step 3).
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/config/update-role', {
      github_username: 'test-architect',
      role:            'senior',
      reason:          'S-09.7 audit coverage test — role will be restored in step 3.',
    })
    expect(res.status).toBe(200)
    expect(res.data.ok).toBe(true)
  })

  test('step 2 — GET /pg/audit?tool=role_update returns the governance audit entry', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/audit?tool=role_update')
    expect(res.status).toBe(200)
    const entries = res.data.entries ?? []
    expect(entries.length).toBeGreaterThan(0)
    const entry = entries[0]
    // Governance entries share the same audit shape as knowledge entries
    expect(entry.tool).toBe('role_update')
    expect(entry.entry_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(typeof entry.chain_position).toBe('string')
  })

  test('step 3 — restore test-architect role to architect', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/config/update-role', {
      github_username: 'test-architect',
      role:            'architect',
      reason:          'S-09.7 cleanup — restoring role to original architect after audit coverage test.',
    })
    expect(res.status).toBe(200)
    expect(res.data.ok).toBe(true)
  })
}) // S-09.7 — Admin Filtered Audit Log

// ─────────────────────────────────────────────────────────────────────────────
// S-09.8 — Project Archive (GAP-022)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.8 — Project Archive', () => {
  // Creates a throwaway project, archives it, and verifies the soft-delete response.
  // DELETE /admin/projects/:groupId is intentionally admin/dashboard-only (no MCP tool).

  beforeAll(async () => {
    // Upload a minimal throwaway config so the project exists in q_projects.
    // Uses tokens.pe (principal_architect in quorum-test-project) — authUpload passes on role check.
    // Config sent as root body (not wrapped) — QuorumConfigSchema.safeParse(req.body) expects this.
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/config/upload', {
      group_id:    THROWAWAY_PROJECT,
      owner:       'test-pe',
      project:     'S-09.8 Throwaway Archive Test',
      members: [{ name: 'Test PE', github_username: 'test-pe', role: 'principal_architect', base_confidence: 0.8, team: 'platform' }],
    })
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`S-09.8 beforeAll: config upload failed with ${res.status}: ${JSON.stringify(res.data)}`)
    }
  })

  test('step 1 — DELETE /admin/projects/:groupId with short reason → 400', async () => {
    const client = api(tokens.admin, PROJECT)
    const res = await client.delete(`/admin/projects/${THROWAWAY_PROJECT}`, { data: { reason: 'short' } })
    expect(res.status).toBe(400)
    expect(res.data.rule).toBe('REASON_REQUIRED')
  })

  test('step 2 — DELETE /admin/projects/:groupId as non-admin → 403', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.delete(`/admin/projects/${THROWAWAY_PROJECT}`, {
      data: { reason: 'Attempting archive without admin privileges — should be blocked.' },
    })
    expect(res.status).toBe(403)
  })

  test('step 3 — admin archives throwaway project → 200 with archived:true', async () => {
    const client = api(tokens.admin, PROJECT)
    const res = await client.delete(`/admin/projects/${THROWAWAY_PROJECT}`, {
      data: { reason: 'S-09.8 cleanup — archiving throwaway project created for archive test.' },
    })
    expect(res.status).toBe(200)
    expect(res.data.archived).toBe(true)
    expect(res.data.group_id).toBe(THROWAWAY_PROJECT)
    expect(res.data.archived_by).toBe('test-admin')
    expect(typeof res.data.versions_deprecated).toBe('number')
  })

  test('step 4 — archiving an already-archived project → 404', async () => {
    const client = api(tokens.admin, PROJECT)
    const res = await client.delete(`/admin/projects/${THROWAWAY_PROJECT}`, {
      data: { reason: 'Attempting to archive an already-archived project — should 404.' },
    })
    expect(res.status).toBe(404)
  })
}) // S-09.8 — Project Archive

}) // S-09 — Admin Operations
