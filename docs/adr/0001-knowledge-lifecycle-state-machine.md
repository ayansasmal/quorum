# ADR-0001: Knowledge Lifecycle State Machine

**Status:** Accepted  
**Date:** 2026-05-16  
**Deciders:** Platform team

---

## Context

Engineering knowledge is not static. A decision made in Q1 may be superseded by new
constraints in Q3. A pattern documented by one engineer may conflict with a later
architectural ruling. Without explicit lifecycle management, a knowledge store degrades
into a flat pile of facts with no way to know which are current, which are overridden,
and which were deliberately retired.

The system also needed to support a human-in-the-loop approval model: agents can
propose knowledge, but humans must approve before it becomes authoritative.

## Decision

Every piece of knowledge exists as a **version** with one of five statuses:

```
DRAFT ──approve──► ACTIVE ──supersede──► SUPERSEDED
      └─reject──► REJECTED
                    └─deprecate──► DEPRECATED
```

| Status | Meaning | Who creates it | Terminal? |
|--------|---------|---------------|-----------|
| `DRAFT` | Proposed — awaiting human review | Agent or human author | No |
| `ACTIVE` | Current authoritative version | Reviewer (via `review()`) | No |
| `SUPERSEDED` | Replaced by a newer version of the same entry | System (atomic supersede) | Yes |
| `DEPRECATED` | Deliberately retired — no replacement | Human via `forget()` | Yes |
| `REJECTED` | Rejected during review | Reviewer (via `review()`) | Yes |

**Legal transitions:**

| From | To | Trigger |
|------|-----|---------|
| DRAFT | ACTIVE | `review(action: 'approve')` |
| DRAFT | REJECTED | `review(action: 'reject')` |
| ACTIVE | SUPERSEDED | `remember()` with conflicting content on an existing key |
| ACTIVE | DEPRECATED | `forget()` |

All other transitions are illegal and rejected at the application layer via the
`LEGAL_TRANSITIONS` map in `gateway/src/shared/graph/queries.js` —
specifically in the `transitionVersionStatus` function which validates the
`(currentStatus → newStatus)` pair before issuing any SQL.

**Versioning is append-only.** Every change creates a new version row; no existing
row is ever mutated (except the `status` field via `transitionVersionStatus`, which
is explicitly carved out). This means the full history of every piece of knowledge
is always queryable.

**The atomic supersede pattern** (Gap 3) ensures there is never a moment when two
ACTIVE versions coexist for the same `topic:key`. The gateway `POST /pg/versions/supersede`
route runs both the INSERT of the new version and the transition of the old to
SUPERSEDED in a single PostgreSQL transaction.

## Consequences

**Positive:**
- Every version is auditable — who wrote it, when, under what confidence
- Rollback is always possible — prior ACTIVE versions are preserved as SUPERSEDED
- The approval gate prevents agents from autonomously publishing authoritative knowledge
- `recall()` always returns only the ACTIVE version — no disambiguation needed at call sites

**Negative:**
- Queries for the "current" value of a key require a status filter (`WHERE status = 'ACTIVE'`)
- Storage grows permanently — there is no garbage collection for old versions
- A key can have zero ACTIVE versions (if all versions are DRAFT/REJECTED/DEPRECATED), which
  `recall()` surfaces as a not-found

**Required by this decision:**
- `knowledge_versions` must have a unique constraint that the atomic supersede respects
- `transitionVersionStatus` must validate transitions against the legal set before writing
- The `review()` tool must enforce that only DRAFT versions can be approved or rejected
- Staleness detection in `review()` must warn when the ACTIVE version has advanced since
  the DRAFT was authored
