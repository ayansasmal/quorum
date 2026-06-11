#!/usr/bin/env bash
# Validates the production deployment offline by default.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMAND="${1:-validate}"

validate() {
  cd "${ROOT}/.."
  npm run test:deploy
}

case "${COMMAND}" in
  validate) validate ;;
  *) echo "usage: deploy.sh validate" >&2; exit 2 ;;
esac
