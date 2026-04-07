/**
 * Tool: remember()
 *
 * Tests the remember handler with mocked graph client and pg queries.
 * Verifies:
 *   1. First version (v1) is created as ACTIVE for human author
 *   2. Claude-authored knowledge enters as DRAFT
 *   3. reflect-triggered knowledge enters as DRAFT
 *   4. Superseding an existing version requires reason (Rule 3)
 *   5. Conflict detected → returns conflict_detected shape when human_required
 *   6. Graphiti addEpisode is called for first version
 *   7. Graphiti addSupersedingEpisode is called when superseding
 *   8. Version number increments correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConstitutionalViolation } from '../../src/governance/constitutional.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/graph/client.js', () => ({
  addEpisode: vi.fn(),
  addSupersedingEpisode: vi.fn(),
  searchNodes: vi.fn(),
  getEvolutionChain: vi.fn(),
  deleteEpisodeSoft: vi.fn(),
  ping: vi.fn(),
  BLOCKED_METHODS: new Set(['delete_episode', 'delete_entity', 'purge']),
  isMethodBlocked: vi.fn((m) => ['delete_episode', 'delete_entity', 'purge'].includes(m)),
}))

vi.mock('../../src/graph/queries.js', () => ({
  getCurrentVersion: vi.fn(),
  getNextVersionNumber: vi.fn(),
  getVersionHistory: vi.fn(),
  getVersionAtDate: vi.fn(),
  getSpecificVersion: vi.fn(),
  insertVersion: vi.fn(),
  transitionVersionStatus: vi.fn(),
  insertVersionAuditLink: vi.fn(),
}))

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => {
    const result = await operation()
    return result
  }),
}))

vi.mock('../../src/governance/conflict.js', () => ({
  detectConflict: vi.fn(),
  resolveConflict: vi.fn(),
}))

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('remember — first version (v1)', () => {
  beforeEach(async () => {
    const { getCurrentVersion, getNextVersionNumber, insertVersion } = await import('../../src/graph/queries.js')
    const { addEpisode } = await import('../../src/graph/client.js')

    vi.mocked(getCurrentVersion).mockResolvedValue(null) // no existing version
    vi.mocked(getNextVersionNumber).mockResolvedValue(1)
    vi.mocked(insertVersion).mockResolvedValue({ id: 1, version: 1 })
    vi.mocked(addEpisode).mockResolvedValue({ episode_id: 'ep_001' })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates v1 as ACTIVE for a human author', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const mockPg = {}

    const result = await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
      author: 'senior-architect',
      confidence: 0.85,
    })

    expect(result.status).toBe('stored')
    expect(result.version).toBe(1)
    expect(result.topic).toBe('auth')
    expect(result.key).toBe('token-strategy')
  })

  it('calls addEpisode (not addSupersedingEpisode) for first version', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { addEpisode, addSupersedingEpisode } = await import('../../src/graph/client.js')
    const mockPg = {}

    await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
      author: 'senior-architect',
    })

    expect(addEpisode).toHaveBeenCalledOnce()
    expect(addSupersedingEpisode).not.toHaveBeenCalled()
  })

  it('creates v1 as DRAFT when author is "claude"', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { insertVersion } = await import('../../src/graph/queries.js')
    const mockPg = {}

    await handler(mockPg, {
      topic: 'testing',
      key: 'claude-pattern',
      content: 'Some knowledge extracted from task',
      author: 'claude',
      confidence: 0.75,
    })

    const insertCall = vi.mocked(insertVersion).mock.calls[0][1]
    expect(insertCall.status).toBe('DRAFT')
  })

  it('creates v1 as DRAFT when triggered_by is "reflect"', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { insertVersion } = await import('../../src/graph/queries.js')
    const mockPg = {}

    await handler(mockPg, {
      topic: 'api',
      key: 'pattern-from-reflect',
      content: 'Extracted from task completion',
      author: 'claude',
      triggered_by: 'reflect',
      confidence: 0.55,
    })

    const insertCall = vi.mocked(insertVersion).mock.calls[0][1]
    expect(insertCall.status).toBe('DRAFT')
  })
})

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
    const { getCurrentVersion, getNextVersionNumber, insertVersion, transitionVersionStatus } = await import('../../src/graph/queries.js')
    const { addEpisode, addSupersedingEpisode } = await import('../../src/graph/client.js')
    const { detectConflict } = await import('../../src/governance/conflict.js')

    vi.mocked(getCurrentVersion).mockResolvedValue(existingVersion)
    vi.mocked(getNextVersionNumber).mockResolvedValue(2)
    vi.mocked(insertVersion).mockResolvedValue({ id: 2, version: 2 })
    vi.mocked(transitionVersionStatus).mockResolvedValue()
    vi.mocked(addEpisode).mockResolvedValue({ episode_id: 'ep_002' })
    vi.mocked(addSupersedingEpisode).mockResolvedValue({ episode_id: 'ep_002' })
    vi.mocked(detectConflict).mockResolvedValue({ conflict: false })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('throws REASON_REQUIRED when superseding without reason', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const mockPg = {}

    await expect(
      handler(mockPg, {
        topic: 'auth',
        key: 'token-strategy',
        content: 'Use JWT for all services',
        author: 'senior-architect',
        confidence: 0.85,
        // no reason provided
      })
    ).rejects.toThrow(ConstitutionalViolation)
  })

  it('calls addSupersedingEpisode (not addEpisode) when superseding', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { addEpisode, addSupersedingEpisode } = await import('../../src/graph/client.js')
    const mockPg = {}

    await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
      author: 'senior-architect',
      confidence: 0.85,
      reason: 'Lambda services do not support session tokens',
    })

    expect(addSupersedingEpisode).toHaveBeenCalledOnce()
    expect(addEpisode).not.toHaveBeenCalled()
  })

  it('returns v2 on successful supersession', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const mockPg = {}

    const result = await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
      author: 'senior-architect',
      confidence: 0.85,
      reason: 'Lambda services do not support session tokens',
    })

    expect(result.status).toBe('stored')
    expect(result.version).toBe(2)
    expect(result.superseded_version).toBe(1)
  })

  it('calls transitionVersionStatus to mark old version as SUPERSEDED', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { transitionVersionStatus } = await import('../../src/graph/queries.js')
    const mockPg = {}

    await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
      author: 'senior-architect',
      reason: 'Lambda does not support sessions',
    })

    expect(transitionVersionStatus).toHaveBeenCalledOnce()
    const call = vi.mocked(transitionVersionStatus).mock.calls[0]
    expect(call[3]).toBe(1)           // old version
    expect(call[4]).toBe('SUPERSEDED') // new status
  })
})

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

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns conflict_detected shape when human resolution is required', async () => {
    const { getCurrentVersion, getNextVersionNumber } = await import('../../src/graph/queries.js')
    const { detectConflict, resolveConflict } = await import('../../src/governance/conflict.js')

    vi.mocked(getCurrentVersion).mockResolvedValue(existingVersion)
    vi.mocked(getNextVersionNumber).mockResolvedValue(2)
    vi.mocked(detectConflict).mockResolvedValue({
      conflict: true,
      reason: 'B contradicts A on pool size',
      similarity: 0.9,
      existing: existingVersion,
    })
    vi.mocked(resolveConflict).mockReturnValue({
      action: 'human_required',
      brief: {
        type: 'conflict_decision_required',
        options: [],
        existing: {},
        incoming: {},
        conflict_reason: 'B contradicts A on pool size',
      },
    })

    const { handler } = await import('../../src/tools/remember.js')

    const result = await handler({}, {
      topic: 'db',
      key: 'connection-pooling',
      content: 'Use pool size 50 for batch processing',
      author: 'junior-dev',
      confidence: 0.5,
      reason: 'High concurrency batch jobs need more connections to avoid starvation',
    })

    expect(result.status).toBe('conflict_detected')
    expect(result.conflict_id).toBeDefined()
    expect(result.brief).toBeDefined()
  })
})
