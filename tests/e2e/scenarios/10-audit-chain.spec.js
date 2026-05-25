/**
 * S-09 — Audit Trail (J09)
 *
 * Journey: J09 — Audit Trail Integrity and Query API
 * Pillars: Functional Correctness (S-09.1, S-09.2)
 *          Structural Integrity   (S-09.3)
 *          Filter / Query API     (S-09.4, S-09.5, S-09.6)
 *          Fetch by ID            (S-09.7)
 *          Lineage                (S-09.8)
 *
 * Sub-scenarios:
 *   S-09.1  Write creates audit entries — seeding an ACTIVE entry via PA produces ≥ 1
 *           audit row; GET /pg/audit/count returns a positive integer
 *   S-09.2  Entry shape — all required fields present (chain fields + metadata);
 *           field types are correct
 *   S-09.3  Hash field structural integrity — entry_hash is a 64-char lowercase hex
 *           (SHA256); chain_position is a non-negative integer; previous_hash is
 *           64-char hex or null
 *   S-09.4  Author filter — GET /pg/audit?author=test-pe returns only test-pe entries
 *   S-09.5  Tool filter — GET /pg/audit?tool=dashboard-create returns only
 *           dashboard-create entries (exact match, not prefix)
 *   S-09.6  Limit parameter — GET /pg/audit?limit=2 returns at most 2 entries
 *   S-09.7  Fetch by ID — valid entry_id returns the full entry (200 with body);
 *           nonexistent UUID returns 200 with null body (not 404)
 *   S-09.8  Lineage — dashboard-created entry returns { entries: [] };
 *           version_audit_links rows are only populated by MCP writes via
 *           POST /pg/audit-links, not by dashboard writes
 *
 * Architecture notes:
 *   GET /pg/audit (routes/pg.js → shared/audit/secondary.js):
 *     - Auth: JWT (verifyJwt middleware) — project resolved from req.user.qProjectId
 *     - Filters: tool (exact match), author (exact match),
 *                topic (ILIKE on outcome_json::text), from/to (timestamp range), limit
 *     - Ordered by chain_position DESC (newest first)
 *     - Response: { entries: [...] }
 *
 *   GET /pg/audit/count: { count: N } — project-scoped row count
 *
 *   GET /pg/audit/:id:
 *     - Returns the entry (200) or null (200) — never 404 for a missing ID
 *     - Returns 404 ONLY when the entry exists but belongs to a different project
 *       (prevents cross-project ID enumeration)
 *
 *   GET /pg/audit/lineage/:topic/:key:
 *     - JOINs version_audit_links; dashboard writes don't populate that table
 *
 *   IMPORTANT — global chain counter:
 *     All projects share one monotonically increasing `audit_chain_counter` sequence.
 *     Project-filtered results therefore have GAPS in chain_position (entries between
 *     two project-A rows may belong to projects B, C, …).  Verifying SHA256 links on
 *     a project-scoped subset is NOT valid — the previous entry in the global chain
 *     is absent from the filtered result set.  This spec tests only structural
 *     invariants (64-char hex, non-negative integer), not hash continuity.
 *
 *   tool='dashboard-create' is written by POST /api/knowledge when author_type='human'.
 *   PA knowledge writes always use this tool value (see dashboard.js line ~1178).
 *
 * Test strategy:
 *   activeEntry() uses PA token → tool='dashboard-create' on the resulting audit row.
 *   Serial mode: S-09.7 beforeAll fetches the entry_id produced by S-09.1 beforeAll.
 *   File-level serial ensures the seed is committed before the ID capture.
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }              from '../helpers/api.js'
import { tokens }           from '../helpers/jwt.js'
import { uid, activeEntry } from '../helpers/seed.js'

const PROJECT  = 'quorum-test-project'
const HEX64_RE = /^[0-9a-f]{64}$/  // SHA256 hex digest — 64 lowercase hex characters

// S-09.7 beforeAll depends on S-09.1 beforeAll having seeded data — serial enforces ordering.
test.describe.configure({ mode: 'serial' })

// ─────────────────────────────────────────────────────────────────────────────
// S-09.1 — Write Creates Audit Entries
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.1 — Write Creates Audit Entries', () => {
  beforeAll(async () => {
    const token = uid('s09-write')
    await activeEntry({
      topic:   'reliability',
      key:     token,
      content: `Audit trail write test entry ${token}.`,
    })
  })

  test('step 1 — seeding a PA write produces at least one audit entry with tool=dashboard-create', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/audit?tool=dashboard-create')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.entries)).toBe(true)
    expect(res.data.entries.length).toBeGreaterThan(0)
  })

  test('step 2 — GET /pg/audit/count returns a positive integer', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/audit/count')
    expect(res.status).toBe(200)
    expect(typeof res.data.count).toBe('number')
    expect(res.data.count).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-09.2 — Entry Shape
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.2 — Entry Shape', () => {
  test('step 1 — all expected chain and metadata fields are present', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/audit?tool=dashboard-create&limit=1')
    expect(res.status).toBe(200)

    const entry = res.data.entries[0]
    expect(entry).toBeTruthy()

    // Chain fields (set by buildEntryWithHash in secondary.js)
    expect(entry).toHaveProperty('entry_id')
    expect(entry).toHaveProperty('entry_hash')
    expect(entry).toHaveProperty('previous_hash')  // null on first global entry
    expect(entry).toHaveProperty('chain_position')

    // Metadata fields written by dashboard routes
    expect(entry).toHaveProperty('operation')
    expect(entry).toHaveProperty('tool')
    expect(entry).toHaveProperty('timestamp')
    expect(entry).toHaveProperty('author')
    expect(entry).toHaveProperty('author_role')
    expect(entry).toHaveProperty('outcome_json')
    expect(entry).toHaveProperty('governance_json')
    expect(entry).toHaveProperty('version_impact')
  })

  test('step 2 — field types are correct', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/audit?tool=dashboard-create&limit=1')
    const entry = res.data.entries[0]

    expect(typeof entry.entry_id).toBe('string')
    expect(typeof entry.tool).toBe('string')
    expect(typeof entry.author).toBe('string')
    expect(typeof entry.author_role).toBe('string')
    expect(typeof entry.entry_hash).toBe('string')
    // chain_position is a PostgreSQL BIGINT — the pg driver serialises BIGINTs as strings
    // to avoid IEEE 754 precision loss (JS Number tops out at 2^53-1; BIGINT at 2^63-1).
    expect(typeof entry.chain_position).toBe('string')
    // timestamp may be an ISO string or Date-string depending on pg driver
    expect(entry.timestamp).toBeTruthy()
    // outcome_json is a JSONB object — returned as a plain object by pg
    expect(typeof entry.outcome_json).toBe('object')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-09.3 — Hash Field Structural Integrity
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.3 — Hash Field Structural Integrity', () => {
  test('step 1 — entry_hash is 64-char hex; chain_position ≥ 0; previous_hash is 64-char hex or null', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/audit?tool=dashboard-create&limit=5')
    expect(res.status).toBe(200)
    expect(res.data.entries.length).toBeGreaterThan(0)

    for (const entry of res.data.entries) {
      // SHA256 digest: always exactly 64 lowercase hex characters
      expect(entry.entry_hash).toMatch(HEX64_RE)

      // chain_position: BIGINT serialised as string by the pg driver — parse before numeric checks
      const pos = Number(entry.chain_position)
      expect(Number.isInteger(pos)).toBe(true)
      expect(pos).toBeGreaterThanOrEqual(0)

      // previous_hash: null only for the very first entry ever written (chain_position 0);
      // for all subsequent entries it must also be a 64-char hex digest.
      // We cannot assert non-null here because the global first entry may appear in
      // a project-scoped result set.
      if (entry.previous_hash !== null) {
        expect(entry.previous_hash).toMatch(HEX64_RE)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-09.4 — Author Filter
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.4 — Author Filter', () => {
  test('step 1 — GET /pg/audit?author=test-pe returns only test-pe authored entries', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/audit?author=test-pe&limit=10')
    expect(res.status).toBe(200)
    expect(res.data.entries.length).toBeGreaterThan(0)

    for (const entry of res.data.entries) {
      // author filter is exact match (= not ILIKE) — no other author should appear
      expect(entry.author).toBe('test-pe')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-09.5 — Tool Filter
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.5 — Tool Filter', () => {
  test('step 1 — GET /pg/audit?tool=dashboard-create returns only dashboard-create entries', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/audit?tool=dashboard-create&limit=10')
    expect(res.status).toBe(200)
    expect(res.data.entries.length).toBeGreaterThan(0)

    for (const entry of res.data.entries) {
      // tool filter is exact match — 'dashboard-promote', 'review' etc. must not appear
      expect(entry.tool).toBe('dashboard-create')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-09.6 — Limit Parameter
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.6 — Limit Parameter', () => {
  test('step 1 — GET /pg/audit?limit=2 returns at most 2 entries', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/audit?limit=2')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.entries)).toBe(true)
    expect(res.data.entries.length).toBeLessThanOrEqual(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-09.7 — Fetch by ID
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.7 — Fetch by ID', () => {
  let validEntryId

  beforeAll(async () => {
    // Capture a real entry_id from the project's audit log.
    // S-09.1 beforeAll has already seeded at least one dashboard-create entry so
    // this fetch is guaranteed to find a row (serial mode ensures ordering).
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/audit?tool=dashboard-create&limit=1')
    validEntryId = res.data.entries[0]?.entry_id
  })

  test('step 1 — valid entry_id returns the full audit entry (200)', async () => {
    expect(validEntryId).toBeTruthy()

    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/audit/${validEntryId}`)
    expect(res.status).toBe(200)
    expect(res.data).not.toBeNull()
    expect(res.data.entry_id).toBe(validEntryId)
    expect(res.data.entry_hash).toMatch(HEX64_RE)
  })

  test('step 2 — nonexistent UUID returns 200 with null body (not 404)', async () => {
    // The route returns null (200) for missing IDs so that callers cannot distinguish
    // "entry doesn't exist" from "entry exists but belongs to another project".
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/audit/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(200)
    expect(res.data).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-09.8 — Lineage
// ─────────────────────────────────────────────────────────────────────────────

describe('S-09.8 — Lineage', () => {
  let lineageTopic, lineageKey

  beforeAll(async () => {
    const token  = uid('s09-lineage')
    lineageTopic = 'auth'
    lineageKey   = token
    await activeEntry({
      topic:   lineageTopic,
      key:     lineageKey,
      content: `Lineage test entry ${token}.`,
    })
  })

  test('step 1 — dashboard-created entry returns { entries: [] } from lineage endpoint', async () => {
    // GET /pg/audit/lineage/:topic/:key JOINs version_audit_links.
    // Dashboard writes (POST /api/knowledge) do NOT insert rows into version_audit_links;
    // only MCP writes via POST /pg/audit-links populate that table.
    // Therefore any dashboard-only entry always returns an empty entries array.
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/audit/lineage/${lineageTopic}/${lineageKey}`)
    expect(res.status).toBe(200)
    expect(res.data).toHaveProperty('entries')
    expect(Array.isArray(res.data.entries)).toBe(true)
    expect(res.data.entries).toHaveLength(0)
  })
})
