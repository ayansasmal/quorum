# Quorum — E2E Test Suite

Each journey is its own file. Read the journey before implementing its spec file.

---

## Journey Index

| Journey | Scenario(s) | Weight | Blast Radius | File |
|---------|-------------|--------|--------------|------|
| J01 — Global Catalog Onboarding | S-01 | 15 | 1.6% | [J01](journeys/J01-global-catalog-onboarding.md) |
| J02 — Knowledge Governance Lifecycle | S-02.1 – S-02.8 | 164 total | ≤ 3.9% each | [J02](journeys/J02-knowledge-governance.md) |
| J03 — Deprecation Workflow | S-03 | 40 | 4.3% | [J03](journeys/J03-deprecation-workflow.md) |
| J04 — Deviation Governance Lifecycle | S-04 | 70 | 7.5% | [J04](journeys/J04-deviation-governance.md) |
| J05 — RBAC Boundary Simulation | S-05.1 – S-05.6 | 333 total | ≤ 7.7% each | [J05](journeys/J05-rbac-boundary.md) |
| J06 — Multi-User Conflict Resolution | S-06 | 45 | 4.8% | [J06](journeys/J06-multi-user-conflict.md) |
| J07 — Conformance Scoring & Portfolio | S-07 | 50 | 5.4% | [J07](journeys/J07-conformance-portfolio.md) |
| J08 — Confidence Endorsement (Bump) | S-08 | 30 | 3.2% | [J08](journeys/J08-confidence-bump.md) |
| J09 — Platform Admin Operations | S-09 | 12 | 1.3% | [J09](journeys/J09-admin-operations.md) |
| J10 — Audit Chain Integrity | S-10 | 19.5 | 2.1% | [J10](journeys/J10-audit-chain.md) |
| J11 — Self-Approval Prevention | S-11 | 40 | 4.3% | [J11](journeys/J11-self-approval.md) |
| J12 — Knowledge Status State Machine | S-12 | 24 | 2.6% | [J12](journeys/J12-state-machine.md) |
| J13 — Config Management & Governance | S-13 | 16 | 1.7% | [J13](journeys/J13-config-governance.md) |
| J14 — Dashboard Visual & Interaction | S-14 | 30 | 3.2% | [J14](journeys/J14-dashboard-visual.md) |
| J15 — Reason / Placeholder Rejection | S-15 | 45 | 4.8% | [J15](journeys/J15-reason-placeholder.md) |

**Total suite weight: 933.5 | 10% gate: 93.4 | Max single blast radius: 7.7% (S-05.1)**

---

## Risk & Weight Model

See [E2E-TEST-PLAN.md](../E2E-TEST-PLAN.md) for the full weight model, frequency tiers, violation analysis, and CI execution strategy.

---

## Running Tests

```bash
# Start test stack (includes mock OpenAI)
docker compose -f docker-compose.test.yml up -d

# Upload test configs and verify infrastructure probes pass
node tests/e2e/helpers/setup.js

# Run all scenarios
npx playwright test tests/e2e/scenarios/

# Run a single journey
npx playwright test tests/e2e/scenarios/01-global-catalog-onboarding.spec.js

# Run by frequency tier (fastest feedback first)
npx playwright test --grep="F4"   # core agent workflow
npx playwright test --grep="F3"   # daily governance / security
npx playwright test --grep="F2"   # weekly operational

# Teardown
node tests/e2e/helpers/teardown.js
```

---

## What Cannot Be Automated

| Scenario | Why | Manual test |
|----------|-----|-------------|
| Conflict enrichment quality | LLM mock returns canned response — structure only, not analytical depth | MT-01 |
| `reflect()` extraction quality | Non-deterministic LLM — quality requires human review | MT-02 |
| `quorum:scan` skill orchestration | Claude skill prompt, not testable code | MT-03 |
| Visual graph layout quality | Node presence asserted; layout clarity requires human judgment | MT-04 |
