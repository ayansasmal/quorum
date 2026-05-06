# @as-quorum/mcp

Published npm package. Engineers install this to connect Claude Code and AI agents to a Quorum gateway.

```bash
npm install -g @as-quorum/mcp
# or via repo:
npm run quorum:install  # from repo root — builds + registers with claude + installs skill
```

---

## Purpose

MCP server that exposes 10 tools to Claude Code: `remember`, `recall`, `search`, `reflect`, `history`, `export`, `forget`, `review`, `pending`, `authenticate`.

Always communicates with a Quorum gateway over HTTP. **Never connects to PostgreSQL directly.** Default gateway URL: `http://localhost:3001` (local dev Docker stack).

---

## Key Files

```
src/
  server.js               — Entry point: startup, tool registration, health endpoint
  quorum-file.js          — .quorum project file auto-discovery (sets env vars)
  tools/                  — One file per MCP tool
  governance/             — conflict.js · authority.js · confidence.js · provenance.js
  audit/                  — pipeline.js · chain.js · primary.js · secondary.js
  graph/                  — client.js (Graphiti) · schema.js · queries.js (pg-compat + GatewayClient duck-type)
  config/                 — schema.js · loader.js · quorum.schema.json
  identity/               — resolver.js (4-layer identity chain)
  gateway/
    client.js             — Outbound HTTP client to gateway (NOT the gateway server)
  export/                 — markdown.js · confluence.js
  prompts/                — loader.js
cli.js                    — quorum init / quorum install CLI
skill/                    — SKILL.md + references/ (bundled with npm package)
dist/                     — Compiled output (esbuild, gitignored)
```

---

## Development

```bash
npm run build:all    # compile src/server.js + cli.js → dist/
npm run dev          # node --watch src/server.js (uncompiled, for local dev)
npm run start        # run compiled dist/server.js
```

Tests run from the **repo root** (`npm test`), not from this directory.

---

## Architecture Constraints

**Never add `pg` calls to new code.** The `pg` parameter on functions in `graph/queries.js` and `audit/secondary.js` is kept for backward-compat with gateway's workspace import — those functions duck-type: `if (typeof pg.methodName === 'function') return pg.methodName(...)` and fall through to raw SQL only when a real `pg.Pool` is passed (which only the gateway does).

**GatewayClient** (`src/gateway/client.js`) is the only persistence interface the MCP uses. It implements typed methods — `getCurrentVersion()`, `insertVersion()`, `writeAuditEntry()`, etc. — that map to the gateway's `/pg/*` REST API. Its `query()` method throws intentionally.

**Identity:** Resolved once per session (from JWT in gateway mode). Never accepted as tool input — server-side only.

**Skill:** Install with `npm run skill:install` from repo root. Installs to `~/.claude/skills/quorum/SKILL.md`.

---

## Non-Negotiable Rules (enforced by constitutional tests)

| Rule | Location |
|------|----------|
| No hard delete | `src/graph/client.js` BLOCKED_METHODS |
| Audit append-only | `src/audit/pipeline.js` |
| Reason ≥ 10 chars | `src/tools/remember.js`, `src/tools/forget.js` |
| No self-approval | `src/tools/review.js` |
| Claude writes → DRAFT | `src/tools/remember.js` storeFirst() |
| `triggered_by` always set | Schema enforcement |
