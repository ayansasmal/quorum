---
name: quorum-restart
description: Restart the Quorum PROD gateway stack over SSM (no SSH) in one of three modes — restart (fast bounce), recreate (pick up env/compose changes), or full (re-pull image + DB init + timers). Use when the user asks to restart, bounce, recreate, or re-converge the prod stack. Wraps quorum/crossplane/ops/quorum-restart.sh. Prod SSM action — requires explicit per-action approval.
---

# quorum-restart — bounce / re-converge the prod gateway

Restarts the **production** Quorum backend on EC2 over SSM. Thin wrapper over the canonical
repo script `quorum/crossplane/ops/quorum-restart.sh` (single source of truth — do not
reimplement it).

## Modes (first positional arg, default `restart`)

| Mode | What it does | When |
|------|--------------|------|
| `restart` | `docker compose restart` — bounce all containers, no re-pull (fast) | quick recovery, clear stuck state |
| `recreate` | `up -d --force-recreate` — recreate containers, sources env | picked up env/compose changes (NOT a new image tag) |
| `full` | `/opt/quorum/start.sh` — re-pull image, idempotent DB init, timers | deploy a re-pinned `GATEWAY_TAG`, full re-converge |

> A new gateway **version** only lands with `full` AND only after the `GATEWAY_TAG` secret is
> repinned — for that, use the `quorum-update` skill (it repins then calls this with `full`).

## Target (prod, preset)

| Var | Value |
|-----|-------|
| `AWS_REGION` | `ap-southeast-2` |
| `INSTANCE_NAME` | `quorum-prod` (resolves to running `i-069de552b4a50b77b`) |

## Approval gate (MANDATORY)

This runs an **SSM** command on **production** `quorum-prod`. Before running, state plainly the
mode and that you are about to **restart the prod stack (`<mode>`) over SSM on EC2 `quorum-prod`,
ap-southeast-2** and get the user's explicit go-ahead. Confirm each time — never on standing approval.

## How to run

After approval, from the workspace root (replace `<mode>` with `restart` | `recreate` | `full`):

```bash
cd /Users/ayan/Desktop/Work/vscode/qc/quorum
AWS_REGION=ap-southeast-2 INSTANCE_NAME=quorum-prod \
bash crossplane/ops/quorum-restart.sh <mode>
```

The script sends the SSM command, waits (up to 60 attempts for slow `full` re-converges), then
prints the invocation `Status` + `StandardOutputContent` + `StandardErrorContent`, including a
`docker compose ps`.

## Report

- Quote the SSM `Status` (expect `Success`) and the `docker compose ps` lines so the user sees
  container health.
- After a `full`, verify `https://quorum-gateway.ayansasmal.work/health` returns 200.
- Logs land in `/tmp/quorum-logs/` (or `/var/log/quorum`).
