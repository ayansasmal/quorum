# Quorum SDLC Integration — Hooks + Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire 5 Claude Code hooks and extend `quorum install` so that installing the MCP automatically enforces Quorum knowledge capture and validation across the full engineering SDLC.

**Architecture:** Hook scripts live in `quorum-mcp/hooks/`, are bundled with the npm package, and are installed to `~/.claude/hooks/` by the existing `quorum install` CLI command. A new `src/install/hooks.js` module handles settings.json merging (testable in isolation). The SKILL.md is updated to respond to hook signals and enforce pull-side protocol.

**Tech Stack:** Node.js ESM, bash, vitest, Claude Code hooks API (`~/.claude/settings.json`)

**Spec:** `docs/superpowers/specs/2026-05-06-quorum-sdlc-integration-design.md`

> **Working repo:** All file paths below are relative to `quorum-mcp/` unless prefixed with `engram/`.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `skill/SKILL.md` | Modify | Updated frontmatter + hook signals section + pull-protocol |
| `hooks/quorum-session-start.sh` | Create | Session-start enforcement (UserPromptSubmit) |
| `hooks/quorum-stop.sh` | Create | Reflect nudge (Stop) |
| `hooks/quorum-pre-commit.sh` | Create | Pre-commit knowledge gate (PreToolUse: Bash) |
| `hooks/quorum-task-complete.sh` | Create | Task completion extraction (PostToolUse: TodoWrite) |
| `hooks/quorum-knowledge-source.sh` | Create | Authoritative source extraction (PostToolUse: Write/Edit) |
| `src/install/hooks.js` | Create | Hook wiring logic — copies scripts, merges settings.json |
| `cli.js` | Modify | Extend `install` command to call hooks.js |
| `tests/install/hooks.test.js` | Create | Unit tests for hooks.js merge logic |
| `engram/.gitignore` | Modify | Add `.quorum-session`, `.quorum-reflected` |

---

## Task 1: Update SKILL.md

**Files:**
- Modify: `skill/SKILL.md`

- [ ] **Step 1: Update the frontmatter description**

Replace the existing `description:` block in the frontmatter (lines 2-5):

```yaml
---
name: quorum
description: >
  ALWAYS invoke at session start for any engineering task in a
  Quorum-connected project (.quorum file present). Primary knowledge
  source — consult before any implementation decision, architectural
  choice, or code change. Skip only for pure read sessions with no
  decisions made.
---
```

- [ ] **Step 2: Add "Responding to Hook Signals" section**

Insert this section immediately after the `## Quick Reference` section:

```markdown
## Responding to Hook Signals

Hooks inject `[QUORUM: ...]` signals into context automatically. When you see
one, act on it immediately — before responding to anything else.

| Signal | Action |
|--------|--------|
| `[QUORUM: session_start_required]` | Run full session-start protocol: `pending()` then `search()` for task domains. Touch `.quorum-session` with today's date. Delete `.quorum-reflected` if it exists (stale from prior session). |
| `[QUORUM: pre-commit]` + staged files | Run capture protocol for the staged files listed. Call `reflect()`. Touch `.quorum-reflected`. |
| `[QUORUM: task-completed]` | Run single-task knowledge extraction on the completed task description. Batch candidates, present for confirmation. Store approved ones with `remember()`. |
| `[QUORUM: knowledge-source-updated]` + file | Run single-file discovery on that file only. Batch candidates, present for confirmation. Do not full-project scan. |
| `[QUORUM: N file(s) changed — reflect?]` | Offer `reflect()`. If accepted, run it and touch `.quorum-reflected`. |

If Quorum is unreachable when acting on a signal: append a one-line note to
`.quorum-offline.log` (e.g. `2026-05-06 pre-commit signal — gateway unreachable`)
and continue without blocking. Never fail silently.
```

- [ ] **Step 3: Add pull-side protocol rule**

In the `## During Task — Proactive Knowledge Use` section, add this paragraph after the existing "Two-tool pattern" block:

```markdown
### Before any Write or Edit

Ask: "am I about to touch something that might have Quorum knowledge?" Apply
this check for any file related to auth, payments, security, core patterns, or
anything that surfaced in this session's `search()` results. If yes:

```
recall("topic", "key")
```

If recalled knowledge conflicts with what you are about to write → stop and
surface the conflict to the human. Do not write first and check later.
This check is non-negotiable for sensitive domains (auth, payments, security,
infra). For all other files, apply judgment.
```

- [ ] **Step 4: Verify the updated skill reads correctly**

```bash
head -10 skill/SKILL.md        # confirm frontmatter has ALWAYS invoke
grep -n "Hook Signals" skill/SKILL.md  # confirm section exists
grep -n "Before any Write" skill/SKILL.md  # confirm pull-protocol exists
```

Expected: all three grep commands return a line number.

- [ ] **Step 5: Commit**

```bash
git add skill/SKILL.md
git commit -m "feat(skill): enforce ALWAYS invoke, add hook signal handlers, tighten pull-protocol"
```

---

## Task 2: Create Hook Scripts

**Files:**
- Create: `hooks/quorum-session-start.sh`
- Create: `hooks/quorum-stop.sh`
- Create: `hooks/quorum-pre-commit.sh`
- Create: `hooks/quorum-task-complete.sh`
- Create: `hooks/quorum-knowledge-source.sh`

- [ ] **Step 1: Create the hooks directory**

```bash
mkdir -p hooks
```

- [ ] **Step 2: Write `quorum-session-start.sh`**

```bash
#!/usr/bin/env bash
# Fires on UserPromptSubmit. Emits session_start_required once per calendar day.
set -e
[ -f ".quorum" ] || exit 0
TODAY=$(date +%Y%m%d)
if [ -f ".quorum-session" ]; then
  [ "$(cat .quorum-session 2>/dev/null)" = "$TODAY" ] && exit 0
fi
echo "$TODAY" > .quorum-session
echo "[QUORUM: session_start_required]"
echo "Project: $(head -1 .quorum 2>/dev/null)"
```

- [ ] **Step 3: Write `quorum-stop.sh`**

```bash
#!/usr/bin/env bash
# Fires on Stop. Nudges reflect() when files changed and reflect not yet done.
set -e
[ -f ".quorum" ] || exit 0
[ -f ".quorum-reflected" ] && exit 0
CHANGES=$(git diff --name-only HEAD 2>/dev/null | wc -l | tr -d ' ')
[ "$CHANGES" -lt "3" ] && exit 0
echo "[QUORUM: ${CHANGES} file(s) changed — reflect() before ending session?]"
```

- [ ] **Step 4: Write `quorum-pre-commit.sh`**

```bash
#!/usr/bin/env bash
# Fires on PreToolUse: Bash. Emits pre-commit signal with staged file list.
# Hook script checks if the bash command is a git commit.
set -e
[ -f ".quorum" ] || exit 0
# CLAUDE_TOOL_INPUT contains the JSON input — check for git commit
INPUT="${CLAUDE_TOOL_INPUT:-}"
echo "$INPUT" | grep -q "git commit" || exit 0
STAGED=$(git diff --cached --name-only 2>/dev/null | head -10)
[ -z "$STAGED" ] && exit 0
echo "[QUORUM: pre-commit]"
echo "staged: $(echo "$STAGED" | tr '\n' ' ')"
```

> **Implementation note:** `CLAUDE_TOOL_INPUT` is the assumed env var name for the tool's
> JSON input in PreToolUse hooks. Verify against Claude Code hook documentation before
> shipping. If the actual var differs, update this script and `hooks.test.js` accordingly.

- [ ] **Step 5: Write `quorum-task-complete.sh`**

```bash
#!/usr/bin/env bash
# Fires on PostToolUse: TodoWrite. Emits task-completed when status is "completed".
set -e
[ -f ".quorum" ] || exit 0
# CLAUDE_TOOL_OUTPUT contains the tool's JSON output
OUTPUT="${CLAUDE_TOOL_OUTPUT:-}"
echo "$OUTPUT" | grep -q '"completed"' || exit 0
echo "[QUORUM: task-completed]"
echo "extract knowledge from recently completed task(s)"
```

> **Implementation note:** `CLAUDE_TOOL_OUTPUT` is the assumed env var for PostToolUse
> hook output. Verify against Claude Code hook documentation before shipping.

- [ ] **Step 6: Write `quorum-knowledge-source.sh`**

```bash
#!/usr/bin/env bash
# Fires on PostToolUse: Write/Edit. Emits knowledge-source-updated for
# memory files and CLAUDE.md only. Silent for all other writes.
set -e
[ -f ".quorum" ] || exit 0
# CLAUDE_TOOL_INPUT contains the JSON input — extract file_path
INPUT="${CLAUDE_TOOL_INPUT:-}"
FILE=$(echo "$INPUT" | grep -o '"file_path":"[^"]*"' | cut -d'"' -f4)
[ -z "$FILE" ] && exit 0
case "$FILE" in
  *memory/*.md|*/CLAUDE.md|*/CLAUDE.md)
    echo "[QUORUM: knowledge-source-updated]"
    echo "file: $FILE"
    ;;
  *)
    exit 0
    ;;
esac
```

- [ ] **Step 7: Make all scripts executable**

```bash
chmod +x hooks/quorum-session-start.sh
chmod +x hooks/quorum-stop.sh
chmod +x hooks/quorum-pre-commit.sh
chmod +x hooks/quorum-task-complete.sh
chmod +x hooks/quorum-knowledge-source.sh
```

- [ ] **Step 8: Smoke test each script locally**

```bash
# Test: silent when no .quorum file
cd /tmp && bash /path/to/quorum-mcp/hooks/quorum-session-start.sh
# Expected: no output, exit 0

# Test: fires when .quorum exists
cd /tmp && touch .quorum && bash /path/to/quorum-mcp/hooks/quorum-session-start.sh
# Expected: [QUORUM: session_start_required]

# Cleanup
rm -f /tmp/.quorum /tmp/.quorum-session
```

- [ ] **Step 9: Commit**

```bash
git add hooks/
git commit -m "feat(hooks): add 5 Claude Code hook scripts for SDLC integration"
```

---

## Task 3: Create Hook Wiring Module + Tests

**Files:**
- Create: `src/install/hooks.js`
- Create: `tests/install/hooks.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/install/hooks.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installHooks, QUORUM_HOOKS } from '../../src/install/hooks.js'

describe('installHooks', () => {
  let tmpDir, hooksDir, settingsPath

  beforeEach(() => {
    tmpDir = join(tmpdir(), `quorum-test-${Date.now()}`)
    hooksDir = join(tmpDir, 'hooks')
    settingsPath = join(tmpDir, 'settings.json')
    mkdirSync(hooksDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates settings.json with hook entries when file does not exist', () => {
    installHooks({ hooksDir, settingsPath, scriptsSrc: 'hooks' })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.hooks).toBeDefined()
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1)
    expect(settings.hooks.Stop).toHaveLength(1)
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    expect(settings.hooks.PostToolUse).toHaveLength(3)
  })

  it('merges hook entries into existing settings.json without destroying other config', () => {
    writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Bash(npm test:*)'] },
      theme: 'dark'
    }, null, 2))
    installHooks({ hooksDir, settingsPath, scriptsSrc: 'hooks' })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.permissions.allow).toContain('Bash(npm test:*)')
    expect(settings.theme).toBe('dark')
    expect(settings.hooks).toBeDefined()
  })

  it('does not duplicate hook entries on re-install', () => {
    installHooks({ hooksDir, settingsPath, scriptsSrc: 'hooks' })
    installHooks({ hooksDir, settingsPath, scriptsSrc: 'hooks' })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1)
    expect(settings.hooks.Stop).toHaveLength(1)
  })

  it('preserves non-quorum hook entries from existing settings', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{
          id: 'other-tool-hook',
          hooks: [{ type: 'command', command: 'bash ~/other.sh' }]
        }]
      }
    }, null, 2))
    installHooks({ hooksDir, settingsPath, scriptsSrc: 'hooks' })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const stopHooks = settings.hooks.Stop
    expect(stopHooks.some(h => h.id === 'other-tool-hook')).toBe(true)
    expect(stopHooks.some(h => h.id === 'quorum-stop')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp
npx vitest run tests/install/hooks.test.js
```

Expected: FAIL — `Cannot find module '../../src/install/hooks.js'`

- [ ] **Step 3: Write `src/install/hooks.js`**

```javascript
import { readFileSync, writeFileSync, cpSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const QUORUM_HOOKS = {
  UserPromptSubmit: [
    {
      id: 'quorum-session-start',
      hooks: [{ type: 'command', command: `bash ${join(homedir(), '.claude', 'hooks', 'quorum-session-start.sh')}` }]
    }
  ],
  Stop: [
    {
      id: 'quorum-stop',
      hooks: [{ type: 'command', command: `bash ${join(homedir(), '.claude', 'hooks', 'quorum-stop.sh')}` }]
    }
  ],
  PreToolUse: [
    {
      id: 'quorum-pre-commit',
      matcher: 'Bash',
      hooks: [{ type: 'command', command: `bash ${join(homedir(), '.claude', 'hooks', 'quorum-pre-commit.sh')}` }]
    }
  ],
  PostToolUse: [
    {
      id: 'quorum-task-complete',
      matcher: 'TodoWrite',
      hooks: [{ type: 'command', command: `bash ${join(homedir(), '.claude', 'hooks', 'quorum-task-complete.sh')}` }]
    },
    {
      id: 'quorum-knowledge-source',
      matcher: 'Write',
      hooks: [{ type: 'command', command: `bash ${join(homedir(), '.claude', 'hooks', 'quorum-knowledge-source.sh')}` }]
    },
    {
      id: 'quorum-knowledge-source-edit',
      matcher: 'Edit',
      hooks: [{ type: 'command', command: `bash ${join(homedir(), '.claude', 'hooks', 'quorum-knowledge-source.sh')}` }]
    }
  ]
}

/**
 * Installs hook scripts and merges hook wiring into Claude Code settings.json.
 * Safe to call multiple times — does not duplicate entries.
 *
 * @param {object} opts
 * @param {string} opts.hooksDir      - Destination for hook scripts (~/.claude/hooks)
 * @param {string} opts.settingsPath  - Path to Claude Code settings.json
 * @param {string} opts.scriptsSrc   - Source directory containing hook scripts
 */
export function installHooks({ hooksDir, settingsPath, scriptsSrc }) {
  // Copy hook scripts
  mkdirSync(hooksDir, { recursive: true })
  const scripts = [
    'quorum-session-start.sh',
    'quorum-stop.sh',
    'quorum-pre-commit.sh',
    'quorum-task-complete.sh',
    'quorum-knowledge-source.sh'
  ]
  for (const script of scripts) {
    const src = join(scriptsSrc, script)
    const dest = join(hooksDir, script)
    if (existsSync(src)) {
      cpSync(src, dest, { force: true })
      chmodSync(dest, 0o755)
    }
  }

  // Merge hook wiring into settings.json
  let settings = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch {
      settings = {}
    }
  }
  settings.hooks = mergeHooks(settings.hooks || {}, QUORUM_HOOKS)
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

function mergeHooks(existing, incoming) {
  const merged = { ...existing }
  for (const [event, handlers] of Object.entries(incoming)) {
    const existing_handlers = merged[event] || []
    // Remove stale quorum entries, preserve all others
    const non_quorum = existing_handlers.filter(h => !h.id?.startsWith('quorum-'))
    merged[event] = [...non_quorum, ...handlers]
  }
  return merged
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run tests/install/hooks.test.js
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/install/hooks.js tests/install/hooks.test.js
git commit -m "feat(install): add hook wiring module with merge-safe settings.json update"
```

---

## Task 4: Extend the Install Command

**Files:**
- Modify: `cli.js`

- [ ] **Step 1: Add the import for `installHooks` at the top of cli.js**

After the existing imports block (around line 11), add:

```javascript
import { installHooks } from './src/install/hooks.js'
```

- [ ] **Step 2: Add `--skip-hooks` option and hooks installation block**

In the `install` command (around line 100), add the `--skip-hooks` option and its handler. The full updated install command:

```javascript
program
  .command('install')
  .description('Install the Quorum skill, hooks, and register the MCP server with Claude Code')
  .option('--skip-mcp',   'Skip claude mcp add registration')
  .option('--skip-skill', 'Skip skill installation')
  .option('--skip-hooks', 'Skip Claude Code hook installation')
  .action(async (opts) => {
    if (!opts.skipSkill) {
      const skillSrc  = join(__dirname, 'skill')
      const skillDest = join(homedir(), '.claude', 'skills', 'quorum')
      try {
        mkdirSync(join(homedir(), '.claude', 'skills'), { recursive: true })
        cpSync(skillSrc, skillDest, { recursive: true, force: true })
        console.log(`✓ Skill installed → ${skillDest}`)
      } catch (err) {
        console.error(`✗ Skill install failed: ${err.message}`)
        process.exit(1)
      }
    }

    if (!opts.skipHooks) {
      const hooksDir     = join(homedir(), '.claude', 'hooks')
      const settingsPath = join(homedir(), '.claude', 'settings.json')
      const scriptsSrc   = join(__dirname, 'hooks')
      try {
        installHooks({ hooksDir, settingsPath, scriptsSrc })
        console.log(`✓ Hooks installed → ${hooksDir}`)
        console.log(`✓ Hook wiring merged → ${settingsPath}`)
      } catch (err) {
        console.error(`✗ Hook install failed: ${err.message}`)
        process.exit(1)
      }
    }

    if (!opts.skipMcp) {
      const result = spawnSync(
        'claude',
        ['mcp', 'add', 'quorum', '--', 'npx', '@as-quorum/mcp'],
        { stdio: 'inherit' },
      )
      if (result.status !== 0) {
        console.error('✗ MCP registration failed. Is the claude CLI installed?')
        console.error('  Run manually: claude mcp add quorum -- npx @as-quorum/mcp')
        process.exit(1)
      }
      console.log('✓ MCP server registered with Claude Code')
    }

    console.log('')
    console.log('Quorum is ready. Run `quorum init` in any project to connect it to a gateway.')
  })
```

- [ ] **Step 2: Run the install command locally to verify**

```bash
node cli.js install --skip-mcp
```

Expected output:
```
✓ Skill installed → /Users/<you>/.claude/skills/quorum
✓ Hooks installed → /Users/<you>/.claude/hooks
✓ Hook wiring merged → /Users/<you>/.claude/settings.json

Quorum is ready. Run `quorum init` in any project to connect it to a gateway.
```

- [ ] **Step 3: Verify files were created**

```bash
ls ~/.claude/hooks/quorum-*.sh
cat ~/.claude/settings.json | grep -A 5 '"hooks"'
```

Expected: 5 hook scripts listed. settings.json contains `"hooks"` with `UserPromptSubmit`, `Stop`, `PreToolUse`, `PostToolUse` entries.

- [ ] **Step 4: Verify re-install is idempotent**

```bash
node cli.js install --skip-mcp
cat ~/.claude/settings.json | python3 -c "import json,sys; s=json.load(sys.stdin); print(len(s['hooks']['Stop']))"
```

Expected: `1` — not `2`. Re-install does not duplicate entries.

- [ ] **Step 5: Commit**

```bash
git add cli.js
git commit -m "feat(cli): extend install command to wire Claude Code hooks"
```

---

## Task 5: Update .gitignore

**Files:**
- Modify: `engram/.gitignore`

- [ ] **Step 1: Add flag files to .gitignore**

Open `/Users/ayan/Desktop/Work/vscode/engram/.gitignore` and add at the end:

```
# Quorum session state (project-local, per-engineer)
.quorum-session
.quorum-reflected
.quorum-offline.log
```

- [ ] **Step 2: Verify**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram
echo "test" > .quorum-session
git status
```

Expected: `.quorum-session` does NOT appear in `git status` output.

```bash
rm .quorum-session
```

- [ ] **Step 3: Commit in the engram repo**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram
git add .gitignore docs/superpowers/specs/2026-05-06-quorum-sdlc-integration-design.md docs/superpowers/plans/2026-05-06-quorum-sdlc-integration.md
git commit -m "chore: gitignore quorum session state files; add SDLC integration spec and plan"
```

---

## Task 6: Integration Test

**No new files — manual verification in a Quorum-connected project.**

- [ ] **Step 1: Confirm hook scripts are installed and executable**

```bash
ls -la ~/.claude/hooks/quorum-*.sh
```

Expected: 5 files, all with execute permission (`-rwxr-xr-x`).

- [ ] **Step 2: Confirm settings.json hook wiring**

```bash
cat ~/.claude/settings.json | python3 -m json.tool | grep -A 3 "quorum"
```

Expected: entries for `quorum-session-start`, `quorum-stop`, `quorum-pre-commit`, `quorum-task-complete`, `quorum-knowledge-source`.

- [ ] **Step 3: Test session-start hook in a Quorum-connected project**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram   # has .quorum file
rm -f .quorum-session                        # reset state
bash ~/.claude/hooks/quorum-session-start.sh
```

Expected output:
```
[QUORUM: session_start_required]
Project: <content of .quorum first line>
```

- [ ] **Step 4: Test session-start deduplication**

```bash
bash ~/.claude/hooks/quorum-session-start.sh
```

Expected: no output (today's date already in `.quorum-session`).

- [ ] **Step 5: Test stop hook**

```bash
# Simulate files changed, no reflect yet
rm -f .quorum-reflected
bash ~/.claude/hooks/quorum-stop.sh
```

Expected: `[QUORUM: N file(s) changed — reflect() before ending session?]` (only if ≥3 files changed vs HEAD, otherwise silent).

- [ ] **Step 6: Test pre-commit hook**

```bash
# Simulate a staged file
touch /tmp/test-auth.js && git -C /tmp init -q && git -C /tmp add test-auth.js
CLAUDE_TOOL_INPUT='{"command":"git commit -m test"}' bash ~/.claude/hooks/quorum-pre-commit.sh
```

Expected: `[QUORUM: pre-commit]` + `staged: test-auth.js`.

- [ ] **Step 7: Test silent behaviour in non-Quorum project**

```bash
cd /tmp
bash ~/.claude/hooks/quorum-session-start.sh
```

Expected: no output (no `.quorum` file).

- [ ] **Step 8: Run full test suite to confirm nothing broken**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp
npm test
```

Expected: all existing tests pass + new `hooks.test.js` tests pass.

- [ ] **Step 9: Commit quorum-mcp final state**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp
git add .
git commit -m "feat: quorum SDLC integration — hooks + skill v1"
```

---

## Known Verification Items

Before shipping, confirm these against Claude Code documentation:

| Item | Location | What to verify |
|------|----------|---------------|
| `CLAUDE_TOOL_INPUT` env var name | `quorum-pre-commit.sh`, `quorum-knowledge-source.sh` | Actual env var name Claude Code uses for PreToolUse hook input |
| `CLAUDE_TOOL_OUTPUT` env var name | `quorum-task-complete.sh` | Actual env var name Claude Code uses for PostToolUse hook output |
| Hook settings.json `matcher` field | `src/install/hooks.js` | Whether `matcher` applies to PreToolUse/PostToolUse and exact format |
| `UserPromptSubmit` event name | `src/install/hooks.js` | Exact event name casing in Claude Code settings |

If any name differs from assumed: update the relevant hook script and `hooks.js` QUORUM_HOOKS constant together, re-run `npm test`, re-run `node cli.js install --skip-mcp`.
