# Quorum — Gap Analysis v0.3

> Written after the v0.2 + dashboard session (April 2026).
> Traces the full adoption journey end-to-end: discovery → install → first run →
> daily use → operational maturity. Gaps are ordered by act and rated by severity.
>
> **Status legend:** ✅ Resolved in this session · ⏳ Pending · 🎯 v0.3 target
>
> **What changed since v0.2 gap analysis:**
> The dashboard session delivered more than governance logic — it meaningfully
> reduced first-run friction. Before claiming adoption friction is still 2/5,
> those improvements are credited first.

---

## What v0.2 + this session already fixed

| What improved | Impact on friction |
|---------------|--------------------|
| **Dashboard** (React, conflict review UI, knowledge browse) | Engineers can manage knowledge without CLI — visual entry point lowers the "what does this do?" question |
| **`npm run quorum:install`** — one command for MCP + skill | Eliminates the two-step copy-paste install that tripped most people up |
| **`npm run docker:rebuild/clean/ps`** | Common ops no longer require reading the setup.sh source |
| **LocalStack persistence detection** in `setup.sh` | Silent data loss on container restart now warned at startup — engineers know before they lose work |
| **Gateway healthcheck fix** (200 or 503) | Stack no longer deadlocks when external LocalStack is in use — was a P0 show-stopper for local dev |
| **LLM prompt extraction** to markdown files | Prompts are now editable without touching code — reduces "can I tweak the AI?" friction for teams |
| **QUICKSTART.md** + lean CLAUDE.md | Gets an engineer to a running system without reading the full CLAUDE.md |
| **`ONBOARDING.md`** with gateway setup guide | Central stack deployment is now documented step-by-step |

**Revised adoption friction rating: 3/5** (up from 2/5)

The dashboard alone moves the needle. A visual interface with pending decisions, conflict review, and knowledge browsing is the single highest-leverage adoption driver — engineers see the value immediately without needing to read documentation. The install scripts and healthcheck fix remove two of the top three first-run failure modes.

What holds it at 3/5 rather than 4/5:
- Stack still requires 6 Docker containers (Graphiti dependency makes lightweight impossible today)
- `reflect()` runs silently — no feedback loop, no observability into whether self-evolution is working
- Confidence decay is designed but not automated — knowledge staleness silently accumulates
- No npx zero-config entry (still requires git clone + npm install)
- LLM is a hard dependency in the critical path — no fallback when OpenAI is down

---

## Act 1 — Discovery and First Impression

### GAP-24 · No npx zero-config entry point `HIGH` 🎯 v0.3

**Friction:** "How do I try this?" currently requires cloning the repo. For OSS tools
the bar is `npx quorum start`. The friction drop from "clone + read setup docs" to
"one command that works" is the difference between 10 stars and 1000 stars on GitHub.

**Resolution:**
1. Publish `quorum` to npm with `"bin": { "quorum": "./cli.js" }` already wired
2. `npx quorum start` → checks Docker, runs `docker compose up` via bundled compose file
3. `npx quorum init` → creates `.quorum` file in current directory
4. Include bundled `docker-compose.yml` in the npm package (not the full repo)
5. Guard: if `node_modules/` is absent, auto-run `npm install` silently

**Scope:** `package.json` publish config, `.npmignore`, README update, test with `npx --yes`

---

### GAP-25 · No lightweight "try it now" stack `MEDIUM` 🎯 v0.3

**Friction:** 6 Docker containers (FalkorDB + PostgreSQL + Graphiti + Gateway + Dashboard +
Quorum) is a significant ask for a solo engineer evaluating the tool on a MacBook.
Graphiti alone pulls in a Python ML environment.

**Resolution — `quorum:start:lite` mode:**
- Use SQLite for the audit store (already optional — pg driver swappable)
- Use an in-process mock graph client (`src/graph/mock-client.js`) for local dev when
  `QUORUM_LITE=true` — stores episodes in SQLite, no Graphiti sidecar required
- Conflict detection degrades gracefully (semantic similarity via local embeddings or disabled)
- Full stack remains the production path; lite is explicitly for evaluation

**Files to add/modify:**
- `src/graph/mock-client.js` — in-process episode store over SQLite
- `src/server.js` — switch client based on `QUORUM_LITE` env var
- `docker-compose.lite.yml` — just PostgreSQL (or SQLite) + Quorum, no Graphiti/FalkorDB
- QUICKSTART.md — add "Try without Docker" section

---

## Act 2 — First Run and Stack Setup

### GAP-26 · `reflect()` has no observability `HIGH` 🎯 v0.3

**Friction:** The self-evolution loop is the core value proposition. But right now:
- Engineers cannot tell whether `reflect()` extracted anything after a task
- No dashboard panel shows reflect activity over time
- The skill calls `reflect()` post-task but the result is swallowed — Claude reports
  "no team-specific knowledge identified" but this is invisible in any UI

**Resolution:**
1. **Dashboard panel** — "Reflect Activity" timeline: last 7 days of reflect calls,
   extraction rate (extracted / calls), top topics being learned, avg items per reflect
2. **SKILL.md guidance** — instruct Claude to always report the reflect() result to the
   user at session end ("Added 2 knowledge items to DRAFT — pending review")
3. **Audit entries** for reflect calls should be queryable via `GET /api/audit?tool=reflect`
4. **Weekly reflect digest** (optional) — `quorum reflect digest` CLI shows what the team
   has been learning automatically

**Files to modify:**
- `dashboard/src/pages/` — add ReflectActivity panel to overview
- `src/gateway/routes/` — `GET /api/audit` with `tool` filter
- `skill/SKILL.md` — session-end summary instructions
- `src/tools/reflect.js` — ensure audit entries are tagged `tool: 'reflect'`

---

### GAP-27 · Confidence decay not automated `HIGH` 🎯 v0.3

**Friction:** The confidence decay model is fully designed (−0.005/week without access,
−0.1 on conflict, +0.01 on recall). The `job:decay` npm script exists. But:
- No cron is set up automatically — it must be run manually or added to a scheduler externally
- No dashboard visibility into stale knowledge
- Knowledge nodes that have not been recalled in 6 months silently accumulate, lowering
  signal-to-noise as the graph grows

**Resolution:**
1. **Docker Compose cron sidecar** — add a lightweight `cron` service to `docker-compose.yml`
   that runs `node scripts/decay-confidence.js` weekly and `node scripts/archive-audit.js` monthly
2. **Dashboard stale panel** — "Knowledge Health" section: count by confidence tier
   (high/medium/low), last-accessed distribution, nodes below 0.3 flagged for review
3. **K8s CronJob** — add `helm/quorum/templates/jobs/decay.yaml` CronJob manifest
4. **CLI report** — `quorum decay status` shows last run time, nodes decayed, current distribution

**Files to add/modify:**
- `docker-compose.yml` — cron service or `command` override on quorum container
- `helm/quorum/templates/jobs/decay-cronjob.yaml`
- `dashboard/src/pages/` — Knowledge Health panel
- `scripts/decay-confidence.js` — add `--report` flag for status output

---

### GAP-28 · Direct-mode MCP server has no auth `MEDIUM` 🎯 v0.3

**Friction:** When `QUORUM_GATEWAY_URL` is not set, the MCP server connects directly
to PostgreSQL and Graphiti. There is no authentication on the MCP server itself —
any process that can reach the stdio transport can write to the knowledge graph.

This is acceptable for a single-engineer local setup but blocks multi-engineer local
use cases (shared home lab, shared dev VM) and is a security concern in any container
deployment where the MCP server is exposed on a port.

**Resolution:**
1. **API key auth for direct mode** — `QUORUM_API_KEY` env var; if set, the MCP server
   requires `X-Quorum-Api-Key` header on every call (streamable HTTP transport)
2. **Identity in direct mode** — `author` claim falls back to `git config user.name`
   (already available via subprocess) when no JWT is present
3. **Document the boundary** — DEPLOYMENT.md section "When to use gateway mode vs direct mode"

**Files to modify:**
- `src/server.js` — API key middleware for HTTP transport
- `DEPLOYMENT.md` — auth model comparison

---

## Act 3 — Daily Use

### GAP-29 · LLM is a hard dependency in the governance critical path `HIGH` 🎯 v0.3

**Friction:** `detectConflict()` calls OpenAI. If `OPENAI_API_KEY` is unset or the API
is down, conflict detection falls through to `graphiti_unavailable: true` — meaning
knowledge is stored with `PENDING_CONFLICT_CHECK` status. This is the correct governance
behaviour. But:
- No retry — a transient 500 from OpenAI permanently marks the entry as pending conflict check
- No dashboard alert when `PENDING_CONFLICT_CHECK` entries accumulate
- `scripts/recheck-conflicts.js` exists but must be triggered manually
- `extractKnowledge()` in reflect.js returns `[]` silently when no API key — reflect does
  nothing and the engineer never knows

**Resolution:**
1. **Retry with backoff** — wrap all three LLM calls (contradiction, enrichment, extraction)
   with a 3-attempt exponential backoff before giving up
2. **Dashboard alert badge** — `PENDING_CONFLICT_CHECK` count shown in header; red if > 5
3. **Reflect fallback** — when no OpenAI key, `reflect()` returns the raw task summary
   as a single DRAFT item with `confidence: 0.35` and `entity_type: 'observation'` so
   something is captured even without LLM extraction
4. **`recheck-conflicts` automation** — wire it into the cron sidecar (GAP-27) — run
   daily, not just manually
5. **Environment check at startup** — warn clearly if `OPENAI_API_KEY` is absent

**Files to modify:**
- `src/governance/conflict.js` — retry wrapper
- `src/tools/reflect.js` — fallback extraction path
- `src/server.js` — startup env check
- `dashboard/src/` — pending conflict badge
- `docker-compose.yml` — recheck in cron schedule

---

### GAP-30 · `ingest_pr()` not implemented `MEDIUM` 🎯 v0.3

**Friction:** `ingest_pr` appears in CLAUDE.md, ROADMAP.md, and the tool list in SKILL.md
but the implementation is a stub. Engineers cannot extract knowledge from merged PRs —
one of the highest-value, lowest-effort signal sources. PRs contain explicit decisions,
review-validated patterns, and approver authority signals.

**Resolution — minimal viable `ingest_pr`:**
1. **GitHub PR fetch** — `src/pr/github.js` fetches PR description, review comments,
   and approvals via GitHub REST API (no OAuth — personal access token in env var is sufficient)
2. **Extraction agent** — call `extractKnowledge()` (already in reflect.js) on a
   concatenated summary of description + review comments
3. **Authority elevation** — if a principal architect approved the PR, extracted items
   get `confidence: 0.85` instead of default
4. **GitHub Action** — `.github/workflows/quorum-pr-ingest.yml` triggers on `pull_request`
   closed + merged, calls `node src/tools/ingest_pr.js --pr-url $URL`
5. **dry_run mode** — default true; engineer reviews extractions via dashboard before committing

**Files to add/modify:**
- `src/pr/github.js` — GitHub API client
- `src/pr/extractor.js` — extraction logic (wraps extractKnowledge)
- `src/tools/ingest_pr.js` — MCP tool handler (connects to authority model)
- `.github/workflows/quorum-pr-ingest.yml` — GitHub Action trigger
- `dashboard/src/` — review dry_run extraction results UI panel

---

### GAP-31 · Notification delivery not implemented `MEDIUM` 🎯 v0.3

**Friction:** The governance model requires humans to act on conflicts and DRAFT reviews.
Currently, the only notification mechanism is "check the dashboard". There is no push.
Conflicts can accumulate for days without anyone knowing.

**Resolution — pragmatic notification layer:**
- **Slack webhook** — `QUORUM_SLACK_WEBHOOK_URL` env var; when set, posts a message on:
  - New conflict detected (with brief + link to dashboard)
  - DRAFT pending review > 24h
  - `PENDING_CONFLICT_CHECK` entries accumulating (> 5)
- **Email** (optional) — `QUORUM_ALERT_EMAIL` + SMTP vars; daily digest of pending actions
- **GitHub issue** (optional) — create issue in the project repo for each conflict, labelled
  `quorum:conflict`, with decision brief in the body; closes when resolved
- **Webhook generic** — `QUORUM_NOTIFY_WEBHOOK_URL` for custom integrations (Teams, PagerDuty)

**Files to add:**
- `src/notify/slack.js` — Slack webhook delivery
- `src/notify/index.js` — notification router (checks which channels are configured)
- Wired into `remember.js` (conflict detected), `review.js` (approved/rejected),
  `src/tools/pending.js` (stale pending check)
- `.env.example` — notification vars documented

---

## Act 4 — Operational Maturity

### GAP-32 · Graphiti version not pinned `MEDIUM` 🎯 v0.3

**Friction:** `Dockerfile.graphiti` builds from `getzep/graphiti` main branch via
sparse clone. This is fine for local dev but is a reliability risk for teams:
- Any breaking change in Graphiti main silently breaks the Quorum stack on the next `docker build`
- No rollback path — you can't `docker pull` a pinned Graphiti image because Graphiti
  has no published Docker image on Docker Hub
- `docker compose build --no-cache` after a Graphiti breaking change is a frustrating mystery

**Resolution:**
1. **Pin to a git SHA or tag** in `Dockerfile.graphiti`: `ARG GRAPHITI_REF=v0.3.x`
   with `git clone --branch $GRAPHITI_REF` (sparse clone to `mcp_server/` only)
2. **Makefile / Renovate bot rule** — add a Dependabot `pip` entry for the graphiti package
   so upgrades are deliberate, not accidental
3. **Integration smoke test** — `npm run test:graphiti-integration` hits the Graphiti
   healthcheck and attempts a test `add_episode` + `search_nodes` round trip
4. **Publish a `quorum-graphiti` Docker image** — build Graphiti with a specific SHA,
   push to GitHub Container Registry; compose uses `ghcr.io/quorum/graphiti:sha-abc123`

**Files to modify:**
- `Dockerfile.graphiti` — parameterise the git ref
- `.github/workflows/build.yml` — publish graphiti image to GHCR
- `docker-compose.yml` — pin to GHCR image in non-dev environments
- `.github/dependabot.yml` — Dockerfile SHA bump rule

---

### GAP-33 · `group_id` isolation not enforced at the graph layer `LOW` 🎯 v0.3

**Friction:** The gateway enforces `project_id` on PostgreSQL queries (GAP-10). But
Graphiti's `group_id` isolation relies on the caller providing the right value — there
is no server-side enforcement. A misconfigured `QUORUM_GROUP_ID` could read across
project boundaries.

**Resolution:**
1. **Gateway validates group_id claim** — the JWT payload includes `group_id` from the
   project config; the Graphiti proxy route (`src/gateway/routes/graphiti.js`) overwrites
   `group_ids` in the request body with the JWT-derived value — caller cannot specify their own
2. **Add integration test** — verify that a request with a tampered `group_ids` value is
   rejected or silently rewritten to the JWT-bound value
3. **Document the isolation model** — DEPLOYMENT.md section "Multi-team isolation guarantees"

**Files to modify:**
- `src/gateway/routes/graphiti.js` — overwrite `group_ids` from JWT claim
- `tests/governance/isolation.test.js` — new test file

---

### GAP-34 · No LLM accuracy regression suite for prompts `LOW` 🎯 v0.3

**Friction:** Three LLM prompts now live in `src/prompts/` and are easy to edit.
This is good for maintenance. But there are no tests that catch regressions when prompts
are changed. A well-meaning edit to `check-contradiction.md` could silently drop the
true-positive rate.

**Resolution:**
1. **Golden dataset** — `tests/llm/conflict-golden-dataset.js` already exists (from
   CLAUDE.md); extend it to 50+ cases with labelled expected outcomes
2. **Prompt regression test** — `tests/llm/prompt-regression.test.js` — runs golden
   dataset against the three prompts, asserts TP rate > 90% and FP rate < 15%
3. **CI accuracy gate** — `npm run test:llm` in GitHub Actions on any change to
   `src/prompts/**` (path filter to avoid running on every PR)
4. **Model upgrade guard** — store the model name in the golden dataset; if `LLM_MODEL_NAME`
   changes, rerun the suite and flag if accuracy drops > 2%

**Files to add:**
- `tests/llm/prompt-regression.test.js`
- Extend `tests/llm/conflict-golden-dataset.js`
- `.github/workflows/test.yml` — add path-filtered LLM accuracy job

---

## Priority Order — v0.3 Work

```
P1 — Self-evolution observability (core value prop visibility)
  🎯 GAP-26  reflect() dashboard panel + SKILL.md session-end summary

P1 — Resilience (reliability of governance critical path)
  🎯 GAP-29  LLM retry, reflect fallback, recheck automation, startup warn

P2 — Automated operations (knowledge health without manual effort)
  🎯 GAP-27  Confidence decay cron + dashboard health panel

P2 — Growth signal (highest value knowledge source)
  🎯 GAP-30  ingest_pr() MVP: GitHub fetch + extraction + dry run + GitHub Action

P3 — Notifications (close the "check the dashboard" loop)
  🎯 GAP-31  Slack webhook + stale pending alert

P3 — Zero-config adoption (OSS growth)
  🎯 GAP-24  npx quorum start

P4 — Security hardening
  🎯 GAP-28  Direct-mode MCP auth (API key)
  🎯 GAP-33  group_id isolation enforcement at gateway

P5 — Operational reliability
  🎯 GAP-32  Graphiti version pinning + GHCR image
  🎯 GAP-34  LLM prompt regression suite

DEFERRED — Evaluation only
  GAP-25  Lightweight stack (no Graphiti) — evaluate after usage data
```

---

## Adoption Friction Reassessment

| Dimension | Before this session | After this session | v0.3 target |
|-----------|---------------------|--------------------|-------------|
| First install | 2/5 | 3/5 (install script, healthcheck fix) | 4/5 (npx) |
| First run | 2/5 | 3/5 (QUICKSTART, persistence warn) | 4/5 (lite stack) |
| Understanding the value | 2/5 | 4/5 (dashboard, visual conflict review) | 4/5 |
| Daily use for engineers | 3/5 | 3/5 | 4/5 (reflect observability, notifications) |
| Operational maturity | 2/5 | 2/5 | 3/5 (decay cron, Graphiti pin) |
| **Overall** | **2/5** | **3/5** | **4/5** |

The gap from 3 to 4 is closed by: `reflect()` observability (engineers trust what they
cannot see only so long before they turn it off), Slack notifications (knowledge that
requires manual dashboard checking gets ignored), and `npx` entry point (OSS tools that
require cloning don't get evaluated). These are the three highest-leverage items for v0.3.

The gap from 4 to 5 is closed at v1.0 by: npx zero-config setup, hosted documentation,
and at least one public case study proving the value in production.
