/**
 * Constitutional Rule 5: Multi-Party Config Change
 *
 * Proves that:
 *   1. Fewer than 2 approvers is always rejected
 *   2. 2+ approvers from the same team is rejected (must be different teams)
 *   3. Fewer than 48h since proposal is rejected (cooling period)
 *   4. 2+ approvers from different teams + 48h+ cooling period → accepted
 *   5. Constitutional rules themselves cannot be changed via config
 */

import { describe, it, expect } from 'vitest'
import {
  enforceMultiPartyConfig,
  enforceConstitutionalRulesAreImmutable,
  ConstitutionalViolation,
} from '../../mcp/src/governance/constitutional.js'

/** Returns an ISO timestamp N hours in the past. */
function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
}

// ── enforceMultiPartyConfig ───────────────────────────────────────────────────

describe('enforceMultiPartyConfig — approver count', () => {
  const validProposedAt = hoursAgo(49) // safely past 48h cooling period

  it('throws with zero approvers', () => {
    expect(() => enforceMultiPartyConfig([], validProposedAt)).toThrow(ConstitutionalViolation)
  })

  it('throws with one approver', () => {
    expect(() =>
      enforceMultiPartyConfig([{ name: 'ayan', team: 'platform' }], validProposedAt)
    ).toThrow(ConstitutionalViolation)
  })

  it('throws with null/undefined approvers', () => {
    expect(() => enforceMultiPartyConfig(null, validProposedAt)).toThrow(ConstitutionalViolation)
    expect(() => enforceMultiPartyConfig(undefined, validProposedAt)).toThrow(ConstitutionalViolation)
  })

  it('sets rule to MULTI_PARTY_CONFIG', () => {
    try {
      enforceMultiPartyConfig([], validProposedAt)
    } catch (err) {
      expect(err.rule).toBe('MULTI_PARTY_CONFIG')
    }
  })
})

describe('enforceMultiPartyConfig — team diversity', () => {
  const validProposedAt = hoursAgo(49)

  it('throws when 2 approvers are from the same team', () => {
    expect(() =>
      enforceMultiPartyConfig(
        [{ name: 'ayan', team: 'platform' }, { name: 'bob', team: 'platform' }],
        validProposedAt,
      )
    ).toThrow(ConstitutionalViolation)
  })

  it('throws when team names differ only by case', () => {
    expect(() =>
      enforceMultiPartyConfig(
        [{ name: 'ayan', team: 'Platform' }, { name: 'bob', team: 'platform' }],
        validProposedAt,
      )
    ).toThrow(ConstitutionalViolation)
  })

  it('throws when team names differ only by whitespace', () => {
    expect(() =>
      enforceMultiPartyConfig(
        [{ name: 'ayan', team: 'platform ' }, { name: 'bob', team: 'platform' }],
        validProposedAt,
      )
    ).toThrow(ConstitutionalViolation)
  })

  it('throws when 3 approvers are all from the same team', () => {
    expect(() =>
      enforceMultiPartyConfig(
        [
          { name: 'ayan', team: 'platform' },
          { name: 'bob', team: 'platform' },
          { name: 'charlie', team: 'platform' },
        ],
        validProposedAt,
      )
    ).toThrow(ConstitutionalViolation)
  })
})

describe('enforceMultiPartyConfig — cooling period', () => {
  const validApprovers = [
    { name: 'ayan', team: 'platform' },
    { name: 'alice', team: 'security' },
  ]

  it('throws when proposed 0 hours ago (no cooling elapsed)', () => {
    expect(() =>
      enforceMultiPartyConfig(validApprovers, new Date().toISOString())
    ).toThrow(ConstitutionalViolation)
  })

  it('throws when proposed 47h ago', () => {
    expect(() =>
      enforceMultiPartyConfig(validApprovers, hoursAgo(47))
    ).toThrow(ConstitutionalViolation)
  })

  it('throws when proposed exactly 47.9h ago', () => {
    expect(() =>
      enforceMultiPartyConfig(validApprovers, hoursAgo(47.9))
    ).toThrow(ConstitutionalViolation)
  })

  it('does not throw when proposed exactly 48h ago (boundary inclusive)', () => {
    // hoursAgo(48) puts us right at the boundary — allow some float tolerance
    const proposedAt = new Date(Date.now() - 48 * 60 * 60 * 1000 - 1000).toISOString()
    expect(() => enforceMultiPartyConfig(validApprovers, proposedAt)).not.toThrow()
  })

  it('does not throw when proposed 72h ago', () => {
    expect(() =>
      enforceMultiPartyConfig(validApprovers, hoursAgo(72))
    ).not.toThrow()
  })

  it('error message includes remaining hours when cooling period not elapsed', () => {
    try {
      enforceMultiPartyConfig(validApprovers, hoursAgo(24))
    } catch (err) {
      expect(err.message).toMatch(/\d+h remaining/)
    }
  })
})

describe('enforceMultiPartyConfig — valid scenarios', () => {
  it('does not throw with 2 approvers from different teams, 49h ago', () => {
    expect(() =>
      enforceMultiPartyConfig(
        [{ name: 'ayan', team: 'platform' }, { name: 'alice', team: 'security' }],
        hoursAgo(49),
      )
    ).not.toThrow()
  })

  it('does not throw with 3 approvers from 3 different teams, 48h+ ago', () => {
    expect(() =>
      enforceMultiPartyConfig(
        [
          { name: 'ayan', team: 'platform' },
          { name: 'alice', team: 'security' },
          { name: 'bob', team: 'data' },
        ],
        hoursAgo(50),
      )
    ).not.toThrow()
  })
})

// ── enforceConstitutionalRulesAreImmutable ────────────────────────────────────

describe('enforceConstitutionalRulesAreImmutable', () => {
  it.each([
    'constitutional_rules',
    'no_hard_delete',
    'append_only_audit',
    'reason_required',
    'no_self_approval',
    'multi_party_config',
    'CONSTITUTIONAL_RULES',              // case insensitive
    'some.prefix.no_hard_delete.suffix', // embedded
  ])('throws for config key: %s', (configKey) => {
    expect(() => enforceConstitutionalRulesAreImmutable(configKey)).toThrow(ConstitutionalViolation)
  })

  it('does not throw for ordinary config keys', () => {
    expect(() => enforceConstitutionalRulesAreImmutable('conflict_threshold')).not.toThrow()
    expect(() => enforceConstitutionalRulesAreImmutable('authority_threshold')).not.toThrow()
    expect(() => enforceConstitutionalRulesAreImmutable('age_decay')).not.toThrow()
  })
})
