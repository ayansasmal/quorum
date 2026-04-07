# Engram — Audit Architecture

## Core Philosophy: Audit by Architecture

There are two ways to build audit into a system:

```
Audit by logging:       Add logs where you remember to
                        Hope nothing slips through
                        Logs can be disabled or bypassed
                        Inconsistent across operations
                        Bolted on after the fact

Audit by architecture:  The pipeline IS the audit trail
                        Cannot operate without producing audit entries
                        Tamper-evident chain proves integrity
                        Build-time checks prove no bypasses exist
                        Impossible to forget — impossible to disable
```

Engram uses audit by architecture. The audit trail is not a feature. It is the system.

---

## The Fundamental Principle

Every MCP tool call flows through a single mandatory pipeline. There is no code path that bypasses it. The operation and the audit are the same thing.

```
Any tool call (remember, recall, forget, review, search, export...)
        ↓
Engram Pipeline — structurally impossible to bypass
        ↓
┌────────────────────────────────────────┐
│  1. Input validation                   │
│     → reason present? author present?  │
│     → constitutional rules check       │
│                                        │
│  2. Pre-operation audit entry          │
│     → INTENT logged before action      │
│     → includes full context snapshot   │
│                                        │
│  3. Governance decisions               │
│     → conflict check                   │
│     → authority assessment             │
│     → draft requirement check          │
│     → human escalation if needed       │
│     → all decisions logged             │
│                                        │
│  4. Execute operation                  │
│     → the actual graph operation       │
│                                        │
│  5. Post-operation audit entry         │
│     → OUTCOME logged after action      │
│     → state before + state after       │
│     → chain hash updated               │
│                                        │
│  6. Return result                      │
└────────────────────────────────────────┘
        ↓
Result returned to caller
```

Steps 2 and 5 are not optional. They cannot be skipped. If they fail, the operation fails. There is no way to execute step 4 without steps 2 and 5 completing successfully.

---

## Audit Entry Structure

Every audit entry captures the full context snapshot — not just what changed, but who, why, what governance ran, and what the outcome was.

```json
{
  "entry_id": "audit_abc123",

  "identity": {
    "operation_id": "op_xyz789",
    "tool": "remember",
    "timestamp": "2024-12-01T10:23:00Z",
    "author": "ayan",
    "author_role": "senior_engineer",
    "session_id": "sess_claude_456",
    "client": "claude-code"
  },

  "intent": {
    "topic": "auth",
    "key": "token-strategy",
    "content_hash": "sha256:abc...",
    "confidence": 0.9,
    "tags": ["auth", "jwt", "security"],
    "entity_type": "Decision"
  },

  "governance": {
    "conflict_checked": true,
    "conflict_detected": false,
    "authority_score": 0.72,
    "draft_required": false,
    "human_notified": false,
    "constitutional_rules_checked": ["no_hard_delete", "reason_required"],
    "constitutional_violations": []
  },

  "outcome": {
    "status": "stored",
    "node_id": "node_def456",
    "graph_episode": "ep_789",
    "state_before": null,
    "state_after": "ACTIVE"
  },

  "version_impact": {
    "topic": "auth",
    "key": "token-strategy",
    "versions_superseded": [],
    "versions_created": [
      {
        "version": 1,
        "node_id": "node_def456",
        "status": "ACTIVE",
        "triggered_by": "engineer_decision",
        "content_hash": "sha256:abc..."
      }
    ]
  },

  "immutability": {
    "entry_hash": "sha256:this_entry_hash...",
    "previous_hash": "sha256:previous_entry_hash...",
    "chain_position": 1247
  }
}
```

Every audit entry carries a `version_impact` block describing which versions were created or superseded by this operation. This creates a bidirectional reference — the audit entry knows what version it produced, and the version record knows which audit entry created it.

### Version ↔ Audit Bidirectionality

```
audit_entry_1389 (conflict resolution)
  version_impact:
    versions_superseded: [{ version: 2, status_before: ACTIVE }]
    versions_created:    [{ version: 3, triggered_by: conflict_resolution }]
          ↕ bidirectional
auth:token-strategy v3
  created_by_audit: audit_entry_1389

Result:
  Walk from version → find exact audit entry that created it
  Walk from audit entry → find version it produced
  Tamper with version content → hash mismatch detected via chain
  Tamper with audit entry → chain breaks at that position
```

Versioning makes tamper evidence **specific** — not just "something changed" but exactly which version of which knowledge was touched.

### Why content_hash not content?

The audit log stores a hash of the content, not the content itself. This serves two purposes:

1. **Privacy** — sensitive content doesn't live in the audit log verbatim
2. **Integrity** — the hash proves what was stored without reproducing it

The actual content lives in the graph. The hash in the audit log proves it hasn't changed.

---

## Tamper-Evident Chain

Every audit entry includes the hash of the previous entry. This creates a blockchain-style chain:

```
Entry 1:  hash(entry_1_content) = H1,  previous_hash = null
Entry 2:  hash(entry_2_content) = H2,  previous_hash = H1
Entry 3:  hash(entry_3_content) = H3,  previous_hash = H2
Entry 4:  hash(entry_4_content) = H4,  previous_hash = H3
```

If anyone modifies entry 2 after the fact:
```
Entry 2 (modified): hash(modified_content) = H2'  ← different from H2
Entry 3: previous_hash = H1  ← now incorrect (should reference H2, not H1... wait)
```

The chain breaks. `verify_chain()` detects it immediately:

```javascript
async function verifyChain() {
  const entries = await audit.getAllEntries({ orderBy: 'chain_position' })
  for (let i = 1; i < entries.length; i++) {
    const expected = hash(entries[i - 1])
    const actual = entries[i].previous_hash
    if (expected !== actual) {
      throw new ChainIntegrityViolation({
        position: i,
        expected,
        actual,
        entry: entries[i]
      })
    }
  }
  return { verified: true, entries: entries.length }
}
```

This runs on startup and on demand. A broken chain is a constitutional violation.

---

## Three Levels of Audit

### Level 1 — Operation Log

Every tool call. Every governance decision. Every state change. Append-only, chained, always on.

Answers: **What happened?**

```
remember() called by @ayan at 10:23
  → conflict check ran: no conflict
  → authority score: 0.72
  → stored as ACTIVE
  → chain position: 1247
```

### Level 2 — Knowledge State Snapshots

At configurable intervals (default: daily, on every significant write), a snapshot of the full knowledge graph state is stored independently:

```json
{
  "snapshot_id": "snap_20241201",
  "timestamp": "2024-12-01T00:00:00Z",
  "stats": {
    "total_nodes": 47,
    "active": 44,
    "draft": 2,
    "deprecated": 1,
    "domains": {
      "auth": 12,
      "payments": 8,
      "infra": 15,
      "api": 12
    },
    "avg_confidence": 0.74,
    "nodes_below_threshold": 3
  },
  "snapshot_hash": "sha256:..."
}
```

Answers: **What did Engram know at any point in time?**

Useful for incident retrospectives:
```
"What did Engram know when PR #847 was merged on Nov 30th?"
→ Load snapshot_20241130
→ Reconstruct exact knowledge state at that moment
→ Trace which knowledge influenced that PR
```

### Level 3 — Decision Lineage

For every knowledge node, a complete lineage trace is queryable:

```
auth:token-strategy — Full Lineage

Created:    2024-06-01 10:15 | @senior-architect | Decision | confidence 0.9
            "Use JWT for all services" | ADR-042 reference
            Chain position: 143

Recalled:   47 times between 2024-06-01 and 2024-12-01
            Notable: 2024-11-30 14:22 by claude during PR #847

Challenged: 2024-12-01 10:20 | @junior-dev
            Incoming: "Use session tokens for internal services"
            Conflict detected: similarity 0.91, LLM confirmed contradiction

Brief shown to @ayan at 2024-12-01 10:23
            Brief open time: 4m 12s (genuine engagement, not rubber-stamp)
            Related context surfaced: infra:lambda-constraints

Resolved:   2024-12-01 10:27 | @ayan
            Decision: "B — Nuance: JWT for Lambda, sessions for non-Lambda"
            Reason: "payment-svc uses Lambda, ADR-042 needs nuancing not replacing"

Dissent:    @engineer flagged Lambda concern during review
            Overruled by @ayan with reason logged
            Dissent preserved permanently at chain position: 1251

Updated:    2024-12-01 10:28 | new version stored as ACTIVE
            Previous version marked SUPERSEDED

Outcome:    Tracked over 90 days
            No incidents linked to this decision
            Recalled 23 times post-update — all without correction
            Confidence updated: 0.9 → 1.0
```

Answers: **Why does this knowledge exist and how did it get here?**

---

## Dual Store Architecture

Two independent stores. Both always written to. Either can reconstruct the audit independently.

```
┌─────────────────────────────┐    ┌──────────────────────────────┐
│   Primary Store             │    │   Secondary Store             │
│   Graph DB                  │    │   PostgreSQL (append-only)    │
│   (FalkorDB/Neo4j)          │    │                              │
│                             │    │   audit_log                  │
│   Audit nodes connected     │    │   → every operation entry    │
│   to knowledge nodes        │    │                              │
│   Version nodes with        │    │   knowledge_versions         │
│   SUPERSEDES edges          │    │   → version snapshots        │
│   Graph traversal gives     │    │                              │
│   full lineage naturally    │    │   version_audit_links        │
│                             │    │   → bidirectional refs       │
│                             │    │                              │
│                             │    │   All tables append-only     │
│                             │    │   No UPDATE or DELETE ever   │
│                             │    │   Survives graph failure     │
└─────────────────────────────┘    └──────────────────────────────┘
         Both written atomically — if either fails, operation fails
```

### PostgreSQL Schema (Secondary Store)

```sql
-- Audit entries — append-only, never modified
CREATE TABLE audit_log (
  entry_id        TEXT PRIMARY KEY,
  operation       TEXT NOT NULL,
  tool            TEXT NOT NULL,
  timestamp       TIMESTAMPTZ NOT NULL,
  author          TEXT NOT NULL,
  author_role     TEXT NOT NULL,
  session_id      TEXT,
  content_hash    TEXT,
  governance_json JSONB NOT NULL,
  outcome_json    JSONB NOT NULL,
  version_impact  JSONB NOT NULL,       -- ← new: version changes made
  entry_hash      TEXT NOT NULL,
  previous_hash   TEXT,
  chain_position  BIGINT NOT NULL UNIQUE
);

-- Knowledge version snapshots — append-only, never modified
CREATE TABLE knowledge_versions (
  id                SERIAL PRIMARY KEY,
  topic             TEXT NOT NULL,
  key               TEXT NOT NULL,
  version           INTEGER NOT NULL,
  status            TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  author            TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  created_by_audit  TEXT NOT NULL,      -- references audit_log.entry_id
  supersedes_version INTEGER,
  supersedes_reason  TEXT,
  triggered_by      TEXT NOT NULL,
  conflict_id       TEXT,
  UNIQUE(topic, key, version)           -- immutable once written
);

-- Bidirectional version ↔ audit cross-reference
CREATE TABLE version_audit_links (
  audit_entry_id  TEXT NOT NULL,
  topic           TEXT NOT NULL,
  key             TEXT NOT NULL,
  version         INTEGER NOT NULL,
  link_type       TEXT NOT NULL,        -- 'created' | 'superseded'
  created_at      TIMESTAMPTZ NOT NULL
);

-- Row-level security: no application user can UPDATE or DELETE
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE version_audit_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_insert_only ON audit_log FOR INSERT TO engram_app;
CREATE POLICY versions_insert_only ON knowledge_versions FOR INSERT TO engram_app;
CREATE POLICY links_insert_only ON version_audit_links FOR INSERT TO engram_app;
```

The secondary store is now a complete independent reconstruction of both the knowledge state and its full version history — without needing the graph DB at all.

Why two stores?

- If graph DB has a problem, PostgreSQL audit + versions are intact
- If PostgreSQL is unavailable, graph audit is intact
- They are independent — compromise of one doesn't compromise the other
- PostgreSQL is the compliance export target — SQL queries, portable, auditable



---

## What Gets Audited — Everything

Because the pipeline is the audit trail, everything that flows through the system is audited. You never have to ask "should we log this?" — the answer is always yes.

```
Claude Code session starts          → session_start logged
Knowledge loaded into context       → recall logged (what was Claude working with?)
Search query made                   → search logged (what was Claude looking for?)
Conflict detected                   → conflict_detected logged
Conflict check ran, no conflict     → conflict_checked_clean logged
Human decision brief shown          → brief_shown logged (with brief content hash)
Time taken to read brief            → engagement_time logged
Human decision made                 → decision logged (choice + reason + brief_hash)
Decision quality outcome            → outcome logged 90 days later
Dissent raised                      → dissent logged permanently
Dissent overruled                   → overrule logged with reason
Draft knowledge accessed by mistake → draft_access_attempt logged (blocked)
Config change proposed              → config_change_proposed logged
Config change approved              → approved_by logged per approver
Config change activated             → activation logged after cooling period
Constitutional test run             → test_run logged (pass/fail + coverage)
Constitutional violation attempt    → violation_attempt logged (critical alert)
Chain integrity verified            → verification logged
Audit export requested              → export logged (who requested, when, scope)

Versioning events (all include version_impact block):
Knowledge node v1 created           → version 1 logged, triggered_by recorded
Knowledge node superseded           → old version SUPERSEDED logged with reason
New version created (any trigger)   → version N logged, supersedes N-1
PR merge created new version        → triggered_by: pr_merge, PR number recorded
Conflict resolution created version → triggered_by: conflict_resolution
reflect() created new version       → triggered_by: reflect, session logged
Temporal recall requested           → point-in-time query logged
Version history requested           → history query logged
```

---

## Three Audit Queries Versioning Enables

### 1. Full Version Audit Trail
```sql
-- Everything that ever happened to auth:token-strategy
SELECT al.*, val.version, val.link_type
FROM audit_log al
JOIN version_audit_links val ON al.entry_id = val.audit_entry_id
WHERE val.topic = 'auth' AND val.key = 'token-strategy'
ORDER BY al.chain_position ASC;
```

Returns: every create, conflict, review, supersession — in order, with full context.

### 2. Point-in-Time Reconstruction
```sql
-- What was the active version of auth:token-strategy on Nov 30th?
SELECT *
FROM knowledge_versions
WHERE topic = 'auth'
  AND key = 'token-strategy'
  AND created_at <= '2024-11-30T23:59:59Z'
  AND (
    status = 'ACTIVE'
    OR EXISTS (
      SELECT 1 FROM knowledge_versions kv2
      WHERE kv2.topic = 'auth'
        AND kv2.key = 'token-strategy'
        AND kv2.supersedes_version = knowledge_versions.version
        AND kv2.created_at > '2024-11-30T23:59:59Z'
    )
  )
ORDER BY version DESC
LIMIT 1;
```

Deterministic answer from the append-only store. No ambiguity.

### 3. Causal Chain for Incident Tracing
```sql
-- What knowledge was active during sessions around the Dec 5th incident?
-- Step 1: find sessions near incident
SELECT DISTINCT session_id
FROM audit_log
WHERE timestamp BETWEEN '2024-12-03' AND '2024-12-05'
  AND tool = 'recall';

-- Step 2: find what was recalled in those sessions
SELECT al.session_id, val.topic, val.key, val.version, kv.content_hash
FROM audit_log al
JOIN version_audit_links val ON al.entry_id = val.audit_entry_id
JOIN knowledge_versions kv ON kv.topic = val.topic
  AND kv.key = val.key
  AND kv.version = val.version
WHERE al.session_id IN (/* sessions from step 1 */)
  AND al.tool = 'recall';

-- Step 3: for each recalled version, get its full history
-- (were any dissents overruled? any conflicts auto-resolved?)
```

Full causal story: what Claude knew → where that knowledge came from → who approved it → were concerns raised?



Audit correctness is a build-time guarantee, not a runtime hope.

### Static Analysis
```yaml
# CI step: audit-bypass-scan
- name: Scan for audit bypass patterns
  run: npm run audit:scan-bypasses

# Checks:
#   Any function touching graph state must call audit.write()
#   No direct Graphiti calls outside the pipeline wrapper
#   No conditional audit writes (audit is never skipped)
#   No try/catch that swallows audit failures silently
```

### Constitutional Audit Tests
```javascript
describe('Audit Pipeline Integrity', () => {

  test('every tool call produces minimum 2 audit entries', async () => {
    const before = await audit.count()
    await remember('auth', 'test', 'content', 'ayan')
    const after = await audit.count()
    expect(after - before).toBeGreaterThanOrEqual(2)  // pre + post
  })

  test('failed operations still produce audit entries', async () => {
    const before = await audit.count()
    await expect(
      remember('auth', 'test', 'content', null)  // missing author
    ).rejects.toThrow()
    const after = await audit.count()
    expect(after - before).toBeGreaterThanOrEqual(1)  // failure logged
  })

  test('audit entries cannot be written outside the pipeline', async () => {
    await expect(
      audit.writeDirectly({ operation: 'fake', author: 'hacker' })
    ).rejects.toThrow('ConstitutionalViolation: direct audit writes not permitted')
  })

  test('both stores written atomically', async () => {
    // Simulate secondary store failure
    await simulateSecondaryStoreFailure()
    await expect(
      remember('auth', 'test', 'content', 'ayan')
    ).rejects.toThrow('AuditFailure: operation rolled back — secondary store unavailable')
    // Primary store must also not have the entry
    expect(await recall('auth', 'test')).toBeNull()
  })

  test('chain integrity verified on startup', async () => {
    await tamperWithEntry(500)  // simulate tampering
    await expect(startApplication()).rejects.toThrow('ChainIntegrityViolation')
  })
})
```

### Dependency Scanning
```yaml
- name: Check Graphiti delete methods are blocked
  run: npm run audit:scan-graphiti-deletes
  # Ensures no new Graphiti version exposes delete methods
  # that aren't wrapped and blocked by Engram's pipeline
```

---

## Runtime Guarantees

### Startup
On every application start:
1. Verify chain integrity — full chain from position 0 to latest
2. If chain broken → refuse to start, alert, wait for human investigation
3. Verify both stores are in sync — entry counts match
4. If out of sync → enter read-only mode, alert

### Continuous
- Audit lag monitoring — time between operation and audit entry should be near-zero
- Chain extension monitoring — every write extends the chain correctly
- Store sync monitoring — primary and secondary stay in sync

### On Demand
```bash
# Verify audit chain integrity
engram audit verify

# Generate lineage report for a knowledge node
engram audit lineage auth:token-strategy

# Export audit log for a time range (compliance)
engram audit export --from 2024-11-01 --to 2024-12-01 --format jsonl

# Show audit stats
engram audit stats
```

---

## Compliance Export

The flat file secondary store is the compliance export target.

Format: JSONL (one JSON object per line, universally parseable)

```bash
# Export everything
engram audit export --format jsonl > audit_2024.jsonl

# Export for specific domain
engram audit export --domain auth --format jsonl > audit_auth.jsonl

# Export for specific time range
engram audit export --from 2024-Q4 --format jsonl > audit_q4.jsonl

# Verify export integrity
engram audit verify-export audit_2024.jsonl
```

The export includes chain hashes so the recipient can verify the export hasn't been tampered with after export.

---

## What the Audit Enables

### Incident Retrospectives
```
Production incident: payment auth failing after deploy

Engram audit trace:
  → PR #847 merged 2024-11-30 14:30
  → auth:token-strategy recalled at 14:22 during PR #847
  → auth:token-strategy was ACTIVE with "JWT for Lambda services"
  → Decision to switch to session tokens made 2024-12-01 10:27
  → Dissent flagged by @engineer at 10:25 — Lambda incompatibility concern
  → Dissent overruled by @ayan at 10:27

Root cause: Session tokens deployed to Lambda-based payment service
Contributing factor: Dissent was raised and overruled — concern was valid
Action: Update auth:token-strategy, improve Lambda constraint knowledge
```

### Governance Health Monitoring
```
Monthly audit report — Auth Domain

Decisions made:        12
Avg time to decide:    4.2h
Rubber stamp rate:     2/12 (brief open < 30s)
Dissents raised:       3
Dissents overruled:    1 (led to incident — see above)
Conflict rate:         4/47 nodes conflicted this month
Decision accuracy:     91% (outcome tracked over 90 days)

Flags:
  @engineer dissent on auth:token-strategy was correct — review overrule policy
  db:pool-size confidence 0.55 — unaccessed 90+ days — consider reviewing
```

### Knowledge Provenance
```
For any piece of knowledge, answer:
  Who created it and when?
  What was their authority score at the time?
  Has it ever been challenged?
  Who resolved those challenges and why?
  How often has it been recalled?
  Has it ever contributed to an incident?
  What is its current confidence score and why?
```

---

## Privacy Considerations

The audit log stores hashes of content, not content itself. However:

- Author identity is always stored — attribution is non-negotiable
- Topic and key are stored — general domain is visible
- Governance decisions are stored — conflict detection results, authority scores
- Timestamps are stored — when things happened

The audit log is not private. It is readable by all team members. This is intentional — transparency is a governance property, not a bug. If you need to store sensitive knowledge, consider whether it belongs in Engram at all.

---

## Summary

```
Audit by architecture means:

  The pipeline IS the operation
  → Cannot call remember() without audit entries being created
  → Cannot call forget() without audit entries being created
  → Cannot make any state change without it being logged

  Two independent stores
  → Graph DB for lineage queries and rich traversal
  → Flat file for compliance, portability, and resilience

  Tamper-evident chain
  → SHA256 chain across all entries
  → Break the chain → detectable immediately
  → Startup refuses if chain is broken

  Build-time guarantees
  → Static analysis proves no bypass paths exist
  → Constitutional tests prove audit pipeline is intact
  → Dependency scanning catches new bypass vectors

  Runtime guarantees
  → Chain integrity verified on startup
  → Audit lag monitored continuously
  → Store sync monitored continuously

  Everything is auditable because the audit IS the system
  not a feature of the system
```
