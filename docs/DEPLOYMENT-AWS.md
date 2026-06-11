# Quorum AWS Deployment Runbook

This runbook operates the production-named demo backend described in the
[approved design](superpowers/specs/2026-06-11-quorum-aws-crossplane-deployment-design.md).
The dashboard remains on Vercel at <https://quorum-dashboard.ayansasmal.work>.

## Safety Boundary

`crossplane/deploy.sh` defaults to offline validation. Implementation and CI must run only:

```bash
./crossplane/deploy.sh validate
```

This renders the Composition, validates all rendered resources against pinned provider schemas,
runs ShellCheck and Bash syntax checks, and validates Docker Compose. It does not call `kubectl apply`
or mutate AWS.

The `apply` and `destroy` paths require an explicit subcommand and typed `yes` confirmation.

## Prerequisites

- Docker Desktop Kubernetes active.
- Crossplane core and CLI `v2.3.2`.
- Docker Buildx and Compose v2.
- ShellCheck `0.11.0` or newer.
- `kubectl`, AWS CLI v2, and access to `ap-southeast-2`.
- Existing `aws-creds-prod` Kubernetes Secret in `crossplane-system`.
- Vercel DNS access for `ayansasmal.work`.

Confirm the offline toolchain:

```bash
crossplane version --client
docker buildx version
docker compose version
shellcheck --version
./crossplane/deploy.sh validate
```

## Provisioned Resource Graph

The production Composition renders 45 managed AWS resources plus the XR. It includes a public
subnet with an internet route, two private RDS subnets, application/database security groups, an
instance profile with scoped inline policies plus the AWS-managed `AmazonSSMManagedInstanceCore`
policy (Session Manager / RunShellScript access with no inbound SSH), an Elastic IP association, and
KMS-backed versioning and encryption controls for all three S3 buckets. The RDS instance is attached
to its subnet group and database security group rather than the account default network.

The XR publishes `status.elasticIp`, `status.instanceId`, and `status.rdsEndpoint` once the managed
resources reconcile, so `./crossplane/deploy.sh status` returns the values needed for DNS and ops.

## Operator Deployment Order

The following steps are operator-run and intentionally excluded from tests.

1. Build the arm64 images locally:

   ```bash
   docker buildx build --platform linux/arm64 -f Dockerfile.gateway \
     -t ghcr.io/ayansasmal/quorum-gateway:0.4.12 --load .
   docker buildx build --platform linux/arm64 -f Dockerfile.graphiti \
     -t ghcr.io/ayansasmal/graphiti-mcp:0.4.x --load .
   ```

2. Authenticate to GHCR and push the reviewed images:

   ```bash
   docker push ghcr.io/ayansasmal/quorum-gateway:0.4.12
   docker push ghcr.io/ayansasmal/graphiti-mcp:0.4.x
   ```

3. Create `quorum/prod/gateway` in AWS Secrets Manager from the local, gitignored `.env.prod`.
   Do not print the file or commit generated JSON. The secret contains application values only:
   JWT, GitHub OAuth, OpenAI, and `GHCR_USERNAME` / `GHCR_TOKEN`. RDS owns its master password
   separately. Bootstrap writes values as shell-escaped assignments and authenticates to GHCR with
   `--password-stdin`.

4. Upload the reviewed `crossplane/bootstrap/` bundle to the deploy bucket under the live prefix:

   ```bash
   aws s3 cp crossplane/bootstrap/ \
     s3://quorum-prod-deploy/bootstrap/current/ \
     --recursive --region ap-southeast-2
   ```

   The instance boots from this prefix (see [Updating The Bootstrap](#updating-the-bootstrap)).
   The deploy bucket has S3 versioning enabled, so overwriting `current/` retains prior revisions.

5. Run:

   ```bash
   ./crossplane/deploy.sh apply
   ```

   `apply` installs the provider family and function, then **waits** for them to report
   `Healthy` and for the `ProviderConfig` and `XQuorumEnvironment` CRDs to be established before
   applying the `ProviderConfig`, composition, and composite resource. This prevents the
   "no matches for kind ProviderConfig" race on a cold cluster. The first provider pull can take
   several minutes, so the `kubectl wait` steps may sit for a while — that is expected.

6. Watch readiness:

   ```bash
   ./crossplane/deploy.sh status
   ```

7. Read the allocated Elastic IP from the XR status:

   ```bash
   kubectl get xquorumenvironment quorum-prod -n quorum-system \
     -o jsonpath='{.status.elasticIp}{"\n"}'
   ```

8. In Vercel DNS, replace the placeholder A record for `quorum-gateway.ayansasmal.work` with that EIP.

9. Wait for Caddy to complete ACME HTTP-01 issuance on ports 80 and 443.

10. Set the Vercel dashboard environment variable:

    ```text
    QUORUM_GATEWAY_URL=https://quorum-gateway.ayansasmal.work
    ```

11. Set the GitHub OAuth callback to the production gateway callback URL.

12. Verify `https://quorum-gateway.ayansasmal.work/health`.

13. Run the MCP integration suite with an MCP client after the gateway is available.

## Resume And Suspend

Scheduled auto-start is disabled. Export the resource identifiers, then resume on demand:

```bash
export AWS_REGION=ap-southeast-2
export DB_INSTANCE_ID=quorum-prod
export EC2_INSTANCE_ID=$(kubectl get xquorumenvironment quorum-prod -n quorum-system -o jsonpath='{.status.instanceId}')
export GATEWAY_URL=https://quorum-gateway.ayansasmal.work
./crossplane/ops/quorum-resume.sh
```

Suspend manually:

```bash
./crossplane/ops/quorum-suspend.sh
```

Suspend requests a final S3 snapshot over SSM before stopping EC2 and RDS. The EventBridge schedules
also stop both resources daily at 10:00 and 23:00 Australia/Sydney. To restore scheduled starts,
set `spec.schedule.autoStart.enabled: true`, review the two start schedules, and reapply the XR.

## Credentials And Rotation

RDS generates the master credential in AWS Secrets Manager. The EC2 instance profile reads the RDS
endpoint and managed-secret ARN, then writes database variables to `/etc/quorum/quorum.env` with mode
`0600`. `quorum-credential-refresh.timer` repeats this every 15 minutes so password rotation does not
require a redeploy. On first boot, AL2023 installs Docker, `jq`, PostgreSQL client tools, and the
checksum-verified ARM64 Docker Compose `v5.1.4` plugin. The bootstrap applies `init-db.sql` with
`ON_ERROR_STOP` before starting containers.

The application secret must never contain `POSTGRES_PASSWORD`.

## Updating The Bootstrap

The instance's `userData` is a minimal stub: it pulls `ec2-userdata.sh` from
`s3://quorum-prod-deploy/bootstrap/current/` and execs it. That orchestrator then downloads the rest
of the bundle (`start.sh`, snapshot scripts, `docker-compose.aws.yml`, `init-db.sql`, systemd units)
from the same prefix and runs `start.sh`. Because the scripts live in S3, you can change them and
re-run on the box without rebuilding or replacing the instance:

1. Edit the script under `crossplane/bootstrap/`, then re-run `./crossplane/deploy.sh validate`.
2. Re-upload the prefix:

   ```bash
   aws s3 cp crossplane/bootstrap/ \
     s3://quorum-prod-deploy/bootstrap/current/ \
     --recursive --region ap-southeast-2
   ```

3. Re-run on the instance over SSM (no SSH; the box has no inbound port 22):

   ```bash
   aws ssm send-command \
     --region ap-southeast-2 \
     --document-name AWS-RunShellScript \
     --targets Key=tag:Name,Values=quorum-prod \
     --parameters 'commands=["/opt/quorum/ec2-userdata.sh"]'
   ```

   Re-running is safe: every bootstrap step is idempotent. To restart only the stack without
   re-fetching the bundle, run `/opt/quorum/start.sh` instead. `userData` itself runs only at first
   launch, so editing the stub requires reapplying the XR; editing the S3 scripts does not.

## Script Logs

Every bootstrap and operator script mirrors its full stdout and stderr to a timestamped log file in
addition to the console. Each run names its own file as
`${QUORUM_LOG_DIR:-/var/log/quorum}/<script>-YYYYMMDD-HHMMSS.log`, so successive runs never overwrite
each other and timer-driven runs (`quorum-credential-refresh.timer`, `quorum-snapshot.timer`) and SSM
re-runs stay independently traceable. On the EC2 instance the scripts run as root and write to
`/var/log/quorum`; when the directory is not writable (for example, an operator laptop running
`ops/quorum-resume.sh` without `sudo`), they fall back to `${TMPDIR:-/tmp}/quorum-logs`. Override the
directory with `QUORUM_LOG_DIR`:

```bash
# Inspect the most recent bootstrap log on the instance over SSM:
aws ssm send-command --region ap-southeast-2 \
  --document-name AWS-RunShellScript \
  --targets Key=tag:Name,Values=quorum-prod \
  --parameters 'commands=["ls -t /var/log/quorum | head","tail -n 50 \"$(ls -t /var/log/quorum/start.sh-*.log | head -1)\""]'
```

The userData boot stub itself is not a script file; its output is captured by cloud-init at
`/var/log/cloud-init-output.log`, and from `exec /opt/quorum/ec2-userdata.sh` onward the per-script
logs take over.

## Cost Controls

- Monthly budget: USD 40.
- Email notification: 100 percent.
- Action threshold: 150 percent.
- EventBridge stop schedules: 10:00 and 23:00 Australia/Sydney.
- Start schedules: present but disabled.
- AWS Budgets automatic action: stop the RDS instance at the configured action threshold.

EC2 schedules call the AWS-managed `AWS-StopEC2Instance` and `AWS-StartEC2Instance` Automation
documents using the stable `Name=quorum-prod` tag. RDS schedules use the stable `quorum-prod`
database identifier.

AWS Budgets does not constrain OpenAI organization spend. Configure the OpenAI usage limit separately.

## Teardown

Take a final snapshot, confirm the retained RDS/S3 data requirements, then run:

```bash
./crossplane/ops/quorum-suspend.sh
./crossplane/deploy.sh destroy
```

The destroy command removes the XR only after typed confirmation. Review final snapshots, versioned
S3 objects, Secrets Manager secrets, the Elastic IP, and the Vercel DNS record separately.
