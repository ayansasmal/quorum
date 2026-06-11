#!/usr/bin/env bash
# Atomically refreshes RDS endpoint and managed master credentials.
set -euo pipefail

# Mirror all output to a timestamped log file (override dir via QUORUM_LOG_DIR).
LOG_DIR="${QUORUM_LOG_DIR:-/var/log/quorum}"
mkdir -p "${LOG_DIR}" 2>/dev/null || { LOG_DIR="${TMPDIR:-/tmp}/quorum-logs"; mkdir -p "${LOG_DIR}"; }
LOG_FILE="${LOG_DIR}/$(basename "${BASH_SOURCE[0]}" .sh)-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "${LOG_FILE}") 2>&1
echo "[quorum] $(date '+%Y-%m-%dT%H:%M:%S%z') start $(basename "${BASH_SOURCE[0]}"); log -> ${LOG_FILE}"

: "${AWS_REGION:?}" "${DB_INSTANCE_ID:?}"
ENV_FILE=/etc/quorum/quorum.env
TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT

DESCRIPTION="$(aws rds describe-db-instances --db-instance-identifier "${DB_INSTANCE_ID}" --region "${AWS_REGION}")"
HOST="$(jq -r '.DBInstances[0].Endpoint.Address' <<<"${DESCRIPTION}")"
PORT="$(jq -r '.DBInstances[0].Endpoint.Port' <<<"${DESCRIPTION}")"
SECRET_ARN="$(jq -r '.DBInstances[0].MasterUserSecret.SecretArn' <<<"${DESCRIPTION}")"
SECRET="$(aws secretsmanager get-secret-value --secret-id "${SECRET_ARN}" --region "${AWS_REGION}" --query SecretString --output text)"
USER="$(jq -r '.username' <<<"${SECRET}")"
PASSWORD="$(jq -r '.password' <<<"${SECRET}")"

grep -v -E '^(POSTGRES_HOST|POSTGRES_PORT|POSTGRES_USER|POSTGRES_PASSWORD)=' "${ENV_FILE}" >"${TMP}" || true
{
  printf 'POSTGRES_HOST=%q\n' "${HOST}"
  printf 'POSTGRES_PORT=%q\n' "${PORT}"
  printf 'POSTGRES_USER=%q\n' "${USER}"
  printf 'POSTGRES_PASSWORD=%q\n' "${PASSWORD}"
} >>"${TMP}"
install -o root -g root -m 0600 "${TMP}" "${ENV_FILE}"
