# J12 — Knowledge Status State Machine

**Scenario ID:** S-12
**Weight:** 24 (12 raw leaves × F2)
**Blast radius:** 2.6% of suite
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

## Pass Criteria

- [ ] DRAFT → ACTIVE via promote works, version number increments
- [ ] DRAFT → REJECTED works, no ACTIVE entry exists after
- [ ] ACTIVE → SUPERSEDED: old version preserved (no hard delete), new version ACTIVE
- [ ] ACTIVE → DEPRECATED: entry disappears from Knowledge browser
- [ ] Promote when no DRAFT → `404 no_draft`
- [ ] Duplicate ACTIVE write as PE → `409 already_exists`
- [ ] Promote an already-ACTIVE entry → `404 no_draft`
- [ ] Supersede is atomic: never a moment with zero ACTIVE versions for the same key
- [ ] Never two ACTIVE versions exist simultaneously for the same topic:key
