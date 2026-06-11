#!/usr/bin/env bash
# EC2 bootstrap: install runtime dependencies, download the bundle, and start.
set -euo pipefail

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
