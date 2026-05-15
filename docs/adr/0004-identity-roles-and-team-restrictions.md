# ADR-0004: Identity, Roles, and Team Restrictions

**Status:** Accepted  
**Date:** 2026-05-16  
**Deciders:** Platform team

---

## Context

**Requirement:** The system must enforce that only authorised people can approve
knowledge in sensitive domains (FR-04, FR-05). An agent or a junior engineer
should not be able to approve a security constraint or an architectural decision.

**Requirement:** Identity must be reliable — the system cannot trust a caller
who self-declares their role or team (NFR-05).

In v0.1–v0.2 the JWT carried role, team, and project directly as claims. This
created two problems:
1. **Fat JWT** — every claim was issued at login time; role changes required
   token rotation, creating stale-privilege windows
2. **No server-side enforcement** — a client that forged a JWT claim (or simply
   used an old token) could escalate privileges without detection

## Decision

### Identity resolution chain

The MCP server resolves the author identity in the following order (first non-null wins):
1. Authenticated identity from the gateway JWT (`sub` claim)
2. `QUORUM_AUTHOR` environment variable (for CI contexts)
3. `git config user.email`
4. `anonymous`

The resolved identity flows into every tool call. It cannot be overridden by the
caller (the `author` field was removed from all tool input schemas in v0.2+).

### Roles

Roles are not stored in the JWT (v0.3 slim JWT carries only `sub` and `is_admin`).
They are resolved from the profile cache on each request:

| Role | Capabilities |
|------|-------------|
| `principal_architect` | Full access; highest `base_confidence`; can approve in any domain |
| `senior_engineer` | Can review and approve in their domains |
| `engineer` | Can write and review; cannot approve restricted domains |
| `junior_engineer` | Can write; limited review access |
| `is_admin` | Platform-level administration; can manage project config, users |
| `is_owner` | Project ownership; can transfer ownership, update roles |

The `agent` identity (claude) is treated as having confidence floor 0.65 and
cannot approve its own DRAFTs (constitutional Rule 4).

### Team restrictions

Projects can restrict reviewer access per domain in `quorum.json`:

```json
{
  "domains": {
    "security": {
      "required_reviewer_teams": ["security-team", "principal-architects"]
    },
    "payments": {
      "required_reviewer_teams": ["payments-team"]
    }
  }
}
```

When `required_reviewer_teams` is non-empty, the `review()` tool checks the
reviewer's team against the list before allowing approval. This check is enforced
in the MCP tool layer (`src/tools/review.js: enforceReviewerTeam()`).

When `required_reviewer_teams` is empty or absent, any team may review.

### Project membership

Project membership is managed in `quorum.json` under the `members` array. Each
member has:
- `github_username` — their identity
- `role` — one of the roles above
- `team` — the team they belong to
- `base_confidence` — optional override of the role default

The `POST /config/update-role` endpoint allows owners and admins to update
member roles. Role changes invalidate the profile cache immediately, taking
effect on the next request.

### Session identity (MCP + Gateway)

The complete identity object attached to each request (`req.user` in gateway,
`identity` in MCP handler signatures):

```typescript
{
  sub: string          // GitHub username (from JWT)
  is_admin: boolean    // Platform admin flag (from JWT)
  project: string      // Active project group_id (from X-Quorum-Project header)
  role: string | null  // Resolved from profile cache
  base_confidence: number | null
  is_owner: boolean
}
```

## Consequences

**Positive:**
- Role changes take effect immediately (profile cache TTL = 5 minutes; forced
  invalidation on `update-role`)
- Slim JWT cannot be used to forge a role — role is always resolved server-side
- Domain team restrictions prevent cross-team approval without config changes

**Negative:**
- One extra server roundtrip per request (JWT verify → profile cache lookup)
- If DDB (profile store) is unavailable, the gateway falls back to a stale cached
  profile — role enforcement degrades gracefully but does not fail hard
- Post-Phase-3 clients sending `q_p{n}` as `X-Quorum-Project` require an extra
  DB lookup to resolve the `group_id` for profile matching (see `verify-jwt.js`)

**Required by this decision:**
- `verify-jwt.js` must resolve role from profile cache, never from JWT claims
- Profile cache must be invalidated on role update (Redis `DEL profile:{username}`)
- The `author` field must be absent from all MCP tool input schemas
- `enforceNoSelfApproval()` must compare the resolved identity, not any caller-provided name
