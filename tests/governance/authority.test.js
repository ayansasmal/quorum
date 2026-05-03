/**
 * Governance: Authority scoring
 *
 * Tests:
 *   - calculateAuthority score formula: (confidence*0.5) + (recency*0.3) + (access*0.2)
 *   - Recency decay via exponential function
 *   - Access log-scaling contribution
 *   - shouldAutoSupersede: delta > AUTHORITY_THRESHOLD
 *   - Score is always in [0, 1] range
 */

import { describe, it, expect } from 'vitest'
import { calculateAuthority, shouldAutoSupersede } from '../../mcp/src/governance/authority.js'

/** Returns a date N days in the past. */
function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

// ── calculateAuthority ────────────────────────────────────────────────────────

describe('calculateAuthority', () => {
  it('returns a number between 0 and 1', () => {
    const score = calculateAuthority({
      confidence: 0.8,
      created_at: daysAgo(10),
      access_count: 5,
    })
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('uses confidence 0.5 as default when not provided', () => {
    const withDefault = calculateAuthority({ created_at: daysAgo(0), access_count: 0 })
    const explicit = calculateAuthority({ confidence: 0.5, created_at: daysAgo(0), access_count: 0 })
    expect(withDefault).toBeCloseTo(explicit, 6)
  })

  it('uses access_count 0 as default when not provided', () => {
    const withDefault = calculateAuthority({ confidence: 0.7, created_at: daysAgo(0) })
    const explicit = calculateAuthority({ confidence: 0.7, created_at: daysAgo(0), access_count: 0 })
    expect(withDefault).toBeCloseTo(explicit, 6)
  })

  it('higher confidence produces higher authority score', () => {
    const base = { created_at: daysAgo(10), access_count: 0 }
    const lowConfidence = calculateAuthority({ ...base, confidence: 0.3 })
    const highConfidence = calculateAuthority({ ...base, confidence: 0.9 })
    expect(highConfidence).toBeGreaterThan(lowConfidence)
  })

  it('more recent knowledge has higher authority score', () => {
    const base = { confidence: 0.7, access_count: 0 }
    const old = calculateAuthority({ ...base, created_at: daysAgo(365) })
    const recent = calculateAuthority({ ...base, created_at: daysAgo(1) })
    expect(recent).toBeGreaterThan(old)
  })

  it('higher access count produces higher authority score', () => {
    const base = { confidence: 0.7, created_at: daysAgo(30) }
    const low = calculateAuthority({ ...base, access_count: 1 })
    const high = calculateAuthority({ ...base, access_count: 100 })
    expect(high).toBeGreaterThan(low)
  })

  it('weights confidence at 30% of score for fresh zero-access episode with unknown role', () => {
    // GAP-21 rebalanced weights (5 dimensions):
    //   confidence: 0.30, recency: 0.22, access_frequency: 0.18, role: 0.18, domain_track_record: 0.12
    //
    // With created_at = now (recency ≈ 1.0), access_count = 0, unknown role (score 0.50),
    // no domain_track_record:
    //   score ≈ (0.8 × 0.30) + (1.0 × 0.22) + (0 × 0.18) + (0.50 × 0.18) + (0 × 0.12)
    //         =  0.24        +  0.22         +  0          +  0.09          +  0
    //         =  0.55
    const episode = { confidence: 0.8, created_at: new Date().toISOString(), access_count: 0 }
    const score = calculateAuthority(episode)
    const expected = 0.8 * 0.30 + 1.0 * 0.22 + 0 * 0.18 + 0.50 * 0.18 + 0 * 0.12
    expect(score).toBeCloseTo(expected, 2)
  })

  it('score decreases as knowledge ages', () => {
    const base = { confidence: 0.7, access_count: 0 }
    const scores = [1, 30, 180, 365].map((days) =>
      calculateAuthority({ ...base, created_at: daysAgo(days) })
    )
    // Scores should be monotonically decreasing
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i + 1])
    }
  })
})

// ── shouldAutoSupersede ───────────────────────────────────────────────────────

describe('shouldAutoSupersede', () => {
  it('returns true when incoming has significantly higher authority', () => {
    const incoming = {
      confidence: 0.95,    // high confidence
      created_at: new Date().toISOString(), // very recent
      access_count: 0,
    }
    const existing = {
      confidence: 0.3,    // low confidence
      created_at: daysAgo(365), // very old
      access_count: 0,
    }
    expect(shouldAutoSupersede(incoming, existing)).toBe(true)
  })

  it('returns false when delta is small (human should decide)', () => {
    const base = { confidence: 0.75, access_count: 5 }
    const incoming = { ...base, created_at: new Date().toISOString() }
    const existing = { ...base, created_at: daysAgo(1) }
    // Very similar profiles — delta should be below threshold
    expect(shouldAutoSupersede(incoming, existing)).toBe(false)
  })

  it('returns false when existing has higher authority', () => {
    const incoming = {
      confidence: 0.4,
      created_at: daysAgo(30),
      access_count: 0,
    }
    const existing = {
      confidence: 0.9,
      created_at: daysAgo(1),
      access_count: 50,
    }
    expect(shouldAutoSupersede(incoming, existing)).toBe(false)
  })

  it('is not symmetric — direction matters', () => {
    const a = { confidence: 0.9, created_at: new Date().toISOString(), access_count: 0 }
    const b = { confidence: 0.3, created_at: daysAgo(365), access_count: 0 }
    const aSupersedingB = shouldAutoSupersede(a, b)
    const bSupersedingA = shouldAutoSupersede(b, a)
    // At most one direction should be true (not necessarily both false)
    expect(aSupersedingB && bSupersedingA).toBe(false)
  })
})
