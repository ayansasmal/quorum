#!/usr/bin/env bash
# =============================================================================
# run.sh — Unified Quorum E2E Docker lifecycle
#
# Usage:
#   sh e2e/scripts/run.sh [up|run|down|clean|full|logs]
#
# This runner owns the Docker-backed API + UI Playwright suite under quorum/e2e/.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
QUORUM_ROOT="$(cd "$E2E_ROOT/.." && pwd)"
COMPOSE="docker compose -f $E2E_ROOT/docker-compose.yml"

resolve_graphiti_tag() {
  local fork_dir="$QUORUM_ROOT/../graphiti/quorum-graphiti"

  if [[ -n "${GRAPHITI_TAG:-}" ]]; then
    echo "$GRAPHITI_TAG"
  elif [[ -d "$fork_dir/.git" ]]; then
    echo "sha-$(git -C "$fork_dir" rev-parse HEAD)"
  else
    echo "sha-d99abda38b1181d1f56198f1565510de9564f79b"
  fi
}

resolve_gateway_tag() {
  local gateway_repo="$QUORUM_ROOT"

  if [[ -n "${GATEWAY_TAG:-}" ]]; then
    echo "$GATEWAY_TAG"
  elif [[ -d "$gateway_repo/.git" ]]; then
    echo "sha-$(git -C "$gateway_repo" rev-parse --short HEAD)"
  else
    echo "latest"
  fi
}

resolve_dashboard_tag() {
  local dashboard_repo="$QUORUM_ROOT/../quorum-dash"

  if [[ -n "${DASHBOARD_TAG:-}" ]]; then
    echo "$DASHBOARD_TAG"
  elif [[ -d "$dashboard_repo/.git" ]]; then
    echo "sha-$(git -C "$dashboard_repo" rev-parse --short HEAD)"
  else
    echo "latest"
  fi
}

export_tags() {
  export GRAPHITI_TAG GATEWAY_TAG DASHBOARD_TAG
  GRAPHITI_TAG="$(resolve_graphiti_tag)"
  GATEWAY_TAG="$(resolve_gateway_tag)"
  DASHBOARD_TAG="$(resolve_dashboard_tag)"
  echo "▶ [E2E] Graphiti image tag: $GRAPHITI_TAG"
  echo "▶ [E2E] Gateway image tag: $GATEWAY_TAG"
  echo "▶ [E2E] Dashboard image tag: $DASHBOARD_TAG"
}

up() {
  export_tags
  echo "▶ [E2E] Building local test-runner images..."
  $COMPOSE build test-runner mcp-test-runner
  echo "▶ [E2E] Starting unified stack..."
  $COMPOSE up -d --wait gateway dashboard
  echo "✓ [E2E] Stack healthy — gateway at http://localhost:${QUORUM_E2E_GATEWAY_PORT:-3001}, dashboard at http://localhost:${QUORUM_E2E_DASHBOARD_PORT:-3002}"
}

run() {
  export_tags
  echo "▶ [E2E] Running unified Playwright suite inside Docker..."
  $COMPOSE run --rm test-runner "$@"
}

down() {
  export_tags
  echo "▶ [E2E] Stopping unified stack..."
  $COMPOSE down
  echo "✓ [E2E] All containers stopped and removed"
}

clean() {
  export_tags
  echo "▶ [E2E] Cleaning unified stack (containers + volumes)..."
  $COMPOSE down --volumes --rmi local 2>/dev/null || $COMPOSE down --volumes
  echo "✓ [E2E] Containers, volumes, and local images removed"
}

logs() {
  export_tags
  $COMPOSE logs -f test-runner
}

case "${1:-full}" in
  up)
    up
    ;;
  run)
    shift || true
    run "$@"
    ;;
  down)
    down
    ;;
  clean)
    clean
    ;;
  logs)
    logs
    ;;
  full)
    up
    echo ""
    set +e
    run
    exit_code=$?
    set -e
    echo ""
    down
    echo ""
    if [[ $exit_code -eq 0 ]]; then
      echo "✓ [E2E] Tests passed (exit 0)"
    else
      echo "✗ [E2E] Tests failed (exit $exit_code)"
    fi
    exit $exit_code
    ;;
  *)
    cat <<'USAGE'
Usage: sh e2e/scripts/run.sh [up|run|down|clean|full|logs]

  up    — Start the unified E2E stack and wait for gateway + dashboard health
  run   — Run the shared Playwright suite against the running stack
  down  — Stop and remove the unified E2E containers
  clean — Stop the stack and remove volumes/local images
  full  — up → run → down (default)
  logs  — Follow test-runner logs

Extra args after 'run' are forwarded to the test-runner:
  sh e2e/scripts/run.sh run npx playwright test --config e2e/playwright.config.js --project=ui --grep "S-14"
USAGE
    exit 1
    ;;
esac
