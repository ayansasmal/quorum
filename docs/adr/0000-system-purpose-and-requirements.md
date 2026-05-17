# ADR-0000: System Purpose and Core Requirements

**Status:** Accepted  
**Date:** 2026-05-16  
**Deciders:** Platform team

---

## Context

AI coding agents (Claude Code, Copilot, etc.) operate within a session. When the
session ends, the agent's context is gone. Teams that use AI agents heavily face
a compounding problem: the same decisions get re-evaluated in every new session,
the same mistakes get made, and institutional knowledge locked in one engineer's
head or one Slack thread is invisible to the agent.

At the same time, simply giving agents a flat memory store creates new risks:
- A junior engineer's mistake gets stored alongside a senior architect's ADR
  with no indication of relative authority
- There is no conflict detection when two engineers make incompatible decisions
- There is no governance — agents can overwrite decisions without human approval
- There is no audit trail proving what was decided, by whom, and when

Existing solutions (RAG over docs, project-level CLAUDE.md files, vector databases)
solve the retrieval problem but not the governance problem.

## Requirements

### Functional requirements

| ID | Requirement |
|----|------------|
| FR-01 | The system must persist engineering knowledge across AI agent sessions |
| FR-02 | Knowledge must be versioned — every change must create a new version, not overwrite the old |
| FR-03 | Knowledge must have a status (draft/active/superseded/deprecated/rejected) |
| FR-04 | Agents may propose knowledge but humans must approve before it becomes authoritative |
| FR-05 | The system must detect when incoming knowledge conflicts with existing knowledge |
| FR-06 | The system must surface conflicts to humans for resolution rather than auto-resolving |
| FR-07 | Every knowledge entry must carry provenance: author, timestamp, confidence, source |
| FR-08 | Every change to the knowledge graph must be auditable with a tamper-evident trail |
| FR-09 | The system must support multiple isolated projects (teams) on shared infrastructure |
| FR-10 | Recall must return the most recent authoritative (ACTIVE) version of any entry |
| FR-11 | The system must track the history of any entry across all versions |
| FR-12 | Confidence must decay over time if knowledge is not reinforced |
| FR-13 | High-authority authors must be able to give their entries more weight |
| FR-14 | The system must be usable from Claude Code via the MCP protocol without extra tooling |

### Non-functional requirements

| ID | Requirement |
|----|------------|
| NFR-01 | Recall latency must be acceptable within a Claude Code session context window |
| NFR-02 | The audit trail must survive database restores (durable, not in-memory) |
| NFR-03 | Project isolation must be enforced at the infrastructure level, not just application level |
| NFR-04 | The system must operate without requiring engineers to install server-side components locally |
| NFR-05 | Constitutional rules must be enforced server-side and must not be bypassable by any client |
| NFR-06 | The system must degrade gracefully when Graphiti (vector search) is unavailable |

## Decision

Build **Quorum**: a governed temporal knowledge graph that satisfies all requirements above.

The system is composed of:
- **MCP Server** (`@as-quorum/mcp`) — the interface layer for Claude Code and agents
- **Gateway** (`@as-quorum/gateway`) — the authoritative backend: auth, governance enforcement, persistence
- **Graphiti** — temporal knowledge graph for semantic search and episode-based recall
- **PostgreSQL** — durable storage for versions, audit log, pending decisions
- **Redis** — cache layer for config, profiles, and admin state

The key architectural choice that differentiates Quorum from a plain vector store is
that **governance is first-class**. Conflict detection, authority weighting, human
approval, and the audit pipeline are not add-ons — they run on every write.

## Consequences

**Positive:**
- Teams can give AI agents persistent, governed memory without ceding control
- The audit trail provides compliance evidence for regulated environments
- Confidence weighting means senior engineers' ADRs are not silently overridden

**Negative:**
- Every write involves more moving parts than a direct database insert
- Human approval is a bottleneck — high-volume agent sessions produce a queue of
  DRAFTs that need review
- Teams must onboard their projects before the system is useful (one-time setup cost)

**Open questions (deferred to future ADRs):**
- Automated confidence decay rate per domain (FR-12)
- Self-evolving graph: when should the system propose its own knowledge updates (v0.4)
- PR ingestion: how to extract knowledge from code changes automatically (v0.4)
