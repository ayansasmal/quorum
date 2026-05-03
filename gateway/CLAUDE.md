# @as-quorum/gateway

Private self-hosted server. Enterprise teams run this alongside Graphiti, PostgreSQL, FalkorDB, and (optionally) LocalStack.

Not published to npm. Teams check out the repo from GitHub and deploy via Docker Compose or Helm.

---

## Purpose

HTTP gateway sitting between the MCP server and persistence layers. Responsibilities:

- **Auth:** GitHub OAuth → ES256 JWT (ECDSA P-256) + refresh tokens. JWKS at `/.well-known/jwks.json`.
- **Identity:** Injects `group_id` from JWT into every Graphiti call so projects are isolated.
- **Config:** S3-backed project config with DynamoDB read-through cache.
- **Audit API:** `/pg/*` routes expose PostgreSQL operations to the MCP over HTTP.
- **Rate limiting:** Per-IP, configurable via env.

Runs on port **3001** by default.

---

## Key Files

```
src/
  server.js               — Express app entry point
  routes/
    auth.js               — GitHub OAuth, JWT issue/refresh/revoke
    pg.js                 — All PostgreSQL REST routes (/pg/versions/*, /pg/audit/*, /pg/pending/*)
    graphiti.js           — Proxy to Graphiti MCP with group_id injection
    config.js             — GET/PUT project config
    schema.js             — GET /schema/config (public JSON Schema)
    jwks.js               — GET /.well-known/jwks.json
    sync.js               — POST /sync/configs (S3→DDB sync, EventBridge-compatible)
    bump.js               — PATCH /bump (confidence bump endpoint)
    projects.js           — GET /auth/projects, POST /auth/switch
    dashboard.js          — Dashboard BFF routes
    oauth.js              — OAuth state helpers
  middleware/
    verify-jwt.js         — ES256 JWT verification, attaches req.user
    project.js            — Injects project scope from JWT
    rate-limit.js         — Rate limiting middleware
  keys.js                 — ES256 key generation/loading
  config-cache.js         — In-memory config cache
  ddb.js                  — DynamoDB client (quorum-configs + quorum-user-projects tables)
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

## Workspace Import

Imports from `@as-quorum/mcp` via npm workspaces:
- `@as-quorum/mcp/config/schema` — QuorumConfigSchema
- `@as-quorum/mcp/graph/queries` — shared SQL query functions (used with real pg.Pool)
- `@as-quorum/mcp/graph/client` — Graphiti client
- `@as-quorum/mcp/audit/secondary` — Audit log functions (used with real pg.Pool)
- `@as-quorum/mcp/governance/constitutional` — Constitutional enforcement

When calling functions from `graph/queries` and `audit/secondary`, always pass a real `pg.Pool`. The duck-type guards in those files will fall through to the SQL path.

---

## Environment Variables

```bash
QUORUM_GATEWAY_PORT=3001
POSTGRES_HOST / POSTGRES_PORT / POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD
GRAPHITI_URL=http://graphiti:8000
FALKORDB_HOST=falkordb  FALKORDB_PORT=6379
QUORUM_CONFIG_BUCKET=quorum-configs
QUORUM_DDB_CONFIGS_TABLE=quorum-configs
QUORUM_DDB_USER_PROJECTS_TABLE=quorum-user-projects
QUORUM_SYNC_SECRET=<static-secret>        # EventBridge sync token (optional)
AWS_REGION / AWS_ENDPOINT_URL / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
```

For local dev, LocalStack provides S3 + DynamoDB at `http://localhost:4566`. Use `awslocal` CLI.

---

## Security

- JWT algorithm: ES256 (ECDSA P-256) — never accept HS256
- `verify-jwt.js` attaches `req.user = { sub, project, role, team, method, base_confidence }`
- `principal_architect` role required for config writes and sync endpoint
- Rate limiting applied to all routes
