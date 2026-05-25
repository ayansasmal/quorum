/**
 * J05 — RBAC Boundary Simulation
 *
 * Pillars:
 *   Knowledge Write (S-05.1)    — all 8 roles create knowledge; DRAFT/ACTIVE split + confidence floor
 *   PE-Only Gate (S-05.2–05.3) — promote, supersede, deprecate single + bulk
 *   Governance (S-05.4)         — review (PE-only); global catalog write (GLOBAL_WRITE_AUTHORITY)
 *   Deviation+Forget (S-05.5)   — deviation action (DEVIATION_ACTION_AUTHORITY); deprecate gate
 *   Portfolio+Admin (S-05.6)    — portfolio role gate; admin is_admin gate; missing project header
 *
 * Sub-scenarios:
 *   S-05.1  Knowledge create — all roles, DRAFT/ACTIVE matrix, confidence floor, cross-project 404
 *   S-05.2  Promote + supersede — PE-only gate (403 for all others)
 *   S-05.3  Deprecate single + bulk — PE-only gate (403 for all others)
 *   S-05.4  Review (PE-only) + global catalog write (GLOBAL_WRITE_AUTHORITY constitutional boundary)
 *   S-05.5  Deviation action (DEVIATION_ACTION_AUTHORITY) + forget / deprecate gate (PE-only)
 *   S-05.6  Portfolio access (PA/director/vp) + admin gate (is_admin only) + missing project header
 *
 * All 8 test roles exercised:
 *   test-pe (principal_architect), test-architect (architect),
 *   test-engineer (engineer), test-senior (senior_engineer),
 *   test-director (director), test-vp (vp_engineering),
 *   test-product (product_owner), test-compliance (compliance_officer)
 *
 * Implementation notes:
 *   - enforceGlobalWriteAuthority fires on POST /api/knowledge when target project is_global=true.
 *     Non-member roles and roles not in GLOBAL_WRITE_ROLES get 400 GLOBAL_WRITE_AUTHORITY.
 *     product_owner and compliance_officer ARE catalog members (fixture updated) → DRAFT.
 *   - enforceDeviationActionAuthority fires on POST /api/deviations/:id/action for
 *     engineer, senior_engineer, director, vp_engineering → 400 DEVIATION_ACTION_AUTHORITY.
 *   - "forget" (MCP deprecation_requested path) is MCP-layer behaviour tested in S-03.
 *     At HTTP level: non-PA → 403 on POST /api/knowledge/:t/:k/deprecate; PA → 200 DEPRECATED.
 *   - ConstitutionalViolation errors return HTTP 400 with { rule, message } body.
 */

import { test, expect } from '@playwright/test'
import { api, catalogApi, assertConstitutionalViolation } from '../helpers/api.js'
import { tokens }                                         from '../helpers/jwt.js'
import { uid, activeEntry, draftEntry, conflict, deviation } from '../helpers/seed.js'

test.describe.configure({ mode: 'serial' })

const PROJECT = 'quorum-test-project'
const CATALOG = 'quorum-test-catalog'

// ─── S-05.1  Knowledge create — all roles, outcome matrix ────────────────────

test.describe('S-05.1 — knowledge create: DRAFT/ACTIVE split + confidence floor', () => {
  /**
   * Every role creates a unique entry so uid() prevents cross-test collisions.
   * Submitted confidence:0.10 is always below base_confidence — the server applies
   * the floor and stores base_confidence instead.
   */
  const roleCases = [
    { token: tokens.engineer,   role: 'engineer',            status: 'DRAFT',  confidence: 0.70 },
    { token: tokens.senior,     role: 'senior_engineer',     status: 'DRAFT',  confidence: 0.75 },
    { token: tokens.director,   role: 'director',            status: 'DRAFT',  confidence: 0.75 },
    { token: tokens.vp,         role: 'vp_engineering',      status: 'DRAFT',  confidence: 0.75 },
    { token: tokens.product,    role: 'product_owner',       status: 'DRAFT',  confidence: 0.85 },
    { token: tokens.compliance, role: 'compliance_officer',  status: 'DRAFT',  confidence: 0.90 },
    { token: tokens.architect,  role: 'architect',           status: 'DRAFT',  confidence: 0.80 },
    { token: tokens.pe,         role: 'principal_architect', status: 'ACTIVE', confidence: 0.90 },
  ]

  for (const { token, role, status: expectedStatus, confidence: expectedConfidence } of roleCases) {
    test(`step 1 — ${role} creates entry → ${expectedStatus} at confidence ${expectedConfidence}`, async () => {
      const res = await api(token, PROJECT).post('/api/knowledge', {
        topic:       'rbac',
        key:         uid(`s051-${role.replace(/_/g, '-')}`),
        content:     `RBAC boundary test entry authored by ${role}.`,
        entity_type: 'Decision',
        // Omit confidence — server must apply base_confidence floor for this role.
        // (Submitting a sub-floor value like 0.10 is rejected by validation as < 0.5.)
      })
      expect(res.status).toBe(201)
      expect(res.data.status).toBe(expectedStatus)
      expect(res.data.confidence).toBe(expectedConfidence)
    })
  }

  test('step 2 — writing to an unknown project returns 404', async () => {
    // Project not found in DDB → gateway returns 404 after input validation passes.
    // entity_type is required by validateKnowledgeInput (runs before project lookup).
    const res = await api(tokens.pe, 'quorum-nonexistent-project-xyz').post('/api/knowledge', {
      topic:       'rbac',
      key:         uid('s051-xproj'),
      content:     'Cross-project access test — unknown project.',
      entity_type: 'Decision',
    })
    expect(res.status).toBe(404)
  })
})

// ─── S-05.2  Promote + supersede — PE-only gate ──────────────────────────────

test.describe('S-05.2 — promote + supersede: PE-only gate', () => {
  let draftTopic, draftKey, activeTopic, activeKey

  test.beforeAll(async () => {
    draftTopic  = 'rbac'
    draftKey    = uid('s052-draft')
    activeTopic = 'rbac'
    activeKey   = uid('s052-active')

    // DRAFT: engineer write (engineer is not PA → lands as DRAFT)
    await draftEntry({ topic: draftTopic, key: draftKey,
                       content: 'RBAC S-05.2 entry for promote test', project: PROJECT })
    // ACTIVE: PA write (PA → ACTIVE directly)
    await activeEntry({ topic: activeTopic, key: activeKey,
                        content: 'RBAC S-05.2 entry for supersede test', project: PROJECT })
  })

  const nonPeTokens = [
    ['engineer',           tokens.engineer],
    ['senior_engineer',    tokens.senior],
    ['director',           tokens.director],
    ['vp_engineering',     tokens.vp],
    ['product_owner',      tokens.product],
    ['compliance_officer', tokens.compliance],
    ['architect',          tokens.architect],
  ]

  for (const [role, token] of nonPeTokens) {
    test(`step 1 — ${role} cannot promote DRAFT → ACTIVE (403)`, async () => {
      const res = await api(token, PROJECT).post(
        `/api/knowledge/${draftTopic}/${draftKey}/promote`,
        { reason: `promote attempt by ${role}` },
      )
      expect(res.status).toBe(403)
      expect(res.data.error).toBe('forbidden')
    })
  }

  for (const [role, token] of nonPeTokens) {
    test(`step 2 — ${role} cannot supersede ACTIVE entry (403)`, async () => {
      const res = await api(token, PROJECT).post(
        `/api/knowledge/${activeTopic}/${activeKey}/supersede`,
        { content: `supersede attempt by ${role}`, reason: `supersede by ${role}` },
      )
      expect(res.status).toBe(403)
      expect(res.data.error).toBe('forbidden')
    })
  }

  test('step 3 — principal_architect can promote DRAFT → ACTIVE', async () => {
    const res = await api(tokens.pe, PROJECT).post(
      `/api/knowledge/${draftTopic}/${draftKey}/promote`,
      { note: 'PE promoting DRAFT to ACTIVE for S-05.2 — sufficiently long note' },
    )
    expect(res.status).toBe(200)
    expect(res.data.promoted).toBe(true)   // promote returns { promoted: true, version, version_id, topic, key }
  })

  test('step 4 — principal_architect can supersede ACTIVE entry', async () => {
    const res = await api(tokens.pe, PROJECT).post(
      `/api/knowledge/${activeTopic}/${activeKey}/supersede`,
      {
        content:     'Superseded content for S-05.2 RBAC test',
        entity_type: 'Decision',
        reason:      'PE superseding ACTIVE for S-05.2 test — valid reason',
      },
    )
    expect(res.status).toBe(200)
  })
})

// ─── S-05.3  Deprecate single + bulk — PE-only gate ──────────────────────────

test.describe('S-05.3 — deprecate: PE-only gate (single + bulk)', () => {
  let singleTopic, singleKey, bulkTopic, bulkKeys

  test.beforeAll(async () => {
    singleTopic = 'rbac'
    singleKey   = uid('s053-single')
    bulkTopic   = 'rbac'
    bulkKeys    = [uid('s053-bulk-a'), uid('s053-bulk-b')]

    await activeEntry({ topic: singleTopic, key: singleKey,
                        content: 'RBAC S-05.3 single deprecate test entry', project: PROJECT })
    for (const key of bulkKeys) {
      await activeEntry({ topic: bulkTopic, key,
                          content: `RBAC S-05.3 bulk deprecate entry ${key}`, project: PROJECT })
    }
  })

  const nonPeTokens = [
    ['engineer',           tokens.engineer],
    ['senior_engineer',    tokens.senior],
    ['director',           tokens.director],
    ['vp_engineering',     tokens.vp],
    ['product_owner',      tokens.product],
    ['compliance_officer', tokens.compliance],
    ['architect',          tokens.architect],
  ]

  for (const [role, token] of nonPeTokens) {
    test(`step 1 — ${role} cannot single-deprecate (403)`, async () => {
      const res = await api(token, PROJECT).post(
        `/api/knowledge/${singleTopic}/${singleKey}/deprecate`,
        { reason: `non-PA deprecate attempt by ${role}` },
      )
      expect(res.status).toBe(403)
      expect(res.data.error).toBe('forbidden')
    })
  }

  for (const [role, token] of nonPeTokens) {
    test(`step 2 — ${role} cannot bulk-deprecate (403)`, async () => {
      const res = await api(token, PROJECT).post('/api/knowledge/deprecate/bulk', {
        entries: bulkKeys.map(key => ({ topic: bulkTopic, key })),
        reason:  `non-PA bulk deprecate by ${role}`,
      })
      expect(res.status).toBe(403)
      expect(res.data.error).toBe('forbidden')
    })
  }

  test('step 3 — principal_architect can single-deprecate', async () => {
    const res = await api(tokens.pe, PROJECT).post(
      `/api/knowledge/${singleTopic}/${singleKey}/deprecate`,
      { reason: 'PE deprecating entry for S-05.3 RBAC test — valid long reason' },
    )
    expect(res.status).toBe(200)
    expect(res.data.deprecated).toBe(true)   // route returns { deprecated: true, topic, key }
  })

  test('step 4 — principal_architect can bulk-deprecate', async () => {
    const res = await api(tokens.pe, PROJECT).post('/api/knowledge/deprecate/bulk', {
      entries: bulkKeys.map(key => ({ topic: bulkTopic, key })),
      reason:  'PE bulk deprecating for S-05.3 RBAC test — valid reason',
    })
    expect(res.status).toBe(200)
    expect(res.data.deprecated).toHaveLength(2)
  })
})

// ─── S-05.4  Review (PE-only) + global catalog write (GLOBAL_WRITE_AUTHORITY) ─

test.describe('S-05.4 — review (PE-only) + global write authority (GLOBAL_WRITE_AUTHORITY)', () => {
  let conflictId

  test.beforeAll(async () => {
    const topic = 'rbac'
    const key   = uid('s054-conflict')

    // conflict() seeds a DRAFT (via engineer) + a pending_decision row.
    // PA reviewer and DRAFT author are different sub values → no self-approval violation.
    const result = await conflict({
      topic,
      key,
      content:         'Conflicting RBAC S-05.4 content submitted by engineer',
      existingContent: 'Existing S-05.4 content (for display in pending review UI)',
      project:         PROJECT,
    })
    conflictId = result.conflictId
  })

  // ── Review: PE-only gate ──────────────────────────────────────────────────────

  const nonPeTokens = [
    ['engineer',           tokens.engineer],
    ['senior_engineer',    tokens.senior],
    ['director',           tokens.director],
    ['vp_engineering',     tokens.vp],
    ['product_owner',      tokens.product],
    ['compliance_officer', tokens.compliance],
    ['architect',          tokens.architect],
  ]

  for (const [role, token] of nonPeTokens) {
    test(`step 1 — ${role} cannot review conflict (403)`, async () => {
      if (!conflictId) test.skip(true, 'conflict seed not available — check beforeAll')
      const res = await api(token, PROJECT).post(`/api/review/${conflictId}`, {
        action: 'approve',
        note:   `Review attempt by ${role} — should be 403 immediately`,
      })
      expect(res.status).toBe(403)
    })
  }

  test('step 2 — principal_architect can approve conflict', async () => {
    if (!conflictId) test.skip(true, 'conflict seed not available — check beforeAll')
    const res = await api(tokens.pe, PROJECT).post(`/api/review/${conflictId}`, {
      action: 'approve',
      note:   'PA approving conflict in S-05.4 — valid note with more than 10 chars',
    })
    expect(res.status).toBe(200)
  })

  // ── Global write authority ────────────────────────────────────────────────────
  // quorum-test-catalog has is_global:true. GLOBAL_WRITE_ROLES = [architect,
  // principal_architect, product_owner, compliance_officer].
  //
  // Blocked: roles not in GLOBAL_WRITE_ROLES (engineer, senior_engineer, director,
  // vp_engineering) AND non-members (any user with role:null).
  //
  // Allowed: architect (catalog member → DRAFT), product_owner (catalog member → DRAFT),
  //          compliance_officer (catalog member → DRAFT), PA (catalog member → ACTIVE).

  const globalBlockedTokens = [
    ['engineer',        tokens.engineer],
    ['senior_engineer', tokens.senior],
    ['director',        tokens.director],
    ['vp_engineering',  tokens.vp],
  ]

  for (const [role, token] of globalBlockedTokens) {
    test(`step 3 — ${role} cannot write to global catalog (400 GLOBAL_WRITE_AUTHORITY)`, async () => {
      // entity_type required by validateKnowledgeInput — must pass validation so
      // enforceGlobalWriteAuthority fires (runs after validation in the route).
      const res = await catalogApi(token).post('/api/knowledge', {
        topic:       'security',
        key:         uid(`s054-${role.replace(/_/g, '-')}-block`),
        content:     `Global write attempt by ${role} — should be GLOBAL_WRITE_AUTHORITY`,
        entity_type: 'Decision',
      })
      assertConstitutionalViolation(res, 'GLOBAL_WRITE_AUTHORITY')
    })
  }

  test('step 4 — architect (catalog member) writes to global catalog → DRAFT', async () => {
    const res = await catalogApi(tokens.architect).post('/api/knowledge', {
      topic:       'security',
      key:         uid('s054-arch'),
      content:     'Global catalog entry by architect — lands as DRAFT for PA approval (S-05.4)',
      entity_type: 'Decision',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('DRAFT')
  })

  test('step 5 — product_owner (catalog member) writes to global catalog → DRAFT', async () => {
    const res = await catalogApi(tokens.product).post('/api/knowledge', {
      topic:       'security',
      key:         uid('s054-product'),
      content:     'Global catalog entry by product_owner — lands as DRAFT for PA approval (S-05.4)',
      entity_type: 'Decision',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('DRAFT')
  })

  test('step 6 — compliance_officer (catalog member) writes to global catalog → DRAFT', async () => {
    const res = await catalogApi(tokens.compliance).post('/api/knowledge', {
      topic:       'security',
      key:         uid('s054-compliance'),
      content:     'Global catalog entry by compliance_officer — lands as DRAFT for PA approval (S-05.4)',
      entity_type: 'Decision',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('DRAFT')
  })

  test('step 7 — principal_architect (catalog member) writes to global catalog → ACTIVE', async () => {
    const res = await catalogApi(tokens.pe).post('/api/knowledge', {
      topic:       'security',
      key:         uid('s054-pa'),
      content:     'Global catalog entry by PA — lands as ACTIVE directly (S-05.4)',
      entity_type: 'Decision',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('ACTIVE')
  })
})

// ─── S-05.5  Deviation action + forget (deprecate gate) ──────────────────────

test.describe('S-05.5 — deviation action (DEVIATION_ACTION_AUTHORITY) + deprecate gate', () => {
  let deviationId, forgeTopic, forgetKey

  test.beforeAll(async () => {
    // Seed a global catalog entry so the deviation can reference a real topic:key
    const devTopic = 'security'
    const devKey   = uid('s055-dev')
    await activeEntry({
      topic:   devTopic,
      key:     devKey,
      content: 'TLS minimum version enforcement standard for S-05.5 RBAC test',
      project: CATALOG,
    })

    // Record a deviation from quorum-test-project against the catalog entry
    const devResult = await deviation({
      catalogId:   CATALOG,
      topic:       devTopic,
      key:         devKey,
      description: `S-05.5 RBAC deviation — TLS enforcement gap ${devKey}`,
      project:     PROJECT,
    })
    deviationId = devResult.deviationId

    // Seed an ACTIVE entry in the project for the deprecate gate tests
    forgeTopic = 'rbac'
    forgetKey  = uid('s055-forget')
    await activeEntry({
      topic:   forgeTopic,
      key:     forgetKey,
      content: 'RBAC S-05.5 entry seeded for forget/deprecate gate test',
      project: PROJECT,
    })
  })

  // ── Deviation action: blocked roles ──────────────────────────────────────────
  // enforceDeviationActionAuthority allows only: architect, principal_architect,
  // product_owner, compliance_officer. All others get 400 DEVIATION_ACTION_AUTHORITY.

  const deviationBlockedTokens = [
    ['engineer',        tokens.engineer],
    ['senior_engineer', tokens.senior],
    ['director',        tokens.director],
    ['vp_engineering',  tokens.vp],
  ]

  for (const [role, token] of deviationBlockedTokens) {
    test(`step 1 — ${role} cannot action deviation (400 DEVIATION_ACTION_AUTHORITY)`, async () => {
      if (!deviationId) test.skip(true, 'deviation seed not available — check beforeAll')
      const res = await api(token, PROJECT).post(`/api/deviations/${deviationId}/action`, {
        action_type: 'accept',
        reason:      `${role} accept attempt — constitutional rule should block this action`,
      })
      assertConstitutionalViolation(res, 'DEVIATION_ACTION_AUTHORITY')
    })
  }

  // ── Deviation action: allowed roles ──────────────────────────────────────────
  // Multiple accepts on the same deviation are allowed (audit trail; status = last action).

  const deviationAllowedTokens = [
    ['architect',          tokens.architect],
    ['product_owner',      tokens.product],
    ['compliance_officer', tokens.compliance],
  ]

  for (const [role, token] of deviationAllowedTokens) {
    test(`step 2 — ${role} can action deviation (accept → 200)`, async () => {
      if (!deviationId) test.skip(true, 'deviation seed not available — check beforeAll')
      const res = await api(token, PROJECT).post(`/api/deviations/${deviationId}/action`, {
        action_type: 'accept',
        reason:      `${role} accepting deviation in S-05.5 — valid acceptance reason`,
      })
      expect(res.status).toBe(200)
      expect(res.data.action_id).toBeDefined()
    })
  }

  test('step 3 — principal_architect can action deviation (accept → 200)', async () => {
    if (!deviationId) test.skip(true, 'deviation seed not available — check beforeAll')
    const res = await api(tokens.pe, PROJECT).post(`/api/deviations/${deviationId}/action`, {
      action_type: 'accept',
      reason:      'PA accepting deviation in S-05.5 — final record with full authority',
    })
    expect(res.status).toBe(200)
    expect(res.data.action_id).toBeDefined()
  })

  // ── Forget / deprecate gate ───────────────────────────────────────────────────
  // POST /api/knowledge/:t/:k/deprecate is PE-only (requirePrincipalArchitect).
  // Note: the MCP forget() path (deprecation_requested for non-PE) is tested in S-03.
  // At HTTP level, non-PA always gets 403; PA gets 200 DEPRECATED.

  const nonPeTokens = [
    ['engineer',           tokens.engineer],
    ['senior_engineer',    tokens.senior],
    ['director',           tokens.director],
    ['vp_engineering',     tokens.vp],
    ['product_owner',      tokens.product],
    ['compliance_officer', tokens.compliance],
    ['architect',          tokens.architect],
  ]

  for (const [role, token] of nonPeTokens) {
    test(`step 4 — ${role} cannot deprecate ACTIVE entry (403)`, async () => {
      const res = await api(token, PROJECT).post(
        `/api/knowledge/${forgeTopic}/${forgetKey}/deprecate`,
        { reason: `${role} deprecate attempt — requirePrincipalArchitect should block` },
      )
      expect(res.status).toBe(403)
      expect(res.data.error).toBe('forbidden')
    })
  }

  test('step 5 — principal_architect can deprecate ACTIVE entry → DEPRECATED', async () => {
    const res = await api(tokens.pe, PROJECT).post(
      `/api/knowledge/${forgeTopic}/${forgetKey}/deprecate`,
      { reason: 'PA deprecating entry in S-05.5 RBAC test — valid reason with length' },
    )
    expect(res.status).toBe(200)
    expect(res.data.deprecated).toBe(true)   // route returns { deprecated: true, topic, key }
  })
})

// ─── S-05.6  Portfolio access + admin gate ────────────────────────────────────

test.describe('S-05.6 — portfolio access + admin gate + missing project header', () => {
  // ── Portfolio: PA/director/vp allowed; all others blocked ────────────────────

  const portfolioBlockedTokens = [
    ['engineer',           tokens.engineer],
    ['senior_engineer',    tokens.senior],
    ['architect',          tokens.architect],
    ['product_owner',      tokens.product],
    ['compliance_officer', tokens.compliance],
  ]

  for (const [role, token] of portfolioBlockedTokens) {
    test(`step 1 — ${role} cannot access portfolio (403)`, async () => {
      const res = await api(token, PROJECT).get('/api/portfolio')
      expect(res.status).toBe(403)
    })
  }

  const portfolioAllowedTokens = [
    ['principal_architect', tokens.pe],
    ['director',            tokens.director],
    ['vp_engineering',      tokens.vp],
  ]

  for (const [role, token] of portfolioAllowedTokens) {
    test(`step 2 — ${role} can access portfolio (200 with projects array)`, async () => {
      const res = await api(token, PROJECT).get('/api/portfolio')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.data.projects)).toBe(true)
    })
  }

  // ── Admin gate: is_admin flag required — no regular role grants admin access ─

  const allRoleTokens = [
    ['engineer',           tokens.engineer],
    ['senior_engineer',    tokens.senior],
    ['architect',          tokens.architect],
    ['principal_architect',tokens.pe],
    ['director',           tokens.director],
    ['vp_engineering',     tokens.vp],
    ['product_owner',      tokens.product],
    ['compliance_officer', tokens.compliance],
  ]

  for (const [role, token] of allRoleTokens) {
    test(`step 3 — ${role} (no is_admin) cannot access admin config (403)`, async () => {
      const res = await api(token, PROJECT).get('/admin/config')
      expect(res.status).toBe(403)
    })
  }

  test('step 4 — is_admin JWT can access admin config (200)', async () => {
    const res = await api(tokens.admin, PROJECT).get('/admin/config')
    expect(res.status).toBe(200)
  })

  // ── Missing X-Quorum-Project header → 400 ────────────────────────────────────
  // The project middleware returns 400 when the header is absent on project-scoped routes.

  test('step 5 — missing X-Quorum-Project header on project-scoped route returns 400', async () => {
    const GATEWAY_URL = process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001'
    // Use axios directly to send a request without X-Quorum-Project header
    const { default: axios } = await import('axios')
    const res = await axios.get(`${GATEWAY_URL}/api/deviations`, {
      headers:        { Authorization: `Bearer ${tokens.pe}` },
      validateStatus: () => true,
    })
    expect(res.status).toBe(400)
  })
})
