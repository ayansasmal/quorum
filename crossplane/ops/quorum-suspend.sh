#!/usr/bin/env bash
# Takes a final snapshot over SSM, then stops EC2 and RDS.
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

aws ssm send-command --region "${AWS_REGION}" \
  --instance-ids "${EC2_INSTANCE_ID}" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["/opt/quorum/snapshot-save.sh"]' \
  --query Command.CommandId --output text || echo "snapshot command skipped"
aws ec2 stop-instances --instance-ids "${EC2_INSTANCE_ID}" --region "${AWS_REGION}" >/dev/null || true
aws rds stop-db-instance --db-instance-identifier "${DB_INSTANCE_ID}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
