---
name: quorum-local-stop
description: Stop the local Quorum dev stack containers without wiping data volumes.
---

# quorum-local-stop — stop local containers (data preserved)

Stops all local Quorum containers. Data volumes (postgres, falkordb, redis, localstack) are preserved — a subsequent `quorum-local-start` resumes from the same state.

## Approval gate

State that you are about to stop the local dev stack (not production) and get the user's go-ahead.

## Steps

1. From `quorum/`: `npm run docker:clean`
   (This runs `setup.sh docker clean` → `docker compose down --remove-orphans`. The dashboard is stopped too if running.)
2. Verify: `npm run docker:ps` should show no running Quorum containers.

## Notes

- Does NOT wipe volumes. Data survives a stop/start cycle.
- To wipe all data use `/quorum-local-reset`.
