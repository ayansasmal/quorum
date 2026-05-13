# @as-quorum/gateway

**Quorum Gateway** — the Express service that fronts Graphiti and PostgreSQL for all Quorum clients (MCP server and Dashboard).

Handles GitHub OAuth, issues ES256 slim JWTs, resolves per-request project context via `X-Quorum-Project` header, caches project configs and user profiles in Redis, and proxies authenticated traffic to Graphiti MCP.

> Not published to npm. Deployed by enterprise platform teams alongside the database stack. See [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) for production setup.

---

## Responsibilities

| Concern | Implementation |
|---------|---------------|
| Authentication | GitHub OAuth → ES256 slim JWT `{ sub, is_admin }` via `routes/auth.js` |
| PKCE OAuth 2.1 | MCP client flow via `routes/mcp-oauth.js` (RFC 8414 discovery) |
| Identity resolution | `middleware/verify-jwt.js` — two-step: JWT verify → `loadUserProfile(sub)` from Redis/DDB |
| Project context | `X-Quorum-Project` header → `req.user.project`, role, base_confidence, is_owner |
| Config cache | Redis `config:{group_id}` TTL 300s → S3 on miss; pub/sub invalidation via `quorum:invalidate` |
| Profile cache | Redis `profile:{sub}` TTL 300s → DynamoDB on miss |
| Admin config | Redis `admin:platform` TTL 300s → S3 `configs/.quorum` on miss |
| Knowledge writes | `routes/pg.js` — version inserts, status transitions, audit chain |
| BFF API | `routes/dashboard.js` — aggregated endpoints for React dashboard |
| Search | `GET /api/search` — Graphiti semantic search with PG ILIKE fallback |
| Graphiti proxy | `routes/graphiti.js` — JWT-gated HTTP proxy, `group_id` injected |
| Governance | `routes/governance.js` — LLM conflict detection via OpenAI |
| Config management | `routes/config.js` — transfer ownership, update role |
| Admin management | `routes/admin.js` — admin user CRUD, `configs/.quorum` |
| User profiles | `routes/user.js` — `GET /user/profile/:username` |
| S3↔DDB sync | `routes/sync.js` — EventBridge-compatible full config sync |
| JWKS | `routes/jwks.js` — public key endpoint for JWT verification |

---

## Route Overview

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Stack liveness check |
| `GET` | `/.well-known/oauth-authorization-server` | None | RFC 8414 discovery |
| `GET` | `/.well-known/jwks.json` | None | Public key for JWT verification |
| `GET` | `/schema/config` | None | JSON Schema for `*.quorum.json` configs |
| `POST` | `/auth/github` | None | Start GitHub OAuth |
| `GET` | `/oauth/callback` | None | GitHub OAuth callback |
| `POST` | `/auth/token` | GitHub token | Issue slim ES256 JWT |
| `POST` | `/auth/refresh` | Refresh token | Refresh slim JWT |
| `GET` | `/auth/projects` | — | **410 Gone** — use `GET /user/profile/:username` |
| `POST` | `/auth/switch` | — | **410 Gone** — use `X-Quorum-Project` header |
| `GET` | `/oauth/authorize` | None | PKCE authorization endpoint |
| `POST` | `/oauth/token` | PKCE | Exchange auth code for slim JWT |
| `GET` | `/user/profile/:username` | JWT | Redis → DDB profile: role, projects, base_confidence |
| `GET` | `/api/stats` | JWT | Aggregate knowledge stats |
| `GET` | `/api/graph` | JWT | Graph nodes + edges for visualization |
| `GET` | `/api/knowledge` | JWT | Paginated knowledge browser |
| `GET` | `/api/knowledge/:topic/:key` | JWT | Single entry with content resolution |
| `GET` | `/api/search` | JWT | Semantic search (Graphiti → PG ILIKE fallback) |
| `GET` | `/api/pending` | JWT | Pending conflicts and DRAFTs |
| `GET` | `/api/pending/:id` | JWT | Single pending decision detail |
| `POST` | `/api/bump/:topic/:key` | JWT | Confidence endorsement (7-day cooldown) |
| `GET` | `/pg/versions/:topic/:key` | JWT | Current ACTIVE version |
| `GET` | `/pg/versions/:topic/:key/history` | JWT | Full version chain |
| `GET` | `/pg/versions/drafts` | JWT | All DRAFT entries for project |
| `GET` | `/pg/versions/by-status/:status` | JWT | Filter versions by status |
| `POST` | `/pg/versions` | JWT | Insert new version (with audit pipeline) |
| `POST` | `/pg/versions/:id/approve` | JWT | DRAFT → ACTIVE |
| `GET` | `/pg/audit` | JWT | Audit entries `{ entries: [...] }` |
| `GET` | `/pg/audit/lineage/:topic/:key` | JWT | Full audit lineage chain |
| `GET` | `/pg/pending` | JWT | Pending decisions |
| `POST` | `/pg/pending` | JWT | Insert pending decision |
| `PUT` | `/pg/pending/:id` | JWT | Resolve pending decision |
| `GET` | `/config` | JWT | Current project config |
| `PUT` | `/config` | JWT (owner) | Update project config |
| `POST` | `/config/transfer-ownership` | JWT (owner/admin) | Transfer project ownership |
| `POST` | `/config/update-role` | JWT (owner/admin) | Update member role |
| `GET` | `/admin/config` | JWT (admin) | Platform admin config |
| `POST` | `/admin/users` | JWT (admin) | Add/remove platform admins |
| `POST` | `/sync/configs` | Sync token / JWT | S3→DDB full config sync |
| `POST` | `/graphiti/*` | JWT | Graphiti MCP proxy (group_id injected) |
| `GET` | `/governance/detect-conflict` | JWT | LLM conflict detection |

---

## Middleware Stack

```
Request
  └─ rate-limit.js         — per-IP rate limiting (express-rate-limit)
  └─ verify-jwt.js         — async two-step:
       1. jwtVerify(token, ES256 public key) → { sub, is_admin }
       2. loadUserProfile(sub) → Redis hit or DDB query + Redis write-back
       3. read X-Quorum-Project header → role, base_confidence, is_owner
       → req.user = { sub, is_admin, project, role, base_confidence, is_owner }
  └─ project.js            — guards project-scoped routes (400 if req.user.project null)
  └─ route handler
```

---

## Identity Model (v0.3)

```
JWT claims:   { sub: "ayansasmal", is_admin: false, jti, exp, iat }
              ─── NO project, role, team, base_confidence in JWT ───

Per-request:  X-Quorum-Project: amethyst-munchkin  →  project scope
              Redis GET profile:ayansasmal          →  role + is_owner
              DDB getUserProjects() on cache miss   →  write back to Redis
```

This separation means a user's project membership and role changes take effect on the next request (Redis TTL ≤ 300s) without requiring a new JWT.

---

## Key Design Decisions

**PostgreSQL `summary` column is the canonical content store.** Every `remember()` call writes `content` to `knowledge_versions.summary`. Graphiti/FalkorDB holds semantic embeddings for vector search but is treated as eventually consistent — it can be wiped without permanent knowledge loss. The `GET /api/knowledge/:topic/:key` endpoint reads `summary` first and only falls back to `searchNodes()` for legacy entries written before v0.3.

**`group_ids` omitted from all Graphiti search calls.** FalkorDB's RediSearch query engine treats `-` as a NOT operator, which silently breaks any project with a hyphenated `group_id` (e.g., `amethyst-munchkin`). Project isolation is handled by the PostgreSQL queries that enrich or post-filter Graphiti results.

---

## Development

```bash
# From repo root
npm run dev:gateway         # nodemon src/server.js — hot reload
npm test                    # vitest (gateway integration tests in tests/gateway/)

# Or from this directory
npm install
npm run dev
npm test
```

**Environment:** copy `../.env.example` → `../.env`, set `OPENAI_API_KEY`. Start the full stack first:

```bash
cd .. && ./scripts/setup.sh docker
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QUORUM_GATEWAY_PORT` | `3001` | Listen port |
| `POSTGRES_HOST/PORT/DB/USER/PASSWORD` | — | PostgreSQL connection |
| `GRAPHITI_URL` | `http://graphiti:8000` | Graphiti MCP base URL |
| `REDIS_URL` | `redis://redis:6379` | Redis for config + profile + admin cache |
| `QUORUM_CONFIG_CACHE_TTL` | `300` | Config cache TTL (seconds) |
| `QUORUM_PROFILE_CACHE_TTL` | `300` | Profile cache TTL (seconds) |
| `QUORUM_ADMIN_CACHE_TTL` | `300` | Admin config cache TTL (seconds) |
| `QUORUM_CONFIG_BUCKET` | `quorum-configs` | S3 bucket for project configs |
| `QUORUM_DDB_USER_PROJECTS_TABLE` | `quorum-user-projects` | DynamoDB membership index |
| `QUORUM_SYNC_SECRET` | — | Static token for EventBridge sync auth |
| `QUORUM_FIRST_ADMIN` | — | GitHub username seeded into `configs/.quorum` on setup |
| `AWS_REGION/ENDPOINT_URL/...` | — | AWS / LocalStack config |
| `OPENAI_API_KEY` | — | LLM calls for conflict detection |

Full defaults: [../.env.example](../.env.example)
