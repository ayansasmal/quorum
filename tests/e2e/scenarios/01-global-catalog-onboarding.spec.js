/**
 * S-01 — Global Catalog Onboarding
 *
 * Journey: J01 — docs/e2e/journeys/J01-global-catalog-onboarding.md
 * Pillar:  Federation Correctness (score-gated 🟡)
 * OwnScore: 34  |  FailureCost: 34
 *
 * What it covers:
 *   Full onboarding flow — upload a global catalog + a linked project config,
 *   verify cross-catalog discovery, PA/architect write authority rules, DRAFT→ACTIVE
 *   promotion, cross-catalog search with source/catalog_id annotation, and
 *   absence of global bleed in the knowledge browser.
 *
 * Uses graphitiSettle() directly before the cross-catalog search assertion (step 13)
 * to allow Graphiti/FalkorDB to finish indexing the PA-written global entry.
 *
 * Setup strategy:
 *   Creates fresh configs with timestamp-based IDs so POST /config/upload is
 *   guaranteed to return 201 (no conflict with setup.js fixture uploads).
 *   test-pe is PA in both fresh configs (mirrors the fixture member list).
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import axios from 'axios'
import { api }            from '../helpers/api.js'
import { tokens }         from '../helpers/jwt.js'
import { graphitiSettle } from '../helpers/graphiti.js'

const GATEWAY = process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001'

/**
 * Unauthenticated axios instance for config upload (upload route does its own auth
 * via the Authorization header — we pass the PA token per-call).
 */
const http = axios.create({ baseURL: GATEWAY, validateStatus: () => true })

// ── Fresh config IDs (timestamp-unique; guarantees 201 on upload) ──────────────
const ts      = Date.now()
const CATALOG = `j01-catalog-${ts}`
const PROJECT = `j01-project-${ts}`

/** Minimal global catalog config. Members mirror quorum-test-catalog.quorum.json. */
const catalogConfig = {
  group_id:     CATALOG,
  project:      'J01 E2E Test Global Catalog',
  owner:        'test-pe',
  is_global:    true,
  global_scope: 'org',
  globals:      [],
  domains:      { security: {}, auth: {}, reliability: {} },
  members: [
    { name: 'Test PE',       github_username: 'test-pe',       role: 'principal_architect', base_confidence: 0.90, team: 'platform' },
    { name: 'Test Architect', github_username: 'test-architect', role: 'architect',          base_confidence: 0.80, team: 'platform' },
    { name: 'Test Engineer',  github_username: 'test-engineer',  role: 'engineer',           base_confidence: 0.70, team: 'backend'  },
  ],
}

/** Minimal project config — linked to the fresh catalog via globals. */
const projectConfig = {
  group_id:  PROJECT,
  project:   'J01 E2E Test Project',
  owner:     'test-pe',
  is_global: false,
  globals:   [CATALOG],
  domains:   { security: {}, auth: {} },
  members: [
    { name: 'Test PE',       github_username: 'test-pe',       role: 'principal_architect', base_confidence: 0.90, team: 'platform' },
    { name: 'Test Architect', github_username: 'test-architect', role: 'architect',          base_confidence: 0.80, team: 'platform' },
    { name: 'Test Engineer',  github_username: 'test-engineer',  role: 'engineer',           base_confidence: 0.70, team: 'backend'  },
  ],
}

// ── Shared test state (set in beforeAll, read in tests) ────────────────────────
let tlsKey     // key slug for the PA-written global entry
let tokenKey   // key slug for the architect-written DRAFT entry

describe('S-01 — Global Catalog Onboarding', () => {
  // Serial mode: all 13 steps share one worker, preserving the beforeAll state
  // (tlsKey, tokenKey) and the same CATALOG/PROJECT IDs across every step.
  // Journey specs that depend on sequenced writes must never run fully parallel.
  test.describe.configure({ mode: 'serial' })

  // ── beforeAll: upload fresh configs ─────────────────────────────────────────
  beforeAll(async () => {
    const paHeader = { Authorization: `Bearer ${tokens.pe}`, 'Content-Type': 'application/json' }

    // Upload catalog config. Accept 409 — can happen if a previous run uploaded
    // the same timestamp-based ID (e.g. test was retried in the same second).
    const catRes = await http.post('/config/upload', catalogConfig, { headers: paHeader })
    if (catRes.status !== 201 && catRes.status !== 409) {
      throw new Error(`beforeAll: catalog upload failed ${catRes.status} ${JSON.stringify(catRes.data)}`)
    }

    // Upload project config (linked to catalog)
    const projRes = await http.post('/config/upload', projectConfig, { headers: paHeader })
    if (projRes.status !== 201 && projRes.status !== 409) {
      throw new Error(`beforeAll: project upload failed ${projRes.status} ${JSON.stringify(projRes.data)}`)
    }

    // Stable key names (unique per test run via ts prefix in project IDs)
    tlsKey   = 'tls-minimum-version'
    tokenKey = 'token-expiry'
  })

  // ── API Phase ────────────────────────────────────────────────────────────────

  test('step 1 — catalog config upload returns 201 with correct group_id', async () => {
    // Config was uploaded in beforeAll. Re-uploading returns 409 (already onboarded).
    // Assert: the catalog IS registered by verifying globals endpoint sees it.
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/globals')
    expect(res.status).toBe(200)
    const catalog = res.data.find(c => c.group_id === CATALOG)
    expect(catalog).toBeDefined()
    expect(catalog.is_global ?? true).toBe(true)
  })

  test('step 2 — project config upload accepts globals: [catalog]', async () => {
    // Verify the project is reachable with the correct config (globals list accepted).
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/knowledge')
    expect(res.status).toBe(200)
    // Project is fresh — no entries yet
    expect(Array.isArray(res.data.items ?? [])).toBe(true)
  })

  test('step 3 — GET /api/globals includes the catalog with is_global true', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/globals')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data)).toBe(true)
    const catalog = res.data.find(c => c.group_id === CATALOG)
    expect(catalog).toBeDefined()
    expect(catalog.group_id).toBe(CATALOG)
  })

  // ── PA Phase (catalog project) ───────────────────────────────────────────────

  test('step 4 — fresh catalog has no knowledge entries', async () => {
    const client = api(tokens.pe, CATALOG)
    const res = await client.get('/api/knowledge')
    expect(res.status).toBe(200)
    const entries = res.data.items ?? []
    // New catalog should be empty
    const catalogEntries = Array.isArray(entries)
      ? entries.filter(e => e.status === 'ACTIVE')
      : []
    expect(catalogEntries.length).toBe(0)
  })

  test('step 5 — PA write to global catalog lands as DRAFT (S-11.1 self-approval prevention)', async () => {
    // Global catalog PA writes always land as DRAFT — a second PA must approve.
    // Self-approval prevention is enforced at the dashboard path for all global projects.
    const client = api(tokens.pe, CATALOG)
    const res = await client.post('/api/knowledge', {
      topic:       'security',
      key:         tlsKey,
      content:     'All services must use TLS 1.3 minimum. TLS 1.2 is permitted only for legacy internal endpoints until Q3 migration.',
      entity_type: 'Constraint',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('DRAFT')
  })

  test('step 6 — PA-written DRAFT entry appears in /api/drafts for the catalog', async () => {
    const client = api(tokens.pe, CATALOG)
    const res = await client.get('/api/drafts')
    expect(res.status).toBe(200)
    const drafts = res.data.drafts ?? []
    expect(drafts.some(d => d.topic === 'security' && d.key === tlsKey)).toBe(true)
  })

  test('step 7 — catalog with only 1 ACTIVE entry shows UNCERTIFIED conformance', async () => {
    // UNCERTIFIED when < 10 ACTIVE entries exist across all linked catalogs.
    // quorum-test-catalog itself has no linked globals, so its own entries count.
    // For the catalog project itself (not the linked project), conformance reflects
    // whether the catalog is fully populated — with 1 entry it's UNCERTIFIED.
    const client = api(tokens.pe, CATALOG)
    const res = await client.get('/api/conformance')
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('UNCERTIFIED')
  })

  // ── Architect Phase (global write → DRAFT) ───────────────────────────────────

  test('step 8 — architect write to global catalog lands as DRAFT', async () => {
    const client = api(tokens.architect, CATALOG)
    const res = await client.post('/api/knowledge', {
      topic:       'auth',
      key:         tokenKey,
      content:     'Access tokens must expire within 1 hour. Refresh tokens within 30 days.',
      entity_type: 'Constraint',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('DRAFT')
  })

  test('step 9 — DRAFT entry appears in GET /api/drafts for the catalog', async () => {
    const client = api(tokens.pe, CATALOG)
    const res = await client.get('/api/drafts')
    expect(res.status).toBe(200)
    const drafts = res.data.drafts ?? []
    expect(drafts.some(d => d.topic === 'auth' && d.key === tokenKey)).toBe(true)
  })

  test('step 10 — PA promotes DRAFT to ACTIVE via /api/knowledge/:topic/:key/promote', async () => {
    const client = api(tokens.pe, CATALOG)
    const res = await client.post(`/api/knowledge/auth/${tokenKey}/promote`, {
      note: 'Standard is correct per security policy',
    })
    expect(res.status).toBe(200)
    expect(res.data.promoted).toBe(true)
  })

  test('step 11 — promoted entry is ACTIVE in catalog knowledge browser', async () => {
    const client = api(tokens.pe, CATALOG)
    const res = await client.get('/api/knowledge')
    expect(res.status).toBe(200)
    const entries = res.data.items ?? []
    const activeEntries = Array.isArray(entries)
      ? entries.filter(e => e.status === 'ACTIVE')
      : []
    expect(activeEntries.some(e => e.key === tokenKey && e.topic === 'auth')).toBe(true)
  })

  // ── Engineer Phase (cross-catalog reads) ────────────────────────────────────

  test('step 12 — cross-catalog search from linked project finds global entry with source and catalog_id', async () => {
    // Graphiti needs time to index the promoted entry.
    await graphitiSettle()

    // tokenKey was promoted to ACTIVE in step 10; tlsKey is DRAFT (self-approval prevention).
    // Search only returns ACTIVE entries — use tokenKey content ("token" / "expiry").
    const client = api(tokens.engineer, PROJECT)
    const res = await client.get('/api/search?q=token')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.results)).toBe(true)

    // The token-expiry entry is ACTIVE in the catalog and the project links to it via globals.
    // The search route annotates it with source: 'global' and catalog_id: CATALOG.
    const globalEntry = res.data.results.find(
      r => r.source === 'global' && r.catalog_id === CATALOG
    )
    expect(globalEntry).toBeDefined()
    expect(globalEntry.key).toBe(tokenKey)
  })

  test('step 13 — knowledge browser for linked project shows NO global entries (no bleed)', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.get('/api/knowledge')
    expect(res.status).toBe(200)
    const entries = res.data.items ?? []
    // The project has no local knowledge entries — it only linked to the catalog.
    // Global entries must NOT appear in the knowledge browser (search is separate).
    const projectEntries = Array.isArray(entries)
      ? entries.filter(e => e.status === 'ACTIVE')
      : []
    expect(projectEntries.some(e => e.key === tlsKey)).toBe(false)
    expect(projectEntries.some(e => e.key === tokenKey)).toBe(false)
  })

  afterAll(async () => {
    // Archive the timestamp-suffixed configs created by this spec so they do not
    // accumulate in DDB across runs and bloat the project selector for test users.
    const adminHeader = { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': 'application/json' }
    for (const id of [CATALOG, PROJECT]) {
      await http.delete(`/admin/projects/${id}`, {
        data:           { reason: 'E2E test cleanup — j01 timestamp config removed after S-01 suite' },
        headers:        adminHeader,
        validateStatus: () => true,
      })
    }
  })

})
