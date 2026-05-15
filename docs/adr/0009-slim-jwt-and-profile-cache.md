# ADR-0009: Slim JWT and Profile Cache (v0.3)

**Status:** Accepted  
**Date:** 2026-05-16  
**Deciders:** Platform team

---

## Context

**Requirement:** Identity must be reliable — the system cannot trust a caller who
self-declares their role or team (NFR-05).

**Requirement:** Role changes must take effect immediately — a revoked or downgraded
role must not remain active for the lifetime of a cached token (NFR-05).

In v0.1–v0.2, the JWT carried all user attributes as claims:

```json
{ "sub": "alice", "project": "platform-team", "role": "senior_engineer",
  "team": "core", "base_confidence": 0.80 }
```

Three problems emerged at scale:

1. **Stale privilege window** — role changes required the engineer to get a new token.
   Until they did, the old role was enforced. On a 24-hour token TTL this was a
   multi-hour stale window.

2. **Fat JWT** — every gateway request decoded a token carrying 8+ fields. Adding
   a new attribute required a schema migration in the token issuance code AND in
   `verify-jwt.js` AND in client decoders (dashboard, MCP server).

3. **Project coupling** — carrying `project` in the JWT meant a single token was
   tied to a single project. Engineers working across projects needed one token per
   project, or a `POST /auth/switch` endpoint to re-issue. This made the auth flow
   brittle and the endpoint table larger than necessary.

4. **No Atlassian MCP alignment** — Atlassian's MCP OAuth 2.1 pattern separates
   identity (token = who you are) from resource context (request param = what you
   access). Quorum's v0.2 fat JWT conflated both in the token.

## Decision

### Slim JWT

The JWT carries only the stable, non-volatile identity attributes:

```json
{ "sub": "alice", "is_admin": false, "jti": "...", "iat": 1715000000, "exp": 1715086400 }
```

`sub` is the GitHub username. `is_admin` is a platform-level flag that changes
rarely. All other attributes (`role`, `team`, `base_confidence`, `project`) are
absent from the token.

### X-Quorum-Project header

Project context travels as an HTTP header on every request:

```
X-Quorum-Project: platform-team
```

The header accepts either the human-readable `group_id` slug or the `q_p{n}`
surrogate key (see ADR-0005 for resolution logic). This decouples identity from
project scope — the same token works for all projects the engineer belongs to.

### Two-step async `verify-jwt.js`

The middleware becomes async and runs two steps on every authenticated request:

1. **JWT verification** — ES256 signature check, expiry check → extract `sub`, `is_admin`
2. **Profile cache lookup** — `loadUserProfile(sub)` → `{ projects: [{group_id, role, team, base_confidence, is_owner}] }`

The profile lookup resolves the active project entry by matching `group_id` against
the `X-Quorum-Project` header. The resulting `req.user` object is:

```typescript
{
  sub: string          // from JWT
  is_admin: boolean    // from JWT
  project: string      // from X-Quorum-Project header
  role: string | null  // from profile cache
  base_confidence: number | null  // from profile cache
  is_owner: boolean    // from profile cache
}
```

### Profile cache (Redis → DynamoDB)

`loadUserProfile(username)` uses a two-tier cache:

- **Redis** `profile:{username}` — TTL from `QUORUM_PROFILE_CACHE_TTL` (default 300s)
- **DynamoDB** `quorum-user-projects` — GSI on `github_username` for O(1) lookup

Cache invalidation is immediate and active:
- `POST /config/update-role` calls `invalidateProfile(username)` synchronously
- `invalidateProfile` does `redis.del('profile:' + username)` AND publishes to
  `quorum:invalidate` channel for multi-instance propagation
- Any gateway instance subscribed to `quorum:invalidate` also drops its local copy

This means role changes take effect within milliseconds, not token-TTL hours.

### Retired endpoints

`GET /auth/projects` → `410 Gone` (was: list projects embedded in JWT)  
`POST /auth/switch` → `410 Gone` (was: re-issue JWT for different project)

Both are superseded by sending `X-Quorum-Project` directly on each request.

### Response body carries profile attributes

The token issuance response body still returns `role`, `team`, `project`,
`base_confidence` so clients (dashboard, MCP) can display the active user's context
without a separate profile fetch:

```json
{
  "token": "eyJ...",
  "role": "senior_engineer",
  "team": "core",
  "project": "platform-team",
  "base_confidence": 0.80
}
```

These are informational only — the gateway resolves them fresh from the profile cache
on every subsequent request.

## Consequences

**Positive:**
- Role changes take effect immediately (Redis TTL = 5 min, forced invalidation on
  `update-role` makes it instant in practice)
- Same token works across all projects — switching context requires only changing the
  `X-Quorum-Project` header, not a new token. Note: `POST /auth/token` still requires
  `project_id` at issuance for membership validation and to populate the response body's
  role/team fields; the token payload itself carries no project binding.
- JWT schema is stable: adding a new profile attribute (e.g. `is_owner`) requires
  only a profile cache schema change, not a token re-issuance
- Atlassian MCP OAuth 2.1 alignment: identity separated from resource context

**Negative:**
- Two round-trips per request: JWT verify + profile cache lookup (Redis makes the
  second trip ~1ms, but it exists)
- If Redis and DDB are both unavailable, the gateway has no profile to resolve;
  requests fail with 503 rather than degrading to stale-role
- Post-Phase-3 clients sending `q_p{n}` as `X-Quorum-Project` require an extra
  DB lookup to resolve `group_id` for profile matching — an O(1) `q_projects` query
  but a round-trip nonetheless

**Required by this decision:**
- `verify-jwt.js` must be async; all downstream middleware must `await next()` correctly
- JWT issuance (`POST /auth/token`, `/auth/refresh`) must produce ONLY slim JWT —
  no `project`, `role`, `team`, `base_confidence` in the token payload
- Profile cache must be invalidated synchronously on `update-role` — not deferred
- The `author` field must be absent from all MCP tool input schemas (identity comes
  from the JWT `sub` claim, not caller-supplied)
- Dashboard `AuthContext._applyJwt()` must accept the response body profile alongside
  the token to populate display fields that are no longer in the token
