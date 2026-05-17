/**
 * Tests for gateway/src/shared/governance/conflict.js
 *
 * Pure functions + async functions with mocked dependencies.
 * No real I/O — all graph/LLM calls are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('../../gateway/src/shared/graph/client.js', () => ({
  searchNodes: vi.fn(),
}))

vi.mock('../../gateway/src/shared/governance/authority.js', () => ({
  calculateAuthority: vi.fn(() => 0.5),
  shouldAutoSupersede: vi.fn(() => false),
}))

vi.mock('../../gateway/src/shared/config/loader.js', () => ({
  getConfig: vi.fn(() => {
    throw new Error('config not loaded — falls through to defaults')
  }),
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { searchNodes } from '../../gateway/src/shared/graph/client.js'
import { calculateAuthority, shouldAutoSupersede } from '../../gateway/src/shared/governance/authority.js'
import {
  normalizeTags,
  generateEnrichment,
  detectConflict,
  resolveConflict,
} from '../../gateway/src/shared/governance/conflict.js'

// ── normalizeTags ─────────────────────────────────────────────────────────────

describe('normalizeTags', () => {
  it('returns empty array for null', () => {
    expect(normalizeTags(null)).toEqual([])
  })

  it('returns empty array for undefined', () => {
    expect(normalizeTags(undefined)).toEqual([])
  })

  it('returns empty array for non-array', () => {
    expect(normalizeTags('string')).toEqual([])
    expect(normalizeTags(42)).toEqual([])
    expect(normalizeTags({})).toEqual([])
  })

  it('returns empty array for empty array', () => {
    expect(normalizeTags([])).toEqual([])
  })

  it('lowercases and trims each tag', () => {
    expect(normalizeTags(['  Auth ', 'API', 'DB'])).toEqual(['api', 'auth', 'db'])
  })

  it('deduplicates tags', () => {
    expect(normalizeTags(['auth', 'AUTH', 'Auth'])).toEqual(['auth'])
  })

  it('sorts tags alphabetically', () => {
    expect(normalizeTags(['z-tag', 'a-tag', 'm-tag'])).toEqual(['a-tag', 'm-tag', 'z-tag'])
  })

  it('filters empty strings', () => {
    expect(normalizeTags(['auth', '', '  ', 'api'])).toEqual(['api', 'auth'])
  })

  it('converts non-string entries via String()', () => {
    expect(normalizeTags([123, true])).toEqual(['123', 'true'])
  })
})

// ── generateEnrichment ────────────────────────────────────────────────────────

describe('generateEnrichment', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns fallback when gw._post throws (LLM unavailable)', async () => {
    const gw = { _post: vi.fn().mockRejectedValue(new Error('network error')) }

    const result = await generateEnrichment(
      'existing content',
      'incoming content',
      'contradicts on DB choice',
      false,
      null,
      gw,
    )

    expect(result.analysis).toMatch(/unavailable/i)
    expect(Array.isArray(result.risks_if_approved)).toBe(true)
    expect(Array.isArray(result.questions_for_reviewer)).toBe(true)
    expect(result.possible_split).toBe(false)
    expect(result.split_suggestion).toBeNull()
  })

  it('merges gateway result over fallback on success', async () => {
    const gw = {
      _post: vi.fn().mockResolvedValue({
        analysis: 'Custom analysis from gateway',
        risks_if_approved: ['risk A', 'risk B'],
        questions_for_reviewer: ['question 1'],
        existing_rationale: 'Because of X',
        possible_split: true,
        split_suggestion: 'scope A vs scope B',
      }),
    }

    const result = await generateEnrichment(
      'existing content',
      'incoming content',
      'contradicts',
      true,
      'scope A vs scope B',
      gw,
    )

    expect(result.analysis).toBe('Custom analysis from gateway')
    expect(result.risks_if_approved).toEqual(['risk A', 'risk B'])
    expect(result.existing_rationale).toBe('Because of X')
    expect(result.possible_split).toBe(true)
    expect(result.split_suggestion).toBe('scope A vs scope B')
  })

  it('propagates possible_split=false and split_suggestion=null from fallback', async () => {
    const gw = { _post: vi.fn().mockRejectedValue(new Error('503')) }

    const result = await generateEnrichment(
      'existing',
      'incoming',
      'contradicts',
      false,
      undefined,
      gw,
    )

    expect(result.possible_split).toBe(false)
    expect(result.split_suggestion).toBeNull()
  })
})

// ── detectConflict ────────────────────────────────────────────────────────────

describe('detectConflict', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns { conflict: false, graphiti_unavailable: true } when searchNodes throws', async () => {
    searchNodes.mockRejectedValue(new Error('Graphiti down'))

    const result = await detectConflict('new content', 'auth', 'jwt-key', null, null)

    expect(result.conflict).toBe(false)
    expect(result.graphiti_unavailable).toBe(true)
  })

  it('returns { conflict: false } when no nodes found', async () => {
    searchNodes.mockResolvedValue({ nodes: [] })

    const result = await detectConflict('new content', 'auth', 'jwt-key', null, null)

    expect(result.conflict).toBe(false)
  })

  it('returns { conflict: false } when all nodes score below threshold', async () => {
    searchNodes.mockResolvedValue({
      nodes: [{ score: 0.5, summary: 'similar content', metadata: { key: 'auth:other-key' } }],
    })

    const result = await detectConflict('new content', 'auth', 'jwt-key', null, null)

    expect(result.conflict).toBe(false)
  })

  it('skips nodes matching same topic:key (self-update)', async () => {
    searchNodes.mockResolvedValue({
      nodes: [{ score: 0.99, summary: 'same content', metadata: { key: 'auth:jwt-key' } }],
    })

    const result = await detectConflict('new content', 'auth', 'jwt-key', null, null)

    expect(result.conflict).toBe(false)
  })

  it('returns conflict when gw contradicts', async () => {
    searchNodes.mockResolvedValue({
      nodes: [{ score: 0.95, summary: 'existing content', metadata: { key: 'auth:other' } }],
    })

    const gw = {
      _post: vi.fn().mockResolvedValue({
        contradicts: true,
        reason: 'These are contradictory',
        possible_split: false,
        split_suggestion: null,
      }),
    }

    const result = await detectConflict('new content', 'auth', 'jwt-key', null, gw)

    expect(result.conflict).toBe(true)
    expect(result.reason).toBe('These are contradictory')
    expect(result.similarity).toBeCloseTo(0.95)
    expect(result.possible_split).toBe(false)
  })

  it('returns no conflict when gw says no contradiction', async () => {
    searchNodes.mockResolvedValue({
      nodes: [{ score: 0.95, summary: 'existing content', metadata: { key: 'auth:other' } }],
    })

    const gw = {
      _post: vi.fn().mockResolvedValue({
        contradicts: false,
        reason: 'These are compatible',
        possible_split: false,
        split_suggestion: null,
      }),
    }

    const result = await detectConflict('new content', 'auth', 'jwt-key', null, gw)

    expect(result.conflict).toBe(false)
  })

  it('flags conflict with possible_split when LLM returns possible_split=true', async () => {
    searchNodes.mockResolvedValue({
      nodes: [{ score: 0.95, summary: 'existing content', metadata: { key: 'db:pg-settings' } }],
    })

    const gw = {
      _post: vi.fn().mockResolvedValue({
        contradicts: true,
        reason: 'Different contexts',
        possible_split: true,
        split_suggestion: 'prod vs staging',
      }),
    }

    const result = await detectConflict('new content', 'db', 'pg-settings-staging', null, gw)

    expect(result.conflict).toBe(true)
    expect(result.possible_split).toBe(true)
    expect(result.split_suggestion).toBe('prod vs staging')
  })

  it('treats 404/501 gw errors as "flag for human review" with contradicts: true', async () => {
    searchNodes.mockResolvedValue({
      nodes: [{ score: 0.95, summary: 'existing content', metadata: { key: 'db:pg-host' } }],
    })

    const gw = {
      _post: vi.fn().mockRejectedValue(new Error('404 not found')),
    }

    const result = await detectConflict('new content', 'db', 'pg-host-staging', null, gw)

    // After gw errors, checkContradiction returns contradicts:true — so we get a conflict
    expect(result.conflict).toBe(true)
    expect(result.reason).toMatch(/human review/i)
  })

  it('handles node.similarity field instead of node.score', async () => {
    searchNodes.mockResolvedValue({
      nodes: [{ similarity: 0.9, summary: 'existing content', metadata: { key: 'api:other' } }],
    })

    const gw = {
      _post: vi.fn().mockResolvedValue({
        contradicts: false,
        reason: 'no conflict',
        possible_split: false,
        split_suggestion: null,
      }),
    }

    const result = await detectConflict('new content', 'api', 'my-key', null, gw)

    expect(gw._post).toHaveBeenCalled()
    expect(result.conflict).toBe(false)
  })

  it('handles node.name as fallback key when metadata.key is missing', async () => {
    searchNodes.mockResolvedValue({
      nodes: [{ score: 0.95, summary: 'existing content', name: 'api:my-key' }],
    })

    const gw = {
      _post: vi.fn().mockResolvedValue({
        contradicts: false,
        reason: 'no conflict',
        possible_split: false,
        split_suggestion: null,
      }),
    }

    // Same topic:key as node.name — should be skipped
    const result = await detectConflict('new content', 'api', 'my-key', null, gw)

    expect(gw._post).not.toHaveBeenCalled()
    expect(result.conflict).toBe(false)
  })
})

// ── resolveConflict ────────────────────────────────────────────────────────────

describe('resolveConflict', () => {
  const now = new Date().toISOString()

  afterEach(() => vi.clearAllMocks())

  it('returns auto_supersede when shouldAutoSupersede is true', () => {
    shouldAutoSupersede.mockReturnValue(true)

    const result = resolveConflict(
      { confidence: 0.9, created_at: now, author: 'alice' },
      { confidence: 0.4, created_at: now, author: 'bob' },
      'contradicts on DB choice',
    )

    expect(result.action).toBe('auto_supersede')
    expect(result.reason).toMatch(/auto-superseded/i)
    expect(result.brief).toBeUndefined()
  })

  it('returns human_required with a brief when shouldAutoSupersede is false', () => {
    shouldAutoSupersede.mockReturnValue(false)
    calculateAuthority.mockReturnValue(0.6)

    const result = resolveConflict(
      { confidence: 0.7, created_at: now, author: 'alice', content: 'incoming content' },
      { confidence: 0.6, created_at: now, author: 'bob', summary: 'existing content' },
      'contradicts on auth method',
    )

    expect(result.action).toBe('human_required')
    expect(result.brief).toBeDefined()
    expect(result.brief.type).toBe('conflict_decision_required')
    expect(result.brief.options).toHaveLength(5)
    expect(result.brief.conflict_reason).toBe('contradicts on auth method')
  })

  it('includes possible_split from hints in the brief', () => {
    shouldAutoSupersede.mockReturnValue(false)
    calculateAuthority.mockReturnValue(0.5)

    const result = resolveConflict(
      { confidence: 0.7, created_at: now, author: 'alice', content: 'incoming' },
      { confidence: 0.6, created_at: now, author: 'bob', summary: 'existing' },
      'scope difference',
      { possible_split: true, split_suggestion: 'prod vs dev' },
    )

    expect(result.brief.possible_split).toBe(true)
    expect(result.brief.split_suggestion).toBe('prod vs dev')
  })

  it('brief existing.confidence falls back to 0.5 when missing', () => {
    shouldAutoSupersede.mockReturnValue(false)
    calculateAuthority.mockReturnValue(0.5)

    const result = resolveConflict(
      { confidence: 0.7, created_at: now, author: 'alice', content: 'incoming' },
      { created_at: now, author: 'bob', summary: 'existing' }, // no confidence
      'conflict reason here',
    )

    expect(result.brief.existing.confidence).toBe(0.5)
  })

  it('brief incoming.confidence falls back to 0.7 when missing', () => {
    shouldAutoSupersede.mockReturnValue(false)
    calculateAuthority.mockReturnValue(0.5)

    const result = resolveConflict(
      { created_at: now, author: 'alice', content: 'incoming' }, // no confidence
      { confidence: 0.6, created_at: now, author: 'bob', summary: 'existing' },
      'conflict reason here',
    )

    expect(result.brief.incoming.confidence).toBe(0.7)
  })

  it('brief includes all 5 resolution options', () => {
    shouldAutoSupersede.mockReturnValue(false)
    calculateAuthority.mockReturnValue(0.5)

    const result = resolveConflict(
      { confidence: 0.7, created_at: now, author: 'alice', content: 'incoming' },
      { confidence: 0.5, created_at: now, author: 'bob', summary: 'existing' },
      'conflict reason here',
    )

    const optionIds = result.brief.options.map((o) => o.id)
    expect(optionIds).toContain('supersede')
    expect(optionIds).toContain('coexist_split')
    expect(optionIds).toContain('coexist_merge')
    expect(optionIds).toContain('reject')
    expect(optionIds).toContain('escalate')
  })

  it('resolveConflict with empty hints uses defaults', () => {
    shouldAutoSupersede.mockReturnValue(false)
    calculateAuthority.mockReturnValue(0.5)

    const result = resolveConflict(
      { confidence: 0.7, created_at: now, content: 'incoming' },
      { confidence: 0.5, created_at: now, summary: 'existing' },
      'conflict reason here',
      // no hints arg
    )

    expect(result.brief.possible_split).toBe(false)
    expect(result.brief.split_suggestion).toBeNull()
  })
})
