---
name: quorum-local-reset
description: Stop the local Quorum stack AND wipe all data volumes — full reset to a clean state. Destructive.
---

# quorum-local-reset — wipe local data and restart clean

**Destructive.** Stops all containers and deletes all data volumes.

## Hard approval gate (MANDATORY)

Before running, tell the user exactly what will be destroyed:
- PostgreSQL audit store (all audit entries)
- FalkorDB knowledge graph (all nodes and edges)
- Redis cache (all config and profile entries)
- LocalStack S3 and DynamoDB state (config bucket, membership table)

Ask: "This will permanently delete all local Quorum data. Type YES to confirm."
Wait for the literal string "YES" (case-sensitive) before proceeding. Do not proceed on anything less.

## Steps

1. After "YES" confirmation, from `quorum/`: `npm run docker:clean:all`
   (Runs `setup.sh docker clean --volumes` → `docker compose down --remove-orphans --volumes`.)
2. Restart a fresh stack: `npm run docker:start`
   (`setup.sh docker` brings the stack up and re-seeds LocalStack automatically via `init-localstack.sh`.)
3. Verify health: `curl -sf http://localhost:3001/health | jq .`
4. Report: stack is clean and running with empty data.

## Notes

- After reset, the first admin is re-seeded automatically if `QUORUM_FIRST_ADMIN` is set in `.env`.
- If `QUORUM_FIRST_ADMIN` is not set, no admin will exist — warn the user.
