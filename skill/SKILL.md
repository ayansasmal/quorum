---
name: quorum
description: >
  Quorum — persistent, governed engineering memory for Claude Code and AI agents.
  Use when working on any engineering task where institutional knowledge, architectural
  decisions, patterns, or constraints are relevant. This skill governs how the agent
  reads from and writes to Quorum's temporal knowledge graph.
---

# Quorum Skill

Quorum is a **governed engineering memory** built on a temporal knowledge graph.
It stores architectural decisions, patterns, constraints, runbooks, and requirements
with full provenance, versioning, and human-in-the-loop conflict resolution.

**Your responsibilities as an agent using this skill:**

1. Check for pending decisions at session start
2. Recall relevant knowledge before making implementation choices
3. Surface pending human decisions and relay responses back
4. Extract and store learnable knowledge after task completion

---

## Session Start Protocol

**Always do this at the beginning of every session.**

### Step 1 — Surface Pending Decisions

Call `pending()` immediately. This returns unresolved conflict briefs and DRAFT
knowledge awaiting human review:

```
pending()
```

If `summary.total_pending > 0`, present the items to the human **before starting work**:

**For each `conflict_brief`:**
- Show: topic, key, the two conflicting versions, author of each, and the LLM-generated analysis
- If `stale_warning` is set: mention that the conflict context is stale and has been updated
- If `more_pending_same_key > 0`: note that more conflicts are queued for this key — resolve in order
- Ask the human to choose: `supersede` | `coexist` | `reject` | `escalate`
- Relay their decision back via `remember()` with `resolution: "<choice>"` and a mandatory reason

**For each `draft_review`:**
- Show: topic, key, content, author, triggered_by (e.g. `reflect`, `pr_merge`)
- Ask: approve, reject, or request changes?
- Relay via `review(action, topic, key, note)` — note is mandatory

If no pending items: proceed directly to work.

### Step 2 — Load Domain Context

Before starting any engineering task, search Quorum for relevant context:

```
search("<task domain or keywords>")
```

Examples:
- Working on auth → `search("authentication token strategy")`
- Fixing a DB bug → `search("database connection pool migration")`
- Reviewing a PR → `search("<component or feature name>")`

Recall specific topic:key pairs when you know them:

```
recall("auth", "token-strategy")
recall("db", "connection-pooling")
recall("infra", "retry-strategy")
```

**Use recalled knowledge to inform your implementation.** If a pattern exists, follow it.
If an architectural decision exists, respect it — or explicitly surface why you're deviating.

---

## During Task

### When to Recall

Recall proactively whenever you are about to:
- Make a technical decision (auth strategy, error handling, data model)
- Implement a pattern that might already be established
- Hit a constraint that might already be documented
- Write code in a domain with known architecture decisions

### When to Remember Mid-Task

If you discover something significant that should not wait until task completion,
call `remember()` immediately:

```
remember(
  topic: "auth",
  key: "token-rotation-window",
  content: "...",
  confidence: 0.80,
  tags: ["auth", "security"]
)
```

**Do not pass `author` — it is resolved server-side from your execution context.**

Typical mid-task triggers:
- You discover an undocumented constraint that blocked you
- You make a significant architectural choice mid-task
- You find an existing pattern being violated elsewhere and want to flag it

---

## After Task Completion

**Always do this before closing a session or marking a task complete.**

### Step 1 — Self-Check

Ask yourself:
- Did I make a decision that a future engineer should know about?
- Did I discover something about this domain that isn't in Quorum yet?
- Did I apply a pattern that others should reuse?
- Did I uncover a constraint (infra, legal, tech debt) that wasn't documented?
- Would a new engineer benefit from knowing what I just learned?

If any answer is yes → go to Step 2. If all no → skip.

### Step 2 — Reflect

Call `reflect()` with a summary of the task, decisions made, and patterns used:

```
reflect(
  task_summary: "Implemented JWT rotation with 15-minute window. Discovered Lambda
    environment does not support persistent session state — stateless JWT is required.",
  decisions_made: [
    "JWT over sessions — Lambda statelessness constraint",
    "15-minute window — balances security and UX"
  ],
  patterns_used: [
    "Bearer token in Authorization header",
    "Refresh token in HttpOnly cookie"
  ]
)
```

`reflect()` will:
- Extract individual learnable entries (decisions, patterns, constraints) via LLM
- Call `remember()` for each entry
- Return a list of what was stored and any conflicts detected

**All knowledge extracted via `reflect()` enters as DRAFT with `triggered_by: reflect`.**
A human must review and approve via `review("approve", ...)` before it becomes ACTIVE.
This is intentional — Claude-authored knowledge requires human validation.

---

## Tool Reference

### `remember(topic, key, content, confidence?, tags?)`

Store or update a knowledge node. Always creates a new version — never edits in place.

- `topic`: domain namespace (`auth`, `api`, `db`, `infra`, `testing`, `payments`, ...)
- `key`: unique identifier within topic (`token-strategy`, `error-standards`, ...)
- `content`: the knowledge to store — be specific, include rationale
- `confidence`: 0.0–1.0 (default 0.70). Use your role's `base_confidence` as a floor.
- `tags`: optional array for cross-domain searchability

**Do not pass `author` or `reviewer`** — both are injected server-side.

If a conflict is detected, `remember()` will either:
- Auto-supersede if authority is clear (returns `status: "superseded"`)
- Return `status: "conflict_detected"` with a conflict brief → surface to human

### `recall(topic, key, options?)`

Retrieve knowledge. Options:
- Default: returns the latest ACTIVE version only
- `{ history: true }`: full version chain v1 → vN
- `{ at: "2024-11-30" }`: version that was ACTIVE on a specific date (audit queries)
- `{ version: 3 }`: specific version, with supersession note if applicable

Returns XML-wrapped context. Pay attention to:
- `confidence` — below 0.60 means this knowledge may be stale or unverified
- `triggered_by: reflect` — Claude-authored, may still be DRAFT
- `status: SUPERSEDED` — use current ACTIVE version instead

### `search(query, domain?, limit?)`

Semantic + BM25 + graph traversal search across all ACTIVE knowledge.
- `domain`: optional filter (`auth`, `db`, etc.)
- `limit`: default 10, max 50

Returns ranked results with provenance (author, confidence, version).

### `pending(topic?)`

Returns all unresolved conflicts and DRAFT entries awaiting review.
- `topic`: optional filter

Call this at session start and whenever the human asks "what needs review?"

### `review(action, topic, key, note)`

Resolve a DRAFT knowledge entry:
- `action`: `"approve"` | `"reject"` | `"request_changes"`
- `note`: mandatory — the reason for the decision (min 10 meaningful characters)

Constitutional rule: **you cannot review your own entries**. If you wrote it (via reflect),
a human must review it — relay the `review()` call on their behalf.

### `reflect(task_summary, decisions_made, patterns_used)`

Post-task knowledge extraction. Call once per task completion.

- `task_summary`: 1–3 sentences describing what was done and why
- `decisions_made`: array of decision strings
- `patterns_used`: array of pattern strings

### `history(topic, key)`

Full version timeline for a knowledge node — shows v1 → vN with authored reasons,
triggered_by, and audit entry references. Use when you need lineage context before
making a change that supersedes existing knowledge.

### `forget(topic, key, reason)`

Deprecate knowledge — never hard deletes. Requires a reason (min 10 chars).
Use when knowledge is definitively obsolete, not just superseded.

### `export(topic?, format)`

Export knowledge to human-readable format.
- `format`: `"markdown"` | `"confluence"`
- `topic`: optional — omit for full export

---

## Knowledge Entry Guidelines

### What to Store

| Type | When | Examples |
|------|------|---------|
| **Decision** | Architectural or technical choice with rationale | "Use JWT over sessions — Lambda is stateless" |
| **Pattern** | Reusable approach the team has adopted | "Error responses follow RFC 7807 Problem Detail" |
| **Constraint** | Non-functional requirement or technical boundary | "Lambda functions cannot use persistent filesystem" |
| **Runbook** | Operational procedure or non-obvious fix | "Rotate KMS key: notify team 48h before, then..." |
| **Requirement** | Business or technical requirement with acceptance criteria | "All API calls must complete within 300ms p99" |

### What NOT to Store

- Information that is already in git history, PRs, or source code comments
- Trivial facts with no governance value
- Temporary workarounds you intend to revert
- Personal preferences not agreed upon by the team
- Secrets, credentials, or PII

### Confidence Guidelines

| Role | Base Confidence |
|------|----------------|
| Principal Architect | 0.90 |
| Senior Engineer | 0.80 |
| Engineer | 0.70 |
| Junior | 0.60 |
| Claude / reflect | 0.55 (always DRAFT) |
| Anonymous | 0.50 (always DRAFT) |

Your confidence floor is determined by your configured role. Do not pass a value
below your floor — the server will enforce it.

---

## Domain Conventions

Use these topic namespaces consistently:

| Topic | Examples of keys |
|-------|-----------------|
| `auth` | `token-strategy`, `delegation-flow`, `rate-limiting`, `session-management` |
| `api` | `error-standards`, `versioning`, `pagination`, `response-format` |
| `db` | `connection-pooling`, `migration-strategy`, `naming-conventions`, `indexing` |
| `infra` | `secrets-management`, `retry-strategy`, `deployment-gates`, `scaling-policy` |
| `testing` | `unit-strategy`, `integration-scope`, `contract-testing`, `e2e-boundaries` |
| `payments` | `refund-policy`, `idempotency`, `webhook-verification`, `pci-scope` |
| `security` | `threat-model`, `csp-policy`, `dependency-scanning`, `pen-test-findings` |

New domains are fine — just be consistent within a project.

---

## Conflict Resolution Guide

When `pending()` returns conflict briefs, present them clearly:

```
🔀 Conflict: auth:token-strategy

  Existing (v2 — ACTIVE, by @senior-architect, confidence 0.85):
    "Use JWT for all services — sessions don't work with Lambda"

  Incoming (by @junior-dev, confidence 0.60):
    "Use sessions for the web frontend — simpler to implement"

  Analysis: The existing decision was made specifically because Lambda
    is stateless. Sessions require server-side state. The incoming
    suggestion may be valid for non-Lambda services but contradicts
    the constraint.

  Risks if approved: Lambda-backed API routes will fail on auth.
  Questions for reviewer: Is the frontend backed by Lambda or a
    persistent server?

  Options:
    A) supersede — incoming replaces existing (requires strong reason)
    B) coexist   — both are valid in different contexts (split into two keys)
    C) reject    — incoming is incorrect or premature
    D) escalate  — needs a senior reviewer before deciding
```

After the human decides, relay their choice:

```
# Option A — supersede
remember("auth", "token-strategy",
  "Use JWT for Lambda routes; sessions allowed for server-rendered frontend only",
  resolution: "supersede",
  reason: "Frontend is nginx-backed, not Lambda — sessions are valid there"
)

# Option C — reject
remember("auth", "token-strategy",
  ...,
  resolution: "reject",
  reason: "Lambda statelessness constraint makes sessions impossible for API routes"
)
```

---

## Constitutional Rules (Never Violate)

These are hardcoded invariants — the server will reject violations:

1. **No hard delete** — never call delete on any knowledge node. Use `forget()` with reason.
2. **Audit is append-only** — every operation is logged. The audit chain cannot be modified.
3. **Reason required** — any operation that supersedes or deprecates requires a reason (≥10 meaningful characters). No TODOs, N/As, or empty strings.
4. **No self-approval** — you cannot review/approve knowledge you authored. Surface to the human.
5. **Claude knowledge is always DRAFT** — everything you write via `reflect()` or `remember()` when operating as an AI agent enters as DRAFT and requires human review before becoming ACTIVE.

---

## Adding Quorum to a New Project

```bash
# Create project file (committed to repo)
quorum init

# Or manually:
echo '{ "gateway_url": "http://localhost:3001", "project_id": "my-team" }' > .quorum

# Register with Claude Code
claude mcp add quorum -- node /path/to/quorum/src/server.js

# Set identity (choose one):
export QUORUM_GITHUB_TOKEN=ghp_...    # most authoritative
export QUORUM_AUTHOR=your-username    # for CI contexts
```

The `.quorum` file is auto-discovered by walking up the directory tree — you do not need
to set `QUORUM_GATEWAY_URL` or `QUORUM_PROJECT_ID` if the file is present in the project root.

---

## Quick Reference

```
Session start:
  pending()                              ← surface decisions first
  search("task domain")                  ← load relevant context

During work:
  recall("topic", "key")                 ← get specific knowledge
  remember("topic", "key", "content")    ← store new knowledge

After task:
  reflect(task_summary, decisions, patterns)  ← extract learnings

Review pending:
  review("approve", "topic", "key", "reason")
  review("reject", "topic", "key", "reason")

History and audit:
  history("topic", "key")               ← version timeline
  export("topic", "markdown")           ← human-readable dump
```
