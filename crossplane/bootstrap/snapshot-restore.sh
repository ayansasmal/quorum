#!/usr/bin/env bash
# Restores the latest derived-state snapshot before the stack starts.
set -euo pipefail

: "${SNAPSHOT_BUCKET:?}" "${AWS_REGION:?}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
PREFIX="s3://${SNAPSHOT_BUCKET}/snapshots/latest"

if ! aws s3 ls "${PREFIX}/dump.rdb" --region "${AWS_REGION}" >/dev/null 2>&1; then
  echo "no snapshot found; starting clean"
  exit 0
fi

aws s3 cp "${PREFIX}/dump.rdb" "${WORK}/dump.rdb" --region "${AWS_REGION}"
aws s3 cp "${PREFIX}/caddy-data.tgz" "${WORK}/caddy-data.tgz" --region "${AWS_REGION}"
docker volume create quorum_falkordb_data >/dev/null
docker volume create quorum_caddy_data >/dev/null
docker run --rm -v quorum_falkordb_data:/data -v "${WORK}:/in:ro" alpine \
  sh -c 'cp /in/dump.rdb /data/dump.rdb'
docker run --rm -v quorum_caddy_data:/data -v "${WORK}:/in:ro" alpine \
  sh -c 'tar -C /data --strip-components=1 -xzf /in/caddy-data.tgz'
