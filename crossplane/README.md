# Crossplane — Quorum Infrastructure (LocalStack)

Crossplane manages all Quorum infrastructure — the only IaC tool in this project. Provisions S3 (project configs), DynamoDB (membership + config cache), RDS PostgreSQL (audit pipeline + version store), and Redis via ElastiCache (gateway cache). Requires Crossplane ≥ v1.14 and the relevant Upbound AWS provider packages.

> **Scope notice (June 11, 2026):** This document describes the existing LocalStack reference
> manifests. It is not the approved production topology. Production uses Crossplane core `v2.3.2` in
> Docker Desktop Kubernetes to provision AWS, then EC2 bootstrap plus Docker Compose to run the backend.
> Helm installs Crossplane core only; `provider-helm` and an application Helm release are not used.
> The dashboard runs independently on Vercel. See the
> [current AWS deployment design](../docs/superpowers/specs/2026-06-11-quorum-aws-crossplane-deployment-design.md).

## Folder Structure

```
crossplane/
├── crossplane.sh                              # Script: setup / start / status / cleanup
├── provider/
│   ├── provider-family-aws.yaml               # Pins provider-family-aws; applies runtimeConfigRef
│   ├── provider-aws-s3.yaml                   # Upbound AWS S3 provider
│   ├── provider-aws-dynamodb.yaml             # Upbound AWS DynamoDB provider
│   ├── provider-aws-rds.yaml                  # Upbound AWS RDS provider
│   ├── provider-aws-elasticache.yaml          # Upbound AWS ElastiCache provider
│   ├── providerconfig-aws.yaml                # ProviderConfig — endpoint, credentials, path-style
│   ├── runtimeconfig-localstack.yaml          # DeploymentRuntimeConfig — injects AWS_ENDPOINT_URL
│   └── controllerconfig-localstack.yaml       # ControllerConfig (kept for compat, no env vars)
├── credentials/
│   └── aws-creds-secret.yaml.example          # Secret template (copy, fill, apply — never commit)
├── bucket/
│   ├── bucket.yaml                            # S3 Bucket (us-east-1)
│   ├── bucket-versioning.yaml                 # Versioning (Enabled)
│   ├── bucket-encryption.yaml                 # SSE-S3 encryption (AES256 — upgrade to KMS for prod)
│   ├── bucket-public-access.yaml              # All public access blocked
│   └── bucket-lifecycle.yaml                  # Noncurrent version archival to STANDARD_IA / GLACIER_IR
├── objects/
│   ├── platform-team-config.yaml              # platform-team/config.json
│   ├── backend-team-config.yaml               # backend-team/config.json
│   └── external-bucket-config.yaml.example    # Template for pre-existing external buckets
├── dynamodb/
│   ├── table-quorum-configs.yaml              # quorum-configs table — PK: group_id
│   └── table-quorum-user-projects.yaml        # quorum-user-projects — PK: github_username, SK: project_id + GSI
├── rds/
│   ├── subnet-group.yaml                      # DB subnet group (placeholder subnets for LocalStack)
│   ├── parameter-group.yaml                   # postgres16 parameter group — slow-query log, max_connections
│   └── instance.yaml                          # PostgreSQL 16 instance (db.t3.micro)
└── redis/
    ├── subnet-group.yaml                      # ElastiCache subnet group (placeholder subnets for LocalStack)
    ├── parameter-group.yaml                   # redis7 parameter group — maxmemory-policy: allkeys-lru
    └── replication-group.yaml                 # Redis 7 single-node replication group (cache.t3.micro)
```

---

## Quick Start — LocalStack (recommended)

Use `crossplane.sh` — it handles everything in order: deps check, LocalStack validation, Crossplane install, CRD wait, CoreDNS patch, provider install, credentials, bucket, objects, DynamoDB tables, RDS instance, and Redis cluster.

### Prerequisites

```bash
# LocalStack must be running WITH LOCALSTACK_HOST set — required for
# virtual-hosted S3 requests from inside Kubernetes pods.
# If already running without it, stop and restart:
localstack stop
LOCALSTACK_HOST=host.docker.internal localstack start -d

# Required CLIs
brew install kubectl helm
pip install awscli-local    # provides the awslocal command
```

### Run setup

```bash
./crossplane/crossplane.sh setup
```

This installs Crossplane (v1.17.2), four Upbound AWS providers, patches CoreDNS, and provisions:
- `quorum-configs` S3 bucket with sample configs
- `quorum-configs` and `quorum-user-projects` DynamoDB tables
- `quorum-postgres` RDS PostgreSQL 16 instance
- `quorum-redis` ElastiCache Redis 7 replication group

```bash
# Check current state at any time
./crossplane/crossplane.sh status

# Re-apply all manifests (idempotent — safe to run again after cluster restart)
./crossplane/crossplane.sh start

# Remove all resources
./crossplane/crossplane.sh cleanup
```

Logs are written to `./logs/crossplane.<timestamp>.log`.

### LocalStack Caveats

LocalStack supports ElastiCache and RDS at a partial level — most settings (encryption, auth tokens, multi-AZ) are accepted but are no-ops. Crossplane resources may show `Synced=False` while still being accepted by LocalStack; check with `awslocal` commands directly if in doubt. The `status` command queries LocalStack directly alongside Crossplane resource state.

### Verify

```bash
# S3 — list objects in the bucket
awslocal s3 ls s3://quorum-configs/ --recursive

# DynamoDB — list tables
awslocal dynamodb list-tables

# RDS — list instances
awslocal rds describe-db-instances \
  --query 'DBInstances[].{ID:DBInstanceIdentifier,Status:DBInstanceStatus}'

# ElastiCache — list replication groups
awslocal elasticache describe-replication-groups \
  --query 'ReplicationGroups[].{ID:ReplicationGroupId,Status:Status}'
```

---

## Manual Apply Order (reference)

If you prefer running `kubectl apply` directly instead of the script:

```bash
# 1. Install Crossplane
helm repo add crossplane-stable https://charts.crossplane.io/stable --force-update
helm upgrade --install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system --create-namespace --version 1.17.2 --wait

# 2. Apply DeploymentRuntimeConfig before provider-family-aws references it
kubectl apply -f crossplane/provider/runtimeconfig-localstack.yaml
kubectl apply -f crossplane/provider/controllerconfig-localstack.yaml

# 3. Install all providers (S3 auto-installs provider-family-aws as dependency)
kubectl apply -f crossplane/provider/provider-aws-s3.yaml
kubectl apply -f crossplane/provider/provider-aws-dynamodb.yaml
kubectl apply -f crossplane/provider/provider-aws-rds.yaml
kubectl apply -f crossplane/provider/provider-aws-elasticache.yaml
kubectl apply -f crossplane/provider/provider-family-aws.yaml

kubectl wait provider/provider-aws-s3          --for=condition=Healthy --timeout=180s
kubectl wait provider/upbound-provider-family-aws --for=condition=Healthy --timeout=120s
kubectl wait provider/provider-aws-dynamodb    --for=condition=Healthy --timeout=180s
kubectl wait provider/provider-aws-rds         --for=condition=Healthy --timeout=180s
kubectl wait provider/provider-aws-elasticache --for=condition=Healthy --timeout=180s

# 4. Create credentials secret and ProviderConfig
kubectl create secret generic aws-creds \
  --namespace crossplane-system \
  --from-literal=credentials=$'[default]\naws_access_key_id=test\naws_secret_access_key=test' \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f crossplane/provider/providerconfig-aws.yaml

# 5. Create application namespace and RDS password secret
kubectl create namespace quorum --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic quorum-db-creds \
  --namespace crossplane-system \
  --from-literal=password=quorum-local-dev-password \
  --dry-run=client -o yaml | kubectl apply -f -

# 6. Provision S3 bucket and objects
kubectl apply -f crossplane/bucket/
kubectl wait bucket/quorum-configs --for=condition=Ready --timeout=120s
kubectl apply -f crossplane/objects/platform-team-config.yaml
kubectl apply -f crossplane/objects/backend-team-config.yaml

# 7. Provision DynamoDB tables
kubectl apply -f crossplane/dynamodb/
kubectl wait table.dynamodb.aws.upbound.io/quorum-configs       --for=condition=Ready --timeout=120s
kubectl wait table.dynamodb.aws.upbound.io/quorum-user-projects --for=condition=Ready --timeout=120s

# 8. Provision RDS PostgreSQL (subnet-group and parameter-group before instance)
kubectl apply -f crossplane/rds/subnet-group.yaml
kubectl apply -f crossplane/rds/parameter-group.yaml
kubectl apply -f crossplane/rds/instance.yaml
kubectl wait instance.rds.aws.upbound.io/quorum-postgres --for=condition=Ready --timeout=180s

# 9. Provision Redis (ElastiCache)
kubectl apply -f crossplane/redis/subnet-group.yaml
kubectl apply -f crossplane/redis/parameter-group.yaml
kubectl apply -f crossplane/redis/replication-group.yaml
kubectl wait replicationgroup.elasticache.aws.upbound.io/quorum-redis --for=condition=Ready --timeout=180s
```

---

## LocalStack Configuration Notes

### Why `LOCALSTACK_HOST=host.docker.internal` is required

LocalStack must be started with this variable set so it can parse bucket names from
virtual-hosted S3 Host headers (e.g. `quorum-configs.host.docker.internal`). Without it,
LocalStack cannot resolve bucket names from inside Kubernetes pods and S3 operations fail silently.

```bash
# Check if your LocalStack has it set
docker inspect localstack-main --format '{{range .Config.Env}}{{println .}}{{end}}' | grep LOCALSTACK_HOST
```

If absent, stop and restart:
```bash
localstack stop
LOCALSTACK_HOST=host.docker.internal localstack start -d
```

### Why `endpoint.services` in ProviderConfig lists all services

The Upbound AWS provider (built on Upjet/AWS SDK Go v2) has separate endpoint resolution
paths for different services. The global `endpoint.url.static` field routes STS, IAM,
and most services — but NOT S3 or the data-plane services unless explicitly listed.

```yaml
# providerconfig-aws.yaml — required for all four services
endpoint:
  source: Custom
  hostnameImmutable: true
  signingRegion: us-east-1
  url:
    type: Static
    static: "http://host.docker.internal:4566"
  services:
    - s3
    - sts
    - dynamodb
    - rds
    - elasticache
```

### CoreDNS wildcard rewrite

`crossplane.sh setup` patches the CoreDNS ConfigMap to resolve `*.host.docker.internal`
to `host.docker.internal`. This allows virtual-hosted S3 URLs like
`quorum-configs.host.docker.internal` to resolve from inside cluster pods.

**Note:** Docker Desktop fully resets Kubernetes (including CoreDNS) if you restart or
reset the cluster. Re-run `./crossplane/crossplane.sh setup` after any cluster reset.

---

## Resource Inventory

| Resource | Kind | Provider | Crossplane name | LocalStack name |
|----------|------|----------|-----------------|-----------------|
| S3 bucket | `Bucket` | provider-aws-s3 | `quorum-configs` | `quorum-configs` |
| S3 objects | `Object` | provider-aws-s3 | `platform-team-config`, `backend-team-config` | — |
| DynamoDB table | `Table` | provider-aws-dynamodb | `quorum-configs` | `quorum-configs` |
| DynamoDB table | `Table` | provider-aws-dynamodb | `quorum-user-projects` | `quorum-user-projects` |
| DB subnet group | `SubnetGroup` | provider-aws-rds | `quorum-db-subnet-group` | `quorum-db-subnet-group` |
| DB parameter group | `ParameterGroup` | provider-aws-rds | `quorum-pg16` | `quorum-pg16` |
| RDS instance | `Instance` | provider-aws-rds | `quorum-postgres` | `quorum-postgres` |
| Cache subnet group | `SubnetGroup` | provider-aws-elasticache | `quorum-redis-subnet-group` | `quorum-redis-subnet-group` |
| Cache parameter group | `ParameterGroup` | provider-aws-elasticache | `quorum-redis7` | `quorum-redis7` |
| Redis cluster | `ReplicationGroup` | provider-aws-elasticache | `quorum-redis` | `quorum-redis` |

### Connection Secrets

| Secret | Namespace | Contents | Consumer |
|--------|-----------|----------|----------|
| `quorum-postgres-conn` | `quorum` | `endpoint`, `port`, `username`, `password` | gateway Deployment |
| `quorum-redis-conn` | `quorum` | `endpoint`, `port` | gateway Deployment |
| `quorum-db-creds` | `crossplane-system` | `password` | Crossplane RDS Instance |

---

## Production Upgrade

### IRSA Instead of Static Keys

1. Remove `s3_use_path_style`, `skip_credentials_validation`, `skip_metadata_api_check`, `skip_region_validation`, and the entire `endpoint` block from `providerconfig-aws.yaml`.
2. Change `credentials.source: Secret` → `source: IRSA` and remove `secretRef`.
3. In each provider YAML, add `serviceAccountAnnotations` with the IAM role ARN.
4. Remove `runtimeconfig-localstack.yaml` and the `runtimeConfigRef` from `provider-family-aws.yaml`.
5. Delete the `aws-creds` Secret — no longer needed.

### RDS Production Checklist

All items are marked in `rds/instance.yaml` as `# PRODUCTION:` comments:

- `instanceClass: db.r7g.large` or appropriate size
- `multiAz: true`
- `deletionProtection: true`
- `storageEncrypted: true` + `kmsKeyId`
- `backupRetentionPeriod: 14` (or 35 for compliance)
- `applyImmediately: false` (use blue/green deployments)
- `vpcSecurityGroupIds` — restrict to gateway pod SG only
- Use AWS Secrets Manager or ESO for `quorum-db-creds` instead of a plain k8s Secret

### Redis Production Checklist

All items are marked in `redis/replication-group.yaml` as `# PRODUCTION:` comments:

- `numCacheClusters: 2`, `automaticFailoverEnabled: true`, `multiAzEnabled: true`
- `atRestEncryptionEnabled: true`
- `transitEncryptionEnabled: true` + `authToken` from Secrets Manager
- `snapshotRetentionLimit: 7`
- `logDeliveryConfigurations` for slow-log and engine-log to CloudWatch

---

## IaC Strategy

Crossplane is the **only** IaC tool in this project. There is no Terraform.

| Mode | Storage | Auth |
|------|---------|------|
| Docker Compose (local dev) | LocalStack via `scripts/init-localstack.sh` | Dummy credentials (`test`/`test`) |
| Local K8s | LocalStack via `crossplane.sh setup` | K8s Secret (`aws-creds`) |
| Production | Real AWS | IRSA (no static keys) |

---

## Config Object Schema

Each `{group_id}.quorum.json` object in the bucket follows this structure:

```json
{
  "group_id": "string",
  "project": "string (display name only)",
  "owner": "string (GitHub username)",
  "version": "string",
  "conflictThreshold": 0.85,
  "authorityThreshold": 0.20,
  "domains": ["string"],
  "teamLeads": ["string"]
}
```

The Quorum Gateway reads these at startup via the `QUORUM_CONFIG_BUCKET` env var and caches them in Redis (TTL: `QUORUM_CONFIG_CACHE_TTL`, default 300s).
