# J05 — RBAC Boundary Simulation

**Original journey weight:** 255 (85 raw leaves × F3)
**Split into 6 independent sub-scenarios (each ≤ 8.9% blast radius)**
**Frequency tier:** F3 (daily — RBAC enforcement fires on every governance action)

> RBAC is a security property. Every cell in the matrix has a known correct answer.
> The test exists to catch any regression where a role boundary widens silently.
> Split by operation category so a failure in knowledge-write RBAC does not
> invalidate deviation RBAC results.

---

## Sub-Scenario Registry

| Scenario ID | Description | Weight | Blast Radius | Spec File |
|-------------|-------------|--------|--------------|-----------|
| S-05.1 | Knowledge create — all roles, outcome matrix | 72 | 7.7% | `05-1-rbac-create.spec.js` |
| S-05.2 | PE-only: promote + supersede | 48 | 5.1% | `05-2-rbac-promote-supersede.spec.js` |
| S-05.3 | PE-only: deprecate single + bulk | 48 | 5.1% | `05-3-rbac-deprecate.spec.js` |
| S-05.4 | Governance: review/approve + global write authority | 60 | 6.4% | `05-4-rbac-governance.spec.js` |
| S-05.5 | Deviation action + forget branching | 60 | 6.4% | `05-5-rbac-deviation.spec.js` |
| S-05.6 | Portfolio access + admin gates | 45 | 4.8% | `05-6-rbac-portfolio-admin.spec.js` |

**All 8 test roles used:** `test-pe` (PA), `test-architect`, `test-senior`, `test-engineer`, `test-product`, `test-compliance`, `test-director`, `test-vp`

---

## RBAC Reference Matrix

The matrix below is the ground truth. Each sub-scenario tests the cells in its category.
A failure must cite the operation, role, expected outcome, and actual outcome.

| Operation | engineer | senior_engineer | architect | principal_architect | director | vp_engineering | product_owner | compliance_officer |
|-----------|:--------:|:---------------:|:---------:|:-------------------:|:--------:|:--------------:|:-------------:|:-----------------:|
| `POST /api/knowledge` | `DRAFT` | `DRAFT` | `DRAFT` | `ACTIVE` | `DRAFT` | `DRAFT` | `DRAFT` | `DRAFT` |
| `POST /knowledge/:t/:k/promote` | `403` | `403` | `403` | `200` | `403` | `403` | `403` | `403` |
| `POST /knowledge/:t/:k/supersede` | `403` | `403` | `403` | `200` | `403` | `403` | `403` | `403` |
| `POST /knowledge/:t/:k/deprecate` | `403` | `403` | `403` | `200` | `403` | `403` | `403` | `403` |
| `POST /knowledge/deprecate/bulk` | `403` | `403` | `403` | `200` | `403` | `403` | `403` | `403` |
| `POST /api/review/:id` (conflict) | `403` | `403` | `403` | `200` | `403` | `403` | `403` | `403` |
| `POST /api/deviations` | `200` | `200` | `200` | `200` | `200` | `200` | `200` | `200` |
| `POST /api/deviations/:id/action` | `403` | `403` | `200` | `200` | `403` | `403` | `200` | `200` |
| Write to global catalog | `403 GLOBAL_WRITE` | `403 GLOBAL_WRITE` | `200 →DRAFT` | `200 →ACTIVE` | `403 GLOBAL_WRITE` | `403 GLOBAL_WRITE` | `200 →DRAFT` | `200 →DRAFT` |
| `GET /api/portfolio` | `403` | `403` | `403` | `200` | `200` | `200` | `403` | `403` |
| `GET /admin/config` | `403` | `403` | `403` | `403` | `403` | `403` | `403` | `403` (admin-only) |
| `POST /admin/users` | `403` | `403` | `403` | `403` | `403` | `403` | `403` | `403` (admin-only) |
| `forget()` (non-PE) | `dep_req` | `dep_req` | `dep_req` | `deprecated` | `dep_req` | `dep_req` | `dep_req` | `dep_req` |

`dep_req` = `deprecation_requested`
`GLOBAL_WRITE` = constitutional violation rule `GLOBAL_WRITE_AUTHORITY`

---

## S-05.1 — Knowledge Create: All Roles, Outcome Matrix

**Weight:** 72 (24 leaves × F3)
**Blast radius:** 7.7%

### What This Tests
All 8 roles call `POST /api/knowledge`. The outcome differs:
- `principal_architect` → `ACTIVE` immediately
- All other roles → `DRAFT`

Confidence floor also tested: every role submitting `confidence: 0.10` receives
`confidence: base_confidence` in the response (floor enforced server-side).

### Setup
Seed project config for both test projects. Generate JWTs for all 8 roles.

### Steps

For each role in `[engineer, senior_engineer, architect, principal_architect, director, vp_engineering, product_owner, compliance_officer]`:

1. `POST /api/knowledge` with unique `topic` + `key` per role (avoid collisions):
   - Content: `"Test entry for role ${role} — unique content per role"`
   - `confidence: 0.10` (below floor for every role)
   - Assert: HTTP 200 or 201
   - Assert: `status` matches matrix (`ACTIVE` for PA, `DRAFT` for all others)
   - Assert: stored `confidence` == role's `base_confidence` (floor applied, 0.10 rejected)

2. **Cross-project access check** (run once, not per role):
   - Use `test-pe` JWT scoped to `quorum-test-project`
   - Attempt `POST /api/knowledge` with `X-Quorum-Project: other-nonexistent-project`
   - Assert: `404` (project not found for this JWT's scope)

### Pass Criteria
- [ ] All 8 roles receive correct `status` (`ACTIVE` for PA, `DRAFT` for all others)
- [ ] Confidence floor enforced — `0.10` input → `base_confidence` stored for all roles
- [ ] Cross-project access → `404` (not the other project's data)
- [ ] Each role's response includes `author`, `role`, `version`, `timestamp`

---

## S-05.2 — PE-Only: Promote + Supersede

**Weight:** 48 (16 leaves × F3)
**Blast radius:** 5.1%

### Setup
- Seed one DRAFT entry (via engineer) at `testing:promote-test`
- Seed one ACTIVE entry (via PE) at `testing:supersede-test`

### Steps

**Promote (DRAFT → ACTIVE):**

For each role except PA, attempt `POST /api/knowledge/testing/promote-test/promote`:
- Assert: `403` with `error: "forbidden"`

As `test-pe`:
- Assert: `200`, entry transitions to `ACTIVE`

**Supersede (ACTIVE → new ACTIVE):**

For each role except PA, attempt `POST /api/knowledge/testing/supersede-test/supersede`:
- Assert: `403`

As `test-pe` with valid payload:
- Assert: `200`, new version is `ACTIVE`, old is `SUPERSEDED`

### Pass Criteria
- [ ] All non-PA roles → `403` on promote
- [ ] All non-PA roles → `403` on supersede
- [ ] PA promote → DRAFT transitions to ACTIVE
- [ ] PA supersede → old ACTIVE to SUPERSEDED, new entry ACTIVE atomically
- [ ] Constitutional error shape correct (`error: "forbidden"`)

---

## S-05.3 — PE-Only: Deprecate Single + Bulk

**Weight:** 48 (16 leaves × F3)
**Blast radius:** 5.1%

### Setup
Seed 3 ACTIVE entries via PA: `testing:dep-a`, `testing:dep-b`, `testing:dep-c`.

### Steps

**Single deprecate:**

For each non-PA role, attempt `POST /api/knowledge/testing/dep-a/deprecate`:
- Body: `{ reason: "Testing RBAC boundary" }`
- Assert: `403`

As `test-pe`:
- Assert: `200`, entry is now `DEPRECATED`

**Bulk deprecate:**

For each non-PA role, attempt `POST /api/knowledge/deprecate/bulk`:
- Body: `{ entries: [{ topic: "testing", key: "dep-b" }], reason: "Bulk RBAC test" }`
- Assert: `403`

As `test-pe`, bulk deprecate 2 remaining entries:
- Assert: `200`, partial results with both entries as `DEPRECATED`

### Pass Criteria
- [ ] Single deprecate: all non-PA roles → `403`
- [ ] Bulk deprecate: all non-PA roles → `403`
- [ ] PA single deprecate → entry is `DEPRECATED`
- [ ] PA bulk deprecate → all specified entries `DEPRECATED`
- [ ] Bulk deprecate with invalid entry → partial success, others still processed

---

## S-05.4 — Governance: Review/Approve + Global Write Authority

**Weight:** 60 (20 leaves × F3)
**Blast radius:** 6.4%

### Setup
- Trigger a real conflict on `testing:conflict-test` for use in review RBAC tests
- `quorum-test-catalog` is an `is_global: true` project

### Steps

**Conflict review RBAC:**

For each non-PA role, attempt `POST /api/review/:conflict_id`:
- `{ resolution: "supersede", note: "Testing review RBAC" }`
- Assert: `403`

As `test-pe`:
- Assert: `200`, conflict resolved

**Global write authority:**

For roles `[engineer, senior_engineer, director, vp_engineering]`:
- Attempt `POST /api/knowledge` with `X-Quorum-Project: quorum-test-catalog` (the global project)
- Assert: `403`, body contains `rule: "GLOBAL_WRITE_AUTHORITY"`

For roles `[architect, product_owner, compliance_officer]`:
- Assert: `200`, entry created as `DRAFT` (eligible to write, but needs PA approval)

For `principal_architect`:
- Assert: `200`, entry created as `ACTIVE` directly

### Pass Criteria
- [ ] All non-PA roles → `403` on conflict review
- [ ] PA conflict review → `200`, resolves conflict
- [ ] engineer/senior_engineer/director/vp → `403 GLOBAL_WRITE_AUTHORITY` on global project write
- [ ] architect/product_owner/compliance_officer → `200 DRAFT` on global project write
- [ ] PA → `200 ACTIVE` on global project write
- [ ] `rule: "GLOBAL_WRITE_AUTHORITY"` present in 403 response body for blocked roles

---

## S-05.5 — Deviation Action + Forget Branching

**Weight:** 60 (20 leaves × F3)
**Blast radius:** 6.4%

### Setup
Seed a deviation in `OPEN` status for use in action RBAC tests.
Seed one ACTIVE entry `testing:forget-test` for forget branching.

### Steps

**Deviation action RBAC:**

For roles `[engineer, senior_engineer, director, vp_engineering]`:
- `POST /api/deviations/:id/action` with `{ action_type: "accept", reason: "Testing RBAC boundary" }`
- Assert: `403`, body contains `rule: "DEVIATION_ACTION_AUTHORITY"`

For roles `[architect, principal_architect, product_owner, compliance_officer]`:
- Assert: `200`, action recorded

**Forget (non-PE) → deprecation_requested vs direct deprecated:**

All roles call `forget` (`POST /pg/versions` with `status: "deprecated"`) on `testing:forget-test`:

- `engineer`, `senior_engineer`, `architect`, `product_owner`, `compliance_officer`, `director`, `vp_engineering`:
  - Assert: `status: "deprecation_requested"` (request queued, not executed)

- `principal_architect`:
  - Assert: `status: "deprecated"` (PA can deprecate directly)

### Pass Criteria
- [ ] engineer/senior_engineer/director/vp → `403 DEVIATION_ACTION_AUTHORITY` on deviation action
- [ ] architect/PA/product_owner/compliance_officer → `200` on deviation action
- [ ] All non-PA roles → `deprecation_requested` when calling forget on ACTIVE entry
- [ ] PA → `deprecated` directly when calling forget on ACTIVE entry

---

## S-05.6 — Portfolio Access + Admin Gates

**Weight:** 45 (15 leaves × F3)
**Blast radius:** 4.8%

### Steps

**Portfolio access (`GET /api/portfolio`):**

| Role | Expected |
|------|----------|
| engineer | `403` |
| senior_engineer | `403` |
| architect | `403` |
| principal_architect | `200` |
| director | `200` |
| vp_engineering | `200` |
| product_owner | `403` |
| compliance_officer | `403` |

Assert: `200` responses include `projects` array and `rollup` object.

**Admin access:**

For all 8 test roles (none of which has `is_admin: true`):
- `GET /admin/config` → `403` for all
- `POST /admin/users` with valid body → `403` for all

Generate a JWT with `is_admin: true, sub: "test-admin"`:
- `GET /admin/config` → `200`
- `POST /admin/users` with `action: "add"` → `200`

**`X-Quorum-Project` absent on project-scoped routes:**

Call `GET /api/deviations` without `X-Quorum-Project` header:
- Assert: `400` with `missing_header` error (project context required)

### Pass Criteria
- [ ] PA/director/vp → `200` on portfolio
- [ ] All other roles → `403` on portfolio
- [ ] All non-admin JWTs → `403` on admin routes
- [ ] `is_admin: true` JWT → `200` on admin routes
- [ ] Project-scoped route without `X-Quorum-Project` → `400 missing_header`
