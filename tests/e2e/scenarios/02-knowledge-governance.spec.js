/**
 * S-02 — Knowledge Governance Lifecycle (J02)
 *
 * Journey: J02 — docs/e2e/journeys/J02-knowledge-governance.md
 * Pillars: Functional Correctness (S-02.1, S-02.4–S-02.7)
 *          Governance Integrity (S-02.2)
 *          Data Integrity (S-02.3)
 *
 * Sub-scenarios (happy path):
 *   S-02.1  Write + Recall (PA ACTIVE / engineer DRAFT / search)
 *   S-02.2  Conflict detection (DRAFT against ACTIVE + /governance/detect-conflict)
 *   S-02.3  Resolve: approve → supersede (DRAFT → ACTIVE, old → SUPERSEDED)
 *   S-02.4  Resolve: reject (DRAFT → REJECTED, old ACTIVE unchanged)
 *   S-02.5  Resolve: request_changes (stays pending with note)
 *   S-02.6  Resolve: coexist_split (PE manually creates two new entries)
 *   S-02.7  Resolve: coexist_merge (PE supersedes with merged content)
 *
 * Sub-scenarios (negative / alternate — multi-member):
 *   S-02.9   Authority fence — non-PA cannot self-approve or review a conflict (NEGATIVE)
 *   S-02.10  Concurrent competing DRAFTs — two engineers write the same key simultaneously (RACE)
 *   S-02.11  Supersede-under-review — ACTIVE replaced while conflict is pending (ALTERNATE)
 *
 * Architecture notes:
 *   - POST /api/knowledge as PE → ACTIVE immediately (no pending decision created)
 *   - POST /api/knowledge as non-PA → DRAFT (no pending decision created)
 *   - POST /pg/pending → explicitly creates a pending_decisions row for /api/review
 *   - POST /api/review/:conflictId requires a pending_decisions row to exist
 *   - GET /pg/versions/:topic/:key returns { summary, status, version, ... }
 *     (content stored in 'summary' column internally)
 *
 * All keys are uid()-suffixed for run-to-run isolation without teardown.
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }            from '../helpers/api.js'
import { tokens }         from '../helpers/jwt.js'
import { graphitiSettle } from '../helpers/graphiti.js'
import { uid, activeEntry, conflict } from '../helpers/seed.js'
import { injectSession, DASHBOARD_URL } from '../helpers/browser.js'

const PROJECT = 'quorum-test-project'

// ─────────────────────────────────────────────────────────────────────────────
// S-02.1 — Write + Recall Cycle
// ─────────────────────────────────────────────────────────────────────────────

describe('S-02.1 — Write + Recall', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'db'
  let poolKey   // PA-written ACTIVE key
  let migKey    // second PA-written key for round-trip fidelity
  let draftKey  // engineer-written DRAFT key

  const POOL_CONTENT   = 'Use connection pool size 10. Sized for p95 load at 200 req/s.'
  const MIG_CONTENT    = 'Use forward-only migrations. No rollback scripts. Blue/green at infra level.'
  const DRAFT_CONTENT  = 'Draft entry — awaiting PE review.'

  beforeAll(() => {
    poolKey  = uid('connection-pooling')
    migKey   = uid('migration-strategy')
    draftKey = uid('index-strategy')
  })

  test('step 1 — PA write to fresh key lands as ACTIVE immediately', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/api/knowledge', {
      topic,
      key:         poolKey,
      content:     POOL_CONTENT,
      entity_type: 'Decision',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.version).toBe(1)
    expect(res.data.author).toBe('test-pe')
    expect(res.data.confidence).toBeGreaterThanOrEqual(0.70)
  })

  test('step 2 — GET /pg/versions returns exact content of written entry', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${poolKey}`)
    expect(res.status).toBe(200)
    // Content stored in 'summary' column internally
    expect(res.data.summary).toBe(POOL_CONTENT)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.version).toBe(1)
  })

  test('step 3 — engineer write to fresh key lands as DRAFT (governance gate)', async () => {
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/api/knowledge', {
      topic,
      key:         draftKey,
      content:     DRAFT_CONTENT,
      entity_type: 'Pattern',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('DRAFT')
  })

  test('step 4 — DRAFT entry visible in GET /api/drafts', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/drafts')
    expect(res.status).toBe(200)
    const drafts = res.data.drafts ?? []
    expect(drafts.some(d => d.topic === topic && d.key === draftKey)).toBe(true)
  })

  test('step 5 — second PA write to different key lands as ACTIVE (round-trip)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/api/knowledge', {
      topic,
      key:         migKey,
      content:     MIG_CONTENT,
      entity_type: 'Pattern',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('ACTIVE')
  })

  test('step 6 — GET /pg/versions returns exact content for second entry (round-trip fidelity)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${migKey}`)
    expect(res.status).toBe(200)
    expect(res.data.summary).toBe(MIG_CONTENT)
    expect(res.data.status).toBe('ACTIVE')
  })

  test('step 7 — GET /api/knowledge browser shows ACTIVE entry', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/knowledge')
    expect(res.status).toBe(200)
    const items = res.data.items ?? []
    expect(items.some(e => e.topic === topic && e.key === poolKey && e.status === 'ACTIVE')).toBe(true)
  })

  test('step 8 — search finds ACTIVE entry with source:project, catalog_id:null annotation', async () => {
    // Graphiti requires settle time before semantic search finds the entry.
    await graphitiSettle()
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/search?q=connection+pool')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.results)).toBe(true)
    // The entry must appear with source:'project' and catalog_id:null (not from a global catalog)
    const entry = res.data.results.find(r => r.topic === topic && r.key === poolKey)
    expect(entry).toBeDefined()
    expect(entry.source).toBe('project')
    expect(entry.catalog_id).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-02.2 — Conflict Detection
// ─────────────────────────────────────────────────────────────────────────────

describe('S-02.2 — Conflict Detection', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'auth'
  let sessionKey
  let existingContent
  let incomingContent

  beforeAll(async () => {
    sessionKey = uid('session-timeout')
    existingContent = 'Sessions expire after 30 minutes of inactivity. Balances security with UX.'
    incomingContent = 'Sessions should never expire automatically — breaks long-running workflows.'

    // Seed: PA writes ACTIVE entry
    await activeEntry({ topic, key: sessionKey, content: existingContent })
  })

  test('step 1 — engineer write to existing ACTIVE key creates DRAFT (pending for PE review)', async () => {
    // Non-PA write to an existing ACTIVE key → DRAFT alongside ACTIVE
    const client = api(tokens.engineer, PROJECT)
    const res = await client.post('/api/knowledge', {
      topic,
      key:         sessionKey,
      content:     incomingContent,
      entity_type: 'Decision',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('DRAFT')
  })

  test('step 2 — DRAFT entry appears in GET /api/drafts for PE review', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/api/drafts')
    expect(res.status).toBe(200)
    const drafts = res.data.drafts ?? []
    // Both the new DRAFT and ACTIVE version share the same topic/key
    expect(drafts.some(d => d.topic === topic && d.key === sessionKey)).toBe(true)
  })

  test('step 3 — POST /governance/detect-conflict returns well-shaped response', async () => {
    // The governance endpoint is used by the MCP to detect semantic contradictions.
    // In E2E: OPENAI_BASE_URL points to mock-openai, which returns contradicts:false.
    // We assert on the response *shape* (correct JSON contract), not LLM accuracy.
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/governance/detect-conflict', {
      existing: existingContent,
      incoming: incomingContent,
    })
    expect(res.status).toBe(200)
    // Contract: four fields required by the MCP conflict detection pipeline
    expect(typeof res.data.contradicts).toBe('boolean')
    expect(typeof res.data.reason).toBe('string')
    expect(typeof res.data.possible_split).toBe('boolean')
    // split_suggestion: string or null (never undefined)
    expect(res.data.split_suggestion === null || typeof res.data.split_suggestion === 'string').toBe(true)
  })

  test('step 4 — POST /governance/detect-conflict validates required fields', async () => {
    const client = api(tokens.pe, PROJECT)
    // Missing 'incoming' → 400 (Errors.unprocessable returns HTTP 400)
    const res = await client.post('/governance/detect-conflict', {
      existing: existingContent,
    })
    expect(res.status).toBe(400)
    expect(res.data.error).toBeDefined()
  })

  test('step 5 — POST /governance/detect-conflict rejects unauthenticated calls', async () => {
    // No auth header — should return 401
    const res = await api('invalid-token', PROJECT).post('/governance/detect-conflict', {
      existing: existingContent,
      incoming: incomingContent,
    })
    expect(res.status).toBe(401)
  })

  test('step 6 — ACTIVE version still present after DRAFT write (no hard replace)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${sessionKey}`)
    expect(res.status).toBe(200)
    // The current ACTIVE version must still be the PA's original entry
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.summary).toBe(existingContent)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-02.3 — Resolve: Approve (supersede path)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-02.3 — Supersede Path', () => {
  test.describe.configure({ mode: 'serial' })

  const topic  = 'infra'
  let deployKey
  let conflictId
  const EXISTING_CONTENT = 'Deploy to prod on Fridays with a 2-hour freeze on Mondays.'
  const INCOMING_CONTENT = 'Never deploy on Fridays. Deploy window is Tue–Thu 10am–2pm UTC.'

  beforeAll(async () => {
    deployKey = uid('deploy-strategy')
    // Seed: PA writes ACTIVE, then conflict() writes DRAFT + pending_decision
    await activeEntry({ topic, key: deployKey, content: EXISTING_CONTENT })
    ;({ conflictId } = await conflict({
      topic,
      key:             deployKey,
      content:         INCOMING_CONTENT,
      existingContent: EXISTING_CONTENT,
    }))
  })

  test('step 1 — PE approves conflict → pending decision resolves', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/review/${conflictId}`, {
      action: 'approve',
      note:   'Incoming version is more accurate — aligns with current deployment policy.',
    })
    expect(res.status).toBe(200)
    // Approved conflict resolves as 'supersede' internally
    expect(['approved', 'supersede']).toContain(res.data.status ?? res.data.resolution)
    expect(res.data.reviewer).toBe('test-pe')
  })

  test('step 2 — DRAFT version is now ACTIVE (v2)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${deployKey}`)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
    // Version number incremented
    expect(res.data.version).toBeGreaterThanOrEqual(2)
    // Content matches the incoming (now ACTIVE) version
    expect(res.data.summary).toBe(INCOMING_CONTENT)
  })

  test('step 3 — original v1 exists in history as SUPERSEDED (no hard delete)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${deployKey}/history`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data)).toBe(true)
    const v1 = res.data.find(v => v.version === 1)
    expect(v1).toBeDefined()
    expect(v1.status).toBe('SUPERSEDED')
  })

  test('step 4 — approve action is recorded in the immutable audit trail', async () => {
    // The dashboard review/approve route writes to audit_log directly via writeAuditEntry
    // (tool: 'review'). This is distinct from the lineage endpoint, which requires
    // version_audit_links entries written by the MCP path. Use GET /pg/audit?tool=review
    // to verify the approval audit record exists.
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/audit?tool=review')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.entries)).toBe(true)
    const approveEntry = res.data.entries.find(e =>
      e.outcome_json?.key === deployKey &&
      e.outcome_json?.status === 'approved',
    )
    expect(approveEntry).toBeDefined()
    expect(approveEntry.operation).toBe('OUTCOME')
  })

  test('step 5 — resolved conflict no longer appears in GET /pg/pending', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/pending')
    expect(res.status).toBe(200)
    const open = Array.isArray(res.data) ? res.data : []
    expect(open.some(d => d.conflict_id === conflictId)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-02.4 — Resolve: Reject
// ─────────────────────────────────────────────────────────────────────────────

describe('S-02.4 — Reject Path', () => {
  test.describe.configure({ mode: 'serial' })

  const topic  = 'infra'
  let monitorKey
  let conflictId
  const EXISTING_CONTENT = 'Use Datadog for metrics and alerting. 15-minute alert SLA for P1 incidents.'
  const INCOMING_CONTENT = 'Use Prometheus + Grafana instead of Datadog. Lower cost for same coverage.'

  beforeAll(async () => {
    monitorKey = uid('monitoring-stack')
    await activeEntry({ topic, key: monitorKey, content: EXISTING_CONTENT })
    ;({ conflictId } = await conflict({
      topic,
      key:             monitorKey,
      content:         INCOMING_CONTENT,
      existingContent: EXISTING_CONTENT,
    }))
  })

  test('step 1 — PE rejects conflict → pending decision resolves as rejected', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/review/${conflictId}`, {
      action: 'reject',
      note:   'Existing standard is correct — incoming based on outdated cost assumptions.',
    })
    expect(res.status).toBe(200)
    expect(['rejected', 'reject']).toContain(res.data.status ?? res.data.resolution)
  })

  test('step 2 — original ACTIVE entry v1 still ACTIVE (unchanged)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${monitorKey}`)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.version).toBe(1)
    expect(res.data.summary).toBe(EXISTING_CONTENT)
  })

  test('step 3 — incoming DRAFT is REJECTED (not deleted — provenance preserved)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${monitorKey}/history`)
    expect(res.status).toBe(200)
    const rejected = res.data.find(v => v.status === 'REJECTED')
    expect(rejected).toBeDefined()
    expect(rejected.summary).toBe(INCOMING_CONTENT)
  })

  test('step 4 — conflict no longer appears in GET /pg/pending after rejection', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/pending')
    expect(res.status).toBe(200)
    const open = Array.isArray(res.data) ? res.data : []
    expect(open.some(d => d.conflict_id === conflictId)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-02.5 — Resolve: Request Changes (Escalation Path)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-02.5 — Escalation Path', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'infra'
  let cacheKey
  let conflictId
  const EXISTING_CONTENT  = 'Use Redis for session cache. 1-hour TTL.'
  const INCOMING_CONTENT  = 'Use Memcached instead of Redis for session cache — simpler ops model.'
  const ESCALATION_NOTE   = 'Requires broader architectural discussion — escalating for architecture board review.'

  beforeAll(async () => {
    cacheKey = uid('cache-strategy')
    await activeEntry({ topic, key: cacheKey, content: EXISTING_CONTENT })
    ;({ conflictId } = await conflict({
      topic,
      key:             cacheKey,
      content:         INCOMING_CONTENT,
      existingContent: EXISTING_CONTENT,
    }))
  })

  test('step 1 — PE requests_changes keeps conflict in pending with note', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/review/${conflictId}`, {
      action: 'request_changes',
      note:   ESCALATION_NOTE,
    })
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('changes_requested')
    expect(res.data.note).toBe(ESCALATION_NOTE)
    expect(res.data.conflict_id).toBe(conflictId)
  })

  test('step 2 — conflict still appears in GET /pg/pending (not resolved)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get('/pg/pending')
    expect(res.status).toBe(200)
    const open = Array.isArray(res.data) ? res.data : []
    // The conflict must still be in the pending list (request_changes does not resolve)
    expect(open.some(d => d.conflict_id === conflictId)).toBe(true)
  })

  test('step 3 — escalation note stored in pending decision record', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/pending/${conflictId}`)
    expect(res.status).toBe(200)
    // Note is stored in stale_warning field by the request_changes path
    expect(res.data.stale_warning).toContain('test-pe')
  })

  test('step 4 — original ACTIVE entry unchanged', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${cacheKey}`)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.summary).toBe(EXISTING_CONTENT)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-02.6 — Resolve: Coexist Split
// ─────────────────────────────────────────────────────────────────────────────

describe('S-02.6 — Coexist-Split', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'db'
  let poolSizeKey   // original key (will be superseded)
  let oltpKey       // split key 1 (new ACTIVE for OLTP)
  let batchKey      // split key 2 (new ACTIVE for batch)
  const ORIGINAL_CONTENT = 'Pool size 10 for all services.'
  const OLTP_CONTENT     = 'Pool size 10 for OLTP services. Sized for synchronous request latency.'
  const BATCH_CONTENT    = 'Pool size 50 for batch processing services. Sized for throughput over latency.'

  beforeAll(async () => {
    poolSizeKey = uid('pool-size')
    oltpKey     = uid('db-oltp-pool')
    batchKey    = uid('db-batch-pool')
    // Seed the original ACTIVE entry
    await activeEntry({ topic, key: poolSizeKey, content: ORIGINAL_CONTENT })
  })

  test('step 1 — PE creates ACTIVE split entry 1 at oltp key', async () => {
    // The split result: two new entries replace one original.
    // In the HTTP API, PE manually creates the two new entries.
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/api/knowledge', {
      topic,
      key:         oltpKey,
      content:     OLTP_CONTENT,
      entity_type: 'Constraint',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.key).toBe(oltpKey)
  })

  test('step 2 — PE creates ACTIVE split entry 2 at batch key', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post('/api/knowledge', {
      topic,
      key:         batchKey,
      content:     BATCH_CONTENT,
      entity_type: 'Constraint',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.key).toBe(batchKey)
  })

  test('step 3 — PE supersedes original key (marks it SUPERSEDED, not deleted)', async () => {
    // The original entry is superseded by the first split entry (oltp).
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/knowledge/${topic}/${poolSizeKey}/supersede`, {
      content:     OLTP_CONTENT,
      entity_type: 'Constraint',
      reason:      'Split into context-specific pool size standards: oltp and batch.',
    })
    expect(res.status).toBe(200)
    // Supersede returns { new_version: <full row object>, superseded_version: <number> }
    expect(res.data.new_version.version).toBeGreaterThan(1)
    expect(res.data.new_version.status).toBe('ACTIVE')
    expect(res.data.superseded_version).toBe(1)
  })

  test('step 4 — both split entries are ACTIVE with correct content', async () => {
    const client = api(tokens.pe, PROJECT)
    const [oltpRes, batchRes] = await Promise.all([
      client.get(`/pg/versions/${topic}/${oltpKey}`),
      client.get(`/pg/versions/${topic}/${batchKey}`),
    ])
    expect(oltpRes.status).toBe(200)
    expect(oltpRes.data.status).toBe('ACTIVE')
    expect(oltpRes.data.summary).toBe(OLTP_CONTENT)

    expect(batchRes.status).toBe(200)
    expect(batchRes.data.status).toBe('ACTIVE')
    expect(batchRes.data.summary).toBe(BATCH_CONTENT)
  })

  test('step 5 — original key now has a SUPERSEDED version in history', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${poolSizeKey}/history`)
    expect(res.status).toBe(200)
    const superseded = res.data.find(v => v.status === 'SUPERSEDED')
    expect(superseded).toBeDefined()
    expect(superseded.version).toBe(1)
    expect(superseded.summary).toBe(ORIGINAL_CONTENT)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-02.7 — Resolve: Coexist Merge
// ─────────────────────────────────────────────────────────────────────────────

describe('S-02.7 — Coexist-Merge', () => {
  test.describe.configure({ mode: 'serial' })

  const topic = 'security'
  let rotationKey
  const ORIGINAL_CONTENT = 'Rotate secrets every 90 days.'
  const MERGED_CONTENT   = 'Rotate secrets every 90 days for standard services; every 30 days for services with PII access. Automated rotation preferred where available.'

  beforeAll(async () => {
    rotationKey = uid('secret-rotation')
    await activeEntry({ topic, key: rotationKey, content: ORIGINAL_CONTENT })
  })

  test('step 1 — PE supersedes with merged content', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.post(`/api/knowledge/${topic}/${rotationKey}/supersede`, {
      content:     MERGED_CONTENT,
      entity_type: 'Constraint',
      reason:      'Merged rotation requirements: 90d standard, 30d for PII services.',
    })
    expect(res.status).toBe(200)
    // Supersede returns { new_version: <full row object>, superseded_version: <number> }
    expect(res.data.new_version.version).toBeGreaterThan(1)
    expect(res.data.new_version.status).toBe('ACTIVE')
    expect(res.data.superseded_version).toBe(1)
  })

  test('step 2 — new version is ACTIVE with merged content', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${rotationKey}`)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.summary).toBe(MERGED_CONTENT)
    expect(res.data.version).toBeGreaterThan(1)
  })

  test('step 3 — previous version is SUPERSEDED (not deleted — provenance preserved)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${rotationKey}/history`)
    expect(res.status).toBe(200)
    const v1 = res.data.find(v => v.version === 1)
    expect(v1).toBeDefined()
    expect(v1.status).toBe('SUPERSEDED')
    expect(v1.summary).toBe(ORIGINAL_CONTENT)
  })

  test('step 4 — merged content matches submitted content exactly (no truncation)', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${topic}/${rotationKey}`)
    expect(res.status).toBe(200)
    expect(res.data.summary).toBe(MERGED_CONTENT)
    // Confirm character-level fidelity
    expect(res.data.summary.length).toBe(MERGED_CONTENT.length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-02.8 — Dashboard Conflict Review (UI)
// ─────────────────────────────────────────────────────────────────────────────
//
// These are full-browser Playwright tests that exercise the React dashboard.
// They require the dashboard service to be running (QUORUM_DASHBOARD_URL).
//
// Auth injection: injectSession() bypasses GitHub OAuth by writing the three
// sessionStorage keys that AuthContext.jsx reads during its useState() init.
// Must be called before page.goto() so the init script fires before React boots.
//
// Shared state across all 5 steps (serial mode):
//   beforeAll seeds ONE ACTIVE entry and ONE conflict for the entire describe.
//   Steps 1–3 do not resolve the conflict.
//   Step 4 approves it — the card disappears.
//   Step 5 verifies the resolution appears in the audit timeline.
//
// Architecture notes:
//   DecisionCard header: span.font-mono.text-blue-400 shows conflict_topic:conflict_key
//   ConflictDiff: "Existing (ACTIVE)" / "Incoming (DRAFT)" labels in the expanded body
//   ReviewForm: radio labels "Approve" / "Reject" / "Request changes"; submit disabled
//     when note.trim().length < 10; useReview() onSuccess invalidates ['pending']
//   After approve: TanStack Query refetches pending — card disappears from DOM.
//
// E2E: tests/e2e/scenarios/02-knowledge-governance.spec.js
//   S-02.8.1 — conflict card visible + diff panel expanded
//   S-02.8.2 — submit blocked at UI when note < 10 chars
//   S-02.8.3 — request_changes keeps conflict in pending
//   S-02.8.4 — approve removes card + transitions entry to ACTIVE
//   S-02.8.5 — audit page shows 'review' tool entries after resolution

describe('S-02.8 — Dashboard UI', () => {
  test.describe.configure({ mode: 'serial' })

  let s028Topic, s028Key
  const EXISTING_CONTENT = 'Existing ADR: use connection pools with max 10 connections per node.'
  const INCOMING_CONTENT = 'Proposed: increase connection pool to 25 for high-throughput read endpoints.'

  beforeAll(async () => {
    const token = uid('s028-ui')
    s028Topic   = 'db'
    s028Key     = token

    // Seed an ACTIVE entry that the engineer's draft will conflict with.
    await activeEntry({ topic: s028Topic, key: s028Key, content: EXISTING_CONTENT })

    // Seed the conflict: engineer writes conflicting DRAFT + pending_decisions row.
    // The conflict_id is not used directly — we find the card by topic:key in the UI.
    await conflict({
      topic:           s028Topic,
      key:             s028Key,
      content:         INCOMING_CONTENT,
      existingContent: EXISTING_CONTENT,
    })
  })

  test('step 1 — pending page shows conflict brief with both content versions', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/pending`)

    // Card header: conflict_topic:conflict_key in font-mono span
    await expect(page.getByText(`${s028Topic}:${s028Key}`)).toBeVisible()

    // Click the header to expand the card body
    await page.getByText(`${s028Topic}:${s028Key}`).click()

    // ConflictDiff renders two panels with these exact labels
    await expect(page.getByText('Existing (ACTIVE)')).toBeVisible()
    await expect(page.getByText('Incoming (DRAFT)')).toBeVisible()

    // Both content strings are rendered in the <pre> diff panels
    await expect(page.getByText(EXISTING_CONTENT)).toBeVisible()
    await expect(page.getByText(INCOMING_CONTENT)).toBeVisible()
  })

  test('step 2 — request_changes with < 10 chars is blocked at UI level', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/pending`)

    // Expand the conflict card
    await page.getByText(`${s028Topic}:${s028Key}`).click()

    // Open the review form
    await page.getByRole('button', { name: 'Review this decision' }).click()

    // Select "Request changes" action
    await page.getByText('Request changes').click()

    // Fill a note shorter than 10 characters
    const textarea = page.getByPlaceholder('Required: reason for this decision (min 10 chars)')
    await textarea.fill('too short')

    // Submit button is disabled when note.trim().length < 10 (ReviewForm.jsx:90)
    await expect(page.getByRole('button', { name: 'Submit review' })).toBeDisabled()
  })

  test('step 3 — valid request_changes note keeps conflict in pending', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/pending`)

    await page.getByText(`${s028Topic}:${s028Key}`).click()
    await page.getByRole('button', { name: 'Review this decision' }).click()
    await page.getByText('Request changes').click()

    const textarea = page.getByPlaceholder('Required: reason for this decision (min 10 chars)')
    await textarea.fill('Need more context and evidence before this can be approved.')

    await page.getByRole('button', { name: 'Submit review' }).click()

    // request_changes does NOT resolve the conflict — it stays in pending_decisions
    // with resolved_at = null. TanStack Query refetches and the card reappears.
    await expect(page.getByText(`${s028Topic}:${s028Key}`)).toBeVisible()
  })

  test('step 4 — approve via dashboard removes conflict and transitions to ACTIVE', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/pending`)

    await page.getByText(`${s028Topic}:${s028Key}`).click()
    await page.getByRole('button', { name: 'Review this decision' }).click()

    // "Approve" is the default selected action — no radio change needed
    const textarea = page.getByPlaceholder('Required: reason for this decision (min 10 chars)')
    await textarea.fill('Approved — connection pool increase is justified for current load.')

    await page.getByRole('button', { name: 'Submit review' }).click()

    // After approve, useReview() onSuccess invalidates ['pending'] — refetch removes
    // the resolved conflict from the response. Card disappears from DOM.
    await expect(page.getByText(`${s028Topic}:${s028Key}`)).not.toBeVisible()

    // Verify via API that the knowledge entry is now ACTIVE (DRAFT superseded → ACTIVE)
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/versions/${s028Topic}/${s028Key}`)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
  })

  test('step 5 — audit timeline shows review tool entries after resolution', async ({ page }) => {
    test.skip(!process.env.QUORUM_DASHBOARD_URL, 'browser tests require dashboard — set QUORUM_DASHBOARD_URL or use npm run test:e2e:docker')
    await injectSession(page)
    await page.goto(`${DASHBOARD_URL}/audit`)

    // Filter by "review" tool using the select dropdown (Audit.jsx TOOLS array)
    await page.getByRole('combobox').selectOption('review')

    // At least one audit entry rendered by AuditEntry.jsx should show 'review' as tool
    // (text-amber-400 span per TOOL_COLOR map)
    const reviewBadge = page.locator('span').filter({ hasText: /^review$/ }).first()
    await expect(reviewBadge).toBeVisible()

    // The PE who approved (test-pe) should appear as the author in the entry
    await expect(page.getByText('test-pe').first()).toBeVisible()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-02.9 — Authority Fence: non-PA cannot self-approve or review a conflict
// ─────────────────────────────────────────────────────────────────────────────

describe('S-02.9 — Authority Fence (NEGATIVE)', () => {
  /**
   * A core trust-model claim: only a principal_architect can resolve a conflict.
   * No other role — regardless of how senior — can call POST /api/review.
   *
   * This falsifies the claim for every non-PA role in the project, then confirms
   * the PA CAN resolve, and verifies the rejected DRAFT is immutably REJECTED
   * (no hard delete).
   *
   * Steps:
   *   1  PA writes ACTIVE baseline; engineer writes competing DRAFT + conflict
   *   2  Engineer tries to review their own conflict → 403 forbidden
   *   3  Senior engineer tries → 403 (higher authority, still not PA)
   *   4  Architect tries → 403 (highest non-PA role, still blocked)
   *   5  PA rejects the conflict → 200
   *   6  DRAFT version is now REJECTED in history (immutable — no hard delete)
   */

  test.describe.configure({ mode: 'serial' })

  const topic = 'auth'
  let fenceKey
  let conflictId
  const ACTIVE_CONTENT  = 'Use RS256 JWT signed by a rotating key. Rotate every 90 days.'
  const DRAFT_CONTENT   = 'Use HS256 shared-secret tokens. Simpler to implement for internal services.'

  beforeAll(async () => {
    fenceKey = uid('s029-authority-fence')
    await activeEntry({ topic, key: fenceKey, content: ACTIVE_CONTENT })
    ;({ conflictId } = await conflict({
      topic,
      key:             fenceKey,
      content:         DRAFT_CONTENT,
      existingContent: ACTIVE_CONTENT,
    }))
  })

  test('step 1 — engineer (conflict author) tries to review own conflict → 403', async () => {
    const res = await api(tokens.engineer, PROJECT).post(`/api/review/${conflictId}`, {
      action: 'reject',
      note:   'Engineer self-reject attempt — authority fence test for S-02.9.',
    })
    expect(res.status).toBe(403)
    expect(res.data.error).toBe('forbidden')
  })

  test('step 2 — senior_engineer tries to review → 403 (not PA)', async () => {
    const res = await api(tokens.senior, PROJECT).post(`/api/review/${conflictId}`, {
      action: 'reject',
      note:   'Senior engineer review attempt — authority fence test for S-02.9.',
    })
    expect(res.status).toBe(403)
    expect(res.data.error).toBe('forbidden')
  })

  test('step 3 — architect (highest non-PA role) tries to review → 403', async () => {
    const res = await api(tokens.architect, PROJECT).post(`/api/review/${conflictId}`, {
      action: 'reject',
      note:   'Architect review attempt — authority fence test for S-02.9.',
    })
    expect(res.status).toBe(403)
    expect(res.data.error).toBe('forbidden')
  })

  test('step 4 — PA rejects the conflict → 200', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/review/${conflictId}`, {
      action: 'reject',
      note:   'Rejecting HS256 proposal — RS256 with rotation is the correct approach per security policy.',
    })
    expect(res.status).toBe(200)
  })

  test('step 5 — DRAFT version is REJECTED in history (no hard delete)', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${fenceKey}/history`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data)).toBe(true)
    const rejected = res.data.find(v => v.status === 'REJECTED')
    expect(rejected).toBeDefined()
    expect(rejected.summary).toBe(DRAFT_CONTENT)
  })

  test('step 6 — original ACTIVE entry is unchanged after rejection', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${fenceKey}`)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.summary).toBe(ACTIVE_CONTENT)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-02.10 — Concurrent Competing DRAFTs (two engineers, same key)
// ─────────────────────────────────────────────────────────────────────────────

describe('S-02.10 — Concurrent Competing DRAFTs (RACE)', () => {
  /**
   * Two engineers write different DRAFTs for the same ACTIVE key in parallel.
   * The gateway must accept both writes independently without losing either.
   *
   * This tests write-path serialization: version numbers are allocated atomically
   * so no two DRAFTs share the same version_id. The PA then sees both DRAFTs in
   * the governance queue and can promote exactly one.
   *
   * Concurrent calls fire in beforeAll so all four assertion steps have the
   * captured responses available without re-running the writes.
   *
   * Steps:
   *   1  Both engineer writes succeed as DRAFT (no 4xx or 5xx)
   *   2  Both DRAFTs appear in GET /api/drafts
   *   3  History: ACTIVE v1 + two DRAFT versions, all with distinct version numbers
   *   4  PA promotes one DRAFT to ACTIVE; the other DRAFT remains (not auto-rejected)
   */

  test.describe.configure({ mode: 'serial' })

  const topic = 'infra'
  let raceKey
  const ACTIVE_CONTENT    = 'Use Terraform for all infrastructure. No manual console changes.'
  const ENGINEER_CONTENT  = 'Migrate from Terraform to Pulumi — TypeScript-native IaC with better type safety.'
  const SENIOR_CONTENT    = 'Adopt OpenTofu (Terraform fork) — same HCL, open-source, no BSL licensing risk.'

  /** @type {import('axios').AxiosResponse} */
  let engineerRes
  /** @type {import('axios').AxiosResponse} */
  let seniorRes

  beforeAll(async () => {
    raceKey = uid('s0210-iac-strategy')
    await activeEntry({ topic, key: raceKey, content: ACTIVE_CONTENT })

    // Both DRAFTs fire in the same event-loop tick — genuine concurrent write test.
    ;[engineerRes, seniorRes] = await Promise.all([
      api(tokens.engineer, PROJECT).post('/api/knowledge', {
        topic,
        key:         raceKey,
        content:     ENGINEER_CONTENT,
        entity_type: 'Decision',
      }),
      api(tokens.senior, PROJECT).post('/api/knowledge', {
        topic,
        key:         raceKey,
        content:     SENIOR_CONTENT,
        entity_type: 'Decision',
      }),
    ])
  })

  test('step 1 — both concurrent writes succeed as DRAFT (no write lost)', () => {
    expect(engineerRes.status).toBe(201)
    expect(engineerRes.data.status).toBe('DRAFT')
    expect(seniorRes.status).toBe(201)
    expect(seniorRes.data.status).toBe('DRAFT')
  })

  test('step 2 — both DRAFTs appear in GET /api/drafts (governance queue has two entries)', async () => {
    const res = await api(tokens.pe, PROJECT).get('/api/drafts')
    expect(res.status).toBe(200)
    const drafts = (res.data.drafts ?? []).filter(d => d.topic === topic && d.key === raceKey)
    // At least two DRAFTs for this key in the queue (concurrent writes both visible to PA)
    expect(drafts.length).toBeGreaterThanOrEqual(2)
  })

  test('step 3 — history has ACTIVE v1 plus two distinct DRAFT versions (no version collision)', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${raceKey}/history`)
    expect(res.status).toBe(200)
    const active = res.data.filter(v => v.status === 'ACTIVE')
    const drafts = res.data.filter(v => v.status === 'DRAFT')
    expect(active).toHaveLength(1)
    expect(drafts.length).toBeGreaterThanOrEqual(2)
    // Version numbers must be strictly increasing — no two entries share a version number
    const versions = res.data.map(v => v.version)
    const unique = new Set(versions)
    expect(unique.size).toBe(versions.length)
  })

  test('step 4 — PA promotes one DRAFT; the other DRAFT persists (not auto-rejected)', async () => {
    // Promote via the dashboard promote endpoint (PA-only path).
    // promote always picks the latest DRAFT by version number — no author selection.
    const promoteRes = await api(tokens.pe, PROJECT).post(
      `/api/knowledge/${topic}/${raceKey}/promote`,
      { note: 'One IaC strategy approved — remaining proposal stays queued for PA review.' },
    )
    expect(promoteRes.status).toBe(200)
    expect(promoteRes.data.promoted).toBe(true)

    // The other DRAFT must still exist — promote is not a bulk operation.
    // Which author's DRAFT was promoted depends on concurrent version ordering;
    // assert the count invariant rather than a specific author.
    const afterRes = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${raceKey}/history`)
    const remainingDrafts = afterRes.data.filter(v => v.status === 'DRAFT')
    expect(remainingDrafts.length).toBeGreaterThanOrEqual(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-02.11 — Supersede-Under-Review: ACTIVE replaced while conflict pending
// ─────────────────────────────────────────────────────────────────────────────

describe('S-02.11 — Supersede-Under-Review (ALTERNATE)', () => {
  /**
   * The PA supersedes the ACTIVE entry that a pending conflict was written against,
   * then resolves the now-stale conflict.
   *
   * Real-world scenario: engineer opens a conflict against v1 of a policy.
   * Before the PE reviews it, the PA publishes a completely new v3 (supersede).
   * The pending conflict is now "stale" — the ACTIVE it challenged no longer exists.
   *
   * Rejection is the safe resolution path: the DRAFT gets REJECTED, and the
   * newer ACTIVE (v3) remains in place unchanged.
   *
   * Steps:
   *   1  PA writes ACTIVE v1; engineer writes DRAFT v2 + conflict (conflictId captured)
   *   2  PA supersedes v1 with new ACTIVE v3 (independent of the pending conflict)
   *   3  GET /pg/versions confirms v3 is now ACTIVE; v1 is SUPERSEDED
   *   4  Pending conflict is still in GET /pg/pending (supersede doesn't auto-clear it)
   *   5  PA rejects the stale conflict → 200 (safe resolution path)
   *   6  v3 is still ACTIVE after rejection (not overridden by the stale DRAFT)
   */

  test.describe.configure({ mode: 'serial' })

  const topic = 'db'
  let staleKey
  let conflictId
  const V1_CONTENT    = 'Use read replicas for reporting queries. Primary handles writes only.'
  const DRAFT_CONTENT = 'Route all queries through a single primary — simplifies connection management.'
  const V3_CONTENT    = 'Use CQRS: separate read model (Postgres replica) from write model. No direct replica access from app layer.'

  beforeAll(async () => {
    staleKey = uid('s0211-stale-conflict')
    await activeEntry({ topic, key: staleKey, content: V1_CONTENT })
    ;({ conflictId } = await conflict({
      topic,
      key:             staleKey,
      content:         DRAFT_CONTENT,
      existingContent: V1_CONTENT,
    }))
  })

  test('step 1 — conflict exists in pending queue before any supersede', async () => {
    const res = await api(tokens.pe, PROJECT).get('/pg/pending')
    expect(res.status).toBe(200)
    const pending = Array.isArray(res.data) ? res.data : []
    expect(pending.some(d => d.conflict_id === conflictId)).toBe(true)
  })

  test('step 2 — PA supersedes v1 with new ACTIVE v3 (independent write)', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/knowledge/${topic}/${staleKey}/supersede`, {
      content:     V3_CONTENT,
      entity_type: 'Decision',
      reason:      'CQRS approach adopted team-wide — superseding read-replica pattern with proper command/query separation.',
    })
    expect(res.status).toBe(200)
  })

  test('step 3 — v3 is now ACTIVE; v1 is SUPERSEDED', async () => {
    const current = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${staleKey}`)
    expect(current.data.status).toBe('ACTIVE')
    expect(current.data.summary).toBe(V3_CONTENT)

    const history = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${staleKey}/history`)
    const v1 = history.data.find(v => v.summary === V1_CONTENT)
    expect(v1).toBeDefined()
    expect(v1.status).toBe('SUPERSEDED')
  })

  test('step 4 — stale conflict is still in GET /pg/pending (supersede does not auto-clear it)', async () => {
    const res = await api(tokens.pe, PROJECT).get('/pg/pending')
    expect(res.status).toBe(200)
    const pending = Array.isArray(res.data) ? res.data : []
    expect(pending.some(d => d.conflict_id === conflictId)).toBe(true)
  })

  test('step 5 — PA rejects stale conflict → 200 (safe path: DRAFT rejected, v3 untouched)', async () => {
    const res = await api(tokens.pe, PROJECT).post(`/api/review/${conflictId}`, {
      action: 'reject',
      note:   'Rejecting stale conflict — the underlying entry has been superseded by the CQRS decision. Original challenge no longer relevant.',
    })
    expect(res.status).toBe(200)
  })

  test('step 6 — v3 remains ACTIVE after stale conflict rejection (no accidental override)', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${staleKey}`)
    expect(res.status).toBe(200)
    expect(res.data.status).toBe('ACTIVE')
    expect(res.data.summary).toBe(V3_CONTENT)

    // DRAFT (engineer's challenge) must be REJECTED — not promoted, not lost
    const history = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${staleKey}/history`)
    const draft = history.data.find(v => v.summary === DRAFT_CONTENT)
    expect(draft).toBeDefined()
    expect(draft.status).toBe('REJECTED')
  })
})
