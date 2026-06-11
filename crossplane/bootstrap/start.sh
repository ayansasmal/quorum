#!/usr/bin/env bash
# Idempotently prepares and starts the production backend stack.
set -euo pipefail

: "${AWS_REGION:?}" "${APP_SECRET_ID:=quorum/prod/gateway}" "${DB_INSTANCE_ID:=quorum-prod}"
install -d -o root -g root -m 0700 /etc/quorum
install -d -o root -g root -m 0755 /opt/quorum

SECRET="$(aws secretsmanager get-secret-value --secret-id "${APP_SECRET_ID}" --region "${AWS_REGION}" --query SecretString --output text)"
jq -r 'to_entries[] | "\(.key)=\(.value)"' <<<"${SECRET}" > /etc/quorum/quorum.env.tmp
install -o root -g root -m 0600 /etc/quorum/quorum.env.tmp /etc/quorum/quorum.env
rm -f /etc/quorum/quorum.env.tmp

export DB_INSTANCE_ID
/opt/quorum/refresh-rds-credentials.sh
set -a
# shellcheck disable=SC1091
source /etc/quorum/quorum.env
set +a
/opt/quorum/snapshot-restore.sh
docker compose -f /opt/quorum/docker-compose.aws.yml pull
docker compose -f /opt/quorum/docker-compose.aws.yml up -d
systemctl daemon-reload
systemctl enable --now quorum-credential-refresh.timer quorum-snapshot.timer \
  quorum-decay.timer quorum-archive.timer quorum-recheck.timer
