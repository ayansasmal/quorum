/**
 * Constitutional Rule 3: Reason Required
 *
 * Proves that enforceReasonRequired() rejects:
 *   - null / undefined
 *   - empty string
 *   - whitespace-only strings
 *   - strings under 10 meaningful characters
 *   - placeholder strings (TODO, FIXME, N/A, TBD, etc.)
 *
 * And accepts legitimate reasons with ≥ 10 meaningful chars.
 */

import { describe, it, expect } from 'vitest'
import {
  enforceReasonRequired,
  ConstitutionalViolation,
} from '../../src/governance/constitutional.js'

// ── Invalid reasons — should throw ────────────────────────────────────────────

describe('enforceReasonRequired — invalid reasons', () => {
  const OPERATION = 'test_operation'

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['boolean', false],
    ['object', {}],
  ])('throws when reason is %s', (_, reason) => {
    expect(() => enforceReasonRequired(reason, OPERATION)).toThrow(ConstitutionalViolation)
  })

  it('throws when reason is empty string', () => {
    expect(() => enforceReasonRequired('', OPERATION)).toThrow(ConstitutionalViolation)
  })

  it('throws when reason is whitespace only', () => {
    expect(() => enforceReasonRequired('   ', OPERATION)).toThrow(ConstitutionalViolation)
    expect(() => enforceReasonRequired('\t\n', OPERATION)).toThrow(ConstitutionalViolation)
  })

  it('throws when reason is fewer than 10 chars', () => {
    expect(() => enforceReasonRequired('short', OPERATION)).toThrow(ConstitutionalViolation)
    expect(() => enforceReasonRequired('9chars!!', OPERATION)).toThrow(ConstitutionalViolation)
  })

  it.each([
    'TODO',
    'FIXME',
    'reason here',
    'add reason',
    'n/a',
    'na',
    'N/A',
    'TBD',
    'placeholder',
    'test',
    '...',
    '!!!',
    'ok',
    'yes',
  ])('throws for placeholder reason: %s', (reason) => {
    expect(() => enforceReasonRequired(reason, OPERATION)).toThrow(ConstitutionalViolation)
  })

  it('sets rule to REASON_REQUIRED on thrown error', () => {
    try {
      enforceReasonRequired(null, OPERATION)
    } catch (err) {
      expect(err.rule).toBe('REASON_REQUIRED')
      expect(err.name).toBe('ConstitutionalViolation')
    }
  })

  it('includes operation name in error context', () => {
    try {
      enforceReasonRequired(null, 'my_operation')
    } catch (err) {
      expect(err.message).toContain('my_operation')
    }
  })
})

// ── Valid reasons — should not throw ─────────────────────────────────────────

describe('enforceReasonRequired — valid reasons', () => {
  const OPERATION = 'test_operation'

  it.each([
    ['ADR-042 nuanced after Lambda constraint discovered in payment-svc'],
    ['Lambda services do not support session tokens — stateless JWT required'],
    ['Migration rollback risk — keeping backwards compatible schema until v2 deploys'],
    ['Security team flagged session token storage as non-compliant with SOC2'],
    ['Confirmed in architecture review — aligns with ADR-042'],
    ['exactly10c'],  // exactly 10 chars
    ['This is a valid detailed reason for the change.'],
  ])('accepts valid reason: %s', (reason) => {
    expect(() => enforceReasonRequired(reason, OPERATION)).not.toThrow()
  })

  it('strips leading/trailing whitespace before length check', () => {
    // 10 chars of meaningful content surrounded by whitespace
    expect(() => enforceReasonRequired('  exactly10c  ', OPERATION)).not.toThrow()
  })
})

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('enforceReasonRequired — edge cases', () => {
  it('works with various operation names in the error message', () => {
    try {
      enforceReasonRequired(null, 'forget')
    } catch (err) {
      expect(err.message).toContain('forget')
    }

    try {
      enforceReasonRequired(null, 'remember (supersede)')
    } catch (err) {
      expect(err.message).toContain('remember (supersede)')
    }
  })

  it('rejects a reason with 9 meaningful chars even with surrounding spaces', () => {
    expect(() => enforceReasonRequired('  9chars!!  ', 'op')).toThrow(ConstitutionalViolation)
  })
})
