# Deprecation Request Workflow Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow non-PE engineers to submit deprecation requests via `forget()` that queue for PE approval, rather than receiving a hard `forbidden` response.

**Architecture:** Reuse the existing `pending_decisions` table with a new `decision_type = 'deprecation_request'`. Extend `pending()` to surface requests, `review()` to approve/reject them, the dashboard `/api/pending` route and `Pending.jsx` to show them alongside conflicts and DRAFTs.

**Tech Stack:** PostgreSQL (`pending_decisions` table), Express gateway, React dashboard, quorum-mcp MCP tools (`forget`, `pending`, `review`).

---

## Data Model

No migration required. The `pending_decisions` table already has all necessary columns.

### Column mapping for `decision_type = 'deprecation_request'`

| Column | Value |
|---|---|
| `decision_type` | `'deprecation_request'` |
| `conflict_reason` | The `reason` string from `forget()` |
| `existing_content` | Snapshot of `summary` from the ACTIVE version at request time |
| `active_version_at_creation` | ACTIVE version number at request time (used for staleness detection) |
| `incoming_content` | `null` (not applicable) |
| `enrichment` | `{ requestor: author }` — requestor identity stored in existing JSONB column |
| `resolved_by` | GitHub username of the PE who approved or rejected |
| `resolution` | `'approved'` \| `'rejected'` |
| `resolution_note` | PE's mandatory review note (≥10 chars) |

The `q_conflict_seq` sequence issues request IDs (`q_c12`, etc.) — same namespace as conflict IDs. No new sequence needed.

---

## `forget()` — Changed Behaviour for Non-PE Callers

**Current:** non-PE → `{ status: 'forbidden', message: '...' }`

**New:** non-PE → check ACTIVE entry exists → check for duplicate pending request → queue → return `deprecation_requested`.

### Flow

```
forget(topic, key, reason):

  [role guard — unchanged for PE / is_admin, they run existing deprecation logic]

  if identity.role !== 'principal_architect' AND NOT identity.is_admin:

    enforceReasonRequired(reason)          ← Constitutional Rule 3 still applies

    existing = getCurrentVersion(topic, key, projectId)
    if !existing:
      return { status: 'not_found', topic, key }

    // Deduplication: one pending request per requestor per key
    existing_requests = getPendingDecisions({ decisionType: 'deprecation_request',
                                              qKeyId, statuses: ['pending'] })
    if any existing_request.enrichment.requestor === author:
      return { status: 'already_requested', request_id: existing_request.conflict_id,
               topic, key,
               message: 'You already have a pending deprecation request for this entry.' }

    conflictId = insertPendingDecision({
      decision_type:               'deprecation_request',
      q_key_id,
      q_project_id,
      existing_content:            existing.summary ?? existing.content,
      active_version_at_creation:  existing.version,
      conflict_reason:             reason,
      enrichment:                  { requestor: author },
    })

    [write INTENT + OUTCOME audit pair]
    // tool: 'forget', triggered_by: 'engineer_decision', outcome: 'deprecation_requested'

    return {
      status:     'deprecation_requested',
      request_id: conflictId,
      topic,
      key,
      message: 'Deprecation request submitted. A principal_architect will review it in pending().',
    }
```

### What does NOT change

- PE and `is_admin` callers run the existing full deprecation path unchanged.
- `enforceNoHardDelete()` still called for all callers.
- `enforceReasonRequired()` still called for all callers — a non-PE must still provide a meaningful reason.

---

## `pending()` — New `deprecation_requests` Section

### Output shape addition

```json
{
  "conflict_briefs":       [...],
  "draft_reviews":         [...],
  "deprecation_requests":  [
    {
      "request_id":      "q_c12",
      "topic":           "auth",
      "key":             "token-strategy",
      "requestor":       "junior-dev",
      "reason":          "Replaced by new OAuth approach with PKCE",
      "current_content": "Use JWT for Lambda, sessions for ECS",
      "current_version": 3,
      "created_at":      "2026-05-19T10:00:00Z",
      "stale_warning":   null
    }
  ],
  "summary": {
    "total_pending":        4,
    "conflicts":            1,
    "drafts":               2,
    "deprecation_requests": 1
  }
}
```

### Staleness detection

Same pattern as conflict staleness. When fetching each request:

1. Re-fetch the current ACTIVE version for the topic:key.
2. If `current_version > active_version_at_creation` → the entry was updated since the request was queued. Set `stale_warning`: `"Active version advanced from vN to vM since this request was created. Review is now against the current active version."`
3. If the entry is already `DEPRECATED` → set `stale_warning`: `"This entry was deprecated after the request was submitted."` and mark the pending_decision `stale`.
4. Persist the stale state via `markPendingDecisionStale()` (already exists).

### `pending()` schema change

Add `deprecation_requests` to the `include_stale` filter — same boolean gates stale display for all three sections.

---

## `review()` — Approve / Reject Deprecation Requests

### New parameter

`request_id` (optional string). When present, `review()` handles a deprecation request instead of a DRAFT.

```
review({ action, request_id, note }, identity):

  row = getPendingDecisionById(request_id)
  if !row OR row.decision_type !== 'deprecation_request':
    return { status: 'not_found', request_id }
  if row.status !== 'pending':
    return { status: 'already_resolved', request_id, resolution: row.resolution }

  enforceReasonRequired(note)    ← Constitutional Rule 3

  if action === 'approve':
    [run full forget() internal logic as PE]
    // insertVersion (DEPRECATED) + transitionVersionStatus + Graphiti soft-delete
    // author = PE's identity.name (not the original requestor)
    resolvePendingDecision(request_id, { status: 'resolved', resolution: 'approved',
                                         note, resolvedBy: pe_author })
    [write INTENT + OUTCOME audit pair]
    // tool: 'review', triggered_by: 'human_decision', outcome: 'approved'
    return { status: 'approved', request_id, topic, key,
             deprecated_version, deprecation_version }

  if action === 'reject':
    resolvePendingDecision(request_id, { status: 'resolved', resolution: 'rejected',
                                         note, resolvedBy: pe_author })
    [write INTENT + OUTCOME audit pair]
    return { status: 'rejected', request_id, topic, key }
```

### Constraints

- Only `'approve'` and `'reject'` are valid actions for deprecation requests. `'request_changes'` is not supported (the requestor should re-submit `forget()` with a better reason if rejected).
- `review()` without `request_id` continues to operate on DRAFT knowledge entries — no change to existing behaviour.
- The existing `(action, topic, key, note)` signature still works for DRAFTs. `request_id` is additive.

---

## Gateway Routes

### `GET /api/pending`

Extend response to include `deprecation_requests` array. Uses same query pattern as conflicts (`decision_type = 'deprecation_request'`, `status = 'pending'`), enriched with staleness detection.

### `POST /api/review/:conflictId`

Already handles conflict resolution. Extend: when loaded row has `decision_type === 'deprecation_request'`:

- Only `approve` and `reject` are accepted (400 for `request_changes`).
- `approve` runs the full deprecation transaction (same logic as `POST /api/knowledge/:topic/:key/deprecate`) and resolves the pending row atomically.
- `reject` resolves the pending row with `resolution: 'rejected'`.
- Both paths require PE role (`requirePrincipalArchitect`).
- Both paths write audit entries (`tool: 'dashboard-review-deprecation'`, `author_type: 'human'`, `triggered_by: 'dashboard'`).

---

## Dashboard — `Pending.jsx`

Add a **Deprecation Requests** section after Conflicts and DRAFTs.

### Card layout

```
┌─ Deprecation Requests (1) ──────────────────────────────────────┐
│  auth:token-strategy                            [STALE? badge]  │
│  Requested by junior-dev · 2 days ago                           │
│  Reason: "Replaced by new OAuth approach with PKCE"             │
│  Current content: "Use JWT for Lambda, sessions for ECS..."     │
│                                          [Reject]  [Approve]    │
└─────────────────────────────────────────────────────────────────┘
```

- Section header hidden when `deprecation_requests.length === 0`.
- Approve/Reject are PE-only. Both open a `ConfirmDialog` (existing component) requiring a mandatory note ≥10 chars.
- Stale requests show an amber `STALE` badge and dim the action buttons with a tooltip.
- API calls: `POST /api/review/:requestId` with `{ action: 'approve'|'reject', note }`.
- On success: invalidate the `/api/pending` query (existing TanStack Query pattern).

### API client

New function in `dashboard/src/api/knowledge.js` (or a new `pending.js`):

```js
export function reviewDeprecationRequest(requestId, action, note) {
  return apiFetch(`/api/review/${encodeURIComponent(requestId)}`,
    { method: 'POST', body: JSON.stringify({ action, note }) })
}
```

---

## Audit Trail

| Event | `tool` | `triggered_by` | `author_type` |
|---|---|---|---|
| Non-PE submits request (MCP) | `forget` | `engineer_decision` | `agent` |
| PE approves request (MCP) | `review` | `human_decision` | `agent` |
| PE rejects request (MCP) | `review` | `human_decision` | `agent` |
| PE approves request (dashboard) | `dashboard-review-deprecation` | `dashboard` | `human` |
| PE rejects request (dashboard) | `dashboard-review-deprecation` | `dashboard` | `human` |

---

## Files to Change

| File | Change |
|---|---|
| `quorum-mcp/src/tools/forget.js` | Replace `forbidden` return with request-queuing path for non-PE |
| `quorum-mcp/src/tools/pending.js` | Add `fetchDeprecationRequests()`, extend output + summary |
| `quorum-mcp/src/tools/review.js` | Accept `request_id`, add approve/reject deprecation request path |
| `quorum-mcp/src/graph/queries.js` | Add `getOrCreateKey()` call if needed; extend `getPendingDecisions` duck-type mock |
| `quorum-mcp/tests/tools/forget.test.js` | Replace forbidden tests with deprecation_requested tests; add not_found + already_requested |
| `quorum-mcp/tests/tools/pending.test.js` | Add deprecation_requests section tests |
| `quorum-mcp/tests/tools/review.test.js` | Add approve + reject deprecation request tests |
| `quorum-mcp/skill/references/tool-reference.md` | Update `forget()`, `pending()`, `review()` docs |
| `gateway/src/routes/dashboard.js` | Extend `GET /api/pending` + `POST /api/review/:conflictId` |
| `gateway/src/routes/pg.js` | Extend MCP gateway bridge if `insertPendingDecision` needs new fields |
| `gateway/openapi.yaml` | Document new `deprecation_requests` field + `review` request body changes |
| `gateway/CLAUDE.md` | Update route descriptions |
| `dashboard/src/pages/Pending.jsx` | Add Deprecation Requests section |
| `dashboard/src/api/knowledge.js` | Add `reviewDeprecationRequest()` |
| `engram/CLAUDE.md` | Update "Built and working" section |

---

## Out of Scope

- Email / webhook notifications to the requestor on approval or rejection — v0.4+.
- Non-PE being able to withdraw their own pending request — v0.4+.
- `request_changes` action on deprecation requests — not meaningful; requestor should re-submit `forget()`.
