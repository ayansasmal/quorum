---
name: quorum-local-status
description: Show a one-table health summary of all local Quorum services.
---

# quorum-local-status — local stack health at a glance

Read-only. No approval needed.

## Steps

1. From `quorum/`: `npm run docker:ps`
2. Also run: `curl -sf http://localhost:3001/health | jq .` (may fail if stack is down — handle gracefully).
3. Render a table:

   | Service | Port | Status |
   |---------|------|--------|
   | gateway | 3001 | healthy / starting / stopped |
   | graphiti | 8001 | healthy / starting / stopped |
   | postgresql | 5432 | healthy / starting / stopped |
   | falkordb | 6379 | healthy / starting / stopped |
   | redis | 6380 (host) | healthy / starting / stopped |
   | localstack | 4566 | healthy / starting / stopped |
   | dashboard | 3002 | running / not started |

4. If the gateway health endpoint responds, include the `components` detail from its JSON.
5. If the stack is not running say so clearly and suggest `/quorum-local-start`.
