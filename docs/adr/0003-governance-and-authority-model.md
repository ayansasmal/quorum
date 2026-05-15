# ADR-0003: Governance and Authority Model

**Status:** Accepted  
**Date:** 2026-05-16  
**Deciders:** Platform team

---

## Context

**Requirement:** Knowledge entries must carry varying degrees of authority (FR-13).
A principal architect's ADR on database connection limits should not be treated
with the same weight as a junior engineer's first-day observation.

**Requirement:** Knowledge must decay over time if not reinforced (FR-12). A
cached decision from 18 months ago may be outdated even if nobody has formally
superseded it.

**Requirement:** Conflicts must be detected and surfaced, not silently resolved
(FR-05, FR-06).

Without an authority and confidence model:
- All knowledge is equally trusted — a wrong guess and an authoritative constraint
  are indistinguishable at recall time
- Knowledge is assumed valid forever — there is no mechanism to represent
  "we're less sure about this now"
- Conflicting knowledge is silently last-write-wins — the person who writes last
  determines what the agent believes

## Decision

### Confidence scores

Every version carries a `confidence` float (0.0–1.0) and a `starting_confidence`.
`starting_confidence` is set at creation and never changes. `confidence` decays
over time and can be boosted by endorsements.

Confidence semantics:

| Range | Meaning |
|-------|---------|
| 0.90–1.00 | High certainty — architectural decision, validated constraint |
| 0.70–0.89 | Reasonable confidence — documented pattern, observed practice |
| 0.50–0.69 | Working assumption — plausible but unverified |
| < 0.50 | Hypothesis — treat as suggestion, not constraint |

### Authority weighting

The `base_confidence` of the author's role is applied as a floor for their
contributions. A `principal_architect` with `base_confidence = 0.90` cannot
submit knowledge below that floor without explicitly overriding it. This ensures
that senior engineers' entries start at an appropriately high confidence.

Role-based `base_confidence` defaults (configurable per project in `quorum.json`):

| Role | Default base_confidence |
|------|------------------------|
| `principal_architect` | 0.90 |
| `senior_engineer` | 0.80 |
| `engineer` | 0.70 |
| `junior_engineer` | 0.60 |
| `agent` (claude) | 0.65 |

### Confidence decay

ACTIVE versions older than 7 days with `confidence > 0.10` decay on a scheduled
cadence (`scripts/decay.js`). The decay formula applies a multiplicative factor
per elapsed period. `starting_confidence` acts as a ceiling — endorsements can
restore confidence toward the starting value but not beyond it.

### Confidence endorsement (bump)

Any project member can endorse an ACTIVE entry via `POST /api/bump/:topic/:key`
(or the MCP confidence bump tool). Rules:
- 7-day cooldown per (author, entry) pair — one endorsement per week maximum
- The delta applied is role-weighted (`principal_architect` bump = larger delta)
- Confidence is capped at `starting_confidence`

### Conflict detection

When `remember()` stores new knowledge for an existing `topic:key`, the system:
1. Runs a semantic similarity check via Graphiti
2. If similarity exceeds a threshold, runs an LLM analysis comparing incoming vs. existing
3. If the LLM detects a contradiction, creates a `pending_decisions` record with `decision_type: 'conflict'`
4. Returns `conflict_detected` to the caller

The conflict entry contains:
- `existing_content` — what was there
- `incoming_content` — what was proposed
- `enrichment` — LLM analysis of the contradiction
- `conflict_reason` — machine-generated summary

Resolution options returned to the human:

| Resolution | Meaning |
|-----------|---------|
| `supersede` | New knowledge replaces old |
| `coexist_split` | Both valid — create a second key for the new context |
| `coexist_merge` | Both contain truth — merge into a single statement |
| `reject` | New addition is wrong |
| `escalate` | Too ambiguous — flag for senior review |

When Graphiti is unavailable, conflict detection is deferred. The entry is stored
as DRAFT with `status = PENDING_CONFLICT_CHECK`. The `/pending` tool surfaces these
for human review when the graph comes back online.

### Domain track record

`author_domain_stats` tracks per-author, per-domain counters:
- `approved_count` — entries approved by reviewers
- `recalled_count` — entries recalled (used) by agents  
- `superseded_count` — entries superseded (replaced)

These stats inform trust decisions but are not currently used to automatically
adjust confidence floors (reserved for v0.4 self-evolving graph).

## Consequences

**Positive:**
- Agents can reason about knowledge reliability at recall time (`confidence < 0.60` → flag to human)
- High-authority knowledge is naturally resistant to being silently overridden
- Stale knowledge is automatically downweighted without requiring manual curation
- Conflict detection surfaces disagreements before they become invisible data corruption

**Negative:**
- Confidence values require calibration — teams must decide what `0.85` means in their context
- Decay requires a scheduled job (`scripts/decay.js`) to be running
- Conflict detection adds latency to `remember()` calls (Graphiti semantic similarity + LLM analysis)
- False positives in conflict detection create noise in the pending queue

**Required by this decision:**
- Every version record must carry `confidence` and `starting_confidence`
- The bump endpoint must enforce the 7-day cooldown and cap at `starting_confidence`
- `recall()` must surface confidence in its response so callers can act on it
- The MCP `SKILL.md` must document the confidence thresholds agents should respect
