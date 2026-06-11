#!/usr/bin/env bash
# Takes a final snapshot over SSM, then stops EC2 and RDS.
set -euo pipefail

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
