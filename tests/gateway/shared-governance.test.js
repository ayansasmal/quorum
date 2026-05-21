/**
 * Constitutional governance — pure-function coverage for:
 *   - shared/governance/constitutional.js
 *   - shared/governance/confidence.js
 *   - shared/governance/authority.js
 *
 * These modules have no I/O, so tests are direct function calls with no mocks.
 */

import { describe, it, expect, vi } from 'vitest'

// ── Mock config loader so authority.js doesn't try to read a file ─────────────

vi.mock('../../gateway/src/shared/config/loader.js', () => ({
  getConfig: vi.fn(() => {
    throw new Error('config not loaded — falls through to defaults')
  }),
}))

import {
  ConstitutionalViolation,
  enforceNoHardDelete,
  validateManifestHasNoDeleteTools,
  enforceAppendOnlyAudit,
  enforceReasonRequired,
  enforceNoSelfApproval,
  enforceConflictPartyCannotSelfResolve,
  enforceMultiPartyConfig,
  enforceConstitutionalRulesAreImmutable,
  enforceGlobalWriteAuthority,         // v0.4 Wave A
  enforceDeviationActionAuthority,     // v0.4 Wave A
  enforceValidDeferDeadline,           // v0.4 Wave A
} from '../../gateway/src/shared/governance/constitutional.js'

import {
  initialConfidence,
  onRecall,
  onAgeDecay,
  onConflictRaised,
  onConflictResolvedFor,
} from '../../gateway/src/shared/governance/confidence.js'

import {
  calculateAuthority,
  shouldAutoSupersede,
  resolveAuthorConfidence,
} from '../../gateway/src/shared/governance/authority.js'

// ── constitutional.js ─────────────────────────────────────────────────────────

describe('constitutional: ConstitutionalViolation', () => {
  it('carries rule, message, name, context', () => {
    const err = new ConstitutionalViolation('NO_HARD_DELETE', 'oops', { a: 1 })
    expect(err.name).toBe('ConstitutionalViolation')
    expect(err.rule).toBe('NO_HARD_DELETE')
    expect(err.message).toContain('NO_HARD_DELETE')
    expect(err.context).toEqual({ a: 1 })
  })
})

describe('constitutional: enforceNoHardDelete', () => {
  it('throws for each delete keyword', () => {
    for (const op of ['deleteNode', 'purge_all', 'remove-x', 'wipeStore', 'dropTable', 'truncate', 'erase', 'destroy']) {
      expect(() => enforceNoHardDelete(op)).toThrow(ConstitutionalViolation)
    }
  })
  it('does not throw for safe operations', () => {
    expect(() => enforceNoHardDelete('forget')).not.toThrow()
    expect(() => enforceNoHardDelete('supersede')).not.toThrow()
  })
})

describe('constitutional: validateManifestHasNoDeleteTools', () => {
  it('throws when manifest contains a delete-capable tool', () => {
    expect(() => validateManifestHasNoDeleteTools([{ name: 'hard_delete' }])).toThrow(ConstitutionalViolation)
    expect(() => validateManifestHasNoDeleteTools([{ name: 'purgeAll' }])).toThrow()
  })
  it('passes for clean manifest', () => {
    expect(() =>
      validateManifestHasNoDeleteTools([{ name: 'remember' }, { name: 'forget' }]),
    ).not.toThrow()
  })
  it('passes for empty manifest', () => {
    expect(() => validateManifestHasNoDeleteTools([])).not.toThrow()
  })
})

describe('constitutional: enforceAppendOnlyAudit', () => {
  it('always throws', () => {
    expect(() => enforceAppendOnlyAudit()).toThrow(ConstitutionalViolation)
  })
})

describe('constitutional: enforceReasonRequired', () => {
  it('throws when reason is null', () => {
    expect(() => enforceReasonRequired(null, 'op')).toThrow(ConstitutionalViolation)
  })
  it('throws when reason is undefined', () => {
    expect(() => enforceReasonRequired(undefined, 'op')).toThrow()
  })
  it('throws when reason is not a string', () => {
    expect(() => enforceReasonRequired(123, 'op')).toThrow()
  })
  it('throws when reason is empty', () => {
    expect(() => enforceReasonRequired('   ', 'op')).toThrow()
  })
  it('throws when reason is too short', () => {
    expect(() => enforceReasonRequired('short', 'op')).toThrow(/too short/)
  })
  it('throws on placeholder patterns', () => {
    // Short placeholders (< 10 chars) hit the "too short" guard first — just verify they throw.
    for (const short of ['todo', 'TODO', 'FIXME', 'n/a', 'tbd', '...', '!!!', 'ok', 'YES']) {
      expect(() => enforceReasonRequired(short, 'op')).toThrow(ConstitutionalViolation)
    }
    // Strings that are ≥ 10 chars AND match a placeholder pattern throw with "placeholder" message.
    expect(() => enforceReasonRequired('placeholder', 'op')).toThrow(/placeholder/)
    expect(() => enforceReasonRequired('reason here', 'op')).toThrow(/placeholder/)
    expect(() => enforceReasonRequired('add reason', 'op')).toThrow(/placeholder/)
  })
  it('accepts a real reason', () => {
    expect(() => enforceReasonRequired('This is a real reason for the change', 'op')).not.toThrow()
  })
})

describe('constitutional: enforceNoSelfApproval', () => {
  it('throws when author and reviewer match (case-insensitive)', () => {
    expect(() => enforceNoSelfApproval('alice', 'ALICE')).toThrow(ConstitutionalViolation)
    expect(() => enforceNoSelfApproval('alice', '  alice  ')).toThrow()
  })
  it('passes when author and reviewer differ', () => {
    expect(() => enforceNoSelfApproval('alice', 'bob')).not.toThrow()
  })
  it('honours the operation parameter', () => {
    expect(() => enforceNoSelfApproval('a', 'a', 'resolve')).toThrow()
  })
})

describe('constitutional: enforceConflictPartyCannotSelfResolve', () => {
  it('throws when resolver is one of the parties', () => {
    expect(() => enforceConflictPartyCannotSelfResolve(['alice', 'bob'], 'BOB')).toThrow()
  })
  it('passes when resolver is independent', () => {
    expect(() => enforceConflictPartyCannotSelfResolve(['alice', 'bob'], 'carol')).not.toThrow()
  })
})

describe('constitutional: enforceMultiPartyConfig', () => {
  const longAgo = new Date(Date.now() - 49 * 3600 * 1000).toISOString()
  it('throws on fewer than 2 approvers', () => {
    expect(() => enforceMultiPartyConfig([{ name: 'a', team: 'x' }], longAgo)).toThrow()
    expect(() => enforceMultiPartyConfig(null, longAgo)).toThrow()
  })
  it('throws when approvers share a team', () => {
    expect(() =>
      enforceMultiPartyConfig(
        [{ name: 'a', team: 'x' }, { name: 'b', team: 'X' }],
        longAgo,
      ),
    ).toThrow(/teams/)
  })
  it('throws when cooling period not elapsed', () => {
    const recent = new Date().toISOString()
    expect(() =>
      enforceMultiPartyConfig(
        [{ name: 'a', team: 'x' }, { name: 'b', team: 'y' }],
        recent,
      ),
    ).toThrow(/cooling/)
  })
  it('passes when all conditions met', () => {
    expect(() =>
      enforceMultiPartyConfig(
        [{ name: 'a', team: 'x' }, { name: 'b', team: 'y' }],
        longAgo,
      ),
    ).not.toThrow()
  })
})

describe('constitutional: enforceConstitutionalRulesAreImmutable', () => {
  it('throws when key targets a constitutional rule', () => {
    for (const k of ['constitutional_rules', 'no_hard_delete', 'append_only_audit', 'reason_required', 'no_self_approval', 'multi_party_config']) {
      expect(() => enforceConstitutionalRulesAreImmutable(k)).toThrow()
    }
  })
  it('passes for ordinary config keys', () => {
    expect(() => enforceConstitutionalRulesAreImmutable('thresholds.authority')).not.toThrow()
  })
})

// ── confidence.js ─────────────────────────────────────────────────────────────

describe('confidence', () => {
  it('initialConfidence falls back to 0.7 when missing or non-numeric', () => {
    expect(initialConfidence(null)).toBe(0.7)
    expect(initialConfidence(undefined)).toBe(0.7)
    expect(initialConfidence('high')).toBe(0.7)
  })
  it('initialConfidence clamps to [0, 1]', () => {
    expect(initialConfidence(0.5)).toBe(0.5)
    expect(initialConfidence(-1)).toBe(0)
    expect(initialConfidence(99)).toBe(1)
  })
  it('onRecall adds 0.01 and clamps at 1', () => {
    expect(onRecall(0.5)).toBeCloseTo(0.51)
    expect(onRecall(0.999)).toBe(1)
  })
  it('onAgeDecay subtracts 0.005 per week and clamps at 0', () => {
    expect(onAgeDecay(0.5, 4)).toBeCloseTo(0.48)
    expect(onAgeDecay(0.01, 10)).toBe(0)
  })
  it('onConflictRaised subtracts 0.1 with clamp', () => {
    expect(onConflictRaised(0.5)).toBeCloseTo(0.4)
    expect(onConflictRaised(0.05)).toBe(0)
  })
  it('onConflictResolvedFor adds 0.1 with clamp', () => {
    expect(onConflictResolvedFor(0.5)).toBeCloseTo(0.6)
    expect(onConflictResolvedFor(0.95)).toBe(1)
  })
})

// ── authority.js ──────────────────────────────────────────────────────────────

describe('authority: calculateAuthority', () => {
  it('produces a score within [0, ~1]', () => {
    const score = calculateAuthority({
      confidence: 0.8,
      created_at: new Date().toISOString(),
      access_count: 5,
      author_role: 'architect',
    })
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(1.2) // bounds aren't strict 0..1 in formula
  })
  it('falls back to engineer baseline for unknown role', () => {
    const s = calculateAuthority({ created_at: new Date().toISOString(), author_role: 'mystery' })
    expect(s).toBeGreaterThan(0)
  })
  it('handles missing optional fields gracefully', () => {
    const s = calculateAuthority({ created_at: new Date().toISOString() })
    expect(typeof s).toBe('number')
  })
  it('uses domain_track_record when supplied', () => {
    const withDtr = calculateAuthority({
      created_at: new Date().toISOString(),
      author_role: 'engineer',
      domain_track_record: { approved_count: 10, recalled_count: 5, superseded_count: 1 },
    })
    const withoutDtr = calculateAuthority({
      created_at: new Date().toISOString(),
      author_role: 'engineer',
    })
    expect(withDtr).toBeGreaterThan(withoutDtr)
  })
  it('floors negative domain score at zero', () => {
    // Lots of superseded entries should not make score negative
    const s = calculateAuthority({
      created_at: new Date().toISOString(),
      author_role: 'engineer',
      domain_track_record: { approved_count: 0, recalled_count: 0, superseded_count: 100 },
    })
    expect(s).toBeGreaterThan(0)
  })
})

describe('authority: shouldAutoSupersede', () => {
  const now = new Date().toISOString()

  it('returns false when incoming is lower tier than existing (hard gate)', () => {
    expect(
      shouldAutoSupersede(
        { confidence: 0.99, created_at: now, author_role: 'engineer' },
        { confidence: 0.10, created_at: now, author_role: 'architect' },
      ),
    ).toBe(false)
  })

  it('returns true when incoming is same tier and has higher authority', () => {
    const old = new Date(Date.now() - 1000 * 86400 * 1000).toISOString()
    const result = shouldAutoSupersede(
      { confidence: 0.95, created_at: now, access_count: 50, author_role: 'architect' },
      { confidence: 0.20, created_at: old, access_count: 0,  author_role: 'architect' },
    )
    expect(result).toBe(true)
  })

  it('returns false when delta is below threshold', () => {
    expect(
      shouldAutoSupersede(
        { confidence: 0.5, created_at: now, author_role: 'engineer' },
        { confidence: 0.5, created_at: now, author_role: 'engineer' },
      ),
    ).toBe(false)
  })
})

describe('authority: resolveAuthorConfidence', () => {
  it('returns provided when above floor', () => {
    expect(resolveAuthorConfidence(0.9, { base_confidence: 0.5, role: 'engineer' })).toBe(0.9)
  })
  it('applies floor when provided is lower', () => {
    expect(resolveAuthorConfidence(0.1, { base_confidence: 0.7, role: 'engineer' })).toBe(0.7)
  })
  it('defaults to 0.5 floor when identity has no base_confidence', () => {
    expect(resolveAuthorConfidence(0.1, { role: 'engineer' })).toBe(0.5)
  })
})

// ── v0.4 Wave A: new constitutional functions ─────────────────────────────────

describe('constitutional: enforceGlobalWriteAuthority', () => {
  it('does nothing when isGlobalProject is false (non-global project)', () => {
    // engineer can write to their own project — not a global catalog
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'engineer' }, 'payments-service', false),
    ).not.toThrow()
  })

  it('throws ConstitutionalViolation for engineer writing to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'engineer' }, 'security-standards', true),
    ).toThrow(ConstitutionalViolation)
  })

  it('throws for senior_engineer writing to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'senior_engineer' }, 'security-standards', true),
    ).toThrow(ConstitutionalViolation)
  })

  it('throws for tech_lead writing to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'tech_lead' }, 'security-standards', true),
    ).toThrow(ConstitutionalViolation)
  })

  it('allows architect to write to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'architect' }, 'security-standards', true),
    ).not.toThrow()
  })

  it('allows principal_architect to write to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'principal_architect' }, 'security-standards', true),
    ).not.toThrow()
  })

  it('allows product_owner to write to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'product_owner' }, 'security-standards', true),
    ).not.toThrow()
  })

  it('allows compliance_officer to write to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({ role: 'compliance_officer' }, 'security-standards', true),
    ).not.toThrow()
  })

  it('violation carries rule GLOBAL_WRITE_AUTHORITY with correct context', () => {
    try {
      enforceGlobalWriteAuthority({ role: 'engineer' }, 'security-standards', true)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConstitutionalViolation)
      expect(err.rule).toBe('GLOBAL_WRITE_AUTHORITY')
      expect(err.context.role).toBe('engineer')
      expect(err.context.projectId).toBe('security-standards')
    }
  })

  it('throws for undefined role (empty identity) writing to a global catalog', () => {
    expect(() =>
      enforceGlobalWriteAuthority({}, 'security-standards', true),
    ).toThrow(ConstitutionalViolation)
  })

  it('executive roles (director, vp_engineering, group_executive) cannot write to global catalogs', () => {
    for (const role of ['director', 'vp_engineering', 'group_executive']) {
      expect(() =>
        enforceGlobalWriteAuthority({ role }, 'security-standards', true),
      ).toThrow(ConstitutionalViolation)
    }
  })
})

describe('constitutional: enforceDeviationActionAuthority', () => {
  it('allows architect to accept a deviation', () => {
    expect(() => enforceDeviationActionAuthority('architect', 'accept')).not.toThrow()
  })

  it('allows principal_architect to deny a deviation', () => {
    expect(() => enforceDeviationActionAuthority('principal_architect', 'deny')).not.toThrow()
  })

  it('allows product_owner to defer a deviation', () => {
    expect(() => enforceDeviationActionAuthority('product_owner', 'defer')).not.toThrow()
  })

  it('allows compliance_officer to accept a deviation', () => {
    expect(() => enforceDeviationActionAuthority('compliance_officer', 'accept')).not.toThrow()
  })

  it('throws for engineer attempting to accept a deviation', () => {
    expect(() => enforceDeviationActionAuthority('engineer', 'accept')).toThrow(ConstitutionalViolation)
  })

  it('throws for senior_engineer attempting to deny', () => {
    expect(() => enforceDeviationActionAuthority('senior_engineer', 'deny')).toThrow(ConstitutionalViolation)
  })

  it('throws for director (executive roles are read-only in governance)', () => {
    expect(() => enforceDeviationActionAuthority('director', 'deny')).toThrow(ConstitutionalViolation)
  })

  it('throws for vp_engineering (executive roles are read-only)', () => {
    expect(() => enforceDeviationActionAuthority('vp_engineering', 'accept')).toThrow(ConstitutionalViolation)
  })

  it('throws for group_executive (executive roles are read-only)', () => {
    expect(() => enforceDeviationActionAuthority('group_executive', 'defer')).toThrow(ConstitutionalViolation)
  })

  it('violation carries rule DEVIATION_ACTION_AUTHORITY with correct context', () => {
    try {
      enforceDeviationActionAuthority('engineer', 'accept')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConstitutionalViolation)
      expect(err.rule).toBe('DEVIATION_ACTION_AUTHORITY')
      expect(err.context.actorRole).toBe('engineer')
      expect(err.context.operation).toBe('accept')
    }
  })
})

describe('constitutional: enforceValidDeferDeadline', () => {
  // Helper: create a Date exactly N days from now
  function daysFromNow(n) {
    return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString()
  }

  it('accepts exactly 30 days from now', () => {
    expect(() => enforceValidDeferDeadline(daysFromNow(30))).not.toThrow()
  })

  it('accepts exactly 45 days from now', () => {
    expect(() => enforceValidDeferDeadline(daysFromNow(45))).not.toThrow()
  })

  it('accepts exactly 60 days from now', () => {
    expect(() => enforceValidDeferDeadline(daysFromNow(60))).not.toThrow()
  })

  it('accepts exactly 90 days from now', () => {
    expect(() => enforceValidDeferDeadline(daysFromNow(90))).not.toThrow()
  })

  it('rejects 29 days (not a valid option)', () => {
    expect(() => enforceValidDeferDeadline(daysFromNow(29))).toThrow(ConstitutionalViolation)
  })

  it('rejects 31 days (not a valid option)', () => {
    expect(() => enforceValidDeferDeadline(daysFromNow(31))).toThrow(ConstitutionalViolation)
  })

  it('rejects 0 days (immediate expiry is not a defer)', () => {
    expect(() => enforceValidDeferDeadline(new Date().toISOString())).toThrow(ConstitutionalViolation)
  })

  it('rejects 120 days (no indefinite deferrals)', () => {
    expect(() => enforceValidDeferDeadline(daysFromNow(120))).toThrow(ConstitutionalViolation)
  })

  it('also accepts Date objects, not just ISO strings', () => {
    expect(() => enforceValidDeferDeadline(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000))).not.toThrow()
  })

  it('violation carries rule DEFER_DEADLINE with the computed day count', () => {
    try {
      enforceValidDeferDeadline(daysFromNow(31))
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConstitutionalViolation)
      expect(err.rule).toBe('DEFER_DEADLINE')
      expect(err.context.days).toBe(31)
    }
  })
})
