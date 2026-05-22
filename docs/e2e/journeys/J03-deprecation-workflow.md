# J03 — Deprecation Workflow

**Scenario ID:** S-03
**Weight:** 40 (20 raw leaves × F2)
**Blast radius:** 4.3% of suite
**Frequency tier:** F2 (weekly operational — deprecation is a regular lifecycle event)
**Spec file:** `tests/e2e/scenarios/03-deprecation-workflow.spec.js`

---

## What It Covers

The full deprecation lifecycle from three angles: a non-PE engineer requests deprecation via `forget()`,
a PE approves or rejects the request from both MCP and dashboard, and a stale warning appears when
the underlying entry has advanced since the request was created.

This also verifies the deduplication rule: one pending request per author per key.

**Roles:** `test-engineer` (requests), `test-pe` (reviews), `test-senior` (reads pending)
**Touches:** `POST /pg/versions` (forget), `GET /pg/pending`, `POST /api/review/:requestId`, `/pending` page
**Automated:** Yes — API + Playwright

---

## Setup

Seed one ACTIVE entry via `test-pe`:
- `topic: "auth"`, `key: "oauth-flow"`, `content: "OAuth 2.1 with PKCE. Authorization code flow only. No implicit grant."`

---

## Steps

### Part A — Non-PE deprecation request (MCP path)

1. `POST /pg/versions` (forget) as `test-engineer`:
   - `topic: "auth"`, `key: "oauth-flow"`, `reason: "Replaced by PKCE-only flow in v2.0 — legacy OAuth config removed"`
   - Assert: `status: "deprecation_requested"`, `request_id` present
   - Assert: entry is **not** `deprecated` — engineer cannot deprecate directly

2. Same `POST /pg/versions` call again (second forget by same engineer on same key):
   - Assert: `status: "already_requested"` — deduplication working
   - Assert: no second pending request created

### Part B — MCP pending check

3. `GET /pg/pending` as `test-pe`
   - Assert: `deprecation_requests` array non-empty
   - Assert: request shows `requestor: "test-engineer"`, `reason`, `topic: "auth"`, `key: "oauth-flow"`

4. `GET /pg/pending` as `test-engineer`
   - Assert: same `deprecation_requests` array visible to the requestor (engineers can see their own requests)

### Part C — Dashboard pending page

5. Log in as `test-engineer`, navigate to `/pending`
   - Assert: "Deprecation requests" table section visible
   - Assert: row shows topic (`auth`), key (`oauth-flow`), reason, requestor
   - Assert: no Approve / Reject buttons visible (non-PE cannot action requests)

6. Log in as `test-pe`, navigate to `/pending`
   - Assert: same row visible with Approve + Reject buttons
   - Click "Reject"
   - ConfirmDialog appears with note field
   - Type fewer than 10 chars in note → button stays disabled
   - Type valid note: `"Deprecation not needed — entry remains relevant for legacy integrations"`
   - Click Confirm
   - Assert: request resolved as rejected
   - Assert: `auth:oauth-flow` entry still `ACTIVE` (not deprecated)

### Part D — Approve path

7. Reset state: `test-pe` seeds a fresh ACTIVE entry at `auth:legacy-session`.

8. `test-engineer` submits deprecation request for `auth:legacy-session`.

9. Log in as `test-pe`, navigate to `/pending`
   - Click "Approve" for the `auth:legacy-session` request
   - ConfirmDialog appears → type valid note → submit
   - Assert: entry transitions to `DEPRECATED`
   - Assert: `auth:legacy-session` no longer appears in Knowledge browser (no ACTIVE version)
   - Assert: history (version lineage) shows v1 ACTIVE → v2 DEPRECATED

### Part E — Staleness detection

10. Reset state: `test-pe` seeds `auth:token-cache` as ACTIVE.

11. `test-engineer` submits deprecation request for `auth:token-cache`.

12. Before PE reviews: `test-pe` supersedes `auth:token-cache` with new content (creates v2 ACTIVE).

13. Navigate to `/pending` as `test-pe`
    - Assert: deprecation request row for `auth:token-cache` shows amber stale badge
    - Assert: badge text includes version advancement context (e.g., "Active version advanced since this request")

14. Attempt `POST /api/review/:request_id` with `action: "request_changes"` as `test-pe`:
    - Assert: `400` — `request_changes` is not a valid action for deprecation requests (only for conflicts)

---

## Pass Criteria

- [ ] Non-PE `forget()` → `deprecation_requested`, never `deprecated`
- [ ] Duplicate request from same engineer on same key → `already_requested`
- [ ] MCP `GET /pg/pending` shows deprecation requests to both PE and requestor
- [ ] Dashboard pending: non-PE sees requests but no action buttons
- [ ] Dashboard pending: note < 10 chars → submit blocked at UI level
- [ ] PE reject → entry stays ACTIVE, request resolved as rejected
- [ ] PE approve → entry transitions to DEPRECATED, disappears from Knowledge browser
- [ ] Version lineage shows ACTIVE → DEPRECATED transition
- [ ] Stale badge appears when active version advanced after request was created
- [ ] `request_changes` action on deprecation request → `400`

---

## Teardown

```javascript
// Remove all knowledge entries and pending requests created during this scenario
```

---

## Related Scenarios

- **S-02.3** (Resolve: supersede) — supersede also moves a version to SUPERSEDED, compare audit trail shape
- **S-12** (State machine) — tests all invalid DEPRECATED transitions
- **S-05.3** (RBAC: deprecate) — tests PE-only direct deprecation access control
