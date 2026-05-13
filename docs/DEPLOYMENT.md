# Quorum — Deployment Guide

## Architecture: Two Parties, One Stack

Quorum has a clear split between who runs what:

```
Platform Team                          Engineers
─────────────────────────────────      ─────────────────────────────────────
Runs the central Quorum stack:         Connect from their local machine:

  gateway       :3001                    npm install -g @as-quorum/mcp
  dashboard     :3002                    quorum install   ← one-time setup
  postgresql    :5432                    quorum init      ← connect to project
  graphiti      :8001
  falkordb      :6379                  Claude Code auto-starts the MCP each
  localstack    :4566 (local/S3)       session. Engineers never touch infra.
```

The MCP server runs **locally on each engineer's machine** — not in the platform stack.
It talks to the central gateway over HTTP. Engineers never need database credentials,
Graphiti URLs, or any infrastructure config.

---

## Security Model

All traffic flows through a single path: **MCP → Gateway → Graphiti / PostgreSQL**.

```
Engineer's machine                     Platform stack
──────────────────                     ──────────────────────────────────
Claude Code (MCP client)
  └─ @as-quorum/mcp
       └─ GatewayClient ──── HTTPS ──► Gateway :3001
                  JWT + X-Quorum-Project   ├─ JWT-gated proxy ──► Graphiti :8001
                                           ├─ REST API ──────────► PostgreSQL :5432
                                           ├─ Profile/config cache ► Redis :6379
                                           └─ Config + admin ────► S3 (LocalStack in dev)
```

**Key properties:**

- The MCP never holds database credentials or raw Graphiti URLs
- `OPENAI_API_KEY` lives only on the gateway — the MCP never touches it
- `group_id` is **unconditionally injected** by the gateway from the `X-Quorum-Project` header (v0.3); any caller-supplied value in the request body is silently discarded (BL-01 fix)
- Active project is set via `X-Quorum-Project` request header — JWT is "pure identity" (`sub + is_admin` only); role and ownership are resolved per-request from the Redis profile cache
- Identity chain: GitHub OAuth → ES256 JWT (1h TTL) → `req.user.project` on every request

### Engineer Authentication Flow (OAuth 2.1 + PKCE)

Engineers authenticate once per session via the `authenticate()` MCP tool:

```
1. Claude Code calls authenticate()
2. MCP discovers /.well-known/oauth-authorization-server on gateway
3. MCP registers dynamically via POST /oauth/register → gets client_id
4. MCP generates PKCE code_verifier (32 random bytes) + code_challenge (SHA256/S256)
5. Browser opens → engineer logs in with GitHub
6. Gateway issues ES256 JWT → stored in MCP memory (cleared on restart)
7. All subsequent tool calls use: Authorization: Bearer <jwt>
```

Zero env vars needed for MCP authentication. The SDLC hooks trigger `authenticate()`
automatically at session start when the token is missing or expired.

---

## Option 1 — Docker Compose (recommended for local dev)

### What Runs

```
┌─────────────────────────────────────────────────┐
│  Platform Stack (docker-compose.yml)            │
│                                                 │
│  localstack       → S3 emulation  :4566         │
│  falkordb         → graph DB      :6379, :3000  │
│  postgresql       → audit store   :5432         │
│  graphiti         → LLM sidecar   :8001         │
│  gateway          → central API   :3001         │
│  dashboard        → web UI        :3002         │
└─────────────────────────────────────────────────┘

Note: The MCP server is NOT in this stack.
      It runs locally on each engineer's machine via Claude Code.
```

### Prerequisites

```bash
# Docker Desktop
docker --version

# Node.js 20+ (for the MCP server on engineer machines)
node --version   # v20.x.x

# awscli-local (for LocalStack S3 setup)
pip install awscli-local
```

### Setup (Platform Team)

```bash
git clone https://github.com/ayansasmal/quorum
cd quorum

# Copy environment file and fill in your OpenAI key
cp .env.example .env
# Edit .env: set OPENAI_API_KEY, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET

# One-command setup: starts stack + creates S3 bucket + uploads configs
./scripts/setup.sh docker

# Verify all components healthy
curl http://localhost:3001/health
# {"status":"healthy","components":{"postgresql":"connected","graphiti":"connected",...}}
```

### Key Environment Variables

```env
# ─────────────────────────────────────────────────────────────
# LLM — used by BOTH Gateway (governance endpoints) and Graphiti
# ─────────────────────────────────────────────────────────────
OPENAI_API_KEY=sk-...
LLM_MODEL_NAME=gpt-4o-mini
EMBEDDER_MODEL_NAME=text-embedding-3-small   # Graphiti only

# PRODUCTION ALTERNATIVE: AWS Bedrock (no API keys needed)
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
# AWS_REGION=ap-southeast-2
# LLM_MODEL_NAME=anthropic.claude-sonnet-4-5
# EMBEDDER_MODEL_NAME=amazon.titan-embed-text-v2

# ─────────────────────────────────────────────────────────────
# Gateway
# ─────────────────────────────────────────────────────────────
QUORUM_GATEWAY_PORT=3001
POSTGRES_HOST=postgresql
POSTGRES_PORT=5432
POSTGRES_DB=quorum_audit
POSTGRES_USER=quorum
POSTGRES_PASSWORD=quorum_local
GRAPHITI_URL=http://graphiti:8001
FALKORDB_HOST=falkordb
FALKORDB_PORT=6379
QUORUM_CONFIG_BUCKET=quorum-configs

# GitHub OAuth (for engineer authentication)
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...

# LocalStack / AWS S3
AWS_ENDPOINT_URL=http://localstack:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_REGION=us-east-1

# ─────────────────────────────────────────────────────────────
# MCP Server (set on engineer's machine, not in platform stack)
# ─────────────────────────────────────────────────────────────
# QUORUM_GATEWAY_URL=http://localhost:3001   ← default; change for remote gateway
# QUORUM_AUTHOR=username                     ← optional identity override
```

### Engineer Onboarding (one-time)

```bash
# Install the MCP server globally
npm install -g @as-quorum/mcp

# Install Claude Code hooks + skill (run once per machine)
quorum install

# Connect to a project
quorum init
# → prompts for gateway URL + project ID
# → writes .quorum file in the project root

# Done. Claude Code auto-starts the MCP on every session.
# Run authenticate() in Claude Code to log in via GitHub.
```

### Useful Commands

```bash
# Start full stack
./scripts/setup.sh docker

# Stop
docker compose down

# Stop and wipe all data
docker compose down -v

# View gateway logs
docker compose logs -f gateway

# Run ops audit CLI (requires QUORUM_GATEWAY_URL + valid JWT)
node scripts/audit-cli.js stats
node scripts/audit-cli.js verify
node scripts/audit-cli.js export > audit.jsonl

# Confidence decay (run on a schedule — weekly recommended)
node scripts/decay-confidence.js
```

---

## Option 2 — Local Kubernetes (Docker Desktop)

Full Helm chart deployment. Matches production orchestration. Good for testing the
Helm chart itself or prod-parity local development.

### Docker Desktop Setup

```
Docker Desktop → Settings → Resources:
  CPUs:    4 minimum (6-8 recommended)
  Memory:  see sizing guide below
  Swap:    1 GB
  Disk:    64 GB+

Docker Desktop → Settings → Kubernetes:
  ✅ Enable Kubernetes
  Click "Apply & Restart"
```

### RAM Sizing Guide

```
16GB Mac:
  Allocate to Docker Desktop: 8GB
  FalkorDB limit:  2GB
  Gateway limit:   512MB
  PostgreSQL:      512MB
  Redis limit:     256MB (maxmemory-policy: allkeys-lru)
  → Workable, close other heavy apps while running

32GB Mac:
  Allocate to Docker Desktop: 16GB
  FalkorDB limit:  4GB
  Redis limit:     256MB
  → Comfortable, no constraints
```

> **Production note (v0.3+):** Redis is a required infrastructure dependency alongside PostgreSQL, FalkorDB, and S3. Use AWS ElastiCache (Redis OSS) or equivalent managed Redis in production deployments. Configure `REDIS_URL` in the gateway environment. Recommended: `maxmemory 512mb` with `allkeys-lru` policy for production workloads.

### Verify Cluster

```bash
kubectl cluster-info
kubectl get nodes
# NAME             STATUS   ROLES           AGE   VERSION
# docker-desktop   Ready    control-plane   ...   v1.x.x
```

### Install Local Path Provisioner

```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/master/deploy/local-path-storage.yaml

kubectl patch storageclass local-path \
  -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

### Create Namespace and Secrets

```bash
kubectl create namespace quorum

kubectl create secret generic quorum-secrets \
  --namespace quorum \
  --from-literal=openai-api-key=$OPENAI_API_KEY \
  --from-literal=github-client-id=$GITHUB_CLIENT_ID \
  --from-literal=github-client-secret=$GITHUB_CLIENT_SECRET \
  --from-literal=postgres-password=quorum_local
```

### Helm Chart Structure

```
helm/quorum/
  Chart.yaml
  values.yaml           ← production defaults
  values-local.yaml     ← local overrides (lower resources)
  templates/
    gateway/
      deployment.yaml
      service.yaml
      configmap.yaml
    dashboard/
      deployment.yaml
      service.yaml
    graphiti/
      deployment.yaml
      service.yaml
    falkordb/
      statefulset.yaml
      service.yaml
      pvc.yaml
    postgresql/
      statefulset.yaml
      service.yaml
      pvc.yaml
    ingress.yaml
    _helpers.tpl
```

### Build and Deploy

```bash
# Install via Helm
helm install quorum ./helm/quorum \
  --namespace quorum \
  --values helm/quorum/values-local.yaml \
  --set secrets.existingSecret=quorum-secrets

# Watch pods come up
kubectl get pods -n quorum --watch

# Health check
kubectl port-forward -n quorum service/gateway 3001:3001 &
curl http://localhost:3001/health
```

### Useful K8s Commands

```bash
kubectl get all -n quorum
kubectl logs -n quorum deployment/gateway -f
kubectl logs -n quorum statefulset/falkordb -f

# Restart gateway after config change
kubectl rollout restart -n quorum deployment/gateway

# Upgrade Helm release
helm upgrade quorum ./helm/quorum \
  --namespace quorum \
  --values helm/quorum/values-local.yaml

# Uninstall (keeps PVCs)
helm uninstall quorum --namespace quorum

# Wipe all data
helm uninstall quorum --namespace quorum
kubectl delete pvc --all -n quorum
```

---

## Production — High Level Plan

### Targets

```
Kubernetes (any cloud):
  → Same Helm chart as local
  → values-production.yaml with proper resource sizing
  → Real StorageClass (gp3 on AWS, premium-ssd on Azure)
  → Ingress controller (nginx or cloud ALB)
  → TLS via cert-manager or ACM
  → Secrets via External Secrets Operator (AWS Secrets Manager)
  → HPA for gateway pods (FalkorDB and PostgreSQL are StatefulSets)

AWS Native:
  → Gateway on ECS Fargate
  → FalkorDB on ECS Fargate + EFS persistent volume
  → PostgreSQL on RDS (managed backups)
  → Secrets Manager for OPENAI_API_KEY, GitHub OAuth credentials, JWT keys
  → ALB for TLS termination
  → ECR for container images
```

### Production Sizing (Reference)

```
Small team (< 20 engineers):
  FalkorDB:   2GB RAM, 1 CPU
  Gateway:    512MB RAM, 0.5 CPU, 2 replicas
  PostgreSQL: 1GB RAM, 0.5 CPU

Medium team (20-100 engineers):
  FalkorDB:   4GB RAM, 2 CPU
  Gateway:    1GB RAM, 1 CPU, 3 replicas
  PostgreSQL: 2GB RAM, 1 CPU

Large org (100+ engineers, multiple teams):
  FalkorDB:   8GB RAM, 4 CPU, primary + replica
  Gateway:    2GB RAM, 2 CPU, 5+ replicas
  PostgreSQL: 4GB RAM, 2 CPU (or RDS)
```

---

## Secrets Management

`.env` files are fine for local development. In production, secrets must come from
a secrets manager — never baked into a container image or committed to git.

### What lives where

| Secret | Where |
|--------|-------|
| `OPENAI_API_KEY` | Gateway pod only (via Secrets Manager / K8s Secret) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Gateway pod only |
| `QUORUM_JWT_PRIVATE_KEY` | Gateway pod only |
| `QUORUM_JWT_PUBLIC_KEY` | Gateway pod (also served at `/.well-known/jwks.json`) |
| `POSTGRES_PASSWORD` | Gateway pod + PostgreSQL StatefulSet |
| `QUORUM_GATEWAY_URL` | Engineer's machine `.quorum` file (not a secret) |

### Option A — AWS Secrets Manager (recommended for EKS)

```bash
aws secretsmanager create-secret \
  --name "quorum/production/gateway" \
  --secret-string '{
    "POSTGRES_PASSWORD": "...",
    "QUORUM_JWT_PRIVATE_KEY": "...",
    "QUORUM_JWT_PUBLIC_KEY": "...",
    "OPENAI_API_KEY": "...",
    "GITHUB_CLIENT_ID": "...",
    "GITHUB_CLIENT_SECRET": "..."
  }'
```

Use the AWS Secrets Store CSI Driver to mount as environment variables. The gateway
pod's IRSA role needs `secretsmanager:GetSecretValue` scoped to
`arn:aws:iam::<account>:secret:quorum/production/*`.

### Option B — Kubernetes Secrets

```bash
kubectl create secret generic quorum-gateway-secrets \
  --namespace quorum \
  --from-literal=POSTGRES_PASSWORD='...' \
  --from-literal=QUORUM_JWT_PRIVATE_KEY='...' \
  --from-literal=QUORUM_JWT_PUBLIC_KEY='...' \
  --from-literal=OPENAI_API_KEY='...' \
  --from-literal=GITHUB_CLIENT_ID='...' \
  --from-literal=GITHUB_CLIENT_SECRET='...'
```

Enable KMS envelope encryption on etcd to encrypt K8s Secrets at rest.

### What never goes in git

```
.env
*.pem
*_private_key*
```

---

## TLS / HTTPS

The gateway serves plain HTTP on port 3001. TLS is terminated at the layer in front.

### Production — AWS ALB

```yaml
# helm/quorum/values-aws.yaml
gateway:
  ingress:
    enabled: true
    className: alb
    annotations:
      alb.ingress.kubernetes.io/scheme: internet-facing
      alb.ingress.kubernetes.io/certificate-arn: "arn:aws:acm:..."
      alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS": 443}]'
      alb.ingress.kubernetes.io/ssl-redirect: "443"
    hosts:
      - host: quorum.your-company.internal
        paths: [{ path: /, pathType: Prefix }]
```

Traffic flow:
```
Engineer → HTTPS :443 → ALB (TLS termination) → HTTP :3001 → Gateway pod
```

### Local dev — Caddy reverse proxy

```bash
brew install caddy

cat > Caddyfile <<'EOF'
quorum.localhost {
  reverse_proxy localhost:3001
}
EOF

caddy run
# Gateway now at https://quorum.localhost
```

Update `.quorum`:
```json
{
  "gateway_url": "https://quorum.localhost",
  "project_id": "your-project"
}
```

### Production TLS checklist

- [ ] TLS terminated at ALB (ACM cert) or ingress controller (cert-manager)
- [ ] Gateway pod only listens on HTTP internally
- [ ] `QUORUM_GATEWAY_URL` in all `.quorum` files uses `https://`
- [ ] `POSTGRES_SSL=true` in gateway environment (enables `ssl: { rejectUnauthorized: true }`)
- [ ] HTTP → HTTPS redirect enforced at the load balancer

---

## Multi-team Isolation

Quorum uses `group_id` to namespace every Graphiti operation to a specific project.

**Enforcement chain:**

1. `POST /auth/token` / `POST /oauth/token` — embeds the canonical `group_id` from the
   S3 project config as the `project` claim in the signed ES256 JWT.
2. `verifyJwt` middleware — attaches `req.user.project` from the verified JWT claim.
3. `/graphiti/*` proxy — **unconditionally overwrites** `body.params.group_id` with
   `req.user.project` before forwarding. Any caller-supplied value is discarded (BL-01).

An engineer with a JWT for `project-A` cannot read or write data belonging to `project-B`,
even if they construct a request body with `"group_id": "project-B"`.

---

## Troubleshooting

### Stack not starting

```bash
# Check all component logs
docker compose logs gateway
docker compose logs graphiti
docker compose logs falkordb

# Wipe and restart clean
docker compose down -v
./scripts/setup.sh docker
```

### Gateway health degraded

```bash
curl http://localhost:3001/health | jq .
# {"status":"degraded","components":{"graphiti":"unavailable: ...","postgresql":"connected",...}}
# Each component reports its own status with the actual error message
```

### MCP not connecting

```bash
# Check the .quorum file in your project root
cat .quorum
# {"gateway_url":"http://localhost:3001","project_id":"..."}

# Verify gateway is reachable from your machine
curl http://localhost:3001/health

# Re-run quorum install if hooks are missing
quorum install

# Re-authenticate if JWT is expired
# In Claude Code: call authenticate()
```

### Audit chain

```bash
# Verify chain integrity via gateway (no direct DB access needed)
node scripts/audit-cli.js verify
# ✅ Chain verified: 247 entries, no tampering detected

node scripts/audit-cli.js stats
node scripts/audit-cli.js export > audit.jsonl
```

### FalkorDB

```bash
# Check FalkorDB directly (local dev only)
redis-cli -p 6379 ping          # PONG
redis-cli -p 6379 GRAPH.LIST    # list graphs
redis-cli -p 6379 INFO memory   # memory usage (expect < 200MB in dev)

# FalkorDB browser UI (local dev)
open http://localhost:3000
```
