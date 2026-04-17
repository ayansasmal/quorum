#!/usr/bin/env bash
# =============================================================================
# Quorum Environment Setup
#
# Usage:
#   ./scripts/setup_env.sh local   — start LocalStack + provision AWS resources
#                                    locally, install all dependencies
#   ./scripts/setup_env.sh prod    — provision real AWS resources using
#                                    ~/.aws default credentials
#
# What "local" does:
#   1. Install Terraform (brew) and terraform-local (pip3) if missing
#   2. npm install
#   3. Copy .env.example → .env (if not present)
#   4. Start LocalStack in Docker
#   5. Run tflocal init + apply  →  S3 bucket + KMS + IAM in LocalStack
#   6. Patch .env with LocalStack connection values
#   7. Start PostgreSQL + FalkorDB + Graphiti via Docker Compose
#   8. Create .quorum project file (if not present)
#
# What "prod" does:
#   1. Install Terraform (brew) if missing
#   2. Verify ~/.aws default credentials via sts:GetCallerIdentity
#   3. Check terraform/terraform.tfvars exists (exit with instructions if not)
#   4. terraform init + plan  →  show diff, ask for confirmation
#   5. terraform apply        →  provision real AWS resources
#   6. Print outputs for Helm + CI integration
# =============================================================================

set -euo pipefail

ENV="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
TF_DIR="$ROOT/terraform"

# ── Colours ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}▶${NC} $*"; }
ok()      { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
die()     { echo -e "${RED}✗${NC} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}$*${NC}"; echo "$(printf '─%.0s' {1..54})"; }

# ── Dependency helpers ────────────────────────────────────────────────────────

check_docker() {
  command -v docker &>/dev/null || die "Docker not found. Install Docker Desktop."
  docker info &>/dev/null       || die "Docker daemon is not running. Start Docker Desktop."
  ok "docker $(docker --version | awk '{print $3}' | tr -d ',')"
}

check_node() {
  command -v node &>/dev/null || die "Node.js not found. Install: brew install node"
  ok "node $(node --version)"
}

ensure_terraform() {
  if command -v terraform &>/dev/null; then
    ok "terraform $(terraform version -json 2>/dev/null \
        | python3 -c 'import sys,json; print(json.load(sys.stdin)["terraform_version"])' \
        2>/dev/null || terraform version | head -1)"
    return
  fi
  info "Installing Terraform via Homebrew..."
  command -v brew &>/dev/null || die "Homebrew not found. Install from https://brew.sh"
  brew install terraform
  ok "terraform installed"
}

ensure_tflocal() {
  if command -v tflocal &>/dev/null; then
    ok "tflocal installed"
    return
  fi
  info "Installing terraform-local..."
  pip3 install --quiet terraform-local
  ok "tflocal installed"
}

# ── .env patcher ──────────────────────────────────────────────────────────────
# Sets KEY=VALUE in .env — adds if missing, replaces if present.

patch_env() {
  local key="$1" value="$2" file="$ROOT/.env"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$file" && rm -f "${file}.bak"
  else
    printf '\n%s=%s' "$key" "$value" >> "$file"
  fi
}

# ── LOCAL setup ───────────────────────────────────────────────────────────────

setup_local() {
  header "Quorum — Local Environment Setup"

  # 1. Prerequisites
  info "Checking prerequisites..."
  check_docker
  check_node
  ensure_terraform
  ensure_tflocal

  # 2. Node dependencies
  header "Node.js dependencies"
  info "Running npm install..."
  cd "$ROOT"
  npm install --silent
  ok "node_modules ready"

  # 3. .env file
  header "Environment file"
  if [[ ! -f "$ROOT/.env" ]]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    ok ".env created from .env.example"
    warn "Add your OPENAI_API_KEY to .env before starting the server"
  else
    ok ".env already exists"
  fi

  # 4. LocalStack
  header "LocalStack (AWS emulation)"
  local ls_container_id
  ls_container_id=$(docker ps -q --filter "name=^localstack$" 2>/dev/null || true)

  if [[ -n "$ls_container_id" ]]; then
    ok "LocalStack already running (container: $ls_container_id)"
  else
    info "Starting LocalStack..."
    docker run -d \
      --name localstack \
      --rm \
      -p 4566:4566 \
      -p 4510-4559:4510-4559 \
      -e SERVICES=s3,iam,kms \
      -e DEBUG=0 \
      -v /var/run/docker.sock:/var/run/docker.sock \
      localstack/localstack:latest \
      >/dev/null

    info "Waiting for LocalStack to be healthy..."
    local waited=0 max_wait=90
    until curl -sf http://localhost:4566/_localstack/health \
        | python3 -c "
import sys, json
h = json.load(sys.stdin)
sys.exit(0 if h.get('status') == 'running' else 1)
" 2>/dev/null; do
      [[ $waited -ge $max_wait ]] && die "LocalStack did not become ready after ${max_wait}s"
      sleep 2; waited=$((waited + 2))
    done
    ok "LocalStack ready at http://localhost:4566"
  fi

  # 5. Terraform → LocalStack
  header "Terraform (LocalStack)"
  cd "$TF_DIR"

  info "Initialising Terraform..."
  tflocal init -upgrade -input=false -no-color 2>&1 | tail -3

  info "Applying infrastructure (S3 + KMS + IAM in LocalStack)..."
  tflocal apply -auto-approve -no-color \
    -var-file="$TF_DIR/local.tfvars" \
    2>&1 | grep -E '(Apply complete|Error|already exists|aws_)'

  local bucket
  bucket=$(tflocal output -raw bucket_name 2>/dev/null || echo "quorum-configs-local")
  local gateway_role_arn
  gateway_role_arn=$(tflocal output -raw gateway_iam_role_arn 2>/dev/null || echo "arn:aws:iam::000000000000:role/quorum-gateway-local")

  ok "Terraform apply complete"
  ok "Config bucket: $bucket"
  ok "Gateway role:  $gateway_role_arn"

  # 6. Patch .env with LocalStack values
  header "Patching .env for LocalStack"
  patch_env "QUORUM_CONFIG_BUCKET"     "$bucket"
  patch_env "AWS_ENDPOINT_URL"         "http://localhost:4566"
  patch_env "AWS_REGION"               "ap-southeast-2"
  patch_env "AWS_ACCESS_KEY_ID"        "test"
  patch_env "AWS_SECRET_ACCESS_KEY"    "test"
  ok ".env updated with LocalStack config"

  # Upload example config so the server can find it
  info "Uploading example project config to LocalStack S3..."
  awslocal s3 cp "$ROOT/quorum.config.example.json" \
    "s3://${bucket}/platform-team/config.json" --quiet || true
  ok "Example config at s3://${bucket}/platform-team/config.json"

  # 7. Docker Compose services
  header "Docker Compose services"
  cd "$ROOT"
  info "Starting PostgreSQL, FalkorDB, Graphiti..."
  docker compose up -d postgresql falkordb graphiti

  # Wait for PostgreSQL
  local pg_wait=0
  info "Waiting for PostgreSQL..."
  until docker compose exec -T postgresql \
      pg_isready -U quorum -d quorum_audit &>/dev/null; do
    [[ $pg_wait -ge 60 ]] && die "PostgreSQL did not become ready"
    sleep 2; pg_wait=$((pg_wait + 2))
  done
  ok "PostgreSQL ready"

  # FalkorDB and Graphiti — give them a moment
  sleep 4
  ok "FalkorDB + Graphiti started"

  # 8. .quorum project file
  header ".quorum project file"
  if [[ ! -f "$ROOT/.quorum" ]]; then
    cat > "$ROOT/.quorum" <<JSON
{
  "gateway_url": "http://localhost:3001",
  "project_id": "platform-team"
}
JSON
    ok ".quorum created (pointing to local gateway)"
  else
    ok ".quorum already exists"
  fi

  # ── Done ─────────────────────────────────────────────────────────────────────
  echo ""
  echo -e "${GREEN}${BOLD}Local environment ready!${NC}"
  echo ""
  echo "  Start the MCP server:"
  echo "    npm start"
  echo ""
  echo "  Start the Gateway:"
  echo "    npm run start:gateway"
  echo ""
  echo "  Seed with sample knowledge:"
  echo "    npm run seed"
  echo ""
  echo "  Inspect LocalStack S3:"
  echo "    awslocal s3 ls s3://${bucket}/"
  echo ""
  echo "  Run tests:"
  echo "    npm test"
  echo ""
}

# ── PROD setup ────────────────────────────────────────────────────────────────

setup_prod() {
  header "Quorum — Production Infrastructure Setup"

  # 1. Prerequisites
  info "Checking prerequisites..."
  ensure_terraform

  # 2. AWS credentials check
  header "AWS credentials"
  info "Verifying ~/.aws default profile..."

  local identity account user_arn
  identity=$(aws sts get-caller-identity --output json 2>/dev/null) \
    || die "AWS credentials not found or expired. Run: aws configure"

  account=$(echo "$identity" | python3 -c "import sys,json; print(json.load(sys.stdin)['Account'])")
  user_arn=$(echo  "$identity" | python3 -c "import sys,json; print(json.load(sys.stdin)['Arn'])")

  ok "Account: $account"
  ok "Identity: $user_arn"

  # Sanity check — warn if this looks like an SSO/assumed-role without explicit confirmation
  if echo "$user_arn" | grep -q "assumed-role"; then
    warn "You are using a temporary assumed role. Ensure it has the required IAM permissions."
    warn "Required: s3:*, iam:*, kms:* (or scoped equivalents)"
  fi

  # 3. terraform.tfvars
  header "Terraform variables"
  local tfvars="$TF_DIR/terraform.tfvars"

  if [[ ! -f "$tfvars" ]]; then
    warn "terraform/terraform.tfvars not found"
    cp "$TF_DIR/terraform.tfvars.example" "$tfvars"
    echo ""
    die "$(cat <<MSG
terraform/terraform.tfvars has been created from the example.

Fill in the required values:
  bucket_name          — globally unique S3 bucket name (e.g. acme-quorum-configs)
  team_lead_arns       — IAM ARNs of engineers who can write project configs
  project_ids          — your team/project names (e.g. platform-team)
  eks_oidc_provider_*  — from your EKS cluster outputs (leave blank if no EKS yet)

Then re-run:
  ./scripts/setup_env.sh prod
MSG
)"
  fi
  ok "terraform.tfvars found"

  # 4. Init
  header "Terraform init"
  cd "$TF_DIR"
  info "Initialising Terraform..."
  terraform init -upgrade -input=false
  ok "Terraform initialised"

  # 5. Plan
  header "Terraform plan"
  info "Generating plan..."
  terraform plan -out="$TF_DIR/quorum.tfplan"

  # 6. Confirm
  echo ""
  warn "Review the plan above. This will create real AWS resources."
  warn "Resources created: S3 bucket, KMS key, IAM role, IAM policies"
  echo ""
  read -r -p "  Apply? (yes/no): " confirm
  echo ""

  if [[ "$confirm" != "yes" ]]; then
    info "Aborted. No changes made."
    rm -f "$TF_DIR/quorum.tfplan"
    exit 0
  fi

  # 7. Apply
  header "Terraform apply"
  terraform apply "$TF_DIR/quorum.tfplan"
  rm -f "$TF_DIR/quorum.tfplan"

  # 8. Outputs
  header "Outputs — copy these into your Helm values and CI config"
  echo ""
  terraform output
  echo ""

  local role_arn bucket_out
  role_arn=$(terraform output -raw gateway_iam_role_arn 2>/dev/null || echo "")
  bucket_out=$(terraform output -raw bucket_name       2>/dev/null || echo "")

  if [[ -n "$role_arn" && -n "$bucket_out" ]]; then
    echo ""
    echo "  Helm (values-aws.yaml):"
    echo "    serviceAccount.annotations[\"eks.amazonaws.com/role-arn\"]: ${role_arn}"
    echo ""
    echo "  CI / .env.production:"
    echo "    QUORUM_CONFIG_BUCKET=${bucket_out}"
    echo "    QUORUM_PROJECT_ID=<your-project-id>"
    echo ""
    echo "  Upload your first project config:"
    echo "    aws s3 cp quorum.config.example.json \\"
    echo "      s3://${bucket_out}/<project-id>/config.json \\"
    echo "      --sse aws:kms \\"
    echo "      --sse-kms-key-id $(terraform output -raw kms_key_arn 2>/dev/null || echo '<kms-key-arn>')"
  fi

  echo ""
  warn "Production hardening — do this once after first apply:"
  warn "  In terraform/main.tf, uncomment the lifecycle { prevent_destroy = true } block"
  warn "  on the aws_s3_bucket resource to prevent accidental bucket deletion."
  echo ""
  ok "Production infrastructure provisioned!"
}

# ── Main ──────────────────────────────────────────────────────────────────────

case "$ENV" in
  local) setup_local ;;
  prod)  setup_prod  ;;
  *)
    echo "Usage: $0 [local|prod]"
    echo ""
    echo "  local  — install deps, start LocalStack, provision S3/IAM locally"
    echo "  prod   — provision real AWS resources using ~/.aws default credentials"
    echo ""
    exit 1
    ;;
esac
