#!/usr/bin/env bash
# Minimal EC2 bootstrap: download the immutable bundle and start the stack.
set -euo pipefail

: "${AWS_REGION:=ap-southeast-2}" "${DEPLOY_BUCKET:?}" "${BOOTSTRAP_VERSION:?}"
install -d -m 0755 /opt/quorum
aws s3 cp "s3://${DEPLOY_BUCKET}/bootstrap/${BOOTSTRAP_VERSION}/" /opt/quorum/ \
  --recursive --region "${AWS_REGION}"
chmod +x /opt/quorum/*.sh
exec /opt/quorum/start.sh
