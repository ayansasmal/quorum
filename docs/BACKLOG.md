# Quorum — Backlog

> This is the project board. One file. No Jira required.
>
> **Columns:** 🔴 Bug · 🟡 To Do · 🔵 In Progress · ✅ Done
> **Priority:** P1 (now) → P7 (later)

---

## Board

| ID | Title | Priority | Status | Notes |
|----|-------|----------|--------|-------|
| BL-01 | `group_id` isolation bypass in Graphiti proxy | P1 | ✅ Done | Conditional guard → unconditional overwrite. See detail below. |
| BL-02 | Remove `mcp/` from engram + ops audit CLI | P2 | ✅ Done | `mcp/` deleted; `@as-quorum/mcp` from `file:../../quorum-mcp`; `scripts/audit-cli.js` created; tests migrated to quorum-mcp. |
| BL-02a | `GET /pg/audit/lineage/:topic/:key` gateway endpoint | P3 | ✅ Done | Added before `/audit/:id` in `gateway/src/routes/pg.js`. Used by `audit-cli lineage`. |
| BL-03 | `npx quorum start` command | P2 | 🟡 To Do | Blocked on BL-02 + BL-07. `bin` field + npm org already done. |
| BL-04 | LLM retry + `reflect()` fallback | P3 | 🟡 To Do | Retry wrapper on gateway governance HTTP calls + `reflect()` fallback when extraction returns []. Startup env check dropped — MCP has no OPENAI_API_KEY dep. |
| BL-05 | Pin Graphiti git SHA in Dockerfile | P3 | 🟡 To Do | Add `ARG GRAPHITI_REF` + Dependabot rule. |
| BL-06 | Confidence decay automation in gateway | P4 | 🟡 To Do | `setInterval` in gateway process + `GET /admin/decay/status`. |
| BL-07 | Graphiti graceful degradation + lite compose | P5 | 🟡 To Do | lite compose = engram (this repo); `graphitiAvailable` flag = quorum-mcp. Unblocks BL-03. |
| BL-08 | `ingest_pr()` MCP tool | P6 | 🟡 To Do | `dry_run: true` default. GitHub Action deferred to v1.0. |
| BL-09 | Prompt rendering unit tests | P7 | 🟡 To Do | Pure function tests + manual validation script. No LLM calls in CI. |
| BL-10 | `DEPLOYMENT.md` — component security model | Docs | 🟡 To Do | ~15 min. Direct mode is gone; document current single-path architecture. |
| BL-11 | Gateway LLM governance endpoints | P1 | 🟡 To Do | `POST /governance/detect-conflict · /governance/enrich · /governance/extract`. ⚠️ MCP already routes governance calls here (9066c8f) — endpoints missing = silent degradation today. |
| BL-12 | OAuth 2.1 Authorization Server in gateway | P2 | ✅ Done | RFC8414 discovery, RFC7591 dynamic client reg, PKCE S256, GitHub IdP, ES256 JWT; wired in `server.js`. quorum-mcp BL-10 client also ✅ Done (f37f560) — full OAuth round-trip live. |
| BL-13 | SDLC Hooks + Skill Integration | P2 | 🔵 In Progress | 5 hook scripts + `hooks.js` + SKILL.md update. Branch: quorum-mcp `feat-sdlc-hooks`. Blocked on BL-11. Spec + plan in `docs/superpowers/`. |

---

## Detail

### 🔴 BL-01 — `group_id` isolation bypass in Graphiti proxy
**File:** `gateway/src/routes/graphiti.js`

The proxy currently uses a conditional check:
```js
// current — BUG: caller can bypass by setting group_id themselves
if (!body.params.group_id) {
  body.params.group_id = req.user.project
}
```
This is a **confused-deputy vulnerability** — the gateway is trusted by Graphiti, so a caller
who includes `"group_id": "other-team"` in their JSON body will have it pass through unchanged,
reading another project's graph data.

**Fix (2 lines):**
```js
// always overwrite — never trust caller input for security-critical fields
body.params.group_id = req.user.project
```
Also check whether Graphiti expects `group_ids` (array) or `group_id` (string) and align.

**Acceptance criteria:**
- [ ] `group_id` always overwritten regardless of caller-supplied value
- [ ] `group_ids` field alignment verified against Graphiti API
- [ ] Test: tampered `group_id` in request body → gateway overwrites with JWT-bound value
- [ ] `docs/DEPLOYMENT.md` — "Multi-team isolation guarantees" paragraph

---

### ✅ BL-02 — Remove `mcp/` from engram + ops audit CLI
**Files:** `mcp/` (deleted) · `scripts/audit-cli.js` (new) · `gateway/package.json` · `package.json` (root)

`mcp/` was migrated to the standalone `quorum-mcp` repo. Gateway now imports `@as-quorum/mcp`
via `file:../../quorum-mcp`. Tests migrated to `quorum-mcp/tests/`. Ops audit CLI created at
`scripts/audit-cli.js` — pure HTTP, no pg dependency.

| Command | Currently | Replace with |
|---------|-----------|--------------|
| `quorum history <topic:key>` | `historyHandler(pool, ...)` | `gw.getVersionHistory(topic, key)` |
| `quorum audit verify` | `getAllEntries(pool)` | `gw.getAllEntries({})` |
| `quorum audit export` | `getAllEntries(pool, opts)` | `gw.getAllEntries(opts)` |
| `quorum audit stats` | `pool.query(...)`, `countEntries(pool)` | `gw.countEntries()` |
| `quorum audit lineage` | `pool.query(...)` | `gw.getAllEntries({})` + local filter |

Use `getGatewayClient()` after loading `.quorum` file defaults at CLI startup.

**Acceptance criteria:**
- [ ] `import pg from 'pg'` removed from `cli.js`
- [ ] All commands work via gateway HTTP
- [ ] `grep -r "from 'pg'" mcp/` returns no output

---

### 🟡 BL-03 — `npx quorum start` command
**File:** `mcp/cli.js`

Foundation already done: `bin.quorum = ./dist/cli.js` in `mcp/package.json`, npm org `as-quorum` created, `quorum init` works.

Missing: the `start` subcommand that launches the lite Docker stack.

```js
program
  .command('start')
  .description('Start the Quorum local stack (lite mode — no Graphiti)')
  .action(() => {
    // spawn docker compose -f <bundled lite compose> up -d
  })
```

**Blocked on:** BL-02 (no pg in published package) · BL-07 (lite compose must exist first)

**Acceptance criteria:**
- [ ] `npx quorum start` pulls and starts the lite stack
- [ ] `npx quorum stop` brings it down
- [ ] `docker-compose.lite.yml` bundled in npm package via `"files"` in package.json
- [ ] README updated with one-liner install

---

### 🟡 BL-04 — LLM retry + `reflect()` fallback
**Files:** `src/governance/conflict.js` · `src/tools/reflect.js`

> **Scope updated 2026-05-07:** `OPENAI_API_KEY` was removed from quorum-mcp (9066c8f).
> All LLM calls now route through gateway HTTP. Startup env check no longer applies.

Two independent changes, one commit:

**1. Retry wrapper** (`conflict.js`)
Wrap `gw._post('/governance/detect-conflict')` (and `/governance/enrich`, `/governance/extract`)
with 3-attempt exponential backoff (200ms → 400ms → 800ms). Covers all three governance call sites.
Requires BL-11 gateway endpoints to be live for retries to have effect.

**2. `reflect()` fallback** (`reflect.js`)
When `extractKnowledge()` returns `[]` (gateway unavailable or extraction error), store the raw
task summary as a single DRAFT observation:
```js
{ confidence: 0.35, entity_type: 'observation', content: taskSummary, tags: ['unextracted'] }
```
The `unextracted` tag makes it easy to find and re-process later.

**Acceptance criteria:**
- [ ] Transient gateway errors on governance endpoints retried up to 3 times with backoff
- [ ] `reflect()` always stores something even when gateway extraction fails

---

### 🟡 BL-05 — Pin Graphiti git SHA in Dockerfile
**Files:** `Dockerfile.graphiti` · `.github/dependabot.yml`

```dockerfile
# In Dockerfile.graphiti — replace branch with pinned SHA
ARG GRAPHITI_REF=<commit-sha>
# To upgrade: find the desired commit at https://github.com/getzep/graphiti
# and update GRAPHITI_REF here.
```

Add `.github/dependabot.yml`:
```yaml
version: 2
updates:
  - package-ecosystem: docker
    directory: /
    schedule:
      interval: weekly
```

No GHCR image publishing — that's a maintenance obligation not worth taking on yet.

**Acceptance criteria:**
- [ ] `Dockerfile.graphiti` pins a specific Graphiti commit SHA
- [ ] Dependabot rule proposes SHA bump PRs
- [ ] Upgrade path documented in a comment

---

### 🟡 BL-06 — Confidence decay automation in gateway
**Files:** `gateway/src/server.js` · `gateway/src/routes/admin.js` · `scripts/decay-confidence.js`

`npm run job:decay` exists but must be run manually. No new container needed — the gateway is always running.

```js
// gateway/src/server.js — on startup
const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000  // check daily
async function maybeRunDecay() {
  const lastRun = await getLastDecayTimestamp()
  if (Date.now() - lastRun > 7 * 24 * 60 * 60 * 1000) {
    await runDecay()
    await setLastDecayTimestamp(Date.now())
  }
}
maybeRunDecay()
setInterval(maybeRunDecay, DECAY_INTERVAL_MS)
```

Expose `GET /admin/decay/status` → `{ last_run, nodes_decayed, confidence_distribution }`.

**Acceptance criteria:**
- [ ] Decay runs automatically if 7 days have elapsed since last run
- [ ] `GET /admin/decay/status` returns last run time and stats
- [ ] Decay run logged: `[Quorum] Decay run: N nodes updated`
- [ ] K8s CronJob manifest deferred to v1.0

---

### 🟡 BL-07 — Graphiti graceful degradation + lite compose
**Files:** `mcp/src/graph/client.js` · `docker-compose.lite.yml` · `docs/QUICKSTART.md`

6 Docker containers is too much for evaluation. No mock — just graceful degradation:

```js
// mcp/src/graph/client.js
let graphitiAvailable = false

export async function ping() {
  try {
    const res = await fetch(`${GRAPHITI_URL}/health`, { signal: AbortSignal.timeout(2000) })
    graphitiAvailable = res.ok
  } catch {
    graphitiAvailable = false
  }
  return graphitiAvailable
}

// All search/graph functions check the flag first
export async function searchNodes(query, groupId) {
  if (!graphitiAvailable) return { results: [], degraded: true }
  // ... existing code
}
```

`docker-compose.lite.yml` — copy of `docker-compose.yml` with `graphiti` and `falkordb`
services removed. Add "Try without the full stack" section to QUICKSTART.md.

**Acceptance criteria:**
- [ ] Server starts and tools work when Graphiti is unavailable
- [ ] `search()` returns `degraded: true` instead of throwing
- [ ] `docker-compose.lite.yml` spins up in under 30 seconds

---

### 🟡 BL-08 — `ingest_pr()` MCP tool
**Files (new):** `mcp/src/pr/github.js` · `mcp/src/pr/extractor.js` · `mcp/src/tools/ingest_pr.js`

```
ingest_pr({ pr_url: "https://github.com/org/repo/pull/123", dry_run: true })
```

- `dry_run: true` (default) — returns would-be DRAFTs for review, stores nothing
- `dry_run: false` — stores via `remember()` with `triggered_by: 'ingest_pr'`
- If a `principal_architect` approved the PR, elevate extracted confidence +0.10
- GitHub Action for automatic ingest deferred until extraction quality validated

**Acceptance criteria:**
- [ ] `dry_run: true` returns extracted items without storing
- [ ] `dry_run: false` stores via the normal `remember()` pipeline
- [ ] Principal architect approval elevates confidence
- [ ] Works with `GITHUB_TOKEN` env for private repos

---

### 🟡 BL-09 — Prompt rendering unit tests
**Files:** `tests/governance/prompt-rendering.test.js` · `scripts/validate-prompts.js`

Three LLM prompts live in `mcp/src/prompts/` and are editable. Tests cover the
deterministic parts (rendering, parsing) — not LLM output quality.

1. Unit-test: `buildConflictPrompt(node1, node2)` produces expected string
2. Unit-test: LLM response parser handles all shapes (object, array, null, malformed JSON)
3. `scripts/validate-prompts.js` — 5–10 labelled fixture cases, run manually before a model upgrade

Full TP/FP accuracy gate with golden dataset is a v1.0 concern.

**Acceptance criteria:**
- [ ] Prompt rendering functions have unit tests
- [ ] Parser handles malformed LLM output without throwing
- [ ] Manual validation script exists and is documented in CONTRIBUTING.md

---

### ✅ BL-12 — OAuth 2.1 Authorization Server in gateway
**Files (new/modified):** `gateway/src/routes/mcp-oauth.js` (new) · `gateway/src/server.js` · `gateway/openapi.yaml`

Implement the standard MCP OAuth 2.1 Authorization Server flow so `quorum-mcp` can authenticate with zero env vars. The gateway acts as both an OAuth client to GitHub and an OAuth server to the MCP client.

**Endpoints required:**

| Endpoint | Purpose |
|----------|---------|
| `GET /.well-known/oauth-authorization-server` | Metadata discovery (RFC8414) — MCP client discovers all endpoints automatically |
| `POST /oauth/register` | Dynamic client registration (RFC7591) — MCP client self-registers, no manual setup |
| `GET /oauth/authorize` | Starts PKCE flow, redirects to GitHub OAuth |
| `GET /oauth/callback` | GitHub redirects here; gateway exchanges GitHub code for GitHub token, issues Gateway-MCP token, redirects to MCP client callback with auth code |
| `POST /oauth/token` | MCP client exchanges auth code + PKCE verifier for Gateway-MCP Token |

**Gateway-MCP Token payload (ES256 JWT):**
```json
{
  "sub": "github_login",
  "mcp_client_id": "dynamic-client-id",
  "project": "group_id",
  "role": "senior_engineer",
  "team": "platform",
  "base_confidence": 0.75,
  "permissions": ["remember", "review", "forget"],
  "exp": 1234567890
}
```

**Flow (per MCP spec 2025-03-26 Third-Party Authorization):**
1. MCP calls gateway → gateway returns `HTTP 401`
2. MCP discovers metadata at `/.well-known/oauth-authorization-server`
3. MCP registers dynamically via `POST /oauth/register` → receives `client_id`
4. MCP opens browser to `GET /oauth/authorize` with PKCE `code_challenge`
5. Gateway redirects to GitHub OAuth
6. User authenticates with GitHub → GitHub redirects to `GET /oauth/callback`
7. Gateway exchanges GitHub code → GitHub token (stays in gateway, never sent to MCP)
8. Gateway enriches token with project config (role, team, permissions, confidence)
9. Gateway issues auth code → redirects to MCP client's local callback
10. MCP exchanges auth code + `code_verifier` via `POST /oauth/token`
11. Gateway returns Gateway-MCP Token — MCP stores in memory, uses for all calls

**Security properties:**
- PKCE required — prevents authorization code interception
- GitHub token never leaves the gateway
- `QUORUM_GITHUB_TOKEN` env var eliminated entirely
- Standard OAuth 2.1 — works with any compliant MCP client out of the box

**Acceptance criteria:**
- [ ] `GET /.well-known/oauth-authorization-server` returns valid RFC8414 metadata
- [ ] `POST /oauth/register` supports dynamic client registration
- [ ] PKCE (`S256`) required and enforced on token exchange
- [ ] GitHub token never returned to MCP client
- [ ] Gateway-MCP token contains user + project + role + permissions
- [ ] Existing `/auth/token` (GitHub PAT exchange) kept for backwards-compat CLI use
- [ ] All endpoints documented in `gateway/openapi.yaml`

---

### 🔵 BL-13 — SDLC Hooks + Skill Integration
**Repos:** quorum-mcp (primary) · engram (`.gitignore` only)
**Branch:** quorum-mcp `feat-sdlc-hooks`
**Spec:** `docs/superpowers/specs/2026-05-06-quorum-sdlc-integration-design.md`
**Plan:** `docs/superpowers/plans/2026-05-06-quorum-sdlc-integration.md`

Wire 5 Claude Code hook scripts + extend `quorum install` so installing the MCP
automatically enforces Quorum knowledge capture and validation across the full engineering SDLC.
No per-project manual configuration — hooks are silent in projects without a `.quorum` file.

**SDLC coverage:**

| SDLC Moment | Hook | Signal |
|-------------|------|--------|
| Session start (once/day) | `UserPromptSubmit` | `[QUORUM: session_start_required]` |
| Before implementation write | SKILL.md pull-protocol | Discipline-enforced via `using-superpowers` |
| Task completion | `PostToolUse: TodoWrite` | `[QUORUM: task-completed]` |
| Memory/CLAUDE.md written | `PostToolUse: Write/Edit` | `[QUORUM: knowledge-source-updated]` |
| Before git commit | `PreToolUse: Bash(git commit*)` | `[QUORUM: pre-commit]` + staged files |
| Session end | `Stop` | `[QUORUM: N file(s) changed — reflect()?]` |

**Files (all in quorum-mcp):**
- `hooks/quorum-session-start.sh` · `quorum-stop.sh` · `quorum-pre-commit.sh` · `quorum-task-complete.sh` · `quorum-knowledge-source.sh`
- `src/install/hooks.js` — safe `settings.json` merge (idempotent, `id`-keyed dedup)
- `tests/install/hooks.test.js` — 4 unit tests for merge logic
- `cli.js` — extend `install` with `--skip-hooks` option
- `skill/SKILL.md` — ALWAYS invoke frontmatter + hook signal table + pull-protocol rule

**Files (engram):**
- `.gitignore` — add `.quorum-session`, `.quorum-reflected`, `.quorum-offline.log`

**Blocked on:** BL-11 (gateway LLM endpoints must exist for session-start governance calls to function end-to-end)

**Acceptance criteria:**
- [ ] `npx @as-quorum/mcp install` installs skill + 5 hooks + wires `settings.json` atomically
- [ ] Re-install is idempotent — no duplicate hook entries (verified by `hooks.test.js`)
- [ ] All hooks are silent in projects without a `.quorum` file
- [ ] Session-start fires once per calendar day (date dedup via `.quorum-session`)
- [ ] Stop hook fires only when ≥3 files changed and `.quorum-reflected` absent
- [ ] Pre-commit fires only when the bash command contains `git commit`
- [ ] SKILL.md: `ALWAYS invoke` in frontmatter, hook signal table present, pull-protocol present
- [ ] `.quorum-session` and `.quorum-reflected` in `.gitignore`
- [ ] Verify `CLAUDE_TOOL_INPUT` / `CLAUDE_TOOL_OUTPUT` env var names against Claude Code docs before shipping

---

### 🟡 BL-11 — Gateway LLM governance endpoints
**Files (new):** `gateway/src/routes/governance.js` · `gateway/src/server.js`

Three endpoints that move LLM calls out of `quorum-mcp` and into the gateway.
The MCP already calls these endpoints and degrades gracefully when they return 404.

| Endpoint | Input | Output |
|----------|-------|--------|
| `POST /governance/detect-conflict` | `{ existing, incoming }` | `{ contradicts, reason, possible_split, split_suggestion? }` |
| `POST /governance/enrich` | `{ existing, incoming, conflict_reason, possible_split, split_suggestion? }` | `{ analysis, risks_if_approved[], questions_for_reviewer[], existing_rationale?, possible_split, split_suggestion? }` |
| `POST /governance/extract` | `{ task_summary, decisions_made?, patterns_used? }` | `{ items: ExtractedItem[] }` |

The LLM prompt templates live in `quorum-mcp/src/prompts/` — either copy them into the gateway
or expose a `GET /governance/prompts/:name` endpoint so the gateway can read them remotely.

**Acceptance criteria:**
- [ ] All three endpoints implemented and authenticated (JWT required)
- [ ] `OPENAI_API_KEY` used only in gateway — not referenced anywhere in `quorum-mcp`
- [ ] MCP gracefully degrades when gateway returns 404 (endpoint not yet live)
- [ ] Endpoints documented in `gateway/openapi.yaml`

---

## Deferred to v1.0

| Item | Reason |
|------|--------|
| Reflect Activity dashboard panel | Build after `reflect()` usage data exists |
| Helm CronJob for decay | After gateway setInterval decay is proven (BL-06) |
| PENDING_CONFLICT_CHECK dashboard badge | Needs BL-06 first |
| GitHub Action for PR ingest | After BL-08 manual quality validated |
| Notifications (Slack, webhook) | Skipped — explicit product decision |
| LLM accuracy CI gate | Needs real usage data for golden dataset |
| Hosted docs site | After core features stable |
| Public case study | After at least one team uses in production |

---

## Changelog

Items resolved in reverse-chronological order.

| Date | Item | Commit |
|------|------|--------|
| 2026-05-07 | BL-11 priority P2→P1: MCP governance calls already routed to gateway (9066c8f) — endpoints missing = silent degradation | (backlog) |
| 2026-05-07 | BL-13 added: SDLC hooks + skill integration — spec + plan in place, worktree started in quorum-mcp | (backlog) |
| 2026-05-06 | quorum-mcp BL-10 complete (f37f560) — full OAuth round-trip live (gateway BL-12 + mcp client both done) | f37f560 |
| 2026-05-04 | BL-01: `group_id` isolation bypass — unconditional overwrite in `graphiti.js` + 6 tests + DEPLOYMENT.md | pending commit |
| 2026-05-03 | Per-package `CLAUDE.md` for `mcp/`, `gateway/`, `dashboard/` | `95e2cae` |
| 2026-05-03 | OpenAPI 3.1 spec at `gateway/openapi.yaml` (~40 routes) | `95e2cae` |
| 2026-05-03 | `pg` removed from `@as-quorum/mcp` — always gateway HTTP | `95e2cae` |
| 2026-05-03 | Duck-type guards in `graph/queries.js` + `audit/secondary.js` (17 guards) | `95e2cae` |
| 2026-05-03 | `QUORUM_GATEWAY_URL` defaults to `http://localhost:3001` | `95e2cae` |
| 2026-05-03 | npm org `as-quorum` + `bin.quorum` in `mcp/package.json` | `95e2cae` |
| 2026-05-03 | Monorepo restructure — `mcp/`, `gateway/`, `dashboard/` | `bb451db` |
| 2026-05-03 | Skill installs as directory `~/.claude/skills/quorum/` (not flat file) | `7280533` |
| 2026-05-03 | Audit chain hash stable across PostgreSQL round-trips | `39063b5` |
| 2026-04-xx | `reflect()` result reported to engineer in SKILL.md | `e9ebf09` |
| 2026-04-xx | LLM prompts extracted to markdown files (`src/prompts/`) | `7d71b73` |
| 2026-04-xx | `authenticate()` MCP tool — in-memory OAuth token injection | `7a9b791` |
| 2026-04-xx | GitHub OAuth + ES256 JWT + refresh tokens + JWKS endpoint | `7a9b791` |
| 2026-04-xx | React dashboard — Stats, Graph, Pending, Knowledge, Audit, Config, Status | `5cdf33f` |
| 2026-04-xx | Dashboard project selector — search, pagination, JWT-based switch | `0ce3567` |
| 2026-04-xx | DynamoDB config cache + user-project mapping + sync endpoint | `fe72718` |
| 2026-04-xx | Confidence lifecycle — decay, bump endpoint, `starting_confidence` floor | `b1baf6c` |
| 2026-04-xx | Multi-project isolation — `group_id` scoping, DDB cache, project token | `9229d7e` |
| 2026-04-xx | SKILL.md self-evolution loop — over-extraction guard, PENDING_CONFLICT_CHECK handling | `9229d7e` |
| 2026-04-xx | `skill/SKILL.md` — full session lifecycle skill | `9229d7e` |
| 2026-04-xx | Domain track record authority — `author_domain_stats` table, wired into recall/review/remember | `9229d7e` |
| 2026-04-xx | S3 + IAM Terraform — KMS, bucket policy, IRSA role, per-project policies | `9229d7e` |
| 2026-04-xx | TLS / HTTPS documented — ALB+ACM, Caddy, nginx+mkcert | `9229d7e` |
| 2026-04-xx | Production secrets documented — AWS Secrets Manager, K8s etcd KMS, Vault | `9229d7e` |
| 2026-04-xx | `quorum projects list` CLI — `GET /projects` + command | `9229d7e` |
| 2026-04-xx | `quorum config show` CLI — `GET /config/:projectId` + command | `9229d7e` |
| 2026-04-xx | `quorum config validate` CLI — `POST /config/validate` + command | `9229d7e` |
| 2026-04-xx | `.quorum` project file — `src/quorum-file.js` + `quorum init` command | `9229d7e` |
| 2026-04-xx | Project scoping on PostgreSQL — `project_id` column, composite index, gateway enforcement | `9229d7e` |
| 2026-04-xx | Tags in `insertVersion` — `tags TEXT[]` + GIN index + `getVersionsByTag()` | `9229d7e` |
| 2026-04-xx | Audit scan scripts — `audit-scan.js` + `audit-scan-harddeletes.js`; 15 violations fixed | `9229d7e` |
| 2026-04-xx | Quorum Gateway microservice — ES256 JWT, `/pg/*` REST API, Graphiti proxy | `9229d7e` |
