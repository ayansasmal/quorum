# Quorum — Risk-Weighted Product Reliability Test Plan

**Version:** 1.0 — May 2026
**Scope:** Quorum v0.4 end-to-end test suite (27 scenarios)
**Gate:** Total failure impact ≤ 10% of suite weight before any deployment
**Suite weight:** 933.5 pts | 10% gate threshold: 93.4 pts

---

## 1. Purpose

This document defines a Risk-Weighted Product Reliability Testing Framework for Quorum.
It evaluates software quality not only through functional correctness but also through:

- Product usability and governance integrity
- Failure blast radius — which other scenarios cascade if this one fails
- Business and operational risk
- Dependency propagation through the constitutional rule layer
- Deployment safety scoring

The framework introduces a weighted journey-based testing model where every test
contributes to an overall product reliability score.

**Primary objective:**

> Ensure total failure impact remains below **10% of total product reliability cost**
> (93.4 of 933.5 pts) before any deployment is permitted.

---

## 2. Goals

The testing framework aims to:

- Measure real-world impact of failures on Quorum's governance guarantees
- Prioritize critical product journeys (RBAC, deviation governance, constitutional rules)
- Quantify deployment risk per scenario before merge
- Improve release confidence with a numeric reliability score
- Reduce production regressions by catching constitutional violations early
- Provide product-aware quality metrics visible to the whole team
- Enable automated deployment gating in CI/CD
- Support scalable platform engineering practices as new journeys are added

---

## 3. Core Principles

### 3.1 Tests Are Not Equal

Traditional testing treats all failures similarly. This framework recognises that:

- Some failures are cosmetic (UI rendering glitch)
- Some failures affect core governance flows (RBAC bypass, self-approval)
- Some failures impact every project linked to a global catalog

Therefore every test receives a calculated weight. A failing RBAC assertion
on `POST /api/knowledge` has 7.7× the blast radius of a failing admin UI interaction.

---

### 3.2 Product Journeys Define Risk

Testing is modelled around user journeys that map to Quorum's constitutional rules
and feature layers:

| Quorum Journey | Domain |
|----------------|--------|
| Global Catalog Onboarding | Federation bootstrap |
| Knowledge Governance Lifecycle | Core agent write / read / conflict path |
| Deprecation Workflow | Knowledge lifecycle management |
| Deviation Governance | Cross-catalog standards compliance |
| RBAC Boundary Simulation | Access control correctness |
| Multi-User Conflict Resolution | Concurrent governance safety |
| Conformance Scoring & Portfolio | Executive intelligence layer |
| Confidence Endorsement | Authority weight evolution |
| Self-Approval Prevention | Constitutional Rule 4 |
| Reason / Placeholder Rejection | Constitutional Rule 3 |
| Audit Chain Integrity | Constitutional Rule 2 |
| Knowledge Status State Machine | Status transition correctness |
| Platform Admin Operations | Operational integrity |
| Dashboard Visual & Interaction | UI correctness |
| Config Management & Governance | Platform config safety |

Each journey contains smaller functional units and leaf-level assertions.

---

### 3.3 Failure Impact Propagates

A low-level failure may affect multiple higher-level journeys. In Quorum, the
propagation is vertical through the constitutional layer:

```
RBAC middleware failure
        ↓
All governance actions fail (review, promote, supersede, deprecate)
        ↓
All deviation governance actions fail
        ↓
Conformance scores become unactionable
        ↓
Portfolio visibility degrades to UNCERTIFIED
```

Risk therefore propagates upward. The RBAC scenarios carry the highest weight
in the suite (333 pts / 35.7%) because they are the root of this propagation tree.

---

## 4. Weight Formula

### 4.1 Theoretical Multi-Factor Model

Each test node receives a calculated weight that quantifies its contribution to the
overall reliability budget:

```
Weight = (BaseWeight + DependencyWeight) × UsageFactor × CriticalityFactor × BlastRadiusFactor
```

Where:
- **BaseWeight** — intrinsic importance of the test type (leaf-level)
- **DependencyWeight** — Σ(child weights) for parent nodes; 0 for leaf nodes
- **UsageFactor** — how frequently this flow executes in production
- **CriticalityFactor** — business severity if this assertion fails
- **BlastRadiusFactor** — how many other journeys depend on this node

---

### 4.2 Weight Component Reference

**BaseWeight — intrinsic test type:**

| Type | Base Weight |
|------|-------------|
| Cosmetic validation | 1 |
| UI interaction | 2 |
| Functional logic | 5 |
| Revenue / core path | 10 |
| Security / governance validation | 15 |

**DependencyWeight — parent aggregation:**

```
ParentWeight = Σ(ChildWeights)
```

**UsageFactor — production frequency:**

| Usage Frequency | Factor | Quorum Tier |
|-----------------|--------|-------------|
| One-time onboarding / admin | 1 | F1 |
| Periodic / scheduled | 1.5 | F1.5 |
| Weekly operational | 2 | F2 |
| Daily governance / security | 3 | F3 |
| Core agent workflow (every tool call) | 4 | F4 |

**CriticalityFactor — business severity:**

| Severity | Factor |
|----------|--------|
| Cosmetic | 1 |
| Minor UX issue | 2 |
| Functional failure | 5 |
| Revenue impact | 10 |
| Security / governance risk | 20 |

**BlastRadiusFactor — affected journeys:**

| Affected Journeys | Factor |
|-------------------|--------|
| Single journey | 1 |
| Few journeys (2–5) | 2 |
| Platform-wide (all journeys) | 5 |

---

### 4.3 Quorum Simplified Model

Applying all four factors independently to every leaf produces weights too large
to reason about (a constitutional security assertion at BW=15 × CF=20 × BRF=5 × F4
= 6,000 per leaf — the total suite would exceed the 10% gate on a single broken test).

For Quorum's suite we apply a conservative simplification that keeps weights
proportional and the total budget manageable:

```
ScenarioWeight = Σ(leaf_weights = 1 each) × FrequencyTier
```

This sets `BaseWeight = 1`, `CriticalityFactor = 1`, `BlastRadiusFactor = 1`
uniformly. The **criticality and blast radius are instead used to determine
how many leaf assertions a scenario contains** — higher-risk scenarios get
more leaf assertions and therefore higher raw counts — making the model
self-consistent without combinatorial explosion.

**Leaf aggregation (binary tree rule):**

```
leaf node:     W = 1 × FrequencyTier
parent node:   W = Σ(child weights)
scenario root: W = raw_leaf_count × FrequencyTier
```

**Failure cost:**

```
FailureCost(scenario) = ScenarioWeight
```

Scenarios seed their own state in isolation. There are no cross-scenario state
dependencies; blast radius is contained to the scenario's own weight.

**Suite risk percentage:**

```
RiskPercentage = (Σ(FailedScenarioWeights) / 933.5) × 100
```

**Reliability score:**

```
ReliabilityScore = 100 − RiskPercentage
```

---

## 5. Failure Cost Model

### 5.1 Failure Cost Per Node

```
FailureCost = NodeWeight + DownstreamImpact
```

For a leaf node:  `FailureCost = FrequencyTier`
For a scenario:   `FailureCost = Σ(leaf weights in scenario)`
For a group:      `FailureCost = Σ(scenario weights in group)`

### 5.2 Total Product Cost

```
TotalProductCost = Σ(AllScenarioWeights) = 933.5
```

### 5.3 Risk Percentage

```
RiskPercentage = (TotalFailedCost / TotalProductCost) × 100
               = (TotalFailedCost / 933.5) × 100
```

---

## 6. Deployment Gate Rules

```
Risk Range     Status      CI Action
─────────────────────────────────────────────────────────────────
0.0  –  5.0%   ✅ SAFE     Merge allowed automatically
5.1  –  9.9%   ⚠️ WARNING  Block merge; require PE manual review
10.0%+         🔴 UNSAFE   Block merge; no exceptions
```

> No individual Quorum scenario exceeds the 10% block threshold.
> Maximum single-scenario blast radius: **7.7% (S-05.1 RBAC Knowledge Create).**

---

## 7. Quorum Suite Binary Tree

### 7.1 Suite Overview

```
Total suite weight:   933.5 pts
10% gate threshold:    93.4 pts  (block deployment above this)
 5% gate threshold:    46.7 pts  (manual review above this)
Number of scenarios:      27
Infrastructure probes:   T0  (outside budget — see §12)
```

The tree has four layers:

1. **Suite root** — the single gate point (W=933.5)
2. **Journey groups** — four functional areas (G-A through G-D)
3. **Scenarios** — 27 independently-gatable test scenarios
4. **Steps / leaves** — individual assertions (1 pt each before F-tier)

---

### 7.2 Full Binary Tree — Suite to Scenario Level

```
QUORUM TEST SUITE (W = 933.5)    10% gate = 93.4 pts
│
├── T0  Infrastructure Probes ─────────── OUTSIDE BUDGET (100% cascade)
│      Mitigation: Docker health retries (3×/120s), committed test keys,
│                  LocalStack HeadBucket probe (5× × 2s backoff)
│   ├── T0.1  Docker stack health
│   │         (PostgreSQL · FalkorDB · Redis · LocalStack · Graphiti · Gateway)
│   ├── T0.2  JWT round-trip
│   │         (sign with test P-256 key → GET /api/knowledge → 200)
│   └── T0.3  Config probe
│             (GET /api/globals + GET /user/profile/test-pe)
│
├── G-A  Catalog & Federation ─────────────────────────── W = 219  (23.5%)
│   │
│   ├── J01  Global Catalog Onboarding ───────────────── W =  15    1.6%  F1
│   │         15 leaf assertions × F1 = 1
│   │         Steps: config upload · globals discovery · PE creates ACTIVE
│   │                architect creates DRAFT · PA approves · cross-catalog search
│   │
│   ├── J02  Knowledge Governance Lifecycle ──────────── W = 164 total
│   │   ├── S-02.1  Write + Recall ─────────────────── W =  32    3.4%  F4
│   │   │           8 leaves × F4=4 | MCP write→approve→recall→audit chain
│   │   ├── S-02.2  Conflict Detection ────────────── W =  24    2.6%  F4
│   │   │           6 leaves × F4=4 | semantic detect→LLM→pending→resolve
│   │   ├── S-02.3  Supersede Path ─────────────────── W =  20    2.1%  F4
│   │   │           5 leaves × F4=4 | ACTIVE→SUPERSEDED + new ACTIVE
│   │   ├── S-02.4  Reject Path ───────────────────── W =  16    1.7%  F4
│   │   │           4 leaves × F4=4 | PE rejects proposal, stays DRAFT
│   │   ├── S-02.5  Escalation Path ─────────────────  W =  16    1.7%  F4
│   │   │           4 leaves × F4=4 | escalate to PA, PA resolves
│   │   ├── S-02.6  Coexist-Split ──────────────────── W =  20    2.1%  F4
│   │   │           5 leaves × F4=4 | two valid entries, both ACTIVE
│   │   ├── S-02.7  Coexist-Merge ──────────────────── W =  16    1.7%  F4
│   │   │           4 leaves × F4=4 | merge duplicate, one canonical
│   │   └── S-02.8  Dashboard UI ───────────────────── W =  20    2.1%  F4
│   │               5 leaves × F4=4 | browser: pending panel, approve, result
│   │
│   └── J03  Deprecation Workflow ──────────────────── W =  40    4.3%  F2
│             20 leaf assertions × F2 = 2
│             Parts: request→dedup→MCP pending→dashboard views→approve→staleness
│
├── G-B  Security & Access Control ─────────────────── W = 333  (35.7%)
│   │
│   └── J05  RBAC Boundary Simulation ─────────────── W = 333 total
│       │
│       ├── S-05.1  RBAC Knowledge Create ─────────── W =  72    7.7%  F4  ← SUITE MAXIMUM
│       │           18 leaves × F4=4 | 8 roles × create op + deny assertions
│       ├── S-05.2  RBAC Promote + Supersede ────── W =  48    5.1%  F4
│       │           12 leaves × F4=4 | promote (PE+ only), supersede (PE+ only)
│       ├── S-05.3  RBAC Deprecate ─────────────── W =  48    5.1%  F4
│       │           12 leaves × F4=4 | single + bulk, PE-only enforcement
│       ├── S-05.4  RBAC Governance + Global Write ─ W =  60    6.4%  F4
│       │           15 leaves × F4=4 | review·bump·global write (architect+)
│       ├── S-05.5  RBAC Deviation Action + Forget ─ W =  60    6.4%  F4
│       │           15 leaves × F4=4 | deviate·action (architect+)·forget
│       └── S-05.6  RBAC Portfolio + Admin ─────── W =  45    4.8%  F3
│                   15 leaves × F3=3 | portfolio (PORTFOLIO_ROLES)·admin routes
│
├── G-C  Governance Flows ─────────────────────────── W = 280  (30.0%)
│   │
│   ├── J04  Deviation Governance Lifecycle ───────── W =  70    7.5%  F2
│   │         35 leaf assertions × F2 = 2
│   │         Parts: record·invalid-catalog·batch·dashboard·accept·deny+hint
│   │                defer+constitutional·executive-readonly·overdue
│   │
│   ├── J06  Multi-User Conflict Resolution ──────── W =  45    4.8%  F3
│   │         15 leaf assertions × F3 = 3
│   │         Two agents write conflicting knowledge simultaneously
│   │
│   ├── J07  Conformance Scoring & Portfolio ──────── W =  50    5.4%  F2
│   │         25 leaf assertions × F2 = 2
│   │         UNCERTIFIED gate · score calc · portfolio rollup · staleness
│   │
│   ├── J08  Confidence Endorsement (Bump) ─────────── W =  30    3.2%  F2
│   │         15 leaf assertions × F2 = 2
│   │         7-day cooldown · role-weighted delta · cap enforcement
│   │
│   ├── J11  Self-Approval Prevention ─────────────── W =  40    4.3%  F3
│   │         ~13 leaf assertions × F3 = 3
│   │         Constitutional Rule 4 on every approval endpoint
│   │
│   └── J15  Reason / Placeholder Rejection ──────── W =  45    4.8%  F3
│             15 leaf assertions × F3 = 3
│             Constitutional Rule 3 — 7 endpoints × (reject + accept)
│
└── G-D  Platform Operations ───────────────────────── W = 101.5 (10.9%)
    │
    ├── J09  Platform Admin Operations ─────────────── W =  12    1.3%  F1
    │         12 leaf assertions × F1 = 1
    │         Admin user CRUD · project archival · admin config
    │
    ├── J10  Audit Chain Integrity ─────────────────── W =  19.5   2.1%  F1.5
    │         13 leaf assertions × F1.5 = 1.5
    │         SHA256 tamper-evident chain verification
    │
    ├── J12  Knowledge Status State Machine ─────────── W =  24    2.6%  F3
    │         8 leaf assertions × F3 = 3
    │         DRAFT→ACTIVE→SUPERSEDED→DEPRECATED legal transitions
    │
    ├── J13  Config Management & Governance ─────────── W =  16    1.7%  F1
    │         16 leaf assertions × F1 = 1
    │         Multi-party config · sync validation · schema enforcement
    │
    └── J14  Dashboard Visual & Interaction ─────────── W =  30    3.2%  F1.5
              20 leaf assertions × F1.5 = 1.5
              Graph · config editor · status · audit timeline · project selector
```

---

### 7.3 Group Weight Validation

| Group | Journeys | W | % of Suite | Max single blast | Gate |
|-------|----------|---|------------|-----------------|------|
| G-A Catalog & Federation | J01, J02, J03 | 219 | 23.5% | 3.4% (S-02.1) | ✓ |
| G-B Security & Access | J05 | 333 | 35.7% | 7.7% (S-05.1) | ✓ |
| G-C Governance Flows | J04, J06, J07, J08, J11, J15 | 280 | 30.0% | 7.5% (J04) | ✓ |
| G-D Platform Operations | J09, J10, J12, J13, J14 | 101.5 | 10.9% | 2.6% (J12) | ✓ |
| **Suite Total** | **J01–J15 (27 scenarios)** | **933.5** | 100% | **7.7%** | ✓ |

Weight check: 219 + 333 + 280 + 101.5 = **933.5** ✓

---

### 7.4 Scenario Derivation Table

All 27 scenarios with raw leaf counts, frequency tier, computed weight, and blast radius.

| Scenario | Journey / Description | Raw Leaves | F Tier | W | Blast% | Gate |
|----------|----------------------|-----------|--------|---|--------|------|
| S-01 | J01 Global Catalog Onboarding | 15 | F1 (×1) | 15 | 1.6% | ✅ |
| S-02.1 | J02 Write + Recall | 8 | F4 (×4) | 32 | 3.4% | ✅ |
| S-02.2 | J02 Conflict Detection | 6 | F4 (×4) | 24 | 2.6% | ✅ |
| S-02.3 | J02 Supersede Path | 5 | F4 (×4) | 20 | 2.1% | ✅ |
| S-02.4 | J02 Reject Path | 4 | F4 (×4) | 16 | 1.7% | ✅ |
| S-02.5 | J02 Escalation Path | 4 | F4 (×4) | 16 | 1.7% | ✅ |
| S-02.6 | J02 Coexist-Split | 5 | F4 (×4) | 20 | 2.1% | ✅ |
| S-02.7 | J02 Coexist-Merge | 4 | F4 (×4) | 16 | 1.7% | ✅ |
| S-02.8 | J02 Dashboard UI | 5 | F4 (×4) | 20 | 2.1% | ✅ |
| S-03 | J03 Deprecation Workflow | 20 | F2 (×2) | 40 | 4.3% | ✅ |
| S-04 | J04 Deviation Governance | 35 | F2 (×2) | 70 | 7.5% | ⚠️ |
| S-05.1 | J05 RBAC Knowledge Create | 18 | F4 (×4) | 72 | 7.7% | ⚠️ |
| S-05.2 | J05 RBAC Promote + Supersede | 12 | F4 (×4) | 48 | 5.1% | ⚠️ |
| S-05.3 | J05 RBAC Deprecate | 12 | F4 (×4) | 48 | 5.1% | ⚠️ |
| S-05.4 | J05 RBAC Governance + Global Write | 15 | F4 (×4) | 60 | 6.4% | ⚠️ |
| S-05.5 | J05 RBAC Deviation Action + Forget | 15 | F4 (×4) | 60 | 6.4% | ⚠️ |
| S-05.6 | J05 RBAC Portfolio + Admin | 15 | F3 (×3) | 45 | 4.8% | ✅ |
| S-06 | J06 Multi-User Conflict Resolution | 15 | F3 (×3) | 45 | 4.8% | ✅ |
| S-07 | J07 Conformance Scoring & Portfolio | 25 | F2 (×2) | 50 | 5.4% | ⚠️ |
| S-08 | J08 Confidence Endorsement (Bump) | 15 | F2 (×2) | 30 | 3.2% | ✅ |
| S-09 | J09 Platform Admin Operations | 12 | F1 (×1) | 12 | 1.3% | ✅ |
| S-10 | J10 Audit Chain Integrity | 13 | F1.5 (×1.5) | 19.5 | 2.1% | ✅ |
| S-11 | J11 Self-Approval Prevention | ~13 | F3 (×3) | 40 | 4.3% | ✅ |
| S-12 | J12 Knowledge Status State Machine | 8 | F3 (×3) | 24 | 2.6% | ✅ |
| S-13 | J13 Config Management & Governance | 16 | F1 (×1) | 16 | 1.7% | ✅ |
| S-14 | J14 Dashboard Visual & Interaction | 20 | F1.5 (×1.5) | 30 | 3.2% | ✅ |
| S-15 | J15 Reason / Placeholder Rejection | 15 | F3 (×3) | 45 | 4.8% | ✅ |
| **Total** | **27 scenarios** | | | **933.5** | — | — |

> ✅ Safe (0–5%) · ⚠️ Warning (5–10%, manual review required) · 🔴 Block (≥10%)
>
> **No scenario reaches the block threshold. Suite maximum: S-05.1 at 7.7%.**

---

### 7.5 Leaf-Level Tree: J15 Reason / Placeholder Rejection (S-15)

J15 has the clearest leaf-level structure — seven endpoints × two assertions each —
making it the canonical example for how leaf weights aggregate up the tree.

```
J15 — Reason / Placeholder Rejection (W = 45)
│    FrequencyTier: F3 (daily — every governance action calls enforceReasonRequired)
│    BlastRadius:   4.8%  ✅ Safe
│    Method:        API only (no browser)
│
├── SETUP  Seed prerequisite state (unweighted — not an assertion)
│          One ACTIVE entry · one DRAFT entry · one conflict · one deviation
│
├── E1  POST /pg/versions — supersede ───────────── W = 6 (2 leaves × F3=3)
│   ├── A.  reason: "tbd" → 400 { rule: "REASON_REQUIRED" } ── leaf W=3
│   └── B.  reason: valid (≥10 chars) → 200, supersede applied ─ leaf W=3
│
├── E2  POST /api/review/:id — conflict resolve ─── W = 6
│   ├── A.  note: "ok" → 400 { rule: "REASON_REQUIRED" } ─────── leaf W=3
│   └── B.  note: valid → 200, conflict resolved ────────────── leaf W=3
│
├── E3  POST .../promote — DRAFT → ACTIVE ───────── W = 6
│   ├── A.  note: "test" → 400 { rule: "REASON_REQUIRED" } ───── leaf W=3
│   └── B.  note: valid → 200, status = ACTIVE ────────────── leaf W=3
│
├── E4  POST .../supersede — knowledge route ──────── W = 6
│   ├── A.  reason: "todo" → 400 { rule: "REASON_REQUIRED" } ─── leaf W=3
│   └── B.  reason: valid → 200, superseded ────────────────── leaf W=3
│
├── E5  POST .../deprecate ──────────────────────── W = 6
│   ├── A.  reason: "n/a" → 400 { rule: "REASON_REQUIRED" } ──── leaf W=3
│   └── B.  reason: valid → 200, entry deprecated ───────────── leaf W=3
│
├── E6  POST /api/deviations/:id/action ───────────── W = 6
│   ├── A.  reason: "." → 400 { rule: "REASON_REQUIRED" } ─────── leaf W=3
│   └── B.  reason: valid → 200, action recorded ────────────── leaf W=3
│
├── E7  POST /admin/users ───────────────────────── W = 6
│   ├── A.  reason: "yes" → 400 { rule: "REASON_REQUIRED" } ──── leaf W=3
│   └── B.  reason: valid → 200, user added ─────────────────── leaf W=3
│
└── META  `rule` field present in ALL 400 responses ── leaf W=3

Weight check:  (7 endpoints × 2 assertions × F3=3) + META(3) = 42 + 3 = 45 ✓
```

**Placeholder matching rules** (affects all 7 reject assertions above):

```
PLACEHOLDER_PATTERNS = ['ok', 'yes', 'no', 'n/a', 'na', 'test',
                        'tbd', 'todo', 'fixme', '.', '!']

Rejection triggers when:
  len(reason.trim()) < 10
  OR reason.trim().toLowerCase() ∈ PLACEHOLDER_PATTERNS
  OR reason.trim().toLowerCase() contains a pattern from the list

Example: "tbd tbd tbd" = 11 chars, meets ≥10 minimum, but contains "tbd" → REJECTED
Matching is case-insensitive and trim-normalised.
```

---

### 7.6 Pre-Split Violation Analysis

Before the final scenario split, two journeys violated the 10% constraint:

| Journey (original) | Original W | Blast% | Constraint | Problem |
|--------------------|------------|--------|------------|---------|
| J02 monolith | 120 | 14.8% | **VIOLATED** | 5 resolution types bundled — each is an independent code path |
| J05 monolith | 255 | 31.4% | **VIOLATED** | 104 RBAC cells (13 ops × 8 roles) in one scenario |

**J02 resolution:** Each conflict resolution type (supersede, reject, escalate,
coexist_split, coexist_merge) became an independent sub-scenario starting from
zero state. Plus write+recall and dashboard UI as separate sub-scenarios. Max
post-split blast radius: **3.4% (S-02.1)** — well under 10%.

**J05 resolution:** Split by operation category into 6 sub-scenarios. Each tests
a distinct set of RBAC rules for a distinct set of operations. An auth injection
failure now breaks at most one sub-scenario. Max post-split blast radius:
**7.7% (S-05.1)** — within the warning tier, not the block tier.

---

### 7.7 Combined Failure Scenarios

When multiple scenarios fail simultaneously, costs add linearly:

| Failed Scenarios | Σ Weight | Risk% | Gate Action |
|-----------------|---------|-------|-------------|
| S-05.1 alone | 72 | 7.7% | ⚠️ Manual review |
| S-04 alone | 70 | 7.5% | ⚠️ Manual review |
| S-05.1 + S-04 | 142 | 15.2% | 🔴 **Block** |
| S-04 + S-07 | 120 | 12.9% | 🔴 **Block** |
| S-06 + S-15 + S-03 | 130 | 13.9% | 🔴 **Block** |
| S-02.1 + S-02.2 + S-02.3 | 76 | 8.1% | ⚠️ Manual review |
| All J02 subs (S-02.1–02.8) | 164 | 17.6% | 🔴 **Block** |
| All J05 subs (S-05.1–05.6) | 333 | 35.7% | 🔴 **Block** |
| Any 2 Warning-tier scenarios | 120–144 | 12.9–15.4% | 🔴 **Block** |

**Key insight:** Two scenarios that individually permit deployment (both in the
warning tier at ~7%) will **together block deployment** when they fail
simultaneously. The gate correctly escalates combined risk.

---

## 8. Failure Cost Reference

Sorted by weight descending. Each scenario's failure cost equals its own weight
because scenarios are state-isolated — no cross-scenario cascade.

| Rank | Scenario | W | Blast% | Deployment Gate |
|------|----------|---|--------|-----------------|
| 1 | S-05.1 RBAC Knowledge Create | 72 | 7.7% | ⚠️ Warning |
| 2 | S-04 Deviation Governance | 70 | 7.5% | ⚠️ Warning |
| 3 | S-05.4 RBAC Governance + Global | 60 | 6.4% | ⚠️ Warning |
| 4 | S-05.5 RBAC Deviation + Forget | 60 | 6.4% | ⚠️ Warning |
| 5 | S-07 Conformance Scoring | 50 | 5.4% | ⚠️ Warning |
| 6 | S-05.2 RBAC Promote + Supersede | 48 | 5.1% | ⚠️ Warning |
| 7 | S-05.3 RBAC Deprecate | 48 | 5.1% | ⚠️ Warning |
| 8 | S-05.6 RBAC Portfolio + Admin | 45 | 4.8% | ✅ Safe |
| 9 | S-06 Multi-User Conflict | 45 | 4.8% | ✅ Safe |
| 10 | S-15 Reason / Placeholder | 45 | 4.8% | ✅ Safe |
| 11 | S-03 Deprecation Workflow | 40 | 4.3% | ✅ Safe |
| 12 | S-11 Self-Approval Prevention | 40 | 4.3% | ✅ Safe |
| 13 | S-02.1 Write + Recall | 32 | 3.4% | ✅ Safe |
| 14 | S-14 Dashboard Visual | 30 | 3.2% | ✅ Safe |
| 15 | S-08 Confidence Bump | 30 | 3.2% | ✅ Safe |
| 16 | S-02.2 Conflict Detection | 24 | 2.6% | ✅ Safe |
| 17 | S-12 State Machine | 24 | 2.6% | ✅ Safe |
| 18 | S-02.3 Supersede Path | 20 | 2.1% | ✅ Safe |
| 19 | S-02.6 Coexist-Split | 20 | 2.1% | ✅ Safe |
| 20 | S-02.8 Dashboard UI | 20 | 2.1% | ✅ Safe |
| 21 | S-10 Audit Chain | 19.5 | 2.1% | ✅ Safe |
| 22 | S-02.4 Reject Path | 16 | 1.7% | ✅ Safe |
| 23 | S-02.5 Escalation Path | 16 | 1.7% | ✅ Safe |
| 24 | S-02.7 Coexist-Merge | 16 | 1.7% | ✅ Safe |
| 25 | S-13 Config Governance | 16 | 1.7% | ✅ Safe |
| 26 | S-01 Global Catalog Onboarding | 15 | 1.6% | ✅ Safe |
| 27 | S-09 Admin Operations | 12 | 1.3% | ✅ Safe |
| — | **Suite Total** | **933.5** | 100% | — |

> **Scenarios ranked 1–7 individually trigger manual review (5–10%) but do not
> block deployment alone. Any two of them failing together will block (>10%).**

---

## 9. Reliability Score

```
ReliabilityScore = 100 − RiskPercentage

Score Range   Level
─────────────────────────────────
95 – 100      Excellent
85 –  94      Stable
70 –  84      Moderate Risk
50 –  69      High Risk
  < 50        Critical
```

**Quorum scenario examples:**

| Failure Scenario | Risk% | Score | Level |
|-----------------|-------|-------|-------|
| Clean run (all pass) | 0.0% | 100.0 | Excellent |
| S-09 Admin Operations | 1.3% | 98.7 | Excellent |
| S-03 Deprecation Workflow | 4.3% | 95.7 | Excellent |
| S-05.1 RBAC Create alone | 7.7% | 92.3 | Stable (⚠️ review) |
| S-04 Deviation Governance alone | 7.5% | 92.5 | Stable (⚠️ review) |
| S-05.1 + S-04 together | 15.2% | 84.8 | Stable (🔴 blocked) |
| All J02 sub-scenarios | 17.6% | 82.4 | Moderate Risk (🔴 blocked) |
| All J05 sub-scenarios | 35.7% | 64.3 | High Risk (🔴 blocked) |

---

## 10. Types of Testing Covered

| Type | Covered by | Notes |
|------|-----------|-------|
| Unit testing | Constitutional test suite (100% coverage requirement) | Outside E2E weight model; enforced separately |
| Integration testing | S-02.x, S-04, S-05.x, S-07 | Gateway + MCP + Graphiti + PostgreSQL |
| End-to-end testing | All 27 scenarios | Full stack via Docker Compose |
| API testing | S-15, S-10, S-09, S-13 | Playwright API mode / Hurl |
| Security testing | S-05.x (RBAC), S-11 (self-approval), S-15 (reason) | Constitutional invariants |
| Contract testing | S-01 (config schema), S-13 (Zod validation) | `POST /sync/configs` validation chain |
| Performance testing | — | Deferred to v0.5 |
| Chaos testing | — | Deferred to v0.5 |
| UX validation | S-02.8, S-14 | Browser-mode Playwright |
| Accessibility testing | — | Deferred to v0.5 |
| Reliability simulations | T0 (stack health), S-10 (audit chain) | Infrastructure probes + SHA256 chain |

---

## 11. CI/CD Integration

### Recommended Pipeline Flow

```
Code Change
     ↓
Static Analysis (ESLint, typescript-check)
     ↓
Unit Tests (constitutional suite, tool tests)
     ↓
Stage 0 — Infrastructure Probe (T0.1 · T0.2 · T0.3)
     ↓
Stage 1 — Core Agent Workflow (F4, ~5 min)
     ↓
Stage 2 — Daily Governance & Security (F4+F3, ~6 min)
     ↓
Stage 3 — Weekly Operational (F2, ~5 min)
     ↓
Stage 4 — Platform & Periodic (F1/F1.5, ~5 min)
     ↓
Risk Calculation Engine (gate.js)
     ↓
Deployment Gate (✅ / ⚠️ / 🔴)
```

### Stage Detail

```
Stage 0 — Infrastructure probe (mandatory; abort if any T0 fails)
  docker compose -f docker-compose.test.yml up -d
  node tests/e2e/helpers/setup.js
  T0.1 · T0.2 · T0.3
  (~2 min)

Stage 1 — Core Agent Workflow (F4 scenarios)
  S-02.1  Write + Recall
  S-02.2  Conflict Detection
  S-05.1  RBAC Knowledge Create         ← risk gate check after this stage
  S-05.4  RBAC Governance + Global
  S-05.5  RBAC Deviation + Forget
  (~5 min)

Stage 2 — Daily Governance & Security (F4 + F3)
  S-02.3  Supersede Path
  S-02.4  Reject Path
  S-02.5  Escalation Path
  S-02.6  Coexist-Split
  S-02.7  Coexist-Merge
  S-02.8  Dashboard UI
  S-05.2  RBAC Promote + Supersede
  S-05.3  RBAC Deprecate
  S-05.6  RBAC Portfolio + Admin
  S-06    Multi-User Conflict
  S-11    Self-Approval Prevention
  S-12    Knowledge Status State Machine
  S-15    Reason / Placeholder Rejection
  (~6 min)

Stage 3 — Weekly Operational (F2)
  S-03    Deprecation Workflow
  S-04    Deviation Governance
  S-07    Conformance Scoring & Portfolio
  S-08    Confidence Endorsement (Bump)
  (~5 min)

Stage 4 — Platform & Periodic (F1 / F1.5)
  S-01    Global Catalog Onboarding
  S-09    Platform Admin Operations
  S-10    Audit Chain Integrity
  S-13    Config Management & Governance
  S-14    Dashboard Visual & Interaction
  (~5 min)

Total estimated run time: ~23 minutes
Risk gate: evaluated after every stage; abort entire pipeline if risk% ≥ 10%
```

### Playwright Frequency Tags

```bash
# Core only — fastest feedback loop (Stages 0–1)
npx playwright test --grep="F4"

# Daily check — core + security (Stages 0–2)
npx playwright test --grep="F4|F3"

# Pre-merge — all except periodic (Stages 0–3)
npx playwright test --grep="F4|F3|F2"

# Full suite
npx playwright test tests/e2e/scenarios/
```

### Risk Gate Script

```javascript
// scripts/ci/gate.js
const SUITE_WEIGHT     = 933.5
const BLOCK_THRESHOLD  =  10.0
const WARN_THRESHOLD   =   5.0

function evaluate(failedWeight) {
  const risk  = (failedWeight / SUITE_WEIGHT) * 100
  const score = (100 - risk).toFixed(1)
  if (risk >= BLOCK_THRESHOLD) {
    console.error(`🔴 BLOCKED   risk=${risk.toFixed(1)}%  score=${score}  ReliabilityScore=CRITICAL`)
    process.exit(1)
  }
  if (risk >= WARN_THRESHOLD) {
    console.warn(`⚠️  WARNING   risk=${risk.toFixed(1)}%  score=${score}  (manual review required)`)
    process.exit(0)
  }
  console.log(`✅ SAFE      risk=${risk.toFixed(1)}%  score=${score}  ReliabilityScore=Excellent`)
  process.exit(0)
}
```

### PR Comment Format

```
## Quorum Test Risk Report

Suite weight:   933.5 pts
Failed weight:   45.0 pts   (S-15 Reason/Placeholder — see run #4521)
Risk:            4.8%  ✅ SAFE
ReliabilityScore: 95.2 / 100 — Excellent

Deployment allowed.
```

---

## 12. Infrastructure Probes (T0)

T0 probes are **outside the 10% budget** by definition — a T0 failure means
the test run itself is invalid, not merely a budget item. They receive dedicated
reliability mitigations rather than a weight allocation.

| Probe | What it checks | Failure mitigation |
|-------|---------------|-------------------|
| T0.1 Stack health | All 6 Docker containers healthy: PostgreSQL, FalkorDB, Redis, LocalStack, Graphiti, Gateway | `healthcheck` in docker-compose.test.yml: 3 retries × 40s interval × 10s start period |
| T0.2 JWT round-trip | Sign minimal JWT with committed P-256 test key → `GET /api/knowledge` → 200 | Committed test key pair (not ephemeral); `QUORUM_JWT_PUBLIC_KEY` env in test compose |
| T0.3 Config probe | `GET /api/globals` returns both test project configs; `GET /user/profile/test-pe` returns correct role | LocalStack HeadBucket probe in setup.js: 5× retries × 2s backoff |

**T0 failure handling:** If any probe fails after retries, `setup.js` calls
`process.exit(1)`. CI logs the specific failing container and exits before
running any scenario. No scenario weights are accumulated; the pipeline aborts.

---

## 13. Manual Test Exclusions

The following concerns cannot be automated and are excluded from the weighted budget:

| ID | Concern | Why not automatable | Mitigation |
|----|---------|---------------------|------------|
| MT-01 | Conflict enrichment quality | LLM mock returns canned "no conflict" — structure tested, not analytical depth | Quarterly review of conflict detection quality on production data |
| MT-02 | `reflect()` extraction quality | Non-deterministic LLM output — quality requires human review | PE reviews generated summaries before promoting to ACTIVE |
| MT-03 | `quorum:scan` skill orchestration | Claude skill prompt text, not testable code | Skill text reviewed in code review; acceptance tested manually on staging |
| MT-04 | Visual graph layout quality | Node presence asserted; layout clarity requires human judgment | UX review checklist in release process |

---

## 14. Visualization Recommendations

The framework benefits significantly from visualization:

- **Journey dependency tree** — the binary tree in §7.2 rendered as an interactive SVG
- **Reliability heatmap** — blast radius colour-coded by scenario (green < 5%, amber 5–10%)
- **Failure propagation graph** — shows which scenarios fail together in combined scenarios
- **Risk trend chart** — ReliabilityScore over time across deployments
- **Release confidence dashboard** — per-stage pass rates + current risk%
- **Service dependency topology** — G-A/B/C/D group health at a glance

---

## 15. Key Risks to the Weight Model

| Risk | Description | Mitigation |
|------|-------------|------------|
| Scenario interdependence | If scenarios share state, a failure in S-X can cause S-Y to fail without S-Y actually being broken | Each scenario seeds its own state with a unique `scenarioId` suffix; no cross-scenario state |
| Mock fidelity gap | Mock OpenAI uses deterministic hash embeddings; real embedding space drift won't be caught | Integration tests on staging with real embeddings on a weekly cadence |
| Weight staleness | New leaf assertions are added without updating raw_leaves counts | Rule: when adding a leaf assertion, update `Raw Leaves` in §7.4 and recalculate `W` and `Blast%` |
| F4 over-concentration | 45% of suite weight is in F4 scenarios; an auth middleware regression could bring 35% at once | Stage 1 runs F4 first — failures caught before spending time on later stages |
| Simultaneous failure blindspot | Two warning-tier failures together block; dev may not realise until full CI run | Gate script evaluates cumulative risk after every stage and aborts early |

---

## 16. Future Enhancements

### 16.1 DAG-Based Dependency Graphs

Move beyond the strict binary tree into Directed Acyclic Graphs (DAGs):

- Model shared services (e.g., constitutional middleware) as shared nodes
- Cross-feature dependency tracking for blast radius calculation
- More accurate cascade when multiple scenarios depend on the same broken service

### 16.2 AI-Assisted Risk Prediction

Potential future capabilities:

- Predict likely failure areas from code diff before tests run
- Suggest high-risk regression zones based on changed files
- Auto-prioritise test execution order based on blast radius × change proximity
- Intelligent test selection: only run scenarios whose blast radius covers the changed code paths

### 16.3 Historical Reliability Modelling

Use historical deployment data to:

- Predict deployment confidence from code change characteristics
- Identify flaky scenarios (intermittent failures inflate effective weight)
- Calculate stability trends per journey group
- Feed back into FrequencyTier reassignment as production usage patterns change

---

## 17. Benefits

This framework provides Quorum with:

- **Governance-aware testing** — constitutional rule violations carry appropriate weight
- **Quantified release confidence** — a numeric score rather than binary pass/fail
- **Reduced production incidents** — high-blast scenarios require manual review at 5%
- **Better prioritisation** — failure cost table ranks which tests matter most for triage
- **Improved executive visibility** — ReliabilityScore communicates quality to non-engineers
- **Faster incident prevention** — CI aborts early when risk crosses stage thresholds
- **Safer continuous delivery** — automated gate catches simultaneous multi-scenario failures
- **Reliability-focused engineering culture** — every new test is a visible budget contribution

---

## 18. Conclusion

This framework transforms Quorum testing from a binary pass/fail system into a
measurable reliability model.

By introducing:

- weighted journeys tied to constitutional rules and product criticality,
- dependency-aware scoring with pre-split violation analysis,
- failure propagation containment via scenario isolation,
- and deployment risk calculation with a hard numeric gate,

the organisation gains a practical method to evaluate the real-world impact of
every code change before release.

The 10% gate is not arbitrary — it is the threshold at which a single scenario
failure indicates a systemic problem requiring human review before the change
reaches production. Below 10%, deployment proceeds automatically. Above 10%,
the change is held until a principal engineer signs off.

The ultimate goal is not merely passing tests, but ensuring that Quorum's
constitutional guarantees, governance correctness, and API contract remain
within acceptable operational risk thresholds — for every deployment, automatically.

---

*Per-journey step detail: [docs/e2e/journeys/](e2e/journeys/)*
*Test infrastructure guide: [docs/e2e/README.md](e2e/README.md)*
*Journey index: [docs/E2E-JOURNEYS.md](E2E-JOURNEYS.md)*
