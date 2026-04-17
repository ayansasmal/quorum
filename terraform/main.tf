# ── Data sources ──────────────────────────────────────────────────────────────

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ── KMS key for S3 encryption at rest ─────────────────────────────────────────
#
# Quorum project configs contain member lists and role assignments.
# KMS encryption ensures config content is encrypted even if the bucket
# policy is misconfigured — defense-in-depth.

resource "aws_kms_key" "quorum_configs" {
  description             = "Quorum project config bucket encryption key"
  deletion_window_in_days = var.kms_deletion_window_in_days
  enable_key_rotation     = true # Rotate annually — best practice

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Allow the AWS account root full control (administrative access)
        Sid    = "EnableRootAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        # Allow the gateway IAM role to use the key for S3 reads
        Sid    = "AllowGatewayDecrypt"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.quorum_gateway.arn
        }
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:DescribeKey",
        ]
        Resource = "*"
      },
      {
        # Allow team leads to encrypt (needed for S3 PutObject with SSE-KMS)
        Sid    = "AllowTeamLeadEncrypt"
        Effect = "Allow"
        Principal = {
          AWS = length(var.team_lead_arns) > 0 ? var.team_lead_arns : ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
        }
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "kms:DescribeKey",
        ]
        Resource = "*"
      },
    ]
  })
}

resource "aws_kms_alias" "quorum_configs" {
  name          = "alias/quorum-configs-${var.environment}"
  target_key_id = aws_kms_key.quorum_configs.key_id
}

# ── S3 bucket ──────────────────────────────────────────────────────────────────
#
# Structure: s3://<bucket>/<project_id>/config.json
#
# Security model:
#   - All public access blocked at bucket level
#   - SSE-KMS encryption enforced in bucket policy (deny unencrypted uploads)
#   - Versioning enabled — S3 versioning is free audit trail for config changes
#   - Gateway pod reads via IRSA (no static credentials)
#   - Team leads write via their own IAM user/role (scoped to their project prefix)

resource "aws_s3_bucket" "quorum_configs" {
  bucket = var.bucket_name

  # PRODUCTION HARDENING: uncomment the lifecycle block below after your first
  # successful apply. This prevents `terraform destroy` from deleting the bucket.
  # Terraform cannot set lifecycle.prevent_destroy from a variable (language limitation),
  # so this is a manual step — the setup_env.sh prod path reminds you.
  #
  # lifecycle {
  #   prevent_destroy = true
  # }
}

resource "aws_s3_bucket_versioning" "quorum_configs" {
  bucket = aws_s3_bucket.quorum_configs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "quorum_configs" {
  bucket = aws_s3_bucket.quorum_configs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.quorum_configs.arn
    }
    bucket_key_enabled = true # Reduces KMS API call cost for high-frequency reads
  }
}

resource "aws_s3_bucket_public_access_block" "quorum_configs" {
  bucket = aws_s3_bucket.quorum_configs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Enforce SSE-KMS on all PutObject calls — unencrypted uploads are rejected.
# This is defense-in-depth: even if the KMS default is removed, uploads fail.
resource "aws_s3_bucket_policy" "quorum_configs" {
  bucket = aws_s3_bucket.quorum_configs.id

  # Wait for public access block to be applied before setting the bucket policy
  depends_on = [aws_s3_bucket_public_access_block.quorum_configs]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Deny any PutObject that does not use SSE-KMS with our specific key
        Sid    = "DenyUnencryptedUploads"
        Effect = "Deny"
        Principal = {
          AWS = "*"
        }
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.quorum_configs.arn}/*"
        Condition = {
          StringNotEqualsIfExists = {
            "s3:x-amz-server-side-encryption-aws-kms-key-id" = aws_kms_key.quorum_configs.arn
          }
          Null = {
            "s3:x-amz-server-side-encryption" = "true"
          }
        }
      },
      {
        # Deny non-HTTPS requests
        Sid    = "DenyHTTP"
        Effect = "Deny"
        Principal = {
          AWS = "*"
        }
        Action   = "s3:*"
        Resource = [
          aws_s3_bucket.quorum_configs.arn,
          "${aws_s3_bucket.quorum_configs.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
      {
        # Allow gateway role to read all project configs
        Sid    = "AllowGatewayRead"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.quorum_gateway.arn
        }
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:ListBucket",
        ]
        Resource = [
          aws_s3_bucket.quorum_configs.arn,
          "${aws_s3_bucket.quorum_configs.arn}/*",
        ]
      },
      {
        # Allow team leads to write to project config paths only
        Sid    = "AllowTeamLeadWrite"
        Effect = "Allow"
        Principal = {
          AWS = length(var.team_lead_arns) > 0 ? var.team_lead_arns : ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
        }
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:ListBucket",
        ]
        Resource = [
          aws_s3_bucket.quorum_configs.arn,
          "${aws_s3_bucket.quorum_configs.arn}/*",
        ]
      },
    ]
  })
}

# ── IAM role for Quorum Gateway (IRSA) ────────────────────────────────────────
#
# The gateway pod authenticates to AWS using IAM Roles for Service Accounts (IRSA).
# This replaces static AWS_ACCESS_KEY_ID/SECRET credentials in the pod environment.
#
# The trust policy allows the EKS OIDC provider to assume this role — scoped to
# the specific namespace:serviceaccount pair.
#
# Prerequisite: EKS cluster must have OIDC provider configured.
# Set eks_oidc_provider_arn and eks_oidc_provider_url variables.

resource "aws_iam_role" "quorum_gateway" {
  name        = "quorum-gateway-${var.environment}"
  description = "Role assumed by the Quorum Gateway pod via IRSA to read project configs from S3"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # IRSA trust: allow the Kubernetes service account to assume this role
      # Only applies when eks_oidc_provider_arn is set (EKS deployments)
      length(var.eks_oidc_provider_arn) > 0 ? {
        Sid    = "EKSIRSATrust"
        Effect = "Allow"
        Principal = {
          Federated = var.eks_oidc_provider_arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "${var.eks_oidc_provider_url}:sub" = "system:serviceaccount:${var.gateway_eks_namespace}:${var.gateway_service_account_name}"
            "${var.eks_oidc_provider_url}:aud" = "sts.amazonaws.com"
          }
        }
      } : null,
    ]
  })
}

resource "aws_iam_role_policy" "quorum_gateway_s3" {
  name = "quorum-gateway-s3-read"
  role = aws_iam_role.quorum_gateway.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadProjectConfigs"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:ListBucket",
        ]
        Resource = [
          aws_s3_bucket.quorum_configs.arn,
          "${aws_s3_bucket.quorum_configs.arn}/*",
        ]
      },
      {
        Sid    = "DecryptConfigs"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:DescribeKey",
        ]
        Resource = aws_kms_key.quorum_configs.arn
      },
    ]
  })
}

# ── IAM policies for team leads (per-project write access) ────────────────────
#
# Each team lead policy is scoped to a specific project prefix.
# Team leads write their project config; they cannot overwrite other teams' configs.
#
# Usage: attach these managed policies to the relevant IAM users/roles.

resource "aws_iam_policy" "quorum_team_lead" {
  for_each = toset(var.project_ids)

  name        = "quorum-team-lead-${each.key}-${var.environment}"
  description = "Allow writing Quorum project config for project '${each.key}'"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "WriteProjectConfig"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:DeleteObjectVersion", # Allow rollback of accidental uploads via version management
        ]
        Resource = "${aws_s3_bucket.quorum_configs.arn}/${each.key}/*"
      },
      {
        Sid    = "ListBucket"
        Effect = "Allow"
        Action = "s3:ListBucket"
        Resource = aws_s3_bucket.quorum_configs.arn
        Condition = {
          StringLike = {
            "s3:prefix" = "${each.key}/*"
          }
        }
      },
      {
        Sid    = "EncryptProjectConfig"
        Effect = "Allow"
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "kms:DescribeKey",
        ]
        Resource = aws_kms_key.quorum_configs.arn
      },
    ]
  })
}

# ── S3 lifecycle rule ─────────────────────────────────────────────────────────
#
# Old config versions are kept indefinitely for audit purposes.
# Transition noncurrent versions to cheaper storage after 90 days.

resource "aws_s3_bucket_lifecycle_configuration" "quorum_configs" {
  bucket     = aws_s3_bucket.quorum_configs.id
  depends_on = [aws_s3_bucket_versioning.quorum_configs]

  rule {
    id     = "archive-old-config-versions"
    status = "Enabled"

    noncurrent_version_transition {
      noncurrent_days = 90
      storage_class   = "STANDARD_IA"
    }

    noncurrent_version_transition {
      noncurrent_days = 365
      storage_class   = "GLACIER_IR"
    }
  }
}
