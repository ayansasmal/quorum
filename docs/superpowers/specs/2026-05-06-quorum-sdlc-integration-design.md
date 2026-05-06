# Quorum SDLC Integration — Hooks + Skill Design Spec

**Date:** 2026-05-06  
**Status:** Draft  
**Branch:** feat/dashboard  

---

## Problem Statement

Quorum's `SKILL.md` is comprehensive and correct, but enforcement is entirely discipline-dependent. Claude only consults Quorum when it explicitly invokes the skill. In practice this means:

- Sessions start without loading Quorum context
- `reflect()` gets skipped or forgotten at session end
- Knowledge is never captured before commits
- Conflicts surface late or not at all

The goal is to make Quorum an always-present, automatically enforced part of the engineering SDLC — without touching project `CLAUDE.md`, without per-project manual configuration, and without adding complexity that degrades day-to-day engineering flow.

---

## Design Principles

1. **Hooks observe. Skills decide.** Hook scripts are domain-agnostic — they emit raw signals (file names, staged files, task descriptions). Claude reads those signals and applies intelligence. No domain inference in bash.
2. **Degrade gracefully.** If Quorum is unavailable, hooks emit nothing harmful. Engineering work is never blocked.
3. **Self-limiting by design.** All hooks check `[ -f ".quorum" ] || exit 0` first. Silent everywhere except Quorum-connected projects.
4. **One install, full enforcement.** `npm install -g @as-quorum/mcp` installs everything. No manual steps.
5. **Push and pull.** Hooks enforce knowledge flowing *into* Quorum. The skill protocol enforces knowledge flowing *from* Quorum before decisions.

---

## Architecture

```
npm install -g @as-quorum/mcp
  └── postinstall.js
        ├── ~/.claude/skills/quorum/SKILL.md         (updated)
        ├── ~/.claude/skills/quorum/references/      (unchanged)
        ├── ~/.claude/hooks/quorum-*.sh              (5 new scripts)
        └── ~/.claude/settings.json                  (hooks merged in)

Session lifecycle:
  UserPromptSubmit → quorum-session-start.sh → [QUORUM: session_start_required]
       │                                              │
       │                                    SKILL: pending() + search()
       │
  Write/Edit code → (skill self-check) → search() + recall() before write
       │
  TodoWrite completed → quorum-task-complete.sh → [QUORUM: task-completed]
       │                                                  │
       │                                       SKILL: extract knowledge candidates
       │
  Write memory/*.md → quorum-knowledge-source.sh → [QUORUM: knowledge-source-updated]
  Write CLAUDE.md   →          │                           │
                               │                  SKILL: single-file discovery
       │
  git commit → quorum-pre-commit.sh → [QUORUM: pre-commit] + staged file list
       │                                        │
       │                             SKILL: capture + reflect() before commit
       │
  Turn ends → quorum-stop.sh → [QUORUM: N files changed — reflect?]  (if needed)
                                           │
                                  SKILL: offer reflect(), touch .quorum-reflected
```

---

## Components

### 1. SKILL.md Updates

Three targeted changes to `~/.claude/skills/quorum/SKILL.md`:

#### 1a. Frontmatter description — "ALWAYS invoke"

```yaml
description: >
  ALWAYS invoke at session start for any engineering task in a
  Quorum-connected project (.quorum file present). Primary knowledge
  source — consult before implementation decisions. Non-negotiable.
  Skip only for pure read sessions with no decisions made.
```

This makes `using-superpowers` discipline treat Quorum the same as `brainstorming` and `systematic-debugging` — mandatory, not optional.

#### 1b. "Responding to Hook Signals" section (~20 lines)

Added after the Quick Reference section. Maps each hook signal to an existing protocol:

| Signal | Action |
|--------|--------|
| `[QUORUM: session_start_required]` | Run full session-start protocol (pending + search). Touch `/tmp/.quorum-session-YYYYMMDD-{project}` when done. Delete `.quorum-reflected` if it exists (stale from prior session). |
| `[QUORUM: pre-commit]` + staged files | Run capture protocol for staged files. Call `reflect()`. Touch `.quorum-reflected`. |
| `[QUORUM: task-completed]` + description | Run single-task knowledge extraction. Batch candidates. Present for confirmation. |
| `[QUORUM: knowledge-source-updated]` + file | Run single-file discovery on that file only. Batch candidates. Present for confirmation. |
| `[QUORUM: N files changed — reflect?]` | Offer `reflect()`. If accepted, run it and touch `.quorum-reflected`. |

#### 1c. Pull-side protocol tightening (~10 lines)

New rule added to "During Task — Proactive Knowledge Use":

> Before any `Write` or `Edit` tool call: ask — "am I about to touch something that might have Quorum knowledge?" If yes (auth, payments, security, core patterns, anything familiar from this session's `search()` results) — run `recall()` first. If recalled knowledge conflicts with what you are about to write — stop and surface the conflict. This check is non-negotiable for sensitive domains.

---

### 2. Hook Scripts

All hooks: `[ -f ".quorum" ] || exit 0` as the first line. All are non-blocking (`exit 0` always). All output ≤2 lines.

#### `quorum-session-start.sh` — UserPromptSubmit

```bash
#!/bin/bash
[ -f ".quorum" ] || exit 0
TODAY=$(date +%Y%m%d)
if [ -f ".quorum-session" ]; then
  [ "$(cat .quorum-session)" = "$TODAY" ] && exit 0
fi
echo "$TODAY" > .quorum-session
echo "[QUORUM: session_start_required]"
echo "Project: $(cat .quorum 2>/dev/null | head -1)"
```

- Fires on every user message
- Silent once `.quorum-session` contains today's date
- New calendar day = new session automatically
- Project-local — scoped exactly to this repo, no OS temp directory differences

#### `quorum-stop.sh` — Stop

```bash
#!/bin/bash
[ -f ".quorum" ] || exit 0
[ -f ".quorum-reflected" ] && exit 0
CHANGES=$(git diff --name-only HEAD 2>/dev/null | wc -l | tr -d ' ')
[ "$CHANGES" -lt "3" ] && exit 0
echo "[QUORUM: $CHANGES file(s) changed — reflect() before ending session?]"
```

- Fires after every Claude turn
- Silent once `.quorum-reflected` exists
- Silent for <3 file changes (prevents noise on small edits)
- `.quorum-reflected` is deleted by the skill after a new session starts

#### `quorum-pre-commit.sh` — PreToolUse: Bash(git commit*)

```bash
#!/bin/bash
[ -f ".quorum" ] || exit 0
STAGED=$(git diff --cached --name-only 2>/dev/null | head -10)
[ -z "$STAGED" ] && exit 0
echo "[QUORUM: pre-commit]"
echo "staged: $(echo $STAGED | tr '\n' ' ')"
```

- Fires before every `git commit` bash command
- Passes staged file names to Claude
- Non-blocking — informational only

#### `quorum-task-complete.sh` — PostToolUse: TodoWrite

```bash
#!/bin/bash
[ -f ".quorum" ] || exit 0
# NOTE: exact env var name for tool output must be confirmed against
# Claude Code hook documentation during implementation
echo "$CLAUDE_TOOL_OUTPUT" | grep -q '"completed"' || exit 0
echo "[QUORUM: task-completed]"
echo "extract knowledge from recently completed task(s)"
```

- Fires when a TodoWrite call results in a completed task
- Skill decides what's worth extracting from the task description

#### `quorum-knowledge-source.sh` — PostToolUse: Write/Edit

```bash
#!/bin/bash
[ -f ".quorum" ] || exit 0
# NOTE: exact env var name for file path must be confirmed against
# Claude Code hook documentation during implementation
FILE="${CLAUDE_TOOL_INPUT_FILE_PATH:-}"
case "$FILE" in
  *memory/*.md|**/CLAUDE.md|*/CLAUDE.md)
    echo "[QUORUM: knowledge-source-updated]"
    echo "file: $FILE"
    ;;
  *)
    exit 0
    ;;
esac
```

- Fires only on memory files and CLAUDE.md writes
- Silent for all other writes (plan docs, code, configs)
- Plan docs excluded intentionally — false starts problem

---

### 3. postinstall.js

Runs automatically on `npm install -g @as-quorum/mcp`. Does three things:

1. **Copies skill files** — `SKILL.md` + `references/` → `~/.claude/skills/quorum/`
2. **Copies hook scripts** — `hooks/*.sh` → `~/.claude/hooks/`, sets `chmod +x`
3. **Merges hook wiring** into `~/.claude/settings.json` — reads existing config, adds Quorum hooks without touching other entries, writes back

```javascript
// Safe merge — never overwrites existing hook config
function mergeHooks(existing, quorumHooks) {
  const merged = { ...existing };
  for (const [event, handlers] of Object.entries(quorumHooks)) {
    merged[event] = [
      ...(existing[event] || []).filter(h => !h.id?.startsWith('quorum-')),
      ...handlers
    ];
  }
  return merged;
}
```

The `id` field on each hook entry allows safe re-install and upgrade without duplicating entries.

**Upgrade story:** `npm update -g @as-quorum/mcp` → postinstall runs → skill, hooks, and settings all updated atomically.

---

### 4. Flag Files

| File | Purpose | Location | Lifecycle |
|------|---------|----------|-----------|
| `.quorum-session` | Session-start dedup | Project root | Contains `YYYYMMDD` string; overwritten each new calendar day |
| `.quorum-reflected` | Reflect dedup | Project root | Created by skill after reflect(); deleted at next session-start |

Both added to `.gitignore`.

---

## Coverage Map

| SDLC Moment | Mechanism | Enforcement |
|-------------|-----------|-------------|
| Session start | `UserPromptSubmit` hook + skill description | Automatic — fires before first response |
| Before implementation decision | SKILL.md pull-protocol + `using-superpowers` "ALWAYS" | Discipline-enforced via superpowers |
| Task/stage completion | `PostToolUse: TodoWrite` hook | Automatic — fires on every completed task |
| memory/CLAUDE.md written | `PostToolUse: Write/Edit` hook | Automatic — fires on authoritative source writes |
| Before commit | `PreToolUse: git commit` hook | Automatic — fires before every commit |
| Session end | `Stop` hook | Automatic — soft nudge when files changed |

---

## Performance Impact

| Hook | Cost per fire | Fires per session | Total |
|------|--------------|-------------------|-------|
| `UserPromptSubmit` | <1ms shell + 1× session-start (3-5 HTTP) | Once | ~3-5s once |
| `Stop` | ~5ms (git diff) | Every turn, mostly silent | Negligible |
| `PreToolUse` git commit | ~5ms + reflect() (1-3 HTTP) | Per commit | ~2-3s per commit |
| `PostToolUse` TodoWrite | <1ms + remember() × N | Per task completion | ~1s per task |
| `PostToolUse` Write/Edit | <1ms + remember() × N | memory/CLAUDE.md writes only | ~1s per write |

**Total session overhead:** ~15-25 seconds spread across natural SDLC boundaries (session start, commits, task completions). Not in the critical path for any coding turn.

---

## Failure Modes and Mitigations

| Failure | Impact | Mitigation |
|---------|--------|-----------|
| Gateway/Graphiti down | Hook signals cause failed Quorum tool calls, noisy session | SKILL.md: if unreachable → log to `.quorum-offline.log`, skip silently, never block |
| Session flag corruption | Session-start runs on every message | `.quorum-session` contains date string — hook compares, overwrites on mismatch. Corrupt file = stale date = new session triggered = self-healing. |
| Stop hook fires every turn | Constant reflect nudges in short-burst sessions | ≥3 files threshold + `.quorum-reflected` flag suppresses after first reflect |
| Pre-commit capture slow | Engineer waits 30s before commit lands | Hook is always `exit 0` — informational only, never hard-blocks commit |
| TodoWrite false positives | Trivial task completions trigger extraction | Skill decides what's extractable — hook is unconditional signal only |
| Context pollution from multiple signals | Multiple [QUORUM:*] blocks fill context | Each hook outputs ≤2 lines. Skill batches into one response. |
| Partial install | Skill installed, hooks not wired | postinstall is atomic. Adds verification: checks hook files exist and settings.json contains hook entries. |
| Hook script silent failure | Bash error → no signal → no enforcement | `set -e` in all scripts. postinstall dry-tests each script after install. |
| CI/CD environment | Gateway not running → tools fail | `.quorum` not present in CI → all hooks silent. CI pipelines unaffected. |

---

## What This Does Not Solve

1. **Mid-turn passive validation** — no hook fires between tool calls within a single Claude turn. The pull-protocol in SKILL.md covers this via discipline, not automation.
2. **Engineers who never install the MCP** — zero enforcement. Acceptable — Quorum is opt-in by design.
3. **Multi-agent flag file collisions** — two agents in the same project directory can race on `.quorum-reflected`. Out of scope for v0.3; Quorum's `group_id` isolation handles graph-level safety.

---

## Files Changed

| File | Change |
|------|--------|
| `mcp/src/install/postinstall.js` | New — install skill, hooks, wire settings |
| `mcp/hooks/quorum-session-start.sh` | New |
| `mcp/hooks/quorum-stop.sh` | New |
| `mcp/hooks/quorum-pre-commit.sh` | New |
| `mcp/hooks/quorum-task-complete.sh` | New |
| `mcp/hooks/quorum-knowledge-source.sh` | New |
| `mcp/package.json` | Add `"postinstall": "node src/install/postinstall.js"` |
| `quorum/SKILL.md` (source) | Update frontmatter + hook signals section + pull-protocol |
| `.gitignore` | Add `.quorum-session` and `.quorum-reflected` |

> `quorum/SKILL.md` is the source file in this repo. `postinstall.js` copies it to `~/.claude/skills/quorum/SKILL.md` on install.
