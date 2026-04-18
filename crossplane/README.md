# Crossplane — Quorum S3 Config Bucket

Crossplane-native alternative to `terraform/` for provisioning the Quorum project config S3 bucket and uploading sample configs. Requires Crossplane ≥ v1.14 installed in your cluster.

## Folder Structure

```
crossplane/
├── provider/
│   ├── provider-aws-s3.yaml           # Installs Upbound AWS S3 provider
│   └── providerconfig-aws.yaml        # Configures AWS credentials
├── credentials/
│   └── aws-creds-secret.yaml.example  # Secret template (copy, fill, apply — never commit)
├── bucket/
│   ├── bucket.yaml                    # S3 Bucket (ap-southeast-2)
│   ├── bucket-versioning.yaml         # Versioning (Enabled)
│   ├── bucket-encryption.yaml         # SSE-S3 encryption (upgrade to KMS for prod)
│   ├── bucket-public-access.yaml      # All public access blocked
│   └── bucket-lifecycle.yaml          # Noncurrent version archival
└── objects/
    ├── platform-team-config.yaml      # platform-team/config.json
    ├── backend-team-config.yaml       # backend-team/config.json
    └── external-bucket-config.yaml.example  # Template for pre-existing buckets
```

---

## Prerequisites

```bash
# Install Crossplane into your cluster
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system \
  --create-namespace
```

---

## Local Development with LocalStack

LocalStack is the default target. The ProviderConfig in `provider/providerconfig-aws.yaml`
already points to `http://host.docker.internal:4566` (Docker Desktop on Mac/Windows).

**If LocalStack runs at a different address**, edit `providerconfig-aws.yaml`:
```yaml
endpoint:
  url:
    static: "http://localhost.localstack.cloud:4566"   # LocalStack DNS (host-only)
    # static: "http://localstack:4566"                 # same k8s namespace
    # static: "http://host.docker.internal:4566"       # Docker Desktop (default)
```

### Quick start (LocalStack)

```bash
# 1. Install provider
kubectl apply -f crossplane/provider/provider-aws-s3.yaml
kubectl wait provider/provider-aws-s3 --for=condition=Healthy --timeout=180s

# 2. Apply test credentials (LocalStack accepts test/test)
kubectl create secret generic aws-creds \
  --namespace crossplane-system \
  --from-literal=credentials=$'[default]\naws_access_key_id=test\naws_secret_access_key=test'
kubectl apply -f crossplane/provider/providerconfig-aws.yaml

# 3. Provision the bucket
kubectl apply -f crossplane/bucket/
kubectl wait bucket/quorum-configs --for=condition=Ready --timeout=120s

# 4. Upload sample configs
kubectl apply -f crossplane/objects/platform-team-config.yaml
kubectl apply -f crossplane/objects/backend-team-config.yaml

# 5. Verify against LocalStack using awslocal
awslocal s3 ls s3://quorum-configs/
awslocal s3 cp s3://quorum-configs/platform-team/config.json -
awslocal s3 cp s3://quorum-configs/backend-team/config.json -
```

---

## Option A: Create a New Bucket (full Crossplane-managed, real AWS)

### 1. Install the AWS S3 provider

```bash
kubectl apply -f crossplane/provider/provider-aws-s3.yaml
kubectl wait provider/provider-aws-s3 --for=condition=Healthy --timeout=180s
```

### 2. Configure AWS credentials

```bash
# Copy the example, fill in real AWS keys (or use IRSA — see below)
cp crossplane/credentials/aws-creds-secret.yaml.example \
   crossplane/credentials/aws-creds-secret.yaml

kubectl apply -f crossplane/credentials/aws-creds-secret.yaml
kubectl apply -f crossplane/provider/providerconfig-aws.yaml
```

### 3. Provision the bucket

> **Bucket names are globally unique.** Set a unique name via annotation:
> ```yaml
> annotations:
>   crossplane.io/external-name: acme-quorum-configs-prod
> ```

```bash
kubectl apply -f crossplane/bucket/
kubectl wait bucket/quorum-configs --for=condition=Ready --timeout=120s
```

### 4. Upload sample configs

```bash
kubectl apply -f crossplane/objects/platform-team-config.yaml
kubectl apply -f crossplane/objects/backend-team-config.yaml

kubectl get object platform-team-config backend-team-config
```

---

## Option B: Use a Pre-existing External Bucket

If your bucket already exists (created by Terraform, manually, or in LocalStack), skip the `bucket/` step.

```bash
# 1. Install provider + credentials (same as Option A steps 1-2)

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

1. In `provider/provider-aws-s3.yaml`, uncomment `serviceAccountAnnotations` and set the IAM role ARN (the `gateway_iam_role_arn` Terraform output).
2. In `provider/providerconfig-aws.yaml`, change `source: Secret` → `source: IRSA`, remove `secretRef`, and remove the `endpoint` block entirely.
3. Delete the `aws-creds` Secret — no longer needed.

---

## Verify (LocalStack)

```bash
# awslocal = aws CLI pre-configured for LocalStack (http://localhost:4566)
BUCKET=$(kubectl get bucket quorum-configs \
  -o jsonpath='{.metadata.annotations.crossplane\.io/external-name}')

awslocal s3 ls s3://$BUCKET/
awslocal s3 cp s3://$BUCKET/platform-team/config.json -
awslocal s3 cp s3://$BUCKET/backend-team/config.json -
```

## Verify (real AWS)

```bash
BUCKET=$(kubectl get bucket quorum-configs \
  -o jsonpath='{.metadata.annotations.crossplane\.io/external-name}')

aws s3 ls s3://$BUCKET/
aws s3 cp s3://$BUCKET/platform-team/config.json -
```

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

The Quorum Gateway reads these at startup via `QUORUM_CONFIG_BUCKET` env var (see `helm/quorum/values-aws.yaml`).
