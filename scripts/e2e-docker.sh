#!/usr/bin/env bash
# =============================================================================
# e2e-docker.sh — Orchestrates the fully isolated E2E Docker environment.
#
# All E2E services run on an internal Docker network (no host port bindings).
# The dev stack (docker-compose.yml) is completely unaffected.
#
# Usage:
#   ./scripts/e2e-docker.sh [up|run|down|clean|full]
#
#   up    — Build images + start infrastructure, wait until all healthy
#   run   — Run the test-runner container (exits with Playwright's exit code)
#   down  — Stop and remove all E2E containers
#   clean — Stop containers AND remove volumes (fresh LocalStack / PG state)
#   full  — up → run → down (CI-friendly, returns Playwright exit code)
#
# Requirements:
#   Docker Desktop >= 4.0 (Docker Engine >= 20.10 + Compose v2.1+)
#   --wait flag requires Docker Compose >= 2.1 (released Dec 2021)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE="docker compose -f $PROJECT_ROOT/docker-compose.e2e.yml"

# Start gateway and its entire dependency tree (localstack, postgresql, redis,
# falkordb, graphiti, mock-openai). gateway depends on all of them transitively,
# so starting gateway alone is sufficient to bring everything up.
#
# --wait blocks until gateway's healthcheck passes (which requires all deps healthy).
# --build rebuilds images if Dockerfiles or build contexts have changed.
# We build ALL services first so test-runner picks up any CMD/Dockerfile changes,
# then bring infrastructure up (gateway + deps) and wait for healthy.
_up() {
  echo "▶ [E2E] Building all images (gateway + test-runner)..."
  $COMPOSE build
  echo "▶ [E2E] Starting infrastructure..."
  $COMPOSE up -d --wait gateway
  echo "✓ [E2E] Infrastructure healthy — gateway is ready at http://gateway:3001 (internal)"
}

_run() {
  echo "▶ [E2E] Running tests inside Docker..."
  # --rm: remove the container (and its anonymous volumes) after the run.
  # The test-runner image has node_modules; its anonymous volume provides
  # Alpine-compiled binaries regardless of what's on the host.
  $COMPOSE run --rm test-runner "$@"
}

_down() {
  echo "▶ [E2E] Stopping E2E environment..."
  $COMPOSE down
  echo "✓ [E2E] All containers stopped and removed"
}

_clean() {
  echo "▶ [E2E] Cleaning E2E environment (containers + volumes)..."
  # --rmi local removes images built from the compose file (not official images).
  # Fall back gracefully if the flag is not supported by older Compose versions.
  $COMPOSE down --volumes --rmi local 2>/dev/null \
    || $COMPOSE down --volumes
  echo "✓ [E2E] Containers, volumes, and local images removed"
}

case "${1:-full}" in
  up)
    _up
    ;;

  run)
    shift || true
    _run "$@"
    ;;

  down)
    _down
    ;;

  clean)
    _clean
    ;;

  full)
    # CI-friendly: start everything, run tests, tear down, return test exit code.
    _up

    echo ""
    set +e   # don't exit on test failure — we still need to tear down
    _run
    exit_code=$?
    set -e

    echo ""
    _down

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
Usage: e2e-docker.sh [up|run|down|clean|full]

  up    — Build images + start infrastructure, wait until all healthy
  run   — Run tests against running infrastructure (exits with Playwright code)
  down  — Stop and remove all E2E containers
  clean — Stop containers AND remove all volumes (fresh LocalStack / PG state)
  full  — CI-friendly: up → run → down (default when no arg given)

Extra args after 'run' are passed directly to the test-runner:
  ./scripts/e2e-docker.sh run npx playwright test --grep "S-01"
USAGE
    exit 1
    ;;
esac
