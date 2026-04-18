#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_ROOT/logs"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/crossplane.${TIMESTAMP}.log"
COMMAND="${1:-help}"

mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "── Crossplane S3 (LocalStack) ─────────────────────────────────"
echo "   Command : $COMMAND"
echo "   Log     : $LOG_FILE"
echo "───────────────────────────────────────────────────────────────"
echo ""

# ── Helpers ─────────────────────────────────────────────────────

check_deps() {
  for cmd in kubectl helm awslocal; do
    if ! command -v "$cmd" &>/dev/null; then
      echo "✗ $cmd not found"
      case "$cmd" in
        kubectl)   echo "  Install: https://kubernetes.io/docs/tasks/tools/" ;;
        helm)      echo "  Install: https://helm.sh/docs/intro/install/" ;;
        awslocal)  echo "  Install: pip install awscli-local" ;;
      esac
      exit 1
    fi
  done
  echo "✓ kubectl  $(kubectl version --client -o json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['clientVersion']['gitVersion'])" 2>/dev/null || echo '(version unknown)')"
  echo "✓ helm     $(helm version --short 2>/dev/null | cut -d+ -f1)"
  echo "✓ awslocal found"
}

check_localstack() {
  if ! awslocal s3 ls &>/dev/null; then
    echo "✗ LocalStack not reachable at http://localhost:4566"
    echo "  Start it with: localstack start -d"
    exit 1
  fi
  echo "✓ LocalStack reachable"
  # Virtual-hosted S3 (bucket.host.docker.internal) requires LOCALSTACK_HOST to be set
  # so LocalStack can parse bucket names from non-standard Host headers.
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
  echo "✓ LocalStack LOCALSTACK_HOST=$LS_HOST"
}

wait_crd() {
  local CRD="$1"
  local ATTEMPTS=0
  echo -n "  Waiting for CRD $CRD ..."
  until kubectl get crd "$CRD" &>/dev/null; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ $ATTEMPTS -ge 40 ]; then
      echo " ✗ timed out"
      echo "  Check: kubectl get pods -n crossplane-system"
      exit 1
    fi
    echo -n "."
    sleep 3
  done
  echo " ✓"
}

# Patch CoreDNS to resolve *.host.docker.internal → host.docker.internal so that
# virtual-hosted S3 URLs (bucket.host.docker.internal) resolve from inside k8s pods.
patch_coredns() {
  echo "▶ Patching CoreDNS for virtual-hosted S3 DNS..."
  local CM
  CM=$(kubectl get configmap coredns -n kube-system -o jsonpath='{.data.Corefile}')
  if echo "$CM" | grep -q "rewrite name regex"; then
    echo "✓ CoreDNS already patched"
    return
  fi
  # Use Python to insert the rewrite rule after the first 'ready' line (BSD sed limitation)
  local PATCH_JSON
  PATCH_JSON=$(python3 - <<'PYEOF'
import sys, json, subprocess

result = subprocess.run(
    ["kubectl", "get", "configmap", "coredns", "-n", "kube-system",
     "-o", "jsonpath={.data.Corefile}"],
    capture_output=True, text=True
)
corefile = result.stdout
rewrite = "    rewrite name regex (.+)\\.host\\.docker\\.internal host.docker.internal"
lines = corefile.splitlines()
patched = []
inserted = False
for line in lines:
    patched.append(line)
    if not inserted and line.strip() == "ready":
        patched.append(rewrite)
        inserted = True
new_corefile = "\n".join(patched) + "\n"
patch = {"data": {"Corefile": new_corefile}}
print(json.dumps(patch))
PYEOF
)
  kubectl patch configmap coredns -n kube-system --type merge -p "$PATCH_JSON"
  kubectl rollout restart deployment/coredns -n kube-system
  kubectl rollout status deployment/coredns -n kube-system --timeout=60s
  echo "✓ CoreDNS patched"
}


# ── setup ────────────────────────────────────────────────────────
cmd_setup() {
  check_deps
  check_localstack

  echo ""
  echo "▶ Installing Crossplane (v1.17.2)..."
  helm repo add crossplane-stable https://charts.crossplane.io/stable --force-update 2>/dev/null || true
  helm upgrade --install crossplane crossplane-stable/crossplane \
    --namespace crossplane-system \
    --create-namespace \
    --version 1.17.2 \
    --wait
  echo "✓ Crossplane ready"

  echo ""
  echo "▶ Waiting for Crossplane CRDs..."
  wait_crd "providers.pkg.crossplane.io"
  echo "✓ CRDs established"

  echo ""
  patch_coredns

  echo ""
  echo "▶ Installing AWS S3 provider..."
  # DeploymentRuntimeConfig must exist before provider-family-aws references it
  kubectl apply -f "$SCRIPT_DIR/provider/runtimeconfig-localstack.yaml"
  # ControllerConfig (deprecated, kept for provider-aws-s3 reference compat)
  kubectl apply -f "$SCRIPT_DIR/provider/controllerconfig-localstack.yaml"
  # Install S3 provider — this auto-installs provider-family-aws as a dependency
  kubectl apply -f "$SCRIPT_DIR/provider/provider-aws-s3.yaml"
  echo -n "  Waiting for provider-aws-s3 to become Healthy ..."
  kubectl wait provider/provider-aws-s3 \
    --for=condition=Healthy \
    --timeout=180s 2>/dev/null && echo " ✓" || { echo " ✗"; exit 1; }
  # Apply RuntimeConfig to family provider (the pod that actually makes S3 calls).
  # runtimeConfigRef tells Crossplane to include AWS_ENDPOINT_URL in the managed deployment.
  kubectl apply -f "$SCRIPT_DIR/provider/provider-family-aws.yaml"
  echo -n "  Waiting for provider-family-aws to become Healthy ..."
  kubectl wait provider/upbound-provider-family-aws \
    --for=condition=Healthy \
    --timeout=120s 2>/dev/null && echo " ✓" || { echo " ✗"; exit 1; }
  # Note: no deployment patch needed — DeploymentRuntimeConfig handles env vars,
  # and ProviderConfig endpoint.services:[s3,sts] routes S3 calls to LocalStack.

  # provider.Healthy=True means Crossplane accepted the provider, but the provider
  # pod's conversion webhook may not be ready yet. Wait for the pod itself.
  echo -n "  Waiting for provider-aws-s3 pod to be Ready ..."
  kubectl wait pods \
    -n crossplane-system \
    -l pkg.crossplane.io/revision \
    --for=condition=Ready \
    --timeout=120s 2>/dev/null && echo " ✓" || { echo " ✗"; exit 1; }

  echo ""
  echo "▶ Applying LocalStack credentials..."
  kubectl create secret generic aws-creds \
    --namespace crossplane-system \
    --from-literal=credentials=$'[default]\naws_access_key_id=test\naws_secret_access_key=test' \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl apply -f "$SCRIPT_DIR/provider/providerconfig-aws.yaml"
  echo "✓ ProviderConfig applied"

  echo ""
  echo "▶ Provisioning S3 bucket..."
  kubectl apply -f "$SCRIPT_DIR/bucket/"
  echo -n "  Waiting for bucket to be Ready ..."
  kubectl wait bucket/quorum-configs \
    --for=condition=Ready \
    --timeout=120s 2>/dev/null && echo " ✓" || { echo " ✗"; exit 1; }

  echo ""
  echo "▶ Uploading sample configs..."
  kubectl apply -f "$SCRIPT_DIR/objects/platform-team-config.yaml"
  kubectl apply -f "$SCRIPT_DIR/objects/backend-team-config.yaml"
  kubectl wait object/platform-team-config --for=condition=Ready --timeout=60s
  kubectl wait object/backend-team-config  --for=condition=Ready --timeout=60s
  echo "✓ Objects synced"

  cmd_status
}

# ── start ────────────────────────────────────────────────────────
# Re-applies all manifests and reconciles — idempotent.
cmd_start() {
  check_deps
  check_localstack

  echo ""
  echo "▶ Re-applying provider config..."
  kubectl apply -f "$SCRIPT_DIR/provider/providerconfig-aws.yaml"

  echo ""
  echo "▶ Re-applying bucket manifests..."
  kubectl apply -f "$SCRIPT_DIR/bucket/"

  echo ""
  echo "▶ Re-applying objects..."
  kubectl apply -f "$SCRIPT_DIR/objects/platform-team-config.yaml"
  kubectl apply -f "$SCRIPT_DIR/objects/backend-team-config.yaml"

  echo "✓ All resources re-applied"
  cmd_status
}

# ── status ───────────────────────────────────────────────────────
cmd_status() {
  echo ""
  echo "── Status ──────────────────────────────────────────────────"

  echo ""
  echo "Crossplane pods:"
  kubectl get pods -n crossplane-system --no-headers 2>/dev/null \
    | awk '{printf "  %-50s %s/%s\n", $1, $2, $2}' \
    || echo "  (none)"

  echo ""
  echo "Provider:"
  kubectl get provider --no-headers 2>/dev/null \
    | awk '{printf "  %-40s HEALTHY=%-5s AGE=%s\n", $1, $2, $5}' \
    || echo "  (none)"

  echo ""
  echo "Bucket:"
  kubectl get bucket --no-headers 2>/dev/null \
    | awk '{printf "  %-40s READY=%-5s SYNCED=%-5s\n", $1, $2, $3}' \
    || echo "  (none)"

  echo ""
  echo "Objects:"
  kubectl get object --no-headers 2>/dev/null \
    | awk '{printf "  %-40s READY=%-5s SYNCED=%-5s\n", $1, $2, $3}' \
    || echo "  (none)"

  echo ""
  echo "LocalStack bucket contents:"
  BUCKET=$(kubectl get bucket quorum-configs \
    -o jsonpath='{.metadata.annotations.crossplane\.io/external-name}' 2>/dev/null \
    || echo "quorum-configs")
  awslocal s3 ls "s3://$BUCKET/" --recursive 2>/dev/null \
    | awk '{printf "  %s  %s  %s\n", $1, $2, $4}' \
    || echo "  (bucket not found or empty)"

  echo ""
}

# ── cleanup ──────────────────────────────────────────────────────
cmd_cleanup() {
  check_deps

  echo ""
  echo "▶ Deleting S3 objects..."
  kubectl delete object platform-team-config backend-team-config --ignore-not-found

  echo ""
  echo "▶ Deleting bucket resources..."
  kubectl delete -f "$SCRIPT_DIR/bucket/" --ignore-not-found

  echo ""
  echo "▶ Deleting ProviderConfig and credentials..."
  kubectl delete -f "$SCRIPT_DIR/provider/providerconfig-aws.yaml" --ignore-not-found
  kubectl delete secret aws-creds -n crossplane-system --ignore-not-found

  echo ""
  echo "▶ Deleting provider..."
  kubectl delete -f "$SCRIPT_DIR/provider/provider-aws-s3.yaml" --ignore-not-found

  echo ""
  read -r -p "Uninstall Crossplane itself? [y/N] " REPLY
  if [[ "$(echo "$REPLY" | tr '[:upper:]' '[:lower:]')" == "y" ]]; then
    helm uninstall crossplane -n crossplane-system 2>/dev/null || true
    kubectl delete namespace crossplane-system --ignore-not-found
    echo "✓ Crossplane uninstalled"
  else
    echo "  Skipped — Crossplane namespace preserved"
  fi

  echo ""
  echo "✓ Cleanup complete"
}

# ── help ─────────────────────────────────────────────────────────
cmd_help() {
  echo "Usage: ./crossplane/crossplane.sh <command>"
  echo ""
  echo "Commands:"
  echo "  setup    Full install: Crossplane + provider + bucket + sample configs"
  echo "  start    Re-apply all manifests (idempotent reconcile)"
  echo "  status   Show provider, bucket, object, and LocalStack state"
  echo "  cleanup  Delete all resources (optionally uninstall Crossplane)"
  echo "  help     Show this message"
  echo ""
  echo "Logs: $LOG_DIR/crossplane.<timestamp>.log"
}

# ── Dispatch ─────────────────────────────────────────────────────
case "$COMMAND" in
  setup)   cmd_setup   ;;
  start)   cmd_start   ;;
  status)  cmd_status  ;;
  cleanup) cmd_cleanup ;;
  help|*)  cmd_help    ;;
esac
