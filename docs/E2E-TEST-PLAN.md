# Quorum — Risk-Weighted E2E Test Plan

> **For agentic workers:** Before implementing any test scenario, read this document.
> Every test file maps to a specific scenario ID (e.g. `S-02.1`). Scenarios are
> structurally independent — each sets up its own state and tears it down.

---

## 1. The Problem This Solves

Test coverage tells you *what* is tested. This plan also measures *what breaks when a test fails*.

A test suite with high coverage can still have a single infrastructure node whose failure silently
invalidates 30% of the suite. That is a blind spot. The model below forces every scenario to be
structurally isolated so that no single failure cascades past 10% of the total test budget.

---

## 2. Weight Model

### 2.1 Leaf Assertion (base unit)

```
W(leaf) = 1 × F
```

A **leaf** is a terminal assertion — an HTTP status code, a response body field, a UI element's
visibility, a database row value. It cannot be decomposed further. Weight is `1` before the
frequency multiplier is applied.

### 2.2 Frequency Multiplier (F)

Frequency reflects how often the code path is exercised in production. A bug on a high-F path
causes more damage per occurrence than a bug on a low-F path.

| Tier | F  | Code paths |
|------|----|-----------|
| **F4 — Core agent workflow** | 4 | `remember`, `recall`, `search`, conflict detection — invoked on every agent write/read |
| **F3 — Daily governance / security** | 3 | RBAC enforcement, `pending`/`review`, self-approval guard, placeholder rejection — checked on every governance action |
| **F2 — Weekly operational** | 2 | `deviate`, `conformance`, `deprecation`, `bump`, state machine — regular feature cadence |
| **F1.5 — Periodic** | 1.5 | Audit chain verification, dashboard visual regression — checked on scheduled runs |
| **F1 — One-time / rare** | 1 | Onboarding, admin ops, config governance — rare lifecycle events |

### 2.3 Node Weight

```
W(step)    = Σ W(leaves in step)
W(scenario) = Σ W(steps in scenario)
W(suite)   = Σ W(all scenarios)
```

### 2.4 Failure Cost

```
FC(node) = W(node) + Σ W(all nodes that structurally depend on this node)
```

With full scenario isolation (each scenario sets up its own state), the failure cost of a scenario's
opening setup step equals the scenario's total weight. No cross-scenario chaining.

### 2.5 The Constraint

```
FC(any node) / W(suite) < 0.10
```

No single test failure may invalidate more than **10%** of the weighted test budget.

Corollary: any scenario whose weight exceeds 10% of W(suite) must be split into independent
sub-scenarios until the constraint is met.

---

## 3. Raw Leaf Inventory

Leaf counts are derived from the explicit assertions in `docs/E2E-JOURNEYS.md` — both the
pass-criteria checklist and the step-level assertions within each journey.

| Journey | Description | Raw Leaves |
|---------|-------------|-----------|
| J01 | Global Catalog Onboarding | 15 |
| J02 | Knowledge Governance Lifecycle (8 sub-parts) | 30 |
| J03 | Deprecation Workflow | 20 |
| J04 | Deviation Governance Lifecycle | 35 |
| J05 | RBAC Boundary Simulation (13 ops × 8 roles + extras) | 85 |
| J06 | Multi-User Conflict Resolution (UI simulation) | 15 |
| J07 | Conformance Scoring & Portfolio Intelligence | 25 |
| J08 | Confidence Endorsement (Bump) | 15 |
| J09 | Platform Admin Operations | 12 |
| J10 | Audit Chain Integrity | 13 |
| J11 | Self-Approval Prevention | 10 |
| J12 | Knowledge Status State Machine | 12 |
| J13 | Config Management & Governance | 16 |
| J14 | Dashboard Visual & Interaction Flows | 20 |
| J15 | Reason / Placeholder Rejection | 15 |
| **Total raw leaves** | | **338** |

---

## 4. Weighted Journey Budget (Pre-Split)

```
W(suite) = Σ (raw_leaves × F)
```

| Journey | Raw Leaves | F   | W(journey) | W/W(suite) | Violates 10%? |
|---------|-----------|-----|-----------|-----------|--------------|
| J01     | 15        | 1.0 | 15        | 1.8%      | —            |
| J02     | 30        | 4.0 | **120**   | **14.8%** | ✗ SPLIT      |
| J03     | 20        | 2.0 | 40        | 4.9%      | —            |
| J04     | 35        | 2.0 | 70        | 8.6%      | —            |
| J05     | 85        | 3.0 | **255**   | **31.4%** | ✗ SPLIT      |
| J06     | 15        | 3.0 | 45        | 5.5%      | —            |
| J07     | 25        | 2.0 | 50        | 6.2%      | —            |
| J08     | 15        | 2.0 | 30        | 3.7%      | —            |
| J09     | 12        | 1.0 | 12        | 1.5%      | —            |
| J10     | 13        | 1.5 | 19.5      | 2.4%      | —            |
| J11     | 10        | 4.0 | 40        | 4.9%      | —            |
| J12     | 12        | 2.0 | 24        | 3.0%      | —            |
| J13     | 16        | 1.0 | 16        | 2.0%      | —            |
| J14     | 20        | 1.5 | 30        | 3.7%      | —            |
| J15     | 15        | 3.0 | 45        | 5.5%      | —            |
| **Sum** | **338**   |     | **811.5** |           |              |

**W(suite) = 811.5**
**10% threshold = 81.2 weighted points**

---

## 5. Violation Analysis

### 5.1 J02 — Knowledge Governance Lifecycle (W = 120, 14.8%) ✗

J02 covers a single journey but has 8 structurally sequential sub-parts:
write → conflict → 5 resolution types → dashboard review.

The root setup step (writing the first knowledge entry) gates everything. If it fails:
- The conflict cannot be triggered (Parts B–D are blocked)
- All 5 resolution paths are unreachable
- 120 weighted points lost from a single failure

**Decomposition required:** each resolution type is an independent story. Each starts from zero
(setup its own entry, trigger its own conflict), so they can run in any order.

### 5.2 J05 — RBAC Boundary Simulation (W = 255, 31.4%) ✗

J05 is a matrix: 13 operations × 8 roles = 104 cells. If the test framework's auth injection fails,
the entire matrix is invalid. Even if auth works, the cells naturally cluster into independent
concerns (knowledge writes, governance operations, admin access, etc.).

**Decomposition required:** split by operation category, each independently testable.

---

## 6. Splitting Strategy

### 6.1 J02 → 8 Independent Sub-Scenarios

Each sub-scenario:
- Creates its own knowledge entry as fresh state
- Does not depend on any other J02 sub-scenario
- Can be run in isolation or in any order

| Scenario ID | Description | Raw Leaves | F | W | W/W(suite) |
|-------------|-------------|-----------|---|---|-----------|
| S-02.1 | Write + Recall cycle (first write, no conflict) | 8 | 4 | 32 | 3.9% ✓ |
| S-02.2 | Conflict detection (semantic near-duplicate → conflict_detected) | 6 | 4 | 24 | 3.0% ✓ |
| S-02.3 | Resolve: `supersede` (v2 ACTIVE, v1 SUPERSEDED) | 5 | 4 | 20 | 2.5% ✓ |
| S-02.4 | Resolve: `reject` (v1 stays ACTIVE, incoming discarded) | 4 | 4 | 16 | 2.0% ✓ |
| S-02.5 | Resolve: `escalate` (conflict stays as escalated) | 4 | 4 | 16 | 2.0% ✓ |
| S-02.6 | Resolve: `coexist_split` (2 new ACTIVE entries, original SUPERSEDED) | 5 | 4 | 20 | 2.5% ✓ |
| S-02.7 | Resolve: `coexist_merge` (merged entry ACTIVE at original key) | 4 | 4 | 16 | 2.0% ✓ |
| S-02.8 | Dashboard conflict review (UI — pending page, approve flow, audit trail) | 5 | 4 | 20 | 2.5% ✓ |

**J02 max cascade after split: 32 / 811.5 = 3.9%** ✓

### 6.2 J05 → 6 Independent Sub-Scenarios

Each sub-scenario exercises one operational category. Auth injection is validated by T0.2 before
the matrix runs — if auth fails, it's an infrastructure failure (outside the 10% budget), not a
scenario failure.

| Scenario ID | Description | Ops Covered | Raw Leaves | F | W | W/W(suite) |
|-------------|-------------|-------------|-----------|---|---|-----------|
| S-05.1 | Knowledge create role matrix (all 8 roles; DRAFT vs ACTIVE outcome) | `POST /api/knowledge` | 24 | 3 | 72 | 8.9% ✓ |
| S-05.2 | PE-only write ops (promote, supersede) | promote, supersede | 16 | 3 | 48 | 5.9% ✓ |
| S-05.3 | PE-only destructive ops (deprecate single, bulk) | deprecate, bulk | 16 | 3 | 48 | 5.9% ✓ |
| S-05.4 | Governance RBAC (review/approve/reject + global write authority) | review, global write | 20 | 3 | 60 | 7.4% ✓ |
| S-05.5 | Deviation action RBAC + forget-path branching | deviation action, forget | 20 | 3 | 60 | 7.4% ✓ |
| S-05.6 | Portfolio + admin access gates | portfolio, admin | 15 | 3 | 45 | 5.5% ✓ |

**J05 max cascade after split: 72 / 811.5 = 8.9%** ✓

---

## 7. Final Scenario Registry (Post-Split)

27 independent scenarios. Every scenario ≤ 10% failure blast radius.
Infrastructure probes (T0) are outside the budget — they are prerequisites that block the entire
suite if failing, but they are given separate reliability mitigations (see §9).

```
W(suite) = 811.5
10% gate  = 81.2 weighted points
```

### Tier F4 — Core Agent Workflow

| ID | Description | W | % | File |
|----|-------------|---|---|------|
| S-02.1 | Write + Recall cycle | 32 | 3.9% | `02-1-write-recall.spec.js` |
| S-02.2 | Conflict detection | 24 | 3.0% | `02-2-conflict-detection.spec.js` |
| S-02.3 | Resolve: supersede | 20 | 2.5% | `02-3-resolve-supersede.spec.js` |
| S-02.4 | Resolve: reject | 16 | 2.0% | `02-4-resolve-reject.spec.js` |
| S-02.5 | Resolve: escalate | 16 | 2.0% | `02-5-resolve-escalate.spec.js` |
| S-02.6 | Resolve: coexist_split | 20 | 2.5% | `02-6-resolve-split.spec.js` |
| S-02.7 | Resolve: coexist_merge | 16 | 2.0% | `02-7-resolve-merge.spec.js` |
| S-02.8 | Dashboard conflict review | 20 | 2.5% | `02-8-dashboard-conflict.spec.js` |
| S-11 | Self-approval prevention | 40 | 4.9% | `11-self-approval.spec.js` |
| **F4 subtotal** | | **204** | **25.1%** | |

### Tier F3 — Daily Governance / Security

| ID | Description | W | % | File |
|----|-------------|---|---|------|
| S-05.1 | RBAC: knowledge create (all roles) | 72 | 8.9% | `05-1-rbac-create.spec.js` |
| S-05.2 | RBAC: PE-only promote + supersede | 48 | 5.9% | `05-2-rbac-promote-supersede.spec.js` |
| S-05.3 | RBAC: PE-only deprecate + bulk | 48 | 5.9% | `05-3-rbac-deprecate.spec.js` |
| S-05.4 | RBAC: governance review + global write authority | 60 | 7.4% | `05-4-rbac-governance.spec.js` |
| S-05.5 | RBAC: deviation action + forget branching | 60 | 7.4% | `05-5-rbac-deviation.spec.js` |
| S-05.6 | RBAC: portfolio + admin gates | 45 | 5.5% | `05-6-rbac-portfolio-admin.spec.js` |
| S-06 | Multi-user conflict simulation | 45 | 5.5% | `06-multi-user-conflict.spec.js` |
| S-15 | Reason / placeholder rejection | 45 | 5.5% | `15-reason-placeholder.spec.js` |
| **F3 subtotal** | | **423** | **52.1%** | |

### Tier F2 — Weekly Operational

| ID | Description | W | % | File |
|----|-------------|---|---|------|
| S-03 | Deprecation workflow (request + approve + stale) | 40 | 4.9% | `03-deprecation-workflow.spec.js` |
| S-04 | Deviation governance lifecycle | 70 | 8.6% | `04-deviation-governance.spec.js` |
| S-07 | Conformance scoring + portfolio intelligence | 50 | 6.2% | `07-conformance-portfolio.spec.js` |
| S-08 | Confidence endorsement (bump) | 30 | 3.7% | `08-confidence-bump.spec.js` |
| S-12 | Knowledge status state machine | 24 | 3.0% | `12-state-machine.spec.js` |
| **F2 subtotal** | | **214** | **26.4%** | |

### Tier F1.5 — Periodic

| ID | Description | W | % | File |
|----|-------------|---|---|------|
| S-10 | Audit chain integrity | 19.5 | 2.4% | `10-audit-chain.spec.js` |
| S-14 | Dashboard visual + interaction flows | 30 | 3.7% | `14-dashboard-visual.spec.js` |
| **F1.5 subtotal** | | **49.5** | **6.1%** | |

### Tier F1 — One-time / Rare

| ID | Description | W | % | File |
|----|-------------|---|---|------|
| S-01 | Global catalog onboarding | 15 | 1.8% | `01-global-catalog-onboarding.spec.js` |
| S-09 | Platform admin operations | 12 | 1.5% | `09-admin-operations.spec.js` |
| S-13 | Config management + governance | 16 | 2.0% | `13-config-governance.spec.js` |
| **F1 subtotal** | | **43** | **5.3%** | |

### Suite Totals

```
W(suite)  = 204 + 423 + 214 + 49.5 + 43 = 933.5
           (note: split decomposition adds ~122 from sub-scenario setup assertions)

10% gate  = 93.4 weighted points

Max single failure cascade: S-05.1 (knowledge create RBAC)
  W = 72 / 933.5 = 7.7%  ✓  well under gate
```

> **All 27 scenarios satisfy the 10% failure cost constraint.**

---

## 8. The Dependency Tree

```
Suite (W = 933.5)
│
├── T0: Infrastructure Probes [OUTSIDE BUDGET — must pass before any scenario runs]
│   ├── T0.1  All 6 Docker services healthy (gateway, PG, Graphiti, Redis, LocalStack, mock-openai)
│   ├── T0.2  JWT generation + gateway verify (sign with test key, GET /health with Bearer token)
│   └── T0.3  LocalStack S3 + DDB accessible (HeadBucket + ListTables)
│
├── F4 Scenarios (W = 204)
│   ├── S-02.1  Write + Recall  (32)  ← no dependencies except T0
│   ├── S-02.2  Conflict detect (24)  ← no dependencies except T0
│   ├── S-02.3  Supersede       (20)  ← no dependencies
│   ├── S-02.4  Reject          (16)  ← no dependencies
│   ├── S-02.5  Escalate        (16)  ← no dependencies
│   ├── S-02.6  Coexist split   (20)  ← no dependencies
│   ├── S-02.7  Coexist merge   (16)  ← no dependencies
│   ├── S-02.8  Dashboard UI    (20)  ← no dependencies
│   └── S-11   Self-approval    (40)  ← no dependencies
│
├── F3 Scenarios (W = 423)
│   ├── S-05.1  RBAC: create    (72)  ← no dependencies
│   ├── S-05.2  RBAC: promote   (48)  ← no dependencies
│   ├── S-05.3  RBAC: deprecate (48)  ← no dependencies
│   ├── S-05.4  RBAC: govern    (60)  ← no dependencies
│   ├── S-05.5  RBAC: deviate   (60)  ← no dependencies
│   ├── S-05.6  RBAC: portfolio (45)  ← no dependencies
│   ├── S-06   Multi-user       (45)  ← no dependencies
│   └── S-15   Reason/ph.      (45)  ← no dependencies
│
├── F2 Scenarios (W = 214)
│   ├── S-03   Deprecation      (40)  ← no dependencies
│   ├── S-04   Deviation        (70)  ← no dependencies
│   ├── S-07   Conformance      (50)  ← no dependencies
│   ├── S-08   Bump             (30)  ← no dependencies
│   └── S-12   State machine    (24)  ← no dependencies
│
├── F1.5 Scenarios (W = 49.5)
│   ├── S-10   Audit chain     (19.5) ← no dependencies
│   └── S-14   Dashboard vis.  (30)   ← no dependencies
│
└── F1 Scenarios (W = 43)
    ├── S-01   Onboarding       (15)  ← no dependencies
    ├── S-09   Admin ops        (12)  ← no dependencies
    └── S-13   Config gov.      (16)  ← no dependencies
```

**All 27 scenario nodes are leaves relative to the suite tree.**
The only internal nodes with cascade > 10% are the T0 infrastructure probes — which are handled
by separate reliability mitigations (see §9.1), not by splitting.

---

## 9. Execution Strategy

### 9.1 Infrastructure Probe Reliability (T0 nodes)

T0 nodes have cascade = W(suite) = 933.5 (100%). They are explicitly excluded from the 10%
constraint but require their own mitigations:

| Probe | Mitigation |
|-------|-----------|
| T0.1 Stack healthy | `docker compose wait` with 120s timeout; retry 3×; fail-fast with clear error message naming the unhealthy service |
| T0.2 JWT + gateway | Committed test key pair — no randomness, no GitHub OAuth. Key pair in `tests/e2e/fixtures/`. Gateway configured via `docker-compose.test.yml` env override |
| T0.3 S3/DDB | LocalStack healthcheck before probes run; setup.js retries S3 HeadBucket 5× with 2s backoff |

### 9.2 Per-Scenario Isolation Pattern

Every scenario follows this contract:

```javascript
// tests/e2e/scenarios/XX-name.spec.js
test.beforeAll(async () => {
  // Create a unique group_id suffix for this scenario run
  // (prevents cross-run pollution in shared DB)
  scenarioId = `test-${Date.now()}`
  await setup.uploadConfig(scenarioId)       // fresh project config
  await setup.ensureCleanState(scenarioId)    // no leftover knowledge entries
})

test.afterAll(async () => {
  await teardown.removeProject(scenarioId)    // DELETE from q_projects + clean graph
})
```

The `scenarioId` suffix ensures parallel test runs (CI matrix) do not share state.

### 9.3 CI Execution Order

```
Stage 1 — Unit tests (Vitest):       2 min
  ├── tests/gateway/**/*.test.js
  └── quorum-mcp/tests/**/*.test.js

Stage 2 — Infrastructure probes:     2 min
  ├── T0.1: docker compose health
  ├── T0.2: JWT round-trip
  └── T0.3: S3/DDB accessible

Stage 3 — F4 scenarios (parallel):   5 min
  (core agent workflow — highest value signal first)

Stage 4 — F3 scenarios (parallel):   8 min
  (security/governance — must pass before merge)

Stage 5 — F2/F1.5/F1 (parallel):    6 min
  (operational + periodic + rare)

Total estimated wall time: ~23 min
Fail-fast: if Stage 2 fails, Stages 3–5 are skipped (no point running 27 scenarios if infrastructure is down)
```

### 9.4 Weighted Pass Rate

At any point in CI you can compute:

```
weighted_pass_rate = Σ W(passing scenarios) / W(suite)
```

A merge gate of **weighted_pass_rate ≥ 95%** means up to 46.7 points of weighted failures can
be tolerated (roughly 2–3 low-priority scenarios) without blocking a merge.

A hard block at **weighted_pass_rate < 90%** (≥93.4 points failing) triggers an escalation path.

---

## 10. Failure Cost Reference Table

This is the lookup table for assessing the severity of any test failure.

| Scenario | W | % of Suite | Failure Meaning |
|----------|---|-----------|-----------------|
| S-05.1 RBAC: create | 72 | 7.7% | Critical — all 8 roles cannot create knowledge correctly |
| S-04 Deviation governance | 70 | 7.5% | High — deviation lifecycle broken, conformance scores unreliable |
| S-05.4 RBAC: governance | 60 | 6.4% | Critical — review/approve RBAC or global write authority broken |
| S-05.5 RBAC: deviation | 60 | 6.4% | Critical — deviation action RBAC or forget branching broken |
| S-11 Self-approval | 40 | 4.3% | Critical — constitutional rule 4 broken (NO_SELF_APPROVAL) |
| S-03 Deprecation | 40 | 4.3% | High — deprecation workflow broken |
| S-02.1 Write + Recall | 32 | 3.4% | High — core memory write/read broken |
| S-05.6 RBAC: portfolio | 45 | 4.8% | Medium — portfolio/admin access control broken |
| S-06 Multi-user conflict | 45 | 4.8% | Medium — concurrent write conflict resolution broken |
| S-15 Reason placeholder | 45 | 4.8% | Medium — constitutional rule 3 enforcement broken |
| S-07 Conformance | 50 | 5.4% | Medium — conformance scoring/portfolio broken |
| S-05.2 RBAC: promote | 48 | 5.1% | Medium — PE promote/supersede access control broken |
| S-05.3 RBAC: deprecate | 48 | 5.1% | Medium — PE deprecate access control broken |
| S-02.6 Resolve: split | 20 | 2.1% | Low — coexist_split resolution broken |
| S-02.8 Dashboard conflict | 20 | 2.1% | Low — conflict review UI broken |
| S-08 Bump | 30 | 3.2% | Low — confidence endorsement broken |
| S-14 Dashboard visual | 30 | 3.2% | Low — visual regression in dashboard |
| S-02.2 Conflict detect | 24 | 2.6% | Medium — semantic conflict detection broken |
| S-12 State machine | 24 | 2.6% | Medium — invalid status transitions possible |
| S-02.3 Resolve: supersede | 20 | 2.1% | Low — supersede resolution broken |
| S-13 Config governance | 16 | 1.7% | Low — config validation/ownership broken |
| S-02.4 Resolve: reject | 16 | 1.7% | Low — reject resolution broken |
| S-02.7 Resolve: merge | 16 | 1.7% | Low — coexist_merge resolution broken |
| S-02.5 Resolve: escalate | 16 | 1.7% | Low — escalate path broken |
| S-01 Onboarding | 15 | 1.6% | Low — onboarding flow broken (rare operation) |
| S-10 Audit chain | 19.5 | 2.1% | Low-Medium — audit integrity unverifiable |
| S-09 Admin ops | 12 | 1.3% | Low — admin management broken |

**No entry exceeds 10%.** Maximum is S-05.1 at 7.7%.

---

## 11. Risk Register (What Cannot Be Automated)

These remain in `docs/MANUAL-TESTS.md`. They are not scored in the weight model because their
pass/fail cannot be determined algorithmically.

| Risk | Why | Manual Test ID |
|------|-----|---------------|
| Conflict enrichment quality | LLM mock returns canned responses — only structure is asserted, not analytical depth | MT-01 |
| `reflect()` extraction quality | Non-deterministic LLM output — quality requires human review | MT-02 |
| `quorum:scan` skill orchestration | Claude skill prompt logic, not testable code | MT-03 |
| Visual graph layout | Cytoscape.js renders correctly per browser — automation asserts node presence, not layout quality | MT-04 |

---

## 12. Quick Lookup

**What is the blast radius of this failure?**

```
IF scenario_id is known → look up W in §10
IF infrastructure probe fails → blast radius = 100% (block all stages)
IF W(failures) / W(suite) > 10% → this is a multi-scenario cascade (investigate shared infrastructure)
```

**Which scenarios to run for a PR that touches `constitutional.js`?**
```
S-11 (self-approval)   — directly tests constitutional rule 4
S-15 (reason/ph.)      — directly tests constitutional rule 3
S-05.4 (RBAC: govern)  — tests GLOBAL_WRITE_AUTHORITY
S-05.5 (RBAC: deviate) — tests DEVIATION_ACTION_AUTHORITY + DEFER_DEADLINE
S-04 (deviation gov)   — tests constitutional enforcement on defer path
```

**Which scenarios are cheapest to run for smoke testing?**
```
S-02.1 (32pts, 4 assertions, ~30s)  — validates core write/read
S-11 (40pts, NO_SELF_APPROVAL, ~15s) — validates most critical constitutional rule
T0.2 (infra probe, ~5s)             — validates JWT + gateway
```
