# Codex Handover — Quorum Pending Work

Date: 2026-07-01  
Status: Ready for implementation  
Reference docs: [CICD-DEPLOYMENT.md](CICD-DEPLOYMENT.md) · [DEPLOYMENT.md](DEPLOYMENT.md) · [local-graphiti-image-analysis-2026-06-29.md](local-graphiti-image-analysis-2026-06-29.md)

---

## Context

Quorum is a five-package monorepo workspace at `/Users/ayan/Desktop/Work/vscode/qc`:

| Dir | Package | Purpose |
|-----|---------|---------|
| `quorum/` | gateway + API E2E | Express gateway `:3001` |
| `quorum-dash/` | dashboard SPA | React SPA `:3002`, also Docker nginx |
| `quorum-mcp/` | `@as-quorum/mcp` | npm MCP server for Claude Code |
| `quorum-website/` | marketing site | Next.js `:4000` |
| `graphiti/quorum-graphiti/` | Graphiti fork | Python; publishes `ghcr.io/ayansasmal/graphiti-mcp` |

The items below are ordered by priority: quick cleanups first, then the biggest correctness gap (Graphiti), then new automation and skills.

---

## Task 1 — Delete `Dockerfile.graphiti` (5 min) ✅ Complete

**Why:** `quorum/Dockerfile.graphiti` sparse-clones upstream `getzep/graphiti` (not the Quorum fork). It was the source for all local Graphiti builds. The `build-graphiti` CI job that verified it was already removed from `quorum/.github/workflows/build.yml` by a prior session. The file is now dead and misleading — keeping it implies it still matters.

**What to do:**

```
DELETE  quorum/Dockerfile.graphiti
```

**Outcome:** completed as part of Task 5, once the live compose and script paths no longer depended on the file.

---

## Task 2 — Migrate `gatewayTag` from semver to `sha-*` in `prod.yaml` (15 min) ✅ Complete

**Why:** `quorum/crossplane/environments/prod.yaml` has `gatewayTag: "0.4.12"` (a semver value). The graphiti tag in the same file uses `sha-*` format. The gateway GHA workflow (`type=sha,prefix=sha-`) produces short-SHA tags. Convention should be consistent across both tags in prod.yaml.

**Current state** (`quorum/crossplane/environments/prod.yaml` lines 59–63):

```yaml
  images:
    registry: ghcr.io/ayansasmal
    gatewayTag: "0.4.12"
    graphitiTag: "sha-d99abda38b1181d1f56198f1565510de9564f79b"
```

**What to do** — change `gatewayTag` to the short-SHA tag currently running in production:

```yaml
    gatewayTag: "sha-ea2f792"
```

> `sha-ea2f792` is the current live gateway tag (deployed 2026-06-13, profile-404 onboarding fix). Two deploys happened that day: `0.4.12 → sha-fa1a960` then `sha-fa1a960 → sha-ea2f792`. The gateway GHA workflow uses `type=sha,prefix=sha-` (no `format=long`), producing 7-char hex short SHAs. The graphiti tag uses full 40-char SHA from a different repo's workflow — both formats are correct for their respective images.

**Verification:** `grep gatewayTag quorum/crossplane/environments/prod.yaml` → `sha-ea2f792`.

---

## Task 3 — Document `GRAPHITI_TAG` and `GATEWAY_TAG` in `.env.example` (15 min) ✅ Complete

**Why:** When the Graphiti GHCR unification (Task 5) lands, `setup.sh` and `e2e-docker.sh` will read `GRAPHITI_TAG` to know which GHCR image to pull. Engineers need the escape hatch documented. `GATEWAY_TAG` is used by the docker-compose.pull.yml overlay (Task 4).

**File:** `quorum/.env.example`

Add a new section after the `v0.3 — Admin bootstrap` section and before the `v0.2 — Project Config` section:

```
# ─────────────────────────────────────────────────────────────────
# Docker image pins (local dev only — optional overrides)
# ─────────────────────────────────────────────────────────────────

# Pin the Graphiti MCP image pulled from GHCR.
# Default (when unset): derived from ../graphiti/quorum-graphiti sibling
#   checkout via sha-$(git -C ../graphiti/quorum-graphiti rev-parse HEAD).
# Fallback (sibling checkout absent): current prod tag below.
# Override example:
# GRAPHITI_TAG=sha-d99abda38b1181d1f56198f1565510de9564f79b

# Pin the gateway image when using docker-compose.pull.yml (GHCR pull mode).
# Default: latest tag published from the prod branch.
# Override example:
# GATEWAY_TAG=sha-ea2f792
```

---

## Task 4 — Add `docker-compose.pull.yml` overlay — GHCR pull mode (1 h) ✅ Complete

**Why:** `docker compose up` currently always builds gateway and graphiti from source. Engineers who haven't changed gateway or graphiti source should be able to pull pre-built GHCR images instead of waiting for a local build.

**File to create:** `quorum/docker-compose.pull.yml`

```yaml
# docker-compose.pull.yml — GHCR pull-mode overlay
#
# Usage:
#   docker compose -f docker-compose.yml -f docker-compose.pull.yml up -d
#
# Replaces local builds for gateway and graphiti with GHCR images.
# Requires: docker login ghcr.io (GitHub PAT with read:packages scope — one-time per machine)
#
# Optional pins (add to .env or export before running):
#   GATEWAY_TAG=sha-ea2f792
#   GRAPHITI_TAG=sha-d99abda38b1181d1f56198f1565510de9564f79b

services:
  gateway:
    image: ghcr.io/ayansasmal/quorum-gateway:${GATEWAY_TAG:-latest}
    pull_policy: always
    build: !reset null

  graphiti:
    image: ghcr.io/ayansasmal/graphiti-mcp:${GRAPHITI_TAG:-latest}
    pull_policy: always
    build: !reset null
```

> `build: !reset null` removes the inherited `build:` block from docker-compose.yml (supported in Docker Compose v2.23+; the local environment runs v5.1.4 so this is safe). `pull_policy: always` forces a registry pull on every `up` so the pinned tag is always fresh.

**Add npm script** to `quorum/package.json` (alongside the other `docker:*` entries):

```json
"docker:start:pull": "docker compose -f docker-compose.yml -f docker-compose.pull.yml up -d"
```

**Document** the new command in `quorum/CLAUDE.md` under the `# ── Development` section:

```
npm run docker:start:pull        # start stack pulling gateway + graphiti from GHCR (no local build)
```

---

## Task 5 — Unify local Graphiti to GHCR pull (2 h) ✅ Complete

**Why (the short version):** All four local Graphiti delivery paths currently build from `quorum/Dockerfile.graphiti`, which sparse-clones upstream `getzep/graphiti` and installs `graphiti-core` from PyPI. This is **semantically wrong**: the Quorum fork (`graphiti/quorum-graphiti`) installs `graphiti_core/` from local source, which contains all Quorum-specific prompt changes (entity extraction, deduplication, temporal invalidation, summary). Local dev silently runs different code from production.

**Full spec:** `quorum/docs/local-graphiti-image-analysis-2026-06-29.md` — read it fully before implementing.

### Tag resolution function

All scripts that start the stack must resolve `GRAPHITI_TAG` via this priority chain. Implement once as a shell function `resolve_graphiti_tag` and source it where needed:

```bash
resolve_graphiti_tag() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local fork_dir="$script_dir/../graphiti/quorum-graphiti"

  if [ -n "${GRAPHITI_TAG:-}" ]; then
    echo "$GRAPHITI_TAG"
  elif [ -d "$fork_dir/.git" ]; then
    echo "sha-$(git -C "$fork_dir" rev-parse HEAD)"
  else
    # Hardcoded prod tag as safe fallback — a known-good image
    echo "sha-d99abda38b1181d1f56198f1565510de9564f79b"
  fi
}
```

> The Graphiti fork uses full 40-char SHA tags (`type=sha,prefix=sha-,format=long` in its CI). The `rev-parse HEAD` call produces the full SHA, which matches.

### Files to change

**`quorum/docker-compose.yml`** — graphiti service (around line 57):

```yaml
# BEFORE
  graphiti:
    image: graphiti-mcp:${IMAGE_TAG:-latest}
    build:
      context: .
      dockerfile: Dockerfile.graphiti

# AFTER
  graphiti:
    image: ghcr.io/ayansasmal/graphiti-mcp:${GRAPHITI_TAG:-latest}
    # Pulled from GHCR. Run `docker login ghcr.io` once per machine.
    # GRAPHITI_TAG resolved by setup.sh; override in .env to pin a specific build.
```

**`quorum/docker-compose.e2e.yml`** — graphiti service (around line 127):

```yaml
# BEFORE
  graphiti:
    image: graphiti-mcp:e2e
    build:
      context: .
      dockerfile: Dockerfile.graphiti

# AFTER
  graphiti:
    image: ghcr.io/ayansasmal/graphiti-mcp:${GRAPHITI_TAG:-latest}
    # tag resolved and exported by e2e-docker.sh before compose up
```

**`quorum/scripts/setup.sh`** — update the `docker_up` and `rebuild` paths:

1. Add the `resolve_graphiti_tag` function near the top (after the constants block).
2. In the `docker` (start) path — before `docker compose up`:
   ```bash
   export GRAPHITI_TAG
   GRAPHITI_TAG=$(resolve_graphiti_tag)
   info "Graphiti image tag: $GRAPHITI_TAG"
   ```
3. In the `rebuild` path — remove `graphiti` from `docker compose build --no-cache --parallel gateway graphiti`. The gateway build stays. Graphiti is pulled, not built.
4. Remove the line (around line 356) that references `quorum-graphiti` in image cleanup.

**`quorum/scripts/e2e-docker.sh`** — `_up()` function:

1. Add the `resolve_graphiti_tag` function.
2. Before the `docker compose ... up` call:
   ```bash
   export GRAPHITI_TAG
   GRAPHITI_TAG=$(resolve_graphiti_tag)
   ```
3. Remove any `docker compose build` invocation for the graphiti service.

**`quorum/scripts/k8s-setup.sh`** — `build_images()` function (around line 123):

```bash
# REMOVE these lines:
  echo "▶ Building graphiti image: $GRAPHITI_IMAGE"
  docker build \
    -f "$PROJECT_ROOT/Dockerfile.graphiti" \
    -t "$GRAPHITI_IMAGE" \
    "$PROJECT_ROOT"
  echo "✓ Built $GRAPHITI_IMAGE"

# ADD resolution instead:
  export GRAPHITI_TAG
  GRAPHITI_TAG=$(resolve_graphiti_tag)
  info "Graphiti GHCR tag: $GRAPHITI_TAG"
```

Update the helm install/upgrade call to pass the GHCR repository and resolved tag:

```bash
helm upgrade --install quorum ./helm/quorum \
  --namespace quorum \
  --values helm/quorum/values-local.yaml \
  --set "graphiti.image.repository=ghcr.io/ayansasmal/graphiti-mcp" \
  --set "graphiti.image.tag=${GRAPHITI_TAG}" \
  --set "graphiti.image.pullPolicy=Always" \
  ...
```

**`quorum/helm/quorum/values.yaml`** — graphiti image section (around line 151):

```yaml
# BEFORE
graphiti:
  image:
    repository: graphiti-mcp
    tag: local

# AFTER
graphiti:
  image:
    repository: ghcr.io/ayansasmal/graphiti-mcp
    tag: latest
    pullPolicy: Always
```

**`quorum/.env.example`** — already covered in Task 3.

### GHCR auth prerequisite

Add to `quorum/AGENTS.md` prerequisites section and `quorum/docs/DEPLOYMENT.md` Option 1 Prerequisites:

```
# One-time per developer machine — authenticate to pull Graphiti from GHCR
docker login ghcr.io
# GitHub username + Personal Access Token with read:packages scope
```

### Verification targets

1. `docker-compose.yml` graphiti service: no `build:` block; image is `ghcr.io/ayansasmal/graphiti-mcp:${GRAPHITI_TAG:-latest}`.
2. `docker-compose.e2e.yml` same.
3. `k8s-setup.sh` does not call `docker build` on `Dockerfile.graphiti`; passes GHCR image to helm.
4. `setup.sh` resolves and exports `GRAPHITI_TAG` before compose up.
5. With sibling fork absent and `GRAPHITI_TAG` unset: tag falls back to `sha-d99abda38b...` (full 40-char prod tag).
6. `GRAPHITI_TAG=sha-abc123` env override is respected across all scripts.
7. Mock-openai remains wired via `OPENAI_BASE_URL=http://mock-openai:3003` in test overlay and E2E — no change needed.
8. Existing failing test `tests/scripts/local-graphiti-image.test.js` passes.

---

## Task 6 — `quorum-mcp` release workflow for npm auto-publish (1 h) ✅ Complete

**Why:** `@as-quorum/mcp` is installed by engineers via `npm install -g @as-quorum/mcp`. Currently `npm publish` is run manually. A CI workflow should publish automatically when a git tag is pushed.

**Package facts:**
- Package name: `@as-quorum/mcp`
- Current version: `0.0.1`
- Build command: `npm run build:all` (compiles `src/server.js` + `src/cli.js` → `dist/`)
- Publish: `npm publish --access public`
- No `.github/` directory exists in `quorum-mcp/` yet — create it

**File to create:** `quorum-mcp/.github/workflows/release.yml`

```yaml
name: Publish @as-quorum/mcp

on:
  push:
    tags:
      - 'v*.*.*'
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Dry run — build and pack but do not publish'
        type: boolean
        default: false

permissions:
  contents: read
  id-token: write   # for npm provenance

jobs:
  publish:
    name: Build and publish to npm
    runs-on: ubuntu-latest
    container: node:24-alpine

    steps:
      - uses: actions/checkout@v4

      - name: Install dependencies
        run: npm ci --prefer-offline

      - name: Run tests
        run: npm test

      - name: Build dist
        run: npm run build:all

      - name: Pack (verify bundle contents)
        run: npm pack --dry-run

      - name: Publish to npm
        if: ${{ !inputs.dry_run }}
        run: npm publish --access public --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Add `.npmrc`** to `quorum-mcp/` (if not already present):

```
//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}
```

**Verify `publishConfig`** in `quorum-mcp/package.json` — add if missing:

```json
"publishConfig": {
  "access": "public",
  "registry": "https://registry.npmjs.org/"
}
```

**Secret required:** `NPM_TOKEN` must be added to the `quorum-mcp` GitHub repository secrets (Settings → Secrets and Variables → Actions). The token must be a Granular Access Token scoped to `@as-quorum/mcp` with `read and write` on packages.

**Release process after the workflow exists:**

```bash
cd quorum-mcp
npm version patch   # or minor / major
git push --follow-tags
# → GHA picks up the v* tag → runs tests → publishes to npm
```

---

## Task 7 — Create 7 `quorum-local-*` Claude skills (3 h)

**Why:** Production operations are driven by the `/quorum-resume`, `/quorum-suspend`, `/quorum-restart`, `/quorum-update` skills. Local dev has no equivalent — engineers type docker compose commands manually. These 7 skills bring the same single-command UX to local development.

**Skills location:** `.claude/skills/` in the workspace root (`/Users/ayan/Desktop/Work/vscode/qc/.claude/skills/`). Each skill is a **directory** containing a `SKILL.md` file. This matches the existing prod skill structure exactly:

```
.claude/skills/
  quorum-resume/SKILL.md       ← existing prod skill
  quorum-update/SKILL.md       ← existing prod skill
  quorum-local-start/SKILL.md  ← NEW
  quorum-local-stop/SKILL.md   ← NEW
  quorum-local-reset/SKILL.md  ← NEW
  quorum-local-update/SKILL.md ← NEW
  quorum-local-status/SKILL.md ← NEW
  quorum-local-logs/SKILL.md   ← NEW
  quorum-local-seed/SKILL.md   ← NEW
```

**Read the existing prod skills** (`quorum-resume/SKILL.md`, `quorum-update/SKILL.md`) before writing the local ones — match their frontmatter format, approval gate language, and step structure exactly.

**Key npm scripts available in `quorum/`** (use these in skill steps, not raw docker commands):

```bash
npm run docker:start           # setup.sh docker — full stack up
npm run docker:rebuild         # setup.sh docker rebuild — rebuild + up
npm run docker:clean           # setup.sh docker clean — down (no volumes)
npm run docker:clean:all       # setup.sh docker clean --volumes — down + wipe
npm run docker:ps              # show running container status
npm run docker:start:dash      # nginx dashboard up on :3002
npm run docker:stop:dash       # docker compose stop dashboard
npm run seed                   # seed knowledge + project data
npm run seed:catalogs          # seed global catalog hierarchy
```

For the seed skill, LocalStack can be re-seeded directly by running `./scripts/init-localstack.sh` on the host (it is idempotent — safe to re-run against a running stack).

---

### Skill 1: `quorum-local-start`

**File:** `.claude/skills/quorum-local-start/SKILL.md`

```markdown
---
name: quorum-local-start
description: Start the local Quorum dev stack (gateway + graphiti + postgres + falkordb + redis + localstack). Optionally starts the dashboard nginx container as well.
---

# quorum-local-start — bring the local stack up

Starts the full local Quorum development stack.

## Usage
/quorum-local-start [dashboard]

- No args: start core stack (gateway + graphiti + postgres + falkordb + redis + localstack)
- `dashboard`: also start the nginx dashboard container on :3002

## Approval gate

State plainly what you are about to start (local Docker Desktop — not production) and get the user's go-ahead before running any commands.

## Steps

1. From `quorum/`:
   - Without `dashboard`: `npm run docker:start`
   - With `dashboard`: `npm run docker:start` then `npm run docker:start:dash`
2. Verify health: `curl -sf http://localhost:3001/health | jq .`
3. Report running services and ports:
   - Gateway: http://localhost:3001
   - Graphiti: http://localhost:8001
   - FalkorDB UI: http://localhost:3000
   - Dashboard: http://localhost:3002 (if started)

## Notes
- Requires Docker Desktop running.
- First run after `docker login ghcr.io` pulls the Graphiti GHCR image (~1 min). Subsequent starts use cached layers.
- For active React dev, prefer `cd quorum-dash && npm run dev` (Vite hot-reload) over the nginx container.
```

---

### Skill 2: `quorum-local-stop`

**File:** `.claude/skills/quorum-local-stop/SKILL.md`

```markdown
---
name: quorum-local-stop
description: Stop the local Quorum dev stack containers without wiping data volumes.
---

# quorum-local-stop — stop local containers (data preserved)

Stops all local Quorum containers. Data volumes (postgres, falkordb, redis, localstack) are preserved — a subsequent `quorum-local-start` resumes from the same state.

## Approval gate

State that you are about to stop the local dev stack (not production) and get the user's go-ahead.

## Steps

1. From `quorum/`: `npm run docker:clean`
   (This runs `setup.sh docker clean` → `docker compose down --remove-orphans`. The dashboard is stopped too if running.)
2. Verify: `npm run docker:ps` should show no running Quorum containers.

## Notes
- Does NOT wipe volumes. Data survives a stop/start cycle.
- To wipe all data use `/quorum-local-reset`.
```

---

### Skill 3: `quorum-local-reset`

**File:** `.claude/skills/quorum-local-reset/SKILL.md`

```markdown
---
name: quorum-local-reset
description: Stop the local Quorum stack AND wipe all data volumes — full reset to a clean state. Destructive.
---

# quorum-local-reset — wipe local data and restart clean

**Destructive.** Stops all containers and deletes all data volumes.

## Hard approval gate (MANDATORY)

Before running, tell the user exactly what will be destroyed:
- PostgreSQL audit store (all audit entries)
- FalkorDB knowledge graph (all nodes and edges)
- Redis cache (all config and profile entries)
- LocalStack S3 and DynamoDB state (config bucket, membership table)

Ask: "This will permanently delete all local Quorum data. Type YES to confirm."
Wait for the literal string "YES" (case-sensitive) before proceeding. Do not proceed on anything less.

## Steps

1. After "YES" confirmation, from `quorum/`: `npm run docker:clean:all`
   (Runs `setup.sh docker clean --volumes` → `docker compose down --remove-orphans --volumes`.)
2. Restart a fresh stack: `npm run docker:start`
   (`setup.sh docker` brings the stack up and re-seeds LocalStack automatically via `init-localstack.sh`.)
3. Verify health: `curl -sf http://localhost:3001/health | jq .`
4. Report: stack is clean and running with empty data.

## Notes
- After reset, the first admin is re-seeded automatically if `QUORUM_FIRST_ADMIN` is set in `.env`.
- If `QUORUM_FIRST_ADMIN` is not set, no admin will exist — warn the user.
```

---

### Skill 4: `quorum-local-update`

**File:** `.claude/skills/quorum-local-update/SKILL.md`

```markdown
---
name: quorum-local-update
description: Pull the latest GHCR images for gateway and/or graphiti, then restart those services without touching data volumes.
---

# quorum-local-update — pull fresh images and restart services

Pulls updated GHCR images and performs a rolling restart of gateway and graphiti. All data volumes remain intact.

## Usage
/quorum-local-update [gateway=sha-<tag>] [graphiti=sha-<tag>]

- No args: pull `latest` for both gateway and graphiti.
- `gateway=sha-ea2f792`: example — pin gateway to current prod tag.
- `graphiti=sha-d99abda38b...`: example — pin graphiti to current prod tag.

## Approval gate

State the images and tags that will be pulled (local Docker Desktop — not production) and get the user's go-ahead.

## Steps

1. From `quorum/`, pull the updated images:
   ```bash
   GATEWAY_TAG=${gateway_tag:-latest} \
   GRAPHITI_TAG=${graphiti_tag:-latest} \
   docker compose -f docker-compose.yml -f docker-compose.pull.yml pull gateway graphiti
   ```
2. Restart the updated services (no volume impact):
   ```bash
   GATEWAY_TAG=${gateway_tag:-latest} \
   GRAPHITI_TAG=${graphiti_tag:-latest} \
   docker compose -f docker-compose.yml -f docker-compose.pull.yml up -d --no-deps gateway graphiti
   ```
3. Verify: `curl -sf http://localhost:3001/health | jq .`

## Notes
- Does NOT change prod.yaml or the production secret — this is local only.
- To deploy to production use `/quorum-update sha-<commit>`.
- Requires `docker login ghcr.io` to have been run once on this machine.
```

---

### Skill 5: `quorum-local-status`

**File:** `.claude/skills/quorum-local-status/SKILL.md`

```markdown
---
name: quorum-local-status
description: Show a one-table health summary of all local Quorum services.
---

# quorum-local-status — local stack health at a glance

Read-only. No approval needed.

## Steps

1. From `quorum/`: `npm run docker:ps`
2. Also run: `curl -sf http://localhost:3001/health | jq .` (may fail if stack is down — handle gracefully).
3. Render a table:

   | Service | Port | Status |
   |---------|------|--------|
   | gateway | 3001 | healthy / starting / stopped |
   | graphiti | 8001 | healthy / ... |
   | postgresql | 5432 | healthy / ... |
   | falkordb | 6379 | healthy / ... |
   | redis | 6380 (host) | healthy / ... |
   | localstack | 4566 | healthy / ... |
   | dashboard | 3002 | running / not started |

4. If the gateway health endpoint responds, include the `components` detail from its JSON.
5. If the stack is not running say so clearly and suggest `/quorum-local-start`.
```

---

### Skill 6: `quorum-local-logs`

**File:** `.claude/skills/quorum-local-logs/SKILL.md`

```markdown
---
name: quorum-local-logs
description: Tail logs for one or more local Quorum services.
---

# quorum-local-logs — stream local service logs

Read-only. No approval needed.

## Usage
/quorum-local-logs [service ...]

Valid service names: `gateway`, `graphiti`, `postgresql`, `falkordb`, `redis`, `localstack`, `dashboard`, `mock-openai`

- No args: tail all services (last 50 lines each, then follow).
- One or more names: tail only those services.

## Steps

1. From `quorum/`:
   ```bash
   docker compose logs -f --tail=100 <service(s)>
   ```
   Run in background and stream output to the user.
2. After the user is done (or after ~60 s of inactivity), stop the stream and summarise any `ERROR` or `WARN` lines seen.
```

---

### Skill 7: `quorum-local-seed`

**File:** `.claude/skills/quorum-local-seed/SKILL.md`

```markdown
---
name: quorum-local-seed
description: Re-seed LocalStack (S3 + DynamoDB) and/or knowledge data against the already-running local stack. Does not restart any containers.
---

# quorum-local-seed — re-seed local data without restart

Re-runs seed scripts against the running local stack. Safe to run multiple times (additive, not a wipe).

## Usage
/quorum-local-seed [localstack|knowledge|catalogs|all]

- `localstack` (default): re-init S3 bucket + DynamoDB table
- `knowledge`: seed knowledge + project data
- `catalogs`: seed global catalog hierarchy
- `all`: all three in sequence

## Approval gate

State what will be seeded and that it is additive (will not wipe existing data). Get the user's go-ahead.

## Steps

1. Confirm the stack is running: `curl -sf http://localhost:3001/health | jq .status`
   If not running, stop and suggest `/quorum-local-start` first.

2. From `quorum/`, run the relevant commands:
   - **localstack**: `./scripts/init-localstack.sh`
     (idempotent — safe to re-run; uses `awslocal` on host pointing to `localhost:4566`)
   - **knowledge**: `npm run seed`
   - **catalogs**: `npm run seed:catalogs`
   - **all**: run all three in sequence

3. Report counts or any errors from each step.

## Notes
- `init-localstack.sh` runs on the host (not inside Docker) and uses `awslocal` — requires `pip install awscli-local` on the host machine.
- If LocalStack is not responding, try `/quorum-local-status` to diagnose.
```

---

## Task 8 — Add `dashboardTag` to `prod.yaml` (optional, ~30 min)

**Status: Future option** — only needed if the live production dashboard is ever moved from Vercel to the Docker/GHCR delivery path. The current production dashboard is the Vercel deployment at `quorum-dashboard.ayansasmal.work`. The dashboard GHCR image is used for local dev and Docker E2E only.

**When to implement:** Only when explicitly decided to serve production dashboard from EC2 instead of Vercel.

**What it would involve:**
- Add `dashboardTag: "sha-<commit>"` under `images:` in `quorum/crossplane/environments/prod.yaml`.
- Add a dashboard service to `quorum/docker-compose.aws.yml` pulling `ghcr.io/ayansasmal/quorum-dashboard:${DASHBOARD_TAG}`.
- Add `DASHBOARD_TAG` to the `quorum/prod/gateway` production secret.
- Update `/quorum-update` skill to optionally accept a dashboard tag argument.

---

## Commit Conventions

All commits must use conventional commits format. Each task should be a separate commit:

```
fix(deploy): delete obsolete Dockerfile.graphiti
fix(deploy): migrate gatewayTag to sha-* format in prod.yaml
docs(deploy): document GRAPHITI_TAG and GATEWAY_TAG in .env.example
feat(deploy): add docker-compose.pull.yml GHCR pull-mode overlay
feat(deploy): unify local graphiti delivery to GHCR pull
feat(ci): add quorum-mcp npm release workflow
feat(skills): add quorum-local-* Claude skills for local dev ops
```

---

## Verification Checklist

After completing all tasks:

- [x] `quorum/Dockerfile.graphiti` deleted after the live compose/script references were removed in the GHCR pull unification change
- [x] `prod.yaml` `gatewayTag` is `sha-ea2f792`
- [x] `.env.example` documents `GRAPHITI_TAG` and `GATEWAY_TAG` with examples
- [x] `docker-compose.pull.yml` exists; `docker compose -f docker-compose.yml -f docker-compose.pull.yml config` validates without error
- [x] `npm run docker:start:pull` script exists in `quorum/package.json`
- [x] `docker-compose.yml` graphiti service: no `build:` block; image is `ghcr.io/ayansasmal/graphiti-mcp:${GRAPHITI_TAG:-latest}`
- [x] `docker-compose.e2e.yml` graphiti service: no `build:` block; same GHCR image reference
- [x] `setup.sh` exports `GRAPHITI_TAG` resolved via the three-step fallback chain before compose up
- [x] `e2e-docker.sh` exports `GRAPHITI_TAG` before compose up
- [x] `k8s-setup.sh` passes `ghcr.io/ayansasmal/graphiti-mcp` image to helm; no graphiti `docker build` call
- [x] `helm/quorum/values.yaml` graphiti `image.repository` is `ghcr.io/ayansasmal/graphiti-mcp`
- [x] `tests/scripts/local-graphiti-image.test.js` passes
- [x] `quorum-mcp/.github/workflows/release.yml` exists
- [ ] `quorum-mcp/.npmrc` exists with `NODE_AUTH_TOKEN` reference
- [ ] `quorum-mcp/package.json` has correct `publishConfig`
- [ ] 7 skill directories exist: `.claude/skills/quorum-local-{start,stop,reset,update,status,logs,seed}/SKILL.md`
- [ ] Each skill's frontmatter `name:` matches its directory name exactly
