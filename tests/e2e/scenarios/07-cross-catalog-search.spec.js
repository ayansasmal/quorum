/**
 * S-07 — Cross-Catalog Search (J07)
 *
 * Journey: J07 — Cross-Catalog Search and Source Attribution
 * Pillars: Functional Correctness (S-07.1, S-07.2)
 *          Federation Integrity   (S-07.3, S-07.4)
 *          Filter Accuracy        (S-07.5, S-07.6)
 *
 * Sub-scenarios:
 *   S-07.1  Query validation — q required, min 2 characters
 *   S-07.2  Result field shape — all 11 result fields present; top-level source indicator
 *   S-07.3  Cross-catalog scope — project with globals finds global entries;
 *           result annotated source:'global' + catalog_id
 *   S-07.4  Scope isolation — project without globals does NOT find global catalog entries
 *   S-07.5  DRAFT exclusion — DRAFT entries never appear in search results
 *   S-07.6  Domain filter — ?domain=<topic> narrows results to exact topic match
 *   S-07.7  Mixed sources — result set can contain both source:'project' and source:'global'
 *
 * Architecture notes:
 *   GET /api/search:
 *     - Runs Graphiti semantic search + PostgreSQL ILIKE in parallel (Promise.allSettled)
 *     - Status filter: excludes DRAFT, DEPRECATED, REJECTED — only ACTIVE (and SUPERSEDED) returned
 *     - Scope: allGroupIds = [projectGroupId, ...project.globals] — all linked global catalogs included
 *     - Source annotation: result.source = 'global' when catalog_id ∈ project.globals; 'project' otherwise
 *     - Domain filter: ?domain=<topic> adds AND kv.topic = $3 to the postgres query
 *     - Response: { results: [...], source: 'graphiti'|'postgres'|'graphiti+postgres' }
 *     - Deduplication: Graphiti results listed first; postgres-only matches appended on topic:key
 *
 * Test strategy:
 *   All write-then-read assertions rely on the PostgreSQL ILIKE path (instant consistency —
 *   no Graphiti/FalkorDB indexing lag) by searching for uid()-suffixed unique token strings
 *   that appear verbatim in the summary column. graphitiSettle() is NOT called.
 *
 *   Serial mode at file level prevents parallel-worker races across describes that share
 *   beforeAll-seeded state (e.g. S-07.3 seeds referenced in S-07.7).
 *
 * All keys are uid()-suffixed for run-to-run isolation.
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }                           from '../helpers/api.js'
import { tokens }                        from '../helpers/jwt.js'
import { uid, activeEntry, draftEntry }  from '../helpers/seed.js'

const PROJECT          = 'quorum-test-project'          // has globals: [quorum-test-catalog]
const CATALOG          = 'quorum-test-catalog'           // is_global:true; members: test-pe, test-architect
const ISOLATED_PROJECT = 'quorum-test-isolated-project'  // no globals field → search always project-scoped

// Serial: S-07.3's beforeAll seeds a global entry that S-07.7 also needs to find.
// Serialising the whole file guarantees ordering and prevents worker isolation races.
test.describe.configure({ mode: 'serial' })

// ─────────────────────────────────────────────────────────────────────────────
// S-07.1 — Query Validation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.1 — Query Validation', () => {
  test('step 1 — missing q returns 400 with query_required', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/search')
    expect(res.status).toBe(400)
    expect(res.data.error).toBe('query_required')
  })

  test('step 2 — empty string q returns 400', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/search?q=')
    expect(res.status).toBe(400)
    expect(res.data.error).toBe('query_required')
  })

  test('step 3 — single-character q returns 400 (minimum is 2 chars)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/search?q=x')
    expect(res.status).toBe(400)
    expect(res.data.error).toBe('query_required')
  })

  test('step 4 — valid q (2+ chars) returns 200 with results array and source indicator', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/search?q=au')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.results)).toBe(true)
    // Top-level source field is always present regardless of which backend responded
    expect(typeof res.data.source).toBe('string')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-07.2 — Result Field Shape
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.2 — Result Field Shape', () => {
  let shapeToken

  beforeAll(async () => {
    shapeToken = uid('s07-shape')
    // PA write → ACTIVE directly (no approval step). Token appears verbatim in content
    // so PostgreSQL ILIKE finds it without waiting for Graphiti indexing.
    await activeEntry({
      topic:   'auth',
      key:     shapeToken,
      content: `Shape test entry ${shapeToken} — used by S-07.2 to verify all result fields are present.`,
    })
  })

  test('step 1 — each result has all 11 required fields', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/api/search?q=${shapeToken}`)
    expect(res.status).toBe(200)
    expect(res.data.results.length).toBeGreaterThanOrEqual(1)

    const entry = res.data.results.find((r) => r.key === shapeToken)
    expect(entry).toBeDefined()

    // Structural field checks — all 11 search result fields must be present.
    expect(typeof entry.topic).toBe('string')
    expect(typeof entry.key).toBe('string')
    expect(typeof entry.entity_type).toBe('string')
    expect(typeof entry.summary).toBe('string')
    expect(Array.isArray(entry.tags)).toBe(true)
    // confidence/score may be null (postgres results always have score:null) — check presence
    expect('confidence' in entry).toBe(true)
    expect('score'      in entry).toBe(true)
    expect('author'     in entry).toBe(true)
    expect('updated_at' in entry).toBe(true)
    // source is always 'project' or 'global'
    expect(['project', 'global']).toContain(entry.source)
    // catalog_id is null for project-local entries
    expect('catalog_id' in entry).toBe(true)
    expect(entry.catalog_id).toBeNull()
  })

  test('step 2 — response has top-level source field naming the backend(s) that responded', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/api/search?q=${shapeToken}`)
    expect(res.status).toBe(200)
    // source is 'graphiti', 'postgres', or 'graphiti+postgres' — never absent
    expect(['graphiti', 'postgres', 'graphiti+postgres']).toContain(res.data.source)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-07.3 — Cross-Catalog Scope
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.3 — Cross-Catalog Scope', () => {
  let globalToken

  beforeAll(async () => {
    globalToken = uid('s07-global')
    // Seed an ACTIVE entry directly into the global catalog.
    // quorum-test-catalog only has test-pe + test-architect; tokens.pe (test-pe) is valid.
    // This entry must be findable by PROJECT (which has globals:[CATALOG])
    // but invisible to ISOLATED_PROJECT (which has no globals).
    await activeEntry({
      topic:   'security',
      key:     globalToken,
      content: `Global catalog entry ${globalToken} — validates cross-catalog search scope via S-07.3.`,
      project: CATALOG,
    })
  })

  test('step 1 — project with globals can find an entry in its linked global catalog', async () => {
    const client = api(tokens.pe, PROJECT)  // PROJECT has globals:[CATALOG]
    const res = await client.get(`/api/search?q=${globalToken}`)
    expect(res.status).toBe(200)

    const entry = res.data.results.find((r) => r.key === globalToken)
    expect(entry).toBeDefined()
  })

  test('step 2 — global catalog entry is annotated with source:global and correct catalog_id', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/api/search?q=${globalToken}`)
    expect(res.status).toBe(200)

    const entry = res.data.results.find((r) => r.key === globalToken)
    expect(entry).toBeDefined()
    expect(entry.source).toBe('global')
    expect(entry.catalog_id).toBe(CATALOG)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-07.4 — Scope Isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.4 — Scope Isolation', () => {
  // Re-uses the global entry seeded in S-07.3 (guaranteed available in serial mode).
  // ISOLATED_PROJECT has no globals field → allGroupIds = [isolatedGroupId] only.

  test('step 1 — project without globals cannot find global catalog entries', async () => {
    // quorum-test-isolated-project has no globals array.
    // The search scope resolves to allGroupIds = ['quorum-test-isolated-project'] only.
    // The global entry seeded in S-07.3.beforeAll must NOT appear here.
    const client = api(tokens.pe, ISOLATED_PROJECT)

    // Fetch globalToken from S-07.3 — we need a shared unique value.
    // Because we run serially, we can rely on the exact token being in the DB.
    // We query broadly (just 's07-global' prefix) — any result with source:'global' is a violation.
    const res = await client.get('/api/search?q=s07-global')
    expect(res.status).toBe(200)

    // ISOLATED_PROJECT must never return results with source:'global'
    const globalResults = res.data.results.filter((r) => r.source === 'global')
    expect(globalResults).toHaveLength(0)
  })

  test('step 2 — project without globals finds only its own project-local entries', async () => {
    // Seed a local entry in the isolated project and verify it IS returned.
    const localToken = uid('s07-isolated-local')
    await activeEntry({
      topic:   'reliability',
      key:     localToken,
      content: `Isolated project local entry ${localToken} — must be findable only within its own project scope.`,
      project: ISOLATED_PROJECT,
    })

    const client = api(tokens.pe, ISOLATED_PROJECT)
    const res = await client.get(`/api/search?q=${localToken}`)
    expect(res.status).toBe(200)

    const entry = res.data.results.find((r) => r.key === localToken)
    expect(entry).toBeDefined()
    expect(entry.source).toBe('project')
    expect(entry.catalog_id).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-07.5 — DRAFT Exclusion
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.5 — DRAFT Exclusion', () => {
  let draftToken

  beforeAll(async () => {
    draftToken = uid('s07-draft')
    // Engineer writes → DRAFT (non-PA writes always land as DRAFT).
    // The status filter in GET /api/search excludes DRAFT — this must never appear.
    await draftEntry({
      topic:   'auth',
      key:     draftToken,
      content: `Draft-only entry ${draftToken} — must never appear in search results regardless of query.`,
    })
  })

  test('step 1 — DRAFT entries are excluded from search results', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/api/search?q=${draftToken}`)
    expect(res.status).toBe(200)

    // status NOT IN ('DRAFT','DEPRECATED','REJECTED') filter must exclude this entry.
    const entry = res.data.results.find((r) => r.key === draftToken)
    expect(entry).toBeUndefined()
  })

  test('step 2 — DRAFT entry is confirmed to exist in /api/drafts (not missing from DB)', async () => {
    // Sanity check: the entry exists as DRAFT — it is excluded from search, not absent entirely.
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/drafts')
    expect(res.status).toBe(200)

    const draft = res.data.drafts?.find((e) => e.key === draftToken)
    expect(draft).toBeDefined()
    expect(draft.status).toBe('DRAFT')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-07.6 — Domain Filter
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.6 — Domain Filter', () => {
  let domainToken
  let authKey
  let reliabilityKey

  beforeAll(async () => {
    domainToken    = uid('s07-domain')
    authKey        = `${domainToken}-auth`
    reliabilityKey = `${domainToken}-rel`

    // Seed one entry in topic:'auth' and one in topic:'reliability' — both contain the
    // same unique domainToken so the base query matches both. The ?domain= filter then
    // narrows to exactly one topic.
    await activeEntry({
      topic:   'auth',
      key:     authKey,
      content: `Domain filter test ${domainToken} auth-topic entry — must appear with domain=auth only.`,
    })
    await activeEntry({
      topic:   'reliability',
      key:     reliabilityKey,
      content: `Domain filter test ${domainToken} reliability-topic entry — must NOT appear with domain=auth.`,
    })
  })

  test('step 1 — ?domain=auth returns only auth-topic entries matching the query', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/api/search?q=${domainToken}&domain=auth`)
    expect(res.status).toBe(200)

    // Auth entry must be present
    const authEntry = res.data.results.find((r) => r.key === authKey)
    expect(authEntry).toBeDefined()
    expect(authEntry.topic).toBe('auth')

    // Reliability entry must NOT appear (different topic, filtered out)
    const relEntry = res.data.results.find((r) => r.key === reliabilityKey)
    expect(relEntry).toBeUndefined()
  })

  test('step 2 — ?domain=nonexistent-topic returns no entries for the seeded query', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/api/search?q=${domainToken}&domain=nonexistent-topic-xyz`)
    expect(res.status).toBe(200)

    // Neither seeded entry has topic='nonexistent-topic-xyz'
    const authEntry = res.data.results.find((r) => r.key === authKey)
    const relEntry  = res.data.results.find((r) => r.key === reliabilityKey)
    expect(authEntry).toBeUndefined()
    expect(relEntry).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-07.7 — Mixed Sources
// ─────────────────────────────────────────────────────────────────────────────

describe('S-07.7 — Mixed Sources', () => {
  let mixedToken
  let localKey
  let globalKey

  beforeAll(async () => {
    mixedToken = uid('s07-mixed')
    localKey   = `${mixedToken}-local`
    globalKey  = `${mixedToken}-global`

    // Seed a project-local entry in quorum-test-project (source: 'project')
    await activeEntry({
      topic:   'reliability',
      key:     localKey,
      content: `Mixed source test ${mixedToken} local entry — project-scoped, source:project expected.`,
      project: PROJECT,
    })
    // Seed a global entry in quorum-test-catalog (source: 'global')
    await activeEntry({
      topic:   'reliability',
      key:     globalKey,
      content: `Mixed source test ${mixedToken} global entry — catalog-scoped, source:global expected.`,
      project: CATALOG,
    })
  })

  test('step 1 — search from a project with globals returns both project and global source entries', async () => {
    const client = api(tokens.pe, PROJECT)  // PROJECT has globals:[CATALOG]
    const res = await client.get(`/api/search?q=${mixedToken}`)
    expect(res.status).toBe(200)

    const localResult  = res.data.results.find((r) => r.key === localKey)
    const globalResult = res.data.results.find((r) => r.key === globalKey)

    expect(localResult).toBeDefined()
    expect(globalResult).toBeDefined()

    expect(localResult.source).toBe('project')
    expect(globalResult.source).toBe('global')
  })

  test('step 2 — global results have catalog_id set; project-local results have catalog_id null', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/api/search?q=${mixedToken}`)
    expect(res.status).toBe(200)

    for (const r of res.data.results) {
      if (r.source === 'global') {
        // Every global result must identify which catalog it came from
        expect(r.catalog_id).toBe(CATALOG)
      } else {
        // Project-local results must have no catalog attribution
        expect(r.catalog_id).toBeNull()
      }
    }
  })
})
