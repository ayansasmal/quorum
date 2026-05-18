# ADR-0002: Constitutional Invariants

**Status:** Accepted  
**Date:** 2026-05-16  
**Deciders:** Platform team

---

## Context

A knowledge governance system is only as trustworthy as the rules it enforces
unconditionally. Governance frameworks that can be bypassed under pressure — a
missing `reason`, a self-approved change, a silent delete — degrade into
theatre. The team needed a set of rules that are enforced by the system itself,
not by convention or code review.

The word "constitutional" is deliberate: these are not preferences or defaults.
They are load-bearing invariants. Violating any one of them would undermine the
audit trail, the conflict detection model, or the trust that the graph reflects
what humans actually approved.

## Decision

Eight invariants are enforced server-side and cannot be bypassed by any client:

### Rule 1: No hard delete

Knowledge is never permanently erased. `forget()` creates a DEPRECATED version;
it does not delete rows. Attempting to call DELETE or destructive methods against
the underlying store is blocked at the client layer (`BLOCKED_METHODS` in both
`quorum-mcp/src/graph/client.js` and `gateway/src/shared/graph/client.js`).

*Why:* Deletions destroy the evidence trail. A decision that looked wrong in
retrospect may have been correct given the context at the time. The context
must be preserved.

### Rule 2: Audit is append-only

`updateEntry()` and `deleteEntry()` in `gateway/src/shared/audit/secondary.js`
unconditionally throw `ConstitutionalViolation`. Audit entries are written once
and never modified. The chain position and SHA256 hash make tampering detectable.

*Why:* An audit trail that can be edited is not an audit trail.

### Rule 3: Reason required (≥10 characters)

Every supersede, deprecation, or review decision must carry a human-readable
reason of at least 10 characters. Enforced by `enforceReasonRequired()` in
`gateway/src/shared/governance/constitutional.js`.

*Why:* A one-word reason ("wrong", "old") carries no context. A minimum length
forces authors to state something a future engineer can act on.

### Rule 4: No self-approval

The author of a DRAFT version cannot be the reviewer who approves it. Enforced
by `enforceNoSelfApproval()` in `gateway/src/shared/governance/constitutional.js`.

*Why:* Approval exists to provide an independent check. Self-approval collapses
that check to a single person — equivalent to no review at all.

### Rule 5: Agent writes are always DRAFT

When `author === 'claude'` (or any agent identity), the status is forced to
DRAFT regardless of what the caller requests. Agents can propose; humans decide.

*Why:* The value of human-in-the-loop governance disappears if agents can
self-publish to ACTIVE.

### Rule 6: `triggered_by` is always set

Every version record carries a `triggered_by` field identifying what MCP tool
created it (`remember`, `reflect`, `forget`, etc.). This field is set by the
MCP tool layer and validated at the schema level — NULL is rejected.

*Why:* Provenance requires knowing not just who wrote something but what
action produced it. `triggered_by` is the entry point into the audit chain.

### Rule 7: Atomic ACTIVE transition

When a new version becomes ACTIVE, the previous ACTIVE version must become
SUPERSEDED in the same database transaction. There is never a window where two
ACTIVE versions coexist for the same `topic:key`.

*Why:* A split-brain ACTIVE state would cause non-deterministic results from
`recall()` and invalidate conflict detection (which assumes at most one ACTIVE
version per key).

### Rule 8: Bidirectional audit↔version references

Every version row carries `created_by_audit` (the audit entry ID that created
it). Every audit entry that creates or supersedes a version inserts a row into
`version_audit_links`. These two references must always be consistent.

*Why:* The `history()` tool and lineage queries rely on this cross-reference.
A version without an audit link, or an audit entry without a version link, is
an orphan that breaks compliance queries.

## Consequences

**Positive:**
- Any client — including Claude — operates within the same constraints
- Audit trail is cryptographically verifiable (SHA256 chain)
- The system is safe to give agents broader autonomy because the worst they
  can do is propose DRAFT entries

**Negative:**
- Legitimate "undo" operations require explicit deprecation with a reason,
  not a simple rollback
- Testing requires careful mock design — constitutional violations must be
  testable without breaking the invariants in test databases

**Required by this decision:**
- Constitutional enforcement functions must be tested at 100% coverage
- Any new tool that writes knowledge must call the enforcement functions
  before the database write, not after
- The `BLOCKED_METHODS` list must be updated whenever Graphiti adds new
  destructive endpoints
- `author_type` is always server-set: `'agent'` for MCP writes, `'human'` for dashboard writes — never from the request body
- Input validation (`validateKnowledgeInput`) is enforced at all five write routes (shared module, vendored to both gateway and quorum-mcp). Rules: content ≤ 500 chars + no HTML; topic/key kebab-case slugs; tags ≤ 10 items; confidence 0.5–1.0; reason ≥ 10 chars for promote/supersede.
