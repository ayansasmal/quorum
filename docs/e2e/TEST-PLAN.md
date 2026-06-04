# Quorum — Quality Assurance Framework & Risk-Weighted Test Plan

**Version:** 2.3 — June 2026
**Scope:** Quorum v0.4 · 22 journeys · 46 scenarios (10 new negative/cross-boundary sub-scenarios added 2026-06-04)
**Suite OwnScore:** 3946 pts | **10% gate:** 395 pts | **5% gate:** 197 pts
**Hard block:** any failure in Governance Integrity, Security, or Data Integrity pillar

> **MCP integration layer:** The MCP protocol path (JSON-RPC → tool handler → real gateway) has its own test plan at [`quorum-mcp/docs/MCP-TEST-PLAN.md`](../../../quorum-mcp/docs/MCP-TEST-PLAN.md) — 6 journeys (M-01–M-06), 54 leaves, OwnScore 655, same OwnScore/FailureCost model.

> **For agentic workers (CI, coding agents, deployment pipelines):**
> Read §2 (Quick Reference) first. §8 gives the agent JSON format. §7 gives the fix priority
> ranking — sort by `fix_priority_score` descending and work top to bottom.
> A HARD_BLOCK failure in any zero-tolerance pillar blocks deployment regardless of score.

---

## 1. Purpose

This document defines how every automated test scenario is scored, how failures are
prioritised for remediation, and what gates control deployment. Its goals:

1. **Prioritise fixes correctly.** A broken RBAC middleware that silently grants access to all
   roles is 57× more urgent than a broken dashboard visual. The framework makes this
   quantitative so agents do not need to reason about it.

2. **Surface propagation.** A failure in `detectConflict()` means S-02.2, S-06, and S-17 all
   fail simultaneously — the same code path, three test scenarios. FailureCost captures the
   full impact of a bug, not just the impact of the single test that detected it.

3. **Gate on quality dimension, not just score.** A single broken constitutional rule is an
   immediate block regardless of what percentage of tests it represents. A broken conformance
   chart is a warning. These are not the same risk.

4. **Be machine-readable.** §9 defines the JSON format CI agents emit and coding agents consume.

---

## 2. Quick Reference — CI Decision Rules

```
FOR EACH failing scenario:
  IF scenario.pillar IN ['governance_integrity', 'security', 'data_integrity']:
    → HARD_BLOCK  (zero-tolerance: constitutional rules, access control, data integrity)
    → deployment blocked immediately, no exceptions, no override

ELSE:
  failure_pct = Σ OwnScore(all unique failing scenarios) / 3946 × 100

  IF failure_pct > 10%  → HARD_BLOCK   (block deployment, no exceptions)
  IF failure_pct > 5%   → WARNING       (block merge; require PE manual review + approval)
  IF failure_pct ≤ 5%   → SAFE          (merge allowed)

FIX ORDER (within any failure set):
  Sort failing scenarios by fix_priority_score DESC.
  Fix the root cause — fixing a root scenario often resolves correlated failures for free.
```

---

## 3. Eight Quality Pillars

The spider chart for Quorum product quality. Every scenario is assigned one primary pillar.
Pillars with a ⛔ are zero-tolerance: any single failure triggers a hard block.

| # | Pillar | ⛔ | What it measures | Scenarios |
|---|--------|---|-----------------|-----------|
| 1 | **Governance Integrity** | ⛔ | Constitutional rules enforced; conflict detection works; authority model correct; no silent governance bypass | S-02.2, S-06, S-10, S-11, S-15, S-17 |
| 2 | **Security & Access Control** | ⛔ | JWT algorithm enforcement; RBAC boundaries; authentication lifecycle; no role escalation | S-05.1–5.6, S-19 |
| 3 | **Data Integrity** | ⛔ | Atomic state transitions; supersede atomicity; no duplicate ACTIVE; version provenance | S-02.3, S-12 |
| 4 | **Functional Correctness** | | Core knowledge lifecycle; happy paths; state visible correctly | S-02.1, S-02.4–2.7, S-03, S-04, S-08 |
| 5 | **Federation Correctness** | | Cross-catalog reads; global catalog discovery; globals validation | S-01, S-20 |
| 6 | **Operational Reliability** | | Graceful degradation; admin ops; config governance; governance routes; MCP layer contracts | S-09, S-13, S-18, S-21 |
| 7 | **Observability & Intelligence** | | Conformance scoring; portfolio; audit timeline; knowledge history | S-07, S-16 |
| 8 | **Developer & Agent Experience** | | Dashboard usability; onboarding; write/read ergonomics | S-02.8, S-14 |

**Pillar OwnScore totals** (used as denominator for per-pillar health %):

| Pillar | OwnScore total | % of suite |
|--------|---------------|-----------|
| Governance Integrity | 1315 | 33.3% |
| Security & Access Control | 1445 | 36.6% |
| Data Integrity | 178 | 4.5% |
| Functional Correctness | 475 | 12.0% |
| Federation | 130 | 3.3% |
| Operational Reliability | 176 | 4.5% |
| Observability & Intelligence | 177 | 4.5% |
| Developer & Agent Experience | 50 | 1.3% |
| **Total** | **3946** | **100%** |

---

## 4. Scoring Formula

### 4.1 Dimensions

Every scenario receives three multipliers on top of its base weight (W = leaf_count × FrequencyTier):

```
OwnScore(S)    = W × C × D
FailureCost(S) = OwnScore(S) + Σ OwnScore(S') for all S' in correlatedFailures(S)
```

| Symbol | Dimension | What it encodes |
|--------|-----------|----------------|
| **W** | Base weight | `leaf_count × FrequencyTier` — how much is asserted × how often |
| **C** | Criticality | Which quality pillar is at risk and how severe a breach is |
| **D** | Detection lag | How long before this failure is noticed in production |

### 4.2 FrequencyTier (F)

How often this code path runs in production:

| Tier | F | Code paths |
|------|---|-----------|
| F4 — Core agent workflow | 4 | `remember`, `recall`, `search`, conflict detection — every agent write/read |
| F3 — Daily governance / security | 3 | RBAC, `pending`/`review`, self-approval, auth — every governance action |
| F2 — Weekly operational | 2 | `deviate`, `conformance`, `deprecation`, `bump`, state machine |
| F1.5 — Periodic | 1.5 | Audit chain verification, dashboard visual, knowledge history |
| F1 — One-time / rare | 1 | Onboarding, admin ops, config governance |

### 4.3 Criticality (C)

Which quality pillar governs this scenario and how catastrophic is a failure:

| C | Pillar | Rationale |
|---|--------|-----------|
| **3.0** | Governance Integrity (constitutional rules) | A constitutional bypass is irreversible without manual audit intervention. The five constitutional rules are non-negotiable invariants; a bypass produces silent data corruption. |
| **2.5** | Security, Governance (other) | An RBAC bypass or broken conflict detection allows unauthorized access or silently contradictory knowledge. Consequences compound over time. |
| **2.0** | Data Integrity | A broken atomic transition or incorrect status can result in duplicate ACTIVE versions — a silent data corruption caught only on the next governance action. |
| **1.5** | Functional Correctness, Operational | A broken feature is visible, recoverable by redeploy, and causes no permanent data change. |
| **1.0** | Observability, Developer Experience, Federation | Degraded visibility or UX; governance still works; teams notice quickly. |

### 4.4 Detection Lag (D)

How long before the failure is discovered without the test catching it:

| D | Lag | Description |
|---|-----|-------------|
| **2.0** | Silent / ambient | Failure goes undetected for days or weeks. The system appears healthy. Examples: conflict detection broken (writes succeed but contradictions accumulate), audit hash gap (chain corrupted but no surface-level symptom), placeholder reason accepted (audit log looks valid until human review). |
| **1.5** | Deferred | Caught the next time a governance action is performed: wrong error code on a rare admin endpoint, broken deprecation approval, stale overdue deferral. |
| **1.0** | Immediate | Visible on the failing HTTP request: wrong HTTP status, missing required field, 500 on a core write. |

---

## 5. Dependency Graph — Code-Path Correlations

A scenario `S'` is in `correlatedFailures(S)` if **the same code path failure that causes S to
fail would also cause S' to fail**. This is not a test-state dependency (all scenarios are
state-isolated via `uid()` keys) — it is a code-level correlation.

When `S` fails in CI, the agent should assume all correlated scenarios are also failing and
compute FailureCost accordingly. Fixing the root cause resolves all correlated failures.

```
S-05.1 (RBAC middleware)
  correlates → S-05.2, S-05.3, S-05.4, S-05.5, S-05.6, S-05.7, S-05.8
  Reason: All RBAC sub-scenarios exercise the same verify-jwt + role-check code path.
          A bug in permission checking typically breaks the whole RBAC boundary, not one sub-scenario.
          S-05.7 (cross-project role isolation) and S-05.8 (concurrent RBAC) both depend on the
          same DDB/Redis role-resolution path — a broken role-check breaks them identically.
          S-05.9 (cache invalidation) is excluded: it tests POST /config/update-role flush
          which is a separate code path from the read-time role check.

S-15 (enforceReasonRequired)
  correlates → S-03, S-04, S-09, S-13
  Reason: enforceReasonRequired() is called on all governance endpoints that require reasons.
          A bug (e.g. minimum length check wrong, or function bypassed) silently allows
          placeholder reasons on every endpoint: deprecation, deviation action, admin users,
          config transfer. All four scenarios include a reason-validation assertion.

S-02.2 (detectConflict)
  correlates → S-06, S-17
  Reason: detectConflict() is the shared function called on every knowledge write.
          If the semantic search or threshold logic is broken, S-06 (multi-user conflict
          detection between concurrent writers) and S-17 Part C (cross-catalog conflict
          detection spanning globals) both fail to detect what they should detect.

S-10 (audit chain writes)
  correlates → S-02.1, S-02.2, S-02.3
  Reason: Every knowledge write (remember/review/supersede) writes two audit entries
          (INTENT + OUTCOME). If audit/secondary.js writes fail or chain_position
          allocation breaks, every write scenario that asserts the audit output fails.
          S-02.1 (write+recall), S-02.2 (conflict, which writes on resolution), S-02.3
          (supersede, which writes the SUPERSEDED transition) all assert audit properties.

S-04 (POST /api/deviations write path)
  correlates → S-07
  Reason: S-07 (conformance scoring) computes a score from existing deviation records.
          If the deviation write path is broken, S-07's conformance score has no input
          data — UNCERTIFIED or wrong score returned.

S-21 (POST /config/validate shared schema code path)
  correlates → S-01
  Reason: S-21.4 calls POST /config/validate and asserts the `owner` field is required.
          S-01 (global catalog onboarding) calls POST /config/upload which internally uses
          the same Zod schema. A regression in the config schema validation path breaks both.
```

---

## 6. Scenario Scoring Table

All 36 scenarios. W = leaf_count × F. OwnScore = W × C × D. FailureCost = OwnScore + correlated.
Gate tier: ⛔ = zero-tolerance hard block | 🟡 = score-gated.

| Scenario | Journey | leaf | F | W | Pillar | C | D | **OwnScore** | Correlated failures | **FailureCost** | Gate |
|----------|---------|------|---|---|--------|---|---|-------------|---------------------|-----------------|------|
| S-01 | J01 | 15 | 1 | 15 | Federation | 1.5 | 1.5 | **34** | — | **34** | 🟡 |
| S-02.1 | J02 | 8 | 4 | 32 | Functional | 1.5 | 1.0 | **48** | — | **48** | 🟡 |
| S-02.2 | J02 | 6 | 4 | 24 | Governance ⛔ | 2.5 | 2.0 | **120** | S-06, S-17 | **415** | ⛔ |
| S-02.3 | J02 | 5 | 4 | 20 | Data Integrity ⛔ | 2.0 | 1.0 | **40** | — | **40** | ⛔ |
| S-02.4 | J02 | 4 | 4 | 16 | Functional | 1.5 | 1.0 | **24** | — | **24** | 🟡 |
| S-02.5 | J02 | 4 | 4 | 16 | Functional | 1.5 | 1.0 | **24** | — | **24** | 🟡 |
| S-02.6 | J02 | 5 | 4 | 20 | Functional | 1.5 | 1.0 | **30** | — | **30** | 🟡 |
| S-02.7 | J02 | 4 | 4 | 16 | Functional | 1.5 | 1.0 | **24** | — | **24** | 🟡 |
| S-02.8 | J02 | 5 | 4 | 20 | Dev Experience | 1.0 | 1.0 | **20** | — | **20** | 🟡 |
| S-03 | J03 | 20 | 2 | 40 | Functional | 1.5 | 1.5 | **90** | — | **90** | 🟡 |
| S-04 | J04 | 37 | 2 | 74 | Functional | 1.5 | 1.5 | **167** | S-07 | **242** | 🟡 |
| S-05.1 | J05 | 18 | 4 | 72 | Security ⛔ | 2.5 | 1.0 | **180** | S-05.2–5.8 | **970** | ⛔ |
| S-05.2 | J05 | 12 | 4 | 48 | Security ⛔ | 2.5 | 1.0 | **120** | — | **120** | ⛔ |
| S-05.3 | J05 | 12 | 4 | 48 | Security ⛔ | 2.5 | 1.0 | **120** | — | **120** | ⛔ |
| S-05.4 | J05 | 15 | 4 | 60 | Security ⛔ | 2.5 | 1.0 | **150** | — | **150** | ⛔ |
| S-05.5 | J05 | 15 | 4 | 60 | Security ⛔ | 2.5 | 1.0 | **150** | — | **150** | ⛔ |
| S-05.6 | J05 | 15 | 3 | 45 | Security ⛔ | 2.0 | 1.0 | **90** | — | **90** | ⛔ |
| S-05.7 | J05 | 5 | 4 | 20 | Security ⛔ | 2.5 | 2.0 | **100** | — | **100** | ⛔ |
| S-05.8 | J05 | 3 | 4 | 12 | Security ⛔ | 2.5 | 2.0 | **60** | — | **60** | ⛔ |
| S-05.9 | J05 | 5 | 3 | 15 | Security ⛔ | 2.5 | 2.0 | **75** | — | **75** | ⛔ |
| S-06 | J06 | 15 | 3 | 45 | Governance ⛔ | 2.0 | 1.5 | **135** | — | **135** | ⛔ |
| S-07 | J07 | 25 | 2 | 50 | Observability | 1.0 | 1.5 | **75** | — | **75** | 🟡 |
| S-08 | J08 | 15 | 2 | 30 | Functional | 1.5 | 1.5 | **68** | — | **68** | 🟡 |
| S-09 | J09 | 14 | 1 | 14 | Operational | 1.0 | 1.0 | **14** | — | **14** | 🟡 |
| S-10 | J10 | 20 | 1.5 | 30 | Governance ⛔ | 3.0 | 2.0 | **180** | S-02.1, S-02.2, S-02.3 | **388** | ⛔ |
| S-11 | J11 | 16 | 4 | 64 | Governance ⛔ | 3.0 | 1.5 | **288** | — | **288** | ⛔ |
| S-12 | J12 | 23 | 2 | 46 | Data Integrity ⛔ | 2.0 | 1.5 | **138** | — | **138** | ⛔ |
| S-13 | J13 | 20 | 1 | 20 | Operational | 1.5 | 1.5 | **45** | — | **45** | 🟡 |
| S-14 | J14 | 20 | 1.5 | 30 | Dev Experience | 1.0 | 1.0 | **30** | — | **30** | 🟡 |
| S-15 | J15 | 21 | 3 | 63 | Governance ⛔ | 3.0 | 2.0 | **378** | S-03, S-04, S-09, S-13 | **694** | ⛔ |
| S-16 | J16 | 12 | 1.5 | 18 | Observability | 1.0 | 1.5 | **27** | — | **27** | 🟡 |
| S-17 | J17 | 16 | 2 | 32 | Governance ⛔ | 2.5 | 2.0 | **160** | — | **160** | ⛔ |
| S-18 | J18 | 12 | 1.5 | 18 | Operational | 1.0 | 1.5 | **27** | — | **27** | 🟡 |
| S-19 | J19 | 15 | 3 | 45 | Security ⛔ | 2.5 | 1.0 | **113** | — | **113** | ⛔ |
| S-20 | J20 | 16 | 4 | 64 | Federation | 1.0 | 1.5 | **96** | — | **96** | 🟡 |
| S-21 | J21 | 20 | 3 | 60 | Operational | 1.5 | 1.0 | **90** | S-01 | **124** | 🟡 |
| S-22 | J22 | 25 | 2 | 50 | Observability | 1.0 | 1.5 | **75** | S-07 | **150** | 🟡 |
| S-02.13 | J02 | 5 | 3 | 15 | Security ⛔ | 2.5 | 2.0 | **75** | S-06.7, S-12.8 | **175** | ⛔ |
| S-03.6 | J03 | 5 | 2 | 10 | Security ⛔ | 2.5 | 1.5 | **38** | — | **38** | ⛔ |
| S-04.10 | J04 | 4 | 2 | 8 | Security ⛔ | 2.0 | 1.5 | **24** | — | **24** | ⛔ |
| S-06.7 | J06 | 4 | 3 | 12 | Security ⛔ | 2.5 | 2.0 | **60** | — | **60** | ⛔ |
| S-08.7 | J08 | 4 | 2 | 8 | Security ⛔ | 1.5 | 1.5 | **18** | — | **18** | ⛔ |
| S-09.9 | J09 | 4 | 1 | 4 | Security ⛔ | 2.5 | 2.0 | **20** | — | **20** | ⛔ |
| S-11.5 | J11 | 4 | 3 | 12 | Governance ⛔ | 2.0 | 1.5 | **36** | — | **36** | ⛔ |
| S-12.8 | J12 | 4 | 2 | 8 | Security ⛔ | 2.5 | 2.0 | **40** | — | **40** | ⛔ |
| S-17.6 | J17 | 3 | 2 | 6 | Governance ⛔ | 2.0 | 1.5 | **18** | — | **18** | ⛔ |
| S-22.9 | J22 | 4 | 1 | 4 | Security ⛔ | 2.0 | 1.5 | **12** | — | **12** | ⛔ |
| **Total** | | | | **1439** | | | | **3946** | | | |

> **W column sum = 1439** (+87 from 10 new negative/cross-boundary sub-scenarios added 2026-06-04).
> **OwnScore total = 3946.** New scenarios are all ⛔ — wrong-order transitions and cross-project isolation failures are governance or security hard-blocks.

---

## 7. Fix Priority Ranking

Sorted by FailureCost descending. This is the order coding agents and CI pipelines should
address failures. When the root cause is fixed, verify that all correlated scenarios also recover
before marking the issue resolved.

| Rank | Scenario | FailureCost | Gate | Primary pillar | Root for |
|------|----------|------------|------|----------------|---------|
| 1 | **S-05.1** RBAC Knowledge Create | **970** | ⛔ | Security | S-05.2–5.8 |
| 2 | **S-15** Reason / Placeholder Rejection | **694** | ⛔ | Governance | S-03, S-04, S-09, S-13 |
| 3 | **S-02.2** Conflict Detection | **415** | ⛔ | Governance | S-06, S-17 |
| 4 | **S-10** Audit Chain Integrity | **388** | ⛔ | Governance | S-02.1, S-02.2, S-02.3 |
| 5 | **S-04** Deviation Governance | **242** | 🟡 | Functional | S-07 |
| 6 | **S-11** Self-Approval Prevention | **288** | ⛔ | Governance | — |
| 7 | **S-17** Conflict Edge Cases | **160** | ⛔ | Governance | — |
| 8 | **S-05.4** RBAC Governance + Global Write | **150** | ⛔ | Security | — |
| 9 | **S-05.5** RBAC Deviation Action + Forget | **150** | ⛔ | Security | — |
| 10 | **S-12** State Machine | **138** | ⛔ | Data Integrity | — |
| 11 | **S-06** Multi-User Conflict | **135** | ⛔ | Governance | — |
| 12 | **S-02.13** Wrong-Order Review + Cross-Project Isolation | **175** | ⛔ | Security | S-06.7, S-12.8 |
| 13 | **S-21** MCP Layer Gateway Contracts | **124** | 🟡 | Operational | — |
| 14 | **S-05.2** RBAC Promote + Supersede | **120** | ⛔ | Security | — |
| 15 | **S-05.3** RBAC Deprecate | **120** | ⛔ | Security | — |
| 16 | **S-19** Authentication Lifecycle | **113** | ⛔ | Security | — |
| 17 | **S-05.7** RBAC Cross-Project Role Context | **100** | ⛔ | Security | — |
| 18 | **S-20** Cross-Catalog Search | **96** | 🟡 | Federation | — |
| 19 | **S-05.6** RBAC Portfolio + Admin | **90** | ⛔ | Security | — |
| 20 | **S-03** Deprecation Workflow | **90** | 🟡 | Functional | — |
| 21 | **S-07** Conformance Scoring & Portfolio | **75** | 🟡 | Observability | — |
| 22 | **S-05.9** Role Update + Cache Invalidation | **75** | ⛔ | Security | — |
| 23 | **S-08** Confidence Endorsement | **68** | 🟡 | Functional | — |
| 24 | **S-06.7** Cross-Project Conflict Review Isolation | **60** | ⛔ | Security | — |
| 25 | **S-05.8** RBAC Concurrent Race | **60** | ⛔ | Security | — |
| 26 | **S-02.1** Write + Recall | **48** | 🟡 | Functional | — |
| 27 | **S-13** Config Management | **45** | 🟡 | Operational | — |
| 28 | **S-12.8** Promote PCC + Cross-Project DRAFT | **40** | ⛔ | Security | — |
| 29 | **S-02.3** Supersede Path | **40** | ⛔ | Data Integrity | — |
| 30 | **S-11.5** Re-Reviewing Resolved Conflict | **36** | ⛔ | Governance | — |
| 31 | **S-01** Global Catalog Onboarding | **34** | 🟡 | Federation | — |
| 32 | **S-02.6** Coexist-Split | **30** | 🟡 | Functional | — |
| 33 | **S-14** Dashboard Visual | **30** | 🟡 | Dev Experience | — |
| 34 | **S-16** Knowledge History | **27** | 🟡 | Observability | — |
| 35 | **S-18** Governance Route | **27** | 🟡 | Operational | — |
| 36 | **S-02.4** Reject Path | **24** | 🟡 | Functional | — |
| 37 | **S-02.5** Escalation Path | **24** | 🟡 | Functional | — |
| 38 | **S-02.7** Coexist-Merge | **24** | 🟡 | Functional | — |
| 39 | **S-04.10** Re-Action Accepted Deviation | **24** | ⛔ | Security | — |
| 40 | **S-09.9** Role Update Edge Cases | **20** | ⛔ | Security | — |
| 41 | **S-02.8** Dashboard UI | **20** | 🟡 | Dev Experience | — |
| 42 | **S-08.7** Wrong-Order Bump Attempts | **18** | ⛔ | Security | — |
| 43 | **S-17.6** Enriching Resolved Conflicts | **18** | ⛔ | Governance | — |
| 44 | **S-03.6** Wrong-Order Deprecation | **38** | ⛔ | Security | — |
| 45 | **S-09** Platform Admin | **14** | 🟡 | Operational | — |
| 46 | **S-22.9** Archived Project Portfolio Isolation | **12** | ⛔ | Security | — |

> Ranks in the ⛔ column are hard-blocked by pillar membership (Security / Governance / Data Integrity),
> not by FailureCost. S-04, S-21, S-20, and S-03 are score-gated despite meaningful FailureCost
> because their primary pillar is not zero-tolerance. New scenarios (ranks 12, 24, 28, 30, 39–46)
> are all ⛔ — cross-project isolation and wrong-order transition failures are governance or security hard-blocks.

---

## 8. Gate Rules

### 8.1 Zero-tolerance gate (⛔ pillars)

```
IF any failing scenario has pillar IN ['governance_integrity', 'security', 'data_integrity']:
  deployment = BLOCKED
  override = NOT_PERMITTED
  reason = "Constitutional rule, access control, or data integrity failure"
```

A single failure in these pillars is an immediate block with no score override. The concern is
not the percentage of tests that failed — it is the category of what is broken.

### 8.2 Score-gated (🟡 pillars)

```
failure_pct = Σ OwnScore(unique failing scenarios in 🟡 pillars) / 3946 × 100

failure_pct ≤ 5.0%  → SAFE     (auto-merge allowed)
5.0% < failure_pct ≤ 10.0%  → WARNING   (block merge; require PE manual review + sign-off)
failure_pct > 10.0%  → BLOCKED  (no deployment; equivalent to hard block)
```

Deduplication rule: if S-04 and S-07 both fail (S-07 is correlated from S-04), count each
scenario's OwnScore once — do not double-count S-07's OwnScore as part of S-04's contribution.
The FailureCost is for prioritisation; the gate uses actual unique OwnScores of failing scenarios.

### 8.3 Per-pillar health percentage

```
PillarHealth(pillar) = Σ OwnScore(passing scenarios in pillar)
                     / Σ OwnScore(all scenarios in pillar) × 100
```

This is the spider chart value. A pillar at 100% means all its scenarios pass. A pillar at 0%
means all its scenarios fail. The spider chart shape tells you WHERE quality is weak even when
no deployment is being blocked (useful for continuous quality tracking between releases).

Example: if S-15 fails alone, Governance Integrity drops to `(1315 − 378) / 1315 = 71%`.
The agent knows to look at enforcement of Constitutional Rule 3 across all governance endpoints.

---

## 9. Agent Integration

### 9.1 CI output format

Every CI run emits a JSON report. Coding agents and deployment pipelines consume this:

```json
{
  "suite_version": "2.0",
  "timestamp": "2026-05-23T12:00:00Z",
  "total_own_score": 3187,
  "gate_threshold_pct": 10,
  "deployment_status": "BLOCKED",
  "block_reason": "Zero-tolerance pillar failure: governance_integrity",

  "pillar_health": {
    "governance_integrity": 67,
    "security": 100,
    "data_integrity": 100,
    "functional_correctness": 95,
    "federation": 100,
    "operational_reliability": 100,
    "observability": 100,
    "developer_experience": 100
  },

  "score_gate": {
    "failing_own_score": 0,
    "failure_pct": 0.0,
    "status": "SAFE"
  },

  "fix_queue": [
    {
      "rank": 1,
      "scenario_id": "S-15",
      "name": "Reason / Placeholder Rejection",
      "journey": "J15",
      "own_score": 378,
      "fix_priority_score": 694,
      "gate": "HARD_BLOCK",
      "pillar": "governance_integrity",
      "pillar_is_zero_tolerance": true,
      "block_reason": "Constitutional Rule 3 (reason ≥ 10 chars) can be bypassed",
      "detection_lag": "silent",
      "correlated_failures": ["S-03", "S-04", "S-09", "S-13"],
      "correlated_own_score": 316,
      "shared_code_path": "enforceReasonRequired() in constitutional.js",
      "spec_file": "tests/e2e/scenarios/15-reason-placeholder.spec.js",
      "journey_file": "docs/e2e/journeys/J15-reason-placeholder.md"
    }
  ],

  "known_code_gaps": [
    {
      "gap_id": "G-2",
      "description": "ConstitutionalViolation missing .status — server.js returns 500 instead of 400 + rule field",
      "fix": "Add ConstitutionalViolation handler to global error handler in gateway/src/server.js",
      "affects": ["S-15", "S-03", "S-04", "S-09", "S-13"]
    },
    {
      "gap_id": "G-7",
      "description": "routes/config.js and routes/admin.js use manual reason check returning error:'missing_param' not rule:'REASON_REQUIRED'",
      "fix": "Replace manual check with enforceReasonRequired() call in transfer-ownership, update-role, POST /admin/users",
      "affects": ["S-13", "S-09", "S-15"]
    },
    {
      "gap_id": "G-6",
      "description": "Bulk deprecate catch block returns error:'reason_required' not rule:'REASON_REQUIRED'",
      "fix": "Update catch block in POST /api/knowledge/deprecate/bulk route handler",
      "affects": ["S-15"]
    }
  ]
}
```

### 9.2 Fix prioritisation algorithm (for coding agents)

```
1. Read fix_queue sorted by fix_priority_score DESC (already sorted in output).
2. For each item where gate == "HARD_BLOCK":
   a. Read shared_code_path — this is the function or module to look at.
   b. Read correlated_failures — expect these to also fail. Do not open separate tickets.
   c. Read journey_file for the precise assertions that must pass.
   d. Fix the root cause in shared_code_path.
   e. Run the full scenario + all correlated scenarios to verify resolution.
3. After all HARD_BLOCK items resolved, re-run suite and check score_gate.
4. Repeat for remaining items in fix_queue until suite_status = SAFE.
```

### 9.3 Spider chart reading guide

The spider chart has 8 axes, each 0–100%. The shape tells you what to investigate:

- **Governance axis low** → constitutional rule broken or conflict detection degraded. Check G-2/G-6/G-7 code gaps first.
- **Security axis low** → RBAC middleware, JWT parsing, or role-check logic. Single failure blocks all 7 Security scenarios.
- **Data Integrity axis low** → atomic transition broken, status machine wrong. Check PostgreSQL transaction boundaries.
- **Functional axis low** → happy-path routes broken. Start with the highest-FailureCost scenario; fix often cascades.
- **All axes high, one dipping** → targeted regression in a specific feature; trace the shared code path from the dependency graph.
- **Multiple axes simultaneously low** → infrastructure problem (T0). Check Docker health, JWT round-trip, config probe before debugging application code.

### 9.4 Implementation — graph reporter and viewer

The JSON output described in §9.1 is produced by the Playwright custom reporter at
`tests/e2e/reporter/graph-reporter.js`. The static node/edge schema (OwnScore, FailureCost,
pillar membership, correlation edges) lives in `tests/e2e/reporter/graph-schema.js`. The reporter
reads that schema at test-run time and overlays live pass/fail/skip status from `onTestEnd`.

**Spec file naming convention (required for reporter to map test results to graph nodes):**

Every spec file must wrap each scenario in a `describe` block whose title begins with the scenario
ID (`S-XX` or `S-XX.Y`). The reporter extracts the ID via `/^S-\d+(?:\.\d+)?/` from the full
title path — any test not inside a matching `describe` block is ignored by the reporter.

```js
// ✅ Correct
describe('S-05.1 — RBAC Knowledge Create', () => {
  test('engineer cannot POST /api/knowledge', ...)
})

// ❌ Wrong — no scenario ID; test counted but not mapped to graph node
describe('RBAC Knowledge Create', () => { ... })
```

**Viewing results:** after a run, `test-results/suite-graph.json` is emitted. The static DAG
viewer at `tests/e2e/viewer/index.html` consumes this file. It renders pillar compound nodes,
scenario nodes sized by `sqrt(ownScore)`, colour-coded by status, and an interactive fix-queue
panel. Serve with `npx serve tests/e2e/viewer` (auto-fetches the JSON) or open the HTML file
directly and use the file picker.

---

## 10. T0 Infrastructure Probes

T0 probes are prerequisites outside the scoring budget. A T0 failure blocks ALL scenarios
without incrementing the failure percentage — it means the stack is not up, not that the
application has a bug.

| Probe | What it checks | Failure action |
|-------|---------------|----------------|
| T0.1 Docker stack health | PostgreSQL · FalkorDB · Redis · LocalStack · Graphiti · Gateway all healthy | Stop suite; restart stack (3× retries, 120s timeout) |
| T0.2 JWT round-trip | Sign with test P-256 key → `GET /api/knowledge` → 200 | Stop suite; check QUORUM_JWT_PUBLIC_KEY matches test keypair |
| T0.3 Config probe | `GET /api/globals` + `GET /user/profile/test-pe` both return 200 | Stop suite; run `node tests/e2e/helpers/setup.js` to re-upload configs |

If T0 fails, fix infrastructure before treating any application scenario failure as real.
T0 failures will superficially look like every scenario failing — the fix_queue will be full
of HARD_BLOCK items that resolve the moment T0 passes.

---

## 11. Suite Dependency Graph (reference)

Updated structure showing all 21 journeys, 33 scenarios, with OwnScore and FailureCost.
The indented tree format below is a rendering aid — the actual structure is a DAG. Several nodes
have multiple incoming edges (e.g. S-06 is downstream of both S-02.2 and S-15; S-04 appears in
Functional Correctness but is also the root for S-07 in Observability). See §5 for the full
code-path correlation edge list. The machine-readable DAG is in `tests/e2e/reporter/graph-schema.js`.

```
QUORUM TEST SUITE (OwnScore = 3187)
  10% gate = 319 pts  |  5% gate = 159 pts
  Hard block: any ⛔ scenario failure
│
├── T0  Infrastructure Probes ─────────────── OUTSIDE BUDGET (stop on failure)
│      T0.1  Docker stack health
│      T0.2  JWT round-trip (test P-256 key)
│      T0.3  Config probe (globals + user profile)
│
├── GOVERNANCE INTEGRITY ⛔ ──────────────── OwnScore = 1153  (38.4%)
│   │
│   ├── S-02.2  Conflict Detection ───────── Own=120  FC=415  F4/C2.5/D2.0
│   │           detectConflict() · semantic threshold · LLM enrichment shape
│   │           Correlates → S-06, S-17
│   │
│   ├── S-06  Multi-User Conflict ──────────  Own=135  FC=135  F3/C2.0/D1.5
│   │         concurrent writes · more_pending_same_key · stale_warning
│   │
│   ├── S-10  Audit Chain Integrity ─────── Own=180  FC=388  F1.5/C3.0/D2.0  ← C3.0
│   │         INTENT+OUTCOME pairs · hash chain · BLOCKED_METHODS · append-only
│   │         Correlates → S-02.1, S-02.2, S-02.3
│   │
│   ├── S-11  Self-Approval Prevention ──── Own=180  FC=180  F4/C3.0/D1.5   ← C3.0
│   │         Constitutional Rule 4 · review/promote/supersede/deprecate
│   │
│   ├── S-15  Reason / Placeholder ─────── Own=378  FC=694  F3/C3.0/D2.0   ← SUITE MAX
│   │         Constitutional Rule 3 · 10 endpoints · placeholder detection
│   │         Correlates → S-03, S-04, S-09, S-13
│   │
│   └── S-17  Conflict Edge Cases ──────── Own=160  FC=160  F2/C2.5/D2.0
│             auto_supersede · PENDING_CONFLICT_CHECK · cross-catalog conflict
│             enrichment shape (analysis / risks / questions)
│
├── SECURITY ⛔ ──────────────────────────── OwnScore = 923  (30.7%)
│   │
│   ├── S-05.1  RBAC Knowledge Create ──── Own=180  FC=810  F4/C2.5/D1.0   ← FC MAX
│   │           18 roles × create op · deny assertions
│   │           Correlates → S-05.2, S-05.3, S-05.4, S-05.5, S-05.6
│   │
│   ├── S-05.2  RBAC Promote + Supersede ─  Own=120  FC=120  F4/C2.5/D1.0
│   ├── S-05.3  RBAC Deprecate ──────────── Own=120  FC=120  F4/C2.5/D1.0
│   ├── S-05.4  RBAC Governance + Global ── Own=150  FC=150  F4/C2.5/D1.0
│   ├── S-05.5  RBAC Deviation Action ───── Own=150  FC=150  F4/C2.5/D1.0
│   ├── S-05.6  RBAC Portfolio + Admin ──── Own=90   FC=90   F3/C2.0/D1.0
│   └── S-19  Authentication Lifecycle ──── Own=113  FC=113  F3/C2.5/D1.0
│             JWT boundaries · JWKS EC/ES256 · project scoping · PAT
│
├── DATA INTEGRITY ⛔ ────────────────────── OwnScore = 178   (5.9%)
│   │
│   ├── S-02.3  Supersede Path ──────────── Own=40   FC=40   F4/C2.0/D1.0
│   │           ACTIVE→SUPERSEDED atomicity · no window of zero ACTIVE
│   │
│   └── S-12  State Machine ─────────────── Own=138  FC=138  F2/C2.0/D1.5
│             all valid/invalid transitions · coexistence · /api/drafts
│
├── FUNCTIONAL CORRECTNESS ───────────────── OwnScore = 475  (15.8%)
│   │
│   ├── S-02.1  Write + Recall ────────────  Own=48   FC=48   F4/C1.5/D1.0
│   ├── S-02.4  Reject Path ─────────────── Own=24   FC=24   F4/C1.5/D1.0
│   ├── S-02.5  Escalation Path ────────── Own=24   FC=24   F4/C1.5/D1.0
│   ├── S-02.6  Coexist-Split ────────────  Own=30   FC=30   F4/C1.5/D1.0
│   ├── S-02.7  Coexist-Merge ───────────── Own=24   FC=24   F4/C1.5/D1.0
│   ├── S-03  Deprecation Workflow ──────── Own=90   FC=90   F2/C1.5/D1.5
│   ├── S-04  Deviation Governance ──────── Own=167  FC=242  F2/C1.5/D1.5
│   │         Correlates → S-07
│   └── S-08  Confidence Endorsement ────── Own=68   FC=68   F2/C1.5/D1.5
│
├── FEDERATION CORRECTNESS ───────────────── OwnScore = 130  (4.1%)
│   ├── S-01  Global Catalog Onboarding ─── Own=34   FC=34   F1/C1.5/D1.5
│   └── S-20  Cross-Catalog Search ──────── Own=96   FC=96   F4/C1.0/D1.5
│             query validation · result field shape · cross-catalog scope · DRAFT exclusion
│             domain filter · mixed sources · scope isolation
│
├── OPERATIONAL RELIABILITY ─────────────── OwnScore = 176  (5.5%)
│   ├── S-09  Platform Admin ────────────── Own=14   FC=14   F1/C1.0/D1.0
│   ├── S-13  Config Management ──────────  Own=45   FC=45   F1/C1.5/D1.5
│   ├── S-18  Governance Route ───────────  Own=27   FC=27   F1.5/C1.0/D1.5
│   └── S-21  MCP Layer Gateway Contracts ─ Own=90   FC=124  F3/C1.5/D1.0
│             pending() topic filter · Requirement entity round-trip · constraints acceptance
│             config owner field · status authority (server-side derivation)
│             Correlates → S-01
│
├── OBSERVABILITY ───────────────────────── OwnScore = 102  (3.4%)
│   ├── S-07  Conformance & Portfolio ───── Own=75   FC=75   F2/C1.0/D1.5
│   └── S-16  Knowledge History ──────────  Own=27   FC=27   F1.5/C1.0/D1.5
│
└── DEVELOPER EXPERIENCE ────────────────── OwnScore = 50   (1.7%)
    ├── S-02.8  Dashboard UI ────────────── Own=20   FC=20   F4/C1.0/D1.0
    └── S-14  Dashboard Visual ───────────  Own=30   FC=30   F1.5/C1.0/D1.0
```

---

## 12. Known Code Gaps

These implementation gaps cause specific scenarios to fail until the underlying code is fixed.
Documented here so agents can identify the fix target before running tests.

| Gap | Severity | Affected scenarios | Fix location | Fix |
|-----|----------|-------------------|--------------|-----|
| **G-2** ConstitutionalViolation has no `.status` — global error handler returns `500 { error: 'internal_error' }` instead of `400 { rule: '...' }` | HIGH | S-15 (rule field assertion), S-13, S-09 | `gateway/src/server.js` error handler | Add `if (err.name === 'ConstitutionalViolation') return res.status(400).json({ rule: err.rule, message: err.message })` |
| **G-7** `routes/config.js` + `routes/admin.js` use manual length check returning `{ error: 'missing_param' }` | HIGH | S-13 Part F, S-09 Step 5, S-15 Steps 9–10 | `routes/config.js` transfer-ownership + update-role; `routes/admin.js` POST /admin/users | Replace manual check with `enforceReasonRequired(reason)` |
| **G-6** Bulk deprecate catch block returns `{ error: 'reason_required' }` not `{ rule: 'REASON_REQUIRED' }` | MEDIUM | S-15 Step 8 | `routes/dashboard.js` POST /api/knowledge/deprecate/bulk catch block | Return `{ rule: 'REASON_REQUIRED' }` consistent with all other governance endpoints |

**Fix order: G-2 first** (unblocks the broadest assertion set across S-15/S-13/S-09), then G-7, then G-6.

---

*Journey files: [docs/e2e/journeys/](e2e/journeys/)*
*Test helpers: [docs/e2e/e2e-test-helpers.md](e2e/e2e-test-helpers.md)*
*Product diagrams: [docs/e2e/PRODUCT-DIAGRAMS.md](e2e/PRODUCT-DIAGRAMS.md)*
*Suite index: [docs/e2e/README.md](e2e/README.md)*

---

## Gap Analysis Companion

[GAP-ANALYSIS.md](GAP-ANALYSIS.md) is the companion document to this test plan. Where
TEST-PLAN.md answers *"how do we score and prioritise failures in existing tests?"*,
GAP-ANALYSIS.md answers *"what known gaps exist in coverage and what exactly needs to change?"*

**Relationship to this document:**

| TEST-PLAN.md | GAP-ANALYSIS.md |
|--------------|-----------------|
| Scores 33 existing scenarios by FailureCost | Catalogues 38 coverage gaps |
| Gates CI deployment | Guides new test + feature work |
| Fix priority for broken tests | Implementation guide for missing tests |
| OwnScore model | P0–P6 risk tiers |

**Priority bridge:** GAP-ANALYSIS P0 gaps map to TEST-PLAN `HARD_BLOCK` pillars.
GAP-001 (hash chain tamper detection) belongs in the `data_integrity` zero-tolerance
pillar — once the unit test is written, a regression there becomes a hard deployment block.
