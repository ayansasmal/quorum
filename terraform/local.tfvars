# LocalStack variable overrides — used by setup_env.sh local
# tflocal reads this file alongside local.auto.tfvars (LocalStack endpoint config)
#
# These are intentionally minimal: no real IAM ARNs, no OIDC provider,
# no IRSA needed — LocalStack accepts dummy values.

environment = "local"
bucket_name = "quorum-configs-local"

project_ids = [
  "default",
  "platform-team",
  "backend-team",
]

# No real IAM ARNs needed locally — LocalStack accepts empty list
team_lead_arns = []

# No EKS OIDC provider locally — IRSA trust policy skipped
eks_oidc_provider_arn = ""
eks_oidc_provider_url = ""

# Shorter KMS deletion window for local dev (minimum allowed is 7)
kms_deletion_window_in_days = 7
