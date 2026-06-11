#!/usr/bin/env bash
# Starts RDS, then EC2, then waits for the HTTPS gateway.
set -euo pipefail

# Mirror all output to a timestamped log file (override dir via QUORUM_LOG_DIR).
LOG_DIR="${QUORUM_LOG_DIR:-/var/log/quorum}"
mkdir -p "${LOG_DIR}" 2>/dev/null || { LOG_DIR="${TMPDIR:-/tmp}/quorum-logs"; mkdir -p "${LOG_DIR}"; }
LOG_FILE="${LOG_DIR}/$(basename "${BASH_SOURCE[0]}" .sh)-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "${LOG_FILE}") 2>&1
echo "[quorum] $(date '+%Y-%m-%dT%H:%M:%S%z') start $(basename "${BASH_SOURCE[0]}"); log -> ${LOG_FILE}"

: "${AWS_REGION:=ap-southeast-2}"
DB_INSTANCE_ID="${DB_INSTANCE_ID:?set DB_INSTANCE_ID}"
EC2_INSTANCE_ID="${EC2_INSTANCE_ID:?set EC2_INSTANCE_ID}"
GATEWAY_URL="${GATEWAY_URL:=https://quorum-gateway.ayansasmal.work}"

aws rds start-db-instance --db-instance-identifier "${DB_INSTANCE_ID}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
aws rds wait db-instance-available --db-instance-identifier "${DB_INSTANCE_ID}" --region "${AWS_REGION}"
aws ec2 start-instances --instance-ids "${EC2_INSTANCE_ID}" --region "${AWS_REGION}" >/dev/null
aws ec2 wait instance-running --instance-ids "${EC2_INSTANCE_ID}" --region "${AWS_REGION}"

for _ in $(seq 1 60); do
  STATUS="$(curl -s -o /dev/null -w '%{http_code}' "${GATEWAY_URL}/health" || true)"
  if [[ "${STATUS}" == 200 || "${STATUS}" == 503 ]]; then
    echo "gateway available (${STATUS})"
    exit 0
  fi
  sleep 10
done
echo "gateway did not become available" >&2
exit 1
