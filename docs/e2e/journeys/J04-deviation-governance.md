# J04 — Deviation Governance Lifecycle

**Scenario ID:** S-04
**Weight:** 74 (37 raw leaves × F2) — updated: +2 leaves for denial_hint_count badge in Part F
**Blast radius:** 6.7% of suite (recalculated against 1107 suite total)
**Frequency tier:** F2 (weekly operational — deviations recorded on every code scan)
**Spec file:** `tests/e2e/scenarios/04-deviation-governance.spec.js`

---

## What It Covers

An agent records a deviation from a global standard, a PE/architect governs it (accept/deny/defer),
the constitutional enforcement on defer is validated, executive roles are confirmed read-only,
and an overdue deferral surfaces in the pending queue with correct conformance impact.

**Roles:** `test-architect` (records deviations), `test-pe` (governs), `test-director` (read-only)
**Touches:** `POST /api/deviations`, `POST /api/deviations/batch`, `GET /api/deviations`, `POST /api/deviations/:id/action`, `GET /api/conformance`, `/deviations` page, `/pending` page, `/stats` page
**Automated:** Yes — API + Playwright

---

## Setup

Seed global catalog `quorum-test-catalog` with 10+ ACTIVE entries via `test-pe`
(required to unlock CERTIFIED status for conformance scoring):

```javascript
// 10 entries across topics: security (3), auth (4), reliability (3)
// All written as test-pe (PA) so they land as ACTIVE immediately
const SEED_ENTRIES = [
  { topic: 'security', key: 'tls-minimum-version', content: 'All services must use TLS 1.3...' },
  { topic: 'security', key: 'secret-rotation',     content: 'Rotate secrets every 90 days...' },
  { topic: 'security', key: 'input-validation',    content: 'Validate and sanitize all inputs...' },
  { topic: 'auth',     key: 'token-expiry',        content: 'Access tokens expire in 1 hour...' },
  { topic: 'auth',     key: 'pkce-required',       content: 'All OAuth flows must use PKCE...' },
  { topic: 'auth',     key: 'mfa-policy',          content: 'MFA required for admin roles...' },
  { topic: 'auth',     key: 'session-timeout',     content: 'Sessions expire after 30 min...' },
  { topic: 'reliability', key: 'circuit-breaker',  content: 'All external calls need circuit breaker...' },
  { topic: 'reliability', key: 'retry-policy',     content: 'Exponential backoff: 3 retries max...' },
  { topic: 'reliability', key: 'health-endpoint',  content: 'Every service exposes /health...' },
]
```

Also register a `project_scans` entry to set `scan_count = 1` (required for CERTIFIED).

---

## Steps

### Part A — Record deviation (agent perspective)

1. `POST /api/deviations` as `test-architect`, project = `quorum-test-project`:
   ```json
   {
     "catalog_id": "quorum-test-catalog",
     "topic": "security",
     "key": "tls-minimum-version",
     "description": "Service uses TLS 1.2 on legacy internal endpoint /admin/health",
     "source": "code-review",
     "evidence": {
       "files": ["src/server.js"],
       "lines": ["L142"],
       "excerpt": "tls.createServer({ minVersion: 'TLSv1.2' })"
     }
   }
   ```
   - Assert: `status: "recorded"`, `severity` present (derived server-side ≥ 0.0), `is_new: true`

2. Same `POST /api/deviations` call again (idempotent re-scan):
   - Assert: `is_new: false`, `last_seen_at` updated (not a new row in DB)

### Part B — Deviation with invalid catalog link

3. `POST /api/deviations` with `catalog_id: "some-other-catalog"` (not in `quorum-test-project`'s globals):
   - Assert: `400`, body has `status: "not_linked"`

4. `POST /api/deviations` with valid `catalog_id` but `key: "nonexistent-key"`:
   - Assert: `404`, body has `status: "not_found"`

### Part C — Batch deviation (agent scan output)

5. `POST /api/deviations/batch` with 3 valid deviations (all linked to `quorum-test-catalog`):
   - Assert: `{ recorded: 3, failed: 0 }`

6. `POST /api/deviations/batch` with 5 deviations, one with invalid `catalog_id`:
   - Assert: `{ recorded: 4, failed: 1 }` — partial success, other 4 recorded

### Part D — Dashboard Deviations page

7. Log in as `test-architect`, project = `quorum-test-project`

8. Navigate to `/deviations`
   - Assert: table shows OPEN deviations recorded in Parts A + C

9. Filter by `status: OPEN` → results match expected OPEN count

10. Filter by `topic: security` → only security deviations shown

11. Filter by `severity_min: 0.7` → only deviations with severity ≥ 0.7 shown

### Part E — Accept action (architect)

12. Expand an OPEN deviation row → action panel appears

13. Click "Accept"
    - Reason textarea appears
    - Type fewer than 10 chars → submit button disabled (UI validation)
    - Type valid reason: `"Acknowledged — migration to TLS 1.3 tracked in JIRA-4521"`
    - Submit → deviation row shows `ACCEPTED` status badge

### Part F — Deny path with denial hint + Knowledge browser badge

14. Identify a deviation against the `security:tls-minimum-version` entry
    (which was authored by `test-pe` as PA with high confidence > 0.85).

15. Expand row → click "Deny" → type valid reason: `"This endpoint is internal-only and exempt per security team approval"`
    - Assert: denial hint text visible inline:
      `"This global standard was authored by a principal_architect with high confidence. Consider adding a project-level knowledge entry..."`
    - Submit → deviation shows `DENIED` status badge

16. Navigate to the Knowledge browser for `quorum-test-catalog` (the global project):
    - `GET /api/knowledge?project=quorum-test-catalog` (or via dashboard Knowledge page scoped to catalog)
    - Locate the `security:tls-minimum-version` entry
    - Assert: `denial_hint_count > 0` on the entry (at least 1 project has denied this standard)
    - Assert: the badge or field shows the numeric count (not just a boolean)

    > **`denial_hint_count` is surfaced on global catalog entries only.** It counts the number
    > of distinct projects that have issued a `deny` action against this specific global standard.
    > It allows PAs to identify standards that may be too prescriptive or need revision.
    > This badge is only visible when viewing entries in a global catalog project.

### Part G — Defer path (constitutional enforcement)

16. Click "Defer" on an OPEN deviation
    - Assert: only valid defer durations shown: 30 / 45 / 60 / 90 days (no free-form entry)

17. Select 30 days, submit with valid reason
    - Assert: `status: "DEFERRED"`, `defer_until` is exactly 30 days from now (±1 min tolerance)

18. Attempt defer via API directly with 31 days (bypassing UI):
    ```
    POST /api/deviations/:id/action
    { "action_type": "defer", "reason": "Testing invalid deadline", "defer_until": "<now + 31 days>" }
    ```
    - Assert: `400`, body includes `rule: "DEFER_DEADLINE"`

### Part H — Executive role (read-only, cannot action)

19. Log in as `test-director`, navigate to `/deviations`
    - Assert: deviations table visible and populated
    - Assert: no action panel expands when clicking an OPEN row (director cannot action)

20. `POST /api/deviations/:id/action` as `test-director` directly via API:
    - Assert: `403`, body includes `rule: "DEVIATION_ACTION_AUTHORITY"`

### Part I — Overdue deferral

21. Insert a deviation action directly into DB with `defer_until = NOW() - INTERVAL '1 day'`
    (simulates an expired defer without waiting):
    ```sql
    UPDATE deviation_actions SET defer_until = NOW() - INTERVAL '1 day'
    WHERE actor = 'test-architect' ORDER BY created_at DESC LIMIT 1
    ```

22. `GET /api/deviations?status=OVERDUE`
    - Assert: the manipulated deviation appears with `status: "OVERDUE"`

23. Navigate to `/pending`
    - Assert: "Overdue deferrals" section visible with the overdue item
    - Assert: item shows catalog, topic, key, severity, last_seen

24. `GET /api/conformance` as `test-architect`
    - Assert: overdue deviation contributes weight 1.0 (same as OPEN — deferral expired)

---

## Pass Criteria

- [ ] First deviation → `recorded`, `is_new: true`, `severity` derived server-side
- [ ] Re-scan same deviation → `is_new: false`, `last_seen_at` updated (idempotent)
- [ ] Not-linked catalog → `400 not_linked`
- [ ] Non-existent key → `404 not_found`
- [ ] Batch: 3 valid → `{ recorded: 3, failed: 0 }`
- [ ] Batch: 4 valid + 1 invalid → `{ recorded: 4, failed: 1 }`
- [ ] Dashboard filter by status, topic, severity_min all work correctly
- [ ] Accept from dashboard — reason < 10 chars blocked at UI level
- [ ] Denial hint appears when global entry confidence > 0.85 + authored by PA
- [ ] Defer with 31 days via API → `400 DEFER_DEADLINE` constitutional violation
- [ ] Defer with 30 days → `DEFERRED`, `defer_until` exactly 30 days from now
- [ ] Director cannot action deviations (403 with DEVIATION_ACTION_AUTHORITY rule)
- [ ] Overdue deviation appears in `/pending` overdue section
- [ ] Overdue deviation has weight 1.0 in conformance score (expired defer = full weight)
- [ ] After deny: `denial_hint_count > 0` on the global catalog entry (badge visible in Knowledge browser)
- [ ] `denial_hint_count` is a numeric count (not boolean)

---

## Teardown

```javascript
// Remove all deviations, deviation_actions, project_scans for this scenario
// Remove seeded global catalog entries
```

---

## Related Scenarios

- **S-07** (Conformance) — directly uses deviation status weights in scoring formula
- **S-05.5** (RBAC: deviation) — exhaustive role × action matrix for deviation endpoints
- **S-04** shares no state with S-07 — both set up their own catalog seed data
