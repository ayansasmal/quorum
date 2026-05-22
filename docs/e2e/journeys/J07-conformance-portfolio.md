# J07 — Conformance Scoring & Portfolio Intelligence

**Scenario ID:** S-07
**Weight:** 50 (25 raw leaves × F2)
**Blast radius:** 5.4% of suite
**Frequency tier:** F2 (weekly — conformance checked on scans and reviews)
**Spec file:** `tests/e2e/scenarios/07-conformance-portfolio.spec.js`

---

## What It Covers

The full UNCERTIFIED → CERTIFIED lifecycle as a global catalog grows from sparse to populated.
Conformance score degrades as deviations accumulate and improves as deferrals are actioned.
Executive roles (director, VP) access the portfolio endpoint; non-portfolio roles are blocked.

**Roles:** `test-pe` (seeds catalog, scores), `test-architect` (records deviations, actions), `test-director`, `test-vp` (portfolio), `test-engineer` (blocked from portfolio)
**Touches:** `GET /api/conformance`, `GET /api/portfolio`, `/stats` page (ConformanceCard)
**Automated:** Yes — API + Playwright

---

## Setup

Fresh state for this scenario. This scenario seeds its own global catalog.

---

## Steps

### Part A — UNCERTIFIED: No globals linked

1. `GET /api/conformance` as `test-pe`, project = `quorum-test-project` (no globals linked yet):
   - Assert: `status: "UNCERTIFIED"`
   - Assert: message includes "no linked global catalogs" (or similar)

---

### Part B — UNCERTIFIED: Linked but sparse (< 10 entries)

2. Upload `quorum-test-catalog` and link `quorum-test-project` to it.
   - Seed 5 ACTIVE entries in `quorum-test-catalog` (below the 10-entry threshold)

3. `GET /api/conformance`:
   - Assert: `status: "UNCERTIFIED"`
   - Assert: `catalogs[0].entry_count: 5` (count shown in response)
   - Assert: message includes the entry count context

4. Navigate to `/stats`
   - Assert: ConformanceCard shows grey `UNCERTIFIED` badge (not a numeric score)

---

### Part C — UNCERTIFIED: Linked + 10 entries but no scan

5. Seed 5 more entries (total = 10 ACTIVE in catalog).
   - Do NOT insert a `project_scans` record yet.

6. `GET /api/conformance`:
   - Assert: `status: "UNCERTIFIED"`
   - Assert: message includes "no scans have been run" context

---

### Part D — CERTIFIED: Unlock with scan + no deviations

7. Insert a `project_scans` record for `quorum-test-project` (simulates one completed scan):
   ```sql
   INSERT INTO project_scans (q_project_id, scan_count, last_scan_at)
   VALUES ($projectId, 1, NOW())
   ON CONFLICT (q_project_id) DO UPDATE SET scan_count = 1, last_scan_at = NOW()
   ```

8. `GET /api/conformance`:
   - Assert: `status: "CERTIFIED"`, `score: 100` (no deviations = perfect score)
   - Assert: `scan_count: 1`, `last_scan_at` present

9. Navigate to `/stats`
   - Assert: ConformanceCard shows green score badge (score = 100)
   - Assert: breakdown bar visible (all segments zero except RESOLVED at empty)

---

### Part E — Score degradation with deviations

10. Record 2 OPEN deviations via `test-architect`:
    - Both linked to `quorum-test-catalog`, topics matching catalog entry topics

11. `GET /api/conformance`:
    - Assert: `score < 100`
    - Assert: `breakdown.open: 2`
    - Assert: Navigate to `/stats` → score badge now amber or red depending on severity

12. Action one deviation as `ACCEPTED` (weight = 1.0 — same as OPEN):
    - `POST /api/deviations/:id/action` with `action_type: "accept"`, valid reason
    - `GET /api/conformance` → Assert: score **unchanged** (accepted = same weight as open)
    - Assert: `breakdown.accepted: 1`, `breakdown.open: 1`

13. Defer the remaining OPEN deviation for 30 days (weight = 0.6):
    - `POST /api/deviations/:id/action` with `action_type: "defer"`, `defer_until` = 30 days from now
    - `GET /api/conformance` → Assert: score **improves** compared to step 11
    - Assert: `breakdown.deferred: 1`

14. `GET /api/conformance?include_details=true`:
    - Assert: `top_deviations` array present
    - Assert: entries sorted by `severity DESC`
    - Assert: at most 10 items returned

---

### Part F — Portfolio access by role

15. `GET /api/portfolio` as `test-director`:
    - Assert: `200`
    - Assert: response includes `projects` array containing `quorum-test-project`
    - Assert: project entry has `conformance_score`, `status`, `last_scan_at`

16. `GET /api/portfolio` as `test-vp` (vp_engineering):
    - Assert: `200` (vp_engineering is in PORTFOLIO_ROLES)

17. `GET /api/portfolio` as `test-engineer`:
    - Assert: `403` (engineer not in portfolio roles)

18. `GET /api/portfolio` as `test-pe` (principal_architect):
    - Assert: `200` (PA always has portfolio access)

---

## Pass Criteria

- [ ] UNCERTIFIED: no globals linked → message about missing catalog link
- [ ] UNCERTIFIED: linked but < 10 entries → message with entry count shown
- [ ] UNCERTIFIED: 10 entries but `scan_count = 0` → message about missing scan
- [ ] CERTIFIED: 10+ entries + scan_count ≥ 1 → score = 100 (no deviations)
- [ ] Stats page shows grey badge for UNCERTIFIED, green badge for CERTIFIED score=100
- [ ] OPEN deviations reduce score below 100
- [ ] ACCEPTED weight = 1.0 — accepting a deviation does NOT improve the score
- [ ] DEFERRED weight = 0.6 — deferring improves the score vs OPEN
- [ ] `include_details: true` returns `top_deviations` sorted by severity DESC, max 10
- [ ] director → `200` on portfolio
- [ ] vp_engineering → `200` on portfolio
- [ ] engineer → `403` on portfolio
- [ ] principal_architect → `200` on portfolio

---

## Teardown

```javascript
// Remove test catalog, test project links, project_scans, all deviations
```

---

## Notes

**ACCEPTED weight = 1.0 is intentional.** Accepting a deviation acknowledges the deviation is real
and owned. The incentive to accept is governance maturity (audit trail), not a score reward.
The score remains honest: the deviation exists, it just has an owner.

**DEFERRED weight = 0.6** signals active remediation intent. The score improves marginally
to reflect that the team has committed to addressing it.
