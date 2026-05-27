# J20 — Cross-Catalog Search and Source Attribution

**Scenario ID:** S-20
**Weight:** 64 (16 raw leaves × F4)
**Blast radius:** 5.2% of suite (recalculated against 1231 suite total)
**Frequency tier:** F4 (core agent workflow — `search()` fires on every agent write/read;
cross-catalog scope is active on every search call in a federated project)
**Pillar:** Federation Correctness — C 1.0, D 1.5, OwnScore 96
**Spec file:** `tests/e2e/scenarios/20-cross-catalog-search.spec.js`

---

## What It Covers

End-to-end coverage of `GET /api/search`, the federated knowledge search route that
searches across a project's local knowledge and all linked global catalogs in a single
request. This scenario verifies the full contract: query validation, result field shape,
cross-catalog scope (federation), project isolation, DRAFT exclusion, domain filtering,
and mixed-source attribution in a single result set.

**Why this matters:** The `search()` MCP tool is the primary discovery mechanism Claude
uses before making implementation decisions. If cross-catalog scope is broken, Claude
silently misses org-wide standards stored in global catalogs and may violate them without
knowing. If source attribution is wrong, `deviate()` calls will reference the wrong
`catalog_id`.

**Roles:** `test-pe` (reads from `quorum-test-project` and `quorum-test-isolated-project`)
**Touches:** `GET /api/search`, PostgreSQL ILIKE fallback, Graphiti semantic search,
`knowledge_versions`, `q_projects`, `q_keys`
**Automated:** Yes — API (relies on PostgreSQL ILIKE path for instant consistency;
`uid()`-suffixed tokens appear verbatim in `summary` column, bypassing Graphiti lag)

---

## Setup

Two fixture projects are required (both seeded by `globalSetup`):

| Project | `globals` | Notes |
|---------|-----------|-------|
| `quorum-test-project` | `["quorum-test-catalog"]` | Standard project with one linked global catalog |
| `quorum-test-isolated-project` | _(none)_ | Project with no `globals` — permanently project-scoped |
| `quorum-test-catalog` | N/A (`is_global: true`) | The global catalog entries come from here |

`test-pe` (principal_architect) is a member of all three projects. The `tokens.pe` JWT
is scoped to `quorum-test-project` by default; per-test API clients switch project via
the `api(token, project)` helper.

All keys are `uid()`-suffixed for run-to-run isolation — no teardown required.

The file uses `test.describe.configure({ mode: 'serial' })` because S-20.3's `beforeAll`
seeds a global entry that S-20.4 and S-20.7 must also find. Serial mode guarantees
ordering and prevents parallel-worker isolation races.

---

## Steps

### S-20.1 — Query Validation

1. `GET /api/search` (no `q` param):
   - Assert: `400`, `error: 'query_required'`

2. `GET /api/search?q=` (empty string):
   - Assert: `400`, `error: 'query_required'`

3. `GET /api/search?q=x` (single character, minimum is 2):
   - Assert: `400`, `error: 'query_required'`

4. `GET /api/search?q=au` (valid, ≥ 2 chars):
   - Assert: `200`, `results` is an array, top-level `source` field is a string

---

### S-20.2 — Result Field Shape

**Setup:** seed one ACTIVE entry in `quorum-test-project` (PA write → ACTIVE directly).

5. `GET /api/search?q=<token>`:
   - Assert: `200`, at least 1 result matching the seeded key
   - Assert: each result has all 11 fields: `topic`, `key`, `entity_type`, `summary`,
     `tags` (array), `confidence`, `score`, `author`, `updated_at`, `source`, `catalog_id`
   - Assert: `source` is `'project'` (local entry in `quorum-test-project`)
   - Assert: `catalog_id` is `null` (no catalog attribution for project-local entries)

6. Response `source` indicator:
   - Assert: top-level `res.data.source` is one of `['graphiti', 'postgres', 'graphiti+postgres']`

---

### S-20.3 — Cross-Catalog Scope

**Setup:** seed an ACTIVE entry directly in `quorum-test-catalog` (PA write; `test-pe`
is a catalog member).

7. Search from `quorum-test-project` (which has `globals: ['quorum-test-catalog']`):
   - Assert: global catalog entry appears in results

8. Same search — source attribution:
   - Assert: `entry.source === 'global'`
   - Assert: `entry.catalog_id === 'quorum-test-catalog'`

---

### S-20.4 — Scope Isolation

**Setup:** re-uses the global entry seeded in S-20.3 (guaranteed available in serial mode).

9. Search from `quorum-test-isolated-project` using the broad `'s07-global'` token prefix:
   - Assert: `200`
   - Assert: no result has `source === 'global'` (isolated project must never see catalog entries)

10. Seed a local entry in `quorum-test-isolated-project`, then search for it:
    - Assert: local entry appears in results
    - Assert: `entry.source === 'project'`
    - Assert: `entry.catalog_id === null`

---

### S-20.5 — DRAFT Exclusion

**Setup:** engineer writes an entry (→ DRAFT) in `quorum-test-project`.

11. Search for the DRAFT entry's unique token:
    - Assert: `200`, entry is **absent** from results (status filter excludes DRAFT)

12. Confirm DRAFT exists via `GET /api/drafts`:
    - Assert: entry appears in drafts list with `status: 'DRAFT'` (not missing from DB)

---

### S-20.6 — Domain Filter

**Setup:** seed one entry in `topic: 'auth'` and one in `topic: 'reliability'`, both
containing the same unique `domainToken` so the base query matches both.

13. `GET /api/search?q=<domainToken>&domain=auth`:
    - Assert: auth entry present (`entry.topic === 'auth'`)
    - Assert: reliability entry absent (different topic, filtered out)

14. `GET /api/search?q=<domainToken>&domain=nonexistent-topic-xyz`:
    - Assert: neither entry appears

---

### S-20.7 — Mixed Sources

**Setup:** seed one entry in `quorum-test-project` (local) and one in `quorum-test-catalog`
(global), both containing the same unique `mixedToken`.

15. Search from `quorum-test-project`:
    - Assert: both entries appear in the same result set
    - Assert: local entry has `source: 'project'`
    - Assert: global entry has `source: 'global'`

16. Source-to-catalog_id mapping:
    - Assert: every result with `source === 'global'` has `catalog_id === 'quorum-test-catalog'`
    - Assert: every result with `source !== 'global'` has `catalog_id === null`

---

## Pass Criteria

- [ ] Missing `q` → `400 query_required`
- [ ] Empty `q` → `400 query_required`
- [ ] Single-char `q` → `400 query_required`
- [ ] Valid `q` (≥ 2 chars) → `200`, `results` array present, `source` string present
- [ ] Each result has all 11 fields (`topic`, `key`, `entity_type`, `summary`, `tags`, `confidence`, `score`, `author`, `updated_at`, `source`, `catalog_id`)
- [ ] Project-local entry: `source === 'project'`, `catalog_id === null`
- [ ] `res.data.source` is one of `['graphiti', 'postgres', 'graphiti+postgres']`
- [ ] Project with `globals` finds global catalog entries
- [ ] Global entry has `source === 'global'` and correct `catalog_id`
- [ ] Project without `globals` returns zero `source === 'global'` results
- [ ] DRAFT entries absent from search results
- [ ] DRAFT entry confirmed present in `/api/drafts` (not missing from DB)
- [ ] `?domain=<topic>` narrows to exact topic only
- [ ] `?domain=nonexistent` returns no results for seeded query
- [ ] Mixed-source result set contains both `source:'project'` and `source:'global'` entries
- [ ] All `source:'global'` results have `catalog_id` set; all others have `catalog_id === null`

---

## Teardown

No teardown required. All entries use `uid()`-suffixed keys for run-to-run isolation.
Entries persist in the E2E database (by design — volume is stable across runs).

---

## Notes

**PostgreSQL ILIKE strategy:** All write-then-read assertions rely on the PostgreSQL
ILIKE fallback path rather than Graphiti semantic search. Searching for the verbatim
`uid()`-suffixed token string in the `summary` column gives instant consistency without
waiting for FalkorDB vector indexing. `graphitiSettle()` is not called. This is by
design — the test validates the search contract, not the embedding pipeline.

**Stale header in spec file:** The spec file comment block header reads `S-07` on line 2
(a copy-paste artifact from an earlier draft). The correct scenario ID is S-20. The
`Journey: J20` annotation on line 4 is authoritative.

**Federation prerequisite:** S-20.3–S-20.4 and S-20.7 require `quorum-test-project` to
have `globals: ['quorum-test-catalog']` in its project config (uploaded during
`globalSetup`). If the config is missing or `globals` is empty, S-20.3 will fail with
a scope isolation false-pass (global entry absent when it should be present).

---

## Related Scenarios

- **S-07** (Conformance + portfolio) — also uses `quorum-test-catalog` fixture
- **S-05** (RBAC boundary) — `GLOBAL_WRITE_AUTHORITY` enforcement when non-members write to global catalog
- **S-21.2** (Requirement entity round-trip) — verifies `search()` returns `entity_type` correctly
- **S-13** (Config governance) — validates `globals` field acceptance in config schema
