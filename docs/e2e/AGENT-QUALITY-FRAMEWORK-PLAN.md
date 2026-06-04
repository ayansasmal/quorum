# Quorum — Agent Quality Framework Evolution Plan

**Status:** Planning document
**Audience:** Solo maintainers, coding agents, CI agents, future Quorum contributors
**Purpose:** Define how to evolve Quorum's current risk-weighted E2E test plan into a generic,
extensible, agent-readable quality framework.

---

## 1. Why This Exists

Quorum is maintained by a solo engineer with coding agents acting as implementation partners.
The test framework must therefore do more than report pass/fail status. It must help agents and
humans answer:

1. Which bug should be fixed first?
2. Which product guarantee is at risk?
3. Is this a root failure or a downstream symptom?
4. What else must be rerun after the fix?
5. Did the fix actually improve product quality, or merely satisfy one test?

The current framework already combines:

- **BDD:** product journeys model real user and agent behaviours.
- **RBT:** scenarios are weighted by risk, usage frequency, criticality, and detection lag.
- **FailureCost:** failures include correlated downstream impact, not only local test impact.
- **Hard-block pillars:** governance, security, and data integrity failures block release.

The next step is to make these ideas generic, structured, and easier for agents to consume.

---

## 2. Target Outcome

Create a reusable quality protocol where Markdown is only the human-readable rendering of a
machine-readable quality graph.

The framework should be portable to any product, while Quorum supplies one concrete instance.

### Generic Framework

Defines the concepts and rules:

- Pillars
- Product guarantees
- Journeys
- Scenarios
- Assertion leaves
- Risk scoring
- Release gates
- Correlation edges
- Failure classes
- Repair playbooks
- Verification policies
- Post-fix reports

### Quorum Instance

Maps the generic framework onto Quorum:

- Quorum quality pillars
- Quorum product guarantees
- Existing J01-J22 journeys
- Existing S-* scenarios
- Scenario scores
- Correlation graph
- Hard-block release gates
- Agent fix queues

---

## 3. Proposed Files

### `docs/e2e/QUALITY-FRAMEWORK.md`

Generic explanation of the framework.

Contents:

- Philosophy: BDD + RBT + blast-radius-aware remediation.
- Core primitives.
- Scoring model.
- Gate model.
- Agent workflow.
- How to extend the framework for a new product area.

No Quorum-specific endpoints, function names, current code gaps, or fix locations.

### `docs/e2e/quality.schema.json`

Machine-readable schema for the framework.

Defines:

- `pillar`
- `guarantee`
- `journey`
- `scenario`
- `risk`
- `gate`
- `correlation`
- `failure_class`
- `repair_playbook`
- `verification_policy`
- `post_fix_report`

This becomes the contract between CI, docs, and coding agents.

### `docs/e2e/quorum-quality-map.json`

The Quorum-specific quality graph.

Contains:

- The eight Quorum pillars.
- Product guarantees.
- Journey/scenario metadata.
- OwnScore and FailureCost data.
- Correlation edges.
- Gate tiers.
- Scenario-to-test-file mappings.
- Safe root-cause hints.
- Rerun policies.

This file should avoid listing unresolved vulnerabilities in public-facing branches.

### `docs/e2e/AGENT-REMEDIATION.md`

Internal agent operating manual.

Contents:

- How to read the fix queue.
- How to distinguish root failures from symptoms.
- Pillar-specific repair playbooks.
- Required verification after a fix.
- Post-fix report format.
- Handling environment failures and flakes.

This is where implementation-specific hints belong.

### `docs/e2e/TEST-PLAN.md`

Keep this as the rendered Quorum test plan.

Eventually, generate parts of it from `quorum-quality-map.json` so scores, scenario counts, and
rankings cannot drift from the machine-readable source of truth.

---

## 4. Framework Primitives

### Pillar

A major quality dimension.

Example:

```json
{
  "id": "security",
  "name": "Security & Access Control",
  "zero_tolerance": true,
  "description": "Access boundaries, authentication lifecycle, role isolation, and escalation resistance."
}
```

### Product Guarantee

A promise the product makes to users.

Guarantees sit above tests. Scenarios validate guarantees.

Example:

```json
{
  "id": "G-SEC-001",
  "pillar": "security",
  "statement": "Unauthorized actors cannot modify governed memory.",
  "release_critical": true
}
```

### Journey

A behaviour-driven user or agent workflow.

Example:

```json
{
  "id": "J05",
  "name": "Role boundary enforcement",
  "actor": "authenticated project member",
  "goal": "Verify that project roles grant only intended capabilities."
}
```

### Scenario

A testable behaviour within a journey.

Example:

```json
{
  "id": "S-05.1",
  "journey": "J05",
  "title": "Role boundary on governed knowledge writes",
  "guarantees": ["G-SEC-001"],
  "pillar": "security",
  "failure_class": "security_boundary",
  "risk": {
    "leaf_count": 18,
    "frequency": 4,
    "criticality": 2.5,
    "detection_lag": 1.0,
    "own_score": 180
  },
  "gate": {
    "tier": "hard_block",
    "reason": "access_control"
  },
  "correlations": ["S-05.2", "S-05.3"],
  "verification": {
    "rerun": ["S-05.1", "S-05.2", "S-05.3"],
    "minimum_pass": "all"
  }
}
```

### Correlation Edge

A relationship where one root failure likely causes other scenario failures.

Example:

```json
{
  "source": "S-05.1",
  "targets": ["S-05.2", "S-05.3"],
  "type": "shared_boundary",
  "confidence": 0.8,
  "public_description": "Several role-boundary behaviours rely on the same authorization boundary."
}
```

### Failure Class

A normalized category that tells an agent how to reason about the failure.

Recommended classes:

- `governance_invariant`
- `security_boundary`
- `data_integrity`
- `contract_regression`
- `functional_regression`
- `observability_gap`
- `developer_experience`
- `environment_failure`
- `test_flake`
- `test_bug`

### Repair Playbook

Generic instructions for how an agent should approach a failure class.

Example:

```json
{
  "failure_class": "security_boundary",
  "steps": [
    "Confirm actor, project, and role context.",
    "Reproduce the smallest denied and allowed cases.",
    "Inspect the shared boundary before individual endpoint handlers.",
    "Add or update both deny-path and allow-path regression coverage.",
    "Rerun all correlated security scenarios."
  ]
}
```

### Post-Fix Report

Required structured output after an agent completes a fix.

Example:

```json
{
  "fixed_root_cause": "short description",
  "failure_class": "security_boundary",
  "scenarios_rerun": ["S-05.1", "S-05.2"],
  "correlated_scenarios_verified": true,
  "new_regression_test_added": true,
  "remaining_risk": "low",
  "notes": "short human-readable summary"
}
```

---

## 5. Agent Workflow

When CI reports failures, agents should follow this sequence:

1. Check for environment failures first.
2. Read the structured fix queue.
3. Handle hard-block failures before score-gated failures.
4. Sort by `fix_priority_score` descending.
5. Identify product guarantees affected by the top failure.
6. Read correlation edges to distinguish root cause from symptoms.
7. Apply the relevant repair playbook.
8. Fix the smallest root cause.
9. Add or update regression coverage.
10. Rerun the scenario and all correlated scenarios.
11. Emit a post-fix report.

This workflow is intentionally generic. Quorum-specific details should be supplied by the quality
map, not embedded in the workflow.

---

## 6. Public vs Internal Boundary

The framework should support both public trust documentation and internal agent execution.

### Public-Safe

Can be used on the website or public docs:

- Framework philosophy.
- Pillar names and high-level descriptions.
- Generic scoring model.
- Hard-block quality categories.
- Sanitized correlation examples.
- Agent-readable quality concept.

### Internal Only

Should remain in private/internal docs:

- Known code gaps.
- Exact fix locations.
- Current failing scenarios.
- Endpoint-level security matrices.
- Function names for sensitive shared code paths.
- Infrastructure probe mechanics.
- Raw CI fix queue with implementation hints.

---

## 7. Effort Estimate

### Phase 1 — Documentation Split

**Effort:** 0.5-1 day

Deliverables:

- Create `QUALITY-FRAMEWORK.md`.
- Create `AGENT-REMEDIATION.md`.
- Move public-safe concepts out of the current test plan.
- Move implementation-specific fix guidance into the internal remediation doc.

Risk: low.

### Phase 2 — Schema Design

**Effort:** 1-2 days

Deliverables:

- Create `quality.schema.json`.
- Define framework primitives.
- Validate a small sample of scenarios against the schema.

Risk: medium. This needs careful design so the schema stays generic and does not overfit Quorum.

### Phase 3 — Quorum Quality Map

**Effort:** 2-4 days

Deliverables:

- Encode all pillars, guarantees, journeys, scenarios, scores, gates, and correlations into
  `quorum-quality-map.json`.
- Add failure classes.
- Add verification policies.
- Add safe root-cause hints.

Risk: medium. Most of the work is structured transcription and consistency cleanup.

### Phase 4 — Reporter Integration

**Effort:** 2-3 days

Deliverables:

- Update the Playwright reporter to read from `quorum-quality-map.json`.
- Emit structured fix queue from the map.
- Include guarantees, failure classes, gates, correlations, and rerun policies in CI output.

Risk: medium-high. This touches CI/reporting, but not product runtime.

### Phase 5 — Generated Docs

**Effort:** 1-2 days

Deliverables:

- Generate tables in `TEST-PLAN.md` from the quality map.
- Prevent drift in scenario counts, OwnScore totals, and rankings.
- Add a validation command for CI.

Risk: medium.

### Phase 6 — Public Quality Page

**Effort:** 0.5-1 day

Deliverables:

- Add a sanitized `/quality` page to the website.
- Present the framework without exposing internal attack surface or known gaps.

Risk: low.

### Total

**Practical MVP:** 3-5 days

Includes documentation split, schema, and partial quality map for the highest-risk scenarios.

**Full implementation:** 7-13 days

Includes complete quality map, reporter integration, generated docs, validation, and public page.

For a solo engineer, the best sequence is:

1. Document the framework.
2. Define the schema.
3. Encode only hard-block scenarios first.
4. Wire reporter output.
5. Expand to the full suite.
6. Generate public docs last.

---

## 8. Success Criteria

The framework is successful when a fresh coding agent can:

1. Read a CI failure report.
2. Identify the highest-priority bug without human triage.
3. Understand which product guarantee is at risk.
4. Distinguish likely root causes from correlated symptoms.
5. Apply a relevant repair playbook.
6. Rerun the right verification set.
7. Produce a structured post-fix report.

For the solo maintainer, success means the framework reduces decision fatigue. The question should
move from "what should I fix?" to "do I accept the agent's proposed fix and verification?"

---

## 9. Open Design Questions

1. Should correlation confidence be static, learned from historical failures, or both?
2. Should OwnScore be manually assigned, computed, or computed with manual overrides?
3. Should known code gaps live in the quality map or in a separate private remediation file?
4. Should public docs quote exact scenario counts and scores, or only describe the model?
5. Should post-fix reports be stored as audit records, CI artifacts, or both?
6. Should the framework track flaky tests as quality debt with its own score?
7. Should the schema support non-E2E coverage such as unit, integration, manual, and adversarial tests?

---

## 10. Next Session Prompt

Use this prompt to continue implementation in a future session:

> Read `docs/e2e/AGENT-QUALITY-FRAMEWORK-PLAN.md` and `docs/e2e/TEST-PLAN.md`.
> Create the first implementation pass of the generic agent quality framework.
> Start with `QUALITY-FRAMEWORK.md`, `AGENT-REMEDIATION.md`, and `quality.schema.json`.
> Keep the current `TEST-PLAN.md` behaviour intact.
> Do not publish internal fix locations or known code gaps in public-facing docs.
> Encode only a small representative set of scenarios first: one governance, one security,
> one data-integrity, and one score-gated functional scenario.
