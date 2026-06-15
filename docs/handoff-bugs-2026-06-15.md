# Bug Handoff — recheck-conflicts & conflict detection gaps

**Date:** 2026-06-15  
**Assigned to:** Codex  
**Context:** Analysis of the `recheck-conflicts.js` job and the MCP `remember()` conflict detection path revealed 6 bugs. One is fixed; five need implementation. This document is the complete brief for Codex.

---

## Summary Table

| ID | Severity | Status | File | Description |
|----|----------|--------|------|-------------|
| BUG-01 | High | ✅ Fixed (`sha-2293c58`) | `scripts/recheck-conflicts.js` | Promote path created dual ACTIVE versions |
| BUG-02 | High | ✅ Fixed locally (2026-06-15) | `scripts/recheck-conflicts.js` | Conflict path now inserts `pending_decisions` row inside the DRAFT downgrade transaction |
| BUG-03 | Low | ✅ Fixed locally (2026-06-15) | `scripts/recheck-conflicts.js` | Audit `version_impact` now records the superseded ACTIVE version when promotion swaps versions |
| BUG-04 | Medium | ✅ Fixed locally (2026-06-15) | `scripts/recheck-conflicts.js` | `detectConflict()` now receives `projectId` + `globals` loaded from `project_configs` |
| BUG-05 | High | ❌ Data fix needed | PostgreSQL `knowledge_versions` | 5 prod entries with dual ACTIVE versions |
| BUG-06 | Medium | ❌ Design/code fix needed | `quorum-mcp/src/tools/remember.js` | Incoming knowledge is discarded on conflict detection |

---

## BUG-01 — Dual ACTIVE versions after recheck promotion

**Status:** Fixed in `sha-2293c58`. Needs to be deployed to prod.

**Root cause:** The promote path in `scripts/recheck-conflicts.js` (line 145) did a simple `UPDATE status=ACTIVE WHERE version_id=$2` without first superseding the existing ACTIVE version. The `storePendingConflictCheck()` path intentionally leaves v1 ACTIVE while v2 is in `PENDING_CONFLICT_CHECK`, so the recheck job must complete the supersede swap atomically.

**Fix applied:** The promote block now uses a transaction: first supersede any existing ACTIVE sibling (same `q_key_id` + `q_project_id`), then set the pending version to ACTIVE. See `scripts/recheck-conflicts.js:127-156`.

**Deploy task:** CI needs to build `sha-2293c58` → repin `GATEWAY_TAG` via `quorum-update` skill.

---

## BUG-02 — Conflict detected during recheck but no `pending_decisions` row

**Status:** Fixed locally on 2026-06-15. Still needs deployment with the recheck job image.

**File:** `quorum/scripts/recheck-conflicts.js:106-113`

**Root cause:** The job's own docstring at line 15 says:

```
c. If conflict detected → insert pending_decisions entry, leave as DRAFT
```

But the code only sets the status to DRAFT:

```js
// CURRENT (buggy):
if (conflictResult.conflict) {
  await pool.query(
    `UPDATE knowledge_versions SET status = $1 WHERE version_id = $2`,
    [KnowledgeStatus.DRAFT, row.version_id],
  )
  conflicted++
}
```

No `pending_decisions` row is inserted. As a result:
- The conflict is invisible in the dashboard Pending tab
- The `pending()` MCP tool does not surface it
- A PE reviewer has no idea there is a conflict to review

**Fix applied:** The recheck row processor now opens a transaction, loads the currently ACTIVE sibling, downgrades the deferred row to `DRAFT`, and inserts a `pending_decisions` record directly in PostgreSQL before committing. This preserves reviewer-visible conflict state even though the cron job has no gateway JWT.

**Option A (preferred) — Direct PG insert:**
```js
if (conflictResult.conflict) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE knowledge_versions SET status = $1 WHERE version_id = $2`,
      [KnowledgeStatus.DRAFT, row.version_id],
    )
    const conflictId = `recheck_conflict_${row.version_id}_${Date.now()}`
    await client.query(
      `INSERT INTO pending_decisions
         (conflict_id, conflict_topic, conflict_key, active_version_at_creation,
          incoming_content, conflict_reason, more_pending_same_key, project_id, created_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, NOW(), 'pending')`,
      [
        conflictId,
        row.topic,
        row.key,
        row.version,                   // v2 is the "incoming" conflict
        row.summary,
        conflictResult.reason ?? 'Conflict detected by recheck job',
        row.q_project_id,
      ],
    )
    await client.query('COMMIT')
    console.error(`[recheck-conflicts] CONFLICT for ${row.topic}:${row.key} v${row.version} — inserted pending_decisions ${conflictId}`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  conflicted++
}
```

**Option B — HTTP gateway:** Use `fetch(QUORUM_GATEWAY_URL + '/pg/pending', { method: 'POST', ... })` but requires an auth token. Option A is simpler.

Note: `existing_content` is not easily available in the recheck job (it only has the pending row, not the v1 row). You would need to query the ACTIVE v1 content separately. The `conflict_id` format should be distinct from the MCP-generated `conflict_{uuid}` pattern.

---

## BUG-03 — Audit `version_impact` always empty

**Status:** Fixed locally on 2026-06-15.

**File:** `quorum/scripts/recheck-conflicts.js:171`

**Root cause:** The audit entry created after each recheck has:
```js
'{"versions_created":[],"versions_superseded":[]}'::jsonb,
```

After the BUG-01 fix, the promote path DOES supersede the v1 version. The audit entry should reflect that. This makes it impossible to reconstruct what happened from the audit log alone.

**Fix applied:** The ACTIVE-sibling supersede update now uses `RETURNING version_id`. The returned version id is fed into the audit insert via `buildVersionImpact()`, so the recheck audit trail now records whether promotion also superseded a prior ACTIVE row.

---

## BUG-04 — `detectConflict()` missing `projectId` and `globals`

**Status:** Fixed locally on 2026-06-15.

**File:** `quorum/scripts/recheck-conflicts.js:94`

**Current call:**
```js
const conflictResult = await detectConflict(row.summary, row.topic, row.key).catch(...)
```

**MCP `remember.js` call (correct signature):**
```js
detectConflict(input.content, input.topic, input.key, domain, pg, projectId, globals)
```

The `globals` parameter controls federation-scoped conflict checking — it tells Graphiti to also search linked global catalog namespaces (`getConfig()?.globals ?? []`). Without it, recheck only checks within the project's own graph, missing contradictions against global catalog standards.

The recheck job has `row.q_project_id` available. It does not currently load the project config.

**Fix applied:** `getProjectGlobals()` now loads `project_configs.config_json.globals` for the row's `q_project_id`, and the recheck path passes `(summary, topic, key, topic, null, q_project_id, globals)` into `detectConflict()`. This matches the scoped federation contract already covered by `tests/gateway/shared-conflict.test.js`.

---

## BUG-05 — 5 prod entries with dual ACTIVE versions

**Status:** Data fix needed. Requires user approval before running on prod.

**Root cause:** BUG-01 ran on prod before `sha-2293c58` fix. The 5 entries that were promoted by the recheck job on 2026-06-15 have both v1 and v2 as ACTIVE.

**Affected entries:**
- `arch:pages-router`
- `infra:rate-limit-tiers`
- `auth:csrf-token`
- `db:prisma-singleton`
- `security:no-cdn`

**SQL fix (safe — idempotent):**
```sql
UPDATE knowledge_versions SET status = 'SUPERSEDED'
WHERE (q_key_id, q_project_id) IN (
  SELECT q_key_id, q_project_id FROM knowledge_versions
  WHERE status = 'ACTIVE'
  GROUP BY q_key_id, q_project_id HAVING COUNT(*) > 1
)
AND status = 'ACTIVE'
AND version < (
  SELECT MAX(version) FROM knowledge_versions v2
  WHERE v2.q_key_id = knowledge_versions.q_key_id
    AND v2.q_project_id = knowledge_versions.q_project_id
    AND v2.status = 'ACTIVE'
);
```

This sets the lower-versioned ACTIVE row to SUPERSEDED for any key with more than one ACTIVE version. Idempotent — safe to re-run.

**Before running:** Confirm with the user; this modifies prod data.

---

## BUG-06 — Incoming knowledge discarded when conflict detected (design gap)

**Status:** Design/code fix needed. Medium priority.

**File:** `quorum-mcp/src/tools/remember.js:165-226`

**Root cause:** When `detectConflict()` finds a conflict and `resolution.action === 'human_required'`, the current code:
1. Inserts a `pending_decisions` row ✅
2. Returns `{ status: 'conflict_detected', message: 'Human decision required...' }` ✅
3. Does **not** store the incoming content anywhere ❌

The user is left holding a `conflict_id` but the knowledge itself is lost unless they call `remember()` again with a resolution.

**Contrast with `storePendingConflictCheck()` (Graphiti-down path):** When Graphiti is unavailable, the incoming content IS stored as `PENDING_CONFLICT_CHECK`. This is the correct behaviour — the content is preserved while the conflict is queued for review.

**User expectation (the "library" model):** Knowledge should always be stored. If a conflict is detected, store the incoming entry as DRAFT and surface the conflict for review. Don't discard the content.

**Proposed fix:** When conflict requires human resolution, store the incoming content as `DRAFT` before returning:

```js
if (resolution.action === 'human_required') {
  const conflictId = `conflict_${uuidv4()}`

  // Generate enrichment (existing code)...

  // NEW: Store incoming content as DRAFT so it is not lost
  const draftResult = await storeSupersede(
    pg, input, author, confidence, tags, triggeredBy, 'DRAFT',
    identity?.role, projectId, ctx, { pre_audit_id: conflictId },
  )

  await insertPendingDecision(pg, {
    conflict_id: conflictId,
    ...,
    // link the pending_decisions to the stored DRAFT so review() can promote/reject it
    incoming_version_id: draftResult?.version_id ?? null,
  })

  return {
    result: {
      status: 'conflict_detected',
      conflict_id: conflictId,
      knowledge_status: 'DRAFT',     // NEW — tell the caller the content was saved
      ...
      message: 'Conflict detected. Knowledge stored as DRAFT pending human review. ...',
    },
    ...
  }
}
```

**Schema change required:** `pending_decisions` needs an `incoming_version_id` column so `review()` can promote the draft to ACTIVE (approve) or set it to REJECTED (reject).

**Scope note:** This is a multi-file change touching:
- `quorum-mcp/src/tools/remember.js`
- `quorum/gateway/src/routes/pg.js` (pending_decisions schema + `POST /pg/pending`)
- `quorum/gateway/src/routes/dashboard.js` (`POST /api/review/:conflictId` — needs to promote/reject the stored draft)
- `helm/quorum/files/init-db.sql` (add `incoming_version_id` column)
- Gateway + MCP vendored `queries.js` copies

Write a failing test first before implementing (TDD per `CLAUDE.md`).

---

## Testing Guidance for Codex

For BUG-02, BUG-03, BUG-04 (all in `recheck-conflicts.js`):
- Unit tests: `tests/scripts/recheck.test.js` now covers `getProjectGlobals()`, conflict-path `pending_decisions` creation, and promotion-path `version_impact`
- `processPendingRow()` and `buildVersionImpact()` are exported so the job can be tested without auto-running the cron on import
- E2E remains valuable later: seed a `PENDING_CONFLICT_CHECK` row (S-17.2 pattern), run the job, and verify Pending + audit state

For BUG-06:
- TDD: write a failing test in `quorum-mcp/tests/tools/remember.test.js` first
- The test should assert: after a conflict-detected response, calling `GET /api/knowledge?domain=X` still shows a DRAFT entry with the incoming content
- This is a breaking change to the `conflict_detected` response shape — update `quorum-mcp/tests/tools/remember.test.js` assertions

---

## "Sun rises from east/west" — What happened

The user called `remember()` twice via MCP:
1. `remember("astronomy", "sun-direction", "Sun rises from east")` → stored as ACTIVE (no conflict)
2. `remember("astronomy", "sun-direction", "Sun rises from west")` → `detectConflict()` returned `conflict: true` → returned `{ status: 'conflict_detected', message: 'Human decision required...' }` → content **not stored**

From the user's perspective this looked like a failure because the second knowledge entry was rejected. This is BUG-06 — the "library" fix would have stored it as DRAFT and shown the conflict for review.

**Workaround until fix is shipped:** After calling `remember()` and seeing `conflict_detected`, call `review()` with the `conflict_id` and `resolution: 'supersede'` (with a reason) to complete the write.

---

## Deploy Order for Codex

1. **BUG-05 data fix** (prod SQL) — needs user sign-off, run first before more data accumulates
2. **BUG-02 + BUG-03 + BUG-04** (recheck-conflicts.js) — code only, deploy together in one PR
3. **BUG-06** (remember.js + pending_decisions schema) — largest change, separate PR with TDD
4. **BUG-01** is already fixed; just needs `sha-2293c58` deployed via `quorum-update`
