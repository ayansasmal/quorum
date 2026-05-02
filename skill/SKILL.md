---
name: quorum
description: >
  Quorum — persistent, governed engineering memory for Claude Code and AI agents.
  Invoke when working on any engineering task where architectural decisions, patterns,
  constraints, or institutional knowledge are relevant.
---

# Quorum Skill

Quorum is a **governed temporal knowledge graph** for engineering teams. It stores
decisions, patterns, constraints, and runbooks with versioning, conflict detection,
authority weighting, and a human-in-the-loop audit trail.

**Your four responsibilities:**
1. Surface pending decisions at session start — never skip this
2. Recall relevant knowledge before making implementation choices
3. Extract and store learnable knowledge after task completion
4. Relay conflict resolutions on behalf of the human

---

## Session Start (always)

```
pending()               ← surface conflicts + DRAFT entries first
search("<task domain>") ← load relevant context before starting work
```

If `pending()` returns items → present them to the human and resolve before
proceeding. See [`references/conflict-resolution.md`](references/conflict-resolution.md).

---

## During Task

Recall before making any of these choices:

| Decision type | Action |
|--------------|--------|
| Auth, data model, error handling | `recall("topic", "key")` |
| Pattern you think the team uses | `search("pattern name")` |
| Constraint you just discovered | `remember()` immediately — do not wait |
| Existing knowledge being violated | `remember()` with reason |

---

## After Task

Ask yourself: *"Would a future engineer benefit from knowing what I just decided?"*

If **yes** → call `reflect()` once with a concise summary. All extracted entries
enter as `DRAFT` — a human must approve before they become `ACTIVE`.

If **no** (pure read session, abandoned task, no real decisions made) → skip entirely.

See [`references/knowledge-guidelines.md`](references/knowledge-guidelines.md) for
the over-extraction guard and quality bar.

---

## Authentication

Quorum requires a valid JWT. Auth failures are transient — handle them
automatically so the engineer stays focused on their task.

### Detecting auth failure

Any of these means auth needs to be (re-)established:

| Signal | Source |
|--------|--------|
| `QUORUM_GATEWAY_URL is set but QUORUM_GITHUB_TOKEN is missing` | MCP startup error |
| `401 Unauthorized` or `jwt_expired` from any tool call | Tool error response |
| `QUORUM_GITHUB_TOKEN` not set in shell | `echo $QUORUM_GITHUB_TOKEN` returns empty |

### Re-auth flow (use mcp-playwright)

When auth fails, run this flow **without interrupting the engineer**:

```
1. Inform: "Quorum auth expired — handling re-auth, back in a moment."

2. Read QUORUM_GATEWAY_URL (default: http://localhost:3001)

3. Use mcp-playwright to open:
     {QUORUM_GATEWAY_URL}/auth/github

4. Wait for the GitHub OAuth page to load.
   If the engineer is not already logged into GitHub, they will need to
   approve — tell them: "Please approve the GitHub login in the browser."

5. After GitHub redirects back, the URL will be:
     http://localhost:3002/login#oauth=gho_<token>

6. Extract the token from the URL fragment:
     window.location.hash  →  parse "oauth" param  →  gho_<token>

7. Ask the engineer which project to authenticate with if not obvious from
   context. Then call the authenticate() MCP tool:
     authenticate({ github_token: "gho_<token>", project_id: "<id>" })
     The token is stored in-memory in the MCP process — no files are written.
     If the MCP server restarts, re-auth will be required again.

8. Retry the original operation that triggered the auth failure.

9. Inform: "Quorum re-auth complete — continuing."
```

### First-time setup (no QUORUM_GATEWAY_URL)

If `QUORUM_GATEWAY_URL` is also missing, the MCP server is running in
**direct mode** (no gateway). In direct mode, auth is not required — skip
the re-auth flow entirely. Identity comes from `git config user.email`.

If the engineer wants gateway mode, ask them to set `QUORUM_GATEWAY_URL`
and then run the re-auth flow above.

---

## Onboarding a New Project

**Trigger phrases:** "add this project to Quorum", "onboard this project",
"set up Quorum here", "connect this repo to Quorum"

When triggered → follow the full 10-phase protocol in
[`references/onboarding.md`](references/onboarding.md).

Phase 8 of that protocol ingests `CLAUDE.md`, `MEMORY.md`, and recent session
transcripts as `DRAFT` knowledge — the fastest way to bootstrap a project's
memory from existing institutional knowledge.

---

## Constitutional Rules

These are server-enforced. Violations are rejected, not warned:

1. **No hard delete** — use `forget(topic, key, reason)` instead
2. **Audit is append-only** — every operation is permanently logged
3. **Reason required** — supersede/deprecate operations require ≥10 meaningful characters
4. **No self-approval** — you cannot `review()` knowledge you authored; surface to human
5. **Claude writes are always DRAFT** — `reflect()` and `remember()` as agent always enter DRAFT

---

## Quick Reference

```
# Session start
pending()
search("domain keywords")

# Retrieve
recall("topic", "key")
recall("topic", "key", { history: true })       ← full version chain
recall("topic", "key", { at: "2024-11-30" })    ← point-in-time
recall("topic", "key", { version: 2 })          ← specific version

# Store
remember("topic", "key", "content")
remember("topic", "key", "content", { confidence: 0.80, tags: ["auth"] })

# Conflict resolution (conflict_id required — from pending() response)
remember("topic", "key", "content", {
  conflict_id: "cfl_...",
  resolution: "supersede" | "coexist_split" | "coexist_merge" | "reject" | "escalate",
  reason: "..."
})

# Post-task
reflect("task summary", ["decision 1", "decision 2"], ["pattern used"])

# Review (relay human's decision — you cannot self-approve)
review("approve" | "reject" | "request_changes", "topic", "key", "reason")

# Audit
history("topic", "key")
export("topic", "markdown")
forget("topic", "key", "reason")
```

**Review pending decisions:** Dashboard at `http://localhost:3002/pending` (preferred)
or `review()` calls relayed on the human's behalf.

---

## References

Load these when you need the full detail for a specific operation:

| File | When to load |
|------|-------------|
| [`references/tool-reference.md`](references/tool-reference.md) | Full parameter schemas, return shapes, edge cases |
| [`references/conflict-resolution.md`](references/conflict-resolution.md) | Full conflict brief format, all resolution options with examples |
| [`references/knowledge-guidelines.md`](references/knowledge-guidelines.md) | What to store, confidence floors, domain conventions, over-extraction guard |
| [`references/onboarding.md`](references/onboarding.md) | Full 10-phase project onboarding protocol |
