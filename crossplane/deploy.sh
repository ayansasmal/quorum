#!/usr/bin/env bash
# Gated production deployment entrypoint. Validation is the default.
set -euo pipefail

# Mirror all output to a timestamped log file (override dir via QUORUM_LOG_DIR).
LOG_DIR="${QUORUM_LOG_DIR:-/var/log/quorum}"
mkdir -p "${LOG_DIR}" 2>/dev/null || { LOG_DIR="${TMPDIR:-/tmp}/quorum-logs"; mkdir -p "${LOG_DIR}"; }
LOG_FILE="${LOG_DIR}/$(basename "${BASH_SOURCE[0]}" .sh)-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "${LOG_FILE}") 2>&1
echo "[quorum] $(date '+%Y-%m-%dT%H:%M:%S%z') start $(basename "${BASH_SOURCE[0]}"); log -> ${LOG_FILE}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMAND="${1:-validate}"
NAMESPACE="quorum-system"
ENVIRONMENT="quorum-prod"
AWS_REGION="ap-southeast-2"
DEPLOY_BUCKET="quorum-prod-deploy"
BOOTSTRAP_VERSION="current"
FINAL_SNAPSHOT_ID="quorum-prod-final"

validate() {
  cd "${ROOT}/.."
  bash crossplane/tests/render.sh >"${ROOT}/tests/rendered.yaml"
  crossplane resource validate \
    "${ROOT}/providers/providers.yaml,${ROOT}/apis/environment/definition.yaml" \
    "${ROOT}/tests/rendered.yaml" \
    --error-on-missing-schemas \
    --cache-dir "${ROOT}/../.crossplane-cache"
  npm run test:deploy
}

confirm() {
  local action="$1"
  local answer
  read -r -p "Type yes to ${action} real AWS resources: " answer
  [[ "${answer}" == yes ]] || { echo "aborted"; exit 1; }
}

# Waits for the composite and returns a published status field.
get_environment_status() {
  local field="$1"
  kubectl get xquorumenvironment "${ENVIRONMENT}" -n "${NAMESPACE}" \
    -o "jsonpath={.status.${field}}"
}

# Uploads the reviewed runtime bundle after the deploy bucket is ready.
upload_bootstrap() {
  echo "uploading bootstrap/${BOOTSTRAP_VERSION} to s3://${DEPLOY_BUCKET}..."
  aws s3 cp "${ROOT}/bootstrap/" \
    "s3://${DEPLOY_BUCKET}/bootstrap/${BOOTSTRAP_VERSION}/" \
    --recursive \
    --region "${AWS_REGION}" \
    --exclude '*.example'
}

# Waits until the instance is registered as an online SSM managed node.
wait_for_ssm() {
  local instance_id="$1"
  local attempt

  echo "waiting for ${instance_id} to register with SSM..."
  for attempt in {1..60}; do
    if [[ "$(aws ssm describe-instance-information \
      --region "${AWS_REGION}" \
      --filters "Key=InstanceIds,Values=${instance_id}" \
      --query 'InstanceInformationList[0].PingStatus' \
      --output text 2>/dev/null)" == "Online" ]]; then
      return
    fi
    sleep 10
  done

  echo "instance ${instance_id} did not become SSM Online within 10 minutes" >&2
  exit 1
}

# Runs commands through SSM, prints their output, and fails on a non-success status.
run_ssm_commands() {
  local instance_id="$1"
  local comment="$2"
  shift 2
  local parameters command_id invocation_status attempt

  parameters="$(printf '%s\n' "$@" | jq -Rsc 'split("\n")[:-1] | {commands: .}')"
  command_id="$(
    aws ssm send-command \
      --region "${AWS_REGION}" \
      --instance-ids "${instance_id}" \
      --document-name AWS-RunShellScript \
      --comment "${comment}" \
      --parameters "${parameters}" \
      --query 'Command.CommandId' \
      --output text
  )"

  invocation_status="Pending"
  for attempt in {1..120}; do
    invocation_status="$(
      aws ssm get-command-invocation \
        --region "${AWS_REGION}" \
        --command-id "${command_id}" \
        --instance-id "${instance_id}" \
        --query Status \
        --output text 2>/dev/null || echo Pending
    )"
    case "${invocation_status}" in
      Pending|InProgress|Delayed) sleep 5 ;;
      *) break ;;
    esac
  done

  if [[ "${invocation_status}" =~ ^(Pending|InProgress|Delayed)$ ]]; then
    echo "SSM command ${command_id} did not finish within 10 minutes" >&2
    exit 1
  fi

  aws ssm get-command-invocation \
    --region "${AWS_REGION}" \
    --command-id "${command_id}" \
    --instance-id "${instance_id}" \
    --query '{Status:Status,StandardOutput:StandardOutputContent,StandardError:StandardErrorContent}' \
    --output json

  if [[ "${invocation_status}" != "Success" ]]; then
    echo "SSM command ${command_id} finished with ${invocation_status}" >&2
    exit 1
  fi
}

# Re-downloads and executes the exact bundle uploaded by this deployment.
bootstrap_application() {
  local instance_id
  instance_id="$(get_environment_status instanceId)"
  [[ -n "${instance_id}" ]] || { echo "XR did not publish an EC2 instance ID" >&2; exit 1; }

  wait_for_ssm "${instance_id}"
  run_ssm_commands "${instance_id}" "Quorum production bootstrap" \
    "set -euo pipefail" \
    "export AWS_REGION=${AWS_REGION}" \
    "export DEPLOY_BUCKET=${DEPLOY_BUCKET}" \
    "export BOOTSTRAP_VERSION=${BOOTSTRAP_VERSION}" \
    "install -d -m 0755 /opt/quorum" \
    "aws s3 cp s3://${DEPLOY_BUCKET}/bootstrap/${BOOTSTRAP_VERSION}/ec2-userdata.sh /opt/quorum/ec2-userdata.sh --region ${AWS_REGION}" \
    "chmod +x /opt/quorum/ec2-userdata.sh" \
    "/opt/quorum/ec2-userdata.sh"

  echo "checking gateway health on the instance..."
  run_ssm_commands "${instance_id}" "Quorum production health check" \
    "set -euo pipefail" \
    "for attempt in \$(seq 1 30); do docker exec quorum-gateway-1 node -e 'fetch(\"http://127.0.0.1:3001/health\").then(response => process.exit(response.status === 200 ? 0 : 1)).catch(() => process.exit(1))' && exit 0; sleep 10; done" \
    "docker compose -f /opt/quorum/docker-compose.aws.yml ps" \
    "exit 1"
}

# Empties every version so Crossplane can delete the versioned deploy bucket.
delete_deploy_bucket_versions() {
  local objects delete_payload

  if ! aws s3api head-bucket --bucket "${DEPLOY_BUCKET}" --region "${AWS_REGION}" 2>/dev/null; then
    return
  fi

  echo "removing versioned objects from s3://${DEPLOY_BUCKET}..."
  while true; do
    objects="$(
      aws s3api list-object-versions \
        --bucket "${DEPLOY_BUCKET}" \
        --region "${AWS_REGION}" \
        --output json |
        jq '[.Versions[]?, .DeleteMarkers[]?] | map({Key, VersionId})'
    )"
    [[ "$(jq 'length' <<<"${objects}")" -gt 0 ]] || break
    delete_payload="$(jq -cn --argjson objects "${objects}" '{Objects: $objects, Quiet: true}')"
    aws s3api delete-objects \
      --bucket "${DEPLOY_BUCKET}" \
      --region "${AWS_REGION}" \
      --delete "${delete_payload}" >/dev/null
  done
}

# Replaces the prior rolling final snapshot so RDS deletion can create a new one.
delete_previous_final_snapshot() {
  if ! aws rds describe-db-snapshots \
    --region "${AWS_REGION}" \
    --db-snapshot-identifier "${FINAL_SNAPSHOT_ID}" >/dev/null 2>&1; then
    return
  fi

  echo "deleting previous rolling RDS snapshot ${FINAL_SNAPSHOT_ID}..."
  aws rds delete-db-snapshot \
    --region "${AWS_REGION}" \
    --db-snapshot-identifier "${FINAL_SNAPSHOT_ID}" >/dev/null
  aws rds wait db-snapshot-deleted \
    --region "${AWS_REGION}" \
    --db-snapshot-identifier "${FINAL_SNAPSHOT_ID}"
}

# Waits for Kubernetes finalizers and AWS deletions to finish, not merely start.
wait_for_managed_deletion() {
  local attempt managed_json remaining

  kubectl wait --for=delete \
    "xquorumenvironment/${ENVIRONMENT}" \
    -n "${NAMESPACE}" \
    --timeout=120s 2>/dev/null || true

  echo "waiting for Crossplane to delete all managed AWS resources..."
  for attempt in {1..240}; do
    managed_json="$(kubectl get managed -n "${NAMESPACE}" -o json)"
    remaining="$(jq '.items | length' <<<"${managed_json}")"
    if [[ "${remaining}" -eq 0 ]]; then
      echo "all managed AWS resources have been deleted"
      return
    fi

    if (( attempt % 6 == 1 )); then
      echo "${remaining} remaining managed resources:"
      jq -r '.items[] | "\(.kind)/\(.metadata.name)"' <<<"${managed_json}"
    fi
    sleep 10
  done

  echo "timed out waiting 40 minutes for managed resource deletion" >&2
  status
  exit 1
}

# Reports aggregate health, published connection outputs, and actionable resource failures.
status() {
  local managed_json

  managed_json="$(kubectl get managed -n "${NAMESPACE}" -o json)"

  printf '\n=== Composite environment ===\n'
  if ! kubectl get xquorumenvironment "${ENVIRONMENT}" -n "${NAMESPACE}" -o wide; then
    echo "No active ${ENVIRONMENT} composite. Managed resources may still be deleting."
  fi

  printf '\n=== Published outputs ===\n'
  if kubectl get xquorumenvironment "${ENVIRONMENT}" -n "${NAMESPACE}" -o json 2>/dev/null |
    jq -r '
        [
          ["ELASTIC_IP", (.status.elasticIp // "pending")],
          ["INSTANCE_ID", (.status.instanceId // "pending")],
          ["RDS_ENDPOINT", (.status.rdsEndpoint // "pending")]
        ] |
        .[] | @tsv
      ' |
    column -t; then
    :
  else
    echo "No outputs: the composite does not exist."
  fi

  printf '\n=== Managed resources ===\n'
  jq -r '
    ["READY", "SYNCED", "KIND", "NAME", "EXTERNAL_NAME"],
    (
      .items[] |
      [
        (if any(.status.conditions[]?; .type == "Ready" and .status == "True") then "yes" else "no" end),
        (if any(.status.conditions[]?; .type == "Synced" and .status == "True") then "yes" else "no" end),
        .kind,
        .metadata.name,
        (.metadata.annotations["crossplane.io/external-name"] // "pending")
      ]
    ) |
    @tsv
  ' <<<"${managed_json}" |
    column -t

  printf '\n=== Non-ready details ===\n'
  jq -r '
    .items[] |
    select(any(.status.conditions[]?; .type == "Ready" and .status == "True") | not) |
    [
      .kind,
      .metadata.name,
      (
        [
          .status.conditions[]? |
          select(.status == "False" or .type == "LastAsyncOperation") |
          "\(.reason): \(.message // "waiting for reconciliation")"
        ] |
        unique |
        join(" | ")
      )
    ] |
    @tsv
  ' <<<"${managed_json}" |
    column -t -s $'\t'

  printf '\n=== Recent warnings ===\n'
  kubectl get events -n "${NAMESPACE}" \
    --field-selector type=Warning \
    --sort-by=.lastTimestamp |
    tail -20
}

case "${COMMAND}" in
  validate) validate ;;
  apply)
    validate
    confirm "create or update"
    kubectl apply -f "${ROOT}/providers/providers.yaml"
    kubectl apply -f "${ROOT}/providers/functions.yaml"
    # The sub-providers pull in provider-family-aws, which installs the
    # ProviderConfig CRD. Wait for that to settle before applying resources that
    # depend on its CRDs, otherwise apply races ahead of CRD installation.
    echo "waiting for providers and functions to become healthy (first pull can take minutes)..."
    kubectl wait --for=condition=Healthy provider.pkg.crossplane.io --all --timeout=600s
    kubectl wait --for=condition=Healthy function.pkg.crossplane.io --all --timeout=300s
    kubectl wait --for=condition=Established crd/providerconfigs.aws.m.upbound.io --timeout=120s
    kubectl create namespace quorum-system --dry-run=client -o yaml | kubectl apply -f -
    kubectl apply -f "${ROOT}/providers/providerconfig-aws-prod.yaml"
    # Applying the XRD generates the XQuorumEnvironment CRD asynchronously; wait
    # for it to be established before applying the composite resource.
    kubectl apply -f "${ROOT}/apis/environment/definition.yaml"
    echo "waiting for the composite resource definition to be established..."
    kubectl wait --for=condition=Established xrd --all --timeout=120s
    kubectl apply -f "${ROOT}/apis/environment/composition.yaml"
    kubectl apply -f "${ROOT}/environments/prod.yaml"
    echo "waiting for ${ENVIRONMENT} infrastructure to become ready..."
    kubectl wait --for=condition=Ready \
      "xquorumenvironment/${ENVIRONMENT}" \
      -n "${NAMESPACE}" \
      --timeout=2400s
    upload_bootstrap
    bootstrap_application
    echo "production infrastructure and application are ready"
    ;;
  status)
    status
    ;;
  destroy)
    confirm "delete"
    delete_previous_final_snapshot
    delete_deploy_bucket_versions
    kubectl delete --ignore-not-found -f "${ROOT}/environments/prod.yaml"
    wait_for_managed_deletion
    ;;
  *) echo "usage: deploy.sh [validate|apply|status|destroy]" >&2; exit 2 ;;
esac
