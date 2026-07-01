---
name: quorum-suspend
description: Suspend (stop) the Quorum PROD AWS stack — takes a final snapshot over SSM, then stops EC2 and RDS to save cost. Use when the user asks to suspend, stop, pause, or shut down the prod stack. Wraps quorum/crossplane/ops/quorum-suspend.sh. Prod state change + SSM — requires explicit per-action approval.
---

# quorum-suspend — stop the prod stack to save cost

Suspends the **production** Quorum stack: triggers an on-box snapshot over SSM, then stops
EC2 and RDS. Thin wrapper over the canonical repo script
`quorum/crossplane/ops/quorum-suspend.sh` (single source of truth — do not reimplement it).

## Target (prod, preset)

| Var | Value |
|-----|-------|
| `AWS_REGION` | `ap-southeast-2` |
| `DB_INSTANCE_ID` | `quorum-prod` (RDS) |
| `EC2_INSTANCE_ID` | `i-069de552b4a50b77b` |

## Approval gate (MANDATORY)

This stops **production** infrastructure and runs an **SSM** command on `quorum-prod`. Before
running, state plainly that you are about to **suspend the prod stack (snapshot via SSM on
EC2 `i-069de552b4a50b77b`, then stop EC2 + RDS `quorum-prod`, ap-southeast-2)** and get the
user's explicit go-ahead. Confirm each time — never on standing approval.

## Known caveat

The on-box snapshot step (`/opt/quorum/snapshot-save.sh`) depends on `SNAPSHOT_BUCKET`; if
that is unset on the instance the snapshot silently no-ops (the script does `|| echo "snapshot
command skipped"` and still stops the stack). Surface this to the user before suspending if a
durable snapshot matters. See memory `project-snapshot-hardening`.

## How to run

After approval, from the workspace root:

```bash
cd /Users/ayan/Desktop/Work/vscode/qc/quorum
AWS_REGION=ap-southeast-2 \
DB_INSTANCE_ID=quorum-prod \
EC2_INSTANCE_ID=i-069de552b4a50b77b \
bash crossplane/ops/quorum-suspend.sh
```

## Report

- Confirm EC2 stopping and RDS stopping; note the snapshot SSM command id (or that it was skipped).
- Remind the user that resuming later is done via the `quorum-resume` skill.
- Logs land in `/tmp/quorum-logs/` (or `/var/log/quorum`).
