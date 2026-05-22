# J15 — Reason / Placeholder Rejection (Constitutional Rule 3)

**Scenario ID:** S-15
**Weight:** 45 (15 raw leaves × F3)
**Blast radius:** 4.8% of suite
**Frequency tier:** F3 (daily — reason validation fires on every governance action)
**Spec file:** `tests/e2e/scenarios/15-reason-placeholder.spec.js`

---

## What It Covers

Constitutional Rule 3 — `REASON_REQUIRED`. Every write endpoint that accepts a `reason` or `note`
field must reject not just strings that are too short (< 10 chars) but also strings that ARE ≥ 10
chars but match the `PLACEHOLDER_PATTERNS` list. This tests every affected endpoint.

**Roles:** `test-pe`, `test-engineer`
**Touches:** All write endpoints that accept `reason` or `note`
**Automated:** Yes — API (no browser required)

---

## Rejected Placeholder Patterns

From `PLACEHOLDER_PATTERNS` in `constitutional.js`:

```javascript
['ok', 'yes', 'no', 'n/a', 'na', 'test', 'tbd', 'todo', 'fixme', '.', '!']
```

These are rejected even if the string meets the ≥ 10 char minimum.
Example: `"tbd tbd tbd"` — 11 chars but matches the `tbd` pattern → rejected.

---

## Setup

Seed the necessary state for each endpoint test:
- One ACTIVE entry for supersede/deprecate tests
- One DRAFT entry for promote tests
- One conflict for review tests
- One deviation for deviation action tests

---

## Endpoint Coverage Matrix

| Endpoint | `reason`/`note` field | Placeholder tested |
|----------|-----------------------|--------------------|
| `POST /pg/versions` (supersede) | `reason` | `"tbd"` |
| `POST /api/review/:id` (conflict resolve) | `note` | `"ok"` |
| `POST /api/knowledge/:t/:k/promote` | `note` | `"test"` |
| `POST /api/knowledge/:t/:k/supersede` | `reason` | `"todo"` |
| `POST /api/knowledge/:t/:k/deprecate` | `reason` | `"n/a"` |
| `POST /api/deviations/:id/action` | `reason` | `"."` |
| `POST /admin/users` | `reason` | `"yes"` |

---

## Steps

### Each endpoint — two tests (placeholder rejected, valid accepted)

For every row in the endpoint coverage matrix:

**A — Placeholder string rejected:**

Call the endpoint with the placeholder string listed:
- Assert: `400`
- Assert: response body contains `rule: "REASON_REQUIRED"`
- Assert: state is unchanged (the action was not applied)

**B — Valid reason accepted:**

Call the same endpoint with a legitimate reason (≥ 10 chars, not a placeholder):
- `"Superseding due to updated architecture decision after Q3 review"`
- Assert: `200` or `201`
- Assert: action applied successfully

---

## Detailed Steps

1. `POST /pg/versions` with superseding content and `reason: "tbd"`:
   - Assert: `400 REASON_REQUIRED`

1b. Same with `reason: "Superseding to align with new deployment model post-migration"`:
   - Assert: `200`, supersede applied

2. `POST /api/review/:conflict_id` with `note: "ok"`:
   - Assert: `400 REASON_REQUIRED`

2b. Same with `note: "Incoming version addresses the identified edge case correctly"`:
   - Assert: `200`, conflict resolved

3. `POST /api/knowledge/testing/placeholder-promote/promote` with `note: "test"`:
   - Assert: `400 REASON_REQUIRED`

3b. Same with `note: "Entry reviewed and meets project quality standards"`:
   - Assert: `200`, DRAFT promoted to ACTIVE

4. `POST /api/knowledge/testing/placeholder-supersede/supersede` with `reason: "todo"`:
   - Assert: `400 REASON_REQUIRED`

4b. Same with `reason: "Updated to reflect current service boundary decisions"`:
   - Assert: `200`, supersede applied

5. `POST /api/knowledge/testing/placeholder-deprecate/deprecate` with `reason: "n/a"`:
   - Assert: `400 REASON_REQUIRED`

5b. Same with `reason: "Entry deprecated following team decision to remove legacy pattern"`:
   - Assert: `200`, entry deprecated

6. `POST /api/deviations/:deviation_id/action` with `reason: "."`:
   - Assert: `400 REASON_REQUIRED`

6b. Same with `reason: "Accepted — migration tracked in JIRA-8821, target Q4"`:
   - Assert: `200`, deviation action applied

7. `POST /admin/users` with `action: "add"` and `reason: "yes"`:
   - Assert: `400 REASON_REQUIRED` (reason validation applies to admin routes too)

7b. Same with `reason: "Adding admin user to support expanded platform team operations"`:
   - Assert: `200`, admin user added

---

## Pass Criteria

- [ ] `"tbd"` rejected on supersede → `400 REASON_REQUIRED`
- [ ] `"ok"` rejected on conflict review → `400 REASON_REQUIRED`
- [ ] `"test"` rejected on promote → `400 REASON_REQUIRED`
- [ ] `"todo"` rejected on supersede (knowledge route) → `400 REASON_REQUIRED`
- [ ] `"n/a"` rejected on deprecate → `400 REASON_REQUIRED`
- [ ] `"."` rejected on deviation action → `400 REASON_REQUIRED`
- [ ] `"yes"` rejected on admin users → `400 REASON_REQUIRED`
- [ ] Valid non-placeholder reason ≥ 10 chars accepted on all same endpoints
- [ ] `rule: "REASON_REQUIRED"` present in every `400` response body
- [ ] State unchanged after each rejected call — no partial writes

---

## Notes

**Why test every endpoint?** Each endpoint implements `enforceReasonRequired` independently.
A refactor that accidentally skips the enforcement on one route would not be caught by testing
only one endpoint. The matrix ensures complete coverage with minimal overhead (14 API calls total).

**Placeholder matching is case-insensitive and trim-normalized.** `"  TBD  "` is equivalent to
`"tbd"`. The constitutional check normalizes before pattern matching.
