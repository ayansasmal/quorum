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
if ! awslocal s3 ls &>/dev/null 2>&1; then
  die "LocalStack not reachable at localhost:4566. Is the Docker stack running?"
fi
ok "LocalStack reachable"

# ── Create bucket (idempotent) ────────────────────────────────────────────────
info "Creating S3 bucket: s3://$BUCKET ..."
if awslocal s3 ls "s3://$BUCKET" &>/dev/null 2>&1; then
  ok "Bucket already exists: s3://$BUCKET"
else
  awslocal s3 mb "s3://$BUCKET" --region us-east-1
  ok "Bucket created: s3://$BUCKET"
fi

# ── Upload example team config ────────────────────────────────────────────────
if [[ -f "$CONFIG_PATH" ]]; then
  S3_KEY="$PROJECT_ID/config.json"
  info "Uploading $CONFIG_PATH → s3://$BUCKET/$S3_KEY ..."
  awslocal s3 cp "$CONFIG_PATH" "s3://$BUCKET/$S3_KEY" \
    --content-type application/json
  ok "Config uploaded: s3://$BUCKET/$S3_KEY"
else
  warn "Config file not found at $CONFIG_PATH — skipping upload"
  warn "Create quorum.config.local.json or set QUORUM_CONFIG_PATH in .env"
fi

# ── Show bucket contents ──────────────────────────────────────────────────────
echo ""
info "Bucket contents:"
awslocal s3 ls "s3://$BUCKET/" --recursive 2>/dev/null \
  | awk '{printf "  %-10s  %s\n", $3, $4}' \
  || echo "  (empty)"

echo ""
ok "LocalStack S3 ready — gateway will use s3://$BUCKET/$PROJECT_ID/config.json"
