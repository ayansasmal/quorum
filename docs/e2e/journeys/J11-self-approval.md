# J11 — Self-Approval Prevention (Constitutional Rule 4)

**Scenario ID:** S-11
**Weight:** 40 (10 raw leaves × F4)
**Blast radius:** 4.3% of suite
**Frequency tier:** F4 (core — self-approval is checked on every review action)
**Spec file:** `tests/e2e/scenarios/11-self-approval.spec.js`

---

## What It Covers

Constitutional Rule 4 — `NO_SELF_APPROVAL`. No user can approve their own DRAFT, regardless of
role. The comparison is case and whitespace insensitive. Verified at both the API layer
(`POST /api/review`) and through an MCP-style write + review cycle.

**Roles:** `test-pe` (self-approves — blocked), `test-architect` (approves another's work — allowed)
**Touches:** `POST /pg/versions`, `POST /api/review/:id`, `/pending` page
**Automated:** Yes — API

---

## Setup

No prior state required.

---

## Steps

### Case 1 — Global catalog write (forces DRAFT even for PA)

1. `test-pe` writes to `quorum-test-catalog` (a global catalog):
   - `topic: "security"`, `key: "self-approval-test"`
   - `content: "Test entry for self-approval prevention validation"`
   - Assert: `status: "DRAFT"` — global catalog writes always land as DRAFT regardless of role
   - `version_id` present in response

2. `test-pe` attempts to review their own DRAFT:
   - `POST /api/review/:version_id` as `test-pe`
   - `{ action: "approve", note: "Approving my own standard — it is correct" }`
   - Assert: `403`, body contains `rule: "NO_SELF_APPROVAL"`
   - Assert: `error` message identifies the attempt as self-approval

3. Same attempt with padded username (whitespace variation):
   - The JWT `sub` is `"test-pe"` — but the conflict record has author `"test-pe"` stored
   - Simulate by testing the comparison function directly (or verify the check is normalized)
   - Assert: blocked even with leading/trailing whitespace in either field
   - Assert: same `403 NO_SELF_APPROVAL`

4. `test-architect` (different user, same project) reviews and approves:
   - `POST /api/review/:version_id` as `test-architect`
   - `{ action: "approve", note: "Reviewed and approved — standard is correct" }`
   - Assert: `200`, entry transitions to `ACTIVE`

---

### Case 2 — Engineer DRAFT (standard flow)

5. `test-engineer` writes to `quorum-test-project`:
   - `topic: "testing"`, `key: "self-approval-engineer"`
   - `content: "Engineers cannot self-approve"`
   - Assert: `status: "DRAFT"` (engineer writes always land as DRAFT)

6. `test-engineer` attempts to review their own DRAFT:
   - Assert: `403 NO_SELF_APPROVAL`

7. `test-pe` (different user) approves via `POST /api/review/:version_id`:
   - Assert: `200`, entry is `ACTIVE`

---

### Case 3 — MCP-style path (via gateway `/pg/*` routes)

8. `test-senior` writes a DRAFT via `POST /pg/versions`:
   - `topic: "testing"`, `key: "mcp-self-approval"`
   - Assert: `status: "DRAFT"`

9. `test-senior` calls `POST /pg/resolve/:conflict_id` on their own entry with approve:
   - This simulates `review(action: "approve", ...)` from the MCP tool
   - Assert: `403` with `rule: "NO_SELF_APPROVAL"` — constitutional enforcement at API layer
   - Assert: DRAFT is not promoted

---

## Pass Criteria

- [ ] Global catalog write by PA → DRAFT (global writes always DRAFT)
- [ ] Self-review of own DRAFT → `403 NO_SELF_APPROVAL`
- [ ] Whitespace/case normalization — padded variant still blocked
- [ ] Different user can approve the same DRAFT → `200` transitions to ACTIVE
- [ ] Engineer self-review → blocked (same rule applies regardless of role)
- [ ] MCP-path self-approval attempt → `403 NO_SELF_APPROVAL` at API layer
- [ ] `rule: "NO_SELF_APPROVAL"` present in every 403 response body
- [ ] Blocked self-approval does not consume or modify the DRAFT entry in any way
- [ ] After block: DRAFT is still approvable by a different user
- [ ] Audit log does NOT record a failed self-approval as an OUTCOME entry
