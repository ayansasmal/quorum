#!/usr/bin/env bash
# =============================================================================
# init-localstack.sh — Bootstrap LocalStack S3 for local Docker Compose dev
#
# Called by setup.sh docker after the stack is healthy.
# Runs on the HOST machine (uses awslocal → localhost:4566).
#
# Usage:
#   ./scripts/init-localstack.sh
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

BUCKET="${QUORUM_CONFIG_BUCKET:-quorum-configs}"
PROJECT_ID="${QUORUM_PROJECT_ID:-my-team}"
CONFIG_SRC="$PROJECT_ROOT/quorum.config.example.json"
S3_KEY="$PROJECT_ID/config.json"

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

# ── Create bucket if it does not exist ───────────────────────────────────────
info "Checking bucket s3://$BUCKET ..."
if awslocal s3api head-bucket --bucket "$BUCKET" &>/dev/null 2>&1; then
  ok "Bucket already exists: s3://$BUCKET"
else
  awslocal s3api create-bucket --bucket "$BUCKET" --region us-east-1 &>/dev/null
  ok "Bucket created: s3://$BUCKET"
fi

# ── Upload example config only if the key does not already exist ──────────────
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

# ── Show available configs ────────────────────────────────────────────────────
echo ""
info "Available configs in s3://$BUCKET/:"
awslocal s3api list-objects --bucket "$BUCKET" \
  --query 'Contents[].{Key:Key,Size:Size}' --output table 2>/dev/null \
  || echo "  (empty)"

echo ""
ok "LocalStack S3 ready"
info "Gateway config: set QUORUM_PROJECT_ID to one of the prefixes above (currently: $PROJECT_ID)"
