/**
 * Governance: Conflict detection and resolution
 *
 * Tests detectConflict() and resolveConflict() with mocked Graphiti client.
 *
 * Scenarios:
 *   1. No similar nodes found → { conflict: false }
 *   2. Similarity < threshold → { conflict: false }
 *   3. Similarity > threshold but same topic:key → { conflict: false } (update, not conflict)
 *   4. Graphiti unavailable → { conflict: false } (fail open)
 *   5. resolveConflict → auto_supersede when authority delta is large
 *   6. resolveConflict → human_required when delta is small
 *   7. human_required brief has correct shape with options
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveConflict } from '../../src/governance/conflict.js'

// ── Top-level mocks (hoisted before any imports by Vitest) ────────────────────

vi.mock('../../src/graph/client.js', () => ({
  searchNodes: vi.fn(),
  searchFacts: vi.fn(),
  addEpisode: vi.fn(),
  addSupersedingEpisode: vi.fn(),
  getEvolutionChain: vi.fn(),
  deleteEpisodeSoft: vi.fn(),
  ping: vi.fn(),
  BLOCKED_METHODS: new Set(['delete_episode', 'delete_entity', 'purge']),
  isMethodBlocked: vi.fn((m) => ['delete_episode', 'delete_entity', 'purge'].includes(m)),
}))

// ── resolveConflict (pure — no external calls) ────────────────────────────────

describe('resolveConflict', () => {
  function daysAgo(days) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  }

  it('returns auto_supersede when incoming has significantly higher authority', () => {
    const incoming = {
      confidence: 0.95,
      created_at: new Date().toISOString(),
      access_count: 0,
      author: 'senior-architect',
      content: 'Use JWT for Lambda-based services',
    }
    const existing = {
      confidence: 0.3,
      created_at: daysAgo(400),
      access_count: 0,
      author: 'junior-dev',
      content: 'Use session tokens for all services',
    }
    const result = resolveConflict(incoming, existing, 'JWT vs session tokens')
    expect(result.action).toBe('auto_supersede')
    expect(typeof result.reason).toBe('string')
  })

  it('returns human_required when authority delta is small', () => {
    const base = {
      confidence: 0.75,
      created_at: new Date().toISOString(),
      access_count: 5,
    }
    const result = resolveConflict(
      { ...base, author: 'engineer-a', content: 'Use pool size 10' },
      { ...base, author: 'engineer-b', content: 'Use pool size 15' },
      'Pool size conflict',
    )
    expect(result.action).toBe('human_required')
    expect(result.brief).toBeDefined()
  })

  it('human_required brief has the expected shape', () => {
    const incoming = {
      confidence: 0.7,
      created_at: new Date().toISOString(),
      access_count: 0,
      author: 'engineer',
      content: 'Content A',
    }
    const existing = {
      confidence: 0.7,
      created_at: new Date().toISOString(),
      access_count: 0,
      author: 'engineer2',
      content: 'Content B',
    }
    const result = resolveConflict(incoming, existing, 'Reason for conflict')
    expect(result.brief.type).toBe('conflict_decision_required')
    expect(result.brief.options).toBeInstanceOf(Array)
    expect(result.brief.options.length).toBeGreaterThanOrEqual(3)
    expect(result.brief.existing).toBeDefined()
    expect(result.brief.incoming).toBeDefined()
    expect(result.brief.conflict_reason).toBe('Reason for conflict')
  })

  it('auto_supersede reason string includes conflict context', () => {
    const incoming = {
      confidence: 0.99,
      created_at: new Date().toISOString(),
      access_count: 0,
      author: 'architect',
      content: 'New approach',
    }
    const existing = {
      confidence: 0.1,
      created_at: new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString(),
      access_count: 0,
      author: 'intern',
      content: 'Old approach',
    }
    const result = resolveConflict(incoming, existing, 'A contradicts B')
    expect(result.reason).toContain('A contradicts B')
  })
})

// ── detectConflict (mocked graph client) ──────────────────────────────────────

describe('detectConflict — no conflict scenarios', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns { conflict: false } when no nodes are found', async () => {
    const { detectConflict } = await import('../../src/governance/conflict.js')
    const { searchNodes } = await import('../../src/graph/client.js')
    vi.mocked(searchNodes).mockResolvedValue({ nodes: [] })

    const result = await detectConflict('New content', 'auth', 'token-strategy')
    expect(result.conflict).toBe(false)
  })

  it('returns { conflict: false } when all nodes are below similarity threshold', async () => {
    const { detectConflict } = await import('../../src/governance/conflict.js')
    const { searchNodes } = await import('../../src/graph/client.js')
    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [
        { score: 0.5, summary: 'Unrelated knowledge', metadata: { key: 'other:key' } },
        { score: 0.7, summary: 'Slightly related', metadata: { key: 'api:versioning' } },
      ],
    })

    const result = await detectConflict('New content', 'auth', 'token-strategy')
    expect(result.conflict).toBe(false)
  })

  it('returns { conflict: false } when same topic:key has high similarity (update, not conflict)', async () => {
    const { detectConflict } = await import('../../src/governance/conflict.js')
    const { searchNodes } = await import('../../src/graph/client.js')
    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [
        {
          score: 0.95,
          summary: 'Old version of this exact knowledge',
          name: 'auth:token-strategy',
          metadata: { key: 'auth:token-strategy' }, // same key → skip
        },
      ],
    })

    const result = await detectConflict('Updated version', 'auth', 'token-strategy')
    expect(result.conflict).toBe(false)
  })

  it('returns { conflict: false } when Graphiti is unavailable (fail open)', async () => {
    const { detectConflict } = await import('../../src/governance/conflict.js')
    const { searchNodes } = await import('../../src/graph/client.js')
    vi.mocked(searchNodes).mockRejectedValue(new Error('Connection refused'))

    const result = await detectConflict('New content', 'auth', 'token-strategy')
    expect(result.conflict).toBe(false)
  })
})
