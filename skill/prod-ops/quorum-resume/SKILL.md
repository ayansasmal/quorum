---
name: quorum-resume
description: Resume (start) the suspended Quorum PROD AWS stack — starts RDS, then EC2, then waits for the HTTPS gateway /health. Use when the user asks to resume, start, bring up, or wake the prod stack. Wraps quorum/crossplane/ops/quorum-resume.sh. Prod state change — requires explicit per-action approval.
---

# quorum-resume — bring the prod stack back up

Resumes the **production** Quorum stack by starting RDS, then EC2, then polling the
public gateway until `/health` responds. Thin wrapper over the canonical repo script
`quorum/crossplane/ops/quorum-resume.sh` (single source of truth — do not reimplement
its logic here).

## Target (prod, preset)

| Var | Value |
|-----|-------|
| `AWS_REGION` | `ap-southeast-2` |
| `DB_INSTANCE_ID` | `quorum-prod` (RDS) |
| `EC2_INSTANCE_ID` | `i-069de552b4a50b77b` |
| `GATEWAY_URL` | `https://quorum-gateway.ayansasmal.work` |

## Approval gate (MANDATORY)

This starts **production** infrastructure. Before running, state plainly that you are about
to **resume the prod stack (RDS `quorum-prod` + EC2 `i-069de552b4a50b77b`, ap-southeast-2)**
and get the user's explicit go-ahead. Do not run on assumed/standing approval — confirm each time.

## How to run

After approval, from the workspace root:

```bash
cd /Users/ayan/Desktop/Work/vscode/qc/quorum
AWS_REGION=ap-southeast-2 \
DB_INSTANCE_ID=quorum-prod \
EC2_INSTANCE_ID=i-069de552b4a50b77b \
GATEWAY_URL=https://quorum-gateway.ayansasmal.work \
bash crossplane/ops/quorum-resume.sh
```

The script waits for RDS `available`, EC2 `running`, then polls `/health` for up to 10
minutes. It exits `0` on `200`/`503` (gateway reachable) and non-zero if it never comes up.

## Report

- On success: confirm the gateway is reachable and quote the final `gateway available (NNN)` line.
- Recall: the gateway re-pulls the **pinned** `GATEWAY_TAG` on boot — resume does NOT change
  the deployed version. To deploy new code, use the `quorum-update` skill instead.
- Logs land in `/tmp/quorum-logs/` (or `/var/log/quorum`) — point the user there on failure.
