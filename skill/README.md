# Quorum Development Skills

These skills are for **developing, operating, and testing the Quorum codebase and environments**.

They are **not** the same thing as using Quorum as a product through the MCP server or dashboard.

## What belongs here

- Local development workflows for this repo
- Production operator runbooks for Quorum environments
- Repository-specific deployment and maintenance helpers

## What does not belong here

- End-user guidance for `@as-quorum/mcp`
- General Quorum product usage instructions
- Project knowledge that should live in docs, code comments, or the governed graph itself

## Layout

- `prod-ops/` — production AWS operation skills such as resume, suspend, restart, and update
- `local-dev/` — local Docker/Desktop development skills for this repo

The workspace-level `.claude/skills/quorum-*` entries are symlinks to these tracked source directories so coding agents
get the expected local skill paths without forcing the source of truth to live outside the repo.
