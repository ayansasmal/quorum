# Self-Serve Onboarding (Initiative I) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any GitHub-authenticated user obtain a JWT with zero pre-existing project membership, reach a welcoming dashboard, and self-serve onboard their first project via the MCP — while seeding only the initial admins at boot and closing the public-project write hole.

**Architecture:** Decouple JWT issuance from project membership in the two gates that still re-check it at login (the PAT path `/auth/token` and the dashboard OAuth callback). Seed `configs/.quorum` (admins only) idempotently at gateway startup. Add a single write-membership guard so public projects stay read-only for non-members. The MCP self-serve path and the last-admin guard already exist in code — this plan verifies them with tests rather than rebuilding them. The dashboard gains a zero-projects welcome state and an admin add/remove panel.

**Tech Stack:** Node 20 ESM, Express, `jose` (ES256 JWT), `@aws-sdk/client-s3`, Redis (`ioredis`), DynamoDB, Vitest (unit), Playwright (E2E), React 19 + React Router 7 + TanStack Query 5 (dashboard).

---

## Implementation Status - June 13, 2026

Tasks 1-8 are implemented and committed on `prod`. Task 9 test code is
implemented as S-19 plus S-23 because S-20 was already assigned to cross-catalog
search. Playwright discovery passes. Live Docker and browser execution remains
pending because the local command-approval service rejected further escalated
commands after reaching its usage limit. Task 10 documentation reflects that
verification boundary.

---

## Source Spec

[docs/superpowers/specs/2026-06-13-self-serve-onboarding-design.md](../specs/2026-06-13-self-serve-onboarding-design.md). Read §3 (the deadlock), §4 (design), §5 (security gaps G1–G7), §7 (resolved decisions) before starting.

## Decisions locked in the spec (do not re-litigate)

- **G1** — public projects are **read-only** for non-members. Reads open to any authenticated user; writes require a non-null role.
- **G2** — `is_admin` stays in the JWT. TTL is **15 min** (already shipped, commit `469d02f`). No per-request admin resolution.
- **G3** — block removing the last admin (`409 last_admin`). **Already in code.**
- **G4** — accept-and-reclaim namespaces. No new code; admins reclaim via existing `DELETE /admin/projects/:groupId`.

## Out of scope (named so they are not pulled in)

- Initiative II (usage-driven global decay) — separate spec.
- A dashboard project-onboarding form — onboarding is MCP-only.
- A true MCP `refresh_token` grant — future hardening (noted in spec §5 G2).
- `QUORUM_GITHUB_ORG_ALLOWLIST` (G6) — future enterprise knob.

## Cross-package shared-code note

None of these changes touch the vendored `gateway/src/shared/**` files (constitutional, config schema, graph client). The new `require-membership.js` is gateway-only middleware, not vendored. **No quorum-mcp↔gateway shared-copy sync is required by this plan.** If a later edit touches a `shared/` file, apply it to both copies in the same commit per the workspace CLAUDE.md rule.

## File Structure

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `quorum/gateway/src/routes/auth.js` | Modify | Make `project_id` optional on `POST /auth/token`; issue slim JWT with no membership gate |
| `quorum/gateway/src/routes/mcp-oauth.js` | Modify | Dashboard OAuth branch: zero projects → mint slim JWT, not `?error=no_projects` |
| `quorum/gateway/src/config-cache.js` | Modify | Add `ensureAdminConfig()` — idempotent boot-seed of `configs/.quorum` |
| `quorum/gateway/src/server.js` | Modify | Call `ensureAdminConfig()` in startup step 3 |
| `quorum/gateway/src/middleware/require-membership.js` | Create | Reject mutating requests from non-members (`role === null && !is_admin`) — G1 |
| `quorum/gateway/src/routes/pg.js` | Modify | Mount `requireMembership` write guard |
| `quorum/gateway/src/routes/dashboard.js` | Modify | Mount `requireMembership` write guard |
| `quorum/tests/gateway/auth.test.js` | Modify | No-`project_id` → 200 slim JWT |
| `quorum/tests/gateway/admin-last-guard.test.js` | Create | G3 verification (last-admin + self-demotion) |
| `quorum/tests/gateway/require-membership.test.js` | Create | G1 unit test for the guard |
| `quorum/tests/gateway/ensure-admin-config.test.js` | Create | Boot-seed idempotency |
| `quorum/tests/e2e/scenarios/19-auth-lifecycle.spec.js` | Modify | Drop the 403-on-non-member assertion; add no-project 200 |
| `quorum/tests/e2e/scenarios/23-self-serve-onboarding.spec.js` | Create | S-23 cold-start onboarding + G1 public read-only |
| `quorum-dash/src/context/AuthContext.jsx` | Modify | Zero projects → `authenticated` with null project (keep JWT) |
| `quorum-dash/src/pages/NoProjects.jsx` | Create | Welcome/empty screen |
| `quorum-dash/src/App.jsx` | Modify | Route null-project users to `NoProjects` |
| `quorum-dash/src/api/admin.js` | Create or Modify | `listAdmins()` / `addAdmin()` / `removeAdmin()` clients |
| `quorum-dash/src/pages/Admin.jsx` | Modify | Add/remove admin UI |
| `quorum/gateway/openapi.yaml` | Modify | `project_id` optional; document membership-on-write |
| Various `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md` | Modify | Reflect the new auth + onboarding flow |

## Build Order (task dependency)

Tasks 1–5 are gateway and independent of each other except where noted; do them first because everything else depends on the auth unlock. Task 6 (MCP verify) needs Task 1 + a running stack. Tasks 7–8 (dashboard) need Task 2. Task 9 (E2E) needs Tasks 1–4. Task 10 (docs) last.

---

## Task 1: Gateway — make `project_id` optional on `POST /auth/token`

Removes deadlock gate #1. A GitHub-authenticated user with no project gets a slim `{ sub, is_admin }` JWT. When `project_id` IS supplied, the response is still enriched with role/team but membership never gates issuance.

**Files:**
- Modify: `quorum/gateway/src/routes/auth.js:83-136`
- Test: `quorum/tests/gateway/auth.test.js`

- [ ] **Step 1: Write the failing test** — append to `quorum/tests/gateway/auth.test.js` (inside the existing top-level `describe` for `/auth/token`; mirror the existing GitHub-mock setup used by the file — reuse whatever `vi.stubGlobal('fetch', ...)` / nock helper the neighbouring tests use to make `verifyGitHubToken` return login `alice`):

```javascript
test('POST /auth/token with no project_id → 200 slim JWT (no membership gate)', async () => {
  // GitHub mock resolves login "alice" via the file's existing fetch stub.
  const res = await request(app)
    .post('/auth/token')
    .send({ github_token: 'gho_valid' })   // intentionally NO project_id
  expect(res.status).toBe(200)
  expect(res.body.sub).toBe('alice')
  expect(typeof res.body.token).toBe('string')
  expect(res.body.token.split('.').length).toBe(3)
  expect(res.body.expires_in).toBe(900)
  expect(res.body.project).toBeNull()
  expect(res.body.role).toBeNull()
  expect(res.body.member_found).toBe(false)
  expect(res.body.is_admin).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd quorum && npx vitest run tests/gateway/auth.test.js -t "no project_id"`
Expected: FAIL — currently returns `400 missing_param` ("project_id required").

- [ ] **Step 3: Write minimal implementation** — replace the `POST /auth/token` handler body in `quorum/gateway/src/routes/auth.js` (lines 83-136) with this. The change: drop the `project_id` 400, make config-load + membership conditional on `project_id` being present, and never 403:

```javascript
// POST /auth/token
router.post('/token', async (req, res) => {
  const { github_token, project_id } = req.body ?? {}

  if (!github_token) return res.status(400).json({ error: 'missing_param', message: 'github_token required' })

  let githubLogin
  try {
    githubLogin = await verifyGitHubToken(github_token)
  } catch (err) {
    return res.status(401).json({ error: 'github_auth_failed', message: err.message })
  }

  // Membership is no longer a gate. project_id only enriches the response.
  let config = null
  let member = null
  if (project_id) {
    try {
      config = await loadProjectConfig(project_id)
      member = findMember(config, githubLogin)
    } catch {
      // Unknown/unloadable project → still issue the JWT; just don't enrich.
      config = null
      member = null
    }
  }

  const isAdmin = await isPlatformAdmin(githubLogin)
  const token   = await issueToken(githubLogin, isAdmin)

  const role           = member?.role ?? null
  const team           = member?.team ?? null
  const baseConfidence = role && config?.roles?.[role] ? config.roles[role].base_confidence : 0.5
  const slug           = config?.group_id ?? project_id ?? null

  res.json({
    token,
    expires_in:      TOKEN_TTL_SECONDS,
    sub:             githubLogin,
    project:         slug,
    role,
    team,
    base_confidence: baseConfidence,
    is_admin:        isAdmin,
    member_found:    member !== null,
  })
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd quorum && npx vitest run tests/gateway/auth.test.js`
Expected: PASS — the new test plus all existing `/auth/token` tests. The existing "member" test still passes because `project_id` enrichment is unchanged when supplied.

- [ ] **Step 5: Check for a now-stale assertion** — the existing suite may assert `403 not_a_member` when a non-member supplies a `project_id`. With the new behaviour that path returns **200** with `member_found: false`. Find it:

Run: `cd quorum && grep -n "not_a_member\|403" tests/gateway/auth.test.js`
If such an assertion exists, update it to expect `200` + `member_found: false` (membership no longer gates; the per-request `verify-jwt` guard enforces access on actual data routes).

- [ ] **Step 6: Run full gateway unit suite**

Run: `cd quorum && npm run test:gateway`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd quorum
git add gateway/src/routes/auth.js tests/gateway/auth.test.js
git commit -m "feat(auth): make project_id optional on /auth/token (remove membership gate)"
```

---

## Task 2: Gateway — dashboard OAuth callback mints a JWT for zero projects

Removes deadlock gate #2. Today the dashboard branch redirects `?error=no_projects` and never mints a token ([mcp-oauth.js:271-273](../../gateway/src/routes/mcp-oauth.js#L271-L273)). Change it to mint a slim JWT and land on the welcome screen.

**Files:**
- Modify: `quorum/gateway/src/routes/mcp-oauth.js:271-273`
- Test: covered by E2E in Task 9 (no unit harness exists for the OAuth redirect; a focused unit test is impractical because the handler depends on live GitHub + DDB). Verify manually in Step 3.

- [ ] **Step 1: Implement** — in `quorum/gateway/src/routes/mcp-oauth.js`, replace the zero-projects early return inside the `if (isDashboard)` branch:

```javascript
    if (projects.length === 0) {
      return res.redirect(`${cfg.dashboardUrl}/login?error=no_projects`)
    }
```

with a slim-JWT mint that mirrors the multi-project pre-auth claims but uses the normal token TTL (so the dashboard can operate in a null-project state):

```javascript
    if (projects.length === 0) {
      const { privateKey, kid } = getKeys()
      const isAdmin = await isPlatformAdmin(githubLogin)
      const jwt = await new SignJWT({
        sub:             githubLogin,
        is_admin:        isAdmin,
        project:         null,
        role:            null,
        team:            null,
        method:          'oauth2_web',
        base_confidence: 0,
      })
        .setProtectedHeader({ alg: 'ES256', kid })
        .setIssuedAt()
        .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
        .setIssuer('quorum-gateway')
        .sign(privateKey)
      return res.redirect(`${cfg.dashboardUrl}/login#token=${jwt}`)
    }
```

`getKeys`, `SignJWT`, `isPlatformAdmin`, and `TOKEN_TTL_SECONDS` are already imported/defined in this file (the single- and multi-project branches use them just below). No new imports.

- [ ] **Step 2: Lint/typecheck the file compiles**

Run: `cd quorum && node --check gateway/src/routes/mcp-oauth.js`
Expected: no output (syntax OK).

- [ ] **Step 3: Manual smoke (optional but recommended)** — with a dev stack up (`npm run dev:gateway` + LocalStack seeded), hit the dashboard OAuth flow with a GitHub account that is in **no** project config. Expected: redirect to `…/login#token=<jwt>` (a real JWT fragment), **not** `?error=no_projects`. Decode the JWT at jwt.io style locally and confirm `project: null`. (This is exercised automatically by the E2E in Task 9; skip if running headless-only.)

- [ ] **Step 4: Commit**

```bash
cd quorum
git add gateway/src/routes/mcp-oauth.js
git commit -m "feat(auth): mint slim jwt for zero-project users in dashboard oauth callback"
```

---

## Task 3: Gateway — idempotent admin boot-seed

Seed `configs/.quorum` once at startup from `QUORUM_FIRST_ADMIN` (comma-separated). Idempotent and atomic via S3 conditional write so concurrent gateway instances cannot double-seed.

**Files:**
- Modify: `quorum/gateway/src/config-cache.js` (add `ensureAdminConfig`, near `saveAdminConfig`)
- Modify: `quorum/gateway/src/server.js:272-282` (call it in startup step 3)
- Test: `quorum/tests/gateway/ensure-admin-config.test.js` (Create)

- [ ] **Step 1: Write the failing test** — create `quorum/tests/gateway/ensure-admin-config.test.js`. Mock the S3 + Redis layer the same way the repo's other `config-cache` tests do (search `tests/gateway` for an existing `config-cache` or `loadAdminConfig` test and copy its mock setup; if none exists, mock `@aws-sdk/client-s3` `S3Client.prototype.send` and `../src/redis.js` `getRedis`). The behaviours under test:

```javascript
import { describe, test, expect, vi, beforeEach } from 'vitest'

// NOTE: adapt these mocks to match the file's existing config-cache test style.
// The key behaviours asserted are: seeds when absent, skips when present,
// parses a comma-separated QUORUM_FIRST_ADMIN, no-ops when unconfigured.

describe('ensureAdminConfig', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.QUORUM_CONFIG_BUCKET = 'test-bucket'
    delete process.env.QUORUM_FIRST_ADMIN
  })

  test('no-ops when QUORUM_FIRST_ADMIN is unset', async () => {
    const { ensureAdminConfig } = await import('../../gateway/src/config-cache.js')
    const result = await ensureAdminConfig()
    expect(result.seeded).toBe(false)
    expect(result.reason).toBe('not_configured')
  })

  test('seeds a single admin when config is absent', async () => {
    process.env.QUORUM_FIRST_ADMIN = 'alice'
    // mock loadAdminConfig → null (absent) and capture the PutObject body
    const { ensureAdminConfig } = await import('../../gateway/src/config-cache.js')
    const result = await ensureAdminConfig()
    expect(result.seeded).toBe(true)
    expect(result.count).toBe(1)
    // assert the written body had admins: [{ github_username: 'alice', added_by: 'boot-seed' }]
  })

  test('parses comma-separated admins and trims whitespace', async () => {
    process.env.QUORUM_FIRST_ADMIN = 'alice, bob ,carol'
    const { ensureAdminConfig } = await import('../../gateway/src/config-cache.js')
    const result = await ensureAdminConfig()
    expect(result.seeded).toBe(true)
    expect(result.count).toBe(3)
  })

  test('is idempotent — skips when config already present', async () => {
    process.env.QUORUM_FIRST_ADMIN = 'alice'
    // mock loadAdminConfig → { admins: [{ github_username: 'existing' }] }
    const { ensureAdminConfig } = await import('../../gateway/src/config-cache.js')
    const result = await ensureAdminConfig()
    expect(result.seeded).toBe(false)
    expect(result.reason).toBe('already_exists')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd quorum && npx vitest run tests/gateway/ensure-admin-config.test.js`
Expected: FAIL — `ensureAdminConfig is not a function`.

- [ ] **Step 3: Implement `ensureAdminConfig`** — add to `quorum/gateway/src/config-cache.js` immediately after `saveAdminConfig` (around line 289). It checks the cached/loaded config first (fast path), then does an atomic conditional `PutObject` (`IfNoneMatch: '*'`) so only one instance wins the cold-start race:

```javascript
/**
 * Idempotently seed the platform admin config (configs/.quorum) at boot.
 *
 * Writes exactly once, from QUORUM_FIRST_ADMIN (comma-separated GitHub
 * usernames). Atomic across instances via S3 conditional write
 * (IfNoneMatch: '*') — a concurrent second writer gets PreconditionFailed
 * and treats it as already-seeded. Never overwrites an existing config.
 *
 * @returns {Promise<{ seeded: boolean, count?: number, reason?: string }>}
 */
export async function ensureAdminConfig() {
  const bucket     = process.env.QUORUM_CONFIG_BUCKET
  const firstAdmin = process.env.QUORUM_FIRST_ADMIN
  if (!bucket || !firstAdmin) return { seeded: false, reason: 'not_configured' }

  // Fast path: already seeded (cached or in S3).
  const existing = await loadAdminConfig()
  if (existing) return { seeded: false, reason: 'already_exists' }

  const usernames = firstAdmin.split(',').map((s) => s.trim()).filter(Boolean)
  if (usernames.length === 0) return { seeded: false, reason: 'not_configured' }

  const now    = new Date().toISOString()
  const config = {
    admins:     usernames.map((u) => ({ github_username: u, added_at: now, added_by: 'boot-seed' })),
    version:    1,
    created_at: now,
  }

  try {
    await getS3().send(new PutObjectCommand({
      Bucket:      bucket,
      Key:         ADMIN_S3_KEY,
      Body:        JSON.stringify(config, null, 2),
      ContentType: 'application/json',
      IfNoneMatch: '*', // atomic: only write if the key does not already exist
    }))
  } catch (err) {
    // Another instance won the race (or the store created it between our
    // load and put). Treat as already-seeded — never an error.
    if (err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412) {
      return { seeded: false, reason: 'already_exists' }
    }
    throw err
  }

  // Bust the admin cache so the very next isPlatformAdmin() sees the seed.
  const redis = getRedis()
  await redis.del('admin:platform').catch(() => {})

  return { seeded: true, count: usernames.length }
}
```

`getS3`, `PutObjectCommand`, `ADMIN_S3_KEY`, `loadAdminConfig`, and `getRedis` are all already in scope in this file. No new imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd quorum && npx vitest run tests/gateway/ensure-admin-config.test.js`
Expected: PASS (4 tests). If LocalStack/S3 mock doesn't honour `IfNoneMatch`, the `already_exists` fast-path (loadAdminConfig) still makes the idempotency test pass; the conditional put is belt-and-suspenders for multi-instance prod.

- [ ] **Step 5: Wire into startup** — in `quorum/gateway/src/server.js`, replace startup step 3 (lines 272-282) so it seeds before loading:

```javascript
  // 3. Seed platform admin config (idempotent) then load it into Redis.
  try {
    const { ensureAdminConfig } = await import('./config-cache.js')
    const seed = await ensureAdminConfig()
    if (seed.seeded) {
      console.error(`[Gateway] ✓ Admin config seeded from QUORUM_FIRST_ADMIN (${seed.count} admin(s))`)
    }
    const adminConfig = await loadAdminConfig()
    if (adminConfig) {
      console.error(`[Gateway] ✓ Admin config loaded (${adminConfig.admins?.length ?? 0} admin(s))`)
    } else {
      console.error('[Gateway] ⚠ Admin config not seeded — set QUORUM_FIRST_ADMIN to bootstrap admins')
    }
  } catch (err) {
    console.error(`[Gateway] Admin config seed/load failed (non-fatal): ${err.message}`)
  }
```

(`loadAdminConfig` is already imported at the top of `server.js`; `ensureAdminConfig` is imported inline to keep the static import list unchanged — match the file's existing inline-import style used in the health probe.)

- [ ] **Step 6: Verify server still boots**

Run: `cd quorum && node --check gateway/src/server.js && node --check gateway/src/config-cache.js`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
cd quorum
git add gateway/src/config-cache.js gateway/src/server.js tests/gateway/ensure-admin-config.test.js
git commit -m "feat(gateway): idempotent admin boot-seed from QUORUM_FIRST_ADMIN"
```

---

## Task 4: Gateway — G1 write-membership guard (public projects read-only)

A single middleware rejects **mutating** requests (POST/PATCH/PUT/DELETE) from non-members (`role === null && !is_admin`), even when `access_denied` is false (the public-project case). Reads are untouched.

**Files:**
- Create: `quorum/gateway/src/middleware/require-membership.js`
- Modify: `quorum/gateway/src/routes/pg.js` (mount after the existing access_denied guard, ~line 138)
- Modify: `quorum/gateway/src/routes/dashboard.js` (mount near the top of the router)
- Test: `quorum/tests/gateway/require-membership.test.js` (Create)

- [ ] **Step 1: Write the failing test** — create `quorum/tests/gateway/require-membership.test.js`:

```javascript
import { describe, test, expect, vi } from 'vitest'
import { requireMembership } from '../../gateway/src/middleware/require-membership.js'

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this },
    json(b)   { this.body = b; return this },
  }
}

describe('requireMembership', () => {
  test('allows GET from a non-member (public read)', () => {
    const req = { method: 'GET', user: { role: null, is_admin: false } }
    const res = mockRes(); const next = vi.fn()
    requireMembership(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(200)
  })

  test('rejects POST from a non-member with 403 not_a_member', () => {
    const req = { method: 'POST', user: { role: null, is_admin: false } }
    const res = mockRes(); const next = vi.fn()
    requireMembership(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
    expect(res.body.error).toBe('not_a_member')
  })

  test('allows POST from a member (has a role)', () => {
    const req = { method: 'POST', user: { role: 'engineer', is_admin: false } }
    const res = mockRes(); const next = vi.fn()
    requireMembership(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  test('allows POST from an admin even with null role', () => {
    const req = { method: 'POST', user: { role: null, is_admin: true } }
    const res = mockRes(); const next = vi.fn()
    requireMembership(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  test('rejects PATCH and DELETE from a non-member', () => {
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const req = { method, user: { role: null, is_admin: false } }
      const res = mockRes(); const next = vi.fn()
      requireMembership(req, res, next)
      expect(res.statusCode).toBe(403)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd quorum && npx vitest run tests/gateway/require-membership.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the guard** — create `quorum/gateway/src/middleware/require-membership.js`:

```javascript
/**
 * Write-membership guard (security gap G1).
 *
 * Public projects are readable by any authenticated user, but writes require
 * membership. verify-jwt.js leaves access_denied=false for public projects, so
 * the per-route access_denied check is not enough to keep non-members from
 * POSTing DRAFTs into a public project. This guard rejects any *mutating*
 * request (POST/PATCH/PUT/DELETE) from a caller with no role, unless they are a
 * platform admin (is_admin bypasses, consistent with verify-jwt.js).
 *
 * Mount AFTER verify-jwt has populated req.user. Reads (GET/HEAD) pass through.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireMembership(req, res, next) {
  const MUTATING = req.method === 'POST' || req.method === 'PATCH' ||
                   req.method === 'PUT'  || req.method === 'DELETE'
  if (!MUTATING) return next()
  if (req.user?.is_admin === true) return next()
  if (req.user?.role == null) {
    return res.status(403).json({
      error:   'not_a_member',
      message: 'Writing to this project requires membership. Public projects are read-only for non-members.',
    })
  }
  next()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd quorum && npx vitest run tests/gateway/require-membership.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Mount in pg.js** — in `quorum/gateway/src/routes/pg.js`, add the guard immediately after the existing access_denied `router.use` block (after line 138, before the `q_project_id` resolver at line 142). Add the import at the top of the file alongside the other imports:

```javascript
import { requireMembership } from '../middleware/require-membership.js'
```

Then after the access_denied block:

```javascript
// G1: public projects are read-only for non-members. Reject writes from a
// roleless (non-member) caller even when access_denied is false (public project).
router.use(requireMembership)
```

- [ ] **Step 6: Mount in dashboard.js** — in `quorum/gateway/src/routes/dashboard.js`, add the same import at the top, then mount the guard once near the top of the router (after the router is created and after any project-scope guard already present, before the route definitions). Add:

```javascript
import { requireMembership } from '../middleware/require-membership.js'
```

```javascript
// G1: dashboard write routes (POST /knowledge, /deviations, /bump, …) require
// membership. Reads (stats, graph, search) remain open to public-project viewers.
router.use(requireMembership)
```

> If `dashboard.js` already has a `router.use` that resolves the project or rejects access_denied, place `requireMembership` directly after it so it sees a populated `req.user.role`.

- [ ] **Step 7: Run full gateway unit suite**

Run: `cd quorum && npm run test:gateway`
Expected: PASS. Watch for any existing test that POSTs to `/pg/*` or `/api/*` with a `role: null` mock user — those represented non-member writes that were previously allowed (as DRAFTs) and must now expect 403, OR the mock must be given a real role. Fix by giving the mock user a role (the realistic case: writers are members).

- [ ] **Step 8: Commit**

```bash
cd quorum
git add gateway/src/middleware/require-membership.js gateway/src/routes/pg.js gateway/src/routes/dashboard.js tests/gateway/require-membership.test.js
git commit -m "feat(security): G1 — public projects read-only for non-members (write-membership guard)"
```

---

## Task 5: Gateway — G3 last-admin guard verification test

The guard already exists ([admin.js:91-93](../../gateway/src/routes/admin.js#L91-L93)). This task pins the behaviour with an explicit test so a future refactor cannot silently remove it, covering both "remove last admin" and "self-demotion when last."

**Files:**
- Create: `quorum/tests/gateway/admin-last-guard.test.js`

- [ ] **Step 1: Write the test** — create `quorum/tests/gateway/admin-last-guard.test.js`. Copy the app + mock bootstrapping from the existing admin test (search `tests/gateway` for a test that drives `POST /admin/users`; reuse its `loadAdminConfig`/`saveAdminConfig` mocks and its admin-authenticated request helper). Assert:

```javascript
// Adapt mocks to the existing admin test harness in tests/gateway.
// Preconditions per test are set by mocking loadAdminConfig's return value.

describe('S-09 last-admin guard', () => {
  test('removing the last admin → 409 last_admin', async () => {
    // loadAdminConfig → { admins: [{ github_username: 'alice' }], version: 1 }
    // request as admin alice: action=remove, github_username=alice, reason=>=10 chars
    // expect res.status 409, res.body.error 'last_admin'
  })

  test('self-demotion when last admin → 409 last_admin', async () => {
    // same precondition; alice removes alice → 409 last_admin
  })

  test('removing a non-last admin → 200 ok', async () => {
    // loadAdminConfig → { admins: [{ github_username: 'alice' }, { github_username: 'bob' }] }
    // alice removes bob → 200, body.ok true, body.action 'remove'
  })

  test('adding an admin is always allowed → 200 ok', async () => {
    // loadAdminConfig → { admins: [{ github_username: 'alice' }] }
    // alice adds bob (reason >= 10 chars) → 200, body.action 'add'
  })
})
```

Fill each test body using the existing admin-test request helper (e.g. `await request(app).post('/admin/users').set('Authorization', `Bearer ${adminJwt}`).send({ action, github_username, reason })`). The `reason` must be ≥10 chars and contain no placeholder pattern (constitutional Rule 3) — use e.g. `'removing duplicate admin entry'`.

- [ ] **Step 2: Run the test**

Run: `cd quorum && npx vitest run tests/gateway/admin-last-guard.test.js`
Expected: PASS without any production change (guard already present). If the "self-demotion when last" case unexpectedly passes through, the guard counts `admins.length === 1` regardless of who is being removed — confirm that matches: with one admin, any remove (including self) hits `length === 1` → 409. ✓

- [ ] **Step 3: Commit**

```bash
cd quorum
git add tests/gateway/admin-last-guard.test.js
git commit -m "test(admin): pin last-admin guard (G3) — block last removal + self-demotion"
```

---

## Task 6: MCP — verify cold-start `authenticate` → `config_upload`

No code change expected: `authenticate`'s `project_id` is already optional and the gateway PKCE callback does not gate on membership. This task adds an integration test proving a never-onboarded user can authenticate and upload their first project config. Per the workspace rule, MCP servers are tested with an MCP client; here we test at the gateway boundary the tool calls.

**Files:**
- Create or extend: `quorum-mcp/tests/tools/authenticate.test.js` (or the existing authenticate test) + `quorum-mcp/tests/tools/config-upload.test.js`

- [ ] **Step 1: Locate the existing tool tests**

Run: `cd quorum-mcp && ls tests/tools/ && grep -rln "authenticate\|config-upload\|config_upload" tests/`
Note the harness style (these are vitest unit tests that mock `../gateway/client.js`).

- [ ] **Step 2: Add a cold-start authenticate test** — assert that `authenticate`'s schema accepts **no** `project_id` and the handler builds an authorize URL **without** a `project_id` query param when none is supplied. Add to the authenticate test file:

```javascript
test('schema accepts empty input (cold-start, no project_id)', () => {
  const parsed = schema.parse({})
  expect(parsed.project_id).toBeUndefined()
})

test('authorize URL omits project_id when none supplied', () => {
  // Build authParams exactly as the handler does and assert no project_id key.
  // (Extract the URLSearchParams construction or assert via a spy on openBrowser.)
  // The handler already does: ...(projectId ? { project_id: projectId } : {})
})
```

> If asserting the authorize URL requires running the full OAuth handler (browser + callback), prefer a narrower unit: import `schema`, parse `{}`, and assert it succeeds — the membership decoupling is the gateway's responsibility (Tasks 1–2), already covered by Task 9's E2E. Do not build flaky browser-driven unit tests.

- [ ] **Step 3: Add a config_upload bootstrap test** — assert that `config-upload` sends the uploaded config to `POST /config/upload` and surfaces the gateway's bootstrap response. Mock the gateway client so `POST /config/upload` returns `{ ok: true, group_id: 'team-x', bootstrapped: true }` and assert the tool reports success. Mirror the existing config-upload test's mock structure.

```javascript
test('uploads a net-new config and reports bootstrap success', async () => {
  // mock gw.uploadConfig (or the fetch it wraps) → { ok: true, group_id: 'team-x', bootstrapped: true }
  // call handler with a minimal valid config where the uploader is listed as principal_architect
  // expect result.status to indicate success and result.group_id === 'team-x'
})
```

- [ ] **Step 4: Run MCP tests**

Run: `cd quorum-mcp && npx vitest run tests/tools/authenticate.test.js tests/tools/config-upload.test.js`
Expected: PASS. If a test reveals the tool actually DOES require `project_id` somewhere (regression vs. the read above), STOP and surface it — that would be a real code gap, not just a test.

- [ ] **Step 5: Commit**

```bash
cd quorum-mcp
git add tests/tools/authenticate.test.js tests/tools/config-upload.test.js
git commit -m "test(mcp): verify cold-start authenticate + config_upload self-serve path"
```

---

## Task 7: Dashboard — zero-projects welcome state

Today `completeOAuth` treats zero projects as an error and discards the JWT ([AuthContext.jsx:331-336](../../../quorum-dash/src/context/AuthContext.jsx#L331-L336)). Keep the JWT, enter `authenticated` with no active project, and render a welcome screen.

**Files:**
- Modify: `quorum-dash/src/context/AuthContext.jsx:331-336`
- Create: `quorum-dash/src/pages/NoProjects.jsx`
- Modify: `quorum-dash/src/App.jsx`
- Test: `quorum-dash/tests/e2e/scenarios/` (browser half) added in Task 9; component-level smoke optional.

- [ ] **Step 1: Update `completeOAuth`** — in `quorum-dash/src/context/AuthContext.jsx`, replace the zero-projects block (lines 331-336):

```javascript
    const projects = userProfile.projects ?? []
    if (projects.length === 0) {
      setError('No projects found. Ask a principal architect to add your GitHub username to a project config.')
      setAuthPhase('unauthenticated')
      pendingPreAuthRef.current = null
      return
    }
```

with: keep the JWT, mark authenticated, no active project:

```javascript
    const projects = userProfile.projects ?? []
    if (projects.length === 0) {
      // Self-serve: a brand-new user with no projects is still authenticated.
      // They land on the NoProjects welcome screen and onboard via the MCP.
      setError(null)
      setAvailableProjects([])
      writeStoredProjects([])
      _applyJwt(jwt, { project: null, role: null, team: null, base_confidence: null })
      pendingPreAuthRef.current = null
      return
    }
```

> Verify `_applyJwt` accepts a null-project profile without throwing. Read `_applyJwt` (around AuthContext.jsx:255-298). If it requires a non-null `project`, add a guard there so a null project sets `selectedProject = null` and still transitions to `'authenticated'`. Show the diff in your commit message if you change `_applyJwt`.

- [ ] **Step 2: Create the welcome screen** — create `quorum-dash/src/pages/NoProjects.jsx`. Match the existing page style (look at `Login.jsx` / `Status.jsx` for the shell, Tailwind classes, and dark-mode tokens used in this repo):

```jsx
/**
 * NoProjects — welcome screen for an authenticated user with zero projects.
 *
 * Self-serve model: onboarding happens through the MCP (quorum config_upload),
 * not a dashboard form. This screen confirms the user is in and points them at
 * their MCP client.
 */
export default function NoProjects() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
        You&apos;re in — no projects yet
      </h1>
      <p className="mt-3 max-w-md text-gray-600 dark:text-gray-300">
        Quorum brings the building; you carry in the books. Onboard your first
        project from your MCP client:
      </p>
      <pre className="mt-4 rounded-md bg-gray-100 px-4 py-3 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-100">
        quorum config_upload
      </pre>
      <p className="mt-4 max-w-md text-sm text-gray-500 dark:text-gray-400">
        Once your project is onboarded, refresh this page and it will appear in
        your project selector.
      </p>
    </div>
  )
}
```

- [ ] **Step 3: Route null-project users to it** — in `quorum-dash/src/App.jsx`, find the auth guard / routing that assumes an active project (look for where `authPhase === 'authenticated'` is handled and where `selectedProject`/active project gates the main shell). Add: when authenticated AND no active project, render `NoProjects` instead of the project-scoped shell. Concretely, import it:

```jsx
import NoProjects from './pages/NoProjects.jsx'
```

and in the authenticated branch, before rendering the project-scoped routes:

```jsx
// Authenticated but no project selected/available → welcome screen.
if (authPhase === 'authenticated' && !activeProject) {
  return <NoProjects />
}
```

> Use whatever the context exposes for "current project" (e.g. `activeProject`, `selectedProject`, or a `useAuth()` field). Read `App.jsx` and `AuthContext.jsx`'s exported value to use the correct name. Ensure this branch sits **after** the `unauthenticated → <Login/>` redirect so a logged-out user still goes to login.

- [ ] **Step 4: Build the dashboard to verify it compiles**

Run: `cd quorum-dash && npm run build`
Expected: build succeeds (no unresolved imports, no JSX errors).

- [ ] **Step 5: Commit**

```bash
cd quorum-dash
git add src/context/AuthContext.jsx src/pages/NoProjects.jsx src/App.jsx
git commit -m "feat(dashboard): zero-projects welcome state (keep jwt, no active project)"
```

---

## Task 8: Dashboard — admin add/remove panel

Expose the existing `GET /admin/config` + `POST /admin/users` through the Admin page so admins manage admins without IaC edits.

**Files:**
- Create or Modify: `quorum-dash/src/api/admin.js`
- Modify: `quorum-dash/src/pages/Admin.jsx`

- [ ] **Step 1: Inspect the current Admin page + api conventions**

Run: `cd quorum-dash && sed -n '1,80p' src/pages/Admin.jsx && ls src/api/`
Note how other api clients in `src/api/` make authenticated calls (they attach the Bearer JWT — reuse that exact helper/wrapper; do not hand-roll fetch).

- [ ] **Step 2: Add the admin api client** — in `quorum-dash/src/api/admin.js` (create if absent), using the repo's shared authed-fetch helper:

```javascript
/**
 * Platform admin API client.
 * Wraps GET /admin/config and POST /admin/users on the gateway.
 */
import { authedFetch } from './client.js' // use this repo's actual authed helper

/** @returns {Promise<{ admins: Array<{ github_username: string, added_at?: string, added_by?: string }>, version: number }>} */
export async function listAdmins() {
  return authedFetch('/admin/config', { method: 'GET' })
}

/**
 * @param {string} githubUsername
 * @param {string} reason  // >= 10 chars, no placeholder text (constitutional Rule 3)
 */
export async function addAdmin(githubUsername, reason) {
  return authedFetch('/admin/users', {
    method: 'POST',
    body: JSON.stringify({ action: 'add', github_username: githubUsername, reason }),
  })
}

/**
 * @param {string} githubUsername
 * @param {string} reason
 */
export async function removeAdmin(githubUsername, reason) {
  return authedFetch('/admin/users', {
    method: 'POST',
    body: JSON.stringify({ action: 'remove', github_username: githubUsername, reason }),
  })
}
```

> Replace `authedFetch`/import path with the repo's real helper (Step 1 tells you the name). Match its error-throwing convention so the page can show gateway errors like `409 last_admin` and `409 already_admin`.

- [ ] **Step 3: Wire the UI into Admin.jsx** — add an "Admins" section that lists current admins (from `listAdmins`) and provides an add form (username + reason) and a remove button per admin. Use TanStack Query (the repo standard) for the list + mutations, invalidating the list query on success. Surface gateway errors inline — specifically:
  - `409 already_admin` → "Already an admin."
  - `409 last_admin` → "Cannot remove the last admin." (also disable the remove button when `admins.length === 1`).
  - constitutional reason error → "Reason must be at least 10 meaningful characters."

Skeleton (adapt to the page's existing component/style patterns):

```jsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listAdmins, addAdmin, removeAdmin } from '../api/admin.js'

function AdminsPanel() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['admins'], queryFn: listAdmins })
  const add    = useMutation({ mutationFn: ({ u, r }) => addAdmin(u, r),    onSuccess: () => qc.invalidateQueries({ queryKey: ['admins'] }) })
  const remove = useMutation({ mutationFn: ({ u, r }) => removeAdmin(u, r), onSuccess: () => qc.invalidateQueries({ queryKey: ['admins'] }) })
  // render list + add form + per-row remove (disabled when admins.length === 1),
  // showing add.error / remove.error messages mapped as above.
}
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd quorum-dash && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
cd quorum-dash
git add src/api/admin.js src/pages/Admin.jsx
git commit -m "feat(dashboard): admin add/remove panel backed by /admin/users"
```

---

## Task 9: E2E — update S-19, add S-23 self-serve onboarding

**Files:**
- Modify: `quorum/tests/e2e/scenarios/19-auth-lifecycle.spec.js`
- Create: `quorum/tests/e2e/scenarios/23-self-serve-onboarding.spec.js`

- [ ] **Step 1: Read the E2E helpers + S-19**

Run: `cd quorum && sed -n '1,60p' tests/e2e/scenarios/19-auth-lifecycle.spec.js && ls tests/e2e/helpers/`
Note the `uid()` fixture-prefixing convention and how scenarios authenticate (the helper that gets a JWT). Every `describe` title must start with its `S-XX.Y` ID (graph reporter requirement).

- [ ] **Step 2: Update S-19** — remove/adjust any assertion that `POST /auth/token` 403s a non-member or that the OAuth callback redirects `?error=no_projects`. The new contract:
  - `POST /auth/token` with no `project_id` → **200** slim JWT (`project: null`, `member_found: false`).
  - `POST /auth/token` with a `project_id` the caller isn't a member of → **200** (`member_found: false`), no 403.

Add an explicit test inside the existing S-19 describe:

```javascript
test('S-19.x — /auth/token without project_id returns a slim JWT', async () => {
  const res = await api.post('/auth/token', { github_token: TEST_GH_TOKEN })
  expect(res.status).toBe(200)
  expect(res.data.project).toBeNull()
  expect(res.data.member_found).toBe(false)
  expect(typeof res.data.token).toBe('string')
})
```

(Use the suite's real GitHub-token fixture / mock — check the helpers for how S-19 currently authenticates.)

- [ ] **Step 3: Create S-23** — `quorum/tests/e2e/scenarios/23-self-serve-onboarding.spec.js`. `S-20` is already assigned to cross-catalog search, so keep the `S-23` prefix on every describe. Cover the cold-start onboarding flow and the G1 read-only guard at the API level (the browser half lives in quorum-dash, Step 5):

```javascript
import { test, expect } from '@playwright/test'
import { uid } from '../helpers/...'   // use the suite's actual fixture helpers + api client

test.describe('S-23.1 cold-start onboarding via /auth/token + /config/upload', () => {
  test('a never-onboarded user gets a JWT and uploads their first project', async () => {
    // 1. POST /auth/token (no project_id) → 200 slim JWT for a fresh GitHub identity
    // 2. POST /config/upload with a net-new group_id (uid()-prefixed) where the
    //    uploader is listed as principal_architect → 200 bootstrapped
    // 3. GET /config/:groupId → 200, config present
    // 4. Re-upload same group_id → 409 (first-come-first-served, G4)
  })
})

test.describe('S-23.2 public projects are read-only for non-members (G1)', () => {
  test('non-member can read a public project but cannot write', async () => {
    // 1. As a member, onboard a public project (is_public: true), uid()-prefixed
    // 2. As a different, non-member identity, GET a read route with
    //    X-Quorum-Project = that project → 200 (read allowed)
    // 3. As the non-member, POST /pg/versions (or /api/knowledge) with the same
    //    header → 403 not_a_member (write blocked)
  })
})
```

Fill the bodies with the suite's real api client and JWT helpers (Step 1). Use `uid()` prefixes for every `group_id` so runs are isolated with no cleanup.

- [ ] **Step 4: Run the API E2E suite** (needs the test stack)

Run: `cd quorum && npm run test:e2e:full`
(or, if the stack is already up: `npm run test:e2e -- tests/e2e/scenarios/19-auth-lifecycle.spec.js tests/e2e/scenarios/23-self-serve-onboarding.spec.js`)
Expected: S-19 (updated) + S-23 PASS.

- [ ] **Step 5: Add the browser half in quorum-dash** — create `quorum-dash/tests/e2e/scenarios/23-self-serve-onboarding.spec.js` keeping the `S-23` IDs. Using `injectSession(page, …)` (from `tests/e2e/helpers/browser.js`) with a test identity that has **zero** projects, assert the dashboard shows the NoProjects welcome screen (text "no projects yet" and the `quorum config_upload` hint) and does NOT bounce to `/login`.

```javascript
test.describe('S-23.3 dashboard zero-projects welcome', () => {
  test('a zero-project user lands on the welcome screen, not an error', async ({ page }) => {
    // injectSession(page, { sub: uid('newbie'), projects: [] })
    // navigate to dashboard root
    // expect to see "no projects yet" and "quorum config_upload"
    // expect NOT redirected to /login
  })
})
```

- [ ] **Step 6: Run the browser E2E** (needs gateway + dashboard test targets)

Run: `cd quorum-dash && npm run test:e2e -- tests/e2e/scenarios/23-self-serve-onboarding.spec.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd quorum && git add tests/e2e/scenarios/19-auth-lifecycle.spec.js tests/e2e/scenarios/23-self-serve-onboarding.spec.js
git commit -m "test(e2e): S-23 self-serve onboarding + G1 public read-only; update S-19 auth contract"
cd ../quorum-dash && git add tests/e2e/scenarios/23-self-serve-onboarding.spec.js
git commit -m "test(e2e): S-23.3 dashboard zero-projects welcome (@ui)"
```

---

## Task 10: Docs — sync the new auth + onboarding model

Per the workspace rule, update docs after the code lands.

**Files:**
- Modify: `quorum/gateway/openapi.yaml`
- Modify: `quorum/CLAUDE.md`, `quorum/gateway/CLAUDE.md`, `quorum-dash/CLAUDE.md`
- Modify: `quorum/docs/ARCHITECTURE.md`, `quorum/docs/TESTING.md`

- [ ] **Step 1: OpenAPI** — in `quorum/gateway/openapi.yaml`, find the `POST /auth/token` request schema and make `project_id` optional (remove it from `required`); update the description to: "GitHub PAT exchange. `project_id` is optional; membership never gates issuance. Supplying it enriches the response with role/team." Document that mutating `/pg/*` and `/api/*` routes return `403 not_a_member` for roleless callers on public projects.

Run: `cd quorum && grep -n "project_id" gateway/openapi.yaml | head` to locate it.

- [ ] **Step 2: CLAUDE.md files** —
  - `quorum/gateway/CLAUDE.md`: under Auth, note `project_id` optional on `/auth/token`; add `require-membership.js` to the middleware list ("write-membership guard, G1 — public read-only"); note `ensureAdminConfig()` boot-seed in config-cache.js and startup.
  - `quorum/CLAUDE.md`: in "Non-Negotiable Rules", add a row: "Public projects read-only for non-members | `requireMembership` write guard (`middleware/require-membership.js`)".
  - `quorum-dash/CLAUDE.md`: note the zero-projects welcome (`NoProjects.jsx`) and the Admin add/remove panel.

- [ ] **Step 3: ARCHITECTURE.md / TESTING.md** —
  - `docs/ARCHITECTURE.md`: in the auth/identity section, document the decoupled model (login = GitHub; membership enforced per-request, not at issuance) and the boot-seed-admins-only flow.
  - `docs/TESTING.md`: add S-23 to the scenario list and note the new unit tests (`require-membership`, `ensure-admin-config`, `admin-last-guard`).

- [ ] **Step 4: Open the changed markdown for review** (per user workflow). For each changed `.md`, ensure the show-md server is up and open it:

```bash
curl -sf http://127.0.0.1:4242/healthz >/dev/null 2>&1 || (nohup node ~/.claude/skills/show-md/server.js >/tmp/show-md.log 2>&1 & disown)
open "http://127.0.0.1:4242?file=/Users/ayan/Desktop/Work/vscode/qc/quorum/docs/ARCHITECTURE.md"
```

- [ ] **Step 5: Commit**

```bash
cd quorum
git add gateway/openapi.yaml CLAUDE.md gateway/CLAUDE.md docs/ARCHITECTURE.md docs/TESTING.md
git commit -m "docs: document self-serve auth, boot-seed, and G1 read-only enforcement"
cd ../quorum-dash
git add CLAUDE.md
git commit -m "docs: note zero-projects welcome + admin management panel"
```

---

## Final Verification

- [ ] **Gateway unit + coverage**

Run: `cd quorum && npm test`
Expected: all pass; coverage ≥ 75% threshold holds.

- [ ] **MCP unit**

Run: `cd quorum-mcp && npm test`
Expected: all pass (incl. the new cold-start tests).

- [ ] **Full E2E (API + browser)**

Run: `cd quorum && npm run test:e2e:full` then `cd ../quorum-dash && npm run test:e2e`
Expected: S-19 (updated), S-23 (new) green; no regressions.

- [ ] **Manual cold-start rehearsal** (the acceptance demo) — with a fresh stack and `QUORUM_FIRST_ADMIN` set, confirm: (1) boot logs "Admin config seeded"; (2) a GitHub user in no project can log into the dashboard and sees the welcome screen; (3) that user runs `authenticate` + `config_upload` from an MCP client and onboards a project; (4) the project then appears in their dashboard selector; (5) a non-member can read but not write a public project.

---

## Self-Review (completed by plan author)

- **Spec coverage:** §4.1 → Tasks 1, 2, 6. §4.2 → Task 3. §4.3 → Task 7. §4.4 → Task 8. G1 → Task 4 + 9. G2 → already shipped (commit `469d02f`); TTL referenced in Task 1 test. G3 → Task 5 (verify). G4 → Task 9 (409-on-existing assertion); no new code per decision. §6 testing impact → Task 9. Docs → Task 10. No spec requirement is unaddressed.
- **Already-implemented, verified-not-rebuilt:** G3 last-admin guard (admin.js:91-93); MCP `authenticate` optional `project_id` (authenticate.js:36); the `/config/upload` bootstrap path. These get tests, not reimplementation.
- **Type/name consistency:** `requireMembership` is the single exported name used in Tasks 4, 5(n/a), and mounted identically in pg.js + dashboard.js. `ensureAdminConfig` returns `{ seeded, count?, reason? }` consistently in Task 3's test and impl. Dashboard `activeProject` is named per the actual AuthContext export (verify in Task 7 Step 3).
- **Open verification points flagged inline (not placeholders):** the exact "current project" field name in AuthContext/App (Task 7), the repo's authed-fetch helper name (Task 8), and the suite's GitHub-token fixture (Task 9). Each step says how to find the real name before using it.
