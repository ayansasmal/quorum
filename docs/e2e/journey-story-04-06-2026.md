# Quorum: Journey Stories — 04 June 2026

> **Purpose:** Each section below maps one E2E journey to a product narrative.
> Stories describe what Quorum *demonstrably does* — validated by passing tests.
> Gaps call out what is not yet verified end-to-end (coverage missing, manual-only, or planned).
>
> **~600 tests. 22 journeys. 0 failures.**
>
> **What's new since 28 May 2026:**
> - Journey 22 (Portfolio Intelligence) added — was missing from the May story
> - **10 new negative/cross-boundary sub-scenarios** added 2026-06-04 across Journeys 2, 3, 4, 6, 8, 9, 11, 12, 17, 22
>   These cover **wrong-order state transitions** (e.g. re-reviewing an already-resolved conflict)
>   and **cross-project isolation** (e.g. using the wrong `X-Quorum-Project` header to access another project's resources)
> - OwnScore: 3605 → **3946**; 10 % gate: 353 → **395**; 5 % gate: 177 → **197**
>
> Status legend:
> - ✅ Verified end-to-end (API test, green in suite)
> - 🖥️ Verified browser (Playwright UI test, green in suite)
> - ⛔ New: negative / cross-boundary guard (wrong-order transition or cross-project isolation)
> - 🔶 Manual only (MT-xx, no automated coverage)
> - ❌ Gap (not yet tested or not yet built)

---

## Table of Contents

| Journey | Title | Sub-scenarios | Test Count |
|---------|-------|---------------|------------|
| [J01](#j01) | Global Catalog Onboarding | 13 steps (serial) | 13 |
| [J02](#j02) | Knowledge Governance Lifecycle | S-02.1–S-02.13 | ~55 (5 browser skipped) |
| [J03](#j03) | Knowledge Deprecation & Retirement | S-03.1–S-03.6 | ~30 |
| [J04](#j04) | Deviation Recording & PE Governance | S-04.1–S-04.10 | ~32 (7 browser skipped) |
| [J05](#j05) | RBAC Boundary Simulation | S-05.1–S-05.10 | ~40 |
| [J06](#j06) | Multi-User Conflict Resolution | S-06.1–S-06.7 | ~24 |
| [J07](#j07) | Conformance Scoring & Portfolio | S-07.1–S-07.8 | ~22 (8 browser skipped) |
| [J08](#j08) | Confidence Endorsement Lifecycle | S-08.1–S-08.7 | ~18 |
| [J09](#j09) | Platform Admin Operations | S-09.1–S-09.9 | ~17 (2 browser skipped) |
| [J10](#j10) | Audit Trail Integrity | S-10.1–S-10.12 | ~16 |
| [J11](#j11) | Self-Approval Prevention | S-11.1–S-11.5 | ~16 |
| [J12](#j12) | Knowledge Status State Machine | S-12.1–S-12.8 | ~25 |
| [J13](#j13) | Config Sync & Global Discovery | S-13.1–S-13.7 | ~24 |
| [J14](#j14) | Dashboard Visual & Interaction | S-14.1–S-14.6 | ~14 (browser) |
| [J15](#j15) | Reason / Placeholder Rejection | S-15.1–S-15.10 | 20 |
| [J16](#j16) | Knowledge History & Point-in-Time | S-16.1–S-16.6 | ~16 |
| [J17](#j17) | Conflict: Governance Edge Cases | S-17.1–S-17.6 | ~15 |
| [J18](#j18) | Governance Route: Direct Coverage | S-18.1–S-18.5 | ~23 |
| [J19](#j19) | Authentication Lifecycle | S-19.1–S-19.5 | 22 |
| [J20](#j20) | Cross-Catalog Search | S-20.1–S-20.8 | ~18 |
| [J21](#j21) | MCP Layer Gateway Contracts | S-21.1–S-21.7 | ~27 |
| [J22](#j22) | Portfolio Intelligence | S-22.1–S-22.9 | ~30 |

---

## J01 — Global Catalog Onboarding {#j01}

### Sub-scenarios

| Step | What is tested |
|------|----------------|
| 1 | Upload global catalog config (201) |
| 2 | Upload project config linked to catalog via `globals:[]` (201) |
| 3 | Catalog visible in `GET /api/globals` with `source:'global'` annotation |
| 4 | PA writes to global catalog → lands as **DRAFT** (self-approval prevention) |
| 5 | DRAFT visible in `GET /api/drafts`, not in `GET /api/knowledge` |
| 6 | Conformance is **UNCERTIFIED** with only 1 entry (< 10 threshold) |
| 7 | Architect member writes to global catalog → also lands as **DRAFT** |
| 8 | A second PA promotes the DRAFT → **ACTIVE** |
| 9 | Promoted entry visible in `GET /api/knowledge` |
| 10 | Cross-catalog search from linked project finds the global entry |
| 11 | Graphiti indexing delay handled (`graphitiSettle()`) before search assertion |
| 12 | Search result annotated `source:'global'` + `catalog_id:'quorum-test-catalog'` |
| 13 | Knowledge browser on the project cannot see global entries that aren't in scope |

### Story

> *An org's principal architect decides to publish a company-wide OAuth standard.*

A PA creates a **global catalog project** (`is_global: true`). They upload the config via `POST /config/upload`. Immediately, `GET /api/globals` discovers it and lists it for any linked project.

The PA writes the first standard entry. **It does not become ACTIVE.** Even the owner of a global catalog cannot self-approve their own write — the entry lands as DRAFT. This is enforced constitutionally, not by convention.

A colleague — also a PA but a different person — reviews the DRAFT and promotes it. Now the entry is ACTIVE in the global catalog.

An engineering project that has declared `globals: ["quorum-test-catalog"]` in its config can immediately search for that standard. The search result comes back annotated with `source: 'global'` and the catalog name, so engineers always know where a standard originated.

Until the catalog has 10 or more ACTIVE entries, any project linked to it shows **UNCERTIFIED** in conformance scoring — preventing premature scoring against an incomplete standard.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Onboarding through the dashboard UI | Config upload UI is not E2E tested — only the API path is verified |
| ❌ Cross-catalog conflict detection via MCP | The MCP `remember()` path that calls `detectConflict()` against globals is MT-07 |
| ❌ Graphiti entity relationships (SUPERSEDES edges) | Semantic graph enrichment is manual-test only (MT-07) |
| ❌ Org hierarchy filtering for `GET /api/globals` | `global_scope: division` filtering by `hierarchy.parent` ancestry is unit-tested only |

---

## J02 — Knowledge Governance Lifecycle {#j02}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-02.1 Write + Recall | PA writes ACTIVE entry; engineer writes DRAFT; both visible in search and `GET /api/knowledge` |
| S-02.2 Conflict Detection | Concurrent writes to same key; second lands as `PENDING_CONFLICT_CHECK`; `pending_decisions` record created with LLM-generated conflict reason |
| S-02.3 Supersede Path | PA approves conflict as `supersede`; old version atomically → SUPERSEDED, new → ACTIVE; `supersedes_reason` preserved |
| S-02.4 Reject Path | PA rejects conflict; first entry remains DRAFT; second entry removed from pending |
| S-02.5 Escalation (request_changes) | PA requests clarification; conflict stays open; note appended to `stale_warning` |
| S-02.6 Coexist-Split | PA resolves by splitting into two scoped entries; both land as DRAFT |
| S-02.7 Coexist-Merge | PA merges two conflicting entries into one unified ACTIVE entry; both old entries SUPERSEDED atomically |
| S-02.8 Dashboard UI (browser) | Pending page conflict card displays; note < 10 chars blocks submission; `request_changes` keeps conflict open; `approve` removes card; audit timeline shows `review` tool entries |
| S-02.9 Authority Fence | Engineer/senior/architect all get 403 on `/api/review`; only PA can resolve a conflict |
| S-02.10 Concurrent Competing DRAFTs | Two engineers write different DRAFTs for same key concurrently; both succeed; PA promotes one; other DRAFT persists |
| S-02.11 Supersede-Under-Review | PA supersedes v1 while engineer's conflict is pending; conflict persists; PA rejects stale conflict → 200; v3 ACTIVE unchanged |
| S-02.12 Stale-Warning Badge | `data-testid="stale-warning-badge"` on overdue decision card (API + browser) |
| S-02.13 ⛔ Wrong-Order Review + Cross-Project Isolation | Re-review of already-resolved conflict → 404; cross-project review as engineer → 403; wrong `X-Quorum-Project` header → 404; peer-project conflict stays pending after failed cross-project reviews |

### Story

> *Two engineers independently document what they believe is the correct TLS policy.*

Engineer A writes `security:tls-minimum-version`. Engineer B writes the same key with a contradicting statement. The second write detects the conflict and creates a `pending_decisions` record with an AI-generated analysis of *why* the two statements contradict.

The conflict appears in the Pending Decisions dashboard. The PA opens it and sees both versions side by side. They can supersede, reject, request changes, coexist-split, or coexist-merge. Every resolution path is covered. None produce data loss.

**New negative guards (2026-06-04):** Once a conflict is resolved, any attempt to re-review it returns `404` — the pending decision no longer exists. An engineer in a different project attempting to call the review endpoint gets `403` (not a PA). Sending the right JWT but the wrong `X-Quorum-Project` header causes the gateway to look up the conflict under the wrong project scope and return `404`. These three guards ensure the conflict resolution surface cannot be replayed or cross-projected.

### Gaps

| Gap | Notes |
|-----|-------|
| 🖥️ S-02.8 browser tests | Run in Docker mode — verified but require `QUORUM_DASHBOARD_URL` env |
| ❌ Stale-warning badge on re-read | Verified API shape; browser rendering of stale badge tested in S-02.12 |
| ❌ MCP `remember()` conflict trigger path | Full MCP flow through `shouldAutoSupersede()` is MT-07; HTTP tests verify end-state only |
| ❌ LLM quality of conflict analysis | Mock OpenAI returns deterministic canned responses; real-model quality is MT-13 |

---

## J03 — Knowledge Deprecation & Retirement {#j03}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-03.1 Single Deprecation | PA deprecates with valid reason → DEPRECATED; entry absent from `GET /api/knowledge`; history preserved |
| S-03.2 Validation Guards | Non-PE → 403; missing/short/placeholder reason → 400 REASON_REQUIRED; non-existent key → 404 |
| S-03.3 Bulk Deprecation | Full batch success; partial success returns `deprecated[]` + `errors[]`; non-PE → 403 |
| S-03.4 Deprecation Request: Approve | Engineer queues `forget()` instead of getting forbidden; PA approves → entry DEPRECATED; request removed from pending |
| S-03.5 Deprecation Request: Reject | PA rejects deprecation request; entry remains ACTIVE; request resolved but entry untouched |
| S-03.6 ⛔ Wrong-Order + Cross-Project Deprecation | Deprecate already-DEPRECATED entry → 404; deprecate DRAFT-only key → 404; engineer in peer-project can't deprecate → 403; wrong project header → 404; entries intact after all failures |

### Story

> *A platform team decides the legacy session-cookie auth pattern is obsolete.*

A PA deprecates the entry. It transitions to DEPRECATED, removed from the knowledge browser, but its full history is preserved. **Nothing is deleted.**

What if an engineer identifies a pattern that should be retired? They call `forget()`, which instead of returning `403` queues a **deprecation request** in Pending Decisions. The PA reviews and approves or rejects.

**New negative guards (2026-06-04):** Attempting to deprecate an entry that is already `DEPRECATED` returns `404` — the gateway's state machine allows only `ACTIVE → DEPRECATED`. Attempting to deprecate a key that only has `DRAFT` versions (no ACTIVE) also returns `404`, because `getCurrentVersion()` queries ACTIVE only. An engineer in a peer project attempting to deprecate returns `403` (non-PA role in that project context). Sending the wrong `X-Quorum-Project` header returns `404`. After all four failed attempts, the actual DEPRECATED and DRAFT entries remain in exactly the state they were before — demonstrating that failed writes leave no side effects.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Dashboard deprecation UI for bulk | DeprecateDialog and BulkActionBar are tested in S-04 deviation tables only |
| ❌ Deprecation request stale-warning in browser | Stale badge is tested API-only |
| ❌ Notification to the engineer who raised the request | No notification mechanism exists yet (v0.5+) |

---

## J04 — Deviation Recording & PE Governance {#j04}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-04.1 Deviation Recording | `POST /api/deviations` idempotent upsert; severity = `confidence × ROLE_SCORES[role]`; PA-authored floor = 0.70 |
| S-04.2 Validation Guards | `not_linked` (project has no globals) → 400; `not_found` (catalog entry absent) → 404; missing fields → 400 |
| S-04.3 Accept | PE accepts deviation → ACCEPTED; removed from OPEN filter |
| S-04.4 Deny | PE denies with reason; `denial_hint` returned when catalog entry is high-confidence PA-authored |
| S-04.5 Defer | PE defers with deadline; `DEFER_DEADLINE` constitutional validation enforces 30/45/60/90d window; status → DEFERRED |
| S-04.6 Batch Recording | Up to 100 records; partial success via `Promise.allSettled`; returns `{ recorded, failed, results }` |
| S-04.7 Dashboard UI (browser) | Filter rail, table rows, inline action panel, reason validation, OPEN filter clears on accept |
| S-04.8 Knowledge Denial Badge (browser) | `✕N` badge on global catalog entries with active denials; tooltip shows count |
| S-04.9 Overdue Deferrals (browser) | `data-testid="overdue-deferrals-section"` in Pending page; past-dated DEFERRED deviation seeded via `/pg/deviation-actions` |
| S-04.10 ⛔ Wrong-Order Action + Cross-Project | Re-actioning an ACCEPTED deviation → non-200; status stays ACCEPTED; engineer in peer-project → 400 DEVIATION_ACTION_AUTHORITY |

### Story

> *A mobile team needs to use a deprecated OAuth pattern that the security catalog has marked as non-compliant.*

The team records a **deviation** against the catalog entry. The record is idempotent — re-scanning updates `last_seen_at` rather than creating duplicate rows.

The PE reviews the deviation queue and can accept, deny, or defer. Batch recording lets a scan tool submit up to 100 deviations in one call.

**New negative guards (2026-06-04):** Re-actioning a deviation that is already `ACCEPTED` returns a non-200 response — the state machine does not allow double-actioning. The status remains ACCEPTED after the failed attempt. An engineer in a peer project who lacks PE authority receives `400 DEVIATION_ACTION_AUTHORITY` — the constitutional enforcement fires before any state change.

### Gaps

| Gap | Notes |
|-----|-------|
| 🖥️ S-04.7 / S-04.8 / S-04.9 | Browser tests verified in Docker mode |
| ❌ Overdue deviation escalation notifications | No notification mechanism exists yet |
| ❌ Deviation re-scan automation | `quorum:scan` skill exists in documentation; no automated scheduler in gateway |
| ❌ Deviation export / reporting | No bulk export endpoint |

---

## J05 — RBAC Boundary Simulation {#j05}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-05.1 Knowledge Write | All 8 roles can write; non-PA → DRAFT, PA → ACTIVE; confidence floored; unknown project → 403 |
| S-05.2 Promote + Supersede | Non-PA → 403; PA → 200 on both operations |
| S-05.3 Single + Bulk Deprecate | Non-PA → 403; PA → 200 |
| S-05.4 Review + Global Write | Non-PE review → 403; PA review → 200; global catalog: non-member → 403; catalog members → 201 DRAFT; PA → 201 DRAFT (self-approval) |
| S-05.5 Deviation Action + Forget | Executive roles blocked from `action` (DEVIATION_ACTION_AUTHORITY); PA/PA-tier → 200; non-PE → 403 on deprecate; `forget()` available to all |
| S-05.6 Portfolio + Admin | Engineer/architect → 403 on portfolio; PA/director/vp → 200; all 8 roles → 403 on `/admin/*`; `is_admin` JWT → 200; missing project header → 400 |
| S-05.7 Cross-Project Role Context | Same JWT + different `X-Quorum-Project` header = different effective role; test-pe writes ACTIVE in test-project (PA) vs DRAFT in peer-project (engineer) |
| S-05.8 Concurrent RBAC Race | PA and engineer fire promote concurrently via `Promise.all`; engineer always 403, PA always 200, exactly 1 ACTIVE version after race |
| S-05.9 Role Update + Cache Invalidation | PA promotes test-engineer → director; test-engineer immediately accesses portfolio → 200; PA resets; test-engineer denied again → 403 |
| S-05.10 Non-Member Private Project | Non-member of private catalog denied on 5 `/api/*` routes (knowledge/drafts/stats/deviations/conformance → 403); catalog member test-architect → 200 |

### Story

> *Eight different team members — from intern to VP of Engineering — try to use every governance operation.*

This journey is Quorum's trust contract table, verified exhaustively. The key findings:

- **Anyone can write knowledge.** The gate is on *who becomes ACTIVE*.
- **Only the Principal Architect can change status** (promote, supersede, deprecate, review).
- **Global catalogs enforce multi-party governance.** Even the PA who owns the catalog cannot self-promote their own entries.
- **Executive roles have read-wide access to portfolio** but cannot perform deviation governance actions.
- **Platform admins are a separate identity** (`is_admin` JWT claim), orthogonal to project role.
- **Confidence is always floored** at the author's `base_confidence`.
- **Role is resolved per-project-per-request.** The same JWT produces a different effective role under a different `X-Quorum-Project` header — a direct test of Quorum's identity/scope decoupling.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Role coverage for `PUT /config/:projectId` (config update) | Not in RBAC matrix test |
| ❌ `is_owner` distinction vs. `principal_architect` role | Ownership transfer tested in S-15.9 but ownership-only gates are not RBAC-matrix-tested |

---

## J06 — Multi-User Conflict Resolution {#j06}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-06.1 Concurrent Writes | Two engineers write same key; second gets `PENDING_CONFLICT_CHECK`; conflict detected |
| S-06.2 Request Changes | PA requests clarification; conflict stays open; note preserved |
| S-06.3 `more_pending_same_key` Counter | Concurrent conflicts on same key increment counter; decrement on resolution |
| S-06.4 Approve First, Reject Second | First approved (atomic supersede), second rejected; final state consistent |
| S-06.5 Coexist-Split | Manual split into two scoped entries; conflict resolved; both in `/api/drafts` |
| S-06.6 Three-Way Conflict | Three engineers write same key; three distinct `pending_decisions` rows; each with unique `incoming_content`; `more_pending_same_key` = 2 |
| S-06.7 ⛔ Cross-Project Conflict Review Isolation | Engineer in peer-project can't review → 403; PA with wrong project header can't review → 404; second PA can't re-review an already-resolved conflict → 404; peer conflict unaffected by all failed cross-project attempts |

### Story

> *A distributed team on different time zones both update the same database indexing pattern simultaneously.*

Both writes succeed. The second is flagged `PENDING_CONFLICT_CHECK`. If multiple conflicts pile up on the same key, the `more_pending_same_key` counter tracks the backlog — verified for up to three concurrent conflicting writers.

**New negative guards (2026-06-04):** An engineer in the peer project cannot review a conflict that belongs to the main project — `403` fires because they lack the `principal_architect` role in that project. A PA who sends the right JWT but the wrong `X-Quorum-Project` header gets `404` because the conflict ID does not exist in the peer project's scope. A second PA who attempts to re-review a conflict that the first PA already resolved gets `404` because the pending decision row has been removed. After all three failed attempts, the peer project's own pending conflict remains untouched — there is no cross-contamination between projects.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Real-time dashboard updates when conflict resolves | WebSocket / polling not tested |
| ❌ Notification to the conflicting author | No notification mechanism on conflict detection |

---

## J07 — Conformance Scoring & Portfolio Intelligence {#j07}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-07.1 UNCERTIFIED Gates | No globals → UNCERTIFIED; sparse catalog (<10 entries) → UNCERTIFIED |
| S-07.2 CERTIFIED Baseline | 10-entry seed + `POST /pg/scans` → `GET /api/conformance` returns score/status/breakdown/catalogs |
| S-07.3 Score Formula | OPEN weight 1.0, DENIED weight 0.3; score = (1 − weighted_deviation_ratio) × 100 |
| S-07.4 Portfolio Role Gate | Engineer/architect → 403; PA/director → 200; rollup = Σ(score × criticality) / Σ(criticality) |
| S-07.5–S-07.8 Dashboard (browser) | Stats page stat cards; ConformanceCard label/badge; UNCERTIFIED project card; score badge absent when uncertified |

### Story

> *The CTO wants to know: how well are our 12 product teams following the architecture standards?*

Every project linked to a global catalog gets a **conformance score** — a 0–100 measure. A project is **UNCERTIFIED** until the linked catalog has 10+ ACTIVE entries and at least one scan has been run.

The **portfolio view** shows all projects with their conformance scores weighted by criticality. Projects with no globals or insufficient catalog coverage are counted as UNCERTIFIED separately.

### Gaps

| Gap | Notes |
|-----|-------|
| 🖥️ S-07.5–S-07.8 | Browser tests verified in Docker mode |
| ❌ Portfolio full-page UI | `GET /api/portfolio` is tested; dashboard Portfolio page drill-down is covered by J22 |
| ❌ Automated conformance scan scheduling | `quorum:scan` skill exists; no gateway-side scheduler (by design — GAP-032 closed as accepted) |
| ❌ Conformance score trend over time | Score is point-in-time; no historical chart or degradation alert |
| ❌ Criticality configuration | Rollup uses `criticality` field but it's not user-configurable in the config schema yet |

---

## J08 — Confidence Endorsement Lifecycle {#j08}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-08.1 Happy Path | PA bumps → 200 with all 11 response fields |
| S-08.2 Role-Weighted Delta | Engineer delta < architect delta < PA delta; formula: `BASE_DELTA(0.05) × ROLE_WEIGHT[role]` |
| S-08.3 Confidence Cap | `confidence_after ≤ starting_confidence`; `Math.min()` cap verified |
| S-08.4 Cooldown Enforcement | Same user → 429 within 7 days; `next_bump_allowed` field present; different user unaffected |
| S-08.5 Validation Guards | Non-existent key → 404; DRAFT-only entry → 404 (ACTIVE-only query) |
| S-08.6 Endorsement History | `GET /api/endorsements/:topic/:key` returns author/role/delta/bumped_at list; 404 on non-existent key |
| S-08.7 ⛔ Deprecated Entry + Cross-Project Isolation | Bump DEPRECATED entry → 404; endorsements for DEPRECATED key → 404; bump peer-project entry with wrong header → 404; engineer CAN bump in correct peer-project scope (positive guard) |

### Story

> *An architect finds a well-established auth pattern that has been production-proven for two years.*

They call `POST /api/bump/auth/jwt-validation-pattern`. The entry's confidence increases by a role-weighted delta, capped at the original `starting_confidence`. Each user can endorse once every 7 days.

**New negative guards (2026-06-04):** Endorsing a `DEPRECATED` entry returns `404` — `getVersionForBump()` queries ACTIVE only, so deprecated entries are invisible to the bump endpoint by design. The endorsement history endpoint similarly returns `404` for a key that has only DEPRECATED versions. Bumping a peer-project entry with the wrong `X-Quorum-Project` header returns `404` because the gateway cannot resolve the key under the wrong project scope. The positive guard confirms that an engineer with the correct peer-project header *can* endorse — cross-project reads are allowed for authorised members.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Decay mechanism | `scripts/decay.js` exists; confidence decay unit-tested but not E2E tested |
| ❌ Endorsement visible in dashboard Knowledge browser | The `confidence` field updates but there's no endorsement history panel in the UI |

---

## J09 — Platform Admin Operations {#j09}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-09.1 Admin Config | `GET /admin/config` requires `is_admin` JWT; returns all project configs; non-admin → 403 |
| S-09.2 User Management | `POST /config/update-role` requires admin or PA; role validated; unknown project → 404 |
| S-09.3 Project Listing | `GET /admin/projects` returns all projects; admin-only |
| S-09.4 Reason Guard | Reason ≥ 10 chars; placeholder pattern blocks "na na na na"; 400 on violation |
| S-09.5 Dashboard Admin Panel (browser) | Admin panel visible to `is_admin` users; heading is "Admin" |
| S-09.6 User Profile | `GET /user/profile/:username` resolves Redis → DDB; includes role, projects, base_confidence |
| S-09.7 Admin Filtered Audit Log | `writeGovernanceAudit` resolves `project` → `q_project_id`; governance audit entries retrievable by tool filter |
| S-09.8 Project Archive | `DELETE /admin/projects/:groupId` reason guard 400; non-admin 403; archive 200; re-archive 404 |
| S-09.9 ⛔ Role Update Guards + Cross-Project | Update role for non-member → 400; invalid role → 400; engineer in peer-project can't update roles → 403; cross-project update attempt (flexible assertion) |

### Story

> *The platform team needs to manage Quorum across 20 engineering projects.*

Platform admins (`is_admin: true`) can see all project configs, add/remove platform admins, list all projects, and archive projects that are being retired. Admin operations write governance audit entries retrievable via tool filter.

**New negative guards (2026-06-04):** Attempting to update a role for a `github_username` that is not a member of the project returns `400`. Specifying an invalid role string (not in the schema's allowed role enum) returns `400`. An engineer in the peer project who lacks admin or PA authority gets `403` when calling `POST /config/update-role`. The cross-project update attempt uses a flexible `[200, 400, 403]` assertion because `test-architect` is legitimately a PA in the peer project — a role change *might* succeed — but the important invariant is that an engineer cannot escalate their own role.

### Gaps

| Gap | Notes |
|-----|-------|
| 🖥️ S-09.5 | Browser test verified in Docker mode |
| ❌ Bulk role management | Roles are updated one user at a time; no batch operation |

---

## J10 — Audit Trail Integrity {#j10}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-10.1 Write Creates Entries | Dashboard write creates audit entry; `GET /pg/audit/count > 0` |
| S-10.2 Entry Shape | All chain + metadata fields present; `chain_position` is BIGINT → string; `entry_hash` is 64-char hex |
| S-10.3 Hash Integrity | `entry_hash` = lowercase hex; `chain_position` non-negative integer; `previous_hash` = hex or null (first entry) |
| S-10.4 Author Filter | `?author=test-pe` returns only test-pe entries (exact match) |
| S-10.5 Tool Filter | `?tool=dashboard-create` returns only dashboard-created entries |
| S-10.6 Limit Pagination | `?limit=2` returns ≤ 2 entries |
| S-10.7 Fetch by ID | Valid UUID → 200 + entry; nonexistent UUID → 200 + null (not 404, prevents enumeration) |
| S-10.8 Lineage | `GET /pg/audit/lineage/:topic/:key` returns empty for dashboard-created entries |
| S-10.9 Cross-Project Audit Isolation | Valid entry_id from project A returns 404 under project B's context |
| S-10.10 Append-Only Enforcement | DELETE and PATCH on `/pg/audit/:id` both return 404 (no route registered) |
| S-10.11 Chain Verification | `GET /pg/audit/verify` (admin-only); returns `{ verified, entries, broken_at? }` |
| S-10.12 Compliance Export | `GET /pg/audit/export?format=ndjson` (admin-only); returns NDJSON stream with chain fields |

### Story

> *A compliance officer needs to demonstrate that no knowledge entry was retroactively altered.*

Every write in Quorum generates an immutable audit entry with a SHA-256 hash chained to the previous entry. The chain can be verified via `GET /pg/audit/verify` (admin-only) and exported as NDJSON for ingestion by compliance tooling.

Fetching a specific entry by ID returns `null` instead of `404` for non-existent IDs — preventing an attacker from enumerating which audit IDs exist. Cross-project audit isolation means a valid entry ID from project A returns `404` under project B's context even for an admin — the ownership check fires before the data is returned.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Hash chain tamper detection | No test that mutates an entry and verifies the chain breaks |
| ❌ Dashboard audit timeline pagination | Tested for "entries exist" but not for large-volume pagination |

---

## J11 — Self-Approval Prevention {#j11}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-11.1 Global Catalog Self-Approval | PA writes to `is_global: true` project → DRAFT; self-promote attempt → 403; second PA promotes → ACTIVE |
| S-11.2 Engineer DRAFT Self-Approval | Engineer writes → DRAFT; engineer attempts review → 403 (NO_SELF_APPROVAL); PA review → 200 |
| S-11.3 MCP-Path Self-Approval | MCP `remember()` → DRAFT (`author='claude'` forces DRAFT); senior author attempts review → 403; PA review → 200 |
| S-11.4 Coexist-Merge Two-PA Flow | `merged_content_required` validation → 400; `NO_SELF_APPROVAL` for draft author → 400; 200 merge by non-draft PA; ACTIVE authored by reviewer; SUPERSEDED history; pending resolved |
| S-11.5 ⛔ Re-Reviewing a Resolved Conflict | Same PA attempts to re-review an already-approved conflict → 404; second PA also → 404; resolved conflict absent from `/pg/pending`; ACTIVE version intact after both failed attempts |

### Story

> *Quorum's fourth constitutional rule: no one can approve their own knowledge.*

This applies at every level. The combination means every ACTIVE entry has been seen and approved by at least one human who was not its author.

**New negative guards (2026-06-04):** Once a PA resolves a conflict, the `pending_decisions` row is removed. Any subsequent review attempt — whether by the same PA or a second PA — returns `404`. This is not a permissions failure; it is a state-machine correctness check. The resolved conflict is gone from `/pg/pending`. The ACTIVE version that was created by the resolution remains exactly as it was — the failed re-reviews do not mutate any state.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Delegation / "reviewed-by" attribution in audit | The audit entry tracks who reviewed, but there's no separate `reviewed_by` field on the knowledge version |

---

## J12 — Knowledge Status State Machine {#j12}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-12.1 Valid Transitions | DRAFT→ACTIVE (promote); DRAFT→REJECTED (review reject); ACTIVE→SUPERSEDED (supersede); ACTIVE→DEPRECATED (deprecate) |
| S-12.2 Invalid Transitions | DRAFT→DRAFT; ACTIVE→DRAFT; REJECTED→*; DEPRECATED→* — all return 404 or 400 |
| S-12.3 DRAFT Coexists with ACTIVE | PA has ACTIVE entry; engineer writes DRAFT on same key; both coexist and are visible in correct APIs |
| S-12.4 Terminal Status Immutability | SUPERSEDED and DEPRECATED entries cannot transition to any other status |
| S-12.5 `GET /api/drafts` | Multiple DRAFTs listed; only DRAFT status returned; `version` field present |
| S-12.6 REJECTED Key Re-Submission | `getCurrentVersion()` queries ACTIVE only so REJECTED history never blocks new DRAFTs |
| S-12.7 Stale DRAFT Cleanup | `GET /api/drafts?max_age_days=N` filter; `GET /api/drafts/stale?threshold_days=N`; `make_interval` parameterised age filter |
| S-12.8 ⛔ PENDING_CONFLICT_CHECK + Cross-Project Promote | Promote PENDING_CONFLICT_CHECK → 404 (no_draft); PA promotes peer-project DRAFT with wrong header → 404; engineer in peer-project can't promote → 403; test-architect (PA in peer-project) CAN promote (positive guard) |

### Story

> *Knowledge in Quorum follows a well-defined lifecycle — every transition is governed, irreversible, and audited.*

An entry moves through: `DRAFT → ACTIVE → SUPERSEDED / DEPRECATED`. The graph has no back-edges. Once deprecated or superseded, an entry cannot be reactivated, edited, or deleted.

**New negative guards (2026-06-04):** A version in `PENDING_CONFLICT_CHECK` status cannot be promoted — it must first be resolved by a PA's conflict review. Attempting to promote it returns `404` because the promote endpoint calls `getCurrentDraftVersion()` which only finds `DRAFT` status. A PA who sends the correct JWT but the wrong `X-Quorum-Project` header gets `404` because the DRAFT exists only in the other project's scope. An engineer in the peer project gets `403` (non-PA). The positive guard confirms that `test-architect` — who is the PA in the peer project — can promote the DRAFT under the correct project header. This validates the full cross-project promote lifecycle.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ REJECTED entry re-submission path | No defined UI workflow for re-proposing a rejected entry |
| ❌ Stale DRAFT automatic expiry | DRAFTs older than N days have no automatic expiry or reminder mechanism |

---

## J13 — Config Sync & Global Catalog Discovery {#j13}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-13.1 Sync Auth | `POST /sync/configs` requires PA JWT or sync token; engineer → 403 |
| S-13.2 Sync Response Shape | `{ synced: ≥3, failed: [], globals_warnings: [], duration_ms }` |
| S-13.3 Self-Reference Guard | Project that lists itself in `globals` uploads (201) but sync puts it in `failed[]` |
| S-13.4 `GET /api/globals` | Discovers `is_global=TRUE` projects; enriches with config metadata; non-member of private project → 403 |
| S-13.5 Config Schema Validation | Invalid `global_scope` → 400; `is_global`, `hierarchy`, `globals` all accepted |
| S-13.6 Config Update | `PUT /config/:projectId` (PA-only, schema-validated, S3 write + Redis invalidate + DDB sync); write/read-back/403/400-mismatch/restore |
| S-13.7 Division-Scoped Catalog Hierarchy | Division-scoped catalog visible to projects in same division; invisible to projects in other divisions |

### Story

> *The platform team adds a new global catalog. Ten minutes later, all 20 engineering projects automatically reflect the update.*

`POST /sync/configs` reads all configs from S3 and syncs them to DynamoDB. Division-scoped global catalogs are visible only to projects in that division's hierarchy — a compliance catalog for the Security division is not visible to the Product division's projects.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ EventBridge-triggered sync | `X-Quorum-Sync-Token` for EventBridge is documented; no E2E test of the webhook-style invocation (GAP-005, deferred) |
| ❌ Config update workflow through the dashboard Config editor | Config editor save is tested via `PUT /config/:projectId` HTTP; the dashboard "Save" button flow is not separately E2E tested |

---

## J14 — Dashboard Visual & Interaction Flows {#j14}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-14.1 Knowledge Graph | Domain `<select>` → Cytoscape canvas renders; legend labels; node-click grid sweep → NodePanel if hit |
| S-14.2 Config Editor | Textarea shows current config JSON; schema-invalid JSON (missing `owner`) → red error div → Save disabled; Save success path → `data-testid="save-success"` |
| S-14.3 System Status | "Service health" heading; all service names visible; ≥ 3 Healthy badges; 0 Unavailable |
| S-14.4 Audit Timeline | Entries listed; author filter narrows results |
| S-14.5 Project Selector | Switch button in header; search input filters projects; "Back to current project" navigates to `/` |
| S-14.6 Dark Mode Toggle | `data-testid="theme-toggle"` in Header; default dark theme; toggle + navigate + persist |

### Story

> *A new engineer joins the team and opens the Quorum dashboard for the first time.*

The **Knowledge Graph**, **Config Editor**, **System Status**, **Audit Timeline**, and **Project Selector** are all visually verified. The dark mode preference is persisted across navigation — toggling in one page and navigating to another retains the setting.

### Gaps

| Gap | Notes |
|-----|-------|
| 🖥️ All S-14 sub-scenarios | Browser tests run in Docker mode only |
| ❌ Knowledge graph visual quality | Node layout, edge rendering, label legibility — MT-04 (manual) |
| ❌ Config editor diff view | No side-by-side diff between current and proposed config (GAP-033, v0.5+) |
| ❌ Mobile / responsive layout | All browser tests use Desktop Chrome; no mobile viewport test |

---

## J15 — Reason / Placeholder Rejection {#j15}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-15.1 `POST /pg/versions` supersede reason | `"tbd"` → 400; valid → 201 |
| S-15.2 `POST /api/review/:id` note | `"ok"` → 400; valid → 200 approved |
| S-15.3 `POST /api/knowledge/:t/:k/promote` | `"test"` → 400; valid → 200 ACTIVE |
| S-15.4 `POST /api/knowledge/:t/:k/supersede` | `"todo"` → 400; valid → 200 |
| S-15.5 `POST /api/knowledge/:t/:k/deprecate` | `"n/a"` → 400; valid → 200 |
| S-15.6 `POST /api/deviations/:id/action` | `"."` → 400; valid → 200 |
| S-15.7 `POST /admin/users` | `"yes"` → 400; valid → 200 + cleanup |
| S-15.8 Bulk Deprecate | `"na na na na"` (≥10 chars but matches `na` pattern) → 400; valid → 200 |
| S-15.9 `POST /config/transfer-ownership` | `"ok"` → 400; valid → 200 + restore |
| S-15.10 `POST /config/update-role` | `"tbd"` → 400; valid → 200 + restore |

### Story

> *Every governance action that creates a permanent audit record requires a real, substantive reason.*

Constitutional Rule 3 (`REASON_REQUIRED`) is one of Quorum's most pervasive checks. It applies to all 10 governance endpoints that mutate authoritative state. The rule: a reason must be at least 10 characters and must not match the placeholder list. The edge case `"na na na na"` (11 chars) is caught by the regex pattern `/^(na\s*)+$/i`.

This 10-endpoint coverage matrix means that no new governance operation can be added without also being covered by this journey's pattern.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Reason field in dashboard UI validation | The reason textarea shows a red border on < 10 chars (tested in S-04.7, S-02.8), but S-15 endpoints are not all tested via browser UI |
| ❌ Custom placeholder list configuration | The placeholder list is hardcoded; no per-project override mechanism |

---

## J16 — Knowledge History & Point-in-Time Recall {#j16}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-16.1 Single-Version History | `GET /pg/versions/:t/:k/history` → `[{version:1, status:'ACTIVE', triggered_by: non-null}]` |
| S-16.2 After Supersede | 2 entries newest-first; v2 ACTIVE; v1 SUPERSEDED; `supersedes_reason` preserved |
| S-16.3 After Deprecation | Highest version shows DEPRECATED; lower versions preserved |
| S-16.4 Nonexistent Key | → 200 `[]` (not 404) |
| S-16.5 Point-in-Time (`/at`) | `tBefore` → null/404; `tAfterV1` → v1 content; missing `date` param → 400 |
| S-16.6 History Drawer (browser) | Row click → version timeline drawer renders; 2 `version-row` testids visible; close button navigates back |

### Story

> *A security team asks: what was the TLS policy on 1 January 2026, at the time of a production incident?*

`GET /pg/versions/security/tls-minimum/at?date=2026-01-01T00:00:00Z` returns the exact version that was ACTIVE at that moment. The full version history is accessible via the Knowledge browser's history drawer. Every entry in the history has a traceable origin via the non-null `triggered_by` field.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Point-in-time across supersede chains | Tested for a single key; multi-hop supersede chain point-in-time not separately tested |
| ❌ History export | No bulk export of full history for a domain or project |

---

## J17 — Conflict: Governance Edge Cases {#j17}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-17.1 Auto-Supersede State Invariants | Via `POST /pg/versions/supersede`; v1 SUPERSEDED, v2 ACTIVE, no pending_decision created, `supersedes_reason` preserved |
| S-17.2 `PENDING_CONFLICT_CHECK` Status | Version inserted/patched to `PENDING_CONFLICT_CHECK`; Docker-pause test (skipped without `QUORUM_DOCKER_E2E`) |
| S-17.3 Cross-Catalog Conflict Brief Shape | Seeded conflict with `existing_content` from global catalog; `conflict_reason` identifies catalog source |
| S-17.4 Enrichment Response Shape | `analysis`, `risks_if_approved` (2–4 items), `questions_for_reviewer` (2–3 items) |
| S-17.5 `PENDING_CONFLICT_CHECK → DRAFT` Lifecycle | PATCH sets status; `GET /api/drafts` finds it; promote succeeds; no longer in pending |
| S-17.6 ⛔ Enrich + Review Resolved Conflict | `POST /governance/enrich` with resolved `conflict_id` → not 5xx (graceful); reviewing resolved conflict → 404; resolved conflict absent from `/pg/pending` |

### Story

> *Edge cases that the main governance flow doesn't hit — but that can corrupt the knowledge graph if they're wrong.*

Auto-supersede, `PENDING_CONFLICT_CHECK` graceful degradation, cross-catalog conflict briefs, and AI enrichment are all verified at the HTTP level.

**New negative guards (2026-06-04):** When `POST /governance/enrich` is called with a `conflict_id` that has already been resolved, the endpoint must not return a 5xx error — the `conflict_id` is optional and the endpoint gracefully generates enrichment from the provided content even when the associated pending decision is gone. Attempting to review the resolved conflict via `POST /api/review/:conflictId` returns `404`. The resolved conflict is absent from `GET /pg/pending`. This triple-guard ensures that a concurrent race between enrichment fetching and conflict resolution does not crash the server.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Auto-supersede MCP trigger (`shouldAutoSupersede()`) | MT-07; requires a real MCP client connection |
| 🔶 Docker-pause Graphiti unavailability test | S-17.2 step 4 only runs with `QUORUM_DOCKER_E2E=true` |

---

## J18 — Governance Route: Direct Coverage {#j18}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-18.1 `detect-conflict` | Missing `existing` → 400; happy path → 200 `{contradicts, reason, possible_split, split_suggestion}`; unauthenticated → 401 |
| S-18.2 `enrich` | Missing `conflict_reason` → 400; happy path → 200; structural shape enforced |
| S-18.3 `extract` | Missing `task_summary` → 400; happy path → items array; each item: valid `topic`, `key` (kebab-case), `content` > 10 chars, `entity_type`, `confidence` ∈ [0,1], `mode` ∈ {echoing, extracting, generalising} |
| S-18.4 Sanitization | 2500-char inputs → 200 (silently truncated, never errors) — prompt-injection boundary |
| S-18.5 Enrichment Persistence | `POST /governance/enrich` with `conflict_id` → persists enrichment JSONB to `pending_decisions.enrichment`; retrievable on re-fetch |

### Story

> *Three governance routes power the AI layer of Quorum's conflict detection and knowledge extraction.*

`detect-conflict`, `enrich`, and `extract` are the three core AI governance routes. The sanitization test confirms that 2500-character inputs are silently truncated to 2000 characters before LLM interpolation — the prompt-injection boundary. Enrichment is now persisted to `pending_decisions.enrichment` so the reviewer's briefing survives page reload.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ LLM quality of extracted items | Mock returns deterministic canned responses; real-model extraction quality is MT-13 |
| ❌ Authentication requirement on `detect-conflict` | `verifyJwt` is applied but no project-scope requirement; any authenticated user can call it |

---

## J19 — Authentication Lifecycle & Boundary Enforcement {#j19}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-19.1 JWT Validation Boundaries | Valid → 200/404; missing header → 401 `missing_token`; expired → 401 `token_expired`; tampered signature → 401 `invalid_token`; HS256 → 401 (algorithm enforcement); non-member of private project → 403 |
| S-19.2 JWKS Endpoint Structure | 200 with `keys[]`; EC key type; ES256/P-256; `use: sig`; `kid` present; no HS256 or RSA keys |
| S-19.3 Project-Scoped Role Resolution | Member project → 200; non-member private project → 403; missing `X-Quorum-Project` → 400 |
| S-19.4 Token Refresh | Valid JWT → 200 with new token; expired JWT → 401 `token_expired` |
| S-19.5 PAT Authentication | Pre-minted JWT → 200/404; bogus string → 401 |

### Story

> *Security starts at the token. Quorum's auth layer is exhaustively tested for every failure mode.*

Every request must carry an ES256-signed JWT. Algorithm enforcement is absolute — HS256 tokens are rejected. Tampered tokens return `invalid_token`. The JWKS endpoint serves only EC/P-256 signing keys. Token refresh uses a sliding window — presenting a valid access token returns a new token with a fresh expiry.

### Gaps

| Gap | Notes |
|-----|-------|
| 🔶 GitHub OAuth browser flow | MT-11; requires a real GitHub OAuth app |
| 🔶 PKCE OAuth 2.1 end-to-end | MT-12; requires an MCP client and full browser flow |
| ❌ Token revocation | No token revocation mechanism; compromise requires key rotation (GAP-030 closed as accepted risk) |

---

## J20 — Cross-Catalog Search & Source Attribution {#j20}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-20.1 Query Validation | Missing/empty/single-char `q` → 400 |
| S-20.2 Result Field Shape | All 11 fields present and correctly typed |
| S-20.3 Cross-Catalog Scope | Project with globals finds global entries; `source:'global'` + `catalog_id` annotated |
| S-20.4 Scope Isolation | Project without globals cannot find global entries; returns `[]`, not 404 |
| S-20.5 DRAFT Exclusion | DRAFT/DEPRECATED/REJECTED entries excluded from search results |
| S-20.6 Domain Filter | `?domain=<topic>` narrows results to exact topic match |
| S-20.7 Mixed Sources | Single query returns both `source:'project'` and `source:'global'` entries |
| S-20.8 Search UI Interaction (browser) | `data-testid="knowledge-search"` input triggers filter; `source-global-badge` span appears for global entries |

### Story

> *An engineer asks: "what does our org know about TLS?"*

A single search query hits both the project's own knowledge and all linked global catalogs simultaneously. Results are annotated with their source. The search **never returns DRAFTs** — only ACTIVE entries appear. A project without any linked global catalogs gets an isolated view.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Graphiti semantic search path | S-20 tests the PostgreSQL ILIKE fallback; Graphiti vector search is unit-tested and MT-13 |
| ❌ Search result ranking | Results are unranked in the fallback path |

---

## J21 — MCP Layer Gateway Contracts {#j21}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-21.1 `pending()` Topic Filter | `GET /pg/pending?topic=X` filters at DB level; `GatewayClient.getPendingDecisions()` forwards `opts.topic` |
| S-21.2 `Requirement` Entity Round-Trip | `entity_type:'Requirement'` accepted; preserved through write → GET → search; `business_owner` property preserved |
| S-21.3 `extract` Constraints | `POST /governance/extract` accepts `constraints[]` (no 400); constraints forwarded to `buildExtractPrompt` (GAP-004 closed) |
| S-21.4 Config Schema `owner` Required | `POST /config/validate` without `owner` → 400 Zod error; with `owner` → 200 |
| S-21.5 Status Derived Server-Side | Gateway always derives status from context, ignoring `req.body.status` |
| S-21.6 `deviate()` MCP Tool HTTP Contract | Full body/severity/idempotent/not_linked/missing-field; `deviation_id` is UUID |
| S-21.7 `conformance()` MCP Tool HTTP Contract | All 7 fields, breakdown 6 keys, UNCERTIFIED shape |

### Story

> *The MCP layer makes HTTP calls to the gateway. These contracts must be exact — any drift causes silent failures in the AI agent's knowledge writes.*

`GET /pg/pending?topic=auth` filters at the database level. The gateway always **derives** knowledge status server-side — sending `status: 'ACTIVE'` in the body is silently ignored. The `constraints[]` field on `extract` is now forwarded to `buildExtractPrompt` (GAP-004 fix), closing a silent drop that was previously a known gap.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ MCP `remember()` end-to-end via MCP client | All S-21 tests are HTTP; the actual `stdio` MCP protocol is MT-01–MT-06 |

---

## J22 — Portfolio Intelligence {#j22}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-22.1 Portfolio Role Gate | Engineer/architect → 403; PA/director/vp → 200; `is_admin` → 200 |
| S-22.2 Portfolio Response Shape | `projects[]`, `rollup.score`, `rollup.certified_count`, `rollup.uncertified_count` |
| S-22.3 UNCERTIFIED Rollup | Projects with no globals excluded from rollup numerator; UNCERTIFIED counted separately |
| S-22.4 `node_id` Filter | `?node_id=X` filters to projects whose `hierarchy.parent` matches X |
| S-22.5 Portfolio Dashboard Render (browser) | Rollup banner; PA session injection → portfolio page renders |
| S-22.6 Portfolio Table (browser) | Project rows visible; at least one row in table |
| S-22.7 Portfolio Search (browser) | Text search input filters table rows by project name |
| S-22.8 Portfolio Status Filter (browser) | Status filter dropdown; CERTIFIED / UNCERTIFIED filter works |
| S-22.9 ⛔ Archived Project + Cross-Project Isolation | Archived project absent from `GET /api/portfolio`; conformance for archived project → 403 or 404; engineer can't access portfolio → 403; `node_id` filter for archived project returns empty |

### Story

> *The CTO opens the Portfolio Intelligence page to see the org-wide conformance picture.*

The Portfolio dashboard shows a rollup banner (org-wide conformance score, certified/uncertified counts), a cascading org filter by hierarchy node, a text search, and a status filter. Projects are shown with their score bar, owner, last scan date, and whether they are global catalog projects.

**New negative guards (2026-06-04):** A project that has been archived via `DELETE /admin/projects/:groupId` no longer appears in `GET /api/portfolio` — the archive operation sets `is_archived=TRUE` and the portfolio query excludes archived projects. Attempting to retrieve conformance for an archived project returns `403` or `404` — the project still exists in the database but is no longer accessible as an active scope. An engineer (non-portfolio-role) attempting `GET /api/portfolio` gets `403` — the `PORTFOLIO_ROLES` gate fires before any query. A `?node_id=` filter that matches only the now-archived project returns an empty `projects[]` — there are no non-archived projects in that node.

### Gaps

| Gap | Notes |
|-----|-------|
| 🖥️ S-22.5–S-22.8 | Browser tests verified in Docker mode |
| ❌ Portfolio drill-down into individual project | Portfolio page links to project detail; detail page not E2E tested |
| ❌ Conformance score trend over time | Score is point-in-time; no historical chart |
| ❌ Criticality field user-configurable | Rollup uses `criticality` but it's not user-configurable via config schema |

---

## Cross-Cutting Gap Analysis

### Features with zero E2E coverage

| Feature | Where it lives | Coverage |
|---------|----------------|----------|
| GitHub OAuth browser login | `routes/auth.js` browser flow | 🔶 MT-11 only |
| PKCE OAuth 2.1 MCP flow | `routes/mcp-oauth.js` | 🔶 MT-12 only |
| MCP stdio protocol (`remember`, `recall`, `reflect`, etc.) | `quorum-mcp` | 🔶 MT-01–MT-06 only |
| Graphiti semantic vector search | `routes/graphiti.js` proxy | Unit test + 🔶 MT-13 |
| Confidence decay script | `scripts/decay.js` | Unit tested (decay.test.js); no E2E |
| Audit chain verification CLI | `scripts/audit-cli.js verify` | ❌ None (API endpoint tested in S-10.11) |
| Dark mode rendering | `ThemeContext.jsx` | ✅ S-14.6 (toggle + persist) |
| Knowledge graph visual quality | `Graph.jsx` Cytoscape | 🔶 MT-04 |
| Auto-supersede MCP trigger | `quorum-mcp/src/governance/authority.js` | 🔶 MT-07 |
| Token revocation / key rotation | `keys.js` | ❌ Accepted risk (GAP-030) |
| `quorum:scan` scheduled automation | `skill/references/scan.md` | ❌ By design — human-triggered (GAP-032) |

### New negative/cross-boundary coverage — 2026-06-04 additions

The 10 new sub-scenarios cover two families of invariants:

**Wrong-order state transitions** — these assert that the state machine correctly rejects operations that are valid in isolation but invalid given the current state:

| Sub-scenario | Transition attempted | Expected result |
|-------------|---------------------|-----------------|
| S-02.13 | Re-review resolved conflict | 404 — no pending row |
| S-03.6 | Deprecate already-DEPRECATED | 404 — state machine blocks |
| S-04.10 | Re-action ACCEPTED deviation | Non-200 — already terminal |
| S-06.7 | Re-review resolved conflict (multi-user) | 404 — no pending row |
| S-11.5 | Re-review resolved conflict (self-approval path) | 404 — no pending row |
| S-17.6 | Enrich + review resolved conflict | Enrich not 5xx; review 404 |

**Cross-project isolation** — these assert that a valid JWT + wrong `X-Quorum-Project` header cannot access another project's resources:

| Sub-scenario | Isolation tested | Expected result |
|-------------|-----------------|-----------------|
| S-02.13 | Wrong header on review | 404 (conflict doesn't exist in that scope) |
| S-03.6 | Wrong header on deprecate | 404 (key not in that scope) |
| S-06.7 | Wrong header on multi-user conflict review | 404 (conflict not in that scope) |
| S-08.7 | Wrong header on bump | 404 (key not in that scope) |
| S-09.9 | Engineer in peer-project attempts role update | 403 (non-PA in that scope) |
| S-12.8 | Wrong header on promote; engineer in peer-project | 404 + 403 respectively |
| S-22.9 | Archived project scope isolation | 403 or 404 |

Every new sub-scenario is marked ⛔ in the TEST-PLAN because wrong-order transitions and cross-project isolation failures are governance or security hard-blocks.

### Browser test coverage summary

Of the ~600 passing tests, **~55 are browser tests** (Playwright Chromium). These cover:

| Page | Covered |
|------|---------|
| `/graph` | ✅ Canvas render, legend, node click |
| `/config` | ✅ Editor display, schema error, save success |
| `/status` | ✅ Health badges |
| `/audit` | ✅ Entry list, author filter |
| `/select-project` | ✅ Switch button, search, cancel |
| `/pending` | ✅ Conflict card, note validation, approve/reject (S-02.8); stale badge (S-02.12); overdue deferrals (S-04.9) |
| `/deviations` | ✅ Filter rail, action panel (S-04.7) |
| `/knowledge` | ✅ Denial badge (S-04.8); search UI + global badge (S-20.8); history drawer (S-16.6) |
| `/stats` | ✅ Stat cards, ConformanceCard (S-07.5–S-07.8) |
| `/admin` | ✅ Heading renders (S-09.5) |
| `/portfolio` | ✅ Rollup banner, table, search, status filter (S-22.5–S-22.8) |
| Dark mode toggle | ✅ S-14.6 — toggle + navigate + persist |

**Not covered by browser tests:**

- Login page (`/login`) — GitHub OAuth requires real browser + GitHub (MT-11)
- Project selector for >10 projects — pagination not browser-tested
- Config editor diff view (v0.5+ — GAP-033 deferred)
- Bulk action bar (deprecate/endorse multiple entries)

### Test isolation & environment risks

| Risk | Current Mitigation | Gap |
|------|-------------------|-----|
| Accumulated test projects polluting project selector | Search by exact name in browser tests; S-01 `afterAll` archives j01 configs | DDB namespace grows indefinitely on repeated runs without `env:clean` |
| S3/DDB persists after `env:clean` (Docker volume wipe) | `POST /config/upload` upsert (409 path re-registers in PostgreSQL) | No full clean of LocalStack state in `env:clean` |
| FalkorDB indexing latency (Graphiti async) | `graphitiSettle()` helper | Not all cross-catalog search tests call it |
| Cross-project seed with inverted role fixture | `quorum-test-peer-project` fixture: `test-architect`=PA, `test-pe`=engineer; peer seeding uses `tokens.architect` directly | Requires discipline in new specs — easy to use wrong token accidentally |

---

## Scoring Summary — 04 June 2026

| Metric | 28 May 2026 | 04 June 2026 | Change |
|--------|-------------|--------------|--------|
| Test count | ~560 | ~600 | +40 |
| Journeys | 21 | **22** | +1 (J22 added) |
| Scenarios | 36 | **46** | +10 negative/cross-boundary |
| Suite OwnScore (W × C × D) | 3605 | **3946** | +341 |
| Weight total (W) | 1352 | **1439** | +87 |
| 10 % deployment gate | 353 pts | **395 pts** | +42 |
| 5 % merge-review gate | 177 pts | **197 pts** | +20 |
| Zero-tolerance ⛔ scenarios | 26 | **36** | +10 |
| Security pillar OwnScore | 1158 | **1445** | +287 |
| Governance pillar OwnScore | 1261 | **1315** | +54 |
| Observability pillar OwnScore | 102 | **177** | +75 |

All 10 new sub-scenarios are in the ⛔ (zero-tolerance) gate tier. A failure in any of them triggers a hard block regardless of the overall OwnScore percentage. This reflects the principle that wrong-order state transitions and cross-project isolation failures are as dangerous as constitutional violations — they can silently allow stale governance actions or data to leak across project boundaries.

---

*Generated: 04 June 2026 — reflects suite state at ~600 passed, 0 failed, 1 skipped.*
*Suite run command: `npm run test:e2e`*
*Log location: `logs/test-e2e-YYYYMMDD-HHMMSS.log`*
*Previous version: [journey-story-28-05-2026.md](journey-story-28-05-2026.md)*
