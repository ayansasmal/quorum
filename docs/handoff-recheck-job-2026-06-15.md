# Handoff: recheck-job fix — 2026-06-15

**For:** Codex  
**Branch:** `prod`  
**Repo:** `github.com/ayansasmal/quorum`  
**Prod host:** EC2 `quorum-prod` (`i-069de552b4a50b77b`), region `ap-southeast-2`

---

## What is the recheck job?

`quorum-recheck.service` is a systemd oneshot timer that runs every 5 minutes on EC2.

It processes `knowledge_versions` rows with `status = 'PENDING_CONFLICT_CHECK'`. These are created by the MCP `remember` tool (GAP-03 path) when Graphiti is unavailable at write time — instead of blocking the write, the entry is stored immediately and flagged for a deferred conflict check.

The job:
1. Fetches up to 50 `PENDING_CONFLICT_CHECK` rows
2. Pings Graphiti — if still down, exits early
3. For each row: runs `detectConflict()` → promotes to `ACTIVE` (or stays `DRAFT` for claude/reflect authors) or sets to `DRAFT` if a conflict is found
4. Writes an audit entry for each processed row

When working correctly, this is how deferred entries surface in the dashboard **Pending** tab after conflict detection runs.

---

## Current status

There are **5 entries** stuck as `PENDING_CONFLICT_CHECK` in prod. The job has been silently failing for days. Three bugs were found and fixed; a **fourth fix is committed but not yet deployed**.

---

## Fixes applied (all deployed — current prod image: `sha-a418dd5`)

### Fix 1 — `Dockerfile.gateway` missing `scripts/` directory
**Commit:** `sha-86096db`  
**Symptom:** `Error: Cannot find module '/app/scripts/recheck-conflicts.js'`  
**Root cause:** `Dockerfile.gateway` (runtime stage) had `COPY gateway/ ./gateway/` but no `COPY scripts/ ./scripts/`. The job scripts live at repo root `scripts/`, not inside `gateway/`.  
**File:** `Dockerfile.gateway`

### Fix 2 — No SSL on `pg.Pool` in job scripts
**Commit:** `sha-eddb649`  
**Symptom:** `Fatal error: no pg_hba.conf entry for host "10.20.1.202", user "quorum", database "quorum_audit", no encryption`  
**Root cause:** All three job scripts (`recheck-conflicts.js`, `decay-confidence.js`, `archive-audit.js`) created `pg.Pool` without the SSL config that RDS requires. The gateway uses `POSTGRES_SSL=true` → `{ rejectUnauthorized: true }`. The scripts didn't.  
**Files:** `scripts/recheck-conflicts.js`, `scripts/decay-confidence.js`, `scripts/archive-audit.js`

### Fix 3 — Wrong column names in `recheck-conflicts.js` SQL
**Commit:** `sha-a418dd5`  
**Symptom:** `Fatal error: column "id" does not exist`  
**Root cause:** The SQL in `recheck-conflicts.js` used wrong column names. The `knowledge_versions` table schema (see `scripts/init-db.sql:81`) has:
- PK: `version_id` (not `id`)
- Content: `summary` (not `content`)
- Project FK: `q_project_id` (not `project_id`)

The `audit_log` table also uses `q_project_id` (not `project_id`).  
**File:** `scripts/recheck-conflicts.js`

---

## Fix 4 — `QUORUM_GATEWAY_URL` routes Graphiti calls through the proxy (NOT YET DEPLOYED)

**Commit:** `sha-f4c4b28`  
**Branch:** pushed to `prod` — CI should be building now

### Symptom (current prod behaviour)
```
[recheck-conflicts] Found 5 row(s) to re-check
[recheck-conflicts] Graphiti became unavailable mid-run — stopping
[recheck-conflicts] Done — promoted: 0, conflicted: 0, deferred: 5
```

Job finds the rows (SQL fix worked) but `detectConflict()` immediately returns `{ graphiti_unavailable: true }` on every row.

### Root cause

`quorum.env` on the EC2 host (`/etc/quorum/quorum.env`) contains:
```
QUORUM_GATEWAY_URL='https://quorum-gateway.ayansasmal.work'
```

All job containers source this file (via `env_file` in the compose service). This sets `QUORUM_GATEWAY_URL` inside the job container.

`gateway/src/shared/graph/client.js:68-73` — `graphitiTarget()`:
```javascript
function graphitiTarget() {
  const gatewayUrl = process.env.QUORUM_GATEWAY_URL
  if (gatewayUrl) {
    return { baseUrl: `${gatewayUrl.replace(/\/$/, '')}/graphiti`, useGateway: true }
  }
  return { baseUrl: GRAPHITI_URL, useGateway: false }   // GRAPHITI_URL = http://graphiti:8000
}
```

**When `QUORUM_GATEWAY_URL` is set, `searchNodes` routes Graphiti calls through the gateway's `/graphiti/*` HTTP proxy instead of calling Graphiti directly.**

The gateway proxy (`routes/graphiti.js`) is JWT-gated. Job containers have no JWT. Result: 401 response → `GraphitiConnectionError` → caught by `detectConflict`'s try/catch at line 177 → returns `{ conflict: false, graphiti_unavailable: true }`.

The ping check (`pingGraphiti()` at the top of `main()`) calls `${GRAPHITI_URL}/health` **directly** (not through the client module), so it succeeds — the liveness gate passes but the actual conflict check fails. This made the bug invisible until deeper analysis.

### Fix applied

`crossplane/bootstrap/docker-compose.aws.yml` — added `environment` override to `recheck-job`:

```yaml
  recheck-job:
    image: ${IMAGE_REGISTRY}/quorum-gateway:${GATEWAY_TAG}
    profiles: [jobs]
    env_file: ["${QUORUM_ENV_FILE:-/etc/quorum/quorum.env}"]
    environment:
      QUORUM_GATEWAY_URL: ""    # ← overrides env_file; forces direct Graphiti access
    volumes:
      - /etc/quorum/rds-global-bundle.pem:/etc/quorum/rds-global-bundle.pem:ro
    command: ["npm", "run", "job:recheck"]
```

Blank string overrides the `env_file` value → `graphitiTarget()` falls through to the `else` branch → calls `http://graphiti:8000` directly (trusted internal Docker network, no auth needed).

---

## What Codex needs to do

### Step 1 — Verify CI built `sha-f4c4b28`
```bash
gh run list --workflow=build.yml --branch prod --limit 3
```
Wait for the top run (commit message: "fix(ops): override quorum_gateway_url in recheck-job...") to show `completed / success`.

### Step 2 — Verify image exists in GHCR
```bash
docker manifest inspect ghcr.io/ayansasmal/quorum-gateway:sha-f4c4b28 >/dev/null && echo "image present" || echo "IMAGE MISSING"
```
Do not proceed if the image is missing.

### Step 3 — Get user approval, then deploy

**Tell the user:** "I'm about to repin `GATEWAY_TAG` in prod secret `quorum/prod/gateway` to `sha-f4c4b28` and re-converge prod EC2 `quorum-prod` over SSM (ap-southeast-2). Please confirm."

After approval:

```bash
# Repin secret (read-modify-write — never print the full secret)
aws secretsmanager get-secret-value \
  --secret-id quorum/prod/gateway \
  --region ap-southeast-2 \
  --query SecretString --output text \
  | jq -c '.GATEWAY_TAG="sha-f4c4b28"' \
  | aws secretsmanager put-secret-value \
      --secret-id quorum/prod/gateway \
      --region ap-southeast-2 \
      --secret-string file:///dev/stdin

# Re-converge (re-pulls image + updates docker-compose.aws.yml from the secret env vars on host)
cd /Users/ayan/Desktop/Work/vscode/qc/quorum
AWS_REGION=ap-southeast-2 INSTANCE_NAME=quorum-prod \
  bash crossplane/ops/quorum-restart.sh full
```

### Step 4 — Verify gateway health
```bash
curl -s https://quorum-gateway.ayansasmal.work/health | jq .
```
Expect: `"status": "healthy"` with all 5 components (`postgresql`, `graphiti`, `falkordb`, `redis`, `s3`) showing `"connected"`.

### Step 5 — Trigger recheck job and confirm it processes the 5 pending entries

```bash
INSTANCE_ID="i-069de552b4a50b77b"
CMD_ID=$(aws ssm send-command \
  --region ap-southeast-2 \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["systemctl start quorum-recheck.service && sleep 12 && journalctl -u quorum-recheck.service -n 30 --no-pager"]' \
  --query "Command.CommandId" --output text)
echo "SSM: $CMD_ID"
sleep 20
aws ssm get-command-invocation \
  --region ap-southeast-2 \
  --command-id "$CMD_ID" \
  --instance-id "$INSTANCE_ID" \
  --query 'StandardOutputContent' \
  --output text
```

**Expected success output:**
```
[recheck-conflicts] Starting deferred conflict re-check run
[recheck-conflicts] Found 5 row(s) to re-check
[recheck-conflicts] <topic>:<key> v<N> promoted to ACTIVE
...
[recheck-conflicts] Done — promoted: 5, conflicted: 0, deferred: 0
```
(Exact numbers depend on whether actual conflicts are detected. `deferred: 0` is the key — means Graphiti is working.)

**If `Graphiti became unavailable mid-run` still appears:** Graphiti itself has an issue — check `docker compose logs graphiti` on the EC2 host. This is a separate problem from the compose fix.

### Step 6 — Check dashboard Pending tab
Any entries where a conflict was detected (→ `conflicted: N`) will appear in the dashboard Pending tab at `https://quorum-gateway.ayansasmal.work` (the dashboard SPA at port 3002, or wherever it's served).

---

## Key files

| File | Relevance |
|------|-----------|
| `scripts/recheck-conflicts.js` | The job script — all 3 SQL fixes are here |
| `scripts/init-db.sql:81-113` | `knowledge_versions` schema — confirms `version_id`, `summary`, `q_project_id` |
| `gateway/src/shared/graph/client.js:68-73` | `graphitiTarget()` — the routing switch |
| `gateway/src/shared/governance/conflict.js:164-181` | `detectConflict()` — `graphiti_unavailable` catch |
| `crossplane/bootstrap/docker-compose.aws.yml` | Job service definitions — Fix 4 is here |
| `Dockerfile.gateway` | Runtime stage — Fix 1 (`COPY scripts/`) is here |

---

## Memory to update after deployment

Update `memory/project-prod-gateway-tag-pin.md` with:
- New deployed tag: `sha-f4c4b28`
- Result of the recheck job run (how many promoted/conflicted)
- Whether the dashboard Pending tab now shows entries
