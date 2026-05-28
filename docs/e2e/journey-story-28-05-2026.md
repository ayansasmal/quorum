# Quorum: Journey Stories — 28 May 2026

> **Purpose:** Each section below maps one E2E journey to a product narrative.
> Stories describe what Quorum *demonstrably does* — validated by passing tests.
> Gaps call out what is not yet verified end-to-end (coverage missing, manual-only, or planned).
>
> **452 tests. 21 journeys. 0 failures.**
>
> Status legend:
> - ✅ Verified end-to-end (API test, green in suite)
> - 🖥️ Verified browser (Playwright UI test, green in suite)
> - 🔶 Manual only (MT-xx, no automated coverage)
> - ❌ Gap (not yet tested or not yet built)

---

## Table of Contents

| Journey | Title | Sub-scenarios | Test Count |
|---------|-------|---------------|------------|
| [J01](#j01) | Global Catalog Onboarding | 13 steps (serial) | 13 |
| [J02](#j02) | Knowledge Governance Lifecycle | S-02.1–S-02.8 | ~40 (5 browser skipped) |
| [J03](#j03) | Knowledge Deprecation & Retirement | S-03.1–S-03.5 | 23 |
| [J04](#j04) | Deviation Recording & PE Governance | S-04.1–S-04.8 | ~26 (7 browser skipped) |
| [J05](#j05) | RBAC Boundary Simulation | S-05.1–S-05.6 | ~30 |
| [J06](#j06) | Multi-User Conflict Resolution | S-06.1–S-06.5 | ~18 |
| [J07](#j07) | Conformance Scoring & Portfolio | S-07.1–S-07.8 | ~21 (8 browser skipped) |
| [J08](#j08) | Confidence Endorsement Lifecycle | S-08.1–S-08.5 | 11 |
| [J09](#j09) | Platform Admin Operations | S-09.1–S-09.6 | ~10 (2 browser skipped) |
| [J10](#j10) | Audit Trail Integrity | S-10.1–S-10.8 | 11 |
| [J11](#j11) | Self-Approval Prevention | S-11.1–S-11.3 | 9 |
| [J12](#j12) | Knowledge Status State Machine | S-12.1–S-12.5 | ~16 |
| [J13](#j13) | Config Sync & Global Discovery | S-13.1–S-13.5 | 16 |
| [J14](#j14) | Dashboard Visual & Interaction | S-14.1–S-14.5 | 12 (11 browser) |
| [J15](#j15) | Reason / Placeholder Rejection | S-15.1–S-15.10 | 20 |
| [J16](#j16) | Knowledge History & Point-in-Time | S-16.1–S-16.5 | 13 |
| [J17](#j17) | Conflict: Governance Edge Cases | S-17.1–S-17.4 | 10 |
| [J18](#j18) | Governance Route: Direct Coverage | S-18.1–S-18.4 | 20 |
| [J19](#j19) | Authentication Lifecycle | S-19.1–S-19.5 | 22 |
| [J20](#j20) | Cross-Catalog Search | S-20.1–S-20.7 | 15 |
| [J21](#j21) | MCP Layer Gateway Contracts | S-21.1–S-21.5 | 20 |

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
| S-02.6 Coexist-Split | PA resolves by splitting into two scoped entries (e.g. `security-tls-prod` + `security-tls-dev`); both land as DRAFT |
| S-02.7 Coexist-Merge | PA merges two conflicting entries into one unified ACTIVE entry; both old entries SUPERSEDED atomically |
| S-02.8 Dashboard UI (browser) | Pending page conflict card displays; note < 10 chars blocks submission; `request_changes` keeps conflict open; `approve` removes card; audit timeline shows `review` tool entries |

### Story

> *Two engineers independently document what they believe is the correct TLS policy.*

Engineer A writes `security:tls-minimum-version`. Engineer B writes the same key with a contradicting statement. The second write detects the conflict (via Graphiti semantic search in production, or via the governance endpoint directly) and creates a `pending_decisions` record with an LLM-generated analysis of *why* the two statements contradict.

The conflict appears in the Pending Decisions dashboard. The PA opens it and sees both versions side by side with an AI analysis of the contradiction. They can:

- **Supersede** — one version wins, the other is archived (no hard delete — both are in history)
- **Reject** — the incoming entry is discarded; the existing one survives unchanged
- **Request changes** — the conflict stays open; the PA adds a note requesting clarification
- **Coexist-split** — the PA acknowledges both are valid in different contexts (prod vs. dev) and creates two scoped entries
- **Coexist-merge** — the PA synthesises a single unified statement, superseding both

Every resolution path is covered. None produce data loss. The atomic supersede guarantee means a PA can never accidentally leave the system in a half-transitioned state.

### Gaps

| Gap | Notes |
|-----|-------|
| 🖥️ S-02.8 browser tests | Run in Docker mode — verified but require `QUORUM_DASHBOARD_URL` env |
| ❌ Stale-warning badge on re-read | Verified API shape; browser rendering of stale badge not separately tested |
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
| S-03.4 Deprecation Request: Approve | Engineer queues `forget()` instead of getting forbidden; PA reviews and approves → entry DEPRECATED; request removed from pending |
| S-03.5 Deprecation Request: Reject | PA rejects deprecation request; entry remains ACTIVE; request resolved but entry untouched |

### Story

> *A platform team decides the legacy session-cookie auth pattern is obsolete.*

A PA calls `POST /api/knowledge/auth/session-cookies/deprecate` with a business justification. The entry transitions to DEPRECATED, is removed from the knowledge browser, but its full history (including the deprecation reason and who deprecated it) is preserved in the audit chain. **Nothing is deleted.**

What if an engineer identifies a pattern that should be retired — but only a PA can deprecate? The engineer calls `forget()` from the MCP, which instead of returning `403 forbidden` queues a **deprecation request** in the Pending Decisions queue. The PA sees it, reviews it, and either approves (the entry is atomically DEPRECATED) or rejects (the entry survives, the request is resolved).

Bulk deprecation handles partial success gracefully: if one entry is missing, the rest still get deprecated and the failures are itemised in the response.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Dashboard deprecation UI for bulk | The DeprecateDialog and BulkActionBar are tested visually only in S-04 deviation tables, not specifically for knowledge deprecation bulk flow |
| ❌ Deprecation request stale-warning in browser | The `stale_warning` badge on an overdue deprecation request is tested API-only |
| ❌ Notification to the engineer who raised the request | No notification mechanism exists yet (v0.5+) |

---

## J04 — Deviation Recording & PE Governance {#j04}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-04.1 Deviation Recording | `POST /api/deviations` idempotent upsert; severity = `confidence × ROLE_SCORES[role]`; PA-authored floor = 0.70 |
| S-04.2 Validation Guards | `not_linked` (project has no globals) → 400; `not_found` (catalog entry absent) → 404; missing fields → 400 |
| S-04.3 Accept | PE accepts deviation → ACCEPTED; removed from OPEN filter |
| S-04.4 Deny | PE denies with reason; `denial_hint` returned when catalog entry is high-confidence PA-authored (non-blocking warning) |
| S-04.5 Defer | PE defers with deadline; `DEFER_DEADLINE` constitutional validation enforces 30/45/60/90d window; status → DEFERRED |
| S-04.6 Batch Recording | Up to 100 records; partial success via `Promise.allSettled`; returns `{ recorded, failed, results }` |
| S-04.7 Dashboard UI (browser) | Filter rail, table rows, inline action panel, reason validation, OPEN filter clears on accept |
| S-04.8 Knowledge Denial Badge (browser) | `✕N` badge on global catalog entries with active denials; tooltip shows count |

### Story

> *A mobile team needs to use a deprecated OAuth pattern that the security catalog has marked as non-compliant.*

The team records a **deviation** against `quorum-test-catalog:auth:oauth-standard`. The record is idempotent — re-scanning doesn't create duplicate rows, it just updates `last_seen_at`. Severity is calculated from the catalog entry's confidence and the author's role weight, so a PA-authored high-confidence standard generates a higher-severity deviation than an engineer-authored low-confidence one.

The PA reviews the deviation queue. They can:

- **Accept** — acknowledge the deviation is intentional and tracked
- **Deny** — reject it; if the standard is high-confidence and PA-authored, a non-blocking hint is returned suggesting the PA reconsider
- **Defer** — schedule a resolution for 30/45/60/90 days out; the system enforces the deadline window constitutionally

Batch recording lets a scan tool submit up to 100 deviations in one call, with partial success handling so one bad entry doesn't poison the batch.

On the dashboard, the Deviations page shows a filter rail (by status, topic, severity), and each OPEN row has an inline action panel. The knowledge browser shows `✕N` badges on global catalog entries that have been denied by N projects — giving catalog authors visibility into how widely their standards are being rejected.

### Gaps

| Gap | Notes |
|-----|-------|
| 🖥️ S-04.7 / S-04.8 | Browser tests verified in Docker mode |
| ❌ Overdue deviation escalation notifications | No notification mechanism exists yet |
| ❌ Deviation re-scan automation | `quorum:scan` skill exists in documentation; no automated scheduler in gateway |
| ❌ Deviation export / reporting | No bulk export endpoint; only `GET /api/deviations` with filters |

---

## J05 — RBAC Boundary Simulation {#j05}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-05.1 Knowledge Write | All 8 roles can write; non-PA → DRAFT, PA → ACTIVE; confidence floored at `base_confidence`; unknown project → 404 |
| S-05.2 Promote + Supersede | Non-PA → 403; PA → 200 on both operations |
| S-05.3 Single + Bulk Deprecate | Non-PA → 403; PA → 200 |
| S-05.4 Review + Global Write | Non-PE review → 403; PA review → 200; global catalog: engineer/senior/director/vp → 400 GLOBAL_WRITE_AUTHORITY; catalog members (architect/product/compliance) → 201 DRAFT; PA → 201 DRAFT (self-approval) |
| S-05.5 Deviation Action + Forget | Executive roles blocked from `action` (DEVIATION_ACTION_AUTHORITY); PA/PA-tier → 200; non-PE → 403 on deprecate; `forget()` available to all |
| S-05.6 Portfolio + Admin | Engineer/architect → 403 on portfolio; PA/director/vp → 200; all 8 roles → 403 on `/admin/*`; `is_admin` JWT → 200; missing project header → 400 |

### Story

> *Eight different team members — from intern to VP of Engineering — try to use every governance operation.*

This journey is Quorum's trust contract table, verified exhaustively. The findings:

- **Anyone can write knowledge.** Quorum is not a write-gate. The gate is on *who becomes ACTIVE*.
- **Only the Principal Architect can change status** (promote, supersede, deprecate, review). RBAC doesn't prevent contribution — it governs promotion to authoritative status.
- **Global catalogs enforce multi-party governance.** Even the PA who owns the catalog cannot self-promote their own entries. A second PA must promote.
- **Executive roles (director, VP) have read-wide access to portfolio** but cannot perform deviation governance actions. This prevents influence without accountability.
- **Platform admins are a separate identity** (`is_admin` JWT claim), orthogonal to project role. They can manage the platform but cannot bypass project governance.
- **Confidence is always floored** at the author's `base_confidence`. Submitting `confidence: 0.10` for a PA results in `confidence: 0.90` being stored — preventing false humility from eroding the authority signal.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Role coverage for `PUT /config/:projectId` (config update) | Not in RBAC matrix test |
| ❌ `is_owner` distinction vs. `principal_architect` role | Ownership transfer tested in S-15.9 but ownership-only gates are not RBAC-matrix-tested |
| ❌ Newly-onboarded role that is not in the member list | Tested indirectly (unknown project → 404) but not "valid user, wrong project" for every operation |

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

### Story

> *A distributed team on different time zones both update the same database indexing pattern simultaneously.*

Both writes succeed. The second one is flagged `PENDING_CONFLICT_CHECK` — the write is not lost, but it awaits review. A `pending_decisions` record captures both versions, the conflict reason, and an `enrichment` object with AI analysis.

If multiple conflicts pile up on the same key (a "hot key" in active debate), the `more_pending_same_key` counter tracks the backlog. Resolving the first conflict decrements it.

The PA works through the queue in order: approve the first (creates a new ACTIVE via atomic supersede), reject the second (discards the duplicate). The final knowledge state is consistent — no orphan versions, no ambiguity about which entry is authoritative.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Real-time dashboard updates when conflict resolves | WebSocket / polling not tested; engineers must manually refresh |
| ❌ Notification to the conflicting author | No notification mechanism on conflict detection |
| ❌ Three-way concurrent conflict | Only two-way conflict tested; N-way conflict handling undefined |

---

## J07 — Conformance Scoring & Portfolio Intelligence {#j07}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-07.1 UNCERTIFIED Gates | No globals → UNCERTIFIED; sparse catalog (<10 entries) → UNCERTIFIED regardless of scan state |
| S-07.2 CERTIFIED Baseline | 10-entry seed + `POST /pg/scans` → `GET /api/conformance` returns score/status/breakdown/catalogs |
| S-07.3 Score Formula | OPEN weight 1.0, DENIED weight 0.3; score = (1 − weighted_deviation_ratio) × 100 |
| S-07.4 Portfolio Role Gate | Engineer/architect → 403; PA/director → 200; rollup = Σ(score × criticality) / Σ(criticality) |
| S-07.5–S-07.8 Dashboard (browser) | Stats page stat cards; ConformanceCard label/badge; UNCERTIFIED project card; score badge absent when uncertified |

### Story

> *The CTO wants to know: how well are our 12 product teams following the architecture standards?*

Every project linked to a global catalog gets a **conformance score** — a 0–100 measure of how many applicable standards the project has accepted, denied, or is actively deviating from.

The score formula is nuanced: an OPEN deviation and an OVERDUE deviation both carry full weight (1.0). A DEFERRED deviation carries partial weight (0.6 — someone is working on it). A DENIED deviation carries low weight (0.3 — the team consciously rejected the standard). A RESOLVED deviation carries zero weight.

A project is **UNCERTIFIED** until the linked catalog has 10+ ACTIVE entries and at least one conformance scan has been run. This prevents "green washing" — a project linked to an empty catalog shouldn't score 100%.

The **portfolio view** (PA, director, VP only) shows all projects with their conformance scores, weighted by a `criticality` value, and rolls them up into an org-wide score. Projects with no globals or insufficient catalog coverage are counted separately as UNCERTIFIED rather than being included in the weighted average.

On the Stats dashboard, the ConformanceCard shows a score badge (green ≥80, amber 50–80, red <50) with a breakdown bar segmented by deviation status.

### Gaps

| Gap | Notes |
|-----|-------|
| 🖥️ S-07.5–S-07.8 | Browser tests verified in Docker mode |
| ❌ Portfolio full-page UI | `GET /api/portfolio` is tested; dashboard Portfolio page with sorting/filtering/drill-down is v0.5+ |
| ❌ Automated conformance scan scheduling | `quorum:scan` skill exists; no gateway-side scheduler |
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

### Story

> *An architect finds a well-established auth pattern that has been production-proven for two years and wants to signal its maturity.*

They call `POST /api/bump/auth/jwt-validation-pattern`. The entry's confidence increases by a role-weighted delta. A PA's endorsement carries more weight than an engineer's — reflecting authority asymmetry in the domain.

The bump is **capped at the original `starting_confidence`** — there's no mechanism to inflate confidence beyond its initial assessment. Endorsements can close the gap between current confidence and its ceiling, not exceed it.

Each user can only endorse an entry once every 7 days — preventing a single person from repeatedly endorsing to inflate a number. The cooldown is per-author, so a team of 5 engineers can all endorse in the same week.

The response tells the endorser when they can endorse again (`next_bump_allowed`), what the delta was, and the before/after confidence — giving full transparency.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Endorsement history / who endorsed | No `GET /api/endorsements/:topic/:key` endpoint to see who endorsed |
| ❌ Decay mechanism | Confidence decay over time (`scripts/decay.js` exists) but is not E2E tested |
| ❌ Endorsement visible in dashboard Knowledge browser | The `confidence` field updates but there's no endorsement history panel in the UI |

---

## J09 — Platform Admin Operations {#j09}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-09.1 Admin Config | `GET /admin/config` requires `is_admin` JWT; returns all project configs; non-admin → 403 |
| S-09.2 User Management | `POST /config/update-role` requires admin or PA; role validated; unknown project → 404 |
| S-09.3 Project Listing | `GET /admin/projects` returns all projects; admin-only |
| S-09.4 Reason Guard | Reason ≥ 10 chars; placeholder pattern `/(na\s*)+/i` blocks "na na na na"; 400 on violation |
| S-09.5 Dashboard Admin Panel (browser) | Admin panel visible to `is_admin` users; heading is "Admin" |
| S-09.6 User Profile | `GET /user/profile/:username` resolves Redis → DDB; includes role, projects, base_confidence |

### Story

> *The platform team needs to manage Quorum across 20 engineering projects.*

Platform admins (`is_admin: true` in JWT — separate from project roles) can see all project configs, add/remove platform admins, and list all registered projects. This is the operations surface, not the governance surface.

Role updates require a reason — and that reason must be substantive. "tbd" and "na na na na" are rejected as placeholders. This prevents lazy audit entries from degrading the trustworthiness of the audit trail.

User profiles are cached in Redis with a DDB fallback, so profile resolution is fast even at scale. The profile includes the user's role and base_confidence across all their projects — the inputs for the authority and delta calculations used throughout the system.

### Gaps

| Gap | Notes |
|-----|-------|
| 🖥️ S-09.5 | Browser test verified in Docker mode |
| ❌ Admin project offboarding | `DELETE /projects/:id` is dashboard-only; no E2E test for project retirement flow |
| ❌ Bulk role management | Roles are updated one user at a time; no batch operation |
| ❌ Admin audit log | Admin operations write to the audit chain but there's no filtered `tool=admin-*` view in the dashboard |

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
| S-10.8 Lineage | `GET /pg/audit/lineage/:topic/:key` returns empty for dashboard-created entries (MCP writes populate this) |

### Story

> *A compliance officer needs to demonstrate that no knowledge entry was retroactively altered.*

Every write in Quorum — whether from the MCP, the dashboard, or an API client — generates an immutable audit entry with a SHA-256 hash chained to the previous entry. The `chain_position` is a monotonically increasing BIGINT. The `previous_hash` links each entry to its predecessor, forming a tamper-evident chain.

The audit API lets compliance teams filter by author, tool (`dashboard-create`, `mcp-write`, `review`, etc.), topic, or time window. Fetching a specific entry by ID returns `null` instead of `404` for non-existent IDs — preventing an attacker from enumerating which audit IDs exist.

`GET /pg/audit/lineage/:topic/:key` provides an end-to-end trace for MCP-written entries: every version creation, conflict review, and status transition that touched a given knowledge entry — linked bidirectionally between the knowledge version record and the audit entry.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Chain integrity verification (`scripts/audit-cli.js verify`) | The `verify` command exists but is not in the E2E suite |
| ❌ Hash chain tamper detection | No test that mutates an entry and verifies the chain breaks |
| ❌ Audit export for compliance (`scripts/audit-cli.js export`) | CLI exists; not E2E tested |
| ❌ Dashboard audit timeline pagination | Tested for "entries exist" but not for large-volume pagination |

---

## J11 — Self-Approval Prevention {#j11}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-11.1 Global Catalog Self-Approval | PA writes to `is_global: true` project → DRAFT; self-promote attempt → 403; second PA promotes → ACTIVE |
| S-11.2 Engineer DRAFT Self-Approval | Engineer writes → DRAFT; engineer attempts review → 403 (NO_SELF_APPROVAL); PA review → 200 |
| S-11.3 MCP-Path Self-Approval | MCP `remember()` → DRAFT (`author='claude'` forces DRAFT); senior author attempts review → 403; PA review → 200 |

### Story

> *Quorum's fourth constitutional rule: no one can approve their own knowledge.*

This applies at every level and every entry path. It is not a convention — it is enforced in code and verified in three distinct flows:

1. A PA who writes to a global catalog cannot promote their own DRAFT, even with the highest authority level in the project. The catalog requires a second PA to promote.
2. An engineer who writes a DRAFT cannot review and approve it themselves. Even if they have a reason, the system returns `403 ConstitutionalViolation NO_SELF_APPROVAL`.
3. The MCP (`author='claude'`) always writes DRAFT. The person who triggered the MCP write cannot review their own AI-assisted entry. A different PA must review.

The combination of these three rules means that every ACTIVE entry in Quorum has been seen and approved by at least one human who was not its author.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Self-approval for coexist-merge | When a PA merges two conflicting entries (one they wrote), the NO_SELF_APPROVAL rule interaction is not separately E2E-tested |
| ❌ Delegation / "reviewed-by" attribution in audit | The audit entry tracks who reviewed, but there's no separate "reviewed_by" field on the knowledge version |

---

## J12 — Knowledge Status State Machine {#j12}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-12.1 Valid Transitions | DRAFT→ACTIVE (promote); DRAFT→REJECTED (review reject); ACTIVE→SUPERSEDED (supersede); ACTIVE→DEPRECATED (deprecate) |
| S-12.2 Invalid Transitions | DRAFT→DRAFT; ACTIVE→DRAFT; REJECTED→*; DEPRECATED→* — all return 404 or 400 |
| S-12.3 DRAFT Coexists with ACTIVE | PA has ACTIVE entry; engineer writes DRAFT on same key; both coexist and are visible in correct APIs |
| S-12.4 Terminal Status Immutability | SUPERSEDED and DEPRECATED entries cannot transition to any other status |
| S-12.5 `GET /api/drafts` | Multiple DRAFTs listed; only DRAFT status returned; `version` field present for promote/supersede chaining |

### Story

> *Knowledge in Quorum follows a well-defined lifecycle — every transition is governed, irreversible, and audited.*

An entry moves through: `DRAFT → ACTIVE → SUPERSEDED / DEPRECATED`. The graph has no back-edges. Once deprecated or superseded, an entry cannot be reactivated, edited, or deleted.

An important nuance: **DRAFT entries coexist with ACTIVE entries on the same key.** If a PA has approved `auth:tls-standard` as ACTIVE, an engineer can still propose an update (which lands as a new DRAFT for the same key). The ACTIVE entry remains authoritative until a PA promotes the new DRAFT, which atomically supersedes the ACTIVE.

`REJECTED` is a terminal status — an engineer's rejected proposal cannot be re-submitted under the same path (they would need to use a new key or have a PA unsuppress it).

`GET /api/drafts` is the "inbox" for the PA — all DRAFTs awaiting review, with their version numbers so promote/supersede operations can chain correctly.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ `PENDING_CONFLICT_CHECK → DRAFT` transition | Tested in S-17.2 (PATCH route) but not via the full lifecycle |
| ❌ REJECTED entry re-submission path | No defined workflow for an engineer to re-propose a rejected entry |
| ❌ Stale DRAFT cleanup | DRAFTs older than N days have no automatic expiry or reminder mechanism |

---

## J13 — Config Sync & Global Catalog Discovery {#j13}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-13.1 Sync Auth | `POST /sync/configs` requires PA JWT or sync token; engineer → 403 |
| S-13.2 Sync Response Shape | `{ synced: ≥3, failed: [], globals_warnings: [], duration_ms }` |
| S-13.3 Self-Reference Guard | Project that lists itself in `globals` uploads (201) but sync puts it in `failed[]` |
| S-13.4 `GET /api/globals` | Discovers `is_global=TRUE` projects; enriches with config metadata; non-member of private project → 403 |
| S-13.5 Config Schema Validation | Invalid `global_scope` → 400; `is_global`, `hierarchy`, `globals` all accepted; `globals:[catalog]` validated |

### Story

> *The platform team adds a new global catalog. Ten minutes later, all 20 engineering projects automatically reflect the update.*

`POST /sync/configs` is the operational heartbeat of Quorum's federation layer. It reads all configs from S3 and syncs them to DynamoDB — updating memberships, global catalog links, and hierarchy metadata. It returns a structured summary of what synced, what failed, and any warnings (e.g., a project referencing a catalog that doesn't exist).

The **self-reference guard** prevents a project from listing itself as its own global catalog — a misconfiguration that would create a circular federation loop.

`GET /api/globals` provides the discovery endpoint: any authenticated user can see which projects are global catalogs, what scope they apply to (`org`, `division`, `department`), and how many ACTIVE entries they have. Private global catalogs are filtered by hierarchy ancestry — a division-scoped catalog is visible to projects in that division's hierarchy, not the entire org.

Config schema validation (`POST /config/validate`) is unauthenticated — allowing CI pipelines to validate configs before upload without requiring a JWT.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ EventBridge-triggered sync | `POST /sync/configs` supports `X-Quorum-Sync-Token` for EventBridge but there's no E2E test of the webhook-style invocation |
| ❌ Hierarchy ancestry filtering end-to-end | Unit-tested; no E2E test of a division-scoped global catalog being invisible to a project in a different division |
| ❌ Config update workflow | Config updates go through the dashboard Config editor; not E2E tested (only the validation endpoint is tested) |

---

## J14 — Dashboard Visual & Interaction Flows {#j14}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-14.1 Knowledge Graph | Domain `<select>` → Cytoscape canvas renders; legend labels (Decision/Pattern/CONFLICTS); node-click grid sweep → NodePanel if hit; `GET /api/graph?domain=auth` contract (API-only, runs in all envs) |
| S-14.2 Config Editor | Textarea shows current config JSON; schema-invalid JSON (missing `owner`) → 400 → red error div → Save disabled |
| S-14.3 System Status | "Service health" heading; all service names visible; ≥ 3 Healthy badges; 0 Unavailable |
| S-14.4 Audit Timeline | Entries listed; "No audit entries found." absent; author filter narrows results |
| S-14.5 Project Selector | Switch button in header (requires `availableProjects.length > 1`); search input filters projects; "Back to current project" navigates to `/` |

### Story

> *A new engineer joins the team and opens the Quorum dashboard for the first time.*

The **Knowledge Graph** (`/graph`) shows the organisation's institutional memory as a force-directed graph — Decisions as one colour, Patterns as another, and CONFLICTS clearly marked for PA attention. Clicking a node opens a panel with author, confidence, version, and status.

The **Config Editor** (`/config`) lets PAs update project config in a raw JSON textarea with live schema validation. Submitting invalid config (e.g., missing the required `owner` field) shows an immediate red error banner and disables the Save button — the gateway's `POST /config/validate` enforces the schema even before save.

The **System Status** page (`/status`) shows real-time health of all backend services — Gateway, PostgreSQL, Graphiti, FalkorDB, Redis. In the test stack, all services show Healthy.

The **Audit Timeline** (`/audit`) is the compliance view: a filterable chronological list of every write, review, and governance action. Author filter, tool filter, and topic filter narrow the results in real time.

The **Project Selector** lets users switch between projects they're a member of. When only one project is available, the switch button is hidden entirely.

### Gaps

| Gap | Notes |
|-----|-------|
| 🖥️ All S-14 sub-scenarios except S-14.1 step 3 | Browser tests run in Docker mode only |
| ❌ Knowledge graph visual quality | Node layout, edge rendering, label legibility — MT-04 (manual) |
| ❌ Config editor diff view | No side-by-side diff between current and proposed config |
| ❌ Dark mode rendering | ThemeContext tested manually; no E2E screenshot comparison |
| ❌ Mobile / responsive layout | All browser tests use Desktop Chrome; no mobile viewport test |
| ❌ Pending Decisions page browser tests | S-02.8 is the only browser test for Pending; it's Docker-mode only |

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

Constitutional Rule 3 (`REASON_REQUIRED`) is one of Quorum's most pervasive checks. It applies to all 10 governance endpoints that mutate authoritative state. The rule is simple: a reason must be at least 10 characters, and it must not match the placeholder list (`"ok"`, `"yes"`, `"tbd"`, `"todo"`, `"n/a"`, `"na"`, `"test"`, `"fixme"`, `"."`, `"!"`).

The edge case `"na na na na"` — which is 11 characters and therefore passes the length check — is caught by the regex pattern `/^(na\s*)+$/i`. The system rejects it as a placeholder regardless of how many times `na` is repeated.

Every endpoint returns `400 { rule: 'REASON_REQUIRED', message: '...' }` — a structured error that lets API clients distinguish placeholder rejection from other validation failures.

The 10-endpoint coverage matrix means that no new governance operation can be added to the gateway without also being covered by this journey's pattern.

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
| S-16.4 Nonexistent Key | → 200 `[]` (not 404; `getOrCreateKey` creates a key row but no versions) |
| S-16.5 Point-in-Time (`/at`) | `tBefore` → null/404; `tAfterV1` → v1 content; missing `date` param → 400 |

### Story

> *A security team asks: what was the TLS policy on 1 January 2026, at the time of a production incident?*

`GET /pg/versions/security/tls-minimum/history` returns the complete version lineage of that entry — every write, supersede, and deprecation, newest-first, with timestamps, authors, and the reason for each transition.

`GET /pg/versions/security/tls-minimum/at?date=2026-01-01T00:00:00Z` returns the exact version that was ACTIVE at that moment — enabling point-in-time compliance reporting. If no version existed at that date, the endpoint returns null rather than the current version.

The `triggered_by` field is constitutionally non-null on every version. This means every entry in the history has a traceable origin — whether it was written by a PA via the dashboard (`triggered_by: 'dashboard'`), by the MCP (`triggered_by: 'mcp'`), or by a governance action (`triggered_by: 'review'`).

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Point-in-time across supersede chains | Tested for a single key; multi-hop supersede chain (v1→v2→v3) point-in-time not separately tested |
| ❌ History export | No bulk export of full history for a domain or project |
| ❌ Dashboard history panel | The Knowledge browser shows current version only; no history panel in UI |

---

## J17 — Conflict: Governance Edge Cases {#j17}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-17.1 Auto-Supersede State Invariants | Via `POST /pg/versions/supersede`; v1 SUPERSEDED, v2 ACTIVE, no pending_decision created, `supersedes_reason` preserved |
| S-17.2 `PENDING_CONFLICT_CHECK` Status | Version inserted/patched to `PENDING_CONFLICT_CHECK`; Docker-pause test (skipped without `QUORUM_DOCKER_E2E`) |
| S-17.3 Cross-Catalog Conflict Brief Shape | Seeded conflict with `existing_content` from global catalog; `conflict_reason` identifies catalog source |
| S-17.4 Enrichment Response Shape | `analysis`, `risks_if_approved` (2–4 items), `questions_for_reviewer` (2–3 items) |

### Story

> *Edge cases that the main governance flow doesn't hit — but that can corrupt the knowledge graph if they're wrong.*

**Auto-supersede** is the MCP-layer mechanism where a high-confidence write by a PA can atomically supersede a low-confidence contradicting entry without going through the conflict queue. The HTTP tests verify the *end state* this produces — both versions preserved, no pending_decision created — without testing the MCP trigger logic (which is MT-07).

**`PENDING_CONFLICT_CHECK`** is the graceful degradation state when Graphiti is unavailable during an MCP write. The entry is stored in PostgreSQL but flagged for deferred conflict checking. The HTTP layer verifies this status is storable and retrievable — the Docker-pause simulation of Graphiti being down is reserved for the Docker E2E environment.

**Cross-catalog conflict briefs** verify that when the MCP detects a contradiction between a local write and a global catalog entry, the `pending_decisions` record correctly identifies the catalog source in `conflict_reason`. This enables the PA to see immediately whether the conflict is internal or cross-catalog.

**Enrichment** from the AI analysis (`POST /governance/enrich`) has a structural contract: an `analysis` string, 2–4 `risks_if_approved` items, and 2–3 `questions_for_reviewer` items. These are loaded into the Pending Decisions UI to help the PA make an informed decision.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Auto-supersede MCP trigger (`shouldAutoSupersede()`) | MT-07; requires a real MCP client connection |
| 🔶 Docker-pause Graphiti unavailability test | S-17.2 step 4 only runs with `QUORUM_DOCKER_E2E=true` |
| ❌ Enrichment persistence across page reload | Enrichment is computed at review time; not persistently stored on the `pending_decisions` row |

---

## J18 — Governance Route: Direct Coverage {#j18}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-18.1 `detect-conflict` | Missing `existing` → 400; missing `incoming` → 400; happy path → 200 `{contradicts, reason, possible_split, split_suggestion}`; unauthenticated → 401 |
| S-18.2 `enrich` | Missing `conflict_reason` → 400; missing `existing` → 400; happy path → 200; `analysis` non-empty string; `risks_if_approved` 2–4 items; `questions_for_reviewer` 2–3 items |
| S-18.3 `extract` | Missing `task_summary` → 400; happy path → items array; each item: `topic`, `key` (kebab-case), `content` > 10 chars, `entity_type`, `confidence` ∈ [0,1], `mode` ∈ {echoing, extracting, generalising} |
| S-18.4 Sanitization | 2500-char inputs to `detect-conflict` and `extract` → 200 (silently truncated, never errors) |

### Story

> *Three governance routes power the AI layer of Quorum's conflict detection and knowledge extraction.*

`POST /governance/detect-conflict` takes two knowledge statements and asks the AI whether they contradict. The response tells the PA not just *whether* they conflict, but *why*, and whether a coexist-split is possible.

`POST /governance/enrich` deepens a known conflict with a reviewer briefing: an analysis of the contradiction, a list of risks if the incoming version is approved, and questions the PA should ask before deciding.

`POST /governance/extract` takes a task summary (e.g., a commit message, a PR description, a session transcript) and extracts learnable knowledge candidates. Each candidate has a topic, a kebab-case key, content, an entity type, a confidence tier, and a mode (`echoing` for explicit decisions, `extracting` for inferred patterns, `generalising` for abstract principles).

The sanitization test confirms that even 2500-character inputs — longer than most real inputs — are silently truncated to 2000 characters before LLM interpolation, never causing an error. This is the prompt-injection boundary.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ LLM quality of extracted items | Mock returns deterministic canned responses; real-model extraction quality is MT-13 |
| ❌ `constraints` field in `extract` | S-21.3 confirmed constraints are accepted but silently dropped (not forwarded to `buildExtractPrompt`) |
| ❌ Authentication requirement on `detect-conflict` | `verifyJwt` is applied but there's no project-scope requirement; any authenticated user can call it |

---

## J19 — Authentication Lifecycle & Boundary Enforcement {#j19}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-19.1 JWT Validation Boundaries | Valid → 200/404; missing header → 401 `missing_token`; expired → 401 `token_expired`; tampered signature → 401 `invalid_token`; HS256 → 401 (algorithm enforcement); non-member of private project → 403 |
| S-19.2 JWKS Endpoint Structure | 200 with `keys[]`; EC key type; ES256/P-256; `use: sig`; `kid` present; no HS256 or RSA keys |
| S-19.3 Project-Scoped Role Resolution | Member project → 200; non-member role-gated route → 403; missing `X-Quorum-Project` → 400 |
| S-19.4 Token Refresh | Valid JWT → 200 with new token; `sub` matches; `expires_in > 0`; expired JWT → 401 `token_expired`; invalid string → 401 |
| S-19.5 PAT Authentication | Pre-minted JWT → 200/404; bogus string → 401 |

### Story

> *Security starts at the token. Quorum's auth layer is exhaustively tested for every failure mode.*

Every request to the gateway must carry an ES256-signed JWT with `iss: 'quorum-gateway'`. The algorithm enforcement is absolute — HS256 tokens are rejected because the server only accepts `['ES256']`. Algorithm confusion attacks are impossible by construction.

Tampered tokens (modified payload with original signature) are rejected as `invalid_token` — not `token_expired` or any other hint that reveals the token structure. Expired tokens get a distinct `token_expired` error code, enabling clients to trigger a refresh without showing a login screen.

The JWKS endpoint (`.well-known/jwks.json`) is public — no auth required — and serves only EC/P-256 signing keys. No encryption keys, no RSA, no HS256. External verifiers and MCP clients use this to validate tokens without contacting the gateway for every request.

Project scope is per-request via `X-Quorum-Project` header. Missing it on a project-scoped route returns 400. Using a valid JWT for a project where the user is not a member of a private project returns 403 — the `is_public` flag controls whether non-members can read the project at all.

Token refresh uses a sliding window: the access JWT *is* the refresh token. Presenting a valid (unexpired) access token to `POST /auth/refresh` returns a new token with a fresh expiry.

### Gaps

| Gap | Notes |
|-----|-------|
| 🔶 GitHub OAuth browser flow | MT-11; requires a real GitHub OAuth app and browser interaction |
| 🔶 PKCE OAuth 2.1 end-to-end | MT-12; requires an MCP client and full browser flow |
| ❌ Token revocation | No token revocation mechanism; compromise requires key rotation |
| ❌ Concurrent refresh race condition | No test for two simultaneous refresh calls from the same client |

---

## J20 — Cross-Catalog Search & Source Attribution {#j20}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-20.1 Query Validation | Missing/empty/single-char `q` → 400 |
| S-20.2 Result Field Shape | All 11 fields present and correctly typed (`source: 'project'|'global'`, `catalog_id: string|null`) |
| S-20.3 Cross-Catalog Scope | Project with globals finds global entries; `source:'global'` + `catalog_id` annotated |
| S-20.4 Scope Isolation | Project without globals cannot find global entries; returns `[]`, not 404 |
| S-20.5 DRAFT Exclusion | DRAFT/DEPRECATED/REJECTED entries excluded from search results |
| S-20.6 Domain Filter | `?domain=<topic>` narrows results to exact topic match |
| S-20.7 Mixed Sources | Single query returns both `source:'project'` and `source:'global'` entries |

### Story

> *An engineer asks: "what does our org know about TLS?"*

A single search query on `GET /api/search?q=tls` hits both the project's own knowledge and all linked global catalogs simultaneously. Results are annotated with their source so the engineer immediately knows whether a pattern came from their project or from an authoritative org-wide catalog.

Critically, the search **never returns DRAFTs** — only ACTIVE entries from both scopes appear. This means search results are always authoritative knowledge, not work-in-progress.

A project without any linked global catalogs gets an isolated view — it can only search its own knowledge. This prevents knowledge leakage across organizational boundaries.

The domain filter (`?domain=auth`) scopes the search to a specific topic, useful in large projects where a broad search would return too many results.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ Graphiti semantic search path | S-20 tests the PostgreSQL ILIKE fallback; Graphiti semantic/vector search is unit-tested and MT-13 |
| ❌ Search result ranking | Results are unranked in the fallback path; Graphiti vector similarity ordering is untested E2E |
| ❌ Search in dashboard UI | The Knowledge browser has a search input but it's not separately E2E-tested against S-20 |

---

## J21 — MCP Layer Gateway Contracts {#j21}

### Sub-scenarios

| Sub | What is tested |
|-----|----------------|
| S-21.1 `pending()` Topic Filter | `GET /pg/pending?topic=X` filters at DB level; `GatewayClient.getPendingDecisions()` forwards `opts.topic` |
| S-21.2 `Requirement` Entity Round-Trip | `entity_type:'Requirement'` accepted; preserved through write → GET → search; `business_owner` property preserved |
| S-21.3 `extract` Constraints | `POST /governance/extract` accepts `constraints[]` (no 400); `constraints` accepted but silently dropped (not in prompt) |
| S-21.4 Config Schema `owner` Required | `POST /config/validate` without `owner` → 400 Zod error; with `owner` → 200; federation fields accepted |
| S-21.5 Status Derived Server-Side | Gateway always derives status from context, ignoring `req.body.status`; PA + non-global + non-reflect → ACTIVE; engineer → DRAFT; `pending_conflict_check: true` flag → `PENDING_CONFLICT_CHECK` |

### Story

> *The MCP layer makes HTTP calls to the gateway. These contracts must be exact — any drift causes silent failures in the AI agent's knowledge writes.*

`GET /pg/pending?topic=auth` filters at the database level, not in the MCP layer. This means the MCP's `pending()` tool can efficiently show only pending decisions relevant to the domain being worked on.

The `Requirement` entity type enables teams to capture **business knowledge** alongside engineering knowledge — feature requirements, compliance constraints, legal obligations. A `Requirement` with a `business_owner` property round-trips through the system unchanged: written by the MCP, visible in search, and filterable in the knowledge browser.

A critical security invariant: the gateway always **derives** the knowledge status server-side. The MCP sends context (author role, project config, whether it's a reflect operation) — not a status value. If the MCP sends `status: 'ACTIVE'` in the body, it is ignored. Only the server knows whether a write should be ACTIVE or DRAFT.

The `pending_conflict_check: true` flag is the exception: when the MCP cannot reach Graphiti for conflict detection, it sends this flag to signal "store but defer conflict check". The gateway maps this to `PENDING_CONFLICT_CHECK` status.

### Gaps

| Gap | Notes |
|-----|-------|
| ❌ `constraints` forwarded to `buildExtractPrompt` | S-21.3 confirmed they're accepted but silently dropped — this is a known gap, not a bug |
| ❌ MCP `remember()` end-to-end via MCP client | All S-21 tests are HTTP; the actual `stdio` MCP protocol is MT-01–MT-06 |
| ❌ `deviate()` MCP tool HTTP contract | Deviation recording via MCP thin proxy is not in S-21 |
| ❌ `conformance()` MCP tool HTTP contract | Similarly absent from S-21 |

---

## Cross-Cutting Gap Analysis

### Features with zero E2E coverage

| Feature | Where it lives | Coverage |
|---------|----------------|----------|
| GitHub OAuth browser login | `routes/auth.js` browser flow | 🔶 MT-11 only |
| PKCE OAuth 2.1 MCP flow | `routes/mcp-oauth.js` | 🔶 MT-12 only |
| MCP stdio protocol (`remember`, `recall`, `reflect`, etc.) | `quorum-mcp` | 🔶 MT-01–MT-06 only |
| Graphiti semantic vector search | `routes/graphiti.js` proxy | Unit test + 🔶 MT-13 |
| Confidence decay script | `scripts/decay.js` | ❌ None |
| Audit chain verification CLI | `scripts/audit-cli.js verify` | ❌ None |
| Config editor dashboard save | `Config.jsx` PUT flow | ❌ None |
| Dark mode rendering | `ThemeContext.jsx` | ❌ Manual only |
| Knowledge graph visual quality | `Graph.jsx` Cytoscape | 🔶 MT-04 |
| Auto-supersede MCP trigger | `quorum-mcp/src/governance/authority.js` | 🔶 MT-07 |
| Token revocation / key rotation | `keys.js` | ❌ None |
| Project offboarding (dashboard) | `DELETE /projects/:id` | ❌ None |
| `quorum:scan` scheduled automation | `skill/references/scan.md` | ❌ v0.5+ |

### Browser test coverage summary

Of the 452 passing tests, **~42 are browser tests** (Playwright Chromium). These cover:

| Page | Covered |
|------|---------|
| `/graph` | ✅ Canvas render, legend, node click |
| `/config` | ✅ Editor display, schema error |
| `/status` | ✅ Health badges |
| `/audit` | ✅ Entry list, author filter |
| `/select-project` | ✅ Switch button, search, cancel |
| `/pending` | ✅ Conflict card, note validation, approve/reject (S-02.8) |
| `/deviations` | ✅ Filter rail, action panel (S-04.7) |
| `/knowledge` | ✅ Denial badge (S-04.8) |
| `/stats` | ✅ Stat cards, ConformanceCard (S-07.5–S-07.8) |
| `/admin` | ✅ Heading renders (S-09.5) |

**Not covered by browser tests:**

- Login page (`/login`) — GitHub OAuth requires real browser + GitHub (MT-11)
- Project selector for >10 projects — pagination not browser-tested
- Knowledge browser search interaction
- Pending page for deviation overdue deferrals
- Config editor save / update
- Bulk action bar (deprecate/endorse multiple entries)

### Test isolation & environment risks

| Risk | Current Mitigation | Gap |
|------|-------------------|-----|
| Accumulated test projects polluting project selector | Search by exact name in browser tests | DDB namespace not cleaned between runs; grows indefinitely |
| S3/DDB persists after `env:clean` (Docker volume wipe) | Fixed in `POST /config/upload` 409 path (today's fix) | No full clean of LocalStack state in `env:clean` |
| FalkorDB indexing latency (Graphiti async) | `graphitiSettle()` helper | Not all cross-catalog search tests call it |
| Parallel worker race on serial-mode specs | `test.describe.configure({ mode: 'serial' })` | Some files are inadvertently relying on this without explicit declaration |

---

*Generated: 28 May 2026 — reflects suite state at 452 passed, 0 failed, 1 skipped.*
*Suite run command: `npm run test:e2e`*
*Log location: `logs/test-e2e-YYYYMMDD-HHMMSS.log`*
