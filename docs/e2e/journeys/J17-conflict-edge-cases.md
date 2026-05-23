# J17 — Conflict: Governance Edge Cases

**Scenario ID:** S-17
**Weight:** 32 (16 raw leaves × F2)
**Blast radius:** 3.3% of suite
**Frequency tier:** F2 (weekly — conflict edge cases exercise governance paths not on the happy-path)
**Spec file:** `tests/e2e/scenarios/17-conflict-edge-cases.spec.js`

---

## What It Covers

Four governance paths not covered by J02 or J06:

- **Auto-supersede** — when incoming authority score exceeds existing by more than `AUTHORITY_THRESHOLD`,
  conflict resolution fires without human involvement. No `pending_decision` is created. This is the
  only write path in Quorum with zero human intervention — it must have explicit test coverage.
- **PENDING_CONFLICT_CHECK fallback** — when Graphiti is unavailable during a write, the knowledge
  node is stored in PostgreSQL with status `PENDING_CONFLICT_CHECK` and surfaced in pending for
  retrospective conflict analysis once Graphiti recovers. Write must never fail due to Graphiti outage.
- **Cross-catalog conflict** — a project-local write that semantically contradicts an entry in a
  linked global catalog triggers conflict detection. The conflict brief identifies the global catalog
  entry as `existing` with `source: "global"`. Without this, a project can silently contradict
  a global standard.
- **Enrichment response shape** — the LLM enrichment object attached to a conflict brief must contain
  `analysis`, `risks_if_approved[]` (2–4 items), and `questions_for_reviewer[]` (2–3 items).
  S-02.2 asserts presence only; this scenario asserts structure.

**Roles:** `test-pe`, `test-engineer`
**Touches:** `POST /pg/versions`, `POST /api/knowledge`, `GET /pg/pending`, `GET /pg/audit/lineage`, docker compose
**Automated:** Yes — API (Part B requires `docker pause/unpause`; see setup note)

---

## Setup

```javascript
// quorum-test-project globals: ["quorum-test-catalog"] — must be configured before this scenario
// quorum-test-catalog must have ACTIVE entry:
//   topic: "auth", key: "global-standard"
//   content: "PKCE is required for all OAuth 2.0 flows. Implicit grant is deprecated."
//   Written by test-pe (PA) so it lands ACTIVE immediately
```

---

## Steps

### Part A — Auto-Supersede (GV-1)

> `shouldAutoSupersede()` in `authority.js` returns `true` when incoming authority delta exceeds
> `AUTHORITY_THRESHOLD` AND incoming is same or higher role tier. When triggered, `remember.js`
> calls `supersede()` directly — no `pending_decision` is created. This is the governance bypass
> path that requires explicit E2E coverage.

1. Record the current pending count before the test:
   ```javascript
   const pendingBefore = await GET('/pg/pending')
   const conflictCountBefore = pendingBefore.conflict_briefs?.length ?? 0
   ```

2. `POST /pg/versions` as `test-pe` — seed the existing entry with deliberately low confidence:
   - `topic: "auth"`, `key: "auto-sup-target-s17"`
   - `content: "Token auth via session cookies. Set-Cookie header on login."`
   - `confidence: 0.50`
   - Assert: `status: "ACTIVE"`, `version: 1`

3. `POST /pg/versions` as `test-pe` — write conflicting content with high confidence:
   - Same `topic: "auth"`, `key: "auto-sup-target-s17"`
   - `content: "Token auth via Bearer JWT in Authorization header. No session state."`
   - `confidence: 0.95`
   - `reason: "Migrating to stateless JWT after scaling incident — session store bottleneck"`
   - Assert: HTTP 200
   - Assert: `status` is NOT `"conflict_detected"` — it is `"stored"` or `"auto_superseded"`
   - Assert: no new `pending_decision` visible (`GET /pg/pending` conflict count unchanged)

4. `GET /pg/versions/auth/auto-sup-target-s17`
   - Assert: v2 is `ACTIVE`
   - Assert: v1 is `SUPERSEDED` (preserved — no hard delete)
   - Assert: no third version exists

5. `GET /pg/audit/lineage/auth/auto-sup-target-s17`
   - Assert: lineage records the supersede transition
   - Assert: `governance_json` on the OUTCOME entry contains `conflict_resolution: "auto_supersede"`
     or `triggered_by: "auto_supersede"` — distinguishes this from human-approved supersedes
   - Assert: no `reviewer` field in governance_json (no human reviewed this)

6. `GET /pg/pending` as `test-pe`
   - Assert: `conflict_briefs.length === conflictCountBefore` (unchanged — auto_supersede does not
     create a pending conflict)

> **Threshold calibration:** `AUTHORITY_THRESHOLD` is defined in `gateway/src/shared/governance/authority.js`.
> Read this value before running. The confidence delta of 0.50 → 0.95 produces an authority delta of
> approximately 0.14–0.16 on the composite score (confidence weight is 0.35 in the formula). If
> `AUTHORITY_THRESHOLD` is higher, adjust confidence values accordingly. Both writes are same-tier
> (PA → PA) so the tier gate passes regardless.

---

### Part B — PENDING_CONFLICT_CHECK (GV-2)

> When the Graphiti client throws during conflict detection, `storePendingConflictCheck()` is called.
> The write succeeds in PostgreSQL but conflict detection is deferred. Write non-failure under
> Graphiti outage is a reliability guarantee — this must be tested explicitly.

7. Pause Graphiti to simulate unavailability:
   ```bash
   docker pause quorum-graphiti
   sleep 2  # ensure the pause has taken effect before the next request
   ```
   If not using Docker Compose: temporarily set `GRAPHITI_URL=http://localhost:19999` (unreachable)
   in the gateway process and restart it.

8. `POST /pg/versions` as `test-engineer` while Graphiti is paused:
   - `topic: "infra"`, `key: "pending-check-s17"`
   - `content: "Use blue-green deployments for all production releases."`
   - Assert: HTTP 200 — write must NOT fail due to Graphiti unavailability
   - Assert: `status: "PENDING_CONFLICT_CHECK"` in response body

9. Resume Graphiti:
   ```bash
   docker unpause quorum-graphiti
   ```

10. `GET /pg/pending` as `test-pe`
    - Assert: response includes `infra:pending-check-s17` in a `pending_conflict_checks` section
      (or under a status filter for `PENDING_CONFLICT_CHECK` entries)
    - Assert: the entry shows the author (`test-engineer`), topic, key, and timestamp

11. `GET /pg/versions/infra/pending-check-s17`
    - Assert: entry exists in PostgreSQL with the written content
    - Assert: `status: "PENDING_CONFLICT_CHECK"`

---

### Part C — Cross-Catalog Conflict (Federation)

> When `quorum-test-project` has `globals: ["quorum-test-catalog"]`, `detectConflict()` searches
> across both project and global catalog. A write that contradicts a global catalog entry must
> trigger conflict detection with the global entry identified as `existing` and sourced from the
> global catalog. Without this test, a project-local write can silently override a global standard.

12. Confirm `quorum-test-project` has the global catalog linked:
    - `GET /config/quorum-test-project` as `test-pe`
    - Assert: `globals` array includes `"quorum-test-catalog"`

13. `POST /pg/versions` as `test-engineer` in `quorum-test-project`:
    - `topic: "auth"`, `key: "oauth-flow-s17"`
    - `content: "Use implicit grant for public clients — simpler for SPAs and mobile."`
    - `reason: "Engineering team prefers simpler auth flows for our dashboard SPA"`
    - Assert: `status: "conflict_detected"`, `conflict_id` present
    - Assert: the entry was NOT stored as ACTIVE (conflict stops the write)

14. `GET /pg/pending` as `test-pe`
    - Assert: conflict brief for `auth:oauth-flow-s17` is present
    - Assert: `existing_content` references the PKCE standard from `quorum-test-catalog`
    - Assert: the existing entry carries `source: "global"` or `catalog_id: "quorum-test-catalog"`
      — identifying it as sourced from the global catalog, not from the project
    - Assert: `incoming_content` matches the implicit grant text from step 13
    - Assert: enrichment object present (mock OpenAI returns canned analysis)

---

### Part D — Enrichment Response Shape (GV-4)

> S-02.2 asserts that `enrichment` is truthy. This part asserts the internal contract that the
> conflict pipeline relies on when presenting conflict briefs to PEs.

15. Trigger a fresh conflict on a new key:
    - PA writes `auth:shape-test-s17` → `ACTIVE`: `"All API keys must rotate every 90 days."`
    - Engineer writes conflicting: `"API keys do not need expiry for internal service accounts."`
    - Assert: `status: "conflict_detected"`, `conflict_id` present

16. `GET /pg/pending` as `test-pe`
    - Find the conflict brief for `auth:shape-test-s17`
    - Assert: `enrichment` is an object (not null, not a string, not undefined)
    - Assert: `enrichment.analysis` is a non-empty string (> 20 chars — not a stub)
    - Assert: `enrichment.risks_if_approved` is an Array
    - Assert: `enrichment.risks_if_approved.length >= 2 && enrichment.risks_if_approved.length <= 4`
    - Assert: every item in `risks_if_approved` is a non-empty string
    - Assert: `enrichment.questions_for_reviewer` is an Array
    - Assert: `enrichment.questions_for_reviewer.length >= 2 && enrichment.questions_for_reviewer.length <= 3`
    - Assert: every item in `questions_for_reviewer` is a non-empty string

---

## Pass Criteria

- [ ] Auto-supersede: PA high-confidence write over PA low-confidence write → `status` is not `conflict_detected`
- [ ] Auto-supersede: no new `pending_decision` created — conflict count unchanged before and after
- [ ] Auto-supersede: old version is `SUPERSEDED`, new version is `ACTIVE` — both preserved (no hard delete)
- [ ] Auto-supersede: audit lineage shows `conflict_resolution: "auto_supersede"` in governance_json
- [ ] Auto-supersede: no `reviewer` field in the governance audit entry
- [ ] Graphiti pause: write returns HTTP 200 (not 5xx) — write non-failure under outage guaranteed
- [ ] Graphiti pause: `status: "PENDING_CONFLICT_CHECK"` returned to caller
- [ ] PENDING_CONFLICT_CHECK: entry appears in `GET /pg/pending` for PE review
- [ ] PENDING_CONFLICT_CHECK: entry is durable in PostgreSQL (survives Graphiti resume)
- [ ] Cross-catalog conflict: project-local write contradicting a linked global entry → `conflict_detected`
- [ ] Cross-catalog conflict brief: existing entry identified as `source: "global"` from the global catalog
- [ ] Cross-catalog conflict: incoming entry is not stored (conflict stops write)
- [ ] Enrichment: `analysis` is a non-empty string
- [ ] Enrichment: `risks_if_approved` array has 2–4 items (all non-empty strings)
- [ ] Enrichment: `questions_for_reviewer` array has 2–3 items (all non-empty strings)

---

## Teardown

```javascript
// auth:auto-sup-target-s17 (v1 SUPERSEDED, v2 ACTIVE)
// infra:pending-check-s17 (PENDING_CONFLICT_CHECK)
// auth:oauth-flow-s17 conflict record (write was stopped — no version row)
// auth:shape-test-s17 ACTIVE entry + conflict record
// auth:global-standard in quorum-test-catalog (seeded in setup)
```

---

## Manual Tests

| Test | Why manual | ID |
|------|------------|-----|
| `fireWebhookAsync` fires on conflict detection | Non-blocking async; cannot be asserted via HTTP response. Configure `QUORUM_WEBHOOK_URL`, trigger conflict, verify payload arrives. | MT-08 |

---

## Related Scenarios

- **S-02.2** (Conflict detection) — happy path; J17 covers authority-bypass and Graphiti-unavailable paths
- **S-01** (Global catalog onboarding) — federation setup; cross-catalog conflict requires `globals` configured
- **S-10** (Audit chain) — auto_supersede produces INTENT + OUTCOME audit entries; chain must not break
- **S-18** (Governance route) — `/governance/*` route shape validation tested directly in J18
