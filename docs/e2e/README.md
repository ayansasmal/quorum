# Quorum — E2E Test Suite

Each journey is its own file. Read the journey before implementing its spec file.

---

## Journey Index

| Journey | Scenario(s) | Weight | Blast Radius | File |
|---------|-------------|--------|--------------|------|
| J01 — Global Catalog Onboarding | S-01 | 15 | 1.4% | [J01](journeys/J01-global-catalog-onboarding.md) |
| J02 — Knowledge Governance Lifecycle | S-02.1 – S-02.8 | 164 total | ≤ 3.9% each | [J02](journeys/J02-knowledge-governance.md) |
| J03 — Deprecation Workflow | S-03 | 40 | 3.8% | [J03](journeys/J03-deprecation-workflow.md) |
| J04 — Deviation Governance Lifecycle | S-04 | 70 | 6.7% | [J04](journeys/J04-deviation-governance.md) |
| J05 — RBAC Boundary Simulation | S-05.1 – S-05.6 | 333 total | ≤ 7.4% each | [J05](journeys/J05-rbac-boundary.md) |
| J06 — Multi-User Conflict Resolution | S-06 | 45 | 4.3% | [J06](journeys/J06-multi-user-conflict.md) |
| J07 — Conformance Scoring & Portfolio | S-07 | 50 | 4.8% | [J07](journeys/J07-conformance-portfolio.md) |
| J08 — Confidence Endorsement (Bump) | S-08 | 30 | 2.9% | [J08](journeys/J08-confidence-bump.md) |
| J09 — Platform Admin Operations | S-09 | 12 | 1.1% | [J09](journeys/J09-admin-operations.md) |
| J10 — Audit Chain Integrity | S-10 | 25.5 | 2.4% | [J10](journeys/J10-audit-chain.md) |
| J11 — Self-Approval Prevention | S-11 | 40 | 3.8% | [J11](journeys/J11-self-approval.md) |
| J12 — Knowledge Status State Machine | S-12 | 40 | 3.8% | [J12](journeys/J12-state-machine.md) |
| J13 — Config Management & Governance | S-13 | 20 | 1.9% | [J13](journeys/J13-config-governance.md) |
| J14 — Dashboard Visual & Interaction | S-14 | 30 | 2.9% | [J14](journeys/J14-dashboard-visual.md) |
| J15 — Reason / Placeholder Rejection | S-15 | 63 | 6.0% | [J15](journeys/J15-reason-placeholder.md) |
| J16 — Knowledge History & Point-in-Time Recall | S-16 | 18 | 1.7% | [J16](journeys/J16-knowledge-history.md) |
| J17 — Conflict: Governance Edge Cases | S-17 | 32 | 3.1% | [J17](journeys/J17-conflict-edge-cases.md) |
| J18 — Governance Route: Direct Coverage | S-18 | 18 | 1.7% | [J18](journeys/J18-governance-route.md) |

**Total suite weight: 1045.5 | 10% gate: 104.6 | Max single blast radius: 7.4% (S-05.1)**

---

## Risk & Weight Model

See [RISK_WEIGHTED_TEST_PLAN.md](../RISK_WEIGHTED_TEST_PLAN.md) for the full weight model, binary tree, frequency tiers, violation analysis, and CI execution strategy.

## Test Helpers

See [e2e-test-helpers.md](e2e-test-helpers.md) for helper API reference, non-conflicting data strategy, and the per-scenario helper usage table.

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
| `export()` MCP tool — markdown/confluence output | No gateway HTTP route; tool queries PostgreSQL + Graphiti directly in MCP process; requires MCP client (stdio) test | MT-05 |
| `set_agent_context` gate behaviour | Module-level state in MCP process — write blocked until context set; no HTTP equivalent | MT-06 |
| `history()` MCP Graphiti SUPERSEDES edge enrichment | HTTP route (`/pg/versions/:t/:k/history`) returns PostgreSQL data only; MCP tool additionally merges Graphiti SUPERSEDES edges via `getEvolutionChain()` — requires MCP client test | MT-07 |
| `fireWebhookAsync` conflict detection notification | Non-blocking async; cannot be asserted via HTTP response body. Configure `QUORUM_WEBHOOK_URL`, trigger a conflict, verify the payload arrives with `{ event: 'conflict_detected', topic, key, conflict_brief }` | MT-08 |
