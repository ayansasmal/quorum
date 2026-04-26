# Conflict Resolution Reference

How to present, handle, and relay conflict decisions in Quorum.

---

## When conflicts appear

`pending()` returns `conflict_briefs` when two knowledge entries for the same `topic:key`
contradict each other and neither side has clear authority to auto-win.

---

## Presenting a conflict to the human

```
🔀 Conflict: auth:token-strategy
   conflict_id: "cfl_abc123"    ← carry this into remember()

  Existing (v2 — ACTIVE, by @senior-architect, confidence 0.85):
    "Use JWT for all services — sessions don't work with Lambda"

  Incoming (by @junior-dev, confidence 0.60):
    "Use sessions for the web frontend — simpler to implement"

  Analysis: The existing decision was made because Lambda is stateless.
    Sessions require server-side state. The incoming suggestion may be valid
    for non-Lambda services but contradicts the constraint.

  Risks if approved: Lambda-backed API routes will fail on auth.
  Questions for reviewer: Is the frontend backed by Lambda or nginx?

  Options:
    A) supersede      — incoming replaces existing (requires strong reason)
    B) coexist_split  — fork into two scoped keys; both are valid in different contexts
    C) coexist_merge  — write a single reconciled entry that absorbs both
    D) reject         — incoming is incorrect or premature
    E) escalate       — needs a senior reviewer before deciding
```

If `stale_warning: true` → note that the conflict context was updated since it was queued.
If `more_pending_same_key > 0` → note more conflicts are queued for this key; resolve in order.

---

## Relaying the decision

**Always include `conflict_id`** — without it `remember()` creates a new version instead
of resolving the pending conflict.

### Option A — supersede

```javascript
remember("auth", "token-strategy",
  "Use JWT for Lambda routes; sessions allowed for server-rendered frontend only", {
  conflict_id: "cfl_abc123",
  resolution: "supersede",
  reason: "Frontend is nginx-backed, not Lambda — sessions are valid there"
})
```

### Option B — coexist_split

Forks the existing entry and the incoming entry into two separate keys. Use when both
are valid but in genuinely different contexts.

```javascript
remember("auth", "token-strategy", "...", {
  conflict_id: "cfl_abc123",
  resolution: "coexist_split",
  split_existing_key: "token-strategy-lambda",    // new key for existing entry
  split_incoming_key: "token-strategy-web",       // new key for incoming entry
  // Optional: refine content for each branch
  split_existing_content: "Use JWT for all Lambda-backed services (stateless)",
  split_incoming_content: "Use sessions for nginx-backed frontend services",
  reason: "Both are valid — Lambda requires JWT, nginx frontend can use sessions"
})
```

### Option C — coexist_merge

Writes a single combined entry that reconciles both. Use when the incoming adds nuance
rather than a genuine contradiction.

```javascript
remember("auth", "token-strategy", "...", {
  conflict_id: "cfl_abc123",
  resolution: "coexist_merge",
  merged_content: "Use JWT for Lambda services (stateless); sessions valid for nginx-backed frontend only",
  reason: "Incoming adds valid nuance — not a true contradiction, just incomplete context"
})
```

### Option D — reject

```javascript
remember("auth", "token-strategy", "...", {
  conflict_id: "cfl_abc123",
  resolution: "reject",
  reason: "Lambda statelessness constraint makes sessions impossible for API routes"
})
```

### Option E — escalate

```javascript
remember("auth", "token-strategy", "...", {
  conflict_id: "cfl_abc123",
  resolution: "escalate",
  reason: "Needs principal architect review — touches auth delegation boundary"
})
```

---

## Dashboard alternative

The **Quorum dashboard** at `http://localhost:3002/pending` shows full conflict briefs
with side-by-side diffs, LLM analysis, and decision buttons — no terminal required.
This is the preferred review surface for non-Claude reviewers.
