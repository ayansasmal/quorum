/**
 * SHA256 tamper-evident audit chain.
 *
 * Every audit entry carries the hash of the previous entry.
 * Modifying any historical entry breaks the chain — detectable on the next verify().
 *
 * Hash input: a deterministic JSON serialisation of the entry's content fields.
 * Keys are sorted recursively (deep-sort) to guarantee identical output regardless
 * of field ordering in the in-memory object or after PostgreSQL JSONB round-trip.
 * JSONB normalises key order on storage; deep-sort makes hashEntry stable across
 * write → store → read back cycles. entry_hash is excluded to avoid circularity.
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

/**
 * Recursively sort object keys so that JSON.stringify produces an identical
 * string regardless of the key insertion order of the original object or the
 * alphabetical reordering imposed by PostgreSQL's JSONB type.
 *
 * Type normalisation across PostgreSQL round-trips:
 * - Date objects (TIMESTAMPTZ returned by pg as a JS Date) → ISO string,
 *   matching the write-time value from new Date().toISOString().
 * - Arrays are left in their original order (order matters for array semantics).
 * - Plain objects have their keys sorted.
 * - All other primitives (string, number, boolean, null) are returned unchanged.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort)
  if (value instanceof Date) return value.toISOString()
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, deepSort(value[k])]),
    )
  }
  return value
}

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
 * All keys are sorted recursively (deep-sort) for determinism across PostgreSQL
 * JSONB round-trips. entry_hash is excluded to avoid circularity.
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
      .map((k) => [k, deepSort(hashable[k])]),
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
    `UPDATE audit_chain_counter SET next_position = next_position + 1
     WHERE id = 1
     RETURNING next_position - 1 AS next_pos`,
  )
  return result.rows[0].next_pos
}
