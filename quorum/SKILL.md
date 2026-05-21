# Quorum Skill for Claude Code

Place this file at `.claude/skills/quorum.md` in any project using Quorum.

---

## What This Skill Does

This skill instructs Claude Code to use Quorum as its persistent engineering and business memory — automatically loading relevant context at session start, consulting it during decisions, adding learnings after task completion, and surfacing governance decisions at the right moment with the right context.

The result: every Claude Code session builds on everything that came before it, across your entire team. And every decision is made by an informed human — not a rubber stamp.

---

## Core Principle: PACE

Every interaction with Quorum follows the PACE framework:

```
P — Prepare       the human before they decide
A — Assess        the right moment to ask
C — Contextualise the decision with full information
E — Evaluate      decision quality over time
```

Claude is not just a memory retriever. It is the interface between institutional knowledge and human judgment. Its job is to make humans genuinely capable of the decisions they are asked to make.

---

## Session Start Protocol

**Step 1 — Check pending reviews**

```
review_list = await quorum.review.list({ reviewer: current_engineer })

If review_list.length > 0:
  Surface HIGHEST IMPACT one only — never dump the queue
  "Before we start — one decision needs your judgment.
   It will take 2 minutes. Want to see it now or after this task?"

  If now  → show full decision brief
  If after → remind at task completion
  Never surface more than one decision per session start
```

**Step 2 — Load domain context**

```
1. Read current task description
2. Infer primary domain (auth, payments, db, infra, api, testing, product, compliance)
3. search(query=task_description, domain=inferred_domain, limit=5)
4. Filter: ACTIVE status only — NEVER load DRAFT knowledge into context
5. Inject results with full attribution tags
6. Announce what was loaded
```

Example:
```
Task: "Add rate limiting to the payment API"
→ search("rate limiting payment API", domain="payments,api")
→ Loaded (ACTIVE only):
    api:rate-limiting-strategy  (v2 | confidence: 0.88 | @senior-engineer)
    payments:idempotency        (v1 | confidence: 0.92 | @architect)
    infra:redis-usage           (v3 | confidence: 0.85 | @engineer | updated 3 days ago ℹ️)
→ "Loaded 3 Quorum entries. infra:redis-usage was updated recently — check if relevant."
```

Example (product/business context):
```
Task: "Refactor the checkout flow"
→ search("checkout", domain="product,payments")
→ Loaded (ACTIVE only):
    product:guest-checkout-requirement  (v1 | confidence: 0.85 | @product-owner)
    payments:idempotency                (v1 | confidence: 0.92 | @architect)
→ "Loaded 2 Quorum entries. product:guest-checkout-requirement is a product requirement — check before removing any checkout paths."
```

**DRAFT knowledge is never loaded into Claude's context.** It is unreviewed and unvalidated.

**SUPERSEDED knowledge is never loaded.** If it comes up in search, load the current version instead and note what changed.

**Version freshness check at session start:**
For each loaded entry, if `updated_at` is within the last 7 days — flag it.
If a loaded entry was SUPERSEDED since last session — alert and reload current version.

---

## During Task Protocol

- Before making an implementation decision → check Quorum first: `recall(topic, key)`
- Before removing or significantly changing a feature → check for product requirements: `search(feature_name, domain="product,compliance")`
- Prefer ACTIVE Quorum knowledge over generic best practices
- If Quorum knowledge seems outdated → flag it, don't silently ignore it
- If Quorum conflicts with what the engineer just said → surface it immediately
- Do not override Quorum knowledge silently — ever

**Recall format — always attribute the source:**
```
[Quorum: auth:token-strategy | ACTIVE | confidence: 0.9 | @ayan | Dec 2024]
Use JWT for external services, session tokens for internal.
Rationale: stateless lambdas require JWT; internal services benefit from revocation.
```

---

## Post-Task Reflection Protocol

### Claude's Three Authority Modes

Claude must self-declare which mode it is in. This is stored as metadata.

```
Mode 1 — Echoing human decision       (confidence: 0.75)
  Engineer or product owner explicitly decided something. Claude is recording it.
  Human is the real author. Claude is the scribe.

Mode 2 — Extracting a pattern         (confidence: 0.55)
  Claude inferred a reusable pattern from the work done.
  Medium confidence. Needs validation.

Mode 3 — Generalising from one case   (confidence: 0.35)
  Claude is speculating from limited evidence.
  Low confidence. Explicitly marked. Likely needs human review.
```

Claude NEVER presents Mode 3 as Mode 1. Ever.

### Reflection Checks

**Decision check:** Did the engineer make an explicit technical decision?
→ `remember(topic, key, decision + rationale, mode="echoing", confidence=0.75)`

**Pattern check:** Did I observe a reusable pattern specific to this team?
→ `remember(topic, key, pattern, mode="extracting", confidence=0.55)`

**Constraint check:** Did I discover a technical or compliance constraint?
→ `remember(topic, key, constraint, mode="extracting", confidence=0.6)`
→ Constraint discoveries are highest value — prioritise these

**Runbook check:** Did I fix a non-obvious bug that could recur?
→ `remember(topic, key, steps, mode="extracting", confidence=0.65)`

**Requirement check:** Did the engineer or product owner state a product requirement, business rule, or compliance constraint?
→ `remember(topic, key, requirement, mode="echoing", confidence=0.75)`
→ Use `entity_type: "Requirement"` and topic: `product` | `compliance` | `legal`
→ Business rationale is highest value: *why* a feature exists, *who* it serves, *when* it applies

**Gap check:** Did I find nothing in Quorum for this domain?
→ Flag to engineer: "Quorum has no knowledge about X — worth adding directly?"

### What NOT to Add

- Generic programming knowledge (not team-specific)
- Things already well-covered in Quorum
- Mode 3 speculation without clear evidence
- Task-specific one-off details that won't generalise

---

## Conflict Surfacing

If `remember()` returns a conflict — stop. Never resolve silently. Ever.

```
⚠️ Quorum Conflict Detected

What you are adding:
  "Use session tokens for internal service auth"
  Mode: extracting | Confidence: 0.55

What is already there:
  "Use JWT for all services" — ADR-042
  Author: @senior-architect | 6 months ago | Confidence: 0.9 | Recalled: 47 times

Why it conflicts:
  Directly contradicts token strategy for internal services

Related context (graph traversal):
  → infra:lambda-constraints: Lambda cannot maintain sessions
  → payments:service-type: Payment service runs on Lambda
  → auth-svc:deployment: Auth service runs on ECS

Quorum's analysis (observation, not recommendation):
  ADR may be correct for Lambda. ECS services could support sessions.
  This may be a valid nuance, not a true conflict.

Options:
  A) Supersede — existing knowledge was wrong, requires reason
  B) Nuance — both valid in different contexts, specify boundary
  C) Preserve — ADR-042 stands as written
  D) Escalate — architecture discussion needed
```

Do not suggest a default. Do not proceed until decision is made.
Store the decision, reason, and who made it — always.

### Dissent Preservation

```
[DISSENT PRESERVED]
Reviewer: @senior-engineer
Concern: "JWT expiry of 24h is too long — security risk"
Overruled by: @principal-architect
Reason: "Acceptable per security team sign-off 2024-11-01"

Surfaces automatically in incident retrospectives if this decision
is linked to a future failure.
```

---

## Decision Brief Format

Always generate a full brief before surfacing a human decision. Never surface a raw prompt.

```
┌─────────────────────────────────────────────────────────┐
│ 🔍 Knowledge Decision Brief — auth:token-strategy        │
├─────────────────────────────────────────────────────────┤
│ WHAT IS IN CONFLICT                                      │
│ Existing: @senior-architect | 6mo ago | conf 0.9        │
│   "Use JWT for all services"  — recalled 47 times       │
│ Incoming: claude | mode: extracting | conf 0.55          │
│   "Use session tokens for internal services"             │
├─────────────────────────────────────────────────────────┤
│ WHY IT MATTERS                                           │
│ Affects: payment-svc, auth-svc, notification-svc         │
│ Risk if wrong: auth failures across 3 services           │
├─────────────────────────────────────────────────────────┤
│ RELATED CONTEXT (graph traversal)                        │
│ → infra:lambda-constraints: sessions not supported       │
│ → payments:service-type: Lambda-based                    │
│ → auth-svc:deployment: ECS-based                         │
├─────────────────────────────────────────────────────────┤
│ QUORUM'S ANALYSIS (observation only)                     │
│ ADR may be correct for Lambda. ECS services could        │
│ support sessions. May be a nuance, not a conflict.       │
├─────────────────────────────────────────────────────────┤
│ YOUR OPTIONS                                             │
│ A) Supersede  B) Nuance  C) Preserve  D) Escalate       │
└─────────────────────────────────────────────────────────┘
```

Brief must include: impact, usage data, graph-traversed related context,
Quorum's analysis (not recommendation), structured options. Readable in < 2 minutes.

---

## Right Moment Assessment

```
NEVER surface decisions when:
  → Engineer is mid-implementation
  → Already pending decisions this session (one at a time)

ALWAYS surface at:
  → Session start (golden moment — fresh mind)
  → Task completion (natural break)
  → When disputed knowledge is about to be used

URGENCY OVERRIDE — surface immediately if:
  → DRAFT knowledge would have been injected into context
  → Pending decision is > 48 hours old
```

---

## Draft State and Version Awareness

### Knowledge States

```
ACTIVE     → use freely — this is current, approved knowledge
DRAFT      → NEVER inject into context, NEVER act on
             surface to engineer: "X is DRAFT, awaiting review"
SUPERSEDED → never use as source of truth
             CAN explain what it said and why it changed
             always surface the current version instead
REJECTED   → never use, never mention
DEPRECATED → do not use, flag if it comes up as potentially stale
```

### Version-Aware Recall Behaviour

When loading context at session start or during task, Claude must check version freshness:

**Recently updated (< 7 days):**
```
[Quorum: auth:token-strategy | v3 ACTIVE | @ayan | Dec 2024]
"JWT for Lambda, session tokens for non-Lambda internal"

ℹ️  Updated 2 days ago from v2.
    Previous: "JWT for all services" (@senior-architect, Jun 2024)
    Reason: "ADR-042 nuanced after Lambda constraint discovered"
```

**Loaded stale version from previous session:**
```
⚠️  auth:token-strategy was updated since your last session.
    You had loaded: v2 — "JWT for all services"
    Current:        v3 — "JWT for Lambda, sessions for non-Lambda"
    → Reloading with current version before proceeding
```

**SUPERSEDED knowledge surfaced in search:**
```
Note: auth:token-strategy v2 matches your search but is SUPERSEDED.
      Current version (v3): "JWT for Lambda, sessions for non-Lambda"
      Superseded reason: "ADR-042 nuanced after Lambda constraint"
      Using v3 for context.
```

**DRAFT version found in search:**
```
Found auth:refresh-rotation but it is DRAFT — awaiting review.
Not injecting into context. Using auth:token-strategy (ACTIVE) instead.
Should be reviewed before relying on it.
```

### Version History on Request

If an engineer asks about history or how something evolved:

```
Engineer: "Why did we change the auth token strategy?"

Claude calls: recall("auth", "token-strategy", { history: true })

Response:
  auth:token-strategy has evolved through 3 versions:

  v1 (Jan 2024, @junior-dev) — "Session tokens for all services"
     Superseded because: Lambda services don't support sessions

  v2 (Jun 2024, @senior-architect) — "JWT for all services"
     Superseded because: ADR-042 nuanced — sessions valid for non-Lambda

  v3 (Dec 2024, @ayan, CURRENT) — "JWT for Lambda, sessions for non-Lambda"
     Triggered by: conflict resolution between v2 and @junior-dev addition
```

### Point-in-Time Recall

If an engineer is investigating an incident or reviewing an old PR:

```
Engineer: "What did Quorum know about auth when PR #847 was merged Nov 30th?"

Claude calls: recall("auth", "token-strategy", { at: "2024-11-30" })

Response:
  On Nov 30 2024, auth:token-strategy was at v2 (ACTIVE):
  "Use JWT for all services"
  This was later superseded on Dec 1 2024.
  Note: the current version (v3) has a different approach.
```

### Never Use Superseded as Source of Truth

Even if superseded knowledge is closer to what the engineer seems to want:

```
❌ Wrong:
  "According to an older Quorum entry, you used to use session tokens..."
  → This could lead engineer to revert to rejected approach

✅ Right:
  "The current Quorum guidance is JWT for Lambda, sessions for non-Lambda.
   If you want to understand the history, I can show you why it evolved."
```



---

## Authority and Draft Rules

```
Claude (any mode)     → always DRAFT → any engineer to approve

Engineering roles:
  Junior engineer       → always DRAFT → senior+ to approve
  Engineer              → DRAFT by default
                           self-approve: domain_entries >= 10, conflict_rate < 10%
  Senior engineer       → ACTIVE in established domain
                           DRAFT in unfamiliar domains
  Principal architect   → ACTIVE always, team notified

Business roles:
  Business analyst      → DRAFT by default → product owner or PA to approve
  Product owner         → ACTIVE for product/* and compliance/* domains
                           DRAFT in engineering domains
  Compliance officer    → ACTIVE for compliance/* and legal/* domains
                           DRAFT in engineering domains
```

Claude never approves its own additions.
Claude never approves human additions.
Self-approval constitutional rule applies to Claude too.

Note: PMs, BAs, and compliance officers use Claude (via Claude Code or any Claude interface)
to interact with Quorum — the MCP tools are their entry point, not just engineers'.

---

## Session Summary

Always end with a concise Quorum summary:

```
Quorum activity this session:
  📖 Loaded:    auth:token-strategy (v3), infra:redis-usage (v2), product:guest-checkout-requirement (v1)
  🔄 Updated:   infra:redis-usage was at v1 last session → now v2 (reloaded)
  ✅ Added:     auth:refresh-token-rotation v1 (DRAFT | echoing | conf: 0.75)
  ⚠️  Conflict: auth:session-vs-jwt — awaiting your decision
  🔍 Gaps:      No knowledge found for payments:fraud-detection
  📋 Pending:   1 review in your queue (api:rate-limiting v2)
  📜 History:   auth:token-strategy has 3 versions — type 'quorum history auth:token-strategy' to see
```
