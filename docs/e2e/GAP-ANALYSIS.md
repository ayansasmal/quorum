# Quorum — Gap Analysis & Remediation Plan

*Generated: 2026-05-28 | Suite baseline: 452 passed, 0 failed, 1 skipped*
*Updated: 2026-05-29 | Gateway unit tests: 688 | E2E: 538 passed | GAP-005 deferred; GAP-006 ✅; GAP-007 ✅; GAP-008 ✅ (PUT /config/:projectId + S-13.6); P2 gaps all closed: GAP-009 ✅ GAP-010 ✅ GAP-011 ✅ GAP-012 ✅ GAP-013 ✅; P3 gaps all closed: GAP-014 ✅ GAP-015 ✅ GAP-016 ✅ GAP-017 ✅*
*Source: journey-story-28-05-2026.md — all 21 journeys, J01–J21*

---

## Overview

| Priority | Description | Count |
|----------|-------------|-------|
| P0 | Trust model — an existing guarantee is claimed but never stress-tested | 3 |
| P1 | Silent contract failures — system reports success, delivers wrong behavior | 5 |
| P2 | API contract coverage — untested integration paths | 6 → 0 (all closed) |
| P3 | Governance workflow completeness | 5 → 0 (all closed) |
| P4 | Operational / observability | 6 |
| P5 | UI/UX completeness | 7 |
| P6 | Not yet built (v0.5+ or design decision required) | 6 |
| **Total** | | **38** |

### Test type key

| Code | What it means | Where |
|------|---------------|-------|
| **UT** | Pure unit test — no HTTP, no DB. Tests a function in isolation. | e.g. `tests/gateway/unit/` |
| **GIT** | Gateway integration test — Express handler with mocked pool/S3/Redis. | `tests/gateway/*.test.js` |
| **E2E-API** | End-to-end API test against the running Docker stack. | `tests/e2e/scenarios/*.spec.js` |
| **E2E-UI** | Playwright browser test against the running stack + dashboard. | same spec files |
| **MANUAL** | Cannot be automated (LLM quality, OAuth browser, MCP stdio). | `docs/e2e/MANUAL-TESTS.md` |
| **CODE-FIRST** | Feature does not exist — must implement before writing test. | — |

### Effort scale

- **S** — Small: ≤ 2 hours, ≤ 30 lines changed. No design decision required.
- **M** — Medium: 2–8 hours. One new test file or one new endpoint. Simple design.
- **L** — Large: > 8 hours. Requires architecture decision, multiple files, or a new subsystem.

---

## P0 — Trust Model

> These gaps are where Quorum makes a verifiable claim to its users but that claim has never been
> falsified in testing. A product that says "tamper-evident" without a tamper-detection test is
> making an unverified marketing statement.

---

### GAP-001 — Hash chain tamper detection never exercised ✅ CLOSED (2026-05-29)

**Journeys:** J10
**Risk:** P0 → resolved
**Test type:** UT
**Resolution:** 3 adversarial unit tests added to `tests/gateway/audit-chain.test.js`. Tests cover: (1) stale `entry_hash` after `author` field mutation, (2) stale `entry_hash` after `tool` field mutation, (3) `ChainIntegrityViolation` carries `position`, `expected` (recomputed hash), and `actual` (stored hash). Gateway unit tests: 685 passed.

**Context:**
`audit/chain.js` exports `verifyChain(entries)` which throws `ChainIntegrityViolation` when
any entry's `entry_hash` does not match the recomputed hash of its fields, or when
`previous_hash` does not match the prior entry's hash. This is Quorum's core compliance
claim: *"no audit entry can be retroactively altered without detection."* The entire audit
trail's trustworthiness rests on this function working correctly. Currently there is zero
test coverage of `verifyChain` under adversarial conditions — only the happy path
(chain can be written and read back) is tested.

**Change needed:**

New file: `tests/gateway/unit/audit-chain-integrity.test.js`

```javascript
import { buildEntryWithHash, verifyChain, ChainIntegrityViolation }
  from '../../../gateway/src/shared/audit/chain.js'

describe('verifyChain — tamper detection', () => {
  it('verifies a clean two-entry chain', () => {
    const e1 = buildEntryWithHash({ actor: 'alice', action: 'write' }, null, 1)
    const e2 = buildEntryWithHash({ actor: 'bob',   action: 'review' }, e1.entry_hash, 2)
    expect(verifyChain([e1, e2])).toEqual({ verified: true, entries: 2 })
  })

  it('throws ChainIntegrityViolation when entry content is mutated', () => {
    const e1 = buildEntryWithHash({ actor: 'alice', action: 'write' }, null, 1)
    const tampered = { ...e1, actor: 'eve' }   // mutate content, leave hash unchanged
    expect(() => verifyChain([tampered])).toThrow(ChainIntegrityViolation)
  })

  it('throws when previous_hash chain link is broken', () => {
    const e1 = buildEntryWithHash({ actor: 'alice', action: 'write' }, null, 1)
    const e2 = buildEntryWithHash({ actor: 'bob', action: 'review' }, 'deadbeef', 2) // wrong prev
    expect(() => verifyChain([e1, e2])).toThrow(ChainIntegrityViolation)
  })

  it('throws on a single-entry chain with a corrupted hash field', () => {
    const e1 = buildEntryWithHash({ actor: 'alice', action: 'write' }, null, 1)
    const corrupt = { ...e1, entry_hash: 'a'.repeat(64) }
    expect(() => verifyChain([corrupt])).toThrow(ChainIntegrityViolation)
  })
})
```

**Effort:** S

---

### GAP-002 — `is_public` non-member enforcement not in RBAC matrix ✅ CLOSED (2026-05-29)

**Journeys:** J05, J19
**Risk:** P0 → resolved
**Test type:** E2E-API (extend S-05)
**Resolution:** `resolveQProjectId()` in `gateway/src/routes/dashboard.js` now checks `req.user.access_denied` first and returns 403 before any DB lookup. Inline `access_denied` guards added to `POST /api/deviations`, `POST /api/deviations/batch`, and `GET /api/deviations` (routes that bypass `resolveQProjectId`). Non-existent projects return 403 (not 404) — `verify-jwt.js` sets `access_denied=true` as fail-safe when config cannot be loaded, preventing project enumeration. S-05.10 added (6 E2E tests). E2E suite: 492 passed after this fix.

**Context:**
S-19.1 step 6 verified that a non-member of a private project gets 403 on
`GET /api/knowledge`. The `verify-jwt.js` middleware sets `access_denied` for all
project-scoped routes — but the enforcement was only tested on that one route.
S-05 (RBAC boundary) tests 8 roles against governance operations but all 8 are project
*members*. There is no test of what a valid authenticated user with a JWT for a *different*
project can do against a private project. If `access_denied` logic has a hole in any route
handler, a member of project A silently reads project B's knowledge.

**Change needed:**

Extend `tests/e2e/scenarios/05-rbac-boundary.spec.js` with S-05.7:

```javascript
// tokens.engineer is a member of quorum-test-project, NOT quorum-test-catalog
// quorum-test-catalog has is_public: false (default)
const CATALOG = 'quorum-test-catalog'
const outOfScopeRoutes = [
  ['GET',  `/api/knowledge`],
  ['GET',  `/api/drafts`],
  ['GET',  `/api/stats`],
  ['GET',  `/api/deviations`],
  ['GET',  `/api/conformance`],
]

test.describe('S-05.7 Non-member access to private project is denied on all project routes', () => {
  for (const [method, path] of outOfScopeRoutes) {
    test(`${method} ${path} → 403 for non-member`, async () => {
      const res = await api[method.toLowerCase()](path, {
        headers: {
          Authorization: `Bearer ${tokens.engineer}`,
          'X-Quorum-Project': CATALOG,
        },
      })
      expect(res.status).toBe(403)
    })
  }
})
```

**Effort:** S

---

### GAP-003 — Self-approval + coexist-merge interaction untested ✅ CLOSED (2026-05-29)

**Journeys:** J11, J02
**Risk:** P0 → resolved
**Test type:** E2E-API (extend S-11)
**Resolution:** `coexist_merge` action implemented in `POST /api/review/:conflictId`. Three correctness fixes required: (1) `getLatestDraftVersion` extended to include `PENDING_CONFLICT_CHECK` status — self-approval was bypassed for PA writes that land as `PENDING_CONFLICT_CHECK` rather than `DRAFT`; (2) `LEGAL_TRANSITIONS` extended with `DRAFT→SUPERSEDED` and `PENDING_CONFLICT_CHECK→SUPERSEDED`; (3) `POST /config/upload` converted to a true upsert so fixture config changes (e.g. `test-pe2` member addition) propagate to the running environment. S-11.4 added (6 E2E tests). E2E suite: 498 passed after this fix.

**Context:**
`enforceNoSelfApproval` checks whether `req.user.sub === conflict.author` in
`POST /api/review/:conflictId`. The `coexist_merge` resolution path creates a *new* unified
entry authored by the reviewing PA. The most common real-world case is the expert who wrote
the standard also being the most qualified to merge it — but this PA is author of one of
the conflicting entries. The check applies to the *review action* not to the *resulting
merged entry*, which means the combination has never been verified end-to-end. Open question:
does the audit chain record the merger correctly, and does the resulting ACTIVE entry have
the right author attribution?

**Change needed:**

Extend `tests/e2e/scenarios/11-self-approval.spec.js` with S-11.4. Requires a second PA
fixture (`test-pe2`) added to `quorum-test-project.quorum.json`:

```javascript
test.describe('S-11.4 PA who wrote entry A can merge A+B (coexist-merge)', () => {
  test('merge succeeds; resulting ACTIVE entry attributed to the merging PA', async () => {
    // test-pe writes entry A (creates PENDING_CONFLICT_CHECK if B already exists)
    // test-pe2 writes entry B on same key
    // test-pe resolves via coexist_merge — permitted because it's a review action not self-review
    const mergeRes = await api.post(`/api/review/${conflictId}`, {
      decision_type: 'coexist_merge',
      note: 'Unified token strategy: sessions for ECS, JWT for Lambda',
      merged_content: 'Use session tokens for ECS; JWT for stateless Lambda services',
    }, { headers: peHeaders })
    expect(mergeRes.status).toBe(200)

    const history = await api.get(`/pg/versions/${TOPIC}/${KEY}/history`, { headers: peHeaders })
    const activeVersion = history.data.find(v => v.status === 'ACTIVE')
    expect(activeVersion.author).toBe('test-pe')  // merger is the author of the unified entry
    // Both source entries must be SUPERSEDED (not deleted)
    const superseded = history.data.filter(v => v.status === 'SUPERSEDED')
    expect(superseded.length).toBe(2)
  })
})
```

**Effort:** M (needs `test-pe2` fixture added to project config)

---

## P1 — Silent Contract Failures

> These gaps are where the API appears to work correctly (no error, correct HTTP status) but
> the actual behavior is wrong or unverified. They are the hardest category to catch because
> no alarm rings.

---

### GAP-004 — `constraints` silently dropped in knowledge extraction ✅ CLOSED

**Journeys:** J18, J21
**Risk:** P1
**Test type:** GIT + E2E-API, code change required first

**Closed: 2026-05-29** — `buildExtractPrompt` extended with 4th `constraintsToAvoid` param;
`/extract` handler now destructures `constraints` from `req.body` and passes it through.
2 new GIT tests added (`forwards constraints array into the LLM prompt user message`,
`normalises non-array constraints to empty`). S-21.3 step 2 comment updated to reflect
the fix. Gateway unit tests: 687 passed.

**Original context:**
`POST /governance/extract` accepted `constraints[]` (confirmed no 400 in S-21.3) but
`governance.js` line 287–290 destructured only `task_summary`, `decisions_made`, and
`patterns_used` — `constraints` was never read. An MCP session calling
`reflect("...", { constraints: ["do not extract auth patterns"] })` extracted those
patterns anyway, looking correct in all logs.

**Change needed (code first):**

`gateway/src/routes/governance.js` — `POST /extract` handler (around line 285):

```javascript
// Add constraints to destructure
const {
  task_summary:    taskSummary,
  decisions_made:  decisionsMade  = [],
  patterns_used:   patternsUsed   = [],
  constraints:     constraints    = [],   // ADD THIS
} = req.body ?? {}

// Pass to prompt builder
const raw = await callLLM(buildExtractPrompt(
  taskSummary,
  Array.isArray(decisionsMade) ? decisionsMade : [],
  Array.isArray(patternsUsed)  ? patternsUsed  : [],
  Array.isArray(constraints)   ? constraints   : [],  // ADD THIS
))
```

`buildExtractPrompt` function (line 151) — add 4th param and constraints block in user prompt:

```javascript
function buildExtractPrompt(taskSummary, decisionsMade, patternsUsed, constraintsToAvoid = []) {
  // ... existing blocks ...
  const constraintsBlock = constraintsToAvoid.length > 0
    ? `\nConstraints — do NOT extract these (explicitly excluded by session):\n` +
      constraintsToAvoid.map((c) => `- ${sanitizeForPrompt(c)}`).join('\n')
    : ''

  // Add constraintsBlock to the user prompt string after patternsBlock
}
```

Then add to `tests/gateway/governance-routes.test.js`:

```javascript
it('forwards constraints array to the LLM prompt user message', async () => {
  const res = await request(app)
    .post('/governance/extract')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      task_summary: 'We chose JWT for auth',
      constraints: ['do not extract auth patterns'],
    })
  expect(callLLMSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      user: expect.stringContaining('do not extract auth patterns'),
    }),
  )
})
```

Also sync to the vendored copy in `quorum-mcp` if `reflect.js` builds its own prompt locally.

**Effort:** M

---

### GAP-005 — EventBridge sync-token path — deferred to production

**Journeys:** J13
**Risk:** P1 → deferred
**Test type:** Production integration test (not automatable in current dev stack)

**Context:**
`POST /sync/configs` supports dual auth: `principal_architect` JWT or
`X-Quorum-Sync-Token` header (for EventBridge automation). The current dev and Docker E2E
stack does **not** include EventBridge — there is no AWS EventBridge to schedule against
in local or CI environments. A local token-header test would only verify the header-parsing
code path, not the actual EventBridge trigger mechanism. This gap will be addressed when
the production stack deploys EventBridge.

**Production setup required (document in DEPLOYMENT.md):**

1. Set `QUORUM_SYNC_SECRET` in the production gateway environment (strong random value, stored in Secrets Manager).
2. Create an EventBridge scheduled rule targeting `POST /sync/configs` with `X-Quorum-Sync-Token` header.
3. Verify initial sync fires and `POST /sync/configs` returns `{ synced: ≥1, failed: [] }` in CloudWatch logs.
4. Test token rotation: update `QUORUM_SYNC_SECRET`, verify next scheduled run succeeds, verify old token is rejected.

**Smoke test (manual, run at production deploy time):**

```bash
# From any machine with network access to the gateway
curl -X POST https://<gateway-host>/sync/configs \
  -H "X-Quorum-Sync-Token: $QUORUM_SYNC_SECRET" \
  -H "Content-Type: application/json" \
  | jq '{ synced, failed }'

# Reject wrong token (expect 403)
curl -X POST https://<gateway-host>/sync/configs \
  -H "X-Quorum-Sync-Token: wrong-value" \
  -w "\nHTTP %{http_code}"
```

**Effort:** deferred — no code change needed; production smoke test documents the verification procedure

---

### GAP-006 — `deviate()` MCP HTTP contract not in S-21 ✅ CLOSED

**Journeys:** J21, J04
**Risk:** P1
**Test type:** E2E-API (extend S-21)

**Closed: 2026-05-29** — S-21.6 added to `21-mcp-layer-contracts.spec.js` with 4 tests:
full body → `recorded` + `severity > 0` + `deviation_id`; idempotent re-record → `is_new: false`;
`catalog_id` not in globals → `status: not_linked` (HTTP 200 body-discriminated); missing
`description` → 400.

**Context:**
S-04 tests `POST /api/deviations` directly with manually crafted payloads. S-21 tests MCP
layer contracts. But S-21 does not cover the `deviate()` tool's expected request shape.
"Thin proxy" is where silent divergences live: wrong field name, missing required key,
response field parsed from wrong path. The real risk: `deviate()` succeeds (HTTP 200) but
sends a malformed body resulting in `severity: 0.0` being stored — undetected until
someone notices all deviations are severity zero.

**Change needed:**

Extend `tests/e2e/scenarios/21-mcp-layer-contracts.spec.js` with S-21.6:

```javascript
test.describe('S-21.6 deviate() MCP HTTP contract', () => {
  test('POST /api/deviations body shape returns valid deviation with non-zero severity', async () => {
    const body = {
      topic:       'auth',
      key:         'oauth-standard',
      catalog_id:  'quorum-test-catalog',
      description: 'Mobile team using older OAuth flow',
      author_role: 'architect',
      confidence:  0.75,
    }
    const res = await api.post('/api/deviations', body, { headers: peHeaders })
    expect([200, 201]).toContain(res.status)
    expect(typeof res.data.id).toBe('number')
    expect(res.data.severity).toBeGreaterThan(0)   // severity must not silently be zero
  })

  test('catalog_id not in project globals → 400 not_linked', async () => {
    const res = await api.post('/api/deviations', {
      topic: 'auth', key: 'oauth-standard',
      catalog_id: 'unlinked-catalog',
      description: 'Testing unlinked catalog path',
      author_role: 'architect', confidence: 0.75,
    }, { headers: peHeaders })
    expect(res.status).toBe(400)
    expect(res.data.error).toBe('not_linked')
  })
})
```

**Effort:** S

---

### GAP-007 — `conformance()` MCP HTTP contract not in S-21 ✅ CLOSED

**Journeys:** J21, J07
**Risk:** P1
**Test type:** E2E-API (extend S-21)

**Closed: 2026-05-29** — S-21.7 added to `21-mcp-layer-contracts.spec.js` with 3 tests:
all 7 fields present (`score`, `status`, `scan_count`, `applicable_entries`, `last_scan_at`,
`catalogs`, `breakdown`); breakdown has all 6 keys (`open/accepted/denied/deferred/overdue/resolved`);
UNCERTIFIED isolated project returns the right shape. Note: `include_details:true` in the MCP
tool triggers a separate `getDeviations()` call — it is NOT a gateway query param, so no
gateway contract test is needed for it.

**Context:**
Same category as GAP-006. The `conformance()` MCP tool calls `GET /api/conformance` and
parses specific fields (`score`, `status`, `scan_count`, `catalogs`, `applicable_entries`,
`last_scan_at`). S-07 tests the route directly; no S-21 sub-scenario verifies the MCP
tool's expected field names against the actual response shape. A field rename in the
gateway silently produces wrong data in the MCP without any test failure.

**Change needed:**

Extend `tests/e2e/scenarios/21-mcp-layer-contracts.spec.js` with S-21.7:

```javascript
test.describe('S-21.7 conformance() MCP HTTP contract', () => {
  test('GET /api/conformance response contains all fields the MCP tool reads', async () => {
    const res = await api.get('/api/conformance', { headers: peHeaders })
    expect(res.status).toBe(200)
    // Fields the MCP tool reads by name (from quorum-mcp/src/tools/conformance.js)
    expect(typeof res.data.score).toBe('number')
    expect(['CERTIFIED', 'UNCERTIFIED']).toContain(res.data.status)
    expect(typeof res.data.scan_count).toBe('number')
    expect(Array.isArray(res.data.catalogs)).toBe(true)
    expect(res.data).toHaveProperty('applicable_entries')
    expect(res.data).toHaveProperty('last_scan_at')
    expect(typeof res.data.breakdown).toBe('object')
  })

  test('include_details=true returns open_deviations array when CERTIFIED', async () => {
    const res = await api.get('/api/conformance?include_details=true', { headers: peHeaders })
    expect(res.status).toBe(200)
    if (res.data.status === 'CERTIFIED') {
      expect(Array.isArray(res.data.open_deviations)).toBe(true)
    }
  })
})
```

**Effort:** S

---

### GAP-008 — Config update workflow not E2E tested ✅ CLOSED

**Journeys:** J13
**Risk:** P1
**Test type:** E2E-API (new sub-scenario in S-13), CODE-FIRST

**Closed: 2026-05-29** — `PUT /config/:projectId` route added to `gateway/src/routes/config.js`
(PA/admin only; schema-validated; `group_id` URL mismatch → 400; calls `saveProjectConfig` for
S3 write + Redis invalidation, then `syncOneProject` for DDB membership sync). S-13.6 added
(5 tests): PA PUT → 200; GET after PUT reflects change (cache invalidated); engineer → 403;
`group_id` mismatch → 400; restore cleanup. E2E suite: 510 passed, 1 skipped.

**Context:**
CLAUDE.md: *"to update an existing project config use the dashboard Config editor or
`POST /sync/configs`."* The dashboard Config editor presumably calls `saveProjectConfig()`
via a gateway route. S-14.2 tests schema-error validation but never submits a valid change.
If the save route has a regression, PAs receive no feedback and config updates silently
fail. This is the most common config operation (adding members, linking globals) and has
zero E2E coverage of the write path.

**Change needed:**

First identify the gateway route `Config.jsx` calls on Save (likely `PUT /config/:projectId`
or `POST /sync/configs` after a direct S3 write). Then add to S-13 or S-14:

```javascript
test.describe('S-13.7 PA can update project config via PUT /config/:projectId', () => {
  test('valid config update → 200; re-read reflects change', async () => {
    const current = await api.get(`/config/${TEST_PROJECT}`, { headers: peHeaders })
    const updated = { ...current.data, _test_marker: 'S-13.7' }
    const res = await api.put(`/config/${TEST_PROJECT}`, updated, { headers: peHeaders })
    expect(res.status).toBe(200)
    // Cache must be invalidated — re-read should return new value
    const readBack = await api.get(`/config/${TEST_PROJECT}`, { headers: peHeaders })
    expect(readBack.data._test_marker).toBe('S-13.7')
  })

  test('non-PA → 403 on config update', async () => {
    const res = await api.put(`/config/${TEST_PROJECT}`, {}, { headers: engineerHeaders })
    expect(res.status).toBe(403)
  })
})
```

Note: if `PUT /config/:projectId` does not exist, this becomes **CODE-FIRST** — the route
must be added to `gateway/src/routes/config.js` before the test can be written.

**Effort:** M (S if route exists; L if route needs to be created)

---

## P2 — API Contract Coverage

> Existing features with tested happy paths but untested integration variants.
> Most are single-test additions to existing spec files.

---

### GAP-009 — Hierarchy ancestry filtering not E2E tested ✅ CLOSED (2026-05-29)

**Journeys:** J01, J13
**Risk:** P2 → resolved
**Test type:** E2E-API

**Closed:** Added `quorum-test-division-catalog.quorum.json` (`is_global:true, global_scope:"division:div-backend"`) and `quorum-test-division-project.quorum.json` (hierarchy `parent:"div-backend"`). Both fixtures uploaded in `setup.js`. S-13.7 (4 tests) added to `13-config-governance.spec.js`: confirms `quorum-test-project` (no hierarchy) cannot see the division catalog, org-scoped catalog remains visible, and `quorum-test-division-project` (matching parent) can see it with correct `global_scope`.

**Context:**
`GET /api/globals` filters division/department-scoped catalogs by `hierarchy.parent`
ancestry. A project in `division: backend` should NOT see a catalog scoped to
`division: mobile`. This is a cross-org data boundary. Currently unit-tested only — no
E2E test verifies that a project in the wrong division actually gets a filtered result list.

**Change needed:**

Add a new fixture `quorum-test-division-catalog.quorum.json` with
`is_global: true, global_scope: "division", hierarchy: { parent: "div-backend", node_id: "backend-standards" }`.
Then in S-13 or a new S-22:

```javascript
test('division-scoped catalog is invisible to projects outside that division', async () => {
  const res = await api.get('/api/globals', { headers: engineerHeaders })
  const ids = res.data.globals.map(g => g.catalog_id)
  expect(ids).not.toContain('quorum-test-division-catalog')
})

test('division-scoped catalog IS visible to a project with matching hierarchy', async () => {
  const res = await api.get('/api/globals', { headers: divisionProjectHeaders })
  const ids = res.data.globals.map(g => g.catalog_id)
  expect(ids).toContain('quorum-test-division-catalog')
})
```

**Effort:** M (new fixture + new project config)

---

### GAP-010 — Endorsement history endpoint missing ✅ CLOSED (2026-05-29)

**Journeys:** J08
**Risk:** P2 → resolved
**Test type:** CODE-FIRST, then E2E-API

**Closed:** Added `GET /api/endorsements/:topic/:key` to `gateway/src/routes/dashboard.js`. Uses `resolveQProjectId` + `getKeyId` (already available), then queries `bump_log` for all endorsements for the key ordered by `bumped_at DESC`. Returns `{ topic, key, endorsements: [{ author, role, delta, bumped_at }] }`. 404 on non-existent key. S-08.6 (4 tests) added to `08-confidence-endorsement.spec.js`: list after two-user bump, field shape (NUMERIC→string from pg driver), both authors present, 404 guard. Gateway rebuilt to pick up route change.

**Context:**
The bump mechanism is tested (S-08) but there is no `GET /api/endorsements/:topic/:key`
endpoint. Governance trust requires knowing *who* endorsed an entry and when. Without
history, a PA cannot tell whether a high-confidence score reflects genuine team consensus
or a single user gaming the cooldown across multiple accounts.

**Change needed (code first):**

Add to `gateway/src/routes/dashboard.js`:

```javascript
// GET /api/endorsements/:topic/:key
router.get('/endorsements/:topic/:key', verifyJwt, projectMiddleware, async (req, res) => {
  const { topic, key } = req.params
  const pool = req.app.locals.pool
  const qProjectId = await getProjectByGroupId(pool, req.user.project)
  if (!qProjectId) return res.status(404).json({ error: 'project_not_found' })

  const { rows } = await pool.query(
    `SELECT author, delta, confidence_before, confidence_after, bumped_at
     FROM confidence_bumps
     WHERE q_project_id = $1 AND topic = $2 AND key = $3
     ORDER BY bumped_at DESC`,
    [qProjectId, topic, key],
  )
  res.json({ topic, key, endorsements: rows })
})
```

Then add to `tests/e2e/scenarios/08-confidence-endorsement.spec.js` as S-08.6:

```javascript
test('GET /api/endorsements returns list after bump', async () => {
  const res = await api.get(`/api/endorsements/${TOPIC}/${KEY}`, { headers: peHeaders })
  expect(res.status).toBe(200)
  expect(Array.isArray(res.data.endorsements)).toBe(true)
  expect(res.data.endorsements[0]).toMatchObject({
    author:            expect.any(String),
    delta:             expect.any(Number),
    confidence_before: expect.any(Number),
    confidence_after:  expect.any(Number),
    bumped_at:         expect.any(String),
  })
})
```

**Effort:** M

---

### GAP-011 — Concurrent token refresh behavior undocumented ✅ CLOSED (2026-05-29)

**Journeys:** J19
**Risk:** P2 → resolved
**Test type:** GIT

**Closed:** Added `'concurrent refresh calls both succeed — stateless sliding-window design'` test to `tests/gateway/auth-lifecycle.test.js` inside the `describe('POST /auth/refresh')` block. Test fires two simultaneous `Promise.all` refresh calls with the same token, asserts both return 200 with distinct tokens (different `iat`). Documents the intentional stateless design so a future engineer adding JTI revocation knows this contract. 688 gateway tests pass.

**Context:**
The sliding-window refresh design (access JWT = refresh token) means two simultaneous
refresh calls from the same client both return new tokens — both valid until expiry. This
is **intentional** in a stateless design, but undocumented and untested. A future engineer
adding JTI-based revocation needs to know this contract before changing it. A test now
documents the current behavior so the design intent survives.

**Change needed:**

Add to `tests/gateway/auth-routes.test.js`:

```javascript
it('concurrent refresh calls both succeed — sliding-window design is stateless', async () => {
  const validToken = mintTestToken({ sub: 'alice', role: 'engineer' })
  const [r1, r2] = await Promise.all([
    request(app).post('/auth/refresh').set('Authorization', `Bearer ${validToken}`),
    request(app).post('/auth/refresh').set('Authorization', `Bearer ${validToken}`),
  ])
  expect(r1.status).toBe(200)
  expect(r2.status).toBe(200)
  // Both return distinct tokens (different iat/jti) — sliding-window, not single-use
  expect(r1.body.token).not.toBe(r2.body.token)
  expect(r1.body.expires_in).toBeGreaterThan(0)
})
```

**Effort:** S

---

### GAP-012 — `PENDING_CONFLICT_CHECK → DRAFT` full lifecycle not tested ✅ CLOSED (2026-05-29)

**Journeys:** J12, J17
**Risk:** P2 → resolved
**Test type:** E2E-API (extend S-17)

**Closed:** Added `describe('S-17.5 — PENDING_CONFLICT_CHECK entry can be cleared to DRAFT')` to `17-conflict-edge-cases.spec.js` as a sibling of S-17.4. Three tests: (1) PCC entry not visible in `/api/drafts`, (2) `PATCH /pg/versions/:t/:k/:v { newStatus:'DRAFT' }` succeeds, (3) entry appears in `/api/drafts` after clearing. Seed uses admin `POST /pg/versions` with `pending_conflict_check:true` flag (body field `summary`, not `content` — route maps `req.body.summary` to the validator's content param). Key structural lesson: the original file's misleading comment `}) // S-17 — Conflict Edge Cases` was actually closing S-17.4, not S-17 — fixed by inserting explicit `}) // S-17.4` close and removing the now-orphaned extra `})`.

**Context:**
S-17.2 tests that a version can be stored with `PENDING_CONFLICT_CHECK` status. But the
*resolution path* — what transitions it to DRAFT when Graphiti comes back online — is not
tested. If the clearing mechanism has a bug, entries are stuck in `PENDING_CONFLICT_CHECK`
forever, invisible to the PA's review queue. The PA cannot promote or reject an entry they
cannot see.

**Change needed:**

Extend `tests/e2e/scenarios/17-conflict-edge-cases.spec.js`:

```javascript
test('S-17.5 PENDING_CONFLICT_CHECK entry can be transitioned to DRAFT', async () => {
  const write = await api.post('/pg/versions', {
    topic: 'arch', key: 'pending-lifecycle-test', content: 'Some content',
    pending_conflict_check: true,
  }, { headers: adminHeaders })
  expect(write.data.status).toBe('PENDING_CONFLICT_CHECK')

  // Transition to DRAFT (conflict check resolved — no conflict found)
  const patch = await api.patch(`/pg/versions/${write.data.id}`,
    { status: 'DRAFT' }, { headers: adminHeaders })
  expect(patch.status).toBe(200)
  expect(patch.data.status).toBe('DRAFT')

  // DRAFT now visible in /api/drafts for PA review
  const drafts = await api.get('/api/drafts', { headers: peHeaders })
  expect(drafts.data.some(d => d.key === 'pending-lifecycle-test')).toBe(true)
})
```

**Effort:** S (if PATCH route exists) / M (if the transition route needs to be created)

---

### GAP-013 — Three-way concurrent conflict behavior undefined ✅ CLOSED (2026-05-29)

**Journeys:** J06
**Risk:** P2 → resolved
**Test type:** E2E-API (extend S-06)

**Closed:** Added `describe('S-06.6 — Three-way conflict produces independent pending decisions per writer')` to `06-multi-user-conflict.spec.js`. Design clarified: `pending_decisions` allows multiple rows per topic:key (one per incoming write). `beforeAll` seeds: one ACTIVE entry + three DRAFT writes (engineer/senior/architect) + three manual `POST /pg/pending` calls. Four tests: (1) ≥3 pending entries exist for the key, (2) all three are retrievable via `GET /pg/pending`, (3) `PATCH` sets `more_pending_same_key=2` on all three rows, (4) each has distinct `incoming_content` (no phantom duplicates).

**Context:**
S-06 tests two-way conflicts exhaustively. If three engineers simultaneously write the same
key, it is unclear whether the third write: (a) creates a second `pending_decisions` row
(undefined behavior with `more_pending_same_key`), (b) increments the existing conflict's
counter, or (c) is silently discarded. Option (b) or (c) would be correct. Option (a) could
corrupt the PA's review queue with phantom conflicts.

**Change needed:**

Clarify the intended behavior in the gateway's conflict detection logic, then add S-06.6:

```javascript
test.describe('S-06.6 Three-way conflict — third write increments counter', () => {
  test('third write on same key does not create duplicate pending_decisions row', async () => {
    // Write A (ACTIVE), Write B (PENDING_CONFLICT_CHECK — creates conflict)
    // Write C on same key
    const writeC = await api.post('/api/knowledge', {
      topic: 'three-way', key: 'concurrent-test',
      content: 'Third concurrent write', confidence: 0.7,
    }, { headers: architectHeaders })
    expect(['PENDING_CONFLICT_CHECK', 'DRAFT']).toContain(writeC.data.status)

    const pending = await api.get('/pg/pending', { headers: peHeaders })
    const conflicts = pending.data.decisions.filter(d =>
      d.topic === 'three-way' && d.key === 'concurrent-test')
    // Only one pending_decisions row — no duplicates
    expect(conflicts.length).toBe(1)
    expect(conflicts[0].more_pending_same_key).toBeGreaterThanOrEqual(1)
  })
})
```

**Effort:** S (test) — recommend behavior clarification comment in dashboard.js first

---

## P3 — Governance Workflow Completeness

> These gaps are workflows that exist in the system but lack a defined resolution path,
> leaving engineers in a governance dead-end.

---

### GAP-014 ✅ — REJECTED entry re-submission path undefined

**Journeys:** J12
**Risk:** P3
**Test type:** E2E-API (after design decision)
**Closed:** S-12.6 (3 tests) — confirmed behavior correct, no code change needed. `getCurrentVersion()` queries ACTIVE only; REJECTED history never blocks re-writes. New write on REJECTED key creates independent DRAFT; REJECTED entry preserved in history.

**Context:**
`REJECTED` is a terminal status. An engineer whose proposal was wrongly rejected has no
documented path to re-propose it. In practice, engineers work around this by using a new
key suffix (`auth:tls-minimum-v2`), polluting the key namespace. A new write on the same
key *might* work (creating a new DRAFT alongside the REJECTED entry), but this is
undocumented and untested.

**Recommended design:** Document that a new write on a REJECTED key creates an independent
DRAFT (the REJECTED entry is preserved in history). No code change needed if this is
already the behavior.

**Change needed:**

Add test to `tests/e2e/scenarios/12-knowledge-state-machine.spec.js`:

```javascript
test('S-12.6 new write on REJECTED key creates independent DRAFT', async () => {
  // First: reject an entry
  // Then: re-submit same topic/key
  const resubmit = await api.post('/api/knowledge', {
    topic: 'rejected-topic', key: 'rejected-key',
    content: 'Improved version of the proposal', confidence: 0.8,
  }, { headers: architectHeaders })
  expect(resubmit.data.status).toBe('DRAFT')

  // REJECTED history entry is preserved
  const history = await api.get(`/pg/versions/rejected-topic/rejected-key/history`,
    { headers: peHeaders })
  expect(history.data.some(v => v.status === 'REJECTED')).toBe(true)
  expect(history.data.some(v => v.status === 'DRAFT')).toBe(true)
})
```

**Effort:** S (if behavior already works as expected)

---

### GAP-015 ✅ — Stale DRAFT cleanup mechanism missing

**Journeys:** J12
**Risk:** P3
**Test type:** CODE-FIRST + GIT
**Closed:** CODE-FIRST — added `GET /api/drafts?max_age_days=N` filter and `GET /api/drafts/stale?threshold_days=N` endpoint to `gateway/src/routes/dashboard.js`. Uses `make_interval(days => $2)` for safe parameterized age filter. 9 GIT tests in `tests/gateway/dashboard-drafts.test.js` + 5 E2E tests in S-12.7 (tests/e2e/scenarios/12-knowledge-state-machine.spec.js).

**Context:**
DRAFTs accumulate indefinitely. A project running for 6 months will have dozens of
abandoned DRAFTs from engineers who left, topics that were superseded, or experiments
abandoned. The PA's review queue degrades in signal-to-noise. `GET /api/drafts` returns
all DRAFTs with no age filter. This is a scale-dependent failure — invisible in tests but
painful in production after 3–6 months.

**Change needed (code first):**

1. Add `?max_age_days=N` query param to `GET /api/drafts`:
   ```javascript
   if (req.query.max_age_days) {
     query += ` AND kv.created_at > NOW() - INTERVAL '${parseInt(req.query.max_age_days)} days'`
   }
   ```

2. Add `GET /api/drafts/stale?threshold_days=90` endpoint — returns DRAFTs older than
   threshold for PA review.

3. New script `scripts/stale-draft-cleanup.js` that transitions stale DRAFTs to
   `ABANDONED` (new terminal status, not deletion).

Gateway integration test:

```javascript
it('GET /api/drafts?max_age_days=30 excludes DRAFTs older than 30 days', async () => {
  // Seed a DRAFT with created_at forced to 90 days ago (direct pool insert in test setup)
  const res = await request(app)
    .get('/api/drafts?max_age_days=30')
    .set('Authorization', `Bearer ${engineerToken}`)
    .set('X-Quorum-Project', TEST_PROJECT)
  const keys = res.body.map(d => d.key)
  expect(keys).not.toContain('stale-draft-key')
})
```

**Effort:** L (new DB status, new endpoint, new script, migration)

---

### GAP-016 ✅ — AI enrichment not persisted on `pending_decisions` row

**Journeys:** J17
**Risk:** P3
**Test type:** E2E-API + CODE-FIRST
**Closed:** CODE-FIRST — `POST /governance/enrich` now accepts optional `conflict_id`; when provided, persists enrichment JSONB to `pending_decisions.enrichment` via `UPDATE`. `GET /pg/pending` already returns the `enrichment` column — no DB migration needed (column existed). 3 E2E tests in S-18.5 (tests/e2e/scenarios/18-governance-route.spec.js).

**Context:**
`POST /governance/enrich` generates AI analysis, risks, and reviewer questions. The
dashboard loads it at review time and displays the result, but does NOT store it on the
`pending_decisions` row. Every page load triggers a new LLM call (cost + latency). More
importantly: if the LLM's analysis changes between the PA's first and second look at a
conflict (non-deterministic temperature), they may make a decision based on a different
analysis than they originally saw. The audit trail records the decision but not the
analysis that informed it.

**Change needed:**

```sql
ALTER TABLE pending_decisions
  ADD COLUMN IF NOT EXISTS enrichment_cache JSONB;
```

`POST /governance/enrich` — after computing enrichment, cache it:

```javascript
await pool.query(
  `UPDATE pending_decisions SET enrichment_cache = $1 WHERE id = $2`,
  [JSON.stringify(enrichment), conflictId],
)
```

`GET /pg/pending` — return `enrichment_cache` on each conflict row. The dashboard
should use cached enrichment when present, call `/governance/enrich` only if
`enrichment_cache` is null.

**Effort:** M

---

### GAP-017 ✅ — Stale-warning badges not browser-tested

**Journeys:** J02, J03
**Risk:** P3
**Test type:** E2E-UI (extend S-02.8 or S-03)
**Closed:** Added `data-testid="stale-warning-badge"` to `DecisionCard.jsx` (expanded conflict body) and `Pending.jsx` (deprecation request row). S-02.12 (2 tests) in tests/e2e/scenarios/02-knowledge-governance.spec.js — step 1 verifies `stale_warning` set via `request_changes` API; step 2 browser test confirms badge visible in Pending page after card expansion.

**Context:**
`stale_warning: true` on a `pending_decisions` row is returned in API responses (tested)
and is supposed to render a visual warning badge on the Pending Decisions page and the
Deprecation Requests table. No browser test validates this rendering. If the conditional
rendering in `Pending.jsx` has a silent bug, the PA has no warning that the conflict is
based on outdated knowledge and may make an incorrect governance decision.

**Change needed:**

1. Add `data-testid="stale-warning-badge"` to the stale warning element in `Pending.jsx`

2. Extend `tests/e2e/scenarios/02-knowledge-governance.spec.js` S-02.8:

```javascript
test('S-02.8.6 stale_warning badge visible on a stale conflict', async () => {
  // Seed: create conflict, advance underlying entry version → stale_warning = true
  await page.goto(`${DASHBOARD_URL}/pending`)
  const badge = page.locator('[data-testid="stale-warning-badge"]').first()
  await expect(badge).toBeVisible()
  await expect(badge).toContainText(/stale/i)
})
```

**Effort:** S (if testid attr added to Pending.jsx) / M (if seed setup for stale_warning is complex)

---

## P4 — Operational / Observability

> These gaps leave the ops team unable to verify the audit chain, export compliance data,
> or observe admin activity. The system is correct but unverifiable.

---

### GAP-018 — Audit chain CLI verification not E2E tested

**Journeys:** J10
**Risk:** P4
**Test type:** E2E-API (extend S-10)

**Context:**
`scripts/audit-cli.js verify` calls the gateway to fetch all audit entries and runs
`verifyChain()` on them. This is the primary compliance tool. It is never invoked in the
E2E suite. If a code change breaks the `/pg/audit` pagination used by the verify command,
the CLI silently returns "verified: true" on a partial result set — a false compliance pass.

**Change needed:**

Option A (preferred): Add a gateway route `GET /pg/audit/verify` that runs `verifyChain`
server-side and returns `{ verified: boolean, entries: number, broken_at?: number }`.
Then test in S-10:

```javascript
test('S-10.9 GET /pg/audit/verify returns verified:true on a clean chain', async () => {
  const res = await api.get('/pg/audit/verify', { headers: adminHeaders })
  expect(res.status).toBe(200)
  expect(res.data.verified).toBe(true)
  expect(res.data.entries).toBeGreaterThan(0)
})
```

Option B: Invoke the CLI script via `execFileNoThrow` from a Node test runner helper.
See `src/utils/execFileNoThrow.ts` for the safe invocation pattern used in this codebase.

**Effort:** M

---

### GAP-019 — Audit export for compliance not E2E tested

**Journeys:** J10
**Risk:** P4
**Test type:** E2E-API + CODE-FIRST

**Context:**
`scripts/audit-cli.js export` generates a NDJSON export for compliance review. No E2E test
verifies the format, completeness, or that chain fields are present. A compliance officer
who receives a truncated or malformatted export cannot fulfil their reporting obligation.

**Change needed:**

Add `GET /pg/audit/export?format=ndjson` gateway route, then test in S-10:

```javascript
test('S-10.10 audit NDJSON export contains chain fields on every entry', async () => {
  const res = await api.get('/pg/audit/export?format=ndjson', {
    headers: adminHeaders,
    responseType: 'text',
  })
  expect(res.status).toBe(200)
  const lines = res.data.trim().split('\n').map(JSON.parse)
  expect(lines.length).toBeGreaterThan(0)
  expect(lines[0]).toMatchObject({
    entry_hash:     expect.stringMatching(/^[a-f0-9]{64}$/),
    chain_position: expect.any(String),   // BIGINT serialised as string by pg driver
    previous_hash:  expect.anything(),    // null for first entry, hex for rest
  })
})
```

**Effort:** M (new route + test)

---

### GAP-020 — Confidence decay script has no test coverage

**Journeys:** J08
**Risk:** P4
**Test type:** UT (script unit test)

**Context:**
`scripts/decay.js` applies time-based confidence decay to knowledge entries. Zero test
coverage — not unit, not integration, not E2E. Confidence decay is core to Quorum's
self-evolving knowledge model: without it, old entries retain high confidence indefinitely.
If `decay.js` has a bug that zeros all confidences, a production cron run silently wipes
the authority signal from the entire knowledge graph.

**Change needed:**

`scripts/decay.js` should export its decay function for testability:

```javascript
export function computeDecay(confidence, decayRatePerDay, elapsedDays) {
  return Math.max(0, confidence - decayRatePerDay * elapsedDays)
}
```

New file `tests/scripts/decay.test.js`:

```javascript
import { computeDecay } from '../../scripts/decay.js'

it('reduces confidence by rate × elapsed days', () => {
  expect(computeDecay(0.90, 0.001, 30)).toBeCloseTo(0.87, 3)
})

it('never decays below 0', () => {
  expect(computeDecay(0.05, 0.01, 100)).toBe(0)
})

it('returns original confidence when no time has elapsed', () => {
  expect(computeDecay(0.80, 0.005, 0)).toBe(0.80)
})
```

**Effort:** M (requires refactoring decay.js to export pure function)

---

### GAP-021 — Admin operations have no filtered audit log view

**Journeys:** J09
**Risk:** P4
**Test type:** E2E-API (extend S-09) + UI change

**Context:**
Admin operations write audit entries with `tool=admin-role-update` etc.
The `?tool=` filter already works on `GET /pg/audit`, but the dashboard Audit Timeline has
no admin-specific filter in its UI. A platform admin reviewing governance changes cannot
isolate admin events without manual API calls. The gap is minor (API works) but creates
ops friction.

**Change needed:**

1. Add `tool=admin` as a preset filter option in `Audit.jsx` filter dropdown.

2. Add to `tests/e2e/scenarios/09-admin-operations.spec.js` as S-09.7:

```javascript
test('S-09.7 admin role-update creates audit entry with tool=admin-role-update', async () => {
  // After a successful role update in earlier S-09 steps...
  const res = await api.get('/pg/audit?tool=admin-role-update', { headers: adminHeaders })
  expect(res.status).toBe(200)
  expect(res.data.length).toBeGreaterThan(0)
  expect(res.data[0].tool).toBe('admin-role-update')
})
```

**Effort:** S

---

### GAP-022 — Project offboarding flow not E2E tested

**Journeys:** J09
**Risk:** P4
**Test type:** E2E-API + CODE-FIRST if route missing

**Context:**
`DELETE /projects/:id` is "dashboard-only" per CLAUDE.md (MCP cannot trigger it —
preserving human-in-the-loop for lifecycle decisions). But neither path is E2E tested.
If a platform admin needs to retire a project (team dissolved, product sunset), the
offboarding path is unvalidated. Orphan records in `q_projects` and DDB accumulate,
degrading `GET /api/portfolio` accuracy over time.

**Change needed:**

Verify the offboarding route exists. If it exists, add to S-09:

```javascript
test('S-09.8 admin can soft-archive a project (history preserved)', async () => {
  // Use a dedicated throwaway fixture for this test (never run in parallel with others)
  const res = await api.delete(`/projects/${THROWAWAY_PROJECT_ID}`,
    { headers: adminHeaders })
  expect(res.status).toBe(200)
  // History is preserved — append-only constraint
  const history = await api.get(`/pg/versions/${TOPIC}/${KEY}/history`)
  expect(history.data.length).toBeGreaterThan(0)
  // Project no longer appears in active listing
  const projects = await api.get('/api/globals', { headers: adminHeaders })
  const ids = projects.data.globals.map(g => g.catalog_id)
  expect(ids).not.toContain(THROWAWAY_PROJECT_ID)
})
```

**Effort:** M (if route exists) / L (if soft-delete semantics need to be implemented)

---

## P5 — UI/UX Completeness

> Dashboard experience gaps. The API is correct; the UI layer is untested or incomplete.

---

### GAP-023 — Config editor save flow not browser-tested

**Journeys:** J14
**Risk:** P5
**Test type:** E2E-UI (extend S-14.2)

**Context:**
S-14.2 tests schema validation (invalid JSON → error div) but never tests a successful
save. If the save button silently fails (React network error, wrong HTTP method), PAs have
no feedback and config updates are silently lost. The error path is green; the success path
is uncovered.

**Change needed:**

Add `data-testid="save-config-btn"` and `data-testid="save-success"` to `Config.jsx`.
Then extend S-14.2:

```javascript
test('S-14.2.3 valid config save shows success feedback', async () => {
  await page.goto(`${DASHBOARD_URL}/config`)
  const textarea = page.locator('[data-testid="config-editor"]')
  const raw = await textarea.inputValue()
  const updated = { ...JSON.parse(raw), _e2e_marker: 'S-14.2.3' }
  await textarea.fill(JSON.stringify(updated, null, 2))
  await page.click('[data-testid="save-config-btn"]')
  await expect(page.locator('[data-testid="save-success"]')).toBeVisible({ timeout: 5000 })
})
```

**Effort:** S (if testid attrs added) / M (if component refactor needed)

---

### GAP-024 — Dashboard knowledge history panel missing

**Journeys:** J16
**Risk:** P5
**Test type:** CODE-FIRST + E2E-UI

**Context:**
The Knowledge browser shows the current version. There is no history panel showing prior
versions, supersede reasons, or the full version chain. Engineers discovering an entry
cannot see how it evolved or why the previous version was replaced — defeating the purpose
of the versioning model from the user's perspective. The API (`/pg/versions/:t/:k/history`)
exists; the UI surface is missing.

**Change needed:**

Add a slide-in history drawer in `Knowledge.jsx` triggered by clicking a "History" icon
on each row. Uses `GET /pg/versions/:topic/:key/history`. E2E test:

```javascript
test('S-16.6 history drawer shows full version chain', async () => {
  await page.goto(`${DASHBOARD_URL}/knowledge`)
  await page.click(`[data-testid="history-btn-${SUPERSEDED_KEY}"]`)
  const drawer = page.locator('[data-testid="version-history-drawer"]')
  await expect(drawer).toBeVisible()
  const rows = drawer.locator('[data-testid="version-row"]')
  await expect(rows).toHaveCount(2)  // ACTIVE + SUPERSEDED
})
```

**Effort:** L (new React component + E2E test)

---

### GAP-025 — Dashboard search interaction not browser-tested

**Journeys:** J20
**Risk:** P5
**Test type:** E2E-UI

**Context:**
S-20 tests `GET /api/search` via direct API calls. The Knowledge browser has a search
input but no browser test validates it is wired to the API, that results render, or that
`source: 'global'` entries show a visual distinction. A React state management bug could
silently decouple the input from the API call.

**Change needed:**

Add to `14-dashboard-visual.spec.js` or a new `20-cross-catalog-search.spec.js` browser section:

```javascript
test('S-20.8 knowledge browser search renders global results with source badge', async () => {
  await page.goto(`${DASHBOARD_URL}/knowledge`)
  await page.locator('[data-testid="knowledge-search"]').fill('tls')
  const globalBadge = page.locator('[data-testid="source-global-badge"]').first()
  await expect(globalBadge).toBeVisible({ timeout: 5000 })
  await expect(globalBadge).toContainText(/global/i)
})
```

**Effort:** S (if testid attrs exist on search input + source badge in JSX)

---

### GAP-026 — Pending page overdue deferrals not browser-tested

**Journeys:** J04
**Risk:** P5
**Test type:** E2E-UI

**Context:**
`Pending.jsx` has an "Overdue deferrals" section (API-tested in S-04). If a React error
in this section prevents the full Pending page from rendering, PAs cannot see any pending
decisions. The risk is not the feature itself but a rendering error in a secondary section
silently breaking the primary governance surface.

**Change needed:**

Seed an OVERDUE deviation before the browser test run, then add a test to S-04.7 or
as a dedicated sub-scenario in the Pending page browser tests:

```javascript
test('Pending page renders overdue deferrals section without error', async () => {
  await page.goto(`${DASHBOARD_URL}/pending`)
  const overdueSection = page.locator('[data-testid="overdue-deferrals-section"]')
  await expect(overdueSection).toBeVisible()
  // Section exists even with zero rows (empty state is acceptable)
})
```

**Effort:** S

---

### GAP-027 — Dark mode not browser-tested

**Journeys:** J14
**Risk:** P5
**Test type:** E2E-UI (low priority — visual regression)

**Context:**
`ThemeContext` toggles dark mode via `localStorage`. No browser test validates the toggle
works, that `dark:` Tailwind classes apply, or that the theme preference persists across
navigation. A CSS purge regression that strips dark-mode classes is invisible to all
automated tests and all 10 dashboard pages are affected simultaneously.

**Change needed:**

Single test in `14-dashboard-visual.spec.js`:

```javascript
test('S-14.6 dark mode toggle applies dark class to html element', async () => {
  await page.goto(`${DASHBOARD_URL}/`)
  await page.click('[data-testid="theme-toggle"]')
  await expect(page.locator('html')).toHaveClass(/dark/)
  // Navigate to another page — theme persists
  await page.goto(`${DASHBOARD_URL}/knowledge`)
  await expect(page.locator('html')).toHaveClass(/dark/)
})
```

**Effort:** S

---

## P6 — Not Yet Built

> These require new features, architecture changes, or design decisions.
> Tracked for roadmap planning; no test can be written until the feature exists.

---

### GAP-028 — Portfolio full-page UI

**Journeys:** J07 | **Risk:** P6 | **Effort:** L

`GET /api/portfolio` is tested (S-07.4). Dashboard has no Portfolio page with
sorting, filtering, project drill-down, or UNCERTIFIED breakdown. Planned for v0.5+.
Test: E2E-UI once page is built.

---

### GAP-029 — Notification system for governance events

**Journeys:** J03, J04, J06 | **Risk:** P6 | **Effort:** L

No notification for: conflict detection alerting the conflicting author, deprecation
request notifying the entry's original author, overdue deferral PA escalation, or any
other async governance event. Planned for v0.5+.

---

### GAP-030 — Token revocation / key rotation

**Journeys:** J19 | **Risk:** P6 (architectural) | **Effort:** L

Stateless JWT has no per-token revocation. Compromise requires full key rotation
(`keys.js`), invalidating all tokens simultaneously. A JTI blacklist in Redis would allow
per-token revocation but requires stateful refresh tokens and a single-use enforcement
mechanism. Design decision required before implementation.

---

### GAP-031 — Knowledge history bulk export

**Journeys:** J16 | **Risk:** P6 | **Effort:** M

No bulk export of full version history for a domain or project. `audit-cli.js export`
covers the audit chain; knowledge version history has no export path. Needed for external
compliance audit tools.

---

### GAP-032 — Automated conformance scan scheduling

**Journeys:** J07, J04 | **Risk:** P6 | **Effort:** L

`quorum:scan` skill describes an orchestration loop. No gateway-side scheduler (EventBridge
rule or cron job) automatically runs conformance scans. Without automation, `scan_count`
only increments when a human manually triggers it, and `last_scan_at` goes stale.

---

### GAP-033 — Config editor diff view

**Journeys:** J14 | **Risk:** P6 (UX) | **Effort:** M

Config editor shows raw JSON textarea with no side-by-side diff. For large configs
(20+ members, multiple globals), an unintended deletion is easy to miss before Save.
Requires a React diff library (e.g. `react-diff-viewer`) and UI redesign.

---

## Appendix A — Gap Discovery Methodology

This analysis was produced by:

1. **Journey story extraction** — each of the 21 journeys' gap tables in
   `docs/e2e/journey-story-28-05-2026.md` was read and deduplicated (38 unique gaps
   after removing overlaps across journeys)
2. **Risk classification** — each gap was mapped to one of Quorum's constitutional
   promises or product claims (tamper-evident, no self-approval, append-only, etc.)
3. **Code verification** — specific function signatures were checked before writing
   fix suggestions (e.g. `verifyChain(entries[])` takes an array, not `pool+projectId`;
   `constraints` destructuring confirmed missing at governance.js line 287–290)
4. **Effort calibration** — estimated against this project's test patterns:
   S = a few test cases in an existing file; M = a new endpoint or new test file;
   L = new DB migration, new subsystem, or design decision required

**Priority assignment rules:**

| Tier | Rule |
|------|------|
| P0 | An existing product *claim* that has never been falsified in testing |
| P1 | System reports success but delivers wrong behavior (no alarm rings) |
| P2 | A feature works but an integration variant is untested (production blindspot) |
| P3 | A workflow exists but has no defined resolution path (governance dead-end) |
| P4 | Ops team cannot maintain the system without this (verification/observability) |
| P5 | UI works but is not browser-tested (hidden regression possible) |
| P6 | Not built yet or requires architectural change |

---

## Appendix B — Recommended Fix Sequence (First Sprint)

Total estimated effort for P0 + P1 items: ~11 hours.

| Order | Gap | Type | Est. |
|-------|-----|------|------|
| 1 | GAP-001 hash chain tamper detection | UT | 2h |
| 2 | GAP-004 constraints forwarded to prompt | GIT + code | 3h |
| 3 | GAP-005 EventBridge sync-token E2E | E2E-API | 1h |
| 4 | GAP-002 is_public RBAC matrix | E2E-API | 2h |
| 5 | GAP-006 deviate() MCP contract | E2E-API | 1h |
| 6 | GAP-007 conformance() MCP contract | E2E-API | 1h |
| 7 | GAP-011 concurrent refresh document | GIT | 30m |
