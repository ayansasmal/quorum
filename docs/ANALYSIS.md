# Quorum — System Analysis & Data Flow Reference

> Updated: 2026-05-18
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
7. [Gap Register](#7-known-gaps--latent-issues)
8. [Essential Files Reference](#8-essential-files-reference)
9. [Shipped Backlog](#9-shipped-backlog)

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

**Gate exemptions:** Gate 1 (`no_project_context`) bypassed — `authenticate` is explicitly excluded from the project context check so it can run before `.quorum` exists. Gate 2 (`not_authenticated`) bypassed for the same reason. Gate 3 does not apply (not a write tool).

---

### g) `set_agent_context()` — register agent identity

```
set_agent_context.handler(pg, input, identity, ctx)
  ↓ Validate agent_id: /^[a-z][a-z0-9-]{0,39}$/
      → Throws invalid_agent_id if pattern fails
  ↓ deriveSessionId()
      → seed = `${process.pid}-${process.hrtime.bigint()}`
      → 'sess_' + sha256(seed).slice(0,8)
  ↓ _agentCtx = { agent_id, session_id, author_type: 'agent' }
      — module-level singleton; overwritten if called again
  → Returns { status:'context_set', agent_id, session_id, author_type:'agent', note }
```

**Zero HTTP calls.** This tool makes no gateway requests — it is pure in-memory state
mutation in the MCP process. The `_agentCtx` value is read by subsequent write tools via
`getAgentCtx()` and merged into `ctx` before calling each handler.

**Data written:** None. Side effect only: module-level `_agentCtx`.

**Gate behaviour:** Gates 1 and 2 apply (project context and auth required). Gate 3 does not
apply (tool is not in `WRITE_TOOLS` — it would deadlock if it required itself).

**Hardcoded field:** `author_type` is always `'agent'` regardless of caller input. This is
foundational for future human dashboard writes (which will set `author_type = 'human'` in the
gateway layer, not via the MCP tool).

---

### h) `config_upload()` — upload project config

```
config_upload.handler(pg, input, identity, ctx)
  ↓ readFileSync(resolve(input.config_path))   — local file read
  ↓ JSON.parse(raw)
  ↓ gw._post('/config/upload', configData)
      → POST /config/upload + Bearer JWT
      → Gateway: authUpload(req)
          → Accept if: sync token header present, OR role==='principal_architect', OR
            bootstrap path: caller is listed as principal_architect in the uploaded config
      → QuorumConfigSchema.safeParse(req.body)   — zod validation
      → S3 HeadObjectCommand               — idempotency check → 409 if exists
      → S3 PutObjectCommand                — write <group_id>.quorum.json
      → syncOneProject(bucket, groupId)
          → Read back from S3
          → PutItem to DDB quorum-configs table
          → Batch write to quorum-user-projects table (one item per member)
      → getProjectByGroupId(pool, groupId) → null → createProject(pool, ...)
          → INSERT INTO q_projects
          → Allocates q_p{n} via sequence
      → Returns { project_id, q_project_id, message, next_step }
  IF 409: returns { status:'already_onboarded', q_project_id from error body }
```

**Data written:** S3 object, DynamoDB `quorum-configs` + `quorum-user-projects` records,
PostgreSQL `q_projects` row (INSERT only — no audit log entry for config upload).

**Gate exemptions:** Gate 1 (`no_project_context`) bypassed — config upload runs before the
`.quorum` file exists (Phase 4 of onboarding). Gate 2 (auth) applies. Gate 3 does not apply.

**Bootstrap self-authorization:** if the uploaded config lists the caller's GitHub username with
role `principal_architect`, the gateway accepts the upload even without a pre-existing project
entry. This is the bootstrap path for new project onboarding. Not documented elsewhere.

---

### i) `forget()` — soft-deprecate knowledge

```
forget.handler(pg, input, identity, ctx)
  ↓ enforceNoHardDelete('forget')         — constitutional check before pipeline
      NOTE: 'forget' contains no blocked keyword → passes trivially
      Real enforcement is BLOCKED_METHODS in graph/client.js
  ↓ enforceReasonRequired(input.reason)   — before pipeline
  ↓ withAuditPipeline wraps:
    ↓ getCurrentVersion(pg, topic, key, projectId)
        → GET /pg/versions/{topic}/{key}
    ↓ deleteEpisodeSoft(episodeId, { key, reason, author }, projectId)
        → POST /graphiti/mcp { name:'add_memory', ... }   — adds DEPRECATED marker episode
        → .catch(() => {})  — Graphiti failure is non-fatal
    ↓ buildVersionRecord({ ..., status: DEPRECATED })
    ↓ insertVersion(pg, versionRecord)
        → POST /pg/versions → INSERT knowledge_versions (status=DEPRECATED, version=N+1)
    ↓ transitionVersionStatus(pg, topic, key, oldVersion, 'DEPRECATED', forwardLink, projectId)
        → PATCH /pg/versions/{topic}/{key}/{version}
  ↓ writeAuditEntry() INTENT + OUTCOME
```

**Two-row deprecation pattern:** `forget` inserts a new DEPRECATED version row (v=N+1) AND
updates the previous ACTIVE row status to DEPRECATED. Both rows share `status='DEPRECATED'`
for the same topic:key — this is correct; the N+1 row records the deprecation reason and
author, the old row records the prior content.

**Data written:** Two `knowledge_versions` status updates (INSERT new row + UPDATE old row),
Graphiti soft-delete episode (best-effort), `audit_log` entries.

---

### j) `review()` — approve/reject a DRAFT

```
review.handler(pg, input, identity, ctx)
  ↓ enforceReasonRequired(input.note)   — before pipeline
  ↓ withAuditPipeline wraps:
    ↓ getLatestDraftVersion(pg, topic, key, projectId)
        → GET /pg/versions/{topic}/{key}/drafts
    ↓ enforceNoSelfApproval(targetVersion.author, reviewer)
        → Throws if author === reviewer (case-insensitive, whitespace-normalised)
    ↓ enforceReviewerTeam(topic, reviewerTeam)
        → Reads getConfig() (in-memory from .quorum / S3)
        → Checks domains[topic].required_reviewer_teams
    ↓ Staleness check: getCurrentVersion(pg, topic, key, projectId)
    IF action === 'request_changes':
      → Returns without state change (no DB write)
    IF action === 'approve' OR 'reject':
      ↓ transitionVersionStatus(pg, ..., newStatus, null, projectId)
          → PATCH /pg/versions/{topic}/{key}/{version}
          → SQL: UPDATE knowledge_versions SET status=? WHERE ...
      ↓ incrementDomainStat(pg, ...)   — fire-and-forget
          ⚠️  See Gap #9: silently fails in gateway mode
  ↓ writeAuditEntry() INTENT + OUTCOME
```

**Graphiti not updated.** When a DRAFT is approved → ACTIVE, ONLY the PostgreSQL
`knowledge_versions.status` column changes. The Graphiti episode metadata (written at
`remember` time with `status: DRAFT`) is NOT updated. `search()` filters results by
`node.metadata?.status` — a newly-approved entry remains invisible in semantic search until
the Graphiti metadata is corrected. See Gap #10.

**Data written:** PostgreSQL `knowledge_versions` status UPDATE only. No new row, no Graphiti
write. `audit_log` entries.

---

### k) `history()` — full version timeline

```
history.handler(pg, input, identity, ctx)
  ↓ withAuditPipeline wraps:
    ↓ getVersionHistory(pg, topic, key, projectId)
        → GET /pg/versions/{topic}/{key}/history
        → SQL: SELECT * FROM knowledge_versions WHERE topic=? AND key=? AND project_id=?
               ORDER BY version ASC
    IF versions found AND latest.graphiti_episode_id:
      ↓ getEvolutionChain(episodeId, projectId)
          → POST /graphiti/mcp { name:'get_entity_edge_facts', ... }
          → .catch(() => [])   — Graphiti failure returns empty array silently
      → Merge: each version gets graph_linked: true/false flag
    ELSE:
      → All versions return graph_linked: false
  ↓ writeAuditEntry() INTENT + OUTCOME
```

**Degraded mode:** If Graphiti is unavailable or returns empty, history still works using only
PostgreSQL data. All entries show `graph_linked: false`. No warning is surfaced — callers
cannot distinguish a successful "no graph data" from a Graphiti failure.

**Data written:** `audit_log` only.

---

### l) `export()` — dump knowledge to markdown/Confluence

```
export.handler(pg, input, identity, ctx)
  ↓ withAuditPipeline wraps:
    ↓ Parallel:
      getVersionsByStatus(pg, 'ACTIVE', { topic, projectId })
          → GET /pg/versions/by-status/ACTIVE
      getVersionsByStatus(pg, 'SUPERSEDED', { topic, projectId })
          → GET /pg/versions/by-status/SUPERSEDED
    ↓ For each ACTIVE version:
      searchNodes(`${topic}:${key}`, { limit:1, groupId:projectId })
          → POST /graphiti/mcp   — content retrieval via search (not direct fetch)
          → .catch(() => null)   — failure → placeholder text inserted silently
    ↓ getVersionStatusCounts(pg, { topic, projectId })
        → GET /pg/versions/status-counts
    ↓ Format: markdown.build() or confluence.build()
  ↓ writeAuditEntry() INTENT + OUTCOME
```

**Content retrieval caveat:** Content is fetched from Graphiti via a search call, not a direct
episode GET. After a FalkorDB wipe, the search index is empty and content retrieval silently
falls back to the placeholder `[Content stored in graph — search for this key to retrieve]`.
The exported document contains placeholder rows without any warning to the caller. The correct
content is in PostgreSQL `summary` column — `export` does NOT fall back to it.

**Data written:** `audit_log` only.

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

### ✅ Gap 1 — ILIKE Fallback Fixed in MCP Context

**Resolution (2026-05-15):** `search.js` now calls `pg.searchByText(query, { domain, limit, projectId })` — a typed `GatewayClient` method backed by `GET /pg/search` on the gateway. The gateway route runs the PostgreSQL ILIKE query against `knowledge_versions.summary` and returns structured results. The broken `pg.query()` direct call is gone.

---

### ✅ Gap 2 — Cross-Project Contamination Fixed

**Resolution (2026-05-15):** `group_ids: [groupId]` is now passed to Graphiti in both `searchNodes()` and `searchFacts()` in both client files. Project IDs use underscores (enforced at `resolveCtx()` and the gateway proxy), so hyphen-as-NOT-operator in RediSearch no longer applies. Project isolation in semantic search is restored.

---

### ✅ Gap 3 — Concurrent Supersession Race Condition Fixed

**Resolution (2026-05-15):** `remember.js` supersession path now calls `pg.atomicSupersede(payload)` — a single `GatewayClient` method backed by `POST /pg/versions/supersede` on the gateway. The gateway route performs the INSERT of the new version and the UPDATE of the old version status to `SUPERSEDED` in a single PostgreSQL transaction, eliminating the race window.

---

### ✅ Gap 4 — Graphiti Episode UUID Is Fictional (Superseded by q_* schema)

**Resolution (2026-05-15):** The q_* schema rewrite makes this gap moot. `knowledge_versions`
now uses `version_id TEXT PRIMARY KEY` of the form `q_k{n}_v{m}`, with `supersedes_version`
and `superseded_by_version` FK columns linking versions directly. Evolution chain traversal is
done entirely in PostgreSQL — `getEvolutionChain()` no longer relies on Graphiti episode UUIDs.

`graphiti_episode_id` remains a best-effort annotation (local UUID returned by `addEpisode()`)
but is not used as a lookup key anywhere in the query layer. No fix needed.

---

### ✅ Gap 5 — Identity Stale After Role Change Fixed

**Resolution (2026-05-15):** Identity is now resolved fresh on every tool call in `server.js`. The startup closure no longer captures `identity` — each handler invocation re-reads the JWT and re-fetches the current role from the gateway profile cache (Redis → DDB), which automatically reflects any role changes within the cache TTL (300s).

---

### ✅ Gap 6 — `pending_decisions` Missing Project Scope (Superseded by q_* schema)

**Resolution (2026-05-15):** The q_* schema rewrite makes this gap moot. `conflict_id` values
are now Quorum-assigned sequential IDs of the form `q_c{n}` (from `q_conflict_seq`). These IDs
are globally unique — a `WHERE conflict_id = $N` clause is sufficient project isolation.

The old design used human-supplied string IDs (e.g. `conflict-auth`) that required `AND project_id = $N`
to prevent cross-project manipulation. `q_c{n}` IDs are opaque integers a caller cannot guess —
they only hold one if it was returned by a prior query scoped to their own project.

---

### ✅ Gap 7 — Silent Privilege Downgrade on DDB Failure Fixed

**Resolution (2026-05-15):** `getUserProjects()` in `ddb.js` now calls `console.warn()` when DDB returns an error before returning `[]`, making the outage visible in gateway logs. The profile cache TTL means stale entries naturally serve as a fallback for the first 300s of a DDB outage.

---

### ✅ Gap 8 — Multi-Instance Redis Invalidation Fixed

**Resolution (2026-05-15):** The `onInvalidate(key)` subscriber callback in `redis.js` now calls `getRedis().del(key)` on receipt of a `quorum:invalidate` message, actively evicting the key from the command client on every instance that receives the pub/sub event. Multi-instance deployments now propagate cache invalidation correctly.

---

### 🔴 Gap 9 — `incrementDomainStat` Silently Fails in All Gateway-Mode MCP Calls

**Discovered: 2026-05-18 (static analysis)**

**Affected tools:** `recall`, `review`, `remember` (supersession path).

**Root cause:** `incrementDomainStat(pg, ...)` in `quorum-mcp/src/graph/queries.js` uses the duck-typing guard:
```javascript
if (typeof pg.incrementDomainStat === 'function') return pg.incrementDomainStat(...)
```
`GatewayClient` does NOT implement `incrementDomainStat`, so the guard fails and the code falls through to `pg.query(rawSQL)`. `GatewayClient.query()` throws `"GatewayClient.query() called with raw SQL"`. The call sites wrap with `.catch(() => {})` — the error is swallowed silently.

**Impact:** The `author_domain_stats` table is never written in production gateway mode. The authority formula (`calculateAuthority`) depends on `access_count` from this table. All `access_count` values are effectively 0, meaning authority scores are computed only from confidence and recency — not from usage frequency. The confidence `bump` endpoint (`POST /api/bump/:topic/:key`) works correctly (it has its own SQL path in the gateway), but organic recall-based stats do not accumulate.

**Fix:** Add `incrementDomainStat(params)` as a typed method on `GatewayClient` backed by a `POST /pg/stats` gateway route, replacing the direct SQL fallback. The route should accept `{ topic, key, author, projectId, statType }` and run the INSERT/UPSERT.

---

### 🟡 Gap 10 — Graphiti Episode Metadata Not Updated on `review()` Approval

**Discovered: 2026-05-18 (static analysis)**

**Root cause:** When `review(action:'approve')` transitions a `knowledge_versions` row from DRAFT→ACTIVE in PostgreSQL, it does NOT make any Graphiti call. The Graphiti episode written at `remember` time carries `status: 'DRAFT'` in its metadata. `search()` in `src/tools/search.js` filters results by `node.metadata?.status`, excluding nodes with non-ACTIVE status.

**Impact:** A newly-approved DRAFT entry is invisible in semantic search results until one of:
- The entry is re-ingested via `scripts/reingest-to-graphiti.js`, OR
- The Graphiti episode happens to be re-written by a subsequent `remember()` supersession

This means the `review() → approve` flow creates a divergence between the PostgreSQL governance record (ACTIVE) and the Graphiti search index (DRAFT). Queries via `recall(topic, key)` still work (PostgreSQL only) but `search(query)` misses the entry.

**Fix:** In `review.js`, after `transitionVersionStatus`, call `updateEpisodeMetadata(episodeId, { status: 'ACTIVE' }, projectId)` via `GatewayClient` — backed by a gateway route that calls Graphiti's `update_memory` or `add_memory` (overwrite) method. If `graphiti_episode_id` is null (FalkorDB wipe), fall back to `addEpisode()` to re-ingest the content from `version.summary`.

---

### 🟡 Gap 11 — No-Self-Approval Not Enforced in Conflict Resolution Path

**Discovered: 2026-05-18 (static analysis)**

**Root cause:** `enforceConflictPartyCannotSelfResolve()` exists in `constitutional.js` but is NOT called in `remember.js:resolveConflictDecision()`. An agent that triggered a conflict (e.g. by calling `remember()` which detected a clash with an existing entry) can call `remember()` again with `{ conflict_id, resolution:'supersede' }` to resolve the conflict in their own favour — without constitutional enforcement.

**Impact:** A junior-role agent can create a conflict with a senior architect's entry, then immediately self-resolve it with `resolution: 'supersede'`, effectively overwriting the senior entry without any human review or cross-party approval. This bypasses the governance intent of conflict detection.

**Fix:** In `remember.js:resolveConflictDecision()`, after loading the conflict record, call:
```javascript
enforceConflictPartyCannotSelfResolve(conflictRecord.incoming_author, identity.name)
```
where `conflictRecord.incoming_author` is the author who originally triggered the conflict (stored in `pending_decisions`).

---

## Gap Priority Summary

> Last updated: 2026-05-18

| # | Severity | Gap | Status |
|---|----------|-----|--------|
| 1 | ~~🔴 High~~ | ILIKE fallback dead code in MCP `search()` | ✅ Fixed — `pg.searchByText()` typed method via `/pg/search` route |
| 2 | ~~🔴 High~~ | Cross-project contamination in Graphiti search | ✅ Fixed — `group_ids` re-enabled in `searchNodes()`/`searchFacts()` |
| 3 | ~~🔴 High~~ | Concurrent supersession race condition | ✅ Fixed — `pg.atomicSupersede()` → `POST /pg/versions/supersede` (atomic transaction) |
| 4 | ~~🟡 Medium~~ | Graphiti episode UUID is fictional | ✅ Superseded — evolution chain uses PostgreSQL q_* FK columns |
| 5 | ~~🟡 Medium~~ | Identity stale after role change in MCP | ✅ Fixed — identity resolved fresh per tool call |
| 6 | ~~🟡 Medium~~ | `pending_decisions` missing project scope on resolution | ✅ Superseded — q_* schema `q_c{n}` IDs are globally unique |
| 7 | ~~🟡 Medium~~ | Silent privilege downgrade on DDB failure | ✅ Fixed — `console.warn()` logged on DDB error in `ddb.js` |
| 8 | ~~🟢 Low~~ | Multi-instance Redis invalidation informational only | ✅ Fixed — `getRedis().del(key)` called in subscriber callback |
| 9 | 🔴 High | `incrementDomainStat` silently fails in all gateway-mode MCP calls | 🔜 Open — `author_domain_stats` table never written in production |
| 10 | 🟡 Medium | Graphiti episode metadata not updated on `review` approval | 🔜 Open — newly-approved entries may be filtered from semantic search |
| 11 | 🟡 Medium | No-self-approval not enforced in `resolveConflictDecision` path | 🔜 Open — conflict originator can resolve their own conflict via `remember()` |

---

## 8. Essential Files Reference

| File | Purpose |
|------|---------|
| `quorum-mcp/src/server.js` | MCP startup, tool registration, identity closure, project context resolution (`resolveCtx`) |
| `quorum-mcp/src/gateway/client.js` | HTTP client, token management, all typed gateway endpoints |
| `quorum-mcp/src/tools/set-agent-context.js` | Gate 3 agent identity — `_agentCtx` singleton, `session_id` derivation, zero HTTP calls |
| `quorum-mcp/src/tools/remember.js` | Full governance write pipeline — conflict detection, supersession, coexist flows |
| `quorum-mcp/src/tools/recall.js` | PostgreSQL-only read; `incrementDomainStat` call silently fails (Gap #9) |
| `quorum-mcp/src/tools/search.js` | Dual-store search (Graphiti primary, PostgreSQL ILIKE fallback via `searchByText`) |
| `quorum-mcp/src/tools/reflect.js` | LLM extraction via `/governance/extract`; calls `rememberHandler` directly (no re-gate) |
| `quorum-mcp/src/tools/forget.js` | Soft deprecation — two-row pattern (new DEPRECATED row + status update on old row) |
| `quorum-mcp/src/tools/review.js` | Approve/reject DRAFT; Graphiti NOT updated (Gap #10); no-self-approval in `review` only |
| `quorum-mcp/src/tools/history.js` | Version timeline; Graphiti evolution chain; silent fallback to `graph_linked:false` |
| `quorum-mcp/src/tools/export.js` | Markdown/Confluence dump; content from Graphiti search (placeholder on FalkorDB wipe) |
| `quorum-mcp/src/tools/pending.js` | Read tool with write side-effect — stale detection mutates `pending_decisions` |
| `quorum-mcp/src/tools/authenticate.js` | OAuth 2.1 PKCE flow; Gate 1 + Gate 2 exempt; backed by `mcp-oauth.js` on gateway |
| `quorum-mcp/src/tools/config-upload.js` | Gate 1 exempt; bootstrap self-auth path; S3+DDB+PG write chain |
| `quorum-mcp/src/graph/client.js` | Graphiti MCP session, BLOCKED_METHODS, `graphiti_episode_id` is best-effort only |
| `gateway/src/server.js` | Gateway entry point, pg pool, route mounting, startup sync |
| `gateway/src/routes/pg.js` | All PostgreSQL REST endpoints, project-scoped queries |
| `gateway/src/routes/graphiti.js` | Graphiti proxy, group_id sanitisation + injection, session header forwarding |
| `gateway/src/routes/auth.js` | PAT-based JWT issuance, refresh, project discovery |
| `gateway/src/middleware/verify-jwt.js` | Two-step JWT verification + profile cache enrichment |
| `gateway/src/config-cache.js` | Redis → S3/DDB read-through cache for config, profile, admin |
| `gateway/src/ddb.js` | DDB membership table, syncProjectMembers, getUserProjects (warn logged on error — Gap #7 fixed) |
| `gateway/src/redis.js` | Dual ioredis connections, pub/sub invalidation subscriber with active DEL (Gap #8 fixed) |
| `gateway/src/shared/graph/queries.js` | All PostgreSQL query functions — source of truth for SQL layer |
| `gateway/src/shared/audit/secondary.js` | Transactional audit write with SHA256 chain, append-only enforcement |
| `gateway/src/shared/governance/constitutional.js` | All 5 constitutional rules as throwing functions |
| `gateway/src/shared/graph/client.js` | Gateway-side Graphiti client (vendored copy of MCP version) |

---

## 9. Shipped Backlog

> Formerly `docs/BACKLOG.md`. All items resolved. Kept as historical record.

### Board (all ✅ Done)

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| BL-01 | `group_id` isolation bypass in Graphiti proxy | P1 | Conditional guard → unconditional overwrite |
| BL-02 | Remove `mcp/` from engram + ops audit CLI | P2 | `mcp/` deleted; `scripts/audit-cli.js` created; tests migrated to quorum-mcp |
| BL-02a | `GET /pg/audit/lineage/:topic/:key` gateway endpoint | P3 | Added before `/audit/:id` in `gateway/src/routes/pg.js` |
| BL-05 | Pin Graphiti git SHA in Dockerfile | P3 | `ARG GRAPHITI_SHA` + `git checkout`. Pinned to `c427615` (2026-05-07) |
| BL-10 | `DEPLOYMENT.md` — component security model | Docs | Full rewrite: two-party arch, OAuth 2.1 flow, engineer onboarding, secrets, multi-team isolation |
| BL-11 | Gateway LLM governance endpoints | P1 | `routes/governance.js` + `llm.js`. JWT-authenticated. OPENAI_API_KEY gateway-only |
| BL-12 | OAuth 2.1 Authorization Server in gateway | P2 | RFC8414 discovery, RFC7591 dynamic client reg, PKCE S256, GitHub IdP, ES256 JWT |
| BL-13 | SDLC Hooks + Skill Integration | P2 | 5 hook scripts + `hooks.js` + SKILL.md. 13 unit tests passing |

### Deferred to v1.0

| Item | Reason |
|------|--------|
| Reflect Activity dashboard panel | Build after `reflect()` usage data exists |
| Helm CronJob for decay | Use external k8s CronJob calling `scripts/decay-confidence.js` |
| PENDING_CONFLICT_CHECK dashboard badge | Deferred to v1.0 |
| GitHub Action for PR ingest | Dropped — SKILL.md + hooks already capture PR knowledge via reflect() |
| Notifications (Slack, webhook) | Skipped — explicit product decision |
| LLM accuracy CI gate | Needs real usage data for golden dataset |
| Hosted docs site | After core features stable |
| Public case study | After at least one team uses in production |

### Changelog

| Date | Item | Commit |
|------|------|--------|
| 2026-05-15 | Gaps 1-8 resolved; q_* schema rewrite (Phase 1-3) | `769ae23`–`c48f8d2` |
| 2026-05-07 | BL-13 ✅ Done: 5 hooks, hooks.js, SKILL.md, 13 tests | feat/sdlc-hooks |
| 2026-05-08 | BL-11 ✅ Done: governance endpoints + llm.js | feat/dashboard |
| 2026-05-07 | BL-03 dropped: platform team deploys centrally; engineers connect from Claude Code | — |
| 2026-05-08 | BL-07/BL-08/BL-04/BL-06/BL-09 dropped (see prior BACKLOG.md for rationale) | — |
| 2026-05-08 | BL-05 ✅ Done: Graphiti SHA pinned `c427615` | feat/dashboard |
| 2026-05-08 | BL-10 ✅ Done: DEPLOYMENT.md rewritten | feat/dashboard |
| 2026-05-06 | quorum-mcp BL-10 ✅ Done: full OAuth round-trip live | f37f560 |
| 2026-05-04 | BL-01 ✅ Done: unconditional overwrite in graphiti.js | — |
| 2026-05-03 | Per-package CLAUDE.md, OpenAPI spec, duck-type guards, npm org | `95e2cae` |
| 2026-05-03 | Monorepo restructure — mcp/, gateway/, dashboard/ | `bb451db` |
