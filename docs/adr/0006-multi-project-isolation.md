# ADR-0006: Multi-project Isolation

**Status:** Accepted  
**Date:** 2026-05-16  
**Deciders:** Platform team

---

## Context

**Requirement:** Multiple engineering teams must be able to share a single Quorum
infrastructure deployment without their knowledge graphs overlapping (NFR-03, FR-09).

**Requirement:** Project scope must be enforced at the infrastructure level — a
misconfigured client should not be able to access another team's knowledge
(NFR-03).

Teams using Quorum have different domains, different governance rules, different
membership, and different levels of sensitivity. An AI agent working on a payments
system must not accidentally recall constraints from an unrelated infrastructure
project, and must not be able to write to it.

## Decision

### Project identity

Each project is identified by a `group_id` — a human-readable slug set in the
project's `quorum.json` config (e.g. `'platform-team'`, `'payments-squad'`).
This maps to a `q_project_id` in the database (e.g. `q_p3`).

Projects are created when their config is first uploaded via `config_upload()`.
The `group_id` is set once and never changed (it is referenced throughout the
graph as the stable identity).

### Isolation mechanism

**Database layer:** Every table that stores project-specific data carries
`q_project_id` as a foreign key. All queries are scoped with `WHERE q_project_id = $1`.
This applies to: `knowledge_versions`, `q_keys`, `pending_decisions`,
`author_domain_stats`, `bump_log`, `audit_log`.

**Graphiti layer:** All Graphiti calls include `group_ids: [groupId]` where
`groupId` is the project's `group_id`. Graphiti enforces episode-level isolation
at the FalkorDB query layer.

**HTTP layer:** The gateway enforces isolation via two parallel mechanisms:

Primary — `X-Quorum-Project` header (standard MCP and dashboard path):
1. Client sends `X-Quorum-Project: <group_id>` with every request
2. `verify-jwt.js` resolves this to `req.user.project`
3. The pg.js middleware resolves `group_id → q_project_id` and attaches it as `req.user.qProjectId`
4. Every route uses `req.user.qProjectId` — never a caller-provided project ID

Secondary — `X-Quorum-Token` header (used by the bump endpoint's internal call path):
- `middleware/project.js` reads `X-Quorum-Token` and resolves a project from its
  embedded identity. This is a separate session token mechanism used by the
  confidence bump flow. Routes that use this path receive `req.project` instead
  of `req.user.project`. Both mechanisms enforce the same `q_project_id` scoping.

**Config layer:** Project config is stored in S3 at `<group_id>.quorum.json` (flat
bucket, no subdirectories). Redis caches it at `config:<group_id>`.

### Global namespace

`q_p0` is the reserved global project, seeded during setup. Knowledge stored
in the global namespace (`isGlobal: true` in `remember()`) is readable by all
projects but writable only by `principal_architect` role. Global entries flow
through the same DRAFT approval process — they are not auto-activated.

### Cross-project references

Cross-project references are not currently supported. An entry in project A cannot
explicitly reference an entry in project B. If a global policy applies to multiple
projects, it must be published to the global namespace.

## Consequences

**Positive:**
- A misconfigured agent writing to the wrong `X-Quorum-Project` header is scoped
  to that project's data — it cannot bleed into other projects
- The global namespace allows platform-wide constraints to be published once
  and recalled from any project
- Projects can have different governance configs (reviewer teams, role definitions,
  confidence floors) without interfering with each other

**Negative:**
- Every write requires knowing the current project — the MCP server must resolve
  the project from the `.quorum` file in the workspace before any tool call
- `getOrCreateKey()` creates the `q_keys` row in the context of the resolved
  `q_project_id` — if the wrong project is active, data is written to the wrong project
  (no cross-project integrity check at the SQL level)
- The global namespace requires a separately managed process for publishing
  platform-wide knowledge

**Required by this decision:**
- Every MCP tool must resolve `ctx.projectId` from the `.quorum` file before
  calling any gateway endpoint
- Gateway routes must never trust a caller-provided `project_id` from the request
  body — always use `req.user.qProjectId`
- The `.quorum` file (containing `project_id` and `group_id`) must be committed
  to the repository root and treated as the project's registration artifact
