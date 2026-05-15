# ADR-0008: Dual-store Audit Pipeline

**Status:** Accepted  
**Date:** 2026-05-16  
**Deciders:** Platform team

---

## Context

**Requirement:** Every knowledge mutation must be traceable — who wrote it, when, from
what version, and why (NFR-02, FR-07).

**Requirement:** The audit trail must be tamper-evident — a compromised operator should
not be able to silently modify or delete audit entries (NFR-02).

**Requirement:** Agents must be able to recall the reasoning chain behind a knowledge
entry, not just its current value (FR-07).

Two stores with different strengths were already in the stack:

- **PostgreSQL** — durable, ACID, easy to query with SQL; no semantic traversal
- **Graphiti / FalkorDB** — temporal knowledge graph; enables semantic similarity,
  "what knowledge was active at time T", and relationship traversal; not ACID

A single-store model would sacrifice either durability/queryability (Graphiti-only)
or temporal reasoning capability (PostgreSQL-only).

## Decision

**Every write operation runs a two-phase audit pipeline:**

### Phase 1 — Pre-audit (PostgreSQL)

Before the knowledge mutation occurs, an audit entry is written to `audit_log` with
`phase: 'pre'`. This records the intent of the operation before it executes.

### Phase 2 — Knowledge mutation (PostgreSQL)

The version row is written to `knowledge_versions`. The new version record captures
`created_by_audit` — the `audit_id` of the pre-audit entry. This creates the first
direction of the bidirectional link.

### Phase 3 — Post-audit (PostgreSQL)

After the mutation, a `phase: 'post'` audit entry is written with `version_id` set
to the newly created version record. This completes the bidirectional link:

```
audit_log (pre)  ←──────── knowledge_versions.created_by_audit
                              ↑
audit_log (post) ───────────── version_id
```

### Phase 4 — Graphiti episode (fire-and-forget)

The same mutation is written to Graphiti as an episode via `add_memory`. This is
fire-and-forget: if Graphiti is unavailable, the PostgreSQL record is still committed
and the version is set to `PENDING_CONFLICT_CHECK` status. The Graphiti write is
retried via the `/pending` recovery path.

### SHA256 tamper-evident chain

Each `audit_log` row carries:
- `prev_hash` — SHA256 of the previous row's content
- `row_hash` — SHA256 of this row's content (including `prev_hash`)

This forms a linked hash chain. Any modification to a past audit row breaks every
subsequent hash in the chain. The `audit-cli.js verify` command walks the chain and
reports the first broken link.

```javascript
// Chain construction (gateway/src/shared/audit/secondary.js)
const prev = await getLatestAuditEntry(pool, projectId)
const prevHash = prev?.row_hash ?? GENESIS_HASH
const rowHash = sha256(`${prevHash}|${JSON.stringify(entryContent)}`)
```

### `version_audit_links` join table

A separate `version_audit_links` table stores the `(version_id, audit_id)` pairs for
bulk lineage queries. This allows `GET /pg/audit/lineage/:topic/:key` to return the
complete chain of audit entries for a given knowledge entry without a full table scan.

### Graphiti `summary` column as durable content store

Graphiti episode content is not treated as the primary store. The `summary` column
on `knowledge_versions` is the durable content store. If FalkorDB's volume is wiped,
the entire knowledge graph can be reconstructed from PostgreSQL `summary` values.
Graphiti is used for semantic similarity and temporal traversal only.

## Consequences

**Positive:**
- Audit entries are append-only at the application layer (`updateEntry()` /
  `deleteEntry()` always throw in `secondary.js`)
- SHA256 chain detects silent modifications; `audit-cli.js verify` is a compliance
  check that can run without touching the gateway
- Bidirectional link (`created_by_audit` ↔ `version_id`) means: given a version,
  find its audit; given an audit, find its version — without a JOIN
- FalkorDB volume loss is a semantics degradation, not a data loss event
- Graphiti failure degrades gracefully to `PENDING_CONFLICT_CHECK`; knowledge is still stored

**Negative:**
- Every write is at least 3 PostgreSQL statements (pre-audit, insert, post-audit);
  `remember()` is 5+ (version check, conflict detection, insert, pre/post audit)
- Pre/post audit must be written in the same transaction scope as the version insert
  or the bidirectional link can break under crash recovery
- Graphiti write failures leave versions stuck in `PENDING_CONFLICT_CHECK` until
  the `/pending` recovery path runs — the longer Graphiti is down, the bigger the queue

**Required by this decision:**
- `updateEntry()` and `deleteEntry()` in `secondary.js` MUST always throw —
  no path through the codebase may modify a committed audit entry
- Every `insertVersion()` call MUST capture the returned `version_id` and thread it
  into the post-audit entry; missing this breaks the bidirectional chain
- `storePendingConflictCheck()` MUST write `pre_audit` before the version insert and
  `post_audit` after — not as a single fire-and-forget write
- `audit-cli.js verify` MUST be run as part of the production deployment checklist
