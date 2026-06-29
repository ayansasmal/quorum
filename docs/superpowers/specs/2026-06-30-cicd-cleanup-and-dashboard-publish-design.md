# CI/CD Cleanup And Dashboard Publish Design

Date: 2026-06-30

## Summary

This design covers two scoped changes, in order:

1. Clean up the `quorum` repository CI/CD surface so it reflects only the artifacts this repo still owns and needs.
2. Add a dedicated GitHub Actions workflow in `quorum-dash` to build and publish the dashboard Docker image for local development and E2E support.

The design intentionally does not change production deployment behavior, Crossplane pins, or the Vercel-hosted dashboard path. It only removes misleading or obsolete CI jobs and adds the missing dashboard image automation.

## Goals

- Remove CI jobs from `quorum/.github/workflows/build.yml` that are no longer needed.
- Keep the gateway image build and publish path intact.
- Add a `quorum-dash` GHCR workflow for the existing dashboard Docker image.
- Update documentation so the current artifact ownership and delivery flow are accurate.

## Non-Goals

- Migrating `gatewayTag` from semver to `sha-*`.
- Changing `prod.yaml`, `docker-compose.aws.yml`, or production runtime topology.
- Adding `quorum-mcp` npm or Docker release automation.
- Converting the dashboard image into a production dependency.

## Current State

### quorum

- `quorum/.github/workflows/build.yml` publishes the gateway image on pushes to `prod`.
- The same workflow still contains:
  - `build-graphiti`, which only verifies `Dockerfile.graphiti` and does not publish an artifact.
  - `build-mcp`, which is disabled with `if: false`.
- `Dockerfile.graphiti` exists only to build from an upstream Graphiti path that is already superseded by the maintained `quorum-graphiti` fork and its own publish workflow.

### quorum-dash

- `quorum-dash/Dockerfile` already builds an nginx-served dashboard image.
- The repo currently has no local `.github/workflows` directory in this workspace.
- The dashboard is live through Vercel, but the Docker image remains useful for local stack composition and E2E environments.

## Proposed Approach

### Phase 1: Quorum Workflow Cleanup

Update `quorum/.github/workflows/build.yml` so it represents the real artifact contract of the `quorum` repo:

- Retain `build-gateway`.
- Remove `build-graphiti`.
- Remove `build-mcp`.
- Refresh workflow header comments so they describe only the active gateway publish behavior.

This keeps the workflow aligned with actual ownership:

- Gateway image publishing belongs in `quorum`.
- Graphiti image publishing belongs in `graphiti/quorum-graphiti`.
- MCP publishing belongs in `quorum-mcp`, not as a dormant stub in `quorum`.

### Phase 2: Dashboard Image Publish Workflow

Add a new workflow in `quorum-dash/.github/workflows/build.yml`:

- Trigger on pushes to `main` and workflow dispatch.
- Build from `quorum-dash/Dockerfile`.
- Publish to `ghcr.io/ayansasmal/quorum-dashboard`.
- Emit immutable `sha-<commit>` tags.
- Optionally emit `latest` only for the default branch as a convenience alias.
- Build for `linux/amd64` and `linux/arm64` to match the broader workspace image strategy.

This workflow is intentionally narrow. It does not:

- Deploy to Vercel.
- Update any production pin.
- Introduce environment-specific runtime logic.

## Documentation Changes

Update the following docs to match the new state:

- `quorum/docs/CICD-DEPLOYMENT.md`
  - Remove statements implying the `quorum` repo still meaningfully owns Graphiti or MCP image CI paths.
  - Mark the dashboard image workflow as implemented once added.
  - Clarify that the dashboard image is primarily for local dev and E2E, not a production prerequisite.
- `quorum/docs/DEPLOYMENT.md`
  - Adjust roadmap or current-state wording that currently treats the dashboard GHCR image as a production-critical gap.
- `quorum/AGENTS.md`
  - Update workspace-level CI/CD guidance if it references the old artifact ownership story.
- `quorum-dash/AGENTS.md`
  - Add the new Docker publish workflow to the package command/context guidance if helpful for future contributors.

## Testing And Verification

### quorum

- Validate workflow syntax by reviewing the resulting YAML structure.
- Confirm `build.yml` still contains a valid `build-gateway` job and no orphaned cache or env references.

### quorum-dash

- Validate the new workflow structure against the existing Dockerfile and image name.
- Run `npm run build` in `quorum-dash` to verify the dashboard still builds cleanly before claiming the image workflow is sound.

### Docs

- Re-read the touched docs after editing to ensure the artifact story is internally consistent.

## Risks And Mitigations

### Risk: removing dormant jobs hides future release intent

Mitigation:
- Keep future MCP automation documented in `CICD-DEPLOYMENT.md` as roadmap work instead of leaving dead CI code in place.

### Risk: dashboard image workflow is mistaken for a production deployment path

Mitigation:
- State explicitly in docs that the dashboard GHCR image supports local dev and E2E, while the live dashboard remains Vercel-hosted.

### Risk: repo-local workflow assumptions drift again

Mitigation:
- Update both AGENTS and deployment docs in the same change set so repo guidance matches the implementation immediately.

## Success Criteria

- `quorum/.github/workflows/build.yml` contains only the gateway image publish path.
- `quorum-dash/.github/workflows/build.yml` exists and publishes `ghcr.io/ayansasmal/quorum-dashboard`.
- Deployment docs describe dashboard image publishing as local-dev/E2E support, not a production blocker.
- No production deployment manifests or runtime compose files are changed in this pass.
