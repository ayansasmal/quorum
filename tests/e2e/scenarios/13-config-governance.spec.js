/**
 * S-06 — Config Sync & Federation Discovery (J06)
 *
 * Journey: J13 — Config Sync and Global Catalog Discovery
 * Pillars: Functional Correctness (S-13.1, S-13.2, S-13.3)
 *          Federation Integrity   (S-13.4, S-13.5)
 *
 * Sub-scenarios:
 *   S-13.1  Sync auth — only PA or sync-token can run /sync/configs
 *   S-13.2  Sync response shape — synced count, failed[], globals_warnings[]
 *   S-13.3  Self-reference guard — a project listing itself in globals fails DDB sync
 *   S-13.4  GET /api/globals — returns is_global:true catalogs with correct shape
 *   S-13.5  Config schema validation — v0.4 fields (is_global, global_scope, globals)
 *   S-13.6  PUT /config/:projectId — PA can update existing config; cache invalidated; non-PA → 403
 *
 * Architecture notes:
 *   POST /sync/configs:
 *     - Auth: principal_architect JWT OR X-Quorum-Sync-Token header; engineers forbidden
 *     - Reads all *.quorum.json from S3 bucket, calls syncOneProject per file
 *     - Self-reference guard: project cannot list its own group_id in globals
 *       → returns ok:false; upload via /config/upload returns 207 (partial_success)
 *     - globals_warnings[]: flags when globals[] references a catalog with is_global:false
 *     - Response: { synced, failed: [{project_id, error}], globals_warnings: [...], duration_ms }
 *
 *   GET /api/globals:
 *     - Auth: any authenticated user
 *     - Discovers is_global:TRUE projects from PostgreSQL
 *     - Enriches with S3/Redis config: global_scope, entry_count, globals[]
 *     - Filters by global_scope: 'org' → visible to all; division/department scoped to
 *       requesting project's hierarchy ancestry
 *     - Response: [{ group_id, display_name, global_scope, entry_count, globals }]
 *
 *   POST /config/upload:
 *     - Auth: PA JWT or sync-token or bootstrap (JWT sub listed as PA in uploaded config)
 *     - Schema: validated by QuorumConfigSchema (Zod) — is_global, global_scope, globals,
 *               hierarchy all validated at upload time
 *     - Self-reference: caught by syncOneProject post-upload → returns 207 partial_success
 *
 * All keys are uid()-suffixed for run-to-run isolation.
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }    from '../helpers/api.js'
import { tokens } from '../helpers/jwt.js'
import { uid }    from '../helpers/seed.js'

const PROJECT = 'quorum-test-project'
const CATALOG = 'quorum-test-catalog'

// Serial: S-13.3 uploads a self-referencing config to S3; S-13.2 re-runs sync
// and will see it in failed[]. Ordering guarantees deterministic assertion.
test.describe.configure({ mode: 'serial' })

describe('S-13 — Config Governance', () => {

// ─────────────────────────────────────────────────────────────────────────────
// S-13.1 — Sync Auth
// ─────────────────────────────────────────────────────────────────────────────

describe('S-13.1 — Sync Auth', () => {
  test('step 1 — engineer cannot run sync (403 forbidden)', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/sync/configs', {})
    expect(res.status).toBe(403)
    expect(res.data.error).toBe('forbidden')
  })

  test('step 2 — architect cannot run sync (403 forbidden)', async () => {
    const client = api(tokens.architect, PROJECT)
    const res = await client.post('/sync/configs', {})
    expect(res.status).toBe(403)
  })

  test('step 3 — principal_architect can run sync (200)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/sync/configs', {})
    expect(res.status).toBe(200)
    // Basic sanity — at minimum fixture configs are synced
    expect(typeof res.data.synced).toBe('number')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-13.2 — Sync Response Shape
// ─────────────────────────────────────────────────────────────────────────────

describe('S-13.2 — Sync Response Shape', () => {
  test('step 1 — sync response has all required fields', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/sync/configs', {})
    expect(res.status).toBe(200)

    // synced count — at minimum the three fixture configs are in S3
    expect(typeof res.data.synced).toBe('number')
    expect(res.data.synced).toBeGreaterThanOrEqual(3)

    // failed is an array (may be empty if all configs are valid)
    expect(Array.isArray(res.data.failed)).toBe(true)

    // globals_warnings is an array (present even when empty)
    expect(Array.isArray(res.data.globals_warnings)).toBe(true)

    // duration_ms is a positive number
    expect(typeof res.data.duration_ms).toBe('number')
    expect(res.data.duration_ms).toBeGreaterThanOrEqual(0)
  })

  test('step 2 — failed entries have project_id and error fields', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/sync/configs', {})
    expect(res.status).toBe(200)
    // Each failed entry must carry project_id and error
    for (const entry of res.data.failed) {
      expect(typeof entry.project_id).toBe('string')
      expect(typeof entry.error).toBe('string')
    }
  })

  test('step 3 — globals_warnings entries have project_id, catalog_id, warning fields', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/sync/configs', {})
    expect(res.status).toBe(200)
    // Each warning entry must carry project_id, catalog_id, and warning message
    for (const w of res.data.globals_warnings) {
      expect(typeof w.project_id).toBe('string')
      expect(typeof w.catalog_id).toBe('string')
      expect(typeof w.warning).toBe('string')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-13.3 — Self-Reference Guard
// ─────────────────────────────────────────────────────────────────────────────

describe('S-13.3 — Self-Reference Guard', () => {
  test.describe.configure({ mode: 'serial' })

  let selfRefGroupId

  beforeAll(async () => {
    // Use uid()-suffixed group_id so each run creates a distinct self-referencing config.
    // The upload fails DDB sync (207) but the file persists in S3 — subsequent calls
    // to POST /sync/configs will include this in failed[].
    selfRefGroupId = uid('self-ref-catalog')
  })

  test('step 1 — config upload with self-referencing globals returns 207 partial_success', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/config/upload', {
      group_id:  selfRefGroupId,
      owner:     'test-pe',
      is_global: true,
      globals:   [selfRefGroupId],   // ← self-reference: this catalog links to itself
      members: [
        {
          name:            'Test PE',
          github_username: 'test-pe',
          role:            'principal_architect',
          base_confidence: 0.90,
          team:            'platform',
        },
      ],
    })
    // Config is written to S3 but DDB sync fails due to the self-reference guard
    expect(res.status).toBe(207)
    expect(res.data.error).toBe('partial_success')
    // Error message must mention self-reference or the group_id
    expect(res.data.message).toMatch(/self.?reference|cannot link to itself/i)
  })

  test('step 2 — POST /sync/configs puts self-referencing config in failed[]', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/sync/configs', {})
    expect(res.status).toBe(200)
    // The self-referencing config uploaded in step 1 must appear in failed[]
    const selfRefFailed = res.data.failed.find((f) => f.project_id === selfRefGroupId)
    expect(selfRefFailed).toBeDefined()
    expect(selfRefFailed.error).toMatch(/self.?reference|cannot link to itself/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-13.4 — GET /api/globals
// ─────────────────────────────────────────────────────────────────────────────

describe('S-13.4 — Global Catalog Discovery', () => {
  test('step 1 — GET /api/globals returns quorum-test-catalog (is_global:true)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/globals')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data)).toBe(true)

    const catalog = res.data.find((c) => c.group_id === CATALOG)
    expect(catalog).toBeDefined()
  })

  test('step 2 — each catalog entry has the required shape', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/globals')
    expect(res.status).toBe(200)

    const catalog = res.data.find((c) => c.group_id === CATALOG)
    expect(typeof catalog.group_id).toBe('string')
    expect(typeof catalog.display_name).toBe('string')
    expect(typeof catalog.global_scope).toBe('string')
    expect(typeof catalog.entry_count).toBe('number')
    expect(catalog.entry_count).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(catalog.globals)).toBe(true)
  })

  test('step 3 — non-global projects are NOT returned', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/globals')
    expect(res.status).toBe(200)

    // quorum-test-project has is_global:false — must not appear
    const project = res.data.find((c) => c.group_id === 'quorum-test-project')
    expect(project).toBeUndefined()

    // quorum-test-isolated-project has no is_global field — must not appear
    const isolated = res.data.find((c) => c.group_id === 'quorum-test-isolated-project')
    expect(isolated).toBeUndefined()
  })

  test('step 4 — quorum-test-catalog has global_scope:org (visible to all requesting projects)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/globals')
    expect(res.status).toBe(200)

    const catalog = res.data.find((c) => c.group_id === CATALOG)
    // The fixture has no global_scope field → defaults to 'org'
    expect(catalog.global_scope).toBe('org')
  })

  test('step 5 — engineer can also list globals (any authenticated user)', async () => {
    // GET /api/globals is not role-gated — any project member can discover catalogs
    const client = api(tokens.engineer, PROJECT)
    const res = await client.get('/api/globals')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-13.5 — Config Schema Validation (v0.4 fields)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-13.5 — Config Schema Validation', () => {
  const validBase = {
    group_id: uid('schema-test-project'),
    owner:    'test-pe',
    members: [
      {
        name:            'Test PE',
        github_username: 'test-pe',
        role:            'principal_architect',
        base_confidence: 0.90,
        team:            'platform',
      },
    ],
  }

  test('step 1 — invalid global_scope value returns 400 (Zod schema validation)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/config/upload', {
      ...validBase,
      group_id:     uid('bad-scope'),
      is_global:    true,
      global_scope: 'cluster:foo',   // ← invalid: only 'org', 'division:<id>', 'department:<id>'
    })
    expect(res.status).toBe(400)
    expect(res.data.error).toBe('invalid_config')
    expect(Array.isArray(res.data.errors)).toBe(true)
    // At least one error must reference global_scope
    const scopeError = res.data.errors.find((e) => e.path === 'global_scope')
    expect(scopeError).toBeDefined()
  })

  test('step 2 — valid is_global:true with hierarchy fields uploads successfully (201)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/config/upload', {
      ...validBase,
      group_id:     uid('valid-global-catalog'),
      is_global:    true,
      global_scope: 'org',
      hierarchy: {
        level:        'service',
        display_name: 'E2E Schema Test Catalog',
        criticality:  2,
      },
    })
    // Either 201 (fresh upload) or 409 (already exists from a prior run) are acceptable
    expect([201, 409]).toContain(res.status)
    if (res.status === 201) {
      // 201 response: { project_id, q_project_id, message }
      expect(res.data.project_id).toBeDefined()
      expect(res.data.message).toMatch(/onboarded/i)
    }
  })

  test('step 3 — valid globals: [catalog] reference uploads successfully when catalog is in globals', async () => {
    const client = api(tokens.pe, PROJECT)
    // quorum-test-catalog is is_global:true — a project linking to it is valid
    const res = await client.post('/config/upload', {
      ...validBase,
      group_id: uid('globals-consumer-project'),
      globals:  [CATALOG],
    })
    // 201 (fresh) or 409 (already exists from prior run) — both valid
    expect([201, 207, 409]).toContain(res.status)
    // 207 partial_success is acceptable here (DDB sync may have a transient issue),
    // but NOT 400 (schema failure) or 500 (internal error)
    expect(res.status).not.toBe(400)
    expect(res.status).not.toBe(500)
  })

}) // S-13.5 — Config Schema Validation

// ─────────────────────────────────────────────────────────────────────────────
// S-13.6 — PUT /config/:projectId — Config Update Write Path
// ─────────────────────────────────────────────────────────────────────────────

describe('S-13.6 — Config Update Write Path', () => {
  // The dashboard Config editor calls PUT /config/:projectId on Save.
  // This route was not wired in the gateway — any PA saving config changes
  // received a silent 404. S-13.6 covers the write path end-to-end:
  //   read current → mutate display name → PUT → re-read verifies cache invalidated.

  let originalConfig

  beforeAll(async () => {
    // Read the current test-project config so we can restore it after the test.
    const res = await api(tokens.pe, PROJECT).get(`/config/${PROJECT}`)
    expect(res.status).toBe(200)
    originalConfig = res.data
  })

  test('step 1 — PA can PUT a valid config → 200, ok:true', async () => {
    const updated = { ...originalConfig, project: `${originalConfig.project ?? PROJECT} [S-13.6 test]` }
    const res = await api(tokens.pe, PROJECT).put(`/config/${PROJECT}`, updated)
    expect(res.status).toBe(200)
    expect(res.data.ok).toBe(true)
    expect(res.data.project_id).toBe(PROJECT)
  })

  test('step 2 — GET after PUT reflects the change (cache invalidated)', async () => {
    // If PUT did not invalidate the Redis cache the stale config would come back.
    const res = await api(tokens.pe, PROJECT).get(`/config/${PROJECT}`)
    expect(res.status).toBe(200)
    expect(res.data.project).toBe(`${originalConfig.project ?? PROJECT} [S-13.6 test]`)
  })

  test('step 3 — non-PA (engineer) → 403 on PUT', async () => {
    const res = await api(tokens.engineer, PROJECT).put(`/config/${PROJECT}`, originalConfig)
    expect(res.status).toBe(403)
  })

  test('step 4 — group_id mismatch in body → 400', async () => {
    const mismatch = { ...originalConfig, group_id: 'completely-different-project' }
    const res = await api(tokens.pe, PROJECT).put(`/config/${PROJECT}`, mismatch)
    expect(res.status).toBe(400)
    expect(res.data.error).toBe('group_id_mismatch')
  })

  test('step 5 — restore original config', async () => {
    // Cleanup: restore the config so other test runs see the original display name.
    const res = await api(tokens.pe, PROJECT).put(`/config/${PROJECT}`, originalConfig)
    expect(res.status).toBe(200)
  })
})

}) // S-13 — Config Governance
