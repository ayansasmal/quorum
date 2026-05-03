/**
 * Tool: recall()
 *
 * Tests the recall handler with mocked pg queries and audit pipeline.
 * Verifies:
 *   1. Default mode returns ACTIVE version as XML
 *   2. Not found returns null
 *   3. SUPERSEDED version shows warning in XML
 *   4. { history: true } mode returns full version chain
 *   5. { at: date } mode returns point-in-time version
 *   6. { version: N } mode returns specific version
 *   7. Freshness flag appears for recently updated knowledge
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../mcp/src/graph/queries.js', () => ({
  getCurrentVersion: vi.fn(),
  getVersionHistory: vi.fn(),
  getVersionAtDate: vi.fn(),
  getSpecificVersion: vi.fn(),
  insertVersion: vi.fn(),
  transitionVersionStatus: vi.fn(),
  insertVersionAuditLink: vi.fn(),
  getNextVersionNumber: vi.fn(),
  // GAP-21: fire-and-forget domain stat increment — must be present in mock
  incrementDomainStat: vi.fn().mockResolvedValue(),
}))

vi.mock('../../mcp/src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => {
    const result = await operation()
    return result
  }),
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeVersion(overrides = {}) {
  return {
    id: 1,
    topic: 'auth',
    key: 'token-strategy',
    version: 3,
    status: 'ACTIVE',
    content: 'Use JWT for Lambda, sessions for ECS',
    author: 'ayan',
    triggered_by: 'conflict_resolution',
    confidence: 0.9,
    created_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(), // 2 days ago
    created_by_audit: 'entry_001',
    supersedes_version: 2,
    supersedes_reason: 'ADR-042 nuanced after Lambda constraint discovered',
    superseded_by_version: null,
    superseded_by_author: null,
    superseded_at: null,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('recall — default mode (ACTIVE)', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns null when no version found', async () => {
    const { getCurrentVersion } = await import('../../mcp/src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(null)

    const { handler } = await import('../../mcp/src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'unknown-key' })
    expect(result).toBeNull()
  })

  it('returns XML string for found ACTIVE version', async () => {
    const { getCurrentVersion } = await import('../../mcp/src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion())

    const { handler } = await import('../../mcp/src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy' })

    expect(typeof result).toBe('string')
    expect(result).toContain('<quorum_memory')
    expect(result).toContain('</quorum_memory>')
    expect(result).toContain('topic="auth"')
    expect(result).toContain('key="token-strategy"')
  })

  it('XML includes version, status, author, triggered_by attributes', async () => {
    const { getCurrentVersion } = await import('../../mcp/src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion())

    const { handler } = await import('../../mcp/src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy' })

    expect(result).toContain('version="3"')
    expect(result).toContain('status="ACTIVE"')
    expect(result).toContain('author="ayan"')
    expect(result).toContain('triggered_by="conflict_resolution"')
  })

  it('includes knowledge content in XML body', async () => {
    const { getCurrentVersion } = await import('../../mcp/src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion())

    const { handler } = await import('../../mcp/src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy' })

    expect(result).toContain('Use JWT for Lambda, sessions for ECS')
  })

  it('adds freshness comment for version updated within 7 days', async () => {
    const { getCurrentVersion } = await import('../../mcp/src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(
      makeVersion({ created_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() }) // 1 day ago
    )

    const { handler } = await import('../../mcp/src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy' })

    expect(result).toContain('Updated')
    expect(result).toContain('day(s) ago')
  })

  it('does not add freshness comment for old knowledge', async () => {
    const { getCurrentVersion } = await import('../../mcp/src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(
      makeVersion({ created_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() }) // 30 days ago
    )

    const { handler } = await import('../../mcp/src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy' })

    expect(result).not.toContain('day(s) ago')
  })
})

describe('recall — SUPERSEDED version', () => {
  afterEach(() => vi.clearAllMocks())

  it('includes SUPERSEDED warning in XML for a superseded version', async () => {
    const { getSpecificVersion } = await import('../../mcp/src/graph/queries.js')
    vi.mocked(getSpecificVersion).mockResolvedValue(
      makeVersion({
        version: 1,
        status: 'SUPERSEDED',
        content: 'Use session tokens for all services',
        author: 'junior-dev',
        superseded_by_version: 2,
        superseded_by_author: 'senior-architect',
        superseded_at: new Date().toISOString(),
      })
    )

    const { handler } = await import('../../mcp/src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy', version: 1 })

    expect(result).toContain('SUPERSEDED')
    expect(result).toContain('v2')
  })
})

describe('recall — history mode', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns null when no versions found', async () => {
    const { getVersionHistory } = await import('../../mcp/src/graph/queries.js')
    vi.mocked(getVersionHistory).mockResolvedValue([])

    const { handler } = await import('../../mcp/src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy', history: true })
    expect(result).toBeNull()
  })

  it('returns formatted history string with version list', async () => {
    const { getVersionHistory } = await import('../../mcp/src/graph/queries.js')
    vi.mocked(getVersionHistory).mockResolvedValue([
      makeVersion({ version: 3, status: 'ACTIVE' }),
      makeVersion({ version: 2, status: 'SUPERSEDED', author: 'senior-architect' }),
      makeVersion({ version: 1, status: 'SUPERSEDED', author: 'junior-dev' }),
    ])

    const { handler } = await import('../../mcp/src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy', history: true })

    expect(typeof result).toBe('string')
    expect(result).toContain('auth:token-strategy')
    expect(result).toContain('v3')
    expect(result).toContain('v2')
    expect(result).toContain('v1')
    expect(result).toContain('ACTIVE')
    expect(result).toContain('SUPERSEDED')
  })
})

describe('recall — point-in-time mode', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns null when no version was active at the given date', async () => {
    const { getVersionAtDate } = await import('../../mcp/src/graph/queries.js')
    vi.mocked(getVersionAtDate).mockResolvedValue(null)

    const { handler } = await import('../../mcp/src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy', at: '2023-01-01' })
    expect(result).toBeNull()
  })

  it('includes point-in-time comment in XML', async () => {
    const { getVersionAtDate } = await import('../../mcp/src/graph/queries.js')
    vi.mocked(getVersionAtDate).mockResolvedValue(
      makeVersion({ version: 1, status: 'ACTIVE', author: 'junior-dev' })
    )

    const { handler } = await import('../../mcp/src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy', at: '2024-01-15' })

    expect(result).toContain('2024-01-15')
    expect(result).toContain('Point-in-time')
  })
})

describe('recall — specific version mode', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns null when specific version does not exist', async () => {
    const { getSpecificVersion } = await import('../../mcp/src/graph/queries.js')
    vi.mocked(getSpecificVersion).mockResolvedValue(null)

    const { handler } = await import('../../mcp/src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy', version: 99 })
    expect(result).toBeNull()
  })

  it('returns the specific version when it exists', async () => {
    const { getSpecificVersion } = await import('../../mcp/src/graph/queries.js')
    vi.mocked(getSpecificVersion).mockResolvedValue(makeVersion({ version: 2 }))

    const { handler } = await import('../../mcp/src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy', version: 2 })

    expect(result).toContain('version="2"')
  })
})
