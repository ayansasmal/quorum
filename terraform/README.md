# Quorum — Terraform (AWS Infrastructure)

This directory provisions the AWS resources that Quorum needs to run in production.

> **Local development?** Use `crossplane/` instead — it provisions the same S3 bucket
> via Crossplane CRDs targeting LocalStack. No AWS account required.
> See [`crossplane/README.md`](../crossplane/README.md) for setup.

## What it creates

**1. KMS encryption key**
An AWS-managed encryption key for the config bucket. Every config file stored in S3 is encrypted at rest using this key. The key auto-rotates annually.

**2. S3 bucket (config store)**
Holds the `quorum.config.json` files for each team, at paths like:
```
s3://acme-quorum-configs/platform-team/config.json
s3://acme-quorum-configs/backend-team/config.json
```
Versioning is enabled — every `config.json` upload creates a new S3 version. Free audit trail, free rollback.

**3. Bucket policy (IAM security boundary)**
- Public access is completely blocked
- Non-HTTPS requests are rejected
- Unencrypted uploads are rejected
- The Quorum Gateway pod can **read** all configs (via its IAM role)
- Team leads can **write** to their own project prefix only

This is the actual security enforcement of Quorum's authority model. Engineers cannot edit `config.json` and elevate their own role — they don't have S3 write access.

**4. IAM role for the gateway pod (IRSA)**
The Quorum Gateway pod running in EKS authenticates to AWS using [IAM Roles for Service Accounts (IRSA)](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html). No `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` in the pod — the pod's Kubernetes service account is linked to an AWS IAM role via OIDC federation. AWS mints short-lived credentials automatically.

**5. Per-project IAM policies for team leads**
For each project in `var.project_ids`, a managed IAM policy is created that grants write access to `s3://bucket/<project-id>/*` only. Attach these policies to the relevant IAM users or roles.

## Prerequisites

1. **Install Terraform** — https://developer.hashicorp.com/terraform/install
   ```bash
   brew install terraform  # macOS
   ```

2. **AWS credentials** — either via `aws configure` or environment variables:
   ```bash
   export AWS_ACCESS_KEY_ID=...
   export AWS_SECRET_ACCESS_KEY=...
   export AWS_REGION=ap-southeast-2
   ```

3. **EKS cluster with OIDC provider enabled** — for IRSA to work.
   If you don't have EKS yet, set `eks_oidc_provider_arn = ""` to skip IRSA setup for now.

## Usage

```bash
cd terraform/

# 1. Copy the example vars file and fill in your values
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your bucket name, team lead ARNs, etc.

# 2. Initialize Terraform (downloads the AWS provider)
terraform init

# 3. Preview what will be created (safe — no changes made yet)
terraform plan

# 4. Apply (creates the real resources)
terraform apply
```

After `apply` completes, copy the outputs into your Helm values:
```bash
terraform output gateway_iam_role_arn
# → paste into helm/quorum/values-aws.yaml as serviceAccount.annotations."eks.amazonaws.com/role-arn"

terraform output bucket_name
# → set as QUORUM_CONFIG_BUCKET in your gateway deployment
```

## Upload your first config

```bash
aws s3 cp quorum.config.example.json \
  s3://$(terraform output -raw bucket_name)/platform-team/config.json \
  --sse aws:kms \
  --sse-kms-key-id $(terraform output -raw kms_key_arn)
```

## Attach team lead policies

```bash
# Attach the platform-team write policy to a specific IAM user
aws iam attach-user-policy \
  --user-name alice \
  --policy-arn $(terraform output -json team_lead_policy_arns | jq -r '.["platform-team"]')
```

## Destroy

```bash
terraform destroy
```

Note: The S3 bucket has `prevent_destroy = true`. You must remove that lifecycle rule from `main.tf` before Terraform will allow deletion. This is intentional — the bucket contains audit-relevant config history.
