/**
 * graph-schema.js — Static DAG definition for the Quorum E2E suite.
 *
 * This file is the single source of truth for the graph structure: which
 * scenarios exist, their static scoring properties, and the code-path
 * correlation edges. The graph-reporter.js overlays live test results on top.
 *
 * Edge semantics: S → S' means "if S fails due to a shared code-path bug,
 * S' is expected to fail for the same reason". This is NOT test-state
 * dependency — all scenarios isolate state via uid() keys.
 *
 * Formula: OwnScore = W × C × D
 *   W = leaf_count × FrequencyTier
 *   C = Criticality (1.0 – 3.0)
 *   D = Detection lag (1.0 – 2.0)
 *
 * Source: docs/e2e/TEST-PLAN.md §5, §6
 */

/** @type {Record<string, { label: string; ownScoreTotal: number; zeroTolerance: boolean }>} */
export const PILLARS = {
  governance_integrity:    { label: 'Governance Integrity',    ownScoreTotal: 1153, zeroTolerance: true  },
  security:                { label: 'Security & Access Control', ownScoreTotal: 923,  zeroTolerance: true  },
  data_integrity:          { label: 'Data Integrity',           ownScoreTotal: 178,  zeroTolerance: true  },
  functional_correctness:  { label: 'Functional Correctness',   ownScoreTotal: 475,  zeroTolerance: false },
  federation:              { label: 'Federation Correctness',   ownScoreTotal: 34,   zeroTolerance: false },
  operational_reliability: { label: 'Operational Reliability',  ownScoreTotal: 86,   zeroTolerance: false },
  observability:           { label: 'Observability',            ownScoreTotal: 102,  zeroTolerance: false },
  developer_experience:    { label: 'Developer Experience',     ownScoreTotal: 50,   zeroTolerance: false },
}

/**
 * @typedef {Object} ScenarioNode
 * @property {string}   id            - Scenario ID (e.g. 'S-05.1')
 * @property {string}   label         - Short description
 * @property {string}   journey       - Journey ID (e.g. 'J05')
 * @property {string}   pillar        - Pillar key from PILLARS
 * @property {number}   leafCount
 * @property {number}   frequencyTier - F value (1, 1.5, 2, 3, or 4)
 * @property {number}   criticality   - C value (1.0 – 3.0)
 * @property {number}   detectionLag  - D value (1.0 – 2.0)
 * @property {number}   ownScore      - W × C × D (pre-computed, integer-rounded)
 * @property {number}   failureCost   - OwnScore + Σ correlated OwnScores
 * @property {string}   specFile      - Relative path to the spec file
 * @property {string}   journeyFile   - Relative path to the journey doc
 */

/** @type {ScenarioNode[]} */
export const NODES = [
  // ─── FEDERATION ───────────────────────────────────────────────────────────
  { id: 'S-01',   label: 'Global Catalog Onboarding',    journey: 'J01', pillar: 'federation',
    leafCount: 15, frequencyTier: 1,   criticality: 1.5, detectionLag: 1.5,
    ownScore: 34,  failureCost: 34,
    specFile: 'e2e/scenarios/api/01-global-catalog-onboarding.spec.js',
    journeyFile: 'docs/e2e/journeys/J01-global-catalog-onboarding.md' },

  // ─── FUNCTIONAL CORRECTNESS (J02 sub-scenarios) ───────────────────────────
  { id: 'S-02.1', label: 'Write + Recall',               journey: 'J02', pillar: 'functional_correctness',
    leafCount: 8,  frequencyTier: 4,   criticality: 1.5, detectionLag: 1.0,
    ownScore: 48,  failureCost: 48,
    specFile: 'e2e/scenarios/api/02-knowledge-governance.spec.js',
    journeyFile: 'docs/e2e/journeys/J02-knowledge-governance.md' },

  // ─── GOVERNANCE INTEGRITY ─────────────────────────────────────────────────
  { id: 'S-02.2', label: 'Conflict Detection',           journey: 'J02', pillar: 'governance_integrity',
    leafCount: 6,  frequencyTier: 4,   criticality: 2.5, detectionLag: 2.0,
    ownScore: 120, failureCost: 415,
    specFile: 'e2e/scenarios/api/02-knowledge-governance.spec.js',
    journeyFile: 'docs/e2e/journeys/J02-knowledge-governance.md' },

  // ─── DATA INTEGRITY ───────────────────────────────────────────────────────
  { id: 'S-02.3', label: 'Supersede Path',               journey: 'J02', pillar: 'data_integrity',
    leafCount: 5,  frequencyTier: 4,   criticality: 2.0, detectionLag: 1.0,
    ownScore: 40,  failureCost: 40,
    specFile: 'e2e/scenarios/api/02-knowledge-governance.spec.js',
    journeyFile: 'docs/e2e/journeys/J02-knowledge-governance.md' },

  // ─── FUNCTIONAL CORRECTNESS (more J02) ────────────────────────────────────
  { id: 'S-02.4', label: 'Reject Path',                  journey: 'J02', pillar: 'functional_correctness',
    leafCount: 4,  frequencyTier: 4,   criticality: 1.5, detectionLag: 1.0,
    ownScore: 24,  failureCost: 24,
    specFile: 'e2e/scenarios/api/02-knowledge-governance.spec.js',
    journeyFile: 'docs/e2e/journeys/J02-knowledge-governance.md' },
  { id: 'S-02.5', label: 'Escalation Path',              journey: 'J02', pillar: 'functional_correctness',
    leafCount: 4,  frequencyTier: 4,   criticality: 1.5, detectionLag: 1.0,
    ownScore: 24,  failureCost: 24,
    specFile: 'e2e/scenarios/api/02-knowledge-governance.spec.js',
    journeyFile: 'docs/e2e/journeys/J02-knowledge-governance.md' },
  { id: 'S-02.6', label: 'Coexist-Split',                journey: 'J02', pillar: 'functional_correctness',
    leafCount: 5,  frequencyTier: 4,   criticality: 1.5, detectionLag: 1.0,
    ownScore: 30,  failureCost: 30,
    specFile: 'e2e/scenarios/api/02-knowledge-governance.spec.js',
    journeyFile: 'docs/e2e/journeys/J02-knowledge-governance.md' },
  { id: 'S-02.7', label: 'Coexist-Merge',                journey: 'J02', pillar: 'functional_correctness',
    leafCount: 4,  frequencyTier: 4,   criticality: 1.5, detectionLag: 1.0,
    ownScore: 24,  failureCost: 24,
    specFile: 'e2e/scenarios/api/02-knowledge-governance.spec.js',
    journeyFile: 'docs/e2e/journeys/J02-knowledge-governance.md' },

  // ─── DEVELOPER EXPERIENCE ─────────────────────────────────────────────────
  { id: 'S-02.8', label: 'Dashboard UI',                 journey: 'J02', pillar: 'developer_experience',
    leafCount: 5,  frequencyTier: 4,   criticality: 1.0, detectionLag: 1.0,
    ownScore: 20,  failureCost: 20,
    specFile: 'e2e/scenarios/ui/02-knowledge-governance-ui.spec.js',
    journeyFile: 'docs/e2e/journeys/J02-knowledge-governance.md' },

  // ─── FUNCTIONAL CORRECTNESS ───────────────────────────────────────────────
  { id: 'S-03',   label: 'Deprecation Workflow',         journey: 'J03', pillar: 'functional_correctness',
    leafCount: 20, frequencyTier: 2,   criticality: 1.5, detectionLag: 1.5,
    ownScore: 90,  failureCost: 90,
    specFile: 'e2e/scenarios/api/03-deprecation-workflow.spec.js',
    journeyFile: 'docs/e2e/journeys/J03-deprecation-workflow.md' },
  { id: 'S-04',   label: 'Deviation Governance',         journey: 'J04', pillar: 'functional_correctness',
    leafCount: 37, frequencyTier: 2,   criticality: 1.5, detectionLag: 1.5,
    ownScore: 167, failureCost: 242,
    specFile: 'e2e/scenarios/api/04-deviation-governance.spec.js',
    journeyFile: 'docs/e2e/journeys/J04-deviation-governance.md' },

  // ─── SECURITY ─────────────────────────────────────────────────────────────
  { id: 'S-05.1', label: 'RBAC Knowledge Create',        journey: 'J05', pillar: 'security',
    leafCount: 18, frequencyTier: 4,   criticality: 2.5, detectionLag: 1.0,
    ownScore: 180, failureCost: 810,
    specFile: 'e2e/scenarios/api/05-rbac-boundary.spec.js',
    journeyFile: 'docs/e2e/journeys/J05-rbac-boundary.md' },
  { id: 'S-05.2', label: 'RBAC Promote + Supersede',     journey: 'J05', pillar: 'security',
    leafCount: 12, frequencyTier: 4,   criticality: 2.5, detectionLag: 1.0,
    ownScore: 120, failureCost: 120,
    specFile: 'e2e/scenarios/api/05-rbac-boundary.spec.js',
    journeyFile: 'docs/e2e/journeys/J05-rbac-boundary.md' },
  { id: 'S-05.3', label: 'RBAC Deprecate',               journey: 'J05', pillar: 'security',
    leafCount: 12, frequencyTier: 4,   criticality: 2.5, detectionLag: 1.0,
    ownScore: 120, failureCost: 120,
    specFile: 'e2e/scenarios/api/05-rbac-boundary.spec.js',
    journeyFile: 'docs/e2e/journeys/J05-rbac-boundary.md' },
  { id: 'S-05.4', label: 'RBAC Governance + Global',     journey: 'J05', pillar: 'security',
    leafCount: 15, frequencyTier: 4,   criticality: 2.5, detectionLag: 1.0,
    ownScore: 150, failureCost: 150,
    specFile: 'e2e/scenarios/api/05-rbac-boundary.spec.js',
    journeyFile: 'docs/e2e/journeys/J05-rbac-boundary.md' },
  { id: 'S-05.5', label: 'RBAC Deviation Action',        journey: 'J05', pillar: 'security',
    leafCount: 15, frequencyTier: 4,   criticality: 2.5, detectionLag: 1.0,
    ownScore: 150, failureCost: 150,
    specFile: 'e2e/scenarios/api/05-rbac-boundary.spec.js',
    journeyFile: 'docs/e2e/journeys/J05-rbac-boundary.md' },
  { id: 'S-05.6', label: 'RBAC Portfolio + Admin',       journey: 'J05', pillar: 'security',
    leafCount: 15, frequencyTier: 3,   criticality: 2.0, detectionLag: 1.0,
    ownScore: 90,  failureCost: 90,
    specFile: 'e2e/scenarios/api/05-rbac-boundary.spec.js',
    journeyFile: 'docs/e2e/journeys/J05-rbac-boundary.md' },

  // ─── GOVERNANCE INTEGRITY ─────────────────────────────────────────────────
  { id: 'S-06',   label: 'Multi-User Conflict',          journey: 'J06', pillar: 'governance_integrity',
    leafCount: 15, frequencyTier: 3,   criticality: 2.0, detectionLag: 1.5,
    ownScore: 135, failureCost: 135,
    specFile: 'e2e/scenarios/api/06-multi-user-conflict.spec.js',
    journeyFile: 'docs/e2e/journeys/J06-multi-user-conflict.md' },

  // ─── OBSERVABILITY ────────────────────────────────────────────────────────
  { id: 'S-07',   label: 'Conformance Scoring',          journey: 'J07', pillar: 'observability',
    leafCount: 25, frequencyTier: 2,   criticality: 1.0, detectionLag: 1.5,
    ownScore: 75,  failureCost: 75,
    specFile: 'e2e/scenarios/api/07-conformance-portfolio.spec.js',
    journeyFile: 'docs/e2e/journeys/J07-conformance-portfolio.md' },

  // ─── FUNCTIONAL CORRECTNESS ───────────────────────────────────────────────
  { id: 'S-08',   label: 'Confidence Endorsement',       journey: 'J08', pillar: 'functional_correctness',
    leafCount: 15, frequencyTier: 2,   criticality: 1.5, detectionLag: 1.5,
    ownScore: 68,  failureCost: 68,
    specFile: 'e2e/scenarios/api/08-confidence-endorsement.spec.js',
    journeyFile: 'docs/e2e/journeys/J08-confidence-bump.md' },

  // ─── OPERATIONAL RELIABILITY ──────────────────────────────────────────────
  { id: 'S-09',   label: 'Platform Admin',               journey: 'J09', pillar: 'operational_reliability',
    leafCount: 14, frequencyTier: 1,   criticality: 1.0, detectionLag: 1.0,
    ownScore: 14,  failureCost: 14,
    specFile: 'e2e/scenarios/api/09-admin-operations.spec.js',
    journeyFile: 'docs/e2e/journeys/J09-admin-operations.md' },

  // ─── GOVERNANCE INTEGRITY ─────────────────────────────────────────────────
  { id: 'S-10',   label: 'Audit Chain Integrity',        journey: 'J10', pillar: 'governance_integrity',
    leafCount: 20, frequencyTier: 1.5, criticality: 3.0, detectionLag: 2.0,
    ownScore: 180, failureCost: 388,
    specFile: 'e2e/scenarios/api/10-audit-chain.spec.js',
    journeyFile: 'docs/e2e/journeys/J10-audit-chain.md' },
  { id: 'S-11',   label: 'Self-Approval Prevention',     journey: 'J11', pillar: 'governance_integrity',
    leafCount: 10, frequencyTier: 4,   criticality: 3.0, detectionLag: 1.5,
    ownScore: 180, failureCost: 180,
    specFile: 'e2e/scenarios/api/11-self-approval.spec.js',
    journeyFile: 'docs/e2e/journeys/J11-self-approval.md' },

  // ─── DATA INTEGRITY ───────────────────────────────────────────────────────
  { id: 'S-12',   label: 'State Machine',                journey: 'J12', pillar: 'data_integrity',
    leafCount: 23, frequencyTier: 2,   criticality: 2.0, detectionLag: 1.5,
    ownScore: 138, failureCost: 138,
    specFile: 'e2e/scenarios/api/12-state-machine.spec.js',
    journeyFile: 'docs/e2e/journeys/J12-state-machine.md' },

  // ─── OPERATIONAL RELIABILITY ──────────────────────────────────────────────
  { id: 'S-13',   label: 'Config Management',            journey: 'J13', pillar: 'operational_reliability',
    leafCount: 20, frequencyTier: 1,   criticality: 1.5, detectionLag: 1.5,
    ownScore: 45,  failureCost: 45,
    specFile: 'e2e/scenarios/api/13-config-governance.spec.js',
    journeyFile: 'docs/e2e/journeys/J13-config-governance.md' },

  // ─── DEVELOPER EXPERIENCE ─────────────────────────────────────────────────
  { id: 'S-14',   label: 'Dashboard Visual',             journey: 'J14', pillar: 'developer_experience',
    leafCount: 20, frequencyTier: 1.5, criticality: 1.0, detectionLag: 1.0,
    ownScore: 30,  failureCost: 30,
    specFile: 'e2e/scenarios/ui/14-dashboard-visual.spec.js',
    journeyFile: 'docs/e2e/journeys/J14-dashboard-visual.md' },

  // ─── GOVERNANCE INTEGRITY ─────────────────────────────────────────────────
  { id: 'S-15',   label: 'Reason/Placeholder Reject',    journey: 'J15', pillar: 'governance_integrity',
    leafCount: 21, frequencyTier: 3,   criticality: 3.0, detectionLag: 2.0,
    ownScore: 378, failureCost: 694,
    specFile: 'e2e/scenarios/api/15-reason-placeholder.spec.js',
    journeyFile: 'docs/e2e/journeys/J15-reason-placeholder.md' },

  // ─── OBSERVABILITY ────────────────────────────────────────────────────────
  { id: 'S-16',   label: 'Knowledge History',            journey: 'J16', pillar: 'observability',
    leafCount: 12, frequencyTier: 1.5, criticality: 1.0, detectionLag: 1.5,
    ownScore: 27,  failureCost: 27,
    specFile: 'e2e/scenarios/api/16-knowledge-history.spec.js',
    journeyFile: 'docs/e2e/journeys/J16-knowledge-history.md' },

  // ─── GOVERNANCE INTEGRITY ─────────────────────────────────────────────────
  { id: 'S-17',   label: 'Conflict Edge Cases',          journey: 'J17', pillar: 'governance_integrity',
    leafCount: 16, frequencyTier: 2,   criticality: 2.5, detectionLag: 2.0,
    ownScore: 160, failureCost: 160,
    specFile: 'e2e/scenarios/api/17-conflict-edge-cases.spec.js',
    journeyFile: 'docs/e2e/journeys/J17-conflict-edge-cases.md' },

  // ─── OPERATIONAL RELIABILITY ──────────────────────────────────────────────
  { id: 'S-18',   label: 'Governance Route',             journey: 'J18', pillar: 'operational_reliability',
    leafCount: 12, frequencyTier: 1.5, criticality: 1.0, detectionLag: 1.5,
    ownScore: 27,  failureCost: 27,
    specFile: 'e2e/scenarios/api/18-governance-route.spec.js',
    journeyFile: 'docs/e2e/journeys/J18-governance-route.md' },

  // ─── SECURITY ─────────────────────────────────────────────────────────────
  { id: 'S-19',   label: 'Authentication Lifecycle',     journey: 'J19', pillar: 'security',
    leafCount: 15, frequencyTier: 3,   criticality: 2.5, detectionLag: 1.0,
    ownScore: 113, failureCost: 113,
    specFile: 'e2e/scenarios/api/19-auth-lifecycle.spec.js',
    journeyFile: 'docs/e2e/journeys/J19-auth-lifecycle.md' },
]

/**
 * Directed edges: source failure correlates → target failure via shared code path.
 * When source status = 'failed', targets should be marked 'correlated' if passing.
 *
 * @type {Array<{ source: string; target: string; sharedCodePath: string; reason: string }>}
 */
export const EDGES = [
  // S-05.1 (RBAC middleware) → RBAC sub-scenarios
  { source: 'S-05.1', target: 'S-05.2', sharedCodePath: 'middleware/verify-jwt.js + role-check',
    reason: 'All RBAC sub-scenarios share the same verify-jwt + role-check code path' },
  { source: 'S-05.1', target: 'S-05.3', sharedCodePath: 'middleware/verify-jwt.js + role-check',
    reason: 'All RBAC sub-scenarios share the same verify-jwt + role-check code path' },
  { source: 'S-05.1', target: 'S-05.4', sharedCodePath: 'middleware/verify-jwt.js + role-check',
    reason: 'All RBAC sub-scenarios share the same verify-jwt + role-check code path' },
  { source: 'S-05.1', target: 'S-05.5', sharedCodePath: 'middleware/verify-jwt.js + role-check',
    reason: 'All RBAC sub-scenarios share the same verify-jwt + role-check code path' },
  { source: 'S-05.1', target: 'S-05.6', sharedCodePath: 'middleware/verify-jwt.js + role-check',
    reason: 'All RBAC sub-scenarios share the same verify-jwt + role-check code path' },

  // S-15 (enforceReasonRequired) → all governance endpoints with reason validation
  { source: 'S-15', target: 'S-03', sharedCodePath: 'shared/governance/constitutional.js enforceReasonRequired()',
    reason: 'Deprecation endpoints assert reason validation behaviour' },
  { source: 'S-15', target: 'S-04', sharedCodePath: 'shared/governance/constitutional.js enforceReasonRequired()',
    reason: 'Deviation action endpoints assert reason validation behaviour' },
  { source: 'S-15', target: 'S-09', sharedCodePath: 'shared/governance/constitutional.js enforceReasonRequired()',
    reason: 'Admin user management endpoint asserts reason validation (step 5)' },
  { source: 'S-15', target: 'S-13', sharedCodePath: 'shared/governance/constitutional.js enforceReasonRequired()',
    reason: 'Config governance endpoints assert reason validation' },

  // S-02.2 (detectConflict) → multi-user + edge cases
  { source: 'S-02.2', target: 'S-06', sharedCodePath: 'shared/governance/conflict.js detectConflict()',
    reason: 'Multi-user conflict relies on same detectConflict() function and threshold logic' },
  { source: 'S-02.2', target: 'S-17', sharedCodePath: 'shared/governance/conflict.js detectConflict()',
    reason: 'Cross-catalog conflict detection in S-17 Part C uses the same detectConflict path' },

  // S-10 (audit chain) → write scenarios that assert audit output
  { source: 'S-10', target: 'S-02.1', sharedCodePath: 'shared/audit/secondary.js audit write pipeline',
    reason: 'Write + Recall scenario asserts INTENT+OUTCOME audit pairs exist after remember()' },
  { source: 'S-10', target: 'S-02.2', sharedCodePath: 'shared/audit/secondary.js audit write pipeline',
    reason: 'Conflict resolution writes audit entries that S-02.2 asserts on' },
  { source: 'S-10', target: 'S-02.3', sharedCodePath: 'shared/audit/secondary.js audit write pipeline',
    reason: 'Supersede path writes SUPERSEDED transition audit entries that S-02.3 asserts on' },

  // S-04 (deviation write path) → conformance score has no input data
  { source: 'S-04', target: 'S-07', sharedCodePath: 'routes/dashboard.js POST /api/deviations',
    reason: 'Conformance scoring needs deviation records; if write path broken, score returns UNCERTIFIED' },
]

/** Suite-level constants */
export const SUITE = {
  version: '2.0',
  totalOwnScore: 3001,
  gateThreshold10pct: 300,
  gateThreshold5pct: 150,
  scenarioCount: 31,
  journeyCount: 19,
}
