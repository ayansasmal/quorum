/**
 * SHA256 tamper-evident audit chain.
 *
 * Every audit entry carries the hash of the previous entry.
 * Modifying any historical entry breaks the chain — detectable on the next verify().
 *
 * Hash input: a deterministic JSON serialisation of the entry's content fields
 * (keys sorted, entry_hash field excluded to avoid circularity).
 */

import { createHash } from 'node:crypto'

/** Fields included in the hash. entry_hash itself is excluded (circular). */
const HASHED_FIELDS = [
  'entry_id',
  'operation',
  'tool',
  'timestamp',
  'author',
  'content_hash',
  'governance_json',
  'outcome_json',
  'version_impact',
  'previous_hash',
  'chain_position',
]

export class ChainIntegrityViolation extends Error {
  /**
   * @param {number} position
   * @param {string} expected
   * @param {string} actual
   * @param {unknown} entry
   */
  constructor(position, expected, actual, entry) {
    super(`Chain integrity violation at position ${position}: expected ${expected}, got ${actual}`)
    this.name = 'ChainIntegrityViolation'
    this.position = position
    this.expected = expected
    this.actual = actual
    this.entry = entry
  }
}

/**
 * Compute the SHA256 hash of an audit entry's content fields.
 * Keys are sorted for determinism. entry_hash is excluded.
 * @param {Record<string, unknown>} entry
 * @returns {string} hex digest
 */
export function hashEntry(entry) {
  const hashable = {}
  for (const field of HASHED_FIELDS) {
    if (field in entry) {
      hashable[field] = entry[field]
    }
  }
  const sorted = Object.fromEntries(
    Object.keys(hashable)
      .sort()
      .map((k) => [k, hashable[k]]),
  )
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
}

/**
 * Build a complete audit entry object with chain fields attached.
 * @param {Record<string, unknown>} entry - entry without chain fields
 * @param {string | null} previousHash - hash of the previous entry, null for first
 * @param {number} chainPosition - monotonically increasing position
 * @returns {Record<string, unknown>} entry with entry_hash, previous_hash, chain_position
 */
export function buildEntryWithHash(entry, previousHash, chainPosition) {
  const withChain = {
    ...entry,
    previous_hash: previousHash,
    chain_position: chainPosition,
  }
  const entryHash = hashEntry(withChain)
  return { ...withChain, entry_hash: entryHash }
}

/**
 * Verify the integrity of the full audit chain.
 * Entries must be ordered by chain_position ascending.
 * Throws ChainIntegrityViolation on the first broken link.
 * @param {Array<Record<string, unknown>>} entries - ordered by chain_position ASC
 * @returns {{ verified: true, entries: number }}
 */
export function verifyChain(entries) {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const expected = hashEntry(entry)

    if (entry.entry_hash !== expected) {
      throw new ChainIntegrityViolation(
        entry.chain_position,
        expected,
        entry.entry_hash,
        entry,
      )
    }

    if (i > 0) {
      const prevHash = hashEntry(entries[i - 1])
      if (entry.previous_hash !== prevHash) {
        throw new ChainIntegrityViolation(
          entry.chain_position,
          prevHash,
          entry.previous_hash,
          entry,
        )
      }
    }
  }

  return { verified: true, entries: entries.length }
}

/**
 * Get the next chain position within a transaction.
 * Must be called inside the same pg transaction as the subsequent INSERT
 * to prevent race conditions.
 * @param {import('pg').PoolClient} client - active transaction client
 * @returns {Promise<number>}
 */
export async function nextChainPosition(client) {
  const result = await client.query(
    'SELECT COALESCE(MAX(chain_position), 0) + 1 AS next_pos FROM audit_log',
  )
  return result.rows[0].next_pos
}
