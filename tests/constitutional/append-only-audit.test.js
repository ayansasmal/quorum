/**
 * Constitutional Rule 2: Append-Only Audit
 *
 * Proves that:
 *   1. enforceAppendOnlyAudit() always throws — no caller can bypass it
 *   2. secondary.updateEntry() throws ConstitutionalViolation unconditionally
 *   3. secondary.deleteEntry() throws ConstitutionalViolation unconditionally
 *   4. The chain module produces valid entries verifiable by verifyChain()
 *   5. hashEntry is deterministic (same input → same hash)
 *   6. Modifying any field in a stored entry breaks verifyChain()
 */

import { describe, it, expect } from 'vitest'
import {
  enforceAppendOnlyAudit,
  ConstitutionalViolation,
} from '../../src/governance/constitutional.js'
import { updateEntry, deleteEntry } from '../../src/audit/secondary.js'
import {
  hashEntry,
  buildEntryWithHash,
  verifyChain,
  ChainIntegrityViolation,
} from '../../src/audit/chain.js'

// ── enforceAppendOnlyAudit ────────────────────────────────────────────────────

describe('enforceAppendOnlyAudit', () => {
  it('always throws a ConstitutionalViolation', () => {
    expect(() => enforceAppendOnlyAudit()).toThrow(ConstitutionalViolation)
  })

  it('sets rule to APPEND_ONLY_AUDIT', () => {
    try {
      enforceAppendOnlyAudit()
    } catch (err) {
      expect(err.rule).toBe('APPEND_ONLY_AUDIT')
    }
  })

  it('throws regardless of arguments passed', () => {
    expect(() => enforceAppendOnlyAudit(null)).toThrow(ConstitutionalViolation)
    expect(() => enforceAppendOnlyAudit({ anything: true })).toThrow(ConstitutionalViolation)
    expect(() => enforceAppendOnlyAudit('bypass')).toThrow(ConstitutionalViolation)
  })
})

// ── secondary.updateEntry / deleteEntry ───────────────────────────────────────

describe('secondary.updateEntry', () => {
  it('throws ConstitutionalViolation unconditionally', () => {
    expect(() => updateEntry()).toThrow(ConstitutionalViolation)
  })

  it('throws even with a pg pool and entry arguments', () => {
    const fakePg = {}
    const fakeEntry = { entry_id: 'test-id' }
    expect(() => updateEntry(fakePg, fakeEntry)).toThrow(ConstitutionalViolation)
  })

  it('sets rule to APPEND_ONLY_AUDIT', () => {
    try {
      updateEntry()
    } catch (err) {
      expect(err.rule).toBe('APPEND_ONLY_AUDIT')
    }
  })
})

describe('secondary.deleteEntry', () => {
  it('throws ConstitutionalViolation unconditionally', () => {
    expect(() => deleteEntry()).toThrow(ConstitutionalViolation)
  })

  it('throws even with a pg pool and id argument', () => {
    expect(() => deleteEntry({}, 'some-id')).toThrow(ConstitutionalViolation)
  })

  it('sets rule to APPEND_ONLY_AUDIT', () => {
    try {
      deleteEntry()
    } catch (err) {
      expect(err.rule).toBe('APPEND_ONLY_AUDIT')
    }
  })
})

// ── audit chain integrity ─────────────────────────────────────────────────────

describe('hashEntry', () => {
  it('produces a hex string', () => {
    const entry = {
      entry_id: 'e1',
      operation: 'INTENT',
      tool: 'remember',
      timestamp: '2024-01-01T00:00:00Z',
      author: 'ayan',
      chain_position: 1,
    }
    const hash = hashEntry(entry)
    expect(typeof hash).toBe('string')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic — same entry produces same hash', () => {
    const entry = {
      entry_id: 'e1',
      operation: 'INTENT',
      tool: 'remember',
      timestamp: '2024-01-01T00:00:00Z',
      author: 'ayan',
      chain_position: 1,
    }
    expect(hashEntry(entry)).toBe(hashEntry(entry))
  })

  it('produces different hash when any field changes', () => {
    const base = {
      entry_id: 'e1',
      operation: 'INTENT',
      tool: 'remember',
      timestamp: '2024-01-01T00:00:00Z',
      author: 'ayan',
      chain_position: 1,
    }
    const modified = { ...base, author: 'tampered' }
    expect(hashEntry(base)).not.toBe(hashEntry(modified))
  })

  it('excludes entry_hash field itself (no circularity)', () => {
    const entry = {
      entry_id: 'e1',
      operation: 'INTENT',
      tool: 'remember',
      timestamp: '2024-01-01T00:00:00Z',
      author: 'ayan',
      chain_position: 1,
      entry_hash: 'should-be-excluded',
    }
    const entryWithout = { ...entry }
    delete entryWithout.entry_hash

    // Hash should be identical regardless of entry_hash value
    expect(hashEntry(entry)).toBe(hashEntry(entryWithout))
  })
})

describe('verifyChain', () => {
  /**
   * Build a valid 3-entry chain for use in tests.
   */
  function buildValidChain() {
    const e1 = buildEntryWithHash(
      { entry_id: 'e1', operation: 'INTENT', tool: 'remember', timestamp: '2024-01-01T00:00:00Z', author: 'ayan' },
      null,
      1,
    )
    const e2 = buildEntryWithHash(
      { entry_id: 'e2', operation: 'OUTCOME', tool: 'remember', timestamp: '2024-01-01T00:00:01Z', author: 'ayan' },
      e1.entry_hash,
      2,
    )
    const e3 = buildEntryWithHash(
      { entry_id: 'e3', operation: 'INTENT', tool: 'recall', timestamp: '2024-01-01T00:00:02Z', author: 'ayan' },
      e2.entry_hash,
      3,
    )
    return [e1, e2, e3]
  }

  it('returns { verified: true } for a valid chain', () => {
    const chain = buildValidChain()
    const result = verifyChain(chain)
    expect(result.verified).toBe(true)
    expect(result.entries).toBe(3)
  })

  it('returns { verified: true } for empty chain', () => {
    const result = verifyChain([])
    expect(result.verified).toBe(true)
    expect(result.entries).toBe(0)
  })

  it('throws ChainIntegrityViolation when entry_hash is tampered', () => {
    const chain = buildValidChain()
    chain[1] = { ...chain[1], author: 'tampered_author' } // modify content but not hash
    expect(() => verifyChain(chain)).toThrow(ChainIntegrityViolation)
  })

  it('throws ChainIntegrityViolation when previous_hash link is broken', () => {
    const chain = buildValidChain()
    chain[2] = { ...chain[2], previous_hash: 'wrong-previous-hash' }
    // Recompute entry_hash so the entry itself is internally consistent, but the chain link is wrong
    const e3Fixed = buildEntryWithHash(
      { entry_id: 'e3', operation: 'INTENT', tool: 'recall', timestamp: '2024-01-01T00:00:02Z', author: 'ayan' },
      'wrong-previous-hash', // wrong previous
      3,
    )
    chain[2] = e3Fixed
    expect(() => verifyChain(chain)).toThrow(ChainIntegrityViolation)
  })

  it('ChainIntegrityViolation carries position info', () => {
    const chain = buildValidChain()
    chain[1] = { ...chain[1], author: 'tampered' }
    try {
      verifyChain(chain)
    } catch (err) {
      expect(err).toBeInstanceOf(ChainIntegrityViolation)
      expect(err.position).toBeDefined()
      expect(typeof err.expected).toBe('string')
      expect(typeof err.actual).toBe('string')
    }
  })
})
