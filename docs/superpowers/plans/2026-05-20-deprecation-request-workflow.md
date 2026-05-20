# Deprecation Request Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow non-PE engineers to submit deprecation requests via `forget()` that queue in `pending_decisions` for PE approval via `review()`, surfaced in both `pending()` (MCP) and the dashboard Pending page.

**Architecture:** Reuse `pending_decisions` table with `decision_type = 'deprecation_request'`. Non-PE `forget()` queues a request instead of returning `forbidden`. `pending()` and `review()` gain a new branch for this type. Gateway `POST /api/review/:conflictId` and `Pending.jsx` are extended to handle approve/reject from the dashboard.

**Tech Stack:** Node.js (quorum-mcp tools), Express (gateway dashboard routes), React + TanStack Query (dashboard), PostgreSQL `pending_decisions` table, Vitest (tests).

---

## File Map

| File | Action | What changes |
|---|---|---|
| `quorum-mcp/src/tools/forget.js` | Modify | Replace `forbidden` with non-PE queuing path |
| `quorum-mcp/src/tools/pending.js` | Modify | Add `fetchDeprecationRequests()`, extend output + summary |
| `quorum-mcp/src/tools/review.js` | Modify | Add `request_id` param + `handleDeprecationRequest()` |
| `quorum-mcp/tests/tools/forget.test.js` | Modify | Replace forbidden tests; add queuing + dedup + not_found |
| `quorum-mcp/tests/tools/pending.test.js` | Modify | Add deprecation_requests section tests |
| `quorum-mcp/tests/tools/review.test.js` | Modify | Add approve + reject deprecation request tests |
| `quorum-mcp/skill/references/tool-reference.md` | Modify | Update forget(), pending(), review() docs |
| `gateway/src/routes/dashboard.js` | Modify | Extend `POST /api/review/:conflictId` for deprecation_request type |
| `gateway/openapi.yaml` | Modify | Document request_id param + deprecation_requests response field |
| `gateway/CLAUDE.md` | Modify | Update route descriptions |
| `dashboard/src/api/pending.js` | Modify | Add `useReviewDeprecationRequest` mutation |
| `dashboard/src/pages/Pending.jsx` | Modify | Add Deprecation Requests section |
| `engram/CLAUDE.md` | Modify | Update "Built and working" section |

---

## Task 1: `forget.js` — non-PE queuing path

**Files:**
- Modify: `quorum-mcp/src/tools/forget.js`
- Modify: `quorum-mcp/tests/tools/forget.test.js`

The current non-PE path returns `{ status: 'forbidden' }`. Replace it with a path that queues a `pending_decisions` row. The role guard tests (added in the prior session) are replaced by queuing behaviour tests.

- [ ] **Step 1: Update the mock in `forget.test.js` to include `getPendingDecisions` and `insertPendingDecision`**

Open `quorum-mcp/tests/tools/forget.test.js`. Find the `vi.mock('../../src/graph/queries.js', ...)` block and add two mocks:

```js
vi.mock('../../src/graph/queries.js', () => ({
  getCurrentVersion: vi.fn(),
  getNextVersionNumber: vi.fn(),
  insertVersion: vi.fn().mockResolvedValue({ version_id: 'q_k1_v2', q_key_id: 'q_k1' }),
  transitionVersionStatus: vi.fn().mockResolvedValue(),
  insertVersionAuditLink: vi.fn().mockResolvedValue(),
  incrementDomainStat: vi.fn().mockResolvedValue(),
  // NEW — needed for non-PE queuing path:
  getPendingDecisions: vi.fn().mockResolvedValue([]),
  insertPendingDecision: vi.fn().mockResolvedValue('q_c5'),
}))
```

- [ ] **Step 2: Write the failing tests for the non-PE queuing path**

Replace the existing `describe('forget — role guard', ...)` block (lines ~45–90 in `forget.test.js`) with the following:

```js
describe('forget — non-PE queuing path', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns deprecation_requested for a non-PE caller with an ACTIVE entry', async () => {
    const { getCurrentVersion, getPendingDecisions, insertPendingDecision } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue({
      version: 3, status: 'ACTIVE', author: 'someone',
      summary: 'Use JWT for Lambda', graphiti_episode_id: null,
    })
    vi.mocked(getPendingDecisions).mockResolvedValue([])
    vi.mocked(insertPendingDecision).mockResolvedValue('q_c5')

    const { handler } = await import('../../src/tools/forget.js')
    const result = await handler(mockPg, {
      topic: 'auth', key: 'token-strategy', reason: 'Replaced by new OAuth approach with PKCE',
    }, juniorIdentity, testCtx)

    expect(result.status).toBe('deprecation_requested')
    expect(result.request_id).toBe('q_c5')
    expect(result.topic).toBe('auth')
    expect(result.key).toBe('token-strategy')
    expect(result.message).toContain('principal_architect')
    expect(insertPendingDecision).toHaveBeenCalledWith(
      mockPg,
      expect.objectContaining({
        decision_type: 'deprecation_request',
        conflict_reason: 'Replaced by new OAuth approach with PKCE',
        existing_content: 'Use JWT for Lambda',
        active_version_at_creation: 3,
        enrichment: { requestor: 'junior-dev' },
      }),
    )
  })

  it('returns not_found when no ACTIVE entry exists for non-PE caller', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(null)

    const { handler } = await import('../../src/tools/forget.js')
    const result = await handler(mockPg, {
      topic: 'auth', key: 'gone', reason: 'Replaced by new OAuth approach with PKCE',
    }, juniorIdentity, testCtx)

    expect(result.status).toBe('not_found')
    expect(result.topic).toBe('auth')
    expect(result.key).toBe('gone')
  })

  it('returns already_requested when same requestor has a pending request for this key', async () => {
    const { getCurrentVersion, getPendingDecisions } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue({
      version: 1, status: 'ACTIVE', summary: 'content', graphiti_episode_id: null,
    })
    vi.mocked(getPendingDecisions).mockResolvedValue([
      {
        conflict_id: 'q_c3',
        decision_type: 'deprecation_request',
        enrichment: { requestor: 'junior-dev' },
      },
    ])

    const { handler } = await import('../../src/tools/forget.js')
    const result = await handler(mockPg, {
      topic: 'auth', key: 'token-strategy', reason: 'Replaced by new OAuth approach with PKCE',
    }, juniorIdentity, testCtx)

    expect(result.status).toBe('already_requested')
    expect(result.request_id).toBe('q_c3')
  })

  it('still throws ConstitutionalViolation for non-PE with short reason', async () => {
    const { handler } = await import('../../src/tools/forget.js')
    await expect(
      handler(mockPg, { topic: 'auth', key: 'x', reason: 'short' }, juniorIdentity, testCtx),
    ).rejects.toThrow(ConstitutionalViolation)
  })

  it('returns forbidden when identity is missing (anonymous caller)', async () => {
    const { handler } = await import('../../src/tools/forget.js')
    const result = await handler(mockPg, {
      topic: 'auth', key: 'token-strategy', reason: 'Replaced by new OAuth approach with PKCE',
    }, undefined, testCtx)
    expect(result.status).toBe('forbidden')
  })

  it('allows is_admin to bypass PE role check and run full deprecation', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(null)

    const { handler } = await import('../../src/tools/forget.js')
    const result = await handler(mockPg, {
      topic: 'auth', key: 'absent', reason: 'Replaced by new OAuth approach with PKCE',
    }, { name: 'admin-user', role: 'senior_engineer', is_admin: true }, testCtx)

    expect(result.status).not.toBe('forbidden')
    expect(result.status).not.toBe('deprecation_requested')
  })
})
```

- [ ] **Step 3: Run tests — confirm they fail**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp
npx vitest run tests/tools/forget.test.js 2>&1
```

Expected: several failures including "deprecation_requested" and "not_found" assertions failing because `forget.js` still returns `forbidden`.

- [ ] **Step 4: Rewrite the non-PE path in `forget.js`**

Open `quorum-mcp/src/tools/forget.js`. Make the following changes:

**4a. Add new imports** at the top of the file (merge with existing import from `queries.js`):

```js
import { getCurrentVersion, getNextVersionNumber, insertVersion, transitionVersionStatus,
         getPendingDecisions, insertPendingDecision } from '../graph/queries.js'
```

**4b. Replace the entire `handler` function** with:

```js
export async function handler(pg, input, identity, ctx) {
  const projectId = ctx?.projectId
  if (!projectId) throw new Error('forget: ctx.projectId is required — ensure a .quorum file exists in this workspace')
  const author = identity?.name ?? 'anonymous'

  // Constitutional rules apply to ALL callers — reason required before we branch
  enforceNoHardDelete('forget')
  enforceReasonRequired(input.reason, 'forget')

  // ── Non-PE path: queue a deprecation request for PE approval ─────────────────
  if (identity?.role !== 'principal_architect' && !identity?.is_admin) {
    // Anonymous callers cannot submit requests (no identity to track)
    if (!identity) {
      return {
        status: 'forbidden',
        message: 'forget() requires principal_architect role. Your role: unknown. Propose the deprecation to a PE — they can action it from the dashboard or MCP.',
        topic: input.topic,
        key: input.key,
      }
    }

    const pipelineResult = await withAuditPipeline(
      pg,
      {
        tool: 'forget',
        author,
        sessionId: input.session_id,
        topic: input.topic,
        key: input.key,
        governanceData: { reason: input.reason, mode: 'deprecation_request' },
      },
      async () => {
        const existing = await getCurrentVersion(pg, input.topic, input.key, projectId)
        if (!existing) {
          return {
            result: { status: 'not_found', topic: input.topic, key: input.key },
            versionImpact: buildAuditVersionImpact([], []),
          }
        }

        // Deduplication: one pending request per requestor per key
        const allRequests = await getPendingDecisions(pg, {
          topic: input.topic,
          statuses: ['pending'],
          projectId,
        })
        const duplicate = allRequests.find((r) => {
          if ((r.decision_type ?? 'conflict') !== 'deprecation_request') return false
          const enrich = typeof r.enrichment === 'string'
            ? JSON.parse(r.enrichment)
            : (r.enrichment ?? {})
          return enrich.requestor === author
        })
        if (duplicate) {
          return {
            result: {
              status: 'already_requested',
              request_id: duplicate.conflict_id,
              topic: input.topic,
              key: input.key,
              message: 'You already have a pending deprecation request for this entry.',
            },
            versionImpact: buildAuditVersionImpact([], []),
          }
        }

        const requestId = await insertPendingDecision(pg, {
          decision_type: 'deprecation_request',
          topic: input.topic,
          key: input.key,
          existing_content: existing.summary ?? existing.content ?? null,
          active_version_at_creation: existing.version,
          conflict_reason: input.reason,
          enrichment: { requestor: author },
          project_id: projectId,
        })

        return {
          result: {
            status: 'deprecation_requested',
            request_id: requestId,
            topic: input.topic,
            key: input.key,
            message: 'Deprecation request submitted. A principal_architect will review it in pending().',
          },
          versionImpact: buildAuditVersionImpact([], []),
        }
      },
    )
    return pipelineResult.result
  }

  // ── PE / admin path: full deprecation (unchanged) ─────────────────────────────
  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'forget',
      author,
      sessionId: input.session_id,
      topic: input.topic,
      key: input.key,
      governanceData: { reason: input.reason },
    },
    async () => {
      const existing = await getCurrentVersion(pg, input.topic, input.key, projectId)
      if (!existing) {
        return {
          result: { status: 'not_found', topic: input.topic, key: input.key },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      const nextVersion = await getNextVersionNumber(pg, input.topic, input.key, projectId)

      if (existing.graphiti_episode_id) {
        await deleteEpisodeSoft(existing.graphiti_episode_id, {
          key: `${input.topic}:${input.key}`,
          reason: input.reason,
          author,
        }, projectId).catch(() => {})
      }

      const deprecationContent = `[DEPRECATED] ${input.reason}`
      const versionRecord = buildVersionRecord({
        topic: input.topic,
        key: input.key,
        version: nextVersion,
        content: deprecationContent,
        author,
        triggeredBy: TriggeredBy.ENGINEER_DECISION,
        auditEntryId: 'pre_pending',
        supersedesVersion: existing.version,
        supersedesReason: input.reason,
        status: KnowledgeStatus.DEPRECATED,
        projectId,
        agentId:    ctx?.agentId    ?? null,
        sessionId:  ctx?.sessionId  ?? null,
        authorType: ctx?.authorType ?? 'agent',
      })

      await insertVersion(pg, versionRecord)
      await transitionVersionStatus(
        pg, input.topic, input.key, existing.version,
        KnowledgeStatus.DEPRECATED,
        { version: nextVersion, author, at: new Date().toISOString() },
        projectId,
      )

      return {
        result: {
          status: 'deprecated',
          topic: input.topic,
          key: input.key,
          deprecated_version: existing.version,
          deprecation_version: nextVersion,
          reason: input.reason,
        },
        versionImpact: buildAuditVersionImpact(
          [{ version: nextVersion, status: KnowledgeStatus.DEPRECATED, triggered_by: TriggeredBy.ENGINEER_DECISION }],
          [{ version: existing.version, status_before: existing.status }],
        ),
      }
    },
  )

  return pipelineResult.result
}
```

- [ ] **Step 5: Run tests — confirm they pass**

```bash
npx vitest run tests/tools/forget.test.js 2>&1
```

Expected: all tests pass (12 original + 6 new = 18 total, minus 3 replaced role-guard tests = 15 total).

- [ ] **Step 6: Run full test suite to check for regressions**

```bash
npm test 2>&1 | tail -10
```

Expected: all test files pass.

- [ ] **Step 7: Commit**

```bash
git add src/tools/forget.js tests/tools/forget.test.js
git commit -m "feat(forget): non-pe callers queue deprecation request instead of forbidden"
```

---

## Task 2: `pending.js` — deprecation_requests section

**Files:**
- Modify: `quorum-mcp/src/tools/pending.js`
- Modify: `quorum-mcp/tests/tools/pending.test.js`

Add `fetchDeprecationRequests()` alongside the existing `fetchConflictBriefs()` and `fetchDraftReviews()`. Extend the output shape and summary counts.

- [ ] **Step 1: Write failing tests for the deprecation_requests section**

Open `quorum-mcp/tests/tools/pending.test.js`. Add after the existing tests:

```js
describe('pending() — deprecation_requests section', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: no conflicts, no drafts
    getPendingDecisions.mockResolvedValue([])
    getDraftVersions.mockResolvedValue([])
  })

  it('returns deprecation_requests populated from pending rows with decision_type=deprecation_request', async () => {
    getPendingDecisions.mockResolvedValue([
      {
        conflict_id: 'q_c12',
        decision_type: 'deprecation_request',
        conflict_topic: 'auth',
        conflict_key: 'token-strategy',
        conflict_reason: 'Replaced by new OAuth flow with PKCE',
        existing_content: 'Use JWT for Lambda',
        active_version_at_creation: 3,
        enrichment: { requestor: 'junior-dev' },
        stale_warning: null,
        created_at: new Date().toISOString(),
      },
    ])
    getCurrentVersion.mockResolvedValue({ version: 3, status: 'ACTIVE' })

    const result = await handler(pg, {}, identity, testCtx)

    expect(result.deprecation_requests).toHaveLength(1)
    const req = result.deprecation_requests[0]
    expect(req.request_id).toBe('q_c12')
    expect(req.topic).toBe('auth')
    expect(req.key).toBe('token-strategy')
    expect(req.requestor).toBe('junior-dev')
    expect(req.reason).toBe('Replaced by new OAuth flow with PKCE')
    expect(req.current_content).toBe('Use JWT for Lambda')
    expect(req.current_version).toBe(3)
    expect(req.stale_warning).toBeNull()
  })

  it('conflict rows are not included in deprecation_requests and vice versa', async () => {
    getPendingDecisions.mockResolvedValue([
      makePendingRow({ decision_type: 'conflict' }),
      {
        conflict_id: 'q_c12',
        decision_type: 'deprecation_request',
        conflict_topic: 'auth',
        conflict_key: 'token-strategy',
        conflict_reason: 'Replaced by new OAuth flow with PKCE',
        existing_content: 'Use JWT',
        active_version_at_creation: 1,
        enrichment: { requestor: 'junior-dev' },
        stale_warning: null,
        created_at: new Date().toISOString(),
      },
    ])
    getCurrentVersion.mockResolvedValue({ version: 1, status: 'ACTIVE' })

    const result = await handler(pg, {}, identity, testCtx)

    expect(result.conflict_briefs).toHaveLength(1)
    expect(result.deprecation_requests).toHaveLength(1)
    expect(result.conflict_briefs[0].conflict_id).toBe('conflict_abc')
    expect(result.deprecation_requests[0].request_id).toBe('q_c12')
  })

  it('sets stale_warning when ACTIVE version advanced since request was created', async () => {
    getPendingDecisions.mockResolvedValue([
      {
        conflict_id: 'q_c12',
        decision_type: 'deprecation_request',
        conflict_topic: 'auth',
        conflict_key: 'token-strategy',
        conflict_reason: 'Reason for deprecation with enough chars',
        existing_content: 'old content',
        active_version_at_creation: 1,
        enrichment: { requestor: 'junior-dev' },
        stale_warning: null,
        created_at: new Date().toISOString(),
      },
    ])
    // Version has advanced from 1 to 4
    getCurrentVersion.mockResolvedValue({ version: 4, status: 'ACTIVE' })
    markPendingDecisionStale.mockResolvedValue(undefined)

    const result = await handler(pg, {}, identity, testCtx)

    expect(result.deprecation_requests[0].stale_warning).toBeTruthy()
    expect(result.deprecation_requests[0].stale_warning).toMatch(/v1/)
    expect(result.deprecation_requests[0].stale_warning).toMatch(/v4/)
    expect(markPendingDecisionStale).toHaveBeenCalledWith(
      pg, 'q_c12', expect.stringContaining('v4'), 4, 'test-project',
    )
  })

  it('summary includes deprecation_requests count', async () => {
    getPendingDecisions.mockResolvedValue([
      {
        conflict_id: 'q_c12',
        decision_type: 'deprecation_request',
        conflict_topic: 'auth',
        conflict_key: 'x',
        conflict_reason: 'reason',
        existing_content: 'content',
        active_version_at_creation: 1,
        enrichment: { requestor: 'jr' },
        stale_warning: null,
        created_at: new Date().toISOString(),
      },
    ])
    getCurrentVersion.mockResolvedValue({ version: 1 })

    const result = await handler(pg, {}, identity, testCtx)

    expect(result.summary.deprecation_requests).toBe(1)
    expect(result.summary.total_pending).toBe(1)
  })

  it('empty queue returns deprecation_requests: [] and count 0 in summary', async () => {
    getPendingDecisions.mockResolvedValue([])
    const result = await handler(pg, {}, identity, testCtx)
    expect(result.deprecation_requests).toEqual([])
    expect(result.summary.deprecation_requests).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests — confirm the new tests fail**

```bash
npx vitest run tests/tools/pending.test.js 2>&1
```

Expected: the new `deprecation_requests` tests fail because `pending.js` doesn't return that field yet.

- [ ] **Step 3: Add `fetchDeprecationRequests()` to `pending.js` and wire it up**

Open `quorum-mcp/src/tools/pending.js`.

**3a.** In the `withAuditPipeline` operation block, add `fetchDeprecationRequests` alongside the existing parallel calls:

```js
const [conflictBriefs, draftReviews, deprecationRequests] = await Promise.all([
  fetchConflictBriefs(pg, input, projectId),
  fetchDraftReviews(pg, input, projectId),
  fetchDeprecationRequests(pg, input, projectId),
])
```

**3b.** Update the returned `result` object:

```js
return {
  result: {
    conflict_briefs:      conflictBriefs,
    draft_reviews:        draftReviews,
    deprecation_requests: deprecationRequests,
    summary: {
      total_pending:        conflictBriefs.length + draftReviews.length + deprecationRequests.length,
      conflicts:            conflictBriefs.length,
      drafts:               draftReviews.length,
      deprecation_requests: deprecationRequests.length,
    },
  },
  versionImpact: buildAuditVersionImpact([], []),
}
```

**3c.** Update `fetchConflictBriefs` to filter out deprecation_request rows (guards against the GatewayClient duck-type returning all types):

```js
async function fetchConflictBriefs(pg, input, projectId) {
  const statuses = input.include_stale ? ['pending', 'stale'] : ['pending']
  const allRows = await getPendingDecisions(pg, { topic: input.topic, statuses, decisionType: 'conflict', projectId })
  // Client-side filter: gateway duck-type returns all decision types; keep only conflicts
  const rows = allRows.filter(r => (r.decision_type ?? 'conflict') === 'conflict')
  // ... rest of existing function unchanged
```

**3d.** Add the new `fetchDeprecationRequests` function at the bottom of the file:

```js
// ── Deprecation requests ───────────────────────────────────────────────────────

/**
 * Fetch pending deprecation requests, run staleness detection, return enriched list.
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {string} projectId
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function fetchDeprecationRequests(pg, input, projectId) {
  const statuses = input.include_stale ? ['pending', 'stale'] : ['pending']
  const allRows = await getPendingDecisions(pg, { topic: input.topic, statuses, projectId })
  const rows = allRows.filter(r => r.decision_type === 'deprecation_request')

  const results = []

  for (const row of rows) {
    const currentActive = await getCurrentVersion(pg, row.conflict_topic, row.conflict_key, projectId)
    const currentVersion = currentActive?.version ?? null

    let staleWarning = row.stale_warning

    if (
      currentVersion !== null &&
      row.active_version_at_creation !== null &&
      currentVersion > row.active_version_at_creation &&
      !staleWarning
    ) {
      staleWarning = `Active version advanced from v${row.active_version_at_creation} to v${currentVersion} since this request was created. Review is now against the current active version.`
      await markPendingDecisionStale(pg, row.conflict_id, staleWarning, currentVersion, projectId)
    }

    const enrichment = typeof row.enrichment === 'string'
      ? JSON.parse(row.enrichment)
      : (row.enrichment ?? {})

    results.push({
      request_id:      row.conflict_id,
      topic:           row.conflict_topic,
      key:             row.conflict_key,
      requestor:       enrichment.requestor ?? 'unknown',
      reason:          row.conflict_reason,
      current_content: row.existing_content ?? null,
      current_version: currentVersion,
      created_at:      row.created_at,
      stale_warning:   staleWarning ?? null,
    })
  }

  return results
}
```

- [ ] **Step 4: Run tests — confirm all pass**

```bash
npx vitest run tests/tools/pending.test.js 2>&1
```

Expected: all tests pass.

- [ ] **Step 5: Run full suite**

```bash
npm test 2>&1 | tail -10
```

Expected: all test files pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools/pending.js tests/tools/pending.test.js
git commit -m "feat(pending): add deprecation_requests section with staleness detection"
```

---

## Task 3: `review.js` — approve/reject deprecation requests

**Files:**
- Modify: `quorum-mcp/src/tools/review.js`
- Modify: `quorum-mcp/tests/tools/review.test.js`

Add a `request_id` parameter. When present, `review()` looks up the pending deprecation request and either runs the full `forget()` internal logic (approve) or resolves the row as rejected.

- [ ] **Step 1: Add new mocks to `review.test.js`**

Open `quorum-mcp/tests/tools/review.test.js`. Find the `vi.mock('../../src/graph/queries.js', ...)` block and add the new functions:

```js
vi.mock('../../src/graph/queries.js', () => ({
  getCurrentVersion:      vi.fn(),
  getSpecificVersion:     vi.fn(),
  transitionVersionStatus: vi.fn(),
  getLatestDraftVersion:  vi.fn(),
  incrementDomainStat:    vi.fn().mockResolvedValue(undefined),
  // NEW — needed for deprecation request path:
  getPendingDecisionById: vi.fn(),
  resolvePendingDecision: vi.fn().mockResolvedValue(),
  getNextVersionNumber:   vi.fn(),
  insertVersion:          vi.fn().mockResolvedValue({ version_id: 'q_k1_v2', q_key_id: 'q_k1' }),
}))

vi.mock('../../src/graph/client.js', () => ({
  deleteEpisodeSoft: vi.fn().mockResolvedValue({}),
  addEpisode:        vi.fn(),
  searchNodes:       vi.fn(),
  BLOCKED_METHODS:   new Set(),
  isMethodBlocked:   vi.fn(() => false),
}))

vi.mock('../../src/governance/provenance.js', () => ({
  buildAuditVersionImpact: vi.fn(() => ({ versions_created: [], versions_superseded: [] })),
  buildVersionRecord:      vi.fn(() => ({ topic: 'auth', key: 'x', version: 2 })),
}))
```

Also add `TriggeredBy` and `KnowledgeStatus.DEPRECATED` to the schema mock:

```js
vi.mock('../../src/graph/schema.js', () => ({
  KnowledgeStatus: { ACTIVE: 'ACTIVE', DRAFT: 'DRAFT', REJECTED: 'REJECTED', DEPRECATED: 'DEPRECATED' },
  TriggeredBy:     { HUMAN_DECISION: 'human_decision', ENGINEER_DECISION: 'engineer_decision' },
}))
```

- [ ] **Step 2: Add a helper and write the failing tests for the deprecation request path**

In `review.test.js`, add after the existing helpers:

```js
const peIdentity = { name: 'senior-architect', role: 'principal_architect', team: 'platform' }
const juniorIdentity = { name: 'junior-dev', role: 'senior_engineer', team: 'platform' }

function makeDeprecationRequestRow(overrides = {}) {
  return {
    conflict_id:               'q_c12',
    decision_type:             'deprecation_request',
    status:                    'pending',
    conflict_topic:            'auth',
    conflict_key:              'token-strategy',
    conflict_reason:           'Replaced by new OAuth flow with PKCE',
    existing_content:          'Use JWT for Lambda',
    active_version_at_creation: 3,
    enrichment:                { requestor: 'junior-dev' },
    q_project_id:              'test-project',
    ...overrides,
  }
}
```

Then add new `describe` blocks:

```js
describe('review() — deprecation request: approve', () => {
  afterEach(() => vi.clearAllMocks())

  it('runs deprecation logic and resolves pending row on approve', async () => {
    const {
      getPendingDecisionById, resolvePendingDecision,
      getCurrentVersion, getNextVersionNumber, insertVersion, transitionVersionStatus,
    } = await import('../../src/graph/queries.js')
    vi.mocked(getPendingDecisionById).mockResolvedValue(makeDeprecationRequestRow())
    vi.mocked(getCurrentVersion).mockResolvedValue({
      version: 3, status: 'ACTIVE', author: 'someone', graphiti_episode_id: null,
    })
    vi.mocked(getNextVersionNumber).mockResolvedValue(4)

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler(mockPg, {
      action: 'approve',
      request_id: 'q_c12',
      note: 'Approved — obsolete after migration to OAuth2',
    }, peIdentity, testCtx)

    expect(result.status).toBe('approved')
    expect(result.request_id).toBe('q_c12')
    expect(result.topic).toBe('auth')
    expect(result.key).toBe('token-strategy')
    expect(result.deprecated_version).toBe(3)
    expect(result.deprecation_version).toBe(4)
    expect(insertVersion).toHaveBeenCalled()
    expect(transitionVersionStatus).toHaveBeenCalledWith(
      mockPg, 'auth', 'token-strategy', 3, 'DEPRECATED',
      expect.objectContaining({ version: 4, author: 'senior-architect' }),
      'test-project',
    )
    expect(resolvePendingDecision).toHaveBeenCalledWith(
      mockPg, 'q_c12',
      expect.objectContaining({ status: 'resolved', resolution: 'approved', resolvedBy: 'senior-architect' }),
    )
  })

  it('returns not_found if request_id does not point to a deprecation_request', async () => {
    const { getPendingDecisionById } = await import('../../src/graph/queries.js')
    vi.mocked(getPendingDecisionById).mockResolvedValue(null)

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler(mockPg, {
      action: 'approve', request_id: 'q_c99',
      note: 'Approved — obsolete after migration to OAuth2',
    }, peIdentity, testCtx)

    expect(result.status).toBe('not_found')
    expect(result.request_id).toBe('q_c99')
  })

  it('returns already_resolved if the request is not pending', async () => {
    const { getPendingDecisionById } = await import('../../src/graph/queries.js')
    vi.mocked(getPendingDecisionById).mockResolvedValue(
      makeDeprecationRequestRow({ status: 'resolved', resolution: 'approved' })
    )

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler(mockPg, {
      action: 'approve', request_id: 'q_c12',
      note: 'Approved — obsolete after migration to OAuth2',
    }, peIdentity, testCtx)

    expect(result.status).toBe('already_resolved')
    expect(result.resolution).toBe('approved')
  })

  it('returns forbidden for non-PE trying to approve a deprecation request', async () => {
    const { getPendingDecisionById } = await import('../../src/graph/queries.js')
    vi.mocked(getPendingDecisionById).mockResolvedValue(makeDeprecationRequestRow())

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler(mockPg, {
      action: 'approve', request_id: 'q_c12',
      note: 'Approved — obsolete after migration to OAuth2',
    }, juniorIdentity, testCtx)

    expect(result.status).toBe('forbidden')
  })

  it('returns invalid_action for request_changes on a deprecation request', async () => {
    const { getPendingDecisionById } = await import('../../src/graph/queries.js')
    vi.mocked(getPendingDecisionById).mockResolvedValue(makeDeprecationRequestRow())

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler(mockPg, {
      action: 'request_changes', request_id: 'q_c12',
      note: 'Please reconsider this deprecation request',
    }, peIdentity, testCtx)

    expect(result.status).toBe('invalid_action')
  })
})

describe('review() — deprecation request: reject', () => {
  afterEach(() => vi.clearAllMocks())

  it('resolves pending row as rejected without running deprecation logic', async () => {
    const { getPendingDecisionById, resolvePendingDecision, insertVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getPendingDecisionById).mockResolvedValue(makeDeprecationRequestRow())

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler(mockPg, {
      action: 'reject', request_id: 'q_c12',
      note: 'Entry is still needed by the payments domain',
    }, peIdentity, testCtx)

    expect(result.status).toBe('rejected')
    expect(result.request_id).toBe('q_c12')
    expect(insertVersion).not.toHaveBeenCalled()
    expect(resolvePendingDecision).toHaveBeenCalledWith(
      mockPg, 'q_c12',
      expect.objectContaining({ status: 'resolved', resolution: 'rejected' }),
    )
  })
})
```

- [ ] **Step 3: Run tests — confirm they fail**

```bash
npx vitest run tests/tools/review.test.js 2>&1
```

Expected: the new deprecation request tests fail.

- [ ] **Step 4: Add `request_id` to the `review.js` schema**

Open `quorum-mcp/src/tools/review.js`. Update the schema:

```js
export const schema = z.object({
  action:     z.enum(['approve', 'reject', 'request_changes']),
  topic:      z.string().min(1).optional().describe('Target topic (required for DRAFT reviews; omit when using request_id)'),
  key:        z.string().min(1).optional().describe('Target key (required for DRAFT reviews; omit when using request_id)'),
  note:       z.string().min(1).describe('Required: reason for this decision'),
  request_id: z.string().optional().describe('For deprecation requests: the request_id returned by pending()'),
  version:    z.number().int().positive().optional().describe('Specific DRAFT version to review (defaults to latest DRAFT)'),
  session_id: z.string().optional(),
})
```

- [ ] **Step 5: Add new imports to `review.js`**

Add to the existing imports:

```js
import { getCurrentVersion, getSpecificVersion, transitionVersionStatus, getLatestDraftVersion,
         incrementDomainStat, getPendingDecisionById, resolvePendingDecision,
         getNextVersionNumber, insertVersion } from '../graph/queries.js'
import { deleteEpisodeSoft } from '../graph/client.js'
import { buildAuditVersionImpact, buildVersionRecord } from '../governance/provenance.js'
import { TriggeredBy, KnowledgeStatus } from '../graph/schema.js'
```

- [ ] **Step 6: Add the deprecation request branch to the `handler` function**

In `review.js`, immediately after the `enforceReasonRequired` call and before the existing `withAuditPipeline`, add:

```js
  // ── Deprecation request approval path ────────────────────────────────────────
  if (input.request_id) {
    return handleDeprecationRequest(pg, input, identity, ctx)
  }
```

- [ ] **Step 7: Add `handleDeprecationRequest` at the bottom of `review.js`**

```js
// ── Deprecation request handler ───────────────────────────────────────────────

/**
 * Approve or reject a pending deprecation request.
 * Only principal_architect or is_admin may act on these.
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {import('../identity/resolver.js').ResolvedIdentity} identity
 * @param {{ projectId: string, gatewayUrl: string } | null} ctx
 */
async function handleDeprecationRequest(pg, input, identity, ctx) {
  const reviewer = identity?.name ?? 'anonymous'
  const projectId = ctx?.projectId

  if (identity?.role !== 'principal_architect' && !identity?.is_admin) {
    return {
      status:  'forbidden',
      message: 'Only principal_architect can approve or reject deprecation requests.',
      request_id: input.request_id,
    }
  }

  if (input.action === 'request_changes') {
    return {
      status:  'invalid_action',
      message: "request_changes is not valid for deprecation requests. Reject it and ask the requestor to re-submit forget() with a clearer reason.",
      request_id: input.request_id,
    }
  }

  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool:     'review',
      author:   reviewer,
      sessionId: input.session_id,
      governanceData: { action: input.action, note: input.note, request_id: input.request_id },
    },
    async () => {
      const row = await getPendingDecisionById(pg, input.request_id)
      if (!row || row.decision_type !== 'deprecation_request') {
        return {
          result: { status: 'not_found', request_id: input.request_id },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }
      if (row.status !== 'pending') {
        return {
          result: { status: 'already_resolved', request_id: input.request_id, resolution: row.resolution },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      const topic = row.conflict_topic
      const key   = row.conflict_key

      if (input.action === 'approve') {
        const existing = await getCurrentVersion(pg, topic, key, projectId)
        if (!existing) {
          await resolvePendingDecision(pg, input.request_id, {
            status: 'resolved', resolution: 'rejected',
            note: 'Entry no longer ACTIVE at approval time.',
            resolvedBy: reviewer,
          })
          return {
            result: {
              status: 'not_found',
              message: `${topic}:${key} is no longer ACTIVE — possibly already deprecated. Request resolved.`,
            },
            versionImpact: buildAuditVersionImpact([], []),
          }
        }

        const nextVersion = await getNextVersionNumber(pg, topic, key, projectId)

        if (existing.graphiti_episode_id) {
          await deleteEpisodeSoft(existing.graphiti_episode_id, {
            key: `${topic}:${key}`, reason: row.conflict_reason, author: reviewer,
          }, projectId).catch(() => {})
        }

        const versionRecord = buildVersionRecord({
          topic,
          key,
          version:          nextVersion,
          content:          `[DEPRECATED] ${row.conflict_reason}`,
          author:           reviewer,
          triggeredBy:      TriggeredBy.HUMAN_DECISION,
          auditEntryId:     'pre_pending',
          supersedesVersion: existing.version,
          supersedesReason: row.conflict_reason,
          status:           KnowledgeStatus.DEPRECATED,
          projectId,
          agentId:          ctx?.agentId    ?? null,
          sessionId:        ctx?.sessionId  ?? null,
          authorType:       ctx?.authorType ?? 'agent',
        })
        await insertVersion(pg, versionRecord)
        await transitionVersionStatus(
          pg, topic, key, existing.version, KnowledgeStatus.DEPRECATED,
          { version: nextVersion, author: reviewer, at: new Date().toISOString() },
          projectId,
        )

        await resolvePendingDecision(pg, input.request_id, {
          status: 'resolved', resolution: 'approved',
          note: input.note, resolvedBy: reviewer,
        })

        return {
          result: {
            status:              'approved',
            request_id:          input.request_id,
            topic,
            key,
            deprecated_version:  existing.version,
            deprecation_version: nextVersion,
          },
          versionImpact: buildAuditVersionImpact(
            [{ version: nextVersion, status: KnowledgeStatus.DEPRECATED, triggered_by: TriggeredBy.HUMAN_DECISION }],
            [{ version: existing.version, status_before: existing.status }],
          ),
        }
      }

      // reject
      await resolvePendingDecision(pg, input.request_id, {
        status: 'resolved', resolution: 'rejected',
        note: input.note, resolvedBy: reviewer,
      })
      return {
        result: { status: 'rejected', request_id: input.request_id, topic, key },
        versionImpact: buildAuditVersionImpact([], []),
      }
    },
  )
  return pipelineResult.result
}
```

- [ ] **Step 8: Run tests — confirm all pass**

```bash
npx vitest run tests/tools/review.test.js 2>&1
```

Expected: all tests pass.

- [ ] **Step 9: Run full suite**

```bash
npm test 2>&1 | tail -10
```

Expected: all test files pass.

- [ ] **Step 10: Commit**

```bash
git add src/tools/review.js tests/tools/review.test.js
git commit -m "feat(review): add request_id path to approve/reject deprecation requests"
```

---

## Task 4: `skill/references/tool-reference.md` + quorum-mcp docs

**Files:**
- Modify: `quorum-mcp/skill/references/tool-reference.md`

Update the three affected tool entries. No code changes.

- [ ] **Step 1: Update `forget()` section**

In `forget()`, the existing "Requires `principal_architect` role" paragraph changes to:

```markdown
**Non-PE callers:** if your role is below `principal_architect`, `forget()` queues a deprecation request instead of deprecating immediately. Returns `{ status: 'deprecation_requested', request_id }`. A PE can approve or reject it via `review({ action, request_id, note })` or from the dashboard Pending page. One pending request per author per key — re-submitting when one is already queued returns `{ status: 'already_requested' }`.
```

- [ ] **Step 2: Update `pending()` section**

Add to the output description:

```markdown
- `deprecation_requests` — pending deprecation requests from non-PE engineers. Each item: `{ request_id, topic, key, requestor, reason, current_content, current_version, created_at, stale_warning }`. Stale when the ACTIVE version has advanced since the request was submitted.
- `summary` now includes `deprecation_requests` count.
```

- [ ] **Step 3: Update `review()` section**

Add to the Parameters section:

```markdown
- `request_id` — string from `pending().deprecation_requests[n].request_id`. When provided, `topic`/`key` are not required — they are resolved from the pending request. Only `'approve'` and `'reject'` are valid actions for deprecation requests; `'request_changes'` returns `invalid_action`.
```

Add a new Returns entry:

```markdown
**Approve deprecation request:**
```json
{ "status": "approved", "request_id": "q_c12", "topic": "auth", "key": "token-strategy",
  "deprecated_version": 3, "deprecation_version": 4 }
```
**Reject deprecation request:**
```json
{ "status": "rejected", "request_id": "q_c12", "topic": "auth", "key": "token-strategy" }
```

- [ ] **Step 4: Commit**

```bash
git add skill/references/tool-reference.md
git commit -m "docs: update forget/pending/review tool reference for deprecation request workflow"
```

---

## Task 5: Gateway — `POST /api/review/:conflictId` deprecation request handling

**Files:**
- Modify: `gateway/src/routes/dashboard.js`
- Modify: `tests/gateway/dashboard-write.test.js`

Extend the existing `POST /api/review/:conflictId` route to detect `decision_type === 'deprecation_request'` and branch to approve/reject logic that mirrors `POST /api/knowledge/:topic/:key/deprecate`.

- [ ] **Step 1: Write failing tests**

Open `tests/gateway/dashboard-write.test.js`. Add a new `describe` block at the end:

```js
describe('POST /api/review/:conflictId — deprecation request path', () => {
  function makeDeprecationDecision(overrides = {}) {
    return {
      conflict_id:               'q_c12',
      decision_type:             'deprecation_request',
      status:                    'pending',
      q_project_id:              'q_p1',
      q_key_id:                  'q_k1',
      conflict_reason:           'Replaced by new OAuth flow with PKCE',
      existing_content:          'Use JWT for Lambda',
      active_version_at_creation: 3,
      enrichment:                JSON.stringify({ requestor: 'junior-dev' }),
      ...overrides,
    }
  }

  it('returns 403 when non-PE tries to approve a deprecation request', async () => {
    getPendingDecisionById.mockResolvedValue(makeDeprecationDecision())

    const res = await request(app)
      .post('/api/review/q_c12')
      .set('Authorization', 'Bearer test-token')
      .send({ action: 'approve', note: 'Approved after review of the request' })

    // non-PE auth — assume test setup uses engineer role by default
    // (adjust if your test auth helper uses PE role — add a separate engineer-role test)
    expect([400, 403]).toContain(res.status)
  })

  it('returns 400 for request_changes action on a deprecation_request', async () => {
    getPendingDecisionById.mockResolvedValue(makeDeprecationDecision())

    const res = await peRequest(app)
      .post('/api/review/q_c12')
      .set('Authorization', 'Bearer pe-token')
      .send({ action: 'request_changes', note: 'Please clarify your reasoning here' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_action')
  })

  it('returns 200 and runs deprecation transaction on approve', async () => {
    getPendingDecisionById.mockResolvedValue(makeDeprecationDecision())
    getCurrentVersion.mockResolvedValue({ version: 3, status: 'ACTIVE', summary: 'Use JWT', graphiti_episode_id: null })
    getNextVersionNumber.mockResolvedValue(4)

    const res = await peRequest(app)
      .post('/api/review/q_c12')
      .set('Authorization', 'Bearer pe-token')
      .send({ action: 'approve', note: 'Approved — entry is obsolete after the migration' })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('approved')
    expect(res.body.request_id).toBe('q_c12')
    expect(transitionVersionStatus).toHaveBeenCalledWith(
      expect.anything(), expect.stringContaining('_v3'), 'DEPRECATED', null
    )
    expect(resolvePendingDecision).toHaveBeenCalledWith(
      expect.anything(), 'q_c12',
      expect.objectContaining({ status: 'resolved', resolution: 'approved' })
    )
  })

  it('returns 200 and resolves row as rejected on reject', async () => {
    getPendingDecisionById.mockResolvedValue(makeDeprecationDecision())

    const res = await peRequest(app)
      .post('/api/review/q_c12')
      .set('Authorization', 'Bearer pe-token')
      .send({ action: 'reject', note: 'Entry still needed by the payments domain' })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('rejected')
    expect(resolvePendingDecision).toHaveBeenCalledWith(
      expect.anything(), 'q_c12',
      expect.objectContaining({ status: 'resolved', resolution: 'rejected' })
    )
    expect(transitionVersionStatus).not.toHaveBeenCalled()
  })
})
```

> **Note on test helpers:** The existing `dashboard-write.test.js` has a `peRequest` helper (or similar) that sends PE-role JWT. Use whatever pattern already exists in the file. Look at how other PE-only tests authenticate.

- [ ] **Step 2: Run tests — confirm they fail**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram
npx vitest run tests/gateway/dashboard-write.test.js 2>&1 | tail -30
```

Expected: the new `deprecation request path` tests fail.

- [ ] **Step 3: Add the deprecation request branch to `POST /api/review/:conflictId` in `dashboard.js`**

Open `gateway/src/routes/dashboard.js`. Find the `POST /api/review/:conflictId` route. After loading the decision row and checking the project scope (around line 671), add this branch before the existing conflict-review logic:

```js
    // ── Deprecation request branch ──────────────────────────────────────────────
    if (decision.decision_type === 'deprecation_request') {
      if (action === 'request_changes') {
        return res.status(400).json({
          error: 'invalid_action',
          message: "request_changes is not valid for deprecation requests. Reject it and ask the requestor to re-submit forget() with a clearer reason.",
        })
      }

      const keyRow = await pool.query(
        `SELECT topic, key FROM q_keys WHERE q_key_id = $1 LIMIT 1`,
        [decision.q_key_id],
      )
      const depTopic = keyRow.rows[0]?.topic ?? null
      const depKey   = keyRow.rows[0]?.key   ?? null

      if (action === 'reject') {
        await resolvePendingDecision(pool, conflictId, {
          status: 'resolved', resolution: 'rejected',
          note, resolvedBy: reviewer,
        })
        await writeAuditEntry(pool, {
          operation:    'OUTCOME',
          tool:         'dashboard-review-deprecation',
          author:       reviewer,
          author_role:  reviewerRole,
          q_project_id: qProjectId,
          governance_json: { action, note, request_id: conflictId },
          outcome_json:    { status: 'rejected', topic: depTopic, key: depKey },
          version_impact:  { versions_created: [], versions_superseded: [] },
        })
        return res.json({ status: 'rejected', request_id: conflictId, topic: depTopic, key: depKey, reviewer, note })
      }

      // approve — run deprecation transaction
      const currentEntry = await getCurrentVersion(pool, decision.q_key_id)
      if (!currentEntry) {
        await resolvePendingDecision(pool, conflictId, {
          status: 'resolved', resolution: 'rejected',
          note: 'Entry no longer ACTIVE at approval time.',
          resolvedBy: reviewer,
        })
        return res.status(404).json({ error: 'not_found', message: `${depTopic}:${depKey} is no longer ACTIVE.` })
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const currentVersionId = `${decision.q_key_id}_v${currentEntry.version}`
        await transitionVersionStatus(client, currentVersionId, 'DEPRECATED', null)

        await resolvePendingDecision(client, conflictId, {
          status: 'resolved', resolution: 'approved',
          note, resolvedBy: reviewer,
        })

        await client.query('COMMIT')
      } catch (txErr) {
        await client.query('ROLLBACK')
        throw txErr
      } finally {
        client.release()
      }

      await writeAuditEntry(pool, {
        operation:    'OUTCOME',
        tool:         'dashboard-review-deprecation',
        author:       reviewer,
        author_role:  reviewerRole,
        q_project_id: qProjectId,
        author_type:  'human',
        triggered_by: 'dashboard',
        governance_json: { action, note, request_id: conflictId },
        outcome_json:    { status: 'approved', topic: depTopic, key: depKey, version: currentEntry.version },
        version_impact:  {
          versions_created:    [],
          versions_superseded: [`${decision.q_key_id}_v${currentEntry.version}`],
        },
      })

      return res.json({
        status:     'approved',
        request_id: conflictId,
        topic:      depTopic,
        key:        depKey,
        reviewer,
        note,
      })
    }
    // ── End deprecation request branch ──────────────────────────────────────────
```

Also ensure `getCurrentVersion` and `getNextVersionNumber` are imported at the top of `dashboard.js` — check existing imports and add if missing.

- [ ] **Step 4: Run tests — confirm all pass**

```bash
npx vitest run tests/gateway/dashboard-write.test.js 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 5: Run full gateway tests**

```bash
npm test 2>&1 | tail -10
```

Expected: all test files pass.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/routes/dashboard.js tests/gateway/dashboard-write.test.js
git commit -m "feat(gateway): handle deprecation_request type in POST /api/review/:conflictId"
```

---

## Task 6: Dashboard — `api/pending.js` mutation + `Pending.jsx` section

**Files:**
- Modify: `dashboard/src/api/pending.js`
- Modify: `dashboard/src/pages/Pending.jsx`

Add a `useReviewDeprecationRequest` TanStack Query mutation and wire it to a new Deprecation Requests section in the Pending page.

- [ ] **Step 1: Add `useReviewDeprecationRequest` to `dashboard/src/api/pending.js`**

Open `dashboard/src/api/pending.js`. Add after the existing `useReview` mutation:

```js
export function useReviewDeprecationRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ requestId, action, note }) =>
      apiFetch(`/api/review/${encodeURIComponent(requestId)}`, {
        method: 'POST',
        body:   JSON.stringify({ action, note }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pending'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}
```

- [ ] **Step 2: Update `Pending.jsx` imports**

Open `dashboard/src/pages/Pending.jsx`. Update the import from `../api/pending.js`:

```js
import { usePending, useDrafts, usePromoteDraft, useReviewDeprecationRequest } from '../api/pending.js'
```

- [ ] **Step 3: Partition the pending data and add state**

In the `Pending` component, update the data parsing and add state for the deprecation request dialogs:

```js
const [promoteTarget,         setPromoteTarget]         = useState(null)
const [deprecationActionTarget, setDeprecationActionTarget] = useState(null) // { request, action }

const reviewDeprecation = useReviewDeprecationRequest()

// Partition pending rows by decision_type
const allPending = pendingData?.decisions ?? pendingData ?? []
const decisions         = allPending.filter(d => (d.decision_type ?? 'conflict') === 'conflict')
const deprecationReqs   = allPending.filter(d => d.decision_type === 'deprecation_request')
const drafts            = draftsData?.drafts ?? []

const isEmpty = !decisions.length && !drafts.length && !deprecationReqs.length
```

- [ ] **Step 4: Add the Deprecation Requests section to the JSX**

Add the following section after the existing "Conflict decisions" section (before the "Promote confirm dialog"):

```jsx
{/* ── Deprecation requests ──────────────────────────────────────── */}
{deprecationReqs.length > 0 && (
  <section className="space-y-3">
    <div className="flex items-center justify-between">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        Deprecation requests
      </h2>
      <span className="text-xs text-gray-400">
        {deprecationReqs.length} pending
      </span>
    </div>

    <div className="space-y-2">
      {deprecationReqs.map((req) => (
        <div
          key={req.conflict_id}
          className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-2"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <p className="font-mono text-sm text-blue-400 truncate">
                {req.conflict_topic}:{req.conflict_key}
              </p>
              <p className="text-xs text-gray-500">
                Requested by <span className="font-medium text-gray-700 dark:text-gray-300">
                  {req.enrichment?.requestor ?? 'unknown'}
                </span>
                {' · '}{fmtDate(req.created_at)}
              </p>
              {req.stale_warning && (
                <span className="inline-flex items-center rounded-full bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                  STALE
                </span>
              )}
            </div>
            {isPE && (
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setDeprecationActionTarget({ request: req, action: 'reject' })}
                  className="rounded px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 border border-red-200 dark:border-red-800"
                >
                  Reject
                </button>
                <button
                  onClick={() => setDeprecationActionTarget({ request: req, action: 'approve' })}
                  className="rounded px-2 py-1 text-xs font-medium text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 border border-green-200 dark:border-green-800"
                >
                  Approve
                </button>
              </div>
            )}
          </div>

          <div className="text-xs space-y-1">
            <p className="text-gray-600 dark:text-gray-400">
              <span className="font-medium text-gray-700 dark:text-gray-300">Reason: </span>
              {req.conflict_reason}
            </p>
            {req.existing_content && (
              <p className="text-gray-500 dark:text-gray-500 truncate">
                <span className="font-medium">Current: </span>
                {req.existing_content}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>

    {!isPE && (
      <p className="text-xs text-gray-500">
        These requests are awaiting approval by a principal architect.
      </p>
    )}
  </section>
)}
```

- [ ] **Step 5: Add the ConfirmDialog for deprecation request approve/reject**

Add after the existing "Promote confirm dialog" block:

```jsx
{/* ── Deprecation request approve/reject dialog ──────────────── */}
{deprecationActionTarget && (
  <ConfirmDialog
    open={Boolean(deprecationActionTarget)}
    title={deprecationActionTarget.action === 'approve' ? 'Approve Deprecation?' : 'Reject Deprecation Request?'}
    body={
      deprecationActionTarget.action === 'approve'
        ? `This will permanently deprecate ${deprecationActionTarget.request.conflict_topic}:${deprecationActionTarget.request.conflict_key}. The entry will no longer appear in search or recall results.`
        : `Reject the deprecation request for ${deprecationActionTarget.request.conflict_topic}:${deprecationActionTarget.request.conflict_key}? The requestor will need to re-submit with a new reason.`
    }
    confirmLabel={deprecationActionTarget.action === 'approve' ? 'Approve & Deprecate' : 'Reject'}
    destructive={deprecationActionTarget.action === 'approve'}
    noteLabel={deprecationActionTarget.action === 'approve' ? 'Reason for approving' : 'Reason for rejecting'}
    noteRequired={true}
    onConfirm={async (note) => {
      await reviewDeprecation.mutateAsync({
        requestId: deprecationActionTarget.request.conflict_id,
        action:    deprecationActionTarget.action,
        note,
      })
      reviewDeprecation.reset()
      setDeprecationActionTarget(null)
    }}
    onCancel={() => {
      reviewDeprecation.reset()
      setDeprecationActionTarget(null)
    }}
    isSubmitting={reviewDeprecation.isPending}
    error={reviewDeprecation.error?.message ?? null}
  />
)}
```

- [ ] **Step 6: Start dev server and verify UI manually**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram
npm run dev:gateway &
cd dashboard && npm run dev
```

Open `http://localhost:3002`. Navigate to Pending. Confirm:
- When no deprecation requests exist, the section is hidden.
- When requests exist, the section shows with topic:key, requestor, reason, and current content.
- Approve/Reject buttons open `ConfirmDialog` with a mandatory note.
- STALE badge appears for stale requests.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/api/pending.js dashboard/src/pages/Pending.jsx
git commit -m "feat(dashboard): add deprecation requests section to pending page"
```

---

## Task 7: OpenAPI spec + CLAUDE.md docs

**Files:**
- Modify: `gateway/openapi.yaml`
- Modify: `gateway/CLAUDE.md`
- Modify: `engram/CLAUDE.md`

Documentation-only task. No tests.

- [ ] **Step 1: Update `gateway/openapi.yaml` — extend `POST /api/review/:conflictId`**

Find the `POST /api/review/{conflictId}` entry. Update the `requestBody` schema to include `request_id`:

```yaml
requestBody:
  required: true
  content:
    application/json:
      schema:
        type: object
        required: [action, note]
        properties:
          action:
            type: string
            enum: [approve, reject, request_changes]
            description: >
              For deprecation requests (when request_id is provided), only
              'approve' and 'reject' are valid. 'request_changes' returns 400.
          note:
            type: string
            minLength: 10
            description: Mandatory reason (≥10 chars — Constitutional Rule 3)
          request_id:
            type: string
            description: >
              When present, handles a deprecation request (decision_type=deprecation_request)
              instead of a conflict decision. Resolved from pending().deprecation_requests[n].request_id.
```

Update the `200` response to document both outcome shapes:

```yaml
'200':
  description: >
    Review outcome. Shape varies by decision type:
    - Conflict/DRAFT: existing shape with conflict_id, topic, key, version, reviewer, note
    - Deprecation request (approve): { status: 'approved', request_id, topic, key, reviewer, note }
    - Deprecation request (reject): { status: 'rejected', request_id, topic, key, reviewer, note }
```

Also update the `400` description: `Invalid action, note too short, or request_changes on a deprecation_request`

- [ ] **Step 2: Update `GET /pg/pending` description in `openapi.yaml`** (if documented) to note that rows now include `decision_type` field and can be `'conflict'` or `'deprecation_request'`.

- [ ] **Step 3: Update `gateway/CLAUDE.md`**

In the `dashboard.js` route table entry, update the description of `POST /api/review/:conflictId`:

```
POST /api/review/:conflictId — approve/reject/request_changes a conflict decision OR approve/reject
a deprecation_request (when decision.decision_type === 'deprecation_request'; 'request_changes' returns 400).
```

- [ ] **Step 4: Update `engram/CLAUDE.md`**

In the "Built and working" section, update the knowledge deprecation bullet to include the new workflow:

```
- Knowledge deprecation request workflow: non-PE engineers submit forget() as a pending request
  (decision_type='deprecation_request' in pending_decisions); PE approves/rejects via review()
  (MCP, request_id parameter) or dashboard Pending page. Approved requests run full deprecation
  transaction. pending() surfaces requests in new deprecation_requests section.
```

- [ ] **Step 5: Commit**

```bash
git add gateway/openapi.yaml gateway/CLAUDE.md CLAUDE.md
git commit -m "docs: update openapi spec and claude.md for deprecation request workflow"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Non-PE `forget()` queues instead of `forbidden` | Task 1 |
| Deduplication (one request per author per key) | Task 1 |
| `pending()` `deprecation_requests` section | Task 2 |
| Staleness detection for deprecation requests | Task 2 |
| `summary.deprecation_requests` count | Task 2 |
| `review()` `request_id` param, approve path | Task 3 |
| `review()` reject path | Task 3 |
| `review()` forbidden for non-PE | Task 3 |
| `request_changes` returns `invalid_action` | Task 3 |
| skill/tool-reference.md updated | Task 4 |
| Gateway `POST /api/review/:conflictId` deprecation branch | Task 5 |
| Dashboard `useReviewDeprecationRequest` mutation | Task 6 |
| `Pending.jsx` Deprecation Requests section | Task 6 |
| Stale badge in dashboard | Task 6 |
| Approve/Reject ConfirmDialog | Task 6 |
| OpenAPI spec updated | Task 7 |
| Both CLAUDE.md updated | Task 7 |

**Placeholder scan:** no TBD, no "add validation", no "similar to Task N" without code. All code blocks are complete.

**Type consistency:**
- `request_id` used consistently across Tasks 1–6 (not `requestId` in MCP, `requestId` only in the dashboard `mutationFn` payload key which is camelCase JS — correct).
- `conflict_id` column name used in gateway; `request_id` is the user-facing field name returned in responses — consistent.
- `resolvePendingDecision` signature used identically in Tasks 3 and 5: `(pg/client, conflictId, { status, resolution, note, resolvedBy })`.
