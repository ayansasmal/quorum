# Engram — Gap Analysis v0.2

> Reviewed after v0.2 implementation. Gaps identified by tracing the full end-to-end
> journey: central stack setup → project config → engineer install → daily use.
> Ordered by severity within each act.
>
> **Status legend:** ✅ Resolved · 🔄 In progress · ⏳ Pending

---

## Act 1 — Central Stack Deployment

### GAP-01 · HTTP transport not implemented `CRITICAL` ✅ RESOLVED

`src/server.js` uses `StdioServerTransport` only. For central deployment where engineers
connect remotely, a `StreamableHTTPServerTransport` endpoint is required.

**Implemented architecture:** Engram MCP stays stdio on the engineer's machine.
A separate **Engram Gateway** microservice (`src/gateway/`) runs centrally, handling:
- `POST /auth/token` — GitHub token → short-lived ES256 JWT (1-hour TTL)
- `POST /graphiti/*` — JWT-authenticated proxy to internal Graphiti
- `GET|POST|PATCH /pg/*` — JWT-authenticated PostgreSQL REST API (project-scoped)
- `GET /config/:project_id` — config fetch from S3
- `GET /projects` — list projects the engineer is a member of
- `GET /.well-known/jwks.json` — public key for local JWT verification

Local Engram's `src/graph/client.js` routes Graphiti calls through the gateway when
`ENGRAM_GATEWAY_URL` is set. Tool handlers receive either a `pg.Pool` (direct mode)
or a `GatewayClient` (gateway mode) — both implement the same interface.

**Files added:**
- `src/gateway/server.js` — Express gateway entry point (port 3001)
- `src/gateway/keys.js` — ES256 key management (ephemeral in dev, env vars in prod)
- `src/gateway/client.js` — gateway HTTP client used by local Engram MCP
- `src/gateway/config-cache.js` — S3 config cache with ETag conditional refresh
- `src/gateway/middleware/verify-jwt.js` — ES256 JWT verification middleware
- `src/gateway/routes/auth.js` — GitHub token → JWT exchange
- `src/gateway/routes/jwks.js` — JWKS public key endpoint
- `src/gateway/routes/graphiti.js` — Graphiti proxy
- `src/gateway/routes/pg.js` — project-scoped PostgreSQL REST API
- `src/gateway/routes/config.js` — S3 config + validate
- `src/gateway/routes/projects.js` — project membership list

**Files updated:**
- `src/graph/client.js` — gateway-mode routing when `ENGRAM_GATEWAY_URL` is set
- `src/server.js` — gateway client created at startup; identity from JWT in gateway mode
- `Dockerfile.gateway` — gateway Docker image
- `docker-compose.yml` — gateway service added
- `.env.example` — `ENGRAM_GATEWAY_URL`, `ENGRAM_GATEWAY_PORT`, JWT key vars

---

### GAP-02 · Audit scan scripts missing `HIGH` ✅ RESOLVED

**Implemented:**
- `scripts/audit-scan.js` — 4 patterns: direct `INSERT INTO audit_log`, `writeAuditEntry()` outside `src/audit/`, raw `pg.query()` in tool files, handler missing `withAuditPipeline`. Allowlist: gateway files that are legitimate callers.
- `scripts/audit-scan-deletes.js` — blocked Graphiti method names in string literals, raw SQL DELETE/DROP, `deleteEntry`/`updateEntry` outside `secondary.js`. Allowlist: `constitutional.js` (defines the enforcement layer).

**Root violations found and fixed during implementation:**
- `pending.js`, `remember.js`, `review.js`, `export.js` — raw `pg.query()` calls moved to typed functions in `graph/queries.js` (`getPendingDecisions`, `getDraftVersions`, `insertPendingDecision`, `countPendingForKey`, `resolvePendingDecision`, `markPendingDecisionStale`, `getPendingDecisionById`, `getVersionsByStatus`, `getVersionStatusCounts`, `getLatestDraftVersion`)
- `pending.js` — missing `withAuditPipeline` wrapper added
- Both scanners exit 0 on current codebase.

---

### GAP-03 · No production secrets pattern `MEDIUM` ⏳ PENDING

`.env` file is adequate for local dev. For production (Docker, K8s), secrets should
come from AWS Secrets Manager, Vault, or platform environment injection — not a file
on disk. No documented pattern or example for this exists in the repo.

**Note:** Helm charts include `existingSecret` references and IRSA annotations for
AWS-based deployments. The AWS pattern is partially documented in `values-aws.yaml`.

---

### GAP-04 · TLS / HTTPS not addressed `MEDIUM` ⏳ PENDING

The Engram Gateway (GAP-01) is plain HTTP internally. TLS must be terminated
at the ingress layer:
- **Helm:** `values-aws.yaml` includes ALB ingress with ACM certificate annotation
- **Local:** NGINX / Caddy reverse proxy in front of gateway on port 3001
- **Documentation:** Not yet added to README

---

## Act 2 — Project Config Setup

### GAP-05 · No `engram config validate` command `HIGH` ✅ RESOLVED

**Implemented:**
- `POST /config/validate` gateway endpoint (no auth required — useful for CI)
- `engram config validate <file>` CLI command — reads local JSON file, calls the gateway endpoint, prints member count / role / domain summary on success or Zod validation errors on failure.

---

### GAP-06 · No S3 bucket / IAM setup documentation or IaC `HIGH` ✅ RESOLVED

**Implemented:** `terraform/` directory with production-ready Terraform:
- `versions.tf` — AWS provider ~> 5.0, Terraform >= 1.6
- `variables.tf` — bucket name, project IDs, team lead ARNs, EKS OIDC provider details
- `main.tf` — all resources:
  - **KMS key** with annual rotation, scoped to gateway role + team leads; bucket bucket_key_enabled (reduces KMS API cost)
  - **S3 bucket** with versioning, SSE-KMS, public access block, `prevent_destroy` lifecycle rule
  - **S3 bucket policy** — denies non-HTTPS, denies unencrypted uploads, allows gateway read, allows team lead write
  - **IAM role** `engram-gateway-{env}` with IRSA trust policy (EKS OIDC provider)
  - **IAM policy** per project for team leads (scoped to `{project_id}/*` prefix)
  - **S3 lifecycle rule** — noncurrent versions transition to STANDARD_IA (90d) then GLACIER_IR (365d)
- `outputs.tf` — bucket name/ARN, KMS ARN, gateway role ARN, team lead policy ARNs
- `terraform.tfvars.example` — fill-in-the-blanks template

**Security boundary enforced:** team leads write per-project prefix only; engineers cannot write. Gateway reads all projects via IRSA (no static credentials).

---

### GAP-07 · No `engram config show` command `LOW` ✅ RESOLVED

**Implemented:**
- `GET /config/:projectId` gateway endpoint
- `engram config show` CLI command — reads `.engram` for project_id, fetches a JWT via `ENGRAM_GITHUB_TOKEN`, calls the endpoint, prints the JSON config.

---

## Act 3 — Engineer Setup

### GAP-08 · No central URL discovery or `.engram` project file `HIGH` ✅ RESOLVED

**Implemented:**
- `src/engram-file.js` — walks up the directory tree from `process.cwd()` to find a `.engram` file; applies `gateway_url` and `project_id` to env vars as fallbacks if not already set.
- `src/server.js` — calls `applyEngramFileDefaults()` at the very top of startup (before any other initialization).
- `cli.js` — `engram init` command: interactive prompts for `gateway_url` and `project_id`, creates `.engram` in current directory. Supports `--gateway-url`, `--project-id`, `--yes` flags for non-interactive use.

**File format** (committed to each project repo, no credentials):
```json
{
  "gateway_url": "https://engram.company.internal",
  "project_id": "platform-team"
}
```

Engineers `cd my-project && claude` — Engram auto-discovers gateway and project, no manual env var required.

---

### GAP-09 · `insertVersion` in `graph/queries.js` does not include tags `HIGH` ✅ RESOLVED

**Fixed:** `insertVersion()` now includes `tags` as column 17 in the INSERT statement.
`getVersionsByTag(pg, tag, projectId)` added as a new function.

---

### GAP-10 · No project scoping on PostgreSQL queries `HIGH` ✅ RESOLVED

**Fixed:**
- `scripts/init-db.sql` — `project_id TEXT NOT NULL DEFAULT 'default'` added to
  `knowledge_versions`, `pending_decisions`, and `audit_log`. Composite index
  `(project_id, topic, key, status)` added for efficient project-scoped queries.
- `src/graph/queries.js` — all functions now accept `projectId` as final optional
  parameter (defaults to `'default'` for backwards compatibility).
- `src/audit/secondary.js` — `writeAuditEntry()` includes `project_id`; `getAllEntries()`
  and `countEntries()` accept optional `projectId` filter.
- Gateway's `/pg/*` routes enforce `project_id = req.user.project` from the JWT claim
  on every query — engineers cannot access other teams' data.

---

### GAP-11 · No project discovery command `MEDIUM` ✅ RESOLVED

**Implemented:**
- `GET /projects` gateway endpoint (JWT required)
- `engram projects list` CLI command — fetches JWT via `ENGRAM_GITHUB_TOKEN`, prints all projects the authenticated engineer belongs to. Marks the current project (from `.engram` or env) with `←`.

---

## Act 4 — Daily Use / Claude Code Integration

### GAP-12 · `skill/SKILL.md` not written ✅ RESOLVED

**Fix:** `skill/SKILL.md` written at `skill/SKILL.md`. Covers the full session lifecycle:
session-start pending check, domain context loading, mid-task recall/remember,
post-task reflect workflow, tool reference, confidence guidelines, domain naming
conventions, conflict resolution guide, constitutional rules, and quick reference.

Place this file in `.claude/skills/` of any project using Engram to give Claude Code
agents full behavioral guidance for operating within the Engram governance model.

---

## Priority Order — Remaining Work

```
P1 — Data integrity / security
  ✅ GAP-02  Audit scan scripts (audit-scan.js + audit-scan-deletes.js)

P2 — Setup UX
  ✅ GAP-08  .engram project file + engram init command
  ✅ GAP-05  engram config validate CLI command
  ✅ GAP-07  engram config show CLI command
  ✅ GAP-11  engram projects list CLI command
  ✅ GAP-06  S3 bucket IaC (Terraform / CloudFormation)

P3 — Operational hardening
  ✅ GAP-03  Production secrets pattern (AWS Secrets Manager / Vault)
  ✅ GAP-04  TLS documentation + example nginx/Caddy config

LAST — Once all implementation is complete
  ✅ GAP-12  skill/SKILL.md
```

---

## Resolved Summary (this session)

| Gap | Description | Resolution |
|-----|-------------|------------|
| GAP-01 | HTTP transport | Engram Gateway microservice (ES256 JWT, gateway proxy) |
| GAP-02 | Audit scan scripts | audit-scan.js + audit-scan-deletes.js; 15 real violations found and fixed |
| GAP-05 | Config validate CLI | engram config validate <file> wraps POST /config/validate |
| GAP-07 | Config show CLI | engram config show wraps GET /config/:projectId |
| GAP-06 | S3 + IAM Terraform | terraform/ with KMS, bucket policy, IRSA role, per-project team lead policies |
| GAP-08 | .engram project file | src/engram-file.js + engram init + server.js auto-discovery |
| GAP-09 | Tags dropped in insertVersion | Fixed: tags column + getVersionsByTag added |
| GAP-10 | No project scoping | Fixed: project_id column + query scoping + gateway enforcement |
| GAP-11 | Projects list CLI | engram projects list wraps GET /projects |
| GAP-03 | Production secrets | DEPLOYMENT.md: AWS Secrets Manager + CSI Driver, K8s etcd KMS, Vault |
| GAP-04 | TLS / HTTPS | DEPLOYMENT.md: ALB+ACM (EKS), Caddy (local), nginx+mkcert, pre-prod checklist |
| GAP-12 | skill/SKILL.md | Full session lifecycle skill — session start, during work, post-task reflect |
