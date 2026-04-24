# Quorum — Quick Start

Get Quorum running locally in under 10 minutes using Docker Compose.

---

## Prerequisites

Install all of these before starting.

```bash
# 1. Node.js 20+
node --version    # must be v20.x.x or higher
# Install: https://nodejs.org or brew install node

# 2. Docker Desktop (includes Docker + Compose)
docker --version
# Install: https://www.docker.com/products/docker-desktop

# 3. awscli-local (for LocalStack S3 bucket bootstrap)
pip install awscli-local
awslocal --version

# 4. An OpenAI API key (used by the Graphiti sidecar for entity extraction)
# Get one at: https://platform.openai.com/api-keys
```

> **Why OpenAI?** Graphiti — the temporal knowledge graph engine Quorum uses — calls
> an LLM to extract entities and relationships from text. `gpt-4o-mini` is the default:
> cheap, fast, and confirmed stable with Graphiti's structured output requirements.

---

## Step 1 — Clone and configure

```bash
git clone https://github.com/ayansasmal/quorum.git
cd quorum

# Copy the example environment file
cp .env.example .env
```

Open `.env` and set your OpenAI key — this is the **only required change**:

```env
OPENAI_API_KEY=sk-...
```

Everything else in `.env` is pre-configured for local Docker Compose. You do not need
to change anything else to get started.

---

## Step 2 — Start the stack

```bash
./scripts/setup.sh docker
```

This single command:
1. Checks Node.js and Docker are installed and running
2. Installs Node.js dependencies (`npm install`)
3. Starts all 7 Docker services and waits for them to be healthy
4. Bootstraps the S3 bucket in LocalStack (`scripts/init-localstack.sh`)
5. Seeds the knowledge graph with sample engineering knowledge (`npm run seed`)

The first run takes 3–5 minutes (Docker image pulls). Subsequent runs are under 60 seconds.

**What you'll see at the end:**

```
✓ All services healthy
✓ LocalStack S3 ready — gateway will use s3://quorum-configs/my-team/config.json
✓ Seed complete

  Add Quorum to Claude Code:
    claude mcp add quorum -- node /path/to/quorum/src/server.js

  Dashboard:  http://localhost:3002
  Gateway:    http://localhost:3001/health
  LocalStack: http://localhost:4566/_localstack/health
```

---

## Step 3 — Verify the stack is running

```bash
# All 7 services should show "running" or "healthy"
docker compose ps

# Gateway health check
curl http://localhost:3001/health
# {"status":"ok","version":"0.2.0"}

# Verify the audit chain is intact
node cli.js audit verify
# Chain verified: N entries, no tampering detected

# Check seeded knowledge is queryable
node cli.js history auth:token-strategy
```

Open the dashboard in your browser: **http://localhost:3002**

---

## Step 4 — Connect to Claude Code

```bash
# Replace /path/to/quorum with your actual clone path
claude mcp add quorum -- node /path/to/quorum/src/server.js

# Verify Claude can see the tools
claude mcp list
# quorum: remember, recall, search, reflect, history, export, forget, review
```

Once connected, Claude Code automatically uses Quorum's tools during sessions.
The `skill/SKILL.md` file documents how Claude is expected to use them — copy it
to your project's `.claude/skills/` folder:

```bash
mkdir -p .claude/skills
cp /path/to/quorum/skill/SKILL.md .claude/skills/quorum.md
```

---

## What's running

| Service | URL | Purpose |
|---|---|---|
| `gateway` | http://localhost:3001 | Central API — JWT auth, S3 config, Graphiti proxy |
| `quorum-dashboard` | http://localhost:3002 | Web UI — browse knowledge, pending decisions |
| `graphiti` | http://localhost:8001 | Python sidecar — temporal knowledge graph engine |
| `falkordb` | http://localhost:3000 | Graph database browser UI |
| `postgresql` | localhost:5432 | Audit log store (dual-store with graph) |
| `localstack` | http://localhost:4566 | AWS S3 emulation — team config bucket |
| `quorum` (MCP) | http://localhost:8000 | MCP server — run locally, not via Docker |

> **Note:** The `quorum` MCP server in Docker Compose is for integration testing only.
> In normal use, Claude Code runs it locally via `node src/server.js` (Step 4 above).

---

## Daily workflow

```bash
# Start the stack (after first setup)
docker compose up -d

# Stop the stack
docker compose down

# Stop and wipe all data (fresh start)
docker compose down -v && ./scripts/setup.sh docker

# View logs for a specific service
docker compose logs -f gateway
docker compose logs -f graphiti

# Re-seed knowledge graph
npm run seed

# Re-bootstrap LocalStack S3 (e.g. after docker compose down -v)
./scripts/init-localstack.sh
```

---

## CLI reference

The `cli.js` provides operational commands — run from the project root:

```bash
# Audit
node cli.js audit verify          # verify SHA256 chain integrity
node cli.js audit export          # export full audit log as JSONL

# Knowledge inspection
node cli.js history auth:token-strategy   # version timeline for a topic:key
node cli.js history db:migration-strategy

# Maintenance jobs (also available as npm run job:*)
node scripts/decay-confidence.js --dry-run    # preview confidence decay
node scripts/archive-audit.js    --dry-run    # preview audit archival
node scripts/recheck-conflicts.js             # re-evaluate stale conflicts
```

---

## Troubleshooting

**`setup.sh` fails at "Waiting for services to be healthy"**
```bash
# Check which service isn't starting
docker compose ps
docker compose logs <service-name>

# Common cause: Graphiti fails if OPENAI_API_KEY is wrong or unset
docker compose logs graphiti | grep -i error
```

**`awslocal` command not found**
```bash
pip install awscli-local
# If pip installs to a location not on PATH:
pip3 install awscli-local
```

**LocalStack bucket missing after restart**
```bash
# Re-run the bootstrap script — it's idempotent
./scripts/init-localstack.sh
```

**Gateway returns 500 errors**
```bash
docker compose logs gateway
# Most common: PostgreSQL not fully ready — restart the gateway
docker compose restart gateway
```

**Port already in use**
```bash
lsof -i :3001    # find what's using the gateway port
lsof -i :3002    # find what's using the dashboard port
# Change ports in .env if needed: QUORUM_GATEWAY_PORT=3011
```

**Fresh start — wipe everything and begin again**
```bash
docker compose down -v          # stop containers and delete all volumes
./scripts/setup.sh docker       # full setup from scratch
```

---

## Next steps

- [DEPLOYMENT.md](DEPLOYMENT.md) — Local K8s (Helm + Crossplane) and production deployment
- [ARCHITECTURE.md](ARCHITECTURE.md) — How Quorum works internally
- [TESTING.md](TESTING.md) — Running and writing tests
- [CONTRIBUTING.md](CONTRIBUTING.md) — Contributing guidelines
