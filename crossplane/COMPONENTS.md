# Crossplane — Component Reference

Deep-dive reference for every Crossplane component in this project.
For quick-start instructions see [README.md](README.md).
For the `crossplane.sh` and `sync.sh` scripts see the root of this directory.

---

## Table of Contents

1. [Crossplane itself](#1-crossplane-itself)
2. [provider-family-aws](#2-provider-family-aws)
3. [provider-aws-s3](#3-provider-aws-s3)
4. [provider-aws-dynamodb](#4-provider-aws-dynamodb)
5. [provider-aws-rds](#5-provider-aws-rds)
6. [provider-aws-elasticache](#6-provider-aws-elasticache)
7. [ProviderConfig](#7-providerconfig)
8. [DeploymentRuntimeConfig](#8-deploymentruntimeconfig)
9. [ControllerConfig](#9-controllerconfig-deprecated)
10. [S3 Resources](#10-s3-resources)
11. [DynamoDB Resources](#11-dynamodb-resources)
12. [RDS Resources](#12-rds-resources)
13. [ElastiCache / Redis Resources](#13-elasticache--redis-resources)
14. [Secrets and Connection Details](#14-secrets-and-connection-details)
15. [LocalStack Compatibility](#15-localstack-compatibility)
16. [Production Checklist](#16-production-checklist)

---

## 1. Crossplane itself

| Field | Value |
|-------|-------|
| Version | `1.17.2` |
| Install | Helm chart `crossplane-stable/crossplane` |
| Namespace | `crossplane-system` |
| Helm repo | `https://charts.crossplane.io/stable` |

**What it does:** Crossplane is the control-plane layer that translates Kubernetes manifests
(`kind: Bucket`, `kind: Instance`, etc.) into real AWS API calls. It reconciles continuously —
if a resource drifts from the declared state, Crossplane corrects it automatically.

**Key concepts:**

| Concept | Explanation |
|---------|-------------|
| `Provider` | Declares which provider package to install (e.g. `provider-aws-s3:v1`) |
| `ProviderConfig` | Configures credentials and endpoint for all managed resources in that provider |
| `Managed Resource` | An instance of a provider CRD — e.g. `kind: Bucket`, `kind: Instance` |
| `DeploymentRuntimeConfig` | Injects env vars into the provider pod's Deployment |
| `ControllerConfig` | Deprecated predecessor to `DeploymentRuntimeConfig` — kept for compat |

**References:**
- Docs: <https://docs.crossplane.io>
- Concepts: <https://docs.crossplane.io/latest/concepts/>
- Helm chart: <https://charts.crossplane.io/stable>
- GitHub: <https://github.com/crossplane/crossplane>
- Release notes v1.17: <https://github.com/crossplane/crossplane/releases/tag/v1.17.2>

---

## 2. provider-family-aws

| Field | Value |
|-------|-------|
| File | `provider/provider-family-aws.yaml` |
| Package | `xpkg.upbound.io/upbound/provider-family-aws:v1.23.2` |
| Kind | `Provider` |
| Namespace | `crossplane-system` (Crossplane manages the pod) |

**What it does:** The family provider is the **shared authentication and configuration layer**
for all Upbound AWS providers. It is not installed directly — it is auto-installed as a
dependency when any `provider-aws-*` package is applied. We pin it explicitly via
`provider-family-aws.yaml` to:

1. Prevent version drift when multiple service providers pull different family versions
2. Attach `runtimeConfigRef` (which sets `AWS_ENDPOINT_URL*` on the pod) — this cannot
   be done via the auto-installed copy

**Why the RuntimeConfig lives here, not on individual providers:**
Only one pod actually makes AWS API calls — the family provider pod. Individual service
providers (S3, DynamoDB, etc.) delegate calls to it. Setting env vars on the service
provider pods has no effect; they must be set on the family pod.

**References:**
- Marketplace: <https://marketplace.upbound.io/providers/upbound/provider-family-aws>
- GitHub: <https://github.com/upbound/provider-aws>
- Changelog: <https://github.com/upbound/provider-aws/releases>

---

## 3. provider-aws-s3

| Field | Value |
|-------|-------|
| File | `provider/provider-aws-s3.yaml` |
| Package | `xpkg.upbound.io/upbound/provider-aws-s3:v1` |
| Kind | `Provider` |
| CRDs installed | `Bucket`, `BucketVersioning`, `BucketServerSideEncryptionConfiguration`, `BucketPublicAccessBlock`, `BucketLifecycleConfiguration`, `Object` |

**What it does:** Manages S3 buckets and objects. Used by Quorum to store
`<group_id>.quorum.json` project config files that the gateway reads at startup.

**Why `controllerConfigRef` (not `runtimeConfigRef`):**
`provider-aws-s3` currently references `controllerConfigRef: localstack-config` for
LocalStack compatibility. The ControllerConfig is intentionally empty of env vars (see
[§9](#9-controllerconfig-deprecated)) — it exists only because some Crossplane versions
required the reference to be present. The actual endpoint env vars are on the family pod.

**References:**
- Marketplace: <https://marketplace.upbound.io/providers/upbound/provider-aws-s3>
- CRD reference: <https://marketplace.upbound.io/providers/upbound/provider-aws-s3/latest/resources>
- AWS S3 docs: <https://docs.aws.amazon.com/s3/>
- LocalStack S3 coverage: <https://docs.localstack.cloud/references/coverage/coverage_s3/>

---

## 4. provider-aws-dynamodb

| Field | Value |
|-------|-------|
| File | `provider/provider-aws-dynamodb.yaml` |
| Package | `xpkg.upbound.io/upbound/provider-aws-dynamodb:v1` |
| Kind | `Provider` |
| CRDs installed | `Table`, `GlobalTable`, `TableItem`, `BackupSelection` |

**What it does:** Manages DynamoDB tables. Quorum uses two tables:

| Table | Purpose |
|-------|---------|
| `quorum-configs` | Config cache layer — project configs read-through from S3 |
| `quorum-user-projects` | Membership index — maps GitHub usernames ↔ projects + roles |

Both tables use `PAY_PER_REQUEST` billing for LocalStack. In production, switch to
`PROVISIONED` with autoscaling or stay on `PAY_PER_REQUEST` depending on traffic profile.

**References:**
- Marketplace: <https://marketplace.upbound.io/providers/upbound/provider-aws-dynamodb>
- CRD reference: <https://marketplace.upbound.io/providers/upbound/provider-aws-dynamodb/latest/resources>
- AWS DynamoDB docs: <https://docs.aws.amazon.com/dynamodb/>
- LocalStack DynamoDB coverage: <https://docs.localstack.cloud/references/coverage/coverage_dynamodb/>

---

## 5. provider-aws-rds

| Field | Value |
|-------|-------|
| File | `provider/provider-aws-rds.yaml` |
| Package | `xpkg.upbound.io/upbound/provider-aws-rds:v1` |
| Kind | `Provider` |
| CRDs installed | `Instance`, `SubnetGroup`, `ParameterGroup`, `ClusterInstance`, `Snapshot`, `EventSubscription`, and more |

**What it does:** Manages RDS database instances. Quorum uses a PostgreSQL 16 instance
(`quorum-postgres`) as the primary store for the audit pipeline and `knowledge_versions`
table. RDS is the source of truth for governance — Graphiti/FalkorDB is the search layer.

**Dependency order:** `SubnetGroup` and `ParameterGroup` must be created before the
`Instance` — the instance references both by name. Crossplane will retry reconciliation
if dependencies are missing, but applying in order avoids the retry delay.

**References:**
- Marketplace: <https://marketplace.upbound.io/providers/upbound/provider-aws-rds>
- CRD reference: <https://marketplace.upbound.io/providers/upbound/provider-aws-rds/latest/resources>
- AWS RDS docs: <https://docs.aws.amazon.com/rds/>
- AWS RDS PostgreSQL versions: <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html>
- LocalStack RDS coverage: <https://docs.localstack.cloud/references/coverage/coverage_rds/>

---

## 6. provider-aws-elasticache

| Field | Value |
|-------|-------|
| File | `provider/provider-aws-elasticache.yaml` |
| Package | `xpkg.upbound.io/upbound/provider-aws-elasticache:v1` |
| Kind | `Provider` |
| CRDs installed | `ReplicationGroup`, `CacheCluster`, `SubnetGroup`, `ParameterGroup`, `User`, `UserGroup` |

**What it does:** Manages ElastiCache clusters. Quorum uses a single-node Redis 7
replication group (`quorum-redis`) as the gateway's in-memory cache for:
- Project config objects (TTL: `QUORUM_CONFIG_CACHE_TTL`, default 300s)
- User profiles (TTL: `QUORUM_PROFILE_CACHE_TTL`, default 300s)
- Admin config (TTL: `QUORUM_ADMIN_CACHE_TTL`, default 300s)
- Pub/sub cache invalidation on config updates

**Why `ReplicationGroup` and not `CacheCluster`:**
AWS deprecated standalone `CacheCluster` for Redis in favour of `ReplicationGroup`, even
for single-node setups. `ReplicationGroup` is the correct primitive for Redis in all
Upbound ElastiCache provider versions.

**References:**
- Marketplace: <https://marketplace.upbound.io/providers/upbound/provider-aws-elasticache>
- CRD reference: <https://marketplace.upbound.io/providers/upbound/provider-aws-elasticache/latest/resources>
- AWS ElastiCache docs: <https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/>
- AWS Redis 7 what's new: <https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/WhatsNew.html>
- LocalStack ElastiCache coverage: <https://docs.localstack.cloud/references/coverage/coverage_elasticache/>

---

## 7. ProviderConfig

| Field | Value |
|-------|-------|
| File | `provider/providerconfig-aws.yaml` |
| Kind | `ProviderConfig` (apiVersion: `aws.upbound.io/v1beta1`) |
| Name | `aws-provider` |

**What it does:** Every managed resource in this project references `providerConfigRef: { name: aws-provider }`. The `ProviderConfig` tells the family provider how to authenticate and where to send API calls.

**Key fields explained:**

```yaml
s3_use_path_style: true
```
Forces path-style S3 URLs (`http://endpoint/bucket/key`) instead of virtual-hosted
(`http://bucket.endpoint/key`). Required for LocalStack. **Remove in production.**

```yaml
skip_credentials_validation: true
skip_metadata_api_check: true
skip_region_validation: true
```
Disables STS, EC2 metadata API, and region validation calls that LocalStack does not
fully implement. **Remove in production.**

```yaml
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
Routes all listed services to the LocalStack endpoint. `hostnameImmutable: true` prevents
the SDK from rewriting the endpoint hostname (required for LocalStack). The `services` list
is critical — without it, only STS and IAM use the custom endpoint; S3, DynamoDB, RDS, and
ElastiCache fall back to real AWS. **Remove the entire `endpoint` block in production.**

```yaml
credentials:
  source: Secret
  secretRef:
    namespace: crossplane-system
    name: aws-creds
    key: credentials
```
Reads `[default]\naws_access_key_id=test\naws_secret_access_key=test` from the
`aws-creds` Secret. LocalStack accepts any non-empty credentials.
**In production, change `source` to `IRSA` and remove `secretRef`.**

**References:**
- ProviderConfig spec: <https://marketplace.upbound.io/providers/upbound/provider-family-aws/latest/resources/aws.upbound.io/ProviderConfig/v1beta1>
- Upbound endpoint configuration guide: <https://docs.upbound.io/providers/provider-aws/authentication/>

---

## 8. DeploymentRuntimeConfig

| Field | Value |
|-------|-------|
| File | `provider/runtimeconfig-localstack.yaml` |
| Kind | `DeploymentRuntimeConfig` (apiVersion: `pkg.crossplane.io/v1beta1`) |
| Name | `localstack-runtime-config` |
| Referenced by | `provider-family-aws.yaml` via `runtimeConfigRef` |

**What it does:** Injects environment variables into the provider-family-aws pod's
Deployment. Crossplane merges these into the pod spec at reconciliation — unlike patching
the Deployment directly, this survives Crossplane's reconciliation loop.

**Key env vars:**

| Var | Value | Why |
|-----|-------|-----|
| `AWS_ENDPOINT_URL` | `http://host.docker.internal:4566` | Global AWS SDK endpoint override |
| `AWS_ENDPOINT_URL_S3` | `http://host.docker.internal:4566` | S3-specific override — takes priority over the global var for S3 in AWS SDK Go v2 |

**Why two S3 endpoint vars:** AWS SDK Go v2 (used by Upbound providers) resolves S3 endpoints
on a separate code path from other services. `AWS_ENDPOINT_URL_S3` was added in Go SDK v2
specifically to allow S3-only overrides. Without it, some provider versions ignore
`AWS_ENDPOINT_URL` for S3 calls.

**Production note:** Remove `runtimeconfig-localstack.yaml` and the `runtimeConfigRef`
from `provider-family-aws.yaml` entirely. IRSA takes over authentication; no custom
endpoint is needed.

**References:**
- DeploymentRuntimeConfig: <https://docs.crossplane.io/latest/concepts/deployment-runtime-configs/>

---

## 9. ControllerConfig (deprecated)

| Field | Value |
|-------|-------|
| File | `provider/controllerconfig-localstack.yaml` |
| Kind | `ControllerConfig` (apiVersion: `pkg.crossplane.io/v1alpha1`) |
| Name | `localstack-config` |
| Referenced by | `provider-aws-s3.yaml`, `provider-aws-dynamodb.yaml`, `provider-aws-rds.yaml`, `provider-aws-elasticache.yaml` |

**What it does:** Intentionally empty of env vars. Its only purpose is to satisfy the
`controllerConfigRef` requirement on service provider packages for Crossplane v1.17.x.

**Why it is intentionally empty:**
Setting `AWS_*` env vars here activates the AWS SDK environment credentials chain, which
bypasses the ProviderConfig custom endpoint resolver. This causes provider pods to call
real AWS instead of LocalStack. The real endpoint configuration lives in:
- `DeploymentRuntimeConfig` for the family pod (env vars)
- `ProviderConfig` for the managed-resource-level endpoint routing

**Deprecation path:** `ControllerConfig` is removed in Crossplane v1.18+ in favour of
`DeploymentRuntimeConfig`. When upgrading Crossplane beyond v1.17, migrate references.

**References:**
- Deprecation notice: <https://docs.crossplane.io/latest/concepts/managed-resources/#speccontrollerconfigref>

---

## 10. S3 Resources

All files live in `bucket/` and `objects/`.

### Bucket (`bucket/bucket.yaml`)

| Field | Value | Notes |
|-------|-------|-------|
| Kind | `Bucket` | `s3.aws.upbound.io/v1beta1` |
| Name | `quorum-configs` | External name matches Crossplane name |
| Region | `us-east-1` | — |

The bucket holds one flat file per project: `<group_id>.quorum.json`.
No subdirectories — the S3 key IS the group ID.

### BucketVersioning (`bucket/bucket-versioning.yaml`)

Enables S3 versioning. This is a separate Crossplane managed resource (not an inline field
on `Bucket`) because the S3 API exposes versioning as its own sub-resource endpoint.
Allows rollback of accidentally overwritten config files.

### BucketServerSideEncryptionConfiguration (`bucket/bucket-encryption.yaml`)

AES256 (SSE-S3) encryption at rest. Upgrade to SSE-KMS in production.

### BucketPublicAccessBlock (`bucket/bucket-public-access.yaml`)

Blocks all public access — `blockPublicAcls`, `blockPublicPolicy`,
`ignorePublicAcls`, `restrictPublicBuckets` all `true`.

### BucketLifecycleConfiguration (`bucket/bucket-lifecycle.yaml`)

Archives noncurrent object versions to `STANDARD_IA` after 30 days,
then `GLACIER_IR` after 90 days. Keeps storage costs bounded as config
history accumulates.

### Object (`objects/*.yaml`)

The `Object` CRD uploads arbitrary content as an S3 object from a Kubernetes
manifest. Used here to seed `platform-team/config.json` and `backend-team/config.json`
as sample project configs.

**References:**
- AWS S3 bucket: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/creating-buckets-s3.html>
- Upbound Bucket CRD: <https://marketplace.upbound.io/providers/upbound/provider-aws-s3/latest/resources/s3.aws.upbound.io/Bucket/v1beta1>
- Upbound Object CRD: <https://marketplace.upbound.io/providers/upbound/provider-aws-s3/latest/resources/s3.aws.upbound.io/Object/v1beta1>

---

## 11. DynamoDB Resources

All files live in `dynamodb/`.

### Table: quorum-configs (`dynamodb/table-quorum-configs.yaml`)

| Field | Value |
|-------|-------|
| Kind | `Table` (`dynamodb.aws.upbound.io/v1beta1`) |
| PK | `group_id` (STRING) |
| Billing | `PAY_PER_REQUEST` |
| PITR | disabled (enable in production) |
| SSE | disabled (enable in production) |

**Purpose:** Config cache. The gateway's `POST /sync/configs` handler writes project
config objects here after reading from S3. Subsequent requests hit DynamoDB
(Redis → DynamoDB fallback) rather than S3 on every call.

### Table: quorum-user-projects (`dynamodb/table-quorum-user-projects.yaml`)

| Field | Value |
|-------|-------|
| Kind | `Table` (`dynamodb.aws.upbound.io/v1beta1`) |
| PK | `github_username` (STRING) |
| SK | `project_id` (STRING) |
| GSI | `ProjectMembersIndex` — PK: `project_id`, SK: `github_username` |
| Billing | `PAY_PER_REQUEST` |

**Purpose:** Membership index. Answers two access patterns:
- "Which projects does user X belong to, and what are their roles?" → main table scan by PK
- "Who are all the members of project Y?" → GSI query by `project_id`

Both access patterns are needed by the gateway's JWT validation and the admin panel.

**References:**
- AWS DynamoDB Table: <https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.CoreComponents.html>
- Upbound Table CRD: <https://marketplace.upbound.io/providers/upbound/provider-aws-dynamodb/latest/resources/dynamodb.aws.upbound.io/Table/v1beta1>
- GSI design guide: <https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html>

---

## 12. RDS Resources

All files live in `rds/`. Apply in this order: `subnet-group` → `parameter-group` → `instance`.

### SubnetGroup (`rds/subnet-group.yaml`)

| Field | Value |
|-------|-------|
| Kind | `SubnetGroup` (`rds.aws.upbound.io/v1beta1`) |
| Name | `quorum-db-subnet-group` |
| Subnets | Placeholder IDs (LocalStack ignores them) |

A DB subnet group tells RDS which VPC subnets the instance may be placed in.
In production, use private subnets only — the gateway should reach Postgres
via a private VPC endpoint, never over the public internet.

### ParameterGroup (`rds/parameter-group.yaml`)

| Field | Value |
|-------|-------|
| Kind | `ParameterGroup` (`rds.aws.upbound.io/v1beta1`) |
| Name | `quorum-pg16` |
| Family | `postgres16` |

**Parameters configured:**

| Parameter | Value | Apply method | Purpose |
|-----------|-------|--------------|---------|
| `log_min_duration_statement` | `1000` (ms) | `immediate` | Log queries slower than 1s for performance monitoring |
| `max_connections` | `200` | `pending-reboot` | Headroom above gateway pool (max: 20 per pod); supports up to 10 pods |
| `pg_stat_statements.track` | `all` | `immediate` | Enable full query statistics via `pg_stat_statements` extension |

**Note:** `pg_stat_statements.track` requires the extension to be created in the database:
`CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`

### Instance (`rds/instance.yaml`)

| Field | Value | Production value |
|-------|-------|-----------------|
| Kind | `Instance` (`rds.aws.upbound.io/v1beta1`) |
| Name | `quorum-postgres` | — |
| Engine | `postgres 16` | — |
| Instance class | `db.t3.micro` | `db.r7g.large` or appropriate |
| Storage | 20 GiB gp3 | ≥ 100 GiB gp3 |
| Storage encrypted | `false` | `true` + KMS key ARN |
| Multi-AZ | `false` | `true` |
| Deletion protection | `false` | `true` |
| Backup retention | 7 days | 14–35 days |
| Apply immediately | `true` | `false` (use blue/green) |

**Credential source:** Password is read from `crossplane-system/quorum-db-creds` Secret
(key: `password`). The Secret is created by `crossplane.sh setup` with a dev-only
placeholder value. In production, use ESO (External Secrets Operator) or AWS Secrets
Manager to populate the Secret from a managed secret store.

**Connection secret output:** `writeConnectionSecretToRef` writes the resolved endpoint,
port, username, and password to `quorum/quorum-postgres-conn` once the instance is Ready.

**References:**
- Upbound Instance CRD: <https://marketplace.upbound.io/providers/upbound/provider-aws-rds/latest/resources/rds.aws.upbound.io/Instance/v1beta1>
- AWS RDS PostgreSQL parameter reference: <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Parameters.html>
- AWS RDS Multi-AZ: <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html>
- ESO (External Secrets Operator): <https://external-secrets.io>

---

## 13. ElastiCache / Redis Resources

All files live in `redis/`. Apply in this order: `subnet-group` → `parameter-group` → `replication-group`.

### SubnetGroup (`redis/subnet-group.yaml`)

| Field | Value |
|-------|-------|
| Kind | `SubnetGroup` (`elasticache.aws.upbound.io/v1beta1`) |
| Name | `quorum-redis-subnet-group` |
| Subnets | Placeholder IDs (LocalStack ignores them) |

Same role as the RDS subnet group — tells ElastiCache which VPC subnets to place the
cache nodes in. Use the same private subnets as RDS in production.

### ParameterGroup (`redis/parameter-group.yaml`)

| Field | Value |
|-------|-------|
| Kind | `ParameterGroup` (`elasticache.aws.upbound.io/v1beta1`) |
| Name | `quorum-redis7` |
| Family | `redis7` |

**Parameters configured:**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `maxmemory-policy` | `allkeys-lru` | Evict least-recently-used keys when Redis hits the memory limit — appropriate for a cache-only workload with no persistence requirement |

**Alternative policies to consider in production:**
- `volatile-lru` — only evicts keys with a TTL set (safer if some keys must survive)
- `allkeys-lfu` — evicts least-frequently-used (better for hot-key workloads)

### ReplicationGroup (`redis/replication-group.yaml`)

| Field | Value | Production value |
|-------|-------|-----------------|
| Kind | `ReplicationGroup` (`elasticache.aws.upbound.io/v1beta1`) |
| Name | `quorum-redis` | — |
| Engine | `redis 7.0` | `7.0.x` (pin patch) |
| Node type | `cache.t3.micro` | `cache.r7g.large` or appropriate |
| Nodes | 1 (`numCacheClusters: 1`) | 2 with automatic failover |
| Multi-AZ | `false` | `true` |
| Encryption at rest | `false` | `true` |
| Encryption in transit | `false` | `true` + auth token |
| Snapshot retention | 0 (disabled) | 7 days |

**Connection secret output:** `writeConnectionSecretToRef` writes the primary endpoint
address and port to `quorum/quorum-redis-conn`. The gateway assembles `REDIS_URL` from
these values at startup.

**References:**
- Upbound ReplicationGroup CRD: <https://marketplace.upbound.io/providers/upbound/provider-aws-elasticache/latest/resources/elasticache.aws.upbound.io/ReplicationGroup/v1beta1>
- AWS ElastiCache Redis best practices: <https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/BestPractices.html>
- Redis maxmemory-policy: <https://redis.io/docs/latest/develop/reference/eviction/>
- AWS ElastiCache encryption: <https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/encryption.html>

---

## 14. Secrets and Connection Details

### Secrets created by `crossplane.sh setup`

| Secret | Namespace | Created by | Contents |
|--------|-----------|------------|---------|
| `aws-creds` | `crossplane-system` | `crossplane.sh` | `[default]\naws_access_key_id=test\naws_secret_access_key=test` |
| `quorum-db-creds` | `crossplane-system` | `crossplane.sh` | `password=quorum-local-dev-password` |

### Secrets written by Crossplane (`writeConnectionSecretToRef`)

| Secret | Namespace | Source resource | Fields written |
|--------|-----------|-----------------|---------------|
| `quorum-postgres-conn` | `quorum` | `instance/quorum-postgres` | `endpoint`, `port`, `username`, `password` |
| `quorum-redis-conn` | `quorum` | `replicationgroup/quorum-redis` | `endpoint`, `port` |

**How the gateway consumes them:**
Mount these Secrets as environment variables in the gateway Deployment via `envFrom`:

```yaml
envFrom:
  - secretRef:
      name: quorum-postgres-conn   # → ENDPOINT, PORT, USERNAME, PASSWORD
  - secretRef:
      name: quorum-redis-conn      # → ENDPOINT, PORT
```

Then assemble the DSNs in the gateway startup config:
```
POSTGRES_HOST=<ENDPOINT>
REDIS_URL=redis://<ENDPOINT>:<PORT>
```

---

## 15. LocalStack Compatibility

LocalStack is the AWS emulator used for local Kubernetes development. It accepts all
the API calls made by Crossplane providers but implements them at varying levels of fidelity.

| Service | LocalStack tier | Known gaps |
|---------|----------------|-----------|
| S3 | ✅ Full | Virtual-hosted URLs require `LOCALSTACK_HOST` env var |
| DynamoDB | ✅ Full | — |
| RDS | ⚠️ Partial | Instance creation succeeds; `Ready=True` may be slow; actual PostgreSQL engine is not spawned — use the Docker Compose Postgres for real queries |
| ElastiCache | ⚠️ Partial | Replication group creation accepted; encryption, auth tokens, and failover are no-ops; actual Redis is not spawned — use the Docker Compose Redis for real cache operations |

**Implication:** The Crossplane resources validate that the IaC manifests are well-formed
and that credentials + endpoints are correctly wired. For actual development, the running
services come from Docker Compose (`docker-compose up`), not from Crossplane-managed
LocalStack resources.

**LocalStack docs:**
- S3: <https://docs.localstack.cloud/references/coverage/coverage_s3/>
- DynamoDB: <https://docs.localstack.cloud/references/coverage/coverage_dynamodb/>
- RDS: <https://docs.localstack.cloud/references/coverage/coverage_rds/>
- ElastiCache: <https://docs.localstack.cloud/references/coverage/coverage_elasticache/>
- LocalStack GitHub: <https://github.com/localstack/localstack>

---

## 16. Production Checklist

> **TODO** — This section is a placeholder. Fill in before the first production deployment.

### 16.1 Provider and Authentication

- [ ] Remove all `controllerConfigRef: localstack-config` references from provider YAMLs
- [ ] Remove `runtimeconfig-localstack.yaml` and its `runtimeConfigRef` from `provider-family-aws.yaml`
- [ ] Switch `ProviderConfig.credentials.source` from `Secret` → `IRSA`
- [ ] Add IRSA `ControllerConfig` (or `DeploymentRuntimeConfig`) with the IAM role ARN for the gateway
- [ ] Remove `s3_use_path_style`, `skip_*`, and the entire `endpoint` block from `providerconfig-aws.yaml`
- [ ] Delete the `aws-creds` Secret — no longer needed with IRSA
- [ ] Pin all provider package versions to specific patch releases (e.g. `provider-aws-s3:v1.14.3`) — `v1` floating tag is not appropriate for production

### 16.2 Networking

- [ ] Replace placeholder subnet IDs in `rds/subnet-group.yaml` with real private subnet IDs
- [ ] Replace placeholder subnet IDs in `redis/subnet-group.yaml` with real private subnet IDs
- [ ] Add VPC security group IDs to `rds/instance.yaml` (`vpcSecurityGroupIds`) — restrict to gateway pod SG only
- [ ] Verify that the `quorum` namespace ServiceAccount has network access to RDS and ElastiCache endpoints

### 16.3 RDS PostgreSQL

- [ ] Upgrade `instanceClass` to production size (e.g. `db.r7g.large`)
- [ ] Set `multiAz: true`
- [ ] Set `deletionProtection: true`
- [ ] Set `storageEncrypted: true` and add `kmsKeyId: arn:aws:kms:...`
- [ ] Increase `allocatedStorage` to ≥ 100 GiB
- [ ] Increase `backupRetentionPeriod` to 14–35 days
- [ ] Set `applyImmediately: false`
- [ ] Replace `quorum-db-creds` plain Secret with ESO `ExternalSecret` pulling from AWS Secrets Manager
- [ ] Review `max_connections` in `rds/parameter-group.yaml` relative to final instance class and pod count

### 16.4 Redis / ElastiCache

- [ ] Upgrade `nodeType` to production size (e.g. `cache.r7g.large`)
- [ ] Set `numCacheClusters: 2`, `automaticFailoverEnabled: true`, `multiAzEnabled: true`
- [ ] Set `atRestEncryptionEnabled: true`
- [ ] Set `transitEncryptionEnabled: true` and add `authToken` from Secrets Manager
- [ ] Set `snapshotRetentionLimit: 7` and `snapshotWindow`
- [ ] Configure `logDeliveryConfigurations` for slow-log and engine-log to CloudWatch

### 16.5 DynamoDB

- [ ] Enable `pointInTimeRecovery` on both tables
- [ ] Enable `serverSideEncryption` with a customer-managed KMS key on both tables
- [ ] Review billing mode — `PAY_PER_REQUEST` vs `PROVISIONED` with autoscaling based on traffic profile
- [ ] Add resource-based IAM policies scoped to the gateway pod's IAM role

### 16.6 S3

- [ ] Upgrade bucket encryption from SSE-S3 (AES256) to SSE-KMS with a customer-managed key
- [ ] Add S3 bucket policy restricting `GetObject`/`PutObject` to the gateway pod's IAM role
- [ ] Review lifecycle policy transition periods relative to compliance requirements

### 16.7 Crossplane operational concerns

- [ ] Set up Crossplane with leader election enabled (default in Helm chart — verify)
- [ ] Configure Crossplane metrics scraping in Prometheus
- [ ] Add `ResourceQuota` and `LimitRange` to `crossplane-system` namespace
- [ ] Review Crossplane RBAC — ensure provider pods have minimal IAM and k8s permissions
- [ ] Set up alerts on `crossplane_managed_resource_ready_total` and `crossplane_managed_resource_exists_total` metrics

---

*Last updated: 2026-05-18*
