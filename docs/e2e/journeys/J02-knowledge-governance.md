# J02 — Knowledge Governance Lifecycle

**Original journey weight:** 120 (30 raw leaves × F4)
**Split into 8 independent sub-scenarios (each ≤ 3.9% blast radius)**
**Frequency tier:** F4 (core agent workflow — every remember/recall interaction)

> This journey covers the most critical path in Quorum: an agent writes knowledge,
> a conflict is detected, and a PE resolves it via one of 5 resolution types.
> Because the resolution types are independent stories, each is its own scenario.

---

## Sub-Scenario Registry

| Scenario ID | Description | Weight | Blast Radius | Spec File |
|-------------|-------------|--------|--------------|-----------|
| S-02.1 | Write + Recall cycle | 32 | 3.9% | `02-1-write-recall.spec.js` |
| S-02.2 | Conflict detection | 24 | 3.0% | `02-2-conflict-detection.spec.js` |
| S-02.3 | Resolve: supersede | 20 | 2.5% | `02-3-resolve-supersede.spec.js` |
| S-02.4 | Resolve: reject | 16 | 2.0% | `02-4-resolve-reject.spec.js` |
| S-02.5 | Resolve: escalate | 16 | 2.0% | `02-5-resolve-escalate.spec.js` |
| S-02.6 | Resolve: coexist_split | 20 | 2.5% | `02-6-resolve-split.spec.js` |
| S-02.7 | Resolve: coexist_merge | 16 | 2.0% | `02-7-resolve-merge.spec.js` |
| S-02.8 | Dashboard conflict review (UI) | 20 | 2.5% | `02-8-dashboard-conflict.spec.js` |

**Roles across all sub-scenarios:** `test-engineer` (writes), `test-pe` (reviews)

---

## S-02.1 — Write + Recall Cycle

**Weight:** 32 (8 leaves × 4)
**Blast radius:** 3.9%

### Setup
Fresh project state. No existing knowledge for `db:connection-pooling`.

### Steps

1. `POST /pg/versions` as `test-engineer`:
   - `topic: "db"`, `key: "connection-pooling"`, `content: "Use pool size 10. Sized for p95 load at 200 req/s."`
   - Assert: `status: "ACTIVE"`, `version: 1`
   - Assert: `author: "test-engineer"`, `base_confidence` present and ≥ 0.70

2. `GET /pg/versions/db/connection-pooling` as `test-engineer`
   - Assert: returns v1 content exactly
   - Assert: `status: "ACTIVE"`, `version: 1`

3. Navigate to `/knowledge` as `test-engineer`
   - Assert: `db:connection-pooling` entry visible with `ACTIVE` badge
   - Assert: confidence bar visible at the correct value

4. `POST /pg/versions` as `test-pe` on a different key:
   - `topic: "db"`, `key: "migration-strategy"`, `content: "Use forward-only migrations. No rollback scripts. Blue/green deploys handle rollback at infra level."`
   - Assert: `status: "ACTIVE"` (PA writes land as ACTIVE immediately)

5. `GET /pg/versions/db/migration-strategy`
   - Assert: content matches exactly — confirms round-trip fidelity

### Pass Criteria
- [ ] Engineer write → `ACTIVE` with correct version number
- [ ] Author + base_confidence present in response
- [ ] Recall returns exact content of the written entry
- [ ] PA write → `ACTIVE` immediately
- [ ] `/knowledge` page shows new entry with ACTIVE badge
- [ ] Confidence bar visible and correct
- [ ] Round-trip content fidelity (write then read returns identical content)
- [ ] No existing entry required — write to a fresh key always succeeds

---

## S-02.2 — Conflict Detection

**Weight:** 24 (6 leaves × 4)
**Blast radius:** 3.0%

### Setup
Seed `auth:session-timeout` as ACTIVE via `test-pe` with content:
`"Sessions expire after 30 minutes of inactivity. Balances security with UX."`

### Steps

1. `POST /pg/versions` as `test-engineer` on the same key:
   - `content: "Sessions should never expire automatically — breaks long-running workflows."`
   - `reason: "Long-running batch jobs require persistent sessions"`
   - Assert: `status: "conflict_detected"`, `conflict_id` present in response
   - Assert: entry was NOT stored (conflict stops the write)

2. `GET /pg/pending` as `test-pe`
   - Assert: `conflict_briefs` array has exactly 1 item
   - Assert: `conflict_briefs[0].conflict_id` matches the id from step 1
   - Assert: `enrichment` object present (mock LLM returns canned analysis)
   - Assert: `existing_content` and `incoming_content` both present

3. Navigate to `/pending` as `test-pe`
   - Assert: conflict brief row visible with "Decide" or "Review" button
   - Assert: existing + incoming content both displayed in the brief

### Pass Criteria
- [ ] Semantic near-duplicate → `conflict_detected` returned (not `ACTIVE`)
- [ ] Conflicting entry is NOT stored in the knowledge graph
- [ ] `conflict_id` present in response for later resolution
- [ ] `GET /pending` surfaces the conflict for the PE
- [ ] LLM enrichment present in conflict brief (mock returns canned analysis)
- [ ] Dashboard pending page shows conflict with both versions

---

## S-02.3 — Resolve: `supersede`

**Weight:** 20 (5 leaves × 4)
**Blast radius:** 2.5%

### Setup
Seed v1 ACTIVE entry `infra:deploy-strategy`. Trigger a conflict on it.

### Steps

1. `POST /api/review/:conflict_id` as `test-pe`:
   - `resolution: "supersede"`, `note: "Incoming version is more accurate for current infra"`
   - Assert: `200`, resolution accepted

2. `GET /pg/versions/infra/deploy-strategy`
   - Assert: v2 is `ACTIVE`
   - Assert: v1 is `SUPERSEDED` (still exists — no hard delete)

3. `GET /pg/audit/lineage/infra/deploy-strategy`
   - Assert: audit trail shows v1 SUPERSEDED → v2 ACTIVE transition

### Pass Criteria
- [ ] `supersede` resolution stores the incoming version as ACTIVE
- [ ] Previous version transitions to SUPERSEDED (not deleted)
- [ ] Audit lineage shows the transition
- [ ] `GET /pending` no longer shows this conflict after resolution
- [ ] Only one ACTIVE version exists at any time for `infra:deploy-strategy`

---

## S-02.4 — Resolve: `reject`

**Weight:** 16 (4 leaves × 4)
**Blast radius:** 2.0%

### Setup
Seed v1 ACTIVE entry `infra:monitoring-stack`. Trigger a conflict on it.

### Steps

1. `POST /api/review/:conflict_id` as `test-pe`:
   - `resolution: "reject"`, `note: "Existing standard is correct — incoming is based on outdated assumptions"`
   - Assert: `200`

2. `GET /pg/versions/infra/monitoring-stack`
   - Assert: v1 is still `ACTIVE` (unchanged)
   - Assert: no v2 exists (incoming was discarded)

### Pass Criteria
- [ ] `reject` leaves the existing entry unchanged (v1 stays ACTIVE)
- [ ] Incoming content is discarded (no v2 created)
- [ ] Conflict removed from pending after rejection
- [ ] Reason stored in audit entry

---

## S-02.5 — Resolve: `escalate`

**Weight:** 16 (4 leaves × 4)
**Blast radius:** 2.0%

### Setup
Seed `infra:cache-strategy` as ACTIVE. Trigger a conflict on it.

### Steps

1. `POST /api/review/:conflict_id` as `test-pe`:
   - `resolution: "escalate"`, `note: "Requires broader architectural discussion — escalating to architecture board"`
   - Assert: `200`

2. `GET /pg/pending` as `test-pe`
   - Assert: conflict record shows `status: "escalated"` (still present — not resolved)
   - Assert: escalation note stored

### Pass Criteria
- [ ] `escalate` leaves the conflict in pending with `status: "escalated"`
- [ ] Original ACTIVE entry unchanged
- [ ] Escalation note persisted in the conflict record
- [ ] Conflict remains visible in dashboard pending page

---

## S-02.6 — Resolve: `coexist_split`

**Weight:** 20 (5 leaves × 4)
**Blast radius:** 2.5%

### Setup
Seed `db:pool-size` as ACTIVE with content: `"Pool size 10 for all services."`.
Trigger conflict with: `"Pool size 50 required for batch processing."`.

### Steps

1. `POST /api/review/:conflict_id` as `test-pe`:
   - `resolution: "coexist_split"`
   - `split_existing_key: "db-oltp-pool"`, `split_incoming_key: "db-batch-pool"`
   - `note: "Different pool sizes for different workload types — both standards are valid in context"`
   - Assert: `200`

2. `GET /pg/versions/db/db-oltp-pool`
   - Assert: `ACTIVE`, content from the original v1

3. `GET /pg/versions/db/db-batch-pool`
   - Assert: `ACTIVE`, content from the incoming version

4. `GET /pg/versions/db/pool-size`
   - Assert: original key is now `SUPERSEDED` (not ACTIVE — the split replaced it)

### Pass Criteria
- [ ] `coexist_split` creates exactly two new ACTIVE entries at the specified keys
- [ ] Original key is SUPERSEDED (not deleted — provenance preserved)
- [ ] Each new entry carries the correct content from its source version
- [ ] Both new entries visible in knowledge browser
- [ ] Original key no longer appears as ACTIVE

---

## S-02.7 — Resolve: `coexist_merge`

**Weight:** 16 (4 leaves × 4)
**Blast radius:** 2.0%

### Setup
Seed `security:secret-rotation` as ACTIVE. Trigger a conflict.

### Steps

1. `POST /api/review/:conflict_id` as `test-pe`:
   - `resolution: "coexist_merge"`
   - `merged_content: "Rotate secrets every 90 days for standard services; every 30 days for services with PII access. Automated rotation preferred."`
   - `note: "Merged both requirements — rotation schedule depends on data classification"`
   - Assert: `200`

2. `GET /pg/versions/security/secret-rotation`
   - Assert: new version is `ACTIVE` with the merged content
   - Assert: previous version is `SUPERSEDED`

### Pass Criteria
- [ ] `coexist_merge` creates a new ACTIVE entry at the original key with merged content
- [ ] Previous version is SUPERSEDED (not both versions — the merge resolved the conflict)
- [ ] Merged content matches the `merged_content` field submitted
- [ ] Conflict removed from pending

---

## S-02.8 — Dashboard Conflict Review (UI)

**Weight:** 20 (5 leaves × 4)
**Blast radius:** 2.5%

### Setup
Seed `auth:password-policy` as ACTIVE. Trigger a conflict on it via API.

### Steps

1. Log in as `test-pe`, navigate to `/pending`
   - Assert: conflict brief row visible with existing + incoming content displayed side by side
   - Assert: LLM enrichment section visible (canned analysis from mock OpenAI)

2. Click "Request Changes" button
   - Note textarea appears — type fewer than 10 chars
   - Assert: submit button disabled (UI-level reason validation)

3. Type valid note (≥ 10 chars): `"Need more context from the team before resolving"`
   - Click submit
   - Assert: conflict brief stays in pending with the PE's note

4. Click "Approve" (supersede resolution) with valid note
   - Assert: pending item disappears from the list
   - Assert: knowledge entry now shows `ACTIVE` (v2)

5. Navigate to `/audit`
   - Assert: INTENT and OUTCOME audit entries visible for this conflict workflow

### Pass Criteria
- [ ] Conflict brief shows both versions (existing + incoming) + LLM enrichment
- [ ] Note field < 10 chars → submit blocked at UI level
- [ ] Request Changes keeps conflict in pending with note stored
- [ ] Approve via dashboard resolves conflict and transitions knowledge to ACTIVE
- [ ] Audit timeline shows INTENT + OUTCOME entries for the resolution
