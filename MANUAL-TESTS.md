# Engram — Manual Test Scenarios

These scenarios cover integration paths that the automated test suite cannot reach:
real PostgreSQL writes, live Graphiti calls, LLM-driven conflict detection, identity
resolution, and audit chain persistence across restarts.

**Run these in order** — later scenarios build on state from earlier ones.

---

## Prerequisites

```bash
# Full stack running
docker compose up -d

# Wait for all services to be healthy
docker compose ps   # all should show "healthy" or "running"

# Dependencies installed
npm install

# Environment configured
cp .env.example .env
# Fill in OPENAI_API_KEY (required for conflict detection LLM call)

# Start the MCP server
npm start
# Look for: "Engram MCP server running" + "Chain integrity verified"

# Register with Claude Code (if using via MCP client)
claude mcp add engram -- node /path/to/engram/src/server.js
```

> All `remember()`, `recall()`, `pending()` etc. calls below are MCP tool calls.
> Run them via Claude Code, a test MCP client, or the CLI where noted.

---

## Scenario 1 — Full Governance Cycle

**What this covers:** The end-to-end path that no unit test exercises:
`remember()` → conflict detected → stored in `pending_decisions` → `pending()` surfaces
it → `review()` resolves it → version becomes ACTIVE → audit chain is intact.

**Why it matters:** This is the core product differentiator. The unit tests mock every
external call, so this has never run against a real database or LLM.

### Steps

**1. Store the first version (v1)**

```
remember(
  topic: "db",
  key: "connection-pooling",
  content: "Use pool size 10 per service. Sized for p95 load of 8 concurrent queries. Larger pools cause connection exhaustion on RDS.",
  confidence: 0.85
)
```

Expected: `{ status: "stored", version: 1, knowledge_status: "ACTIVE" }`

**2. Store a contradicting version**

```
remember(
  topic: "db",
  key: "connection-pooling",
  content: "Pool size should be 50 for high-concurrency batch processing nodes. Batch jobs saturate the default pool of 10 within seconds.",
  confidence: 0.60,
  reason: "Batch processing team requires higher concurrency"
)
```

Expected: `{ status: "conflict_detected", conflict_id: "conflict_...", brief: { ... } }`

> If you get `{ status: "stored", version: 2 }` instead — conflict detection is not
> triggering. Check that `OPENAI_API_KEY` is set and Graphiti is healthy.

**3. Check that pending surfaces the conflict**

```
pending()
```

Expected output shape:
```json
{
  "conflict_briefs": [
    {
      "conflict_id": "conflict_...",
      "topic": "db",
      "key": "connection-pooling",
      "stale_warning": null,
      "brief": {
        "existing": { "content": "Use pool size 10...", "author": "..." },
        "incoming": { "content": "Pool size should be 50...", "author": "..." },
        "enrichment": {
          "analysis": "...",
          "risks_if_approved": [...],
          "questions_for_reviewer": [...]
        }
      },
      "options": ["supersede", "coexist", "reject", "escalate"],
      "more_pending_same_key": 0
    }
  ],
  "draft_reviews": [],
  "summary": { "total_pending": 1, "conflicts": 1, "drafts": 0 }
}
```

> If `conflict_briefs` is empty — the conflict was not written to `pending_decisions`.
> Check the `pending_decisions` table directly:
> ```bash
> docker compose exec postgresql psql -U engram -d engram_audit -c "SELECT * FROM pending_decisions;"
> ```

**4. Resolve the conflict**

```
review(
  action: "approve",
  topic: "db",
  key: "connection-pooling",
  note: "Batch nodes run on separate infra with dedicated RDS — pool size 50 is correct for that context. OLTP services keep pool size 10."
)
```

Expected: `{ status: "approved", version: 2, knowledge_status: "ACTIVE" }`

**5. Verify exactly one ACTIVE version exists**

```
recall(topic: "db", key: "connection-pooling")
```

Expected: returns the v2 content (pool size 50 version), status ACTIVE.

```
recall(topic: "db", key: "connection-pooling", options: { history: true })
```

Expected:
```
v2 ● ACTIVE    <author>    <date>
   "Pool size should be 50..."
   Triggered by: conflict_resolution

v1   SUPERSEDED  <author>  <date>
   "Use pool size 10..."
   Superseded by v2
```

**6. Verify audit chain**

```bash
node cli.js audit verify
```

Expected: `Chain integrity: OK, N entries` (N should be at least 4: INTENT+OUTCOME for each remember(), plus entries for review).

> If you see `ChainIntegrityViolation` — a hash mismatch occurred. This is a critical bug.

### Pass criteria

- [ ] `remember()` #2 returns `conflict_detected`, not `stored`
- [ ] `pending()` returns exactly 1 conflict brief with enrichment populated
- [ ] After `review("approve")`, exactly one version is ACTIVE
- [ ] `recall({ history: true })` shows v1 SUPERSEDED → v2 ACTIVE with triggered_by: conflict_resolution
- [ ] `audit verify` reports OK with no integrity violations

---

## Scenario 2 — Audit Chain Survives Restart

**What this covers:** The append-only audit guarantee across process restarts. The chain
position must continue from where it left off — not reset — and verification must pass.

**Why it matters:** If the chain breaks on restart, the tamper-evidence guarantee is
meaningless. Unit tests mock the database, so this has never been exercised.

### Steps

**1. Note the current chain length**

```bash
node cli.js audit stats
# Note: "Total entries: N"
```

**2. Stop the server**

```bash
pkill -f "node src/server.js"
# or Ctrl+C if running in foreground
```

**3. Restart and watch startup output**

```bash
npm start
```

Expected in startup log:
```
▶ Verifying audit chain...
✓ Chain integrity verified: N entries OK
▶ Engram MCP server running
```

> If you see `ChainIntegrityViolation` in startup — the server will refuse to start.
> This is intentional. It means a database row was modified after the fact.

**4. Write a new entry and re-verify**

```
remember(
  topic: "auth",
  key: "restart-test",
  content: "Testing audit chain continuity across restarts.",
  confidence: 0.70
)
```

```bash
node cli.js audit verify
```

Expected: `Chain integrity: OK, N+2 entries` (INTENT + OUTCOME for the new remember()).

**5. Inspect chain positions directly**

```bash
docker compose exec postgresql psql -U engram -d engram_audit \
  -c "SELECT chain_position, operation, tool, author FROM audit_log ORDER BY chain_position DESC LIMIT 5;"
```

Expected: chain positions are sequential (no gaps, no duplicates).

### Pass criteria

- [ ] Server starts cleanly with "Chain integrity verified: N entries OK"
- [ ] After a new write, chain positions are sequential (no reset to 1)
- [ ] `audit verify` passes after restart

---

## Scenario 3 — Identity Resolution

**What this covers:** The 4-layer identity resolution chain. Your role and confidence
floor must come from the S3 config (or local config path), not from tool input.

**Why it matters:** The entire authority model depends on the server knowing who you are.
If identity resolution is broken, anyone can write high-confidence ACTIVE knowledge.

### Steps

**3a — GitHub token resolution (most authoritative)**

```bash
# Set your token
export ENGRAM_GITHUB_TOKEN=<your-real-github-token>

# Set local config path (skip S3 for this test)
export ENGRAM_CONFIG_PATH=./engram.config.example.json

# Update engram.config.example.json — add your real github_username
# to one of the members, e.g.:
# { "name": "you", "team": "platform", "role": "principal_architect",
#   "github_username": "<your-github-username>", "git_email": "..." }

# Restart the server so it picks up the new env + config
npm start
```

Store something with a deliberately low confidence:

```
remember(
  topic: "auth",
  key: "identity-test-github",
  content: "Testing GitHub token identity resolution.",
  confidence: 0.40
)
```

Check what was stored:

```
recall(topic: "auth", key: "identity-test-github", options: { history: true })
```

Expected:
- `author` = your GitHub username (not "anonymous")
- If your role is `principal_architect` (base_confidence 0.90): stored confidence should be **0.90**, not 0.40 — the server floored it
- `knowledge_status` = ACTIVE (not DRAFT)

**3b — Anonymous (no token)**

```bash
unset ENGRAM_GITHUB_TOKEN
unset ENGRAM_AUTHOR
# Also clear git config temporarily if needed:
# git config --global --unset user.email
npm start
```

```
remember(
  topic: "auth",
  key: "identity-test-anon",
  content: "This was written anonymously.",
  confidence: 0.90
)
```

Expected:
- `author` = "anonymous"
- `knowledge_status` = DRAFT (anonymous writes are always DRAFT regardless of confidence)

**3c — Env var identity (CI context)**

```bash
export ENGRAM_AUTHOR=carol-dev   # must match a member name/github_username in config
unset ENGRAM_GITHUB_TOKEN
npm start
```

```
remember(
  topic: "auth",
  key: "identity-test-env",
  content: "Testing env var identity.",
  confidence: 0.50
)
```

Expected:
- `author` = "carol-dev"
- `knowledge_status` = ACTIVE (if carol-dev is a known member)
- Confidence floored to carol-dev's role base_confidence

### Pass criteria

- [ ] GitHub token resolves to correct username (verified by GitHub API, not self-asserted)
- [ ] Confidence below role floor is silently raised to floor — not rejected
- [ ] Anonymous writes always produce DRAFT regardless of confidence
- [ ] `identity_method` visible in audit entry (check via `node cli.js audit export`)

---

## Scenario 4 — Stale Conflict Detection

**What this covers:** When two conflicts queue on the same `topic:key` and the first is
resolved, the second should detect that its comparison context is now stale.

**Why it matters:** Without stale detection, a reviewer could approve conflict B while
comparing against v1, silently overwriting v2 that was just approved from conflict A.

### Steps

**1. Store a base version**

```
remember(
  topic: "infra",
  key: "retry-strategy",
  content: "Exponential backoff: max 3 retries, base delay 100ms, max delay 5s. Applied to all external HTTP calls."
)
```

**2. Trigger two conflicts without resolving either**

```
remember(
  topic: "infra",
  key: "retry-strategy",
  content: "Max 5 retries, base 200ms. The 3-retry default causes too many cascading failures during upstream degradation.",
  confidence: 0.70,
  reason: "SLA renegotiation requires more resilience"
)
# → conflict_detected (conflict_id: "conflict_A")

remember(
  topic: "infra",
  key: "retry-strategy",
  content: "Max 10 retries with full jitter. Jitter prevents thundering herd on recovery.",
  confidence: 0.65,
  reason: "Post-incident finding: synchronized retries caused cascading failure"
)
# → conflict_detected (conflict_id: "conflict_B")
```

**3. Resolve conflict A**

```
review(
  action: "approve",
  topic: "infra",
  key: "retry-strategy",
  note: "Upstream SLA change validated — 5 retries correct."
)
```

**4. Call `pending()` — conflict B should now show stale_warning**

```
pending()
```

Expected for conflict B:
```json
{
  "conflict_id": "conflict_B",
  "stale_warning": "Active version changed to v2 since this conflict was created. Brief updated to compare against current active.",
  "current_active_version": 2,
  "brief": {
    "existing": {
      "content": "Max 5 retries, base 200ms...",  ← this is v2, NOT the original v1
      ...
    },
    ...
  }
}
```

> If `stale_warning` is null — stale detection is not working. The reviewer would see
> conflict B compared against the original v1, not v2.

### Pass criteria

- [ ] Conflict B shows non-null `stale_warning` after conflict A is resolved
- [ ] Conflict B's `existing` in the brief now shows the v2 content (not v1)
- [ ] `current_active_version` is 2, not 1

---

## Scenario 5 — `reflect()` Knowledge Quality

**What this covers:** The LLM-driven knowledge extraction in `reflect()`. This is
inherently subjective — there's no assertion to write, only judgment to apply.

**Why it matters:** `reflect()` is the self-evolution mechanism. If it extracts vague,
incorrect, or duplicate knowledge, it pollutes the graph. Only a human can assess quality.

### Steps

**1. Run a realistic reflect() call**

```
reflect(
  task_summary: "Implemented rate limiting on the /api/payments endpoint. Used Redis token bucket algorithm with a limit of 100 requests per minute per user. Discovered that our Lambda timeout of 3 seconds was being hit during Redis cold starts when the pool was not warm. Fixed by pre-warming the Redis connection pool on Lambda init and setting pool size to 10.",
  decisions_made: [
    "Token bucket over leaky bucket — token bucket allows predictable burst handling",
    "100 req/min per user — conservative for payments, revisit after load testing",
    "Redis connection pool size 10 — avoids Lambda cold start latency on subsequent calls"
  ],
  patterns_used: [
    "Token bucket rate limiting via Redis",
    "Lambda init handler for connection pool warming"
  ]
)
```

**2. Check what was extracted**

```
pending(topic: "payments")
pending(topic: "infra")
# reflect() knowledge enters as DRAFT, visible in draft_reviews
```

Assess each extracted entry:
- Is it specific enough to be actionable? (not "use rate limiting")
- Does it include rationale? (not just the decision, but why)
- Is the topic:key mapping sensible? (e.g. `payments:rate-limiting` not `general:stuff`)
- Are there duplicates or near-duplicates of existing knowledge?

**3. Approve the good ones, reject the vague ones**

```
review("approve", "payments", "rate-limiting", "Correct — validated against load test results")
review("reject", "infra", "lambda-warmup", "Too specific to this one function — not a general pattern yet")
```

**4. Verify the approved entry is now ACTIVE**

```
recall(topic: "payments", key: "rate-limiting")
```

### Pass criteria (judgment call)

- [ ] At least 2–3 distinct knowledge entries extracted (not a single blob)
- [ ] Each entry has a sensible topic:key (not generic keys like "decision-1")
- [ ] Rationale is present in the content (not just the conclusion)
- [ ] All extracted entries start as DRAFT with triggered_by: reflect
- [ ] Approved entries become ACTIVE; rejected entries become REJECTED (not deleted)

---

## Scenario 6 — `forget()` Leaves No Hard Delete

**What this covers:** Constitutional Rule 1 in a live system. `forget()` must create a
DEPRECATED version — never remove a row from any table.

**Why it matters:** The unit test verifies that `enforceNoHardDelete` throws on delete
keywords. This scenario verifies that `forget()` itself goes through the correct path
end-to-end and leaves history intact.

### Steps

**1. Store a version to forget**

```
remember(
  topic: "testing",
  key: "deprecated-pattern",
  content: "Use Jest for all unit tests. Configured with jsdom environment."
)
```

**2. Forget it**

```
forget(
  topic: "testing",
  key: "deprecated-pattern",
  reason: "We migrated from Jest to Vitest in Q1 2025. This pattern is obsolete."
)
```

Expected: `{ status: "deprecated", version: 2 }`

**3. Confirm no ACTIVE version exists**

```
recall(topic: "testing", key: "deprecated-pattern")
```

Expected: null or a message indicating no active version.

**4. Confirm the content still exists in history**

```
recall(topic: "testing", key: "deprecated-pattern", options: { history: true })
```

Expected:
```
v2   DEPRECATED  <author>   <date>
   Triggered by: engineer_decision
   Reason: "We migrated from Jest to Vitest..."

v1   SUPERSEDED  <author>   <date>
   "Use Jest for all unit tests..."
```

**5. Confirm the database row was never deleted**

```bash
docker compose exec postgresql psql -U engram -d engram_audit \
  -c "SELECT version, status, content FROM knowledge_versions WHERE topic='testing' AND key='deprecated-pattern' ORDER BY version;"
```

Expected: 2 rows — v1 (SUPERSEDED) and v2 (DEPRECATED). No rows missing.

**6. Verify audit chain is still intact**

```bash
node cli.js audit verify
```

Expected: OK, no integrity violations.

### Pass criteria

- [ ] `forget()` returns `{ status: "deprecated" }`, not an error
- [ ] `recall()` (default) returns null after forget — no ACTIVE version
- [ ] `recall({ history: true })` shows both versions with DEPRECATED at the end
- [ ] PostgreSQL has 2 rows — nothing was deleted
- [ ] Audit chain passes verification

---

## Quick Checklist

After running all scenarios, confirm:

| Check | Expected | Actual | Pass? |
|-------|----------|--------|-------|
| Scenario 1: conflict_detected on semantic contradiction | `status: "conflict_detected"` | | |
| Scenario 1: pending() surfaces conflict with enrichment | enrichment populated | | |
| Scenario 1: one ACTIVE version after resolution | exactly v2 ACTIVE | | |
| Scenario 1: audit verify passes | "Chain integrity: OK" | | |
| Scenario 2: server restarts without chain violation | clean startup log | | |
| Scenario 2: chain positions sequential after restart | no gaps/resets | | |
| Scenario 3: GitHub token maps to config member | correct author + confidence floor | | |
| Scenario 3: anonymous write → DRAFT | DRAFT regardless of confidence | | |
| Scenario 4: second conflict shows stale_warning | non-null stale_warning | | |
| Scenario 4: stale brief compares against v2, not v1 | v2 content in existing | | |
| Scenario 5: reflect() extracts distinct entries | ≥2 entries, distinct topic:keys | | |
| Scenario 5: all reflect entries start as DRAFT | DRAFT, triggered_by: reflect | | |
| Scenario 6: forget() creates DEPRECATED version | v2 DEPRECATED in history | | |
| Scenario 6: no rows deleted from knowledge_versions | 2 rows in psql | | |

---

## Filing Bugs

For any failed check, capture:

```bash
# Server logs
npm start 2>&1 | tee /tmp/engram-test.log

# Database state at failure
docker compose exec postgresql psql -U engram -d engram_audit \
  -c "\dt" \
  -c "SELECT COUNT(*) FROM audit_log;" \
  -c "SELECT topic, key, version, status FROM knowledge_versions ORDER BY topic, key, version;"

# Chain state
node cli.js audit verify
node cli.js audit stats
```

Include the log, database state, and the exact tool call that produced the unexpected result.
