# Quorum — Critical Analysis & Gap Register

> Generated: 2026-04-19  
> Scope: Full codebase review — architecture, implementation, tests, deployment, CI/CD  
> Purpose: Actionable backlog for v0.3 hardening

---

## Executive Summary

Quorum's core governance model is sound. The constitutional layer is immutable and cryptographically enforced; the audit chain is verified at startup; identity is resolved server-side; and every tool operation flows through a mandatory audit pipeline. These are non-negotiable invariants that hold throughout the codebase.

The gaps are concentrated in three areas: **integration edge cases** (LLM unavailability, Graphiti downtime), **missing scheduled work** (confidence decay), and **test coverage blind spots** (config polling, pending staleness, gateway routes). None are showstoppers for v0.2, but all need resolution before a production deployment.

**Architecture score: 8.5 / 10**

---

## Strengths

| Area | Observation |
|------|-------------|
| Constitutional enforcement | Rules 1–5 enforced as throwing functions — not config flags, not middleware, not opt-in. Cannot be bypassed at call site. |
| Audit chain | SHA256 chain verified at startup; hard stop on tamper. Both audit stores written atomically; operation rolls back if either fails. |
| Identity | Author is resolved server-side from GitHub token → git config → env var → anonymous. Tools accept no `author` parameter — spoofing is architecturally impossible. |
| Append-only | `updateEntry()` and `deleteEntry()` throw `ConstitutionalViolation` unconditionally. No conditional path exists. |
| Soft delete only | Graphiti `BLOCKED_METHODS` set prevents any hard delete at the client layer. `deleteEpisodeSoft()` is the only exit. |
| Governance separation | Conflict detection uses OpenAI directly, not via Graphiti. LLM concerns are explicitly separated from graph storage. |
| Input validation | All MCP tool inputs validated with Zod schemas before any operation. |
| 100% constitutional coverage | CI blocks merge if constitutional test coverage drops below 100%. `meta.test.js` verifies the guard itself cannot be skipped. |

---

## Gaps & Issues

Each issue has a severity rating:

- **P0** — Blocks production use; must fix before any real deployment
- **P1** — Significant risk; fix before v0.3 ships
- **P2** — Technical debt; fix within next two milestones
- **P3** — Nice-to-have; schedule when capacity allows

---

### P0 — Blocks Production

#### GAP-01: LLM failure returns false-positive conflict

**File:** `src/governance/conflict.js`  
**Behaviour:** When the OpenAI API call for contradiction checking fails (network error, quota, timeout), the catch block returns `{ contradicts: true, reason: "LLM call failed" }`.  
**Risk:** Every write during an OpenAI outage gets flagged as a conflict and routed to a human decision queue. Engineers are blocked from storing knowledge while the LLM is unavailable, even though there may be no real conflict.  
**Fix:** Introduce a distinct result state:
```js
// Instead of { contradicts: true, reason: "LLM call failed" }
return { contradicts: false, llm_unavailable: true, reason: "LLM check skipped — API unavailable" };
```
Surface `llm_unavailable` in the conflict brief so reviewers know the check was not performed. Store the knowledge but flag it for post-hoc review.

---

#### GAP-02: No Dockerfile.graphiti in CI build pipeline

**File:** `.github/workflows/build.yml`  
**Behaviour:** The build workflow builds `Dockerfile` (MCP server) and `Dockerfile.gateway`, but not `Dockerfile.graphiti`. The Graphiti image is only built at deploy time via `scripts/k8s-setup.sh`.  
**Risk:** A breaking change to `Dockerfile.graphiti` (e.g. wrong entrypoint, broken pip install) is not caught by CI. It surfaces only when someone runs the setup script.  
**Fix:** Add a third job to `build.yml`:
```yaml
build-graphiti:
  name: Build Graphiti image
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Build
      run: docker build -f Dockerfile.graphiti -t graphiti-mcp:ci-check .
```
No push needed — just verify the build succeeds.

---

### P1 — Significant Risk

#### GAP-03: Graphiti downtime silently skips conflict detection

**File:** `src/governance/conflict.js`  
**Behaviour:** When Graphiti is unreachable during `detectConflict()`, the function returns `{ conflict: false }` — allowing the write to proceed without any conflict check.  
**Risk:** During a Graphiti outage, conflicting knowledge can be written undetected. The conflict will only surface later (if ever) when someone runs a search.  
**Fix:** Two options — choose based on team's availability vs consistency preference:
- **Option A (recommended):** Return `{ conflict: false, graphiti_unavailable: true }` and store knowledge with a `PENDING_CONFLICT_CHECK` flag. Run a background job to re-check once Graphiti recovers.
- **Option B (strict):** Reject the write with a clear error: `"Conflict check unavailable — Graphiti unreachable. Try again shortly."` Store the attempted write as a DRAFT.

Document whichever option is chosen in `ARCHITECTURE.md`.

---

#### GAP-04: Confidence decay not implemented

**File:** `src/graph/schema.js` (defines `TriggeredBy.CONFIDENCE_DECAY`), `src/governance/confidence.js` (defines `onAgeDecay()`)  
**Behaviour:** The decay function exists as a pure function but there is no scheduled job that calls it. Knowledge confidence never decays regardless of age.  
**Risk:** Old, potentially stale knowledge retains its original confidence score. A 3-year-old decision and a recent one look equally authoritative.  
**Fix:** Add a Kubernetes CronJob (or docker-compose equivalent for local dev) that:
1. Queries all ACTIVE knowledge nodes older than N days
2. Calls `onAgeDecay()` for each
3. Updates the confidence score in PostgreSQL and Graphiti
4. Writes a `triggered_by: confidence_decay` audit entry

Suggest weekly cadence. Add to Helm chart as an optional `cronjob` template under `values.yaml`.

---

#### GAP-05: No archival strategy for audit_log

**File:** `scripts/init-db.sql`, `src/audit/secondary.js`  
**Behaviour:** The `audit_log` table is append-only and grows indefinitely. No archival, compression, or rotation strategy exists.  
**Risk:** At high write volumes (many engineers, frequent tool calls), the table can grow to hundreds of GB within months. PostgreSQL performance degrades, and storage costs increase.  
**Fix:**
1. Add a documented archival job: export old entries to S3 (as JSONL, compressed), then mark them as archived in a separate `audit_log_archives` table (never delete from `audit_log`).
2. Add `archived_at` and `archive_s3_key` columns to `audit_log` (nullable).
3. Run archival for entries older than 90 days on a monthly schedule.
4. Document in `AUDIT.md`.

---

#### GAP-06: GitHub token verification hits rate limits

**File:** `src/identity/resolver.js`  
**Behaviour:** `verifyGitHubToken()` makes a request to GitHub API (`GET /user`) on every identity resolution. The module-level cache helps within a single session, but:
- Rate limit for authenticated requests: 5,000/hr per token — acceptable
- Rate limit for unauthenticated: 60/hr — only applies if no token, probably fine
- Cache is process-scoped and resets on server restart

**Risk:** If Quorum runs as a long-lived server with many concurrent engineers, token verification could hit rate limits under load. More importantly, the identity cache has no TTL — a revoked token remains "verified" until the process restarts.  
**Fix:**
1. Add a TTL to the identity cache (e.g. 15 minutes): re-verify token on TTL expiry.
2. Handle GitHub 401 explicitly: return `anonymous` identity rather than throwing.
3. Add `X-RateLimit-Remaining` header inspection to warn when approaching limit.

---

### P2 — Technical Debt

#### GAP-07: ~~Missing test coverage for config/loader.js S3 polling~~ — SUPERSEDED

**Status: Obsolete as of 2026-04-19 — superseded by GAP-20 redesign.**

Config no longer lives in S3. The multi-project redesign (GAP-20) moves config into the `projects` table in PostgreSQL. `pollConfig()` and its S3 ETag loop are eliminated entirely. The `config/loader.js` module will be rewritten to query PostgreSQL per request.

**New test target:** `GET /api/projects/:id` — verify config is read from PostgreSQL, schema migration loader applies defaults for missing fields, and `config_version` is returned for optimistic locking (GAP-25).

---

#### GAP-08: Missing test coverage for pending.js staleness detection

**File:** `src/tools/pending.js`  
**Behaviour:** The tool detects when an ACTIVE version has advanced since a DRAFT was created ("staleness"). No test file is visible for this logic.  
**Risk:** Stale detection is subtle — it compares version numbers across time. A regression could surface outdated conflict briefs to reviewers.  
**Fix:** Add `tests/tools/pending.test.js` covering:
- DRAFT created at v1, ACTIVE now at v3 → stale warning shown
- DRAFT created at v1, ACTIVE still at v1 → no warning
- Empty pending queue → clean response

---

#### GAP-09: No tests for gateway routes

**Files:** `src/gateway/routes/` (auth.js, graphiti.js, pg.js, config.js, projects.js, jwks.js)  
**Behaviour:** Gateway routes handle JWT issuance, Graphiti proxying, PostgreSQL REST, and S3 config loading. No test files visible for any of these.  
**Risk:** Auth bypass, broken JWT verification, or Graphiti proxy errors won't be caught in CI.  
**Fix:** Add `tests/gateway/` with:
- `auth.test.js` — valid GitHub token → JWT issued; invalid token → 401
- `verify-jwt.test.js` — valid JWT → passes; expired JWT → 401; wrong key → 401
- `graphiti.test.js` — proxies request with auth; rejects without JWT
- `config.test.js` — loads config from mock S3; validates schema; returns 400 on invalid

---

#### GAP-10: Gateway error responses may leak internal state

**File:** `src/gateway/server.js`  
**Behaviour:** The global Express error handler is generic. Route-level errors (PostgreSQL query errors, AWS SDK errors) may propagate raw error messages to the response body.  
**Risk:** Stack traces, SQL error messages, or AWS ARNs could be exposed to callers.  
**Fix:** Add explicit error sanitisation in the error handler:
```js
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const safe = status < 500
    ? err.message   // client errors: safe to surface
    : 'Internal server error';  // server errors: never leak details
  if (status >= 500) logger.error({ err, path: req.path });
  res.status(status).json({ error: safe });
});
```

---

#### GAP-11: No TLS between services in Kubernetes

**Files:** `helm/quorum/templates/`  
**Behaviour:** Gateway → Graphiti, Gateway → PostgreSQL, and Quorum MCP → Gateway all communicate over plain HTTP/TCP within the Kubernetes cluster. TLS is terminated at the Ingress only.  
**Risk:** If the cluster network is compromised (lateral movement), credentials and knowledge content are exposed in transit.  
**Fix:** For production deployments:
1. Enable PostgreSQL SSL (`ssl: require` in pg client config, self-signed cert or cert-manager)
2. Add mTLS for gateway ↔ Graphiti via a service mesh (Istio or Linkerd) — annotate in Helm values
3. Document the network trust boundary clearly in `DEPLOYMENT.md`

---

#### GAP-12: `quorum.config.example.json` has no version field

**File:** `quorum.config.example.json`  
**Behaviour:** The config schema (src/config/schema.js) does not include a `schema_version` field. When the config schema evolves, there's no way to detect stale configs or run migrations.  
**Fix:** Add `"schema_version": "1"` to both the example and the Zod schema. When loading, check the version and either migrate or reject with a clear error.

---

### P3 — Nice to Have

#### GAP-13: reflect.js has no deduplication guard

**File:** `src/tools/reflect.js`  
**Behaviour:** If `reflect()` is called multiple times after the same task (e.g. Claude re-runs reflect on retry), duplicate DRAFT entries for the same knowledge may be created.  
**Risk:** Low — DRAFTs require review before becoming ACTIVE. But reviewer queue fills with duplicates.  
**Fix:** Before inserting a reflect-derived DRAFT, check if a DRAFT with identical content hash already exists for the same `topic:key`. Skip if duplicate.

---

#### GAP-14: No rate limiting on gateway endpoints

**File:** `src/gateway/server.js`  
**Behaviour:** Gateway HTTP endpoints have no rate limiting. A misconfigured or malicious MCP client could flood the gateway with tool calls.  
**Risk:** PostgreSQL connection pool exhaustion (max 20 connections); Graphiti overwhelmed; audit log flooded.  
**Fix:** Add `express-rate-limit` middleware:
```js
import rateLimit from 'express-rate-limit';
app.use('/graphiti', rateLimit({ windowMs: 60_000, max: 200 }));
app.use('/pg', rateLimit({ windowMs: 60_000, max: 500 }));
app.use('/auth', rateLimit({ windowMs: 60_000, max: 20 }));
```

---

#### GAP-15: No multi-platform build for Graphiti image

**File:** `.github/workflows/build.yml`  
**Behaviour:** Once `Dockerfile.graphiti` is added to CI (see GAP-02), it should also publish a multi-platform image (`linux/amd64`, `linux/arm64`) to match the gateway and MCP images.  
**Fix:** Add to the Graphiti build job:
```yaml
platforms: linux/amd64,linux/arm64
push: true
tags: ghcr.io/${{ github.repository }}-graphiti:latest
```

---

#### GAP-16: CLI `audit lineage` not covered in tests

**File:** `cli.js`  
**Behaviour:** The `audit lineage` command traverses version chains and audit links for a given topic:key. Not visible in any test file.  
**Risk:** Low — CLI is a thin wrapper over graph/queries.js which is tested. But the traversal logic itself is not exercised.  
**Fix:** Add `tests/cli/audit.test.js` with subprocess-based CLI tests or extract the traversal into a testable module.

---

### P1 — New (identified post v0.2 review)

#### GAP-17: No webhook notification on DRAFT creation

**Files:** `src/tools/remember.js`, `quorum.config.example.json`  
**Behaviour:** When a conflict is detected and routed to human review, nothing notifies anyone. The reviewer must poll `pending()` or open the dashboard to discover the decision exists.  
**Risk:** Review queue fills silently. "Humans at the fork" is the core value proposition — but humans currently have to find the fork themselves.  
**Fix:** Add a configurable `notifications.webhook_url` field to `quorum.config.json`. When `remember()` creates a `PENDING` decision, fire a `POST` to that URL with a structured payload:
```js
{
  event: "conflict.pending_review",
  topic: "auth",
  key: "token-strategy",
  conflict_reason: "...",
  possible_split: false,
  incoming_author: "alice",
  dashboard_url: "${QUORUM_DASHBOARD_URL}/pending/${conflictId}"
}
```
Teams wire this URL to Slack (via Slack incoming webhook), email (via a relay), or PagerDuty. No new infrastructure in Quorum — one HTTP POST, one config field, ~15 lines in `remember.js`. Fail silently if webhook is not configured or unreachable — notification failure must never block the write operation.

---

#### GAP-18: Role and seniority missing from authority scoring formula

**File:** `src/governance/authority.js`  
**Behaviour:** The authority formula is `confidence × 0.5 + recency × 0.3 + access_frequency × 0.2`. Role and seniority are noted as "can be added later via team config" but have never been implemented. A junior engineer's frequently-accessed note can outweigh a principal architect's 6-month-old ADR.  
**Risk:** Violates the core design intent from CLAUDE.md: "A junior engineer's new addition should not silently overwrite a senior architect's 6-month-old ADR." Auto-supersede decisions are currently role-blind.  
**Fix:** Two-part change:

1. **Store role at write time.** Add `author_role` column to `knowledge_versions` table. Populate from the JWT `role` claim in `remember.js`. Preserves the role at the time the knowledge was written — correct even if the author changes role later.

2. **Add role weight to authority formula.** Role weights are configurable per project in `quorum.config.json`:
```json
"authority": {
  "weights": {
    "confidence": 0.35,
    "recency": 0.25,
    "access_frequency": 0.20,
    "role": 0.20
  },
  "role_scores": {
    "engineer": 0.50,
    "tech_lead": 0.65,
    "architect": 0.80,
    "principal_architect": 1.00
  }
}
```

3. **Add a role gate.** Regardless of composite score delta, an engineer-authored entry can never auto-supersede an architect or principal_architect entry — always routes to human review. The gate is a hard check before the score delta comparison.

**Dashboard impact:** Role weights exposed as sliders in the config editor (see `FRONTEND.md`).

---

#### GAP-19: ~~No config write path in the Gateway~~ — SUPERSEDED

**Status: Obsolete as of 2026-04-19 — collapsed into GAP-20.**

The original gap described adding a `PUT /config/:projectId` route that uploaded to S3. The multi-project redesign eliminates S3 as the config store entirely. Config is now a column in the `projects` table. The write path becomes `PATCH /api/projects/:id` (part of GAP-20's full project API). See GAP-20 for the replacement design.

---

### P2 — New

#### GAP-20: Multi-project system — project registry, config-in-DB, and full project API

**Priority: P1 — Large. Prerequisite for dashboard multi-project support, GAP-25 through GAP-32.**

**Revised scope (2026-04-19):** The original gap described a simple `POST /projects` endpoint writing to S3. This has been redesigned. Config no longer lives in S3 — it lives in the `projects` table in PostgreSQL. S3 is now audit-archival-only (GAP-05). GAP-19 (S3 config write path) is obsolete. GAP-07 (S3 polling tests) is obsolete. The full project system replaces both.

**What this builds:**

**1. `projects` table (new DB migration):**
```sql
CREATE TABLE projects (
  id                TEXT PRIMARY KEY,        -- proj-abc123 (UUID prefix)
  slug              TEXT UNIQUE NOT NULL,    -- acme-payments
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | ARCHIVED
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        TEXT NOT NULL,           -- github username

  -- Full Quorum config (replaces S3 config file)
  members           JSONB NOT NULL DEFAULT '[]',
  -- [{ github_username, role, team, base_confidence }]
  domains           JSONB NOT NULL DEFAULT '[]',
  -- [{ name, conflict_threshold }]
  governance        JSONB NOT NULL DEFAULT '{}',
  -- { conflict_threshold, authority_threshold,
  --   draft_alert_max_age_hours, notification_poll_minutes }

  schema_version    INTEGER NOT NULL DEFAULT 1,
  config_version    INTEGER NOT NULL DEFAULT 0,  -- for optimistic locking (GAP-25)
  config_updated_at TIMESTAMPTZ,
  config_updated_by TEXT,

  -- Enterprise links (all optional)
  github_org        TEXT,
  github_repo       TEXT,
  jira_project      TEXT,
  slack_channel     TEXT,

  -- Auth
  token_hash        TEXT NOT NULL   -- bcrypt hash of project token
);

CREATE TABLE bump_log (
  id            SERIAL PRIMARY KEY,
  author        TEXT NOT NULL,
  topic         TEXT NOT NULL,
  key           TEXT NOT NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  bumped_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  role          TEXT NOT NULL,
  delta_applied FLOAT NOT NULL
);
CREATE INDEX bump_log_lookup ON bump_log (author, topic, key, bumped_at DESC);
```

**2. Project API routes (`src/gateway/routes/projects.js`):**
```
POST   /api/projects             → create project, return project_id + plaintext token
GET    /api/projects?member=X    → list projects where github_username=X (discovery)
GET    /api/projects/:id         → fetch project + full config
PATCH  /api/projects/:id         → update members / domains / governance (optimistic lock)
POST   /api/projects/:id/token/rotate → invalidate old token, return new (1hr grace)
DELETE /api/projects/:id         → soft-archive (status = ARCHIVED, bulk-deprecates knowledge)
```

**3. Config migration from S3 to PostgreSQL:**
- `src/config/loader.js` rewrites `getConfig(projectId)` to query `projects` table
- `pollConfig()` and S3 ETag loop removed entirely
- Schema migration loader runs on every read: checks `schema_version`, fills missing JSONB fields with defaults, writes back if schema upgraded
- All existing Gateway routes that call `getConfig()` continue to work unchanged — loader interface is identical

**4. Graphiti group_id made dynamic:**
- `src/graph/client.js` — all calls accept `projectId` parameter
- `searchNodes(query, options, projectId)` passes `group_ids: [projectId]`
- `addEpisode(content, metadata, projectId)` passes `group_id: projectId`
- Gateway middleware resolves `projectId` from project token → attaches to `req.projectId`
- All tool handlers pass `req.projectId` through to graph client

**5. `QUORUM_ALLOW_SELF_SERVICE` env var:**
- `false` → `POST /api/projects` requires a master admin token (for platform-controlled orgs)
- `true` (default) → any authenticated GitHub user can create a project

---

#### GAP-21: Domain track record missing from authority scoring

**File:** `src/governance/authority.js`  
**Behaviour:** The spec describes authority weighting that includes "domain track record" — how often an author's knowledge in a given domain has been recalled, approved, and validated in production. This signal does not exist anywhere in the codebase.  
**Risk:** An author who has written 50 approved auth decisions has no more authority in the auth domain than someone who wrote their first auth entry yesterday. The authority model does not reflect demonstrated expertise.  
**Fix:** Add a `author_domain_stats` table to PostgreSQL:
```sql
CREATE TABLE author_domain_stats (
  author       TEXT NOT NULL,
  domain       TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  approved_count    INT DEFAULT 0,
  recalled_count    INT DEFAULT 0,
  superseded_count  INT DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (author, domain, project_id)
);
```
- Increment `approved_count` on `review(approve)` for a domain
- Increment `recalled_count` on `recall()` for a domain
- Increment `superseded_count` when author's knowledge is superseded
- Normalise to 0–1 range, add as a fifth dimension to authority formula

**Note:** This is a P2 because it requires schema migration + ongoing stat tracking. GAP-18 (role scoring) is P1 and delivers most of the authority model value with far less complexity.

---

### P3 — New

#### GAP-22: Graph scale handling for dashboard Cytoscape.js view

**File:** `FRONTEND.md` (dashboard — not yet built)  
**Behaviour:** The knowledge graph view in the dashboard renders all nodes for a domain in a single Cytoscape.js instance. At low node counts (<100) this is fine. At 500+ nodes, force-directed layout becomes slow and the graph becomes unreadable.  
**Risk:** Performance degrades noticeably at scale. A mature Quorum graph with many domains and years of decisions would be unusable in the full-graph view.  
**Fix:**
- Server-side: `GET /api/graph` accepts a `limit` parameter (default: 100) and returns the most recently active nodes
- Client-side: domain filter is mandatory above 200 nodes — full graph only available when node count is below threshold
- Layout: switch from force-directed (`cose-bilkent`) to hierarchical DAG (`dagre`) automatically when SUPERSEDES chain depth > 3

---

#### GAP-23: SKILL.md design and deployment

**Status: Intentionally deferred — implement last, after all features are stable.**

**File:** `skill/SKILL.md`  
**Behaviour:** SKILL.md is the Claude Code skill that closes the self-evolution loop — it instructs Claude to call `reflect()` automatically after every task and to search Quorum for context at session start. The file exists as a placeholder but contains no working instructions.  
**Risk:** Without SKILL.md deployed, the self-evolution loop remains broken at point 1. `reflect()` must be called manually. Knowledge does not grow from engineering activity automatically.  
**Rationale for deferral:** SKILL.md should describe the *finished* system. If written now, it would need updating with every new feature added (webhook notifications, authority model, confidence decay). Writing it last means it describes Quorum accurately and completely in one pass.  
**Design questions to resolve before implementing:**
1. When does Claude invoke `reflect()`? After every task, or only when a decision is detected?
2. What prevents over-extraction — 5 low-quality DRAFTs per task flooding the reviewer queue?
3. How does the skill know which Quorum instance and project namespace to write to?
4. What is the session-start search scope — full graph or domain-filtered by current task?

---

#### GAP-24: Knowledge endorsement ("bump") with role-weighted confidence restoration

**Priority: P1 — Small effort. Requires GAP-04 (decay job) to be meaningful.**

**Context:** Confidence decay (GAP-04) erodes knowledge confidence at `-0.005/week`, flooring at `max(0.10, startingConfidence × 0.30)`. Without a mechanism to counteract decay, valuable knowledge that isn't accessed frequently will silently lose authority — even if engineers still consider it correct.

**The bump mechanic:** Engineers explicitly endorse a knowledge node via the dashboard. This resets the decay clock and adds a role-weighted confidence delta, capped at the node's `starting_confidence`.

**Formula:**
```
delta = 0.05 × role_weight
  engineer              → 0.50  (delta: +0.025)
  senior_engineer       → 0.70  (delta: +0.035)
  architect             → 0.85  (delta: +0.042)
  principal_architect   → 1.00  (delta: +0.050)

new_confidence = Math.min(starting_confidence, current_confidence + delta)
last_accessed_at = NOW()   // always resets, regardless of role
```

**Cooldown:** 7 days per author per topic:key. Stored in a new `bump_log` table. Prevents a single engineer from gaming decay by bumping their own entries weekly.

**Why role-weighted:** Endorsement from a principal architect carries more authority signal than from an engineer — the same hierarchy used in GAP-18 (role and seniority in authority scoring). Using the same role tiers keeps the system coherent.

**Why clock-reset is primary:** For typical knowledge (starting confidence 0.70), the floor is `0.21`. Reaching the floor from 0.70 takes 98 weeks (`(0.70 - 0.21) / 0.005`). Engineers rarely need to restore the delta — they just need to reset the clock so useful knowledge doesn't decay while it's still valid.

**New database table:**
```sql
CREATE TABLE bump_log (
  id            SERIAL PRIMARY KEY,
  author        TEXT NOT NULL,
  topic         TEXT NOT NULL,
  key           TEXT NOT NULL,
  bumped_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  role          TEXT NOT NULL,
  delta_applied FLOAT NOT NULL
);
CREATE INDEX bump_log_lookup ON bump_log (author, topic, key, bumped_at DESC);
```

**New Gateway route:** `POST /api/bump/:topic/:key` (see FRONTEND.md).

**Audit trail:** Every bump creates an audit entry (`triggered_by = 'bump'`) with author, role, delta, and topic:key. No bump is anonymous.

**Dashboard integration:** "Decaying Knowledge" panel in Stats tab — see FRONTEND.md § 5a.

**Relationship to GAP-18:** The bump mechanic uses GAP-18's role tiers and weights directly. GAP-18 adds `author_role` to authority scoring; GAP-24 extends that same role signal to the confidence maintenance lifecycle. Implement GAP-18 first.

---

### P0 — Multi-project (Blockers)

#### GAP-25: Config PATCH race condition — no optimistic locking

**Priority: P0 — Small. Must ship with GAP-20.**

**Behaviour:** Two engineers open the Config Editor simultaneously. Both fetch the current `members` array at `config_version = 5`. Engineer A adds a member, PATCHes → server writes `config_version = 6`. Engineer B (who fetched at v5) adds a different member, PATCHes → server accepts, silently overwrites A's change with a stale base. Last write wins. No error. A's member is silently dropped.

**Risk:** Silent data loss in project config. Trust in the Config Editor breaks after one incident.

**Fix:** Optimistic locking — every PATCH must include the `config_version` it was based on. Server rejects if versions diverge.

**Algorithm:**
```
PATCH /api/projects/:id
Request: { members: [...], config_version: 5 }

BEGIN TRANSACTION
  current = SELECT config_version FROM projects WHERE id = :id FOR UPDATE
  IF current.config_version != request.config_version:
    ROLLBACK
    return 409 { error: "Config modified by another session. Refresh and retry.", current_version: current.config_version }

  UPDATE projects SET
    members = request.members,
    config_version = config_version + 1,
    config_updated_at = NOW(),
    config_updated_by = req.user.sub
  WHERE id = :id

  INSERT INTO audit_log (operation, author, project_id, metadata)
  VALUES ('config_update', req.user.sub, :id, { config_version: current + 1 })
COMMIT

return 200 { config_version: current + 1 }
```

**Dashboard handling:** On 409, show a non-dismissable banner: "Config was updated by @{config_updated_by}. Your changes have not been saved. Refresh to see the latest version." The banner must not silently auto-merge — force the engineer to look at the new state first.

---

#### GAP-26: Project bootstrap paradox — no principal_architect on creation

**Priority: P0 — Small. Must ship with GAP-20.**

**Behaviour:** A project is created with `members = []`. First `remember()` call produces a DRAFT. To approve a DRAFT, the `review()` tool requires a reviewer. But `resolveIdentity()` looks up the caller in `project.members` to determine their role — if members is empty, role defaults to `engineer`. No `principal_architect` exists → no one has authority to approve DRAFTs → the governance queue fills with unresolvable entries.

**Risk:** New projects are immediately broken for governance. First-time teams hit an invisible wall.

**Fix — two guards:**

**Guard 1 — creator auto-enrolled at creation:**
```
POST /api/projects
  caller = resolveIdentity(req.githubToken)  // resolves github_username from GitHub API

  project.members = [{
    github_username: caller.username,
    role: 'principal_architect',   // creator is always PA
    team: 'platform',
    base_confidence: 0.85
  }]

  // Creator can downgrade themselves later via PATCH — but can't remove themselves
  // if they are the last principal_architect (see Guard 2)
```

**Guard 2 — constitutional: last PA cannot be removed:**
```
PATCH /api/projects/:id (members update)
  principal_architects = request.members.filter(m => m.role === 'principal_architect')

  IF principal_architects.length === 0:
    return 422 {
      error: "At least one principal_architect must remain. Assign another PA before removing this one.",
      code: "LAST_PA_GUARD"
    }
```

This guard belongs in `src/governance/constitutional.js` alongside the other constitutional rules — it is enforced unconditionally, not a config flag.

---

### P1 — Multi-project (Significant Risk)

#### GAP-27: No cross-project knowledge sharing mechanism

**Priority: P1 — Medium.**

**Behaviour:** An auth decision written in `proj-abc123` is invisible to `proj-def456` even if both teams should follow it. A company-wide security policy has no home — it must be duplicated in every project's knowledge, creating drift.

**Fix:** A reserved `global` project_id. Knowledge written to `global` is readable by all projects. Projects fall through to `global` on miss.

**Read-through algorithm (recall and search):**
```
function recallWithGlobalFallback(topic, key, projectId):
  // 1. Check project-local first
  result = queryKnowledge(topic, key, projectId)
  if result: return { ...result, source: 'project' }

  // 2. Fall through to global namespace
  globalResult = queryKnowledge(topic, key, 'global')
  if globalResult: return { ...globalResult, source: 'global', readonly: true }

  return null

function searchWithGlobalFallback(query, projectId, limit=10):
  // Run both searches in parallel, merge + deduplicate by topic:key
  [projectResults, globalResults] = await Promise.all([
    searchGraphiti(query, group_id: projectId, limit),
    searchGraphiti(query, group_id: 'global',    limit)
  ])

  merged = deduplicateByKey([...projectResults, ...globalResults])
  // Project-local results rank above global on equal score
  return merged.sort((a, b) =>
    b.score - a.score || (a.source === 'project' ? -1 : 1)
  )
```

**Write rules:**
- Only `principal_architect` role can write to `global` project — enforced in `remember()` as a constitutional check
- Writes to `global` always enter DRAFT regardless of author — global knowledge must be explicitly approved before it is visible
- No project can write to another project's namespace — `req.projectId` from token is the only writable target

**`global` project bootstrap:**
```sql
INSERT INTO projects (id, slug, name, created_by, members, governance, token_hash)
VALUES (
  'global', 'global', 'Global Shared Knowledge', 'system',
  '[{"github_username": "system", "role": "principal_architect", "team": "platform", "base_confidence": 1.0}]',
  '{}',
  'not-a-real-token'  -- global project is not accessible via MCP token
);
```

---

#### GAP-28: Graphiti group_id is static — not per-request

**Priority: P1 — Small. Prerequisite for any real project isolation.**

**Behaviour:** `src/graph/client.js` reads `process.env.QUORUM_GROUP_ID` once at module load. All semantic searches and episode writes share the same Graphiti namespace regardless of which project the MCP call belongs to. Project A's `remember()` can surface in Project B's `detectConflict()` semantic search — knowledge leaks across project boundaries.

**Risk:** Cross-project knowledge contamination. Conflict detection fires on unrelated knowledge. Governance model breaks.

**Fix — thread projectId through every graph client call:**

```js
// src/graph/client.js — before (static)
const GROUP_ID = process.env.QUORUM_GROUP_ID || 'default'

export async function searchNodes(query, options = {}) {
  return graphitiFetch('search_nodes', {
    query,
    group_ids: [GROUP_ID],   // ← static
    ...options
  })
}

// src/graph/client.js — after (dynamic)
export async function searchNodes(query, options = {}, projectId) {
  const groupId = projectId ?? process.env.QUORUM_GROUP_ID ?? 'default'
  return graphitiFetch('search_nodes', {
    query,
    group_ids: [groupId, 'global'],  // always include global namespace
    ...options
  })
}

export async function addEpisode(content, metadata, projectId) {
  const groupId = projectId ?? process.env.QUORUM_GROUP_ID ?? 'default'
  return graphitiFetch('add_episode', {
    episode_body: content,
    group_id: groupId,    // write only to project namespace — never 'global' unless explicit
    ...metadata
  })
}
```

**Gateway middleware wiring:**
```js
// src/gateway/middleware/project.js (new file)
export async function resolveProject(req, res, next) {
  const token = req.headers['x-quorum-token']
  if (!token) return next(Errors.unauthorized('Missing project token'))

  const project = await getProjectByTokenHash(bcrypt.hash(token))
  if (!project || project.status === 'ARCHIVED')
    return next(Errors.unauthorized('Invalid or archived project'))

  req.projectId = project.id
  req.projectConfig = project   // members, domains, governance all available
  next()
}
```

All tool handlers receive `req.projectId` and pass it to graph client calls. No changes to tool schemas — projectId is server-resolved, never caller-provided.

---

#### GAP-29: Project archival leaves orphaned knowledge_versions rows

**Priority: P1 — Small.**

**Behaviour:** `DELETE /api/projects/:id` sets `projects.status = 'ARCHIVED'`. All `knowledge_versions` rows with `project_id = proj-abc123` remain `ACTIVE`. The project token is revoked — MCP calls stop. But the rows exist in a limbo state: not deleted (constitutional), not deprecated (no reason recorded), not exportable (project is gone). If the project is ever accidentally restored, stale ACTIVE knowledge reactivates immediately.

**Risk:** Data integrity. Constitutional audit trail breaks — ACTIVE knowledge with no reachable project context.

**Fix — pre-archival export + bulk soft-deprecate:**

```
DELETE /api/projects/:id
  BEGIN TRANSACTION
    // Step 1: Auto-export before any state changes
    exportResult = await exportProject(project.id, format: 'markdown')
    // Store export in audit_log as a special 'project_archive_export' entry
    // Constitutional: the export is the permanent record of what existed

    // Step 2: Bulk soft-deprecate all active knowledge
    affectedCount = await db.query(`
      UPDATE knowledge_versions
      SET status = 'DEPRECATED',
          deprecated_at = NOW(),
          deprecated_reason = $1,
          deprecated_by = $2
      WHERE project_id = $3
        AND status IN ('ACTIVE', 'DRAFT')
    `, [
      'Project archived: ' + project.name,
      req.user.sub,
      project.id
    ])

    // Step 3: Archive the project
    UPDATE projects SET status = 'ARCHIVED', archived_at = NOW()
    WHERE id = project.id

    // Step 4: Audit entry
    INSERT INTO audit_log (operation, author, project_id, metadata)
    VALUES ('project_archived', req.user.sub, project.id,
      { knowledge_deprecated: affectedCount, export_audit_id: exportResult.auditId })
  COMMIT
```

**Restoration path:** Archived projects cannot be un-archived via API (prevents accidental reactivation). A new project with the same slug must be created, and knowledge re-imported from the archived export. This is intentional — it forces a deliberate decision to restore knowledge rather than a silent toggle.

---

### P2 — Multi-project

#### GAP-30: JSONB config schema migration per project

**Priority: P2 — Small.**

**Behaviour:** `projects.governance` JSONB gains new fields as Quorum evolves (e.g., `bump_cooldown_days` from GAP-24, `notification_poll_minutes` from FRONTEND.md). Existing project rows have stale JSONB — new fields are `undefined` when read. Code using optional chaining (`project.governance?.bump_cooldown_days ?? 7`) works but silently applies defaults instead of flagging stale config.

**Risk:** Silent default application. Teams don't know their project config is missing fields. After several releases, `schema_version = 1` projects are significantly under-configured.

**Fix — migration loader runs on every config read:**

```js
// src/config/migrations.js

const MIGRATIONS = [
  // v1 → v2: add bump_cooldown_days
  {
    version: 2,
    up: (config) => ({
      ...config,
      governance: {
        bump_cooldown_days: 7,     // new field — default value
        ...config.governance       // existing fields take precedence
      }
    })
  },
  // v2 → v3: add notification_poll_minutes (already defined in FRONTEND.md)
  {
    version: 3,
    up: (config) => ({
      ...config,
      governance: {
        notification_poll_minutes: 60,
        ...config.governance
      }
    })
  }
  // Add new migration objects here for each schema version bump
]

export function applyMigrations(project) {
  let config = { members: project.members, domains: project.domains, governance: project.governance }
  let version = project.schema_version

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue   // already applied
    config = migration.up(config)
    version = migration.version
  }

  // Write back if upgraded — prevents re-running migrations on every read
  if (version > project.schema_version) {
    db.query(
      'UPDATE projects SET members=$1, domains=$2, governance=$3, schema_version=$4 WHERE id=$5',
      [config.members, config.domains, config.governance, version, project.id]
    )
  }

  return { ...project, ...config, schema_version: version }
}
```

Called in `GET /api/projects/:id` before returning. Transparent to all callers — they always get a fully-migrated config shape.

---

#### GAP-31: No project-level rate limiting

**Priority: P2 — Small.**

**Behaviour:** GAP-14 adds per-engineer rate limiting (`300 calls/minute per jwt.sub`). But a project with 30 engineers all actively calling `remember()` concurrently produces 30× the Graphiti load with no project-level cap. One high-traffic project can starve others sharing the same Graphiti instance.

**Risk:** Resource starvation between projects. Graphiti queue backs up. All projects slow down, not just the overloaded one.

**Fix — second rate-limit tier in the gateway middleware:**

```js
// src/gateway/middleware/rate-limit.js (extend existing file)

// Per-project bucket — caps aggregate load from all engineers in a project
export const projectLimit = rateLimit({
  windowMs: 60_000,
  max: 1000,            // 1000 calls/minute per project (across all engineers)
  keyGenerator: (req) => req.projectId ?? 'unknown',
  message: { error: 'Project rate limit exceeded — too many concurrent engineers', code: 'PROJECT_RATE_LIMIT' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Apply after resolveProject middleware (so req.projectId is set)
// In server.js:
app.use('/pg', projectLimit, apiLimit)        // project cap first, then per-engineer
app.use('/graphiti', projectLimit, graphitiLimit)
```

**Why 1000/minute:** At 300 calls/minute per engineer, a 3-engineer project would hit 900/minute at peak. 1000 gives headroom for bursts without blocking small teams. Configurable per project via `governance.rate_limit_per_minute` in the project config.

---

#### GAP-32: Project discovery — no endpoint to list a user's projects

**Priority: P2 — Small.**

**Behaviour:** The JWT carries one `project_id` at a time (resolved from `QUORUM_PROJECT_ID` env). A user who belongs to 4 projects has no API call to discover which projects they are a member of. The dashboard cannot show a project picker without this.

**Risk:** Dashboard cannot support multi-project switching. Engineers must know their `project_id` before they can use the dashboard — no onboarding UX.

**Fix — project discovery endpoint using GitHub token (not project token):**

```
GET /api/projects?member=:github_username
Authorization: Bearer <github_token>   ← not project token — broader scope

Algorithm:
  1. Resolve caller from GitHub token (same resolveIdentity() used elsewhere)
  2. Validate caller.username === request param (prevents looking up other users)
  3. Query:
     SELECT id, slug, name, status, created_at,
            members @> $memberFilter AS is_member
     FROM projects
     WHERE status = 'ACTIVE'
       AND members @> $memberFilter::jsonb

     -- $memberFilter = '[{"github_username": "ayan"}]'
     -- PostgreSQL JSONB @> operator: "does array contain this element?"

  4. Return: [{ id, slug, name, role (extracted from members array), created_at }]

Response:
[
  { id: "proj-abc123", slug: "acme-payments", name: "Payments Team", role: "principal_architect" },
  { id: "proj-def456", slug: "acme-platform", name: "Platform Team", role: "architect" }
]
```

**Dashboard use:** Login screen shows a project picker populated from this endpoint. Selecting a project exchanges the GitHub token for a project token (`POST /auth/token` with `project_id` payload). The project token is stored in `AuthContext` for the session.

**PostgreSQL index for JSONB member lookup:**
```sql
CREATE INDEX projects_members_gin ON projects USING GIN (members);
-- GIN index makes @> operator fast even with hundreds of projects
```

---

---

## Resolution Plans

Each plan prioritises the simplest possible implementation. Where the fix is a script or algorithm, pseudocode is provided so the intent is clear before any code is written. No new infrastructure, no new services — only what already exists in Quorum is extended.

---

### PLAN-01: Fix LLM fallback false-positive (GAP-01)

**Decision:** Option B — store as DRAFT when LLM is unavailable; re-check job promotes to ACTIVE once LLM recovers.  
**Future path:** When multi-LLM support is added (e.g. Anthropic, Gemini, AWS Bedrock as alternatives to OpenAI), implement a fallback chain before reaching DRAFT: try primary LLM → try fallback LLM(s) → only go to DRAFT if all are unavailable. The `checkContradiction()` function should be written with a provider abstraction from the start so swapping or chaining providers requires no structural changes.



**Principle:** A failed LLM call is not a contradiction. Treat it as "unknown", not "conflict".

**Current state machine:**
```
LLM call → success → { contradicts: true/false }
         → failure → { contradicts: true }   ← BUG: same shape as real conflict
```

**Target state machine:**
```
LLM call → success → { contradicts: true/false, llm_unavailable: false }
         → failure → { contradicts: false, llm_unavailable: true }
```

**Algorithm:**

```
function checkContradiction(incoming, existing):
  try:
    result = callOpenAI(incoming, existing)
    return {
      contradicts: result.answer === "YES",
      reason: result.reason,
      llm_unavailable: false
    }
  catch NetworkError | RateLimitError | TimeoutError:
    return {
      contradicts: false,
      llm_unavailable: true,
      reason: "LLM unavailable — contradiction check skipped"
    }

function detectConflict(incoming, existing):
  check = checkContradiction(incoming, existing)

  if check.llm_unavailable:
    # Store with a warning flag, not as a conflict
    return {
      conflict: false,
      warning: "llm_check_skipped",
      recommendation: "Review manually — LLM was unavailable during conflict check"
    }

  if check.contradicts:
    return { conflict: true, ... }

  return { conflict: false }
```

**Impact on remember():** The write proceeds. The returned metadata includes `warning: "llm_check_skipped"`, which the tool surfaces to the caller. No human queue entry created. The knowledge is stored as a normal version with a `_llm_check_skipped: true` tag so it can be found later.

**One-time backfill query (after deploying fix):**
```sql
-- Find all past "conflicts" that were actually LLM failures
SELECT id, topic, key, created_at
FROM knowledge_versions
WHERE metadata->>'llm_unavailable' = 'true'
  AND status = 'PENDING_HUMAN';
```

---

### PLAN-02: Add Graphiti image to CI (GAP-02)

**Principle:** Build verification costs nothing. Add one job, no push, fail fast.

**Approach — add to `.github/workflows/build.yml`:**

```yaml
build-graphiti:
  name: Build Graphiti image
  runs-on: ubuntu-latest
  # Run in parallel with build-mcp and build-gateway
  steps:
    - uses: actions/checkout@v4

    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v3

    - name: Build (verify only — no push)
      uses: docker/build-push-action@v5
      with:
        context: .
        file: Dockerfile.graphiti
        push: false
        # Cache between runs so the sparse-clone + pip install hit cache layer
        cache-from: type=gha,scope=graphiti
        cache-to: type=gha,mode=max,scope=graphiti
```

**Key insight — caching:** The `git clone + pip install` step in `Dockerfile.graphiti` takes ~60s cold. GitHub Actions cache (GHA cache backend) will cache the layer after the first run, making subsequent runs ~5s. The `scope=graphiti` key prevents cache collision with the other two images.

---

### PLAN-03: Handle Graphiti downtime in conflict detection (GAP-03)

**Decision:** Option B — store as DRAFT, re-check once Graphiti recovers, auto-promote to ACTIVE if clean.  
**Secondary goal:** Target 99% Graphiti availability (≤3.65 days downtime/year) via PodDisruptionBudget, tuned resource limits, fast liveness probe, and circuit breaker on the gateway client. Single replica — horizontal scaling requires upstream verification first. The DRAFT fallback handles the outage window gracefully.  
**Operational safety:** Dead man's switch on DRAFT age only — no count limit (queue can grow unbounded during a legitimate outage without alerting). Alert fires when oldest DRAFT exceeds 5 days: at that point Graphiti has either not recovered or the re-check job itself has failed. Env var: `QUORUM_DRAFT_ALERT_MAX_AGE_DAYS=5`.



**Principle:** Don't block writes. Mark what couldn't be checked and re-check automatically.

**New status value:** Add `PENDING_CONFLICT_CHECK` to `KnowledgeStatus` in `src/graph/schema.js`.

**Algorithm:**

```
# In detectConflict():
function searchSimilarNodes(query):
  try:
    return graphiti.searchNodes(query)
  catch GraphitiUnavailable:
    return { unavailable: true }

# In remember():
similar = searchSimilarNodes(incoming)

if similar.unavailable:
  # Store but mark for re-check
  version = createVersion(incoming, status: PENDING_CONFLICT_CHECK)
  scheduleRecheck(version.id)
  return {
    stored: true,
    warning: "Conflict check deferred — Graphiti unavailable",
    status: "PENDING_CONFLICT_CHECK"
  }

# Normal flow continues if Graphiti was reachable
```

**Re-check script** (`scripts/recheck-conflicts.js`) — runs as a K8s CronJob every 5 minutes:

```
# Pseudo-code for scripts/recheck-conflicts.js

pending = db.query("
  SELECT * FROM knowledge_versions
  WHERE status = 'PENDING_CONFLICT_CHECK'
  ORDER BY created_at ASC
  LIMIT 50
")

for each version in pending:
  try:
    graphiti.ping()   # fast liveness check first
  catch:
    break             # Graphiti still down, stop and wait

  result = detectConflict(version)

  if result.conflict:
    db.updateStatus(version.id, 'CONFLICT_DETECTED')
    notifyHuman(version)
  else:
    db.updateStatus(version.id, 'ACTIVE')

  writeAuditEntry(version.id, 'conflict_recheck_complete')
```

**Helm CronJob (every 5 minutes):**
```yaml
schedule: "*/5 * * * *"
command: ["node", "scripts/recheck-conflicts.js"]
```

**Why 50 per batch:** Bounded so one slow Graphiti call doesn't hold the job past its next scheduled run. At 5min cadence and 50 items/run, this processes 600 deferred checks per hour — more than enough for any realistic outage recovery.

---

### PLAN-04: Implement confidence decay (GAP-04)

**Principle:** Use the pure function that already exists. Just call it on a schedule.

**Existing function (already in `src/governance/confidence.js`):**
```js
export function onAgeDecay(score) {
  return Math.max(0.0, score - 0.005);  // -0.005 per week
}
```

**Decay script** (`scripts/decay-confidence.js`) — new file, ~40 lines:

```
# Pseudo-code

DECAY_THRESHOLD_DAYS = 7          # only decay nodes older than 1 week
MINIMUM_CONFIDENCE = 0.10         # floor — never decay below this
BATCH_SIZE = 200

staleNodes = db.query("
  SELECT id, topic, key, confidence, last_accessed_at, created_at
  FROM knowledge_versions
  WHERE status = 'ACTIVE'
    AND created_at < NOW() - INTERVAL '7 days'
    AND confidence > 0.10
  ORDER BY last_accessed_at ASC
  LIMIT 200
")

for each node in staleNodes:
  newScore = onAgeDecay(node.confidence)
  newScore = max(newScore, MINIMUM_CONFIDENCE)

  if newScore == node.confidence:
    continue   # already at floor, skip

  db.updateConfidence(node.id, newScore)

  writeAuditEntry({
    operation: 'confidence_decay',
    topic: node.topic,
    key: node.key,
    old_confidence: node.confidence,
    new_confidence: newScore,
    triggered_by: 'confidence_decay'
  })

  # Also update the Graphiti episode metadata
  graphiti.updateEpisodeMetadata(node.graphiti_episode_id, {
    confidence: newScore
  })

log("Decayed " + count + " nodes")
```

**Helm CronJob (weekly, Sunday 2am UTC):**
```yaml
schedule: "0 2 * * 0"
command: ["node", "scripts/decay-confidence.js"]
restartPolicy: OnFailure
```

**Note:** The `onAgeDecay` formula decays by 0.005/week. A node starting at 0.7 reaches the 0.10 floor after ~120 weeks (2.3 years) with no access. Frequent access (via `onRecall` which adds +0.01) counteracts decay — actively used knowledge stays authoritative.

---

### PLAN-05: Audit log archival (GAP-05)

**Decision:** Dedicated audit bucket (`company-quorum-audit`) — separate from the config bucket. Independent lifecycle policy (Glacier after 1 year), separate IAM grants for auditor access, clean compliance boundary.



**Principle:** Never delete. Mark as archived. Export to S3 for long-term storage.

**Schema addition (new migration):**
```sql
ALTER TABLE audit_log
  ADD COLUMN archived_at TIMESTAMPTZ,
  ADD COLUMN archive_s3_key TEXT;

CREATE INDEX idx_audit_log_archived ON audit_log (archived_at)
  WHERE archived_at IS NULL;  -- partial index: only unarchived rows
```

**Archival script** (`scripts/archive-audit.js`) — ~60 lines:

```
# Pseudo-code

ARCHIVE_AFTER_DAYS = 90
BATCH_SIZE = 10000
S3_PREFIX = "audit-archive"

cutoff = NOW() - INTERVAL '90 days'

# Stream in batches (never load all rows into memory)
loop:
  batch = db.query("
    SELECT * FROM audit_log
    WHERE created_at < $cutoff
      AND archived_at IS NULL
    ORDER BY created_at ASC
    LIMIT 10000
  ", cutoff)

  if batch is empty: break

  # Serialize to newline-delimited JSON, gzip
  content = batch.map(toJSON).join('\n')
  compressed = gzip(content)

  # Key: audit-archive/2026/01/2026-01-01T00:00:00Z_to_2026-01-31T00:00:00Z.jsonl.gz
  s3Key = buildS3Key(batch.first.created_at, batch.last.created_at)

  s3.putObject({
    Bucket: QUORUM_CONFIG_BUCKET,
    Key: s3Key,
    Body: compressed,
    ContentEncoding: 'gzip',
    ContentType: 'application/x-ndjson'
  })

  # Mark as archived — append-only: we add the pointer, never delete the row
  db.query("
    UPDATE audit_log
    SET archived_at = NOW(), archive_s3_key = $key
    WHERE id = ANY($ids)
  ", s3Key, batch.map(r => r.id))

  log("Archived " + batch.length + " entries to " + s3Key)
```

**Retrieval:** The audit CLI (`node cli.js audit lineage`) already queries `audit_log`. Add a flag:
```
node cli.js audit lineage auth:token-strategy --include-archived
```
This fetches the S3 archive for the relevant date range and merges with local results before display.

**Helm CronJob (monthly, 1st of month, 3am UTC):**
```yaml
schedule: "0 3 1 * *"
command: ["node", "scripts/archive-audit.js"]
```

---

### PLAN-06: GitHub token cache with TTL (GAP-06)

**Decision:** Option A — 15-minute TTL. Long enough for an engineer to complete a multi-step task without re-verification interrupting their flow; short enough to revoke access within a predictable window. Always inspect `X-RateLimit-Remaining` on every GitHub API response and log a warning below 500.



**Principle:** Replace a plain object cache with a Map that stores expiry timestamps. No new library needed.

**Current (simplified):**
```js
let cached = null;
export async function resolveIdentity() {
  if (cached) return cached;
  cached = await verify();
  return cached;
}
```

**Target — TTL cache (~10 lines of change):**

```js
const TTL_MS = 15 * 60 * 1000;   // 15 minutes
const cache = new Map();           // token → { identity, expiresAt }

export async function resolveIdentity(token, { forceRefresh = false } = {}) {
  const cacheKey = token ?? 'anonymous';
  const hit = cache.get(cacheKey);

  if (!forceRefresh && hit && hit.expiresAt > Date.now()) {
    return hit.identity;
  }

  const identity = await verify(token);
  cache.set(cacheKey, { identity, expiresAt: Date.now() + TTL_MS });
  return identity;
}

# In verifyGitHubToken():
catch (err):
  if err.status === 401:
    return { author: 'anonymous', verified: false, reason: 'token_revoked' }
  # Inspect rate limit header
  remaining = parseInt(response.headers['x-ratelimit-remaining'] ?? '9999')
  if remaining < 100:
    log.warn("GitHub API rate limit low", { remaining })
```

**Why 15 minutes:** Long enough to avoid redundant API calls in a normal work session; short enough that a revoked token stops working within 15 minutes, which is acceptable for an internal engineering tool.

---

### PLAN-07 + 08 + 09: Test coverage (GAP-07, GAP-08, GAP-09)

**Principle:** All three gaps are pure test additions — zero production code changes. Use the mocking pattern already established in the codebase (`vi.mock()` at top-level, mock at module boundaries).

#### Config loader polling tests (`tests/config/loader.test.js`)

```
# Test structure

mock: vi.mock('@aws-sdk/client-s3')
mock: vi.mock('../../src/audit/pipeline.js', passThrough)

describe('pollConfig'):

  test 'skips update when ETag matches':
    s3.GetObject → { ETag: '"abc"', Body: validConfig }
    loadConfig()    # populates ETag cache
    s3.GetObject → { ETag: '"abc"' }   # same ETag
    pollOnce()
    assert s3.GetObject called once (not twice for body)
    assert config unchanged

  test 'applies update when ETag changes':
    s3.GetObject → { ETag: '"abc"', Body: configV1 }
    loadConfig()
    s3.GetObject → { ETag: '"xyz"', Body: configV2 }
    pollOnce()
    assert currentConfig === configV2

  test 'does not crash server when S3 unreachable mid-poll':
    loadConfig()
    s3.GetObject → throws NetworkError
    assert pollOnce() resolves without throwing
    assert currentConfig unchanged  # last good config retained
```

#### Pending staleness tests (`tests/tools/pending.test.js`)

```
describe('pending'):

  test 'shows stale warning when active version advanced':
    db.getPendingDecisions → [{
      topic: 'auth', key: 'token-strategy',
      created_at_version: 1
    }]
    db.getCurrentVersion → { version: 3 }
    result = await pending({})
    assert result includes "stale" warning
    assert result shows "active is now v3, brief was created at v1"

  test 'no warning when active version unchanged':
    db.getPendingDecisions → [{ created_at_version: 3 }]
    db.getCurrentVersion → { version: 3 }
    result = await pending({})
    assert result has no stale flag

  test 'empty queue returns clean response':
    db.getPendingDecisions → []
    result = await pending({})
    assert result indicates "no pending decisions"
```

#### Gateway route tests (`tests/gateway/auth.test.js`)

```
# Pattern: use supertest against the Express app directly
# No real GitHub API — mock at the resolver boundary

import { app } from '../../src/gateway/server.js'
import supertest from 'supertest'

mock: vi.mock('../../src/identity/resolver.js')

describe('POST /auth/token'):

  test 'returns JWT for valid GitHub token':
    resolver.resolveIdentity.mockResolvedValue({
      author: 'alice', verified: true, role: 'engineer'
    })
    res = await supertest(app)
      .post('/auth/token')
      .set('Authorization', 'Bearer valid-token')
    assert res.status === 200
    assert res.body.token is a valid JWT
    assert jwtVerify(res.body.token).sub === 'alice'

  test 'returns 401 for invalid token':
    resolver.resolveIdentity.mockResolvedValue({ verified: false })
    res = await supertest(app)
      .post('/auth/token')
      .set('Authorization', 'Bearer bad-token')
    assert res.status === 401

  test 'returns 401 with no Authorization header':
    res = await supertest(app).post('/auth/token')
    assert res.status === 401
```

---

### PLAN-10: Gateway error sanitisation (GAP-10)

**Principle:** One error handler. Client errors (4xx) surface the message. Server errors (5xx) surface nothing.

```js
// Add to bottom of src/gateway/server.js, after all routes

app.use((err, req, res, next) => {
  const status = err.status ?? err.statusCode ?? 500;

  // Structured log for all errors (stays server-side)
  if (status >= 500) {
    console.error({
      path: req.method + ' ' + req.path,
      status,
      message: err.message,
      // Never log req.body — may contain tokens or knowledge content
    });
  }

  // Safe response — never expose stack, SQL, or AWS details externally
  res.status(status).json({
    error: status < 500 ? err.message : 'Internal server error',
    code: err.code ?? undefined   // structured error codes are safe (e.g. "CONFLICT_DETECTED")
  });
});
```

**Existing error shapes to define (centralise in `src/gateway/errors.js`):**

```js
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const Errors = {
  unauthorized: (msg) => new HttpError(401, msg, 'UNAUTHORIZED'),
  forbidden: (msg) => new HttpError(403, msg, 'FORBIDDEN'),
  notFound: (msg) => new HttpError(404, msg, 'NOT_FOUND'),
  conflict: (msg) => new HttpError(409, msg, 'CONFLICT'),
  unprocessable: (msg) => new HttpError(422, msg, 'UNPROCESSABLE'),
};
```

Route handlers then `throw Errors.unauthorized("Token revoked")` — no more inconsistent response shapes.

---

### PLAN-11: TLS between services (GAP-11)

**Decision:** Envoy sidecar mTLS — self-contained manual service mesh without a control plane dependency.

- **Gateway → Graphiti:** Envoy sidecar on both pods handles mTLS. Gateway Node.js talks to `localhost:9000` (its own Envoy); Envoy makes mTLS hop to Graphiti's Envoy on `:9000`; Graphiti Envoy proxies to `localhost:8000` (plain HTTP, Python uvicorn unchanged).
- **Gateway → PostgreSQL:** Native PostgreSQL SSL — no sidecar needed, pg client supports it natively.
- **MCP → Gateway:** Ingress TLS — already in place.
- **Cert management:** cert-manager `Certificate` resources. Envoy watches cert files on filesystem — rotates without pod restart.
- **Helm:** `graphiti.envoy.enabled`, `postgresql.tls.enabled` (default false for local dev, true for production).
- **Rationale:** Graphiti's Python code is completely untouched. Security boundary lives entirely inside the Helm chart — no Linkerd control plane, no CNI dependency, no cluster-admin requirement beyond cert-manager (near-universal on managed clusters).



**Principle:** Use cert-manager (already common in K8s clusters) + PostgreSQL native SSL. No service mesh — that's over-engineered for this stack's current scale.

**Step 1 — PostgreSQL SSL (Helm values addition):**
```yaml
# helm/quorum/values.yaml
postgresql:
  tls:
    enabled: false          # default off; set true for production
    certSecretName: ""      # cert-manager Certificate secret name
```

**Step 2 — pg client (src/audit/secondary.js + src/gateway/server.js):**
```js
// Conditional SSL based on env
const sslConfig = process.env.POSTGRES_SSL === 'true'
  ? { rejectUnauthorized: true }
  : false;

const pool = new pg.Pool({ ..., ssl: sslConfig });
```

**Step 3 — Gateway → Graphiti HTTPS (future, not needed now):**
Graphiti runs in the same K8s pod namespace. K8s network policies can restrict traffic to only gateway→graphiti without TLS. Add a values flag `graphiti.networkPolicy.enabled: true` that creates a `NetworkPolicy` resource restricting ingress to the gateway pod only. This is simpler than mTLS and sufficient for the threat model.

**Document in DEPLOYMENT.md:**
```
## Production TLS checklist
- [ ] Set POSTGRES_SSL=true in gateway env
- [ ] Provision cert-manager Certificate for postgresql service
- [ ] Set postgresql.tls.enabled=true in Helm values
- [ ] Apply NetworkPolicy for graphiti (restrict to gateway pod only)
- [ ] Ingress TLS already configured via values.yaml
```

---

### PLAN-12: Config schema versioning (GAP-12)

**Principle:** Add `schema_version` now, write a one-step migration loader for when the schema changes in future.

**Zod schema addition (`src/config/schema.js`):**
```js
export const configSchema = z.object({
  schema_version: z.literal('1').default('1'),  // new field with default
  project: z.string(),
  // ... rest of schema unchanged
});
```

**Loader migration shim (`src/config/migrations.js`) — trivial now, useful later:**
```
function migrateConfig(raw):
  version = raw.schema_version ?? '0'   # '0' = pre-versioning

  if version === '0':
    # v0 → v1: add schema_version field, no other changes
    return { ...raw, schema_version: '1' }

  if version === '1':
    return raw   # current version, no migration needed

  throw Error("Unknown config schema version: " + version)

# In loader.js, before validate():
migrated = migrateConfig(rawJson)
validated = configSchema.parse(migrated)
```

**Result:** Old configs without `schema_version` continue to work. New configs declare version explicitly. When v2 is needed, add one `if version === '1'` branch.

---

### PLAN-13: reflect.js deduplication guard (GAP-13)

**Principle:** Hash the content before inserting. Skip if identical hash exists as DRAFT for same topic:key.

```
# In src/tools/reflect.js, before inserting each extracted node:

function shouldSkipReflect(topic, key, content):
  contentHash = sha256(content)

  existing = db.query("
    SELECT id FROM knowledge_versions
    WHERE topic = $topic
      AND key = $key
      AND status = 'DRAFT'
      AND metadata->>'content_hash' = $hash
    LIMIT 1
  ", topic, key, contentHash)

  return existing.length > 0

# Usage:
for each extracted in reflectResults:
  if shouldSkipReflect(extracted.topic, extracted.key, extracted.content):
    log("Skipping duplicate reflect entry: " + extracted.topic + ":" + extracted.key)
    continue
  insertDraft(extracted)
```

**Cost:** One extra SELECT per extracted item. At typical reflect sizes (3–8 items per task), this is negligible.

---

### PLAN-14: Rate limiting on gateway (GAP-14)

**Principle:** In-process rate limiting with `express-rate-limit`. No Redis, no external state — simple and sufficient for a single-instance gateway.

```js
// src/gateway/middleware/rate-limit.js  (new file, ~20 lines)

import { rateLimit } from 'express-rate-limit';

// Per-JWT-subject rate limiting (each engineer gets their own bucket)
const keyGenerator = (req) =>
  req.auth?.sub ?? req.ip;  // after JWT verify middleware sets req.auth

export const authLimit = rateLimit({
  windowMs: 60_000,
  max: 10,              // 10 token requests per minute per IP
  keyGenerator: (req) => req.ip,
  message: { error: 'Too many auth requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiLimit = rateLimit({
  windowMs: 60_000,
  max: 300,             // 300 API calls per minute per engineer
  keyGenerator,
  message: { error: 'Rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const graphitiLimit = rateLimit({
  windowMs: 60_000,
  max: 100,             // tighter — Graphiti is expensive
  keyGenerator,
  message: { error: 'Graphiti rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});
```

```js
// In src/gateway/server.js:
import { authLimit, apiLimit, graphitiLimit } from './middleware/rate-limit.js';

app.use('/auth', authLimit);
app.use('/graphiti', graphitiLimit);
app.use('/pg', apiLimit);
app.use('/config', apiLimit);
```

**Note on single-instance assumption:** `express-rate-limit` is in-process. If the gateway scales to 2+ replicas, state is not shared between instances. For multi-replica, swap the store to `rate-limit-redis` — one line change: `store: new RedisStore({ client: redisClient })`. FalkorDB (already in the stack) could serve as this Redis instance — no new infrastructure.

---

### Summary: Complexity vs Impact Map

```
High Impact, Low Complexity (do first):
  GAP-01  LLM fallback fix          → 3-line change in conflict.js
  GAP-02  Graphiti CI build         → 20-line YAML addition
  GAP-06  Token TTL cache           → 10-line change in identity/resolver.js
  GAP-10  Error sanitisation        → 15-line error handler + errors.js
  GAP-12  Config schema_version     → 5-line Zod + migration shim (now per-project JSONB — see GAP-30)
  GAP-14  Rate limiting             → new 20-line middleware file
  GAP-24  Knowledge bump mechanic   → new bump_log table + 1 Gateway route + dashboard panel (after GAP-04 + GAP-18)
  GAP-25  Config PATCH optimistic lock → config_version column + 409 check (ships with GAP-20)
  GAP-26  PA bootstrap guard        → creator auto-enrolled + last-PA constitutional rule (ships with GAP-20)
  GAP-28  Graphiti group_id dynamic → thread projectId through graph client calls (~15 lines, ships with GAP-20)
  GAP-29  Project archival          → bulk soft-deprecate + pre-export hook (~30 lines, ships with GAP-20)
  GAP-31  Project rate limiting     → second rateLimit() tier, keyGenerator = req.projectId (~10 lines)
  GAP-32  Project discovery         → GIN-indexed JSONB @> query + GET /api/projects?member= (~20 lines)

High Impact, Medium Complexity (schedule for v0.3):
  GAP-03  Graphiti downtime         → new PENDING_CONFLICT_CHECK status + 40-line recheck script + CronJob
  GAP-04  Confidence decay          → 40-line decay script + CronJob (calls existing pure function)
  GAP-08  Pending staleness tests   → ~40 lines of tests, no production changes
  GAP-09  Gateway route tests       → ~120 lines of tests, no production changes
  GAP-13  reflect deduplication     → 15-line guard + 1 SQL query
  GAP-27  Global namespace          → reserved project_id + read-through fallback in recall() and search()
  GAP-30  JSONB migration loader    → migrations array + applyMigrations() on every config read

High Impact, High Complexity (plan carefully):
  GAP-05  Audit archival            → schema migration + 60-line script + CronJob + CLI flag
  GAP-11  TLS                       → Helm values + pg config + NetworkPolicy
  GAP-20  Multi-project system      → projects table + full API + Graphiti group_id + config-in-DB (blocks GAP-25 to GAP-32)

Obsolete (do not implement):
  GAP-07  S3 polling tests          → superseded by GAP-20 (no S3 polling after redesign)
  GAP-19  S3 config write path      → superseded by GAP-20 (config lives in PostgreSQL)

Low Impact (P3 — schedule freely):
  GAP-15  Multi-platform Graphiti   → 5-line YAML addition
  GAP-16  CLI audit tests           → subprocess test pattern
```

---



| Module | Completeness | Notes |
|--------|-------------|-------|
| `src/governance/constitutional.js` | ✅ Complete | 100% test coverage enforced |
| `src/governance/authority.js` | ✅ Complete | Scoring formula tested |
| `src/governance/conflict.js` | ⚠️ 85% | LLM fallback gap (GAP-01), Graphiti downtime gap (GAP-03) |
| `src/governance/confidence.js` | ⚠️ 70% | Pure functions done; no scheduled decay job (GAP-04) |
| `src/governance/provenance.js` | ✅ Complete | Hash + version record building |
| `src/audit/pipeline.js` | ✅ Complete | Pre+post entries, failure compensation |
| `src/audit/secondary.js` | ✅ Complete | Append-only enforced; no archival (GAP-05) |
| `src/audit/chain.js` | ✅ Complete | SHA256 chain verified at startup |
| `src/graph/client.js` | ✅ Complete | BLOCKED_METHODS enforced |
| `src/graph/queries.js` | ✅ Complete | Full version CRUD + transitions |
| `src/identity/resolver.js` | ⚠️ 80% | Cache TTL missing (GAP-06) |
| `src/config/loader.js` | ❌ Rewrite required | S3 polling replaced by PostgreSQL `projects` table (GAP-20). `pollConfig()` eliminated. Migration loader (GAP-30) added. |
| `src/tools/remember.js` | ✅ Complete | Conflict + supersession flow tested |
| `src/tools/recall.js` | ✅ Complete | All 4 retrieval modes tested |
| `src/tools/search.js` | ✅ Complete | |
| `src/tools/forget.js` | ✅ Complete | |
| `src/tools/history.js` | ✅ Complete | |
| `src/tools/review.js` | ✅ Complete | |
| `src/tools/reflect.js` | ⚠️ 80% | No deduplication guard (GAP-13) |
| `src/tools/export.js` | ✅ Complete | |
| `src/tools/pending.js` | ⚠️ 70% | Staleness detection untested (GAP-08) |
| `src/gateway/server.js` | ⚠️ 75% | No rate limiting (GAP-14), error leakage (GAP-10) |
| `src/gateway/routes/` | ⚠️ 60% | No route tests (GAP-09) |
| `Dockerfile.graphiti` | ⚠️ 80% | Not in CI build (GAP-02) |
| Confidence decay job | ❌ Missing | `confidence_decay` TriggeredBy defined but no job (GAP-04) |
| Audit archival | ❌ Missing | No archival strategy (GAP-05) |

---

## Prioritised Backlog

| ID | Title | Priority | Effort |
|----|-------|----------|--------|
| GAP-01 | LLM failure returns false-positive conflict | P0 | Small |
| GAP-02 | Add Dockerfile.graphiti to CI build | P0 | Small |
| GAP-03 | Graphiti downtime skips conflict detection silently | P1 | Medium |
| GAP-04 | Implement confidence decay scheduled job | P1 | Medium |
| GAP-05 | Audit log archival strategy | P1 | Large |
| GAP-06 | GitHub token cache TTL + revocation handling | P1 | Small |
| GAP-07 | ~~Tests for config/loader.js S3 polling~~ — SUPERSEDED by GAP-20 | Obsolete | — |
| GAP-08 | Tests for pending.js staleness detection | P2 | Small |
| GAP-09 | Tests for gateway routes | P2 | Large |
| GAP-10 | Gateway error response sanitisation | P2 | Small |
| GAP-11 | TLS between services in Kubernetes | P2 | Large |
| GAP-12 | Add schema_version to quorum.config | P2 | Small |
| GAP-13 | reflect.js deduplication guard | P3 | Small |
| GAP-14 | Rate limiting on gateway endpoints | P3 | Small |
| GAP-15 | Multi-platform build for Graphiti image | P3 | Small |
| GAP-16 | CLI audit lineage test coverage | P3 | Small |
| GAP-17 | Webhook notification on DRAFT creation | P1 | Small |
| GAP-18 | Role and seniority in authority scoring formula | P1 | Small |
| GAP-19 | ~~Config write path (PUT /config/:projectId)~~ — SUPERSEDED by GAP-20 | Obsolete | — |
| GAP-20 | Multi-project system — project registry, config-in-DB, full API | P1 | Large |
| GAP-21 | Domain track record in authority scoring | P2 | Large |
| GAP-22 | Graph scale handling for dashboard (500+ nodes) | P3 | Small |
| GAP-23 | SKILL.md design and deployment | Deferred | Large |
| GAP-24 | Knowledge endorsement ("bump") with role-weighted confidence restoration | P1 | Small |
| GAP-25 | Config PATCH race condition — optimistic locking | P0 | Small |
| GAP-26 | Project bootstrap paradox — no PA on creation | P0 | Small |
| GAP-27 | Cross-project knowledge sharing — global namespace | P1 | Medium |
| GAP-28 | Graphiti group_id static — must be per-request | P1 | Small |
| GAP-29 | Project archival orphans knowledge_versions rows | P1 | Small |
| GAP-30 | JSONB config schema migration per project | P2 | Small |
| GAP-31 | No project-level rate limiting (second tier) | P2 | Small |
| GAP-32 | Project discovery — no endpoint to list a user's projects | P2 | Small |

---

## Product Assessment — Governance, Usage, Functionalities, Capabilities

> Added: 2026-04-19 | Next session: discuss and work through this conceptually and theoretically

---

### Governance — Strong Model, Weak Workflow

The governance *model* is well-designed. Constitutional rules, conflict detection, authority weighting, human-in-the-loop, provenance tracking — the concepts are right and the code enforces them.

The governance *workflow* has a critical gap: it is entirely pull-based. When knowledge gets flagged for human review, nothing tells anyone. No notification, no webhook, no Slack message. The human has to remember to ask Claude "any pending decisions?" and Claude runs `pending()`. In a busy engineering team, this means the review queue fills up and nobody notices. The governance model exists on paper; the mechanism to actually exercise it does not.

**This is the most important product gap.** The entire value proposition — "humans at the fork" — depends on humans actually knowing when they are needed.

---

### Functionalities — 9 of 14 Tools Built

The CLAUDE.md spec defines 14 tools. Current state:

| Tool | Status |
|------|--------|
| remember() | ✅ Built |
| recall() | ✅ Built |
| search() | ✅ Built |
| forget() | ✅ Built |
| history() | ✅ Built |
| review() | ✅ Built |
| reflect() | ✅ Built |
| export() | ✅ Built |
| pending() | ✅ Built |
| ingest_pr() | ❌ Not built |
| enrich_from_jira() | ❌ Not built |
| enrich_from_confluence() | ❌ Not built |
| search_atlassian() | ❌ Not built |
| sync_atlassian() | ❌ Not built |

36% of planned functionality is missing. The five missing tools are all *external ingestion* capabilities — PR learning, Jira enrichment, Confluence extraction. Without them, Quorum learns only from what engineers explicitly tell it. The knowledge graph does not grow from engineering activity automatically.

---

### Capabilities — What It Can Actually Do Today

**Works well:**
- Storing and versioning engineering knowledge with full provenance
- Conflict detection (with the LLM fallback caveat from GAP-01)
- Authority-based supersession decisions
- Full version history and point-in-time recall
- Cryptographically verified append-only audit trail
- Export to markdown

**Partially works:**
- Self-evolution via `reflect()` — the tool exists but SKILL.md (which makes Claude call it automatically after every task) is explicitly deferred as "last to implement". Without SKILL.md deployed, engineers must manually trigger reflect. The self-evolving loop is not closed.
- Human governance — exists but pull-based, not push-based.

**Does not work yet:**
- Learning from PRs automatically
- Atlassian knowledge ingestion (Jira, Confluence)
- Multi-team self-service (GROUP_ID exists but teams cannot configure their own namespace without platform team involvement)
- Any visibility into graph state without querying via CLI or MCP tools
- Proactive notifications of any kind

---

### Usage — Three Personas, Very Different Experiences

**Engineers (primary users):** Reasonable experience. They write via Claude, recall via Claude, it mostly works. Friction point: they do not know when their DRAFTs are approved without asking.

**Tech leads and architects (reviewers):** Poor experience. They must periodically poll `pending()` to find what needs review. No proactive surface. In practice, reviews will be forgotten and DRAFTs will accumulate.

**Platform teams (configurers):** Worst experience. They write a JSON config file and upload it to S3 manually. No UI. No validation feedback until Quorum polls and parses it. No visibility into what is currently active in the knowledge graph.

---

### The Self-Evolution Loop Is Not Closed

Quorum's core differentiator is knowledge that grows automatically from engineering activity. The intended loop:

```
Engineer completes task → Claude reflects → knowledge extracted → DRAFT created
→ reviewer notified → reviewed → ACTIVE → future engineers benefit
```

The loop breaks at two points:
1. `reflect()` is not called automatically — SKILL.md is deferred
2. Reviewers are not notified — they must poll

The actual current loop:
```
Engineer manually calls reflect → DRAFT created → sits in queue → maybe reviewed someday
```

That is not self-evolving. That is a manual knowledge base with extra steps.

---

### The Authority Model Is Incomplete Relative to Spec

The CLAUDE.md spec describes authority weighting that includes role and seniority. The actual implementation in `src/governance/authority.js`:

```
score = (confidence × 0.5) + (recency × 0.3) + (access_frequency × 0.2)
```

Role and seniority are noted as "can be added later via team config." This means currently a junior engineer's frequently-accessed new knowledge can outweigh a principal architect's older decision. The authority model does not reflect organisational hierarchy — only recency and access patterns.

---

### Capability Shape

```
Constitutional layer         ████████████░░  Strong, near-complete
Audit system                 ████████████░░  Strong, missing CI gate
Core MCP tools (9/14)        ████████░░░░░░  Good core, missing ingestion
Governance model             ██████████░░░░  Model solid, workflow pull-based
Self-evolution loop          ████░░░░░░░░░░  Broken at two points
Authority model              ██████░░░░░░░░  Incomplete vs spec
External integrations        ░░░░░░░░░░░░░░  Not started
Notification system          ░░░░░░░░░░░░░░  Not started
Visibility / dashboard       ░░░░░░░░░░░░░░  Not started
Platform team UX             ██░░░░░░░░░░░░  Functional but painful
```

---

### Core Product Problem

Quorum today is a well-built governance engine with no delivery mechanism. The rules are right, the audit is solid, the storage is sound — but the system does not proactively surface anything to anyone. It answers questions when asked but never volunteers information. For a product whose value proposition is "humans at the fork," the humans currently have to find the fork themselves.

---

### Agenda for Next Session

Discuss and work through the following conceptually and theoretically before any implementation:

1. **Notification system design** — how does Quorum tell humans they are needed? Webhook, Slack, email, MCP push? What is the right abstraction so it works across different team setups?
2. **Closing the self-evolution loop** — SKILL.md design: what does it look like, when does Claude invoke it, what are the guardrails to prevent over-extraction?
3. **Authority model completion** — how do role and seniority feed into the score? How does the team config express organisational hierarchy in a way that is maintainable?
4. **External ingestion strategy** — `ingest_pr()`, Jira, Confluence: what is the right sequencing, and how do these interact with the existing conflict detection pipeline?
5. **Platform team experience** — config management UX: can teams self-serve without S3 knowledge? Is there a simpler path?

---

## No "engram" References

Confirmed: no source file, template, script, or documentation contains the string "engram". The only occurrence is the filesystem directory path (`/vscode/engram`) which is the Git working directory — not a project identity reference and not present in any built artifact.

---

## Recommended Next Steps

1. **Fix GAP-01 now** — one-line change in conflict.js; unblocks production use under LLM partial outage
2. **Fix GAP-02 now** — adds CI safety net for Graphiti image changes
3. **Schedule GAP-03, GAP-04, GAP-06** for v0.3 milestone
4. **Schedule GAP-07, GAP-08, GAP-09** as a dedicated "test coverage sprint" — these are pure test additions with no production code changes
5. **Design GAP-05 (archival)** as a separate RFC — involves S3 schema decisions and operational runbooks
