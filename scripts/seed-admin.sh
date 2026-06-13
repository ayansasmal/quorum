#!/usr/bin/env bash
# =============================================================================
# seed-admin.sh — Seed the first platform admin on a real AWS deployment
#
# Real-AWS counterpart to the admin block in init-localstack.sh (which only
# targets LocalStack via awslocal). Writes the platform admin config object
# s3://${QUORUM_CONFIG_BUCKET}/configs/.quorum so a fresh installer can make
# themselves an admin and move on — without waiting for the gateway boot-seed
# (which silently no-ops when QUORUM_FIRST_ADMIN is unset).
#
# The object shape is identical to what gateway/src/config-cache.js
# ensureAdminConfig() produces, so the next gateway boot finds it present and
# cleanly no-ops (already_exists) rather than double-seeding.
#
# Usage:
#   ./scripts/seed-admin.sh                       # interactive (prompts / gh login)
#   QUORUM_FIRST_ADMIN=octocat ./scripts/seed-admin.sh
#   QUORUM_FIRST_ADMIN=alice,bob ./scripts/seed-admin.sh   # multiple admins
#   ./scripts/seed-admin.sh --bucket my-cfg --region ap-southeast-2
#   ./scripts/seed-admin.sh --force               # overwrite an existing config
#
# Admin resolution order:
#   QUORUM_FIRST_ADMIN env (comma-separated) → gh api user login → interactive prompt
#
# Environment:
#   QUORUM_CONFIG_BUCKET   target bucket  (or pass --bucket; required)
#   AWS_REGION             AWS region     (or pass --region; falls back to
#                                          `aws configure get region`)
#   QUORUM_FIRST_ADMIN     GitHub username(s), comma-separated (optional)
#
# Requirements:
#   - aws CLI v2, authenticated with PutObject/HeadObject on the config bucket
#   - gh CLI (optional — used only to suggest your own GitHub login)
#
# Idempotency:
#   Skips if configs/.quorum already exists, unless --force is given. Without
#   --force the write uses an S3 conditional (--if-none-match '*') so a
#   concurrent seed cannot be clobbered.
# =============================================================================

set -euo pipefail

ADMIN_S3_KEY="configs/.quorum"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'

info() { echo -e "${BLUE}▶${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

# ── Args ──────────────────────────────────────────────────────────────────────
FORCE=false
BUCKET="${QUORUM_CONFIG_BUCKET:-}"
REGION="${AWS_REGION:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)   FORCE=true; shift ;;
    --bucket)  BUCKET="${2:?--bucket needs a value}"; shift 2 ;;
    --region)  REGION="${2:?--region needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         die "unknown argument: $1 (try --help)" ;;
  esac
done

# ── Preconditions ─────────────────────────────────────────────────────────────
command -v aws &>/dev/null || die "aws CLI not found. Install AWS CLI v2."

[[ -z "$BUCKET" ]] && die "config bucket not set. Pass --bucket <name> or export QUORUM_CONFIG_BUCKET."

[[ -z "$REGION" ]] && REGION="$(aws configure get region 2>/dev/null || true)"
[[ -z "$REGION" ]] && die "region not set. Pass --region <region> or export AWS_REGION."

# Confirm the bucket exists and we can reach it before doing anything else.
aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" &>/dev/null \
  || die "cannot access bucket '$BUCKET' in $REGION (check name, region, and credentials)."

# ── Idempotency check ─────────────────────────────────────────────────────────
if aws s3api head-object --bucket "$BUCKET" --key "$ADMIN_S3_KEY" --region "$REGION" &>/dev/null; then
  if [[ "$FORCE" == false ]]; then
    ok "Admin config already exists: s3://$BUCKET/$ADMIN_S3_KEY (use --force to overwrite)"
    exit 0
  fi
  warn "Admin config exists — overwriting because --force was given."
fi

# ── Resolve the admin username(s) ─────────────────────────────────────────────
# env → gh login (as a prompt default) → interactive prompt.
FIRST_ADMIN="${QUORUM_FIRST_ADMIN:-}"
if [[ -z "$FIRST_ADMIN" ]]; then
  SUGGEST=""
  command -v gh &>/dev/null && SUGGEST="$(gh api user --jq .login 2>/dev/null || true)"
  if [[ -n "$SUGGEST" ]]; then
    read -rp "  GitHub username(s) for first admin (comma-separated) [$SUGGEST]: " FIRST_ADMIN
    FIRST_ADMIN="${FIRST_ADMIN:-$SUGGEST}"
  else
    read -rp "  GitHub username(s) for first platform admin (comma-separated): " FIRST_ADMIN
  fi
fi
[[ -z "$FIRST_ADMIN" ]] && die "no admin specified. Set QUORUM_FIRST_ADMIN or answer the prompt."

# Trim surrounding whitespace from a string (pure bash; bash 3.2-safe).
trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }

# ── Build the admins array (split on comma, trim, dedupe) ─────────────────────
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
SEEN=" "           # space-delimited seen-set, avoids arrays for bash 3.2 safety
ADMIN_ENTRIES=""
COUNT=0
OLD_IFS="$IFS"; IFS=','
for raw in $FIRST_ADMIN; do
  IFS="$OLD_IFS"
  u="$(trim "$raw")"
  if [[ -z "$u" ]]; then IFS=','; continue; fi
  case "$SEEN" in *" $u "*) IFS=','; continue ;; esac   # already added
  SEEN="$SEEN$u "
  [[ $COUNT -gt 0 ]] && ADMIN_ENTRIES+=","
  ADMIN_ENTRIES+=$(printf '\n    { "github_username": "%s", "added_at": "%s", "added_by": "setup-script" }' "$u" "$NOW")
  COUNT=$((COUNT + 1))
  IFS=','
done
IFS="$OLD_IFS"
[[ $COUNT -eq 0 ]] && die "no valid usernames parsed from: '$FIRST_ADMIN'"

# ── Assemble + upload ─────────────────────────────────────────────────────────
TMP="$(mktemp -t quorum-admin-config.XXXXXX)"
trap 'rm -f "$TMP"' EXIT
printf '{\n  "admins": [%s\n  ],\n  "version": 1,\n  "created_at": "%s"\n}\n' "$ADMIN_ENTRIES" "$NOW" > "$TMP"

PUT_ARGS=(--bucket "$BUCKET" --key "$ADMIN_S3_KEY" --body "$TMP" --content-type application/json --region "$REGION")
[[ "$FORCE" == false ]] && PUT_ARGS+=(--if-none-match '*')

info "Seeding s3://$BUCKET/$ADMIN_S3_KEY ($COUNT admin(s): ${SEEN# }) ..."
aws s3api put-object "${PUT_ARGS[@]}" >/dev/null \
  || die "put-object failed (a concurrent seed may have won the race; re-run with --force to overwrite)."

ok "Admin config seeded: s3://$BUCKET/$ADMIN_S3_KEY"
info "The gateway picks this up on next boot; no restart of an already-running gateway is needed beyond cache TTL (QUORUM_ADMIN_CACHE_TTL, default 300s)."
