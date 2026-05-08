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
| BL-05 | Pin Graphiti git SHA in Dockerfile | P3 | ✅ Done | `ARG GRAPHITI_SHA` + `git checkout` in `Dockerfile.graphiti`. Pinned to `c427615` (2026-05-07). Update manually when taking upstream changes. |
| BL-10 | `DEPLOYMENT.md` — component security model | Docs | ✅ Done | Full rewrite: two-party arch, OAuth 2.1 flow, engineer onboarding, secrets table, multi-team isolation. |
| BL-11 | Gateway LLM governance endpoints | P1 | ✅ Done | `gateway/src/routes/governance.js` + `gateway/src/llm.js`. JWT-authenticated. OPENAI_API_KEY gateway-only. OpenAPI spec updated. |
| BL-12 | OAuth 2.1 Authorization Server in gateway | P2 | ✅ Done | RFC8414 discovery, RFC7591 dynamic client reg, PKCE S256, GitHub IdP, ES256 JWT; wired in `server.js`. quorum-mcp BL-10 client also ✅ Done (f37f560) — full OAuth round-trip live. |
| BL-13 | SDLC Hooks + Skill Integration | P2 | ✅ Done | 5 hook scripts + `hooks.js` + SKILL.md. Merged to quorum-mcp `prod`. 13 unit tests passing. |

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

### ✅ BL-05 — Pin Graphiti git SHA in Dockerfile
**File:** `Dockerfile.graphiti`

`ARG GRAPHITI_SHA` + `git checkout "${GRAPHITI_SHA}"` makes builds reproducible.
No automation — update the SHA manually when taking upstream changes or when a
vulnerability is flagged. The upgrade path is documented in a comment in the Dockerfile.

**Acceptance criteria:**
- [x] `Dockerfile.graphiti` pins a specific Graphiti commit SHA (`c427615`, 2026-05-07)
- [x] Upgrade path documented in a comment above the `ARG` line

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

### ✅ BL-13 — SDLC Hooks + Skill Integration
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

### ✅ BL-11 — Gateway LLM governance endpoints
**Files (new):** `gateway/src/routes/governance.js` · `gateway/src/llm.js`
**Files (modified):** `gateway/src/server.js` · `gateway/openapi.yaml` · `.env.example`

Three endpoints that move LLM calls out of `quorum-mcp` and into the gateway.
JWT-authenticated (`verifyJwt`). Prompts are inlined in the route — gateway is self-contained.

| Endpoint | Input | Output |
|----------|-------|--------|
| `POST /governance/detect-conflict` | `{ existing, incoming }` | `{ contradicts, reason, possible_split, split_suggestion }` |
| `POST /governance/enrich` | `{ existing, incoming, conflict_reason, possible_split, split_suggestion }` | `{ analysis, risks_if_approved[], questions_for_reviewer[], existing_rationale, possible_split, split_suggestion }` |
| `POST /governance/extract` | `{ task_summary, decisions_made?, patterns_used? }` | `{ items: ExtractedItem[] }` |

**Acceptance criteria:**
- [x] All three endpoints implemented and authenticated (JWT required)
- [x] `OPENAI_API_KEY` used only in gateway — not referenced anywhere in `quorum-mcp`
- [x] 503 returned when `OPENAI_API_KEY` not set (clear error, not a crash)
- [x] Endpoints documented in `gateway/openapi.yaml`
- [x] `.env.example` updated — `OPENAI_API_KEY` noted as gateway + Graphiti shared var

---

## Deferred to v1.0

| Item | Reason |
|------|--------|
| Reflect Activity dashboard panel | Build after `reflect()` usage data exists |
| Helm CronJob for decay | Use external k8s CronJob calling `scripts/decay-confidence.js` |
| PENDING_CONFLICT_CHECK dashboard badge | Deferred to v1.0 |
| GitHub Action for PR ingest | Dropped — SKILL.md + hooks already capture PR knowledge via reflect() |
| Notifications (Slack, webhook) | Skipped — explicit product decision |
| LLM accuracy CI gate | Needs real usage data for golden dataset |
| Hosted docs site | After core features stable |
| Public case study | After at least one team uses in production |

---

## Changelog

Items resolved in reverse-chronological order.

| Date | Item | Commit |
|------|------|--------|
| 2026-05-07 | BL-03 dropped: platform team deploys Quorum centrally; engineers connect from local Claude Code — no local stack CLI needed | (backlog) |
| 2026-05-07 | BL-13 ✅ Done: merged to quorum-mcp prod — 5 hooks, hooks.js, SKILL.md, 13 tests passing | feat/sdlc-hooks |
| 2026-05-08 | BL-07 dropped: lite compose is platform-team infra — they compose their own setup; a generic lite file would be in their way | (backlog) |
| 2026-05-08 | BL-08 dropped: SKILL.md + hooks already capture PR knowledge via reflect() and remember() — dedicated tool is redundant | (backlog) |
| 2026-05-08 | BL-05 ✅ Done: `Dockerfile.graphiti` pins `GRAPHITI_SHA=c427615` — reproducible builds, manual upgrade path documented in comment | feat/dashboard |
| 2026-05-08 | BL-04 dropped: clear error messages already actionable; LLM can guide engineer to retry — automatic retry adds complexity without value | (backlog) |
| 2026-05-08 | BL-06 dropped: gateway setInterval fragile on restart/scale-out; use external k8s CronJob calling existing `scripts/decay-confidence.js` | (backlog) |
| 2026-05-08 | BL-07 narrowed to lite compose only: MCP `graphitiAvailable` flag dropped — gateway `/health` already surfaces Graphiti status; surface failures, don't hide them | (backlog) |
| 2026-05-08 | BL-09 dropped: prompts moved to gateway as inlined template literals (BL-11); `src/prompts/*.md` in quorum-mcp now orphaned; response normalization too simple to unit-test | (backlog) |
| 2026-05-08 | BL-10 ✅ Done: `docs/DEPLOYMENT.md` rewritten — two-party architecture, OAuth 2.1 engineer flow, updated env vars, secrets table, multi-team isolation enforcement chain | feat/dashboard |
| 2026-05-08 | BL-11 ✅ Done: `gateway/src/routes/governance.js` + `gateway/src/llm.js` — 3 endpoints, JWT auth, OpenAI via native fetch, 503 when unconfigured | feat/dashboard |
| 2026-05-07 | BL-11 priority P2→P1: MCP governance calls already routed to gateway (9066c8f) — endpoints missing = silent degradation | (backlog) |
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
