#!/usr/bin/env bash
# scripts/k8s-setup.sh — single command to build and deploy the full Quorum stack
# on Docker Desktop Kubernetes (gateway + FalkorDB + PostgreSQL + Graphiti + S3 via Crossplane).
#
# Usage:
#   ./scripts/k8s-setup.sh setup      # build + deploy everything
#   ./scripts/k8s-setup.sh teardown   # remove everything
#   ./scripts/k8s-setup.sh status     # show current state
#   ./scripts/k8s-setup.sh build      # build gateway image only
#   ./scripts/k8s-setup.sh help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMAND="${1:-help}"

LOG_DIR="$PROJECT_ROOT/logs"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/k8s-setup.${TIMESTAMP}.log"
mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "── Quorum K8s Setup ───────────────────────────────────────────"
echo "   Command : $COMMAND"
echo "   Log     : $LOG_FILE"
echo "───────────────────────────────────────────────────────────────"
echo ""

# ── Config ──────────────────────────────────────────────────────
NAMESPACE="quorum"
HELM_RELEASE="quorum"
HELM_CHART="$PROJECT_ROOT/helm/quorum"
CROSSPLANE_SCRIPT="$PROJECT_ROOT/crossplane/crossplane.sh"
GATEWAY_IMAGE_NAME="quorum-gateway"
GRAPHITI_IMAGE_NAME="graphiti-mcp"
GRAPHITI_IMAGE="graphiti-mcp:local"

# ── Load .env ───────────────────────────────────────────────────
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/.env"
  set +a
  echo "✓ Loaded .env"
else
  echo "⚠  No .env file found — copy .env.example to .env and add OPENAI_API_KEY"
fi

GIT_SHA="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo 'dev')"
GATEWAY_IMAGE="${GATEWAY_IMAGE_NAME}:${GIT_SHA}"

# ── Helpers ─────────────────────────────────────────────────────

check_deps() {
  echo "▶ Checking dependencies..."
  for cmd in kubectl helm docker awslocal; do
    if ! command -v "$cmd" &>/dev/null; then
      echo "✗ $cmd not found"
      case "$cmd" in
        kubectl)   echo "  Comes with Docker Desktop — enable Kubernetes in settings" ;;
        helm)      echo "  Install: brew install helm" ;;
        docker)    echo "  Install Docker Desktop: https://www.docker.com/products/docker-desktop/" ;;
        awslocal)  echo "  Install: pip install awscli-local" ;;
      esac
      exit 1
    fi
  done
  echo "✓ kubectl  $(kubectl version --client -o json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['clientVersion']['gitVersion'])" 2>/dev/null || echo '(version unknown)')"
  echo "✓ helm     $(helm version --short 2>/dev/null | cut -d+ -f1)"
  echo "✓ docker   $(docker --version | cut -d' ' -f3 | tr -d ',')"
  echo "✓ awslocal found"
}

check_k8s() {
  echo ""
  echo "▶ Checking Kubernetes cluster..."
  if ! kubectl cluster-info &>/dev/null; then
    echo "✗ Kubernetes cluster not reachable."
    echo "  Docker Desktop → Settings → Kubernetes → Enable Kubernetes → Apply & Restart"
    exit 1
  fi
  local NODE
  NODE=$(kubectl get nodes --no-headers 2>/dev/null | awk '{print $2}' | head -1)
  if [ "$NODE" != "Ready" ]; then
    echo "✗ Node not Ready (status: $NODE). Wait for Docker Desktop K8s to finish starting."
    exit 1
  fi
  echo "✓ Kubernetes cluster ready"
}

check_localstack() {
  echo ""
  echo "▶ Checking LocalStack..."
  if ! awslocal s3 ls &>/dev/null; then
    echo "✗ LocalStack not reachable at http://localhost:4566"
    echo "  Start with: LOCALSTACK_HOST=host.docker.internal localstack start -d"
    exit 1
  fi
  local LS_HOST
  LS_HOST=$(docker inspect localstack-main --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep "^LOCALSTACK_HOST=" | cut -d= -f2)
  if [ -z "$LS_HOST" ]; then
    echo "✗ LocalStack is missing LOCALSTACK_HOST env var."
    echo "  Stop and restart with:"
    echo "    localstack stop"
    echo "    LOCALSTACK_HOST=host.docker.internal localstack start -d"
    exit 1
  fi
  echo "✓ LocalStack reachable (LOCALSTACK_HOST=$LS_HOST)"
}

check_openai_key() {
  if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "✗ OPENAI_API_KEY is not set."
    echo "  Add it to .env: OPENAI_API_KEY=sk-..."
    echo "  Graphiti requires it for entity extraction."
    exit 1
  fi
  echo "✓ OPENAI_API_KEY set (${#OPENAI_API_KEY} chars)"
}

# Build gateway and graphiti Docker images.
# Docker Desktop K8s shares the local Docker daemon — no registry push needed.
cmd_build() {
  echo ""
  echo "▶ Building gateway image: $GATEWAY_IMAGE"
  docker build \
    -f "$PROJECT_ROOT/Dockerfile.gateway" \
    -t "$GATEWAY_IMAGE" \
    -t "${GATEWAY_IMAGE_NAME}:latest" \
    "$PROJECT_ROOT"
  echo "✓ Built $GATEWAY_IMAGE"

  echo ""
  echo "▶ Building graphiti image: $GRAPHITI_IMAGE"
  docker build \
    -f "$PROJECT_ROOT/Dockerfile.graphiti" \
    -t "$GRAPHITI_IMAGE" \
    "$PROJECT_ROOT"
  echo "✓ Built $GRAPHITI_IMAGE"
}

# ── setup ────────────────────────────────────────────────────────
cmd_setup() {
  check_deps
  check_k8s
  check_localstack
  check_openai_key

  # ── 1. Build gateway + graphiti images ────────────────────────
  cmd_build

  # ── 2. Create namespace ────────────────────────────────────────
  echo ""
  echo "▶ Creating namespace '$NAMESPACE'..."
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
  echo "✓ Namespace ready"

  # ── 3. Deploy Helm chart ───────────────────────────────────────
  echo ""
  echo "▶ Deploying Quorum Helm chart (release: $HELM_RELEASE)..."
  echo "  Image: $GATEWAY_IMAGE"

  local POSTGRES_PASS="${POSTGRES_PASSWORD:-quorum_local}"

  helm upgrade --install "$HELM_RELEASE" "$HELM_CHART" \
    --namespace "$NAMESPACE" \
    --values "$HELM_CHART/values-local.yaml" \
    --set "gateway.image.tag=${GIT_SHA}" \
    --set "gateway.image.pullPolicy=IfNotPresent" \
    --set "graphiti.openaiSecret.apiKey=${OPENAI_API_KEY}" \
    --set "postgresql.password=${POSTGRES_PASS}" \
    --wait \
    --timeout 300s
  echo "✓ Helm chart deployed"

  # ── 4. Wait for all components ─────────────────────────────────
  echo ""
  echo "▶ Waiting for components to be ready..."
  kubectl wait pods \
    -n "$NAMESPACE" \
    --all \
    --for=condition=Ready \
    --timeout=300s
  echo "✓ All pods ready"

  # ── 5. Provision S3 bucket via Crossplane ─────────────────────
  echo ""
  echo "▶ Provisioning S3 bucket via Crossplane..."
  bash "$CROSSPLANE_SCRIPT" setup

  # ── 6. Final status ────────────────────────────────────────────
  cmd_status
}

# ── teardown ─────────────────────────────────────────────────────
cmd_teardown() {
  echo ""
  echo "▶ Removing Crossplane S3 resources..."
  bash "$CROSSPLANE_SCRIPT" cleanup

  echo ""
  echo "▶ Uninstalling Helm release '$HELM_RELEASE'..."
  if helm status "$HELM_RELEASE" -n "$NAMESPACE" &>/dev/null; then
    helm uninstall "$HELM_RELEASE" --namespace "$NAMESPACE"
    echo "✓ Helm release removed"
  else
    echo "  (release not found — skipped)"
  fi

  echo ""
  read -r -p "Delete namespace '$NAMESPACE' and all its resources? [y/N] " REPLY
  if [[ "$(echo "$REPLY" | tr '[:upper:]' '[:lower:]')" == "y" ]]; then
    kubectl delete namespace "$NAMESPACE" --ignore-not-found
    echo "✓ Namespace deleted"
  else
    echo "  Skipped — namespace preserved"
  fi

  echo ""
  echo "✓ Teardown complete"
}

# ── status ───────────────────────────────────────────────────────
cmd_status() {
  echo ""
  echo "── Status ──────────────────────────────────────────────────"

  echo ""
  echo "Images:"
  echo "  $GATEWAY_IMAGE (git SHA: $GIT_SHA)"
  echo "  $GRAPHITI_IMAGE"

  echo ""
  echo "Quorum pods ($NAMESPACE):"
  kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null \
    | awk '{printf "  %-45s %s\n", $1, $3}' \
    || echo "  (namespace not found or no pods)"

  echo ""
  echo "Quorum services:"
  kubectl get svc -n "$NAMESPACE" --no-headers 2>/dev/null \
    | awk '{printf "  %-35s %-12s %s\n", $1, $2, $5}' \
    || echo "  (none)"

  echo ""
  echo "Gateway health:"
  local GW_POD
  GW_POD=$(kubectl get pods -n "$NAMESPACE" -l "app.kubernetes.io/component=gateway" \
    --no-headers 2>/dev/null | awk 'NR==1{print $1}')
  if [ -n "$GW_POD" ]; then
    kubectl exec -n "$NAMESPACE" "$GW_POD" -- \
      curl -sf http://localhost:3001/health 2>/dev/null \
      | python3 -m json.tool 2>/dev/null \
      || echo "  (not yet healthy)"
  else
    echo "  (no gateway pod running)"
  fi

  echo ""
  bash "$CROSSPLANE_SCRIPT" status
}

# ── help ─────────────────────────────────────────────────────────
cmd_help() {
  echo "Usage: ./scripts/k8s-setup.sh <command>"
  echo ""
  echo "Commands:"
  echo "  setup     Build gateway + deploy full stack (Helm + Crossplane S3)"
  echo "  teardown  Remove everything (Helm release + Crossplane + namespace)"
  echo "  status    Show pod states, services, gateway health, and S3 contents"
  echo "  build     Build gateway (git SHA tagged) + graphiti (local) images"
  echo "  help      Show this message"
  echo ""
  echo "Requires:"
  echo "  - Docker Desktop with Kubernetes enabled"
  echo "  - LocalStack running: LOCALSTACK_HOST=host.docker.internal localstack start -d"
  echo "  - .env file with OPENAI_API_KEY set"
  echo ""
  echo "Logs: $LOG_DIR/k8s-setup.<timestamp>.log"
}

# ── Dispatch ─────────────────────────────────────────────────────
case "$COMMAND" in
  setup)    cmd_setup    ;;
  teardown) cmd_teardown ;;
  status)   cmd_status   ;;
  build)    cmd_build    ;;
  help|*)   cmd_help     ;;
esac
