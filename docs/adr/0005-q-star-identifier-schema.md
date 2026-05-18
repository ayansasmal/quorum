# ADR-0005: q_* Identifier Schema

**Status:** Accepted  
**Date:** 2026-05-16  
**Deciders:** Platform team

---

## Context

**Requirement:** Knowledge must be addressable in a stable, human-readable way
(topic:key) while also supporting efficient database operations that require
surrogate keys (FR-01, FR-07).

The original schema used `(project_id, topic, key)` as a composite primary key
for `knowledge_versions`. This created three problems:

1. **Verbosity** — every query carried three WHERE clauses; foreign keys were
   three-column composites
2. **Rename fragility** — renaming a topic or key required updating every version
   row, every audit link, and every pending decision
3. **No stable identity** — the `project_id` was the human-readable group slug
   (e.g. `'amethyst-munchkin'`), making cross-project references brittle if
   the project was renamed

## Decision

A three-level identifier hierarchy with sequence-backed surrogate keys:

```
q_p{n}          Project identifier       e.g. q_p1, q_p42
q_k{n}          Knowledge entry key      e.g. q_k198
q_k{n}_v{m}     Version identifier       e.g. q_k198_v3
q_c{n}          Conflict identifier      e.g. q_c7
```

These IDs are generated server-side from PostgreSQL sequences (`q_project_seq`,
`q_key_seq`, `q_conflict_seq`). Clients never construct them directly.

### Table structure

```
q_projects  (q_project_id PK, group_id UNIQUE, display_name, owner, ...)
q_keys      (q_key_id PK, q_project_id FK, topic, key, UNIQUE(q_project_id, topic, key))
knowledge_versions (version_id PK = q_key_id + '_v' + version, q_key_id FK, version INT, ...)
```

`topic` and `key` are denormalised onto `knowledge_versions` for display purposes only.
All structural queries use `q_key_id` or `version_id`.

### Resolution flow

The gateway routes are the only place where `(topic, key)` is resolved to `q_key_id`.
The `resolveKey()` helper calls `getOrCreateKey()` which does an `INSERT ... ON CONFLICT DO UPDATE`
— meaning the `q_key_id` is created on first reference and stable thereafter.

All downstream SQL (version queries, audit links, pending decisions) uses `q_key_id`.
All MCP-facing interfaces (tool inputs, GatewayClient HTTP URLs) use `(topic, key)`.
The gateway route layer is the translation boundary.

### Version ID construction

`version_id = q_key_id + '_v' + version_number`

For example, `q_k198_v3` is version 3 of entry `q_k198`. This compound form is
the PRIMARY KEY of `knowledge_versions` and is used in `version_audit_links` and
`forward_link` JSONB references.

The version number is a monotonically increasing integer per `q_key_id`, not
a global sequence. Version 1 is always the first version of a given entry.

### Project header resolution

Clients may send either the human-readable `group_id` slug or the `q_project_id`
in the `X-Quorum-Project` header. The gateway detects which form:

```js
// Fast path: already a q_project_id
if (/^q_p\d+$/.test(header)) {
  req.user.qProjectId = header
}
// Slow path: resolve slug → q_project_id via DB
else {
  req.user.qProjectId = await getProjectByGroupId(pool, header)
}
```

## Consequences

**Positive:**
- Renaming a topic or key is a single UPDATE on `q_keys` — all version rows are
  unaffected (they use `q_key_id`)
- Foreign keys are single-column integers — simpler indexes, faster JOINs
- The `q_p{n}` / `q_k{n}` prefixes make it immediately obvious what type of ID
  a value is when reading logs or query output
- `version_id` can be reconstructed from `(q_key_id, version)` without a DB lookup

**Negative:**
- Two ID systems must be kept consistent: the human-readable `(topic, key)` used
  by clients and the `q_*` IDs used by the DB
- `resolveKey()` must be called at every route handler that accepts `(topic, key)` —
  missing this call is a latent bug (it would pass `undefined` to SQL)
- The `getOrCreateKey()` insert creates a `q_keys` row even for read-only queries,
  which means a `recall()` on a non-existent key creates an orphan row

**Required by this decision:**
- All gateway pg.js route handlers that accept `:topic` and `:key` parameters MUST
  call `resolveKey()` before any SQL operation
- MCP clients must never construct `q_key_id` or `version_id` themselves — these
  are server-generated and returned in response bodies
- `storePendingConflictCheck` and other paths that call `insertVersion` must capture
  the returned `version_id` and `q_key_id` for audit link threading
