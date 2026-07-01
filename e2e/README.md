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

## Ownership Boundaries

Use this directory when the change is about:

- end-to-end system behavior
- Playwright scenarios
- test fixtures, JWTs, seed data, and browser bootstrap
- Docker orchestration for integrated E2E runs
- suite reporting and scenario graph output

Do not add a parallel E2E harness back into:

- `quorum-dash/`
- `quorum-mcp/`
- other sibling repositories

If a sibling package needs shared E2E behavior, import or reference the helper
from here instead of copying it.

## Directory Map

- `scenarios/api/` — API-first Playwright specs
- `scenarios/ui/` — browser Playwright specs
- `helpers/` — shared HTTP, JWT, browser-session, seed, and setup helpers
- `fixtures/` — canonical committed test configs and ES256 test keys
- `reporter/` — graph reporter and static suite graph metadata
- `viewer/` — static graph viewer assets
- `scripts/run.sh` — unified Docker E2E lifecycle entrypoint

## How Coding Agents Should Navigate It

Start in this order:

1. `playwright.config.js` for projects, reporters, and suite entrypoints
2. `helpers/setup.js` and `helpers/teardown.js` for stack assumptions
3. `scenarios/api/` or `scenarios/ui/` for the behavior under test
4. `helpers/` for reusable test primitives before adding new ones
5. `scripts/run.sh` and `docker-compose.yml` for runtime wiring

This keeps changes aligned with the real suite contract before editing specs or
infrastructure.

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

## Scenario Conventions

- API scenarios live in `scenarios/api/`.
- Browser scenarios live in `scenarios/ui/`.
- Every `describe` title must begin with the scenario ID, like `S-12.3`.
- Reuse committed fixtures where possible instead of generating ad hoc ones in
  individual specs.
- Put cross-scenario behavior in `helpers/` only when at least two specs need
  it; otherwise keep setup local to the spec.

## Cross-Repo Context

- `quorum/` owns the integrated E2E harness and the Docker runtime.
- `quorum-dash/` owns dashboard application code, not a separate Playwright
  runtime.
- `quorum-mcp/` may consume helpers from this suite for integration tests, but
  should not fork the JWT or fixture contract.

When changing imports across repos, prefer pointing at this canonical helper
surface instead of creating new copies.

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

## When To Update Docs

Update this README, `quorum/AGENTS.md`, and any affected package docs whenever
you change:

- scenario layout
- helper ownership
- Docker entrypoints
- required image tags or runtime expectations
- cross-repo E2E responsibilities

## Image Tag Notes

- `e2e/scripts/run.sh` resolves `GRAPHITI_TAG`, `GATEWAY_TAG`, and
  `DASHBOARD_TAG` from the environment first.
- Without overrides, Graphiti falls back to the local fork SHA when available,
  and gateway/dashboard fall back to the local repo SHAs when available.
- Those local SHAs must already exist in GHCR. If a local checkout is ahead of
  the published images, override the tags with known published values before
  starting the stack.
