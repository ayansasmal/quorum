# Quorum v0.4 Wave A — Constitutional + DB Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the constitutional and database foundations for federation, deviation governance, and conformance scoring — every subsequent wave depends on what this wave delivers.

**Architecture:** Three new constitutional enforcement functions extend the throw-on-violation layer. New PostgreSQL tables (`deviations`, `deviation_actions`, `project_scans`) go in `scripts/init-db.sql` with full RLS. `remember.js` replaces its soft-return global guard with a constitutional throw. All changes are applied to both repos — `gateway` (shared modules) and `quorum-mcp` (vendored copies) — in the same PR.

**Tech Stack:** JavaScript (ESM), Node.js, Zod v3, PostgreSQL 15, Vitest, `quorum-mcp` and `gateway` repos

---

## Pre-flight: Orientation

Before touching any file, confirm these exist and match expectations:

- [ ] `gateway/src/shared/governance/constitutional.js` — 5 rules, `ConstitutionalViolation` class
- [ ] `tests/gateway/shared-governance.test.js` — unit tests for all constitutional functions; this is where new tests go
- [ ] `scripts/init-db.sql` — PostgreSQL DDL; new tables append here
- [ ] `helm/quorum/files/init-db.sql` — must be kept in sync with `scripts/init-db.sql`
- [ ] `quorum-mcp/src/governance/constitutional.js` — vendored copy; must receive identical changes
- [ ] `quorum-mcp/src/tools/remember.js` lines 117-128 — soft `{ status: 'forbidden' }` guard (the one we replace)
- [ ] `quorum-mcp/src/tools/remember.js` lines ~255 and ~360 — two `const isGlobal = projectId === GLOBAL_PROJECT_ID` (the two we update)

**Rule about vendored copies:** Every change to a `shared/` module in `gateway` must be identically applied to the corresponding file in `quorum-mcp/src/`. The CLAUDE.md documents this. Never change one without the other.

---

## File Map

| File | Action | What changes |
|------|--------|--------------|
| `gateway/src/shared/governance/constitutional.js` | Modify | +3 functions, updated rule union comment |
| `quorum-mcp/src/governance/constitutional.js` | Modify (sync) | Identical changes |
| `tests/gateway/shared-governance.test.js` | Modify | +3 test blocks |
| `scripts/init-db.sql` | Modify | +3 new tables, +`is_global` column on `q_projects`, +indexes, +RLS, +grants |
| `helm/quorum/files/init-db.sql` | Modify (sync) | Identical SQL changes |
| `gateway/src/shared/graph/schema.js` | Modify | +`DeviationStatus`, `DeviationActionType`, `VALID_DEFER_DAYS` |
| `quorum-mcp/src/graph/schema.js` | Modify (sync) | Identical changes |
| `gateway/src/shared/config/schema.js` | Modify | +`hierarchy`, `is_global`, `global_scope`, `is_public`, `globals` |
| `quorum-mcp/src/config/schema.js` | Modify (sync) | Identical changes |
| `quorum-mcp/src/tools/remember.js` | Modify | Replace soft guard + fix 2 isGlobal checks |
| `gateway/src/shared/governance/authority.js` | Modify | +3 executive roles |
| `quorum-mcp/src/governance/authority.js` | Modify (sync) | Identical changes |

---

## Task 1: Failing tests for `enforceGlobalWriteAuthority`

**Files:**
- Modify: `tests/gateway/shared-governance.test.js`

- [ ] **Step 1: Add the failing test block**

Open `tests/gateway/shared-governance.test.js`. After the existing `describe('enforceConstitutionalRulesAreImmutable', ...)` block (currently the last describe block), add:

```javascript
describe('enforceGlobalWriteAuthority', () => {
  it('does nothing when isGlobalProject is false (non-global project)', () => {
    // engineer can write to their own project — not a global catalog
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'engineer' }, 'payments-service', false)
    ).not.toThrow()
  })

  it('throws ConstitutionalViolation for engineer writing to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'engineer' }, 'security-standards', true)
    ).toThrow(ConstitutionalViolation)
  })

  it('throws for senior_engineer writing to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'senior_engineer' }, 'security-standards', true)
    ).toThrow(ConstitutionalViolation)
  })

  it('throws for tech_lead writing to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'tech_lead' }, 'security-standards', true)
    ).toThrow(ConstitutionalViolation)
  })

  it('allows architect to write to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'architect' }, 'security-standards', true)
    ).not.toThrow()
  })

  it('allows principal_architect to write to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'principal_architect' }, 'security-standards', true)
    ).not.toThrow()
  })

  it('allows product_owner to write to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'product_owner' }, 'security-standards', true)
    ).not.toThrow()
  })

  it('allows compliance_officer to write to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'compliance_officer' }, 'security-standards', true)
    ).not.toThrow()
  })

  it('violation carries rule GLOBAL_WRITE_AUTHORITY with correct context', () => {
    try {
      enforceGlobalWriteAuthority({ role: 'engineer' }, 'security-standards', true)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConstitutionalViolation)
      expect(err.rule).toBe('GLOBAL_WRITE_AUTHORITY')
      expect(err.context.role).toBe('engineer')
      expect(err.context.projectId).toBe('security-standards')
    }
  })

  it('throws for undefined role (null identity) writing to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({}, 'security-standards', true)
    ).toThrow(ConstitutionalViolation)
  })

  it('executive roles (director, vp_engineering, group_executive) cannot write to global catalogs', () => {
    for (const role of ['director', 'vp_engineering', 'group_executive']) {
      expect(() =>
        enforceGlobalWriteAuthority({ role }, 'security-standards', true)
      ).toThrow(ConstitutionalViolation)
    }
  })
})
```

Make sure `enforceGlobalWriteAuthority` is added to the import at the top of the test file:
```javascript
import {
  ConstitutionalViolation,
  enforceNoHardDelete,
  validateManifestHasNoDeleteTools,
  enforceAppendOnlyAudit,
  enforceReasonRequired,
  enforceNoSelfApproval,
  enforceConflictPartyCannotSelfResolve,
  enforceMultiPartyConfig,
  enforceConstitutionalRulesAreImmutable,
  enforceGlobalWriteAuthority,         // new
  enforceDeviationActionAuthority,     // new (will be added in Task 3)
  enforceValidDeferDeadline,           // new (will be added in Task 5)
} from '../../gateway/src/shared/governance/constitutional.js'
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram
npm test -- --reporter=verbose tests/gateway/shared-governance.test.js 2>&1 | tail -30
```

Expected: `enforceGlobalWriteAuthority is not a function` or similar import error. If you see passing tests, the function already exists — investigate before proceeding.

---

## Task 2: Implement `enforceGlobalWriteAuthority`

**Files:**
- Modify: `gateway/src/shared/governance/constitutional.js`

- [ ] **Step 1: Update the `ConstitutionalViolation` constructor JSDoc comment**

Find this block in `constitutional.js`:
```javascript
  /**
   * @param {'NO_HARD_DELETE'|'APPEND_ONLY_AUDIT'|'REASON_REQUIRED'|'NO_SELF_APPROVAL'|'MULTI_PARTY_CONFIG'} rule
```

Replace with:
```javascript
  /**
   * @param {'NO_HARD_DELETE'|'APPEND_ONLY_AUDIT'|'REASON_REQUIRED'|'NO_SELF_APPROVAL'|'MULTI_PARTY_CONFIG'|'GLOBAL_WRITE_AUTHORITY'|'DEVIATION_ACTION_AUTHORITY'|'DEFER_DEADLINE'} rule
```

- [ ] **Step 2: Add `enforceGlobalWriteAuthority` after `enforceConstitutionalRulesAreImmutable`**

Append at the end of the file:

```javascript
// ── Global write authority (GAP-27 lift) ──────────────────────────────────────

/**
 * Throws if a role below architect-tier attempts to write to a global catalog.
 *
 * Lifted from the application-level soft-return in remember.js (GAP-27) into
 * the constitutional layer. Widened from principal_architect-only to all
 * architect-tier and business-authority roles because POs and compliance officers
 * need to maintain standards in their domain catalogs.
 *
 * Callers resolve isGlobalProject from the target project's config:
 *   - MCP: getConfig()?.is_global === true (loaded from .quorum file)
 *   - Gateway: projectConfig.is_global === true (from Redis config cache)
 *
 * @param {{ role?: string }} identity
 * @param {string} projectId - group_id of the target project
 * @param {boolean} isGlobalProject - true when the target project has is_global: true
 */
export function enforceGlobalWriteAuthority(identity, projectId, isGlobalProject) {
  // Non-global projects: no restriction. Every role can write to their own project.
  if (!isGlobalProject) return

  const GLOBAL_WRITE_ROLES = [
    'architect',
    'principal_architect',
    'product_owner',       // owns product standards catalog
    'compliance_officer',  // owns compliance standards catalog
  ]

  if (!GLOBAL_WRITE_ROLES.includes(identity?.role)) {
    throw new ConstitutionalViolation(
      'GLOBAL_WRITE_AUTHORITY',
      `Role '${identity?.role ?? 'unknown'}' cannot write to global catalog '${projectId}'. ` +
        `Minimum role required: architect.`,
      { role: identity?.role, projectId },
    )
  }
}
```

- [ ] **Step 3: Run tests — confirm Task 1 tests pass**

```bash
npm test -- --reporter=verbose tests/gateway/shared-governance.test.js 2>&1 | grep -E "enforceGlobalWrite|PASS|FAIL"
```

Expected: all `enforceGlobalWriteAuthority` tests green.

---

## Task 3: Failing tests for `enforceDeviationActionAuthority`

**Files:**
- Modify: `tests/gateway/shared-governance.test.js`

- [ ] **Step 1: Add the failing test block** (after the Task 1 block)

```javascript
describe('enforceDeviationActionAuthority', () => {
  it('allows architect to accept a deviation', () => {
    expect(() => enforceDeviationActionAuthority('architect', 'accept')).not.toThrow()
  })

  it('allows principal_architect to deny a deviation', () => {
    expect(() => enforceDeviationActionAuthority('principal_architect', 'deny')).not.toThrow()
  })

  it('allows product_owner to defer a deviation', () => {
    expect(() => enforceDeviationActionAuthority('product_owner', 'defer')).not.toThrow()
  })

  it('allows compliance_officer to accept a deviation', () => {
    expect(() => enforceDeviationActionAuthority('compliance_officer', 'accept')).not.toThrow()
  })

  it('throws for engineer attempting to accept a deviation', () => {
    expect(() => enforceDeviationActionAuthority('engineer', 'accept')).toThrow(ConstitutionalViolation)
  })

  it('throws for senior_engineer attempting to deny', () => {
    expect(() => enforceDeviationActionAuthority('senior_engineer', 'deny')).toThrow(ConstitutionalViolation)
  })

  it('throws for director (executive roles are read-only in governance)', () => {
    expect(() => enforceDeviationActionAuthority('director', 'deny')).toThrow(ConstitutionalViolation)
  })

  it('throws for vp_engineering (executive roles are read-only)', () => {
    expect(() => enforceDeviationActionAuthority('vp_engineering', 'accept')).toThrow(ConstitutionalViolation)
  })

  it('throws for group_executive (executive roles are read-only)', () => {
    expect(() => enforceDeviationActionAuthority('group_executive', 'defer')).toThrow(ConstitutionalViolation)
  })

  it('violation carries rule DEVIATION_ACTION_AUTHORITY with correct context', () => {
    try {
      enforceDeviationActionAuthority('engineer', 'accept')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConstitutionalViolation)
      expect(err.rule).toBe('DEVIATION_ACTION_AUTHORITY')
      expect(err.context.actorRole).toBe('engineer')
      expect(err.context.operation).toBe('accept')
    }
  })
})
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
npm test -- --reporter=verbose tests/gateway/shared-governance.test.js 2>&1 | tail -20
```

Expected: `enforceDeviationActionAuthority is not a function`.

---

## Task 4: Implement `enforceDeviationActionAuthority`

**Files:**
- Modify: `gateway/src/shared/governance/constitutional.js`

- [ ] **Step 1: Add the function**

```javascript
// ── Deviation governance authority ────────────────────────────────────────────

/**
 * Throws if the actor lacks authority to action (accept/deny/defer) a deviation.
 *
 * Architect-tier roles and business-authority roles can govern deviations.
 * Executive roles (director, vp_engineering, group_executive) are READ-ONLY —
 * they see portfolio data but cannot change governance state. Enforced here at
 * the constitutional layer, not just the UI, so API calls are also rejected.
 *
 * @param {string} actorRole
 * @param {'accept'|'deny'|'defer'} operation
 */
export function enforceDeviationActionAuthority(actorRole, operation) {
  const ALLOWED_ROLES = [
    'architect',
    'principal_architect',
    'product_owner',
    'compliance_officer',
  ]

  if (!ALLOWED_ROLES.includes(actorRole)) {
    throw new ConstitutionalViolation(
      'DEVIATION_ACTION_AUTHORITY',
      `Role '${actorRole}' cannot ${operation} deviations. Minimum role required: architect.`,
      { actorRole, operation },
    )
  }
}
```

- [ ] **Step 2: Run tests — confirm Task 3 tests pass**

```bash
npm test -- --reporter=verbose tests/gateway/shared-governance.test.js 2>&1 | grep -E "enforceDeviationAction|PASS|FAIL"
```

---

## Task 5: Failing tests for `enforceValidDeferDeadline`

**Files:**
- Modify: `tests/gateway/shared-governance.test.js`

- [ ] **Step 1: Add the failing test block**

```javascript
describe('enforceValidDeferDeadline', () => {
  // Helper: create a Date exactly N days from now
  function daysFromNow(n) {
    return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString()
  }

  it('accepts exactly 30 days from now', () => {
    expect(() => enforceValidDeferDeadline(daysFromNow(30))).not.toThrow()
  })

  it('accepts exactly 45 days from now', () => {
    expect(() => enforceValidDeferDeadline(daysFromNow(45))).not.toThrow()
  })

  it('accepts exactly 60 days from now', () => {
    expect(() => enforceValidDeferDeadline(daysFromNow(60))).not.toThrow()
  })

  it('accepts exactly 90 days from now', () => {
    expect(() => enforceValidDeferDeadline(daysFromNow(90))).not.toThrow()
  })

  it('rejects 29 days (not a valid option)', () => {
    expect(() => enforceValidDeferDeadline(daysFromNow(29))).toThrow(ConstitutionalViolation)
  })

  it('rejects 31 days (not a valid option)', () => {
    expect(() => enforceValidDeferDeadline(daysFromNow(31))).toThrow(ConstitutionalViolation)
  })

  it('rejects 0 days (immediate expiry is not a defer)', () => {
    expect(() => enforceValidDeferDeadline(new Date().toISOString())).toThrow(ConstitutionalViolation)
  })

  it('rejects 120 days (no indefinite deferrals)', () => {
    expect(() => enforceValidDeferDeadline(daysFromNow(120))).toThrow(ConstitutionalViolation)
  })

  it('also accepts Date objects, not just ISO strings', () => {
    expect(() => enforceValidDeferDeadline(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000))).not.toThrow()
  })

  it('violation carries rule DEFER_DEADLINE with the computed day count', () => {
    try {
      enforceValidDeferDeadline(daysFromNow(31))
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConstitutionalViolation)
      expect(err.rule).toBe('DEFER_DEADLINE')
      expect(err.context.days).toBe(31)
    }
  })
})
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
npm test -- --reporter=verbose tests/gateway/shared-governance.test.js 2>&1 | tail -20
```

---

## Task 6: Implement `enforceValidDeferDeadline`

**Files:**
- Modify: `gateway/src/shared/governance/constitutional.js`

- [ ] **Step 1: Add the function**

```javascript
// ── Defer deadline validation ──────────────────────────────────────────────────

/**
 * Throws if the defer deadline is not exactly 30, 45, 60, or 90 days from now.
 *
 * Fixed options create accountability checkpoints and prevent indefinite deferrals.
 * A PE who chooses 90 days is making a visible, recorded commitment to revisit.
 * Arbitrary dates would make the commitment ambiguous and harder to surface in
 * the portfolio view.
 *
 * Tolerance: ±1 day rounding (Math.round) to absorb clock skew between
 * client and server when deadline is computed client-side.
 *
 * @param {string | Date} deferUntil - ISO timestamp or Date object
 */
export function enforceValidDeferDeadline(deferUntil) {
  const days = Math.round(
    (new Date(deferUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  )
  if (![30, 45, 60, 90].includes(days)) {
    throw new ConstitutionalViolation(
      'DEFER_DEADLINE',
      `Defer deadline must be exactly 30, 45, 60, or 90 days from now. Got: ${days} days.`,
      { days, deferUntil },
    )
  }
}
```

- [ ] **Step 2: Run ALL governance tests — confirm 100% pass**

```bash
npm test -- --reporter=verbose tests/gateway/shared-governance.test.js 2>&1 | tail -40
```

Expected: all tests green, coverage at 100%.

- [ ] **Step 3: Run full test suite — no regressions**

```bash
npm test 2>&1 | tail -20
```

- [ ] **Step 4: Commit**

```bash
git add gateway/src/shared/governance/constitutional.js tests/gateway/shared-governance.test.js
git commit -m "feat(constitutional): add enforceGlobalWriteAuthority, enforceDeviationActionAuthority, enforceValidDeferDeadline

Lifts GAP-27 global write guard into the constitutional layer (widens from
principal_architect-only to all architect-tier + business-authority roles).
Adds deviation governance authority check (executives are read-only).
Adds defer deadline validation (only 30/45/60/90 days permitted).

100% coverage maintained on all three new functions."
```

---

## Task 7: Sync constitutional.js to quorum-mcp

**Files:**
- Modify: `quorum-mcp/src/governance/constitutional.js`

- [ ] **Step 1: Apply identical changes**

The three new functions and the updated JSDoc on `ConstitutionalViolation` must be copied verbatim to `quorum-mcp/src/governance/constitutional.js`. The files must be character-for-character identical in their shared content.

Open both files side by side and verify: the only expected differences are the file header comments if any exist.

- [ ] **Step 2: Verify the quorum-mcp tests pass**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp
npm test 2>&1 | tail -20
```

- [ ] **Step 3: Commit in quorum-mcp**

```bash
git add src/governance/constitutional.js
git commit -m "feat(constitutional): sync enforceGlobalWriteAuthority, enforceDeviationActionAuthority, enforceValidDeferDeadline from gateway"
```

---

## Task 8: SQL DDL — add `is_global` to `q_projects` and new tables

**Files:**
- Modify: `scripts/init-db.sql`
- Modify: `helm/quorum/files/init-db.sql` (must be kept in sync)

- [ ] **Step 1: Add `is_global` column to `q_projects`**

In `scripts/init-db.sql`, find the `q_projects` table definition. After the `config_version` line, add:

```sql
  -- Federation: true if this project is a global standards catalog.
  -- Global catalogs are discoverable by all authenticated users and may be
  -- linked by project configs via the globals: [...] field.
  -- Setting is_global = true requires multi-party approval (enforceMultiPartyConfig).
  is_global       BOOLEAN NOT NULL DEFAULT FALSE,
```

Then add an index for `GET /api/globals` discovery after the existing `q_projects` indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_qp_is_global ON q_projects (is_global)
  WHERE is_global = TRUE;
```

Also add the new column to the narrow UPDATE grant:

Find:
```sql
GRANT UPDATE (members, domains, governance, display_name, owner, config_version)
  ON q_projects TO quorum_app;
```

Replace with:
```sql
GRANT UPDATE (members, domains, governance, display_name, owner, config_version, is_global)
  ON q_projects TO quorum_app;
```

- [ ] **Step 2: Add `project_scans` table** (tracks scan history for `scan_count` + `last_scan_at` per project)

After the `author_domain_stats` table, add:

```sql
-- ── Project scan log (conformance scan history) ──────────────────────────────
-- One row per scan run. Used to compute scan_count and last_scan_at for the
-- conformance API. Separate table rather than derived from deviations.last_seen_at
-- because: (a) a scan with zero new deviations still counts; (b) partial scans
-- (incremental, changed files only) update last_seen_at but not last_full_scan_at.
CREATE TABLE IF NOT EXISTS project_scans (
  scan_id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  q_project_id     TEXT NOT NULL REFERENCES q_projects(q_project_id),
  scan_type        TEXT NOT NULL CHECK (scan_type IN ('full', 'incremental')),
  triggered_by     TEXT NOT NULL,   -- 'agent' | 'quorum:scan' | 'scheduled'
  files_scanned    INTEGER,
  deviations_new   INTEGER NOT NULL DEFAULT 0,
  deviations_confirmed INTEGER NOT NULL DEFAULT 0,
  deviations_resolved  INTEGER NOT NULL DEFAULT 0,
  candidates_surfaced  INTEGER NOT NULL DEFAULT 0,
  scanned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ps_project_scanned ON project_scans (q_project_id, scanned_at DESC);
```

Add RLS and grants for `project_scans`:

```sql
ALTER TABLE project_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_scans_insert_only ON project_scans;
CREATE POLICY project_scans_insert_only
  ON project_scans FOR INSERT TO quorum_app WITH CHECK (true);

GRANT SELECT ON project_scans TO quorum_app;
GRANT INSERT ON project_scans TO quorum_app;
```

- [ ] **Step 3: Add `deviations` table**

```sql
-- ── Deviations (conformance deviations from global catalog entries) ───────────
-- A deviation records that a project's codebase deviates from a global catalog
-- standard. Upserted on (q_project_id, catalog_id, topic, key) — running the
-- same scan twice updates last_seen_at, not creates a duplicate row.
--
-- severity is computed server-side:
--   severity = global_entry.confidence × authority_score(global_entry)
--   PA_AUTHORED_FLOOR = 0.70 (applied when global entry author_role = 'principal_architect')
-- Never accepted from client — callers supply topic:key; gateway computes severity.
CREATE TABLE IF NOT EXISTS deviations (
  deviation_id    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  q_project_id    TEXT NOT NULL REFERENCES q_projects(q_project_id),
  catalog_id      TEXT NOT NULL,   -- group_id of the global catalog this deviates from
  topic           VARCHAR(60) NOT NULL,
  key             VARCHAR(80) NOT NULL,
  description     TEXT NOT NULL,
  evidence        JSONB,           -- { files: [], lines: [], excerpt: '' }
  severity        DECIMAL(4,3) NOT NULL CHECK (severity BETWEEN 0 AND 1),
  source          VARCHAR(50) NOT NULL DEFAULT 'agent',
                                   -- 'agent' | 'code-review' | 'security-review'
  entity_type     VARCHAR(50),     -- Decision | Pattern | Constraint | Runbook | Requirement
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,     -- set when scan no longer surfaces this deviation
  created_by      TEXT NOT NULL,
  UNIQUE (q_project_id, catalog_id, topic, key)
);

CREATE INDEX IF NOT EXISTS idx_dev_project          ON deviations (q_project_id);
CREATE INDEX IF NOT EXISTS idx_dev_project_topic    ON deviations (q_project_id, topic, key);
CREATE INDEX IF NOT EXISTS idx_dev_project_severity ON deviations (q_project_id, severity DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dev_catalog          ON deviations (catalog_id);
```

Add RLS and grants:

```sql
ALTER TABLE deviations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deviations_insert_only ON deviations;
CREATE POLICY deviations_insert_only
  ON deviations FOR INSERT TO quorum_app WITH CHECK (true);

GRANT SELECT ON deviations TO quorum_app;
GRANT INSERT ON deviations TO quorum_app;
-- last_seen_at and resolved_at are updated on upsert and scan resolution
GRANT UPDATE (last_seen_at, resolved_at, description, evidence, source, severity)
  ON deviations TO quorum_app;
```

- [ ] **Step 4: Add `deviation_actions` table**

```sql
-- ── Deviation actions (accept / deny / defer) ────────────────────────────────
-- Append-only governance trail. Status is computed from the latest action:
--   no row → OPEN
--   latest action_type = 'accept' → ACCEPTED
--   latest action_type = 'deny'   → DENIED
--   latest action_type = 'defer' AND defer_until > NOW() → DEFERRED
--   latest action_type = 'defer' AND defer_until <= NOW() → OVERDUE
-- resolved_at on the parent deviations row → RESOLVED (takes precedence over all)
--
-- reason is enforced at the gateway via enforceReasonRequired (Rule 3, min 10 chars).
-- defer_until is validated via enforceValidDeferDeadline (must be 30/45/60/90 days).
CREATE TABLE IF NOT EXISTS deviation_actions (
  action_id       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  deviation_id    TEXT NOT NULL REFERENCES deviations(deviation_id),
  action_type     VARCHAR(10) NOT NULL CHECK (action_type IN ('accept', 'deny', 'defer')),
  actor           TEXT NOT NULL,
  actor_role      TEXT NOT NULL,
  reason          TEXT NOT NULL,   -- min 10 chars enforced by enforceReasonRequired
  defer_until     TIMESTAMPTZ,     -- only for defer; must be 30/45/60/90 days from created_at
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_da_deviation ON deviation_actions (deviation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_da_actor     ON deviation_actions (actor);
```

Add RLS and grants:

```sql
ALTER TABLE deviation_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deviation_actions_insert_only ON deviation_actions;
CREATE POLICY deviation_actions_insert_only
  ON deviation_actions FOR INSERT TO quorum_app WITH CHECK (true);

GRANT SELECT ON deviation_actions TO quorum_app;
GRANT INSERT ON deviation_actions TO quorum_app;
-- Deviation actions are append-only — no UPDATE grant
```

- [ ] **Step 5: Sync to Helm chart SQL**

```bash
cp scripts/init-db.sql helm/quorum/files/init-db.sql
diff scripts/init-db.sql helm/quorum/files/init-db.sql
```

Expected: no diff output.

- [ ] **Step 6: Validate the SQL syntax locally**

```bash
# Requires psql available. Dry-run validation only — no connection needed.
psql --no-psqlrc -f scripts/init-db.sql postgres://quorum:quorum@localhost:5432/quorum 2>&1 | grep -iE "error|ERROR" | head -20
```

If no local Postgres: use `pg_dump --schema-only` on the Docker dev instance or validate via Docker Compose.

- [ ] **Step 7: Commit**

```bash
git add scripts/init-db.sql helm/quorum/files/init-db.sql
git commit -m "feat(db): add deviations, deviation_actions, project_scans tables; is_global flag on q_projects

Adds SQL DDL for v0.4 deviation infrastructure. Tables are append-only with
full RLS policies and narrow update grants following existing schema patterns.
project_scans tracks scan history (scan_count + last_scan_at) — separate from
deviations.last_seen_at to correctly handle zero-deviation scans.
is_global flag on q_projects enables GET /api/globals discovery via partial index."
```

---

## Task 9: Add `DeviationStatus`, `DeviationActionType`, `VALID_DEFER_DAYS` to schema.js

**Files:**
- Modify: `gateway/src/shared/graph/schema.js`
- Modify: `quorum-mcp/src/graph/schema.js` (sync — identical)

- [ ] **Step 1: Add the new enums to `gateway/src/shared/graph/schema.js`**

Add after the `AUDIT_GROUP_ID` export at the end of the file:

```javascript
/**
 * Computed deviation status values.
 * Status is NOT stored in the deviations table — it is derived from deviation_actions
 * and the deviations.resolved_at column at query time.
 *
 * Derivation logic:
 *   resolved_at IS NOT NULL                              → RESOLVED (takes precedence)
 *   no deviation_actions row                             → OPEN
 *   latest action_type = 'accept'                       → ACCEPTED
 *   latest action_type = 'deny'                         → DENIED
 *   latest action_type = 'defer' AND defer_until > NOW() → DEFERRED
 *   latest action_type = 'defer' AND defer_until <= NOW() → OVERDUE
 */
export const DeviationStatus = /** @type {const} */ ({
  OPEN:     'OPEN',
  ACCEPTED: 'ACCEPTED',
  DENIED:   'DENIED',
  DEFERRED: 'DEFERRED',
  OVERDUE:  'OVERDUE',    // deferred but defer_until has passed — score weight reverts to 1.0
  RESOLVED: 'RESOLVED',  // scan no longer surfaces this deviation
})

/** The three governance actions a PE/architect can take on an OPEN or OVERDUE deviation. */
export const DeviationActionType = /** @type {const} */ ({
  ACCEPT: 'accept',
  DENY:   'deny',
  DEFER:  'defer',
})

/**
 * The only permitted defer durations in days.
 * Arbitrary deadlines are not accepted — fixed options create accountability
 * checkpoints and make overdue deferrals easy to surface.
 */
export const VALID_DEFER_DAYS = /** @type {const} */ ([30, 45, 60, 90])
```

- [ ] **Step 2: Sync to `quorum-mcp/src/graph/schema.js`**

Apply identical changes to `quorum-mcp/src/graph/schema.js`.

- [ ] **Step 3: Confirm existing tests still pass**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram && npm test 2>&1 | tail -10
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp && npm test 2>&1 | tail -10
```

- [ ] **Step 4: Commit (both repos)**

```bash
# In gateway repo
git add gateway/src/shared/graph/schema.js
git commit -m "feat(schema): add DeviationStatus, DeviationActionType, VALID_DEFER_DAYS enums"

# In quorum-mcp repo
git add src/graph/schema.js
git commit -m "feat(schema): sync DeviationStatus, DeviationActionType, VALID_DEFER_DAYS from gateway"
```

---

## Task 10: Extend Zod config schema for federation fields

**Files:**
- Modify: `gateway/src/shared/config/schema.js`
- Modify: `quorum-mcp/src/config/schema.js` (sync — identical)

- [ ] **Step 1: Add new schemas to `gateway/src/shared/config/schema.js`**

Add after the `NotificationsSchema` definition and before the `QuorumConfigSchema`:

```javascript
/**
 * Hierarchy position for a project in the org tree.
 * Projects that declare hierarchy can be rolled up in portfolio views.
 * criticality (1–5) weights this project in department/division rollup scores:
 *   5 = mission-critical (payments, auth, core platform)
 *   1 = internal tooling with minimal blast radius
 */
export const HierarchySchema = z.object({
  /** Must match one of the levels defined in the platform config hierarchy.levels */
  level: z.string().min(1),
  /** group_id of the parent node — null for root nodes */
  parent: z.string().optional(),
  /** Human-readable display name for dashboard and portfolio views */
  display_name: z.string().optional(),
  /** 1–5 criticality weight for portfolio rollup scoring */
  criticality: z.number().int().min(1).max(5).optional(),
})
```

- [ ] **Step 2: Add federation fields to `QuorumConfigSchema`**

Find the closing `})` of `QuorumConfigSchema`. Before it, add the new optional fields:

```javascript
  /**
   * Hierarchy position in the org tree.
   * Projects that declare hierarchy can be rolled up by GET /api/portfolio.
   */
  hierarchy: HierarchySchema.optional(),

  /**
   * Marks this project as a global standards catalog.
   * Global projects are discoverable via GET /api/globals and may be linked
   * by other projects via the globals field.
   *
   * Setting is_global: true is a governance decision that affects the whole org.
   * It requires multi-party approval (enforceMultiPartyConfig) — not just the project owner.
   * The gateway's PUT /config enforces this distinction.
   */
  is_global: z.boolean().optional(),

  /**
   * Visibility scope for this global catalog. Only meaningful when is_global: true.
   *   'org'                — visible to all authenticated projects (default)
   *   'division:<group_id>' — visible only to projects in the named division
   *   'department:<group_id>' — visible only to projects in the named department
   */
  global_scope: z
    .string()
    .regex(
      /^(org|division:[a-z0-9-]+|department:[a-z0-9-]+)$/,
      'global_scope must be "org", "division:<group_id>", or "department:<group_id>"',
    )
    .optional(),

  /**
   * Marks this project's knowledge as freely readable without authentication.
   * Future capability — flag is defined now to reserve the field.
   * No current enforcement; all reads still require a valid JWT.
   */
  is_public: z.boolean().optional(),

  /**
   * Explicit list of global catalog group_ids this project links to.
   * Cross-catalog reads and conformance scoring are scoped to this list.
   *   - Only projects with is_global: true may be listed here
   *   - A project cannot list itself (enforced in POST /sync/configs)
   *   - Empty array (default): reads are project-scoped only, score is UNCERTIFIED
   */
  globals: z.array(z.string().regex(/^[a-z0-9-]+$/)).optional(),
```

- [ ] **Step 3: Sync to `quorum-mcp/src/config/schema.js`**

Apply identical changes (same new `HierarchySchema` + same new fields in `QuorumConfigSchema`).

- [ ] **Step 4: Run tests in both repos**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram && npm test 2>&1 | tail -10
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp && npm test 2>&1 | tail -10
```

- [ ] **Step 5: Commit (both repos)**

```bash
# Gateway repo
git add gateway/src/shared/config/schema.js
git commit -m "feat(config): add hierarchy, is_global, global_scope, is_public, globals fields to QuorumConfigSchema

Enables federation: projects can declare themselves as global catalogs (is_global: true)
and link to global catalogs (globals: [...]). global_scope restricts catalog visibility
by org hierarchy level. is_public reserved for future unauthenticated reads."

# quorum-mcp repo
git add src/config/schema.js
git commit -m "feat(config): sync federation fields from gateway QuorumConfigSchema"
```

---

## Task 11: Replace soft guard in `remember.js` + fix isGlobal checks

**Files:**
- Modify: `quorum-mcp/src/tools/remember.js`

This task has 3 sub-changes. Make them all, run tests once, commit once.

- [ ] **Step 1: Add the new import**

Find the existing import from `'../governance/constitutional.js'`:
```javascript
import { enforceReasonRequired, enforceConflictPartyCannotSelfResolve } from '../governance/constitutional.js'
```

Replace with:
```javascript
import {
  enforceReasonRequired,
  enforceConflictPartyCannotSelfResolve,
  enforceGlobalWriteAuthority,
} from '../governance/constitutional.js'
```

- [ ] **Step 2: Replace the soft-return guard (lines 117-128)**

Find this block:
```javascript
  // ── GAP-27: Global namespace write guard ────────────────────────────────────
  // The 'global' project is readable by all projects but writable only by
  // principal_architect. Every global write enters DRAFT — no auto-activation.
  if (projectId === GLOBAL_PROJECT_ID) {
    if (identity?.role !== 'principal_architect') {
      return {
        status: 'forbidden',
        message: `Only principal_architect role can write to the global namespace. Your role: ${identity?.role ?? 'unknown'}.`,
        hint: 'Global knowledge is company-wide policy. Ask a principal_architect to submit or approve.',
      }
    }
  }
```

Replace with:
```javascript
  // ── GAP-27: Global catalog write authority ──────────────────────────────────
  // Widened from principal_architect-only to all architect-tier and business-authority
  // roles. Uses the constitutional layer (throws) instead of a soft return.
  // is_global is read from the local .quorum file — no HTTP call required.
  enforceGlobalWriteAuthority(identity, projectId, getConfig()?.is_global === true)
```

- [ ] **Step 3: Fix `isGlobal` in `supersede()` (~line 255)**

Find in the `supersede` function:
```javascript
  const isGlobal = projectId === GLOBAL_PROJECT_ID
```

Replace with:
```javascript
  // Use the project config flag, not the legacy 'global' project ID string.
  // is_global is set in the .quorum file — readable via getConfig() in the MCP.
  const isGlobal = getConfig()?.is_global === true
```

- [ ] **Step 4: Fix `isGlobal` in `storeFirst()` (~line 360)**

Find in the `storeFirst` function:
```javascript
  const isGlobal = projectId === GLOBAL_PROJECT_ID
```

Replace with:
```javascript
  const isGlobal = getConfig()?.is_global === true
```

- [ ] **Step 5: Run quorum-mcp tests**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp && npm test 2>&1 | tail -20
```

Expected: all tests pass. If existing tests assert the old `{ status: 'forbidden' }` return shape, update them to expect a `ConstitutionalViolation` throw instead.

- [ ] **Step 6: Commit**

```bash
git add src/tools/remember.js
git commit -m "feat(remember): replace GAP-27 soft guard with enforceGlobalWriteAuthority constitutional throw

Replaces the soft { status: 'forbidden' } return at lines 117-128 with a
ConstitutionalViolation throw via enforceGlobalWriteAuthority(). Widens
write access from principal_architect-only to all architect-tier and
business-authority roles. Fixes isGlobal checks in storeFirst() and
supersede() to use is_global flag from project config instead of the
hardcoded 'global' project ID string."
```

---

## Task 12: Add executive roles to `authority.js`

**Files:**
- Modify: `gateway/src/shared/governance/authority.js`
- Modify: `quorum-mcp/src/governance/authority.js` (sync — identical)

- [ ] **Step 1: Add executive roles to `DEFAULT_ROLE_SCORES`**

Find the `// Business roles` block:
```javascript
  // Business roles
  business_analyst:     0.65,
  product_owner:        0.85,
  compliance_officer:   0.90,
```

Add after it:
```javascript
  // Executive roles (read-only governance consumers — can read portfolio, cannot action deviations)
  director:             0.75,   // department/division level visibility
  vp_engineering:       0.75,   // org-wide visibility but read-only governance
  group_executive:      0.70,   // group level visibility
```

- [ ] **Step 2: Add executive roles to `ROLE_TIER`**

Find the `// Business roles` block in `ROLE_TIER`:
```javascript
  // Business roles
  business_analyst:     2,
  product_owner:        3,
  compliance_officer:   3,
```

Add after it:
```javascript
  // Executive roles — tier 3 so their entries aren't silently superseded by engineers,
  // but enforceDeviationActionAuthority prevents them from actioning deviations.
  director:             3,
  vp_engineering:       3,
  group_executive:      3,
```

- [ ] **Step 3: Sync to `quorum-mcp/src/governance/authority.js`**

Apply identical changes.

- [ ] **Step 4: Run tests in both repos**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram && npm test 2>&1 | tail -10
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp && npm test 2>&1 | tail -10
```

- [ ] **Step 5: Commit (both repos)**

```bash
# Gateway
git add gateway/src/shared/governance/authority.js
git commit -m "feat(authority): add director, vp_engineering, group_executive executive roles

Tier 3 so entries aren't silently superseded by engineers. enforceDeviationActionAuthority
prevents them from actioning deviations — they are read-only consumers in the governance model."

# quorum-mcp
git add src/governance/authority.js
git commit -m "feat(authority): sync executive roles from gateway"
```

---

## Task 13: Wave A end-to-end verification

- [ ] **Verify 1: Full test suite green**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram && npm test 2>&1 | tail -20
```

Expected: 0 failures.

- [ ] **Verify 2: Constitutional coverage check**

The test runner must show 100% function coverage for `constitutional.js`. Check the coverage output or run:

```bash
npm test -- --coverage tests/gateway/shared-governance.test.js 2>&1 | grep -A5 "constitutional"
```

- [ ] **Verify 3: Schema sanity check**

Confirm the new Zod fields parse correctly:

```javascript
// Run this snippet in a node REPL or a quick test
import { QuorumConfigSchema } from './gateway/src/shared/config/schema.js'

const result = QuorumConfigSchema.safeParse({
  owner: 'alice',
  group_id: 'security-standards',
  is_global: true,
  global_scope: 'org',
  globals: [],
})
console.assert(result.success, 'Schema parse failed:', result.error)

const badScope = QuorumConfigSchema.safeParse({
  owner: 'alice',
  group_id: 'security-standards',
  global_scope: 'invalid-format',
})
console.assert(!badScope.success, 'Should have rejected invalid global_scope')
```

- [ ] **Verify 4: SQL syntax**

```bash
# Check for obvious SQL errors in the new additions
grep -n "CREATE TABLE\|CREATE INDEX\|GRANT\|ALTER TABLE\|CREATE POLICY" scripts/init-db.sql | tail -30
```

Confirm `deviations`, `deviation_actions`, `project_scans` all appear in the output.

- [ ] **Verify 5: Helm SQL in sync**

```bash
diff scripts/init-db.sql helm/quorum/files/init-db.sql && echo "IN SYNC" || echo "OUT OF SYNC — fix before continuing"
```

---

## Wave A Completion Checklist

Before starting Wave B, confirm every item:

- [ ] `enforceGlobalWriteAuthority` — implemented, tested, synced to quorum-mcp
- [ ] `enforceDeviationActionAuthority` — implemented, tested, synced to quorum-mcp
- [ ] `enforceValidDeferDeadline` — implemented, tested, synced to quorum-mcp
- [ ] All three new functions have 100% branch coverage in `shared-governance.test.js`
- [ ] `scripts/init-db.sql` has `deviations`, `deviation_actions`, `project_scans`, `is_global` on `q_projects`
- [ ] `helm/quorum/files/init-db.sql` is identical to `scripts/init-db.sql`
- [ ] `DeviationStatus`, `DeviationActionType`, `VALID_DEFER_DAYS` exported from `graph/schema.js` (both repos)
- [ ] `QuorumConfigSchema` accepts `hierarchy`, `is_global`, `global_scope`, `is_public`, `globals` (both repos)
- [ ] `remember.js` soft guard replaced with `enforceGlobalWriteAuthority` throw
- [ ] `remember.js` `isGlobal` checks use `getConfig()?.is_global === true` (both occurrences)
- [ ] Executive roles added to `authority.js` (both repos)
- [ ] Full test suite green in both repos

---

## Waves B–G: Summary Plan

Detailed task breakdown for these waves will be written at the start of each wave. High-level scope:

**Wave B — Federation (2 weeks):** `graphiti.js` cross-catalog group_ids injection; `GET /api/globals` endpoint; `detectConflict()` scoped search (add BOTH projectId AND globals); `recall()` + `search()` source annotations; `POST /sync/configs` globals validation; `quorum:onboard` skill stub.

**Wave C — Deviation Write Path (1 week):** `deviate.js` MCP tool; `POST /api/deviations` + batch endpoint; `upsertDeviation` + `batchUpsertDeviations` queries; PA_AUTHORED_FLOOR severity logic.

**Wave D — PE Governance (2 weeks):** `POST /api/deviations/:id/action`; `GET /api/deviations` with computed status; `pending()` MCP update; Dashboard Deviations page; Pending page overdue section.

**Wave E — Conformance Scoring (1 week):** `conformance.js` MCP tool; `GET /api/conformance`; UNCERTIFIED gate; `getConformanceScore` query; Stats page badge; `quorum:scan` skill (full implementation).

**Wave F — Portfolio (1 week):** `GET /api/portfolio` with hierarchy rollup; `getPortfolioScores` query; `denial_hint_count` computed count in Knowledge page; overdue deferral surfacing.

**Wave G — Documentation (1 week):** Both repos — CLAUDE.md, ARCHITECTURE.md, ROADMAP.md, ONBOARDING.md, FRONTEND.md, openapi.yaml updates, quorum-mcp SKILL.md.
