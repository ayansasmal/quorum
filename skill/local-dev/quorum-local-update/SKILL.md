---
name: quorum-local-update
description: Pull the latest GHCR images for gateway and/or graphiti, then restart those services without touching data volumes.
---

# quorum-local-update — pull fresh images and restart services

Pulls updated GHCR images and performs a rolling restart of gateway and graphiti. All data volumes remain intact.

## Usage
/quorum-local-update [gateway=sha-<tag>] [graphiti=sha-<tag>]

- No args: pull `latest` for both gateway and graphiti.
- `gateway=sha-ea2f792`: example — pin gateway to current prod tag.
- `graphiti=sha-d99abda38b...`: example — pin graphiti to current prod tag.

## Approval gate

State the images and tags that will be pulled (local Docker Desktop — not production) and get the user's go-ahead.

## Steps

1. From `quorum/`, pull the updated images:
   ```bash
   GATEWAY_TAG=${gateway_tag:-latest} \
   GRAPHITI_TAG=${graphiti_tag:-latest} \
   docker compose -f docker-compose.yml -f docker-compose.pull.yml pull gateway graphiti
   ```
2. Restart the updated services (no volume impact):
   ```bash
   GATEWAY_TAG=${gateway_tag:-latest} \
   GRAPHITI_TAG=${graphiti_tag:-latest} \
   docker compose -f docker-compose.yml -f docker-compose.pull.yml up -d --no-deps gateway graphiti
   ```
3. Verify: `curl -sf http://localhost:3001/health | jq .`

## Notes

- Does NOT change prod.yaml or the production secret — this is local only.
- To deploy to production use `/quorum-update sha-<commit>`.
- Requires `docker login ghcr.io` to have been run once on this machine.
