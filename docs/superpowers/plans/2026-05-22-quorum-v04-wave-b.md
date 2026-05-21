# Quorum v0.4 Wave B — Federation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable cross-catalog reads so projects linked via `globals: [...]` can search and recall knowledge from global catalogs, and fix the critical governance gap where `detectConflict()` searches ALL projects instead of only the linked ones.

**Architecture:** Three layers of change — (1) fix `searchNodes` to correctly pass arrays of `groupIds`, (2) fix `detectConflict` to scope searches to `[projectId, ...globals]`, (3) update MCP tools (`search`, `recall`) and the gateway graphiti proxy to use config-driven globals instead of hardcoded `'global'` project IDs.

**Tech Stack:** Node.js, Express, Graphiti MCP (HTTP), PostgreSQL, Zod, vitest

---

## Critical Context Before Starting

**Both repos must be kept in sync.** Every file in `gateway/src/shared/` has a counterpart in `quorum-mcp/src/`. Changes to shared files (client.js, conflict.js) must be applied to BOTH.

**The detectConflict governance gap:** `detectConflict()` in both repos currently calls `searchNodes(newContent, { limit: 5 })` with NO groupId at all — it searches ALL Graphiti data globally. This means a project-local `remember()` could silently contradict a global catalog entry with no warning. Tasks B2 and B3 fix this and MUST ship atomically with the federation read changes (Task B4).

**Graphiti arguments vs params levels:** The gateway proxy currently sets `body.params.group_id` (at the MCP protocol params level). The actual MCP tool call format from `callGraphiti` puts `group_ids` inside `body.params.arguments`. Wave B must deep-copy `arguments` and modify `body.params.arguments.group_ids` to actually override what Graphiti uses.

**`normalizeGroupId`:** Replaces hyphens with underscores for RediSearch compatibility. Currently private in `client.js`. Must be exported so `conflict.js` can normalize group IDs when constructing the groupIds array.

---

## File Map

| File | Change |
|------|--------|
| `quorum-mcp/src/graph/client.js` | Export `normalizeGroupId`; fix `searchNodes`/`searchFacts` to accept `groupIds: string[]` array |
| `quorum-mcp/src/governance/conflict.js` | Add `projectId`+`globals` params to `detectConflict`; scope `searchNodes` call |
| `quorum-mcp/src/tools/remember.js` | Pass `projectId` + `getConfig()?.globals ?? []` to `detectConflict` |
| `quorum-mcp/src/tools/search.js` | Replace hardcoded `groupId: 'global'` with config-driven globals; add `catalog_id` annotation |
| `quorum-mcp/src/tools/recall.js` | Replace `projectId !== 'global'` check with globals loop; add `catalog_id` to XML output |
| `gateway/src/shared/graph/client.js` | Same as quorum-mcp client.js (vendored copy, must stay in sync) |
| `gateway/src/shared/governance/conflict.js` | Same as quorum-mcp conflict.js (vendored copy, must stay in sync) |
| `gateway/src/routes/graphiti.js` | Deep-copy `arguments`; inject multi-`group_ids` for read ops; load project config for globals |
| `gateway/src/routes/dashboard.js` | Add `GET /api/globals` endpoint |
| `gateway/src/routes/sync.js` | Add globals self-reference + is_global validation in `syncOneProject` and `syncAllConfigs` |
| `quorum-mcp/tests/governance/conflict.test.js` | Add tests for scoped detectConflict |
| `gateway/tests/gateway/shared-conflict.test.js` | Add tests for scoped detectConflict (new signature) |
| `gateway/tests/gateway/graphiti.test.js` | Add tests for multi-group_ids injection for read ops |
| `gateway/tests/gateway/sync.test.js` | Add globals validation tests |

---

## Task B1: Export `normalizeGroupId` and fix `searchNodes`/`searchFacts` (both repos)

The `searchNodes` function currently only uses the first element of a `groupIds` array: `options.groupIds?.[0]`. It needs to pass ALL group IDs so conflict detection and cross-catalog reads work correctly.

**Files:**
- Modify: `quorum-mcp/src/graph/client.js:47-49` and `:377-384` and `:396-402`
- Modify: `gateway/src/shared/graph/client.js` (same changes — vendored copy)

- [ ] **Step 1: Export `normalizeGroupId` in quorum-mcp/src/graph/client.js**

Change (line 47):
```javascript
function normalizeGroupId(id) {
```
To:
```javascript
export function normalizeGroupId(id) {
```

- [ ] **Step 2: Fix `searchNodes` to pass all group IDs**

Replace lines 377–384 in `quorum-mcp/src/graph/client.js`:
```javascript
export async function searchNodes(query, options = {}) {
  const groupId = options.groupId ?? options.groupIds?.[0]
  return callGraphiti('search_nodes', {
    query,
    max_nodes: options.limit ?? 10,
    ...(groupId ? { group_ids: [normalizeGroupId(groupId)] } : {}),
  })
}
```

With:
```javascript
/**
 * Search for knowledge nodes semantically.
 *
 * Accepts either a single groupId or an array of groupIds (e.g. project + linked globals).
 * All IDs are normalized (hyphen → underscore) for RediSearch compatibility.
 *
 * @param {string} query
 * @param {{ limit?: number, groupIds?: string[], groupId?: string }} [options]
 * @returns {Promise<{ nodes: Array<unknown> }>}
 */
export async function searchNodes(query, options = {}) {
  // Resolve to an array: options.groupIds takes precedence over single options.groupId
  const ids = options.groupIds ?? (options.groupId ? [options.groupId] : null)
  const normalizedIds = ids?.map(normalizeGroupId).filter(Boolean)
  return callGraphiti('search_nodes', {
    query,
    max_nodes: options.limit ?? 10,
    ...(normalizedIds?.length ? { group_ids: normalizedIds } : {}),
  })
}
```

- [ ] **Step 3: Fix `searchFacts` the same way**

Replace lines 396–402 in `quorum-mcp/src/graph/client.js`:
```javascript
export async function searchFacts(query, options = {}) {
  const groupId = options.groupId ?? options.groupIds?.[0]
  return callGraphiti('search_memory_facts', {
    query,
    ...(groupId ? { group_ids: [normalizeGroupId(groupId)] } : {}),
  })
}
```

With:
```javascript
/**
 * Search for relationships/edges across the knowledge graph.
 *
 * Accepts either a single groupId or an array of groupIds.
 * All IDs are normalized (hyphen → underscore) for RediSearch compatibility.
 *
 * @param {string} query
 * @param {{ groupIds?: string[], groupId?: string }} [options]
 * @returns {Promise<{ facts: Array<unknown> }>}
 */
export async function searchFacts(query, options = {}) {
  const ids = options.groupIds ?? (options.groupId ? [options.groupId] : null)
  const normalizedIds = ids?.map(normalizeGroupId).filter(Boolean)
  return callGraphiti('search_memory_facts', {
    query,
    ...(normalizedIds?.length ? { group_ids: normalizedIds } : {}),
  })
}
```

- [ ] **Step 4: Apply same changes to `gateway/src/shared/graph/client.js`**

Make identical changes to the vendored copy:
- Export `normalizeGroupId`
- Replace `searchNodes` with the multi-groupId version
- Replace `searchFacts` with the multi-groupId version

- [ ] **Step 5: Run tests to confirm no regressions**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp && npm test -- --reporter=verbose 2>&1 | tail -30
cd /Users/ayan/Desktop/Work/vscode/engram && npm test -- --reporter=verbose 2>&1 | tail -30
```

Expected: all tests pass (the change is backward compatible — single groupId still works via the `options.groupId ? [options.groupId] : null` fallback).

- [ ] **Step 6: Commit both repos**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp
git add src/graph/client.js
git commit -m "feat(graph): export normalizeGroupId; support groupIds array in searchNodes and searchFacts"

cd /Users/ayan/Desktop/Work/vscode/engram
git add gateway/src/shared/graph/client.js
git commit -m "feat(graph): export normalizeGroupId; support groupIds array in searchNodes and searchFacts"
```

---

## Task B2: Fix `detectConflict` scope in conflict.js (both repos)

**Critical governance fix.** The current `detectConflict` calls `searchNodes(newContent, { limit: 5 })` with NO groupId — it searches ALL Graphiti data. This allows a project-local write to go undetected if it contradicts a global catalog entry. The fix scopes the search to `[projectId, ...globals]`.

**Files:**
- Modify: `quorum-mcp/src/governance/conflict.js:156-166`
- Modify: `gateway/src/shared/governance/conflict.js:156-166`

- [ ] **Step 1: Add `normalizeGroupId` import to conflict.js (quorum-mcp)**

In `quorum-mcp/src/governance/conflict.js`, update the import from client.js:
```javascript
import { searchNodes, normalizeGroupId } from '../graph/client.js'
```

- [ ] **Step 2: Update `detectConflict` signature to accept `projectId` and `globals`**

Replace the function signature and `searchNodes` call in `quorum-mcp/src/governance/conflict.js`:

Current (line 156–166):
```javascript
export async function detectConflict(newContent, topic, key, domain, gw) {
  const conflictThreshold = getConflictThreshold(domain)

  let searchResult
  try {
    searchResult = await searchNodes(newContent, { limit: 5 })
  } catch {
```

Replace with:
```javascript
/**
 * Detect whether new content conflicts with existing knowledge.
 * Uses the domain-specific conflict threshold when available.
 * Returns { conflict: false } if no conflict detected.
 *
 * @param {string} newContent
 * @param {string} topic
 * @param {string} key
 * @param {string} [domain] - domain name for per-domain threshold lookup
 * @param {import('../gateway/client.js').GatewayClient} [gw]
 * @param {string} [projectId] - current project ID (used to scope search)
 * @param {string[]} [globals] - linked global catalog group_ids (raw, not normalized)
 * @returns {Promise<ConflictResult>}
 */
export async function detectConflict(newContent, topic, key, domain, gw, projectId, globals = []) {
  const conflictThreshold = getConflictThreshold(domain)

  // Build scoped group ID list: project + all linked global catalogs.
  // Normalizes hyphens to underscores for RediSearch compatibility.
  // Falls back to unscoped search if no projectId — same behavior as before v0.4.
  const groupIds = projectId
    ? [normalizeGroupId(projectId), ...globals.map(normalizeGroupId)]
    : undefined

  let searchResult
  try {
    searchResult = await searchNodes(newContent, { limit: 5, ...(groupIds ? { groupIds } : {}) })
  } catch {
```

- [ ] **Step 3: Apply same changes to `gateway/src/shared/governance/conflict.js`**

Make identical changes to the vendored copy:
- Update import: `import { searchNodes, normalizeGroupId } from '../graph/client.js'`
- Replace `detectConflict` signature and `searchNodes` call with the scoped version

- [ ] **Step 4: Add tests for scoped detectConflict in quorum-mcp**

Add a new describe block to `quorum-mcp/tests/governance/conflict.test.js`:

```javascript
describe('detectConflict — scoped group ID search (v0.4)', () => {
  afterEach(() => vi.clearAllMocks())

  it('passes groupIds: [projectId] to searchNodes when no globals', async () => {
    const { searchNodes: mockSearch } = await import('../../src/graph/client.js')
    vi.mocked(mockSearch).mockResolvedValue({ nodes: [] })

    await detectConflict('new content', 'auth', 'jwt-key', null, null, 'my-project', [])

    expect(vi.mocked(mockSearch)).toHaveBeenCalledWith(
      'new content',
      expect.objectContaining({ groupIds: ['my_project'] })
    )
  })

  it('includes global catalog IDs in groupIds when globals provided', async () => {
    const { searchNodes: mockSearch } = await import('../../src/graph/client.js')
    vi.mocked(mockSearch).mockResolvedValue({ nodes: [] })

    await detectConflict(
      'new content', 'auth', 'jwt-key', null, null,
      'my-project',
      ['security-standards', 'payments-compliance']
    )

    expect(vi.mocked(mockSearch)).toHaveBeenCalledWith(
      'new content',
      expect.objectContaining({
        groupIds: ['my_project', 'security_standards', 'payments_compliance']
      })
    )
  })

  it('normalizes hyphens to underscores in all group IDs', async () => {
    const { searchNodes: mockSearch } = await import('../../src/graph/client.js')
    vi.mocked(mockSearch).mockResolvedValue({ nodes: [] })

    await detectConflict(
      'content', 'auth', 'key', null, null,
      'my-hyphenated-project',
      ['global-catalog-one']
    )

    const [, opts] = vi.mocked(mockSearch).mock.calls[0]
    expect(opts.groupIds).toEqual(['my_hyphenated_project', 'global_catalog_one'])
  })

  it('falls back to unscoped search when projectId is not provided', async () => {
    const { searchNodes: mockSearch } = await import('../../src/graph/client.js')
    vi.mocked(mockSearch).mockResolvedValue({ nodes: [] })

    await detectConflict('new content', 'auth', 'jwt-key', null, null)
    // no projectId — should NOT pass groupIds
    const [, opts] = vi.mocked(mockSearch).mock.calls[0]
    expect(opts.groupIds).toBeUndefined()
  })
})
```

- [ ] **Step 5: Add same tests for gateway/tests/gateway/shared-conflict.test.js**

Add the identical describe block to `tests/gateway/shared-conflict.test.js`, importing from `../../gateway/src/shared/governance/conflict.js` and `../../gateway/src/shared/graph/client.js`.

- [ ] **Step 6: Run tests**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp && npm test -- tests/governance/conflict.test.js --reporter=verbose
cd /Users/ayan/Desktop/Work/vscode/engram && npm test -- tests/gateway/shared-conflict.test.js --reporter=verbose
```

Expected: all new tests pass; all existing tests pass.

- [ ] **Step 7: Commit both repos**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp
git add src/governance/conflict.js tests/governance/conflict.test.js
git commit -m "fix(conflict): scope detectConflict search to project + linked global catalogs"

cd /Users/ayan/Desktop/Work/vscode/engram
git add gateway/src/shared/governance/conflict.js tests/gateway/shared-conflict.test.js
git commit -m "fix(conflict): scope detectConflict search to project + linked global catalogs"
```

---

## Task B3: Update `remember.js` to pass projectId + globals to detectConflict

**Files:**
- Modify: `quorum-mcp/src/tools/remember.js:148`

- [ ] **Step 1: Update the detectConflict call in remember.js**

In `quorum-mcp/src/tools/remember.js`, find line 148:
```javascript
const conflictResult = await detectConflict(input.content, input.topic, input.key, domain, pg)
```

Replace with:
```javascript
const globals = getConfig()?.globals ?? []
const conflictResult = await detectConflict(
  input.content, input.topic, input.key, domain, pg,
  projectId, globals,
)
```

(`getConfig` is already imported at line 38.)

- [ ] **Step 2: Run the remember tests**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp && npm test -- tests/tools/remember --reporter=verbose 2>&1 | tail -40
```

Expected: all remember tests pass. The change is backward compatible — `globals` defaults to `[]` so existing tests without globals config work unchanged.

- [ ] **Step 3: Add a test verifying detectConflict receives globals in remember.test.js**

In `quorum-mcp/tests/tools/remember.test.js`, find the existing `describe('remember — conflict detection')` section. Add one test at the end of that block:

```javascript
it('passes globals from project config to detectConflict when config has globals', async () => {
  const { handler } = await import('../../src/tools/remember.js')
  const { detectConflict } = await import('../../src/governance/conflict.js')
  const { getCurrentVersion, getNextVersionNumber } = await import('../../src/graph/queries.js')
  const { getConfig } = await import('../../src/config/loader.js')

  vi.mocked(getCurrentVersion).mockResolvedValue(existingVersion)
  vi.mocked(getNextVersionNumber).mockResolvedValue(2)
  vi.mocked(getConfig).mockReturnValue({
    project: 'test', members: [], roles: {}, domains: {}, group_id: 'test-project',
    is_global: false,
    globals: ['security-standards', 'payments-compliance'],
  })
  vi.mocked(detectConflict).mockResolvedValue({ conflict: false })

  await handler(
    makePg(),
    { topic: 'auth', key: 'jwt', content: 'Use JWT', confidence: 0.8, reason: 'switching to jwt tokens' },
    humanIdentity,
    { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' },
  )

  expect(vi.mocked(detectConflict)).toHaveBeenCalledWith(
    expect.any(String),   // content
    'auth', 'jwt',        // topic, key
    expect.any(String),   // domain
    expect.anything(),    // gw
    'test-project',       // projectId
    ['security-standards', 'payments-compliance'],  // globals from config
  )
})
```

NOTE: `detectConflict` is already mocked in `remember.test.js` via `vi.mock('../../src/governance/conflict.js', ...)`. This test just adds a `spy` assertion on the arguments.

- [ ] **Step 4: Run tests and commit**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp && npm test -- tests/tools/remember --reporter=verbose 2>&1 | tail -30
git add src/tools/remember.js tests/tools/remember.test.js
git commit -m "fix(remember): pass projectId and globals to detectConflict for scoped conflict search"
```

---

## Task B4: Update `search.js` — replace hardcoded 'global' with config-driven globals

**Files:**
- Modify: `quorum-mcp/src/tools/search.js:42-160`

The current code hard-codes `groupId: 'global'` for the global search leg (line 59) and uses `projectId !== 'global'` to decide whether to include it (line 43). This must be replaced with the config-driven `globals` array.

The new approach: run one search per linked global catalog in parallel, annotating each result with `source: 'global'` and `catalog_id: <group_id>`.

- [ ] **Step 1: Add getConfig import to search.js**

`getConfig` is not currently imported in `search.js`. Add it at the top:
```javascript
import { getConfig } from '../config/loader.js'
```

- [ ] **Step 2: Replace the hardcoded global search logic**

Replace lines 42–116 in `quorum-mcp/src/tools/search.js` (from `const includeGlobal` through `const sorted`):

```javascript
  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'search',
      author: input.author ?? 'unknown',
      sessionId: input.session_id,
      governanceData: { query: input.query, domain: input.domain },
    },
    async () => {
      const globals = getConfig()?.globals ?? []

      // Project-level search (primary)
      const projectNodesPromise = searchNodes(input.query, { limit: input.limit * 2, groupId: projectId })
      const projectFactsPromise = searchFacts(input.query, { groupId: projectId })

      // Per-catalog searches — one per linked global catalog to preserve catalog attribution.
      // Parallel but isolated so a single catalog failure doesn't block the rest.
      const catalogSearchPromises = globals.map((catalogId) =>
        searchNodes(input.query, { limit: input.limit, groupId: catalogId })
          .then((r) => ({ nodes: r?.nodes ?? [], catalogId }))
          .catch(() => ({ nodes: [], catalogId })),
      )

      const [nodesResult, factsResult, ...catalogResults] = await Promise.allSettled([
        projectNodesPromise,
        projectFactsPromise,
        ...catalogSearchPromises,
      ])

      const projectNodes = nodesResult.status === 'fulfilled' ? (nodesResult.value?.nodes ?? []) : []
      const facts        = factsResult.status === 'fulfilled' ? (factsResult.value?.facts ?? []) : []

      // Tag source on project nodes
      const taggedProject = projectNodes.map((n) => ({ ...n, _source: 'project', _catalog_id: null }))

      // Tag source + catalog_id on global catalog nodes (flatten from per-catalog results)
      const taggedGlobal = catalogResults.flatMap((settled, i) => {
        if (settled.status !== 'fulfilled') return []
        const { nodes, catalogId } = settled.value
        return nodes.map((n) => ({ ...n, _source: 'global', _catalog_id: catalogId }))
      })

      // Merge + deduplicate by episode UUID (project wins over global on tie)
      const seen = new Set()
      const merged = [...taggedProject, ...taggedGlobal].filter((node) => {
        const id = node.uuid ?? node.episode_id ?? node.name
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })

      // Filter out nodes with excluded statuses
      const filtered = merged.filter((node) => {
        const status = node.metadata?.status ?? node.status
        return !status || !EXCLUDED_STATUSES.has(status)
      })

      // Apply domain filter if provided
      const domainFiltered = input.domain
        ? filtered.filter((node) => {
            const nodeDomain = node.metadata?.domain ?? node.domain ?? ''
            const nodeName = node.name ?? ''
            return nodeDomain.includes(input.domain) || nodeName.startsWith(input.domain)
          })
        : filtered

      // Sort: project-local first on equal score, then by score descending
      const sorted = domainFiltered.sort(
        (a, b) => (b.score ?? b.similarity ?? 0) - (a.score ?? a.similarity ?? 0)
          || (a._source === 'project' ? -1 : 1),
      )

      const results = sorted.slice(0, input.limit).map((node) => ({
        topic_key:     node.name ?? node.uuid,
        summary:       node.summary ?? node.content,
        author:        node.metadata?.author,
        confidence:    node.metadata?.confidence,
        status:        node.metadata?.status ?? 'ACTIVE',
        score:         node.score ?? node.similarity,
        source:        node._source,       // 'project' | 'global'
        catalog_id:    node._catalog_id,   // null for project results; group_id of catalog for global
        episode_id:    node.uuid ?? node.episode_id,
        related_facts: facts
          .filter((f) => f.source_node_uuid === node.uuid || f.target_node_uuid === node.uuid)
          .slice(0, 3)
          .map((f) => f.fact),
      }))
```

- [ ] **Step 3: Remove the old `includeGlobal` declaration at line 42-43**

The line `const includeGlobal = projectId !== 'global'` is removed entirely — no longer needed.

- [ ] **Step 4: Run search tests**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp && npm test -- tests/tools/search --reporter=verbose 2>&1 | tail -40
```

Existing tests should still pass. If `tests/tools/search.test.js` has tests that mock `getConfig`, update them to return a config with `globals: []` (no global catalogs) to match the new behavior.

- [ ] **Step 5: Commit**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp
git add src/tools/search.js
git commit -m "feat(search): replace hardcoded global groupId with config-driven globals; add catalog_id annotation"
```

---

## Task B5: Update `recall.js` — replace hardcoded 'global' with config globals

**Files:**
- Modify: `quorum-mcp/src/tools/recall.js:99-106`, `:136-170`

The current code checks `if (!version && projectId !== 'global')` and then falls back to `getCurrentVersion(pg, ..., 'global')`. Must use the `globals` array from config instead.

- [ ] **Step 1: Add getConfig import to recall.js**

```javascript
import { getConfig } from '../config/loader.js'
```

- [ ] **Step 2: Replace the global fallback in the default branch (lines 99-106)**

Replace:
```javascript
      // ── Default: ACTIVE version with global fallback (GAP-27) ─────────────
      let version = await getCurrentVersion(pg, input.topic, input.key, projectId)
      let fromGlobal = false

      // If no project-local result and we are not already in global, fall through
      if (!version && projectId !== 'global') {
        version = await getCurrentVersion(pg, input.topic, input.key, 'global')
        if (version) fromGlobal = true
      }
```

With:
```javascript
      // ── Default: ACTIVE version with global catalog fallback ──────────────
      let version = await getCurrentVersion(pg, input.topic, input.key, projectId)
      let fromGlobal = false
      let fromCatalogId = null

      // If no project-local result, try each linked global catalog in order.
      // First catalog that has an ACTIVE version wins (earliest in globals array).
      if (!version) {
        const globals = getConfig()?.globals ?? []
        for (const catalogId of globals) {
          version = await getCurrentVersion(pg, input.topic, input.key, catalogId)
          if (version) {
            fromGlobal = true
            fromCatalogId = catalogId
            break
          }
        }
      }
```

- [ ] **Step 3: Pass `fromCatalogId` to formatVersion**

Update the `formatVersion` call at line ~119:
```javascript
      return {
        result: formatVersion(version, { fromGlobal, fromCatalogId }),
        versionImpact: buildAuditVersionImpact([], []),
      }
```

- [ ] **Step 4: Update `formatVersion` to include `catalog_id` in XML output**

In the `formatVersion` function, the `source` attribute is already on the XML tag. Add `catalog_id`:

Replace in `formatVersion`:
```javascript
  let xml = `<quorum_memory topic="${escapeXml(version.topic)}" key="${escapeXml(version.key)}" version="${escapeXml(version.version)}" status="${escapeXml(version.status)}" author="${escapeXml(version.author)}" updated="${formatDate(version.created_at)}" triggered_by="${escapeXml(version.triggered_by)}" source="${source}">`
```

With:
```javascript
  const catalogId = opts.fromCatalogId ?? null
  let xml = `<quorum_memory topic="${escapeXml(version.topic)}" key="${escapeXml(version.key)}" version="${escapeXml(version.version)}" status="${escapeXml(version.status)}" author="${escapeXml(version.author)}" updated="${formatDate(version.created_at)}" triggered_by="${escapeXml(version.triggered_by)}" source="${source}"${catalogId ? ` catalog_id="${escapeXml(catalogId)}"` : ''}>`
```

Update the `formatVersion` signature JSDoc to include `fromCatalogId`:
```javascript
/**
 * Format a single version as XML for Claude context injection.
 * @param {Record<string, unknown>} version
 * @param {{ pointInTime?: string, explicit?: boolean, fromGlobal?: boolean, fromCatalogId?: string | null }} opts
 * @returns {string}
 */
```

Also update the comment inside when `opts.fromGlobal` is true to include the catalog ID:
```javascript
  if (opts.fromGlobal) {
    const catalogNote = opts.fromCatalogId ? ` (catalog: ${escapeXml(opts.fromCatalogId)})` : ''
    xml += `\n  <!-- ℹ️  Sourced from global catalog${catalogNote} — company-wide policy, readonly from this project -->`
  }
```

- [ ] **Step 5: Run recall tests**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp && npm test -- tests/tools/recall --reporter=verbose 2>&1 | tail -30
```

If there's a `tests/tools/recall.test.js`, update any tests that mock `getConfig` or check the `from_global` / global fallback behavior.

- [ ] **Step 6: Commit**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp
git add src/tools/recall.js
git commit -m "feat(recall): replace hardcoded global fallback with config-driven globals; add catalog_id to xml output"
```

---

## Task B6: Fix `graphiti.js` proxy — inject multi-group_ids for read ops

**Files:**
- Modify: `gateway/src/routes/graphiti.js`

Key insight from reading the code + tests: the current proxy sets `body.params.group_id` (at MCP protocol's params level). But `callGraphiti` sends `group_ids` inside `body.params.arguments`. The gateway must deep-copy `arguments` and inject group_ids there for the override to actually take effect in Graphiti.

For Wave B: read tools (`search_nodes`, `search_memory_facts`) get `[sanitizedProject, ...sanitizedGlobals]`. Write tools (`add_memory`) remain single-project scoped.

- [ ] **Step 1: Add `loadProjectConfig` import to graphiti.js**

```javascript
import { loadProjectConfig } from '../config-cache.js'
```

- [ ] **Step 2: Replace the body construction and group_id injection logic**

Replace lines 39–43 in `gateway/src/routes/graphiti.js`:
```javascript
  const sanitizedProject = req.user.project.replace(/-/g, '_');
  const body = { ...(req.body ?? {}), params: { ...(req.body?.params ?? {}) } };
  body.params.group_id = sanitizedProject;
  if (body.params.group_ids !== undefined) body.params.group_ids = [sanitizedProject];
```

With:
```javascript
  const sanitizedProject = req.user.project.replace(/-/g, '_');

  // Load project config to get linked global catalogs for read-op multi-group injection.
  // Failure is non-fatal — fall back to single-project scope.
  let sanitizedGlobals = []
  try {
    const projConfig = await loadProjectConfig(req.user.project)
    sanitizedGlobals = (projConfig?.globals ?? []).map((g) => g.replace(/-/g, '_'))
  } catch {
    // Config unavailable — read ops fall back to project-only scope
  }

  // Deep-copy both params and arguments so we can safely overwrite group_ids
  // at the MCP arguments level (where callGraphiti actually puts them) without
  // mutating the original request body or leaving the shallow-copied arguments
  // object shared with req.body.
  const body = {
    ...(req.body ?? {}),
    params: {
      ...(req.body?.params ?? {}),
      arguments: { ...(req.body?.params?.arguments ?? {}) },
    },
  };

  // Determine if this is a read operation — read tools search across catalogs,
  // write tools must stay single-project scoped to prevent cross-catalog writes.
  const toolName = req.body?.params?.name ?? ''
  const READ_TOOLS = new Set(['search_nodes', 'search_memory_facts'])
  const isReadOp = READ_TOOLS.has(toolName)
  const injectedGroupIds = isReadOp
    ? [sanitizedProject, ...sanitizedGlobals]
    : [sanitizedProject]

  // Overwrite group_id/group_ids at BOTH levels:
  //   params level     — legacy callers that send group_ids directly in params (not arguments)
  //   arguments level  — callGraphiti format: group_ids is inside params.arguments
  body.params.group_id = sanitizedProject;
  body.params.arguments.group_id = sanitizedProject;

  if (body.params.group_ids !== undefined) {
    body.params.group_ids = injectedGroupIds;
  }
  // Always overwrite group_ids in arguments for read ops; only if present for write ops
  if (isReadOp || body.params.arguments.group_ids !== undefined) {
    body.params.arguments.group_ids = injectedGroupIds;
  }
```

- [ ] **Step 3: Add tests for multi-group_ids injection in graphiti.test.js**

Add a new describe block to `tests/gateway/graphiti.test.js`:

```javascript
describe('POST /graphiti/*path — multi-catalog read injection (v0.4)', () => {
  beforeEach(() => {
    // Override config-cache mock to return a config with globals
    const { loadProjectConfig } = await import('../../gateway/src/config-cache.js')
    // Note: loadProjectConfig is already mocked at top of file via vi.mock.
    // Override return value per-test using vi.mocked(loadProjectConfig).mockResolvedValue(...)
  })

  afterEach(() => vi.clearAllMocks())

  it('injects [project, ...globals] into arguments.group_ids for search_nodes', async () => {
    const { loadProjectConfig } = await import('../../gateway/src/config-cache.js')
    vi.mocked(loadProjectConfig).mockResolvedValue({
      group_id: 'test-project',
      globals: ['security-standards', 'payments-compliance'],
    })

    const store = mockGraphiti()

    await post('/graphiti/mcp', {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: { query: 'auth', max_nodes: 5, group_ids: ['attacker-project'] },
      },
    })

    expect(store.capturedBody.params.arguments.group_ids).toEqual([
      'test_project', 'security_standards', 'payments_compliance',
    ])
    // Attacker-supplied group_ids are overwritten
    expect(store.capturedBody.params.arguments.group_ids).not.toContain('attacker_project')
  })

  it('injects only [project] for search_nodes when globals is empty', async () => {
    const { loadProjectConfig } = await import('../../gateway/src/config-cache.js')
    vi.mocked(loadProjectConfig).mockResolvedValue({
      group_id: 'test-project',
      globals: [],
    })

    const store = mockGraphiti()

    await post('/graphiti/mcp', {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'search_nodes', arguments: { query: 'auth' } },
    })

    expect(store.capturedBody.params.arguments.group_ids).toEqual(['test_project'])
  })

  it('does NOT inject group_ids into arguments for add_memory (write op)', async () => {
    const { loadProjectConfig } = await import('../../gateway/src/config-cache.js')
    vi.mocked(loadProjectConfig).mockResolvedValue({
      group_id: 'test-project',
      globals: ['security-standards'],
    })

    const store = mockGraphiti()

    await post('/graphiti/mcp', {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'add_memory',
        arguments: { name: 'auth:jwt', episode_body: 'Use JWT', group_id: 'attacker-project' },
      },
    })

    // Write op: group_id is single-project only; group_ids not injected into arguments
    expect(store.capturedBody.params.arguments.group_id).toBe('test_project')
    expect(store.capturedBody.params.arguments.group_ids).toBeUndefined()
    // Attacker-supplied group_id is overwritten
    expect(store.capturedBody.params.arguments.group_id).not.toBe('attacker_project')
  })

  it('falls back to single-project scope when loadProjectConfig fails', async () => {
    const { loadProjectConfig } = await import('../../gateway/src/config-cache.js')
    vi.mocked(loadProjectConfig).mockRejectedValue(new Error('S3 unavailable'))

    const store = mockGraphiti()

    await post('/graphiti/mcp', {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'search_nodes', arguments: { query: 'auth' } },
    })

    // Graceful degradation — project scope only
    expect(store.capturedBody.params.arguments.group_ids).toEqual(['test_project'])
  })
})
```

NOTE: The existing `loadUserProfile` mock in this test file covers `config-cache.js`. Add `loadProjectConfig` to the same mock:
```javascript
vi.mock('../../gateway/src/config-cache.js', () => ({
  loadUserProfile: vi.fn().mockResolvedValue({
    github_username: 'alice',
    is_admin: false,
    projects: [{ group_id: 'test-project', role: 'engineer', base_confidence: 0.7, is_owner: false, team: 'platform' }],
  }),
  loadProjectConfig: vi.fn().mockResolvedValue({
    group_id: 'test-project',
    globals: [],
  }),
}))
```

- [ ] **Step 4: Run graphiti tests**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram && npm test -- tests/gateway/graphiti.test.js --reporter=verbose
```

Expected: all existing tests pass + new tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram
git add gateway/src/routes/graphiti.js tests/gateway/graphiti.test.js
git commit -m "feat(graphiti): inject multi-group_ids for read ops using config globals; fix arguments-level override"
```

---

## Task B7: Add `GET /api/globals` endpoint to dashboard.js (gateway)

**Files:**
- Modify: `gateway/src/routes/dashboard.js`

This endpoint lets the `quorum:onboard` skill present available global catalogs to an engineer setting up a new project. It queries `q_projects WHERE is_global = TRUE` and filters by `global_scope` relative to the requesting project's hierarchy position.

The gateway already has a pg pool available (passed to route handlers via the pool parameter or imported from a shared module). Check how other routes access pg — use the same pattern.

- [ ] **Step 1: Find how dashboard.js accesses pg**

Look at `gateway/src/server.js` to understand how pg is passed to routes. Common pattern: `router.use((req, res, next) => { req.pg = pool; next() })` or the pool is imported directly.

```bash
grep -n "pg\|pool\|Pool" /Users/ayan/Desktop/Work/vscode/engram/gateway/src/routes/dashboard.js | head -20
grep -n "pool\|pg\b" /Users/ayan/Desktop/Work/vscode/engram/gateway/src/server.js | head -20
```

- [ ] **Step 2: Add the `GET /api/globals` route**

Add this route to `gateway/src/routes/dashboard.js`. Register it BEFORE any route with wildcard params to avoid Express route order issues. A good place is after `GET /api/stats` and before `GET /api/knowledge`.

```javascript
/**
 * GET /api/globals
 * Returns all global catalog projects visible to the authenticated user's project.
 *
 * Filtering by global_scope:
 *   - 'org' (or absent) → visible to all projects
 *   - 'division:<group_id>' → visible only to projects whose hierarchy parent chain includes that node
 *   - 'department:<group_id>' → same, narrower scope
 *
 * For Wave B, scope filtering is simplified: 'org'-scoped catalogs are always visible;
 * division/department-scoped catalogs are visible only if the requesting project has
 * a hierarchy.parent that matches. Full hierarchy traversal is deferred to Wave F.
 *
 * Query params:
 *   none (scoping is derived from the JWT project)
 *
 * Response: [{ group_id, display_name, global_scope, entry_count, globals }]
 */
router.get('/globals', async (req, res) => {
  try {
    // Fetch the requesting project's config to determine scope eligibility
    let requestingProjectConfig = null
    try {
      requestingProjectConfig = await loadProjectConfig(req.user.project)
    } catch { /* proceed with no scope filtering */ }

    const { rows } = await req.pg.query(`
      SELECT
        p.group_id,
        p.display_name,
        p.global_scope,
        p.globals,
        COUNT(kv.version_id) AS entry_count
      FROM q_projects p
      LEFT JOIN knowledge_versions kv
        ON kv.q_project_id = p.id
        AND kv.status = 'ACTIVE'
      WHERE p.is_global = TRUE
      GROUP BY p.group_id, p.display_name, p.global_scope, p.globals
      ORDER BY p.group_id ASC
    `)

    // Filter by global_scope:
    // 'org' (or null) → visible to all
    // 'division:<id>' / 'department:<id>' → visible only if requesting project's hierarchy
    // parent chain includes that node (simplified: check direct parent match for now)
    const requestingParent = requestingProjectConfig?.hierarchy?.parent ?? null
    const requestingLevel  = requestingProjectConfig?.hierarchy?.level ?? null

    const visibleCatalogs = rows.filter((row) => {
      const scope = row.global_scope ?? 'org'
      if (scope === 'org') return true
      // division or department scoped: check if requesting project is in that scope
      const [scopeType, scopeNode] = scope.split(':')
      if (!scopeNode) return false
      // Direct match: requesting project's parent is the scope node
      if (requestingParent === scopeNode) return true
      // Level match: requesting project is at the right level under this scope
      // Full hierarchy traversal deferred to Wave F
      return false
    })

    res.json(visibleCatalogs.map((row) => ({
      group_id:     row.group_id,
      display_name: row.display_name ?? row.group_id,
      global_scope: row.global_scope ?? 'org',
      entry_count:  Number(row.entry_count),
      globals:      row.globals ?? [],
    })))
  } catch (err) {
    console.error('[Gateway] GET /api/globals failed:', err.message)
    res.status(500).json({ error: 'internal_error', message: err.message })
  }
})
```

NOTE: `req.pg` must be available. Check how the dashboard router accesses pg (from Step 1) and use the same pattern. If pg is passed as a parameter, adjust accordingly. Also add the `loadProjectConfig` import at the top of dashboard.js if not already present.

Also check if `q_projects` has a `display_name` column (added in Wave A as part of the hierarchy config, or it may be part of the config JSON rather than a separate column). If not, use `group_id` as fallback. Similarly `global_scope` and `globals` may not be columns — they might be stored in the config JSON blob. Adjust the query based on the actual schema.

**Check the q_projects schema:**
```bash
grep -A 20 "CREATE TABLE q_projects" /Users/ayan/Desktop/Work/vscode/engram/scripts/init-db.sql
```

If `is_global`, `global_scope`, `globals` are not columns on `q_projects` (they may live in the S3/Redis config only), then the endpoint should use `listProjectIds()` + `loadProjectConfig()` for each project to gather the globals list, rather than SQL. Adapt accordingly.

- [ ] **Step 3: Run gateway tests**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram && npm test -- tests/gateway/ --reporter=verbose 2>&1 | tail -40
```

- [ ] **Step 4: Add a test for GET /api/globals in dashboard tests**

Find `tests/gateway/dashboard-write.test.js` or similar, and add a test file `tests/gateway/globals-endpoint.test.js`:

```javascript
describe('GET /api/globals', () => {
  it('returns global catalogs visible to the requesting project', async () => {
    // Mock pg.query to return a global catalog row
    // Mock loadProjectConfig to return no hierarchy (defaults to org-wide visibility)
    // GET /api/globals with valid JWT
    // Expect [{ group_id, display_name, global_scope, entry_count, globals }]
  })

  it('filters out non-org catalogs when project has no matching parent', async () => {
    // Mock two catalogs: one org-scoped, one division-scoped not matching project's parent
    // Expect only the org-scoped one returned
  })

  it('returns 401 when no JWT', async () => { ... })
})
```

- [ ] **Step 5: Commit**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram
git add gateway/src/routes/dashboard.js tests/gateway/globals-endpoint.test.js
git commit -m "feat(api): add GET /api/globals endpoint for global catalog discovery"
```

---

## Task B8: Validate globals in `syncOneProject` (gateway sync.js)

**Files:**
- Modify: `gateway/src/routes/sync.js`

Add two validation checks when syncing a project config:
1. **Self-reference**: a project must not list its own `group_id` in `globals`
2. **Cross-catalog validation**: after all projects are synced, any project that references a `group_id` in `globals` which does NOT have `is_global: true` should be flagged (non-fatal warning in response)

- [ ] **Step 1: Add self-reference check in `syncOneProject`**

In `syncOneProject`, after parsing the config (line ~106), add:
```javascript
    // Validate globals: no self-reference allowed
    const selfRef = (config.globals ?? []).find((g) => g === (config.group_id ?? projectId))
    if (selfRef) {
      return {
        project_id: projectId,
        ok: false,
        error: `globals contains self-reference: project '${projectId}' cannot list itself in globals`,
      }
    }
```

- [ ] **Step 2: Add cross-catalog validation in `syncAllConfigs`**

In `syncAllConfigs`, after the `inBatches` call (line ~176), add a post-validation pass:
```javascript
  // Post-sync validation: check that every entry in any project's globals array
  // references a project that actually has is_global: true.
  // This requires loading all configs — we do it as a lightweight second pass
  // using the already-synced project list.
  const globalsCrossCheckWarnings = []
  try {
    // Collect all group_ids that ARE global catalogs
    const bucket = process.env.QUORUM_CONFIG_BUCKET
    if (bucket) {
      // Re-read configs for cross-check (they're cached in Redis after sync, so fast)
      const globalProjectIds = new Set()
      for (const id of projectIds) {
        try {
          const projConfig = await loadProjectConfig(id).catch(() => null)
          if (projConfig?.is_global === true) globalProjectIds.add(projConfig.group_id ?? id)
        } catch { /* skip */ }
      }

      // Check each project's globals array
      for (const id of projectIds) {
        try {
          const projConfig = await loadProjectConfig(id).catch(() => null)
          for (const globalRef of projConfig?.globals ?? []) {
            if (!globalProjectIds.has(globalRef)) {
              globalsCrossCheckWarnings.push({
                project_id: id,
                warning: `globals references '${globalRef}' which does not have is_global: true`,
              })
            }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* non-fatal — warnings only */ }
```

Return the warnings alongside the sync result:
```javascript
  return {
    synced,
    failed,
    duration_ms: Date.now() - startedAt,
    globals_warnings: globalsCrossCheckWarnings,
  }
```

- [ ] **Step 3: Add tests for validation in sync.test.js**

In `tests/gateway/sync.test.js`, add:
```javascript
describe('syncOneProject — globals validation', () => {
  it('rejects a config where globals contains the project's own group_id', async () => {
    // Mock S3 to return config with globals: ['self-project'] and group_id: 'self-project'
    const result = await syncOneProject('test-bucket', 'self-project')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/self-reference/)
  })

  it('accepts a config where globals contains valid external group_ids', async () => {
    // Mock S3 to return config with globals: ['other-project'], group_id: 'my-project'
    const result = await syncOneProject('test-bucket', 'my-project')
    expect(result.ok).toBe(true)
  })
})
```

- [ ] **Step 4: Run sync tests**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram && npm test -- tests/gateway/sync.test.js --reporter=verbose
```

- [ ] **Step 5: Commit**

```bash
cd /Users/ayan/Desktop/Work/vscode/engram
git add gateway/src/routes/sync.js tests/gateway/sync.test.js
git commit -m "feat(sync): validate globals self-reference and cross-catalog is_global check on project sync"
```

---

## Task B9: Full test run and CLAUDE.md update

- [ ] **Step 1: Run all tests in both repos**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp && npm test 2>&1 | tail -20
cd /Users/ayan/Desktop/Work/vscode/engram && npm test 2>&1 | tail -20
```

Expected: all tests pass with no regressions.

- [ ] **Step 2: Update `quorum-mcp/CLAUDE.md`**

In the "Key Files" section, add `detect-conflict` globals parameter to the architecture note under `governance/`. Also update the tool descriptions for `recall.js` and `search.js` to mention global catalog fallback and `catalog_id` annotation.

- [ ] **Step 3: Update `engram/gateway/CLAUDE.md`**

Add `GET /api/globals` to the dashboard.js route description. Note the multi-group_ids injection change in graphiti.js. Note the globals validation in sync.js.

- [ ] **Step 4: Update `engram/CLAUDE.md`**

Update the "Current State (v0.3)" section or add a "v0.4 Wave B" note mentioning federation reads, globals-scoped conflict detection, and the new endpoint.

- [ ] **Step 5: Commit documentation**

```bash
cd /Users/ayan/Desktop/Work/vscode/quorum-mcp
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Wave B federation changes"

cd /Users/ayan/Desktop/Work/vscode/engram
git add CLAUDE.md gateway/CLAUDE.md
git commit -m "docs: update CLAUDE.md for Wave B federation changes"
```

---

## Verification

After completing all tasks, run the Wave B verification scenarios from the design spec:

1. **Conflict detection scoped**: `remember()` that contradicts an entry in a linked global catalog must trigger conflict detection. Verify by checking that `detectConflict` is called with `groupIds: [projectId, ...globals]` in the test that simulates a conflict.

2. **Cross-catalog recall**: `recall('auth', 'token-strategy')` in a project with `globals: ['security-standards']` where no project-local entry exists should return the entry from `security-standards` with `source="global"` and `catalog_id="security-standards"` in the XML.

3. **Search annotation**: `search('jwt authentication')` in a project with linked globals should return results with `source: 'global'` and `catalog_id` for entries coming from catalog projects.

4. **GET /api/globals**: Returns global catalogs with `is_global: true`. Org-scoped catalogs visible to all projects. Division-scoped catalogs only visible to projects with a matching hierarchy parent.

5. **Globals self-reference rejected**: `POST /sync/configs` with a project config that has `globals: ['self-id']` where `group_id: 'self-id'` returns the project in `failed` with a self-reference error.

6. **Write ops unaffected**: `remember()` still writes only to the single project; the graphiti proxy does not inject global `group_ids` for `add_memory` calls.
