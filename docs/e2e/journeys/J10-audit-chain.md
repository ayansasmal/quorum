# J10 — Audit Chain Integrity

**Scenario ID:** S-10
**Weight:** 19.5 (13 raw leaves × F1.5)
**Blast radius:** 2.1% of suite
**Frequency tier:** F1.5 (periodic — chain integrity checked on scheduled compliance runs)
**Spec file:** `tests/e2e/scenarios/10-audit-chain.spec.js`

---

## What It Covers

The SHA256 tamper-evident audit chain that backs every knowledge write. Every `remember()` call
produces exactly two audit entries (INTENT + OUTCOME). Chain positions are sequential with no
gaps. Each entry's `prev_hash` links to the preceding entry's `entry_hash`. The audit timeline
in the dashboard renders the entries correctly.

**Roles:** `test-pe`
**Touches:** `POST /pg/versions`, `GET /pg/audit/lineage/:topic/:key`, direct DB query (chain positions + hashes), `/audit` page
**Automated:** Yes — API + DB inspection + Playwright

---

## Setup

Note the current chain length before starting:
```javascript
const startStats = await GET('/pg/audit/stats')
const startChainLength = startStats.total_entries
```

---

## Steps

1. Write 3 knowledge entries in sequence as `test-pe`:
   - `infra:chain-test-a` — "First entry for audit chain test"
   - `infra:chain-test-b` — "Second entry for audit chain test"
   - `infra:chain-test-c` — "Third entry for audit chain test"
   - Each write produces 2 audit entries (INTENT + OUTCOME) = 6 new entries total

2. `GET /pg/audit/stats`
   - Assert: `total_entries == startChainLength + 6`

3. `GET /pg/audit/lineage/infra/chain-test-b`
   - Assert: lineage chain present
   - Assert: entries linked bidirectionally (each entry references both its version and audit siblings)
   - Assert: INTENT and OUTCOME entries present for `infra:chain-test-b`

4. Direct PostgreSQL query — chain position continuity:
   ```sql
   SELECT chain_position FROM audit_log
   WHERE chain_position > $startPosition
   ORDER BY chain_position ASC
   ```
   - Assert: positions are consecutive integers (no gaps, no duplicates)
   - Assert: exactly 6 new positions (one per audit entry)

5. Direct PostgreSQL query — hash chain integrity:
   ```sql
   SELECT entry_hash, prev_hash, chain_position
   FROM audit_log
   WHERE chain_position > $startPosition
   ORDER BY chain_position ASC
   ```
   - Assert: for each entry at position N, `prev_hash == entry_hash` of entry at position N-1
   - Assert: the entire new segment forms an unbroken hash chain

6. Navigate to `/audit` as `test-pe`
   - Assert: audit timeline visible with entries in reverse-chronological order
   - Assert: the 3 new knowledge writes appear with `tool`, `author`, and `timestamp`
   - Assert: click on one entry → expanded detail shows `governance_json` and `outcome_json` content

---

## Pass Criteria

- [ ] Every `remember()` call produces exactly 2 audit entries (INTENT + OUTCOME)
- [ ] Chain positions are sequential integers — no gaps after 3 concurrent writes
- [ ] No duplicate chain positions
- [ ] Each `prev_hash` matches the `entry_hash` of the immediately preceding entry
- [ ] Lineage endpoint returns complete bidirectional audit trail for a topic:key
- [ ] Audit timeline page shows new entries in correct order with correct fields
- [ ] Expanded audit entry shows governance_json and outcome_json

---

## Teardown

```javascript
// Remove infra:chain-test-a, infra:chain-test-b, infra:chain-test-c
// Audit entries remain — audit log is append-only (no teardown of audit rows)
```

---

## Notes

**Chain positions are append-only.** This scenario does not attempt to delete or modify audit entries.
Any test that detects a gap in chain positions is a critical failure — it indicates either
a missed write, a deletion, or a race condition in the chain-position allocation.

The direct DB query in step 5 is intentional — the API layer cannot expose the raw hash values
(doing so would enable crafted tampering proofs). Only the integrity *result* is exposed via API;
the actual hashes require DB access to verify.
