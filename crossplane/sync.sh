#!/usr/bin/env bash
##
## sync.sh — re-apply all Crossplane manifests against LocalStack
##
## Run this after editing any manifest to reconcile changes.
## Assumes `crossplane.sh setup` has already been run once.
##
## Usage:
##   ./crossplane/sync.sh
##
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "▶ provider config"
kubectl apply -f "$DIR/provider/providerconfig-aws.yaml"

echo "▶ S3 bucket"
kubectl apply -f "$DIR/bucket/"

echo "▶ S3 objects"
kubectl apply -f "$DIR/objects/platform-team-config.yaml"
kubectl apply -f "$DIR/objects/backend-team-config.yaml"

echo "▶ DynamoDB"
kubectl apply -f "$DIR/dynamodb/"

echo "▶ RDS"
kubectl apply -f "$DIR/rds/subnet-group.yaml"
kubectl apply -f "$DIR/rds/parameter-group.yaml"
kubectl apply -f "$DIR/rds/instance.yaml"

echo "▶ Redis"
kubectl apply -f "$DIR/redis/subnet-group.yaml"
kubectl apply -f "$DIR/redis/parameter-group.yaml"
kubectl apply -f "$DIR/redis/replication-group.yaml"

echo "✓ done"
