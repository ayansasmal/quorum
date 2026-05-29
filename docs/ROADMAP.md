# Quorum — Roadmap

## North Star

> An autonomous engineering nervous system where AI agents operate as full team members — inheriting institutional knowledge, reasoning over domain context, self-correcting, and delivering complex work — with humans only intervening at genuine decision forks.

Governance is not a feature. It is the architecture. The goal is not to make humans approve everything — it is to make the human decisions that do happen genuinely meaningful.

---

## The Compounding Effect

```
Week 1:   10 nodes    → Claude needs lots of hand-holding
Month 1:  100 nodes   → Claude rarely asks obvious questions
Month 3:  500 nodes   → Claude pre-loads context automatically
Month 6:  2000 nodes  → Agents deliver features semi-autonomously
Year 1:   5000+ nodes → Fork intervention rare, agents are team members
```

Every task makes every future task easier. This is the network effect moat.

---

## v0.1 — Prove the Core Loop
**Goal: Does the fundamental store-retrieve-govern loop work?**

```
MCP Server
  → remember() — store with governance pipeline
  → recall()   — exact topic:key, ACTIVE status only
                  recall with { history: true } for full version chain
                  recall with { at: date } for point-in-time version
                  recall with { version: n } for specific version
  → search()   — semantic search via Graphiti hybrid
  → forget()   — deprecate with required reason, never hard delete
  → export()   — markdown output per topic with version history section

Versioning (fundamental — ships with v0.1)
  → Every knowledge node is immutable once written
  → Changes create new versions — never edits in place
  → topic:key is stable identifier, version increments from 1
  → Only one version ACTIVE at any time
  → All previous versions SUPERSEDED — never deleted
  → Every version carries: triggered_by enum, supersedes reason,
    created_by_audit reference (bidirectional with audit entry)
  → triggered_by: conflict_resolution | engineer_decision | pr_merge |
                  atlassian_sync | confidence_decay | reflect
  → CLI: quorum history topic:key — full version timeline

Knowledge States
  → DRAFT / ACTIVE / SUPERSEDED / REJECTED / DEPRECATED
  → Claude additions always enter as DRAFT
  → State transitions require author + reason — always

Governance — Constitutional Layer (Layer 1)
  → No hard deletes — enforced in code, not config
  → Append-only audit log — immutable, exportable by any role
  → Reason required on all state changes — enforced, not optional
  → No self-approval — conflict parties cannot resolve their own conflicts
  → Multi-party config changes — 2 approvers from different teams + 48h cooling

Provenance
  → Author + timestamp + mode + confidence on every write
  → Claude self-declares mode: echoing / extracting / generalising
  → Source episode traceable for every derived fact

Graph
  → Graphiti integration (FalkorDB default)
  → Engineering entity types: Decision, Pattern, Constraint, Runbook, Requirement
  → Basic conflict detection via semantic similarity + LLM check

Infrastructure
  → Docker Compose: FalkorDB + Quorum in single command
  → Seed data with deliberate contradictions for demo
  → README and 5-minute quick start

Testing — Constitutional Suite
  → 100% coverage on constitutional module — no exceptions
  → All 5 rules tested: direct violation, privilege escalation,
    indirect bypass, race conditions, dependency upgrade safety
  → Meta tests — test suite tests itself
  → CI constitutional guard — cannot be skipped, blocks merge
  → Minimum 20 LLM golden dataset cases

Audit Pipeline (ships with v0.1 — not optional)
  → Dual-store architecture: graph DB primary + flat file secondary
  → Pre + post audit entries on every single operation
  → SHA256 tamper-evident chain across all entries
  → Atomic writes — operation rolls back if either store fails
  → Chain integrity verification on every startup
  → Static analysis in CI — proves no bypass paths exist
  → audit verify, audit lineage, audit export CLI commands

Success criteria:
  → Claude Code answers domain questions using team knowledge
  → Conflict detection triggers on seed contradictions
  → No hard delete possible by any role including principal architect
  → Audit log immutable and fully exportable
  → Zero-install local setup under 5 minutes
```

---

## v0.2 — Full Governance
**Goal: Teams can genuinely trust the knowledge**

```
PACE Framework — Human Empowerment
  → Prepare: full decision brief before any human decision
  → Assess: right moment detection — never interrupt mid-task
  → Contextualise: graph traversal surfaces related knowledge automatically
  → Evaluate: decision quality tracked over time, feeds back into authority

Decision Brief Generation
  → Impact statement: what breaks if this decision is wrong
  → Usage data: how often this knowledge is currently relied on
  → Related context: graph traversal surfaces what else says something relevant
  → Quorum's analysis: observation not recommendation
  → Structured options: A/B/C/D — never open-ended, never binary
  → Readable in under 2 minutes
  → Minimum engagement gate: brief open > 30 seconds before decision accepted

Right Moment Assessment
  → Never interrupt mid-task
  → One decision per session start maximum — no queue dumps
  → Session start is the golden moment: fresh mind, low cognitive load
  → Urgency override: DRAFT about to be used, decision > 48h old

Authority Model
  → Role-based baseline (quorum.config.yml):
      principal_architect: 1.0
      senior_engineer:     0.8
      engineer:            0.6
      junior_engineer:     0.4
      claude:              mode-dependent (0.35 / 0.55 / 0.75)
  → Domain track record: earned per domain, not global
  → Usage validation: unchallenged recalls increase authority over time
  → Formula: role(35%) + domain(30%) + usage(25%) + confidence(10%)

Review Routing by Role
  → Junior    → always DRAFT → senior+ to approve
  → Engineer  → DRAFT by default
                self-approve: domain_entries >= 10, conflict_rate < 10%
  → Senior    → ACTIVE in established domain, DRAFT elsewhere
  → Principal → ACTIVE always, team notified
  → Claude    → always DRAFT, any engineer to approve, never self-approves
  → Security/compliance/infra → principal review regardless of author role

Conflict of Interest Detection
  → Author cannot approve their own knowledge
  → Conflict party cannot resolve their own conflict
  → Cannot delegate review rights for own knowledge
  → Identity normalisation: AYAN == ayan == "ayan " (bypass attacks blocked)

Dissent Preservation
  → Overruled concerns stored permanently — never deleted
  → Surface automatically in incident retrospectives
  → Not punitive — accountability visible, not weaponised

Confidence Lifecycle
  → Initial: author-provided (default 0.7)
  → +0.01 per recall (frequently recalled = more trusted)
  → -0.005 per week without access (staleness decay)
  → -0.1 when conflict raised against it
  → +0.1 if conflict resolved in its favour

Export
  → Markdown per topic: active, superseded, resolved conflicts, audit trail
  → Confluence wiki markup
  → Knowledge stats: gaps, low confidence, stale, disputed

Testing — Governance Suite
  → Behavioural: conflict detection, authority scoring, brief quality
  → Adversarial: prompt injection, authority claim in content, confidence inflation
  → 50+ LLM golden dataset cases
  → CI accuracy: overall >90%, true positive rate >95%

Success criteria:
  → No silent conflict resolution — ever
  → Every write is auditable with full lineage
  → Alert fatigue rate < 10%
  → Decision briefs rated useful > 80% of the time
```

---

## v0.3 — Identity, Cache, and Governance Foundation ✅ Shipped
**Goal: Slim identity model, Redis cache, ownership governance**

```
✅ Slim JWT — { sub, is_admin } only; role + project from header + profile endpoint
✅ X-Quorum-Project header — identity (who you are) decoupled from project scope (what you access)
✅ Redis two-tier cache — config:{group_id}, profile:{sub}, admin:platform; pub/sub invalidation
✅ GET /user/profile/:username — Redis → DDB, role + projects + base_confidence
✅ Ownership governance — POST /config/transfer-ownership, POST /config/update-role
✅ Admin management — GET /admin/config, POST /admin/users; configs/.quorum platform config
✅ Dashboard governance panels — Ownership, Role Editor, Admin; guarded by is_owner / is_admin
✅ summary column as durable content store — survives FalkorDB/volume wipes
✅ group_ids removed from Graphiti search calls — RediSearch hyphen bug workaround
✅ PostgreSQL ILIKE fallback in GET /api/search — resilience when Graphiti empty
✅ POST /api/bump/:topic/:key — confidence endorsement with 7-day cooldown, role-weighted delta
✅ TDD gates for verify-jwt, slim JWT shape, X-Quorum-Project header threading
✅ Deprecation request workflow — non-PE forget() queues pending_decisions(decision_type=deprecation_request); pending() surfaces deprecation_requests[]; review(request_id) approve/reject; dashboard Pending page shows PE-only approve/reject with stale_warning badges
```

Success criteria met:
→ Any gateway replica resolves the same profile in < 1s (Redis hit)
→ Role change reflects in next request without restart
→ Ownership transfer auditable with full lineage
→ Content always retrievable via PostgreSQL even when FalkorDB is wiped

---

## v0.4 — Federation, Conformance & Portfolio Intelligence ✅ Shipped
**Goal: Shared knowledge across projects, measurable standards compliance, org-wide visibility**

```
Wave A — Constitutional + DB Foundation ✅
  ✅ enforceGlobalWriteAuthority (architect+ for global catalog writes)
  ✅ enforceDeviationActionAuthority (architect+ to action deviations; execs excluded)
  ✅ enforceValidDeferDeadline (exactly 30/45/60/90 days)
  ✅ deviations + deviation_actions + project_scans tables; is_global on q_projects
  ✅ DeviationStatus, DeviationActionType, VALID_DEFER_DAYS in graph/schema.js (both repos)
  ✅ QuorumConfigSchema extended: hierarchy, is_global, global_scope, is_public, globals
  ✅ Executive roles: director, vp_engineering, group_executive (0.75/0.70, tier 3)

Wave B — Federation ✅
  ✅ GET /api/globals — discovers is_global=true projects; filters by global_scope
  ✅ Cross-project reads: graphiti.js injects [project, ...globals] for read ops
  ✅ search()/recall() annotated: source + catalog_id on every result node
  ✅ detectConflict() scoped to [projectId, ...globals] — global contradictions detected
  ✅ POST /sync/configs: self-reference check + is_global validation for globals[]
  ✅ quorum:onboard skill — catalog selection via GET /api/globals

Wave C — Deviation Write Path ✅
  ✅ POST /api/deviations — idempotent upsert, server-side severity, PA_AUTHORED_FLOOR
  ✅ POST /api/deviations/batch — up to 100 records, partial success via Promise.allSettled
  ✅ deviate() MCP tool — thin proxy; agents record deviations from scan output

Wave D — PE Governance ✅
  ✅ GET /api/deviations — computed status via LATERAL join; filters: status/catalog/topic/severity
  ✅ POST /api/deviations/:id/action — accept/deny/defer with constitutional enforcement
  ✅ pending() updated: open deviations + overdue deferrals in response
  ✅ Dashboard Deviations page — filter rail, inline action panel, reason validation, denial hint
  ✅ Dashboard Pending page — overdue deferrals section

Wave E — Conformance Scoring ✅
  ✅ GET /api/conformance — weighted score, UNCERTIFIED gate, per-catalog entry counts
  ✅ conformance() MCP tool — score + contextual UNCERTIFIED message + include_details
  ✅ Stats.jsx ConformanceCard — score badge, breakdown bar, staleness warning
  ✅ quorum:scan skill — incremental scan orchestration (code+security review → deviate/remember)

Wave F — Portfolio Intelligence ✅
  ✅ GET /api/portfolio — role-gated (exec+), node_id filter, weighted criticality rollup
  ✅ Knowledge.jsx denial_hint_count — batch query, red pill badge on global entries
  ✅ getPortfolioScores — Promise.allSettled for per-project failure isolation

Wave G — Documentation ✅
  ✅ gateway/openapi.yaml v0.4.0 — all new endpoints, schemas, tags
  ✅ docs/ARCHITECTURE.md — federation model, deviation data model, conformance scoring
  ✅ docs/ROADMAP.md — v0.4 section complete
  ✅ docs/ONBOARDING.md — hierarchy config, quorum:onboard step, global catalog linking
  ✅ docs/FRONTEND.md — Deviations page, Stats update, Pending update, Knowledge update
  ✅ quorum-mcp SKILL.md + README — deviate/conformance tools, scan/onboard skills

Wave H — Quality & Security Hardening ✅ (post-Wave G)
  ✅ GAP-001: adversarial hash-chain tamper detection tests (3 UT)
  ✅ GAP-002: is_public non-member enforcement on all /api/* routes (S-05.10, 6 E2E)
  ✅ GAP-003: coexist_merge conflict resolution + self-approval enforcement (S-11.4, 6 E2E)
  ✅ coexist_merge: new ACTIVE entry by reviewer, both source versions SUPERSEDED atomically
  ✅ getLatestDraftVersion includes PENDING_CONFLICT_CHECK (self-approval check was bypassed for PA writes)
  ✅ LEGAL_TRANSITIONS extended: DRAFT→SUPERSEDED, PENDING_CONFLICT_CHECK→SUPERSEDED
  ✅ POST /config/upload upsert: 200 on update (re-syncs DDB, invalidates Redis), 201 on create
  ✅ test-pe2 (second PA) fixture member added; pe2Token() factory in jwt.js
  ✅ 498 E2E tests passing (up from 492); 685 gateway unit tests (up from 675)

Success criteria met:
  → Cross-project reads: recall() + search() transparently traverse linked global catalogs
  → Conformance scores visible per project in Stats page
  → Deviation governance: PEs can accept/deny/defer with full constitutional enforcement
  → Portfolio view available to principal_architect + executive roles
  → UNCERTIFIED state shown clearly; no misleading scores during cold-start
  → All three P0 security/trust gaps closed (GAP-001, GAP-002, GAP-003)
  → 685 gateway tests + 620 quorum-mcp tests passing · 498 E2E tests (Playwright)
```

---

## v0.5 — Multi-Team and Scale
**Goal: Org-wide, not just one team**

```
Multi-Team Namespacing
  → group_id strategy: isolated team graphs
  → Shared knowledge tier: org-wide ADRs, compliance constraints
  → Cross-team promotion workflow with explicit approval
  → No silent bleed between team graphs

Who Audits the Auditor — Layered Accountability
  → Layer 1: Protocol — constitutional rules enforced in code, not config
  → Layer 2: Peers — distributed review, dissent preserved permanently
  → Layer 3: Graph — decision history audits the decision makers themselves
  → Layer 4: Public — OSS, transparent design, community scrutiny
  → Layer 5: Time — outcomes are the ultimate truth

Constitutional Governance (OSS RFC Process)
  → Constitutional rule changes require 30-day community RFC
  → No single maintainer can push constitutional changes alone
  → Supermajority required for constitutional amendments
  → All constitutional changes audited like any other state change

Atlassian MCP Integration
  → Connect via published Atlassian MCP server (OAuth, no custom infra)
  → enrich_from_jira(issue_key) — extract decisions, requirements,
    constraints, acceptance criteria, linked issues as graph edges
  → enrich_from_confluence(page_id) — extract ADRs, runbooks,
    technical designs, meeting notes
  → search_atlassian(query) — unified search across Jira + Confluence + graph
  → sync_atlassian(domain) — proactive stale knowledge detection
    Jira ticket REOPENED → flag linked knowledge for review
    Confluence page updated → flag extracted knowledge for re-enrichment

Diagram Ingestion (human-assisted, deferred)
  → Engineer exports diagram as image (any format — Draw.io, Lucidchart, whiteboard)
  → Claude vision converts image → Mermaid diagram
  → Engineer reviews and corrects before storing
  → Stored as searchable Mermaid text with image URL as reference
  → Works on any diagram format — not locked to Draw.io XML parsing

Jira as Knowledge Signal
  → Bug tickets → constraint discovered ("X breaks when Y")
  → Story acceptance criteria → Requirement entity type
  → Status transitions → confidence signals (DONE++ REOPENED--)
  → Linked issues → dependency edges in graph (blocks, relates to)
  → Comments → engineering debate captured as decisions

Confluence as Knowledge Signal
  → ADRs → Decision entity type with alternatives + consequences
  → Runbooks → Runbook entity type
  → Technical designs → multiple nodes with relationships
  → Meeting notes → decisions with team endorsement signals
  → Space authority ranking (Engineering > General for technical knowledge)

PR Ingestion
  → GitHub Action on PR merge (lowest friction, highest signal)
  → ingest_pr() — extract decisions, patterns, constraints from:
      PR description (intent), review comments (constraints/patterns),
      review resolutions (what was agreed), approvals (authority signal)
  → PR linked to Jira? → auto-fetch ticket context for enrichment
  → Authority elevated by approver role (principal architect = 0.85)
  → Post-merge CI outcome tracking (90-day confidence update)
  → dry_run mode — engineer reviews extractions before committing

Bidirectional Loop (complete knowledge lifecycle)
  Jira ticket → requirement captured
  Confluence ADR → decision + alternatives captured
  PR reviewed + merged → implementation decisions captured
  Jira closed → confidence increased
  Claude Code session → all of above available as context
  Engineer implements → new knowledge via reflect()
  Quorum exports → Confluence updated
  Confluence change → Quorum sync detects, flags for review

Scale
  → AWS Neptune support (enterprise)
  → OpenSearch Serverless for large graph semantic search
  → Bedrock Titan Embeddings for AWS-native deployments
  → Performance benchmarks: no degradation at 10k+ nodes

Success criteria:
  → Multiple teams using isolated but connected graphs
  → Confluence ingestion working end-to-end
  → Diagram ingestion flow working (image → Mermaid → Quorum)
  → RFC process has processed at least 1 community constitutional proposal
```

---

## v1.0 — Production Ready
**Goal: Trustworthy enough for enterprise**

```
Reliability
  → Full error handling and graceful degradation
  → Retry logic and circuit breakers
  → Zero data loss guarantee on write

Distribution
  → npm package: npx quorum start (zero-config)
  → Docker Hub official image
  → Hosted documentation site
  → External security audit

Observability
  → OpenTelemetry on all graph operations
  → Conflict rate metrics per domain
  → Knowledge growth analytics
  → Governance health metrics (decision latency, rubber stamp rate)
  → Stale node alerts

Success criteria:
  → Zero-config setup via npx under 5 minutes
  → Used by at least 3 external engineering teams
  → Case study: institutional knowledge preserved after engineer departure
  → External security audit passed
  → Constitutional rules never successfully bypassed in production
```

---

## Future Vision

```
HTTP/SSE MCP Transport (post-v1.0)
  → Migrate quorum-mcp from stdio to HTTP/SSE (StreamableHTTPServerTransport)
  → Gateway hosts /mcp endpoint — quorum-mcp becomes a thin local proxy on :8000
  → Claude Code shows △ needs authentication natively (HTTP 401 at transport layer)
  → authenticate() tool removed — Claude Code handles PKCE browser flow automatically
  → Local proxy buffers writes to .quorum-offline.log when gateway unreachable
  → On reconnect: proxy replays buffered writes with full conflict detection
  → Engineers register http://localhost:8000/mcp — never the remote gateway URL directly
  → Gateway can be hosted centrally; engineers point proxy at it via .quorum file
  → Full design: docs/V03-PLAN.md § 5 (HTTP MCP Migration) and § 6 (Offline Mode)

```

```
Bidirectional Confluence Sync
  → Ingest and export in both directions
  → Webhook real-time sync, supersede detection across Confluence edits

Multi-Agent Orchestration
  → Quorum as shared memory for LangGraph, CrewAI, AutoGen agents
  → Constitutional rules apply to agents too — no agent resolves silently
  → Fork-in-road interface for complex multi-agent decisions

Fork Decision Intelligence
  → Frequently-resolved forks → auto-resolve with notification
  → Never-resolved forks → escalate with full context and history
  → Decision confidence feeds back into authority model

Governance Analytics
  → Knowledge gaps by domain
  → Highest incident-correlated decisions
  → Cross-team knowledge sharing opportunities
  → What knowledge is never recalled (prune candidates)

Autonomous Delivery
  → BA agent: reads requirements, documents acceptance criteria into Quorum
  → QA agent: pulls known edge cases, generates test strategies
  → Engineer agent: implements against Quorum-verified patterns
  → Human only at genuine forks — not at every step
```

---

## Testing Milestones

```
v0.1 → Constitutional suite (100% coverage, CI guard, 20+ LLM cases)
v0.2 → Governance suite (adversarial, 50+ cases, CI accuracy thresholds)
v0.3 → TDD gates for verify-jwt, slim JWT, X-Quorum-Project header (shipped ✅)
v0.4 → LLM accuracy (100+ cases, regression tests, production feedback loop)
v1.0 → Full (200+ cases, load/chaos testing, external security audit)
```

---

## Non-Goals

- Replacing Graphiti — Quorum builds on it, not against it
- General-purpose memory for non-engineering domains
- Consumer-facing product — this is a developer tool
- Vendor lock-in — must work with any LLM, any graph DB
- Real-time streaming memory — batch post-task reflection is intentional
- Removing human governance — automation assists, humans decide at forks

---

## Design Invariants

These must remain true across every version, every PR, every contributor:

1. **Never hard delete** — always supersede with reason, preserve history
2. **Never silent conflict resolution** — always notify, log, require decision
3. **Always require reason** — on every state change, enforced in code not convention
4. **No self-approval** — conflict parties cannot resolve their own conflicts, ever
5. **Human at genuine forks** — agents decide within known knowledge, humans at ambiguity
6. **Governance is architecture** — invariants are code, not config, not policy
7. **Dissent is preserved** — overruled concerns stored permanently, never deleted
8. **Draft knowledge never used** — Claude never injects unreviewed knowledge into context
9. **Provenance on every write** — author, timestamp, session_id, agent_id, triggered_by always stored; auditable via the audit chain
10. **Constitution changes require community** — no single person changes Layer 1 unilaterally
