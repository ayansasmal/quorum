# Onboarding a Local Project to Quorum

> This guide walks you through connecting an existing local project to a running Quorum
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
3. Pointing the Quorum MCP server at your project
4. Installing the Quorum skill in your project so Claude Code uses it automatically

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
  // Unique identifier for this project — used as the S3 key and the graph group_id.
  // Use lowercase letters, numbers, and hyphens only. No spaces.
  "project": "my-project",
  "group_id": "my-project",

  // Everyone on the team who will use Quorum.
  // github_username must match exactly — the gateway verifies it against GitHub.
  "members": [
    {
      "name": "alice",
      "team": "platform",
      "role": "principal_architect",
      "github_username": "alice-gh",
      "git_email": "alice@example.com"
    },
    {
      "name": "bob",
      "team": "backend",
      "role": "senior_engineer",
      "github_username": "bob-gh",
      "git_email": "bob@example.com"
    }
  ],

  // Role definitions — controls base confidence weight for each role.
  // You can add or remove roles. Every role used in `members` must appear here.
  "roles": {
    "principal_architect": { "base_confidence": 0.90 },
    "senior_engineer":     { "base_confidence": 0.80 },
    "engineer":            { "base_confidence": 0.70 },
    "junior":              { "base_confidence": 0.60 }
  },

  // Domain-specific overrides (optional).
  // Omit a domain to use the global thresholds below.
  // required_reviewer_teams: changes to this domain must be reviewed by someone
  //   from at least one of these teams before the knowledge becomes ACTIVE.
  "domains": {
    "auth": {
      "conflict_threshold": 0.90,
      "required_reviewer_teams": ["platform"]
    }
  },

  // Global governance thresholds.
  // conflict_threshold: semantic similarity above which two knowledge nodes are
  //   flagged as potentially conflicting (0–1). Start at 0.85.
  // authority_threshold: authority delta above which a conflict is auto-resolved
  //   in favour of the higher-authority author (0–1). Start at 0.20.
  "thresholds": {
    "conflict_threshold": 0.85,
    "authority_threshold": 0.20
  }
}
```

> **Tip:** Keep `conflict_threshold` at 0.85 until you have real knowledge in the graph.
> You can tune it once you see what kinds of false positives (or missed conflicts)
> your team produces.

---

## Step 2 — Validate the config

Before uploading, validate the config against the Quorum schema:

```bash
curl -s -X POST http://localhost:3001/config/validate \
  -H "Content-Type: application/json" \
  -d @quorum.config.json | python3 -m json.tool
```

A valid config returns:

```json
{
  "valid": true,
  "summary": {
    "project": "my-project",
    "members": 2,
    "roles": 4,
    "domains": 1,
    "member_names": ["alice", "bob"],
    "role_names": ["principal_architect", "senior_engineer", "engineer", "junior"],
    "domain_names": ["auth"],
    "thresholds": { "conflict": 0.85, "authority": 0.20 }
  }
}
```

If `valid` is `false`, the response includes a list of `errors` with paths and messages.
Fix them before continuing.

---

## Step 3 — Upload the config to S3

The gateway reads project configs from an S3 bucket at the key
`<project_id>/config.json`. For local development, the bucket lives in LocalStack.

```bash
# Upload using awslocal (LocalStack-aware AWS CLI wrapper)
awslocal s3 cp quorum.config.json \
  s3://quorum-configs/my-project/config.json \
  --endpoint-url http://localhost:4566
```

> **Don't have `awslocal`?**
> ```bash
> pip install awscli-local
> ```

Verify the upload:

```bash
awslocal s3 ls s3://quorum-configs/ --recursive --endpoint-url http://localhost:4566
# 2026-01-01 00:00:00   1234 my-project/config.json
```

**Production / real S3:** replace `awslocal` with `aws` and omit `--endpoint-url`:
```bash
aws s3 cp quorum.config.json s3://your-quorum-bucket/my-project/config.json
```

---

## Step 4 — Verify the config by logging in

Open the dashboard and sign in with GitHub OAuth to confirm your config was uploaded
correctly and your membership is recognised:

1. Open **http://localhost:3002** in your browser
2. Click **Sign in with GitHub** — completes the OAuth flow automatically
3. Enter your `project_id` when prompted on first login
4. If login succeeds, your config is valid and your `github_username` is recognised

That's it — no personal access tokens, no manual token exchange. The dashboard handles
the full OAuth flow and issues a short-lived ES256 JWT scoped to your project.

> **If login fails with "Member not found":** your `github_username` in the config
> doesn't match your actual GitHub username. Edit the config and re-upload it (Step 3),
> then try again.

---

## Step 5 — Connect Claude Code

### 5a — Authenticate via GitHub OAuth (CLI login with Playwright)

Authentication is GitHub OAuth — no personal access tokens needed.
Use the `mcp-playwright` MCP server to open the dashboard, complete the
GitHub login, and extract your OAuth token automatically.

Ask Claude to run the following flow (or run it yourself if you have
Playwright wired up directly):

```
1. Open http://localhost:3001/auth/github?project_id=<your_project_id>
2. Wait for the GitHub OAuth page to load and log in
3. After GitHub redirects back, the URL will contain:
     http://localhost:3002/login#oauth=gho_<token>&project_id=<id>
4. Extract the oauth token from the URL fragment
5. Export it as QUORUM_GITHUB_TOKEN
```

With `mcp-playwright`, Claude does this automatically:

```
Ask Claude:
  "Log me into Quorum for project my-project.
   Open http://localhost:3001/auth/github?project_id=my-project,
   complete the GitHub login, extract the oauth token from the URL
   fragment, and set QUORUM_GITHUB_TOKEN in my shell profile."
```

Claude will use Playwright to open the browser, wait for you to approve
the GitHub OAuth screen, then read `window.location.hash` to extract the
token and write it to `~/.zshrc` (or whichever shell profile you use).

Once extracted, set it in your shell:

```bash
export QUORUM_GATEWAY_URL=http://localhost:3001
export QUORUM_GITHUB_TOKEN=gho_<extracted_token>
```

> **Note:** `gho_` tokens are GitHub OAuth access tokens — they work
> identically to PATs at the `/auth/token` endpoint. They expire when you
> revoke the Quorum OAuth App from your GitHub account settings.

> **Security note:** Engineers only need the gateway URL and their OAuth
> token. They never handle PostgreSQL credentials, S3 keys, or the graph
> database password — those are held exclusively by the gateway.

### 5b — Add Quorum to Claude Code

```bash
# Replace /path/to/quorum with your actual clone path
claude mcp add quorum -- node /path/to/quorum/src/server.js
```

Verify Claude can see the tools:

```bash
claude mcp list
```

You should see `quorum` with tools: `remember`, `recall`, `search`, `reflect`,
`history`, `export`, `forget`, `review`.

### 5c — Install the Quorum skill in your project

The skill file tells Claude Code *when* and *how* to use Quorum's tools automatically
(session-start protocol, reflect after tasks, etc.).

```bash
# From inside your project directory
mkdir -p .claude/skills
cp /path/to/quorum/skill/SKILL.md .claude/skills/quorum.md
```

Commit this file to your project repo so the whole team gets it:

```bash
git add .claude/skills/quorum.md
git commit -m "chore: add Quorum skill for governed engineering memory"
```

---

## Step 6 — Verify the connection

Start a new Claude Code session in your project directory and ask:

```
What pending Quorum decisions are there?
```

Claude should call `pending()` and respond with either a list of pending decisions
or "No pending items — ready to start."

Then try storing a knowledge node:

```
Remember that we use cursor-based pagination for all list endpoints.
Topic: api, key: pagination-strategy.
Author: alice, confidence: 0.85.
```

And retrieve it:

```
Recall api:pagination-strategy
```

If both round-trip correctly, Quorum is fully wired to your project.

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

Each engineer sets `QUORUM_GATEWAY_URL` and, on first dashboard login, selects
their `project_id`. The gateway scopes all graph and audit operations to that project
automatically via the `group_id` claim in the JWT.

```bash
# Alice — set gateway URL, then open the dashboard and select project-alpha
export QUORUM_GATEWAY_URL=http://localhost:3001

# Bob — same gateway URL, selects project-beta in the dashboard
export QUORUM_GATEWAY_URL=http://localhost:3001
```

Knowledge, conflicts, audit logs, and pending decisions are all scoped per project.
There is no cross-project bleed.

---

## Dashboard access

The Quorum dashboard shows all knowledge, pending decisions, and audit logs for
your project:

1. Open **http://localhost:3002** in your browser
2. Click **Sign in with GitHub** — this uses the same OAuth flow
3. On first login, enter your `project_id` when prompted

The dashboard reads the `project` claim from your JWT and automatically scopes
all queries to your project's knowledge graph.

---

## Troubleshooting

**`Config not found` when fetching JWT**

The gateway couldn't find your config in S3. Check:
```bash
awslocal s3 ls s3://quorum-configs/<project_id>/ --endpoint-url http://localhost:4566
```
If empty, re-run the upload in Step 3.

**`Member '<github_username>' not found in project`**

Your GitHub username (as returned by `GET https://api.github.com/user`) doesn't
match any `github_username` in the config. Check your config and re-upload.

**Config changes not reflected after re-upload**

The gateway caches configs in memory. Easiest fix — restart the gateway:
```bash
docker compose restart gateway
```
Or, if you have a JWT from the dashboard (visible in browser devtools → Application → Local Storage):
```bash
curl -X POST http://localhost:3001/config/<project_id>/invalidate \
  -H "Authorization: Bearer <jwt_from_dashboard>"
```

**MCP server can't reach the gateway**

```bash
# Check QUORUM_GATEWAY_URL is set in the shell Claude Code runs in
echo $QUORUM_GATEWAY_URL

# Test the gateway is reachable
curl http://localhost:3001/health
```

**Knowledge is visible across projects**

Check that `group_id` in your config matches `project` — they should be identical.
If they diverge, the JWT carries one value but the graph search uses another.

---

## Summary

| Step | Command / Action |
|------|-----------------|
| 1. Create config | `cp quorum.config.example.json quorum.config.json` + edit |
| 2. Validate | `curl -X POST localhost:3001/config/validate -d @quorum.config.json` |
| 3. Upload | `awslocal s3 cp quorum.config.json s3://quorum-configs/<id>/config.json` |
| 4. Verify config | Open http://localhost:3002 → Sign in with GitHub → confirm project loads |
| 5. CLI auth | Ask Claude: open `/auth/github?project_id=<id>` via Playwright → extract `gho_` token → `QUORUM_GITHUB_TOKEN` |
| 6. MCP | `export QUORUM_GATEWAY_URL=http://localhost:3001` then `claude mcp add quorum -- node /path/to/quorum/src/server.js` |
| 7. Skill | `cp skill/SKILL.md <your-project>/.claude/skills/quorum.md` |
| 8. Verify | Ask Claude: `"What pending Quorum decisions are there?"` |

---

## Next steps

- [QUICKSTART.md](QUICKSTART.md) — Get Quorum itself running (if not already)
- [skill/SKILL.md](skill/SKILL.md) — How Claude Code uses Quorum tools during sessions
- [ARCHITECTURE.md](ARCHITECTURE.md) — How governance, versioning, and conflict resolution work
- [DEPLOYMENT.md](DEPLOYMENT.md) — Helm / production deployment
