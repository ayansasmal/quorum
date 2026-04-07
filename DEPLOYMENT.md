# Engram — Deployment Guide

## Overview

Engram supports three deployment targets. This document covers the first two in detail. Production deployment is documented at a high level — implementation comes later.

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
┌─────────────────────────────────────────┐
│  Docker Compose Stack                   │
│                                         │
│  engram        → MCP server  :8000      │
│  falkordb      → graph DB    :6379      │
│  falkordb-ui   → browser UI  :3000      │
│  postgresql    → audit store :5432      │
└─────────────────────────────────────────┘
```

**Stack includes 4 services:**
- `engram` — the Node.js MCP server (port 8000)
- `graphiti` — Python sidecar, Engram calls it via HTTP (port 8001)
- `falkordb` — graph database (port 6379, browser UI port 3000)
- `postgresql` — audit secondary store (port 5432)

Graphiti is Python-only — it has no npm package. It runs as a Docker sidecar.
Engram never imports Graphiti — it calls it over HTTP.

### Setup

```bash
# Clone the repo
git clone https://github.com/ayansasmal/engram
cd engram

# Copy environment file
cp .env.example .env

# Edit .env — add your OpenAI API key (used by Graphiti sidecar)
# OPENAI_API_KEY=sk-...

# Start the stack
docker compose up -d

# Verify all 4 services are running
docker compose ps

# NAME         STATUS    PORTS
# engram       running   0.0.0.0:8000->8000/tcp
# graphiti     running   0.0.0.0:8001->8000/tcp
# falkordb     running   0.0.0.0:6379->6379/tcp
#                        0.0.0.0:3000->3000/tcp
# postgresql   running   0.0.0.0:5432->5432/tcp
```

### Environment Variables

```env
# .env.example

# ─────────────────────────────────────────────
# Graphiti sidecar LLM config (Python — not Engram Node.js)
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
# Engram MCP Server (Node.js)
# ─────────────────────────────────────────────

# Graphiti sidecar URL (set automatically in docker-compose)
GRAPHITI_URL=http://graphiti:8000

# Graph DB — FalkorDB
FALKORDB_URI=redis://falkordb:6379

# Audit secondary store — PostgreSQL
POSTGRES_HOST=postgresql
POSTGRES_PORT=5432
POSTGRES_DB=engram_audit
POSTGRES_USER=engram
POSTGRES_PASSWORD=engram_local

# Engram config
ENGRAM_PORT=8000
ENGRAM_GROUP_ID=default
ENGRAM_CONFLICT_THRESHOLD=0.85
ENGRAM_AUTHORITY_THRESHOLD=0.20
NODE_ENV=development
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
      POSTGRES_DB: engram_audit
      POSTGRES_USER: engram
      POSTGRES_PASSWORD: engram_local
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./scripts/init-db.sql:/docker-entrypoint-initdb.d/init.sql
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U engram"]
      interval: 10s
      timeout: 5s
      retries: 5

  engram:
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
# Add Engram as an MCP server
claude mcp add engram -- node /path/to/engram/src/server.js

# Or via HTTP if MCP server is running
claude mcp add engram --url http://localhost:8000/mcp

# Verify connection
claude "What does Engram know about auth?"
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
docker compose logs -f engram
docker compose logs -f falkordb

# Restart just Engram (after code changes)
docker compose restart engram

# Shell into Engram container
docker compose exec engram sh

# Verify audit chain integrity
docker compose exec engram node cli.js audit verify

# Export audit log
docker compose exec engram node cli.js audit export > audit.jsonl
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
  Engram limit:    1GB
  PostgreSQL:      512MB
  OS + apps:       8GB
  → Workable, close other heavy apps while running

32GB Mac:
  Allocate to Docker Desktop: 16GB
  FalkorDB limit:  4GB
  Engram limit:    1GB
  PostgreSQL:      512MB
  → Comfortable, no constraints

64GB Mac (M3 Max etc):
  Allocate to Docker Desktop: 24GB
  → No constraints at all
```

**Honest note on FalkorDB memory:** For realistic Engram usage (500-2000 knowledge nodes for an engineering team), FalkorDB uses ~200-500MB. The 2-4GB limits are headroom, not requirements. You won't hit them during development.

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
kubectl create namespace engram

# Create secret for API keys
kubectl create secret generic engram-secrets \
  --namespace engram \
  --from-literal=anthropic-api-key=$ANTHROPIC_API_KEY \
  --from-literal=postgres-password=engram_local \
  --from-literal=falkordb-password=""
```

### Helm Chart Structure

```
helm/engram/
  Chart.yaml            ← chart metadata
  values.yaml           ← production defaults
  values-local.yaml     ← local overrides (lower resources)
  templates/
    engram/
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
# helm/engram/values-local.yaml
# Local Docker Desktop overrides — lower resource limits

global:
  storageClass: local-path
  imageTag: latest
  imagePullPolicy: Always  # always pull latest in dev

engram:
  replicas: 1
  image: engram:local      # built locally
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
  database: engram_audit
  username: engram
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
docker build -t engram:local .

# Install via Helm
helm install engram ./helm/engram \
  --namespace engram \
  --values helm/engram/values-local.yaml \
  --set secrets.existingSecret=engram-secrets

# Watch pods come up
kubectl get pods -n engram --watch

# NAME                    READY   STATUS    RESTARTS   AGE
# engram-xxx-yyy          0/1     Init:0/1  0          5s
# falkordb-0              0/1     Pending   0          5s
# postgresql-0            0/1     Pending   0          5s
# ...
# engram-xxx-yyy          1/1     Running   0          45s
# falkordb-0              1/1     Running   0          30s
# postgresql-0            1/1     Running   0          25s
```

### Verify Deployment

```bash
# Check all pods running
kubectl get pods -n engram
# All should show 1/1 Running

# Check services
kubectl get services -n engram
# NAME         TYPE        CLUSTER-IP    PORT(S)
# engram       ClusterIP   10.x.x.x      8000/TCP
# falkordb     ClusterIP   10.x.x.x      6379/TCP, 3000/TCP
# postgresql   ClusterIP   10.x.x.x      5432/TCP

# Port-forward Engram to localhost
kubectl port-forward -n engram service/engram 8000:8000 &

# Port-forward FalkorDB UI
kubectl port-forward -n engram service/falkordb 3000:3000 &

# Health check
curl http://localhost:8000/health
# {"status":"healthy","graph":"connected","audit":"connected","version":"0.1.0"}
```

### Connect to Claude Code

```bash
# Engram is now available at localhost:8000 via port-forward
claude mcp add engram --url http://localhost:8000/mcp

# Verify
claude "What does Engram know about auth?"
```

### Seed Data on K8s

```bash
# Run seed job
kubectl apply -f helm/engram/templates/jobs/seed.yaml

# Or exec into pod
kubectl exec -it -n engram deployment/engram -- node cli.js seed

# Verify
kubectl exec -it -n engram deployment/engram -- node cli.js audit verify
```

### Useful K8s Commands

```bash
# Get all resources in namespace
kubectl get all -n engram

# View Engram logs
kubectl logs -n engram deployment/engram -f

# View FalkorDB logs
kubectl logs -n engram statefulset/falkordb -f

# Shell into Engram pod
kubectl exec -it -n engram deployment/engram -- sh

# Restart Engram (after image rebuild)
docker build -t engram:local .
kubectl rollout restart -n engram deployment/engram

# Upgrade Helm release (after values change)
helm upgrade engram ./helm/engram \
  --namespace engram \
  --values helm/engram/values-local.yaml \
  --set secrets.existingSecret=engram-secrets

# Uninstall (keeps PVCs — data survives)
helm uninstall engram --namespace engram

# Uninstall and wipe all data
helm uninstall engram --namespace engram
kubectl delete pvc --all -n engram

# Check resource usage
kubectl top pods -n engram
```

### Development Workflow on K8s

```bash
# Typical iteration loop:

# 1. Make code changes
vim src/tools/remember.js

# 2. Rebuild image
docker build -t engram:local .

# 3. Restart pod (picks up new image)
kubectl rollout restart -n engram deployment/engram

# 4. Watch pod restart
kubectl get pods -n engram --watch

# 5. Test
curl http://localhost:8000/health
claude "Test remember and recall"
```

---

## Choosing Between Docker Compose and Local K8s

```
Use Docker Compose if:
  → First time setting up Engram
  → You just want to try it quickly
  → You don't need K8s for anything else
  → You're building/testing the MCP tools themselves

Use Local K8s if:
  → You're building/testing the Helm chart
  → You want prod-parity in your local environment
  → You're testing K8s-specific behaviour (health checks, restarts, PVCs)
  → You already have Docker Desktop K8s running for other projects
```

Both run the exact same Engram code. The difference is purely operational — how the containers are orchestrated.

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
  → HPA for Engram pods (FalkorDB and PostgreSQL are StatefulSets)

AWS Native:
  → Engram on ECS Fargate
  → FalkorDB on ECS Fargate + EFS persistent volume
  → PostgreSQL on RDS (managed, backups handled)
  → Amazon Neptune (optional — only at very large graph scale)
  → Secrets Manager for API keys
  → ALB for load balancing
  → ECR for container images
  → Terraform for all infrastructure
```

### Production Sizing (Reference)

```
Small team (< 20 engineers):
  FalkorDB:   2GB RAM, 1 CPU
  Engram:     512MB RAM, 0.5 CPU, 2 replicas
  PostgreSQL: 1GB RAM, 0.5 CPU

Medium team (20-100 engineers):
  FalkorDB:   4GB RAM, 2 CPU
  Engram:     1GB RAM, 1 CPU, 3 replicas
  PostgreSQL: 2GB RAM, 1 CPU

Large org (100+ engineers, multiple teams):
  FalkorDB:   8GB RAM, 4 CPU, primary + replica
  Engram:     2GB RAM, 2 CPU, 5+ replicas
  PostgreSQL: 4GB RAM, 2 CPU (or RDS)
  Consider:   Amazon Neptune at this scale
```

### Production Roadmap

```
v0.2 → Helm chart production values + AWS Terraform
v0.3 → CI/CD pipeline (GitHub Actions → ECR → ECS/K8s)
v0.4 → Monitoring stack (Prometheus + Grafana dashboards)
v1.0 → One-command production deploy via npx engram deploy
```

---

## Troubleshooting

### Docker Compose

```bash
# Container not starting — check logs
docker compose logs engram

# FalkorDB connection refused
docker compose logs falkordb
# Wait for "Ready to accept connections" in logs
# Engram has health check dependency — will retry

# Port already in use
lsof -i :8000  # find what's using the port
# Change port in .env: ENGRAM_PORT=8001

# Fresh start — wipe everything
docker compose down -v
docker compose up -d
```

### Local K8s

```bash
# Pod stuck in Pending
kubectl describe pod -n engram <pod-name>
# Usually: PVC not bound, insufficient resources, image pull issue

# PVC not binding
kubectl get pvc -n engram
kubectl describe pvc -n engram <pvc-name>
# Check storageClass is correct: local-path

# Image pull error (engram:local)
# Must build image first: docker build -t engram:local .
# Docker Desktop K8s shares the local Docker daemon — no push needed

# Port-forward died
kubectl port-forward -n engram service/engram 8000:8000 &
# Add & to background it, or run in a separate terminal

# K8s not enabled in Docker Desktop
# Docker Desktop → Settings → Kubernetes → Enable Kubernetes → Apply & Restart

# Node not ready
kubectl get nodes
kubectl describe node docker-desktop
# Usually resolves itself — Docker Desktop K8s can take 2-3 min to start

# Resource limits hit (OOMKilled)
kubectl describe pod -n engram <pod-name>
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
# For Engram dev usage, expect < 100MB
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
