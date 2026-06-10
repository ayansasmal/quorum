# Quorum on AWS via Crossplane — Deployment Design

**Status:** Approved design (pre-implementation)
**Date:** 2026-06-11
**Author:** ayansasmal
**Scope:** Provision and run the entire Quorum platform on AWS from a single Crossplane control plane.

---

## 1. Goal

Deploy the full Quorum stack to AWS using **Crossplane as the only IaC tool**, driven by a
single declarative `Claim`. One `kubectl apply` of a `QuorumEnvironment` claim converges the
complete environment: network, EKS cluster, managed data services, IAM/IRSA, secrets, DNS/TLS,
and the Quorum application workloads themselves.

This extends the existing LocalStack-targeted Crossplane setup in [`crossplane/`](../../../crossplane/)
to a real-AWS production footprint, and replaces the OpenAI dependency with AWS Bedrock.

### Non-goals

- Multi-region / active-active. Single region (`ap-southeast-2` default) per environment.
- A hub/management EKS cluster. The control plane stays local (see §3).
- GitOps (ArgoCD/Flux). App delivery is via Crossplane `provider-helm` (see §8). GitOps remains a
  possible later evolution.
- Migrating the existing LocalStack dev path. It is kept as-is under the `aws-local` ProviderConfig.

---

## 2. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | **Scope** Crossplane owns | Everything: VPC, EKS, IRSA, ALB, Bedrock, Route53/ACM, Secrets Manager |
| 2 | **Control plane location** | Local (Docker Desktop / kind), permanent — provisions into real AWS |
| 3 | **IaC structure** | Compositions + XRDs, one `Claim` per environment |
| 4 | **Composition decomposition** | Flat-composition-first (one Composition, fenced sections); lift to nested XRDs later |
| 5 | **App delivery onto EKS** | Crossplane `provider-helm` + `provider-kubernetes` (single declarative flow) |
| 6 | **LLM / embeddings** | AWS Bedrock now. LLM default `amazon.nova-micro-v1:0` (cheapest; a Claim knob). Embeddings `amazon.titan-embed-text-v2` (1024-dim) |

### Established conventions adopted from the reference project

(`/Users/ayan/Desktop/Work/vscode/low-carb-diet-app/backend/k8s/crossplane`)

- Upbound AWS providers (`*.aws.upbound.io`).
- **Label-selector cross-references** between managed resources (`vpcIdSelector.matchLabels`, etc.)
  rather than hardcoded IDs.
- `writeConnectionSecretToRef` to surface resolved endpoints/credentials.
- `ProviderConfig` switching: `aws-prod` (creds from a `crossplane-system` secret) vs `aws-local`
  (LocalStack). Production `aws-prod` uses static-key secret now; IRSA-for-the-provider is a later
  hardening step.
- A `scripts/deploy-aws.sh` orchestrator with a checksums drift file.
- Default region `ap-southeast-2`.
- CloudWatch log groups + alarms + SNS for observability/alerting.

---

## 3. Topology

```
┌─ LOCAL (Docker Desktop / kind) ─ permanent control plane ──┐
│  Crossplane core                                           │
│  AWS providers (ec2/eks/iam/rds/elasticache/s3/dynamodb/   │
│                 secretsmanager/route53/acm/cloudwatch)     │
│  provider-helm  ·  provider-kubernetes                     │
│  composition functions (patch-and-transform, auto-ready)   │
│  ProviderConfig: aws-prod (creds secret) · aws-local       │
└───────────────────────────┬────────────────────────────────┘
                            │ AWS API calls (region ap-southeast-2)
                            ▼
┌─ AWS ───────────────────────────────────────────────────────┐
│  VPC (3 AZ): public + private subnets, IGW, NAT, routes     │
│   └─ EKS cluster + managed node group + OIDC (IRSA)         │
│        ├─ RDS PostgreSQL 16        (private subnets)        │
│        ├─ ElastiCache Redis 7      (private subnets)        │
│        ├─ S3 (quorum-configs)      DynamoDB ×2              │
│        ├─ IAM/IRSA roles · Secrets Manager · ACM · Route53 │
│        └─ Bedrock (InvokeModel via IRSA)                    │
│                                                             │
│  EKS workloads (Helm via provider-helm):                    │
│    aws-load-balancer-controller · external-secrets (ESO)    │
│    quorum chart: gateway · dashboard · graphiti · falkordb  │
│                  · jobs (decay/archive/recheck)             │
└─────────────────────────────────────────────────────────────┘
```

**Why the control plane stays local:** matches the operator's prior working pattern (local k8s +
Crossplane → real AWS via a Crossplane identity), avoids an always-on management cluster, and keeps
the bootstrap dependency on a laptop/CI runner that already holds AWS credentials. The trade-off
(control plane not HA in AWS) is acceptable because Crossplane reconciliation is desired-state: if
the local cluster is down, running AWS resources are unaffected; only new changes pause.

---

## 4. The Claim API

A namespaced `QuorumEnvironment` claim, backed by a cluster-scoped `XQuorumEnvironment` XRD.
One claim file per environment under `crossplane/claims/`.

```yaml
apiVersion: platform.quorum.io/v1alpha1
kind: QuorumEnvironment
metadata:
  name: quorum-prod
  namespace: quorum-system
spec:
  parameters:
    environment: prod                      # dev | staging | prod
    region: ap-southeast-2
    domainName: quorum.acme.internal       # ACM cert + Route53 record
    hostedZoneId: Z0XXXXXXXXXXXXX
    network:
      vpcCidr: 10.20.0.0/16
      azCount: 3
    eks:
      version: "1.31"
      nodeInstanceType: m6i.large
      nodeMinCount: 2
      nodeMaxCount: 4
    rds:
      instanceClass: db.r7g.large
      allocatedStorageGiB: 100
      multiAz: true
    redis:
      nodeType: cache.r7g.large
      replicas: 2
    bedrock:
      llmModelId: amazon.nova-micro-v1:0   # cheapest; bump to nova-lite/haiku if extraction is poor
      embedModelId: amazon.titan-embed-text-v2
      embedDim: 1024
    app:
      chartVersion: "0.4.x"
      gatewayReplicas: 3
  compositionRef:
    name: xquorumenvironment
  writeConnectionSecretToRef:
    name: quorum-prod-connection
    namespace: quorum-system
```

Sizing defaults derive from `environment` (dev → smaller classes) but every value is overridable on
the claim. `kubectl apply -f claims/prod.yaml` converges the whole environment.

---

## 5. Composition structure

**Flat-composition-first.** One `Composition` (`xquorumenvironment`) using the
`function-patch-and-transform` pipeline, holding all composed resources grouped into clearly fenced
sections. One XRD, one Claim. Sections are authored so they lift cleanly into nested XRDs
(`XNetwork`, `XCluster`, `XData`, `XIam`, `XApp`) when reuse/testing-in-isolation justifies it.

```
crossplane/
  apis/environment/
    definition.yaml          # XRD: XQuorumEnvironment (+ claim QuorumEnvironment)
    composition.yaml         # Composition: pipeline of fenced sections (below)
  claims/
    dev.yaml  staging.yaml  prod.yaml
  providers/
    providers.yaml           # all provider packages (pinned versions)
    functions.yaml           # function-patch-and-transform, function-auto-ready
    providerconfig-aws-prod.yaml
    providerconfig-aws-local.yaml   # existing LocalStack path, retained
  control-plane/
    provider-helm.yaml       # provider-helm + ProviderConfig(EKS kubeconfig)
    provider-kubernetes.yaml # provider-kubernetes + ProviderConfig(EKS kubeconfig)
  # existing bucket/ dynamodb/ rds/ redis/ remain as the aws-local dev reference
scripts/
  deploy-aws.sh              # extended orchestrator (see §9)
```

---

## 6. Composed layers (sections of the Composition)

Crossplane resolves creation order from references; sections below are logical groupings.

### 6.1 Network
VPC, 3× public + 3× private subnets across AZs, Internet Gateway, NAT Gateway(s), route tables and
associations. Public subnets host the ALB; private subnets host nodes, RDS, and Redis. Label-selector
wiring throughout.

### 6.2 EKS
- Cluster IAM role + `eks.aws.upbound.io/Cluster` (private+public endpoint, in the VPC private subnets).
- Node IAM role + managed `NodeGroup` (min/max from claim, in private subnets).
- **OIDC provider** association — the prerequisite for IRSA (pod-level IAM without static keys).

### 6.3 Data
Promotes the shapes already in [`crossplane/`](../../../crossplane/) into composed templates with
production values:
- **RDS PostgreSQL 16** — private subnet group, `storageEncrypted: true` + KMS, `multiAz`,
  `deletionProtection`, parameterized backups. Password sourced from Secrets Manager (§6.5).
- **ElastiCache Redis 7** `ReplicationGroup` — private subnet group, at-rest + in-transit encryption,
  automatic failover, `numCacheClusters` from claim.
- **S3** `quorum-configs` bucket — versioning, SSE-KMS, public-access block, lifecycle.
- **DynamoDB** `quorum-configs` + `quorum-user-projects` (with GSI) — PITR + SSE-KMS enabled.

### 6.4 IAM / IRSA
Per-workload roles trust-bound to the EKS OIDC provider + service account:
- **gateway** — S3 RW (configs bucket), DynamoDB RW (both tables), SecretsManager read
  (`quorum/<env>/*`), `bedrock:InvokeModel` (governance LLM calls).
- **graphiti** — `bedrock:InvokeModel` (entity extraction + embeddings).
- **aws-load-balancer-controller** — the standard ALB controller policy.
- **external-secrets (ESO)** — SecretsManager read on `quorum/<env>/*`.

### 6.5 Secrets
Secrets Manager secret `quorum/<env>/gateway` holding: `QUORUM_JWT_PRIVATE_KEY`,
`QUORUM_JWT_PUBLIC_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `POSTGRES_PASSWORD`. Values are
seeded out-of-band (not in git). RDS consumes the password; ESO projects the rest into the EKS
`quorum` namespace as a Kubernetes secret consumed by the gateway pod via `envFrom`.

### 6.6 DNS / TLS
- **ACM** certificate for `domainName`, DNS-validated (validation records in the hosted zone).
- **Route53** A/ALIAS record → the ALB. Created after the ingress provisions the ALB; the ALB
  hostname flows back via the ingress status (external-dns is an optional later add).

### 6.7 App delivery
`provider-helm` `Release` resources (ordered after EKS + data readiness):
1. `aws-load-balancer-controller` (IRSA-annotated SA).
2. `external-secrets` operator + a `ClusterSecretStore` pointing at Secrets Manager.
3. **Quorum chart** ([`helm/quorum/`](../../../helm/quorum/)) with `values-aws.yaml`: IRSA SA
   annotations on gateway/graphiti, ingress on ALB + ACM cert, Bedrock env (§7), and connection
   wiring from §6.8.

### 6.8 Connection-detail propagation (design point)
Crossplane writes RDS/Redis endpoints as connection secrets into the **local** control plane, but the
app needs them in **EKS**. Resolution:
- A `provider-kubernetes` `ProviderConfig` authenticates to the new EKS cluster using the EKS
  connection secret Crossplane writes (kubeconfig/CA/token).
- `provider-kubernetes` `Object`s (or the Helm release values) project the RDS/Redis endpoints into
  the `quorum` namespace in EKS.
- App-level secrets (JWT/OAuth/password) flow via **ESO from Secrets Manager**, so they never persist
  long-term in the local control plane's etcd.

This avoids the anti-pattern of staging real production secrets in a laptop-resident cluster.

---

## 7. Bedrock migration

Replaces `OPENAI_API_KEY` for both consumers:
- **Gateway** governance endpoints (conflict detection, enrichment, extract) → Bedrock LLM.
- **Graphiti** sidecar → Bedrock LLM (entity extraction) + Bedrock embedder.

Configuration (no API keys; IRSA grants `bedrock:InvokeModel`):

```env
# replaces OPENAI_API_KEY / LLM_MODEL_NAME / EMBEDDER_MODEL_NAME
AWS_REGION=ap-southeast-2
LLM_PROVIDER=bedrock
LLM_MODEL_NAME=amazon.nova-micro-v1:0
EMBEDDER_PROVIDER=bedrock
EMBEDDER_MODEL_NAME=amazon.titan-embed-text-v2
```

### Risks / validation tasks
- **Graphiti Bedrock support — must verify.** Confirm the Graphiti image's LLM/embedder client
  supports a Bedrock backend and the exact env/config it expects. If not natively supported, this
  blocks the Bedrock-for-Graphiti path and we either patch the sidecar config or fall back to
  OpenAI-via-Secrets-Manager for Graphiti only. **Verify before committing the Composition.**
- **Embedding dimension change.** Current `text-embedding-3-small` = 1536-dim; `titan-embed-text-v2`
  = 1024-dim. FalkorDB embeddings must be regenerated. Low risk per Quorum's durability model (the
  graph is a disposable search layer; durable content lives in PostgreSQL `knowledge_versions.summary`),
  but it is an explicit re-embed step on cutover.
- **Tiny-model extraction quality.** `nova-micro` is the cheapest model; entity extraction is the one
  task where a very small model can wobble. The model is a Claim knob — smoke-test extraction after
  first deploy and bump to `amazon.nova-lite-v1:0` or `anthropic.claude-3-5-haiku` if quality is poor.

---

## 8. Why provider-helm (app delivery)

The control plane stays local and owns everything; installing the app from the same control plane via
`provider-helm` keeps infra + app in one declarative `Claim`, wired directly to Crossplane-produced
connection secrets and IRSA role ARNs. No separate `helm install` step, no extra GitOps component to
operate for a first cut. ArgoCD/GitOps remains a clean later evolution (Crossplane would bootstrap
ArgoCD; ArgoCD syncs the chart) once app-lifecycle needs outgrow a single release.

---

## 9. Deployment flow (`scripts/deploy-aws.sh`)

Extends the reference's script-driven orchestration:

```
deploy-aws.sh aws <env>:
  1. Ensure local cluster + Crossplane core healthy.
  2. Apply providers + functions; wait Healthy.
  3. Apply ProviderConfig aws-prod (creds secret must exist in crossplane-system).
  4. Apply XRD (apis/environment/definition.yaml) + Composition (composition.yaml).
  5. Apply claim (claims/<env>.yaml).
  6. Wait for the composite Ready: network → eks → data → iam → secrets.
  7. provider-kubernetes ProviderConfig binds to EKS (from EKS connection secret).
  8. provider-helm rolls out ALB controller, ESO, then the Quorum chart.
  9. ACM validates; Route53 record → ALB; verify HTTPS /health.
```

A checksums file (mirroring `.crossplane-checksums` in the reference) guards against unintended
manifest drift between runs.

---

## 10. Observability (CloudWatch / SNS)

Per the reference convention: CloudWatch log groups for gateway/graphiti, metric filters
(error rate, 5xx), and alarms (RDS CPU/storage/connections, EKS node health, ALB target health, ACM
expiry) fanning out to an SNS topic with an email subscription. Scoped as part of the Composition's
observability section; can be deferred to a follow-up if first-deploy scope needs trimming.

---

## 11. Open items to resolve during implementation

1. **Verify Graphiti Bedrock support** (§7) — gating, do first.
2. Confirm Bedrock model availability + access enabled in `ap-southeast-2` for the chosen model IDs.
3. Choose composition function versions (`function-patch-and-transform`, `function-auto-ready`) and
   pin provider package versions.
4. Decide NAT strategy (single NAT vs per-AZ) per environment cost/HA target.
5. KMS key strategy (one CMK per environment vs per-service).
6. Where production secret values are seeded from (manual `aws secretsmanager put-secret-value` vs an
   existing secret store) — out of git either way.

---

## 12. Success criteria

- `kubectl apply -f claims/<env>.yaml` converges to a Ready composite with all AWS resources present.
- The Quorum gateway is reachable over HTTPS at `domainName`, `/health` returns healthy with
  PostgreSQL, Graphiti, Redis all connected.
- Gateway and Graphiti perform LLM/embedding operations via Bedrock with **no OpenAI key present**.
- No long-lived production secrets stored in the local control plane (secrets via ESO/Secrets Manager).
- Tearing down the claim removes the AWS footprint cleanly (respecting `deletionProtection` on RDS as
  an intentional guard).
```
