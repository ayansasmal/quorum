#!/usr/bin/env bash
# Idempotently prepares and starts the production backend stack.
set -euo pipefail

# Mirror all output to a timestamped log file (override dir via QUORUM_LOG_DIR).
LOG_DIR="${QUORUM_LOG_DIR:-/var/log/quorum}"
mkdir -p "${LOG_DIR}" 2>/dev/null || { LOG_DIR="${TMPDIR:-/tmp}/quorum-logs"; mkdir -p "${LOG_DIR}"; }
LOG_FILE="${LOG_DIR}/$(basename "${BASH_SOURCE[0]}" .sh)-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "${LOG_FILE}") 2>&1
echo "[quorum] $(date '+%Y-%m-%dT%H:%M:%S%z') start $(basename "${BASH_SOURCE[0]}"); log -> ${LOG_FILE}"

: "${AWS_REGION:?}" "${APP_SECRET_ID:=quorum/prod/gateway}"
install -d -o root -g root -m 0700 /etc/quorum
install -d -o root -g root -m 0755 /opt/quorum

SECRET="$(aws secretsmanager get-secret-value --secret-id "${APP_SECRET_ID}" --region "${AWS_REGION}" --query SecretString --output text)"
jq -r 'to_entries[] | "\(.key)=\(.value | @sh)"' <<<"${SECRET}" > /etc/quorum/quorum.env.tmp
install -o root -g root -m 0600 /etc/quorum/quorum.env.tmp /etc/quorum/quorum.env
rm -f /etc/quorum/quorum.env.tmp

set -a
# shellcheck disable=SC1091
source /etc/quorum/quorum.env
set +a
: "${DB_INSTANCE_ID:=quorum-prod}"
export DB_INSTANCE_ID
/opt/quorum/refresh-rds-credentials.sh
set -a
# shellcheck disable=SC1091
source /etc/quorum/quorum.env
set +a

: "${POSTGRES_DB:=quorum_audit}"
if [[ ! "${POSTGRES_DB}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
  echo "Invalid POSTGRES_DB identifier: ${POSTGRES_DB}" >&2
  exit 1
fi
DATABASE_EXISTS="$(
  PGPASSWORD="${POSTGRES_PASSWORD}" PGSSLMODE=require psql \
    --host "${POSTGRES_HOST}" \
    --port "${POSTGRES_PORT}" \
    --username "${POSTGRES_USER}" \
    --dbname postgres \
    --tuples-only \
    --no-align \
    --set ON_ERROR_STOP=1 \
    --command "SELECT 1 FROM pg_database WHERE datname = '${POSTGRES_DB}'"
)"
if [[ "${DATABASE_EXISTS}" != "1" ]]; then
  PGPASSWORD="${POSTGRES_PASSWORD}" PGSSLMODE=require createdb \
    --host "${POSTGRES_HOST}" \
    --port "${POSTGRES_PORT}" \
    --username "${POSTGRES_USER}" \
    --maintenance-db postgres \
    "${POSTGRES_DB}"
fi
PGPASSWORD="${POSTGRES_PASSWORD}" psql \
  "host=${POSTGRES_HOST} port=${POSTGRES_PORT} dbname=${POSTGRES_DB} user=${POSTGRES_USER} sslmode=require" \
  --set ON_ERROR_STOP=1 \
  --file /opt/quorum/init-db.sql

/opt/quorum/snapshot-restore.sh
if [[ -n "${GHCR_USERNAME:-}" && -n "${GHCR_TOKEN:-}" ]]; then
  printf '%s' "${GHCR_TOKEN}" | docker login ghcr.io --username "${GHCR_USERNAME}" --password-stdin
fi
docker compose -f /opt/quorum/docker-compose.aws.yml pull
docker compose -f /opt/quorum/docker-compose.aws.yml up -d
systemctl daemon-reload
systemctl enable --now quorum-credential-refresh.timer quorum-snapshot.timer \
  quorum-decay.timer quorum-archive.timer quorum-recheck.timer
