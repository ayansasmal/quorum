/**
 * Unit tests for decay-confidence.js pure functions (GAP-020).
 *
 * These tests cover the core decay formula without DB or process.argv side effects.
 * The script exports computeDecay() and decayFloor() specifically for this purpose.
 */

import { describe, it, expect } from 'vitest'
import { computeDecay, decayFloor } from '../../scripts/decay-confidence.js'

describe('decayFloor', () => {
  it('uses ABSOLUTE_FLOOR (0.10) when 30% of starting confidence is less', () => {
    // 0.30 × 0.20 = 0.06 < 0.10 → floor is 0.10
    expect(decayFloor(0.20)).toBeCloseTo(0.10, 5)
  })

  it('uses 30% of starting confidence when it exceeds ABSOLUTE_FLOOR', () => {
    // 0.30 × 0.90 = 0.27 > 0.10 → floor is 0.27
    expect(decayFloor(0.90)).toBeCloseTo(0.27, 5)
  })

  it('floor at starting confidence of 0.50 is 0.15', () => {
    expect(decayFloor(0.50)).toBeCloseTo(0.15, 5)
  })
})

describe('computeDecay', () => {
  it('reduces confidence by 0.005 × weeks elapsed', () => {
    // 0.90 − (0.005 × 4w) = 0.90 − 0.02 = 0.88; floor=0.27 → no clamping
    expect(computeDecay(0.90, 0.90, 4)).toBeCloseTo(0.88, 5)
  })

  it('never decays below the starting-confidence floor', () => {
    // floor for 0.90 = 0.27; after many weeks onAgeDecay would give < 0.27
    // 0.90 − (0.005 × 200) = 0.90 − 1.00 = −0.10 (clamped to 0 by onAgeDecay), then floor=0.27
    expect(computeDecay(0.90, 0.90, 200)).toBeCloseTo(0.27, 5)
  })

  it('returns original confidence when no time has elapsed', () => {
    expect(computeDecay(0.80, 0.80, 0)).toBeCloseTo(0.80, 5)
  })

  it('applies ABSOLUTE_FLOOR (0.10) for low starting confidence after heavy decay', () => {
    // floor for 0.20 = 0.10; 0.20 − (0.005 × 100) = −0.30 → floor=0.10
    expect(computeDecay(0.20, 0.20, 100)).toBeCloseTo(0.10, 5)
  })
})
