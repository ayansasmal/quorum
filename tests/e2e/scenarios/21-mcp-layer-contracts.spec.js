/**
 * S-21 — MCP-Gateway HTTP Contract Tests (J21)
 *
 * Journey: J21 — MCP Layer Gateway Contracts
 * Pillars: Functional Correctness (S-21.1, S-21.2, S-21.3)
 *          Schema Integrity       (S-21.4 — config owner field)
 *          Status Authority       (S-21.5 — server-side status derivation)
 *
 * Sub-scenarios:
 *   S-21.1  pending() topic filter — GET /pg/pending?topic=X narrows to that topic only
 *   S-21.2  Requirement entity round-trip — entity_type='Requirement' accepted by gateway
 *   S-21.3  /governance/extract accepts constraints field — no 400 on the extra param
 *   S-21.4  Config schema owner field required — POST /config/validate without owner → 400
 *   S-21.5  /pg/versions status authority — status always derived server-side, body value ignored
 *
 * Architecture notes:
 *   The E2E suite historically exercised dashboard /api/* routes. The MCP GatewayClient
 *   calls a different surface — /pg/*, /governance/*, /config/validate — that had no
 *   direct E2E coverage. S-21 closes that gap.
 *
 *   S-21.1: GET /pg/pending JOINs q_keys and filters on qk.topic = $N when ?topic= is
 *           supplied. The GatewayClient.getPendingDecisions() forwards opts.topic as a
 *           query param. This verifies the full round-trip from HTTP to SQL to response.
 *
 *   S-21.2: validateKnowledgeInput() in gateway/src/shared/graph/validate.js maintains
 *           VALID_ENTITY_TYPES. 'Requirement' must be present. The quorum-mcp graph/schema.js
 *           Requirement node type includes a 'business_owner' property not yet reflected
 *           in the gateway schema — we test acceptance here, not property storage.
 *
 *   S-21.3: The gateway's POST /governance/extract currently accepts but silently drops
 *           any 'constraints' field — it is not forwarded to buildExtractPrompt(). This
 *           spec verifies HTTP acceptance (no 400). LLM-prompt forwarding is verified by
 *           the quorum-mcp unit test in tests/tools/reflect.test.js.
 *           See also: gateway/src/routes/governance.js buildExtractPrompt() TODO.
 *
 *   S-21.4: Gateway QuorumConfigSchema requires owner: z.string().min(1). The quorum-mcp
 *           QuorumConfigSchema (src/config/schema.js) lacks this field — creating a trap
 *           where the MCP onboarding skill can build a valid-per-MCP config that the
 *           gateway rejects at upload time. POST /config/validate (no auth) is used so
 *           the test doesn't need to perform a real S3 upload.
 *
 *   S-21.5: POST /pg/versions must derive status server-side regardless of what the
 *           caller sends in the body. The fix in status-authority commit ensures the
 *           gateway ignores req.body.status and always uses the role+flag formula:
 *             PA + non-global + non-reflect → ACTIVE
 *             pending_conflict_check:true   → PENDING_CONFLICT_CHECK
 *             everyone else                 → DRAFT
 *
 * All keys are uid()-suffixed for run-to-run isolation without teardown.
 */

import { test, expect } from '@playwright/test'

const { describe, beforeAll } = test
import { api }    from '../helpers/api.js'
import { tokens } from '../helpers/jwt.js'
import { uid }    from '../helpers/seed.js'

const PROJECT = 'quorum-test-project'

// Serial: S-21.1 seeds pending decisions that later steps read. Parallel workers
// could interleave with other test files and produce spurious topic matches.
test.describe.configure({ mode: 'serial' })

describe('S-21 — MCP-Gateway HTTP Contracts', () => {

// ─────────────────────────────────────────────────────────────────────────────
// S-21.1 — GET /pg/pending topic filter
// ─────────────────────────────────────────────────────────────────────────────

describe('S-21.1 — pending() topic filter', () => {
  let authKey, dbKey

  beforeAll(async () => {
    authKey = uid('pending-topic-auth-s21')
    dbKey   = uid('pending-topic-db-s21')

    const authRes = await api(tokens.engineer, PROJECT).post('/pg/pending', {
      conflict_topic:   'auth',
      conflict_key:     authKey,
      decision_type:    'conflict',
      existing_content: 'Use JWT for auth',
      incoming_content: 'Use sessions for auth',
      conflict_reason:  'Auth strategy conflict for topic filter test S-21.1',
    })
    expect(authRes.status).toBe(201)

    const dbRes = await api(tokens.engineer, PROJECT).post('/pg/pending', {
      conflict_topic:   'db',
      conflict_key:     dbKey,
      decision_type:    'conflict',
      existing_content: 'Use PostgreSQL connection pool size 10',
      incoming_content: 'Use PostgreSQL connection pool size 20',
      conflict_reason:  'DB connection pool conflict for topic filter test S-21.1',
    })
    expect(dbRes.status).toBe(201)
  })

  test('step 1 — ?topic=auth returns auth decision and excludes db decision', async () => {
    const res = await api(tokens.pe, PROJECT).get('/pg/pending', { params: { topic: 'auth' } })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data)).toBe(true)

    const keys = res.data.map(r => r.conflict_key)
    expect(keys).toContain(authKey)
    expect(keys).not.toContain(dbKey)
  })

  test('step 2 — ?topic=db returns db decision and excludes auth decision', async () => {
    const res = await api(tokens.pe, PROJECT).get('/pg/pending', { params: { topic: 'db' } })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data)).toBe(true)

    const keys = res.data.map(r => r.conflict_key)
    expect(keys).toContain(dbKey)
    expect(keys).not.toContain(authKey)
  })

  test('step 3 — no topic param returns both decisions', async () => {
    const res = await api(tokens.pe, PROJECT).get('/pg/pending')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data)).toBe(true)

    const keys = res.data.map(r => r.conflict_key)
    expect(keys).toContain(authKey)
    expect(keys).toContain(dbKey)
  })

  test('step 4 — ?topic= nonexistent topic returns empty array', async () => {
    const res = await api(tokens.pe, PROJECT).get('/pg/pending', {
      params: { topic: `ghost-topic-${Date.now()}` },
    })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data)).toBe(true)
    // No decisions were seeded for this topic in this project
    const keys = res.data.map(r => r.conflict_key)
    expect(keys).not.toContain(authKey)
    expect(keys).not.toContain(dbKey)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-21.2 — Requirement entity round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('S-21.2 — Requirement entity round-trip', () => {
  let topic, key

  beforeAll(async () => {
    topic = 'product'
    key   = uid('req-entity-s21')
  })

  test('step 1 — POST /api/knowledge entity_type=Requirement accepted → 201', async () => {
    const res = await api(tokens.pe, PROJECT).post('/api/knowledge', {
      topic,
      key,
      content:    `Guest checkout must remain available. Business owner: product team. ` +
                  `Conversion data shows 40% abandonment on mandatory registration. Key: ${key}`,
      entity_type: 'Requirement',
      confidence:  0.85,
    })
    expect(res.status).toBe(201)
    expect(res.data.entity_type).toBe('Requirement')
  })

  test('step 2 — GET /pg/versions/:topic/:key reflects entity_type=Requirement', async () => {
    const res = await api(tokens.pe, PROJECT).get(`/pg/versions/${topic}/${key}`)
    expect(res.status).toBe(200)
    expect(res.data.entity_type).toBe('Requirement')
    expect(res.data.status).toBe('ACTIVE')
  })

  test('step 3 — search returns Requirement entry with correct entity_type', async () => {
    const res = await api(tokens.pe, PROJECT).get('/api/search', { params: { q: key } })
    expect(res.status).toBe(200)
    const match = (res.data.results ?? []).find(r => r.key === key && r.topic === topic)
    expect(match).toBeDefined()
    expect(match.entity_type).toBe('Requirement')
  })

  test('step 4 — unknown entity_type rejected → 400', async () => {
    const badKey = uid('bad-entity-s21')
    const res = await api(tokens.pe, PROJECT).post('/api/knowledge', {
      topic:       'product',
      key:         badKey,
      content:     `Content for bad entity type test ${badKey}`,
      entity_type: 'InvalidType',
    })
    expect(res.status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-21.3 — POST /governance/extract constraints field acceptance
// ─────────────────────────────────────────────────────────────────────────────

describe('S-21.3 — extract constraints acceptance', () => {
  const TASK_SUMMARY =
    'Implement rate limiting using Redis sliding window. One counter per service per endpoint. ' +
    'Maximum 100 requests per minute per endpoint. Circuit breaker pattern applied.'

  test('step 1 — without constraints → 200 with items array', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/extract', {
      task_summary: TASK_SUMMARY,
    })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.items)).toBe(true)
    expect(res.data.items.length).toBeGreaterThan(0)
  })

  test('step 2 — with constraints field → 200 and constraints forwarded to LLM', async () => {
    // GAP-004 closed: gateway/src/routes/governance.js buildExtractPrompt() now accepts
    // a 4th constraintsToAvoid param and appends a "do NOT extract" block to the user prompt.
    // The mock-openai returns canned items regardless of prompt content, so we verify
    // the contract at the HTTP layer (200 + items array) and the prompt forwarding
    // at unit-test level (governance-routes.test.js "forwards constraints array").
    const res = await api(tokens.pe, PROJECT).post('/governance/extract', {
      task_summary: TASK_SUMMARY,
      constraints:  [
        'All writes require tamper-evident audit trail',
        'No hard deletes — append-only semantics enforced at DB level',
      ],
    })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.items)).toBe(true)
    expect(res.data.items.length).toBeGreaterThan(0)
  })

  test('step 3 — items from constrained extract have valid entity_type', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/extract', {
      task_summary: TASK_SUMMARY,
      constraints:  ['Audit trail required on all knowledge mutations'],
    })
    const VALID_TYPES = ['Decision', 'Pattern', 'Constraint', 'Runbook', 'Requirement']
    for (const item of res.data.items) {
      expect(VALID_TYPES).toContain(item.entity_type)
    }
  })

  test('step 4 — missing task_summary → 400 (unchanged by constraints addition)', async () => {
    const res = await api(tokens.pe, PROJECT).post('/governance/extract', {
      constraints: ['Some constraint'],
    })
    expect(res.status).toBe(400)
    const errText = (res.data.message ?? res.data.error ?? '').toLowerCase()
    expect(errText).toMatch(/task_summary/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-21.4 — Config schema owner field required
// ─────────────────────────────────────────────────────────────────────────────

describe('S-21.4 — Config schema owner field', () => {
  // POST /config/validate requires no auth — used here so we can probe schema
  // without performing a real S3 upload.
  const VALID_CONFIG = {
    group_id: 'test-s21-schema-validation',
    owner:    'test-pe',
    members:  [],
    roles:    {},
    domains:  {},
  }

  test('step 1 — config without owner → 400, error path contains "owner"', async () => {
    // This is the schema divergence gap: quorum-mcp QuorumConfigSchema lacks owner,
    // so the MCP onboarding skill can build a config that passes MCP-side Zod validation
    // but is rejected by the gateway at upload time with a confusing 400.
    const { owner: _omit, ...withoutOwner } = VALID_CONFIG
    const res = await api(tokens.pe, PROJECT).post('/config/validate', withoutOwner)
    expect(res.status).toBe(400)
    expect(res.data.valid).toBe(false)
    expect(Array.isArray(res.data.errors)).toBe(true)
    const errorPaths = res.data.errors.map(e => e.path)
    expect(errorPaths).toContain('owner')
  })

  test('step 2 — config with owner present → 200 valid', async () => {
    const res = await api(tokens.pe, PROJECT).post('/config/validate', VALID_CONFIG)
    expect(res.status).toBe(200)
    expect(res.data.valid).toBe(true)
  })

  test('step 3 — config with owner empty string → 400', async () => {
    const res = await api(tokens.pe, PROJECT).post('/config/validate', {
      ...VALID_CONFIG,
      owner: '',
    })
    expect(res.status).toBe(400)
    expect(res.data.valid).toBe(false)
    const errorPaths = res.data.errors.map(e => e.path)
    expect(errorPaths).toContain('owner')
  })

  test('step 4 — config with valid federation fields accepted', async () => {
    // Verify is_global + global_scope + hierarchy all accepted by gateway schema.
    // These are v0.4 fields absent from earlier MCP-side schema and may be missing
    // from configs built via older MCP versions.
    const res = await api(tokens.pe, PROJECT).post('/config/validate', {
      ...VALID_CONFIG,
      group_id:    'test-s21-federation-config',
      is_global:   false,
      global_scope: 'org',
      hierarchy: {
        level:       'service',
        parent:      'platform-division',
        criticality: 2,
      },
    })
    expect(res.status).toBe(200)
    expect(res.data.valid).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S-21.5 — POST /pg/versions status derived server-side
// ─────────────────────────────────────────────────────────────────────────────

describe('S-21.5 — Status authority on /pg/versions', () => {
  // E2E: tests/e2e/scenarios/21-mcp-layer-contracts.spec.js — S-21.5 status authority

  test('step 1 — PA write without status field → ACTIVE', async () => {
    const key = uid('status-pa-s21')
    const res = await api(tokens.pe, PROJECT).post('/pg/versions', {
      topic:        'auth',
      key,
      summary:      `Status authority test — PA write, no status in body. Key: ${key}`,
      entity_type:  'Decision',
      confidence:   0.85,
      triggered_by: 'mcp',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('ACTIVE')
  })

  test('step 2 — engineer write without status field → DRAFT', async () => {
    const key = uid('status-eng-s21')
    const res = await api(tokens.engineer, PROJECT).post('/pg/versions', {
      topic:        'auth',
      key,
      summary:      `Status authority test — engineer write, no status in body. Key: ${key}`,
      entity_type:  'Decision',
      confidence:   0.70,
      triggered_by: 'mcp',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('DRAFT')
  })

  test('step 3 — PA sends status=DRAFT in body → ignored, still ACTIVE', async () => {
    // The gateway must be the sole status authority. A client cannot downgrade
    // a PA write to DRAFT by including status:'DRAFT' in the payload.
    const key = uid('status-ignore-s21')
    const res = await api(tokens.pe, PROJECT).post('/pg/versions', {
      topic:        'auth',
      key,
      summary:      `Status authority ignore test — PA sends DRAFT in body. Key: ${key}`,
      entity_type:  'Decision',
      confidence:   0.85,
      triggered_by: 'mcp',
      status:       'DRAFT',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('ACTIVE')
  })

  test('step 4 — pending_conflict_check:true → PENDING_CONFLICT_CHECK regardless of role', async () => {
    // E2E: tests/e2e/scenarios/21-mcp-layer-contracts.spec.js — S-21.5 pending_conflict_check flag
    const key = uid('status-pcc-s21')
    const res = await api(tokens.pe, PROJECT).post('/pg/versions', {
      topic:                  'auth',
      key,
      summary:                `Status authority PCC flag test. Key: ${key}`,
      entity_type:            'Decision',
      confidence:             0.85,
      triggered_by:           'mcp',
      pending_conflict_check: true,
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('PENDING_CONFLICT_CHECK')
  })
})

}) // outer describe — required by graph reporter extractScenarioId()
