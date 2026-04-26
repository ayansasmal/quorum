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
- Ask the human to choose: `supersede` | `coexist_split` | `coexist_merge` | `reject` | `escalate`
- Relay their decision back via `remember()` with the original `conflict_id`, `resolution: "<choice>"`, and a mandatory reason

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

If any answer is yes → go to Step 2. If all no → **skip entirely**.

### Over-Extraction Guard

**Do NOT call `reflect()` for these sessions — the DRAFT queue is a shared resource:**

| Session type | Action |
|-------------|--------|
| Pure read session (recall, search only) | Skip reflect |
| Debugging session with no decisions made | Skip reflect |
| Task abandoned / rolled back | Skip reflect |
| Documentation only, no implementation | Skip reflect |
| Repeated work covered by existing knowledge | Skip reflect |

Only call `reflect()` when you made choices with genuine rationale — not observations,
not temporary workarounds, not personal style preferences.

**Quality bar:** Each entry extracted by `reflect()` should pass this test:
> "If a senior engineer asked me 'why did you do X?', would this entry be the answer?"

If the extracted entry is just "I used a for-loop", skip it. If it is "I used polling instead
of a push callback because the upstream API does not support webhooks", store it.

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
- Deduplicate against existing DRAFT entries via content hash — identical content is silently skipped
- Call `remember()` for each novel entry
- Return a list of what was stored, skipped, and any conflicts detected

**All knowledge extracted via `reflect()` enters as DRAFT with `triggered_by: reflect`.**
A human must review and approve via `review("approve", ...)` before it becomes ACTIVE.
This is intentional — Claude-authored knowledge requires human validation.

### Step 3 — DRAFT Notification

When `reflect()` stores entries, a webhook notification fires automatically to any
configured channel (Slack, webhook URL). **You do not need to poll `pending()` again.**
The reviewer will be notified and will use `review()` in their next session.

If no webhook is configured, remind the human:
> "X entries stored as DRAFT — review them in the **Quorum dashboard → Pending Decisions**
> (`http://localhost:3002/pending`), or run `pending()` at the start of your next session."

The dashboard is the preferred review surface: it shows the full conflict brief, both
versions side-by-side, the LLM analysis, and the decision buttons — no terminal needed.

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
- `status: PENDING_CONFLICT_CHECK` — Graphiti was unavailable when stored; conflict check is pending. Treat as tentative — do not treat it as confirmed ACTIVE.
- `source: global` — read from global namespace; **do not supersede from this project**. Only a principal architect with global scope can update global knowledge.

Frequent recall of an entry by multiple sessions automatically increases its domain track
record signal — the authority formula rewards knowledge that is actively used, not just
knowledge that is recent or from a senior author.

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
   conflict_id: "cfl_abc123"    ← carry this into remember()

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
    A) supersede      — incoming replaces existing entirely (requires strong reason)
    B) coexist_split  — fork into two scoped keys (e.g. auth:token-strategy-lambda
                        and auth:token-strategy-web) — use when BOTH are valid in
                        different contexts. Requires split_existing_key and
                        split_incoming_key.
    C) coexist_merge  — write a single combined entry that reconciles both (use when
                        the incoming adds nuance rather than contradicting). Requires
                        merged_content.
    D) reject         — incoming is incorrect or premature
    E) escalate       — needs a senior reviewer before deciding
```

After the human decides, relay their choice. **Always include `conflict_id`** — without
it `remember()` treats the call as a new write, not a conflict resolution:

```
# Option A — supersede
remember("auth", "token-strategy",
  content: "Use JWT for Lambda routes; sessions allowed for server-rendered frontend only",
  conflict_id: "cfl_abc123",
  resolution: "supersede",
  reason: "Frontend is nginx-backed, not Lambda — sessions are valid there"
)

# Option B — coexist_split (fork into two scoped keys)
remember("auth", "token-strategy",
  content: "...",
  conflict_id: "cfl_abc123",
  resolution: "coexist_split",
  split_existing_key: "token-strategy-lambda",
  split_incoming_key: "token-strategy-web",
  reason: "Both are valid — Lambda requires JWT, nginx frontend can use sessions"
)

# Option C — coexist_merge (single reconciled entry)
remember("auth", "token-strategy",
  content: "...",
  conflict_id: "cfl_abc123",
  resolution: "coexist_merge",
  merged_content: "Use JWT for Lambda services (stateless); sessions valid for nginx-backed frontend only",
  reason: "Incoming adds valid nuance — not a true contradiction"
)

# Option D — reject
remember("auth", "token-strategy",
  content: "...",
  conflict_id: "cfl_abc123",
  resolution: "reject",
  reason: "Lambda statelessness constraint makes sessions impossible for API routes"
)
```

---

## The Self-Evolution Loop

Quorum builds authority automatically from usage — no curation required beyond normal work:

```
recall() ──────────────────────► recalled_count +1 (per domain)
review("approve", ...) ────────► approved_count +1 (per domain)
remember() supersedes older ──► superseded_count +1 (for old author)
```

After a few weeks of active use, the authority formula will weight knowledge from
engineers whose work:
- Gets recalled often (teams trust it for context)
- Gets approved by reviewers (peers validated it)
- Rarely gets superseded (it was right the first time)

**What this means for you:** calling `recall()` is not just retrieving — it is casting a
vote. When you recall knowledge to inform your implementation, you are contributing to
that author's domain track record. Over time, the system learns whose knowledge in which
domains is most reliable.

---

## Constitutional Rules (Never Violate)

These are hardcoded invariants — the server will reject violations:

1. **No hard delete** — never call delete on any knowledge node. Use `forget()` with reason.
2. **Audit is append-only** — every operation is logged. The audit chain cannot be modified.
3. **Reason required** — any operation that supersedes or deprecates requires a reason (≥10 meaningful characters). No TODOs, N/As, or empty strings.
4. **No self-approval** — you cannot review/approve knowledge you authored. Surface to the human.
5. **Claude knowledge is always DRAFT** — everything you write via `reflect()` or `remember()` when operating as an AI agent enters as DRAFT and requires human review before becoming ACTIVE.

---

## Onboarding a Project to Quorum

**Trigger phrases:** "add this project to Quorum", "onboard this project", "set up Quorum here",
"connect this project to Quorum", "initialize Quorum for this repo".

When you detect one of these, follow this protocol **in order**. Execute each step yourself
using your available tools (Bash, Read, Write) — do not ask the human to run commands
unless explicitly noted.

---

### Phase 1 — Check for existing setup

```bash
# Check for prior onboarding
ls -la .quorum quorum.config.json .claude/skills/quorum.md 2>/dev/null
```

If `.quorum` already exists → confirm with human before re-onboarding. The `project_id`
in that file is the active namespace; onboarding again will overwrite config in S3.

---

### Phase 2 — Gather team information

Ask the human (one prompt, not one question at a time):

> "To onboard this project I need:
> 1. **Project ID** — a short slug, e.g. `platform-team` (default: current directory name)
> 2. **Team members** — for each person: name, GitHub username, git email, role
>    (`principal_architect` | `senior_engineer` | `engineer` | `junior`)
> 3. **Key domains** — any domain that needs stricter governance, e.g. `auth`, `payments`
>    (optional — standard thresholds apply to all domains otherwise)
> 4. **Gateway URL** — where Quorum gateway is running (default: `http://localhost:3001`)"

Do not proceed to Phase 3 until you have at least a project ID and one team member.

---

### Phase 3 — Create and validate the project config

Write `quorum.config.json` in the current directory:

```json
{
  "project": "<project_id>",
  "group_id": "<project_id>",
  "members": [
    {
      "name": "<name>",
      "team": "<team>",
      "role": "<role>",
      "github_username": "<github_username>",
      "git_email": "<git_email>"
    }
  ],
  "roles": {
    "principal_architect": { "base_confidence": 0.90 },
    "senior_engineer":     { "base_confidence": 0.80 },
    "engineer":            { "base_confidence": 0.70 },
    "junior":              { "base_confidence": 0.60 }
  },
  "domains": {},
  "thresholds": {
    "conflict_threshold": 0.85,
    "authority_threshold": 0.20
  }
}
```

Populate `domains` from what the human provided. If they specified required reviewer
teams for a domain, add them:
```json
"auth": { "conflict_threshold": 0.90, "required_reviewer_teams": ["platform"] }
```

Then validate before uploading:

```bash
GATEWAY_URL="${QUORUM_GATEWAY_URL:-http://localhost:3001}"
curl -s -X POST "$GATEWAY_URL/config/validate" \
  -H "Content-Type: application/json" \
  -d @quorum.config.json
```

If `"valid": false` → fix the errors reported in the response and re-validate.
Do not proceed to Phase 4 until `"valid": true`.

---

### Phase 4 — Upload config to S3

```bash
PROJECT_ID=$(node -e "console.log(require('./quorum.config.json').project)")

# Local dev (LocalStack)
awslocal s3 cp quorum.config.json \
  "s3://quorum-configs/${PROJECT_ID}/config.json" \
  --endpoint-url http://localhost:4566

# Production (real S3) — use this if AWS_ENDPOINT_URL is not set
# aws s3 cp quorum.config.json "s3://quorum-configs/${PROJECT_ID}/config.json"
```

Verify the upload:
```bash
awslocal s3 ls "s3://quorum-configs/${PROJECT_ID}/" --endpoint-url http://localhost:4566
```

---

### Phase 5 — Create the `.quorum` discovery file

```bash
QUORUM_PATH=$(which quorum 2>/dev/null || echo "node $(pwd)/../quorum/cli.js")
$QUORUM_PATH init \
  --gateway-url "${QUORUM_GATEWAY_URL:-http://localhost:3001}" \
  --project-id "$PROJECT_ID" \
  --yes
```

This writes `.quorum` to the current directory. The MCP server auto-discovers it on
startup — engineers do not need to set env vars manually.

---

### Phase 6 — Install identity and register MCP

Tell the human what environment variables to set (they must do this in their shell):

> Set these in your shell profile (`~/.zshrc` or `~/.bashrc`) or in a `.env` file:
> ```bash
> export QUORUM_GITHUB_TOKEN=ghp_...   # GitHub PAT with read:user scope — most authoritative
> # export QUORUM_AUTHOR=your-username  # CI contexts only (no PAT available)
> ```
>
> Then register the MCP server with Claude Code:
> ```bash
> claude mcp add quorum -- node /path/to/quorum/src/server.js
> ```

Verify auth works (ask human to run this after setting their token):
```bash
curl -s -X POST "${QUORUM_GATEWAY_URL:-http://localhost:3001}/auth/token" \
  -H "Content-Type: application/json" \
  -d "{\"github_token\":\"$QUORUM_GITHUB_TOKEN\",\"project_id\":\"$PROJECT_ID\"}"
```
Expected: `{ "token": "eyJ...", "sub": "<github_username>", "project": "<project_id>", ... }`

---

### Phase 7 — Install the Quorum skill

```bash
QUORUM_REPO_PATH=$(dirname $(which quorum 2>/dev/null) || echo "../quorum")
mkdir -p .claude/skills
cp "${QUORUM_REPO_PATH}/../skill/SKILL.md" .claude/skills/quorum.md
```

If the path resolution fails, ask the human for the Quorum repo path and copy manually.

---

### Phase 8 — Ingest existing project knowledge

This is the highest-value onboarding step. The project's CLAUDE.md, MEMORY.md, and
past Claude Code session memories contain institutional knowledge that should be governed
— not just sitting in flat files.

**8a — Read CLAUDE.md**

```bash
cat CLAUDE.md 2>/dev/null || cat .claude/CLAUDE.md 2>/dev/null
```

Extract every statement that is:
- An architectural decision ("we use X because Y")
- A constraint ("do not do X", "always do Y")
- An established pattern ("errors follow RFC 7807")
- A named convention ("all tables use snake_case")

For each extracted statement, call `remember()` — classify it as the appropriate domain
(`auth`, `api`, `db`, `infra`, `testing`, etc.) and set a key that matches the convention
table in this skill:

```
remember(
  topic: "api",
  key: "error-standards",
  content: "All API errors follow RFC 7807 Problem Detail format: type, title, status, detail",
  confidence: 0.75,
  tags: ["api", "errors", "conventions"]
)
```

**All entries enter as DRAFT with `triggered_by: onboard`** — nothing becomes ACTIVE
without human review. This is intentional.

**8b — Read MEMORY.md** (Claude Code auto-memory)

```bash
# Claude Code stores auto-memory here:
cat ~/.claude/projects/$(echo $PWD | tr '/' '-')/memory/MEMORY.md 2>/dev/null
# Or check the .claude/memory/ directory in the project:
cat .claude/memory/MEMORY.md 2>/dev/null
```

Extract the same categories as 8a. Pay special attention to:
- Architecture choices recorded across sessions
- Decisions made about patterns or technology choices
- Constraints that emerged from debugging sessions

**8c — Extract from recent session transcripts** (optional, ask human first)

> "I can also extract knowledge from your recent Claude Code session transcripts.
> These contain decisions made during actual work sessions. Want me to do that?
> (I will only read sessions from this project directory.)"

If yes, find the session file:
```bash
ls -lt ~/.claude/projects/$(echo $PWD | tr '/' '-')/*.jsonl 2>/dev/null | head -5
```

Read the most recent 1–3 sessions. Look for:
- Messages where a decision was stated with a reason
- Messages where a constraint was discovered
- Any `reflect()` calls that were made (these may already be in Quorum as DRAFT)

Do not re-ingest anything that is already in Quorum — call `search()` first for
each candidate to check for duplicates.

---

### Phase 9 — Commit onboarding files

```bash
git add quorum.config.json .quorum .claude/skills/quorum.md
git commit -m "chore: onboard project to Quorum governed memory

- quorum.config.json: team members, roles, domain thresholds
- .quorum: gateway auto-discovery file
- .claude/skills/quorum.md: Quorum session skill for Claude Code"
```

Do not commit `.env` or files containing `QUORUM_GITHUB_TOKEN`.

---

### Phase 10 — Verify the connection

Tell the human to start a fresh Claude Code session and run:

> "What pending Quorum decisions are there?"

Claude should call `pending()` and return either the DRAFT entries from Phase 8
or "No pending items — ready to start."

If Quorum is unreachable, check:
```bash
curl http://localhost:3001/health   # gateway health (all 4 components)
```

---

### Onboarding summary

| Phase | What happens |
|-------|-------------|
| 1 | Check for existing setup |
| 2 | Gather team info (one prompt) |
| 3 | Write + validate `quorum.config.json` |
| 4 | Upload config to S3 |
| 5 | Create `.quorum` discovery file |
| 6 | Identity env vars + MCP registration |
| 7 | Copy SKILL.md to `.claude/skills/` |
| 8 | Ingest CLAUDE.md, MEMORY.md, session transcripts as DRAFT |
| 9 | Commit onboarding files |
| 10 | Verify connection |

The `.quorum` file is auto-discovered by walking up the directory tree — engineers
in any subdirectory of the repo will automatically connect to the right project.

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

Review pending (dashboard preferred):
  http://localhost:3002/pending          ← full UI with side-by-side diff
  review("approve", "topic", "key", "reason")  ← or relay from Claude
  review("reject", "topic", "key", "reason")

Conflict resolution (always include conflict_id):
  remember(..., conflict_id: "cfl_...", resolution: "supersede"|"coexist_split"|"coexist_merge"|"reject"|"escalate", reason: "...")

History and audit:
  history("topic", "key")               ← version timeline
  export("topic", "markdown")           ← human-readable dump

Onboarding a new project:
  "add this project to Quorum"          ← triggers 10-phase onboarding protocol
  "onboard this project"                ← same trigger
```
