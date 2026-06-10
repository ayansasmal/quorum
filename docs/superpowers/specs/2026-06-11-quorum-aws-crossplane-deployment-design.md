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
to a real-AWS production footprint. The LLM/embedding provider stays **OpenAI** (Graphiti has no AWS
Bedrock client — see §7); the OpenAI API key is provisioned through Secrets Manager + ESO rather than
committed anywhere.

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
| 1 | **Scope** Crossplane owns | Everything: VPC, EKS, IRSA, ALB, Route53/ACM, Secrets Manager |
| 2 | **Control plane location** | Local (Docker Desktop / kind), permanent — provisions into real AWS |
| 3 | **IaC structure** | Compositions + XRDs, one `Claim` per environment |
| 4 | **Composition decomposition** | Flat-composition-first (one Composition, fenced sections); lift to nested XRDs later |
| 5 | **App delivery onto EKS** | Crossplane `provider-helm` + `provider-kubernetes`. Gateway and dashboard are **independent Releases** (independent update/rollback); graphiti/falkordb/jobs bundled as one backing release |
| 6 | **LLM / embeddings** | **OpenAI** (Graphiti has no Bedrock client). Key via Secrets Manager + ESO. Models stay current: `gpt-*` for extraction, `text-embedding-3-small` (1536-dim) — no re-embed |

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
│        └─ IAM/IRSA roles · Secrets Manager · ACM · Route53 │
│           (OpenAI API key held in Secrets Manager)          │
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
    llm:
      provider: openai                     # Graphiti has no Bedrock client (§7)
      model: gpt-4o-mini                   # extraction/governance model (Claim knob)
      embedModel: text-embedding-3-small
      embedDim: 1536                        # unchanged → no FalkorDB re-embed
      # OPENAI_API_KEY is NOT here — sourced from Secrets Manager via ESO (§6.5)
    app:
      gateway:
        imageTag: "0.4.12"           # bump to deploy gateway alone
        replicas: 3
      dashboard:
        imageTag: "0.4.12"           # bump to deploy dashboard alone
      backing:
        chartVersion: "0.4.x"        # graphiti + falkordb + jobs (bundled)
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
  (`quorum/<env>/*`). No LLM IAM needed — OpenAI is called with an API key (§6.5), not IRSA.
- **graphiti** — no AWS IAM role required; it talks only to FalkorDB and OpenAI (key from the
  ESO-projected secret).
- **aws-load-balancer-controller** — the standard ALB controller policy.
- **external-secrets (ESO)** — SecretsManager read on `quorum/<env>/*`.

### 6.5 Secrets
Secrets Manager secret `quorum/<env>/gateway` holding: `QUORUM_JWT_PRIVATE_KEY`,
`QUORUM_JWT_PUBLIC_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `POSTGRES_PASSWORD`,
`OPENAI_API_KEY`. Values are seeded out-of-band (not in git). RDS consumes the password; ESO projects
the rest into the EKS `quorum` namespace as a Kubernetes secret. The gateway consumes it via `envFrom`;
`OPENAI_API_KEY` is also referenced by the graphiti pod (both consume the same ESO-projected secret) so
the key is never committed and never lands in the local control plane's etcd.

### 6.6 DNS / TLS
- **ACM** certificate for `domainName`, DNS-validated (validation records in the hosted zone).
- **Route53** A/ALIAS record → the ALB. Created after the ingress provisions the ALB; the ALB
  hostname flows back via the ingress status (external-dns is an optional later add).

### 6.7 App delivery
`provider-helm` `Release` resources (ordered after EKS + data readiness). **Cluster add-ons** first,
then the Quorum app split into independently-deployable releases:

Cluster add-ons (rarely change):
1. `aws-load-balancer-controller` (IRSA-annotated SA).
2. `external-secrets` operator + a `ClusterSecretStore` pointing at Secrets Manager.

Quorum app releases (all use `values-aws.yaml` base + IRSA SA annotations, ingress on ALB + ACM cert,
OpenAI env (§7), and connection wiring from §6.8):

| Release | Contents | Change frequency | Independent rollback |
|---------|----------|------------------|----------------------|
| `quorum-gateway` | gateway Deployment, HPA, gateway ingress, gateway IRSA SA | high | ✅ own revision history |
| `quorum-dashboard` | dashboard (nginx SPA) Deployment, dashboard ingress | high | ✅ own revision history |
| `quorum-backing` | graphiti, falkordb, jobs (decay/archive/recheck), shared config | low | bundled (per decision) |

Deploying a gateway change = bump `quorum-gateway`'s image tag → only that Release upgrades, with its
own `helm history` / `helm rollback`. The dashboard and backing releases are never opened, and the
Composition's data/infra resources are untouched. Same for a dashboard-only change. The data services
(RDS, ElastiCache, S3, DynamoDB) are Composition-managed resources, **not** Helm — they are never
involved in an app deploy.

> **Chart implication:** `helm/quorum/` is refactored into an umbrella chart with `gateway`,
> `dashboard`, and `backing` subcharts (or component-enable toggles) so each can be released
> independently while sharing common values (ingress host, ACM cert ARN, IRSA annotations). See §11.

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

## 7. LLM / embeddings — OpenAI (no Bedrock)

**Why not Bedrock:** verified against Graphiti's current clients (`graphiti_core`) — the supported
LLM/embedder backends are OpenAI, Azure OpenAI, Anthropic (direct Anthropic API), Google Gemini, Groq,
and OpenAI-generic (Ollama/local). **There is no AWS Bedrock client.** Anthropic support is the direct
API, not Bedrock. Rather than fork Graphiti or split providers, both consumers stay on OpenAI:
- **Gateway** governance endpoints (conflict detection, enrichment, extract) → OpenAI.
- **Graphiti** sidecar → OpenAI LLM (entity extraction) + OpenAI embedder.

Configuration (unchanged provider; key delivered via Secrets Manager → ESO, never committed):

```env
OPENAI_API_KEY=<from quorum/<env>/gateway secret via ESO>
LLM_MODEL_NAME=gpt-4o-mini
EMBEDDER_MODEL_NAME=text-embedding-3-small   # 1536-dim — no FalkorDB re-embed
```

### Notes
- **No embedding-dimension change.** Staying on `text-embedding-3-small` (1536-dim) means existing
  FalkorDB embeddings remain valid — no re-embed step on cutover.
- **No LLM IAM.** OpenAI is reached over HTTPS with the API key; no `bedrock:InvokeModel`, no per-pod
  IRSA role for LLM access (§6.4).
- **Key hygiene is the only cost.** The single new secret value (`OPENAI_API_KEY`) lives in Secrets
  Manager and is projected by ESO into EKS — it never touches git or the local control plane's etcd.
- **Bedrock remains a future option** if/when Graphiti ships a Bedrock client or if Graphiti is
  swapped out; it would reintroduce the IRSA-for-LLM path and an embed-dimension migration.

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

1. Choose composition function versions (`function-patch-and-transform`, `function-auto-ready`) and
   pin provider package versions.
2. Decide NAT strategy (single NAT vs per-AZ) per environment cost/HA target.
3. KMS key strategy (one CMK per environment vs per-service).
4. Where production secret values are seeded from (manual `aws secretsmanager put-secret-value` vs an
   existing secret store) — `OPENAI_API_KEY` included; out of git either way.
5. **Chart refactor for independent releases** (§6.7) — restructure `helm/quorum/` into an umbrella
   chart with `gateway`, `dashboard`, and `backing` subcharts so each maps to its own `provider-helm`
   `Release` with independent `helm history`/`helm rollback`, while sharing common values (ingress
   host, ACM cert ARN, IRSA SA annotations). Decide subcharts-vs-component-toggles during implementation.

---

## 12. Success criteria

- `kubectl apply -f claims/<env>.yaml` converges to a Ready composite with all AWS resources present.
- The Quorum gateway is reachable over HTTPS at `domainName`, `/health` returns healthy with
  PostgreSQL, Graphiti, Redis all connected.
- Gateway and Graphiti perform LLM/embedding operations via OpenAI, with `OPENAI_API_KEY` delivered
  only through ESO/Secrets Manager — never committed and never in the local control plane's etcd.
- No long-lived production secrets stored in the local control plane (secrets via ESO/Secrets Manager).
- **Gateway and dashboard are independently deployable and rollback-able** — bumping one's image tag
  upgrades only its `provider-helm` `Release` (own `helm history`), leaving the other release, the
  `quorum-backing` release, and all Composition-managed infra untouched.
- Tearing down the claim removes the AWS footprint cleanly (respecting `deletionProtection` on RDS as
  an intentional guard).
```
