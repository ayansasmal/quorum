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

echo "── Crossplane (LocalStack) ─────────────────────────────────────"
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

wait_provider() {
  local NAME="$1"
  local TIMEOUT="${2:-180s}"
  echo -n "  Waiting for $NAME to become Healthy ..."
  kubectl wait "provider/$NAME" \
    --for=condition=Healthy \
    --timeout="$TIMEOUT" 2>/dev/null && echo " ✓" || { echo " ✗"; exit 1; }
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

ensure_namespace() {
  local NS="$1"
  kubectl get namespace "$NS" &>/dev/null \
    || kubectl create namespace "$NS"
  echo "✓ Namespace $NS exists"
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

  # ── Providers ────────────────────────────────────────────────
  echo ""
  echo "▶ Installing AWS providers (S3 · DynamoDB · RDS · ElastiCache)..."
  # DeploymentRuntimeConfig must exist before provider-family-aws references it
  kubectl apply -f "$SCRIPT_DIR/provider/runtimeconfig-localstack.yaml"
  # ControllerConfig (deprecated, kept for provider-aws-s3 reference compat)
  kubectl apply -f "$SCRIPT_DIR/provider/controllerconfig-localstack.yaml"

  # S3 provider (auto-installs provider-family-aws as a dependency)
  kubectl apply -f "$SCRIPT_DIR/provider/provider-aws-s3.yaml"
  # DynamoDB, RDS, ElastiCache providers
  kubectl apply -f "$SCRIPT_DIR/provider/provider-aws-dynamodb.yaml"
  kubectl apply -f "$SCRIPT_DIR/provider/provider-aws-rds.yaml"
  kubectl apply -f "$SCRIPT_DIR/provider/provider-aws-elasticache.yaml"

  # Apply RuntimeConfig to the family provider (the pod that makes all AWS calls)
  kubectl apply -f "$SCRIPT_DIR/provider/provider-family-aws.yaml"

  wait_provider "provider-aws-s3"
  wait_provider "upbound-provider-family-aws" "120s"
  wait_provider "provider-aws-dynamodb"
  wait_provider "provider-aws-rds"
  wait_provider "provider-aws-elasticache"

  # Wait for provider pods to be Ready (webhook conversion may lag behind Healthy)
  echo -n "  Waiting for provider pods to be Ready ..."
  kubectl wait pods \
    -n crossplane-system \
    -l pkg.crossplane.io/revision \
    --for=condition=Ready \
    --timeout=120s 2>/dev/null && echo " ✓" || { echo " ✗"; exit 1; }

  # ── Credentials & ProviderConfig ─────────────────────────────
  echo ""
  echo "▶ Applying LocalStack credentials..."
  kubectl create secret generic aws-creds \
    --namespace crossplane-system \
    --from-literal=credentials=$'[default]\naws_access_key_id=test\naws_secret_access_key=test' \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl apply -f "$SCRIPT_DIR/provider/providerconfig-aws.yaml"
  echo "✓ ProviderConfig applied"

  # ── Application namespaces ───────────────────────────────────
  echo ""
  echo "▶ Ensuring application namespaces..."
  ensure_namespace quorum

  # ── RDS password secret ──────────────────────────────────────
  echo ""
  echo "▶ Creating RDS password secret (quorum-db-creds)..."
  # LocalStack: any non-empty password is accepted.
  # PRODUCTION: replace with a strong secret from AWS Secrets Manager or ESO.
  kubectl create secret generic quorum-db-creds \
    --namespace crossplane-system \
    --from-literal=password=quorum-local-dev-password \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "✓ quorum-db-creds created"

  # ── S3 bucket ────────────────────────────────────────────────
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

  # ── DynamoDB tables ──────────────────────────────────────────
  echo ""
  echo "▶ Provisioning DynamoDB tables..."
  kubectl apply -f "$SCRIPT_DIR/dynamodb/table-quorum-configs.yaml"
  kubectl apply -f "$SCRIPT_DIR/dynamodb/table-quorum-user-projects.yaml"
  echo -n "  Waiting for quorum-configs table ..."
  kubectl wait table.dynamodb.aws.upbound.io/quorum-configs \
    --for=condition=Ready --timeout=120s 2>/dev/null && echo " ✓" || { echo " ✗"; exit 1; }
  echo -n "  Waiting for quorum-user-projects table ..."
  kubectl wait table.dynamodb.aws.upbound.io/quorum-user-projects \
    --for=condition=Ready --timeout=120s 2>/dev/null && echo " ✓" || { echo " ✗"; exit 1; }

  # ── RDS PostgreSQL ───────────────────────────────────────────
  echo ""
  echo "▶ Provisioning RDS PostgreSQL..."
  # Dependency order: subnet-group and parameter-group before instance
  kubectl apply -f "$SCRIPT_DIR/rds/subnet-group.yaml"
  kubectl apply -f "$SCRIPT_DIR/rds/parameter-group.yaml"
  echo -n "  Waiting for DB subnet group ..."
  kubectl wait subnetgroup.rds.aws.upbound.io/quorum-db-subnet-group \
    --for=condition=Ready --timeout=60s 2>/dev/null && echo " ✓" || echo " (LocalStack: may stay Synced=False — continuing)"
  echo -n "  Waiting for DB parameter group ..."
  kubectl wait parametergroup.rds.aws.upbound.io/quorum-pg16 \
    --for=condition=Ready --timeout=60s 2>/dev/null && echo " ✓" || echo " (LocalStack: may stay Synced=False — continuing)"
  kubectl apply -f "$SCRIPT_DIR/rds/instance.yaml"
  echo -n "  Waiting for RDS instance (this takes ~90s in LocalStack) ..."
  kubectl wait instance.rds.aws.upbound.io/quorum-postgres \
    --for=condition=Ready --timeout=180s 2>/dev/null && echo " ✓" || echo " (LocalStack: may report Synced=False — check events)"

  # ── Redis (ElastiCache) ──────────────────────────────────────
  echo ""
  echo "▶ Provisioning Redis (ElastiCache)..."
  kubectl apply -f "$SCRIPT_DIR/redis/subnet-group.yaml"
  kubectl apply -f "$SCRIPT_DIR/redis/parameter-group.yaml"
  echo -n "  Waiting for Redis subnet group ..."
  kubectl wait subnetgroup.elasticache.aws.upbound.io/quorum-redis-subnet-group \
    --for=condition=Ready --timeout=60s 2>/dev/null && echo " ✓" || echo " (LocalStack: may stay Synced=False — continuing)"
  echo -n "  Waiting for Redis parameter group ..."
  kubectl wait parametergroup.elasticache.aws.upbound.io/quorum-redis7 \
    --for=condition=Ready --timeout=60s 2>/dev/null && echo " ✓" || echo " (LocalStack: may stay Synced=False — continuing)"
  kubectl apply -f "$SCRIPT_DIR/redis/replication-group.yaml"
  echo -n "  Waiting for Redis replication group ..."
  kubectl wait replicationgroup.elasticache.aws.upbound.io/quorum-redis \
    --for=condition=Ready --timeout=180s 2>/dev/null && echo " ✓" || echo " (LocalStack: may report Synced=False — check events)"

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

  echo ""
  echo "▶ Re-applying DynamoDB tables..."
  kubectl apply -f "$SCRIPT_DIR/dynamodb/"

  echo ""
  echo "▶ Re-applying RDS resources..."
  kubectl apply -f "$SCRIPT_DIR/rds/subnet-group.yaml"
  kubectl apply -f "$SCRIPT_DIR/rds/parameter-group.yaml"
  kubectl apply -f "$SCRIPT_DIR/rds/instance.yaml"

  echo ""
  echo "▶ Re-applying Redis resources..."
  kubectl apply -f "$SCRIPT_DIR/redis/subnet-group.yaml"
  kubectl apply -f "$SCRIPT_DIR/redis/parameter-group.yaml"
  kubectl apply -f "$SCRIPT_DIR/redis/replication-group.yaml"

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
    | awk '{printf "  %-50s %s\n", $1, $3}' \
    || echo "  (none)"

  echo ""
  echo "Providers:"
  kubectl get provider --no-headers 2>/dev/null \
    | awk '{printf "  %-50s HEALTHY=%-5s AGE=%s\n", $1, $2, $5}' \
    || echo "  (none)"

  echo ""
  echo "S3 Bucket:"
  kubectl get bucket --no-headers 2>/dev/null \
    | awk '{printf "  %-40s READY=%-5s SYNCED=%-5s\n", $1, $2, $3}' \
    || echo "  (none)"

  echo ""
  echo "S3 Objects:"
  kubectl get object --no-headers 2>/dev/null \
    | awk '{printf "  %-40s READY=%-5s SYNCED=%-5s\n", $1, $2, $3}' \
    || echo "  (none)"

  echo ""
  echo "DynamoDB Tables:"
  kubectl get table.dynamodb.aws.upbound.io --no-headers 2>/dev/null \
    | awk '{printf "  %-40s READY=%-5s SYNCED=%-5s\n", $1, $2, $3}' \
    || echo "  (none)"

  echo ""
  echo "RDS:"
  kubectl get subnetgroup.rds.aws.upbound.io,parametergroup.rds.aws.upbound.io,instance.rds.aws.upbound.io \
    --no-headers 2>/dev/null \
    | awk '{printf "  %-60s READY=%-5s SYNCED=%-5s\n", $1, $2, $3}' \
    || echo "  (none)"

  echo ""
  echo "Redis (ElastiCache):"
  kubectl get subnetgroup.elasticache.aws.upbound.io,parametergroup.elasticache.aws.upbound.io,replicationgroup.elasticache.aws.upbound.io \
    --no-headers 2>/dev/null \
    | awk '{printf "  %-60s READY=%-5s SYNCED=%-5s\n", $1, $2, $3}' \
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
  echo "LocalStack DynamoDB tables:"
  awslocal dynamodb list-tables 2>/dev/null \
    | python3 -c "import sys,json; [print('  ' + t) for t in json.load(sys.stdin).get('TableNames',[])]" \
    || echo "  (LocalStack DynamoDB not available)"

  echo ""
  echo "LocalStack RDS instances:"
  awslocal rds describe-db-instances 2>/dev/null \
    | python3 -c "import sys,json; [print('  ' + i['DBInstanceIdentifier'] + '  ' + i.get('DBInstanceStatus','')) for i in json.load(sys.stdin).get('DBInstances',[])]" \
    || echo "  (LocalStack RDS not available)"

  echo ""
  echo "LocalStack ElastiCache replication groups:"
  awslocal elasticache describe-replication-groups 2>/dev/null \
    | python3 -c "import sys,json; [print('  ' + r['ReplicationGroupId'] + '  ' + r.get('Status','')) for r in json.load(sys.stdin).get('ReplicationGroups',[])]" \
    || echo "  (LocalStack ElastiCache not available)"

  echo ""
}

# ── cleanup ──────────────────────────────────────────────────────
cmd_cleanup() {
  check_deps

  echo ""
  echo "▶ Deleting Redis resources..."
  kubectl delete replicationgroup.elasticache.aws.upbound.io/quorum-redis --ignore-not-found
  kubectl delete parametergroup.elasticache.aws.upbound.io/quorum-redis7 --ignore-not-found
  kubectl delete subnetgroup.elasticache.aws.upbound.io/quorum-redis-subnet-group --ignore-not-found

  echo ""
  echo "▶ Deleting RDS resources..."
  kubectl delete instance.rds.aws.upbound.io/quorum-postgres --ignore-not-found
  kubectl delete parametergroup.rds.aws.upbound.io/quorum-pg16 --ignore-not-found
  kubectl delete subnetgroup.rds.aws.upbound.io/quorum-db-subnet-group --ignore-not-found
  kubectl delete secret quorum-db-creds -n crossplane-system --ignore-not-found

  echo ""
  echo "▶ Deleting DynamoDB tables..."
  kubectl delete table.dynamodb.aws.upbound.io/quorum-configs --ignore-not-found
  kubectl delete table.dynamodb.aws.upbound.io/quorum-user-projects --ignore-not-found

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
  echo "▶ Deleting providers..."
  kubectl delete -f "$SCRIPT_DIR/provider/provider-aws-elasticache.yaml" --ignore-not-found
  kubectl delete -f "$SCRIPT_DIR/provider/provider-aws-rds.yaml" --ignore-not-found
  kubectl delete -f "$SCRIPT_DIR/provider/provider-aws-dynamodb.yaml" --ignore-not-found
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
  echo "  setup    Full install: Crossplane + providers + all resources + sample configs"
  echo "  start    Re-apply all manifests (idempotent reconcile)"
  echo "  status   Show provider, bucket, table, RDS, Redis, and LocalStack state"
  echo "  cleanup  Delete all resources (optionally uninstall Crossplane)"
  echo "  help     Show this message"
  echo ""
  echo "Providers managed:"
  echo "  provider-aws-s3          S3 bucket + objects"
  echo "  provider-aws-dynamodb    DynamoDB tables"
  echo "  provider-aws-rds         RDS PostgreSQL instance"
  echo "  provider-aws-elasticache Redis replication group"
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
