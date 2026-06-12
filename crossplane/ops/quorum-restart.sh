#!/usr/bin/env bash
# Restarts the production backend stack on the EC2 instance over SSM (no SSH).
#
# Modes (first positional arg, default: restart):
#   restart   docker compose restart            — bounce all containers, no re-pull (fast)
#   recreate  docker compose up -d --force-recreate — recreate containers (picks up env/compose changes)
#   full      /opt/quorum/start.sh              — full idempotent re-converge (re-pull, DB init, timers)
set -euo pipefail

# Mirror all output to a timestamped log file (override dir via QUORUM_LOG_DIR).
LOG_DIR="${QUORUM_LOG_DIR:-/var/log/quorum}"
mkdir -p "${LOG_DIR}" 2>/dev/null || { LOG_DIR="${TMPDIR:-/tmp}/quorum-logs"; mkdir -p "${LOG_DIR}"; }
LOG_FILE="${LOG_DIR}/$(basename "${BASH_SOURCE[0]}" .sh)-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "${LOG_FILE}") 2>&1
echo "[quorum] $(date '+%Y-%m-%dT%H:%M:%S%z') start $(basename "${BASH_SOURCE[0]}"); log -> ${LOG_FILE}"

: "${AWS_REGION:=ap-southeast-2}"
: "${INSTANCE_NAME:=quorum-prod}"
COMPOSE="/opt/quorum/docker-compose.aws.yml"
ENV_FILE="/etc/quorum/quorum.env"
MODE="${1:-restart}"

# A bare SSM AWS-RunShellScript shell has none of the boot-time environment, so
# any mode that re-reads the compose file or runs start.sh must supply it:
#   - recreate sources the secret-backed env so ${IMAGE_REGISTRY}/${GATEWAY_TAG}/
#     ${AWS_REGION}/${LOG_GROUP} compose interpolation resolves (blank otherwise).
#   - full exports AWS_REGION because start.sh fails fast on `: "${AWS_REGION:?}"`
#     before it can fetch the secret that holds everything else.
# restart only bounces existing containers, so it needs neither.
case "${MODE}" in
  restart)  REMOTE_CMD="docker compose -f ${COMPOSE} restart" ;;
  recreate) REMOTE_CMD="set -a; . ${ENV_FILE}; set +a; docker compose -f ${COMPOSE} up -d --force-recreate" ;;
  full)     REMOTE_CMD="AWS_REGION=${AWS_REGION} /opt/quorum/start.sh" ;;
  *) echo "unknown mode: ${MODE} (use: restart | recreate | full)" >&2; exit 2 ;;
esac

# Resolve the instance id from the Name tag unless one was provided.
EC2_INSTANCE_ID="${EC2_INSTANCE_ID:-$(aws ec2 describe-instances --region "${AWS_REGION}" \
  --filters "Name=tag:Name,Values=${INSTANCE_NAME}" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text)}"
if [[ -z "${EC2_INSTANCE_ID}" || "${EC2_INSTANCE_ID}" == "None" ]]; then
  echo "no running instance tagged Name=${INSTANCE_NAME} in ${AWS_REGION}" >&2
  exit 1
fi
echo "[quorum] mode=${MODE} instance=${EC2_INSTANCE_ID} -> ${REMOTE_CMD}"

CMD_ID="$(aws ssm send-command --region "${AWS_REGION}" \
  --instance-ids "${EC2_INSTANCE_ID}" \
  --document-name AWS-RunShellScript \
  --comment "quorum stack ${MODE}" \
  --parameters "commands=[\"${REMOTE_CMD}\",\"docker compose -f ${COMPOSE} ps\"]" \
  --query Command.CommandId --output text)"
echo "[quorum] SSM command id: ${CMD_ID}"

# AWS_MAX_ATTEMPTS keeps the waiter from timing out on a slow 'full' re-converge.
AWS_MAX_ATTEMPTS=60 aws ssm wait command-executed \
  --region "${AWS_REGION}" --command-id "${CMD_ID}" --instance-id "${EC2_INSTANCE_ID}" \
  || echo "[quorum] waiter returned non-zero; inspect invocation below"

aws ssm get-command-invocation --region "${AWS_REGION}" \
  --command-id "${CMD_ID}" --instance-id "${EC2_INSTANCE_ID}" \
  --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}' --output text
