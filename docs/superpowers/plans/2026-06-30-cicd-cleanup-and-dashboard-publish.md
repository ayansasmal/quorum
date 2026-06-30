# CI/CD Cleanup And Dashboard Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove obsolete CI jobs from the `quorum` repo, add a GHCR dashboard image workflow in `quorum-dash`, and sync the affected docs so the workspace artifact story matches reality.

**Architecture:** Keep the existing gateway publish path in `quorum` as the only active image workflow there, and move the dashboard image publish responsibility into `quorum-dash` where the Dockerfile already lives. Treat docs as part of the implementation so artifact ownership, local-dev/E2E usage, and workflow expectations stay aligned across repos.

**Tech Stack:** GitHub Actions, Docker Buildx, GHCR, Vite, nginx, Markdown docs

---

## File Map

- Modify: `quorum/.github/workflows/build.yml`
- Modify: `quorum/docs/CICD-DEPLOYMENT.md`
- Modify: `quorum/docs/DEPLOYMENT.md`
- Modify: `quorum/AGENTS.md`
- Create: `quorum-dash/.github/workflows/build.yml`
- Modify: `quorum-dash/AGENTS.md`

### Task 1: Remove obsolete CI jobs from quorum

**Files:**
- Modify: `quorum/.github/workflows/build.yml`
- Test: `quorum/.github/workflows/build.yml`

- [ ] **Step 1: Write the failing workflow expectation as a checklist**

Record the expected end state before editing:

```text
- build.yml has exactly one job: build-gateway
- no MCP_IMAGE env entry remains
- no build-mcp job remains
- no build-graphiti job remains
- header comments mention only the gateway image publish path
```

- [ ] **Step 2: Inspect the current workflow and confirm the obsolete sections exist**

Run:

```bash
sed -n '1,220p' quorum/.github/workflows/build.yml
```

Expected:
- `env` contains both `MCP_IMAGE` and `GATEWAY_IMAGE`
- `jobs` contains `build-mcp`, `build-gateway`, and `build-graphiti`

- [ ] **Step 3: Edit the workflow to the minimal active gateway-only version**

Apply this shape:

```yaml
name: Build

on:
  push:
    branches: [prod]
  workflow_dispatch:

env:
  GATEWAY_IMAGE: ghcr.io/${{ github.repository }}-gateway

jobs:
  build-gateway:
    name: Build Quorum Gateway Image
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata for Gateway image
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.GATEWAY_IMAGE }}
          tags: |
            type=sha,prefix=sha-
            type=raw,value=latest,enable={{is_default_branch}}
            type=semver,pattern={{version}}

      - name: Build and push Quorum Gateway image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: Dockerfile.gateway
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha,scope=gateway
          cache-to: type=gha,mode=max,scope=gateway
          platforms: linux/amd64,linux/arm64
```

- [ ] **Step 4: Re-read the workflow to verify nothing orphaned remains**

Run:

```bash
sed -n '1,220p' quorum/.github/workflows/build.yml
```

Expected:
- no `MCP_IMAGE`
- no `build-mcp`
- no `build-graphiti`
- one valid `build-gateway` job only

- [ ] **Step 5: Commit the quorum workflow cleanup**

Run:

```bash
git -C quorum add .github/workflows/build.yml
git -C quorum commit -m "ci: remove obsolete image build jobs"
```

Expected:
- one commit affecting only `quorum/.github/workflows/build.yml`

### Task 2: Add dashboard GHCR publish workflow in quorum-dash

**Files:**
- Create: `quorum-dash/.github/workflows/build.yml`
- Modify: `quorum-dash/AGENTS.md`
- Test: `quorum-dash/Dockerfile`
- Test: `quorum-dash/package.json`

- [ ] **Step 1: Write the failing workflow expectation**

Record the target behavior:

```text
- quorum-dash has a .github/workflows/build.yml file
- workflow triggers on push to main and workflow_dispatch
- workflow publishes ghcr.io/ayansasmal/quorum-dashboard
- workflow builds quorum-dash/Dockerfile for linux/amd64 and linux/arm64
- workflow emits sha-* tags and latest on default branch
```

- [ ] **Step 2: Confirm the current repo has no workflow directory**

Run:

```bash
rg --files quorum-dash/.github
```

Expected:
- no files found or no `.github` directory yet

- [ ] **Step 3: Create the dashboard build workflow**

Create `quorum-dash/.github/workflows/build.yml` with this structure:

```yaml
name: Build Dashboard Image

on:
  push:
    branches: [main]
  workflow_dispatch:

env:
  DASHBOARD_IMAGE: ghcr.io/ayansasmal/quorum-dashboard

jobs:
  build-dashboard:
    name: Build Quorum Dashboard Image
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata for dashboard image
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.DASHBOARD_IMAGE }}
          tags: |
            type=sha,prefix=sha-
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Build and push dashboard image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          build-args: |
            VCS_REF=${{ github.sha }}
          cache-from: type=gha,scope=dashboard
          cache-to: type=gha,mode=max,scope=dashboard
          platforms: linux/amd64,linux/arm64
```

- [ ] **Step 4: Document the workflow in the dashboard repo guide**

Add a short section in `quorum-dash/AGENTS.md` like:

```md
## CI/CD

- `quorum-dash/.github/workflows/build.yml` publishes `ghcr.io/ayansasmal/quorum-dashboard`.
- The image is for local development and E2E/containerised dashboard flows.
- Vercel remains the live production hosting path for the SPA.
```

- [ ] **Step 5: Run the dashboard build to verify the image workflow targets a valid Dockerfile**

Run:

```bash
npm run build
```

Working directory:

```bash
quorum-dash
```

Expected:
- Vite build succeeds and writes `dist/`

- [ ] **Step 6: Commit the dashboard workflow changes**

Run:

```bash
git -C quorum-dash add .github/workflows/build.yml AGENTS.md
git -C quorum-dash commit -m "ci: add dashboard image publish workflow"
```

Expected:
- one commit in `quorum-dash` covering the new workflow and repo guidance

### Task 3: Sync quorum docs with the new artifact story

**Files:**
- Modify: `quorum/docs/CICD-DEPLOYMENT.md`
- Modify: `quorum/docs/DEPLOYMENT.md`
- Modify: `quorum/AGENTS.md`

- [ ] **Step 1: Capture the doc mismatches before editing**

Use this checklist while editing:

```text
- dashboard image is described as local-dev/E2E support, not a production blocker
- quorum repo no longer claims an active MCP image job
- quorum repo no longer claims an active graphiti verify/build path once removed
- roadmap items distinguish implemented dashboard publishing from future production pinning
```

- [ ] **Step 2: Update CICD-DEPLOYMENT.md to match the implemented workflow ownership**

Make these edits:

```md
- In "Component Map", remove the "not yet published" warning from the dashboard image.
- In "What's published", add the dashboard image workflow once created.
- In "What is NOT yet published (gaps)", remove the dashboard workflow gap.
- Remove or rewrite references that treat `build-mcp` in `quorum/build.yml` as a current disabled path.
- Update the current/proposed pipeline diagrams so the quorum repo shows only gateway publishing and quorum-dash shows dashboard publishing.
- Clarify that the dashboard GHCR image supports local dev and E2E, while Vercel remains the live dashboard path.
```

- [ ] **Step 3: Update DEPLOYMENT.md so dashboard GHCR is no longer framed as a production-critical missing piece**

Edit the deployment guide so the affected sections read like:

```md
- Dashboard SPA: live via Vercel in production.
- Dashboard GHCR image: local-dev and E2E/container workflows.
- Roadmap items about `dashboardTag` or EC2 dashboard consumption remain future or optional, not prerequisites for the current live setup.
```

- [ ] **Step 4: Add workspace-level CI/CD ownership guidance to AGENTS.md**

Add or update a short rule in `quorum/AGENTS.md` stating:

```md
- `quorum/.github/workflows/build.yml` owns gateway image publishing only.
- Graphiti image publishing belongs to `graphiti/quorum-graphiti`.
- Dashboard image publishing belongs to `quorum-dash`.
- Do not reintroduce dormant MCP or Graphiti image jobs into the `quorum` repo.
```

- [ ] **Step 5: Re-read the edited docs for consistency**

Run:

```bash
sed -n '1,260p' quorum/docs/CICD-DEPLOYMENT.md
sed -n '1,220p' quorum/docs/DEPLOYMENT.md
sed -n '1,260p' quorum/AGENTS.md
```

Expected:
- artifact ownership is consistent across all three docs
- no section still treats the dashboard image as a production requirement for the current state

- [ ] **Step 6: Commit the quorum doc sync**

Run:

```bash
git -C quorum add docs/CICD-DEPLOYMENT.md docs/DEPLOYMENT.md AGENTS.md
git -C quorum commit -m "docs: sync ci and deployment ownership"
```

Expected:
- one docs-focused commit in `quorum`

### Task 4: Final verification and handoff

**Files:**
- Test: `quorum/.github/workflows/build.yml`
- Test: `quorum-dash/.github/workflows/build.yml`
- Test: `quorum/docs/CICD-DEPLOYMENT.md`
- Test: `quorum/docs/DEPLOYMENT.md`
- Test: `quorum/AGENTS.md`
- Test: `quorum-dash/AGENTS.md`

- [ ] **Step 1: Review both repos’ git status to isolate only intended changes**

Run:

```bash
git -C quorum status --short
git -C quorum-dash status --short
```

Expected:
- only the intended workflow/doc files are staged or committed for this task
- unrelated pre-existing dirty files remain untouched

- [ ] **Step 2: Re-run the dashboard build after all edits**

Run:

```bash
npm run build
```

Working directory:

```bash
quorum-dash
```

Expected:
- `vite build` succeeds again after the docs/workflow changes

- [ ] **Step 3: Summarize the final artifact ownership in the handoff**

Include these points in the final response:

```text
- quorum repo publishes only the gateway image
- quorum-dash publishes the dashboard image for local-dev/E2E use
- graphiti image publishing remains in graphiti/quorum-graphiti
- production runtime behavior was not changed in this pass
```

- [ ] **Step 4: If the user wants further work, queue the next logical follow-up**

Suggested next items:

```text
1. Remove Dockerfile.graphiti and any remaining local references once the GHCR pull path is fully unified.
2. Migrate gateway production pinning from semver to sha-* tags.
3. Add quorum-mcp release automation in its own repository.
```
