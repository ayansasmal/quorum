/**
 * SHA256 audit chain — pure hashing + chain verification.
 *
 * Covers:
 *   - hashEntry: deterministic across key order + JSONB round-trips
 *   - buildEntryWithHash: attaches previous_hash, chain_position, entry_hash
 *   - verifyChain: detects tampering on entry_hash and previous_hash links
 *   - nextChainPosition: increments via UPDATE
 *   - ChainIntegrityViolation: carries position/expected/actual/entry
 */

import { describe, it, expect, vi } from 'vitest'
import {
  hashEntry,
  buildEntryWithHash,
  verifyChain,
  nextChainPosition,
  ChainIntegrityViolation,
} from '../../gateway/src/shared/audit/chain.js'

describe('hashEntry', () => {
  it('is deterministic regardless of key insertion order', () => {
    const a = { entry_id: '1', operation: 'create', tool: 'remember', author: 'alice' }
    const b = { author: 'alice', tool: 'remember', operation: 'create', entry_id: '1' }
    expect(hashEntry(a)).toBe(hashEntry(b))
  })
  it('produces different hashes for different content', () => {
    expect(hashEntry({ entry_id: '1' })).not.toBe(hashEntry({ entry_id: '2' }))
  })
  it('ignores non-hashable fields', () => {
    const a = { entry_id: '1', operation: 'create', some_extra: 'x' }
    const b = { entry_id: '1', operation: 'create' }
    expect(hashEntry(a)).toBe(hashEntry(b))
  })
  it('normalises Date objects to ISO strings (JSONB round-trip)', () => {
    const iso = '2024-01-01T00:00:00.000Z'
    const fromString = hashEntry({ entry_id: '1', timestamp: iso })
    const fromDate   = hashEntry({ entry_id: '1', timestamp: new Date(iso) })
    expect(fromString).toBe(fromDate)
  })
  it('handles nested objects deterministically', () => {
    const h1 = hashEntry({ entry_id: '1', governance_json: { a: 1, b: { x: 1, y: 2 } } })
    const h2 = hashEntry({ entry_id: '1', governance_json: { b: { y: 2, x: 1 }, a: 1 } })
    expect(h1).toBe(h2)
  })
  it('preserves array order', () => {
    const h1 = hashEntry({ entry_id: '1', governance_json: { tags: ['a', 'b'] } })
    const h2 = hashEntry({ entry_id: '1', governance_json: { tags: ['b', 'a'] } })
    expect(h1).not.toBe(h2)
  })
})

describe('buildEntryWithHash', () => {
  it('attaches chain fields and entry_hash', () => {
    const built = buildEntryWithHash({ entry_id: '1', operation: 'create' }, null, 1)
    expect(built.previous_hash).toBe(null)
    expect(built.chain_position).toBe(1)
    expect(built.entry_hash).toMatch(/^[a-f0-9]{64}$/)
  })
  it('produces identical hash for the same content', () => {
    const a = buildEntryWithHash({ entry_id: '1' }, null, 1)
    const b = buildEntryWithHash({ entry_id: '1' }, null, 1)
    expect(a.entry_hash).toBe(b.entry_hash)
  })
  it('links previous_hash through', () => {
    const built = buildEntryWithHash({ entry_id: '2' }, 'abc123', 2)
    expect(built.previous_hash).toBe('abc123')
  })
})

describe('verifyChain', () => {
  it('verifies a clean chain', () => {
    const e1 = buildEntryWithHash({ entry_id: '1', operation: 'create' }, null, 1)
    const e2 = buildEntryWithHash({ entry_id: '2', operation: 'update' }, e1.entry_hash, 2)
    const result = verifyChain([e1, e2])
    expect(result.verified).toBe(true)
    expect(result.entries).toBe(2)
  })
  it('throws when entry_hash has been tampered', () => {
    const e1 = buildEntryWithHash({ entry_id: '1' }, null, 1)
    e1.entry_hash = 'deadbeef'.padEnd(64, '0')
    expect(() => verifyChain([e1])).toThrow(ChainIntegrityViolation)
  })
  it('throws when previous_hash link is broken', () => {
    const e1 = buildEntryWithHash({ entry_id: '1' }, null, 1)
    const e2 = buildEntryWithHash({ entry_id: '2' }, e1.entry_hash, 2)
    e2.previous_hash = 'wrong'.padEnd(64, '0')
    // recompute entry_hash so first check passes; but previous_hash mismatch triggers second
    e2.entry_hash = hashEntry(e2)
    expect(() => verifyChain([e1, e2])).toThrow(ChainIntegrityViolation)
  })
  it('verifies an empty chain', () => {
    expect(verifyChain([])).toEqual({ verified: true, entries: 0 })
  })
})

describe('ChainIntegrityViolation', () => {
  it('carries position, expected, actual, entry', () => {
    const err = new ChainIntegrityViolation(3, 'aaa', 'bbb', { entry_id: 'x' })
    expect(err.name).toBe('ChainIntegrityViolation')
    expect(err.position).toBe(3)
    expect(err.expected).toBe('aaa')
    expect(err.actual).toBe('bbb')
    expect(err.entry).toEqual({ entry_id: 'x' })
    expect(err.message).toContain('position 3')
  })
})

describe('nextChainPosition', () => {
  it('returns the next position from the counter UPDATE', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ next_pos: 42 }] }),
    }
    const pos = await nextChainPosition(client)
    expect(pos).toBe(42)
    expect(client.query).toHaveBeenCalledTimes(1)
    expect(client.query.mock.calls[0][0]).toContain('audit_chain_counter')
  })
})
