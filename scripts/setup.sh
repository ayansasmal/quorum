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

# ── Dev mode ──────────────────────────────────────────────────────────────────
# Bind-mounts gateway/src and runs Vite dev server instead of built images.
# Activated by either of:
#   npm run docker:start --env=dev        (npm sets npm_config_env=dev)
#   QUORUM_ENV=dev ./scripts/setup.sh docker
#
# When active, COMPOSE_FILE merges docker-compose.dev.yml on top of the base
# so all docker compose calls in this script pick up the dev overlay automatically.
if [[ "${npm_config_env:-}" == "dev" ]] || [[ "${QUORUM_ENV:-}" == "dev" ]]; then
  export COMPOSE_FILE="docker-compose.yml:docker-compose.dev.yml"
  export _QUORUM_DEV_MODE=1
else
  export _QUORUM_DEV_MODE=0
fi

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

resolve_graphiti_tag() {
  local fork_dir="$PROJECT_ROOT/../graphiti/quorum-graphiti"

  if [[ -n "${GRAPHITI_TAG:-}" ]]; then
    echo "$GRAPHITI_TAG"
  elif [[ -d "$fork_dir/.git" ]]; then
    echo "sha-$(git -C "$fork_dir" rev-parse HEAD)"
  else
    echo "sha-d99abda38b1181d1f56198f1565510de9564f79b"
  fi
}

# Check for a container already using port 4566 (LocalStack).
#
# Cases handled:
#   quorum-localstack-1  → already Compose-managed, idempotent — no action
#   any other localstack → reuse it: connect to quorum_default network so
#                          gateway can reach it as http://localstack:4566,
#                          then skip starting the Compose service
#   something else       → warn, let Docker surface the real error
#
# Sets EXTERNAL_LOCALSTACK=<name> when an external container will be reused.
check_localstack_conflict() {
  local conflict
  conflict=$(docker ps --filter "publish=4566" --format "{{.Names}}" 2>/dev/null | head -1)

  [[ -z "$conflict" ]] && return 0   # port free — Compose will start its own

  # Our own Compose-managed service — already running, nothing to do.
  if [[ "$conflict" == *"localstack"* && "$conflict" == *"quorum"* ]]; then
    ok "Compose-managed LocalStack already running ($conflict)"
    check_localstack_persistence "$conflict"
    return 0
  fi

  # Any other LocalStack container — reuse it instead of starting a new one.
  if [[ "$conflict" == *"localstack"* ]]; then
    ok "LocalStack already running ($conflict) — reusing it"
    EXTERNAL_LOCALSTACK="$conflict"
    check_localstack_persistence "$conflict"
    return 0
  fi

  # Unknown container on port 4566 — warn and let Docker handle it.
  warn "Container '$conflict' is already using port 4566."
  warn "If 'docker compose up' fails, stop it first: docker stop $conflict"
}

# Detect whether a LocalStack container is running with persistence enabled.
# Persistence requires either PERSISTENCE=1 env var or a volume mounted at
# /var/lib/localstack. Without it, S3 data (project configs) is lost on restart.
check_localstack_persistence() {
  local container="$1"

  local persistence_env
  persistence_env=$(docker inspect "$container" \
    --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep "^PERSISTENCE=" | cut -d= -f2)

  local data_volume
  data_volume=$(docker inspect "$container" \
    --format '{{range .Mounts}}{{if eq .Destination "/var/lib/localstack"}}{{.Source}}{{end}}{{end}}' \
    2>/dev/null)

  if [[ "$persistence_env" == "1" ]] || [[ -n "$data_volume" ]]; then
    ok "LocalStack persistence: ENABLED — S3 configs survive restarts"
    [[ -n "$data_volume" ]] && info "  Data volume: $data_volume"
  else
    warn "LocalStack persistence: DISABLED — S3 configs will be lost on container restart"
    warn "  To enable: set PERSISTENCE=1 and mount a volume at /var/lib/localstack"
    warn "  After any LocalStack restart, re-run: ./scripts/init-localstack.sh"
  fi
}

# ── docker mode ───────────────────────────────────────────────────────────────
# Starts the full stack via Docker Compose: FalkorDB + PostgreSQL + Graphiti +
# Quorum MCP server + Gateway. No Kubernetes required.
# The dashboard ships from its own repo (quorum-dash) and runs separately.

cmd_docker() {
  local LOG_FILE="$LOG_DIR/setup.${TIMESTAMP}.log"
  exec > >(tee -a "$LOG_FILE") 2>&1

  header "Quorum — Docker Compose Setup"
  info "Log: $LOG_FILE"
  if [[ "$_QUORUM_DEV_MODE" == "1" ]]; then
    ok "Dev mode: bind-mounted source (docker-compose.dev.yml overlay active)"
    ok "  Gateway:   node --watch on gateway/src/         →  http://localhost:3001"
  else
    info "Production mode: built images (pass --env=dev or set QUORUM_ENV=dev for live source)"
  fi

  # Tag images with the current git commit hash for traceability.
  # APP_VERSION is read from root package.json — single source of truth for the release version.
  # IMAGE_TAG defaults to the git short hash; falls back to APP_VERSION when git is unavailable.
  # docker-compose.yml reads IMAGE_TAG; its own fallback is also APP_VERSION (via setup.sh export).
  local APP_VERSION
  APP_VERSION=$(python3 -c "import json; print(json.load(open('$PROJECT_ROOT/package.json'))['version'])" 2>/dev/null || echo "latest")
  export IMAGE_TAG
  IMAGE_TAG=$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo "$APP_VERSION")
  info "Image tag: $IMAGE_TAG  (app version: $APP_VERSION)"
  export GRAPHITI_TAG
  GRAPHITI_TAG=$(resolve_graphiti_tag)
  info "Graphiti image tag: $GRAPHITI_TAG"

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
  EXTERNAL_LOCALSTACK=""
  check_localstack_conflict

  # One-time migration: stop containers from the old project name (engram-*)
  # that predate the `name: quorum` fix in docker-compose.yml.
  # --remove-orphans only removes orphans of the current project, so these
  # would otherwise hold their ports and block the new quorum-* containers.
  local old_containers
  old_containers=$(docker ps -q --filter "name=engram-" 2>/dev/null)
  if [[ -n "$old_containers" ]]; then
    warn "Found containers from old project name (engram-*) — stopping them..."
    docker stop $old_containers 2>/dev/null || true
    docker rm   $old_containers 2>/dev/null || true
    ok "Old engram-* containers removed"
  fi

  info "Removing any stale containers (data volumes are preserved)..."
  docker compose down --remove-orphans 2>/dev/null || true

  if [[ -n "$EXTERNAL_LOCALSTACK" ]]; then
    info "Starting stack (skipping LocalStack — reusing $EXTERNAL_LOCALSTACK)..."
    docker compose up -d --scale localstack=0
    # Connect the external container to the quorum network so the gateway can
    # resolve it by service name (http://localstack:4566 inside the network).
    info "Connecting $EXTERNAL_LOCALSTACK to Docker network quorum_default..."
    docker network connect --alias localstack quorum_default "$EXTERNAL_LOCALSTACK" 2>/dev/null \
      && ok "$EXTERNAL_LOCALSTACK connected to quorum_default (alias: localstack)" \
      || ok "$EXTERNAL_LOCALSTACK already in quorum_default — no action needed"
  else
    info "Starting FalkorDB + PostgreSQL + Graphiti + Gateway..."
    docker compose up -d
  fi

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

  header "LocalStack S3"
  if command -v awslocal &>/dev/null; then
    if [[ -n "$EXTERNAL_LOCALSTACK" ]]; then
      # External LocalStack — skip bucket creation (owned by another workflow)
      # but still upload configs and create DDB tables.
      info "Using external LocalStack — uploading configs and creating DDB tables..."
      bash "$SCRIPT_DIR/init-localstack.sh" --skip-bucket
    else
      info "Bootstrapping LocalStack bucket, configs, and DDB tables..."
      bash "$SCRIPT_DIR/init-localstack.sh"
    fi
  else
    warn "awslocal not found — skipping S3 bucket init"
    warn "Install with: pip install awscli-local"
    warn "Then run: ./scripts/init-localstack.sh"
  fi

  header "Seed data"
  # Seed runs on the host — override GRAPHITI_URL from the Docker-internal default
  # (http://graphiti:8000) to the host-facing port so fetch() can reach it.
  GRAPHITI_URL=http://localhost:8001 npm run seed

  header "Setup complete"
  echo ""
  echo "  Add Quorum to Claude Code (install quorum-mcp first):"
  echo "    npm install -g @as-quorum/mcp"
  echo "    quorum install   # or: npm run setup in quorum-mcp"
  echo ""
  echo "  Verify:"
  echo "    node scripts/audit-cli.js stats"
  echo ""
  echo "  Gateway:    http://localhost:3001/health"
  echo "  LocalStack: http://localhost:4566/_localstack/health"
  echo ""
}

# ── docker rebuild ────────────────────────────────────────────────────────────
# Rebuild the gateway image from scratch,
# then restart the stack. Graphiti is pulled from GHCR. Skips LocalStack — existing data is preserved.
# Use after Dockerfile or source code changes that don't hot-reload.
# The quorum MCP service is opt-in (profile: mcp) and excluded from default builds.

cmd_docker_rebuild() {
  header "Quorum — Rebuild Docker Images"
  check_docker
  cd "$PROJECT_ROOT"

  local APP_VERSION
  APP_VERSION=$(python3 -c "import json; print(json.load(open('$PROJECT_ROOT/package.json'))['version'])" 2>/dev/null || echo "latest")
  export IMAGE_TAG
  IMAGE_TAG=$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo "$APP_VERSION")
  info "Image tag: $IMAGE_TAG  (app version: $APP_VERSION)"
  export GRAPHITI_TAG
  GRAPHITI_TAG=$(resolve_graphiti_tag)
  info "Graphiti image tag: $GRAPHITI_TAG"

  EXTERNAL_LOCALSTACK=""
  check_localstack_conflict

  info "Stopping stack (keeping volumes)..."
  docker compose down --remove-orphans 2>/dev/null || true

  info "Rebuilding gateway image without cache..."
  docker compose build --no-cache --parallel gateway

  if [[ -n "$EXTERNAL_LOCALSTACK" ]]; then
    info "Starting stack (skipping LocalStack — reusing $EXTERNAL_LOCALSTACK)..."
    docker compose up -d --scale localstack=0
    info "Connecting $EXTERNAL_LOCALSTACK to Docker network quorum_default..."
    docker network connect --alias localstack quorum_default "$EXTERNAL_LOCALSTACK" 2>/dev/null \
      && ok "$EXTERNAL_LOCALSTACK connected to quorum_default" \
      || ok "$EXTERNAL_LOCALSTACK already in quorum_default"
  else
    docker compose up -d
  fi

  ok "Rebuild complete"
  docker compose ps
}

# ── docker clean ──────────────────────────────────────────────────────────────
# Stop the stack and remove containers + custom images.
# Data volumes (postgres_data, falkordb_data, localstack_data) are preserved
# so you don't lose graph data or S3 configs.
# Use --volumes / -v to also wipe data volumes (full reset).
#
# NOTE: docker compose down --volumes only removes volumes when run in the
# correct project directory. This command always explicitly removes the named
# volumes (quorum_postgres_data, quorum_falkordb_data, quorum_localstack_data)
# so a volume wipe works reliably regardless of how Docker was invoked.

cmd_docker_clean() {
  local wipe_volumes=false
  # Arguments: setup.sh docker clean [--volumes|-v]
  # $1=docker  $2=clean  $3=flag — check all args for the flag
  for arg in "$@"; do
    [[ "$arg" == "--volumes" || "$arg" == "-v" ]] && wipe_volumes=true
  done

  header "Quorum — Clean Docker Stack"
  check_docker
  cd "$PROJECT_ROOT"

  if $wipe_volumes; then
    warn "Wiping containers, images, AND data volumes (postgres + falkordb + localstack)"
    docker compose down --remove-orphans --volumes 2>/dev/null || true

    # Explicitly remove named volumes by their prefixed names — docker compose
    # down --volumes can silently skip them if the project context doesn't match.
    local project_name
    project_name=$(docker compose config --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('name','quorum'))" 2>/dev/null || echo "quorum")
    for vol in postgres_data falkordb_data localstack_data; do
      local full_name="${project_name}_${vol}"
      if docker volume inspect "$full_name" &>/dev/null 2>&1; then
        docker volume rm "$full_name" 2>/dev/null && ok "  Removed volume: $full_name" || warn "  Could not remove $full_name (may be in use)"
      fi
    done
  else
    info "Stopping containers (data volumes preserved)..."
    docker compose down --remove-orphans 2>/dev/null || true
  fi

  info "Removing custom Quorum images..."
  docker images --filter "label=com.docker.compose.project=quorum" -q \
    | xargs docker rmi -f 2>/dev/null \
    || true
  # Also remove by name in case labels aren't set
  for img in quorum-quorum quorum-gateway; do
    docker rmi -f "$img" 2>/dev/null || true
  done

  ok "Clean complete"
  if $wipe_volumes; then
    ok "Data volumes wiped — next 'setup.sh docker' will start fresh"
  else
    ok "Data volumes preserved — run 'setup.sh docker' to restart"
  fi
}

# ── docker ps ─────────────────────────────────────────────────────────────────
# Show current status of all Quorum containers with health state.

cmd_docker_ps() {
  cd "$PROJECT_ROOT"
  check_docker
  echo ""
  docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
  echo ""
  # LocalStack persistence check for any running LocalStack
  local ls_container
  ls_container=$(docker ps --filter "publish=4566" --format "{{.Names}}" 2>/dev/null | head -1)
  [[ -n "$ls_container" ]] && check_localstack_persistence "$ls_container"
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
  echo -e "  ${BOLD}Docker Compose (local dev)${NC}"
  echo "  ./scripts/setup.sh docker              Start full stack"
  echo "  ./scripts/setup.sh docker rebuild      Rebuild all images --no-cache, then start"
  echo "  ./scripts/setup.sh docker clean        Stop stack + remove images (keep volumes)"
  echo "  ./scripts/setup.sh docker clean -v     Stop stack + remove images AND volumes (full wipe)"
  echo "  ./scripts/setup.sh docker ps           Show container status + LocalStack persistence"
  echo ""
  echo -e "  ${BOLD}Kubernetes${NC}"
  echo "  ./scripts/setup.sh k8s                 Deploy to Docker Desktop Kubernetes"
  echo "  ./scripts/setup.sh k8s teardown        Remove all K8s resources"
  echo "  ./scripts/setup.sh k8s status          Show current K8s deployment state"
  echo "  ./scripts/setup.sh k8s build           Rebuild gateway image only"
  echo ""
  echo -e "  ${BOLD}npm shortcuts${NC}"
  echo "  npm run docker:start                   → setup.sh docker"
  echo "  npm run docker:rebuild                 → setup.sh docker rebuild"
  echo "  npm run docker:clean                   → setup.sh docker clean"
  echo "  npm run docker:ps                      → setup.sh docker ps"
  echo ""
  echo -e "  ${BOLD}LocalStack persistence${NC}"
  echo "  Enable with: PERSISTENCE=1 and a volume at /var/lib/localstack"
  echo "  Without it, S3 project configs are lost on container restart."
  echo "  After any LocalStack restart: ./scripts/init-localstack.sh"
  echo ""
  echo -e "  ${BOLD}Infrastructure (S3 buckets, IAM) — Crossplane only${NC}"
  echo "    kubectl apply -f crossplane/provider/"
  echo "    kubectl apply -f crossplane/bucket/"
  echo "    kubectl apply -f crossplane/objects/"
  echo ""
  echo -e "  ${BOLD}CronJob runners (also available as npm run job:*)${NC}"
  echo "    node scripts/decay-confidence.js [--dry-run]"
  echo "    node scripts/archive-audit.js    [--dry-run]"
  echo "    node scripts/recheck-conflicts.js"
  echo ""
}

# ── dispatch ──────────────────────────────────────────────────────────────────

case "$COMMAND" in
  docker)
    SUBCOMMAND="${2:-start}"
    case "$SUBCOMMAND" in
      start|"")  cmd_docker ;;
      rebuild)   cmd_docker_rebuild ;;
      clean)     cmd_docker_clean "$@" ;;
      ps)        cmd_docker_ps ;;
      *)
        echo -e "${RED}Unknown docker subcommand: $SUBCOMMAND${NC}" >&2
        cmd_help; exit 1 ;;
    esac ;;
  k8s)    shift; cmd_k8s "${@}" ;;
  help|--help|-h) cmd_help ;;
  *)
    echo -e "${RED}Unknown command: $COMMAND${NC}" >&2
    cmd_help
    exit 1
    ;;
esac
