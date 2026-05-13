# Quorum v0.3 — Architecture Plan

> Decisions finalised in design session: 2026-05-09.
> Covers: JWT redesign, Redis cache, governance model (owner + admin), user profile API.
>
> **Note:** HTTP MCP migration (stdio → HTTP/SSE transport, local proxy, offline buffer)
> is deferred to post-v1.0. `quorum-mcp` remains stdio for all v0.x releases.
> See ROADMAP.md → Future Vision for the HTTP/SSE migration plan.

---

## Goals

1. **JWT as pure identity** — `sub` only; all authorisation resolved from user profile
2. **Redis KV cache** — replaces DDB `quorum-configs` cache; profile cache with real-time invalidation
3. **Governance model** — `owner` role (project-level) + `admin` group (platform-level)
4. **User profile API** — single source of truth for project membership, roles, ownership

---

## Target Architecture

```
Engineer (Claude Code)
    ↓ stdio
quorum-mcp (stdio — unchanged transport)
    ↓ HTTP :3001
Quorum Gateway (Express)
    ├─ /auth         ← GitHub OAuth, JWT issue (sub only)
    ├─ /user         ← profile, project membership
    ├─ /admin        ← platform admin management
    ├─ /config       ← project config upload, transfer, role update
    ├─ /graphiti     ← proxied to Graphiti with group_id injection
    └─ /pg           ← PostgreSQL audit/version routes
         ↓                    ↓                 ↓              ↓
    Redis :6380          PostgreSQL :5432   Graphiti :8001   S3 / DDB
    (profile + config    (audit, versions)  (knowledge       (configs,
     cache, pub/sub)                         graph)           membership)
```

---

## 1. JWT Redesign — Pure Identity

### Decision
JWT is an identity token only. No project, role, team, confidence, or ownership claims.

### New JWT structure
```json
{
  "sub": "ayansasmal",
  "exp": 1234567890,
  "iat": 1234567890,
  "jti": "unique-token-id"
}
```

### What moves out of JWT
| Removed claim | Moves to |
|---|---|
| `project` | `X-Quorum-Project` request header (from `.quorum` file) |
| `role` | `GET /user/profile/{username}` → cached in Redis |
| `team` | User profile |
| `base_confidence` | User profile |
| `is_owner` | User profile (per project) |
| `permissions` | Derived from role + profile at request time |

### What stays in JWT
| Claim | Reason |
|---|---|
| `sub` | GitHub username — core identity |
| `is_admin` | Platform-level flag, rarely changes, needed before profile lookup |
| `exp` / `iat` / `jti` | Standard JWT fields |

### `verify-jwt.js` after change
```
1. Verify JWT signature → extract sub, is_admin
2. Read X-Quorum-Project header → active project context
3. Lookup profile(sub) from Redis cache → role, base_confidence, is_owner for active project
4. Attach to req.user = { sub, is_admin, project, role, base_confidence, is_owner }
```

### Token TTL
1 hour. Role changes take effect immediately via cache invalidation — not bound by JWT TTL.

---

## 2. Redis Cache Layer

### Decision
Redis replaces the DynamoDB `quorum-configs` cache table. Redis is the single cache layer
for all hot-path lookups. DynamoDB `quorum-user-projects` remains as the permanent
membership store (source of truth for profile queries).

### Docker Compose addition
```yaml
redis:
  image: redis:7-alpine
  ports:
    - "6380:6379"
  command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
```

Port `6380` to avoid conflict with FalkorDB on `6379`.

### Key space
```
config:{group_id}       → project config JSON        TTL: 5 min
profile:{username}      → user profile + all roles   TTL: 5 min
admin:platform          → configs/.quorum admin list  TTL: 5 min
```

### Cache invalidation — write-through + pub/sub
Every write to profile data immediately evicts the cache AND publishes an invalidation
event for multi-instance consistency:

```javascript
// Pattern used by every profile-mutating operation
await redis.del(`profile:${username}`)
await redis.publish('quorum:invalidate', `profile:${username}`)
await writeAuditEntry({ action, actor, target: username, ... })
```

All gateway instances subscribe:
```javascript
redis.subscribe('quorum:invalidate', (key) => localCache.delete(key))
```

### DynamoDB after change
| Table | Role after |
|---|---|
| `quorum-user-projects` | Permanent membership index — source of truth |
| ~~`quorum-configs`~~ | Retired — Redis replaces it |

### Production mapping
| Local | AWS |
|---|---|
| Redis :6380 (Docker) | ElastiCache Redis (or Upstash serverless) |
| LocalStack DDB | DynamoDB |

---

## 3. Governance Model — Owner + Admin

### 3a. `owner` field in project config

Added to `QuorumConfigSchema` as a required field:

```json
{
  "group_id": "platform-team",
  "owner": "ayansasmal",
  "members": [...],
  "roles": {...},
  "thresholds": {...}
}
```

The `owner` is the project's governance authority. Separate from `principal_architect`
(knowledge authority). They can be the same person or different.

| Role | Authority |
|---|---|
| `principal_architect` | Knowledge decisions, conflict resolution, confidence |
| `owner` | Role updates, ownership transfer, member management |
| `admin` (platform) | All of the above across ALL projects |

### 3b. Platform admin config — `configs/.quorum` in S3

Special S3 object. Loaded by gateway on startup, cached in Redis under `admin:platform`.

```json
{
  "admins": [
    { "github_username": "ayansasmal", "name": "Ayan", "added_at": "2026-05-09T...", "added_by": "system" }
  ],
  "version": 1,
  "updated_at": "2026-05-09T..."
}
```

Seeded by `setup.sh` on first deploy. Updateable via dashboard (admin-only action, audited).

### 3c. Ownership transfer rules

```javascript
function canTransferOwnership(actor, newOwner, isOwner, isAdmin) {
  if (isOwner) return true                         // current owner → anyone
  if (isAdmin && newOwner !== actor) return true   // admin → anyone except themselves
  return false
}
```

| Scenario | Allowed |
|---|---|
| Owner transfers to any member | ✅ |
| Admin transfers between members | ✅ |
| Admin assigns themselves as owner of another's project | ❌ |
| Owner with no successor removes themselves | ❌ — schema requires one owner |

### 3d. Bootstrap catch-22 (already fixed)

When a new user uploads their first project config, JWT has `role: none` (not yet in
any project). Fixed via self-validating bootstrap: if the JWT `sub` matches a
`principal_architect` in the uploaded config's `members` array, the upload is allowed.
This only applies to net-new projects (existing projects return 409 before any check).

---

## 4. User Profile API

### New endpoint: `GET /user/profile/{username}`

```
Auth: JWT required. Self: always allowed. Admin: any user. Others: shared-project members.

Response:
{
  "github_username": "ayansasmal",
  "is_admin": true,
  "projects": [
    {
      "group_id": "platform-team",
      "role": "principal_architect",
      "base_confidence": 0.90,
      "is_owner": true,
      "team": "platform"
    },
    {
      "group_id": "mobile-app",
      "role": "senior_engineer",
      "base_confidence": 0.80,
      "is_owner": false,
      "team": "mobile"
    }
  ]
}
```

Backed by `quorum-user-projects` DynamoDB table. Cached in Redis under `profile:{username}`.

### `GET /auth/projects` → replaced by profile endpoint

`GET /auth/projects` is retired. Callers use `GET /user/profile/{sub}` instead.
`POST /auth/switch` is retired. Project context moves to `X-Quorum-Project` header.

### New governance endpoints

```
POST /config/transfer-ownership
  body:  { to: "newowner", reason: "..." }
  auth:  owner OR admin (admin cannot self-assign)
  audit: always

POST /config/update-role
  body:  { github_username: "janedoe", role: "senior_engineer", reason: "..." }
  auth:  owner OR admin
  audit: always

GET  /admin/config
  auth:  admin only

POST /admin/users
  body:  { action: "add" | "remove", github_username: "...", reason: "..." }
  auth:  admin only
  audit: always
```

### Governance audit entry shape

```json
{
  "actor":       "ayansasmal",
  "actor_type":  "admin",
  "action":      "ownership_transfer",
  "project":     "platform-team",
  "from":        "alice",
  "to":          "bob",
  "reason":      "alice leaving team",
  "timestamp":   "2026-05-09T..."
}
```

All governance events go into the same PostgreSQL audit table as knowledge events.
Single timeline in the dashboard.

---

---

## Wave Sequencing

### Wave 1 — Foundation (unblocks everything)
1. Add Redis to Docker Compose + LocalStack equivalent
2. Implement `profileCache` using Redis
3. Retire DDB `quorum-configs` table — move config caching to Redis
4. Redesign JWT: remove project/role/team/confidence claims, keep sub + is_admin
5. Update `verify-jwt.js`: two-step auth (JWT verify → profile lookup)
6. Implement `GET /user/profile/{username}` backed by `quorum-user-projects` DDB
7. Add `X-Quorum-Project` header support throughout gateway middleware
8. Retire `POST /auth/switch` and `GET /auth/projects`

### Wave 2 — Governance model
1. Add `owner` field to `QuorumConfigSchema` (required)
2. Add `configs/.quorum` S3 object + gateway loading on startup
3. Seed `setup.sh` with first admin bootstrap
4. Implement `POST /config/transfer-ownership`
5. Implement `POST /config/update-role`
6. Implement `GET /admin/config` + `POST /admin/users`
7. Governance audit entries in PostgreSQL
8. Cache invalidation on every governance write (write-through + pub/sub)
9. Dashboard: ownership transfer UI, role editor, admin panel

### Wave 3 — Verification + cleanup
1. End-to-end test: engineer onboards new project, role shown correctly on next request
2. End-to-end test: role update → cache invalidated → next request reflects new role immediately
3. End-to-end test: admin transfers ownership → old owner loses rights → new owner gains them
4. Update ARCHITECTURE.md, ONBOARDING.md, DEPLOYMENT.md
5. Update openapi.yaml with new endpoints (`/user`, `/admin`, `/config/transfer-ownership`, `/config/update-role`)

---

## Files Created / Modified

### Gateway (`gateway/src/`)
```
routes/mcp.js              NEW — HTTP MCP endpoint (StreamableHTTPServerTransport)
routes/admin.js            NEW — admin management (/admin/config, /admin/users)
routes/user.js             NEW — user profile (/user/profile/{username})
routes/config.js           MOD — add transfer-ownership, update-role; bootstrap fix (done)
routes/auth.js             MOD — JWT now issues sub + is_admin only
routes/projects.js         MOD — retire auth/projects, retire auth/switch
middleware/verify-jwt.js   MOD — two-step: JWT verify → profile lookup
middleware/project.js      MOD — read X-Quorum-Project header
config-cache.js            MOD — Redis-backed, retire DDB quorum-configs
ddb.js                     MOD — remove quorum-configs table operations
redis.js                   NEW — Redis client singleton
shared/config/schema.js    MOD — add required owner field
```

### quorum-mcp (`src/`)
```
No changes — stdio transport unchanged for v0.3.
HTTP/SSE migration is post-v1.0. See ROADMAP.md → Future Vision.
```

### Infrastructure
```
docker-compose.yml         MOD — add redis service :6380
setup.sh                   MOD — seed configs/.quorum admin config in S3
.env.example               MOD — add REDIS_URL, remove QUORUM_SYNC_SECRET from MCP docs
```

---

## Environment Variables (additions)

```bash
# Gateway
REDIS_URL=redis://redis:6380                    # new
QUORUM_ADMIN_CACHE_TTL=300                      # seconds, default 300
QUORUM_PROFILE_CACHE_TTL=300                    # seconds, default 300

# quorum-mcp proxy
QUORUM_PROXY_PORT=8000                          # local proxy port, default 8000
QUORUM_GATEWAY_URL=http://localhost:3001        # unchanged
```

---

## Removed Concepts

| Removed | Replaced by |
|---|---|
| `POST /auth/switch` | `X-Quorum-Project` request header |
| `GET /auth/projects` | `GET /user/profile/{username}` |
| Role/team/project/confidence claims in JWT | Profile cache lookup per request |
| DDB `quorum-configs` cache table | Redis `config:{group_id}` key |

---

## Open Questions (pre-implementation)

1. **`configs/.quorum` bootstrap** — who runs `setup.sh` on a fresh enterprise deploy?
   First admin is seeded via env var or interactive prompt during setup.

2. **Profile cache TTL tuning** — 5 minutes is the starting point. May need to be
   shorter for high-churn teams (frequent role changes) or longer for stable orgs.
   Make it configurable via `QUORUM_PROFILE_CACHE_TTL` env var.
