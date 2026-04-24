#!/usr/bin/env bash
# =============================================================================
# Quorum — unified setup entrypoint
#
# Usage:
#   ./scripts/setup.sh docker   — start full stack via Docker Compose (local dev)
#   ./scripts/setup.sh k8s      — deploy to Docker Desktop Kubernetes via Helm + Crossplane
#   ./scripts/setup.sh k8s teardown
#   ./scripts/setup.sh k8s status
#   ./scripts/setup.sh k8s build
#   ./scripts/setup.sh help
#
# Infrastructure provisioning (S3 buckets, IAM) is managed exclusively by
# Crossplane — see crossplane/ for manifests. Terraform is not used.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_ROOT/logs"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
COMMAND="${1:-help}"

mkdir -p "$LOG_DIR"

# ── Colours ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

info()   { echo -e "${BLUE}▶${NC} $*"; }
ok()     { echo -e "${GREEN}✓${NC} $*"; }
warn()   { echo -e "${YELLOW}⚠${NC}  $*"; }
die()    { echo -e "${RED}✗${NC} $*" >&2; exit 1; }
header() { echo -e "\n${BOLD}$*${NC}"; printf '─%.0s' {1..54}; echo; }

# ── Shared checks ─────────────────────────────────────────────────────────────

check_node() {
  command -v node &>/dev/null || die "Node.js not found. Install: brew install node"
  local ver; ver=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
  [[ "$ver" -ge 20 ]] || die "Node.js 20+ required. Got: $(node --version)"
  ok "node $(node --version)"
}

check_docker() {
  command -v docker &>/dev/null || die "Docker not found. Install Docker Desktop."
  docker info &>/dev/null       || die "Docker daemon is not running. Start Docker Desktop."
  ok "docker $(docker --version | awk '{print $3}' | tr -d ',')"
}

# ── docker mode ───────────────────────────────────────────────────────────────
# Starts the full stack via Docker Compose: FalkorDB + PostgreSQL + Graphiti +
# Quorum MCP server + Gateway + Dashboard. No Kubernetes required.

cmd_docker() {
  local LOG_FILE="$LOG_DIR/setup.${TIMESTAMP}.log"
  exec > >(tee -a "$LOG_FILE") 2>&1

  header "Quorum — Docker Compose Setup"
  info "Log: $LOG_FILE"

  check_node
  check_docker

  header "Node.js dependencies"
  cd "$PROJECT_ROOT"
  npm install

  header "Environment file"
  if [[ ! -f .env ]]; then
    cp .env.example .env
    ok ".env created from .env.example"
    warn "Add your OPENAI_API_KEY to .env before starting (required by Graphiti)"
  else
    ok ".env already exists"
  fi

  if ! grep -q "^OPENAI_API_KEY=sk-" .env 2>/dev/null; then
    warn "OPENAI_API_KEY not set — Graphiti entity extraction will fail"
    warn "Edit .env and add: OPENAI_API_KEY=sk-..."
  fi

  header "Docker stack"
  info "Starting FalkorDB + PostgreSQL + Graphiti + Gateway + Dashboard..."
  docker compose up -d

  info "Waiting for services to be healthy..."
  local timeout=60 elapsed=0
  while [[ $elapsed -lt $timeout ]]; do
    local falkor postgres
    falkor=$(docker compose ps --format json falkordb 2>/dev/null \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('Health',''))" 2>/dev/null || echo "")
    postgres=$(docker compose ps --format json postgresql 2>/dev/null \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('Health',''))" 2>/dev/null || echo "")

    if [[ "$falkor" == "healthy" && "$postgres" == "healthy" ]]; then
      ok "All services healthy"
      break
    fi
    sleep 3; elapsed=$((elapsed + 3))
    echo "  waiting... (${elapsed}s)"
  done

  [[ $elapsed -ge $timeout ]] && die "Timed out waiting for services. Check: docker compose ps"

  header "Seed data"
  npm run seed

  header "Setup complete"
  echo ""
  echo "  Add Quorum to Claude Code:"
  echo "    claude mcp add quorum -- node $(pwd)/src/server.js"
  echo ""
  echo "  Verify:"
  echo "    node cli.js audit verify"
  echo "    node cli.js history auth:token-strategy"
  echo ""
  echo "  Dashboard: http://localhost:3002"
  echo "  Gateway:   http://localhost:3001/health"
  echo ""
}

# ── k8s mode ──────────────────────────────────────────────────────────────────
# Delegates to scripts/k8s-setup.sh with the remaining arguments.
# Infrastructure (S3) is managed by Crossplane — see crossplane/ for manifests.

cmd_k8s() {
  local K8S_SCRIPT="$SCRIPT_DIR/k8s-setup.sh"
  [[ -f "$K8S_SCRIPT" ]] || die "k8s-setup.sh not found at $K8S_SCRIPT"
  exec bash "$K8S_SCRIPT" "${@}"
}

# ── help ──────────────────────────────────────────────────────────────────────

cmd_help() {
  echo ""
  echo -e "${BOLD}Quorum Setup${NC}"
  echo ""
  echo "  ./scripts/setup.sh docker          Start full stack via Docker Compose"
  echo "  ./scripts/setup.sh k8s             Deploy to Docker Desktop Kubernetes"
  echo "  ./scripts/setup.sh k8s teardown    Remove all K8s resources"
  echo "  ./scripts/setup.sh k8s status      Show current K8s deployment state"
  echo "  ./scripts/setup.sh k8s build       Rebuild gateway image only"
  echo ""
  echo "  Infrastructure (S3 buckets, IAM) — Crossplane only:"
  echo "    kubectl apply -f crossplane/provider/"
  echo "    kubectl apply -f crossplane/bucket/"
  echo "    kubectl apply -f crossplane/objects/"
  echo ""
  echo "  CronJob runners (also available as npm run job:*):"
  echo "    node scripts/decay-confidence.js [--dry-run]"
  echo "    node scripts/archive-audit.js    [--dry-run]"
  echo "    node scripts/recheck-conflicts.js"
  echo ""
}

# ── dispatch ──────────────────────────────────────────────────────────────────

case "$COMMAND" in
  docker) cmd_docker ;;
  k8s)    shift; cmd_k8s "${@}" ;;
  help|--help|-h) cmd_help ;;
  *)
    echo -e "${RED}Unknown command: $COMMAND${NC}" >&2
    cmd_help
    exit 1
    ;;
esac
