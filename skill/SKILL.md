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

---

## Session Start (always, without being asked)

```
pending()                    ← surface conflicts + DRAFTs awaiting review
search("<task domain>")      ← load relevant context before touching any code
```

**Go a step further:** read the task description and infer the domains involved.
Pull knowledge for all of them upfront:

| Task mentions | Recall domains |
|--------------|----------------|
| auth, login, token, session, OAuth | `search("auth")` |
| database, query, migration, schema | `search("db")` |
| API, endpoint, REST, HTTP | `search("api")` |
| deploy, infra, secrets, container | `search("infra")` |
| test, coverage, mock, integration | `search("testing")` |
| payment, billing, subscription | `search("payments")` |

If `pending()` returns items → **present them to the human and get resolution
before writing any code**. A DRAFT conflict unresolved is a landmine.
See [`references/conflict-resolution.md`](references/conflict-resolution.md).

---

## During Task — Proactive Knowledge Use

Do not wait to be asked. When you encounter any of these, act immediately:

### You are about to make an implementation choice

```
recall("topic", "key")       ← check if the team has already decided this
search("choice description") ← find related patterns or constraints
```

Examples that should always trigger a recall:
- Choosing an auth mechanism → `recall("auth", "token-strategy")`
- Writing a database query → `recall("db", "connection-pooling")`
- Designing an API response → `recall("api", "error-standards")`
- Handling a retry → `recall("infra", "retry-strategy")`

**If recalled knowledge contradicts what you were about to do** → stop, surface the
conflict to the human, do not silently override.

### You discover a new constraint

Call `remember()` **immediately** — do not wait for the task to finish.
Constraints discovered mid-task are the most valuable kind; they get lost otherwise.

```javascript
remember("domain", "key", "constraint statement", {
  confidence: 0.80,
  tags: ["domain", "constraint-type"],
  reason: "discovered while implementing X"
})
```

### You see existing knowledge being violated

```javascript
remember("domain", "key", "corrected statement", {
  reason: "existing entry conflicts with current implementation — see PR #...",
  confidence: 0.85
})
```

This creates a conflict for human review. Do not silently override existing knowledge.

### Sensitive domains — pull everything, not just one key

In `auth`, `payments`, `infra` domains: do a full domain scan before touching anything:

```
search("auth")      ← all auth patterns + constraints
search("payments")  ← all payment rules
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

All entries enter as `DRAFT`. Tell the human: *"I've submitted N knowledge entries
to Quorum for your review at http://localhost:3002/pending."*

**Skip `reflect()` entirely** for: pure read sessions, abandoned tasks, sessions
where no real architectural or design decisions were made. Over-extraction degrades
signal quality. See [`references/knowledge-guidelines.md`](references/knowledge-guidelines.md).

---

## Conflict Resolution — Guide, Don't Just Report

When a conflict is detected (`conflict_detected` in response or in `pending()`):

**Do not just dump the raw conflict.** Brief the human:

> "There's a conflict on `auth:token-strategy`:
> - **Existing** (by @senior-architect, 3 months ago, confidence 0.90): 'Use session tokens'
> - **Incoming** (your current decision, confidence 0.85): 'Use JWT for Lambda services'
>
> Suggested resolution: **coexist_split** — the existing rule covers ECS services,
> the new one covers Lambda. Want me to apply that?"

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

Quorum requires a valid JWT. Handle auth failures transparently — never interrupt
the engineer's flow for something you can fix yourself.

### Auth failure signals

| Signal | Meaning |
|--------|---------|
| `401 Unauthorized` or `jwt_expired` from any tool | Token expired |
| `QUORUM_GATEWAY_URL` set but no token in MCP state | First-time auth needed |
| `QUORUM_GITHUB_TOKEN` not set | PAT missing |

### Re-auth flow

Run this **without asking** — just inform and proceed:

```
1. Say: "Quorum auth expired — re-authenticating, back in a moment."

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

9. Say: "Re-auth done — continuing."
```

### Direct mode (no QUORUM_GATEWAY_URL)

MCP server talks to Graphiti directly. No auth required. Identity = `git config user.email`.
If the engineer wants multi-project governance, they need to set `QUORUM_GATEWAY_URL`.

---

## Onboarding a New Project

**Triggers:** "add this project to Quorum", "onboard this project", "connect this repo to Quorum"

Follow the full 10-phase protocol: [`references/onboarding.md`](references/onboarding.md).

**Phase 8 is the highest-value step** — it ingests `CLAUDE.md`, `MEMORY.md`, and recent
session transcripts as `DRAFT` knowledge, bootstrapping the team's memory from what
already exists rather than starting from zero.

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

---

## Quick Reference

```
# Session start (always)
pending()
search("task domain")

# Retrieve
recall("topic", "key")
recall("topic", "key", { history: true })       ← full version chain
recall("topic", "key", { at: "2024-11-30" })    ← point-in-time
recall("topic", "key", { version: 2 })          ← specific version

# Store
remember("topic", "key", "content")
remember("topic", "key", "content", {
  confidence: 0.85,
  tags: ["domain", "type"],
  reason: "why this matters"
})

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

Never inflate confidence. A 0.95 that turns out wrong is more damaging than a 0.70.

---

## References

Load when you need full detail:

| File | When to load |
|------|-------------|
| [`references/tool-reference.md`](references/tool-reference.md) | Full parameter schemas, return shapes, edge cases |
| [`references/conflict-resolution.md`](references/conflict-resolution.md) | Full conflict brief format, all resolution options with examples |
| [`references/knowledge-guidelines.md`](references/knowledge-guidelines.md) | What to store, quality bar, over-extraction guard |
| [`references/onboarding.md`](references/onboarding.md) | Full 10-phase project onboarding protocol |
