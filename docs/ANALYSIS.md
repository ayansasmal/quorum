# Quorum — System Analysis & Data Flow Reference

> Generated: 2026-05-15
> Scope: Full end-to-end data flow — Skills → MCP → Gateway → PostgreSQL + Graphiti + FalkorDB + DynamoDB + Redis
> Purpose: Architectural reference, gap register, and prioritised fix backlog

---

## Table of Contents

1. [Component Map](#1-component-map)
2. [Full Request Flows](#2-full-request-flows)
3. [Identity & Authorization Chain](#3-identity--authorization-chain)
4. [Dual-Store Architecture](#4-dual-store-architecture)
5. [Caching Layers](#5-caching-layers)
6. [Constitutional Enforcement Points](#6-constitutional-enforcement-points)
7. [Known Gaps & Latent Issues](#7-known-gaps--latent-issues)
8. [Essential Files Reference](#8-essential-files-reference)

---

## 1. Component Map

### Skill (`quorum-mcp/skill/SKILL.md`)
- **Owns:** Behavioural contract for Claude Code agents — how and when to use each tool
- **Reads:** Nothing directly; instructions consumed by the LLM at session start
- **Writes:** Nothing directly; drives tool invocations
- **Failure mode:** If missing or ignored, agents skip `pending()` at session start, miss conflict briefs, and write without checking existing knowledge

### MCP Server (`quorum-mcp/src/server.js`)
- **Owns:** stdio transport, tool registration, identity-in-closure, health endpoint (:8000), project context resolution via `.quorum` file
- **Reads:** `.quorum` file (MCP roots → PWD → env fallback), `QUORUM_GATEWAY_URL`, `_runtimeToken` in-memory, Graphiti session ID (`_sessionId`)
- **Writes:** Nothing persistent — all writes delegated to gateway
- **Failure mode:** If down, Claude Code gets no tools. Identity is captured at startup — MCP restart loses the token; `authenticate()` must be called again

### GatewayClient (`quorum-mcp/src/gateway/client.js`)
- **Owns:** Module-level JWT singleton (`_runtimeToken`), HTTP client singleton (`_client`), project ID per-call via `setProjectId()`
- **Reads:** JWT payload (client-side decode only), `_projectId` field, `QUORUM_GATEWAY_URL`
- **Writes:** `_runtimeToken` via `setGatewayToken()` (authenticate flow only)
- **Failure mode:** If gateway unreachable, all typed endpoints throw. Token expiry within 60s of `exp` triggers a pre-emptive null, forcing re-auth

### Gateway HTTP (`gateway/src/server.js`)
- **Owns:** Express app, `pg.Pool` (singleton, max:20), route mounting, ES256 key loading, Redis pub/sub subscriber, startup DDB sync
- **Reads:** All environment variables, ES256 keys from `keys.js`
- **Writes:** Nothing directly — delegates to PostgreSQL, S3, DDB, Redis
- **Failure mode:** Single point of failure for all MCP tool calls. PostgreSQL failure at startup triggers `process.exit(1)`. Graphiti/Redis/S3 failures allow degraded start — JWT verification still works

### PostgreSQL
- **Owns:** `knowledge_versions`, `audit_log`, `version_audit_links`, `pending_decisions`, `bump_log`, `author_domain_stats`
- **Reads:** All query functions in `queries.js` and `secondary.js`
- **Writes:** Every `remember()`, `recall()` (audit pipeline), `search()` (audit), `review()`, conflict resolution, confidence bump
- **Failure mode:** Total loss of governance history, audit chain, version tracking, and pending decisions. Gateway refuses to start

### Graphiti / FalkorDB
- **Owns:** Semantic knowledge graph — episodes, entity nodes, entity relationships, SUPERSEDES edges
- **Reads:** `searchNodes()`, `searchFacts()`, `getEpisodes()`, `getEvolutionChain()`
- **Writes:** `addEpisode()`, `addSupersedingEpisode()`, `deleteEpisodeSoft()` (soft only — adds a DEPRECATED marker episode)
- **Failure mode:** Semantic search falls back to PostgreSQL ILIKE. New writes during downtime use `PENDING_CONFLICT_CHECK` status. FalkorDB volume wipe means episode UUIDs in `knowledge_versions.graphiti_episode_id` become stale — but content is preserved in the PostgreSQL `summary` column

### DynamoDB (LocalStack in dev)
- **Owns:** `quorum-user-projects` table — permanent membership index (PK: `github_username`, SK: `project_id`; GSI: `ProjectMembersIndex`)
- **Reads:** `getUserProjects()` — called by profile cache cold path during every JWT verification
- **Writes:** `syncProjectMembers()` on config sync, `updateMemberRecord()` on role/ownership changes
- **Failure mode:** `getUserProjects()` catches all errors and returns `[]` (`ddb.js` line 74). The profile cache stores an empty projects array — `req.user.role` and `req.user.is_owner` become `null`/`false` silently for up to 5 minutes

### Redis
- **Owns:** Three cache namespaces: `config:{group_id}`, `profile:{username}`, `admin:platform`
- **Reads:** All cache hot paths in `loadProjectConfig()`, `loadUserProfile()`, `loadAdminConfig()`
- **Writes:** Set on every cold-path miss; pub/sub `quorum:invalidate` channel for multi-instance eviction
- **Failure mode:** Falls through to S3 (config) or DDB (profile) — correct but slow. If Redis and DDB are both down, profile loads empty (same as DDB failure)

---

## 2. Full Request Flows

### a) `remember()` — engineer stores new knowledge

```
Skill instructs Claude → remember(topic, key, content, reason, ...)
  ↓
MCP registerTools() closure fires
  ↓ resolveCtx()           — reads .quorum → { projectId (normalised _), gatewayUrl }
  ↓ isAuthenticated()      — checks _runtimeToken expiry
  ↓ getGatewayClient()     — returns/creates GatewayClient singleton
  ↓ activePool.setProjectId(ctx.projectId)
  ↓ remember.handler(activePool, input, identity, ctx)

    [remember.js]
    ↓ resolveAuthorConfidence(rawConfidence, identity)   — applies role floor
    ↓ normalizeTags(input.tags)
    ↓ withAuditPipeline(pg, { tool:'remember', author, ... }, callback)

      ↓ getCurrentVersion(pg, topic, key, projectId)
          → GET /pg/versions/{topic}/{key}  +  X-Quorum-Project header
          → Gateway: verifyJwt() → loadUserProfile() → Redis / DDB
          → SQL: SELECT * FROM knowledge_versions WHERE project_id=? AND status='ACTIVE'

      IF existing version (supersede path):
        ↓ enforceReasonRequired(input.reason)       — throws if <10 chars or placeholder
        ↓ detectConflict(content, topic, key, ...)
            → POST /governance/detect-conflict → Gateway → OpenAI LLM
        IF graphiti_unavailable:
          → storePendingConflictCheck()              — status: PENDING_CONFLICT_CHECK
          → POST /pg/versions → INSERT knowledge_versions
        IF conflict AND human_required:
          ↓ generateEnrichment()                     → POST /governance/enrich → LLM
          ↓ insertPendingDecision()                  → POST /pg/pending → INSERT pending_decisions
          ↓ fireWebhookAsync()                       — async, swallows errors
          → Returns conflict_detected + conflict_id
        ELSE (auto_supersede or no conflict):
          ↓ addSupersedingEpisode(content, oldId, metadata, projectId)
              → POST /graphiti/mcp (gateway proxy injects sanitised group_id)
              → Graphiti add_memory → FalkorDB stores episode + SUPERSEDES edge text
              → Returns locally generated UUID (not real Graphiti UUID — see Gap #4)
          ↓ insertVersion()        → POST /pg/versions → INSERT knowledge_versions (ACTIVE)
          ↓ transitionVersionStatus(old → SUPERSEDED)
          ↓ incrementDomainStat(superseded_count)    — fire-and-forget

      IF no existing version (first write):
        ↓ storeFirst()
          Status = DRAFT  if: author==='claude' OR author==='anonymous' OR triggeredBy===REFLECT
          Status = ACTIVE otherwise
          ↓ addEpisode(content, metadata, projectId) → Graphiti add_memory → FalkorDB
          ↓ insertVersion() → INSERT knowledge_versions

    [withAuditPipeline completes]
    ↓ writeAuditEntry()   → POST /pg/audit
        → pg.connect() → BEGIN TRANSACTION
        → nextChainPosition()      — SELECT MAX(chain_position)+1 with row lock
        → buildEntryWithHash()     — SHA256 over normalised fields
        → INSERT INTO audit_log
        → COMMIT
```

**Data written:** `knowledge_versions` (new row), `audit_log` (new row), optionally `pending_decisions`, `author_domain_stats`. FalkorDB gets a new episode/node.

---

### b) `recall()` — retrieve by topic + key

```
recall.handler(pg, input, identity, ctx)
  ↓ withAuditPipeline wraps
  ↓ getCurrentVersion(pg, topic, key, projectId)
      → GET /pg/versions/{topic}/{key}  +  X-Quorum-Project
      → verifyJwt → loadUserProfile (Redis / DDB)
      → SQL: SELECT * FROM knowledge_versions WHERE project_id=? AND topic=? AND key=? AND status='ACTIVE'
  IF not found AND projectId !== 'global':
    ↓ getCurrentVersion(pg, topic, key, 'global')   — GAP-27 global fallback
  ↓ incrementDomainStat(recalled_count)              — fire-and-forget
  ↓ formatVersion()                                  — returns XML with <quorum_memory> tags
  ↓ writeAuditEntry()
```

**Data written:** `audit_log` only. PostgreSQL is the sole data source — no Graphiti call.

---

### c) `search()` — semantic search

```
search.handler(pg, input, identity, ctx)
  ↓ withAuditPipeline wraps
  ↓ Parallel Promise.allSettled:
    [1] searchNodes(query, { limit: limit*2, groupId: projectId })
          → POST /graphiti/mcp { name:'search_nodes', max_nodes:20 }
          → Gateway verifyJwt → body.params.group_id = sanitisedProject (unconditional)
          → Graphiti: FalkorDB vector similarity + BM25 hybrid
          ⚠️  group_ids NOT sent — search is global, not project-scoped (see Gap #2)
    [2] searchFacts(query, { groupId: projectId })
          → POST /graphiti/mcp { name:'search_memory_facts' }
          ⚠️  same global-search issue
    [3] searchNodes(query, 'global')    — if projectId !== 'global' (GAP-27)

  ↓ Merge + deduplicate by episode UUID (project wins over global on tie)
  ↓ Filter DRAFT / DEPRECATED / REJECTED
  ↓ Apply domain filter
  ↓ Sort: score DESC, project-local first on tie

  IF results.length === 0:
    ↓ pg.query() ILIKE fallback
        ⚠️  In MCP context: pg is GatewayClient → query() throws (see Gap #1)
        ✓  In gateway BFF context (/api/search): pg is real pg.Pool → works correctly

  ↓ writeAuditEntry()
```

**Data written:** `audit_log` only.

---

### d) `reflect()` — post-session knowledge extraction

```
reflect.handler(pg, input, identity, ctx)
  ↓ withAuditPipeline wraps  (author: 'claude')
  ↓ extractKnowledge(taskSummary, decisions, patterns, gw)
      → POST /governance/extract
      → Gateway → OpenAI LLM call
      → Returns { items: [{ topic, key, content, entity_type, confidence, mode }] }
  ↓ For each item:
    isDuplicateReflect(pg, topic, key, contentHash)
        → GET /pg/versions/{topic}/{key}/history → check for matching DRAFT content_hash
    IF not duplicate:
      ↓ rememberHandler(pg, { ...item, triggered_by: TriggeredBy.REFLECT }, identity, ctx)
          → Full remember() flow — status forced DRAFT (triggered_by === REFLECT)
```

**Data written:** Multiple `knowledge_versions` rows (all DRAFT), multiple `audit_log` rows, optionally `pending_decisions`. FalkorDB episodes per item.

---

### e) `pending()` — surface conflicts and drafts

```
pending.handler(pg, input, identity, ctx)
  ↓ withAuditPipeline wraps
  ↓ Parallel:
    fetchConflictBriefs(pg, input, projectId)
      → getPendingDecisions()
          → SELECT * FROM pending_decisions WHERE project_id=? AND status='pending'
      FOR EACH row:
        getCurrentVersion(pg, topic, key, projectId)     — stale detection
        IF currentVersion.version > active_version_at_creation:
          markPendingDecisionStale()
      Returns enriched conflict brief objects

    fetchDraftReviews(pg, input, projectId)
      → getDraftVersions()
          → SELECT * FROM knowledge_versions WHERE status='DRAFT'
      + loads domain config from in-memory getConfig()

  ↓ writeAuditEntry()
```

**Data written:** `audit_log`, optionally `pending_decisions` status updates.

---

### f) `authenticate()` — GitHub OAuth → JWT

```
authenticate.handler()
  ↓ discoverMetadata(gatewayUrl)
      → GET /.well-known/oauth-authorization-server
      → { authorization_endpoint, token_endpoint, registration_endpoint }
  ↓ startCallbackServer()   — Node.js HTTP on random port (listen(0))
  ↓ registerClient(regEndpoint, redirectUri)
      → POST /oauth/register → returns client_id
  ↓ generatePKCE()          — randomBytes(32) → base64url verifier + SHA256 challenge
  ↓ openBrowser(authorizeUrl)   — spawnSync 'open' / 'xdg-open'
  ↓ Await codePromise (5-min timeout)
      Engineer authenticates GitHub in browser
      Gateway /oauth/callback:
        → Validates GitHub OAuth code
        → Issues auth_code for MCP
        → Redirects to localhost:{port}/callback?code=...&state=...
  ↓ exchangeCode(tokenEndpoint, clientId, code, redirectUri, verifier)
      → POST /oauth/token { grant_type, code, redirect_uri, client_id, code_verifier }
      → Gateway verifies PKCE S256
      → Issues ES256 slim JWT: { sub, is_admin, jti, exp, iat }  (NO project, role, or team)
  ↓ setGatewayToken(accessToken)   — stored in _runtimeToken module-level variable
  ↓ gw.verifyAuth()                — client-side JWT decode (no network)
  → Returns { status:'authenticated', user, is_admin, expires_in }
```

**Data written:** None — JWT is in-memory only.

---

## 3. Identity & Authorization Chain

### Identity Resolution Path

**MCP side:**
1. `resolveIdentity()` runs at startup — tries gateway JWT decode, falls back to `git config user.email`
2. Identity is captured once in `registerTools()` closure — stale for lifetime of process
3. Every tool call checks `isAuthenticated()` against `_runtimeToken` expiry
4. `author = identity?.name ?? 'anonymous'` — the `sub` claim from JWT

**Gateway side (every request):**
1. `verifyJwt` extracts `Bearer <token>` → `jwtVerify(token, publicKey, { algorithms:['ES256'] })`
2. Reads `X-Quorum-Project` header → `req.user.project`
3. `loadUserProfile(sub)` → Redis `profile:{sub}` → DDB `quorum-user-projects` on miss
4. Looks up project entry in profile → resolves `role`, `base_confidence`, `is_owner`
5. Sets `req.user = { sub, is_admin, project, role, base_confidence, is_owner }`

### Project Scoping — Layer by Layer

| Layer | File | Mechanism |
|-------|------|-----------|
| MCP `resolveCtx()` | `server.js` | Reads `project_id` from `.quorum`; normalises `-` → `_` |
| MCP tool dispatch | `server.js` | `activePool.setProjectId(ctx.projectId)` before every handler |
| GatewayClient `_request()` | `gateway/client.js` | Adds `X-Quorum-Project: {projectId}` header to every HTTP call |
| Gateway `verify-jwt.js` | `middleware/verify-jwt.js` | Sets `req.user.project` from header; loads role from profile cache |
| Gateway Graphiti proxy | `routes/graphiti.js` | Unconditionally overwrites `group_id` with `req.user.project.replace(/-/g,'_')` |
| Gateway `/pg/*` routes | `routes/pg.js` | Reject 400 if `req.user.project` is null |

### Write Permission Matrix

| Identity | First write | Supersede | Approve DRAFT | Admin |
|----------|-------------|-----------|---------------|-------|
| `claude` / `anonymous` | DRAFT only | DRAFT only | ✗ | ✗ |
| `junior` | ACTIVE | Yes (reason required) | ✗ | ✗ |
| `engineer` | ACTIVE | Yes | ✗ | ✗ |
| `senior_engineer` | ACTIVE | Yes | ✓ via `review()` | ✗ |
| `principal_architect` | ACTIVE (global ns) | Yes | ✓ | ✗ |
| `is_admin: true` | ACTIVE | Yes | ✓ | ✓ via `/admin/*` |

---

## 4. Dual-Store Architecture

### What Lives Where

| Data | PostgreSQL | Graphiti / FalkorDB |
|------|-----------|---------------------|
| Version records | `knowledge_versions` — canonical source of truth | Episode nodes — semantic search index |
| Content (durable) | `summary` column — **always written, survives wipe** | `episode_body` — ephemeral, can be wiped |
| Audit chain | `audit_log` — append-only, SHA256 tamper-evident | Audit episodes in `quorum-audit` group |
| Pending conflicts | `pending_decisions` | Not stored |
| Version status transitions | Status column + `supersedes_version` FK | SUPERSEDES edges as text `[supersedes:{id}]` |
| Author, confidence, tags | Columns in `knowledge_versions` | Episode metadata fields |
| Project membership | Not here (in DDB) | Not stored |
| Project config | Not here (in S3 / Redis) | Not stored |

### Why Both Are Needed

**PostgreSQL** is the governance record. It enforces project isolation, status transitions, audit chain integrity, version history, and conflict tracking. No governance is possible without it.

**Graphiti/FalkorDB** provides semantic search — vector similarity, BM25 hybrid, and temporal graph traversal (SUPERSEDES chain). Without it, search degrades to PostgreSQL ILIKE — keyword-only, no semantic similarity, slow on large knowledge bases.

### FalkorDB Wipe Recovery Path

1. FalkorDB wiped → `knowledge_versions.graphiti_episode_id` values are stale (they were local UUIDs anyway — see Gap #4)
2. `summary` column in PostgreSQL holds the durable content — zero data loss
3. `search()` falls back to PostgreSQL ILIKE automatically while FalkorDB is empty
4. Re-ingest using `scripts/reingest-to-graphiti.js` — reads ACTIVE rows, calls `addEpisode()` per row
5. Entries with empty `summary` get a metadata-only body: `{topic}:{key}\nTags: {tags}` — searchable by name but not by semantic content

---

## 5. Caching Layers

### Redis Cache Map

| Key | Source | TTL | Invalidation trigger | Risk on stale data |
|-----|--------|-----|----------------------|--------------------|
| `config:{group_id}` | S3 `{group_id}.quorum.json` | `QUORUM_CONFIG_CACHE_TTL` (300s) | `invalidateProject()` on config write/sync | Wrong conflict thresholds, wrong role base_confidence, wrong domain overrides |
| `profile:{username}` | DDB `quorum-user-projects` | `QUORUM_PROFILE_CACHE_TTL` (300s) | `invalidateProfile()` on role/owner update | Wrong `req.user.role`, wrong `req.user.is_owner` for up to 5 min after role change |
| `admin:platform` | S3 `configs/.quorum` | `QUORUM_ADMIN_CACHE_TTL` (300s) | `saveAdminConfig()` on admin write | Wrong `is_admin` on token issuance |

### Cache Miss Path

```
loadUserProfile(username)
  ↓ getRedis().get('profile:{username}')
  IF miss:
    ↓ getUserProjects(username)   — DDB GetItem
    ↓ getRedis().setex('profile:{username}', TTL, JSON.stringify(result))
  RETURN profile
```

### Pub/Sub Invalidation

`startInvalidationSubscriber()` (`redis.js` line 69) subscribes to `quorum:invalidate`. The subscriber callback currently only **logs** the key — the actual DEL is done by the write path before publishing. The subscriber is informational only — it does not re-fetch or warm the cache. Correct for single-instance deployment. For multi-instance, each instance receiving the message needs to also DEL its cached copy (the write-path DEL only affects the writing instance).

### Two Redis Connections

A dedicated subscriber connection (`subscriberClient`) is separate from the command client (`commandClient`) — ioredis blocks a connection in `SUBSCRIBE` mode. Both are lazy-initialised.

---

## 6. Constitutional Enforcement Points

### Rule 1 — No Hard Delete

| Layer | File | Mechanism |
|-------|------|-----------|
| Tool manifest | `server.js` | `validateManifestHasNoDeleteTools()` at startup — throws if any tool name matches delete patterns |
| Graphiti client (MCP) | `quorum-mcp/src/graph/client.js` line 61 | `BLOCKED_METHODS` set; checked in `callGraphiti()` before every call |
| Graphiti client (gateway) | `gateway/src/shared/graph/client.js` line 61 | Same `BLOCKED_METHODS` set — vendored copy |
| SQL layer | `queries.js`, `secondary.js` | No DELETE statements exist — only INSERT and one legal UPDATE |
| Soft deprecation | `graph/client.js` | `deleteEpisodeSoft()` calls `add_memory` with deprecation marker, never a delete method |

### Rule 2 — Append-Only Audit

| Layer | File | Mechanism |
|-------|------|-----------|
| Write guard | `secondary.js` | `updateEntry()` and `deleteEntry()` throw `ConstitutionalViolation[APPEND_ONLY_AUDIT]` unconditionally |
| SQL | `secondary.js` `writeAuditEntry()` | INSERT-only in BEGIN/COMMIT transaction |
| Chain integrity | `secondary.js` | `nextChainPosition()` with row lock — sequential, non-gappable positions; SHA256 links each entry to previous |

### Rule 3 — Reason Required (≥10 chars, not a placeholder)

| Layer | File | When enforced |
|-------|------|---------------|
| Supersession | `remember.js` | Before any supersede |
| Conflict resolution | `remember.js` | Before `resolveConflictDecision()` |
| Constitutional check | `constitutional.js` | 14 placeholder patterns blocked (`todo`, `na`, `tbd`, `test`, etc.) |
| **NOT enforced** | — | First writes — only supersession and resolution require a reason |

### Rule 4 — No Self-Approval

| Layer | File | Mechanism |
|-------|------|-----------|
| Review tool | `tools/review.js` | `enforceNoSelfApproval(author, reviewer)` |
| Constitutional | `constitutional.js` | Case-insensitive, whitespace-normalised comparison |
| Conflict party | `constitutional.js` | `enforceConflictPartyCannotSelfResolve()` |

### Rule 5 — Claude Writes Always DRAFT

| Layer | File | Mechanism |
|-------|------|-----------|
| First write | `remember.js` `storeFirst()` | `author === 'claude'` forces DRAFT status |
| Reflect path | `reflect.js` | `triggered_by: TriggeredBy.REFLECT` propagated; `storeFirst()` checks trigger |
| **Gap** | — | Supersession path: an approved DRAFT by 'claude' superseded again by 'claude' would not be forced DRAFT — appears intentional (review approval promotes to ACTIVE) |

### Rule 5b — Multi-Party Config (governance actions)

`enforceMultiPartyConfig()` in `constitutional.js` requires `approvers.length >= 2` from at least 2 different teams plus a 48h cooling period. The function exists and is tested but must be explicitly called by config/governance routes.

---

## 7. Known Gaps & Latent Issues

### 🔴 Gap 1 — ILIKE Fallback Is Dead Code in MCP Context

**File:** `quorum-mcp/src/tools/search.js` line 128
**Impact:** When Graphiti returns 0 results (empty FalkorDB), MCP `search()` silently fails instead of falling back to PostgreSQL.

`search.js` calls `pg.query()` directly for the ILIKE fallback. In the MCP context, `pg` is a `GatewayClient` instance, and `GatewayClient.query()` unconditionally throws:
```
'use the typed gateway endpoints instead'
```
The error is swallowed by `withAuditPipeline` — the tool returns empty results with no indication of the failure. The gateway BFF (`/api/search`) has the same fallback correctly wired to a real `pg.Pool` and works correctly.

**Fix:** Replace the inline `pg.query()` call with a typed GatewayClient method (e.g. `gw.searchByText(query, { domain, limit, projectId })`) backed by a new `/pg/search` gateway route that runs the ILIKE query.

---

### 🔴 Gap 2 — Cross-Project Contamination in Graphiti Search

**Files:** `quorum-mcp/src/graph/client.js` lines 339–358; `gateway/src/shared/graph/client.js` lines 336–355
**Impact:** All semantic search is global — knowledge from any project can appear in any search result.

`searchNodes()` and `searchFacts()` intentionally omit `group_ids` from Graphiti calls because hyphens in project IDs break FalkorDB/RediSearch queries. Since all project IDs are now normalised to underscores at both `resolveCtx()` and the gateway proxy, passing `group_ids: [underscoredProjectId]` to Graphiti should now be safe.

**Fix:** Re-enable `group_ids` filtering in both client files now that hyphen normalisation is enforced at both layers. This restores project isolation for semantic search.

---

### 🔴 Gap 3 — Concurrent Supersession Race Condition

**File:** `quorum-mcp/src/tools/remember.js` lines 210–280
**Impact:** Two concurrent `remember()` calls on the same topic+key can produce two `ACTIVE` version rows simultaneously.

`supersede()` makes 4 sequential HTTP calls with no atomic transaction:
1. `getNextVersionNumber()` — reads `MAX(version)`
2. `addSupersedingEpisode()` — writes to Graphiti
3. `insertVersion()` — inserts into PostgreSQL
4. `transitionVersionStatus(old → SUPERSEDED)`

Two concurrent callers both read version N at step 1, both attempt to insert version N+1, PostgreSQL accepts both. Both rows have `status: ACTIVE`. `getCurrentVersion()` (`SELECT WHERE status='ACTIVE'`) returns an undefined set.

**Fix:** Move the version sequence + status transition into a single PostgreSQL transaction on the gateway side. The gateway `POST /pg/versions` route should accept an optional `supersedes_id` parameter and atomically perform the INSERT + UPDATE in one transaction.

---

### 🟡 Gap 4 — Graphiti Episode UUID Is Fictional

**File:** `quorum-mcp/src/graph/client.js` lines 271–290
**Impact:** `getEvolutionChain(episodeId)` can never reliably find the evolution chain.

`addEpisode()` generates a `randomUUID()` locally and returns it as `episode_id` — but this UUID is never passed to Graphiti (removed to fix the Graphiti 0.29 retrieve-key bug). Graphiti assigns its own UUID internally. The `graphiti_episode_id` column in `knowledge_versions` contains a local UUID that Graphiti never knew about.

`getEvolutionChain()` passes this local UUID into a semantic text search — may occasionally find SUPERSEDES edge text by coincidence, but is structurally unreliable.

**Fix (medium-term):** Return the real Graphiti UUID from `add_memory` response if Graphiti exposes it. Store it in `knowledge_versions.graphiti_episode_id`. Until then, evolution chain traversal should be done purely via the PostgreSQL `supersedes_version` / `superseded_by_version` columns.

---

### 🟡 Gap 5 — Identity Stale After Role Change

**File:** `quorum-mcp/src/server.js` lines 148–232
**Impact:** `identity.role` used in `resolveAuthorConfidence()` may be stale for the lifetime of the MCP process.

`identity` is resolved once at MCP startup and captured in the `registerTools()` closure. If a user's role changes in DDB/Redis after the MCP started, `identity.role` at the MCP is stale. The gateway-side `req.user.role` (from `verifyJwt` + live profile cache) is always current — but these are two different role values used at different points in the pipeline.

**Fix:** Re-resolve identity on each tool call (or re-fetch role from the gateway identity endpoint), replacing the startup closure capture with a live fetch per call.

---

### 🟡 Gap 6 — `pending_decisions` Missing Project Scope on Resolution

**File:** `gateway/src/shared/graph/queries.js`
**Impact:** Architecturally incorrect boundary — resolution UPDATE has no `project_id` guard.

```sql
UPDATE pending_decisions SET ... WHERE conflict_id = $8
-- missing: AND project_id = $N
```

UUID collision across projects is astronomically unlikely in practice, but the project boundary is an architectural invariant that should be explicit in every write path.

**Fix:** Add `AND project_id = $N` to both `resolvePendingDecision()` and `markPendingDecisionStale()` queries.

---

### 🟡 Gap 7 — Silent Privilege Downgrade on DDB Failure

**File:** `gateway/src/ddb.js` line 74
**Impact:** DDB outage silently sets `req.user.role = null` and `req.user.is_owner = false` for all users for up to 5 minutes.

```js
} catch (err) {
  return []   // ← silent failure — no warn log, no 503
}
```

The profile cache stores the empty result. Every JWT verification during the DDB outage window returns a degraded profile. Engineers lose write permissions without any error surfaced to them.

**Fix:** Log at `warn` level when DDB returns empty due to an error. Optionally: if a stale cache entry exists, prefer it over a fresh empty-due-to-error result.

---

### 🟢 Gap 8 — Multi-Instance Redis Invalidation Is Informational Only

**File:** `gateway/src/redis.js` line 69
**Impact:** In a multi-instance deployment, the invalidation subscriber does not DEL the key on receiving a message — only the instance that performed the write DELs its own copy.

The write path does: `DEL key` then `PUBLISH quorum:invalidate key`. The subscriber callback only logs. For a single-instance deployment (current) this is harmless. For multi-instance, other instances do not evict their cached copy — stale data persists up to TTL on non-writing instances.

**Fix:** In `onInvalidate(key)`, call `getRedis().del(key)` on receipt of the invalidation message.

---

## Gap Priority Summary

| # | Severity | Gap | Fix complexity |
|---|----------|-----|----------------|
| 1 | 🔴 High | ILIKE fallback dead code in MCP `search()` | Medium — new `/pg/search` gateway route |
| 2 | 🔴 High | Cross-project contamination in Graphiti search | Low — re-enable `group_ids` now IDs use `_` |
| 3 | 🔴 High | Concurrent supersession race condition | Medium — atomic gateway transaction |
| 4 | 🟡 Medium | Graphiti episode UUID is fictional | Medium — depends on Graphiti API |
| 5 | 🟡 Medium | Identity stale after role change in MCP | Low — live fetch per call |
| 6 | 🟡 Medium | `pending_decisions` missing project scope on resolution | Low — add `AND project_id` |
| 7 | 🟡 Medium | Silent privilege downgrade on DDB failure | Low — warn log + prefer stale cache |
| 8 | 🟢 Low | Multi-instance Redis invalidation informational only | Low — `del(key)` in subscriber |

---

## 8. Essential Files Reference

| File | Purpose |
|------|---------|
| `quorum-mcp/src/server.js` | MCP startup, tool registration, identity closure, project context resolution (`resolveCtx`) |
| `quorum-mcp/src/gateway/client.js` | HTTP client, token management, all typed gateway endpoints |
| `quorum-mcp/src/tools/remember.js` | Full governance write pipeline — conflict detection, supersession, coexist flows |
| `quorum-mcp/src/tools/search.js` | Dual-store search + broken ILIKE fallback (Gap #1) |
| `quorum-mcp/src/tools/reflect.js` | LLM extraction + batch DRAFT remember |
| `quorum-mcp/src/tools/authenticate.js` | OAuth 2.1 PKCE flow, callback server, token exchange |
| `quorum-mcp/src/graph/client.js` | Graphiti MCP session, BLOCKED_METHODS, fictional episode UUID (Gap #4) |
| `gateway/src/server.js` | Gateway entry point, pg pool, route mounting, startup sync |
| `gateway/src/routes/pg.js` | All PostgreSQL REST endpoints, project-scoped queries |
| `gateway/src/routes/graphiti.js` | Graphiti proxy, group_id sanitisation + injection, session header forwarding |
| `gateway/src/routes/auth.js` | PAT-based JWT issuance, refresh, project discovery |
| `gateway/src/middleware/verify-jwt.js` | Two-step JWT verification + profile cache enrichment |
| `gateway/src/config-cache.js` | Redis → S3/DDB read-through cache for config, profile, admin |
| `gateway/src/ddb.js` | DDB membership table, syncProjectMembers, getUserProjects (silent failure — Gap #7) |
| `gateway/src/redis.js` | Dual ioredis connections, pub/sub invalidation subscriber (Gap #8) |
| `gateway/src/shared/graph/queries.js` | All PostgreSQL query functions — source of truth for SQL layer |
| `gateway/src/shared/audit/secondary.js` | Transactional audit write with SHA256 chain, append-only enforcement |
| `gateway/src/shared/governance/constitutional.js` | All 5 constitutional rules as throwing functions |
| `gateway/src/shared/graph/client.js` | Gateway-side Graphiti client (vendored copy of MCP version) |
