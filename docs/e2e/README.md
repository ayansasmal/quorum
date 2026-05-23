# Quorum — E2E Test Suite

Each journey is its own file. Read the journey before implementing its spec file.

---

## Journey Index

| Journey | Scenario(s) | Weight | Blast Radius | File |
|---------|-------------|--------|--------------|------|
| J01 — Global Catalog Onboarding | S-01 | 15 | 1.4% | [J01](journeys/J01-global-catalog-onboarding.md) |
| J02 — Knowledge Governance Lifecycle | S-02.1 – S-02.8 | 164 total | ≤ 3.9% each | [J02](journeys/J02-knowledge-governance.md) |
| J03 — Deprecation Workflow | S-03 | 40 | 3.6% | [J03](journeys/J03-deprecation-workflow.md) |
| J04 — Deviation Governance Lifecycle | S-04 | 74 | 6.7% | [J04](journeys/J04-deviation-governance.md) |
| J05 — RBAC Boundary Simulation | S-05.1 – S-05.6 | 333 total | ≤ 7.1% each | [J05](journeys/J05-rbac-boundary.md) |
| J06 — Multi-User Conflict Resolution | S-06 | 45 | 4.1% | [J06](journeys/J06-multi-user-conflict.md) |
| J07 — Conformance Scoring & Portfolio | S-07 | 50 | 4.5% | [J07](journeys/J07-conformance-portfolio.md) |
| J08 — Confidence Endorsement (Bump) | S-08 | 30 | 2.7% | [J08](journeys/J08-confidence-bump.md) |
| J09 — Platform Admin Operations | S-09 | 14 | 1.3% | [J09](journeys/J09-admin-operations.md) |
| J10 — Audit Chain Integrity | S-10 | 30 | 2.7% | [J10](journeys/J10-audit-chain.md) |
| J11 — Self-Approval Prevention | S-11 | 40 | 3.6% | [J11](journeys/J11-self-approval.md) |
| J12 — Knowledge Status State Machine | S-12 | 46 | 4.2% | [J12](journeys/J12-state-machine.md) |
| J13 — Config Management & Governance | S-13 | 20 | 1.8% | [J13](journeys/J13-config-governance.md) |
| J14 — Dashboard Visual & Interaction | S-14 | 30 | 2.7% | [J14](journeys/J14-dashboard-visual.md) |
| J15 — Reason / Placeholder Rejection | S-15 | 63 | 5.7% | [J15](journeys/J15-reason-placeholder.md) |
| J16 — Knowledge History & Point-in-Time Recall | S-16 | 18 | 1.6% | [J16](journeys/J16-knowledge-history.md) |
| J17 — Conflict: Governance Edge Cases | S-17 | 32 | 2.9% | [J17](journeys/J17-conflict-edge-cases.md) |
| J18 — Governance Route: Direct Coverage | S-18 | 18 | 1.6% | [J18](journeys/J18-governance-route.md) |
| J19 — Authentication Lifecycle | S-19 | 45 | 4.1% | [J19](journeys/J19-auth-lifecycle.md) |

**Total suite weight: 1107 | 10% gate: 110.7 | Max single blast radius: 7.1% (S-05.1)**

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
| Claude-authored writes always land as DRAFT | Module-level check in `storeFirst()` when `author === 'claude'` forces DRAFT status; no HTTP equivalent exists (gateway writes use human JWT); requires MCP client (stdio) test with `QUORUM_AUTHOR=claude` | MT-09 |
| `pending_review` MCP status for global catalog writes | Returned when a non-PA writes to a project with `is_global: true`; entry lands as DRAFT in global catalog; MCP layer returns `{ status: 'pending_review' }` but there is no HTTP-only way to trigger the non-PA global write path without a live MCP process | MT-10 |
| GitHub OAuth browser flow | Full redirect dance (GitHub → gateway `/auth/callback` → JWT issue → sessionStorage) requires a real browser session and a configured GitHub OAuth app; not reproducible with Playwright alone without live GitHub | MT-11 |
| PKCE OAuth 2.1 MCP client auth | Claude Code MCP client PKCE flow — authorization_code exchange with code_verifier; requires a live MCP client (stdio) paired with a configured OAuth provider; no HTTP-only equivalent | MT-12 |

---

## Known Code Gaps — Tests Blocked Until Fixed

These are implementation gaps identified during journey documentation. The journey files that depend on each gap include a note at the relevant step. All gaps follow the same pattern: a constitutional rule is enforced inconsistently across routes.

| Gap | Affected Route(s) | Current Behaviour | Required Behaviour | Journeys Affected |
|-----|-------------------|-------------------|--------------------|-------------------|
| **G-2** — `ConstitutionalViolation` has no `.status` property | Any route that calls `next(err)` after a constitutional throw | Global error handler returns `500 { error: 'internal_error' }` — `rule:` field never surfaces | Add `if (err.name === 'ConstitutionalViolation') return res.status(400).json({ rule: err.rule, message: err.message })` to `gateway/src/server.js` error handler | J15 (all 10 endpoints — rule field assertion), J13 Part F, J09 Step 5 |
| **G-6** — Bulk deprecate inconsistent error key | `POST /api/knowledge/deprecate/bulk` | Returns `{ error: 'reason_required' }` (catch block) | Must return `{ rule: 'REASON_REQUIRED' }` consistent with all other governance endpoints | J15 Step 8 |
| **G-7** — Manual reason check in config routes | `POST /config/transfer-ownership`, `POST /config/update-role`, `POST /admin/users` | Returns `{ error: 'missing_param' }` from inline length check | Must call `enforceReasonRequired(reason)` and propagate `{ rule: 'REASON_REQUIRED' }` | J13 Part F, J09 Step 5, J15 Steps 9–10 |

**Fix order:** G-2 first (unblocks the broadest set of assertions), then G-7, then G-6.
