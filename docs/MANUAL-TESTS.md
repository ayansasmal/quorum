# Quorum — Manual Test Scenarios

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
# Look for: "Quorum MCP server running" + "Chain integrity verified"

# Register with Claude Code (if using via MCP client)
claude mcp add quorum -- node /path/to/quorum/src/server.js
```

> All `remember()`, `recall()`, `pending()` etc. calls below are MCP tool calls.
> Run them via Claude Code, a test MCP client, or the CLI where noted.

---

## Quality Pillar Mapping

Each manual test maps to a pillar in the Eight-Pillar Quality Framework
([RISK_WEIGHTED_TEST_PLAN.md](RISK_WEIGHTED_TEST_PLAN.md)). ⛔ = zero-tolerance (any failure
blocks the build immediately, regardless of score percentage).

| Scenario | Quality Pillar | Pillar Gate |
|----------|---------------|-------------|
| Scenario 1 — Full Governance Cycle | Governance Integrity | ⛔ zero-tolerance |
| Scenario 2 — Audit Chain Survives Restart | Governance Integrity | ⛔ zero-tolerance |
| Scenario 3 — Identity Resolution | Security | ⛔ zero-tolerance |
| Scenario 4 — Stale Conflict Detection | Governance Integrity | ⛔ zero-tolerance |
| Scenario 5 — `reflect()` Knowledge Quality | Functional Correctness | 🟡 score-gated |
| Scenario 6 — `forget()` Leaves No Hard Delete | Data Integrity | ⛔ zero-tolerance |
| MT-09 — Claude Writes Always DRAFT | Governance Integrity | ⛔ zero-tolerance |
| MT-10 — Global Catalog `pending_review` | Federation | 🟡 score-gated |
| MT-11 — GitHub OAuth Browser Flow | Security | ⛔ zero-tolerance |
| MT-12 — PKCE OAuth 2.1 MCP Client Auth | Security | ⛔ zero-tolerance |
| Knowledge Write Flows — DRAFT/ACTIVE/Promote | Functional Correctness | 🟡 score-gated |
| Deprecation Request Workflow | Functional Correctness | 🟡 score-gated |

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
> docker compose exec postgresql psql -U quorum -d quorum_audit -c "SELECT * FROM pending_decisions;"
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
▶ Quorum MCP server running
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
docker compose exec postgresql psql -U quorum -d quorum_audit \
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
export QUORUM_GITHUB_TOKEN=<your-real-github-token>

# Set local config path (skip S3 for this test)
export QUORUM_CONFIG_PATH=./quorum.config.example.json

# Update quorum.config.example.json — add your real github_username
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
unset QUORUM_GITHUB_TOKEN
unset QUORUM_AUTHOR
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
export QUORUM_AUTHOR=carol-dev   # must match a member name/github_username in config
unset QUORUM_GITHUB_TOKEN
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
docker compose exec postgresql psql -U quorum -d quorum_audit \
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
| Deprecation request: non-PE forget() queues request | `status: "deprecation_requested"` | | |
| Deprecation request: PE approve → DEPRECATED | entry DEPRECATED in psql | | |
| Deprecation request: PE reject → entry stays ACTIVE | entry ACTIVE in psql | | |
| Deprecation request: stale_warning appears after version advance | amber badge on row | | |

---

## Knowledge Write Flows

### Create new entry (all roles)
1. Log in as any authenticated user; navigate to `/knowledge`
2. Click "+ Add entry" — KnowledgeForm modal opens
3. Fill all fields; submit
   - As `principal_architect` → entry appears in list with **ACTIVE** status
   - As any other role → entry goes to **DRAFT** (visible at `/pending`, not in the browse list)
4. Try submitting with content > 500 chars → validation error shown inline
5. Try submitting with HTML in content (`<b>test</b>`) → validation error shown

### Non-PE creates DRAFT alongside existing ACTIVE
1. As non-PE, find a topic:key that already has an ACTIVE entry in the Knowledge browser
2. Click "+ Add entry" and submit with the same topic and key
3. Expected: 201 Created → DRAFT entry is created; the existing ACTIVE entry is unchanged
4. Navigate to `/pending` → the new DRAFT appears in the "Draft entries — awaiting review" section
5. As PE: verify "Promote" button is visible next to the DRAFT row
6. As PE: try the same create → expected 409 with `already_exists` (PE must use supersede)

### DRAFT review queue on Pending page
1. Navigate to `/pending` as PE
2. "Draft entries — awaiting review" section appears above the conflict decisions section
3. Each row shows domain, key, type, confidence, author, created date, and a Promote button
4. Click "Promote" → ConfirmDialog with note field (≥ 10 chars required)
5. Confirm → DRAFT promoted to ACTIVE; row disappears from DRAFT section; entry appears in Knowledge browser
6. Navigate to `/pending` as non-PE → DRAFT section visible but **no Promote button** — row is informational only with "These entries are awaiting review by a principal architect." note

### Confidence floor applied server-side (dashboard create)
1. As a non-PE engineer (base_confidence 0.70), submit a new knowledge entry with `confidence: 0.40`
2. After creation, open the entry detail → stored confidence should be **0.70** (floored to role minimum), not 0.40
3. As `senior_engineer` (base_confidence 0.80), submit with `confidence: 0.50` → stored confidence should be **0.80**
4. As `principal_architect` (base_confidence 0.90), submit with `confidence: 0.95` → stored as **0.95** (above floor, kept as-is)

### Promote DRAFT to Active (from Knowledge browser)
1. Navigate to `/knowledge`, open the detail drawer on a DRAFT entry
2. "Promote" button visible in header → click
3. ConfirmDialog opens with note field → note must be ≥ 10 chars
4. Confirm → entry status becomes ACTIVE; drawer header now shows "Edit" instead of "Promote"
5. As non-PE user: verify "Promote" button is NOT visible

### Edit (supersede) Active entry
1. Click `⋯` on an ACTIVE row → "Edit" option appears
2. KnowledgeForm opens pre-filled with existing values
3. Modify content → submit → new version created; old version SUPERSEDED
4. Version history in drawer shows two entries
5. As non-PE user: verify `⋯` button is NOT visible

### Deprecation request workflow (non-PE → queue → PE approve/reject)

**Pre-condition:** Two users — a `principal_architect` (PE) and a non-PE engineer (e.g. `senior_engineer`). One ACTIVE knowledge entry exists.

**Step 1 — Non-PE submits deprecation via MCP `forget()`**
1. In the non-PE engineer's Claude Code session, call:
   ```
   forget(
     topic: "auth",
     key:   "oauth-flow",
     reason: "Replaced by the new PKCE-only flow — legacy flow removed in v2"
   )
   ```
2. Expected response: `{ status: "deprecation_requested", request_id: "q_c...", message: "Deprecation request queued..." }`
3. NOT expected: `{ status: "forbidden" }` or `{ status: "deprecated" }`

**Step 2 — Non-PE sees the queued request**
1. Non-PE calls `pending()` in their session
2. Expected: response includes `deprecation_requests: [{ request_id, topic, key, requestor, reason, current_version }]`
3. The `decisions` array does NOT contain a `deprecation_request`-type entry (correct filtering)

**Step 3 — Deduplication check**
1. Non-PE calls `forget()` on the same topic:key again with the same or different reason
2. Expected: `{ status: "already_requested", request_id: "q_c..." }` — second request is blocked

**Step 4 — Dashboard shows the pending request (non-PE view)**
1. Non-PE navigates to `/pending`
2. "Deprecation requests" section visible with the queued row
3. Row shows: domain, key, requestor name, reason text, current version
4. No Approve/Reject buttons visible — informational only
5. Footer note: "These deprecation requests are awaiting review by a principal architect."

**Step 5 — PE reviews and approves via MCP**
1. In the PE session, call `pending()` → `deprecation_requests` section appears with `request_id`
2. Call:
   ```
   review(
     request_id: "<the request_id from step 1>",
     action: "approve",
     note: "Confirmed — PKCE migration complete, legacy flow removed in deploy #342"
   )
   ```
3. Expected: `{ status: "approved", topic: "auth", key: "oauth-flow" }`
4. The ACTIVE entry is now DEPRECATED — verify:
   ```sql
   SELECT version, status FROM knowledge_versions
   WHERE topic='auth' AND key='oauth-flow' ORDER BY version;
   -- expect: version 1 → DEPRECATED
   ```

**Step 6 — Dashboard Pending page clears after approval**
1. Navigate to `/pending` (any user)
2. The processed request no longer appears in "Deprecation requests" section
3. If no other pending items exist, the queue-clear state is shown

**Step 7 — Reject path**
1. Create another ACTIVE entry and submit a new `forget()` request as non-PE
2. PE navigates to `/pending` dashboard → "Deprecation requests" section shows the row with Approve/Reject buttons
3. Click "Reject" → ConfirmDialog opens with note field (≥ 10 chars required)
4. Enter a note and confirm → request is resolved as rejected
5. The ACTIVE entry remains ACTIVE — verify in Knowledge browser
6. `pending()` no longer shows the request

**Step 8 — Staleness detection**
1. Create an ACTIVE entry and submit a `forget()` request as non-PE
2. Before the PE reviews it, have the PE supersede the ACTIVE entry (creating a new version)
3. Navigate to `/pending` → the deprecation request row should now show an amber staleness badge, e.g. "Active version advanced from v1 to v2..."
4. PE can still approve or reject — the stale_warning is informational

**Checklist additions:**
| Check | Expected | Actual | Pass? |
|-------|----------|--------|-------|
| Non-PE forget() returns deprecation_requested | `status: "deprecation_requested"` | | |
| Duplicate forget() returns already_requested | `status: "already_requested"` | | |
| pending() includes deprecation_requests[] section | non-empty array | | |
| Dashboard Pending page shows "Deprecation requests" section | section visible | | |
| Non-PE sees no Approve/Reject buttons | buttons absent | | |
| PE approve → entry transitions to DEPRECATED | DEPRECATED in psql | | |
| PE reject → entry remains ACTIVE | ACTIVE in psql | | |
| Staleness badge appears after version advances | amber badge visible | | |
| MT-09: QUORUM_AUTHOR=claude → knowledge_status DRAFT | DRAFT regardless of confidence | | |
| MT-09: PostgreSQL row has author_type=agent | `author_type` = `agent` | | |
| MT-10: Non-PA write to is_global catalog → pending_review | `status: "pending_review"` | | |
| MT-10: DRAFT in psql, visible in PA pending() draft_reviews | DRAFT row exists | | |
| MT-10: PA write to global catalog → ACTIVE | `knowledge_status: "ACTIVE"` | | |
| MT-11: OAuth redirect contains correct client_id + scope | URL params verified | | |
| MT-11: sessionStorage quorum_jwt is ES256 JWT | valid JWT, alg:ES256 | | |
| MT-11: Expired token → login redirect, not 500 | login screen appears | | |
| MT-12: PKCE auth request has code_challenge_method=S256 | param present | | |
| MT-12: Wrong code_verifier → 400 invalid_grant | HTTP 400 | | |
| MT-12: Replayed code → 400 invalid_grant | HTTP 400 | | |

### Edit (supersede) Active entry
1. Click `⋯` on an ACTIVE row → "Edit" option appears
2. KnowledgeForm opens pre-filled with existing values
3. Modify content → submit → new version created; old version SUPERSEDED
4. Version history in drawer shows two entries
5. As non-PE user: verify `⋯` button is NOT visible

---

## MT-09 — Claude-Authored Writes Always Land as DRAFT

**Quality pillar:** Governance Integrity ⛔  
**Why automated test cannot reach it:** The `author === 'claude'` check lives inside
`storeFirst()` at module level in the MCP process. The gateway HTTP write path always
uses a human JWT — there is no HTTP-only way to inject `author: 'claude'` without
going through the MCP stdio layer.  
**Maps to:** `remember.js:storeFirst()` — `if (author === 'claude') status = 'DRAFT'`

### Prerequisites

- Full stack running including `quorum-mcp` server
- `QUORUM_AUTHOR=claude` set in the MCP server's environment (or set in `.env` loaded by the server)
- MCP client connected (Claude Code with `claude mcp add quorum ...`)

### Steps

**1. Confirm the env var reaches the MCP server**

In Claude Code terminal:
```bash
env | grep QUORUM_AUTHOR
# Expected: QUORUM_AUTHOR=claude
```

Restart the MCP server process so the env var is active.

**2. Write a knowledge entry with high confidence**

Via MCP tool call (Claude Code session):
```
remember(
  topic: "auth",
  key: "claude-draft-test",
  content: "This entry was authored by the Claude agent and must always land as DRAFT regardless of confidence.",
  confidence: 0.99
)
```

Expected response:
```json
{ "status": "stored", "knowledge_status": "DRAFT", "version": 1 }
```

NOT expected: `"knowledge_status": "ACTIVE"` — even confidence 0.99 must not produce ACTIVE.

**3. Verify status in PostgreSQL**

```bash
docker compose exec postgresql psql -U quorum -d quorum_audit \
  -c "SELECT version, status, confidence, author_type FROM knowledge_versions WHERE topic='auth' AND key='claude-draft-test';"
```

Expected:
- `status` = `DRAFT`
- `author_type` = `agent`
- `confidence` ≥ `base_confidence` (floored to role minimum, but status stays DRAFT)

**4. Verify the entry does NOT appear in Knowledge browser without PE filter**

Navigate to `/knowledge` in the dashboard (any user).  
Search for key `claude-draft-test` — the entry should NOT appear in the default ACTIVE list.  
Navigate to `/pending` → it should appear in "Draft entries — awaiting review."

**5. Confirm a non-claude MCP author produces ACTIVE (control)**

Unset `QUORUM_AUTHOR`, restart MCP server:
```bash
unset QUORUM_AUTHOR
# restart the MCP server
```

```
remember(
  topic: "auth",
  key: "human-active-test",
  content: "This entry has no QUORUM_AUTHOR=claude override — should land ACTIVE for PA role.",
  confidence: 0.90
)
```

Expected: `"knowledge_status": "ACTIVE"` (if the resolved identity is `principal_architect`).

### Pass criteria

- [ ] `remember()` with `QUORUM_AUTHOR=claude` returns `"knowledge_status": "DRAFT"` regardless of confidence
- [ ] PostgreSQL row has `status=DRAFT`, `author_type=agent`
- [ ] Entry visible in `/pending` "Draft entries" section, not in default Knowledge browser list
- [ ] Control write (no `QUORUM_AUTHOR=claude`) produces `ACTIVE` for a PA-role identity

---

## MT-10 — Global Catalog Write Returns `pending_review` for Non-PA

**Quality pillar:** Federation 🟡  
**Why automated test cannot reach it:** The HTTP write path uses a human JWT which always
carries an explicit role. The `pending_review` response is returned by the MCP layer when
a non-PA agent writes to a project with `is_global: true` — no HTTP-only equivalent exists
because the MCP process is the only layer that resolves `is_global` from project config and
wraps the response with `{ status: 'pending_review' }`.  
**Maps to:** `remember.js:storeFirst()` — `if (isGlobal && !identity.isPA) return { status: 'pending_review' }`

### Prerequisites

- Full stack running
- A project configured with `is_global: true` in its `.quorum` config (e.g. `security-standards`)
- MCP server connected to that project (`X-Quorum-Project: security-standards`)
- Identity resolving to a non-PA role (e.g. `architect` — `QUORUM_AUTHOR=arc-test`)

### Steps

**1. Confirm the target project is a global catalog**

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://localhost:3001/api/globals | jq '.[] | select(.group_id == "security-standards")'
```

Expected: the project appears with `is_global: true`.

**2. Write to the global catalog as a non-PA (architect role)**

In a Claude Code session where the MCP project context is `security-standards` and `QUORUM_AUTHOR` resolves to an `architect`:
```
remember(
  topic: "security",
  key: "jwt-expiry-policy",
  content: "All JWT access tokens must expire in ≤ 15 minutes. Refresh tokens may be long-lived with rotation.",
  entity_type: "Constraint",
  confidence: 0.88
)
```

Expected response:
```json
{
  "status": "pending_review",
  "message": "Entry written as DRAFT to global catalog 'security-standards'. A principal_architect must promote it to ACTIVE.",
  "version": 1,
  "knowledge_status": "DRAFT"
}
```

NOT expected: `{ "status": "stored", "knowledge_status": "ACTIVE" }`  
NOT expected: `{ "status": "forbidden" }` — architect+ can write, just not promote.

**3. Verify DRAFT in PostgreSQL**

```bash
docker compose exec postgresql psql -U quorum -d quorum_audit \
  -c "SELECT version, status, q_project_id FROM knowledge_versions WHERE topic='security' AND key='jwt-expiry-policy';"
```

Expected: `status=DRAFT` with the correct `q_project_id` for `security-standards`.

**4. Verify it surfaces in a PA's `pending()` call**

Switch to a PA identity and call:
```
pending()
```

Expected: the new DRAFT entry appears under `draft_reviews` with `triggered_by: 'remember'`.

**5. Control — PA write to global catalog produces ACTIVE**

Switch to a `principal_architect` identity in the same global project:
```
remember(
  topic: "security",
  key: "jwt-expiry-policy-pa",
  content: "PA-authored version — should land ACTIVE immediately.",
  confidence: 0.95
)
```

Expected: `{ "status": "stored", "knowledge_status": "ACTIVE" }` — PA writes skip the DRAFT gate.

### Pass criteria

- [ ] Non-PA (architect) write to `is_global: true` project returns `{ status: 'pending_review' }`
- [ ] PostgreSQL row has `status=DRAFT`
- [ ] Entry appears in PA's `pending()` `draft_reviews` section
- [ ] PA write to the same global project produces `ACTIVE` directly

---

## MT-11 — GitHub OAuth Browser Flow

**Quality pillar:** Security ⛔  
**Why automated test cannot reach it:** The full redirect dance (GitHub → gateway `/auth/callback`
→ JWT issue → sessionStorage) requires a real browser session and a configured GitHub OAuth app.
Playwright cannot authenticate against live GitHub without a real OAuth app client ID and secret,
and mocking the entire OAuth flow defeats the purpose of testing the redirect chain.  
**Maps to:** `gateway/src/routes/oauth.js` — full `GET /auth/github`, `GET /auth/callback` path

### Prerequisites

- Gateway running with a real GitHub OAuth app configured:
  ```bash
  GITHUB_CLIENT_ID=<your-oauth-app-client-id>
  GITHUB_CLIENT_SECRET=<your-oauth-app-client-secret>
  QUORUM_GATEWAY_URL=http://localhost:3001
  ```
- A real GitHub account that is a member of the Quorum project being tested
- Browser with developer tools open

### Steps

**1. Trigger the OAuth login flow**

Navigate to the dashboard: `http://localhost:3002`  
Click "Sign in with GitHub" — you should be redirected to `github.com/login/oauth/authorize`.

Verify the redirect URL contains:
- `client_id=<your-app-client-id>`
- `redirect_uri=http://localhost:3001/auth/callback`
- `scope=read:user`

**2. Authorise the app on GitHub**

After authorising, GitHub redirects to `http://localhost:3001/auth/callback?code=<code>&state=<state>`.

Watch the gateway logs:
```bash
docker compose logs -f gateway | grep -E "(auth|oauth|jwt|callback)"
```

Expected log sequence:
```
GET /auth/callback code=<redacted>
GitHub user resolved: <your-github-username>
JWT issued for sub=<your-github-username> is_admin=false
Redirect → http://localhost:3002/?token=<jwt>
```

**3. Verify JWT is stored in sessionStorage**

In browser DevTools → Application → Session Storage → `http://localhost:3002`:
- Key `quorum_jwt` should exist
- Value should be a valid JWT (three dot-separated base64 segments)

Decode the payload (middle segment, base64 decode):
```json
{
  "sub": "<your-github-username>",
  "is_admin": false,
  "iat": <timestamp>,
  "exp": <timestamp+1h>,
  "alg": "ES256"
}
```

**4. Verify the dashboard loads as an authenticated user**

After redirect, the dashboard should show:
- Your GitHub username in the top-right avatar/menu
- The Knowledge browser accessible (not a login gate)
- Role and project context visible in the sidebar

**5. Verify JWT is used in subsequent API calls**

In browser DevTools → Network:  
Navigate to `/knowledge` → watch the XHR request to `GET /api/knowledge`.  
Expected: `Authorization: Bearer <jwt>` header on every API request.

**6. Verify expiry produces a new login prompt**

Manually expire the token by editing `quorum_jwt` in sessionStorage to an expired JWT.  
Refresh the page — expected: redirected back to the login screen, not a 500 error.

### Pass criteria

- [ ] OAuth redirect to GitHub contains correct `client_id`, `redirect_uri`, `scope`
- [ ] After authorisation, gateway logs show correct username resolution + JWT issue
- [ ] `quorum_jwt` in sessionStorage is a valid ES256 JWT with `sub = your-github-username`
- [ ] Dashboard loads with correct identity after redirect
- [ ] All subsequent API calls include `Authorization: Bearer <jwt>`
- [ ] Expired token redirects to login — does not produce 500

---

## MT-12 — PKCE OAuth 2.1 MCP Client Authentication

**Quality pillar:** Security ⛔  
**Why automated test cannot reach it:** The Claude Code MCP client PKCE flow uses the
`authorization_code` grant with `code_verifier` exchange. This requires a live MCP client
(stdio) paired with a configured OAuth provider. There is no HTTP-only equivalent — the
PKCE verifier never leaves the MCP client process.  
**Maps to:** `gateway/src/routes/oauth.js` — PKCE token endpoint; MCP server auth bootstrap

### Prerequisites

- Gateway running with OAuth 2.1 + PKCE configured
- Claude Code with the Quorum MCP server registered via `claude mcp add quorum`
- A GitHub account or OAuth provider account that can authorise the MCP client
- Terminal with gateway logs visible

### Steps

**1. Trigger MCP client authentication**

In Claude Code, invoke any Quorum MCP tool without a pre-existing token:
```
pending()
```

Expected: Claude Code should open a browser window or prompt for authorisation.

**2. Observe the PKCE parameters in the authorization request**

Watch the browser URL or gateway logs. The authorization request should include:
- `code_challenge` — SHA256 hash of the code verifier (base64url encoded)
- `code_challenge_method=S256`
- `response_type=code`
- A unique `state` parameter

**3. Complete authorisation**

Authorise in the browser. The gateway receives the callback with `code`.

Watch gateway logs for the token exchange:
```
POST /oauth/token
grant_type=authorization_code
code_verifier=<verifier>
Token issued for sub=<username> client=quorum-mcp
```

**4. Verify code_verifier validation**

Attempt a token exchange with an incorrect `code_verifier` (tamper the value):
```bash
curl -X POST http://localhost:3001/oauth/token \
  -d "grant_type=authorization_code&code=<valid-code>&code_verifier=wrong_verifier&redirect_uri=..."
```

Expected: `400 { "error": "invalid_grant", "error_description": "code_verifier mismatch" }`

**5. Verify the issued JWT is ES256**

The MCP client should now have a JWT. Extract it from the MCP server session (check logs or MCP debug output).  
Decode the header (first segment): `{ "alg": "ES256", "kid": "<key-id>", "typ": "JWT" }`

**6. Verify the MCP client can now make authenticated calls**

In Claude Code:
```
pending()
```

Expected: returns the pending decisions for the configured project — not an auth error.

**7. Verify replay attack prevention**

Attempt to reuse the same `code` after a successful exchange:
```bash
curl -X POST http://localhost:3001/oauth/token \
  -d "grant_type=authorization_code&code=<already-used-code>&code_verifier=<correct-verifier>&..."
```

Expected: `400 { "error": "invalid_grant", "error_description": "code already redeemed" }`

### Pass criteria

- [ ] Authorization request includes `code_challenge`, `code_challenge_method=S256`
- [ ] Token exchange with correct `code_verifier` produces a valid ES256 JWT
- [ ] Token exchange with wrong `code_verifier` returns `400 invalid_grant`
- [ ] Issued JWT has `alg: ES256` in header
- [ ] MCP client can make authenticated API calls after PKCE flow completes
- [ ] Replayed authorization code is rejected with `400 invalid_grant`

---

## Filing Bugs

For any failed check, capture:

```bash
# Server logs
npm start 2>&1 | tee /tmp/quorum-test.log

# Database state at failure
docker compose exec postgresql psql -U quorum -d quorum_audit \
  -c "\dt" \
  -c "SELECT COUNT(*) FROM audit_log;" \
  -c "SELECT topic, key, version, status FROM knowledge_versions ORDER BY topic, key, version;"

# Chain state
node cli.js audit verify
node cli.js audit stats
```

Include the log, database state, and the exact tool call that produced the unexpected result.
