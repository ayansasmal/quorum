#!/usr/bin/env bash
# =============================================================================
# init-localstack-e2e.sh — Bootstrap E2E test resources inside LocalStack.
#
# This script is mounted into the LocalStack container at:
#   /etc/localstack/init/ready.d/01-init.sh
#
# LocalStack runs scripts in this directory automatically once it has
# fully initialised S3 + DynamoDB. The awslocal CLI is pre-installed
# in the LocalStack image — no pip install required.
#
# Environment variables (passed via docker-compose.e2e.yml):
#   QUORUM_CONFIG_BUCKET            S3 bucket name   (default: quorum-configs-test)
#   QUORUM_DDB_USER_PROJECTS_TABLE  DDB table name   (default: quorum-user-projects-test)
#   AWS_DEFAULT_REGION              AWS region        (default: us-east-1)
#
# Idempotent — safe to run multiple times. Existing resources are skipped.
# =============================================================================

set -euo pipefail

BUCKET="${QUORUM_CONFIG_BUCKET:-quorum-configs-test}"
TABLE="${QUORUM_DDB_USER_PROJECTS_TABLE:-quorum-user-projects-test}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

echo "▶ [E2E init] Creating S3 bucket: $BUCKET"
if awslocal s3api create-bucket --bucket "$BUCKET" --region "$REGION" > /dev/null 2>&1; then
  echo "✓ [E2E init] Bucket created: $BUCKET"
else
  echo "ℹ [E2E init] Bucket already exists: $BUCKET"
fi

echo "▶ [E2E init] Creating DDB table: $TABLE"
if awslocal dynamodb create-table \
  --table-name "$TABLE" \
  --attribute-definitions \
    AttributeName=github_username,AttributeType=S \
    AttributeName=project_id,AttributeType=S \
  --key-schema \
    AttributeName=github_username,KeyType=HASH \
    AttributeName=project_id,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --global-secondary-indexes '[{
    "IndexName": "ProjectMembersIndex",
    "KeySchema": [
      {"AttributeName": "project_id",       "KeyType": "HASH"},
      {"AttributeName": "github_username",  "KeyType": "RANGE"}
    ],
    "Projection": {"ProjectionType": "ALL"}
  }]' \
  --region "$REGION" > /dev/null 2>&1; then
  echo "✓ [E2E init] DDB table created: $TABLE (GSI: ProjectMembersIndex)"
else
  echo "ℹ [E2E init] DDB table already exists: $TABLE"
fi

echo "▶ [E2E init] Seeding admin config (configs/.quorum)..."
cat > /tmp/quorum-admin.json <<'ADMIN_JSON'
{
  "admins": [
    {
      "github_username": "test-admin",
      "added_at": "2025-01-01T00:00:00Z",
      "added_by": "system"
    }
  ],
  "version": 1,
  "updated_at": "2025-01-01T00:00:00Z"
}
ADMIN_JSON

if awslocal s3api head-object --bucket "$BUCKET" --key "configs/.quorum" --region "$REGION" > /dev/null 2>&1; then
  echo "ℹ [E2E init] Admin config already present — skipping"
else
  awslocal s3api put-object \
    --bucket       "$BUCKET" \
    --key          "configs/.quorum" \
    --body         /tmp/quorum-admin.json \
    --content-type "application/json" \
    --region       "$REGION" > /dev/null
  echo "✓ [E2E init] Admin config seeded (admin: test-admin)"
fi
rm -f /tmp/quorum-admin.json

echo ""
echo "✓ [E2E init] LocalStack bootstrap complete"
echo "  bucket: $BUCKET"
echo "  table:  $TABLE"
echo "  region: $REGION"
