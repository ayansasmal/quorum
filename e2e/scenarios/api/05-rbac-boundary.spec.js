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
 *   S-05.7  Cross-project role context — same JWT yields different role per project (NEGATIVE)
 *   S-05.8  Concurrent RBAC race — authorized + unauthorized request simultaneously (NEGATIVE)
 *   S-05.9  Role update + cache invalidation — new role reflected immediately (ALTERNATE)
 *   S-05.10 is_public enforcement — non-member of private project denied on all /api routes (NEGATIVE)
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
 *   - S-05.7 uses quorum-test-peer-project where test-architect is PA and test-pe is engineer.
 *     This fixture deliberately inverts the roles from quorum-test-project to make cross-project
 *     role isolation falsifiable: the same JWT must resolve to different roles in different projects.
 *   - S-05.9 uses POST /config/update-role to change test-engineer's role mid-test.
 *     afterAll always resets test-engineer to 'engineer' so the suite is idempotent across reruns.
 */

import { test, expect } from '@playwright/test'
import { api, catalogApi, assertConstitutionalViolation } from '../../helpers/api.js'
import { tokens }                                         from '../../helpers/jwt.js'
import { uid, activeEntry, draftEntry, conflict, deviation } from '../../helpers/seed.js'

test.describe.configure({ mode: 'serial' })

const PROJECT      = 'quorum-test-project'
const CATALOG      = 'quorum-test-catalog'
/** Role-reversed peer project: test-architect is PA here; test-pe is engineer. */
const PEER_PROJECT = 'quorum-test-peer-project'

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

  test('step 2 — writing to an unknown project returns 403', async () => {
    // Non-existent project: verify-jwt sets access_denied=true (fail-safe — cannot load config
    // → treats as private). resolveQProjectId returns 403 before any DB lookup.
    // This prevents project enumeration (leaking 404 vs 403 would reveal project existence).
    const res = await api(tokens.pe, 'quorum-nonexistent-project-xyz').post('/api/knowledge', {
      topic:       'rbac',
      key:         uid('s051-xproj'),
      content:     'Cross-project access test — unknown project.',
      entity_type: 'Decision',
    })
    expect(res.status).toBe(403)
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
  // Non-members of the catalog (engineer, senior_engineer, director, vp_engineering)
  // are blocked at the access_denied gate (403) before reaching enforceGlobalWriteAuthority.
  // The GLOBAL_WRITE_AUTHORITY constitutional rule fires only when a catalog *member* has
  // a role not in GLOBAL_WRITE_ROLES — enforced at the unit test level (shared-governance.test.js).
  //
  // Allowed: architect (catalog member → DRAFT), product_owner (catalog member → DRAFT),
  //          compliance_officer (catalog member → DRAFT), PA (catalog member → DRAFT, S-11.1).

  const globalBlockedTokens = [
    ['engineer',        tokens.engineer],
    ['senior_engineer', tokens.senior],
    ['director',        tokens.director],
    ['vp_engineering',  tokens.vp],
  ]

  for (const [role, token] of globalBlockedTokens) {
    test(`step 3 — ${role} (non-member) cannot write to global catalog → 403`, async () => {
      // Non-members: access_denied=true fires in resolveQProjectId before any route logic.
      // enforceGlobalWriteAuthority is not reached — the access gate is the first barrier.
      const res = await catalogApi(token).post('/api/knowledge', {
        topic:       'security',
        key:         uid(`s054-${role.replace(/_/g, '-')}-block`),
        content:     `Global write attempt by ${role} — blocked as non-member`,
        entity_type: 'Decision',
      })
      expect(res.status).toBe(403)
      expect(res.data.error).toBe('forbidden')
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

  test('step 7 — principal_architect (catalog member) writes to global catalog → DRAFT (self-approval prevention S-11.1)', async () => {
    const res = await catalogApi(tokens.pe).post('/api/knowledge', {
      topic:       'security',
      key:         uid('s054-pa'),
      content:     'Global catalog entry by PA — lands as DRAFT; second PA must approve (S-05.4/S-11.1)',
      entity_type: 'Decision',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('DRAFT')
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
      globalCatalog: true,
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

// ─── S-05.7  Cross-project role context (NEGATIVE) ───────────────────────────

test.describe('S-05.7 — cross-project role context: same JWT yields different role per project', () => {
  /**
   * Role is NOT encoded in the JWT. The gateway resolves it from DDB + Redis cache
   * keyed by (sub, group_id) on every request. The same ES256 token for test-pe yields:
   *   - principal_architect in quorum-test-project (PA access — ACTIVE writes, promote)
   *   - engineer            in quorum-test-peer-project (restricted — DRAFT writes, 403 on promote)
   *
   * This is the fundamental RBAC isolation contract: changing X-Quorum-Project changes
   * the effective role, without any token change.
   *
   * @see tests/e2e/fixtures/quorum-test-peer-project.quorum.json
   */

  /** @type {string} */
  let peerDraftKey

  test.beforeAll(async () => {
    peerDraftKey = uid('s057-peer-draft')
    // test-engineer (engineer in peer-project) seeds the DRAFT so test-architect (PA) can promote it
    const res = await api(tokens.engineer, PEER_PROJECT).post('/api/knowledge', {
      topic:       'rbac-xproject',
      key:         peerDraftKey,
      content:     'S-05.7 cross-project role context test — seeded by engineer in peer-project.',
      entity_type: 'Decision',
    })
    if (res.status !== 201) {
      throw new Error(`S-05.7 beforeAll: peer DRAFT seed failed: ${res.status} ${JSON.stringify(res.data)}`)
    }
  })

  test('step 1 — test-pe writing to test-project (PA) lands as ACTIVE', async () => {
    const res = await api(tokens.pe, PROJECT).post('/api/knowledge', {
      topic:       'rbac-xproject',
      key:         uid('s057-tp'),
      content:     'S-05.7 test-pe in test-project (PA role) — must be ACTIVE.',
      entity_type: 'Decision',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('ACTIVE')
  })

  test('step 2 — same test-pe JWT writing to peer-project (engineer) lands as DRAFT', async () => {
    // test-pe has role:engineer in quorum-test-peer-project per fixture — not PA.
    // Same JWT, different project header → knowledge must land as DRAFT.
    const res = await api(tokens.pe, PEER_PROJECT).post('/api/knowledge', {
      topic:       'rbac-xproject',
      key:         uid('s057-pp'),
      content:     'S-05.7 test-pe in peer-project (engineer role) — must be DRAFT.',
      entity_type: 'Decision',
    })
    expect(res.status).toBe(201)
    expect(res.data.status).toBe('DRAFT')
  })

  test('step 3 — test-pe (engineer in peer-project) cannot promote → 403', async () => {
    const res = await api(tokens.pe, PEER_PROJECT).post(
      `/api/knowledge/rbac-xproject/${peerDraftKey}/promote`,
      { note: 'test-pe trying to promote in peer-project as engineer — should be denied.' },
    )
    expect(res.status).toBe(403)
    expect(res.data.error).toBe('forbidden')
  })

  test('step 4 — test-architect (architect in test-project) cannot promote there → 403', async () => {
    // test-architect is only architect (not PA) in quorum-test-project — promote denied.
    const tpDraftKey = uid('s057-tp-arch-attempt')
    await draftEntry({
      topic:   'rbac-xproject',
      key:     tpDraftKey,
      content: 'S-05.7 DRAFT seeded for architect promote attempt in test-project.',
      project: PROJECT,
    })
    const res = await api(tokens.architect, PROJECT).post(
      `/api/knowledge/rbac-xproject/${tpDraftKey}/promote`,
      { note: 'test-architect (architect, not PA) promoting in test-project — should fail.' },
    )
    expect(res.status).toBe(403)
    expect(res.data.error).toBe('forbidden')
  })

  test('step 5 — test-architect (PA in peer-project) CAN promote peer DRAFT → 200', async () => {
    // The same test-architect JWT that cannot promote in test-project (architect role)
    // CAN promote in peer-project (PA role). This is the cross-project role isolation proof.
    const res = await api(tokens.architect, PEER_PROJECT).post(
      `/api/knowledge/rbac-xproject/${peerDraftKey}/promote`,
      { note: 'test-architect (PA in peer-project) promoting — must succeed with 10+ char note.' },
    )
    expect(res.status).toBe(200)
    expect(res.data.promoted).toBe(true)
  })
})

// ─── S-05.8  Concurrent RBAC race: authorized + unauthorized simultaneous ─────

test.describe('S-05.8 — concurrent RBAC race: authorized + unauthorized simultaneous request', () => {
  /**
   * RBAC checks are per-request, not per-session. When an unauthorized user (engineer)
   * and an authorized user (PA) fire the same PA-only action concurrently, the
   * authorization middleware must evaluate each request independently in parallel.
   *
   * The concurrent call is made once in beforeAll so the two HTTP responses are
   * available to all three steps as independent assertions. Each step reports a
   * distinct failure mode: engineer denied, PA succeeded, no state corruption.
   */

  /** @type {string} */
  let raceTopic
  /** @type {string} */
  let raceKey
  /** @type {import('axios').AxiosResponse} */
  let engineerRaceRes
  /** @type {import('axios').AxiosResponse} */
  let peRaceRes

  test.beforeAll(async () => {
    raceTopic = 'rbac-race'
    raceKey   = uid('s058')
    await draftEntry({
      topic:   raceTopic,
      key:     raceKey,
      content: 'S-05.8 concurrent RBAC race — seeded by engineer; PA and engineer promote simultaneously.',
      project: PROJECT,
    })
    // Both requests fire in the same event-loop tick — true concurrent authorization test.
    ;[engineerRaceRes, peRaceRes] = await Promise.all([
      api(tokens.engineer, PROJECT).post(
        `/api/knowledge/${raceTopic}/${raceKey}/promote`,
        { note: 'engineer concurrent promote attempt — S-05.8 authorization race test.' },
      ),
      api(tokens.pe, PROJECT).post(
        `/api/knowledge/${raceTopic}/${raceKey}/promote`,
        { note: 'PA concurrent promote — must win the authorization check in S-05.8.' },
      ),
    ])
  })

  test('step 1 — engineer concurrent promote denied → 403 forbidden', () => {
    // Authorization gate must hold regardless of concurrent PA request in flight.
    expect(engineerRaceRes.status).toBe(403)
    expect(engineerRaceRes.data.error).toBe('forbidden')
  })

  test('step 2 — PA concurrent promote succeeds → 200 promoted', () => {
    // Authorized request must not be degraded by the concurrent unauthorized request.
    expect(peRaceRes.status).toBe(200)
    expect(peRaceRes.data.promoted).toBe(true)
  })

  test('step 3 — exactly one ACTIVE version after race (no state corruption)', async () => {
    const histRes = await api(tokens.pe, PROJECT).get(
      `/pg/versions/${raceTopic}/${raceKey}/history`,
    )
    expect(histRes.status).toBe(200)
    const activeVersions = histRes.data.filter(v => v.status === 'ACTIVE')
    // Race must not create duplicate ACTIVE or leave zero ACTIVE versions.
    expect(activeVersions).toHaveLength(1)
  })
})

// ─── S-05.9  Role update + immediate permission reflection ────────────────────

test.describe('S-05.9 — role update: new role reflected immediately (Redis cache invalidation)', () => {
  /**
   * POST /config/update-role modifies the member's role in the project config stored in
   * S3/DDB, then publishes a Redis pub/sub invalidation event for the affected user.
   * The gateway's profile cache for (sub, group_id) is cleared synchronously — the
   * next request for that user re-resolves their role from DDB without any wait.
   *
   * This tests both role promotion (access granted) and revocation (access denied),
   * both visible with zero latency after the update-role call completes.
   *
   * afterAll resets test-engineer to 'engineer' unconditionally so that other test
   * runs see the expected baseline state from the quorum-test-project fixture.
   */

  test.afterAll(async () => {
    // Insurance reset — keeps the suite idempotent if steps 2–4 fail mid-test
    await api(tokens.pe, PROJECT).post('/config/update-role', {
      github_username: 'test-engineer',
      role:            'engineer',
      reason:          'S-05.9 afterAll insurance: resetting test-engineer to baseline engineer role',
    })
  })

  test('step 1 — baseline: test-engineer (engineer) cannot access portfolio → 403', async () => {
    const res = await api(tokens.engineer, PROJECT).get('/api/portfolio')
    expect(res.status).toBe(403)
  })

  test('step 2 — PA promotes test-engineer to director → 200', async () => {
    const res = await api(tokens.pe, PROJECT).post('/config/update-role', {
      github_username: 'test-engineer',
      role:            'director',
      reason:          'S-05.9: promoting to director to verify portfolio access is granted immediately',
    })
    expect(res.status).toBe(200)
  })

  test('step 3 — test-engineer immediately accesses portfolio after promotion → 200', async () => {
    // No sleep — Redis pub/sub invalidation is synchronous to the update-role response.
    // The profile cache key for (test-engineer, quorum-test-project) is cleared when
    // the config update is persisted; the next resolve goes to DDB for the fresh role.
    const res = await api(tokens.engineer, PROJECT).get('/api/portfolio')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.data.projects)).toBe(true)
  })

  test('step 4 — PA resets test-engineer back to engineer → 200', async () => {
    const res = await api(tokens.pe, PROJECT).post('/config/update-role', {
      github_username: 'test-engineer',
      role:            'engineer',
      reason:          'S-05.9: reverting test-engineer to engineer to verify portfolio access is revoked immediately',
    })
    expect(res.status).toBe(200)
  })

  test('step 5 — test-engineer denied portfolio again after role revocation → 403', async () => {
    // Revocation is also immediate — no TTL-based delay before the restriction takes effect.
    const res = await api(tokens.engineer, PROJECT).get('/api/portfolio')
    expect(res.status).toBe(403)
  })
})

// ─── S-05.10  is_public enforcement: non-member blocked on all /api/* routes ──

/**
 * S-05.10 — Non-member of a private project is denied on every /api/* dashboard route.
 *
 * test-engineer is a member of quorum-test-project but NOT quorum-test-catalog.
 * quorum-test-catalog has no is_public:true → defaults to private.
 *
 * verify-jwt.js sets access_denied:true when the JWT sub is not in the project's
 * member list and the project is not public. resolveQProjectId() in dashboard.js
 * checks this flag and short-circuits with 403 before any DB query runs.
 *
 * This tests that the enforcement gap (access_denied only enforced on pg/* routes
 * before this fix) is closed for all dashboard BFF routes.
 *
 * GAP-002 — P0 gap closed by adding access_denied guard to resolveQProjectId().
 */
test.describe('S-05.10 — is_public enforcement: non-member denied on all /api routes', () => {
  /**
   * Routes that formerly had no access_denied check before the GAP-002 fix.
   * Each returns 403 when test-engineer (not a catalog member) sends
   * X-Quorum-Project: quorum-test-catalog.
   */
  const outOfScopeRoutes = [
    ['GET', '/api/knowledge'],
    ['GET', '/api/drafts'],
    ['GET', '/api/stats'],
    ['GET', '/api/deviations'],
    ['GET', '/api/conformance'],
  ]

  for (const [method, path] of outOfScopeRoutes) {
    test(`${method} ${path} → 403 for non-member of private project`, async () => {
      const res = await api(tokens.engineer, CATALOG)[method.toLowerCase()](path)
      expect(res.status).toBe(403)
      expect(res.data.error).toBe('forbidden')
    })
  }

  test('same routes accessible to catalog member (test-architect) → 200', async () => {
    // Positive guard: verifies the fix does not over-block legitimate members.
    // test-architect IS a member of quorum-test-catalog with role architect.
    const res = await api(tokens.architect, CATALOG).get('/api/knowledge')
    expect(res.status).toBe(200)
  })
})
