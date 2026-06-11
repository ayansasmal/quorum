# Contributing to Quorum

Welcome. Quorum is early-stage OSS and contributions are very welcome — especially around the governance layer, which is the hard part nobody has solved well.

---

## Philosophy First

Before contributing, understand the core design invariants. These are non-negotiable:

1. **Never hard delete** — always supersede with reason
2. **Never silent conflict resolution** — always notify, always log
3. **Always require reason for deprecation** — enforced, not optional
4. **Provenance on every write** — author + timestamp + source, always
5. **Human at genuine forks** — don't automate away human judgment
6. **Versioning is immutable** — remember() creates new versions, never edits in place
7. **triggered_by always set** — every version knows what workflow created it
8. **Audit ↔ version bidirectional** — every version references its audit entry and vice versa
9. **One ACTIVE per topic:key** — atomic state transition, never two ACTIVE simultaneously
10. **Draft by default for Claude** — Claude additions never auto-activate, ever

If a contribution violates any of these, it won't be merged regardless of how well it's implemented.

---

## What We Need Help With

**High priority:**
- Versioning edge cases (concurrent writes, version ordering under load)
- Governance logic improvements (conflict detection accuracy, authority weighting)
- Graphiti integration edge cases
- Test coverage for governance layer
- FalkorDB and Neo4j integration testing

**Medium priority:**
- Export format improvements (Confluence markup quality)
- Skill improvements (better post-task reflection prompts)
- Performance optimisation of conflict detection
- Documentation and examples

**Not currently needed:**
- New graph database backends (wait for v1.0)
- Consumer UI (this is a developer tool)
- Features that remove human governance

---

## Getting Started

```bash
git clone https://github.com/yourusername/quorum
cd quorum
npm install

# Start local stack
docker-compose up -d

# Run tests
npm test

# Start dev server
npm run dev
```

---

## Project Structure

```
src/
  tools/       → MCP tool implementations (one file per tool)
  governance/  → Conflict detection, authority, provenance, confidence
  graph/       → Graphiti client wrapper and schema
  export/      → Markdown and Confluence exporters

skill/
  SKILL.md     → Claude Code skill file

tests/
  governance/  → Unit tests for governance logic
  tools/       → Integration tests for MCP tools
```

---

## Testing Requirements

Quorum has three testing layers. Each has different rules.

**Layer 1 — Constitutional Tests (non-negotiable):**
- 100% coverage required — no exceptions
- Must cover direct violations, privilege escalation, indirect bypasses, race conditions
- Cannot be skipped — CI guard job enforces this
- PRs touching `src/governance/constitutional.js` must update tests

**Layer 2 — Governance Tests:**
- >90% coverage required
- Behavioural tests — does the logic produce correct outcomes?
- Edge cases acceptable to miss, but document them

**Layer 3 — LLM Tests:**
- Add to golden dataset for any new conflict detection cases you discover
- Adversarial cases especially welcome
- Production failures that become test cases are the most valuable contribution

See TESTING.md for full specifications.

---

## Commit Convention

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/). Husky enforces this via a `commit-msg` hook backed by commitlint.

| Type | Semver effect |
|---|---|
| `feat:` | minor bump |
| `fix:`, `perf:` | patch bump |
| `BREAKING CHANGE:` footer | major bump |
| `refactor:`, `docs:`, `chore:`, `test:`, `ci:`, `style:` | no bump |

**If you use nvm**, create `~/.config/husky/init.sh` so husky can find `node` inside git hooks (husky v9 runs hooks in a restricted shell):

```bash
mkdir -p ~/.config/husky
cat > ~/.config/husky/init.sh << 'EOF'
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
EOF
```

## Releasing

Releases are cut by the repo maintainer using:

```bash
npm run release:dry   # preview — shows what would be bumped and what CHANGELOG entries
npm run release       # auto-detect bump from commits since last tag
npm run release:minor # force minor bump regardless of commit types
git push --follow-tags origin main
```

`npm run release` bumps `package.json` and `gateway/package.json` together, appends `CHANGELOG.md`, and creates a git commit + tag (`v0.x.y`) in one step.

---

## Submitting Changes

1. Open an issue first for non-trivial changes — alignment before code
2. Branch from `main`
3. Write tests — governance logic especially must be tested
4. Keep PRs focused — one concern per PR
5. Update relevant `.md` docs if architecture changes

---

## Governance Logic Contributions

The governance layer is the most important and most sensitive part of Quorum. When contributing here:

- Every conflict detection change needs test cases covering: no conflict, soft conflict, hard conflict, edge cases
- Authority weighting changes need clear rationale — why does this produce better outcomes?
- Do not make human escalation less likely without strong justification
- Conflict resolution outcomes must always be stored — never discard

---

## Licence

Apache 2.0. Your contributions are also Apache 2.0.
