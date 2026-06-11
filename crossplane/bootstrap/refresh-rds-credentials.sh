#!/usr/bin/env bash
# Atomically refreshes RDS endpoint and managed master credentials.
set -euo pipefail

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
printf 'POSTGRES_HOST=%s\nPOSTGRES_PORT=%s\nPOSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\n' \
  "${HOST}" "${PORT}" "${USER}" "${PASSWORD}" >>"${TMP}"
install -o root -g root -m 0600 "${TMP}" "${ENV_FILE}"
