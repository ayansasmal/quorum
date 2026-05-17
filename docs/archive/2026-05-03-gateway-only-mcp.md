# Plan: Gateway-Only MCP + OpenAPI Spec

**Date:** 2026-05-03  
**Branch:** (current worktree)  
**Goal:** Remove direct PostgreSQL access from `@as-quorum/mcp`. The MCP always talks to the gateway over HTTP. Add an OpenAPI 3.1 spec for the gateway. Add per-package CLAUDE.md files.

---

## Background

After the monorepo restructure (`mcp/`, `gateway/`, `dashboard/`), the MCP still imports `pg` directly and creates a `pg.Pool` for direct-mode operation. The agreed architecture is:

- **Engineers** install `@as-quorum/mcp` from npm + connect to their team's central Quorum gateway.
- **Local default** `QUORUM_GATEWAY_URL` = `http://localhost:3001` (dev stack via Docker Compose).
- **No direct pg path in MCP** — all persistence goes through the gateway's `/pg/*` REST API.

The `GatewayClient` in `mcp/src/gateway/client.js` already implements typed methods matching every function in `graph/queries.js` and `audit/secondary.js`. The gateway's `routes/pg.js` already handles all these routes.

Duck-typing pattern: each query function checks `typeof pg.methodName === 'function'` first. If true, delegate to the typed GatewayClient method. The `pg` parameter name is kept in signatures for backward compatibility (gateway's own code still passes a real pg.Pool to these functions via the `@as-quorum/mcp` workspace import).

---

## Tasks

### Task 1 — Duck-type `mcp/src/graph/queries.js`

**File:** `mcp/src/graph/queries.js`

Add a GatewayClient fast-path to the top of each exported function. The check is `typeof pg.methodName === 'function'`. When true, delegate and return immediately. The raw SQL path below is unchanged — it still runs when the gateway calls these functions with a real `pg.Pool`.

Functions to update and their GatewayClient counterparts:

| Function | GatewayClient method | Signature difference |
|---|---|---|
| `getCurrentVersion(pg, topic, key, projectId)` | `pg.getCurrentVersion(topic, key)` | projectId dropped — gateway injects from JWT |
| `getVersionAtDate(pg, topic, key, date, projectId)` | `pg.getVersionAtDate(topic, key, date)` | |
| `getVersionHistory(pg, topic, key, projectId)` | `pg.getVersionHistory(topic, key)` | |
| `getNextVersionNumber(pg, topic, key, projectId)` | `pg.getNextVersionNumber(topic, key)` | |
| `getSpecificVersion(pg, topic, key, version, projectId)` | `pg.getSpecificVersion(topic, key, version)` | |
| `insertVersion(pg, record)` | `pg.insertVersion(record)` | |
| `getVersionsByTag(pg, tag, projectId)` | `pg.getVersionsByTag(tag)` | |
| `transitionVersionStatus(pg, topic, key, version, newStatus, forwardLink, projectId)` | `pg.transitionVersionStatus(topic, key, version, newStatus, forwardLink)` | |
| `insertVersionAuditLink(pg, record)` | `pg.insertVersionAuditLink(record)` | |
| `getLatestDraftVersion(pg, topic, key, projectId)` | — not on GatewayClient; falls through to SQL | skip |
| `getVersionsByStatus(pg, status, opts)` | — not on GatewayClient | skip |
| `getVersionStatusCounts(pg, opts)` | — not on GatewayClient | skip |
| `getPendingDecisions(pg, opts)` | `pg.getPendingDecisions(opts)` | |
| `getDraftVersions(pg, opts)` | — not on GatewayClient | skip |
| `markPendingDecisionStale(pg, conflictId, staleWarning, currentVersion)` | — not on GatewayClient | skip |
| `countPendingForKey(pg, topic, key, projectId)` | `pg.countPendingForKey(topic, key)` | |
| `getPendingDecisionById(pg, conflictId)` | — not on GatewayClient | skip |
| `insertPendingDecision(pg, record)` | `pg.insertPendingDecision(record)` | |
| `resolvePendingDecision(pg, conflictId, updates)` | `pg.updatePendingDecision(conflictId, updates)` | method renamed on client |
| `updateConfidence(pg, id, newConfidence)` | — not on GatewayClient | skip |
| `updateLastAccessed(pg, topic, key, projectId)` | — not on GatewayClient | skip |
| `getDecayEligibleVersions(pg, projectId, batchSize)` | — not on GatewayClient | skip |
| `getLastBump(pg, author, topic, key, projectId)` | — not on GatewayClient | skip |
| `insertBump(pg, record)` | — not on GatewayClient | skip |
| `incrementDomainStat(pg, opts)` | — not on GatewayClient | skip |
| `getDomainStats(pg, opts)` | — not on GatewayClient | skip |

For functions without a GatewayClient method, leave them unchanged (they will throw naturally if a GatewayClient is passed since GatewayClient.query() throws intentionally — the MCP won't call these from the gateway-mode path anyway).

**Example pattern to apply:**
```js
export async function getCurrentVersion(pg, topic, key, projectId = 'default') {
  if (typeof pg.getCurrentVersion === 'function') return pg.getCurrentVersion(topic, key)
  const result = await pg.query(...)
  return result.rows[0] ?? null
}
```

**Verification:** `npm test` passes (existing test mocks already implement typed methods, so they naturally exercise the GatewayClient branch).

**Commit:** `refactor(mcp): duck-type graph/queries.js for GatewayClient`

---

### Task 2 — Duck-type `mcp/src/audit/secondary.js`

**File:** `mcp/src/audit/secondary.js`

The five exported async functions need GatewayClient fast-paths. `updateEntry` and `deleteEntry` are constitutional stubs — do not touch them.

| Function | GatewayClient method |
|---|---|
| `writeAuditEntry(pg, entry)` | `pg.writeAuditEntry(entry)` |
| `getAuditEntry(pg, entryId)` | `pg.getAuditEntry(entryId)` |
| `getAllEntries(pg, options)` | `pg.getAllEntries(options)` |
| `countEntries(pg, projectId)` | `pg.countEntries()` |
| `exportEntries(pg, options)` | delegates to `getAllEntries` — handled automatically |

**Important:** `writeAuditEntry` currently acquires a pg transaction with `pg.connect()`. The duck-type guard must come before `pg.connect()` so the GatewayClient path never tries to acquire a pg connection.

**Example:**
```js
export async function writeAuditEntry(pg, entry) {
  if (typeof pg.writeAuditEntry === 'function') return pg.writeAuditEntry(entry)
  const client = await pg.connect()
  // ... existing transaction code unchanged
}
```

**Verification:** `npm test` passes.

**Commit:** `refactor(mcp): duck-type audit/secondary.js for GatewayClient`

---

### Task 3 — Remove direct pg from `mcp/src/server.js`

**File:** `mcp/src/server.js`

Changes:

1. **Remove** `import pg from 'pg'` (line 25)

2. **Replace the pool block** (lines 46-73) with:
   ```js
   // ── Gateway URL default ────────────────────────────────────────────────────────
   // MCP always communicates with the gateway. Default to localhost for local dev.
   // Enterprise teams set QUORUM_GATEWAY_URL to their central Quorum instance.
   process.env.QUORUM_GATEWAY_URL ??= 'http://localhost:3001'
   console.error(`[Quorum] Gateway: ${process.env.QUORUM_GATEWAY_URL}`)
   const hasToken = !!(process.env.QUORUM_GITHUB_TOKEN)
   if (!hasToken) {
     console.error('[Quorum] ℹ  No token at startup — call authenticate() to log in via GitHub OAuth')
   }
   ```

3. **Fix startup chain verification** (lines 164-180) — replace `getAllEntries(pool)` with gateway-aware call:
   ```js
   const gw = getGatewayClient()
   const entries = gw
     ? await gw.getAllEntries({}).catch(() => [])
     : []
   ```

4. **Fix `verifyStoreSync`** (lines 149-158) — already gateway-aware (uses `gw.countEntries()`), just remove the `pool` fallback path:
   ```js
   async function verifyStoreSync() {
     const gw = getGatewayClient()
     if (!gw) return  // not authenticated yet — skip
     const count = await gw.countEntries().catch(() => -1)
     if (count === -1) console.error('[Quorum] WARNING: Could not reach audit store via gateway')
   }
   ```

5. **Fix `loadConfig` call** (line 190) — pass `null` (DB snapshot fallback is gateway-side, not MCP-side):
   ```js
   const config = await loadConfig(null)
   ```

6. **Fix health endpoint** (lines 234-248) — replace `pool.query('SELECT 1')` with gateway ping:
   ```js
   const [graphConnected, auditConnected] = await Promise.all([
     pingGraphiti(),
     getGatewayClient()?.ping().then(() => true).catch(() => false) ?? false,
   ])
   ```

7. **Fix shutdown** (lines 258-264) — remove `pool.end()`:
   ```js
   async function shutdown() {
     console.error('[Quorum] Shutting down...')
     stopConfigPoller()
     process.exit(0)
   }
   ```

8. **Update JSDoc** at the top: replace "1. Connect PostgreSQL pool" with "1. Set QUORUM_GATEWAY_URL default (http://localhost:3001)".

**Verification:** Server starts without error. `npm test` passes.

**Commit:** `refactor(mcp): remove direct PostgreSQL pool — always use gateway`

---

### Task 4 — Remove `pg` from `mcp/package.json`

**File:** `mcp/package.json`

Remove `"pg": "8.20.0"` from `dependencies`.

Verify no remaining `pg` imports in `mcp/src/`:
```bash
grep -rn "from 'pg'" mcp/src/
```
Expected: no output.

Run `npm install` from repo root to update `package-lock.json`.

**Commit:** `chore(mcp): remove pg dependency — gateway-only mode`

---

### Task 5 — Create `gateway/openapi.yaml`

**File:** `gateway/openapi.yaml`

Write an OpenAPI 3.1 YAML spec covering all gateway routes. Use the existing route files as source of truth.

**Routes to document** (from `gateway/src/routes/`):

**Auth** (`routes/auth.js`):
- `GET /auth/login` — redirect to GitHub OAuth
- `GET /auth/callback` — GitHub OAuth callback → JWT + refresh token
- `GET /auth/me` — current user info (JWT required)
- `GET /auth/projects` — list accessible projects (JWT required)
- `POST /auth/switch` — switch active project (JWT required)
- `POST /auth/refresh` — exchange refresh token for new JWT
- `POST /auth/logout` — revoke refresh token

**Config** (`routes/config.js`):
- `GET /config` — get project config (JWT required)
- `PUT /config` — update project config (JWT required, principal_architect only)

**Schema** (`routes/schema.js`):
- `GET /schema/config` — public JSON Schema for quorum config files

**JWKS** (`routes/jwks.js`):
- `GET /.well-known/jwks.json` — public JWKS endpoint

**Graphiti proxy** (`routes/graphiti.js`):
- `POST /graphiti/*` — proxy to Graphiti MCP (JWT required, group_id injected)

**PostgreSQL API** (`routes/pg.js`):
- `GET /pg/versions/current` — current active version for topic:key
- `GET /pg/versions/history` — version history for topic:key
- `GET /pg/versions/at-date` — version active at a given date
- `GET /pg/versions/next-number` — next version number
- `GET /pg/versions/specific` — specific version by number
- `POST /pg/versions` — insert new version record
- `PATCH /pg/versions/status` — transition version status
- `GET /pg/versions/by-tag` — versions matching a tag
- `POST /pg/audit-links` — insert version↔audit cross-reference
- `POST /pg/audit` — write audit entry
- `GET /pg/audit/:entryId` — get audit entry by ID
- `GET /pg/audit` — list audit entries (filterable)
- `GET /pg/audit/count` — count audit entries
- `GET /pg/pending` — list pending decisions
- `POST /pg/pending` — insert pending decision
- `PATCH /pg/pending/:conflictId` — resolve/update pending decision
- `GET /pg/pending/count` — count pending for topic:key

**Sync** (`routes/sync.js`):
- `POST /sync/configs` — S3→DDB full config sync (sync token or principal_architect JWT)

**Health:**
- `GET /health` — gateway health status

**Security schemes:**
- `BearerAuth`: ES256 JWT in `Authorization: Bearer <token>` header

**Commit:** `docs(gateway): add OpenAPI 3.1 spec`

---

### Task 6 — Add per-package CLAUDE.md files

**Files to create:** `mcp/CLAUDE.md`, `gateway/CLAUDE.md`, `dashboard/CLAUDE.md`

Each file is a concise context document for Claude Code sessions that open the package directory directly. They should cover: package purpose, key files, dev commands, important constraints.

See the content specs in the "CLAUDE.md Content" section below.

**Commit:** `docs: add per-package CLAUDE.md files`

---

## CLAUDE.md Content

### `mcp/CLAUDE.md`

Content: `@as-quorum/mcp` — published npm package. Purpose, key files (server.js, tools/, governance/, gateway/client.js), build commands (`npm run build:all`), key constraints (no direct pg, always gateway-mode, never call pg.query in new code), skill install path.

### `gateway/CLAUDE.md`

Content: `@as-quorum/gateway` — private self-hosted server. Purpose, key files (server.js, routes/, middleware/), dev commands (`npm run dev`), env vars summary, note that it imports from `@as-quorum/mcp` workspace for shared schema/queries/constitutional.

### `dashboard/CLAUDE.md`

Content: React dashboard for Quorum. Purpose, key pages, dev commands, auth flow (GitHub OAuth → JWT → BFF), API clients in `src/api/`.

---

## Verification Checklist

- [ ] `npm test` passes from repo root
- [ ] `grep -rn "from 'pg'" mcp/src/` returns no output
- [ ] `npm run build:all --workspace=mcp` succeeds
- [ ] `npm run skill:install` reinstalls updated skill
