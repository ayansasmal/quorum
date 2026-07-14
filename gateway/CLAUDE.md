# @as-quorum/gateway

Private self-hosted server. Enterprise teams run this alongside Graphiti, PostgreSQL, FalkorDB, and (optionally) LocalStack.

Not published to npm. Teams check out the repo from GitHub and deploy via Docker Compose or Helm.

---

## Purpose

HTTP gateway sitting between the MCP server and persistence layers. Responsibilities:

- **Auth:** GitHub OAuth → ES256 slim JWT `{ sub, is_admin, jti, iat, exp }` + refresh tokens. `POST /auth/token` accepts a GitHub PAT with optional `project_id`; membership never gates issuance and supplied project context only enriches the response. JWKS at `/.well-known/jwks.json`. PKCE OAuth 2.1 is supported (`routes/mcp-oauth.js`) for MCP clients.
- **Identity:** Two-step `verify-jwt.js` middleware — JWT → `loadUserProfile(sub)` from Redis (`profile:{sub}`) → DDB on miss. Active project is set per-request via `X-Quorum-Project` header (not in JWT). `group_id` is injected into every Graphiti call from `req.user.project`.
- **Config:** S3-backed project config with Redis read-through cache (`config:{group_id}`). DynamoDB holds the user→projects membership index (`quorum-user-projects`).
- **Audit API:** `/pg/*` routes expose PostgreSQL operations to the MCP over HTTP. Dual-store pipeline writes to PostgreSQL (`knowledge_versions.summary` for durable content + SHA256 chain) and Graphiti (semantic graph).
- **Governance:** `routes/config.js` (transfer ownership, update role), `routes/admin.js` (platform admin management), `routes/governance.js` (LLM conflict detection), `routes/user.js` (`/user/profile/:username`).
- **Confidence endorsement:** `POST /api/bump/:topic/:key` — 7-day cooldown, role-weighted delta, capped at `starting_confidence`.
- **Rate limiting:** Per-IP via `express-rate-limit`.

Runs on port **3001** by default.

---

## Key Files

```
src/
  server.js               — Express app entry point
  routes/
    auth.js               — GitHub OAuth (browser + PAT), slim JWT issue/refresh
    mcp-oauth.js          — Shared dashboard + MCP PKCE callback; zero-project dashboard users receive a normal JWT with null project context
    oauth.js              — Shared OAuth callback + state helpers
    pg.js                 — All PostgreSQL REST routes (/pg/versions/*, /pg/audit/*, /pg/pending/*, /pg/audit/lineage/:topic/:key)
                            POST /pg/versions extracts agent_id, session_id, author_type from request body (all optional, defaults to null/'agent')
    graphiti.js           — JWT-gated proxy to Graphiti MCP with group_id injection
    config.js             — GET/PUT project config + transfer-ownership + update-role
    schema.js             — GET /schema/config (public JSON Schema)
    jwks.js               — GET /.well-known/jwks.json
    sync.js               — POST /sync/configs (S3→DDB sync, EventBridge-compatible; dual auth)
    bump.js               — POST /api/bump/:topic/:key (confidence endorsement, 7-day cooldown)
    projects.js           — Project listing (legacy /auth/projects + /auth/switch return 410)
    dashboard.js          — Dashboard BFF routes (/api/stats, /api/graph, /api/knowledge, /api/search, /api/pending, /api/drafts)
                            POST /api/knowledge (create — all roles; PE→ACTIVE, others→DRAFT; confidence floored at base_confidence; PE 409s on duplicate ACTIVE, non-PE can DRAFT alongside an existing ACTIVE), GET /api/drafts (DRAFT entries awaiting PE review), POST /api/knowledge/:topic/:key/promote (DRAFT→ACTIVE, PE only), POST /api/knowledge/:topic/:key/supersede (atomic supersede, PE only), POST /api/knowledge/deprecate/bulk (bulk ACTIVE→DEPRECATED, PE only; partial success allowed), POST /api/knowledge/:topic/:key/deprecate (single ACTIVE→DEPRECATED, PE only). validateKnowledgeInput + audit chain on all write routes. Rate-limited 10/min/IP, 4KB payload cap.
                            Route ordering: /knowledge/deprecate/bulk MUST be registered before /knowledge/:topic/:key/deprecate to prevent Express matching "deprecate" as :topic.
                            POST /api/review/:conflictId branches on decision_type: conflict path (existing approve/reject/request_changes) vs deprecation_request path (approve runs atomic ACTIVE→DEPRECATED transaction; reject resolves request as rejected; request_changes returns 400). Both paths write audit entry with tool=dashboard-review-deprecation. PE role required for deprecation_request path. Staleness guard: if getCurrentVersion returns null on approve, request is auto-rejected.
    user.js               — GET /user/profile/:username (Redis → DDB). Self with zero projects → 200 { projects: [] } (drives dashboard onboarding); third-party zero-project lookups → 404 (enumeration guard)
    admin.js              — Platform admin management (/admin/config, /admin/users); final-admin removal is blocked with `409 last_admin`
    governance.js         — LLM conflict detection via OpenAI
  middleware/
    verify-jwt.js         — Async two-step: ES256 verify → loadUserProfile(sub) → X-Quorum-Project header
                            attaches req.user = { sub, is_admin, project, role, base_confidence, is_owner }
    require-membership.js — G1 write guard: public-project reads are open; mutations require membership or platform admin
    project.js            — Guards project-scoped routes (400 if req.user.project null)
    rate-limit.js         — Per-IP rate limiting (express-rate-limit)
  shared/                 — Vendored copies of quorum-mcp shared modules (no npm dep)
    config/schema.js      — QuorumConfigSchema (zod)
    config/migrations.js  — PG schema migrations (q_* id schema)
    graph/schema.js       — KnowledgeStatus enum
    graph/queries.js      — Shared SQL query functions (pass real pg.Pool)
    graph/client.js       — Graphiti client (searchNodes, etc.)
    audit/chain.js        — SHA256 tamper-evident chain
    audit/secondary.js    — writeAuditEntry (pass real pg.Pool)
    governance/constitutional.js — Constitutional enforcement
  keys.js                 — ES256 key generation/loading
  redis.js                — Redis client (separate command + subscriber connections)
  config-cache.js         — Redis config + profile + admin cache wrappers; atomic `QUORUM_FIRST_ADMIN` boot seed
  ddb.js                  — DynamoDB client (quorum-user-projects table; config cache retired)
  llm.js                  — OpenAI wrapper for governance LLM calls
  errors.js               — Shared error types
```

---

## Development

```bash
npm run dev              # nodemon src/server.js
npm run start            # node src/server.js
```

Full stack (with Graphiti, PostgreSQL, FalkorDB, LocalStack):
```bash
# from repo root
npm run docker:start
```

---

## Shared Modules (`src/shared/`)

The gateway vendors copies of shared logic from `quorum-mcp` directly under `src/shared/`. There is **no npm dependency** on `@as-quorum/mcp` — this decouples the Docker build from the MCP repo entirely.

When either repo changes shared logic (queries, audit, constitutional rules), the files must be manually synced.

| File | Purpose |
|------|---------|
| `config/schema.js` | QuorumConfigSchema (zod) |
| `config/loader.js` | Config resolution + cache (`loadConfig`); `getConfig` throws when unloaded, `getConfigSafe`/`isConfigLoaded` are non-throwing; env fallback is infallible (never leaves `_config` null) |
| `config/migrations.js` | PostgreSQL schema migrations — `q_*` id schema (`q_projects`, `q_keys`) |
| `graph/schema.js` | KnowledgeStatus enum |
| `graph/queries.js` | SQL query helpers — always pass a real `pg.Pool` |
| `graph/client.js` | Graphiti HTTP client (`searchNodes`, etc.) — `BLOCKED_METHODS` enforces no hard delete |
| `audit/chain.js` | SHA256 tamper-evident chain helpers |
| `audit/secondary.js` | `writeAuditEntry` / `updateEntry`-throw / `deleteEntry`-throw — append-only |
| `governance/constitutional.js` | Constitutional enforcement (self-approval, reason checks) |
| `graph/validate.js` | `validateKnowledgeInput(fields, opts)` + `ValidationError` — shared validation for all knowledge write routes; vendored copy in quorum-mcp |

> Note: deploying a `shared/` fix to a running local stack requires `docker compose build gateway && docker compose up -d gateway` (the dev container runs a baked image, not a bind-mounted `src/` — use `docker-compose.dev.yml`'s overlay for live-reload during active development instead).
>
> Full dated history of fixes to these shared modules: [../docs/CHANGELOG.md](../docs/CHANGELOG.md)

---

## Environment Variables

```bash
QUORUM_GATEWAY_PORT=3001
POSTGRES_HOST / POSTGRES_PORT / POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD
GRAPHITI_URL=http://graphiti:8000
FALKORDB_HOST=falkordb  FALKORDB_PORT=6379
QUORUM_CONFIG_BUCKET=quorum-configs
QUORUM_DDB_USER_PROJECTS_TABLE=quorum-user-projects
QUORUM_SYNC_SECRET=<static-secret>        # EventBridge sync token (optional)
REDIS_URL=redis://redis:6379               # Redis for config + profile + admin cache
QUORUM_CONFIG_CACHE_TTL=300                # seconds
QUORUM_PROFILE_CACHE_TTL=300               # seconds
QUORUM_ADMIN_CACHE_TTL=300                 # seconds
QUORUM_FIRST_ADMIN=<github-username>       # seeded into configs/.quorum on setup
AWS_REGION / AWS_ENDPOINT_URL / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
OPENAI_API_KEY=sk-...                      # governance LLM
```

For local dev, LocalStack provides S3 + DynamoDB at `http://localhost:4566`. Use `awslocal` CLI.

---

## Security

- JWT algorithm: ES256 (ECDSA P-256) — never accept HS256
- `verify-jwt.js` attaches `req.user = { sub, is_admin, project, role, base_confidence, is_owner }` (v0.3 slim JWT — `team` and `method` are not present; role/base_confidence/is_owner resolved from Redis profile cache per-request)
- `principal_architect` role required for config writes and sync endpoint
- Rate limiting applied to all routes
