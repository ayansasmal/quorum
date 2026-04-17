output "bucket_name" {
  description = "Name of the Quorum project config S3 bucket"
  value       = aws_s3_bucket.quorum_configs.id
}

output "bucket_arn" {
  description = "ARN of the Quorum project config S3 bucket"
  value       = aws_s3_bucket.quorum_configs.arn
}

output "kms_key_arn" {
  description = "ARN of the KMS key used for bucket encryption"
  value       = aws_kms_key.quorum_configs.arn
}

output "kms_key_alias" {
  description = "Alias of the KMS key"
  value       = aws_kms_alias.quorum_configs.name
}

output "gateway_iam_role_arn" {
  description = "ARN of the IAM role used by the Quorum Gateway pod (for IRSA annotation in Helm values)"
  value       = aws_iam_role.quorum_gateway.arn
}

output "team_lead_policy_arns" {
  description = "Map of project_id → IAM policy ARN for team lead write access"
  value       = { for k, v in aws_iam_policy.quorum_team_lead : k => v.arn }
}

output "quorum_config_bucket_env" {
  description = "QUORUM_CONFIG_BUCKET env var value to set in Helm values"
  value       = aws_s3_bucket.quorum_configs.id
}
