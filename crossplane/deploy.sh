#!/usr/bin/env bash
# Gated production deployment entrypoint. Validation is the default.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMAND="${1:-validate}"

validate() {
  cd "${ROOT}/.."
  bash crossplane/tests/render.sh >"${ROOT}/tests/rendered.yaml"
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
