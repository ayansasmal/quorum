variable "aws_region" {
  type        = string
  description = "AWS region to deploy resources in"
  default     = "ap-southeast-2"
}

variable "environment" {
  type        = string
  description = "Deployment environment (e.g. production, staging)"
  default     = "production"
}

variable "bucket_name" {
  type        = string
  description = "Name of the S3 bucket for Quorum project configs (must be globally unique)"
  # Example: "acme-quorum-configs"
}

variable "project_ids" {
  type        = list(string)
  description = "List of project IDs that will have prefix paths in the bucket (e.g. [\"platform-team\", \"backend-team\"]). Used to pre-create IAM policies per project."
  default     = []
}

variable "team_lead_arns" {
  type        = list(string)
  description = "IAM ARNs (users or roles) that can write project configs to S3. These are your team leads — the actual security boundary of the authority model."
  default     = []
  # Example:
  # [
  #   "arn:aws:iam::123456789012:user/alice",
  #   "arn:aws:iam::123456789012:assumed-role/TeamLeadsRole/session"
  # ]
}

variable "gateway_eks_namespace" {
  type        = string
  description = "Kubernetes namespace where the Quorum Gateway pod runs (for IRSA trust policy)"
  default     = "quorum"
}

variable "gateway_service_account_name" {
  type        = string
  description = "Kubernetes service account name for the Quorum Gateway (for IRSA trust policy)"
  default     = "quorum-gateway"
}

variable "eks_oidc_provider_arn" {
  type        = string
  description = "ARN of the EKS OIDC provider (output from your EKS cluster Terraform). Used to build the IRSA trust policy."
  default     = ""
  # Example: "arn:aws:iam::123456789012:oidc-provider/oidc.eks.ap-southeast-2.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE"
}

variable "eks_oidc_provider_url" {
  type        = string
  description = "URL of the EKS OIDC provider without https:// prefix"
  default     = ""
  # Example: "oidc.eks.ap-southeast-2.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE"
}

variable "kms_deletion_window_in_days" {
  type        = number
  description = "KMS key deletion window (7–30 days)"
  default     = 30
  validation {
    condition     = var.kms_deletion_window_in_days >= 7 && var.kms_deletion_window_in_days <= 30
    error_message = "KMS deletion window must be between 7 and 30 days."
  }
}
