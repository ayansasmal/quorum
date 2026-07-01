---
name: quorum-local-logs
description: Stream logs for one or more local Quorum services from Docker Compose.
---

# quorum-local-logs — stream local service logs

Read-only. No approval needed.

## Usage
/quorum-local-logs [service ...]

- No args: stream the most important services (`gateway`, `graphiti`, `postgresql`, `redis`, `localstack`)
- Specific services: e.g. `/quorum-local-logs gateway graphiti`

## Steps

1. From `quorum/`, decide the target services:
   - No args:
     ```bash
     docker compose logs -f gateway graphiti postgresql redis localstack
     ```
   - With args:
     ```bash
     docker compose logs -f <service ...>
     ```
2. If Docker says a service name is unknown, stop and tell the user which name failed.
3. If the stack is not running, say so clearly and suggest `/quorum-local-start`.

## Notes

- Use this for live log streaming.
- For the most recent browser/API E2E run log file, prefer `npm run test:e2e:log`.
