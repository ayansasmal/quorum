# Quorum Unified E2E Suite

This directory is the single source of truth for Quorum end-to-end testing.

It owns the integrated Playwright surface for:

- API scenarios against the gateway
- Browser scenarios against the dashboard
- Shared fixtures, JWT helpers, seed helpers, and graph reporting
- The Docker-based runtime used to stand up the full local E2E stack

## Why This Lives Here

Quorum's API and dashboard E2E tests exercise one integrated system:

- `gateway`
- `dashboard`
- `graphiti`
- `postgresql`
- `redis`
- `localstack`

Keeping the suite in `quorum/e2e/` gives coding agents one place to inspect,
run, and maintain the real cross-package behavior.

The dashboard repository still owns dashboard application code, but it no
longer owns a separate E2E harness.

## Directory Map

- `scenarios/api/` — API-first Playwright specs
- `scenarios/ui/` — browser Playwright specs
- `helpers/` — shared HTTP, JWT, browser-session, seed, and setup helpers
- `fixtures/` — canonical committed test configs and ES256 test keys
- `reporter/` — graph reporter and static suite graph metadata
- `viewer/` — static graph viewer assets
- `scripts/run.sh` — unified Docker E2E lifecycle entrypoint

## Coding Agent Rules

- Treat this directory as the canonical E2E home for Quorum.
- Do not recreate duplicate Playwright configs or duplicate fixtures under
  `quorum-dash/`.
- When adding or changing E2E coverage, prefer extending helpers here instead
  of forking setup logic in another package.
- Keep API and UI scenarios aligned with the shared scenario IDs used by the
  graph reporter.
- If the Docker runtime or scenario layout changes, update this README and the
  repo docs in the same task.

## Common Commands

From `quorum/`:

```bash
npm run test:e2e
npm run test:e2e:env:up
npm run test:e2e:docker
npm run test:e2e:docker:logs
```

Use `npm run test:e2e:mcp` separately when validating the published MCP server
against the live E2E gateway.

## Image Tag Notes

- `e2e/scripts/run.sh` resolves `GRAPHITI_TAG`, `GATEWAY_TAG`, and
  `DASHBOARD_TAG` from the environment first.
- Without overrides, Graphiti falls back to the local fork SHA when available,
  and gateway/dashboard fall back to the local repo SHAs when available.
- Those local SHAs must already exist in GHCR. If a local checkout is ahead of
  the published images, override the tags with known published values before
  starting the stack.
