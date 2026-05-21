# Quorum v0.4 — Federation, Conformance & Portfolio Intelligence
**Design Spec**
*Date: 2026-05-21*

---

## Context

Quorum v0.3 shipped a working knowledge governance layer: store, version, conflict-detect, and audit engineering and business knowledge for a single project. It works. Engineers and architects are using it.

The v0.4 scope comes from a stakeholder session with engineers, architects, and a Director of Engineering who reviewed the current system. Their feedback clustered into five themes:

1. Shared knowledge across projects
2. Identifying projects that have deviated from established standards
3. Retrospective review of a project against a core knowledge base
4. Linking multiple projects to see shared knowledge
5. Portfolio-level visibility for leadership

This spec designs those capabilities as one coherent product arc, not five separate features.

---

## Philosophy — The Library

Quorum is a library. It holds institutional knowledge — decisions, patterns, constraints, requirements, runbooks. The library never blocks access. It scores alignment, surfaces gaps, and lets the right people own the remediation.

The five constitutional rules protect catalog integrity (no destruction, full provenance, reason required, no self-approval, multi-party config). They do not control what agents or engineers do with the knowledge. This distinction is foundational and must be preserved in every design decision in this spec.

**What Quorum v0.4 adds:** the ability for the library to serve multiple reading rooms (projects) from one or more shared reference sections (global catalogs — each a distinct Quorum project), to know which reading rooms are drifting from their chosen reference sections (conformance scanning), and to give leadership a view of the whole library's health (portfolio).

---

## What Is Already Built — Do Not Re-Implement

Before implementing anything, confirm these exist and work:

| Capability | Location | Notes |
|-----------|----------|-------|
| Business roles | `authority.js:34-45` | `product_owner (0.85)`, `business_analyst (0.65)`, `compliance_officer (0.90)` already in DEFAULT_ROLE_SCORES and ROLE_TIER |
| `architect` role | `authority.js:39` | Already exists at score 0.80, tier 3 |
| Global namespace guard (GAP-27) | `remember.js:117-128` | Global write exists but is PA-only and in application code, not constitutional layer |
| `GET /schema/config` | `routes/schema.js` | Already serves JSON Schema for `.quorum` files — extend, don't replace |
| Platform config (`configs/.quorum`) | Gateway S3 + DDB | Already exists as master platform config |
| `Requirement` entity type | `remember.js schema:83` | Already in enum alongside Decision, Pattern, Constraint, Runbook |
| Conflict detection pipeline | `shared/governance/conflict.js` | Already exists — needs extension for global group_id search |
| DRAFT-always for global writes | `remember.js:268, 374` | Already enforced via `isGlobal` check in `supersede()` and `storeFirst()` — update check from `=== 'global'` to `projectConfig.is_global === true` |
| `POST /sync/configs` | `routes/sync.js` | Already validates and syncs project configs — extend to validate hierarchy |

---

## New Capabilities Overview

```
v0.4 adds four layers, each building on the previous:

Layer 1 — Federation
  Any project can be elevated to a global catalog (is_global: true in .quorum).
  Each project explicitly links to any or all global projects via globals: [...].
  Global projects can reference other global projects (catalog hierarchy, ≥ 0).
  Architect+ can write to a global catalog (DRAFT); PA approves → ACTIVE.

Layer 2 — Deviation Infrastructure
  Agents record deviations from global catalog entries.
  Skill-orchestrated: code-review + security-review outputs
  are translated into topic:key deviation records.
  Incremental: only changed files re-scanned.

Layer 3 — PE Governance
  PE/PA actions deviations: accept / deny / defer (30/45/60/90 days).
  Unmatched findings enter project-level DRAFT — PE/PA decides if globally applicable.
  Self-evolution: PEs promote project DRAFTs → global catalog entries (deliberate, not automatic).

Layer 4 — Portfolio Intelligence
  Per-project conformance score (0-100%).
  Org hierarchy rollup: Department → Division → Group.
  Executive read-only visibility scoped to their hierarchy node.
```

---

## 1. Organisational Hierarchy

### Model

Hierarchy is defined in two places:

**Platform config (`configs/.quorum`) — defines the schema:**
```json
{
  "hierarchy": {
    "levels": ["group", "division", "department", "service", "application"],
    "display_names": {
      "group":       ["GroupA"],
      "division":    ["DivisionA"],
      "department":  ["DepartmentA", "DepartmentB"],
      "service":     ["ServiceA", "ServiceB"],
      "application": ["ApplicationA", "ApplicationB"]
    }
  }
}
```

> Note: `display_names` is a map of `{ level → string[] }`. Valid domain names come from `Object.keys(config.domains)` — the existing `domains` record already serves this purpose; do NOT add a separate `domains: string[]` field.

Different orgs define their own levels. Macquarie uses 5. A startup might use 2 (`["team", "service"]`). No hierarchy logic in code — all config-driven.

**Project `.quorum` file — declares position in hierarchy, whether it is a global catalog, and which global catalogs it links to:**
```json
{
  "group_id": "payments-service",
  "owner": "alice",
  "is_public": false,
  "is_global": false,
  "hierarchy": {
    "level": "service",
    "parent": "payments-department",
    "display_name": "Payments Processing Service",
    "criticality": 4
  },
  "globals": ["security-standards", "payments-compliance"]
}
```

```json
{
  "group_id": "security-standards",
  "owner": "sec-team",
  "is_global": true,
  "global_scope": "org",
  "globals": ["org-base-standards"]
}
```

```json
{
  "group_id": "payments-compliance",
  "owner": "payments-pa",
  "is_global": true,
  "global_scope": "division:payments-division"
}
```

**`is_global: true`** — marks this project as a global catalog. Only `is_global` projects can appear in another project's `globals` list. Any senior role (architect+) can write to a global project (constitutional enforcement). Setting `is_global: true` is a high-impact config change — requires multi-party approval via `enforceMultiPartyConfig` (PA + one other, 48h cooling). This is correct: elevating a project to a global catalog is a governance decision that affects the whole org.

**`globals: [...]` config write authority** — setting or updating a project's `globals` list (opting into global catalogs) requires only the project owner or a `principal_architect`. It does NOT require multi-party approval — you are opting your project IN to standards, not imposing them on others. `PUT /config` must enforce this distinction: `is_global` field changes → `enforceMultiPartyConfig`; `globals` field changes → project owner/PA only.

**`is_public: true`** — marks this project's knowledge as freely readable without authentication (future; flag defined in schema now for completeness).

**`globals: [...]`** — explicit list of `group_id` values that are `is_global: true` projects this project links to. A project (global or non-global) is only scored against the catalogs it has opted into. Global projects can also list other global projects in `globals` — enabling catalog inheritance (e.g., a division-level security catalog inheriting from an org-level security catalog). Minimum 0 references. During `quorum:onboard`, the gateway serves available global projects visible to the onboarding user — they select which to link.

**No platform config registry** — global catalogs are discovered from DDB by reading `is_global: true` on project configs, not from a central registry. The gateway indexes this via a DDB GSI on the `is_global` attribute.

`criticality` (1–5) is used for rollup weighting. A payments service with criticality 5 weights more in a department's score than an internal tooling service with criticality 1.

### Validation Chain

```
Platform config defines valid levels + domains
       ↓
GET /schema/config (already exists) — emit hierarchy.level as dynamic enum
  from platform config levels. IDEs show only valid levels.
       ↓
POST /sync/configs (already exists) — validate on import:
  - hierarchy.level is a known level
  - hierarchy.parent is a known group_id in DDB (or null for root nodes)
  - each entry in globals resolves to is_global = true in q_projects
  - globals self-reference check: group_id must not appear in its own globals list
       ↓
Portfolio API — tree always coherent, parents always resolvable
```

### Rollup Formula

```
node_conformance_score = Σ(child_score × child_criticality) / Σ(child_criticality)
```

If no criticality configured: simple average. Leaves (projects with no children) use their own conformance score directly.

### Config Schema Changes

`gateway/src/shared/config/schema.js` (Zod) — extend `QuorumConfigSchema`:

```javascript
// Add to shared config schema (applies to both platform and project configs):
hierarchy: z.object({
  // Platform-level: hierarchy structure definition
  levels: z.array(z.string()).optional(),
  display_names: z.record(z.array(z.string())).optional(),  // { level → string[] }
  // Project-level: hierarchy position
  level: z.string().optional(),
  parent: z.string().optional(),
  display_name: z.string().optional(),
  criticality: z.number().min(1).max(5).optional(),
}).optional(),
is_global: z.boolean().optional(),         // true = this project is a global catalog (architect+ writes, PA approves)
global_scope: z.string().regex(/^(org|division:[a-z0-9-]+|department:[a-z0-9-]+)$/).optional(),
                                           // only meaningful when is_global: true; controls visibility in GET /api/globals
is_public: z.boolean().optional(),         // true = freely readable without auth (future; define now)
globals: z.array(z.string()).optional(),   // group_ids of linked global-catalog projects (must have is_global: true)
```

> **DO NOT** add `domains: z.array(z.string())` — the existing `domains: z.record()` field already covers per-domain governance config. Valid domain names are `Object.keys(config.domains)`. Adding an array would create a naming collision.

Vendored copy in `quorum-mcp/src/shared/config/schema.js` must be updated in sync.

---

## 2. New Executive Roles

Add to `DEFAULT_ROLE_SCORES` and `ROLE_TIER` in `authority.js` (both repos):

```javascript
// New executive roles
director:          0.75,   // tier 3 — department/division level visibility
vp_engineering:    0.75,   // tier 3
group_executive:   0.70,   // tier 3 — group level visibility

// ROLE_TIER additions
director:          3,
vp_engineering:    3,
group_executive:   3,
```

Executive roles are **read-only consumers** — they never action deviations, approve knowledge, or resolve conflicts. Their role score exists so that if they do add knowledge (rare), it's weighted appropriately. Their tier ensures their entries aren't silently superseded by engineers.

**Governance gate**: `enforceDeviationActionAuthority()` (new constitutional function) allows only `architect` and above to action deviations. Executive roles are excluded from governance actions — enforced at the constitutional layer, not just the UI.

---

## 3. Federation — Global Commons Layer

### GAP-27 Constitutional Lift + Guard Softening

**Current state**: `remember.js:119-128` has an application-level guard returning `{ status: 'forbidden' }` for non-PA global writes. This is wrong — a constitutional invariant must throw, not return.

**Change 1** — Move to `constitutional.js`, widen to `architect+`, accept catalog registry:

```javascript
// New function in constitutional.js (both repos)
// isGlobalProject: boolean — resolved from the target project's config (is_global: true)
export function enforceGlobalWriteAuthority(identity, projectId, isGlobalProject) {
  if (!isGlobalProject) return
  const GLOBAL_WRITE_ROLES = ['architect', 'principal_architect',
                               'product_owner', 'compliance_officer']
  if (!GLOBAL_WRITE_ROLES.includes(identity?.role)) {
    throw new ConstitutionalViolation(
      'GLOBAL_WRITE_AUTHORITY',
      `Role '${identity?.role ?? 'unknown'}' cannot write to global catalog '${projectId}'. ` +
      `Minimum role required: architect.`,
      { role: identity?.role, projectId }
    )
  }
}
```

**Change 2** — Remove the application-level guard from `remember.js:119-128`. Replace with a call to `enforceGlobalWriteAuthority(identity, projectId, getConfig()?.is_global === true)`.

> Note: `getConfig()` in the MCP returns the current project's `.quorum` config directly — no HTTP round-trip needed. Use `getConfig()?.is_global === true` throughout.

**`isGlobal` check in `storeFirst()` and `supersede()`** — update from `projectId === GLOBAL_PROJECT_ID` to `getConfig()?.is_global === true` so all global catalog writes always enter DRAFT regardless of the project's name.

**Update `ConstitutionalViolation` rule union** to include `'GLOBAL_WRITE_AUTHORITY'`.

### Global Catalog Discovery

**New endpoint: `GET /api/globals`** (gateway)
- Auth: authenticated user
- Discovers all projects with `is_global: true` from DDB (via GSI on `is_global` attribute)
- Filters by `global_scope`: `scope: 'org'` (or absent) → visible to all; `scope: 'division:<id>'` → visible only to projects whose hierarchy ancestry includes `<id>`; `scope: 'department:<id>'` → same, narrower
- Used by `quorum:onboard` skill to present catalog choices to the onboarding user
- Response: `[{ group_id, display_name, global_scope, entry_count, globals[] }]` — `globals` shows any other global projects this catalog itself links to (catalog hierarchy)

### Cross-Project Reads

**`routes/graphiti.js` (gateway)**
- Load the requesting project's `globals` array from cached project config
- For MCP `search_nodes` and `search_memory_facts` tool calls (read operations): inject `group_ids: [normalizeGroupId(projectGroupId), ...normalizeGroupIds(project.globals)]`
- For `add_memory` (write operations): single `group_id` only — unchanged
- If `project.globals` is empty or undefined: reads are project-scoped only (no cross-catalog reads)
- Add `X-Quorum-Include-Globals: false` escape hatch for explicit single-project queries
- Detect operation type by inspecting `req.body?.params?.name` — the MCP tool name

**`recall.js` and `search.js` (quorum-mcp)**
- MCP fetches its own project config (already happens for identity resolution) — extract `globals` array
- Extend both to pass `groupIds: [projectId, ...globals]` for all read operations
- Annotate results: add `source: 'project' | 'global'` and `catalog_id: string | null` to each returned node
- `catalog_id` is the group_id of the global catalog the entry came from — null for project-local entries

**`conflict.js` — `detectConflict()` (both repos — CRITICAL)**
- Currently calls `searchNodes(newContent, { limit: 5 })` with **NO groupId scoping** — existing behaviour is accidentally unscoped
- Must change to `searchNodes(newContent, { limit: 5, groupIds: [normalizedProjectId, ...normalizedGlobals] })`
- `globals` array passed as parameter — caller resolves from `getConfig()?.globals ?? []`
- Without this fix, a project-local `remember()` can silently contradict a global catalog entry — a governance gap
- **This fix MUST land in the same Wave B PR as cross-project reads — never after**

---

## 4. Deviation Infrastructure

### Data Model

New tables in `scripts/init-db.sql` (and `helm/quorum/files/init-db.sql` — both must stay in sync).

> **Important**: `migrations.js` handles ONLY JSONB governance config field migrations. New PostgreSQL tables always go in `scripts/init-db.sql`. Each new table requires: `CREATE TABLE IF NOT EXISTS`, indexes, `ALTER TABLE ENABLE ROW LEVEL SECURITY`, `DROP/CREATE POLICY`, `GRANT SELECT/INSERT`, and narrow `GRANT UPDATE` if any column is mutable.

```sql
-- Extend q_projects with is_global flag
ALTER TABLE q_projects ADD COLUMN IF NOT EXISTS is_global BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_q_projects_is_global ON q_projects(is_global) WHERE is_global = TRUE;

-- Track scan runs per project (separate from deviations — zero-deviation scans still count)
CREATE TABLE IF NOT EXISTS project_scans (
  scan_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  VARCHAR(255) NOT NULL,
  scan_type   VARCHAR(20) NOT NULL DEFAULT 'incremental',  -- 'full' | 'incremental'
  scanned_by  VARCHAR(255) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_scans_project ON project_scans(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deviations (
  deviation_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    VARCHAR(255) NOT NULL,
  catalog_id    VARCHAR(255) NOT NULL,  -- group_id of the global catalog this deviates from
  topic         VARCHAR(60) NOT NULL,
  key           VARCHAR(80) NOT NULL,
  description   TEXT NOT NULL,
  evidence      JSONB,                  -- { files: [], lines: [], excerpt: '' }
  severity      DECIMAL(4,3) NOT NULL CHECK (severity BETWEEN 0 AND 1),
  source        VARCHAR(50) DEFAULT 'agent',  -- 'agent'|'code-review'|'security-review'
  entity_type   VARCHAR(50),            -- Decision|Pattern|Constraint|Runbook|Requirement
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  created_by    VARCHAR(255) NOT NULL,
  UNIQUE (project_id, catalog_id, topic, key)  -- idempotent upsert key
);
CREATE INDEX IF NOT EXISTS idx_deviations_project   ON deviations(project_id);
CREATE INDEX IF NOT EXISTS idx_deviations_topic_key ON deviations(project_id, topic, key);
CREATE INDEX IF NOT EXISTS idx_deviations_severity  ON deviations(project_id, severity DESC);

CREATE TABLE IF NOT EXISTS deviation_actions (
  action_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deviation_id UUID NOT NULL REFERENCES deviations(deviation_id),
  action_type  VARCHAR(10) NOT NULL CHECK (action_type IN ('accept','deny','defer')),
  actor        VARCHAR(255) NOT NULL,
  actor_role   VARCHAR(50) NOT NULL,
  reason       TEXT NOT NULL,           -- Rule 3 enforced: min 10 chars
  defer_until  TIMESTAMPTZ,             -- only for defer: exactly 30/45/60/90 days
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deviation_actions_dev ON deviation_actions(deviation_id);
```

**Deviation status** is computed from `deviation_actions` — never stored directly:
- `OPEN` — no action taken
- `ACCEPTED` — latest action is `accept`
- `DENIED` — latest action is `deny`
- `DEFERRED` — latest action is `defer` AND `defer_until` > NOW()
- `OVERDUE` — latest action is `defer` AND `defer_until` <= NOW()
- `RESOLVED` — `resolved_at` IS NOT NULL (set when scan no longer surfaces this)

**Severity formula** (computed server-side — never accepted from client):
```
severity = global_knowledge.confidence × authority_score(global_knowledge)
PA_AUTHORED_FLOOR = 0.70  -- PA-authored global entries have minimum severity 0.70
                          -- regardless of confidence, to handle cold-start period
```

### New Shared Schema (`graph/schema.js` — both repos)

```javascript
export const DeviationStatus = {
  OPEN:     'OPEN',
  ACCEPTED: 'ACCEPTED',
  DENIED:   'DENIED',
  DEFERRED: 'DEFERRED',
  OVERDUE:  'OVERDUE',
  RESOLVED: 'RESOLVED',
}

export const DeviationActionType = {
  ACCEPT: 'accept',
  DENY:   'deny',
  DEFER:  'defer',
}

export const VALID_DEFER_DAYS = [30, 45, 60, 90]
```

### New Shared Queries (`graph/queries.js` — both repos)

Add to the existing 31 exports:

- `upsertDeviation(pg, record)` — insert or update `last_seen_at` on conflict `(project_id, catalog_id, topic, key)`
- `batchUpsertDeviations(pg, records)` — for scan result batch writes
- `getDeviationsByProject(pg, projectId, filters)` — with computed status via LEFT JOIN on `deviation_actions`
- `insertDeviationAction(pg, record)` — with `defer_until` validation
- `getConformanceScore(pg, projectId)` — weighted severity sum
- `resolveDeviation(pg, deviationId)` — sets `resolved_at`
- `getPortfolioScores(pg, groupIds)` — bulk conformance scores for portfolio view

---

## 5. Constitutional Changes

All changes to `gateway/src/shared/governance/constitutional.js` **and** vendored copy in `quorum-mcp/src/shared/governance/constitutional.js`.

### New Functions

```javascript
// Rule extension: global write authority (lifts GAP-27 from application code)
// isGlobalProject resolved from getConfig()?.is_global === true — no HTTP call needed
export function enforceGlobalWriteAuthority(identity, projectId, isGlobalProject) {
  if (!isGlobalProject) return
  const GLOBAL_WRITE_ROLES = ['architect', 'principal_architect',
                               'product_owner', 'compliance_officer']
  if (!GLOBAL_WRITE_ROLES.includes(identity?.role)) {
    throw new ConstitutionalViolation(
      'GLOBAL_WRITE_AUTHORITY',
      `Role '${identity?.role ?? 'unknown'}' cannot write to global catalog '${projectId}'. ` +
      `Minimum role required: architect.`,
      { role: identity?.role, projectId }
    )
  }
}

// New: deviation governance authority
export function enforceDeviationActionAuthority(actorRole, operation) {
  const ALLOWED_ROLES = ['architect', 'principal_architect',
                          'product_owner', 'compliance_officer']
  if (!ALLOWED_ROLES.includes(actorRole)) {
    throw new ConstitutionalViolation(
      'DEVIATION_ACTION_AUTHORITY',
      `Role '${actorRole}' cannot ${operation} deviations. ` +
      `Minimum role required: architect.`,
      { actorRole, operation }
    )
  }
}

// New: defer deadline validation
export function enforceValidDeferDeadline(deferUntil) {
  const days = Math.round((new Date(deferUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  if (![30, 45, 60, 90].includes(days)) {
    throw new ConstitutionalViolation(
      'DEFER_DEADLINE',
      `Defer deadline must be exactly 30, 45, 60, or 90 days from now. Got: ${days} days.`,
      { days, deferUntil }
    )
  }
}
```

### Updated Rule Union Type

```javascript
constructor(rule, message, context) {
  // rule: 'NO_HARD_DELETE' | 'APPEND_ONLY_AUDIT' | 'REASON_REQUIRED' |
  //       'NO_SELF_APPROVAL' | 'MULTI_PARTY_CONFIG' |
  //       'GLOBAL_WRITE_AUTHORITY' | 'DEVIATION_ACTION_AUTHORITY' | 'DEFER_DEADLINE'
```

### Test Coverage

Constitutional test suite (currently at 100% coverage requirement) must add tests for all three new functions:
- Direct violation — engineer/senior_engineer/director cannot write to global catalog
- Non-global project bypass — `enforceGlobalWriteAuthority` with `isGlobalProject = false` must not throw for any role
- Privilege escalation — engineer cannot action deviations
- Boundary cases — architect can write global, engineer cannot; 30-day defer valid, 31-day invalid
- Defer deadline edge cases — 29 days throws, 90 days passes, non-integer rounds correctly

---

## 6. New MCP Tools

### `deviate.js`

```javascript
schema: z.object({
  catalog_id:  z.string(),                           // group_id of the global catalog being deviated from
  topic:       z.string().regex(/^[a-z0-9-]+$/),
  key:         z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().max(500),
  evidence:    z.object({
    files:   z.array(z.string()).optional(),
    lines:   z.array(z.string()).optional(),
    excerpt: z.string().max(300).optional(),
  }).optional(),
  source:      z.string().optional(),  // 'code-review' | 'security-review' | 'agent'
  session_id:  z.string().optional(),
})
```

Behaviour:
- Validates `catalog_id` is in the project's linked `globals` list — returns `not_linked` if not
- Verifies `topic:key` exists in the specified global catalog — returns `not_found` if missing
- Derives severity server-side from referenced entry's confidence × authority
- Applies `PA_AUTHORED_FLOOR = 0.70` if the global entry was authored by `principal_architect`
- Upserts on `(project_id, catalog_id, topic, key)` — updates `last_seen_at` if already exists
- Returns `{ deviation_id, catalog_id, severity, status, message }`

### `conformance.js`

```javascript
schema: z.object({
  include_details: z.boolean().optional().default(false),
})
```

Behaviour:
- Returns project conformance score (0–100%)
- Returns `UNCERTIFIED` status if global catalog has fewer than 10 ACTIVE entries covering this project's topics — prevents meaningless scores during cold start
- Always includes `last_scan_at` and `scan_count`
- With `include_details: true`: returns top 10 deviations by severity with status breakdown

### Updates to Existing Tools

**`pending.js`** — extend response to include open deviations:
```javascript
{
  decisions: [...],            // existing
  deprecation_requests: [...], // existing
  deviations: {
    open:              [...],  // OPEN deviations for this project
    overdue_deferrals: [...],  // DEFERRED with defer_until passed
  }
}
```

**`recall.js`** — add `source` annotation to results:
```javascript
{ topic, key, content, ..., source: 'project' | 'global', catalog_id: string | null }
```

**`search.js`** — add `source` annotation, search across `[projectId, ...project.globals]`.

---

## 7. Gateway API Changes

### New Routes (`routes/dashboard.js`)

```
GET  /api/globals
  Auth: authenticated user
  Returns all global catalogs visible to the requesting project, filtered by scope.
  Response: [{ group_id, display_name, scope, entry_count, domains[] }]
  Used by quorum:onboard to present catalog choices during project setup.

POST /api/deviations
  Auth: authenticated user (agent via MCP)
  Body: { catalog_id, topic, key, description, evidence?, source? }
  Severity derived server-side. Upserts on (project_id, catalog_id, topic, key).
  Returns 400 if catalog_id not in project's globals list, or catalog has is_global: false.

POST /api/deviations/batch
  Auth: authenticated user
  Body: { deviations: [...] }
  For quorum:scan batch writes after a full scan.

GET  /api/deviations
  Auth: authenticated user
  Query: status?, catalog_id?, topic?, severity_min?, source?, limit?, offset?
  Returns deviations with computed status.

POST /api/deviations/:id/action
  Auth: architect+ (enforceDeviationActionAuthority)
  Body: { action_type, reason, defer_until? }
  Enforces Rule 3 (reason min 10 chars).
  Enforces VALID_DEFER_DAYS for defer.

GET  /api/conformance
  Auth: authenticated user
  Returns: { score, status, breakdown, last_scan_at, scan_count, catalogs: [{catalog_id, entry_count}] }
  score: combined across all linked catalogs — single scorecard
  status: 'CERTIFIED' | 'UNCERTIFIED' (< 10 total ACTIVE entries across all linked catalogs)

GET  /api/portfolio
  Auth: is_admin OR principal_architect OR director OR vp_engineering OR group_executive
  Query: node_id? (hierarchy node to scope — defaults to all accessible projects)
  Returns: projects with conformance scores, breakdown, last_scan_at
  Includes rollup score if node_id resolves to a non-leaf hierarchy node.
```

### Updates to Existing Routes

**`routes/graphiti.js`** — cross-project group_id injection for read operations only:
- Read (`search_nodes`, `search_memory_facts`): inject `group_ids: [projectGroupId, ...globals]`
- Write (`add_memory`): single `group_id` only — unchanged

**`routes/schema.js`** (`GET /schema/config`) — dynamically include `hierarchy.level` enum from platform config levels; `globals` field validated at sync time against DDB `is_global` index (not schema enum).

**`routes/sync.js`** (`POST /sync/configs`) — add validations:
- Each `globals` entry must resolve to `is_global = true` in `q_projects` (reject with 400 if not)
- `group_id` must not appear in its own `globals` list (self-reference check, reject with 400)
- `hierarchy.level` must be a known level from platform config
- `hierarchy.parent` must be a known `group_id` in DDB (or null for root nodes)

---

## 8. PE Governance — Accept / Deny / Defer

### Action Rules

| Action | Who | Constitutional check | Score weight |
|--------|-----|---------------------|--------------|
| `accept` | architect+ | `enforceDeviationActionAuthority` + Rule 3 | 1.0 (owned debt, still counts) |
| `deny` | architect+ | `enforceDeviationActionAuthority` + Rule 3 | 0.3 (contested) |
| `defer` | architect+ | `enforceDeviationActionAuthority` + Rule 3 + `enforceValidDeferDeadline` | 0.6 (deferred) |

### Deny Behaviour

When `deny` is actioned:
- Returns contextual note if target global entry has `confidence > 0.85` and `author_role = principal_architect`:
  `"This global standard was authored by a principal_architect with high confidence. Consider adding a project-level knowledge entry to document your project's reasoning for this exception."`
- Does NOT block the action — note only, consistent with library philosophy
- `denial_hint_count` is computed at query time: `SELECT COUNT(DISTINCT da.actor) FROM deviation_actions da JOIN deviations d ON da.deviation_id = d.deviation_id WHERE da.action_type = 'deny' AND d.catalog_id = $1 AND d.topic = $2 AND d.key = $3` — surfaced as a derived count in `GET /api/knowledge` response for global entries as "N projects have denied this standard"

### Defer Expiry

When `defer_until` passes with no new action:
- Status computed as `OVERDUE`
- Surfaces in `pending()` response under `overdue_deferrals`
- Score weight reverts to 1.0 (full weight, same as OPEN)
- Dashboard Pending page surfaces overdue deferrals with urgency badge

---

## 9. Conformance Scoring

### Formula

```
score = (1 - weighted_deviation_ratio) × 100

weighted_deviation_ratio =
  Σ(deviation.severity × status_weight) / applicable_catalog_entries

status_weight:
  OPEN     → 1.0
  OVERDUE  → 1.0
  ACCEPTED → 1.0  (owned — still a deviation, scored honestly; accepting does not improve
                   your score because the deviation is real. The incentive to ACCEPT is
                   governance maturity and audit trail, not score reward.)
  DEFERRED → 0.6  (active remediation intent lowers weight)
  DENIED   → 0.3  (contested — PE formally disputes the global standard applies here;
                   lower weight because the standard itself is under challenge, not
                   because denial is rewarded. denial_hint_count surfaces widely-denied
                   entries to PAs for catalog review.)
  RESOLVED → 0.0

applicable_catalog_entries:
  All ACTIVE entries across ALL of the project's linked global catalogs
  (project.globals array) whose topic matches any topic the project has
  knowledge in. Combined pool — not per-catalog.
```

### UNCERTIFIED Gate

Return `status: 'UNCERTIFIED'` (no numeric score) when:
- Total ACTIVE entries across all linked global catalogs is fewer than 10
- OR no scan has been run for this project yet (`scan_count = 0`)
- OR project has no linked global catalogs (not opted in to any)

Show `UNCERTIFIED` in the dashboard and portfolio view instead of a misleading score. This prevents the cold-start credibility problem.

### Rollup (Hierarchy)

```
node_score = Σ(child_score × child_criticality) / Σ(child_criticality)
```
Only `CERTIFIED` children contribute. `UNCERTIFIED` children are excluded from rollup and flagged separately as "N projects not yet certified."

---

## 10. Conformance Scanning — Skill Orchestration

### `quorum:scan` (thin orchestrator — not a standalone analyser)

The skill guides agents to:

1. Call `conformance()` — see current state before scanning
2. Invoke `code-review` skill on changed files (incremental: `git diff HEAD~1 --name-only`)
3. Invoke `security-review` skill on changed files
4. For each finding from both skills:
   - Call `search()` — searches across all project's linked global catalogs for matching `topic:key`
   - If match found: call `deviate()` with `catalog_id` (from `search()` result `catalog_id` field) + finding + evidence → deviation record
   - If no match found: synthesize a meaningful `topic` (domain-based: e.g. `security`, `reliability`, `auth`) and `key` (kebab-case pattern name: e.g. `missing-circuit-breaker`, `sql-injection-risk`), then call `remember(topic, key, finding, { entity_type, project: projectId })` → project-level DRAFT pending PE/PA review. One `remember()` per distinct pattern — never one per file instance.
5. For existing OPEN deviations that were NOT surfaced in this scan: call `deviate()` again with same `topic:key` to update `last_seen_at` (confirms still present), OR mark resolved if genuinely fixed
6. Return summary: `{ deviations_new, deviations_confirmed, deviations_resolved, candidates_surfaced }`

**Critical guidance in skill text**: "Group findings by pattern, not by instance. One `deviate()` call per pattern across the codebase. Use the `evidence` field for specific file locations."

### `quorum:onboard` (for new projects)

1. Call `GET /api/globals` — present available global catalogs scoped to this project's org position
2. Prompt onboarding user to select which catalogs to link (can choose any or all)
3. Save selection to project `.quorum` file as `globals: [...]`
4. Check total ACTIVE entries across linked catalogs — warn if < 10 (UNCERTIFIED territory)
5. Run `quorum:scan` as initial baseline (stub in Wave B; full implementation in Wave E)
6. Surface top 5 most critical deviations with remediation suggestions
7. Return onboarding report with `{ score, top_deviations, linked_catalogs, catalog_entry_counts, recommended_global_reads }`

### Scheduled Scanning

The `schedule` skill creates recurring remote agents. A nightly incremental scan:
```
schedule: nightly (or on PR merge)
  trigger: git diff to identify changed files
  run: quorum:scan on changed files only
  update: deviation last_seen_at + resolve fixed items
```

This is configuration, not code. Documented in `quorum:onboard` skill guidance.

---

## 11. Self-Evolution Loop — Project-Level DRAFT Path

### Flow

```
Skill output → unmatched finding (no match across any linked global catalog)
       ↓
Agent calls remember(topic, key, content, { entity_type, project: projectId })
  → lands as DRAFT (project-level) — same as any non-PE write
       ↓
PE/PA sees it in normal Pending Decisions flow
  → approve: becomes ACTIVE project-local knowledge
  → reject: discarded
  → if PE/PA judges it globally applicable:
       → writes to a global catalog directly:
         remember(topic, key, content, { project: globalCatalogId })
         enforceGlobalWriteAuthority fires (architect+ required)
         lands as DRAFT global catalog entry
       ↓
Second PA approves via review()
  → becomes ACTIVE in global catalog
       ↓
All future scans across all projects linked to this catalog
now detect this as a potential deviation. Conformance scores
update portfolio-wide.
```

**No automatic cross-project aggregation.** Unmatched findings do not get special treatment or a "Global Candidates" badge. They enter the same DRAFT → pending review flow as every other knowledge entry. Global promotion is always a deliberate human choice — the normal knowledge write path is the self-evolution path.

---

## 12. Dashboard Changes

### New Pages

**`pages/Deviations.jsx`**
- Table: deviation description, referenced global entry (linked to Knowledge page), severity bar, source badge (agent/code-review/security-review), first_seen, last_seen, status badge, last action
- Filter rail: status (OPEN/ACCEPTED/DENIED/DEFERRED/OVERDUE), topic, severity range, source
- Action panel (architect+ only) per OPEN/OVERDUE row:
  - `Accept` / `Deny` / `Defer (30d | 45d | 60d | 90d)` buttons
  - Reason textarea — required, red border if < 10 chars, submit blocked until valid
  - Deny: shows contextual note if target global standard was authored by a PA with high confidence
- UNCERTIFIED banner if catalog coverage too low to score

### Updated Pages

**`pages/Stats.jsx`**
- Add conformance score badge (0–100%, colour: green >80, amber 50–80, red <50, grey = UNCERTIFIED)
- Add deviation trend sparkline (30 days)
- Add breakdown bar: OPEN / ACCEPTED / DEFERRED / DENIED / RESOLVED counts
- Add `last_scan_at` with staleness warning if > 14 days

**`pages/Pending.jsx`**
- Add "Overdue deferrals" section (pattern: identical to existing deprecation_requests section — surfaced when `defer_until` has passed with no new action)

**`pages/Knowledge.jsx`**
- For global entries: show `denial_hint_count` — "N projects have denied this standard"
- Tooltip: anonymised denial summary (configurable per platform config: `deny_reasons_visible: true|false`)
- Helps PAs identify global standards that may need revision

---

## 13. Implementation Waves

Ordered by dependency and value delivery speed.

### Wave A — Constitutional + DB Foundation (1 week)
Files: `constitutional.js` (both repos), `scripts/init-db.sql` + `helm/quorum/files/init-db.sql`, `graph/schema.js` (both repos), `config/schema.js` (both repos), `remember.js` (quorum-mcp), `authority.js` (both repos)

See detailed task-by-task plan: [`docs/superpowers/plans/2026-05-21-quorum-v04-wave-a.md`](../plans/2026-05-21-quorum-v04-wave-a.md)

- Move GAP-27 guard to `constitutional.js` as `enforceGlobalWriteAuthority(identity, projectId, isGlobalProject)` — widen to architect+, accept boolean flag
- In `remember.js`: replace soft-return guard at lines 117-128 with `enforceGlobalWriteAuthority(identity, projectId, getConfig()?.is_global === true)`
- Update `storeFirst()` and `supersede()`: replace `const isGlobal = projectId === GLOBAL_PROJECT_ID` with `const isGlobal = getConfig()?.is_global === true`
- Add `enforceDeviationActionAuthority(actorRole, operation)`
- Add `enforceValidDeferDeadline(deferUntil)`
- SQL DDL: `is_global` column on `q_projects`; `project_scans` table; `deviations` table; `deviation_actions` table — all in `scripts/init-db.sql`
- Add `DeviationStatus`, `DeviationActionType`, `VALID_DEFER_DAYS` to `graph/schema.js` (both repos)
- Extend `QuorumConfigSchema` with federation fields
- Constitutional test suite: 100% coverage on all three new functions
- **Delivers**: foundation everything else depends on

### Wave B — Federation (2 weeks)
Files: `gateway/src/routes/graphiti.js`, `gateway/src/routes/dashboard.js` (globals endpoint), `quorum-mcp/src/tools/recall.js`, `quorum-mcp/src/tools/search.js`, `quorum-mcp/src/governance/conflict.js`, `gateway/src/shared/governance/conflict.js`

- `GET /api/globals` endpoint
- Cross-project reads in `graphiti.js` (detect by MCP tool name)
- `recall()` + `search()` global annotation
- **CRITICAL**: `detectConflict()` — fix from unscoped to `groupIds: [projectId, ...globals]` — **atomic with federation reads, same PR**
- `globals` self-reference + `is_global` validation in `POST /sync/configs`
- `quorum:onboard` skill (scan step is stub until Wave E)
- **Delivers**: cross-catalog reads live; conflict detection covers globals

### Wave C — Deviation Write Path (1 week)
Files: `quorum-mcp/src/tools/deviate.js` (new), `gateway/src/routes/dashboard.js`, `gateway/src/shared/graph/queries.js`
- `deviate()` MCP tool — idempotent upsert, server-side severity, PA_AUTHORED_FLOOR
- `POST /api/deviations` + `POST /api/deviations/batch` gateway routes
- New query functions: `upsertDeviation`, `batchUpsertDeviations`
- **Delivers**: agents can start recording deviations immediately

### Wave D — PE Governance (2 weeks)
Files: `gateway/src/routes/dashboard.js`, `quorum-mcp/src/tools/pending.js`, `dashboard/src/pages/Deviations.jsx` (new), `dashboard/src/pages/Pending.jsx`
- `POST /api/deviations/:id/action` with constitutional enforcement
- `GET /api/deviations` with computed status
- `pending()` MCP tool update
- Dashboard Deviations page (PE action panel)
- Pending page update (overdue deferrals section)
- **Delivers**: PEs can govern deviations, accountability trail active

### Wave E — Conformance Scoring (1 week)
Files: `quorum-mcp/src/tools/conformance.js` (new), `gateway/src/routes/dashboard.js`, `dashboard/src/pages/Stats.jsx`
- `conformance()` MCP tool with UNCERTIFIED gate
- `GET /api/conformance` with catalog coverage check
- `getConformanceScore` query
- Stats page conformance badge + trend sparkline
- `quorum:scan` skill (thin orchestrator, replaces stub)
- **Delivers**: first conformance scores visible

### Wave F — Portfolio (1 week)
Files: `gateway/src/routes/dashboard.js`, `gateway/src/shared/graph/queries.js`, `dashboard/src/pages/Knowledge.jsx`, `dashboard/src/pages/Pending.jsx`
- `GET /api/portfolio` with hierarchy rollup
- `getPortfolioScores` query
- `denial_hint_count` on Knowledge page global catalog entries
- New executive role scores in `authority.js` (both repos)
- **Delivers**: enterprise portfolio view; overdue deferral surfacing live

### Wave G — Documentation (1 week, both repos)
- `CLAUDE.md` (root + gateway subdirectory) — v0.4 additions, shared module sync note
- `docs/ARCHITECTURE.md` — federation model, deviation data model, hierarchy, self-evolution
- `docs/ROADMAP.md` — v0.4 section
- `docs/ONBOARDING.md` — `quorum:onboard` step, hierarchy config
- `docs/FRONTEND.md` — Deviations page, Stats updates, Pending updates, Knowledge updates
- `gateway/openapi.yaml` — all new endpoints (OpenAPI 3.1)
- `quorum-mcp` README + SKILL.md — `deviate()`, `conformance()`, `quorum:scan`, `quorum:onboard`
- JSDoc on all new functions and tools

---

## 14. Deferred to v0.5

| Feature | Reason for deferral |
|---------|-------------------|
| `quorum:ingest` (external tool reports) | Format diversity across SonarQube/Fortify/Snyk versions is maintenance burden; code-review skill covers same ground for v0.4 |
| Dashboard Portfolio page (full UI) | `GET /api/portfolio` ships in Wave F; full UI (sorting, filtering, CSV export, drill-down) deferred — enterprises can query API |
| Defer co-sign requirement | Pre-solving a problem that may not materialise; chronic-deferrer signal in portfolio view is sufficient |
| `PostToolUse` hook on `code-review` | SessionStart + `pending()` extension covers ambient awareness; full hook wiring is v0.5 |

---

## 15. Key Risks

### Risk 1: Cold Start — UNCERTIFIED scores
**Problem**: A new enterprise sees meaningless or UNCERTIFIED scores in week one. Portfolio dashboard shows all grey.
**Mitigation**: `quorum:onboard` explicitly warns when global catalog < 10 ACTIVE entries. UNCERTIFIED state shown clearly — not a zero score. Onboarding guide includes "seed your global catalog first" as Step 1.

### Risk 2: detectConflict gap
**Problem**: If Wave B lands partially (federation reads working but conflict detection not updated), engineers can `remember()` project-local knowledge that silently contradicts a global entry.
**Mitigation**: Wave B is atomic — the conflict detection fix must be in the same PR as the federation read changes. Test: `remember()` that contradicts a global entry must trigger conflict detection.

### Risk 3: Deviation staleness misleads portfolio
**Problem**: A project scanned 90 days ago shows a high score based on stale data.
**Mitigation**: `GET /api/portfolio` includes `last_scan_at` per project. Portfolio view flags `last_scan_at > 30 days` with a "Stale" badge. Score is shown greyed out, not as authoritative.

### Risk 4: Severity gaming via DENIED
**Problem**: PEs deny everything, keeping score high while changing nothing.
**Mitigation**: DENIED weight is 0.3 — not zero. `denial_hint_count` on global entries surfaces to PAs if a standard is being widely denied — prompting review of the standard itself.

### Risk 5: Orphaned global links
**Problem**: A project's `.quorum` file references a `globals` entry whose project has been deprovisioned or had `is_global` set to false.
**Mitigation**: `POST /sync/configs` validates each `globals` entry resolves to an `is_global: true` project. Gateway logs a warning (not error) if a linked catalog is missing at read time — score degrades gracefully.

### Risk 6: Shared module sync
**Problem**: `constitutional.js`, `schema.js`, `queries.js` are vendored between gateway and quorum-mcp.
**Mitigation**: Document in both `CLAUDE.md` files: "When editing `shared/` modules in either repo, the vendored copy in the other repo must be updated in the same PR."

---

## Verification Plan

**Wave A**: Constitutional tests pass at 100% coverage. `npm test` — no regressions.

**Wave B**: `GET /api/globals` returns catalogs scoped correctly. `recall("auth", "token-strategy")` returns entry from linked global catalog. `remember()` that contradicts a global entry triggers conflict detection. Project with no `globals` gets project-scoped reads only. `POST /sync/configs` rejects a config whose `globals` references a non-global project.

**Wave C**: Agent can call `deviate()` and record appears in `deviations` table. Duplicate call updates `last_seen_at`, not creates new row.

**Wave D**: PE can accept/deny/defer via dashboard. `pending()` returns open deviations. Overdue deferral resurfaces in `pending()`.

**Wave E**: `conformance()` returns UNCERTIFIED when global catalog sparse. Returns score when catalog populated. Stats page shows badge.

**Wave F**: `GET /api/portfolio` returns conformance scores for all accessible projects. Rollup score correct for a department with 3 child projects of different criticality. Overdue deferral appears in `pending()` under `overdue_deferrals`.

**Wave G**: No broken links in docs. `openapi.yaml` validates against OpenAPI 3.1 spec.
