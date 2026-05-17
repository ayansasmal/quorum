# ADR-0007: Gateway-only MCP Architecture

**Status:** Accepted  
**Date:** 2026-05-16  
**Deciders:** Platform team

---

## Context

**Requirement:** The system must be usable from Claude Code without engineers
installing server-side components locally (NFR-04).

**Requirement:** Constitutional rules must be enforced server-side and must not be
bypassable by any client (NFR-05).

**Requirement:** Project isolation must be enforced at the infrastructure level (NFR-03).

In v0.1, the MCP server connected directly to PostgreSQL and Graphiti. This worked
locally but created several problems in team deployments:

1. **Local infra dependency** — every engineer needed to run PostgreSQL, FalkorDB,
   and Graphiti locally (Docker Compose), even for read-only queries
2. **No enforcement boundary** — constitutional rules were enforced in the MCP
   process, which ran on the engineer's machine. A modified MCP client could
   bypass them
3. **No multi-tenancy** — direct DB access meant the project isolation had to be
   enforced entirely by application code, with no network-level boundary
4. **No shared context** — each engineer's local DB was their own island; team
   knowledge was not shared

## Decision

**The MCP server never connects to PostgreSQL or Graphiti directly.** All operations
go through the Quorum Gateway over HTTP.

```
Claude Code
    │
    │ stdio (MCP protocol)
    ▼
MCP Server (@as-quorum/mcp)
    │
    │ HTTP (all operations)
    ▼
Quorum Gateway (http://localhost:3001 or central deployment)
    │         │         │
    ▼         ▼         ▼
PostgreSQL  Graphiti  Redis / S3
```

### MCP responsibilities

- Parse and validate tool inputs (Zod schemas)
- Resolve identity from JWT / env / git
- Enforce constitutional rules that can be checked without DB (reason required,
  no self-approval by identity alone)
- Call the GatewayClient for all storage and retrieval operations
- Format responses for Claude Code

### Gateway responsibilities

- Authenticate every request (ES256 JWT verification)
- Enforce project isolation (`X-Quorum-Project` → `q_project_id`)
- Resolve `(topic, key)` → `q_key_id` (the only place this translation happens)
- Enforce constitutional rules that require DB state (legal status transitions,
  duplicate detection)
- Proxy Graphiti calls with `group_id` injection
- Run the audit pipeline (pre/post entries, version_audit_links)

### GatewayClient

The MCP server uses a `GatewayClient` class (`src/gateway/client.js`) that wraps
all HTTP calls. Each method corresponds to one gateway endpoint:

```js
client.getCurrentVersion(topic, key)     // GET /pg/versions/:topic/:key
client.insertVersion(record)             // POST /pg/versions
client.atomicSupersede(...)              // POST /pg/versions/supersede
client.transitionVersionStatus(...)      // PATCH /pg/versions/:topic/:key/:version
```

The `pg` parameter accepted by `queries.js` functions is always a `GatewayClient`
instance in production. There are no direct PostgreSQL connections from the MCP process.

### Shared module pattern

Both the MCP and the gateway share function signatures for `queries.js`, `secondary.js`,
and `constitutional.js`. The gateway vendors these as `src/shared/` copies. The MCP
`queries.js` functions are thin delegates to the GatewayClient; the gateway's vendored
copies contain the actual SQL.

**This means the two `queries.js` files have divergent implementations** and must
not be blindly synced. The MCP version contains no SQL; the gateway version contains
SQL and no GatewayClient calls.

## Consequences

**Positive:**
- Engineers install only `@as-quorum/mcp` — no local infra required
- Constitutional enforcement cannot be bypassed by modifying the MCP client;
  the gateway re-enforces everything server-side
- A central team deployment serves all engineers' Claude Code sessions simultaneously
- Graphiti `group_id` injection happens at the gateway — the MCP never needs to
  know the internal FalkorDB scoping mechanism

**Negative:**
- All MCP operations require network connectivity to the gateway — offline use
  is not supported
- Latency: every tool call is at minimum one HTTP roundtrip; `remember()` is
  several (version check, conflict detection, insert, audit)
- The `queries.js` dual-file pattern creates a sync maintenance burden;
  function signature changes must be made in both files (with different implementations)

**Required by this decision:**
- MCP `src/graph/queries.js` must contain no SQL — only GatewayClient delegates
- Gateway `src/shared/graph/queries.js` must contain SQL — no GatewayClient calls
- `GatewayClient.query()` must throw unconditionally to prevent accidental
  direct SQL execution from the MCP layer
- Any new MCP tool must accept `pg` (a GatewayClient) and `ctx` (with `projectId`)
  and must pass `projectId` to all gateway calls
