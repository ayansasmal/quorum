# J11 — Self-Approval Prevention (Constitutional Rule 4)

**Scenario ID:** S-11
**Weight:** 64 (16 raw leaves × F4)
**OwnScore:** 288 (W=64 × C=3.0 × D=1.5)
**Blast radius:** 8.2% of suite (288/3530)
**Frequency tier:** F4 (core — self-approval is checked on every review action)
**Spec file:** `tests/e2e/scenarios/11-self-approval.spec.js`

---

## What It Covers

Constitutional Rule 4 — `NO_SELF_APPROVAL`. No user can approve their own DRAFT, regardless of
role. The comparison is case and whitespace insensitive. Verified at both the API layer
(`POST /api/review`) and through an MCP-style write + review cycle.

Also covers `coexist_merge` (Case 4): a PA who wrote one of the two conflicting entries cannot
be the merger (self-approval semantics apply to the DRAFT/PENDING_CONFLICT_CHECK author). A
different PA performing the merge is permitted — the rule targets the author of the entry being
reviewed, not the author of the existing ACTIVE entry.

**Roles:** `test-pe` (self-approves — blocked; also coexist_merge author of merged entry), `test-pe2` (second PA, DRAFT author — blocked from self-merge), `test-architect` (approves another's work — allowed)
**Touches:** `POST /pg/versions`, `POST /api/review/:id`, `/pending` page, `coexist_merge` action
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

### Case 4 — coexist_merge Two-PA Flow (S-11.4)

The coexist_merge action creates a unified ACTIVE entry from two conflicting versions. The
self-approval check applies to the **DRAFT/PENDING_CONFLICT_CHECK author** — meaning the PA
who wrote the conflicting DRAFT cannot be the merger. The ACTIVE entry's author (who is the
*other* party in the conflict) CAN be the merger.

Setup:
- `test-pe` writes an ACTIVE entry (e.g., retry back-off strategy)
- `test-pe2` writes a conflicting entry (PENDING_CONFLICT_CHECK via `pending_conflict_check: true`)
- A `pending_decision` is seeded linking the conflict to both versions

10. `test-pe2` attempts `coexist_merge` without `merged_content`:
    - `POST /api/review/:conflictId` as `test-pe2`, action: `"coexist_merge"`, note ≥10 chars, no `merged_content`
    - Assert: `400`, body contains `error: "merged_content_required"`

11. `test-pe2` (DRAFT author) attempts self-merge:
    - `POST /api/review/:conflictId` as `test-pe2`, action: `"coexist_merge"`, with valid `merged_content`
    - Assert: `400`, body contains `rule: "NO_SELF_APPROVAL"` — DRAFT author cannot be the merger

12. `test-pe` (ACTIVE entry author, NOT the DRAFT author) merges:
    - `POST /api/review/:conflictId` as `test-pe`, action: `"coexist_merge"`, with valid `merged_content`
    - Assert: `200`, body contains `merged_version`

13. Merged entry is ACTIVE and authored by `test-pe`:
    - `GET /pg/versions/:topic/:key/history`
    - Assert: one ACTIVE entry, `author: "test-pe"` (the merger), content = `merged_content`

14. Source versions are SUPERSEDED:
    - Same history response
    - Assert: exactly 2 SUPERSEDED entries (the original ACTIVE and the PENDING_CONFLICT_CHECK)

15. Pending decision resolved:
    - `GET /pg/pending`
    - Assert: the conflict entry is no longer in the pending list (resolved with `coexist_merge`)

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
- [ ] `coexist_merge` without `merged_content` → `400 merged_content_required`
- [ ] PENDING_CONFLICT_CHECK author cannot coexist_merge their own entry → `400 NO_SELF_APPROVAL`
- [ ] ACTIVE entry author (not the DRAFT author) can be the merger → `200`
- [ ] Merged entry: ACTIVE status, authored by the merging PA, content = `merged_content`
- [ ] Both source entries (ACTIVE + PENDING_CONFLICT_CHECK) transition to SUPERSEDED atomically
- [ ] Pending decision resolved with `resolution: "coexist_merge"` after successful merge
