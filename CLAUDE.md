# Engram
## Persistent Engineering Memory for Claude Code and AI Agents
### Agent Instruction File — Read this first, build everything after.

---

## What is Engram?

Engram (noun) — *a persistent memory trace in the brain formed by experience.*

Engram is an open-source governance layer for engineering knowledge — built on top of Graphiti's temporal knowledge graph — that gives Claude Code and multi-agent systems a shared, self-evolving, human-governed memory of engineering decisions, patterns, and institutional knowledge.

**The core problem it solves:**

Every AI dystopia film — Mercy, Minority Report, Ex Machina, 2001 — shares the same root failure: humans built something powerful, removed themselves from the decision loop, and lost the ability to course correct.

Multi-agent systems today have the same flaw. They share memory without governance. Knowledge is written silently, conflicts are resolved automatically, and there is no audit trail.

Engram puts humans back in the loop — not as a bottleneck, but as a constitutional layer. Governance is not a feature. It is the architecture.

---

## Design Philosophy

### 1. Governance is Architecture
Every memory operation asks: Who added this? Does it conflict? Should a human be notified? Is this traceable? These are not afterthought checks — they are first-class primitives.

### 2. Constitution over Rules
Engram does not maintain a blocklist of forbidden knowledge. It maintains a framework for judgment. Like Anthropic's model spec for Claude, Engram bakes values into how knowledge is reasoned about — not filters applied on top.

### 3. Provenance Always
Every node in the graph carries: author, timestamp, confidence, source, conflict history. Nothing is anonymous. Nothing is untrackable.

### 4. Human at the Fork
Agents operate autonomously within established knowledge. At genuine ambiguity — a contradiction, a superseded decision, a low-confidence assertion — humans are surfaced a structured decision. Not a wall. A choice.

### 5. Silent Automatic ≠ Safe
Graphiti resolves conflicts automatically by recency. Engram questions whether recency is the right signal for engineering decisions. A junior engineer's new addition should not silently overwrite a senior architect's 6-month-old ADR.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Engram                           │
│                                                     │
│  ┌─────────────┐    ┌──────────────────────────┐   │
│  │ MCP Server  │    │   Governance Layer        │   │
│  │ (Node.js)   │    │                          │   │
│  │             │    │  - Conflict Detection     │   │
│  │ remember()  │───►│  - Authority Weighting    │   │
│  │ recall()    │    │  - Human-in-the-loop      │   │
│  │ search()    │    │  - Provenance Tracking    │   │
│  │ export()    │    │  - Confidence Scoring     │   │
│  │ reflect()   │    │                          │   │
│  └──────┬──────┘    └──────────┬───────────────┘   │
│         │                      │                    │
│         └──────────┬───────────┘                    │
│                    │                                │
│         ┌──────────▼───────────┐                   │
│         │   Graphiti Engine    │                   │
│         │  (Temporal KG)       │                   │
│         │                      │                   │
│         │  - Entity Extraction │                   │
│         │  - Temporal Edges    │                   │
│         │  - Hybrid Search     │                   │
│         │  - Bi-temporal Model │                   │
│         └──────────┬───────────┘                   │
│                    │                                │
│         ┌──────────▼───────────┐                   │
│         │   Graph Database     │                   │
│         │  FalkorDB (default)  │                   │
│         │  Neo4j (supported)   │                   │
│         │  Amazon Neptune      │                   │
│         └──────────────────────┘                   │
└─────────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
   Claude Code          AI Agents
   (MCP client)    (LangGraph, CrewAI etc)
```

---

## Project Structure

Scaffold exactly this:

```
engram/
├── CLAUDE.md                     ← this file
├── README.md                     ← OSS-facing documentation
├── CONTRIBUTING.md               ← contribution guidelines
├── LICENSE                       ← Apache 2.0
├── package.json                  ← Node.js project
├── docker-compose.yml            ← FalkorDB + Engram stack
├── .env.example
│
├── src/
│   ├── server.js                     ← MCP server entry point
│   │
│   ├── tools/                        ← MCP tool implementations
│   │   ├── remember.js               ← store with governance pipeline + versioning
│   │   ├── recall.js                 ← retrieve by topic:key, version options
│   │   ├── history.js                ← full version timeline for a node
│   │   ├── search.js                 ← semantic search across graph
│   │   ├── reflect.js                ← post-task self-evolution
│   │   ├── export.js                 ← export to markdown/confluence
│   │   ├── forget.js                 ← deprecate with reason
│   │   ├── review.js                 ← approve/reject/request_changes
│   │   ├── ingest_pr.js              ← PR knowledge extraction
│   │   ├── enrich_from_jira.js       ← Jira enrichment via Atlassian MCP
│   │   ├── enrich_from_confluence.js ← Confluence extraction + ADR parsing
│   │   ├── search_atlassian.js       ← unified search across all sources
│   │   └── sync_atlassian.js         ← proactive staleness detection
│   │
│   ├── governance/                   ← the differentiator
│   │   ├── constitutional.js         ← Layer 1 rules (enforced in code)
│   │   ├── conflict.js               ← detect semantic conflicts
│   │   ├── authority.js              ← role + domain track record + usage
│   │   ├── confidence.js             ← score and decay knowledge confidence
│   │   └── provenance.js             ← track full lineage
│   │
│   ├── audit/                        ← dual-store audit pipeline
│   │   ├── pipeline.js               ← wraps every operation pre+post
│   │   ├── chain.js                  ← SHA256 tamper-evident chain
│   │   ├── primary.js                ← graph DB audit store
│   │   └── secondary.js              ← flat file append-only store
│   │
│   ├── graph/
│   │   ├── client.js                 ← Graphiti client wrapper
│   │   ├── schema.js                 ← Engram entity/edge types
│   │   └── queries.js                ← common graph queries
│   │
│   ├── atlassian/
│   │   ├── jira.js                   ← Jira extraction + knowledge mapping
│   │   ├── confluence.js             ← Confluence extraction + ADR parsing
│   │   ├── diagram.js                ← image → Mermaid conversion (human-assisted)
│   │   └── sync.js                   ← staleness detection scheduler
│   │
│   ├── pr/
│   │   ├── github.js                 ← GitHub API client
│   │   ├── extractor.js              ← PR knowledge extraction agent
│   │   └── authority.js              ← PR authority scoring model
│   │
│   └── export/
│       ├── markdown.js               ← clean .md per topic
│       └── confluence.js             ← Confluence wiki markup
│
├── skill/
│   └── SKILL.md                      ← Claude Code skill (self-evolving)
│
├── helm/
│   └── engram/
│       ├── Chart.yaml
│       ├── values.yaml               ← production defaults
│       ├── values-local.yaml         ← Docker Desktop K8s overrides
│       ├── values-aws.yaml           ← AWS-specific overrides (future)
│       └── templates/
│           ├── engram/
│           │   ├── deployment.yaml
│           │   ├── service.yaml
│           │   └── configmap.yaml
│           ├── falkordb/
│           │   ├── statefulset.yaml
│           │   ├── service.yaml
│           │   └── pvc.yaml
│           ├── postgresql/
│           │   ├── statefulset.yaml
│           │   ├── service.yaml
│           │   └── pvc.yaml
│           ├── jobs/
│           │   └── seed.yaml
│           └── _helpers.tpl
│
├── .github/
│   └── workflows/
│       ├── test.yml                  ← CI — constitutional + governance tests
│       ├── build.yml                 ← build + push Docker image
│       └── engram-pr-ingest.yml      ← PR knowledge extraction on merge
│
├── scripts/
│   ├── setup.sh                      ← bootstrap local stack
│   ├── init-db.sql                   ← PostgreSQL audit schema
│   └── seed.js                       ← seed with sample engineering knowledge
│
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── cli.js                            ← engram CLI entry point
│
└── tests/
    ├── constitutional/
    │   ├── no-hard-delete.test.js
    │   ├── append-only-audit.test.js
    │   ├── reason-required.test.js
    │   ├── no-self-approval.test.js
    │   ├── multi-party-config.test.js
    │   └── meta.test.js              ← test suite tests itself
    ├── governance/
    │   ├── conflict.test.js
    │   └── authority.test.js
    ├── tools/
    │   ├── remember.test.js
    │   └── recall.test.js
    └── llm/
        ├── conflict-golden-dataset.js
        └── conflict-detection.test.js
```

---

## Graphiti Integration

Engram uses Graphiti as its temporal knowledge graph engine. Do NOT reimplement graph storage, entity extraction, or temporal invalidation — Graphiti handles all of this.

### What Graphiti gives us for free:
- Bi-temporal model (valid_at, invalid_at, expired_at)
- Automatic entity and relationship extraction from text
- Hybrid search (semantic + BM25 + graph traversal)
- Conflict detection via temporal metadata
- Incremental graph updates without recomputation
- FalkorDB, Neo4j, Amazon Neptune support

### What Engram adds on top:
- Engineering-domain entity types (Decision, Pattern, Constraint, Runbook, Requirement)
- Authority weighting — not all writes are equal
- Human-in-the-loop governance at conflict points
- Reason capture — WHY was this changed?
- Structured conflict resolution workflow
- Confidence scoring beyond recency
- Export to human-readable formats
- Self-evolving skill for Claude Code

### Critical: Graphiti is Python-only

Graphiti has no npm package. It cannot be imported into Node.js directly.
Engram (Node.js) calls Graphiti via HTTP — Graphiti runs as a Python Docker sidecar.

```
Engram MCP Server (Node.js :8000)
        ↓ HTTP calls
Graphiti MCP Server (Python :8001)   ← Docker sidecar
        ↓
FalkorDB (:6379)
```

### Graphiti Client in Node.js (HTTP calls, not npm import):

```javascript
// src/graph/client.js
// Graphiti runs as a Python sidecar — call it via HTTP
// Do NOT npm install graphiti — it does not exist

const GRAPHITI_URL = process.env.GRAPHITI_URL || 'http://graphiti:8001'

export async function addEpisode(content, metadata) {
  const response = await fetch(`${GRAPHITI_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tool: 'add_episode',
      params: {
        name: metadata.key,
        episode_body: content,
        group_id: process.env.ENGRAM_GROUP_ID || 'default',
        source_description: metadata.source
      }
    })
  })
  return response.json()
}

export async function searchNodes(query, options = {}) {
  const response = await fetch(`${GRAPHITI_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tool: 'search_nodes',
      params: { query, group_ids: [process.env.ENGRAM_GROUP_ID || 'default'], ...options }
    })
  })
  return response.json()
}

export async function searchFacts(query, options = {}) {
  const response = await fetch(`${GRAPHITI_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tool: 'search_facts',
      params: { query, group_ids: [process.env.ENGRAM_GROUP_ID || 'default'], ...options }
    })
  })
  return response.json()
}
```

### Graphiti Sidecar LLM Configuration

Graphiti uses OpenAI by default. For local dev use OpenAI. For production use Bedrock.

```
Local dev:    OpenAI GPT-4o-mini (LLM) + text-embedding-3-small (embedder)
              → Proven to work with Graphiti, cheap, single API key

Production:   AWS Bedrock Claude Sonnet (LLM) + Bedrock Titan (embedder)
              → IAM auth, no API keys, fits enterprise security
              → You're already on Bedrock at Macquarie
```

**Note on Anthropic direct:** Graphiti supports Anthropic as LLM provider but warns it works
best with services that support Structured Output (OpenAI and Gemini are confirmed stable).
Claude Sonnet 4.5 now supports structured output — but OpenAI is the safer default until
Graphiti explicitly validates Claude structured output support in their test suite.

---

## Engram Entity Schema

Define these as Graphiti Pydantic-compatible entity types:

```javascript
// src/graph/schema.js

const EngramEntityTypes = {
  Decision: {
    description: 'An architectural or technical decision made by the team',
    properties: ['rationale', 'alternatives_considered', 'status', 'domain']
  },
  Pattern: {
    description: 'A reusable code or design pattern adopted by the team',
    properties: ['implementation', 'when_to_use', 'when_not_to_use', 'domain']
  },
  Constraint: {
    description: 'A non-functional requirement or technical constraint',
    properties: ['type', 'source', 'impact', 'domain']
  },
  Runbook: {
    description: 'An operational procedure or how-to guide',
    properties: ['steps', 'triggers', 'rollback', 'domain']
  },
  Requirement: {
    description: 'A business or technical requirement',
    properties: ['acceptance_criteria', 'priority', 'source', 'domain']
  }
};

const EngramEdgeTypes = {
  SUPERSEDES: 'This knowledge replaces previous knowledge',
  DEPENDS_ON: 'This knowledge requires the other to be true',
  CONFLICTS_WITH: 'This knowledge contradicts the other (unresolved)',
  INFORMED_BY: 'This knowledge was derived from the other',
  RELATES_TO: 'General semantic relationship'
};
```

---

## MCP Tools Specification

### `remember(topic, key, content, author, confidence?, tags?)`
Store new engineering knowledge. Creates a new version — never edits in place.

**Governance flow:**
1. Check for existing node at this topic:key
2. If no existing node → create v1, status ACTIVE, triggered_by: engineer_decision
3. If existing node → run conflict detection
4. If no conflict → create vN superseding vN-1, reason required, triggered_by set
5. If conflict detected → run authority comparison
6. If authority clear → auto-supersede with notification, reason required
7. If authority ambiguous → surface to human for resolution
8. On resolution → create vN, store reason + triggered_by: conflict_resolution
9. Record version_impact in audit entry (bidirectional reference)

**Version record written on every remember():**
```
version:        N (incremented from previous)
status:         ACTIVE (previous version → SUPERSEDED)
triggered_by:   engineer_decision | conflict_resolution | pr_merge |
                atlassian_sync | confidence_decay | reflect
supersedes:     { version: N-1, reason: "...", conflict_id: "..." }
created_by_audit: audit_entry_id (bidirectional)
```

**Conflict detection logic:**
```
Semantic similarity > 0.85 between new and existing → flag as potential conflict
LLM call: "Does this contradict existing? YES/NO + reason"
If YES → conflict workflow
If NO → store as new version, RELATES_TO edge to existing
```

**Authority comparison:**
```
Composite score: role (35%) + domain track record (30%) +
                 usage validation (25%) + confidence (10%)

Delta > AUTHORITY_THRESHOLD → auto-supersede + notify
Delta ≤ threshold            → surface to human
```

### `recall(topic, key, options?)`
Retrieve knowledge by topic:key.

Options:
- Default — returns latest ACTIVE version only
- `{ history: true }` — returns full version chain v1 → vN with reasons
- `{ at: "2024-11-30" }` — returns version that was ACTIVE on that date
- `{ version: 2 }` — returns specific version with supersession note

Returns structured XML injection format for Claude context.
Includes: content, version, author, confidence, created_at, triggered_by, supersedes.
Flags if version was updated recently (< 7 days).
Alerts if version loaded in previous session has since been superseded.

### `search(query, domain?, limit?)`
Semantic search across the knowledge graph.
- Uses Graphiti hybrid search (semantic + BM25 + graph traversal)
- Optional domain filter (auth, payments, infra etc)
- Returns ranked results with provenance

### `reflect(task_summary, decisions_made, patterns_used)`
Self-evolving tool — called by Claude after task completion.
- Analyses task for learnable knowledge
- Extracts: decisions made, patterns applied, constraints discovered
- Calls remember() for each extracted learning
- Surfaces conflicts to human if any arise

### `export(topic?, format)`
Export knowledge to human-readable format.
- `format: 'markdown'` — clean .md file per topic
- `format: 'confluence'` — wiki markup
- Includes: active decisions, superseded history, resolved conflicts, audit trail

### `forget(topic, key, reason, author)`
Deprecate knowledge — never hard delete.
- Creates new DEPRECATED version — does not modify existing node
- Requires reason string — enforced, not optional
- Records triggered_by: engineer_decision
- Creates version_impact audit entry

### `history(topic, key)`
Return full version timeline for a knowledge node.

Output:
```
auth:token-strategy — Version History
──────────────────────────────────────────────────────
v3 ● ACTIVE      @ayan               Dec 01 2024
   "JWT for Lambda, sessions for non-Lambda internal"
   Triggered by: conflict_resolution (conflict_abc123)
   Reason: ADR-042 nuanced after Lambda constraint discovered
   Audit: entry_1389

v2   SUPERSEDED  @senior-architect   Jun 01 2024
   "Use JWT for all services"
   Triggered by: engineer_decision
   Reason: Lambda services don't support sessions
   Superseded by v3 on Dec 01 2024

v1   SUPERSEDED  @junior-dev         Jan 15 2024
   "Use session tokens for all services"
   Triggered by: engineer_decision
   Superseded by v2 on Jun 01 2024
```

### `review(action, topic, key, reviewer, note)`
Approve, reject, or request changes on a DRAFT knowledge entry.

- `action`: `"approve"` | `"reject"` | `"request_changes"`
- `reviewer`: must not be the author of the entry (self-approval constitutional rule)
- `note`: required — reason for decision, stored in audit trail
- On approve → status transitions DRAFT → ACTIVE, version becomes usable
- On reject → status transitions DRAFT → REJECTED, stored but never used
- On request_changes → stays DRAFT, note sent back to author
- Creates version_impact audit entry with reviewer identity

```javascript
review("approve", "auth", "token-strategy", "senior-architect",
  "Confirmed — aligns with ADR-042 and Lambda constraints")
```

### `ingest_pr(pr_url, options?)`
Extract engineering knowledge from a merged GitHub PR.

Fetches the full PR via GitHub API: description, diff, all review comments,
review resolutions, approvals, and CI status. Runs extraction agent.
All extracted knowledge enters DRAFT with `triggered_by: pr_merge`.

Options:
- `dry_run: true` — show what would be extracted without storing (default: true initially)
- `domains: ["auth"]` — filter extraction to specific domains
- `fetch_linked_jira: true` — auto-enrich from linked Jira tickets via Atlassian MCP
- `auto_approve_if: { approved_by_role: "principal_architect" }` — skip DRAFT for trusted PRs

Authority model for PR-extracted knowledge:
```
PR description only                → confidence 0.50, DRAFT
Review comment (one party)         → confidence 0.65, DRAFT
Resolved comment (both agreed)     → confidence 0.75, DRAFT (fast-track)
Approved by any approver           → confidence 0.80, DRAFT
Approved by principal architect    → confidence 0.85, DRAFT (may fast-track)
Post-merge: no incidents 90 days   → confidence +0.10 delta
Post-merge: incident linked        → confidence -0.30, retrospective triggered
```

### `enrich_from_jira(issue_key, knowledge_key?)`
Fetch a Jira issue via Atlassian MCP and extract knowledge.

Extracts: decisions, requirements, constraints, acceptance criteria.
Maps issue type → entity type: Bug → Constraint, Story → Requirement, Spike → Decision.
Jira status signals: DONE → confidence +0.05, REOPENED → confidence -0.15 + flag.
Linked issues become graph edges: "blocks" → DEPENDS_ON, "relates to" → RELATES_TO.
If `knowledge_key` provided → attaches Jira context as provenance to existing node.
All extracted knowledge enters DRAFT with `triggered_by: atlassian_sync`.

```javascript
enrich_from_jira("AUTH-247", "auth:token-strategy")
// Fetches AUTH-247, extracts business driver + acceptance criteria
// Links to existing auth:token-strategy node as enrichment
```

### `enrich_from_confluence(page_id, knowledge_key?)`
Fetch a Confluence page via Atlassian MCP and extract knowledge.

Handles: ADRs → Decision entity, Runbooks → Runbook entity,
technical designs → multiple nodes with relationships,
meeting notes → decisions with team endorsement signals.
Diagrams are handled separately via the human-assisted image → Mermaid flow.
Space authority ranking (configurable): Engineering > Team > General.
All extracted knowledge enters DRAFT with `triggered_by: atlassian_sync`.

```javascript
enrich_from_confluence("12345678")
// Fetches Confluence page, extracts ADR decisions + alternatives
// Returns extracted knowledge entries for review before storing
```

### `search_atlassian(query, sources?, domain?)`
Unified semantic search across Jira + Confluence + Engram graph simultaneously.

- `sources`: `["jira", "confluence", "graph"]` (default: all three)
- `domain`: optional filter (auth, payments, infra etc)
- Returns ranked results from all sources with relevance explanation
- Useful when engineer wants full context before implementing

```javascript
search_atlassian("how should we handle auth delegation", { domain: "auth" })
// Returns: graph nodes + Jira tickets + Confluence pages all ranked together
```

### `sync_atlassian(domain?)`
Proactive staleness detection — check Atlassian for changes to sources linked from knowledge nodes.

- Queries Jira for status changes on tickets linked to knowledge nodes
- Queries Confluence for version changes on pages used as knowledge sources
- Flags knowledge nodes whose source documents have changed
- Returns: list of nodes recommended for review with change summary

```javascript
sync_atlassian("auth")
// Checks all auth domain nodes with Jira/Confluence sources
// Returns: "auth:token-strategy source ADR-042 updated 3 days ago — review recommended"
```

---

## Versioning Rules for Agent Implementation

These are non-negotiable — the agent must implement these correctly:

1. **No edits in place** — every remember() creates a new version
2. **Version counter increments** — v1, v2, v3... never resets for a topic:key
3. **Only one ACTIVE** — when vN is created, vN-1 becomes SUPERSEDED atomically
4. **triggered_by always set** — never null, never empty
5. **Bidirectional reference** — version knows its audit entry, audit entry knows its version
6. **recall() default = ACTIVE only** — never return SUPERSEDED without explicit request
7. **history() and at/version options** — must be implemented on recall()
8. **DRAFT enters at v1** — even first version of Claude additions starts as DRAFT
9. **Supersession requires reason** — same as forget(), enforced at code level
10. **Atomic state transition** — old ACTIVE → SUPERSEDED and new ACTIVE in single transaction

---

## Governance Layer Details


### Conflict Resolution Workflow

```
New knowledge arrives
        │
        ▼
Graphiti semantic search for similar nodes
        │
        ▼
Similarity > threshold?
   │              │
  YES             NO
   │              │
   ▼              ▼
LLM conflict   Store normally
check          via Graphiti
   │
   ▼
Contradiction confirmed?
   │              │
  YES             NO
   │              │
   ▼              ▼
Authority      Store as
comparison     related node
   │
   ▼
Clear winner?
   │              │
  YES             NO
   │              │
   ▼              ▼
Auto-resolve   Surface to human:
+ notify       structured decision
               A) Supersede existing (add reason)
               B) Coexist (different contexts)
               C) Reject new addition
                       │
                       ▼
               Resolution stored
               with full audit trail
```

### Authority Weighting

```javascript
// src/governance/authority.js

function calculateAuthority(episode) {
  return {
    confidence: episode.confidence || 0.5,      // explicit confidence score
    recency: calculateRecencyScore(episode.created_at),
    accessFrequency: episode.access_count || 0,  // how often recalled
    // Note: role/seniority can be added later via team config
  };
}

function shouldAutoSupersede(incoming, existing) {
  const incomingScore = calculateAuthority(incoming);
  const existingScore = calculateAuthority(existing);
  const delta = incomingScore.total - existingScore.total;
  return delta > AUTHORITY_THRESHOLD; // configurable
}
```

### Confidence Scoring

Every knowledge node has a confidence score (0-1) that evolves:
- Starts at author-provided value (default 0.7)
- Increases when recalled frequently
- Decreases when age increases without access
- Drops when a conflict is raised against it
- Rises when a conflict is resolved in its favour

---

## Self-Evolving Skill (`skill/SKILL.md`)

This file is placed in `.claude/skills/` of any project using Engram.

It instructs Claude Code to:

1. **At session start** — search Engram for context relevant to current task domain
2. **During task** — recall specific knowledge when making implementation decisions
3. **After task completion** — reflect and extract learnable knowledge:
   - Was an architectural decision made? → remember as Decision
   - Was a pattern applied? → remember as Pattern
   - Was a constraint discovered? → remember as Constraint
   - Was a bug fixed with a non-obvious fix? → remember as Runbook

**Self-check questions Claude asks itself post-task:**
- "Did I make a decision that a future engineer should know about?"
- "Did I discover something about this domain that isn't in Engram yet?"
- "Did I apply a pattern that others should reuse?"
- "Would a new engineer benefit from knowing what I just learned?"

---

## Export Format

### Markdown Export
```markdown
# {Topic} Domain — Engineering Knowledge
> Generated by Engram | {timestamp}

## ✅ Active Knowledge

### {key}
**Summary:** {summary}
**Author:** @{author} | **Confidence:** {confidence} | **Updated:** {date}
**Tags:** {tags}

{full detail}

---

## 🔄 Superseded

| Key | Superseded By | Reason | Date |
|-----|---------------|--------|------|

## ⚔️ Conflicts Resolved

| Key | Conflict | Resolution | Resolved By | Date |
|-----|----------|------------|-------------|------|

## 📊 Knowledge Stats
- Total active nodes: {n}
- Last updated: {date}
- Most accessed: {key}
- Lowest confidence: {key} ({score})
```

---

## Docker Compose

```yaml
version: '3.8'
services:
  falkordb:
    image: falkordb/falkordb:latest
    ports:
      - "6379:6379"
      - "3000:3000"  # FalkorDB browser UI
    volumes:
      - falkordb_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  postgresql:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: engram_audit
      POSTGRES_USER: engram
      POSTGRES_PASSWORD: engram_local
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./scripts/init-db.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U engram"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Graphiti runs as a Python sidecar — Engram (Node.js) calls it via HTTP
  # Graphiti has no npm package — do NOT try to import it into Node.js
  graphiti:
    image: zep/graphiti-mcp:latest   # or build from getzep/graphiti/mcp_server
    ports:
      - "8001:8000"
    environment:
      - FALKORDB_URI=redis://falkordb:6379
      # LLM: OpenAI by default (proven stable with Graphiti)
      # For production: switch to Bedrock via AWS_* env vars
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - LLM_MODEL_NAME=gpt-4o-mini
      - EMBEDDER_MODEL_NAME=text-embedding-3-small
      - GROUP_ID=${ENGRAM_GROUP_ID:-default}
    depends_on:
      falkordb:
        condition: service_healthy

  engram:
    build: .
    ports:
      - "8000:8000"
    environment:
      - GRAPHITI_URL=http://graphiti:8000
      - FALKORDB_URI=redis://falkordb:6379
      - POSTGRES_HOST=postgresql
      - POSTGRES_USER=engram
      - POSTGRES_PASSWORD=engram_local
      - POSTGRES_DB=engram_audit
      - ENGRAM_GROUP_ID=${ENGRAM_GROUP_ID:-default}
      - ENGRAM_CONFLICT_THRESHOLD=0.85
      - ENGRAM_AUTHORITY_THRESHOLD=0.20
      - NODE_ENV=development
    depends_on:
      falkordb:
        condition: service_healthy
      postgresql:
        condition: service_healthy
      graphiti:
        condition: service_started

volumes:
  falkordb_data:
  postgres_data:
```

---

## Seed Data (`scripts/seed.js`)

Seed with realistic engineering knowledge across these domains:

**auth domain:**
- `auth:delegation-flow` — internal vs external auth strategy
- `auth:token-strategy` — JWT vs session token decision with rationale
- `auth:rate-limiting` — rate limiting approach and thresholds

**api domain:**
- `api:error-standards` — error response format with examples
- `api:versioning` — versioning strategy and deprecation policy
- `api:pagination` — pagination pattern (cursor vs offset)

**db domain:**
- `db:connection-pooling` — pool size decisions and rationale
- `db:migration-strategy` — how migrations are run in prod
- `db:naming-conventions` — table/column naming rules

**infra domain:**
- `infra:secrets-management` — how secrets are stored and rotated
- `infra:retry-strategy` — retry patterns and backoff config

**testing domain:**
- `testing:unit-strategy` — what to unit test, what not to
- `testing:integration-scope` — integration test boundaries

Make one pair of entries deliberately contradictory (for conflict detection demo).

---

## Environment Variables

```env
# ─────────────────────────────────────────────
# Engram MCP Server (Node.js)
# ─────────────────────────────────────────────

# Graphiti sidecar URL (Python — runs as Docker service)
GRAPHITI_URL=http://graphiti:8000      # docker-compose service name
# GRAPHITI_URL=http://localhost:8001   # if running locally outside Docker

# Graph Database (FalkorDB)
FALKORDB_URI=redis://localhost:6379

# Audit secondary store (PostgreSQL)
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=engram_audit
POSTGRES_USER=engram
POSTGRES_PASSWORD=engram_local

# Engram governance config
ENGRAM_GROUP_ID=default            # namespace for team isolation
ENGRAM_CONFLICT_THRESHOLD=0.85     # semantic similarity conflict threshold
ENGRAM_AUTHORITY_THRESHOLD=0.20    # auto-supersede delta threshold
ENGRAM_PORT=8000
NODE_ENV=development

# ─────────────────────────────────────────────
# Graphiti Sidecar (Python — set in docker-compose / k8s)
# Graphiti is Python-only. These vars are for the Graphiti container,
# not the Engram Node.js process.
# ─────────────────────────────────────────────

# LOCAL DEV — OpenAI (recommended: proven stable with Graphiti)
OPENAI_API_KEY=sk-...
LLM_MODEL_NAME=gpt-4o-mini              # cheap, fast, structured output support
EMBEDDER_MODEL_NAME=text-embedding-3-small

# PRODUCTION OPTION — AWS Bedrock (recommended for enterprise)
# Set these in Graphiti container instead of OPENAI_API_KEY
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
# AWS_REGION=ap-southeast-2
# LLM_MODEL_NAME=anthropic.claude-sonnet-4-5
# EMBEDDER_MODEL_NAME=amazon.titan-embed-text-v2

# ALTERNATIVE — Anthropic direct (supported but verify structured output stability)
# ANTHROPIC_API_KEY=sk-ant-...
# LLM_MODEL_NAME=claude-sonnet-4-5
# Note: still needs a separate embedder (OpenAI or local Ollama)
```

---

## Testing

Use Vitest. Cover:

**Governance tests:**
- `conflict.test.js` — no conflict, soft conflict, hard conflict, authority comparison
- `authority.test.js` — scoring, auto-supersede, human escalation

**Tool tests:**
- `remember.test.js` — happy path, duplicate, conflict triggered
- `recall.test.js` — found, not found, superseded
- `search.test.js` — semantic results, domain filter, ranked output

- `reflect.test.js` — extraction from task summary, remember triggered
- `export.test.js` — markdown structure, conflict section, audit trail

Mock Graphiti client for unit tests. Integration tests run against local FalkorDB.

---

## OSS Launch Plan

### README must include:
- One-line pitch
- The governance philosophy (why this exists)
- Quick start (docker-compose up + claude mcp add)
- Architecture diagram
- Comparison with Graphiti alone (what Engram adds)
- Roadmap

### Target communities:
- HackerNews: "Show HN: Engram — governance layer for AI agent memory"
- r/LocalLLaMA
- r/ClaudeAI
- Dev.to
- Tag @getzep on Twitter/X — they will likely notice and engage

### Differentiation message:
> "Graphiti is brilliant at temporal knowledge graphs. Engram is the governance layer on top — conflict detection with human oversight, authority weighting, provenance tracking, and self-evolving knowledge from Claude Code sessions. Built for engineering teams who can't afford silent knowledge corruption."

---

## Roadmap

```
v0.1 — Core (build this first)
  ✅ MCP server with all tools
  ✅ Graphiti integration
  ✅ Basic conflict detection
  ✅ Provenance tracking
  ✅ FalkorDB docker stack
  ✅ Seed data + README

v0.2 — Governance
  → Human-in-the-loop conflict resolution
  → Authority weighting
  → Confidence scoring + decay
  → Audit trail export

v0.3 — Self-evolving
  → reflect() skill for Claude Code
  → Post-task knowledge extraction
  → Confidence increases on access

v0.4 — Export + Integrations
  → Markdown export
  → Confluence wiki markup export
  → Multi-team group_id namespacing

v1.0 — Production Ready
  → Full test coverage
  → Docker + npm package
  → Hosted docs
  → AWS Neptune support (for enterprise)

Future
  → Confluence ingestion agent
  → Diagram ingestion (image → Mermaid via Claude vision, human validates)
  → Cross-org knowledge federation
  → Analytics dashboard
```

---

## Agent Build Instructions

If you are a Claude agent reading this file:

1. Scaffold the full project structure above
2. Install Graphiti: `pip install graphiti-core` (Python SDK) or use HTTP API
3. Implement all MCP tools in `src/tools/` — each as a separate module
4. Implement governance layer in `src/governance/`
5. Wire Graphiti client in `src/graph/client.js`
6. Write `docker-compose.yml` with FalkorDB + Engram
7. Write `scripts/seed.js` with realistic contradictory data
8. Write `skill/SKILL.md` for Claude Code self-evolution
9. Write tests for all governance logic
10. Write `README.md` — OSS-quality, not internal docs quality
11. Write `TESTING.md` is already provided — implement the test files it describes
12. Constitutional tests must have 100% coverage before v0.1 ships
13. CI pipeline must include constitutional guard job that cannot be skipped
14. Read `AUDIT.md` — implement the dual-store audit pipeline in `src/audit/`
    Every tool call flows through the pipeline. Pre + post audit entries per operation.
    SHA256 chain across all entries. Both stores written atomically.
    If either store fails the operation must roll back. No exceptions.

15. Implement versioning correctly — this is fundamental, not optional:
    - remember() always creates a new version — never edits in place
    - Only one ACTIVE version per topic:key at any time — atomic state transition
    - triggered_by is always set — never null
    - Bidirectional reference between version record and audit entry — always
    - recall() supports { history, at, version } options
    - history() tool returns full version timeline with audit links
    - init-db.sql must include knowledge_versions and version_audit_links tables
    - All version transitions are append-only — no UPDATE or DELETE ever

16. Seed data must include at least one topic:key with 3 versions
    to demonstrate the version history CLI command in the demo

**Principles while building:**
- Governance logic must be explicit — no magic, no silent decisions
- Every conflict must be logged even if auto-resolved
- Never hard delete — always supersede with reason
- Versioning and audit are one system — they reference each other
- Audit is not a feature — it is the pipeline. Build it that way from day one.
- Prefer simple and explicit over clever and implicit
- The README is a first-class deliverable — make it compelling
