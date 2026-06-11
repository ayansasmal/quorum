#!/usr/bin/env bash
# Saves FalkorDB and Caddy derived state to the versioned snapshot bucket.
set -euo pipefail

: "${SNAPSHOT_BUCKET:?}" "${AWS_REGION:?}"
COMPOSE=(docker compose -f /opt/quorum/docker-compose.aws.yml)
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

"${COMPOSE[@]}" exec -T falkordb redis-cli BGSAVE
sleep 5
"${COMPOSE[@]}" cp falkordb:/data/dump.rdb "${WORK}/dump.rdb"
"${COMPOSE[@]}" cp caddy:/data "${WORK}/caddy-data"
tar -C "${WORK}" -czf "${WORK}/caddy-data.tgz" caddy-data

for file in dump.rdb caddy-data.tgz; do
  aws s3 cp "${WORK}/${file}" "s3://${SNAPSHOT_BUCKET}/snapshots/${STAMP}/${file}" --region "${AWS_REGION}"
  aws s3 cp "${WORK}/${file}" "s3://${SNAPSHOT_BUCKET}/snapshots/latest/${file}" --region "${AWS_REGION}"
done
