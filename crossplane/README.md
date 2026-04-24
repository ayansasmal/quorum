# Crossplane — Quorum S3 Config Bucket

Crossplane manages all Quorum infrastructure — the only IaC tool in this project. Provisions the Quorum project config S3 bucket and uploads sample configs. Requires Crossplane ≥ v1.14 and the Upbound AWS S3 provider.

## Folder Structure

```
crossplane/
├── crossplane.sh                          # Script: setup / start / status / cleanup
├── provider/
│   ├── provider-aws-s3.yaml               # Installs Upbound AWS S3 provider (v0.47.x)
│   ├── provider-family-aws.yaml           # Pins provider-family-aws; applies runtimeConfigRef
│   ├── providerconfig-aws.yaml            # ProviderConfig — endpoint, credentials, path-style
│   ├── runtimeconfig-localstack.yaml      # DeploymentRuntimeConfig — injects AWS_ENDPOINT_URL
│   └── controllerconfig-localstack.yaml   # ControllerConfig (kept for compat, no env vars)
├── credentials/
│   └── aws-creds-secret.yaml.example      # Secret template (copy, fill, apply — never commit)
├── bucket/
│   ├── bucket.yaml                        # S3 Bucket (us-east-1)
│   ├── bucket-versioning.yaml             # Versioning (Enabled)
│   ├── bucket-encryption.yaml             # SSE-S3 encryption (AES256 — upgrade to KMS for prod)
│   ├── bucket-public-access.yaml          # All public access blocked
│   └── bucket-lifecycle.yaml             # Noncurrent version archival to STANDARD_IA / GLACIER_IR
└── objects/
    ├── platform-team-config.yaml          # platform-team/config.json
    ├── backend-team-config.yaml           # backend-team/config.json
    └── external-bucket-config.yaml.example  # Template for pre-existing external buckets
```

---

## Quick Start — LocalStack (recommended)

Use `crossplane.sh` — it handles everything in order: deps check, LocalStack validation, Crossplane install, CRD wait, CoreDNS patch, provider install, credentials, bucket, and objects.

### Prerequisites

```bash
# LocalStack must be running WITH LOCALSTACK_HOST set — this is required for
# virtual-hosted S3 requests from inside Kubernetes pods.
# If LocalStack is already running without it, stop and restart:
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

This installs Crossplane (v1.17.2), the Upbound AWS S3 provider, patches CoreDNS for wildcard DNS resolution, provisions the `quorum-configs` bucket in LocalStack, and uploads sample configs.

```bash
# Check current state at any time
./crossplane/crossplane.sh status

# Re-apply all manifests (idempotent — safe to run again after cluster restart)
./crossplane/crossplane.sh start

# Remove all resources
./crossplane/crossplane.sh cleanup
```

Logs are written to `./logs/crossplane.<timestamp>.log`.

### Verify

```bash
# List objects in the bucket
awslocal s3 ls s3://quorum-configs/ --recursive

# Read a config
awslocal s3 cp s3://quorum-configs/platform-team/config.json -
awslocal s3 cp s3://quorum-configs/backend-team/config.json -
```

---

## Manual Apply Order (reference)

If you prefer running `kubectl apply` directly instead of the script:

```bash
# 1. Install Crossplane
helm repo add crossplane-stable https://charts.crossplane.io/stable --force-update
helm upgrade --install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system --create-namespace --version 1.17.2 --wait

# 2. Apply DeploymentRuntimeConfig before provider (provider-family-aws references it)
kubectl apply -f crossplane/provider/runtimeconfig-localstack.yaml
kubectl apply -f crossplane/provider/controllerconfig-localstack.yaml

# 3. Install AWS S3 provider (auto-installs provider-family-aws as dependency)
kubectl apply -f crossplane/provider/provider-aws-s3.yaml
kubectl wait provider/provider-aws-s3 --for=condition=Healthy --timeout=180s

# 4. Apply RuntimeConfig to provider-family-aws (the pod that makes S3 calls)
kubectl apply -f crossplane/provider/provider-family-aws.yaml
kubectl wait provider/upbound-provider-family-aws --for=condition=Healthy --timeout=120s

# 5. Create credentials secret and ProviderConfig
kubectl create secret generic aws-creds \
  --namespace crossplane-system \
  --from-literal=credentials=$'[default]\naws_access_key_id=test\naws_secret_access_key=test' \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f crossplane/provider/providerconfig-aws.yaml

# 6. Provision the bucket
kubectl apply -f crossplane/bucket/
kubectl wait bucket/quorum-configs --for=condition=Ready --timeout=120s

# 7. Upload sample configs
kubectl apply -f crossplane/objects/platform-team-config.yaml
kubectl apply -f crossplane/objects/backend-team-config.yaml
kubectl wait object/platform-team-config --for=condition=Ready --timeout=60s
kubectl wait object/backend-team-config  --for=condition=Ready --timeout=60s
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

If the variable is absent, stop and restart LocalStack:
```bash
localstack stop
LOCALSTACK_HOST=host.docker.internal localstack start -d
```

### Why `endpoint.services: [s3, sts]` in ProviderConfig is critical

The Upbound AWS provider (built on Upjet/AWS SDK Go v2) has separate endpoint resolution
paths for S3 and global AWS services. The global `endpoint.url.static` field routes STS,
IAM, and most services — but **not S3** unless you explicitly list `s3` in the `services`
array. Without it, S3 operations silently go to real AWS HTTPS instead of LocalStack.

```yaml
# providerconfig-aws.yaml — the critical part
endpoint:
  source: Custom
  hostnameImmutable: true
  signingRegion: us-east-1
  url:
    type: Static
    static: "http://host.docker.internal:4566"
  services:       # ← required — without this, S3 ignores the custom endpoint
    - s3
    - sts
```

### CoreDNS wildcard rewrite

`crossplane.sh setup` patches the CoreDNS ConfigMap to resolve `*.host.docker.internal`
to `host.docker.internal`. This allows virtual-hosted S3 URLs like
`quorum-configs.host.docker.internal` to resolve from inside cluster pods.

The patch is applied via Python (not sed) because macOS ships BSD sed which does not
support multiline append in scripts. The patch is idempotent — running `setup` again
skips it if already present.

**Note:** Docker Desktop fully resets the Kubernetes cluster (including CoreDNS) if you
restart Docker Desktop or reset the cluster. Re-run `./crossplane/crossplane.sh setup`
after any cluster reset.

---

## Option B: Use a Pre-existing External Bucket

If your bucket already exists (created manually or in LocalStack), skip the `bucket/` step.

```bash
# 1. Install provider + credentials (steps 1-5 from manual apply above)

# 2. Copy the external bucket template
cp crossplane/objects/external-bucket-config.yaml.example \
   crossplane/objects/my-team-config.yaml

# 3. Set `bucket:` to your existing bucket name, then apply
kubectl apply -f crossplane/objects/my-team-config.yaml

# Verify against LocalStack
awslocal s3 ls s3://your-existing-bucket-name/
```

The only difference from the managed bucket path: use `bucket: <name>` directly instead of
`bucketRef: { name: ... }`. No Crossplane Bucket resource needed.

---

## Production Upgrade: IRSA Instead of Static Keys

1. Remove `s3_use_path_style`, `skip_credentials_validation`, `skip_metadata_api_check`, `skip_region_validation`, and the entire `endpoint` block from `providerconfig-aws.yaml` — these are LocalStack-only settings.
2. Change `credentials.source: Secret` → `source: IRSA` and remove `secretRef`.
3. In `provider-aws-s3.yaml`, uncomment `serviceAccountAnnotations` and set the IAM role ARN provisioned for the gateway.
4. Remove `runtimeconfig-localstack.yaml` and the `runtimeConfigRef` from `provider-family-aws.yaml`.
5. Delete the `aws-creds` Secret — no longer needed.

---

## IaC Strategy

Crossplane is the **only** IaC tool in this project. There is no Terraform.

| Mode | S3 | Auth |
|--|--|--|
| Docker Compose (local dev) | LocalStack via `scripts/init-localstack.sh` | Dummy credentials (`test`/`test`) |
| Local K8s | LocalStack via `crossplane.sh setup` | K8s Secret (`aws-creds`) |
| Production | Real AWS S3 | IRSA (no static keys) |

For production, see the IRSA upgrade path above.

---

## Config Object Schema

Each `{project_id}/config.json` object in the bucket follows this structure:

```json
{
  "projectId": "string",
  "version": "string",
  "conflictThreshold": 0.85,
  "authorityThreshold": 0.20,
  "domains": ["string"],
  "teamLeads": ["string"]
}
```

The Quorum Gateway reads these at startup via the `QUORUM_CONFIG_BUCKET` env var (see `helm/quorum/values-aws.yaml`).
