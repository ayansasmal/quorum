---
name: quorum-local-start
description: Start the local Quorum dev stack (gateway + graphiti + postgres + falkordb + redis + localstack). Optionally starts the dashboard nginx container as well.
---

# quorum-local-start — bring the local stack up

Starts the full local Quorum development stack.

## Usage
/quorum-local-start [dashboard]

- No args: start core stack (gateway + graphiti + postgres + falkordb + redis + localstack)
- `dashboard`: also start the nginx dashboard container on :3002

## Approval gate

State plainly what you are about to start (local Docker Desktop — not production) and get the user's go-ahead before running any commands.

## Steps

1. From `quorum/`:
   - Without `dashboard`: `npm run docker:start`
   - With `dashboard`: `npm run docker:start` then `npm run docker:start:dash`
2. Verify health: `curl -sf http://localhost:3001/health | jq .`
3. Report running services and ports:
   - Gateway: http://localhost:3001
   - Graphiti: http://localhost:8001
   - FalkorDB UI: http://localhost:3000
   - Dashboard: http://localhost:3002 (if started)

## Notes

- Requires Docker Desktop running.
- First run after `docker login ghcr.io` pulls the Graphiti GHCR image (~1 min). Subsequent starts use cached layers.
- For active React dev, prefer `cd quorum-dash && npm run dev` (Vite hot-reload) over the nginx container.
