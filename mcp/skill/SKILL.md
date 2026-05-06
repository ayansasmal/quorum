---
name: quorum
description: >
  Quorum — persistent, governed engineering memory for Claude Code and AI agents.
  Invoke when working on any engineering task where architectural decisions, patterns,
  constraints, or institutional knowledge are relevant.
---

# Quorum Skill

Quorum is a **governed temporal knowledge graph** for engineering teams. It stores
decisions, patterns, constraints, and runbooks with full versioning, conflict detection,
authority weighting, and a tamper-evident audit trail.

**Your responsibilities — in priority order:**
1. Surface pending decisions at session start — non-negotiable
2. Recall relevant knowledge **before** making implementation choices — proactively, without being asked
3. Capture decisions and constraints the moment they are made — not at the end
4. Extract and submit learnable knowledge after the task — via `reflect()`
5. Relay human conflict resolutions — you cannot self-approve
6. Discover latent knowledge in existing files and surface candidates for human confirmation

---

## Session Start (always, without being asked)

### Step 0 — Is this project connected to Quorum?

```bash
ls .quorum 2>/dev/null
```

| Result | Action |
|--------|--------|
| Not found | Ask once: *"I don't see a `.quorum` file. Want me to onboard this project to Quorum?"* |
| Found, but graph is empty (< 5 entries) | Run discovery scan — CLAUDE.md + MEMORY.md + recent git log — before Step 1 |
| Found, graph has entries | Skip scan — go straight to Step 1 |

---

### Step 1 — Surface pending items

```
pending()    ← returns conflict_briefs and draft_reviews — handle them differently
```

| Return type | How to handle |
|-------------|--------------|
| `conflict_briefs` — unresolved conflicts | **Block on resolution before writing any code.** Present each conflict and get human decision. See Conflict Resolution section. |
| `draft_reviews` — DRAFTs awaiting approval | **Do not block.** Note them: *"N DRAFT entries await your review at http://localhost:3002/pending."* Then continue. |

---

### Step 2 — Load relevant context

Read the task and infer all domains involved. Pull knowledge for each upfront:

| Task mentions | Search |
|--------------|--------|
| auth, login, token, session, OAuth | `search("auth")` |
| database, query, migration, schema | `search("db")` |
| API, endpoint, REST, HTTP | `search("api")` |
| deploy, infra, secrets, container | `search("infra")` |
| test, coverage, mock, integration | `search("testing")` |
| payment, billing, subscription | `search("payments")` |
| security, vulnerability, CVE, audit, pentest | `search("security")` |
| cache, Redis, CDN, TTL, invalidation | `search("caching")` |
| monitoring, alerts, metrics, SLO, SLA, observability | `search("monitoring")` |
| queue, worker, job, async, event-driven, consumer | `search("async")` |
| **No keyword matches** | `search("<raw task description literally>")` |

---

## During Task — Proactive Knowledge Use

Do not wait to be asked. When you encounter any of these, act immediately:

### You are about to make an implementation choice

**Two-tool pattern — always in this order:**

```
search("what you're about to decide")    ← find candidate keys
recall("topic", "key")                   ← load the exact entry once you know the key
```

`search()` is for **exploration** — use it when you don't know the exact key.
`recall()` is for **precision** — use it once `search()` has surfaced the right key.
Never call `recall()` with a guessed key — if the key doesn't exist, you get nothing back.

Examples:
- Choosing an auth mechanism → `search("auth token")` → `recall("auth", "token-strategy")`
- Writing a database query → `search("db connection")` → `recall("db", "connection-pooling")`
- Designing an API response → `search("api errors")` → `recall("api", "error-standards")`
- Handling a retry → `search("retry backoff")` → `recall("infra", "retry-strategy")`

**If recalled knowledge contradicts what you were about to do** → stop, surface the
conflict to the human, do not silently override.

**Reading recalled entries — act on these signals:**

| Signal in recall response | What to do |
|--------------------------|-----------|
| `confidence < 0.60` | Treat as hypothesis, not constraint. Flag to human before applying. |
| `status: SUPERSEDED` | Fetch the ACTIVE version — never apply a superseded entry. |
| `triggered_by: reflect` + `status: DRAFT` | Not yet human-approved. Verify with human before using as a hard constraint. |
| `source: global` | Company-wide policy. Do not supersede from this project. Escalate conflicts upward. |

**Before superseding any existing entry:**

```
history("topic", "key")   ← understand why prior versions were written before overwriting
```

Never supersede without reading the history. An entry may have gone through deliberate
reversals — superseding blindly can undo months of governed decisions.

---

### You discover a new constraint

Call `remember()` **immediately** — do not wait for the task to finish.
Constraints discovered mid-task are the most valuable kind; they get lost otherwise.

**Key naming:** kebab-case noun-phrase, specific enough to be unique within the topic.
Good: `connection-pool-size`. Bad: `db_stuff`, `connectionPoolingDecision`, `config`.

```javascript
remember("domain", "key", "constraint statement", {
  confidence: 0.80,
  tags: ["domain", "constraint-type", "affected-component"],
  reason: "discovered while implementing X"
})
```

**Tags are cross-domain search hooks.** Tag with: the domain (`auth`), the constraint
type (`performance`, `security`, `limit`), and affected component (`lambda`, `postgres`).
Example: `tags: ["auth", "security", "lambda"]` makes an auth constraint findable from
a Lambda or security search. Skip tags only for entries purely self-contained within one domain.

If `remember()` returns `stored_pending_conflict_check` → tell the human:
*"Entry stored but conflict check was deferred (Graphiti unavailable). Review at /pending
once the graph is back — a hidden conflict may exist."*

---

### You see existing knowledge being violated

```javascript
remember("domain", "key", "corrected statement", {
  reason: "existing entry conflicts with current implementation — see PR #...",
  confidence: 0.85
})
```

This creates a conflict for human review. Do not silently override existing knowledge.

---

### Sensitive domains — pull everything, not just one key

In `auth`, `payments`, `infra`, `security` domains: do a full domain scan before touching anything:

```
search("auth")      ← all auth patterns + constraints
search("payments")  ← all payment rules
search("security")  ← all security constraints
```

Sensitive domain violations are the costliest to fix after the fact.

---

## After Task — Reflect and Capture

Ask: *"What did I decide, discover, or reinforce that a future engineer should know?"*

If the answer is anything → call `reflect()` once:

```javascript
reflect("concise task summary — what was built and why", {
  decisions: ["decision 1 with rationale", "decision 2 with rationale"],
  patterns:  ["pattern used and why it fits here"],
  constraints: ["constraint discovered or confirmed"]
})
```

**After `reflect()` returns:**
- Tell the human: *"I've submitted N knowledge entries to Quorum for your review at http://localhost:3002/pending."*
- If any entry returned `conflict_detected` → do not close the session silently. Brief the human on each conflict and resolve them the same way as a mid-task conflict. See Conflict Resolution section.
- If any entry returned `stored_pending_conflict_check` → tell the human: *"Conflict check deferred for N entries — review at /pending once Graphiti is back."*

**Skip `reflect()` entirely** for: pure read sessions, abandoned tasks, sessions
where no real architectural or design decisions were made. Over-extraction degrades
signal quality. See [`references/knowledge-guidelines.md`](references/knowledge-guidelines.md).

---

## Conflict Resolution — Guide, Don't Just Report

When a conflict is detected (`conflict_detected` in response or in `pending()`):

**Do not just dump the raw conflict.** Read the `brief` field in the response — it contains
an LLM analysis of the contradiction. Use it to inform your suggested resolution. Brief
the human like this:

> "There's a conflict on `auth:token-strategy`:
> - **Existing** (by @senior-architect, 3 months ago, confidence 0.90): 'Use session tokens'
> - **Incoming** (your current decision, confidence 0.85): 'Use JWT for Lambda services'
>
> Analysis: *[brief field content — e.g., "existing rule predates Lambda adoption; new rule is likely scoped to Lambda contexts"]*
>
> Suggested resolution: **coexist_split** — the existing rule covers ECS services,
> the new one covers Lambda. Want me to apply that?"

If `pending()` returns a conflict with `stale_warning: true` → the underlying entry has
changed since the conflict was raised. Surface this first:
*"This conflict may be outdated — the underlying knowledge has been updated since it was
flagged. Want me to re-run the conflict check rather than resolve a potentially stale one?"*

Options to offer:
| Resolution | When to suggest |
|-----------|----------------|
| `supersede` | New knowledge is clearly more accurate or up-to-date |
| `coexist_split` | Both are valid in different contexts — suggest context boundaries |
| `coexist_merge` | Both contain truth — suggest a merged statement |
| `reject` | New addition is wrong or already covered |
| `escalate` | Genuinely ambiguous — needs a human decision |

```javascript
// Once the human decides:
remember("topic", "key", "resolved content", {
  conflict_id: "cfl_...",
  resolution: "coexist_split",
  reason: "ECS services use sessions (revocable), Lambda uses JWT (stateless)"
})
```

---

## Authentication

### Check your mode first

```bash
echo ${QUORUM_GATEWAY_URL:-"(not set — direct mode)"}
```

| Mode | Auth required | Identity |
|------|--------------|----------|
| **Direct** (`QUORUM_GATEWAY_URL` not set) | ❌ None — use tools immediately | `git config user.email` |
| **Gateway** (`QUORUM_GATEWAY_URL` set) | ✅ JWT required — run auth flow below | GitHub OAuth → JWT |

**In direct mode, skip the rest of this section and use the MCP tools directly.**

---

### Gateway mode — auth flow

Run this **without asking** — just inform and proceed:

```
1. Say: "Quorum auth needed — authenticating, back in a moment."

2. Read QUORUM_GATEWAY_URL (default: http://localhost:3001)

3. Open in browser (use mcp-playwright if available):
     {QUORUM_GATEWAY_URL}/auth/github

4. GitHub OAuth flow completes. Dashboard URL becomes:
     http://localhost:3002/login#oauth=gho_<token>

5. Extract: window.location.hash → parse "oauth=" → gho_<token>

6. If project_id is not obvious from context, ask once:
   "Which project should I authenticate with?"

7. authenticate({ github_token: "gho_<token>", project_id: "<id>" })
   Token lives in MCP process memory — never written to disk.

8. Retry the operation that triggered the failure.

9. Say: "Auth done — continuing."
```

### Proactive auth at session start (gateway mode only)

If `QUORUM_GATEWAY_URL` is set, run the auth flow **before** Step 1 (`pending()`),
not after a failure. A 401 mid-session interrupts the engineer's flow — auth first
removes that risk entirely.

### Auth failure signals

| Signal | Action |
|--------|--------|
| `401 Unauthorized` or `jwt_expired` | Run re-auth flow above, then retry |
| `QUORUM_GITHUB_TOKEN` not set and mcp-playwright unavailable | Tell human: *"Set `QUORUM_GITHUB_TOKEN` in your shell profile (GitHub PAT, scope: `read:user`), then restart Claude Code."* |

---

## Onboarding a New Project

**Triggers:** "add this project to Quorum", "onboard this project", "connect this repo to Quorum"

Follow the full 10-phase protocol: [`references/onboarding.md`](references/onboarding.md).

**Phase overview:**
1. Check for existing setup (`.quorum` file)
2. Gather team info — project ID, members, domains, gateway URL
3. Create + validate `<group_id>.quorum.json` config
4. Upload config to S3
5. Create `.quorum` discovery file via CLI
6. Set identity (`QUORUM_GITHUB_TOKEN`) + register MCP server
7. Install skill at user level (`~/.claude/skills/quorum/` — run `npm run skill:install`)
8. **Ingest existing knowledge** — CLAUDE.md, MEMORY.md, session transcripts → DRAFT entries
9. Commit `.quorum` discovery file (config is gitignored — lives in S3)
10. Verify connection with a fresh session

**Phase 8 is the highest-value step** — it bootstraps the team's memory from institutional
knowledge that already exists, rather than starting from zero.

---

## Knowledge Discovery — Surface Latent Knowledge

Quorum's graph is only as good as what gets into it. Most institutional knowledge
lives in files that already exist — `CLAUDE.md`, `MEMORY.md`, README sections,
ADRs, code comments, test names, config values. This section tells you when and
how to scan for it and surface candidates for human confirmation before storing.

**Golden rule: always `search()` before proposing. Never suggest storing something
that is already in Quorum.**

---

### When to run discovery

| Trigger | What to scan |
|---------|-------------|
| First session in a project | `CLAUDE.md`, `MEMORY.md`, `README.md`, `docs/` |
| Human says "onboard this project" | Full scan — all sources below |
| Human says "what should we add to Quorum?" | Full scan |
| You open a file with dense comments or ADR-style notes | That file |
| You read a long test file | Extract business rules from test names + assertions |
| You read a config file (limits, thresholds, pool sizes) | Extract constraints |
| Human pastes a decision, email, or Slack thread | Extract immediately |

---

### What to look for in each source

#### `CLAUDE.md` / `MEMORY.md`
These files are the richest source. Read them fully and extract:
- Any sentence stating a technical decision or rationale
- Any "we use X because Y" or "always do X" or "never do Y"
- Any constraint with a number (timeout, pool size, retry count)
- Any mention of a tool choice with reasoning

```bash
cat CLAUDE.md .claude/CLAUDE.md 2>/dev/null
cat ~/.claude/projects/$(echo $PWD | tr '/' '-')/memory/MEMORY.md 2>/dev/null
```

#### `README.md` / `docs/*.md`
Look for:
- Architecture decision sections
- "Why we chose X over Y" paragraphs
- Runbook procedures
- Non-obvious setup steps that encode constraints

#### Source code comments
Lines starting with `// NOTE:`, `// IMPORTANT:`, `// WHY:`, `// HACK:`, `// TODO:`,
or multi-line comments explaining *why* (not *what*) the code does something.

```bash
grep -rn "NOTE:\|IMPORTANT:\|WHY:\|HACK:\|DECISION:" src/ --include="*.js" --include="*.ts"
```

#### Test files
Test names encode business rules. Scan test `describe`/`it` blocks for:
- "should reject X when Y" → constraint
- "should use X for Z" → pattern
- "must not allow X" → hard constraint

```bash
grep -rn "it(\|test(\|describe(" tests/ --include="*.test.*" -A 1
```

#### Config and environment files
Numeric values in config often encode constraints no one wrote down:
- Pool sizes, timeout values, retry counts, rate limits
- Feature flags that encode a decision about what's enabled

```bash
cat .env.example docker-compose.yml 2>/dev/null | grep -E "[0-9]+" | head -30
```

#### Recent git history
Commit messages with rationale are a goldmine:

```bash
git log --oneline -20                          # scan subjects
git log --format="%s%n%b" -10 | head -60      # subjects + bodies
```

Look for commits that explain *why* a change was made, not just *what* changed.

---

### How to present candidates — batch, don't drip

Never ask the human to confirm one entry at a time. Batch everything you found,
deduplicate against existing Quorum knowledge, then present a numbered list:

> **Quorum discovery — I found 6 knowledge candidates in this project.**
> Please confirm which to store (reply with the numbers, e.g. "1 3 5", or "all" / "none"):
>
> 1. **api:error-standards** *(Pattern, confidence 0.80)*
>    "All API errors follow RFC 7807 Problem Detail: type, title, status, detail"
>    *Source: CLAUDE.md line 14*
>
> 2. **db:connection-pooling** *(Constraint, confidence 0.85)*
>    "PostgreSQL pool size: 10 per service instance, max 100 total across all instances"
>    *Source: .env.example + docker-compose.yml*
>
> 3. **infra:retry-strategy** *(Pattern, confidence 0.75)*
>    "Exponential backoff with jitter: base 1s, max 30s, max 3 retries, ±20% jitter"
>    *Source: src/utils/retry.js comment block*
>
> 4. **auth:token-strategy** *(Decision, confidence 0.80)*
>    "JWT for Lambda-based services; session tokens for ECS internal services"
>    *Source: CLAUDE.md line 8 — already in Quorum? → search result: YES — skip*
>    ⚠️ Already in Quorum — excluded from list

Once the human replies, store the approved ones:

```javascript
// For each approved candidate:
remember("topic", "key", "content", {
  confidence: 0.80,
  tags: ["domain", "source-type"],
  reason: "discovered in CLAUDE.md during project scan"
})
```

All entries enter as `DRAFT`. Tell the human: *"Stored N entries as DRAFT —
review them at http://localhost:3002/pending."*

---

### Ongoing passive discovery — notice and flag

Even outside a full scan, keep a passive eye open:

| You notice | Action |
|-----------|--------|
| A code comment that says "always X" or "never Y" | Propose storing it |
| A function with a surprising limit (timeout, retry, size) | Propose storing the constraint |
| An error message that reveals a hard constraint | Propose storing it immediately |
| A pattern repeated 3+ times with no Quorum entry | Propose storing the pattern |
| A deprecated approach still present in old code | `search()` to find the Quorum entry → `history()` to check what depends on it → propose: *"This approach appears obsolete. The Quorum entry `topic:key` is still ACTIVE. Want me to deprecate it with `forget()`?"* |

For all except deprecated approaches: one sentence, low friction. Human says yes or no.
*"I noticed a constraint/pattern/decision here that isn't in Quorum — want me to add it?"*

---

## Constitutional Rules — Server-Enforced

Violations are **rejected**, not warned:

| Rule | What to do instead |
|------|--------------------|
| No hard delete | `forget(topic, key, reason)` — creates DEPRECATED version |
| Audit is append-only | Never attempt to edit or delete audit entries |
| Reason required (≥10 chars) | Always provide a meaningful reason for supersede/deprecate |
| No self-approval | Surface to human; relay their decision via `review()` |
| Claude writes are always DRAFT | `reflect()` and `remember()` as agent always enter DRAFT |
| `triggered_by` always set | Set automatically by the server — if you see a `triggered_by: null` error, the server version is outdated |
| Atomic ACTIVE transition | If an entry is stuck in PENDING_ACTIVE state, report to human — do not retry manually |
| Bidirectional audit↔version | If `history()` returns a version with no `created_by_audit`, the audit chain is broken — escalate to human |

---

## Quick Reference

```
# Session start (always)
ls .quorum                                       ← verify project is connected
pending()                                        ← conflicts block; drafts note-only
search("task domain")                            ← load context before touching code

# Retrieve — always search first, then recall
search("what you're deciding")                   ← find candidate keys
recall("topic", "key")                           ← load exact entry once key is known
recall("topic", "key", { history: true })        ← full version chain
recall("topic", "key", { at: "2024-11-30" })     ← point-in-time
recall("topic", "key", { version: 2 })           ← specific version
history("topic", "key")                          ← ALWAYS call before superseding

# Store
remember("topic", "key", "content")
remember("topic", "key", "content", {
  confidence: 0.85,
  tags: ["domain", "type", "component"],         ← cross-domain search hooks
  reason: "why this matters"
})
# → if stored_pending_conflict_check → warn human, Graphiti unavailable

# Resolve conflict (conflict_id from pending() or conflict_detected response)
remember("topic", "key", "resolved content", {
  conflict_id: "cfl_...",
  resolution: "supersede" | "coexist_split" | "coexist_merge" | "reject" | "escalate",
  reason: "rationale for resolution"
})

# Post-task
reflect("what was built and why", {
  decisions: ["..."],
  patterns: ["..."],
  constraints: ["..."]
})
# → if conflict_detected in response → resolve before closing session
# → if stored_pending_conflict_check → warn human, Graphiti unavailable

# Governance
review("approve" | "reject" | "request_changes", "topic", "key", "reason")
history("topic", "key")
export("topic", "markdown")
forget("topic", "key", "reason — min 10 chars")
```

**Review queue:** Dashboard → http://localhost:3002/pending (preferred for humans)

---

## Confidence Guidelines

| Situation | Confidence |
|-----------|-----------|
| Established, documented decision — high certainty | 0.90–0.95 |
| Strong pattern — team follows this consistently | 0.80–0.85 |
| Working assumption — likely correct, not yet verified | 0.65–0.75 |
| Hypothesis — needs validation | 0.50–0.60 |
| Uncertain — flag for review | < 0.50 — consider skipping |

**For discovered knowledge** (source may be stale — use lower starting confidence):

| Discovery source | Confidence |
|-----------------|-----------|
| CLAUDE.md / MEMORY.md — explicit decision | 0.80 |
| README / docs — documented pattern | 0.75 |
| Code comment — WHY-style explanation | 0.70 |
| Config value — numeric constraint | 0.70 |
| Test name — inferred business rule | 0.65 |
| Git commit message | 0.65 |
| Implicit from code structure | 0.55 |

Never inflate confidence. A 0.95 that turns out wrong is more damaging than a 0.70.
Always let the human adjust confidence before confirming discovery candidates — they
know better than the file how current the knowledge is.

---

## References

Load when you need full detail:

| File | When to load |
|------|-------------|
| [`references/tool-reference.md`](references/tool-reference.md) | Full parameter schemas, return shapes, edge cases |
| [`references/conflict-resolution.md`](references/conflict-resolution.md) | Full conflict brief format, all resolution options with examples |
| [`references/knowledge-guidelines.md`](references/knowledge-guidelines.md) | What to store, quality bar, over-extraction guard, discovery vs. reflect() |
| [`references/onboarding.md`](references/onboarding.md) | Full 10-phase project onboarding protocol |
