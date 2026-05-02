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

1. Writing a `quorum.config.json` that describes the team (members, roles, domains)
2. Uploading that config to the S3 bucket the gateway reads from
3. Verifying your membership works via the dashboard
4. Connecting Claude Code to the gateway and installing the Quorum skill

All four steps take under 10 minutes.

---

## Step 1 — Create your project config

Copy the example config from the Quorum repo and edit it for your team:

```bash
# From inside your project directory
cp /path/to/quorum/quorum.config.example.json quorum.config.json
```

Edit `quorum.config.json`:

```jsonc
{
  // Unique identifier for this project — used as the S3 key prefix and the JWT group_id.
  // Use lowercase letters, numbers, and hyphens only. No spaces.
  "project": "my-project",
  "group_id": "my-project",

  // Everyone on the team who will use Quorum.
  // github_username must match exactly — the gateway verifies it against GitHub.
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

  // Role definitions — controls base confidence weight for each role.
  // Every role used in `members` must appear here.
  "roles": {
    "principal_architect": { "base_confidence": 0.90 },
    "senior_engineer":     { "base_confidence": 0.80 },
    "engineer":            { "base_confidence": 0.70 },
    "junior":              { "base_confidence": 0.60 }
  },

  // Domain-specific overrides (optional).
  // Omit a domain to use the global thresholds below.
  "domains": {
    "auth": {
      "conflict_threshold": 0.90
    }
  },

  // Global governance thresholds.
  // conflict_threshold: semantic similarity above which two nodes are flagged as
  //   potentially conflicting (0–1). Start at 0.85 and tune once you have real data.
  // authority_threshold: authority delta above which a conflict is auto-resolved
  //   in favour of the higher-authority author (0–1). Start at 0.20.
  "thresholds": {
    "conflict_threshold": 0.85,
    "authority_threshold": 0.20
  },

  // Set to true to allow any GitHub-authenticated user to browse this project's
  // knowledge in read-only guest mode (no authority, no writes).
  "guest_access": false
}
```

---

## Step 2 — Upload the config to S3

The gateway reads project configs from an S3 bucket at the key
`<project_id>/config.json`. For local development, the bucket lives in LocalStack.

```bash
awslocal s3 cp quorum.config.json \
  s3://quorum-configs/my-project/config.json
```

Verify the upload:

```bash
awslocal s3 ls s3://quorum-configs/ --recursive
# 2026-01-01 00:00:00  1234 my-project/config.json
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
aws s3 cp quorum.config.json s3://your-quorum-bucket/my-project/config.json
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

```bash
# Replace /path/to/quorum with your actual clone path
claude mcp add quorum -- node /path/to/quorum/src/server.js
```

Set the gateway URL in your shell profile so the MCP server knows where to send requests:

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

The MCP server needs its own JWT — separate from the dashboard session.
When Claude Code starts a session in a project that has the Quorum skill loaded,
it will detect a missing auth token and run the re-auth flow automatically:

1. It opens the GitHub OAuth URL in a browser window
2. You approve the GitHub login (one click if already logged in)
3. Claude extracts the `gho_` token and calls `authenticate({ github_token, project_id })`
4. The JWT is stored in-memory for the session

You can also trigger this manually:

```
Ask Claude: "Authenticate me with Quorum for project my-project."
```

> **Note:** The MCP server holds the JWT in memory only — it is never written to
> disk. If the MCP server process restarts, re-auth runs automatically on the next
> tool call.

### 4c — Install the Quorum skill (user-level)

The skill file tells Claude Code *when* and *how* to use Quorum's tools automatically —
session-start protocol, recall before decisions, reflect after tasks.

Install it at the **user level** so it is active in every project on your machine
without any per-repo setup:

```bash
mkdir -p ~/.claude/skills
cp /path/to/quorum/skill/SKILL.md ~/.claude/skills/quorum.md
```

That's all. No per-project changes, no commits needed. Every Claude Code session
on your machine now has the Quorum skill available.

> If you prefer project-level installation (e.g. to pin a specific skill version
> per repo), copy to `.claude/skills/quorum.md` inside the project instead and
> commit it.

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
  project-alpha/config.json     ← group_id: "project-alpha"
  project-beta/config.json      ← group_id: "project-beta"
  my-project/config.json        ← group_id: "my-project"
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
If `failed` contains your project ID, check the S3 key matches `<project_id>/config.json`.

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

Check that `project` and `group_id` in your config are identical — they must match.
If they diverge, the JWT carries one value but config lookups use another.

---

## Summary

| Step | Action |
|------|--------|
| 1. Create config | Edit `quorum.config.json` from the example |
| 2. Upload | `awslocal s3 cp quorum.config.json s3://quorum-configs/<id>/config.json` + sync |
| 3. Verify | Open `http://localhost:3002` → sign in → confirm your project card appears |
| 4. MCP | `claude mcp add quorum -- node /path/to/quorum/src/server.js` + `QUORUM_GATEWAY_URL` |
| 5. Skill | `cp skill/SKILL.md ~/.claude/skills/quorum.md` |
| 6. Verify | Ask Claude: `"What pending Quorum decisions are there?"` |

---

## Next steps

- [QUICKSTART.md](QUICKSTART.md) — Get Quorum itself running (if not already)
- [skill/SKILL.md](../skill/SKILL.md) — How Claude Code uses Quorum tools during sessions
- [ARCHITECTURE.md](ARCHITECTURE.md) — How governance, versioning, and conflict resolution work
- [DEPLOYMENT.md](DEPLOYMENT.md) — Helm / production deployment
