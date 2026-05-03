# Quorum — Gap Analysis v0.3

> Written after the v0.2 + dashboard session (April 2026).
> Revised after critical analysis to strip over-engineering and replace dashboard-first
> solutions with the simplest change that closes the gap.
>
> **Last updated:** 2026-05-03 — monorepo restructure + gateway-only MCP session.
>
> **Status legend:** ✅ Resolved · ⏳ Pending · 🎯 v0.3 target · 🐛 Bug found
>
> **What changed since v0.2 gap analysis:**
> The dashboard session delivered more than governance logic — it meaningfully
> reduced first-run friction. Before claiming adoption friction is still 2/5,
> those improvements are credited first.

---

## Structural Patterns Avoided in This Plan

Three over-engineering patterns appear repeatedly in gap analyses for tools at this stage.
This plan explicitly avoids them:

1. **Dashboard-first reflex.** A dashboard panel is real work. Most observability problems
   are solved by surfacing data in existing flows — SKILL.md output, server logs, startup
   messages — before building new UI.

2. **Infrastructure for infrastructure.** Cron sidecars, GHCR-published images, GitHub Actions
   for features not yet validated manually — these are maintenance obligations, not features.
   They come after the core behaviour is proven, not before.

3. **Conflating detection with resolution.** Several gaps are two problems: knowing it is
   broken, and fixing it. This plan solves detection first. Remediation follows once you
   can see the problem.

---

## What v0.2 + this session already fixed

| What improved | Impact on friction |
|---------------|--------------------|
| **Dashboard** (React, conflict review UI, knowledge browse) | Engineers can manage knowledge without CLI — visual entry point lowers the "what does this do?" question |
| **`npm run quorum:install`** — one command for MCP + skill | Eliminates the two-step copy-paste install that tripped most people up |
| **Monorepo restructure** — `mcp/`, `gateway/`, `dashboard/` with per-package `package.json` | `@as-quorum/mcp` ready for npm publish; gateway and dashboard clearly separated |
| **`pg` removed from `@as-quorum/mcp`** — always gateway HTTP | MCP has no DB dependency; engineers never need PostgreSQL credentials |
| **npm org `as-quorum`** + `bin.quorum` field in `mcp/package.json` | Foundation for `npx quorum` entry point (GAP-24 unblocked) |
| **OpenAPI 3.1 spec** at `gateway/openapi.yaml` | All ~40 gateway routes documented; SDK generation possible |
| **Per-package CLAUDE.md** — `mcp/`, `gateway/`, `dashboard/` | Future Claude Code sessions in any package have immediate context |
| **`npm run docker:rebuild/clean/ps`** | Common ops no longer require reading the setup.sh source |
| **LocalStack persistence detection** in `setup.sh` | Silent data loss on container restart now warned at startup |
| **Gateway healthcheck fix** (200 or 503) | Stack no longer deadlocks when external LocalStack is in use — was a P0 show-stopper |
| **LLM prompt extraction** to markdown files | Prompts are editable without touching code |
| **QUICKSTART.md** + lean CLAUDE.md | Gets an engineer to a running system without reading the full architecture docs |
| **`ONBOARDING.md`** with gateway setup guide | Central stack deployment is documented step-by-step |
| **In-memory OAuth token injection** (`authenticate()` MCP tool) | Re-auth handled by Claude Code via mcp-playwright — no shell file writes, no engineer interruption |

**Revised adoption friction rating: 3/5** (up from 2/5)

What holds it at 3/5 rather than 4/5:
- Stack still requires 6 Docker containers (Graphiti is not optional today)
- `reflect()` output is never surfaced to the engineer — the self-evolution loop is invisible
- Confidence decay is designed but runs manually — knowledge staleness accumulates silently
- No npx zero-config entry (still requires git clone + npm install)
- LLM is a hard dependency in the governance critical path — no retry, no fallback

---

## Act 1 — Discovery and First Impression

### GAP-24 · No npx zero-config entry point `HIGH` 🎯 v0.3

**Friction:** "How do I try this?" currently requires cloning the repo. For OSS tools
the bar is `npx quorum start`.

**What the original plan got wrong:** `npx quorum start` still requires Docker. Solving the
entry point without solving the stack size (GAP-25) moves the error one step later — the
command crashes with "Docker not found" or times out pulling 6 images. GAP-25 must ship first.

**Progress (2026-05-03):**
- ✅ `"bin": { "quorum": "./dist/cli.js" }` is set in `mcp/package.json`
- ✅ npm org `as-quorum` created; package ready to publish
- ✅ `npx quorum init` is implemented in `cli.js`
- ⏳ `npx quorum start` → docker compose is NOT yet implemented
- 🐛 `cli.js` still imports `pg` directly — uses a raw `pg.Pool` for `history`, `audit verify`,
  `audit export`, `audit stats` commands. These must be ported to gateway HTTP calls before
  publishing (no pg dep in the published package). See **GAP-35** below.

**Remaining resolution:**
1. Port `cli.js` audit/history commands to use `GatewayClient` HTTP (GAP-35 below)
2. Add `npx quorum start` command: `spawn('docker', ['compose', '-f', bundledLiteCompose, 'up', '-d'])`
3. Bundle `docker-compose.lite.yml` in the npm package (GAP-25 must exist first)
4. Add `.npmignore` / `"files"` in `package.json` to exclude `src/`, tests, docs from the tarball

**Blocked on:** GAP-25 (lite compose), GAP-35 (cli.js pg removal).

---

### GAP-25 · No lightweight "try it now" stack `MEDIUM` 🎯 v0.3

**Friction:** 6 Docker containers is a significant ask for a solo engineer evaluating the tool.
Graphiti alone pulls in a Python ML environment.

**What the original plan got wrong:** A `src/graph/mock-client.js` that mirrors the Graphiti API
over SQLite is a second graph implementation to maintain forever. Every new Graphiti method
needs a mock equivalent. The mock drifts silently from production behaviour.

**Resolution — graceful degradation, not a second code path:**
1. In `src/graph/client.js`, if `pingGraphiti()` at startup returns false, set a module-level
   `graphitiAvailable = false` flag
2. All graph call functions check the flag; if false, return `{ results: [], degraded: true }`
   immediately — no mock, no SQLite, just a short-circuit
3. Add `docker-compose.lite.yml` — the existing compose file with the `graphiti` and `falkordb`
   services removed
4. Add `QUICKSTART.md` section: "Try without the full stack"

Engineers get a working audit store and key-value `recall()` without semantic search.
Conflict detection degrades gracefully (no semantic similarity, LLM-only path or skip).

**Files to add/modify:**
- `src/graph/client.js` — `graphitiAvailable` flag, short-circuit in graph functions
- `docker-compose.lite.yml` — stripped compose
- `QUICKSTART.md` — lite-stack section

---

## Act 2 — First Run and Stack Setup

### GAP-26 · `reflect()` has no observability `HIGH` ✅ Done

**Friction:** The self-evolution loop is the core value proposition. Engineers cannot tell
whether `reflect()` extracted anything. The skill calls it post-task but the result is swallowed.

**Resolution applied:**
`mcp/skill/SKILL.md` under "After Task" now says:

> After `reflect()` returns: Tell the human: "I've submitted N knowledge entries to Quorum
> for your review at http://localhost:3002/pending."
> Handle conflict and deferred-check cases inline.

The zero-extract case ("reflect() found no new knowledge") is implied by N=0 but could be
made explicit if engineers report confusion. Treat as closed for v0.3.

A dashboard "Reflect Activity" timeline is a v1.0 analytics feature.

---

### GAP-27 · Confidence decay not automated `HIGH` 🎯 v0.3

**Friction:** The `job:decay` npm script exists but must be run manually. Knowledge staleness
accumulates silently.

**What the original plan got wrong:** A Docker Compose cron sidecar is a new container with
its own lifecycle, logs, and failure modes. A K8s CronJob manifest is fine for production
but premature for v0.3. Neither is needed — the gateway process is already always running.

**Resolution — `setInterval` in the gateway server:**
1. On gateway startup, read `last_decay_run` timestamp from a config row in PostgreSQL
2. If `now - last_decay_run > 7 days`, run `decayConfidence()` immediately and update the timestamp
3. Set a `setInterval` for 24h to re-check; fire decay if the 7-day window has elapsed
4. Log the result: `[Quorum] Decay run: N nodes updated, M archived`

No new container, no new service, no Helm manifest. It runs as long as the gateway runs.

For status visibility: expose `GET /admin/decay/status` — returns last run time, nodes decayed,
confidence distribution. No dashboard panel needed; engineers can curl it or check the logs.

**Files to modify:**
- `src/gateway/server.js` — add decay scheduler on startup
- `src/gateway/routes/admin.js` — `GET /admin/decay/status` endpoint
- `scripts/decay-confidence.js` — add `--report` flag (reusable by both the scheduler and CLI)

---

### GAP-28 · Component communication security model `MEDIUM` ✅ Code secured · ⏳ Docs pending

**Status (2026-05-03 update):**

**Direct mode no longer exists in `@as-quorum/mcp`.** It was removed in the 2026-05-03
session. `QUORUM_GATEWAY_URL` now defaults to `http://localhost:3001` — there is no
pg.Pool in the MCP, no unauthenticated Graphiti leg from the MCP side. The "direct mode
trust model" table below is historical only.

**Current communication map (gateway-only MCP):**

| Leg | Protocol | Auth |
|-----|----------|------|
| Claude Code → MCP server | stdio (process spawn) | Process-scoped — only the spawning process can communicate |
| MCP server → Gateway | HTTP | ES256 JWT (`authenticate()` tool: GitHub OAuth token → JWT at `POST /auth/token`) |
| Gateway → PostgreSQL | TCP | Database credentials (user/password) |
| Gateway → Graphiti | HTTP (Docker internal network) | JWT-gated proxy — `verifyJwt` on every request; `group_id` injected server-side |
| Gateway → S3/LocalStack | HTTPS | AWS credentials |
| Browser → Gateway | HTTPS | ES256 JWT (GitHub OAuth flow) |

Every leg is authenticated. The `authenticate()` MCP tool handles MCP → Gateway auth without
manual token management.

**Remaining work:** Add a "Component Security Model" section to `docs/DEPLOYMENT.md` covering
the table above. (~15 min, no code change.)

> **Note on GAP-33:** The Graphiti route currently uses `if (!body.params.group_id)` —
> conditional injection. A caller who sets `group_id` in the request body bypasses isolation.
> See GAP-33 for the fix.

**Files to modify:**
- `docs/DEPLOYMENT.md` — component security model section (still pending)

---

## Act 3 — Daily Use

### GAP-29 · LLM is a hard dependency in the governance critical path `HIGH` 🎯 v0.3

**Friction:** `detectConflict()` calls OpenAI with no retry. A transient 500 permanently marks
the entry as `PENDING_CONFLICT_CHECK`. `reflect()` returns `[]` silently when no API key —
the engineer never knows extraction did nothing.

**What the original plan got wrong:** Five fixes bundled together guarantee none ship cleanly.
The dashboard badge and recheck automation are the same infrastructure problem as GAP-27.
Split into two atomic changes:

**Resolution — two independent changes:**

**Change 1: Retry wrapper** (`src/governance/conflict.js`)
Wrap `callLLM()` with 3-attempt exponential backoff (200ms, 400ms, 800ms) before giving up.
~15 lines. Covers all three LLM call sites (contradiction, enrichment, extraction).

**Change 2: reflect() fallback** (`src/tools/reflect.js`)
When `extractKnowledge()` returns `[]` due to missing API key or LLM error, store the raw
task summary as a single DRAFT item:
```js
{ confidence: 0.35, entity_type: 'observation', content: taskSummary, tags: ['unextracted'] }
```
Something is captured even without LLM extraction. The `unextracted` tag makes it easy to
find and re-process later.

**Change 3: Startup env check** (`src/server.js`, 1 line)
```js
if (!process.env.OPENAI_API_KEY) console.error('[Quorum] WARNING: OPENAI_API_KEY not set — LLM features disabled')
```

The `PENDING_CONFLICT_CHECK` dashboard badge and `recheck-conflicts` cron automation follow
from GAP-27's scheduler once that exists.

**Files to modify:**
- `src/governance/conflict.js` — retry wrapper
- `src/tools/reflect.js` — fallback extraction path
- `src/server.js` — startup env check (1 line)

---

### GAP-30 · `ingest_pr()` not implemented `MEDIUM` 🎯 v0.3

**Friction:** PRs contain explicit decisions, review-validated patterns, and approver authority
signals — the highest-value, lowest-effort knowledge source. The tool is a stub.

**What the original plan got wrong:** The GitHub Action inverts the dependency. Automate only
after manual use proves the extraction quality. Running extraction on every merged PR before
you trust the output floods the graph with noise.

**Resolution — MCP tool only, dry_run default:**
1. `src/pr/github.js` — fetch PR description, review comments, approvals via GitHub REST API
   (no OAuth for public repos; `GITHUB_TOKEN` env var for private)
2. `src/pr/extractor.js` — call `extractKnowledge()` on description + review comment concat;
   if a principal architect approved, elevate extracted `confidence` by +0.10
3. `src/tools/ingest_pr.js` — MCP tool: `ingest_pr({ pr_url, dry_run: true })`
   - `dry_run: true` (default) returns would-be DRAFTs for review without storing anything
   - `dry_run: false` stores them via `remember()`

Engineers call it via Claude: "Ingest the knowledge from this PR: https://github.com/..."
The GitHub Action comes after extraction quality is validated manually.

**Files to add:**
- `src/pr/github.js`
- `src/pr/extractor.js`
- `src/tools/ingest_pr.js`

---

## Act 4 — Operational Maturity

### GAP-32 · Graphiti version not pinned `MEDIUM` 🎯 v0.3

**Friction:** `Dockerfile.graphiti` builds from Graphiti main. Any breaking change silently
breaks the stack on the next `docker build`. No rollback path.

**What the original plan got wrong:** Publishing a `quorum-graphiti` GHCR image with its own
CI workflow means owning Graphiti's build pipeline. When Graphiti ships a fix, you must
rebuild and push before Quorum users can get it. That is a maintenance obligation that
outweighs the reliability benefit it provides.

**Resolution:**
1. Pin to a specific git SHA in `Dockerfile.graphiti`:
   ```dockerfile
   ARG GRAPHITI_REF=<sha>
   # To upgrade: update GRAPHITI_REF to the desired commit SHA and rebuild.
   ```
2. Add a `.github/dependabot.yml` Dockerfile entry so SHA bumps are proposed as PRs,
   not discovered by breakage

No GHCR image publishing. No separate CI workflow.

**Files to modify:**
- `Dockerfile.graphiti` — parameterise the git ref, add upgrade comment
- `.github/dependabot.yml` — Dockerfile SHA bump rule

---

### GAP-33 · `group_id` isolation not enforced at the graph layer `MEDIUM` 🐛 Bug found · 🎯 v0.3

**Friction:** Graphiti's `group_id` isolation relies on the caller providing the right value.
A misconfigured or malicious request could read across project boundaries.

**Current state (2026-05-03 audit):**

`gateway/src/routes/graphiti.js` injects `group_id` but with a conditional guard:

```js
// BUG: conditional — caller can bypass by supplying their own group_id
if (!body.params.group_id) {
  body.params.group_id = req.user.project
}
```

This is a **confused deputy vulnerability**: the gateway is trusted by Graphiti, but a
caller who includes `"group_id": "other-team"` in their request body will have it pass through
unchanged. The gateway must always overwrite, never trust caller input for isolation fields.

**Additional issue:** The field injected is `group_id` (singular). Graphiti's API uses
`group_ids` (plural, array). Verify which the Graphiti MCP actually expects and align.

**Resolution:**
1. `gateway/src/routes/graphiti.js` — change conditional to unconditional overwrite:
   ```js
   // Always overwrite — never trust caller-supplied group scoping
   body.params.group_id = req.user.project
   ```
   If Graphiti expects `group_ids` (array), also set that:
   ```js
   body.params.group_ids = [req.user.project]
   ```
2. Add one test: send a Graphiti request with a tampered `group_id` in the body, assert
   the gateway overwrote it with the JWT-bound value before forwarding
3. Add isolation guarantee paragraph to `docs/DEPLOYMENT.md`

**Files to modify:**
- `gateway/src/routes/graphiti.js` — unconditional overwrite (2-line fix, critical)
- `tests/governance/isolation.test.js` — new test
- `docs/DEPLOYMENT.md` — isolation guarantee documentation

---

### GAP-34 · No LLM accuracy regression suite for prompts `LOW`

**Friction:** Three LLM prompts live in `src/prompts/` and are editable. No tests catch
regressions when prompts change.

**What the original plan got wrong:** You cannot build a TP/FP accuracy gate around a golden
dataset that does not exist yet. Running 50+ cases against the live OpenAI API in CI is
expensive and flaky. The accuracy regression is a v1.0 concern.

**Resolution — snapshot tests on prompt rendering, not LLM output:**
1. Unit-test that `buildConflictPrompt(node1, node2)` produces the expected string —
   pure function, no API calls
2. Unit-test that the LLM response parser handles all output shapes Graphiti returns
   (object, array, null, malformed JSON)
3. Add 5–10 labelled fixture cases as a manual validation script (`scripts/validate-prompts.js`)
   run by humans before a model upgrade — not in CI

A proper TP/FP accuracy gate with 50+ golden cases is added at v1.0 once real usage data
exists to build the dataset from.

**Files to add/modify:**
- `tests/governance/prompt-rendering.test.js` — new unit tests
- `scripts/validate-prompts.js` — manual accuracy check (no CI gate)

---

---

## GAP-35 · `cli.js` still imports `pg` directly `HIGH` 🎯 v0.3

**Friction:** `mcp/cli.js` was not updated when `pg` was removed from `server.js`. It still
creates a raw `pg.Pool` for the `history`, `audit verify`, `audit export`, and `audit stats`
commands. This means:

1. `pg` is still an implicit runtime dependency of `@as-quorum/mcp` even though it was removed
   from `package.json` — these commands will throw `Cannot find package 'pg'` when run from
   the published npm package
2. Prevents publishing `@as-quorum/mcp` to npm without breaking the CLI commands
3. Blocks GAP-24 (`npx quorum start`) — the published package must have zero pg dependency

**Resolution:**
Port each `cli.js` command to use the gateway HTTP API instead of a direct pg.Pool:

| Command | Currently uses | Replace with |
|---------|----------------|--------------|
| `quorum history <topic:key>` | `historyHandler(pool, ...)` | `GET /pg/versions/{topic}/{key}/history` via GatewayClient |
| `quorum audit verify` | `getAllEntries(pool)` | `gw.getAllEntries({})` |
| `quorum audit export` | `getAllEntries(pool, opts)` | `gw.getAllEntries(opts)` |
| `quorum audit stats` | `pool.query(...)`, `countEntries(pool)` | `gw.countEntries()` + `gw.getAllEntries({})` |
| `quorum audit lineage` | `pool.query(...)` | gateway `/pg/audit` query |

The `GatewayClient` (`src/gateway/client.js`) already exposes all needed methods.
Use `getGatewayClient()` after setting `QUORUM_GATEWAY_URL` from env or `.quorum` file.

**Files to modify:**
- `mcp/cli.js` — remove `import pg from 'pg'`, remove `const pool = new pg.Pool(...)`,
  port each command to GatewayClient HTTP

---

## Priority Order — v0.3 Work

Ordered by value-to-effort ratio:

```
P0 — Already done (no work needed)
  ✅ GAP-26  reflect() result reported to engineer (SKILL.md, done)
  ✅ GAP-28  Security model code secured (direct mode removed from MCP)

P1 — Security fixes (high risk, low effort)
  🐛 GAP-33  Unconditional group_id overwrite in graphiti.js (2-line fix, CRITICAL)
  🎯 GAP-33  Isolation test + DEPLOYMENT.md paragraph

P2 — Unblock npm publish (must ship together)
  🎯 GAP-35  Port cli.js to GatewayClient HTTP (no pg in published package)
  🎯 GAP-24  npx quorum start command in cli.js (also needs GAP-25)
  ⏳ GAP-28  DEPLOYMENT.md security model section (15 min)

P3 — Core reliability
  🎯 GAP-29  LLM retry wrapper + reflect() fallback + startup env check
  🎯 GAP-32  Pin Graphiti SHA + Dependabot rule

P4 — Operational automation
  🎯 GAP-27  setInterval decay in gateway + /admin/decay/status endpoint

P5 — Stack simplification (enables full npx flow)
  🎯 GAP-25  Graphiti graceful degradation + docker-compose.lite.yml

P6 — New knowledge source
  🎯 GAP-30  ingest_pr() MCP tool, dry_run mode only

P7 — Test infrastructure
  🎯 GAP-34  Prompt rendering unit tests + manual validation script

DEFERRED — v1.0
  GAP-26 dashboard  Reflect Activity panel (after reflect() usage proven)
  GAP-27 K8s        Helm CronJob manifest (after decay is proven in gateway)
  GAP-29 badge      PENDING_CONFLICT_CHECK dashboard badge (after GAP-27 cron)
  GAP-30 action     GitHub Action for PR ingest (after extraction quality validated)
  GAP-31            Notifications — skipped per explicit decision
  GAP-34 gate       LLM accuracy CI gate (after golden dataset exists from real usage)
```

---

## Estimated v0.3 Effort

| Gap | Change | Effort | Status |
|-----|--------|--------|--------|
| GAP-26 | SKILL.md reflect() reporting | — | ✅ Done |
| GAP-28 | Direct mode removed from MCP | — | ✅ Done (code); docs still pending |
| GAP-33 | Unconditional group_id overwrite (2 lines) + isolation test | 2h | 🐛 Bug — fix first |
| GAP-35 | Port cli.js to GatewayClient HTTP | 4h | ⏳ New gap |
| GAP-28 | DEPLOYMENT.md security model section | 15 min | ⏳ Pending |
| GAP-29 | Retry wrapper + reflect fallback + startup warn | 4h | ⏳ Pending |
| GAP-32 | Pin Graphiti SHA + Dependabot | 1h | ⏳ Pending |
| GAP-24 | npx quorum start command | 2h | ⏳ Partially done (bin + org) |
| GAP-27 | setInterval decay + status endpoint | 3h | ⏳ Pending |
| GAP-25 | Graceful degradation flag + lite compose | 4h | ⏳ Pending |
| GAP-30 | ingest_pr() MCP tool, 3 files | 1d | ⏳ Pending |
| GAP-34 | Prompt rendering unit tests | 4h | ⏳ Pending |
| **Total remaining** | | **~4 days** | |

---

## Adoption Friction Reassessment

| Dimension | v0.2 | Post-dashboard session | Post-2026-05-03 session | v0.3 target |
|-----------|------|----------------------|------------------------|-------------|
| First install | 2/5 | 3/5 (install script, healthcheck fix) | 3/5 | 4/5 (npx after GAP-25, GAP-35) |
| First run | 2/5 | 3/5 (QUICKSTART, persistence warn) | 3/5 | 4/5 (lite stack) |
| Understanding the value | 2/5 | 4/5 (dashboard, visual conflict review) | 4/5 | 4/5 |
| Daily use for engineers | 3/5 | 3/5 | 3/5 | 4/5 (LLM resilience GAP-29) |
| Operational maturity | 2/5 | 2/5 | 2.5/5 (security hardened, no direct pg) | 3/5 (decay automation) |
| **Overall** | **2/5** | **3/5** | **3/5** | **4/5** |

The 2026-05-03 session hardened the architecture (no direct pg in MCP, gateway-only) and
unblocked the npm publish path. It did not move the adoption friction number because those
changes are invisible to engineers who are already running the stack — they matter for
publishing and enterprise trust, not first-run experience.

The gap from 3 to 4 is closed by: npx entry point (GAP-24 + GAP-25 + GAP-35), LLM retry
and fallback (GAP-29), and fixing the group_id isolation bug (GAP-33).

The gap from 4 to 5 is closed at v1.0 by: hosted documentation, at least one public case
study, and the analytics features (reflect dashboard, decay health panel) that prove the
self-evolution loop is working in production.
