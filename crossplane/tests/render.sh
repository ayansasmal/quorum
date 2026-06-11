#!/usr/bin/env bash
# Renders the canonical production XR through the pinned composition function.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crossplane composition render \
  "${ROOT}/environments/prod.yaml" \
  "${ROOT}/apis/environment/composition.yaml" \
  "${ROOT}/providers/functions.yaml" \
  --include-full-xr
