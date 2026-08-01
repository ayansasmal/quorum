# Architecture Decision Records

This directory contains the Architecture Decision Records (ADRs) for the Quorum system.
Each ADR captures a decision that shapes how Quorum works, why it was made, and what
the consequences are. ADRs are append-only — superseded decisions are marked as such
but never deleted, mirroring the constitutional rule they often describe.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0000](0000-system-purpose-and-requirements.md) | System Purpose and Requirements | Accepted |
| [0001](0001-knowledge-lifecycle-state-machine.md) | Knowledge Lifecycle State Machine | Accepted |
| [0002](0002-constitutional-invariants.md) | Constitutional Invariants | Accepted |
| [0003](0003-governance-and-authority-model.md) | Governance and Authority Model | Accepted |
| [0004](0004-identity-roles-and-team-restrictions.md) | Identity, Roles, and Team Restrictions | Accepted |
| [0005](0005-q-star-identifier-schema.md) | q_* Identifier Schema | Accepted |
| [0006](0006-multi-project-isolation.md) | Multi-project Isolation via group_id | Accepted |
| [0007](0007-gateway-only-mcp-architecture.md) | Gateway-only MCP Architecture | Accepted |
| [0008](0008-dual-store-audit-pipeline.md) | Dual-store Audit Pipeline | Accepted |
| [0009](0009-slim-jwt-and-profile-cache.md) | Slim JWT + Profile Cache (v0.3) | Accepted |
| [0010](0010-redis-two-tier-config-cache.md) | Redis Two-tier Config and Profile Cache | Accepted |
| [0011](0011-llm-provider-strategy-openai-vs-local.md) | LLM Provider Strategy — Stay on OpenAI, Defer Local Models | Accepted |

## Format

Each ADR follows the [Michael Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) format:

- **Status** — Proposed / Accepted / Deprecated / Superseded by ADR-XXXX
- **Context** — The forces at play; why a decision was needed
- **Decision** — What was decided
- **Consequences** — What becomes easier, harder, or newly required
