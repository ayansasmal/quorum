# Quorum — Gap Analysis v0.3

> Written after the v0.2 + dashboard session (April 2026).
> Revised after critical analysis to strip over-engineering and replace dashboard-first
> solutions with the simplest change that closes the gap.
>
> **Status legend:** ✅ Resolved in this session · ⏳ Pending · 🎯 v0.3 target
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

**Resolution:**
1. Publish `quorum` to npm with `"bin": { "quorum": "./cli.js" }`
2. `cli.js` is a thin wrapper: `npx quorum start` → `docker compose -f <bundled-compose> up -d`
3. The bundled `docker-compose.yml` in the npm package is the lite compose (GAP-25) — not the
   full 6-container stack
4. `npx quorum init` creates a `.quorum` file in the current directory

Defer all guard logic (auto-`npm install`, Docker version checks) until the basic flow is validated.

**Scope:** `cli.js`, `package.json` publish config, `.npmignore`, README update.
Blocked on GAP-25.

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

### GAP-26 · `reflect()` has no observability `HIGH` 🎯 v0.3

**Friction:** The self-evolution loop is the core value proposition. Engineers cannot tell
whether `reflect()` extracted anything. The skill calls it post-task but the result is swallowed.

**What the original plan got wrong:** A "Reflect Activity" dashboard panel is the wrong fix
for a SKILL.md problem. `reflect()` already returns a structured result — Claude just doesn't
report it to the engineer. That is a skill instruction issue, not a UI gap.

**Resolution:**
Add one instruction to `skill/SKILL.md` under "After Task":

> After calling `reflect()`, always report the result to the engineer inline:
> "reflect() extracted N items — pending your review at http://localhost:3002/pending"
> or "reflect() found no new knowledge to store this session."

That is the complete fix for v0.3.

A dashboard "Reflect Activity" timeline (extraction rate, top topics, weekly digest) is a
v1.0 analytics feature. Do not build it before engineers are actually using `reflect()`.

**Files to modify:**
- `skill/SKILL.md` — one sentence under "After Task"

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

### GAP-28 · Component communication security model `MEDIUM` ✅ Already secured

**Status:** No gap in gateway mode. Direct mode has a documented, acceptable trust boundary.

**Full communication map:**

| Leg | Protocol | Auth |
|-----|----------|------|
| Claude Code → MCP server | stdio (process spawn) | Process-scoped — only the spawning process can communicate |
| MCP server → Gateway | HTTP | ES256 JWT (`authenticate()` tool: `gho_` OAuth token → JWT exchange at `POST /auth/token`) |
| Gateway → PostgreSQL | TCP | Database credentials (user/password) |
| Gateway → Graphiti | HTTP (Docker internal network) | JWT-gated proxy — `verifyJwt` middleware enforces JWT on every request; `group_id` claim injected server-side, caller cannot override |
| Gateway → S3/LocalStack | HTTPS | AWS credentials |
| Browser → Gateway | HTTPS | ES256 JWT (GitHub OAuth flow) |

Every leg in gateway mode is authenticated. The `authenticate()` MCP tool (shipped in v0.2)
completes the MCP → Gateway leg — Claude Code exchanges a GitHub OAuth token for a short-lived
ES256 JWT without any manual token management by the engineer.

**Direct mode (no `QUORUM_GATEWAY_URL`) trust model:**

| Leg | Auth |
|-----|------|
| Claude Code → MCP server | Process-scoped stdio |
| MCP server → PostgreSQL | Database credentials |
| MCP server → Graphiti | HTTP, no token — trust via Docker network isolation |

The MCP → Graphiti leg in direct mode has no token. This is acceptable: Graphiti is not
exposed on a host port by default in `docker-compose.yml` — it is only reachable within
the Docker network. The trust boundary is the Docker network, not a credential.

**Resolution:** Document the security model. No code change needed.

Add one section to `docs/DEPLOYMENT.md` covering the table above and noting:
- Gateway mode is the correct choice for any multi-engineer or shared environment
- Direct mode is single-engineer local only; Graphiti network isolation is the perimeter

**Files to modify:**
- `docs/DEPLOYMENT.md` — component security model section

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

### GAP-33 · `group_id` isolation not enforced at the graph layer `LOW` 🎯 v0.3

**Friction:** Graphiti's `group_id` isolation relies on the caller providing the right value.
A misconfigured `QUORUM_GROUP_ID` could read across project boundaries.

**What the original plan got wrong:** The gateway Graphiti route likely already overwrites
`group_ids` from the JWT. The actual gap is the missing test.

**Resolution:**
1. Verify `src/gateway/routes/graphiti.js` overwrites `group_ids` in the proxied request body
   with the JWT-derived value — add the two-line overwrite if absent
2. Add one integration test: send a Graphiti request with a tampered `group_ids` value,
   assert the gateway rewrote it to the JWT-bound value before forwarding
3. Add one paragraph to `docs/DEPLOYMENT.md`: "Multi-team isolation guarantees"

**Files to modify:**
- `src/gateway/routes/graphiti.js` — verify/add `group_ids` overwrite (2 lines if missing)
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

## Priority Order — v0.3 Work

Ordered by value-to-effort ratio:

```
P0 — Already resolved (no work needed)
  ✅ GAP-28  Document direct-mode security boundary (DEPLOYMENT.md)

P1 — Highest leverage, smallest change
  🎯 GAP-26  One sentence in SKILL.md — reflect() result always reported to engineer
  🎯 GAP-29  Retry wrapper (conflict.js) + reflect() fallback + startup env check

P2 — Core reliability
  🎯 GAP-33  group_id overwrite verification + isolation test
  🎯 GAP-32  Pin Graphiti SHA + Dependabot rule

P3 — Operational automation
  🎯 GAP-27  setInterval decay in gateway + /admin/decay/status endpoint

P4 — Stack simplification (enables npx entry point)
  🎯 GAP-25  Graphiti graceful degradation + docker-compose.lite.yml
  🎯 GAP-24  npx quorum start (blocked on GAP-25)

P5 — New knowledge source
  🎯 GAP-30  ingest_pr() MCP tool, dry_run mode only

P6 — Test infrastructure
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

| Gap | Change | Effort |
|-----|--------|--------|
| GAP-26 | One sentence in SKILL.md | 5 min |
| GAP-28 | Paragraph in DEPLOYMENT.md | 15 min |
| GAP-29 | Retry wrapper + reflect fallback + startup warn | 4h |
| GAP-33 | group_id overwrite verify + 1 test | 4h |
| GAP-32 | Pin Graphiti SHA + Dependabot | 1h |
| GAP-27 | setInterval decay + status endpoint | 3h |
| GAP-25 | Graceful degradation flag + lite compose | 4h |
| GAP-24 | npx cli.js wrapper | 3h |
| GAP-30 | ingest_pr() MCP tool, 3 files | 1d |
| GAP-34 | Prompt rendering unit tests | 4h |
| **Total** | | **~4 days** |

---

## Adoption Friction Reassessment

| Dimension | v0.2 | After this session | v0.3 target |
|-----------|------|-------------------|-------------|
| First install | 2/5 | 3/5 (install script, healthcheck fix) | 4/5 (npx after GAP-25) |
| First run | 2/5 | 3/5 (QUICKSTART, persistence warn) | 4/5 (lite stack) |
| Understanding the value | 2/5 | 4/5 (dashboard, visual conflict review) | 4/5 |
| Daily use for engineers | 3/5 | 3/5 | 4/5 (reflect observability, LLM resilience) |
| Operational maturity | 2/5 | 2/5 | 3/5 (decay automation, Graphiti pin) |
| **Overall** | **2/5** | **3/5** | **4/5** |

The gap from 3 to 4 is closed by three changes: `reflect()` result surfaced in SKILL.md
(engineers trust what they cannot see only so long before they turn it off), LLM retry and
fallback (governance reliability degrades gracefully instead of silently failing), and the
lite stack + npx entry point (OSS tools that require cloning don't get evaluated).

The gap from 4 to 5 is closed at v1.0 by: hosted documentation, at least one public case
study, and the analytics features (reflect dashboard, decay health panel) that prove the
self-evolution loop is working in production.
