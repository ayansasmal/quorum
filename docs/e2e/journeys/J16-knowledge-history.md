# J16 — Knowledge History & Point-in-Time Recall

**Scenario ID:** S-16
**Weight:** 18 (12 raw leaves × F1.5)
**Blast radius:** 1.9% of suite
**Frequency tier:** F1.5 (periodic — history consulted during incident review, compliance audits, and onboarding)
**Spec file:** `tests/e2e/scenarios/16-knowledge-history.spec.js`

---

## What It Covers

Two gateway routes that expose the full version timeline of a knowledge entry:

- `GET /pg/versions/:topic/:key/history` — all versions (newest first) with status, author, timestamps, superseding reasons
- `GET /pg/versions/:topic/:key/at?date=ISO` — point-in-time recall: what was the active version on a given date?

These are the HTTP-testable layer of the `history()` MCP tool. The MCP tool additionally merges Graphiti SUPERSEDES edges (evolution chain from the semantic graph) — that enrichment is covered by **MT-07** (MCP client test).

History is the feature that answers: "What did Quorum know about auth when this incident happened?" Point-in-time recall is used in incident post-mortems, compliance audits, and PR blame analysis.

**Roles:** `test-pe`
**Touches:** `GET /pg/versions/:topic/:key/history`, `GET /pg/versions/:topic/:key/at`, `POST /api/knowledge`, `POST /api/knowledge/:t/:k/supersede`, `POST /api/knowledge/:t/:k/deprecate`
**Automated:** Yes — API

---

## Setup

No prior state. Uses `uid()` keys per sub-test to avoid state leakage.

---

## Steps

### Part A — History on a single-version entry

1. PA writes `infra:history-v1` via `POST /api/knowledge`:
   - `content: "Baseline infrastructure pattern — single deployment region."`
   - Assert: `status: "ACTIVE"`, `version: 1`, `author: "test-pe"`

2. `GET /pg/versions/infra/history-v1/history`
   - Assert: `200`, array with exactly 1 entry
   - Assert: `versions[0].version: 1`, `versions[0].status: "ACTIVE"`
   - Assert: `versions[0].author: "test-pe"`, `versions[0].created_at` present (not null)
   - Assert: `versions[0].triggered_by` present (not null — always set per constitutional requirement)
   - Assert: `versions[0].supersedes_reason: null` (no supersede yet)
   - Assert: `versions[0].superseded_by_version: null`

---

### Part B — History after supersede (two versions, correct order)

3. PA supersedes `infra:history-v1` with updated content:
   - `reason: "Extended to multi-region after DR requirement in Q3"`
   - Assert: `version: 2`, `status: "ACTIVE"`

4. `GET /pg/versions/infra/history-v1/history`
   - Assert: `200`, array has exactly 2 entries
   - Assert: **newest first** — `versions[0].version: 2`, `versions[1].version: 1`
   - Assert: `versions[0].status: "ACTIVE"`, `versions[1].status: "SUPERSEDED"`
   - Assert: `versions[0].supersedes_reason: "Extended to multi-region after DR requirement in Q3"` (reason preserved)
   - Assert: `versions[1].superseded_by_version: 2` (back-reference from old version to the new one)
   - Assert: `versions[1].superseded_at` present (timestamp of transition)

---

### Part C — History after deprecation

5. PA writes `infra:history-dep` and then deprecates it:
   - Write: `POST /api/knowledge` → assert `ACTIVE`
   - Deprecate: `POST /api/knowledge/infra/history-dep/deprecate`
     - `reason: "Pattern removed — replaced by managed platform service"`
   - Assert deprecate succeeds: `200`

6. `GET /pg/versions/infra/history-dep/history`
   - Assert: `200`, response has at least 1 entry
   - Assert: the entry with the highest version number has `status: "DEPRECATED"`
   - Assert: `deprecated_at` (or `supersedes_reason`) present on the final version

---

### Part D — History on nonexistent key

7. `GET /pg/versions/infra/does-not-exist-s16/history`
   - Assert: `200`, empty array `[]`
   - (Note: `getOrCreateKey` is called internally — this creates the key row in `q_keys`
     but returns no version rows since no knowledge has been written)

---

### Part E — Point-in-time recall: before supersede

8. Record the timestamp `t_before` (now).

9. PA writes `infra:history-point-in-time`:
   - `content: "Original content — written before the supersede"`
   - Assert: `ACTIVE`, `version: 1`

10. Record the timestamp `t_after_v1` (now, after write).

11. Wait 1 second (ensures `t_after_v1 < created_at_of_v2`).

12. PA supersedes with new content:
    - `content: "Updated content — supersedes the original"`, `reason: "Architecture evolved"`
    - Assert: `ACTIVE`, `version: 2`

13. `GET /pg/versions/infra/history-point-in-time/at?date=<t_after_v1>`
    - Assert: `200`
    - Assert: response content matches v1 content (`"Original content — written before the supersede"`)
    - Assert: `status: "ACTIVE"` at that point in time (v2 hadn't been written yet)

14. `GET /pg/versions/infra/history-point-in-time/at?date=<t_before>`
    - Assert: `200` with `null` body OR `404` — no version existed at that time

15. `GET /pg/versions/infra/history-point-in-time/at` (missing `date` param):
    - Assert: `400` with `error: "date query param required"`

---

## Pass Criteria

- [ ] Single-version history returns 1 entry with correct fields
- [ ] `triggered_by` is always present — never null (constitutional invariant)
- [ ] After supersede: 2 entries returned, newest first
- [ ] Ordering: `versions[0]` is always the highest version number
- [ ] Old version has `superseded_by_version` back-reference
- [ ] Old version has `superseded_at` timestamp
- [ ] Superseding `reason` preserved on the new version
- [ ] After deprecation: highest version entry is `DEPRECATED`
- [ ] Nonexistent key returns `200 []` (empty array, not 404)
- [ ] Point-in-time recall returns v1 content when queried at a time after v1 but before v2
- [ ] Point-in-time recall at a time before any write returns `null` or `404`
- [ ] Missing `date` param returns `400 date query param required`

---

## Teardown

```javascript
// infra:history-v1, infra:history-dep, infra:history-point-in-time
// infra:does-not-exist-s16 key row (created by getOrCreateKey)
```

---

## Manual Tests

| Test | Why manual | ID |
|------|------------|-----|
| `history()` MCP Graphiti SUPERSEDES edge enrichment | Requires MCP client (stdio) — the HTTP route only returns PostgreSQL data; the MCP tool additionally merges Graphiti SUPERSEDES edges from `getEvolutionChain()` | MT-07 |
| `export()` MCP tool (markdown / confluence format output) | No gateway HTTP route — tool queries PostgreSQL + Graphiti directly in the MCP process | MT-05 |
| `set_agent_context` gate (write blocked until context set) | Module-level state in MCP process — no HTTP equivalent; requires MCP client test | MT-06 |

---

## Related Scenarios

- **S-02.3** (Resolve: supersede) — verifies the supersede transition; J16 verifies the history record of that transition
- **S-10** (Audit chain) — verifies INTENT + OUTCOME audit entries; J16 verifies version timeline records
- **S-12** (State machine) — verifies valid/invalid transitions; J16 verifies the historical record of those transitions
