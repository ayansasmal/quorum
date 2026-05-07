# Quorum — Deployment Guide

## Overview

Quorum supports three deployment targets. This document covers the first two in detail. Production deployment is documented at a high level — implementation comes later.

```
1. Docker Compose     → simplest, zero K8s, good for first run
2. Local K8s          → Docker Desktop, full Helm chart, matches prod
3. Production         → real cluster or AWS (documented, not yet implemented)
```

---

## Prerequisites

### All Deployments
```bash
# Node.js 20+
node --version   # v20.x.x

# Docker Desktop (includes both Docker and K8s)
# Download: https://www.docker.com/products/docker-desktop/
docker --version
```

### Local K8s Only
```bash
# kubectl (comes with Docker Desktop)
kubectl version --client

# Helm 3
brew install helm
helm version
```

### Required API Keys
```bash
# Anthropic API key (for LLM governance + conflict detection)
# Get one at: https://console.anthropic.com
export ANTHROPIC_API_KEY=sk-ant-...
```

---

## Option 1 — Docker Compose

Simplest path. No K8s required. Good for first-time setup and local development.

### What Runs

```
┌─────────────────────────────────────────────────┐
│  Docker Compose Stack                           │
│                                                 │
│  localstack       → S3 emulation  :4566         │
│  falkordb         → graph DB      :6379, :3000  │
│  postgresql       → audit store   :5432         │
│  graphiti         → LLM sidecar   :8001         │
│  gateway          → central API   :3001         │
│  quorum-dashboard → web UI        :3002         │
│  quorum           → MCP server    :8000 (test)  │
└─────────────────────────────────────────────────┘
```

Graphiti is Python-only — it has no npm package. It runs as a Docker sidecar.
Quorum never imports Graphiti — it calls it over HTTP.

### Setup

```bash
# Clone
git clone https://github.com/ayansasmal/quorum
cd quorum

# Copy environment file and add your OpenAI key
cp .env.example .env

# One-command setup (requires Docker Desktop + pip install awscli-local)
./scripts/setup.sh docker

# Verify audit chain
node scripts/audit-cli.js verify
```

### Environment Variables

```env
# .env.example

# ─────────────────────────────────────────────
# Graphiti sidecar LLM config (Python — not Quorum Node.js)
# ─────────────────────────────────────────────

# LOCAL DEV: OpenAI (recommended — proven stable with Graphiti)
OPENAI_API_KEY=sk-...
LLM_MODEL_NAME=gpt-4o-mini
EMBEDDER_MODEL_NAME=text-embedding-3-small

# PRODUCTION ALTERNATIVE: AWS Bedrock (enterprise — no API keys needed)
# Uncomment and remove OPENAI_API_KEY above
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
# AWS_REGION=ap-southeast-2
# LLM_MODEL_NAME=anthropic.claude-sonnet-4-5
# EMBEDDER_MODEL_NAME=amazon.titan-embed-text-v2

# ─────────────────────────────────────────────
# Quorum MCP Server (Node.js)
# ─────────────────────────────────────────────

# Graphiti sidecar URL (set automatically in docker-compose)
GRAPHITI_URL=http://graphiti:8000

# Graph DB — FalkorDB
FALKORDB_URI=redis://falkordb:6379

# Audit secondary store — PostgreSQL
POSTGRES_HOST=postgresql
POSTGRES_PORT=5432
POSTGRES_DB=quorum_audit
POSTGRES_USER=quorum
POSTGRES_PASSWORD=quorum_local

# Quorum config
QUORUM_PORT=8000
QUORUM_GROUP_ID=default
QUORUM_CONFLICT_THRESHOLD=0.85
QUORUM_AUTHORITY_THRESHOLD=0.20
NODE_ENV=development

# LocalStack / AWS S3 (set automatically in docker-compose.yml; shown for reference)
AWS_ENDPOINT_URL=http://localstack:4566
AWS_ACCESS_KEY_ID=test                    # LocalStack dummy
AWS_SECRET_ACCESS_KEY=test                # LocalStack dummy
AWS_REGION=us-east-1
QUORUM_CONFIG_BUCKET=quorum-configs
```

### Docker Compose File

```yaml
# docker-compose.yml
version: '3.8'

services:
  falkordb:
    image: falkordb/falkordb:latest
    ports:
      - "6379:6379"
      - "3000:3000"
    volumes:
      - falkordb_data:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  postgresql:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: quorum_audit
      POSTGRES_USER: quorum
      POSTGRES_PASSWORD: quorum_local
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./scripts/init-db.sql:/docker-entrypoint-initdb.d/init.sql
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U quorum"]
      interval: 10s
      timeout: 5s
      retries: 5

  quorum:
    build: .
    ports:
      - "8000:8000"
    env_file:
      - .env
    depends_on:
      falkordb:
        condition: service_healthy
      postgresql:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 15s
      timeout: 5s
      retries: 3

volumes:
  falkordb_data:
  postgres_data:
```

### Seed Data

```bash
# Load sample engineering knowledge (with deliberate contradictions for demo)
npm run seed

# Verify knowledge was loaded
curl http://localhost:8000/health
# {"status":"healthy","graph":"connected","audit":"connected"}
```

### Connect to Claude Code

```bash
# Add Quorum as an MCP server
claude mcp add quorum -- node /path/to/quorum/src/server.js

# Or via HTTP if MCP server is running
claude mcp add quorum --url http://localhost:8000/mcp

# Verify connection
claude "What does Quorum know about auth?"
```

### FalkorDB Browser UI

Open http://localhost:3000 in your browser to visually inspect the knowledge graph. Useful for debugging and demos.

### Useful Commands

```bash
# Start
docker compose up -d

# Stop
docker compose down

# Stop and wipe all data (fresh start)
docker compose down -v

# View logs
docker compose logs -f quorum
docker compose logs -f falkordb

# Restart just Quorum (after code changes)
docker compose restart quorum

# Shell into Quorum container
docker compose exec quorum sh

# Verify audit chain integrity
docker compose exec quorum node cli.js audit verify

# Export audit log
docker compose exec quorum node cli.js audit export > audit.jsonl
```

---

## Option 2 — Local Kubernetes (Docker Desktop)

Full Helm chart deployment on your local K8s cluster. Identical to production — same manifests, different sizing. Good for developing and testing the Helm chart itself.

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
  Wait for K8s indicator to go green (bottom left of Docker Desktop)
```

### RAM Sizing Guide

```
16GB Mac:
  Allocate to Docker Desktop: 8GB
  FalkorDB limit:  2GB
  Quorum limit:    1GB
  PostgreSQL:      512MB
  OS + apps:       8GB
  → Workable, close other heavy apps while running

32GB Mac:
  Allocate to Docker Desktop: 16GB
  FalkorDB limit:  4GB
  Quorum limit:    1GB
  PostgreSQL:      512MB
  → Comfortable, no constraints

64GB Mac (M3 Max etc):
  Allocate to Docker Desktop: 24GB
  → No constraints at all
```

**Honest note on FalkorDB memory:** For realistic Quorum usage (500-2000 knowledge nodes for an engineering team), FalkorDB uses ~200-500MB. The 2-4GB limits are headroom, not requirements. You won't hit them during development.

### Verify Cluster

```bash
kubectl cluster-info
# Kubernetes control plane is running at https://127.0.0.1:6443

kubectl get nodes
# NAME             STATUS   ROLES           AGE   VERSION
# docker-desktop   Ready    control-plane   ...   v1.x.x
```

### Install Local Path Provisioner

Docker Desktop's default storage provisioner works but local-path is more reliable for stateful workloads:

```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/master/deploy/local-path-storage.yaml

# Set as default storage class
kubectl patch storageclass local-path \
  -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

# Verify
kubectl get storageclass
# NAME                   PROVISIONER             DEFAULT
# local-path (default)   rancher.io/local-path   true
```

### Create Namespace and Secrets

```bash
# Create namespace
kubectl create namespace quorum

# Create secret for API keys
kubectl create secret generic quorum-secrets \
  --namespace quorum \
  --from-literal=anthropic-api-key=$ANTHROPIC_API_KEY \
  --from-literal=postgres-password=quorum_local \
  --from-literal=falkordb-password=""
```

### Helm Chart Structure

```
helm/quorum/
  Chart.yaml            ← chart metadata
  values.yaml           ← production defaults
  values-local.yaml     ← local overrides (lower resources)
  templates/
    quorum/
      deployment.yaml
      service.yaml
      configmap.yaml
      hpa.yaml
    falkordb/
      statefulset.yaml
      service.yaml
      pvc.yaml
    postgresql/
      statefulset.yaml
      service.yaml
      pvc.yaml
    ingress.yaml        ← optional
    _helpers.tpl
```

### values-local.yaml

```yaml
# helm/quorum/values-local.yaml
# Local Docker Desktop overrides — lower resource limits

global:
  storageClass: local-path
  imageTag: latest
  imagePullPolicy: Always  # always pull latest in dev

quorum:
  replicas: 1
  image: quorum:local      # built locally
  port: 8000
  resources:
    requests:
      memory: "256Mi"
      cpu: "250m"
    limits:
      memory: "1Gi"
      cpu: "500m"
  config:
    groupId: default
    conflictThreshold: "0.85"
    authorityThreshold: "0.20"
    nodeEnv: development
    logLevel: debug

falkordb:
  image: falkordb/falkordb:latest
  port: 6379
  uiPort: 3000
  resources:
    requests:
      memory: "512Mi"
      cpu: "250m"
    limits:
      memory: "2Gi"      # 16GB Mac
      cpu: "1000m"
  persistence:
    size: 10Gi
    storageClass: local-path

postgresql:
  image: postgres:16-alpine
  port: 5432
  database: quorum_audit
  username: quorum
  resources:
    requests:
      memory: "256Mi"
      cpu: "100m"
    limits:
      memory: "512Mi"
      cpu: "250m"
  persistence:
    size: 5Gi
    storageClass: local-path

# Disable features not needed locally
ingress:
  enabled: false

monitoring:
  enabled: false        # enable when you want Prometheus/Grafana

autoscaling:
  enabled: false        # single replica locally
```

### Build and Deploy

```bash
# Build local Docker image
docker build -t quorum:local .

# Install via Helm
helm install quorum ./helm/quorum \
  --namespace quorum \
  --values helm/quorum/values-local.yaml \
  --set secrets.existingSecret=quorum-secrets

# Watch pods come up
kubectl get pods -n quorum --watch

# NAME                    READY   STATUS    RESTARTS   AGE
# quorum-xxx-yyy          0/1     Init:0/1  0          5s
# falkordb-0              0/1     Pending   0          5s
# postgresql-0            0/1     Pending   0          5s
# ...
# quorum-xxx-yyy          1/1     Running   0          45s
# falkordb-0              1/1     Running   0          30s
# postgresql-0            1/1     Running   0          25s
```

### Verify Deployment

```bash
# Check all pods running
kubectl get pods -n quorum
# All should show 1/1 Running

# Check services
kubectl get services -n quorum
# NAME         TYPE        CLUSTER-IP    PORT(S)
# quorum       ClusterIP   10.x.x.x      8000/TCP
# falkordb     ClusterIP   10.x.x.x      6379/TCP, 3000/TCP
# postgresql   ClusterIP   10.x.x.x      5432/TCP

# Port-forward Quorum to localhost
kubectl port-forward -n quorum service/quorum 8000:8000 &

# Port-forward FalkorDB UI
kubectl port-forward -n quorum service/falkordb 3000:3000 &

# Health check
curl http://localhost:8000/health
# {"status":"healthy","graph":"connected","audit":"connected","version":"0.1.0"}
```

### Connect to Claude Code

```bash
# Quorum is now available at localhost:8000 via port-forward
claude mcp add quorum --url http://localhost:8000/mcp

# Verify
claude "What does Quorum know about auth?"
```

### Seed Data on K8s

```bash
# Run seed job
kubectl apply -f helm/quorum/templates/jobs/seed.yaml

# Or exec into pod
kubectl exec -it -n quorum deployment/quorum -- node cli.js seed

# Verify
kubectl exec -it -n quorum deployment/quorum -- node cli.js audit verify
```

### Useful K8s Commands

```bash
# Get all resources in namespace
kubectl get all -n quorum

# View Quorum logs
kubectl logs -n quorum deployment/quorum -f

# View FalkorDB logs
kubectl logs -n quorum statefulset/falkordb -f

# Shell into Quorum pod
kubectl exec -it -n quorum deployment/quorum -- sh

# Restart Quorum (after image rebuild)
docker build -t quorum:local .
kubectl rollout restart -n quorum deployment/quorum

# Upgrade Helm release (after values change)
helm upgrade quorum ./helm/quorum \
  --namespace quorum \
  --values helm/quorum/values-local.yaml \
  --set secrets.existingSecret=quorum-secrets

# Uninstall (keeps PVCs — data survives)
helm uninstall quorum --namespace quorum

# Uninstall and wipe all data
helm uninstall quorum --namespace quorum
kubectl delete pvc --all -n quorum

# Check resource usage
kubectl top pods -n quorum
```

### Development Workflow on K8s

```bash
# Typical iteration loop:

# 1. Make code changes
vim src/tools/remember.js

# 2. Rebuild image
docker build -t quorum:local .

# 3. Restart pod (picks up new image)
kubectl rollout restart -n quorum deployment/quorum

# 4. Watch pod restart
kubectl get pods -n quorum --watch

# 5. Test
curl http://localhost:8000/health
claude "Test remember and recall"
```

### S3 Config Bucket (Local K8s)

When running on Local K8s, provision the Quorum config S3 bucket via Crossplane:

```bash
# Requires LocalStack started with LOCALSTACK_HOST set
LOCALSTACK_HOST=host.docker.internal localstack start -d

# One-command setup: Crossplane + provider + bucket + sample configs
./crossplane/crossplane.sh setup

# Verify
awslocal s3 ls s3://quorum-configs/ --recursive
```

See [`crossplane/README.md`](crossplane/README.md) for full details, including the critical
`endpoint.services: [s3, sts]` requirement and CoreDNS patching notes.

For production, use Crossplane with IRSA instead of static credentials — see
[`crossplane/README.md#production-upgrade-irsa`](crossplane/README.md#production-upgrade-irsa-instead-of-static-keys).

---

## Choosing Between Docker Compose and Local K8s

```
Use Docker Compose if:
  → First time setting up Quorum
  → You just want to try it quickly
  → You don't need K8s for anything else
  → You're building/testing the MCP tools themselves

Use Local K8s if:
  → You're building/testing the Helm chart
  → You want prod-parity in your local environment
  → You're testing K8s-specific behaviour (health checks, restarts, PVCs)
  → You already have Docker Desktop K8s running for other projects
```

Both run the exact same Quorum code. The difference is purely operational — how the containers are orchestrated.

---

## Production — High Level Plan

Production deployment is not implemented yet. This section documents the intended approach.

### Targets

```
Kubernetes (any cloud):
  → Same Helm chart as local
  → values-production.yaml with proper resource sizing
  → Real StorageClass (gp3 on AWS, premium-ssd on Azure)
  → Ingress controller (nginx or cloud-native)
  → TLS via cert-manager
  → Secrets via External Secrets Operator (AWS Secrets Manager)
  → HPA for Quorum pods (FalkorDB and PostgreSQL are StatefulSets)

AWS Native:
  → Quorum on ECS Fargate
  → FalkorDB on ECS Fargate + EFS persistent volume
  → PostgreSQL on RDS (managed, backups handled)
  → Amazon Neptune (optional — only at very large graph scale)
  → Secrets Manager for API keys
  → ALB for load balancing
  → ECR for container images
  → Crossplane for all infrastructure
```

### Production Sizing (Reference)

```
Small team (< 20 engineers):
  FalkorDB:   2GB RAM, 1 CPU
  Quorum:     512MB RAM, 0.5 CPU, 2 replicas
  PostgreSQL: 1GB RAM, 0.5 CPU

Medium team (20-100 engineers):
  FalkorDB:   4GB RAM, 2 CPU
  Quorum:     1GB RAM, 1 CPU, 3 replicas
  PostgreSQL: 2GB RAM, 1 CPU

Large org (100+ engineers, multiple teams):
  FalkorDB:   8GB RAM, 4 CPU, primary + replica
  Quorum:     2GB RAM, 2 CPU, 5+ replicas
  PostgreSQL: 4GB RAM, 2 CPU (or RDS)
  Consider:   Amazon Neptune at this scale
```

### Production Roadmap

```
v0.2 → Helm chart production values + AWS Terraform
v0.3 → CI/CD pipeline (GitHub Actions → ECR → ECS/K8s)
v0.4 → Monitoring stack (Prometheus + Grafana dashboards)
v1.0 → One-command production deploy via npx quorum deploy
```

---

## Troubleshooting

### Docker Compose

```bash
# Container not starting — check logs
docker compose logs quorum

# FalkorDB connection refused
docker compose logs falkordb
# Wait for "Ready to accept connections" in logs
# Quorum has health check dependency — will retry

# Port already in use
lsof -i :8000  # find what's using the port
# Change port in .env: QUORUM_PORT=8001

# Fresh start — wipe everything
docker compose down -v
docker compose up -d
```

### Local K8s

```bash
# Pod stuck in Pending
kubectl describe pod -n quorum <pod-name>
# Usually: PVC not bound, insufficient resources, image pull issue

# PVC not binding
kubectl get pvc -n quorum
kubectl describe pvc -n quorum <pvc-name>
# Check storageClass is correct: local-path

# Image pull error (quorum:local)
# Must build image first: docker build -t quorum:local .
# Docker Desktop K8s shares the local Docker daemon — no push needed

# Port-forward died
kubectl port-forward -n quorum service/quorum 8000:8000 &
# Add & to background it, or run in a separate terminal

# K8s not enabled in Docker Desktop
# Docker Desktop → Settings → Kubernetes → Enable Kubernetes → Apply & Restart

# Node not ready
kubectl get nodes
kubectl describe node docker-desktop
# Usually resolves itself — Docker Desktop K8s can take 2-3 min to start

# Resource limits hit (OOMKilled)
kubectl describe pod -n quorum <pod-name>
# Increase memory limits in values-local.yaml
# Or allocate more RAM to Docker Desktop
```

### FalkorDB

```bash
# Check FalkorDB is responding
redis-cli -p 6379 ping
# PONG

# View graph statistics
redis-cli -p 6379 GRAPH.LIST

# Check memory usage
redis-cli -p 6379 INFO memory
# used_memory_human: shows actual usage
# For Quorum dev usage, expect < 100MB
```

### Audit Chain

```bash
# Verify chain integrity
node cli.js audit verify
# ✅ Chain verified: 247 entries, no tampering detected

# If chain is broken (should not happen in normal operation)
node cli.js audit diagnose
# Shows which entry broke the chain and when
```

---

## Production Secrets Management (GAP-03)

`.env` files are fine for local development. In production, secrets must come from
a secrets manager — never from a file on disk inside the container.

### Why not `.env` in production

- A file on disk can be read by anyone with container exec access
- Secrets in environment variables injected from a file survive container restarts but
  are visible in `docker inspect` output
- AWS Secrets Manager and Vault provide rotation, audit trails, and fine-grained access control

### Option A — AWS Secrets Manager (recommended for EKS)

Store all Quorum Gateway secrets as a single JSON secret:

```bash
# Create the secret
aws secretsmanager create-secret \
  --name "quorum/production/gateway" \
  --description "Quorum Gateway production secrets" \
  --secret-string '{
    "POSTGRES_PASSWORD": "...",
    "QUORUM_JWT_PRIVATE_KEY": "...",
    "QUORUM_JWT_PUBLIC_KEY": "...",
    "OPENAI_API_KEY": "..."
  }'
```

In EKS, use the **AWS Secrets Store CSI Driver** to mount secrets as environment variables:

```yaml
# helm/quorum/values-aws.yaml (already includes this pattern)
gateway:
  secretsManager:
    enabled: true
    secretName: "quorum/production/gateway"
    region: "ap-southeast-2"

# The Helm chart mounts the secret via SecretProviderClass.
# No secret values appear in values.yaml or Kubernetes Secret objects.
```

The gateway pod's IRSA role must have `secretsmanager:GetSecretValue` and
`secretsmanager:DescribeSecret` permissions scoped to
`arn:aws:iam::<account>:secret:quorum/production/*`.

### Option B — Kubernetes Secrets (simpler, less secure)

If you are not on EKS or do not want Secrets Manager:

```bash
# Create the Kubernetes secret
kubectl create secret generic quorum-gateway-secrets \
  --namespace quorum \
  --from-literal=POSTGRES_PASSWORD='...' \
  --from-literal=QUORUM_JWT_PRIVATE_KEY='...' \
  --from-literal=QUORUM_JWT_PUBLIC_KEY='...' \
  --from-literal=OPENAI_API_KEY='...'
```

Reference in Helm `values-aws.yaml`:

```yaml
gateway:
  existingSecret: "quorum-gateway-secrets"
```

The Helm chart reads `existingSecret` and injects the keys as environment variables
via `envFrom.secretRef`. No plaintext values appear in the chart.

**Limitation:** Kubernetes Secrets are base64-encoded, not encrypted by default.
Enable [KMS envelope encryption](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/)
for the etcd data store to encrypt secrets at rest.

### Option C — HashiCorp Vault

If your organisation runs Vault:

```bash
# Write secrets to Vault
vault kv put secret/quorum/production \
  POSTGRES_PASSWORD="..." \
  QUORUM_JWT_PRIVATE_KEY="..." \
  QUORUM_JWT_PUBLIC_KEY="..."
```

Use the [Vault Agent Sidecar Injector](https://developer.hashicorp.com/vault/docs/platform/k8s/injector)
or [Vault Secrets Operator](https://developer.hashicorp.com/vault/docs/platform/k8s/vso) to
inject secrets into the gateway pod at startup.

### Local dev with LocalStack

In Docker Compose mode, `AWS_ENDPOINT_URL=http://localstack:4566` and dummy credentials
(`AWS_ACCESS_KEY_ID=test`, `AWS_SECRET_ACCESS_KEY=test`) are set automatically in
`docker-compose.yml`. Run `./scripts/init-localstack.sh` manually if you need to
re-bootstrap the S3 bucket.

### What never goes in git

```
.env                          # gitignored
*.pem                         # any certificate private keys
*_private_key*                # JWT signing keys
```

---

## TLS / HTTPS (GAP-04)

The Quorum Gateway (`src/gateway/server.js`) serves plain HTTP on port 3001.
TLS must be terminated at the layer in front of it. The gateway never needs to
handle TLS directly — this is standard practice for internal microservices.

### Production — AWS ALB (EKS)

The Helm chart (`helm/quorum/values-aws.yaml`) already includes an ALB Ingress
annotation for ACM certificate termination:

```yaml
# helm/quorum/values-aws.yaml
gateway:
  ingress:
    enabled: true
    className: alb
    annotations:
      kubernetes.io/ingress.class: alb
      alb.ingress.kubernetes.io/scheme: internet-facing
      alb.ingress.kubernetes.io/certificate-arn: "arn:aws:acm:ap-southeast-2:ACCOUNT:certificate/CERT-ID"
      alb.ingress.kubernetes.io/ssl-policy: ELBSecurityPolicy-TLS13-1-2-2021-06
      alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS": 443}]'
      alb.ingress.kubernetes.io/ssl-redirect: "443"
    hosts:
      - host: quorum.your-company.internal
        paths:
          - path: /
            pathType: Prefix
```

Traffic flow:
```
Engineer → HTTPS :443 → ALB (TLS termination, ACM cert) → HTTP :3001 → Gateway pod
```

The ALB handles the certificate — no cert files inside the pod.

### Local dev — Caddy reverse proxy

Caddy is the simplest local TLS option. It auto-generates a self-signed certificate
trusted by your local machine:

```bash
# Install
brew install caddy

# Create Caddyfile in the quorum root
cat > Caddyfile <<'EOF'
quorum.localhost {
  reverse_proxy localhost:3001
}
EOF

# Start
caddy run

# Now the gateway is available at https://quorum.localhost
# Caddy auto-generates a certificate trusted by your OS keychain
```

Update `.quorum` to use HTTPS:
```json
{
  "gateway_url": "https://quorum.localhost",
  "project_id": "platform-team"
}
```

### Local dev — nginx reverse proxy

If you prefer nginx:

```nginx
# /usr/local/etc/nginx/servers/quorum.conf
server {
    listen 443 ssl;
    server_name quorum.localhost;

    ssl_certificate     /path/to/quorum.localhost+1.pem;
    ssl_certificate_key /path/to/quorum.localhost+1-key.pem;

    location / {
        proxy_pass         http://localhost:3001;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

Generate a locally-trusted certificate with [mkcert](https://github.com/FiloSottile/mkcert):

```bash
brew install mkcert
mkcert -install                           # installs local CA into OS keychain
mkcert quorum.localhost 127.0.0.1         # generates the cert + key pair
# → quorum.localhost+1.pem and quorum.localhost+1-key.pem
```

### Docker Compose — Caddy sidecar

Add Caddy as a sidecar in `docker-compose.yml` for a fully containerised local TLS setup:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - gateway

volumes:
  caddy_data:
  caddy_config:
```

```
# Caddyfile
quorum.localhost {
  reverse_proxy gateway:3001
}
```

### Checklist before going to production

- [ ] TLS terminated at ALB (ACM cert) or ingress controller (cert-manager)
- [ ] Gateway pod only listens on HTTP internally — no TLS config in `src/gateway/server.js`
- [ ] `QUORUM_GATEWAY_URL` in all `.quorum` files uses `https://`
- [ ] `alb.ingress.kubernetes.io/ssl-redirect: "443"` forces HTTP → HTTPS redirect
- [ ] Certificate auto-renews (ACM manages this automatically; cert-manager handles it for nginx ingress)

### Production TLS checklist (GAP-11 — service-to-service encryption)

- [ ] Set `POSTGRES_SSL=true` in gateway environment (enables `ssl: { rejectUnauthorized: true }`)
- [ ] Provision a cert-manager `Certificate` resource for the PostgreSQL service
- [ ] Set `postgresql.tls.enabled=true` in Helm values (documents the cert secret name)
- [ ] Set `graphiti.networkPolicy.enabled=true` in Helm values (restricts Graphiti ingress to gateway pod only)
- [ ] Verify gateway → PostgreSQL SSL with: `openssl s_client -connect <postgres-host>:5432 -starttls postgres`

```yaml
# helm/quorum/values-production.yaml additions
postgresql:
  tls:
    enabled: true
    certSecretName: quorum-postgresql-tls   # cert-manager Certificate secret

graphiti:
  networkPolicy:
    enabled: true

---

## Multi-team Isolation Guarantees

Quorum uses `group_id` to namespace every Graphiti graph operation to a specific project.
The `group_id` value is **owned by the S3 project config** (`<group_id>.quorum.json`) and is
embedded in the JWT at issue time by `POST /auth/token`. It is never derived from or
influenced by caller-supplied request body content.

**Enforcement chain:**

1. `POST /auth/token` — reads the project config from S3 (via DynamoDB cache) and embeds
   the canonical `group_id` as the `project` claim in the signed ES256 JWT.
2. `verifyJwt` middleware — verifies the JWT signature and attaches `req.user.project` from
   the `project` claim.
3. `POST /graphiti/*path` proxy — **unconditionally overwrites** `body.params.group_id` (and
   `body.params.group_ids` if present) with `req.user.project` before forwarding to Graphiti.
   Any caller-supplied `group_id` value is silently discarded.

This means a team member with a valid JWT for `project-A` **cannot read or write** graph
data belonging to `project-B`, even if they construct a request body that includes
`"group_id": "project-B"`. The gateway enforces the S3-defined project boundary at the
proxy layer, and Graphiti trusts the gateway entirely.
```
