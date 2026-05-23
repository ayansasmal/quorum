# J12 — Knowledge Status State Machine

**Scenario ID:** S-12
**Weight:** 40 (20 raw leaves × F2) — updated: +8 leaves from Parts E-F (non-PE alongside ACTIVE, SUPERSEDED immutability)
**Blast radius:** 3.8% of suite (recalculated against 1045.5 suite total)
**Frequency tier:** F2 (weekly — state transitions happen on every governance action)
**Spec file:** `tests/e2e/scenarios/12-state-machine.spec.js`

---

## What It Covers

All valid status transitions and all invalid transitions. The goal is to prove that only
legitimate paths through the state machine exist and that no transition produces an impossible
state (e.g., two ACTIVE versions for the same key).

**Roles:** `test-pe`, `test-engineer`
**Touches:** `POST /api/knowledge`, `POST /knowledge/:t/:k/promote`, `POST /knowledge/:t/:k/supersede`, `POST /knowledge/:t/:k/deprecate`, `GET /pg/versions/:t/:k`
**Automated:** Yes — API

---

## Valid State Transitions

```
DRAFT ──────────────────► ACTIVE      (via promote or PA write)
DRAFT ──────────────────► REJECTED    (via review reject)
ACTIVE ─────────────────► SUPERSEDED  (via supersede — old version)
ACTIVE ─────────────────► DEPRECATED  (via deprecate or PA forget)
```

---

## Invalid Transitions (must be rejected)

| Attempt | Expected |
|---------|----------|
| Promote when no DRAFT exists | `404 no_draft` |
| PE creates duplicate ACTIVE via POST | `409 already_exists` |
| Promote an already-ACTIVE version | `404 no_draft` |
| Supersede a DRAFT (nothing to supersede) | `404` or first-write behaviour |
| Deprecate a DRAFT directly | `404` — only ACTIVE entries can be deprecated |

---

## Setup

No prior state. Each transition test uses a fresh unique key to prevent state leakage.

---

## Steps

### Valid Transitions

1. **DRAFT → ACTIVE (promote path):**
   - Engineer writes `testing:state-draft` → assert `DRAFT`
   - PA promotes via `POST /api/knowledge/testing/state-draft/promote`:
     - Note: `"Reviewed and correct"`
     - Assert: `200`, entry is `ACTIVE`, version = 1

2. **DRAFT → REJECTED:**
   - Engineer writes `testing:state-reject` → assert `DRAFT`
   - PA reviews with `action: "reject"`:
     - Note: `"Does not meet quality standards for this project"`
     - Assert: `200`, entry is `REJECTED`
     - Assert: `GET /pg/versions/testing/state-reject` returns empty (no ACTIVE entry)

3. **ACTIVE → SUPERSEDED (via supersede):**
   - PA writes `testing:state-supersede` → assert `ACTIVE` v1
   - PA supersedes with new content:
     - Assert: `200`, v2 is `ACTIVE`, v1 is `SUPERSEDED`
     - Assert: both versions exist in DB (no hard delete)
   - Assert: `GET /pg/versions/testing/state-supersede` returns v2 content

4. **ACTIVE → DEPRECATED:**
   - PA writes `testing:state-deprecate` → assert `ACTIVE`
   - PA calls `POST /api/knowledge/testing/state-deprecate/deprecate`:
     - Reason: `"Entry superseded by new platform decision — no longer applicable"`
     - Assert: `200`, entry is `DEPRECATED`
     - Assert: entry no longer appears in Knowledge browser (no ACTIVE version)

---

### Invalid Transitions

5. **Promote when no DRAFT exists:**
   - `POST /api/knowledge/testing/no-draft-here/promote` (key does not exist)
   - Assert: `404` with `error: "no_draft"`

6. **Duplicate ACTIVE via PE POST:**
   - PA writes `testing:state-dup` → assert `ACTIVE`
   - PA attempts second `POST /api/knowledge` with same topic:key
   - Assert: `409` with `error: "already_exists"`
   - Assert: original entry unchanged (no side effect from the failed write)

7. **Promote an already-ACTIVE version:**
   - PA writes `testing:state-promote-active` → `ACTIVE`
   - `POST /api/knowledge/testing/state-promote-active/promote`
   - Assert: `404` with `error: "no_draft"` (nothing to promote — already ACTIVE)

8. **Atomicity of supersede:**
   - PA writes `testing:state-atomic` → v1 ACTIVE
   - PA supersedes to v2
   - Query DB directly:
     ```sql
     SELECT status, version FROM knowledge_versions
     WHERE topic = 'testing' AND key = 'state-atomic'
     ORDER BY version
     ```
   - Assert: exactly one ACTIVE version (v2), exactly one SUPERSEDED version (v1)
   - Assert: no window of zero ACTIVE versions (atomic transition)

---

## Part E — Non-PE DRAFT Alongside Existing ACTIVE

> CLAUDE.md specifies: "PE 409s on duplicate ACTIVE, non-PE can DRAFT alongside an existing ACTIVE."
> This means a non-PA write to a topic:key that already has an ACTIVE version does NOT return 409.
> Instead it lands as DRAFT. Both versions coexist. This is not tested in the invalid-transitions matrix
> above, which only tests the PE duplicate path.

9. PA writes `testing:coexist-s12` → assert `ACTIVE`, `version: 1`

10. Engineer writes to the same key:
    - `POST /api/knowledge` with `topic: "testing"`, `key: "coexist-s12"` and new content
    - Assert: HTTP 200 or 201 — NOT `409 already_exists`
    - Assert: `status: "DRAFT"` (engineer writes always land as DRAFT)

11. `GET /pg/versions/testing/coexist-s12`
    - Assert: two versions exist (v1 ACTIVE, v2 DRAFT)
    - Assert: only one ACTIVE version (v1 from the PA write)
    - Assert: v2 is DRAFT (coexists without displacing the ACTIVE version)

---

## Part F — SUPERSEDED and DEPRECATED Entry Immutability

> Once an entry reaches SUPERSEDED or DEPRECATED status, no further governance action is valid
> on it. The transitions diagram only shows paths FROM ACTIVE. Attempting invalid transitions on
> terminal statuses must return the correct error.

12. PA writes and supersedes `testing:super-imm-s12`:
    - PA writes v1 → ACTIVE
    - PA supersedes → v2 is ACTIVE, v1 is SUPERSEDED

13. Attempt to deprecate the SUPERSEDED entry (v1):
    - `POST /api/knowledge/testing/super-imm-s12/deprecate`
      (the route deprecates the ACTIVE version — there is no ACTIVE version at v1)
    - Assert: this operates on the ACTIVE version (v2) and succeeds with `200` if a reason is provided,
      OR assert `404` if the route explicitly blocks deprecating a SUPERSEDED version directly
    - Assert: the SUPERSEDED v1 entry is NOT affected — its status remains `SUPERSEDED`

14. Attempt to supersede a DEPRECATED entry:
    - PA writes `testing:dep-imm-s12` → ACTIVE
    - PA deprecates it (v1 → DEPRECATED)
    - `POST /api/knowledge/testing/dep-imm-s12/supersede` with new content
    - Assert: `404` or `400` — no ACTIVE version exists to supersede (entry is DEPRECATED)

15. Attempt to promote a DEPRECATED entry:
    - `POST /api/knowledge/testing/dep-imm-s12/promote`
    - Assert: `404 no_draft` — no DRAFT to promote; DEPRECATED is not a promotable state

16. Attempt to promote a SUPERSEDED entry directly:
    - `POST /api/knowledge/testing/super-imm-s12/promote`
      (v2 of this key is now DEPRECATED from step 13; v1 is SUPERSEDED)
    - If both v1 and v2 have non-DRAFT statuses: assert `404 no_draft`
    - Assert: SUPERSEDED status on v1 is not changed

---

## Pass Criteria (updated)

- [ ] DRAFT → ACTIVE via promote works, version number increments
- [ ] DRAFT → REJECTED works, no ACTIVE entry exists after
- [ ] ACTIVE → SUPERSEDED: old version preserved (no hard delete), new version ACTIVE
- [ ] ACTIVE → DEPRECATED: entry disappears from Knowledge browser
- [ ] Promote when no DRAFT → `404 no_draft`
- [ ] Duplicate ACTIVE write as PE → `409 already_exists`
- [ ] Promote an already-ACTIVE entry → `404 no_draft`
- [ ] Supersede is atomic: never a moment with zero ACTIVE versions for the same key
- [ ] Never two ACTIVE versions exist simultaneously for the same topic:key
- [ ] Non-PE write to a key with an existing ACTIVE → `DRAFT` (not `409`)
- [ ] Non-PE DRAFT and PA ACTIVE can coexist for the same topic:key simultaneously
- [ ] SUPERSEDED entry is not affected by deprecate route (route targets ACTIVE only)
- [ ] Supersede on a DEPRECATED key → `404` (no ACTIVE version to supersede)
- [ ] Promote on a DEPRECATED key → `404 no_draft` (DEPRECATED is not promotable)
