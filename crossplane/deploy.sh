#!/usr/bin/env bash
# Gated production deployment entrypoint. Validation is the default.
set -euo pipefail

# Mirror all output to a timestamped log file (override dir via QUORUM_LOG_DIR).
LOG_DIR="${QUORUM_LOG_DIR:-/var/log/quorum}"
mkdir -p "${LOG_DIR}" 2>/dev/null || { LOG_DIR="${TMPDIR:-/tmp}/quorum-logs"; mkdir -p "${LOG_DIR}"; }
LOG_FILE="${LOG_DIR}/$(basename "${BASH_SOURCE[0]}" .sh)-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "${LOG_FILE}") 2>&1
echo "[quorum] $(date '+%Y-%m-%dT%H:%M:%S%z') start $(basename "${BASH_SOURCE[0]}"); log -> ${LOG_FILE}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMAND="${1:-validate}"

validate() {
  cd "${ROOT}/.."
  bash crossplane/tests/render.sh >"${ROOT}/tests/rendered.yaml"
  crossplane resource validate \
    "${ROOT}/providers/providers.yaml,${ROOT}/apis/environment/definition.yaml" \
    "${ROOT}/tests/rendered.yaml" \
    --error-on-missing-schemas \
    --cache-dir "${ROOT}/../.crossplane-cache"
  npm run test:deploy
}

confirm() {
  local action="$1"
  local answer
  read -r -p "Type yes to ${action} real AWS resources: " answer
  [[ "${answer}" == yes ]] || { echo "aborted"; exit 1; }
}

# Reports aggregate health, published connection outputs, and actionable resource failures.
status() {
  local namespace="quorum-system"
  local environment="quorum-prod"
  local managed_json

  managed_json="$(kubectl get managed -n "${namespace}" -o json)"

  printf '\n=== Composite environment ===\n'
  kubectl get xquorumenvironment "${environment}" -n "${namespace}" -o wide

  printf '\n=== Published outputs ===\n'
  kubectl get xquorumenvironment "${environment}" -n "${namespace}" -o json |
    jq -r '
      [
        ["ELASTIC_IP", (.status.elasticIp // "pending")],
        ["INSTANCE_ID", (.status.instanceId // "pending")],
        ["RDS_ENDPOINT", (.status.rdsEndpoint // "pending")]
      ] |
      .[] | @tsv
    ' |
    column -t

  printf '\n=== Managed resources ===\n'
  jq -r '
    ["READY", "SYNCED", "KIND", "NAME", "EXTERNAL_NAME"],
    (
      .items[] |
      [
        (if any(.status.conditions[]?; .type == "Ready" and .status == "True") then "yes" else "no" end),
        (if any(.status.conditions[]?; .type == "Synced" and .status == "True") then "yes" else "no" end),
        .kind,
        .metadata.name,
        (.metadata.annotations["crossplane.io/external-name"] // "pending")
      ]
    ) |
    @tsv
  ' <<<"${managed_json}" |
    column -t

  printf '\n=== Non-ready details ===\n'
  jq -r '
    .items[] |
    select(any(.status.conditions[]?; .type == "Ready" and .status == "True") | not) |
    [
      .kind,
      .metadata.name,
      (
        [
          .status.conditions[]? |
          select(.status == "False" or .type == "LastAsyncOperation") |
          "\(.reason): \(.message // "waiting for reconciliation")"
        ] |
        unique |
        join(" | ")
      )
    ] |
    @tsv
  ' <<<"${managed_json}" |
    column -t -s $'\t'

  printf '\n=== Recent warnings ===\n'
  kubectl get events -n "${namespace}" \
    --field-selector type=Warning \
    --sort-by=.lastTimestamp |
    tail -20
}

case "${COMMAND}" in
  validate) validate ;;
  apply)
    validate
    confirm "create or update"
    kubectl apply -f "${ROOT}/providers/providers.yaml"
    kubectl apply -f "${ROOT}/providers/functions.yaml"
    # The sub-providers pull in provider-family-aws, which installs the
    # ProviderConfig CRD. Wait for that to settle before applying resources that
    # depend on its CRDs, otherwise apply races ahead of CRD installation.
    echo "waiting for providers and functions to become healthy (first pull can take minutes)..."
    kubectl wait --for=condition=Healthy provider.pkg.crossplane.io --all --timeout=600s
    kubectl wait --for=condition=Healthy function.pkg.crossplane.io --all --timeout=300s
    kubectl wait --for=condition=Established crd/providerconfigs.aws.m.upbound.io --timeout=120s
    kubectl create namespace quorum-system --dry-run=client -o yaml | kubectl apply -f -
    kubectl apply -f "${ROOT}/providers/providerconfig-aws-prod.yaml"
    # Applying the XRD generates the XQuorumEnvironment CRD asynchronously; wait
    # for it to be established before applying the composite resource.
    kubectl apply -f "${ROOT}/apis/environment/definition.yaml"
    echo "waiting for the composite resource definition to be established..."
    kubectl wait --for=condition=Established xrd --all --timeout=120s
    kubectl apply -f "${ROOT}/apis/environment/composition.yaml"
    kubectl apply -f "${ROOT}/environments/prod.yaml"
    ;;
  status)
    status
    ;;
  destroy)
    confirm "delete"
    kubectl delete -f "${ROOT}/environments/prod.yaml"
    ;;
  *) echo "usage: deploy.sh [validate|apply|status|destroy]" >&2; exit 2 ;;
esac
