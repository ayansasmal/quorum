/**
 * Tool: remember()
 *
 * Tests the remember handler with mocked graph client and pg queries.
 *
 * v0.2: author is no longer in the input schema — it is injected via the
 * identity argument (3rd param). All handler calls pass a mock identity object.
 *
 * Verifies:
 *   1. First version (v1) is created as ACTIVE for human author
 *   2. Claude identity → DRAFT
 *   3. anonymous identity → DRAFT
 *   4. reflect-triggered → DRAFT
 *   5. Superseding without reason throws REASON_REQUIRED (Rule 3)
 *   6. Conflict detected → returns conflict_detected shape with conflict_id
 *   7. addEpisode called for first version; addSupersedingEpisode for supersede
 *   8. transitionVersionStatus called with SUPERSEDED on supersede
 *   9. Tags are normalized (lowercase + trim)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConstitutionalViolation } from '../../mcp/src/governance/constitutional.js'

// ── Mocks (hoisted — must be at top level in ESM) ─────────────────────────────

vi.mock('../../mcp/src/graph/client.js', () => ({
  addEpisode: vi.fn(),
  addSupersedingEpisode: vi.fn(),
  searchNodes: vi.fn(),
  getEvolutionChain: vi.fn(),
  deleteEpisodeSoft: vi.fn(),
  ping: vi.fn(),
  BLOCKED_METHODS: new Set(['delete_episode', 'delete_entity', 'purge']),
  isMethodBlocked: vi.fn((m) => ['delete_episode', 'delete_entity', 'purge'].includes(m)),
}))

vi.mock('../../mcp/src/graph/queries.js', () => ({
  getCurrentVersion: vi.fn(),
  getNextVersionNumber: vi.fn(),
  getVersionHistory: vi.fn(),
  getVersionAtDate: vi.fn(),
  getSpecificVersion: vi.fn(),
  insertVersion: vi.fn(),
  transitionVersionStatus: vi.fn(),
  insertVersionAuditLink: vi.fn(),
  countPendingForKey: vi.fn().mockResolvedValue(0),
  insertPendingDecision: vi.fn().mockResolvedValue(),
  getPendingDecisionById: vi.fn(),
  resolvePendingDecision: vi.fn().mockResolvedValue(),
  // GAP-21: fire-and-forget domain stat increment — must be present in mock
  incrementDomainStat: vi.fn().mockResolvedValue(),
}))

vi.mock('../../mcp/src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => {
    const result = await operation()
    return result
  }),
}))

vi.mock('../../mcp/src/governance/conflict.js', () => ({
  detectConflict: vi.fn(),
  resolveConflict: vi.fn(),
  generateEnrichment: vi.fn().mockResolvedValue({
    analysis: 'Mock enrichment analysis',
    risks_if_approved: [],
    questions_for_reviewer: [],
    existing_rationale: null,
    possible_split: false,
  }),
  // normalizeTags uses real logic — no mocking needed, but must be exported
  normalizeTags: vi.fn((tags) => {
    if (!tags || !Array.isArray(tags)) return []
    return [...new Set(tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))].sort()
  }),
}))

vi.mock('../../mcp/src/governance/authority.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    resolveAuthorConfidence: vi.fn((provided, _identity) => provided),
  }
})

// ── Shared helpers ────────────────────────────────────────────────────────────

const humanIdentity = { name: 'senior-architect', team: 'platform', role: 'principal_architect', base_confidence: 0.9, method: 'github_token' }
const claudeIdentity = { name: 'claude', team: null, role: null, base_confidence: 0.5, method: 'anonymous' }
const anonIdentity = { name: 'anonymous', team: null, role: null, base_confidence: 0.5, method: 'anonymous' }

// Minimal pg stub — tool code must not call pg.query() directly (scanner enforces this)
const mockPg = {}

// ── First version ─────────────────────────────────────────────────────────────

describe('remember — first version (v1)', () => {
  beforeEach(async () => {
    const { getCurrentVersion, getNextVersionNumber, insertVersion } = await import('../../mcp/src/graph/queries.js')
    const { addEpisode } = await import('../../mcp/src/graph/client.js')

    vi.mocked(getCurrentVersion).mockResolvedValue(null)
    vi.mocked(getNextVersionNumber).mockResolvedValue(1)
    vi.mocked(insertVersion).mockResolvedValue({ id: 1, version: 1 })
    vi.mocked(addEpisode).mockResolvedValue({ episode_id: 'ep_001' })
  })

  afterEach(() => vi.clearAllMocks())

  it('creates v1 as ACTIVE for a human identity', async () => {
    const { handler } = await import('../../mcp/src/tools/remember.js')

    const result = await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
      confidence: 0.85,
    }, humanIdentity)

    expect(result.status).toBe('stored')
    expect(result.version).toBe(1)
    expect(result.knowledge_status).toBe('ACTIVE')
  })

  it('calls addEpisode (not addSupersedingEpisode) for first version', async () => {
    const { handler } = await import('../../mcp/src/tools/remember.js')
    const { addEpisode, addSupersedingEpisode } = await import('../../mcp/src/graph/client.js')

    await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
    }, humanIdentity)

    expect(addEpisode).toHaveBeenCalledOnce()
    expect(addSupersedingEpisode).not.toHaveBeenCalled()
  })

  it('creates v1 as DRAFT when identity is claude', async () => {
    const { handler } = await import('../../mcp/src/tools/remember.js')
    const { insertVersion } = await import('../../mcp/src/graph/queries.js')

    await handler(mockPg, {
      topic: 'testing',
      key: 'claude-pattern',
      content: 'Some knowledge extracted from task',
      confidence: 0.75,
    }, claudeIdentity)

    const insertCall = vi.mocked(insertVersion).mock.calls[0][1]
    expect(insertCall.status).toBe('DRAFT')
  })

  it('creates v1 as DRAFT when identity is anonymous', async () => {
    const { handler } = await import('../../mcp/src/tools/remember.js')
    const { insertVersion } = await import('../../mcp/src/graph/queries.js')

    await handler(mockPg, {
      topic: 'auth',
      key: 'anon-write',
      content: 'Some knowledge from unknown author',
    }, anonIdentity)

    const insertCall = vi.mocked(insertVersion).mock.calls[0][1]
    expect(insertCall.status).toBe('DRAFT')
  })

  it('creates v1 as DRAFT when triggered_by is reflect', async () => {
    const { handler } = await import('../../mcp/src/tools/remember.js')
    const { insertVersion } = await import('../../mcp/src/graph/queries.js')

    await handler(mockPg, {
      topic: 'api',
      key: 'pattern-from-reflect',
      content: 'Extracted from task completion',
      triggered_by: 'reflect',
      confidence: 0.55,
    }, claudeIdentity)

    const insertCall = vi.mocked(insertVersion).mock.calls[0][1]
    expect(insertCall.status).toBe('DRAFT')
  })

  it('normalizes tags to lowercase before storage', async () => {
    const { handler } = await import('../../mcp/src/tools/remember.js')
    const { normalizeTags } = await import('../../mcp/src/governance/conflict.js')

    await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT',
      tags: ['Auth:Token', '  JWT  ', 'auth:token', 'API'],
    }, humanIdentity)

    expect(normalizeTags).toHaveBeenCalledWith(['Auth:Token', '  JWT  ', 'auth:token', 'API'])
  })
})

// ── Supersession ──────────────────────────────────────────────────────────────

describe('remember — superseding existing version', () => {
  const existingVersion = {
    id: 1,
    topic: 'auth',
    key: 'token-strategy',
    version: 1,
    status: 'ACTIVE',
    content: 'Use session tokens for all services',
    author: 'junior-dev',
    graphiti_episode_id: 'ep_001',
    created_at: new Date().toISOString(),
    confidence: 0.6,
    access_count: 0,
  }

  beforeEach(async () => {
    const { getCurrentVersion, getNextVersionNumber, insertVersion, transitionVersionStatus } = await import('../../mcp/src/graph/queries.js')
    const { addSupersedingEpisode } = await import('../../mcp/src/graph/client.js')
    const { detectConflict } = await import('../../mcp/src/governance/conflict.js')

    vi.mocked(getCurrentVersion).mockResolvedValue(existingVersion)
    vi.mocked(getNextVersionNumber).mockResolvedValue(2)
    vi.mocked(insertVersion).mockResolvedValue({ id: 2, version: 2 })
    vi.mocked(transitionVersionStatus).mockResolvedValue()
    vi.mocked(addSupersedingEpisode).mockResolvedValue({ episode_id: 'ep_002' })
    vi.mocked(detectConflict).mockResolvedValue({ conflict: false })
  })

  afterEach(() => vi.clearAllMocks())

  it('throws REASON_REQUIRED when superseding without reason', async () => {
    const { handler } = await import('../../mcp/src/tools/remember.js')

    await expect(
      handler(mockPg, {
        topic: 'auth',
        key: 'token-strategy',
        content: 'Use JWT for all services',
        confidence: 0.85,
        // no reason
      }, humanIdentity),
    ).rejects.toThrow(ConstitutionalViolation)
  })

  it('calls addSupersedingEpisode (not addEpisode) when superseding', async () => {
    const { handler } = await import('../../mcp/src/tools/remember.js')
    const { addEpisode, addSupersedingEpisode } = await import('../../mcp/src/graph/client.js')

    await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
      confidence: 0.85,
      reason: 'Lambda services do not support session tokens',
    }, humanIdentity)

    expect(addSupersedingEpisode).toHaveBeenCalledOnce()
    expect(addEpisode).not.toHaveBeenCalled()
  })

  it('returns v2 on successful supersession', async () => {
    const { handler } = await import('../../mcp/src/tools/remember.js')

    const result = await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
      confidence: 0.85,
      reason: 'Lambda services do not support session tokens',
    }, humanIdentity)

    expect(result.status).toBe('stored')
    expect(result.version).toBe(2)
    expect(result.superseded_version).toBe(1)
  })

  it('calls transitionVersionStatus to mark old version as SUPERSEDED', async () => {
    const { handler } = await import('../../mcp/src/tools/remember.js')
    const { transitionVersionStatus } = await import('../../mcp/src/graph/queries.js')

    await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
      reason: 'Lambda does not support sessions',
    }, humanIdentity)

    expect(transitionVersionStatus).toHaveBeenCalledOnce()
    const call = vi.mocked(transitionVersionStatus).mock.calls[0]
    expect(call[3]).toBe(1)            // old version
    expect(call[4]).toBe('SUPERSEDED') // new status
  })
})

// ── Conflict detection ────────────────────────────────────────────────────────

describe('remember — conflict detection', () => {
  const existingVersion = {
    id: 1,
    topic: 'db',
    key: 'connection-pooling',
    version: 1,
    status: 'ACTIVE',
    content: 'Pool size 10 per service',
    author: 'senior-architect',
    graphiti_episode_id: 'ep_db_01',
    created_at: new Date().toISOString(),
    confidence: 0.85,
    access_count: 10,
  }

  afterEach(() => vi.clearAllMocks())

  it('returns conflict_detected shape with conflict_id when human resolution is required', async () => {
    const { getCurrentVersion } = await import('../../mcp/src/graph/queries.js')
    const { detectConflict, resolveConflict } = await import('../../mcp/src/governance/conflict.js')

    vi.mocked(getCurrentVersion).mockResolvedValue(existingVersion)
    vi.mocked(detectConflict).mockResolvedValue({
      conflict: true,
      reason: 'B contradicts A on pool size',
      similarity: 0.9,
      existing: existingVersion,
      possible_split: false,
    })
    vi.mocked(resolveConflict).mockReturnValue({
      action: 'human_required',
      brief: {
        type: 'conflict_decision_required',
        options: [],
        existing: {},
        incoming: {},
        conflict_reason: 'B contradicts A on pool size',
        possible_split: false,
        split_suggestion: null,
      },
    })

    const { handler } = await import('../../mcp/src/tools/remember.js')

    const result = await handler(mockPg, {
      topic: 'db',
      key: 'connection-pooling',
      content: 'Use pool size 50 for batch processing',
      confidence: 0.5,
      reason: 'High concurrency batch jobs need more connections',
    }, humanIdentity)

    expect(result.status).toBe('conflict_detected')
    expect(result.conflict_id).toBeDefined()
    expect(result.conflict_id).toMatch(/^conflict_/)
    expect(result.brief).toBeDefined()
    expect(result.brief.type).toBe('conflict_decision_required')
  })

  it('conflict_detected result includes possible_split signal', async () => {
    const { getCurrentVersion } = await import('../../mcp/src/graph/queries.js')
    const { detectConflict, resolveConflict } = await import('../../mcp/src/governance/conflict.js')

    vi.mocked(getCurrentVersion).mockResolvedValue(existingVersion)
    vi.mocked(detectConflict).mockResolvedValue({
      conflict: true,
      reason: 'Appears to contradict on pool size',
      similarity: 0.91,
      possible_split: true,
      split_suggestion: 'First for OLTP services, second for batch jobs',
    })
    vi.mocked(resolveConflict).mockReturnValue({
      action: 'human_required',
      brief: {
        type: 'conflict_decision_required',
        options: [],
        existing: {},
        incoming: {},
        conflict_reason: 'Appears to contradict on pool size',
        possible_split: true,
        split_suggestion: 'First for OLTP services, second for batch jobs',
      },
    })

    const { handler } = await import('../../mcp/src/tools/remember.js')

    const result = await handler(mockPg, {
      topic: 'db',
      key: 'connection-pooling',
      content: 'Pool size 50 for batch processing nodes',
      confidence: 0.7,
      reason: 'Batch nodes have different concurrency requirements',
    }, humanIdentity)

    expect(result.possible_split).toBe(true)
    expect(result.split_suggestion).toBe('First for OLTP services, second for batch jobs')
  })
})
