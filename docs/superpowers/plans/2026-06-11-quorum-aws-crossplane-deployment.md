# Quorum AWS-via-Crossplane Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision a single-instance, cost-controlled AWS deployment of the Quorum backend (gateway + Graphiti + FalkorDB + Redis + Caddy) using a local Crossplane v2 control plane, with RDS PostgreSQL as the durable source of truth and a versioned S3 snapshot of derived state — all authored and validated offline, with every AWS-mutating action gated behind explicit operator approval.

**Architecture:** One Crossplane v2 namespaced XR (`XQuorumEnvironment`) rendered by one flat pipeline `Composition` provisions VPC + a public-subnet Graviton EC2 (Amazon Linux 2023, arm64) running `docker-compose.aws.yml`, an RDS PostgreSQL 16 instance, three versioned S3 buckets, a DynamoDB membership table, a KMS key, CloudWatch logs, and AWS-native cost controls (EventBridge Scheduler daily auto-stop, disabled auto-start, AWS Budget + SSM Automation action). The EC2 box is disposable: PostgreSQL (RDS) holds all governed knowledge; FalkorDB's derived graph/embeddings and Caddy's TLS material are snapshotted to S3 and restored on boot. DNS lives in Vercel (`quorum-gateway.ayansasmal.work` → EIP); Caddy issues TLS via ACME HTTP-01. The dashboard is **not** in AWS (separate Vercel deploy).

**Tech Stack:** Crossplane v2.3.2 (core and CLI, local Docker Desktop K8s) · `crossplane composition render` + `crossplane resource validate` · namespaced Upbound provider-family-aws v2 managed resources (ec2, rds, s3, iam, dynamodb, kms, cloudwatchlogs, scheduler, budgets, ssm) · `function-patch-and-transform` v0.10.6 · Docker Compose v2 · Caddy 2 · systemd · AWS CLI v2 · Node 24 / vitest + ajv · shellcheck · Amazon Linux 2023 (arm64).

---

## Conventions for the Implementing Agent (read once, apply throughout)

1. **Working directory:** all paths are relative to `quorum/` (the git repo root is `quorum/`, not the workspace root). Run git commands from `quorum/`.
2. **Commit messages are LOWERCASE conventional commits.** The husky `commit-msg` hook runs commitlint with `subject-case` lower-case enforced — capitals like `AWS`, `OpenAI`, `RDS` in the *subject line* fail the hook. Use them freely in the body. End every commit body with:
   ```
   Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
   ```
3. **Never run an AWS-mutating command.** This entire plan is authored and validated **offline**. The only commands you run create no AWS resources: `crossplane composition render`, `crossplane resource validate`, `helm template`, `shellcheck`, `bash -n`, `docker compose config`, `npx vitest`, `ajv`, `docker buildx build` (no `--push`). Anything that applies providers/XRDs/XRs, seeds Secrets Manager, pushes images, or edits DNS is the operator's job after handoff — the deploy script (M7) refuses to mutate without an explicit `apply` argument.
4. **Do not touch the existing LocalStack manifests** under `crossplane/provider/`, `crossplane/rds/`, `crossplane/redis/`, etc. New production files live under the new `crossplane/apis/`, `crossplane/environments/`, `crossplane/providers/`, `crossplane/bootstrap/`, `crossplane/ops/` directories and use explicit `aws-prod` names.
5. **No secret values in git.** `quorum/.env.prod` already exists, is gitignored, and holds real operator secrets — never read it into a committed file, never `cat` it into output, never reference its values. The seed step consumes it locally only.
6. **JSDoc/comments:** add a top-of-file comment block to every script and a `# E2E:`/purpose comment to non-obvious manifests, matching the density of the existing repo files you read.
7. **Verify provider field names against downloaded provider CRDs, never from memory.** Crossplane provider CRD schemas are version-specific. `crossplane composition render` executes the function pipeline; it does not prove managed-resource fields are valid. Pipe the full render through `crossplane resource validate --error-on-missing-schemas` and fix every unknown or missing field against the pinned provider schema.
8. **Use one kind throughout.** The XRD defines `XQuorumEnvironment`, so the canonical XR and the Composition both use `kind: XQuorumEnvironment`. A v2 namespaced XR composes namespaced managed resources; use provider API groups ending in `.m.upbound.io`.

---

## File Structure (what gets created)

```text
quorum/crossplane/
  apis/environment/
    definition.yaml              # XRD: XQuorumEnvironment (cluster) → QuorumEnvironment (namespaced)
    composition.yaml             # one pipeline Composition, function-patch-and-transform
  environments/
    prod.yaml                    # the QuorumEnvironment XR (no secrets)
  providers/
    providers.yaml               # pinned provider-family-aws v2 subpackages
    functions.yaml               # function-patch-and-transform, pinned
    providerconfig-aws-prod.yaml # prod ProviderConfig (IRSA/secret ref, NO localstack flags)
    providerconfig-aws-local.yaml# copy of existing localstack config, renamed (reference only)
  ops/
    quorum-resume.sh             # operator laptop: start RDS→EC2, poll health
    quorum-suspend.sh            # operator laptop: SSM snapshot, stop EC2+RDS
  bootstrap/
    ec2-userdata.sh              # minimal: pull bundle from S3, run start.sh
    start.sh                     # idempotent boot: discover RDS, fetch secrets, restore snapshot, compose up
    refresh-rds-credentials.sh   # re-fetch RDS managed secret every 15m
    snapshot-save.sh             # BGSAVE FalkorDB + tar Caddy → S3
    snapshot-restore.sh          # latest S3 snapshot → volumes before compose up
    docker-compose.aws.yml       # backend-only stack (NO localstack, NO dashboard) + caddy
    Caddyfile                    # quorum-gateway.ayansasmal.work → gateway:3001, ACME
    init-db.sql                  # idempotent audit schema bootstrap
    systemd/                     # 11 unit/timer files (see M4)
  deploy.sh                      # gated: render/validate by default; mutate only on `apply`
  tests/
    render.test.js               # composition render smoke + resource assertions
    xrd-schema.test.js           # ajv: XR schema accepts valid / rejects invalid
    bootstrap.test.js            # shellcheck + bash -n over bootstrap/ops scripts
    compose.test.js              # docker compose config valid + no dashboard/localstack
quorum/docs/
  DEPLOYMENT-AWS.md              # operator runbook (deploy order, resume/suspend, teardown)
```

The existing lowercase singular dirs (`provider/`, `rds/`, …) stay as the LocalStack reference.

---

## Milestone M0 — Scaffolding, tooling, and the test harness

**Goal:** create the directory tree, pin the crossplane CLI, and stand up an offline test harness that every later milestone extends. Nothing here touches AWS.

### Task M0.1: Confirm tooling versions

**Files:** none (verification only)

- [ ] **Step 1: Check the crossplane CLI has `render`**

Run: `crossplane version --client`
Expected: a client version is printed. Then:
Run: `crossplane composition render --help | head -1`
Expected: help text for `composition render` (not "unknown command"). Record the working command in `docs/DEPLOYMENT-AWS.md` later.

Run: `crossplane resource validate --help | head -1`
Expected: help text for offline schema validation.

- [ ] **Step 2: Confirm Docker + buildx + compose are present**

Run: `docker buildx version && docker compose version`
Expected: both print versions (buildx ≥ 0.10, compose ≥ 2.20).

- [ ] **Step 3: Confirm shellcheck**

Run: `shellcheck --version`
Expected: prints version. If missing: `brew install shellcheck` (operator action, ask first).

### Task M0.2: Create the directory tree

**Files:**
- Create: `crossplane/apis/environment/`, `crossplane/environments/`, `crossplane/providers/`, `crossplane/ops/`, `crossplane/bootstrap/systemd/`, `crossplane/tests/`

- [ ] **Step 1: Make the directories**

Run:
```bash
mkdir -p crossplane/apis/environment crossplane/environments crossplane/providers \
  crossplane/ops crossplane/bootstrap/systemd crossplane/tests
```
Expected: no output, exit 0.

- [ ] **Step 2: Add a .gitkeep placeholder so empty dirs commit**

Create `crossplane/tests/.gitkeep` (empty file).

- [ ] **Step 3: Commit the scaffold**

```bash
git add crossplane/tests/.gitkeep
git commit -m "chore(deploy): scaffold production crossplane directory tree"
```

### Task M0.3: Wire the offline test harness into package.json

**Files:**
- Modify: `package.json` (root `quorum/package.json` — add a `test:deploy` script)
- Create: `crossplane/tests/bootstrap.test.js`

- [ ] **Step 1: Write the failing test (shellcheck/bash -n over scripts)**

Create `crossplane/tests/bootstrap.test.js`:
```javascript
/**
 * @file Offline validation for all production bootstrap + ops shell scripts.
 * Runs shellcheck and `bash -n` over every *.sh under crossplane/bootstrap and
 * crossplane/ops. No script is executed — only linted and syntax-checked.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** @returns {string[]} absolute paths of every *.sh under the given dir (non-recursive + systemd) */
function shellScripts(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.sh')).map((f) => join(dir, f))
}

const scripts = [
  ...shellScripts('crossplane/bootstrap'),
  ...shellScripts('crossplane/ops'),
]

describe('S-DEPLOY bootstrap and ops scripts', () => {
  it('finds the expected scripts once authored', () => {
    // This guard flips meaningful once M4/M5 land; until then it documents intent.
    expect(Array.isArray(scripts)).toBe(true)
  })

  for (const script of scripts) {
    it(`${script} passes bash -n`, () => {
      expect(() => execFileSync('bash', ['-n', script])).not.toThrow()
    })
    it(`${script} passes shellcheck`, () => {
      expect(() => execFileSync('shellcheck', ['-x', script])).not.toThrow()
    })
  }
})
```

- [ ] **Step 2: Add the script to package.json**

In `package.json`, add to `"scripts"`:
```json
"test:deploy": "vitest run crossplane/tests"
```

- [ ] **Step 3: Run it to verify it passes (no scripts yet → only the guard runs)**

Run: `npm run test:deploy`
Expected: PASS, 1 test ("finds the expected scripts once authored"). Zero per-script tests because none exist yet.

- [ ] **Step 4: Commit**

```bash
git add package.json crossplane/tests/bootstrap.test.js
git commit -m "test(deploy): add offline shellcheck and syntax harness for bootstrap scripts"
```

---

## Milestone M1 — Production providers, functions, and ProviderConfig

**Goal:** declare the pinned AWS provider subpackages, the patch-and-transform function, and a production ProviderConfig that contains **none** of the LocalStack overrides. These are authored, not applied.

### Task M1.1: Pin the provider-family subpackages

**Files:**
- Create: `crossplane/providers/providers.yaml`
- Read first: `crossplane/provider/provider-family-aws.yaml` (existing, for the runtime-config pattern to NOT copy)

- [ ] **Step 1: Write providers.yaml**

Create `crossplane/providers/providers.yaml`:
```yaml
# Production AWS provider-family subpackages, pinned to the v2 line.
# Applied by the operator (deploy.sh apply), NOT during validation.
# Each subpackage shares the same provider-family runtime; pins must agree.
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-ec2
spec:
  package: xpkg.upbound.io/upbound/provider-aws-ec2:v2.5.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-rds
spec:
  package: xpkg.upbound.io/upbound/provider-aws-rds:v2.5.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-s3
spec:
  package: xpkg.upbound.io/upbound/provider-aws-s3:v2.5.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-iam
spec:
  package: xpkg.upbound.io/upbound/provider-aws-iam:v2.5.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-dynamodb
spec:
  package: xpkg.upbound.io/upbound/provider-aws-dynamodb:v2.5.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-kms
spec:
  package: xpkg.upbound.io/upbound/provider-aws-kms:v2.5.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-cloudwatchlogs
spec:
  package: xpkg.upbound.io/upbound/provider-aws-cloudwatchlogs:v2.5.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-scheduler
spec:
  package: xpkg.upbound.io/upbound/provider-aws-scheduler:v2.5.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-budgets
spec:
  package: xpkg.upbound.io/upbound/provider-aws-budgets:v2.3.0
```

> **Verify before committing:** the family subpackage versions must match a real published tag. Run `crossplane xpkg dep xpkg.upbound.io/upbound/provider-aws-ec2:v2.5.0` if available, or confirm via the Upbound Marketplace. `provider-aws-scheduler` v2.5.0 and `provider-aws-budgets` v2.3.0 were confirmed during design; re-confirm the shared ec2/rds/s3/iam/dynamodb/kms/cloudwatchlogs pin and adjust all to the same latest v2.x tag if v2.5.0 is not current.

- [ ] **Step 2: YAML-validate**

Run: `npx js-yaml crossplane/providers/providers.yaml >/dev/null && echo OK`
Expected: `OK` (install `js-yaml` CLI if missing, or use `python3 -c "import yaml,sys; list(yaml.safe_load_all(open('crossplane/providers/providers.yaml')))"`).

- [ ] **Step 3: Commit**

```bash
git add crossplane/providers/providers.yaml
git commit -m "feat(deploy): pin production aws provider-family subpackages"
```

### Task M1.2: Pin the composition function

**Files:**
- Create: `crossplane/providers/functions.yaml`

- [ ] **Step 1: Write functions.yaml**

```yaml
# Composition pipeline function: patch-and-transform. Pinned.
apiVersion: pkg.crossplane.io/v1
kind: Function
metadata:
  name: function-patch-and-transform
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-patch-and-transform:v0.10.6
```

> **Verify:** confirm `function-patch-and-transform` v0.10.6 is the latest stable on the Upbound Marketplace. `crossplane composition render` runs the function image locally from this manifest — see M3.

- [ ] **Step 2: YAML-validate + commit**

Run: `python3 -c "import yaml; yaml.safe_load(open('crossplane/providers/functions.yaml'))" && echo OK`
Expected: `OK`.
```bash
git add crossplane/providers/functions.yaml
git commit -m "feat(deploy): pin patch-and-transform composition function"
```

### Task M1.3: Production ProviderConfig (no LocalStack flags)

**Files:**
- Create: `crossplane/providers/providerconfig-aws-prod.yaml`
- Create: `crossplane/providers/providerconfig-aws-local.yaml` (renamed copy of existing localstack config, for reference)
- Read first: `crossplane/provider/providerconfig-aws.yaml`

- [ ] **Step 1: Copy the existing localstack config under the new name (reference only)**

Run: `cp crossplane/provider/providerconfig-aws.yaml crossplane/providers/providerconfig-aws-local.yaml`
Expected: file created. Do not edit it; it documents the local variant beside the prod one.

- [ ] **Step 2: Write the prod ProviderConfig**

Create `crossplane/providers/providerconfig-aws-prod.yaml`:
```yaml
# Production AWS ProviderConfig. Region ap-southeast-2 (Sydney).
# NONE of the LocalStack overrides (no custom endpoint, no skip_* flags,
# no s3_use_path_style). Credentials come from a Kubernetes Secret the
# operator creates out-of-band — NO credential values are committed.
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: aws-prod
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: aws-creds-prod      # operator-created; NOT in git
      key: creds
```

> The Secret `aws-creds-prod` is created by the operator (deploy step), never committed. `crossplane/credentials/aws-creds-secret.yaml` is already gitignored; the prod secret follows the same rule.

- [ ] **Step 3: YAML-validate + commit**

Run: `python3 -c "import yaml; yaml.safe_load(open('crossplane/providers/providerconfig-aws-prod.yaml'))" && echo OK`
Expected: `OK`.
```bash
git add crossplane/providers/providerconfig-aws-prod.yaml crossplane/providers/providerconfig-aws-local.yaml
git commit -m "feat(deploy): add production providerconfig without localstack overrides"
```

---

## Milestone M2 — The XRD (composite schema) + schema-rejection tests

**Goal:** define the Crossplane v2 XRD with the full §7 input schema, and prove with ajv tests that it accepts a valid prod XR and rejects invalid ones. The XRD schema is the contract the Composition consumes.

### Task M2.1: Author the XRD

**Files:**
- Create: `crossplane/apis/environment/definition.yaml`

- [ ] **Step 1: Write the XRD**

Create `crossplane/apis/environment/definition.yaml`:
```yaml
# Crossplane v2 XRD. XQuorumEnvironment is itself the namespaced XR API.
# v2 uses apiextensions.crossplane.io/v2 and scope: Namespaced; claims are
# deprecated and no separate QuorumEnvironment claim kind exists.
apiVersion: apiextensions.crossplane.io/v2
kind: CompositeResourceDefinition
metadata:
  name: xquorumenvironments.platform.quorum.dev
spec:
  scope: Namespaced
  group: platform.quorum.dev
  names:
    kind: XQuorumEnvironment
    plural: xquorumenvironments
  claimNames: null
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: [environment, region, domainName, network, compute, schedule, budget, snapshot, database, llm, tls, dns, images]
              properties:
                environment: { type: string, enum: [prod] }
                region: { type: string, enum: [ap-southeast-2] }
                domainName: { type: string, pattern: '^[a-z0-9.-]+\.[a-z]{2,}$' }
                dashboardUrl: { type: string }
                network:
                  type: object
                  required: [vpcCidr]
                  properties:
                    vpcCidr: { type: string, pattern: '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$' }
                compute:
                  type: object
                  required: [instanceType, capacityType, rootVolumeGiB, arch]
                  properties:
                    instanceType: { type: string }
                    capacityType: { type: string, enum: [on-demand] }
                    rootVolumeGiB: { type: integer, minimum: 20, maximum: 200 }
                    arch: { type: string, enum: [arm64] }
                schedule:
                  type: object
                  required: [timezone, autoStop, autoStart]
                  properties:
                    timezone: { type: string }
                    autoStop:
                      type: object
                      required: [enabled, cron]
                      properties:
                        enabled: { type: boolean }
                        cron: { type: string }
                    autoStart:
                      type: object
                      required: [enabled, cron]
                      properties:
                        enabled: { type: boolean }
                        cron: { type: string }
                budget:
                  type: object
                  required: [monthlyLimitUSD, alertThresholdPercent, actionThresholdPercent, notifyEmail]
                  properties:
                    monthlyLimitUSD: { type: number, minimum: 1 }
                    alertThresholdPercent: { type: integer, minimum: 1, maximum: 1000 }
                    actionThresholdPercent: { type: integer, minimum: 1, maximum: 1000 }
                    notifyEmail: { type: string, pattern: '^[^@]+@[^@]+\.[^@]+$' }
                snapshot:
                  type: object
                  required: [bucketSuffix, intervalMinutes, restoreOnBoot]
                  properties:
                    bucketSuffix: { type: string }
                    intervalMinutes: { type: integer, minimum: 5 }
                    restoreOnBoot: { type: boolean }
                database:
                  type: object
                  required: [engineVersion, instanceClass, allocatedStorageGiB, masterUsername, manageMasterUserPassword]
                  properties:
                    engineVersion: { type: string }
                    instanceClass: { type: string }
                    allocatedStorageGiB: { type: integer, minimum: 20 }
                    masterUsername: { type: string }
                    manageMasterUserPassword: { type: boolean }
                    multiAz: { type: boolean }
                    deletionProtection: { type: boolean }
                    backupRetentionDays: { type: integer, minimum: 0, maximum: 35 }
                llm:
                  type: object
                  required: [provider, model, embedModel, embedDim]
                  properties:
                    provider: { type: string }
                    model: { type: string }
                    embedModel: { type: string }
                    embedDim: { type: integer }
                tls:
                  type: object
                  required: [mode, acmeEmail]
                  properties:
                    mode: { type: string, enum: [acme] }
                    acmeEmail: { type: string }
                dns:
                  type: object
                  required: [provider, manageRoute53]
                  properties:
                    provider: { type: string }
                    manageRoute53: { type: boolean }
                    hostedZoneId: { type: string }
                images:
                  type: object
                  required: [registry, gatewayTag, graphitiTag, applySchema]
                  properties:
                    registry: { type: string }
                    gatewayTag: { type: string }
                    graphitiTag: { type: string }
                    applySchema: { type: boolean }
            status:
              type: object
              properties:
                elasticIp: { type: string }
                instanceId: { type: string }
                rdsEndpoint: { type: string }
                snapshotBucket: { type: string }
```

- [ ] **Step 2: YAML-validate**

Run: `python3 -c "import yaml; yaml.safe_load(open('crossplane/apis/environment/definition.yaml'))" && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add crossplane/apis/environment/definition.yaml
git commit -m "feat(deploy): add quorumenvironment xrd with full input schema"
```

### Task M2.2: Schema-rejection tests with ajv

**Files:**
- Create: `crossplane/tests/xrd-schema.test.js`
- Create: `crossplane/environments/prod.yaml` (the valid XR — also a deliverable)

- [ ] **Step 1: Write the valid prod XR**

Create `crossplane/environments/prod.yaml`:
```yaml
# Production QuorumEnvironment XR. No secrets. Applied by the operator AFTER
# quorum/prod/gateway is seeded in Secrets Manager. domainName confirmed; DNS
# is a Vercel-managed A record (quorum-gateway → EIP), so manageRoute53 stays false.
apiVersion: platform.quorum.dev/v1alpha1
kind: XQuorumEnvironment
metadata:
  name: quorum-prod
  namespace: quorum-system
spec:
  environment: prod
  region: ap-southeast-2
  domainName: quorum-gateway.ayansasmal.work
  dashboardUrl: https://quorum-dashboard.ayansasmal.work
  network:
    vpcCidr: 10.20.0.0/16
  compute:
    instanceType: t4g.large
    capacityType: on-demand
    rootVolumeGiB: 30
    arch: arm64
  schedule:
    timezone: Australia/Sydney
    autoStop:
      enabled: true
      cron: "cron(0 10,23 * * ? *)"
    autoStart:
      enabled: false
      cron: "cron(0 5,16 ? * MON-FRI *)"
  budget:
    monthlyLimitUSD: 40
    alertThresholdPercent: 100
    actionThresholdPercent: 150
    notifyEmail: ayandelhi@gmail.com
  snapshot:
    bucketSuffix: snapshots
    intervalMinutes: 60
    restoreOnBoot: true
  database:
    engineVersion: "16"
    instanceClass: db.t4g.micro
    allocatedStorageGiB: 20
    masterUsername: quorum
    manageMasterUserPassword: true
    multiAz: false
    deletionProtection: false
    backupRetentionDays: 7
  llm:
    provider: openai
    model: gpt-4o-mini
    embedModel: text-embedding-3-small
    embedDim: 1536
  tls:
    mode: acme
    acmeEmail: ayandelhi@gmail.com
  dns:
    provider: vercel-external
    manageRoute53: false
    hostedZoneId: ""
  images:
    registry: ghcr.io/ayansasmal
    gatewayTag: "0.4.12"
    graphitiTag: "0.4.x"
    applySchema: true
```

- [ ] **Step 2: Write the failing ajv test**

Create `crossplane/tests/xrd-schema.test.js`:
```javascript
/**
 * @file Validates the QuorumEnvironment XR against the openAPIV3Schema embedded
 * in the XRD, using ajv. Proves the schema accepts the canonical prod XR and
 * rejects malformed inputs — offline, no Crossplane control plane required.
 */
import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'

/** Extracts the v1alpha1 spec schema object from the XRD document. */
function specSchema() {
  const xrd = yaml.load(readFileSync('crossplane/apis/environment/definition.yaml', 'utf8'))
  const version = xrd.spec.versions.find((v) => v.name === 'v1alpha1')
  return version.schema.openAPIV3Schema.properties.spec
}

/** Loads the canonical prod XR's spec block. */
function prodSpec() {
  return yaml.load(readFileSync('crossplane/environments/prod.yaml', 'utf8')).spec
}

const ajv = new Ajv({ allErrors: true, strict: false })

describe('S-DEPLOY XRD input schema', () => {
  it('accepts the canonical prod XR spec', () => {
    const validate = ajv.compile(specSchema())
    const ok = validate(prodSpec())
    expect(validate.errors).toBeNull()
    expect(ok).toBe(true)
  })

  it('rejects a non-prod environment', () => {
    const validate = ajv.compile(specSchema())
    expect(validate({ ...prodSpec(), environment: 'staging' })).toBe(false)
  })

  it('rejects a non-Sydney region', () => {
    const validate = ajv.compile(specSchema())
    expect(validate({ ...prodSpec(), region: 'us-east-1' })).toBe(false)
  })

  it('rejects a non-arm64 arch', () => {
    const validate = ajv.compile(specSchema())
    const spec = prodSpec()
    expect(validate({ ...spec, compute: { ...spec.compute, arch: 'x86_64' } })).toBe(false)
  })

  it('rejects a spot capacity type', () => {
    const validate = ajv.compile(specSchema())
    const spec = prodSpec()
    expect(validate({ ...spec, compute: { ...spec.compute, capacityType: 'spot' } })).toBe(false)
  })

  it('rejects a malformed notify email', () => {
    const validate = ajv.compile(specSchema())
    const spec = prodSpec()
    expect(validate({ ...spec, budget: { ...spec.budget, notifyEmail: 'not-an-email' } })).toBe(false)
  })

  it('rejects a missing required block (database)', () => {
    const validate = ajv.compile(specSchema())
    const spec = prodSpec()
    delete spec.database
    expect(validate(spec)).toBe(false)
  })
})
```

- [ ] **Step 3: Install dev deps if missing, run the test**

Run: `npm ls ajv js-yaml >/dev/null 2>&1 || npm install -D ajv js-yaml`
Then: `npx vitest run crossplane/tests/xrd-schema.test.js`
Expected: all 7 tests PASS. If "accepts the canonical prod XR" FAILS, the XRD schema and the XR disagree — fix the XRD (not the XR) until it passes.

- [ ] **Step 4: Commit**

```bash
git add crossplane/environments/prod.yaml crossplane/tests/xrd-schema.test.js package.json package-lock.json
git commit -m "test(deploy): validate xr against xrd schema with ajv, reject bad inputs"
```

---

## Milestone M3 — The Composition (rendered and schema-validated offline)

**Goal:** author the single pipeline `Composition` that turns one `XQuorumEnvironment` XR into the full AWS resource graph, and validate it offline. Build it **incrementally** — add a resource group, render, schema-validate, assert, commit — so a failure is always localized to the last group added.

### Task M3.0: Render scaffold + smoke test

**Files:**
- Create: `crossplane/apis/environment/composition.yaml` (skeleton)
- Create: `crossplane/tests/render.test.js`
- Create: `crossplane/tests/render.sh` (helper that invokes `crossplane composition render` with the pinned function)

- [ ] **Step 1: Write the Composition skeleton (pipeline mode, no resources yet)**

Create `crossplane/apis/environment/composition.yaml`:
```yaml
# One flat pipeline Composition for QuorumEnvironment. Uses
# function-patch-and-transform. Resources are added group-by-group in M3.
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xquorumenvironment
  labels:
    provider: aws
    environment: prod
spec:
  compositeTypeRef:
    apiVersion: platform.quorum.dev/v1alpha1
    kind: XQuorumEnvironment
  mode: Pipeline
  pipeline:
    - step: patch-and-transform
      functionRef:
        name: function-patch-and-transform
      input:
        apiVersion: pt.fn.crossplane.io/v1beta1
        kind: Resources
        resources: []
```

- [ ] **Step 2: Write the render helper**

Create `crossplane/tests/render.sh`:
```bash
#!/usr/bin/env bash
# Renders the Composition against the canonical prod XR, fully offline.
# Pulls the patch-and-transform function image once; no AWS calls, no cluster.
# Usage: crossplane/tests/render.sh   → prints rendered managed resources as YAML.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XR="${ROOT}/environments/prod.yaml"
COMPOSITION="${ROOT}/apis/environment/composition.yaml"
FUNCTIONS="${ROOT}/providers/functions.yaml"

# `crossplane composition render <xr> <composition> <functions>` resolves the function image
# from functions.yaml and runs it locally in Docker. If your CLI predates the
# GA command, replace `render` with `beta render`.
crossplane composition render "${XR}" "${COMPOSITION}" "${FUNCTIONS}" --include-full-xr
```

Run: `chmod +x crossplane/tests/render.sh`

- [ ] **Step 3: Write the render smoke test**

Create `crossplane/tests/render.test.js`:
```javascript
/**
 * @file Offline composition render check. Invokes crossplane/tests/render.sh and
 * asserts the rendered output parses as YAML and contains the expected managed
 * resource kinds. Resource-count assertions tighten as M3 adds groups.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import yaml from 'js-yaml'

/** Runs the render helper and returns every rendered document. */
function render() {
  const out = execFileSync('bash', ['crossplane/tests/render.sh'], { encoding: 'utf8' })
  return yaml.loadAll(out).filter(Boolean)
}

describe('S-DEPLOY composition render', () => {
  it('renders without error and yields documents', () => {
    const docs = render()
    expect(Array.isArray(docs)).toBe(true)
  })

  // Assertions below are enabled as each M3 task lands. Keep them in sync.
  it('includes the expected managed resource kinds', () => {
    const kinds = new Set(render().map((d) => d?.kind).filter(Boolean))
    // M3.x tasks add: Key, VPC, Subnet, InternetGateway, RouteTable,
    // SecurityGroup, EIP, Role, Instance (ec2), Instance (rds), Bucket,
    // Table, Group (logs), Schedule, Budget, BudgetAction.
    expect(kinds.size).toBeGreaterThanOrEqual(0)
  })
})
```

- [ ] **Step 4: Render once to prove the toolchain works**

Run: `bash crossplane/tests/render.sh`
Expected: exits 0. With an empty `resources: []` the output is just the XR echoed with an empty status, or an empty render — no error. If it errors pulling the function image, run `docker pull xpkg.upbound.io/crossplane-contrib/function-patch-and-transform:v0.10.6` first (operator may need to approve network egress).

- [ ] **Step 5: Run the smoke test + commit**

Run: `npx vitest run crossplane/tests/render.test.js`
Expected: 2 PASS.
```bash
git add crossplane/apis/environment/composition.yaml crossplane/tests/render.sh crossplane/tests/render.test.js
git commit -m "feat(deploy): add composition skeleton and offline render harness"
```

### Task M3.1 → M3.9: Add resource groups (repeat the loop for each)

For each group below, follow the **same five steps**:

1. **Add the resources** to the `resources:` array in `composition.yaml`. Each entry is a `function-patch-and-transform` resource: a `name`, a `base` (the managed resource manifest with `apiVersion`/`kind`/`spec.forProvider`), and `patches` that copy XR spec fields into the base and copy created IDs back / across resources via `ToCompositeFieldPath` / `FromCompositeFieldPath` and `combine` where needed.
2. **Render:** `bash crossplane/tests/render.sh` → exits 0, new kinds appear.
3. **Tighten** the `render.test.js` "includes the expected managed resource kinds" assertion to require the kinds just added.
4. **Run:** `npx vitest run crossplane/tests/render.test.js` → PASS.
5. **Commit** with `feat(deploy): compose <group> resources`.

> **Field-accuracy rule:** author each `base.spec.forProvider` against the pinned provider CRD, not memory. After adding a group, pipe the render output into `crossplane resource validate`; render alone does not detect unknown managed-resource fields. Use namespaced provider APIs such as `ec2.aws.m.upbound.io/v1beta1`.

The groups, in dependency order:

- [ ] **M3.1 — KMS.** `kms.aws.m.upbound.io/v1beta1` `Key` (+ `Alias`), `region` from `spec.region`, rotation enabled, deletion window = AWS minimum. Every encrypted resource references this key. Assert kind `Key` renders. Commit.

- [ ] **M3.2 — Network.** `VPC` (cidr from `spec.network.vpcCidr`), 1 public `Subnet`, 2 private `Subnet`s in different AZs, `InternetGateway`, public `RouteTable` + `Route` (0.0.0.0/0 → IGW) + `RouteTableAssociation`, `DBSubnetGroup` over the two private subnets. Patches wire subnet IDs via matchController refs or `crossplane.io/external-name`. Assert `VPC`, `Subnet`, `InternetGateway`, `RouteTable` render. Commit.

- [ ] **M3.3 — Security groups.** App `SecurityGroup` + `SecurityGroupRule`s: inbound 80 and 443 from `0.0.0.0/0`, **no 22**, all egress. DB `SecurityGroup` + rule: inbound 5432 only from the app SG. Assert both SGs render; assert no rule opens 22 (add a render assertion that scans for `fromPort: 22` and expects none). Commit.

- [ ] **M3.4 — IAM (three roles).**
  - **Instance role** + `InstanceProfile` + policies scoped to §9.5: config bucket RW, deploy bucket R, snapshot bucket RW, membership table RW, `secretsmanager:GetSecretValue` on `quorum/prod/*` and the RDS-managed secret ARN pattern, `rds:DescribeDBInstances`, `kms:Decrypt` on the env key, CloudWatch Logs put, SSM core managed policy. **No** ec2/rds stop/start.
  - **Scheduler execution role** — `assumeRole` trust for `scheduler.amazonaws.com`; policy = `ec2:StopInstances`/`StartInstances` + `rds:StopDBInstance`/`StartDBInstance` on the two specific ARNs only.
  - **Budget action role** — trust for `budgets.amazonaws.com`; same two-ARN stop/start policy.

  Assert 3 `Role`s + 1 `InstanceProfile` render. Add a render assertion that the instance role policy contains **no** `ec2:StopInstances`. Commit.

- [ ] **M3.5 — Storage + index.** Three `s3.aws.m.upbound.io` `Bucket`s (config, deploy, snapshot) each with `BucketVersioning` enabled and `BucketServerSideEncryptionConfiguration` referencing the KMS key; snapshot bucket gets a `BucketLifecycleConfiguration` expiring noncurrent versions after 14 days. DynamoDB `Table` `quorum-user-projects` with the membership GSI (mirror the existing local table's key schema). Assert 3 `Bucket`s + `Table` render. Commit.

- [ ] **M3.6 — RDS.** `rds.aws.m.upbound.io/v1beta1` `Instance`: engine `postgres`, `engineVersion` from spec, `instanceClass` from spec, `allocatedStorage` from spec, `username` from spec, `manageMasterUserPassword: true`, `dbSubnetGroupNameSelector` → the DB subnet group, `vpcSecurityGroupIdSelector` → DB SG, `storageEncrypted: true` + `kmsKeyId` → env key, `publiclyAccessible: false`, `backupRetentionPeriod` from spec, `finalSnapshotIdentifier` set, `skipFinalSnapshot: false`. Use `crossplane/rds/instance.yaml` as the base shape, translated to the namespaced API. Assert rds `Instance` renders with `manageMasterUserPassword: true`. Commit.

- [ ] **M3.7 — Compute.** `ec2 Instance`: arm64 AL2023 AMI via SSM public parameter or a pinned AMI map for ap-southeast-2, `instanceType` from spec, `iamInstanceProfile` → instance profile, `subnetId` → public subnet, `vpcSecurityGroupIds` → app SG, root `gp3` `ebsBlockDevice` sized from `spec.compute.rootVolumeGiB` + `encrypted: true` + KMS key, `userData` = base64 of `bootstrap/ec2-userdata.sh` templated with the deploy bucket name. `EIP` + `EIPAssociation` to the instance. `cloudwatchlogs Group` for the stack. Assert ec2 `Instance`, `EIP`, log `Group` render. Commit.

- [ ] **M3.8 — Cost control: schedules.** `scheduler.aws.m.upbound.io` `Schedule` ×4:
  - **EC2 stop + RDS stop** — two schedules using `spec.schedule.autoStop.cron`, `scheduleExpressionTimezone` from `spec.schedule.timezone`, `state: ENABLED`, flexible window off, and the matching AWS SDK universal target. Role ARN → scheduler role.
  - **EC2 start + RDS start** — two schedules using `spec.schedule.autoStart.cron`, with `state` patched from `spec.schedule.autoStart.enabled` (false → `DISABLED`). Use a `map` transform: `true→ENABLED`, `false→DISABLED`.

  Assert four `Schedule`s render; assert both start schedules have `state: DISABLED` given the canonical XR. Commit.

- [ ] **M3.9 — Cost control: budget.** `budgets.aws.m.upbound.io` `Budget` (monthly cost, `limitAmount` from `spec.budget.monthlyLimitUSD`, currency USD, a notification at `alertThresholdPercent` emailing `notifyEmail`). Add an `ssm.aws.m.upbound.io` Automation document that stops the environment's tagged EC2 instance and RDS database, then configure `BudgetAction` at `actionThresholdPercent` to execute that SSM action through the budget action role. AWS Budgets does not directly invoke EC2/RDS stop APIs. Assert `Budget`, `BudgetAction`, and the Automation document render; assert alert threshold 100 and action threshold 150 from the canonical XR. Commit.

### Task M3.10: Connection secret (operator-visible outputs)

- [ ] **Step 1:** Add (in the XRD `spec` or composition) a `writeConnectionSecretToRef` / status patches publishing `elasticIp`, `instanceId`, `rdsEndpoint`, `snapshotBucket`, `domainName`, `dashboardUrl` into a `quorum-prod-connection` Secret in `quorum-system`. The RDS password is **not** included.
- [ ] **Step 2:** Render; assert the rendered XR `status` carries `elasticIp`/`rdsEndpoint` placeholders. Commit `feat(deploy): publish operator-visible connection outputs`.

### Task M3.11: Full-graph render assertion

- [ ] **Step 1:** Tighten `render.test.js` to assert the complete kind set renders and the instance role has no stop/start permission. Run `npm run test:deploy`. Expected: all PASS. Commit `test(deploy): assert full resource graph renders offline`.

---

## Milestone M4 — Bootstrap assets (validated with shellcheck / bash -n / compose config)

**Goal:** author everything that runs **on the instance**. All scripts pass `shellcheck -x` and `bash -n` (already wired in M0.3); the compose file passes `docker compose config`.

### Task M4.1: `docker-compose.aws.yml` (backend-only + caddy)

**Files:**
- Create: `crossplane/bootstrap/docker-compose.aws.yml`
- Create: `crossplane/tests/compose.test.js`
- Read first: `docker-compose.yml` (existing dev — copy service shapes, DROP localstack, DROP dashboard, ADD caddy)

- [ ] **Step 1: Write the compose file**

Create `crossplane/bootstrap/docker-compose.aws.yml` modeling the existing dev services minus `localstack` and any dashboard, plus `caddy`. Services: `caddy`, `gateway`, `graphiti`, `falkordb`, `redis`, `decay-job`, `archive-job`, `recheck-job`. Use `${VAR}` interpolation for everything secret/host-specific (image tags, `POSTGRES_*`, `OPENAI_API_KEY`, `GITHUB_*`, `QUORUM_*`) so values come from the bootstrap-written env file, never the compose file. `awslogs` logging driver on `gateway`, `graphiti`, `caddy`, and the jobs. Caddy publishes `80:80` and `443:443`, mounts a named `caddy_data` volume and the `Caddyfile`. `falkordb` mounts a named `falkordb_data` volume at `/data`.

```yaml
# Backend-only production stack for the disposable EC2 instance.
# NO localstack (real AWS), NO dashboard (Vercel). Caddy fronts the gateway.
# All secret/host values come from the root-owned env file start.sh writes.
name: quorum
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on: [gateway]
    logging:
      driver: awslogs
      options:
        awslogs-group: ${LOG_GROUP}
        awslogs-region: ${AWS_REGION}
        awslogs-stream: caddy

  gateway:
    image: ${IMAGE_REGISTRY}/quorum-gateway:${GATEWAY_TAG}
    restart: unless-stopped
    env_file: [/etc/quorum/quorum.env]
    depends_on: [falkordb, redis, graphiti]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3001/health').then(r=>process.exit([200,503].includes(r.status)?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 5
    logging:
      driver: awslogs
      options:
        awslogs-group: ${LOG_GROUP}
        awslogs-region: ${AWS_REGION}
        awslogs-stream: gateway

  graphiti:
    image: ${IMAGE_REGISTRY}/graphiti-mcp:${GRAPHITI_TAG}
    restart: unless-stopped
    env_file: [/etc/quorum/quorum.env]
    depends_on: [falkordb]
    logging:
      driver: awslogs
      options:
        awslogs-group: ${LOG_GROUP}
        awslogs-region: ${AWS_REGION}
        awslogs-stream: graphiti

  falkordb:
    image: falkordb/falkordb:latest
    restart: unless-stopped
    volumes: [falkordb_data:/data]

  redis:
    image: redis:7-alpine
    restart: unless-stopped

  decay-job:
    image: ${IMAGE_REGISTRY}/quorum-gateway:${GATEWAY_TAG}
    profiles: [jobs]
    env_file: [/etc/quorum/quorum.env]
    command: ["npm", "run", "job:decay"]

  archive-job:
    image: ${IMAGE_REGISTRY}/quorum-gateway:${GATEWAY_TAG}
    profiles: [jobs]
    env_file: [/etc/quorum/quorum.env]
    command: ["npm", "run", "job:archive"]

  recheck-job:
    image: ${IMAGE_REGISTRY}/quorum-gateway:${GATEWAY_TAG}
    profiles: [jobs]
    env_file: [/etc/quorum/quorum.env]
    command: ["npm", "run", "job:recheck"]

volumes:
  caddy_data:
  caddy_config:
  falkordb_data:
```

> The `*-job` services use `profiles: [jobs]` so `docker compose up -d` does **not** start them; the systemd timers (M4.6) invoke them with `docker compose run --rm`. Verify the gateway image actually exposes `npm run job:*` (it does — see root `package.json`).

- [ ] **Step 2: Write the compose validation test**

Create `crossplane/tests/compose.test.js`:
```javascript
/**
 * @file Validates docker-compose.aws.yml renders with `docker compose config`
 * under a dummy env, contains the expected backend services, and excludes the
 * localstack and dashboard services that must never ship to production.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import yaml from 'js-yaml'

const FILE = 'crossplane/bootstrap/docker-compose.aws.yml'
const DUMMY_ENV = {
  ...process.env,
  IMAGE_REGISTRY: 'ghcr.io/example', GATEWAY_TAG: 'test', GRAPHITI_TAG: 'test',
  AWS_REGION: 'ap-southeast-2', LOG_GROUP: '/quorum/test',
}

/** Runs `docker compose config` and returns the normalized compose model. */
function composeConfig() {
  const out = execFileSync('docker', ['compose', '-f', FILE, 'config'], { encoding: 'utf8', env: DUMMY_ENV })
  return yaml.load(out)
}

describe('S-DEPLOY docker-compose.aws.yml', () => {
  it('is a valid compose file', () => {
    expect(() => composeConfig()).not.toThrow()
  })
  it('contains the backend + caddy services', () => {
    const svc = Object.keys(composeConfig().services)
    for (const s of ['caddy', 'gateway', 'graphiti', 'falkordb', 'redis']) {
      expect(svc).toContain(s)
    }
  })
  it('does NOT contain localstack or any dashboard service', () => {
    const svc = Object.keys(composeConfig().services)
    expect(svc).not.toContain('localstack')
    expect(svc.some((s) => s.includes('dashboard'))).toBe(false)
  })
})
```

- [ ] **Step 3: Validate + run + commit**

Run: `IMAGE_REGISTRY=ghcr.io/example GATEWAY_TAG=test GRAPHITI_TAG=test AWS_REGION=ap-southeast-2 LOG_GROUP=/quorum/test docker compose -f crossplane/bootstrap/docker-compose.aws.yml config >/dev/null && echo OK`
Expected: `OK`.
Run: `npx vitest run crossplane/tests/compose.test.js`
Expected: 3 PASS.
```bash
git add crossplane/bootstrap/docker-compose.aws.yml crossplane/tests/compose.test.js
git commit -m "feat(deploy): add backend-only aws compose stack with caddy"
```

### Task M4.2: `Caddyfile`

- [ ] **Step 1:** Create `crossplane/bootstrap/Caddyfile`:
```caddyfile
# Caddy fronts the gateway. The bare site block makes Caddy obtain and renew a
# Let's Encrypt cert via the ACME HTTP-01 challenge (port 80 must be reachable —
# the Vercel A record points quorum-gateway.ayansasmal.work at the EIP).
{
	email {$ACME_EMAIL}
}

quorum-gateway.ayansasmal.work {
	encode gzip
	reverse_proxy gateway:3001
}
```
- [ ] **Step 2:** Validate with the Caddy image: `docker run --rm -v "$PWD/crossplane/bootstrap/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
Expected: `Valid configuration`. (If Docker egress is blocked, fall back to `caddy validate` if Caddy is installed locally; otherwise note the validation is operator-run.)
- [ ] **Step 3:** Commit `feat(deploy): add caddyfile for quorum-gateway acme tls`.

### Task M4.3: `init-db.sql`

- [ ] **Step 1:** Create `crossplane/bootstrap/init-db.sql` — idempotent (`CREATE TABLE IF NOT EXISTS …`, `CREATE INDEX IF NOT EXISTS …`) DDL for the audit/versions schema the gateway expects. **Source the exact DDL** from the existing gateway migration/schema files (find them: `grep -rl "knowledge_versions" gateway/src scripts` and locate the canonical `CREATE TABLE`s). Do not invent columns — copy the authoritative schema and wrap each statement to be re-runnable.
- [ ] **Step 2:** Validate syntax offline: `docker run --rm -v "$PWD/crossplane/bootstrap/init-db.sql:/q.sql:ro" postgres:16-alpine sh -c 'pg_query? no — use: cat /q.sql | grep -c "CREATE"'` — i.e. confirm it parses by counting statements; a true parse check happens at deploy. At minimum assert the file is non-empty and contains `IF NOT EXISTS`. Add a vitest case in `compose.test.js` or a new `initdb.test.js` asserting every `CREATE TABLE`/`CREATE INDEX` includes `IF NOT EXISTS`.
- [ ] **Step 3:** Commit `feat(deploy): add idempotent init-db schema bootstrap`.

### Task M4.4: `snapshot-save.sh` and `snapshot-restore.sh`

- [ ] **Step 1:** Create `crossplane/bootstrap/snapshot-save.sh`:
```bash
#!/usr/bin/env bash
# Snapshot derived state to versioned S3: BGSAVE FalkorDB's dump.rdb and tar
# Caddy's /data (TLS cert + ACME account), then upload both under a timestamped
# prefix and update a `latest` pointer. Idempotent; safe to run on a timer.
set -euo pipefail

: "${SNAPSHOT_BUCKET:?}" "${AWS_REGION:?}"
COMPOSE="docker compose -f /opt/quorum/docker-compose.aws.yml"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# 1. FalkorDB BGSAVE then copy the rdb out of the container's volume.
${COMPOSE} exec -T falkordb redis-cli BGSAVE
sleep 5
${COMPOSE} cp falkordb:/data/dump.rdb "${WORK}/dump.rdb"

# 2. Tar Caddy's state.
${COMPOSE} cp caddy:/data "${WORK}/caddy-data"
tar -C "${WORK}" -czf "${WORK}/caddy-data.tgz" caddy-data

# 3. Upload under the timestamped prefix and refresh `latest`.
for f in dump.rdb caddy-data.tgz; do
  aws s3 cp "${WORK}/${f}" "s3://${SNAPSHOT_BUCKET}/snapshots/${STAMP}/${f}" --region "${AWS_REGION}"
  aws s3 cp "${WORK}/${f}" "s3://${SNAPSHOT_BUCKET}/snapshots/latest/${f}" --region "${AWS_REGION}"
done
echo "snapshot ${STAMP} uploaded"
```
- [ ] **Step 2:** Create `crossplane/bootstrap/snapshot-restore.sh`:
```bash
#!/usr/bin/env bash
# Restore the latest derived-state snapshot from S3 into the named volumes
# BEFORE the compose stack starts. No-op (clean start) when no snapshot exists,
# so a first-ever boot proceeds and Caddy issues a fresh certificate.
set -euo pipefail

: "${SNAPSHOT_BUCKET:?}" "${AWS_REGION:?}"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
PREFIX="s3://${SNAPSHOT_BUCKET}/snapshots/latest"

if ! aws s3 ls "${PREFIX}/dump.rdb" --region "${AWS_REGION}" >/dev/null 2>&1; then
  echo "no snapshot found — clean start"; exit 0
fi

aws s3 cp "${PREFIX}/dump.rdb" "${WORK}/dump.rdb" --region "${AWS_REGION}"
aws s3 cp "${PREFIX}/caddy-data.tgz" "${WORK}/caddy-data.tgz" --region "${AWS_REGION}"

# Seed the docker named volumes via a throwaway alpine mount.
docker volume create quorum_falkordb_data >/dev/null
docker volume create quorum_caddy_data >/dev/null
docker run --rm -v quorum_falkordb_data:/data -v "${WORK}:/in:ro" alpine \
  sh -c 'cp /in/dump.rdb /data/dump.rdb'
docker run --rm -v quorum_caddy_data:/data -v "${WORK}:/in:ro" alpine \
  sh -c 'tar -C /data --strip-components=1 -xzf /in/caddy-data.tgz'
echo "snapshot restored"
```
- [ ] **Step 3:** `npm run test:deploy` — the M0 harness now lints these. Expected: per-script shellcheck + bash -n PASS. Commit `feat(deploy): add falkordb and caddy snapshot save/restore scripts`.

### Task M4.5: `refresh-rds-credentials.sh`, `start.sh`, `ec2-userdata.sh`

- [ ] **Step 1: `refresh-rds-credentials.sh`** — re-fetch the RDS-managed secret + endpoint and rewrite the `POSTGRES_*` lines of `/etc/quorum/quorum.env` atomically (write temp, `mv`), root-owned `0600`. Runs every 15 min via timer.
```bash
#!/usr/bin/env bash
# Re-resolve the RDS endpoint and the RDS-managed master credential, then patch
# the POSTGRES_* lines of the root-owned env file in place. Picks up password
# rotation without a redeploy. Idempotent; writes atomically.
set -euo pipefail
: "${AWS_REGION:?}" "${DB_INSTANCE_ID:?}"
ENV_FILE=/etc/quorum/quorum.env
TMP="$(mktemp)"; trap 'rm -f "${TMP}"' EXIT

DESC="$(aws rds describe-db-instances --db-instance-identifier "${DB_INSTANCE_ID}" --region "${AWS_REGION}")"
HOST="$(echo "${DESC}" | jq -r '.DBInstances[0].Endpoint.Address')"
PORT="$(echo "${DESC}" | jq -r '.DBInstances[0].Endpoint.Port')"
SECRET_ARN="$(echo "${DESC}" | jq -r '.DBInstances[0].MasterUserSecret.SecretArn')"
SECRET="$(aws secretsmanager get-secret-value --secret-id "${SECRET_ARN}" --region "${AWS_REGION}" --query SecretString --output text)"
USER="$(echo "${SECRET}" | jq -r '.username')"
PASS="$(echo "${SECRET}" | jq -r '.password')"

grep -v -E '^(POSTGRES_HOST|POSTGRES_PORT|POSTGRES_USER|POSTGRES_PASSWORD)=' "${ENV_FILE}" > "${TMP}" || true
{
  echo "POSTGRES_HOST=${HOST}"
  echo "POSTGRES_PORT=${PORT}"
  echo "POSTGRES_USER=${USER}"
  echo "POSTGRES_PASSWORD=${PASS}"
} >> "${TMP}"
install -o root -g root -m 0600 "${TMP}" "${ENV_FILE}"
echo "rds credentials refreshed"
```
- [ ] **Step 2: `start.sh`** — the idempotent boot path (spec §11 bootstrap sequence): install Docker/Compose/jq/awscli/psql if absent; pull bootstrap bundle from the deploy bucket; fetch `quorum/prod/gateway` app secret + RDS secret; atomically write `/etc/quorum/quorum.env` (app values + discovered `POSTGRES_*` + `GRAPHITI_URL`/`FALKORDB_URI`/`REDIS_URL` compose-DNS values + `IMAGE_REGISTRY`/`GATEWAY_TAG`/`GRAPHITI_TAG`/`LOG_GROUP`/`AWS_REGION`/`SNAPSHOT_BUCKET`/`ACME_EMAIL`); authenticate to GHCR with `GHCR_TOKEN`; run `snapshot-restore.sh`; apply `init-db.sql` with `psql`; `docker compose pull`; `docker compose up -d`; enable systemd timers. Guard each side-effect so a re-run on resume is clean.
- [ ] **Step 3: `ec2-userdata.sh`** — minimal: set region, `aws s3 cp` the versioned bootstrap bundle from `s3://<deploy-bucket>/bootstrap/<version>/` to `/opt/quorum/`, `chmod +x`, exec `start.sh`. The deploy bucket name is templated into userData by the Composition (M3.7).
- [ ] **Step 4:** `npm run test:deploy` → all three lint clean. Commit `feat(deploy): add rds-refresh, boot, and userdata bootstrap scripts`.

### Task M4.6: systemd units + timers

- [ ] **Step 1:** Create the 11 files under `crossplane/bootstrap/systemd/` (spec §8 list):
  - `quorum.service` — `oneshot`/`forking` wrapping `docker compose up -d` (after Docker, wants network-online).
  - `quorum-credential-refresh.service` + `.timer` (every 15 min) → `refresh-rds-credentials.sh`.
  - `quorum-snapshot.service` + `.timer` (every 60 min) → `snapshot-save.sh`.
  - `quorum-decay.service` + `.timer` (daily) → `docker compose run --rm decay-job`.
  - `quorum-archive.service` + `.timer` (daily) → `docker compose run --rm archive-job`.
  - `quorum-recheck.service` + `.timer` (hourly) → `docker compose run --rm recheck-job`.
  Each `.service` sources `/etc/quorum/quorum.env` via `EnvironmentFile=`.
- [ ] **Step 2:** Validate with `systemd-analyze verify` if available (Linux only; on macOS skip with a note). At minimum, add a vitest case asserting every `.timer` has a `[Timer]` section and every `.service` has `ExecStart=`. Put it in a new `crossplane/tests/systemd.test.js`.
- [ ] **Step 3:** Commit `feat(deploy): add systemd units and timers for the stack and jobs`.

---

## Milestone M5 — Operator on-demand control scripts

**Goal:** `quorum-resume.sh` / `quorum-suspend.sh` — run from the operator's laptop, AWS CLI only, idempotent, no Crossplane dependency.

### Task M5.1: `quorum-resume.sh`

- [ ] **Step 1:** Create `crossplane/ops/quorum-resume.sh`:
```bash
#!/usr/bin/env bash
# Operator laptop tool: bring the stack up on demand (scheduled auto-start is
# disabled during the build phase). Starts RDS first, waits for available, then
# starts EC2, then polls the gateway health endpoint. Idempotent: starting an
# already-running resource is a no-op.
set -euo pipefail
: "${AWS_REGION:=ap-southeast-2}"
DB_INSTANCE_ID="${DB_INSTANCE_ID:?set DB_INSTANCE_ID}"
EC2_INSTANCE_ID="${EC2_INSTANCE_ID:?set EC2_INSTANCE_ID}"
GATEWAY_URL="${GATEWAY_URL:=https://quorum-gateway.ayansasmal.work}"

echo "starting rds ${DB_INSTANCE_ID}…"
aws rds start-db-instance --db-instance-identifier "${DB_INSTANCE_ID}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
aws rds wait db-instance-available --db-instance-identifier "${DB_INSTANCE_ID}" --region "${AWS_REGION}"

echo "starting ec2 ${EC2_INSTANCE_ID}…"
aws ec2 start-instances --instance-ids "${EC2_INSTANCE_ID}" --region "${AWS_REGION}" >/dev/null
aws ec2 wait instance-running --instance-ids "${EC2_INSTANCE_ID}" --region "${AWS_REGION}"

echo "polling ${GATEWAY_URL}/health…"
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "${GATEWAY_URL}/health" || true)"
  if [ "${code}" = "200" ] || [ "${code}" = "503" ]; then echo "gateway up (${code})"; exit 0; fi
  sleep 10
done
echo "gateway did not report healthy in time" >&2; exit 1
```

### Task M5.2: `quorum-suspend.sh`

- [ ] **Step 1:** Create `crossplane/ops/quorum-suspend.sh`:
```bash
#!/usr/bin/env bash
# Operator laptop tool: suspend the stack on demand. Triggers a final snapshot
# on the instance over SSM, then stops EC2 and RDS. Idempotent: stopping an
# already-stopped resource is a no-op. The daily 10:00/23:00 schedule is the
# safety net if this is never run.
set -euo pipefail
: "${AWS_REGION:=ap-southeast-2}"
DB_INSTANCE_ID="${DB_INSTANCE_ID:?set DB_INSTANCE_ID}"
EC2_INSTANCE_ID="${EC2_INSTANCE_ID:?set EC2_INSTANCE_ID}"

echo "triggering final snapshot via ssm…"
aws ssm send-command --region "${AWS_REGION}" \
  --instance-ids "${EC2_INSTANCE_ID}" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["/opt/quorum/snapshot-save.sh"]' \
  --query 'Command.CommandId' --output text || echo "ssm snapshot skipped (instance may be stopped)"

echo "stopping ec2…"; aws ec2 stop-instances --instance-ids "${EC2_INSTANCE_ID}" --region "${AWS_REGION}" >/dev/null || true
echo "stopping rds…"; aws rds stop-db-instance --db-instance-identifier "${DB_INSTANCE_ID}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
echo "suspend requested"
```
- [ ] **Step 2:** `npm run test:deploy` → both lint clean. Commit `feat(deploy): add operator on-demand resume and suspend scripts`.

---

## Milestone M6 — arm64 image builds (no push)

**Goal:** prove the gateway and Graphiti images build for `linux/arm64` locally. **No `--push`.**

### Task M6.1: Build gateway arm64

- [ ] **Step 1:** Run (from `quorum/`):
```bash
docker buildx build --platform linux/arm64 -f Dockerfile.gateway -t quorum-gateway:arm64-test --load .
```
Expected: build succeeds, image loaded. If `--load` rejects multi-arch, build single-arch arm64 (it is single-platform here, so `--load` is fine).
- [ ] **Step 2:** Verify arch: `docker image inspect quorum-gateway:arm64-test --format '{{.Architecture}}'`
Expected: `arm64`.

### Task M6.2: Build Graphiti arm64

- [ ] **Step 1:** Run:
```bash
docker buildx build --platform linux/arm64 -f Dockerfile.graphiti -t graphiti-mcp:arm64-test --load .
```
Expected: build succeeds (the pinned `GRAPHITI_SHA` sparse-clone completes).
- [ ] **Step 2:** Verify arch as above → `arm64`.
- [ ] **Step 3:** Document the exact tag-and-push commands (operator-run, gated) in `docs/DEPLOYMENT-AWS.md` (M8). No commit needed for the build artifacts themselves.

---

## Milestone M7 — Gated deploy script

**Goal:** one `deploy.sh` that **renders/validates by default** and only mutates AWS when called with `apply`. This is the single entrypoint the operator uses post-handoff.

### Task M7.1: Write `deploy.sh`

- [ ] **Step 1:** Create `crossplane/deploy.sh`:
```bash
#!/usr/bin/env bash
# Gated deployment entrypoint for the Quorum AWS stack.
#
#   ./deploy.sh validate     (default) render + schema-validate + lint, touch no AWS
#   ./deploy.sh apply        MUTATING: install providers, apply xrd/composition/xr
#   ./deploy.sh status       read-only: show XR + managed resource readiness
#   ./deploy.sh destroy      MUTATING: delete the XR (gated by a typed confirmation)
#
# Mutating paths require BOTH the explicit subcommand AND, for apply/destroy, a
# typed "yes" confirmation. Default behavior never calls AWS.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CMD="${1:-validate}"

validate() {
  echo "== rendering composition offline =="
  bash "${ROOT}/tests/render.sh" >/dev/null && echo "render OK"
  echo "== running offline test suite =="
  ( cd "${ROOT}/.." && npm run test:deploy )
}

confirm() {
  read -r -p "Type 'yes' to ${1} real AWS resources: " ans
  [ "${ans}" = "yes" ] || { echo "aborted"; exit 1; }
}

case "${CMD}" in
  validate) validate ;;
  apply)
    validate
    confirm "CREATE/UPDATE"
    kubectl apply -f "${ROOT}/providers/providers.yaml"
    kubectl apply -f "${ROOT}/providers/functions.yaml"
    kubectl apply -f "${ROOT}/providers/providerconfig-aws-prod.yaml"
    kubectl apply -f "${ROOT}/apis/environment/definition.yaml"
    kubectl apply -f "${ROOT}/apis/environment/composition.yaml"
    kubectl apply -f "${ROOT}/environments/prod.yaml"
    echo "applied — watch with ./deploy.sh status"
    ;;
  status)
    kubectl get quorumenvironment -n quorum-system -o wide || true
    kubectl get managed 2>/dev/null || true
    ;;
  destroy)
    confirm "DELETE"
    kubectl delete -f "${ROOT}/environments/prod.yaml"
    ;;
  *) echo "usage: deploy.sh [validate|apply|status|destroy]"; exit 2 ;;
esac
```
- [ ] **Step 2:** `chmod +x crossplane/deploy.sh`; lint: `shellcheck -x crossplane/deploy.sh` → clean.
- [ ] **Step 3:** Prove the default path is non-mutating: `bash crossplane/deploy.sh validate` runs render + tests and **never** calls `kubectl`/`aws`. Add a vitest case in a new `crossplane/tests/deploy.test.js` asserting the script contains no top-level `kubectl`/`aws` call outside the `apply`/`status`/`destroy` branches (grep-based: the `validate` function body contains neither `kubectl` nor `aws`).
- [ ] **Step 4:** Commit `feat(deploy): add gated deploy script (validate default, apply on demand)`.

---

## Milestone M8 — Tests green, docs, and final sweep

### Task M8.1: Full offline suite green

- [ ] **Step 1:** Run `npm run test:deploy`. Expected: every test PASS (schema, render full-graph, compose, systemd, deploy-gating, all scripts shellcheck+bash -n clean).
- [ ] **Step 2:** Run `bash crossplane/deploy.sh validate`. Expected: `render OK` + suite green, zero AWS calls.

### Task M8.2: Operator runbook

- [ ] **Step 1:** Create `docs/DEPLOYMENT-AWS.md` covering: the gated deploy order (spec §12 items 1–13), the Vercel A-record edit (`quorum-gateway` `127.0.0.1` → EIP), the Secrets Manager seed command that reads `quorum/.env.prod` locally (`aws secretsmanager create-secret --name quorum/prod/gateway --region ap-southeast-2 --secret-string …`), the `quorum-resume.sh`/`quorum-suspend.sh` env vars (`DB_INSTANCE_ID`, `EC2_INSTANCE_ID`), the daily auto-stop behavior + how to re-enable auto-start (flip `schedule.autoStart.enabled`), the budget alert/action thresholds + the OpenAI org-limit caveat, the arm64 tag-and-push commands, and teardown (spec §14). Cross-link the spec.
- [ ] **Step 2:** Update `CLAUDE.md` (workspace) "Key Reference Documents" table to list `docs/DEPLOYMENT-AWS.md`.
- [ ] **Step 3:** Open the new doc via the show-md skill (per user convention): ensure the server is up, then `open "http://127.0.0.1:4242?file=$(pwd)/docs/DEPLOYMENT-AWS.md"`.
- [ ] **Step 4:** Commit `docs(deploy): add aws deployment runbook and link from claude.md`.

### Task M8.3: Final verification sweep

- [ ] **Step 1: No secret committed.** Run `git log -p --all | grep -iE 'GITHUB_CLIENT_SECRET=.+[a-f0-9]{20}|OPENAI_API_KEY=sk-' | head` → expect **no** real values (only placeholders/example). Run `git ls-files | grep -E '\.env(\..*)?$'` → expect only `.env.example`.
- [ ] **Step 2: No deploy command in tests.** Run `grep -rnE 'kubectl apply|aws .* (create|run-instances|start-db)' crossplane/tests` → expect no matches.
- [ ] **Step 3: No dashboard/localstack in the prod stack.** Run `grep -niE 'localstack|dashboard' crossplane/bootstrap/docker-compose.aws.yml` → expect no matches.
- [ ] **Step 4:** Commit any doc tweaks. Done.

---

## Spec → task traceability (self-review map)

| Spec section | Covered by |
|---|---|
| §7 XR schema | M2.1 (XRD), M2.2 (XR + ajv) |
| §8 package layout | M0.2 dirs; files across M1–M7 |
| §9.1 network | M3.2, M3.3 |
| §9.2 compute | M3.7, M4.5 (userData/start) |
| §9.3 database | M3.6, M4.5 (refresh) |
| §9.4 storage/index | M3.5 |
| §9.5 IAM | M3.4 |
| §9.6 cost-control resources | M3.8, M3.9 |
| §10 secrets/OAuth | M8.2 seed runbook; `.env.prod` (done) |
| §11 EC2 app stack + bootstrap | M4.1–M4.6 |
| §12 deployment workflow | M7 (gated), M8.2 (runbook) |
| §13 observability/ops/cost | M3.7 logs, M4.6 timers, M5 scripts, M3.8/3.9 |
| §13 DNS (Vercel A record) | prod.yaml `dns.provider: vercel-external`; M8.2 runbook |
| §14 teardown | M7 destroy; M8.2 runbook |
| §15 deliverables 1–15 | M1–M8 (1:1 — see below) |
| §16 success criteria | M8.1/M8.3 enforce the offline half |

**Deliverables §15 → milestones:** 1 XRD→M2 · 2 Composition→M3 · 3 prod ProviderConfig→M1.3 · 4 AWS resources→M3 · 5 bootstrap+S3 objects→M4.5 · 6 compose→M4.1 · 7 Caddy→M4.2 · 8 systemd→M4.6 · 9 RDS refresh→M4.5 · 10 snapshot save/restore→M4.4 · 11 schedules+budget+roles→M3.4/3.8/3.9 · 12 resume/suspend→M5 · 13 offline tests→M0/M2/M3/M4 · 14 docs→M8.2 · 15 gated deploy script→M7.

---

## What this plan deliberately defers to the operator (post-handoff, gated)

- Installing providers/functions, applying XRD/Composition/XR (`deploy.sh apply`).
- Seeding `quorum/prod/gateway` in Secrets Manager from local `quorum/.env.prod`.
- Pushing arm64 images to GHCR.
- Editing the Vercel `quorum-gateway` A record to the real EIP.
- Updating the GitHub OAuth callback / Vercel `QUORUM_GATEWAY_URL`.

None of these run during implementation or tests (enforced by M8.3).
