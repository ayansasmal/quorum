/**
 * Constitutional Rule 4: No Self-Approval
 *
 * Proves that:
 *   1. enforceNoSelfApproval throws when author === reviewer (exact match)
 *   2. Identity normalization: "AYAN" === "ayan" === "ayan " (trim+lowercase)
 *   3. enforceConflictPartyCannotSelfResolve throws when resolver is a conflict party
 *   4. Different identities never trigger the rule
 */

import { describe, it, expect } from 'vitest'
import {
  enforceNoSelfApproval,
  enforceConflictPartyCannotSelfResolve,
  ConstitutionalViolation,
} from '../../mcp/src/governance/constitutional.js'

// ── enforceNoSelfApproval ─────────────────────────────────────────────────────

describe('enforceNoSelfApproval', () => {
  it('throws when author and reviewer are identical strings', () => {
    expect(() => enforceNoSelfApproval('ayan', 'ayan')).toThrow(ConstitutionalViolation)
  })

  it('throws when author is uppercase and reviewer is lowercase', () => {
    expect(() => enforceNoSelfApproval('AYAN', 'ayan')).toThrow(ConstitutionalViolation)
  })

  it('throws when reviewer has trailing whitespace', () => {
    expect(() => enforceNoSelfApproval('ayan', 'ayan ')).toThrow(ConstitutionalViolation)
  })

  it('throws when author has leading whitespace', () => {
    expect(() => enforceNoSelfApproval(' ayan', 'ayan')).toThrow(ConstitutionalViolation)
  })

  it('throws when both have mixed case and whitespace', () => {
    // "AYAN " normalizes to "ayan", same as "ayan"
    expect(() => enforceNoSelfApproval('AYAN ', ' Ayan')).toThrow(ConstitutionalViolation)
  })

  it('does not throw when author and reviewer are different people', () => {
    expect(() => enforceNoSelfApproval('junior-dev', 'senior-architect')).not.toThrow()
  })

  it('does not throw when names are similar but different', () => {
    expect(() => enforceNoSelfApproval('ayan', 'ayaan')).not.toThrow()
    expect(() => enforceNoSelfApproval('ayan', 'ayan1')).not.toThrow()
  })

  it('sets rule to NO_SELF_APPROVAL on thrown error', () => {
    try {
      enforceNoSelfApproval('ayan', 'ayan')
    } catch (err) {
      expect(err.rule).toBe('NO_SELF_APPROVAL')
      expect(err.name).toBe('ConstitutionalViolation')
    }
  })

  it('includes both author and reviewer in error context', () => {
    try {
      enforceNoSelfApproval('ayan', 'ayan')
    } catch (err) {
      expect(err.context.author).toBe('ayan')
      expect(err.context.reviewer).toBe('ayan')
    }
  })

  it('accepts custom operation name in context', () => {
    try {
      enforceNoSelfApproval('ayan', 'ayan', 'conflict_resolution')
    } catch (err) {
      expect(err.context.operation).toBe('conflict_resolution')
    }
  })
})

// ── enforceConflictPartyCannotSelfResolve ─────────────────────────────────────

describe('enforceConflictPartyCannotSelfResolve', () => {
  it('throws when resolver is one of the conflict parties', () => {
    expect(() =>
      enforceConflictPartyCannotSelfResolve(['ayan', 'senior-architect'], 'ayan')
    ).toThrow(ConstitutionalViolation)
  })

  it('throws when resolver matches a party after normalization', () => {
    expect(() =>
      enforceConflictPartyCannotSelfResolve(['AYAN', 'senior-architect'], 'ayan ')
    ).toThrow(ConstitutionalViolation)
  })

  it('throws when resolver matches any party in a multi-party conflict', () => {
    expect(() =>
      enforceConflictPartyCannotSelfResolve(['alice', 'bob', 'charlie'], 'charlie')
    ).toThrow(ConstitutionalViolation)
  })

  it('does not throw when resolver is not a party', () => {
    expect(() =>
      enforceConflictPartyCannotSelfResolve(['ayan', 'junior-dev'], 'senior-architect')
    ).not.toThrow()
  })

  it('does not throw with empty conflict parties list', () => {
    expect(() =>
      enforceConflictPartyCannotSelfResolve([], 'ayan')
    ).not.toThrow()
  })

  it('sets rule to NO_SELF_APPROVAL', () => {
    try {
      enforceConflictPartyCannotSelfResolve(['ayan'], 'ayan')
    } catch (err) {
      expect(err.rule).toBe('NO_SELF_APPROVAL')
    }
  })
})
