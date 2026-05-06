# Onboarding a Project to Quorum

> This guide walks you through connecting an existing project to a running Quorum
> stack so that Claude Code (or any MCP client) can read and write governed engineering
> knowledge scoped to your team.
>
> **Prerequisite:** Quorum is already running locally.
> If it isn't, complete [QUICKSTART.md](QUICKSTART.md) first.

---

## What "onboarding a project" means

Each project in Quorum is a **named namespace** (called a `group_id`) that isolates
its knowledge graph, audit log, and team configuration from other projects on the same
stack. Onboarding a project means:

1. Writing a `<group_id>.quorum.json` that describes the team (members, roles, domains)
2. Uploading that config to the S3 bucket the gateway reads from
3. Verifying your membership works via the dashboard
4. Connecting Claude Code to the gateway and installing the Quorum skill

All four steps take under 10 minutes.

---

## Step 1 — Create your project config

Copy the example config from the Quorum repo and edit it for your team:

```bash
# Replace my-project with your actual group_id
cp /path/to/quorum/example.quorum.json my-project.quorum.json
```

Edit `my-project.quorum.json`:

```json
{
  "$schema": "http://localhost:3001/schema/config",
  "group_id": "my-project",

  "members": [
    {
      "name": "Alice",
      "team": "platform",
      "role": "principal_architect",
      "github_username": "alice-gh",
      "git_email": "alice@example.com"
    },
    {
      "name": "Bob",
      "team": "backend",
      "role": "senior_engineer",
      "github_username": "bob-gh",
      "git_email": "bob@example.com"
    }
  ],

  "roles": {
    "principal_architect": { "base_confidence": 0.90 },
    "senior_engineer":     { "base_confidence": 0.80 },
    "engineer":            { "base_confidence": 0.70 },
    "junior":              { "base_confidence": 0.60 }
  },

  "domains": {
    "auth": {
      "conflict_threshold": 0.90
    }
  },

  "thresholds": {
    "conflict_threshold": 0.85,
    "authority_threshold": 0.20
  }
}
```

### Key fields

| Field | Required | Description |
|-------|----------|-------------|
| `group_id` | **Yes** | Canonical project ID — S3 key prefix, DDB primary key, JWT claim, Graphiti namespace. Lowercase letters, numbers, hyphens only. |
| `project` | No | Human-readable display name for the dashboard. Falls back to `group_id` if omitted. |
| `members` | No | Team roster. At least `github_username` or `git_email` needed per member for identity resolution. |
| `roles` | No | Base confidence floors per role. Any role in `members` not listed here defaults to `0.5`. |
| `domains` | No | Per-domain governance overrides — stricter `conflict_threshold` and `required_reviewer_teams`. |
| `thresholds` | No | Global conflict and authority thresholds. Defaults: `conflict_threshold: 0.85`, `authority_threshold: 0.20`. |
| `guest_access` | No | When `true`, any GitHub-authenticated user can browse in read-only guest mode. Default: `false`. |

### IDE validation and autocomplete

The gateway serves the full JSON Schema at `GET /schema/config`. Add the `$schema` key to
any config file to get inline autocomplete, hover docs, and red squiggles on invalid values
in VS Code, IntelliJ, and any editor backed by a JSON Language Server:

```json
{ "$schema": "http://localhost:3001/schema/config", "group_id": "my-project", ... }
```

In production, replace `localhost:3001` with your gateway's public URL. You can also validate
a config without uploading it:

```bash
curl -s -X POST http://localhost:3001/config/validate \
  -H "Content-Type: application/json" \
  -d @my-project.quorum.json | python3 -m json.tool
```

A valid config returns `{ "valid": true, "summary": { ... } }`. Errors return `{ "valid": false, "errors": [...] }`.

---

## Step 2 — Upload the config to S3

The gateway reads project configs from an S3 bucket using a flat key:
`<group_id>.quorum.json`. For local development, the bucket lives in LocalStack.

```bash
awslocal s3 cp my-project.quorum.json \
  s3://quorum-configs/my-project.quorum.json
```

Verify the upload:

```bash
awslocal s3 ls s3://quorum-configs/
# 2026-01-01 00:00:00  1234 my-project.quorum.json
```

Then trigger a gateway sync so the config is cached in DynamoDB immediately
(otherwise it picks up on the next restart). Use whichever auth you have:

```bash
# Option A — principal_architect JWT from your dashboard session
curl -s -X POST http://localhost:3001/sync/configs \
  -H "Authorization: Bearer <your-jwt>" | python3 -m json.tool

# Option B — static sync secret (if QUORUM_SYNC_SECRET is set in .env)
curl -s -X POST http://localhost:3001/sync/configs \
  -H "X-Quorum-Sync-Token: ${QUORUM_SYNC_SECRET}" | python3 -m json.tool
```

```json
{ "synced": 1, "failed": [], "duration_ms": 45 }
```

> If neither option is available, just restart the gateway:
> `docker compose restart gateway`

**Production / real S3:** replace `awslocal` with `aws`:
```bash
aws s3 cp my-project.quorum.json s3://your-quorum-bucket/my-project.quorum.json
```

---

## Step 3 — Verify your membership via the dashboard

Open the dashboard and sign in with GitHub OAuth to confirm the config was uploaded
correctly and your `github_username` is recognised:

1. Open **http://localhost:3002** in your browser
2. Click **Sign in with GitHub** — completes the OAuth flow automatically
3. Your project appears as a card in the project picker — click it to enter
4. If login succeeds you are now inside your project's workspace

> **If your project card doesn't appear:** the config wasn't synced yet — run the
> `POST /sync/configs` call from Step 2 again, then refresh.
>
> **If login fails with "not a member":** your `github_username` in the config
> doesn't exactly match your GitHub account username. Edit the config, re-upload
> (Step 2), and sync again.

---

## Step 4 — Connect Claude Code

### 4a — Add the Quorum MCP server

The MCP server is `@as-quorum/mcp` — a separate package from this repo:

```bash
# Recommended: one-step install (registers MCP + installs skill)
npx @as-quorum/mcp install

# Or — if running from a local quorum-mcp clone:
claude mcp add quorum -- node /path/to/quorum-mcp/dist/server.js
```

Set the gateway URL in your shell profile if the gateway isn't on `localhost:3001`:

```bash
# Add to ~/.zshrc or ~/.bashrc
export QUORUM_GATEWAY_URL=http://localhost:3001
```

Verify Claude can see the tools:

```bash
claude mcp list
# quorum: remember, recall, search, reflect, history, export, forget, review, pending, authenticate
```

### 4b — Authenticate the MCP server

The MCP server uses OAuth 2.1 + PKCE — no env vars needed. When Claude Code starts a
session with the Quorum skill loaded, it detects a missing auth token and runs the flow
automatically:

1. The gateway's `/.well-known/oauth-authorization-server` is discovered
2. A local callback server starts on a random ephemeral port
3. A browser window opens to the gateway's `/oauth/authorize` (redirects to GitHub)
4. You approve the GitHub login — the gateway exchanges the code, enriches with project config claims, and redirects back to the local callback
5. The MCP server completes the PKCE exchange and stores the ES256 JWT in-memory

You can also trigger this manually:

```
Ask Claude: "Authenticate me with Quorum for project my-project."
```

> **Note:** The JWT is stored in-memory only — never written to disk. If the MCP server
> process restarts, re-auth runs automatically on the next tool call.

### 4c — Install the Quorum skill (user-level)

The skill file tells Claude Code *when* and *how* to use Quorum's tools automatically —
session-start protocol, recall before decisions, reflect after tasks.

If you ran `npx @as-quorum/mcp install` in step 4a, the skill is already installed.
Otherwise, install it manually:

```bash
npx @as-quorum/mcp install --skip-mcp   # skill only (if MCP already registered)
```

That's all. No per-project changes, no commits needed. Every Claude Code session
on your machine now has the Quorum skill available.

> If you prefer project-level installation (e.g. to pin a specific skill version
> per repo), copy to `.claude/skills/quorum.md` inside the project instead and commit it.

---

## Step 5 — Verify the connection

Start a new Claude Code session in any project directory and ask:

```
What pending Quorum decisions are there?
```

Claude should call `pending()` and respond with either a list of pending decisions
or "No pending items — ready to start."

Then try storing a knowledge node:

```
Remember that we use cursor-based pagination for all list endpoints.
Topic: api, key: pagination-strategy.
Confidence: 0.85.
```

And retrieve it:

```
Recall api:pagination-strategy
```

If both round-trip correctly, Quorum is fully wired.

---

## Multi-project setup

You can onboard multiple projects to the same Quorum stack — each gets its own
isolated knowledge graph and team config. The gateway uses the `group_id` claim
in the JWT to scope all graph operations automatically.

```
s3://quorum-configs/
  project-alpha.quorum.json     ← group_id: "project-alpha"
  project-beta.quorum.json      ← group_id: "project-beta"
  my-project.quorum.json        ← group_id: "my-project"
```

The dashboard's project picker shows all projects your GitHub account has access to
(either as a member or as a guest if `guest_access: true`). You switch projects by
clicking **Switch Project** in the header — no re-authentication with GitHub required.

---

## Troubleshooting

**Project card not visible in the dashboard**

Run the sync and check it picked up your config:
```bash
curl -s -X POST http://localhost:3001/sync/configs \
  -H "Authorization: Bearer <your-jwt>" | python3 -m json.tool
```
If `failed` contains your project ID, check the S3 key matches `<group_id>.quorum.json`.

**"not a member" on login**

Your `github_username` in the config (case-sensitive) must match exactly what
`GET https://api.github.com/user` returns for your account:
```bash
curl -s -H "Authorization: Bearer <your_github_token>" \
  https://api.github.com/user | python3 -c "import sys,json; print(json.load(sys.stdin)['login'])"
```

**Config changes not reflected after re-upload**

The gateway caches configs in memory for 5 minutes. Trigger an immediate invalidation:
```bash
curl -s -X POST http://localhost:3001/sync/configs \
  -H "Authorization: Bearer <your-jwt>"
# or simply:
docker compose restart gateway
```

**MCP server can't reach the gateway**

```bash
echo $QUORUM_GATEWAY_URL          # must be set
curl http://localhost:3001/health  # must return {"status":"ok"}
```

**Knowledge visible across projects**

Check that `group_id` in your config matches the S3 key you uploaded to
(`s3://quorum-configs/<group_id>.quorum.json`). The JWT `project` claim is derived
from `group_id` — if they diverge, graph operations will target the wrong namespace.
The `project` field is display-only and has no effect on routing.

---

## Summary

| Step | Action |
|------|--------|
| 1. Create config | Copy `example.quorum.json` → `<group_id>.quorum.json`, edit for your team |
| 2. Upload | `awslocal s3 cp <group_id>.quorum.json s3://quorum-configs/<group_id>.quorum.json` + sync |
| 3. Verify | Open `http://localhost:3002` → sign in → confirm your project card appears |
| 4. MCP | `npx @as-quorum/mcp install` (registers MCP + skill) |
| 5. Skill | Included in step 4 — or `npx @as-quorum/mcp install --skip-mcp` |
| 6. Verify | Ask Claude: `"What pending Quorum decisions are there?"` |

---

## Next steps

- [QUICKSTART.md](QUICKSTART.md) — Get Quorum itself running (if not already)
- [quorum-mcp skill/SKILL.md](https://github.com/as-quorum/quorum-mcp/blob/prod/skill/SKILL.md) — How Claude Code uses Quorum tools during sessions
- [ARCHITECTURE.md](ARCHITECTURE.md) — How governance, versioning, and conflict resolution work
- [DEPLOYMENT.md](DEPLOYMENT.md) — Helm / production deployment
