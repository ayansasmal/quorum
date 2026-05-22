# J06 — Multi-User Conflict Resolution (UI Simulation)

**Scenario ID:** S-06
**Weight:** 45 (15 raw leaves × F3)
**Blast radius:** 4.8% of suite
**Frequency tier:** F3 (daily — concurrent writes are a normal team workflow)
**Spec file:** `tests/e2e/scenarios/06-multi-user-conflict.spec.js`

---

## What It Covers

Two engineers write conflicting knowledge simultaneously using separate Playwright browser contexts.
A PE sees both in pending, uses "Request Changes" to pause resolution, then resolves via
`coexist_split`. Tests the `more_pending_same_key` counter and stale warning on the second conflict.

**Roles:** `test-engineer` (context A), `test-senior` (context B), `test-pe` (resolver)
**Touches:** `POST /pg/versions`, `GET /pg/pending`, `POST /api/review/:id`, `/pending` page, `/knowledge` page
**Automated:** Yes — 3 Playwright browser contexts (engineerA, engineerB, PE)

---

## Setup

No prior state required. Each context authenticates independently via sessionStorage JWT injection.

---

## Steps

1. Open 3 Playwright browser contexts:
   - `ctxA` — authenticated as `test-engineer`
   - `ctxB` — authenticated as `test-senior`
   - `ctxPE` — authenticated as `test-pe`

2. **ctxA:** `POST /pg/versions` as `test-engineer`:
   - `topic: "auth"`, `key: "session-strategy"`
   - `content: "Stateless JWT sessions. No server-side state. Tokens are self-contained."`
   - Assert: `status: "ACTIVE"`, `version: 1`

3. **ctxB:** `POST /pg/versions` as `test-senior` on the same key:
   - `content: "Redis-backed sessions required. Stateless JWT has no revocation mechanism."`
   - `reason: "JWT sessions cannot be revoked before expiry — security risk"`
   - Assert: `status: "conflict_detected"`, `conflict_id` present

4. **ctxPE:** Navigate to `/pending`
   - Assert: conflict brief for `auth:session-strategy` visible
   - Assert: both versions shown (existing: JWT, incoming: Redis)
   - Assert: LLM enrichment section present (canned mock analysis)
   - Assert: `more_pending_same_key: 0` (only one conflict so far)

5. **ctxPE:** Click "Request Changes"
   - Note textarea: type valid note: `"Need the security team's input before resolving this"`
   - Submit
   - Assert: conflict remains in `/pending` with PE's note recorded
   - Assert: conflict status is `escalated` or similar (not resolved)

6. **ctxA:** `test-engineer` rewrites and re-submits with updated content:
   - `content: "Stateless JWT with short expiry (15 min) plus refresh token rotation. Revocation via token blocklist."`
   - `reason: "Addressed revocation concern — blocklist added"`
   - Assert: `status: "conflict_detected"` — a second conflict queued on same key

7. **ctxPE:** Refresh `/pending`
   - Assert: first conflict brief now shows `more_pending_same_key: 1`

8. **ctxPE:** Resolve first conflict via `supersede`:
   - Note: `"Approving updated JWT approach with revocation mechanism"`
   - Assert: `200`, first conflict resolved
   - Assert: `auth:session-strategy` is now ACTIVE (v2 from engineer-A's update)

9. **ctxPE:** Refresh `/pending`
   - Assert: second conflict (test-senior's version) now shows `stale_warning`
   - Assert: warning indicates active version advanced (v1→v2) since the conflict was queued

10. **ctxPE:** Resolve second conflict via `coexist_split`:
    - `split_existing_key: "auth-session-jwt"`, `split_incoming_key: "auth-session-redis"`
    - Note: `"Both session strategies are valid — contextual choice"`
    - Assert: `200`

11. **ctxA or ctxB:** Navigate to `/knowledge?domain=auth`
    - Assert: `auth:auth-session-jwt` visible as ACTIVE
    - Assert: `auth:auth-session-redis` visible as ACTIVE
    - Assert: original `auth:session-strategy` is SUPERSEDED (not ACTIVE)

---

## Pass Criteria

- [ ] Two simultaneous conflicting writes produce two conflict entries without interfering
- [ ] `more_pending_same_key` counter increments correctly when second conflict queued
- [ ] "Request Changes" keeps conflict in pending with PE's note stored
- [ ] After first resolution, second conflict shows `stale_warning` (active version advanced)
- [ ] `coexist_split` produces two new ACTIVE entries at the specified keys
- [ ] Original key (`auth:session-strategy`) is SUPERSEDED after the split
- [ ] Both new split entries visible in Knowledge browser under `auth` domain

---

## Teardown

```javascript
// Remove auth:session-strategy, auth:auth-session-jwt, auth:auth-session-redis
// Remove all conflict records created during this scenario
```
