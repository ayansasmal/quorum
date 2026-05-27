# J21 — MCP Layer Gateway Contracts

**Scenario ID:** S-21
**Weight:** 60 (20 raw leaves × F3)
**Blast radius:** 4.9% of suite (recalculated against 1231 suite total)
**Frequency tier:** F3 (daily governance — `pending()` is F3; covers session-start behavior and
MCP write paths exercised on every agent session)
**Pillar:** Operational Reliability — C 1.5, D 1.0, OwnScore 90
**Spec file:** `tests/e2e/scenarios/21-mcp-layer-contracts.spec.js`

---

## What It Covers

Direct HTTP coverage of the gateway routes that the Quorum MCP server's `GatewayClient`
calls — a surface historically untested by the E2E suite, which focused on dashboard
`/api/*` routes. The MCP calls a different set of routes (`/pg/*`, `/governance/*`,
`/config/validate`) that have distinct contracts, auth requirements, and schema rules.

Five integration gaps are verified:

| Sub-scenario | Gap | Routes |
|-------------|-----|--------|
| S-21.1 | `pending()` topic filter isolates by domain | `GET /pg/pending?topic=` |
| S-21.2 | `Requirement` entity type accepted end-to-end | `POST /api/knowledge`, `GET /pg/versions`, `GET /api/search` |
| S-21.3 | `constraints[]` forwarded to extract without rejection | `POST /governance/extract` |
| S-21.4 | Config `owner` field required by gateway schema | `POST /config/validate` |
| S-21.5 | Status is always derived server-side; body value ignored | `POST /pg/versions` |

**Roles:** `test-pe` (principal_architect), `test-engineer` (engineer)
**Touches:** `GET /pg/pending`, `POST /pg/versions`, `POST /api/knowledge`, `GET /pg/versions/:t/:k`,
`GET /api/search`, `POST /governance/extract`, `POST /config/validate`
**Automated:** Yes — API (no browser; mock OpenAI required for S-21.3)

---

## Setup

Standard fixture projects:

| Project | Role | Notes |
|---------|------|-------|
| `quorum-test-project` | Primary | `test-pe` is PA; `test-engineer` is engineer |

`test-pe` JWT → `tokens.pe`; `test-engineer` JWT → `tokens.engineer`.

All keys are `uid()`-suffixed for run-to-run isolation. The file uses
`test.describe.configure({ mode: 'serial' })` because S-21.1's `beforeAll` seeds
pending decisions that subsequent steps must read without interference from parallel
workers.

---

## Steps

### S-21.1 — `pending()` Topic Filter

**Purpose:** verify `GET /pg/pending?topic=X` narrows the result to decisions of that
topic only. The `GatewayClient.getPendingDecisions()` forwards `opts.topic` as a query
parameter; the gateway SQL JOIN filters on `qk.topic = $N`.

**Setup:** seed two `pending_decisions` rows — one with `conflict_topic: 'auth'` and one
with `conflict_topic: 'db'` — via `POST /pg/pending`.

1. `GET /pg/pending?topic=auth`:
   - Assert: `200`, result array contains auth key, does NOT contain db key

2. `GET /pg/pending?topic=db`:
   - Assert: `200`, result array contains db key, does NOT contain auth key

3. `GET /pg/pending` (no topic filter):
   - Assert: `200`, result array contains both keys

4. `GET /pg/pending?topic=<random-ghost-topic>`:
   - Assert: `200`, result array contains neither seeded key

---

### S-21.2 — Requirement Entity Round-Trip

**Purpose:** verify the `Requirement` entity type (used for business and product knowledge)
is accepted by `validateKnowledgeInput()` in the gateway and survives the full write →
read → search round-trip. The `quorum-mcp` `graph/schema.js` defines `Requirement` with a
`business_owner` property not yet stored as a separate column — the test verifies
acceptance, not property persistence.

5. `POST /api/knowledge` with `entity_type: 'Requirement'`:
   - Assert: `201`
   - Assert: response `entity_type === 'Requirement'`

6. `GET /pg/versions/product/<key>`:
   - Assert: `200`
   - Assert: `entity_type === 'Requirement'`
   - Assert: `status === 'ACTIVE'` (PA write)

7. `GET /api/search?q=<key>` — search returns the entry:
   - Assert: `200`, match found
   - Assert: `entry.entity_type === 'Requirement'`

8. `POST /api/knowledge` with `entity_type: 'InvalidType'`:
   - Assert: `400` (unknown entity type rejected)

---

### S-21.3 — `POST /governance/extract` Constraints Acceptance

**Purpose:** verify the gateway does not reject the `constraints[]` field that
`reflect()` now forwards. The gateway currently accepts it but silently drops it
(does not pass it to `buildExtractPrompt()`). This spec documents the HTTP acceptance
contract; LLM-prompt forwarding is covered by the quorum-mcp unit test in
`tests/tools/reflect.test.js`.

9. `POST /governance/extract` without `constraints`:
   - Assert: `200`, `items` array is non-empty

10. `POST /governance/extract` with `constraints: [...]`:
    - Assert: `200`, no `400` rejection despite the extra field
    - Assert: `items` array is non-empty

11. Items from constrained extract — all have valid `entity_type`:
    - Assert: each `item.entity_type` is one of `['Decision', 'Pattern', 'Constraint', 'Runbook', 'Requirement']`

12. Missing `task_summary` (constraints alone, no summary):
    - Assert: `400`, error message references `task_summary`

---

### S-21.4 — Config Schema Owner Field Required

**Purpose:** verify `POST /config/validate` (no auth) enforces the `owner` field,
documenting the schema divergence trap: older MCP versions could build a config that
passes MCP-side Zod validation but is rejected by the gateway at upload time with a
confusing `400 owner required` error.

`POST /config/validate` requires no JWT — used to probe the schema without an S3 upload.

13. Config without `owner` field:
    - Assert: `400`
    - Assert: `valid === false`
    - Assert: `errors` array contains at least one entry with `path === 'owner'`

14. Config with `owner` field present → valid:
    - Assert: `200`, `valid === true`

15. Config with `owner: ''` (empty string):
    - Assert: `400`, `valid === false`, error path `'owner'`

16. Config with v0.4 federation fields (`is_global`, `global_scope`, `hierarchy`):
    - Assert: `200`, `valid === true` (v0.4 fields all accepted)

---

### S-21.5 — Status Derived Server-Side on `POST /pg/versions`

**Purpose:** verify the gateway is the sole authority on knowledge version status.
Callers (including the MCP server) must never be able to dictate status by including
`status` in the request body.

Status derivation formula (enforced server-side):
- PA + non-global + non-reflect trigger → `ACTIVE`
- `pending_conflict_check: true` flag → `PENDING_CONFLICT_CHECK` (regardless of role)
- All other roles → `DRAFT`

17. PA write, no `status` in body:
    - Assert: `201`, `status === 'ACTIVE'`

18. Engineer write, no `status` in body:
    - Assert: `201`, `status === 'DRAFT'`

19. PA sends `status: 'DRAFT'` in body:
    - Assert: `201`, `status === 'ACTIVE'` (body value ignored — PA always gets ACTIVE)

20. PA sends `pending_conflict_check: true` in body:
    - Assert: `201`, `status === 'PENDING_CONFLICT_CHECK'` (flag overrides role formula)

---

## Pass Criteria

- [ ] `pending()` topic filter: `?topic=auth` includes auth key, excludes db key
- [ ] `pending()` topic filter: `?topic=db` includes db key, excludes auth key
- [ ] `pending()` no filter: returns both keys
- [ ] `pending()` ghost topic: returns neither key
- [ ] `POST /api/knowledge entity_type=Requirement` → `201`, response `entity_type=Requirement`
- [ ] `GET /pg/versions` reflects `entity_type=Requirement` and `status=ACTIVE`
- [ ] `GET /api/search` returns Requirement entry with correct `entity_type`
- [ ] `POST /api/knowledge entity_type=InvalidType` → `400`
- [ ] `POST /governance/extract` without constraints → `200`, non-empty `items`
- [ ] `POST /governance/extract` with constraints → `200` (no rejection), non-empty `items`
- [ ] All extract items have `entity_type` from valid set
- [ ] `POST /governance/extract` without `task_summary` → `400` referencing `task_summary`
- [ ] Config without `owner` → `400`, `valid=false`, error path `'owner'`
- [ ] Config with `owner` → `200`, `valid=true`
- [ ] Config with `owner: ''` → `400`, error path `'owner'`
- [ ] Config with v0.4 federation fields → `200`, `valid=true`
- [ ] PA write (no status) → `ACTIVE`
- [ ] Engineer write (no status) → `DRAFT`
- [ ] PA sends `status: 'DRAFT'` in body → still `ACTIVE`
- [ ] PA sends `pending_conflict_check: true` → `PENDING_CONFLICT_CHECK`

---

## Teardown

No teardown required. All entries use `uid()`-suffixed keys. Pending decisions seeded in
S-21.1 persist in the E2E database (isolated per run by unique tokens).

---

## Notes

**Why `/pg/*` routes had no E2E coverage before S-21:** The historical test suite was
built from the dashboard perspective. Dashboard uses `/api/*` routes. The MCP
`GatewayClient` was an internal abstraction — its HTTP calls to `/pg/*` were assumed
to work once the dashboard routes passed. S-21 closes this assumption.

**S-21.3 known gap — constraints not forwarded to LLM prompt:** `POST /governance/extract`
accepts the `constraints` field but does not include it in `buildExtractPrompt()`. The
test verifies HTTP acceptance (no 400), not LLM behaviour. The TODO is in
`gateway/src/routes/governance.js`. Once fixed, the extracted `items` should reflect the
constraints as additional context for the LLM extraction step.

**S-21.4 schema divergence fixed:** The quorum-mcp `src/config/schema.js` now includes
`owner: z.string().min(1)` (aligned with the gateway schema). This spec documents the
contract that triggered the fix — a regression guard for future schema drift.

---

## Related Scenarios

- **S-03** (Deprecation workflow) — also exercises `POST /pg/pending` for deprecation requests
- **S-10** (Audit chain) — covers audit entries produced by `POST /pg/versions`
- **S-16** (Knowledge history) — exercises `GET /pg/versions/:t/:k/history`
- **S-18** (Governance route) — direct coverage of `POST /governance/detect-conflict` and `POST /governance/enrich`
- **S-20** (Cross-catalog search) — `GET /api/search` source attribution tested in depth
