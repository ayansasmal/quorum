# Contributing to Engram

Welcome. Engram is early-stage OSS and contributions are very welcome — especially around the governance layer, which is the hard part nobody has solved well.

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
git clone https://github.com/yourusername/engram
cd engram
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

Engram has three testing layers. Each has different rules.

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

## Submitting Changes

1. Open an issue first for non-trivial changes — alignment before code
2. Branch from `main`
3. Write tests — governance logic especially must be tested
4. Keep PRs focused — one concern per PR
5. Update relevant `.md` docs if architecture changes

---

## Governance Logic Contributions

The governance layer is the most important and most sensitive part of Engram. When contributing here:

- Every conflict detection change needs test cases covering: no conflict, soft conflict, hard conflict, edge cases
- Authority weighting changes need clear rationale — why does this produce better outcomes?
- Do not make human escalation less likely without strong justification
- Conflict resolution outcomes must always be stored — never discard

---

## Licence

Apache 2.0. Your contributions are also Apache 2.0.
