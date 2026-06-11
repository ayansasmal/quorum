#!/usr/bin/env bash
# Saves FalkorDB and Caddy derived state to the versioned snapshot bucket.
set -euo pipefail

# Mirror all output to a timestamped log file (override dir via QUORUM_LOG_DIR).
LOG_DIR="${QUORUM_LOG_DIR:-/var/log/quorum}"
mkdir -p "${LOG_DIR}" 2>/dev/null || { LOG_DIR="${TMPDIR:-/tmp}/quorum-logs"; mkdir -p "${LOG_DIR}"; }
LOG_FILE="${LOG_DIR}/$(basename "${BASH_SOURCE[0]}" .sh)-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "${LOG_FILE}") 2>&1
echo "[quorum] $(date '+%Y-%m-%dT%H:%M:%S%z') start $(basename "${BASH_SOURCE[0]}"); log -> ${LOG_FILE}"

: "${SNAPSHOT_BUCKET:?}" "${AWS_REGION:?}"
COMPOSE=(docker compose -f /opt/quorum/docker-compose.aws.yml)
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

"${COMPOSE[@]}" exec -T falkordb redis-cli BGSAVE
sleep 5
"${COMPOSE[@]}" cp falkordb:/data/dump.rdb "${WORK}/dump.rdb"
"${COMPOSE[@]}" cp caddy:/data "${WORK}/caddy-data"
tar -C "${WORK}" -czf "${WORK}/caddy-data.tgz" caddy-data

for file in dump.rdb caddy-data.tgz; do
  aws s3 cp "${WORK}/${file}" "s3://${SNAPSHOT_BUCKET}/snapshots/${STAMP}/${file}" --region "${AWS_REGION}"
  aws s3 cp "${WORK}/${file}" "s3://${SNAPSHOT_BUCKET}/snapshots/latest/${file}" --region "${AWS_REGION}"
done
