#!/usr/bin/env bash
# =============================================================================
# init-localstack.sh — Bootstrap LocalStack for local Docker Compose dev
#
# Called by setup.sh docker after the stack is healthy.
# Runs on the HOST machine (uses awslocal → localhost:4566).
#
# Usage:
#   ./scripts/init-localstack.sh               # full bootstrap
#   ./scripts/init-localstack.sh --skip-bucket # skip bucket creation (external LS)
#
# Project configs:
#   Place one file per project in configs/<group_id>.quorum.json.
#   Copy example.quorum.json as a starting point.
#   These are gitignored (contain real usernames/emails).
#
# Environment:
#   QUORUM_CONFIG_BUCKET   bucket name  (default: quorum-configs)
#   AWS_REGION             AWS region   (default: us-east-1)
#
# Requirements:
#   pip install awscli-local   (provides awslocal command)
#
# Idempotency:
#   - Bucket/table creation is skipped if they already exist.
#   - Config uploads always overwrite — configs/ is the local source of truth.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SKIP_BUCKET=false
[[ "${1:-}" == "--skip-bucket" ]] && SKIP_BUCKET=true

BUCKET="${QUORUM_CONFIG_BUCKET:-quorum-configs}"
CONFIGS_DIR="$PROJECT_ROOT/configs"

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

# ── Create S3 bucket (skipped when using external LocalStack) ─────────────────
if $SKIP_BUCKET; then
  ok "Skipping bucket creation — using external LocalStack"
else
  info "Checking bucket s3://$BUCKET ..."
  if awslocal s3api head-bucket --bucket "$BUCKET" &>/dev/null 2>&1; then
    ok "Bucket already exists: s3://$BUCKET"
  else
    awslocal s3api create-bucket --bucket "$BUCKET" --region "$REGION" &>/dev/null
    ok "Bucket created: s3://$BUCKET"
  fi
fi

# ── Upload project configs from configs/ ──────────────────────────────────────
# Each configs/<group_id>.quorum.json → s3://$BUCKET/<group_id>.quorum.json (flat).
# Always overwrites — configs/ is the local source of truth.
if [[ -d "$CONFIGS_DIR" ]] && compgen -G "$CONFIGS_DIR/*.quorum.json" > /dev/null 2>&1; then
  for config_file in "$CONFIGS_DIR"/*.quorum.json; do
    filename="$(basename "$config_file")"          # e.g. my-project.quorum.json
    group_id="${filename%.quorum.json}"             # e.g. my-project
    s3_key="$filename"                             # flat key: my-project.quorum.json
    info "Uploading $group_id → s3://$BUCKET/$s3_key ..."
    upload_attempt=0 upload_ok=false
    until $upload_ok; do
      if awslocal s3api put-object \
          --bucket       "$BUCKET" \
          --key          "$s3_key" \
          --body         "$config_file" \
          --content-type application/json &>/dev/null 2>&1; then
        upload_ok=true
      else
        upload_attempt=$((upload_attempt + 1))
        if [[ $upload_attempt -ge 3 ]]; then
          warn "Upload failed after 3 attempts — skipping $group_id (non-fatal)"
          break
        fi
        warn "Upload attempt $upload_attempt failed — retrying in 3 s..."
        sleep 3
      fi
    done
    $upload_ok && ok "Config uploaded: s3://$BUCKET/$s3_key"
  done
else
  warn "No configs found in $CONFIGS_DIR"
  warn "Add project configs as configs/<group_id>.quorum.json (copy example.quorum.json)"
fi

# ── Admin config (configs/.quorum) ────────────────────────────────────────────
# The gateway loads this on startup to determine platform admins.
# Seeds once — skip if already present in S3.
ADMIN_S3_KEY="configs/.quorum"
if awslocal s3api head-object --bucket "$BUCKET" --key "$ADMIN_S3_KEY" --region "$REGION" &>/dev/null 2>&1; then
  ok "Admin config already seeded: s3://$BUCKET/$ADMIN_S3_KEY"
else
  # Resolve first admin: QUORUM_FIRST_ADMIN env var, then git config, then prompt
  FIRST_ADMIN="${QUORUM_FIRST_ADMIN:-}"
  if [[ -z "$FIRST_ADMIN" ]]; then
    FIRST_ADMIN="$(git config user.name 2>/dev/null || true)"
  fi
  if [[ -z "$FIRST_ADMIN" ]]; then
    read -rp "  Enter GitHub username for first platform admin: " FIRST_ADMIN
  fi

  ADMIN_JSON=$(printf '{
  "admins": [
    {
      "github_username": "%s",
      "added_at": "%s",
      "added_by": "system"
    }
  ],
  "version": 1,
  "updated_at": "%s"
}' "$FIRST_ADMIN" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")

  echo "$ADMIN_JSON" > /tmp/quorum-admin-config.json
  awslocal s3api put-object \
    --bucket       "$BUCKET" \
    --key          "$ADMIN_S3_KEY" \
    --body         /tmp/quorum-admin-config.json \
    --content-type "application/json" \
    --region       "$REGION" > /dev/null
  rm -f /tmp/quorum-admin-config.json
  ok "Admin config seeded: s3://$BUCKET/$ADMIN_S3_KEY (admin: $FIRST_ADMIN)"
fi

# ── DynamoDB tables ────────────────────────────────────────────────────────────
# Note: quorum-configs table is retired in v0.3 — Redis now serves config cache.
# Only quorum-user-projects is needed.
USER_PROJECTS_TABLE="${QUORUM_DDB_USER_PROJECTS_TABLE:-quorum-user-projects}"

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

# ── Seed DDB memberships from uploaded configs ────────────────────────────────
# config_upload (gateway path) does S3 + DDB in one call.
# init-localstack.sh bypasses the gateway (direct awslocal s3 cp), so it must
# seed DDB membership entries itself — otherwise OAuth returns no_projects.
echo ""
info "Seeding DDB memberships from configs..."
if ! command -v python3 &>/dev/null; then
  warn "python3 not found — skipping DDB membership seeding. OAuth login will fail."
  warn "Install python3 and re-run this script, or run POST /sync/configs manually."
else
  SEEDED=0
  for config_file in "$CONFIGS_DIR"/*.quorum.json; do
    [[ -f "$config_file" ]] || continue
    python3 - "$config_file" "$USER_PROJECTS_TABLE" "$REGION" <<'PYEOF'
import json, sys, subprocess
from datetime import datetime, timezone

config_file, table, region = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(config_file) as f:
        config = json.load(f)
except Exception as e:
    print(f'  ✗ failed to parse {config_file}: {e}', file=sys.stderr)
    sys.exit(0)

project_id   = config.get('group_id', '')
project_name = config.get('project', project_id)
owner        = config.get('owner', '')
roles_map    = config.get('roles', {})
updated_at   = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

if config.get('is_hierarchy_anchor'):
    print(f'  - {project_id} is a hierarchy anchor — skipping DDB membership sync')
    sys.exit(0)

for m in config.get('members', []):
    username = m.get('github_username', '')
    if not username:
        continue
    role      = m.get('role', 'engineer') or 'engineer'
    team      = m.get('team', '') or ''
    base_conf = m.get('base_confidence') or roles_map.get(role, {}).get('base_confidence', 0.7)
    is_owner  = (username == owner)

    item = {
        'github_username': {'S': username},
        'project_id':      {'S': project_id},
        'project_name':    {'S': project_name},
        'project_slug':    {'S': project_id},
        'role':            {'S': role},
        'base_confidence': {'N': str(base_conf)},
        'is_owner':        {'BOOL': is_owner},
        'updated_at':      {'S': updated_at},
    }
    if team:
        item['team'] = {'S': team}

    result = subprocess.run(
        ['awslocal', 'dynamodb', 'put-item',
         '--table-name', table, '--region', region,
         '--item', json.dumps(item)],
        capture_output=True
    )
    mark = '✓' if result.returncode == 0 else '✗'
    print(f'  {mark} {username} → {project_id} ({role})')
PYEOF
    SEEDED=$((SEEDED + 1))
  done
  [[ $SEEDED -eq 0 ]] && warn "No configs found — DDB membership table is empty" \
    || ok "DDB memberships seeded from $SEEDED config file(s)"
fi

# ── Show available configs ────────────────────────────────────────────────────
echo ""
info "Available configs in s3://$BUCKET/:"
awslocal s3api list-objects --bucket "$BUCKET" \
  --query 'Contents[].{Key:Key,Size:Size}' --output table 2>/dev/null \
  || echo "  (empty)"

echo ""
ok "LocalStack S3 ready"
info "Project IDs listed above — use one as the group_id when authenticating"
