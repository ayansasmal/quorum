/**
 * S-02 — Knowledge Governance Lifecycle (J02)
 *
 * Journey: J02 — docs/e2e/journeys/J02-knowledge-governance.md
 * Pillars: Functional Correctness (S-02.1, S-02.4–S-02.7)
 *          Governance Integrity (S-02.2)
 *          Data Integrity (S-02.3)
 *
 * Sub-scenarios:
 *   S-02.1  Write + Recall (PA ACTIVE / engineer DRAFT / search)
 *   S-02.2  Conflict detection (DRAFT against ACTIVE + /governance/detect-conflict)
 *   S-02.3  Resolve: approve → supersede (DRAFT → ACTIVE, old → SUPERSEDED)
 *   S-02.4  Resolve: reject (DRAFT → REJECTED, old ACTIVE unchanged)
 *   S-02.5  Resolve: request_changes (stays pending with note)
 *   S-02.6  Resolve: coexist_split (PE manually creates two new entries)
 *   S-02.7  Resolve: coexist_merge (PE supersedes with merged content)
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
      key:     sessionKey,
      content: incomingContent,
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
    // Missing 'incoming' → 422
    const res = await client.post('/governance/detect-conflict', {
      existing: existingContent,
    })
    expect(res.status).toBe(422)
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

  test('step 4 — audit lineage records the supersede transition', async () => {
    const client = api(tokens.pe, PROJECT)
    const res = await client.get(`/pg/audit/lineage/${topic}/${deployKey}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.entries)).toBe(true)
    expect(res.data.entries.length).toBeGreaterThan(0)
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
    expect(res.data.new_version).toBeGreaterThan(1)
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
    expect(res.data.new_version).toBeGreaterThan(1)
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
// Deferred: requires full browser automation (click, fill, navigate).
// Current E2E runner uses PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — API tests only.
// Re-enable when browser-mode tests are added (v0.5+).

describe('S-02.8 — Dashboard UI', () => {
  test.describe.configure({ mode: 'serial' })

  test.skip('step 1 — pending page shows conflict brief with both content versions [browser required]', () => {})
  test.skip('step 2 — request_changes with < 10 chars is blocked at UI level [browser required]', () => {})
  test.skip('step 3 — valid request_changes note keeps conflict in pending [browser required]', () => {})
  test.skip('step 4 — approve via dashboard removes conflict and transitions to ACTIVE [browser required]', () => {})
  test.skip('step 5 — audit timeline shows INTENT + OUTCOME entries for resolution [browser required]', () => {})
})
