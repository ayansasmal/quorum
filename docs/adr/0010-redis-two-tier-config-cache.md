# ADR-0010: Redis Two-tier Config and Profile Cache

**Status:** Accepted  
**Date:** 2026-05-16  
**Deciders:** Platform team

---

## Context

**Requirement:** Engineers must be able to use Quorum from Claude Code without
running local infrastructure (NFR-04). This implies a central deployment model
where config is fetched from a shared store.

**Requirement:** Config reads must be fast — every MCP tool call triggers a
config lookup to resolve project membership and roles (NFR-01).

**Requirement:** Config updates (role changes, ownership transfers) must be
reflected across all connected clients within seconds, not hours (NFR-05).

In v0.2, config was cached in DynamoDB with an in-process Map as an L1 cache:

```
In-process Map (L1)
    ↓ miss
DynamoDB (L2, quorum-configs table)
    ↓ miss
S3 (authoritative store)
```

Three problems with this model:

1. **DynamoDB as config cache is over-engineered** — DynamoDB is provisioned
   capacity, has cold-start latency, and requires IAM setup. For a cache that
   serves sub-second config reads, a Redis TTL entry is simpler and faster.

2. **No multi-instance invalidation** — the in-process Map cache had no
   cross-instance invalidation. Multiple gateway instances (e.g., in a Kubernetes
   Deployment) would each hold stale config until their individual TTL expired.
   A role change was visible to whichever instance the engineer happened to hit.

3. **Profile data in the wrong table** — the `quorum-configs` DDB table stored
   project configs (S3 mirror). The profile system (`quorum-user-projects`) is
   a separate table with a GSI. Two DynamoDB tables, two access patterns, two
   cache invalidation paths. Unifying under Redis simplifies the cache layer.

## Decision

### Three-tier write path (S3 authoritative)

S3 remains the authoritative store for all config:

```
S3 (authoritative, flat bucket: <group_id>.quorum.json)
    ↑
    Write path: gateway → S3 → emit invalidation → Redis
    Read path:  Redis (hit) → response
                Redis (miss) → S3 → write-through → response
```

S3 is the source of truth. Redis is a write-through cache. DynamoDB (`quorum-configs`)
is retired as a config cache.

DynamoDB (`quorum-user-projects`) is retained for the membership index — it is not a
cache but a purpose-built membership store with a GSI on `github_username`. Redis
acts as a read-through cache in front of this table for profile lookups.

### Redis key space

| Key | Value | TTL |
|-----|-------|-----|
| `config:<group_id>` | Full JSON config blob | `QUORUM_CONFIG_CACHE_TTL` (default 300s) |
| `profile:<username>` | `{ projects: [...] }` | `QUORUM_PROFILE_CACHE_TTL` (default 300s) |
| `admin:platform` | Admin config blob | `QUORUM_ADMIN_CACHE_TTL` (default 300s) |

### Pub/sub invalidation channel

`quorum:invalidate` is a Redis pub/sub channel. All gateway instances subscribe
to it at startup via a separate ioredis subscriber connection (ioredis requires
a dedicated connection for pub/sub).

When a config or profile is mutated:

```javascript
// In config-cache.js
async function invalidateProject(groupId) {
  await redis.del(`config:${groupId}`)
  await redis.publish('quorum:invalidate', JSON.stringify({ type: 'config', key: groupId }))
}

async function invalidateProfile(username) {
  await redis.del(`profile:${username}`)
  await redis.publish('quorum:invalidate', JSON.stringify({ type: 'profile', key: username }))
}
```

Each subscribed instance drops its local Redis key on receipt. This is not
strictly necessary (Redis is already the shared cache — del on one instance
affects all), but the channel payload allows future optimisation: in-process
LRU cache per-instance that can be selectively invalidated without a Redis round-trip.

### `ioredis` singleton pattern

`gateway/src/redis.js` exports two singletons:
- `getRedis()` — command connection (get, set, del, publish)
- `getSubscriber()` — subscriber connection (subscribe only)

Both are lazy-initialised on first call. The subscriber connection is started
at server startup via `startInvalidationSubscriber()`, which registers the
message handler for `quorum:invalidate`.

### Config file naming convention

S3 key: `<group_id>.quorum.json` (flat bucket, no subdirectory prefixes).  
Redis key: `config:<group_id>`.  
Local dev: `<group_id>.quorum.json` in the working directory.

The `group_id` is the canonical project identifier throughout all layers
(see ADR-0006).

### Admin config

Platform-level admin config (`configs/.quorum`) is loaded at gateway startup
and cached at `admin:platform`. It holds the list of platform admins and
global settings. It is never client-provided — it is a server-side
configuration file managed by the platform team.

### Local dev: Redis on port 6380

To avoid conflict with FalkorDB which also uses a Redis protocol on `6379`,
the local Docker Compose maps Redis to host port `6380`:

```yaml
redis:
  image: redis:7-alpine
  ports:
    - "6380:6379"
  command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
```

`REDIS_URL=redis://localhost:6380` in `.env` for local dev.
`REDIS_URL=redis://redis:6379` in Docker Compose inter-container networking.

## Consequences

**Positive:**
- Config reads are O(1) Redis lookups — sub-millisecond in a co-located deployment
- Role changes invalidate immediately via `invalidateProfile()` — no stale window
- Multi-instance deployments (Kubernetes Deployment with replica count > 1) all
  share the same Redis cache — no per-instance stale config islands
- DynamoDB `quorum-configs` table can be deprecated; one fewer table to provision
- `POST /sync/configs` (S3→DDB sync) now also warms Redis on ingest, replacing the
  DDB write path

**Negative:**
- Redis is a new infrastructure dependency — local dev requires Docker Compose
  to include the Redis service; production deployments must provision Redis
- If Redis is unavailable, every request falls through to S3/DDB on every call —
  increased latency and cost proportional to request volume
- Redis TTL-based eviction means config reads between writes and cache warm-up
  may briefly see stale data (TTL = 300s default) — this is acceptable because
  explicit invalidation covers the mutation paths
- The separate subscriber connection means two Redis connections per gateway
  instance (ioredis requirement for pub/sub)

**Required by this decision:**
- `getRedis()` must be the only path to Redis in the gateway — no direct `new Redis()`
  calls outside `redis.js`
- `startInvalidationSubscriber()` must be called in `server.js` before routes are
  registered, not lazily
- Every config mutation route (`/config/update-role`, `/config/transfer-ownership`,
  `POST /sync/configs`) MUST call the appropriate `invalidate*()` function
- `REDIS_URL` must be set in all deployment environments; gateway must refuse to
  start if Redis is unreachable (fail-fast, not silent degradation)
- The DynamoDB `quorum-configs` table must not be removed until all deployments
  have migrated to the Redis path and a data migration has confirmed no active reads
