# Quorum

> *Every AI dystopia film has the same root cause — humans removed themselves from the decision loop. Quorum puts them back in.*

**Quorum** is an open-source governance layer for engineering knowledge — built on [Graphiti](https://github.com/getzep/graphiti)'s temporal knowledge graph — that gives Claude Code and multi-agent systems a shared, self-evolving, human-governed memory of engineering decisions, patterns, and institutional knowledge.

---

## The Problem

Multi-agent systems and AI coding assistants like Claude Code are brilliant — but they start from zero every session. Worse, when teams try to share knowledge between agents, they hit a deeper problem: **knowledge without governance.**

```
Agent A writes: "Use JWT for all internal services"
Agent B writes: "Use session tokens for internal services"
Result:         Both stored. No conflict flagged.
                Claude now confidently gives contradictory advice.
```

Existing solutions — Graphiti, Mem0, vector stores — handle storage and retrieval well. None handle the harder problem: **what happens when knowledge conflicts, who decides, and how do you audit it?**

---

## What Quorum Does

Quorum sits on top of Graphiti and adds a constitutional governance layer:

```
Engineer calls remember("auth", "token-strategy", "Use JWT for external")
        ↓
Quorum checks existing knowledge graph
        ↓
⚠️  Conflict detected with existing entry by @senior-architect (6 months ago)
    Existing: "Use session tokens always"
    Incoming: "Use JWT for external, sessions for internal"

    Options:
    A) Supersede existing — requires reason
    B) Coexist — different contexts, specify
    C) Reject new addition

→ Human decides. Resolution + reason stored with full audit trail.
```

---

## Key Features

- **Governance first** — conflict detection with human-in-the-loop resolution. Not silent. Not automatic. Governed.
- **Provenance always** — every node carries author, timestamp, confidence, source, conflict history
- **Authority-weighted writes** — a junior engineer's addition does not silently overwrite a senior architect's ADR
- **Self-evolving** — Claude Code skill reflects after every task and adds learnings automatically
- **Human at the fork** — agents operate autonomously on established knowledge; humans only intervene at genuine ambiguity
- **Export to human** — everything Quorum knows, exportable as Markdown or Confluence markup

---

## Architecture

```
Claude Code / AI Agents
        │ MCP
        ▼
┌─────────────────────┐
│  Quorum MCP Server  │
│  (Node.js)          │
├─────────────────────┤
│  Governance Layer   │  ← The differentiator
│  Conflict detection │
│  Authority weights  │
│  Provenance track   │
│  Confidence scores  │
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│  Graphiti Engine    │  ← Temporal knowledge graph (OSS)
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│  FalkorDB / Neo4j   │  ← Graph storage
│  / AWS Neptune      │
└─────────────────────┘
```

---

## Quick Start

```bash
git clone https://github.com/yourusername/quorum
cd quorum
cp .env.example .env   # add your LLM API key

docker-compose up -d

# Add to Claude Code
claude mcp add quorum -- node /path/to/quorum/src/server.js

# Verify
claude "What does Quorum know about auth?"
```

---

## MCP Tools

**Core knowledge tools:**

| Tool | Description |
|---|---|
| `remember(topic, key, content, author)` | Store knowledge — creates new version, never edits |
| `recall(topic, key, options?)` | Retrieve — default ACTIVE, `{history}` `{at}` `{version}` options |
| `history(topic, key)` | Full version timeline with triggered_by and audit links |
| `search(query, domain?)` | Semantic search across graph |
| `reflect(task_summary)` | Post-task self-evolving extraction |
| `export(topic?, format)` | Export to markdown or Confluence |
| `forget(topic, key, reason)` | Deprecate — creates DEPRECATED version, never hard delete |

**Governance tools:**

| Tool | Description |
|---|---|
| `review(action, topic, key, reviewer, note)` | Approve / reject / request changes on DRAFT knowledge |

**Integrations (v0.4):**

| Tool | Description |
|---|---|
| `ingest_pr(pr_url, options?)` | Extract knowledge from merged GitHub PR |
| `enrich_from_jira(issue_key)` | Fetch Jira issue via Atlassian MCP, extract knowledge |
| `enrich_from_confluence(page_id)` | Fetch Confluence page, extract ADRs / runbooks / designs |
| `search_atlassian(query, sources?)` | Unified search across Jira + Confluence + graph |
| `sync_atlassian(domain?)` | Proactive staleness detection for Atlassian-linked knowledge |

---

## How It Differs from Graphiti Alone

| Capability | Graphiti | Quorum |
|---|---|---|
| Temporal knowledge graph | ✅ | ✅ inherited |
| Conflict detection | ✅ silent/auto | ✅ + human governance |
| Conflict resolution | ✅ recency wins | ✅ + authority weighting |
| Reason capture | ❌ | ✅ required field |
| Full audit trail | ⚠️ timestamps only | ✅ decision history + SHA256 chain |
| Provenance | ⚠️ source episode | ✅ author + confidence + lineage |
| Human-in-the-loop | ❌ | ✅ at conflict forks |
| Versioning | ⚠️ bi-temporal edges | ✅ explicit vN chain, triggered_by, history() |
| Point-in-time recall | ⚠️ partial | ✅ recall({ at: date }) deterministic |
| Draft approval workflow | ❌ | ✅ review() tool |
| Self-evolving skill | ❌ | ✅ Claude Code SKILL.md |
| Export to human | ❌ | ✅ markdown + confluence |
| PR knowledge ingestion | ❌ | ✅ ingest_pr() (v0.4) |
| Atlassian integration | ❌ | ✅ Jira + Confluence via MCP (v0.4) |
| Engineering entity types | ❌ | ✅ Decision, Pattern, Constraint, Runbook |

---

## Philosophy

Anthropic builds Claude around a model spec — values baked into how Claude reasons, not rules bolted on top. Governance is architecture, not afterthought.

Quorum applies the same principle to engineering knowledge. Not a system that *prevents* bad knowledge from entering. A system that *naturally tends toward* accurate, governed, trustworthy knowledge because that's how it's built.

---

## Roadmap

- **v0.1** — Core MCP server + Graphiti integration + conflict detection
- **v0.2** — Full governance (authority weighting, human-in-the-loop, confidence scoring)
- **v0.3** — Self-evolving Claude Code skill
- **v0.4** — Export (Markdown + Confluence) + multi-team namespacing
- **v1.0** — Production ready
- **Future** — Confluence ingestion, Draw.io parsing, cross-org federation

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Apache 2.0 licensed.
