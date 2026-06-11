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

case "${COMMAND}" in
  validate) validate ;;
  apply)
    validate
    confirm "create or update"
    kubectl apply -f "${ROOT}/providers/providers.yaml"
    kubectl apply -f "${ROOT}/providers/functions.yaml"
    kubectl apply -f "${ROOT}/providers/providerconfig-aws-prod.yaml"
    kubectl apply -f "${ROOT}/apis/environment/definition.yaml"
    kubectl apply -f "${ROOT}/apis/environment/composition.yaml"
    kubectl create namespace quorum-system --dry-run=client -o yaml | kubectl apply -f -
    kubectl apply -f "${ROOT}/environments/prod.yaml"
    ;;
  status)
    kubectl get xquorumenvironment -n quorum-system -o wide
    ;;
  destroy)
    confirm "delete"
    kubectl delete -f "${ROOT}/environments/prod.yaml"
    ;;
  *) echo "usage: deploy.sh [validate|apply|status|destroy]" >&2; exit 2 ;;
esac
