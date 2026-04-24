#!/usr/bin/env bash
# =============================================================================
# init-localstack.sh — Bootstrap LocalStack S3 for local Docker Compose dev
#
# Called by setup.sh docker after the stack is healthy.
# Runs on the HOST machine (uses awslocal → localhost:4566).
#
# Usage:
#   ./scripts/init-localstack.sh [--bucket <name>] [--config-path <path>]
#
# Requirements:
#   pip install awscli-local   (provides awslocal command)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BUCKET="${QUORUM_CONFIG_BUCKET:-quorum-configs}"
PROJECT_ID="${QUORUM_PROJECT_ID:-my-team}"
CONFIG_PATH="${1:-$PROJECT_ROOT/quorum.config.example.json}"

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

# ── Check LocalStack is reachable ─────────────────────────────────────────────
info "Checking LocalStack at localhost:4566..."

# Wait up to 30 s for LocalStack to be fully ready (it may have just started).
local_timeout=30 local_elapsed=0
until awslocal s3api list-buckets &>/dev/null 2>&1; do
  [[ $local_elapsed -ge $local_timeout ]] \
    && die "LocalStack not reachable at localhost:4566 after ${local_timeout}s"
  sleep 2; local_elapsed=$((local_elapsed + 2))
done
ok "LocalStack reachable"

# ── Create bucket (idempotent via head-bucket) ────────────────────────────────
info "Creating S3 bucket: s3://$BUCKET ..."
if awslocal s3api head-bucket --bucket "$BUCKET" &>/dev/null 2>&1; then
  ok "Bucket already exists: s3://$BUCKET"
else
  awslocal s3api create-bucket --bucket "$BUCKET" \
    --region us-east-1 &>/dev/null
  ok "Bucket created: s3://$BUCKET"
fi

# ── Upload example team config (s3api put-object — avoids transfer-manager
#    routing bugs in some LocalStack CLI-managed instances) ───────────────────
if [[ -f "$CONFIG_PATH" ]]; then
  S3_KEY="$PROJECT_ID/config.json"
  info "Uploading $CONFIG_PATH → s3://$BUCKET/$S3_KEY ..."

  # Retry up to 3 times — LocalStack occasionally returns a transient InternalError
  # on PutObject immediately after bucket creation.
  local_attempt=0
  until awslocal s3api put-object \
      --bucket "$BUCKET" \
      --key    "$S3_KEY" \
      --body   "$CONFIG_PATH" \
      --content-type application/json &>/dev/null 2>&1; do
    local_attempt=$((local_attempt + 1))
    [[ $local_attempt -ge 3 ]] \
      && die "Upload failed after 3 attempts. Check: awslocal s3api list-buckets"
    warn "Upload attempt $local_attempt failed — retrying in 3 s..."
    sleep 3
  done
  ok "Config uploaded: s3://$BUCKET/$S3_KEY"
else
  warn "Config file not found at $CONFIG_PATH — skipping upload"
  warn "Create quorum.config.local.json or set QUORUM_CONFIG_PATH in .env"
fi

# ── Show bucket contents ──────────────────────────────────────────────────────
echo ""
info "Bucket contents:"
awslocal s3api list-objects --bucket "$BUCKET" \
  --query 'Contents[].{Key:Key,Size:Size}' --output table 2>/dev/null \
  || echo "  (empty)"

echo ""
ok "LocalStack S3 ready — gateway will use s3://$BUCKET/$PROJECT_ID/config.json"
