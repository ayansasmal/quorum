# J09 — Platform Admin Operations

**Scenario ID:** S-09
**Weight:** 14 (14 raw leaves × F1) — updated: +2 leaves for user profile endpoint
**Blast radius:** 1.3% of suite (recalculated against 1107 suite total)
**Frequency tier:** F1 (rare — admin management is a one-time or monthly event)
**Spec file:** `tests/e2e/scenarios/09-admin-operations.spec.js`

---

## What It Covers

Admin-only platform operations: reading admin config, adding/removing admin users, and the
dashboard admin panel visibility. Verifies that no non-admin JWT — including a principal_architect —
can access admin routes.

**Roles:** `test-admin` (`is_admin: true` JWT, `sub: "test-admin"`), `test-pe` (blocked)
**Touches:** `GET /admin/config`, `POST /admin/users`, `GET /admin/projects`, `/admin` page
**Automated:** Yes — API + Playwright

---

## Setup

Generate an admin JWT with `is_admin: true, sub: "test-admin"` using the test key pair.
This bypasses GitHub OAuth — the admin flag is embedded in the JWT claim.

```javascript
// jwt.js helper:
const adminToken = await generateToken({ sub: 'test-admin', is_admin: true })
```

---

## Steps

### API: Admin config

1. `GET /admin/config` as `test-admin`
   - Assert: `200`, returns platform admin config with `admins` list

2. `GET /admin/config` as `test-pe` (principal_architect, not admin)
   - Assert: `403` with `error: "forbidden"`

---

### API: User management

3. `POST /admin/users` as `test-admin`:
   ```json
   { "action": "add", "github_username": "test-new-admin", "reason": "Platform expansion requires additional administrator" }
   ```
   - Assert: `200`, `test-new-admin` appears in updated admin list

4. `POST /admin/users` as `test-admin`:
   ```json
   { "action": "remove", "github_username": "test-new-admin", "reason": "Admin removed after team restructure in Q3" }
   ```
   - Assert: `200`, `test-new-admin` no longer in admin list

5. `POST /admin/users` as `test-admin` with reason shorter than 10 chars:
   ```json
   { "action": "add", "github_username": "someone", "reason": "short" }
   ```
   - Assert: `400` (reason validation enforced on admin routes)
   - Assert: response body has `rule: "REASON_REQUIRED"` — consistent with all governance endpoints
   - (Note: if the current code returns `error: "missing_param"`, this is the same code gap as
     `transfer-ownership` / `update-role` in J13 Part F. The fix is the same: call
     `enforceReasonRequired(reason)` instead of a manual check.)

---

### API: Project listing

6. `GET /admin/projects` as `test-admin`
   - Assert: `200`, projects array includes both `quorum-test-project` and `quorum-test-catalog`

---

### Dashboard: Admin panel

7. Log in as `test-admin` (inject admin JWT into sessionStorage)
   - Navigate to `/admin`
   - Assert: Admin panel visible and rendered (not redirected or shown 403 page)

8. Log in as `test-pe` (non-admin PA JWT)
   - Navigate to `/admin`
   - Assert: Admin section not accessible — either redirected or shows permission denied state

---

### API: User profile

> `GET /user/profile/:username` returns a user's profile (role, projects, base_confidence)
> from Redis cache → DDB on miss. This endpoint is used by the dashboard to display user
> info and is accessible to any authenticated user.

9. `GET /user/profile/test-pe` as `test-engineer` (any authenticated user can query profiles):
   - Assert: `200`
   - Assert: response has `github_username: "test-pe"`
   - Assert: `role` present (e.g. `"principal_architect"`)
   - Assert: `base_confidence` is a number between 0 and 1
   - Assert: `projects` array is present (includes `quorum-test-project`)

10. `GET /user/profile/user-does-not-exist-s09` as `test-engineer`:
    - Assert: `404` — unknown user returns not found (not a 500)

---

## Pass Criteria

- [ ] `GET /admin/config` accessible to admin JWT, blocked for PA JWT (403)
- [ ] Add admin user → user appears in admin list
- [ ] Remove admin user → user removed from admin list
- [ ] Reason < 10 chars on admin user management → `400` with `rule: "REASON_REQUIRED"`
- [ ] `GET /admin/projects` returns both test projects
- [ ] Dashboard admin panel visible only when `is_admin: true` JWT injected
- [ ] `GET /user/profile/:username` → `200` with role, base_confidence, projects
- [ ] `GET /user/profile/<nonexistent>` → `404` (not 500)
