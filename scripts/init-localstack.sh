#!/usr/bin/env bash
# =============================================================================
# init-localstack.sh — Bootstrap LocalStack S3 for local Docker Compose dev
#
# Called by setup.sh docker after the stack is healthy.
# Runs on the HOST machine (uses awslocal → localhost:4566).
#
# Usage:
#   ./scripts/init-localstack.sh             # full bootstrap (create bucket + upload)
#   ./scripts/init-localstack.sh --read-only # list configs only, no writes
#
# Environment:
#   QUORUM_CONFIG_BUCKET   bucket name            (default: quorum-configs)
#   QUORUM_PROJECT_ID      team config prefix     (default: my-team)
#
# Requirements:
#   pip install awscli-local   (provides awslocal command)
#
# Idempotency:
#   - Bucket creation is skipped if the bucket already exists.
#   - Config upload is skipped if the key already exists in the bucket.
#     This preserves configs managed by other workflows (e.g. Crossplane).
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

READ_ONLY=false
[[ "${1:-}" == "--read-only" ]] && READ_ONLY=true

BUCKET="${QUORUM_CONFIG_BUCKET:-quorum-configs}"
PROJECT_ID="${QUORUM_PROJECT_ID:-my-team}"
CONFIG_SRC="$PROJECT_ROOT/quorum.config.example.json"
S3_KEY="$PROJECT_ID/config.json"

# Region used for all awslocal calls. Honour AWS_REGION if set (e.g. from .env),
# otherwise default to us-east-1. All clients (ddb.js, config-cache.js, etc.)
# use the same fallback so everything stays in the same region.
REGION="${AWS_REGION:-us-east-1}"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'

info() { echo -e "${BLUE}▶${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

# ── Check awslocal ────────────────────────────────────────────────────────────
if ! command -v awslocal &>/dev/null; then
  die "awslocal not found. Install with: pip install awscli-local"
fi

# ── Wait for LocalStack to be fully ready ─────────────────────────────────────
info "Checking LocalStack at localhost:4566..."
ls_timeout=30 ls_elapsed=0
until awslocal s3api list-buckets &>/dev/null 2>&1; do
  [[ $ls_elapsed -ge $ls_timeout ]] \
    && die "LocalStack not reachable at localhost:4566 after ${ls_timeout}s"
  sleep 2; ls_elapsed=$((ls_elapsed + 2))
done
ok "LocalStack reachable"

# ── Create bucket + upload config (skipped in read-only mode) ─────────────────
if $READ_ONLY; then
  ok "Read-only mode — skipping bucket creation and config upload"
else
  # Create bucket if it does not exist
  info "Checking bucket s3://$BUCKET ..."
  if awslocal s3api head-bucket --bucket "$BUCKET" &>/dev/null 2>&1; then
    ok "Bucket already exists: s3://$BUCKET"
  else
    awslocal s3api create-bucket --bucket "$BUCKET" --region "$REGION" &>/dev/null
    ok "Bucket created: s3://$BUCKET"
  fi

  # Upload example config only if the key does not already exist.
  # Skipping preserves configs written by other workflows (Crossplane, CI, etc.)
  info "Checking s3://$BUCKET/$S3_KEY ..."
  if awslocal s3api head-object --bucket "$BUCKET" --key "$S3_KEY" &>/dev/null 2>&1; then
    ok "Config already exists at s3://$BUCKET/$S3_KEY — skipping upload"
  elif [[ -f "$CONFIG_SRC" ]]; then
    info "Uploading $CONFIG_SRC → s3://$BUCKET/$S3_KEY ..."
    upload_attempt=0 upload_ok=false
    until $upload_ok; do
      if awslocal s3api put-object \
          --bucket       "$BUCKET" \
          --key          "$S3_KEY" \
          --body         "$CONFIG_SRC" \
          --content-type application/json &>/dev/null 2>&1; then
        upload_ok=true
      else
        upload_attempt=$((upload_attempt + 1))
        if [[ $upload_attempt -ge 3 ]]; then
          warn "Upload failed after 3 attempts — skipping (non-fatal)"
          warn "To upload manually: awslocal s3api put-object --bucket $BUCKET --key $S3_KEY --body $CONFIG_SRC"
          break
        fi
        warn "Upload attempt $upload_attempt failed — retrying in 3 s..."
        sleep 3
      fi
    done
    $upload_ok && ok "Config uploaded: s3://$BUCKET/$S3_KEY"
  else
    warn "Source file not found: $CONFIG_SRC — skipping upload"
  fi
fi

# ── DynamoDB tables ────────────────────────────────────────────────────────────
CONFIGS_TABLE="${QUORUM_DDB_CONFIGS_TABLE:-quorum-configs}"
USER_PROJECTS_TABLE="${QUORUM_DDB_USER_PROJECTS_TABLE:-quorum-user-projects}"

# quorum-configs — project config cache
if awslocal dynamodb describe-table --table-name "$CONFIGS_TABLE" --region "$REGION" &>/dev/null 2>&1; then
  ok "DynamoDB table already exists: $CONFIGS_TABLE"
else
  awslocal dynamodb create-table \
    --table-name "$CONFIGS_TABLE" \
    --attribute-definitions AttributeName=project_id,AttributeType=S \
    --key-schema AttributeName=project_id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION" > /dev/null
  # Enable TTL on the ttl attribute
  awslocal dynamodb update-time-to-live \
    --table-name "$CONFIGS_TABLE" \
    --time-to-live-specification "Enabled=true,AttributeName=ttl" \
    --region "$REGION" > /dev/null
  ok "DynamoDB table created: $CONFIGS_TABLE"
fi

# quorum-user-projects — user→project mapping with GSI
if awslocal dynamodb describe-table --table-name "$USER_PROJECTS_TABLE" --region "$REGION" &>/dev/null 2>&1; then
  ok "DynamoDB table already exists: $USER_PROJECTS_TABLE"
else
  awslocal dynamodb create-table \
    --table-name "$USER_PROJECTS_TABLE" \
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
        {"AttributeName":"project_id","KeyType":"HASH"},
        {"AttributeName":"github_username","KeyType":"RANGE"}
      ],
      "Projection": {"ProjectionType":"ALL"}
    }]' \
    --region "$REGION" > /dev/null
  ok "DynamoDB table created: $USER_PROJECTS_TABLE (GSI: ProjectMembersIndex)"
fi

# ── Show available configs ────────────────────────────────────────────────────
echo ""
info "Available configs in s3://$BUCKET/:"
awslocal s3api list-objects --bucket "$BUCKET" \
  --query 'Contents[].{Key:Key,Size:Size}' --output table 2>/dev/null \
  || echo "  (empty)"

echo ""
ok "LocalStack S3 ready"
if $READ_ONLY; then
  warn "Using external LocalStack — set QUORUM_PROJECT_ID in .env to one of the prefixes above"
  info "Example: QUORUM_PROJECT_ID=platform-team"
else
  info "Gateway config: QUORUM_PROJECT_ID=$PROJECT_ID (change in .env if needed)"
fi
