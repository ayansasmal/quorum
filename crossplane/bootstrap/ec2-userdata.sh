#!/usr/bin/env bash
# EC2 bootstrap: install runtime dependencies, download the bundle, and start.
set -euo pipefail

# Mirror all output to a timestamped log file (override dir via QUORUM_LOG_DIR).
LOG_DIR="${QUORUM_LOG_DIR:-/var/log/quorum}"
mkdir -p "${LOG_DIR}" 2>/dev/null || { LOG_DIR="${TMPDIR:-/tmp}/quorum-logs"; mkdir -p "${LOG_DIR}"; }
LOG_FILE="${LOG_DIR}/$(basename "${BASH_SOURCE[0]}" .sh)-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "${LOG_FILE}") 2>&1
echo "[quorum] $(date '+%Y-%m-%dT%H:%M:%S%z') start $(basename "${BASH_SOURCE[0]}"); log -> ${LOG_FILE}"

: "${AWS_REGION:=ap-southeast-2}" "${DEPLOY_BUCKET:?}" "${BOOTSTRAP_VERSION:?}"
: "${COMPOSE_VERSION:=v5.1.4}"

dnf install -y docker jq postgresql16
systemctl enable --now docker

if ! docker compose version >/dev/null 2>&1; then
  install -d -m 0755 /usr/local/lib/docker/cli-plugins
  COMPOSE_ASSET="docker-compose-linux-aarch64"
  COMPOSE_URL="https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}"
  curl -fsSLo "/tmp/${COMPOSE_ASSET}" "${COMPOSE_URL}/${COMPOSE_ASSET}"
  curl -fsSLo "/tmp/${COMPOSE_ASSET}.sha256" "${COMPOSE_URL}/${COMPOSE_ASSET}.sha256"
  (
    cd /tmp
    sha256sum -c "${COMPOSE_ASSET}.sha256"
  )
  install -m 0755 "/tmp/${COMPOSE_ASSET}" /usr/local/lib/docker/cli-plugins/docker-compose
fi

install -d -m 0755 /opt/quorum
aws s3 cp "s3://${DEPLOY_BUCKET}/bootstrap/${BOOTSTRAP_VERSION}/" /opt/quorum/ \
  --recursive --region "${AWS_REGION}"
chmod +x /opt/quorum/*.sh
exec /opt/quorum/start.sh
