---
name: quorum-update
description: Deploy a new gateway build to the Quorum PROD stack — verify the image exists in GHCR, repin GATEWAY_TAG in the quorum/prod/gateway secret, then full re-converge over SSM and verify /health. Use when the user asks to update, deploy, ship, roll out, or bump the prod gateway to a new commit/tag. Takes a sha-<commit> (or semver) argument. Prod secret write + SSM — requires explicit per-action approval.
---

# quorum-update — deploy a new gateway build to prod

Deploys a specific gateway image to **production** by repinning the pinned `GATEWAY_TAG` and
re-converging the stack. The gateway is **tag-pinned**: every boot re-pulls `GATEWAY_TAG` from
the secret `quorum/prod/gateway`, so a deploy = repin-the-tag + `restart full`.

**Argument:** the image tag to deploy, normally `sha-<short-commit>` (e.g. `sha-e88b97c`).
Prefer `sha-<commit>` over `latest` for immutability/rollback.

## Target (prod, preset)

| Thing | Value |
|-------|-------|
| Secret | `quorum/prod/gateway` (key `GATEWAY_TAG`) |
| Region | `ap-southeast-2` |
| EC2 | `quorum-prod` (`i-069de552b4a50b77b`) |
| Image | `ghcr.io/ayansasmal/quorum-gateway:<tag>` |
| Health | `https://quorum-gateway.ayansasmal.work/health` |

## Steps

### 1. Confirm CI built the image (recommended)

```bash
gh run list --workflow=build.yml --branch prod --limit 5
```

Confirm the run for the target commit is green before proceeding.

### 2. Verify the image exists in GHCR (REQUIRED — the auto-mode classifier blocks the repin otherwise)

```bash
docker manifest inspect ghcr.io/ayansasmal/quorum-gateway:<tag> >/dev/null && echo "image present" || echo "IMAGE MISSING — do not repin"
```

If the image is missing, **stop** and tell the user — do not repin a tag that has no image.

### 3. Approval gate (MANDATORY)

State plainly that you are about to **repin `GATEWAY_TAG` in the prod secret `quorum/prod/gateway`
to `<tag>` and re-converge prod EC2 `quorum-prod` over SSM (ap-southeast-2)**, and get the user's
explicit go-ahead. This is a **prod secret write + SSM action** — confirm each time, never on
standing approval.

### 4. Repin the secret (read-modify-write — NEVER print the secret)

Preserves every other key; only `GATEWAY_TAG` changes. Do **not** echo the secret to chat/logs.

```bash
aws secretsmanager get-secret-value --secret-id quorum/prod/gateway --region ap-southeast-2 \
  --query SecretString --output text \
  | jq -c '.GATEWAY_TAG="<tag>"' \
  | aws secretsmanager put-secret-value --secret-id quorum/prod/gateway --region ap-southeast-2 \
      --secret-string file:///dev/stdin
```

### 5. Re-converge the stack

- **Running stack:** use the `quorum-restart` skill with mode `full` (re-pulls the new tag).
- **Suspended stack:** use the `quorum-resume` skill instead — the EC2 boot runs `start.sh`
  which does `docker compose pull`, so it comes up directly on the new tag (no separate `full`).

### 6. Verify

```bash
curl -s https://quorum-gateway.ayansasmal.work/health | jq .
```

Expect HTTP 200 and all components connected.

## Report & record

- Confirm the deployed tag, the health result, and which re-converge path (restart-full vs resume) was used.
- Update memory `project-prod-gateway-tag-pin` with a dated deploy entry (old tag → new tag, path used).
- Never paste the secret or any token into chat or logs.
