/**
 * Secondary audit store — PostgreSQL.
 *
 * Append-only. No UPDATE or DELETE ever runs on audit_log.
 * updateEntry() and deleteEntry() throw ConstitutionalViolation unconditionally
 * so the constitutional test suite can verify the invariant.
 *
 * writeAuditEntry() claims a chain_position and INSERTs in a single pg transaction
 * so concurrent writes cannot produce duplicate positions.
 */

import { v4 as uuidv4 } from 'uuid'
import { buildEntryWithHash, nextChainPosition } from './chain.js'
import { enforceAppendOnlyAudit } from '../governance/constitutional.js'

/**
 * Write a new audit entry to the PostgreSQL audit log.
 * Transactional: chain position claim + hash computation + INSERT are atomic.
 * @param {import('pg').Pool} pg
 * @param {Record<string, unknown>} entry - partial entry (without chain fields)
 * @returns {Promise<Record<string, unknown>>} the stored entry with all chain fields
 */
export async function writeAuditEntry(pg, entry) {
  if (typeof pg.writeAuditEntry === 'function') return pg.writeAuditEntry(entry)
  const client = await pg.connect()
  try {
    await client.query('BEGIN')

    const chainPosition = await nextChainPosition(client)

    // Get previous hash for chain linking
    const prevResult = await client.query(
      'SELECT entry_hash FROM audit_log WHERE chain_position = $1',
      [chainPosition - 1],
    )
    const previousHash = prevResult.rows[0]?.entry_hash ?? null

    // Normalise every field that will be stored in the DB row to its canonical
    // value BEFORE hashing. Fields omitted by callers (e.g. timestamp in
    // compensation entries) would otherwise be absent from the hash but present
    // when the row is read back — causing a write-time ≠ read-time hash mismatch.
    const normalised = {
      entry_id:        entry.entry_id ?? uuidv4(),
      timestamp:       entry.timestamp ?? new Date().toISOString(),
      content_hash:    entry.content_hash ?? null,
      governance_json: entry.governance_json ?? {},
      outcome_json:    entry.outcome_json ?? {},
      version_impact:  entry.version_impact ?? { versions_created: [], versions_superseded: [] },
      ...entry,
    }
    // Re-apply the same defaults after the spread so that a caller passing
    // `undefined` explicitly still gets a canonical non-undefined value in the
    // hashed object (matches what the DB will store).
    normalised.timestamp       = normalised.timestamp       ?? new Date().toISOString()
    normalised.content_hash    = normalised.content_hash    ?? null
    normalised.governance_json = normalised.governance_json ?? {}
    normalised.outcome_json    = normalised.outcome_json    ?? {}
    normalised.version_impact  = normalised.version_impact  ?? { versions_created: [], versions_superseded: [] }

    const completeEntry = buildEntryWithHash(normalised, previousHash, chainPosition)

    await client.query(
      `INSERT INTO audit_log (
        entry_id, operation, tool, timestamp, author, author_role,
        session_id, content_hash, governance_json, outcome_json,
        version_impact, entry_hash, previous_hash, chain_position,
        q_project_id, version_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        completeEntry.entry_id,
        completeEntry.operation,
        completeEntry.tool,
        completeEntry.timestamp,
        completeEntry.author,
        completeEntry.author_role ?? 'unknown',
        completeEntry.session_id ?? null,
        completeEntry.content_hash,
        JSON.stringify(completeEntry.governance_json),
        JSON.stringify(completeEntry.outcome_json),
        JSON.stringify(completeEntry.version_impact),
        completeEntry.entry_hash,
        completeEntry.previous_hash,
        completeEntry.chain_position,
        completeEntry.q_project_id ?? null,
        completeEntry.version_id ?? null,
      ],
    )

    await client.query('COMMIT')
    return completeEntry
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/**
 * Retrieve a single audit entry by ID.
 * @param {import('pg').Pool} pg
 * @param {string} entryId
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getAuditEntry(pg, entryId) {
  if (typeof pg.getAuditEntry === 'function') return pg.getAuditEntry(entryId)
  const result = await pg.query('SELECT * FROM audit_log WHERE entry_id = $1', [entryId])
  return result.rows[0] ?? null
}

/**
 * Retrieve all audit entries ordered by chain_position.
 * Used for chain verification and compliance export.
 * @param {import('pg').Pool} pg
 * @param {{ from?: string, to?: string, tool?: string, author?: string, topic?: string, limit?: number, qProjectId?: string }} [options]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getAllEntries(pg, options = {}) {
  if (typeof pg.getAllEntries === 'function') return pg.getAllEntries(options)
  let query = 'SELECT * FROM audit_log'
  const params = []
  const conditions = []

  if (options.qProjectId) {
    params.push(options.qProjectId)
    conditions.push(`q_project_id = $${params.length}`)
  }
  if (options.from) {
    params.push(options.from)
    conditions.push(`timestamp >= $${params.length}`)
  }
  if (options.to) {
    params.push(options.to)
    conditions.push(`timestamp <= $${params.length}`)
  }
  if (options.tool) {
    params.push(options.tool)
    conditions.push(`tool = $${params.length}`)
  }
  if (options.author) {
    params.push(options.author)
    conditions.push(`author = $${params.length}`)
  }
  if (options.topic) {
    params.push(`%${options.topic}%`)
    conditions.push(`outcome_json::text ILIKE $${params.length}`)
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ')
  }

  query += ' ORDER BY chain_position DESC'

  const limit = parseInt(options.limit, 10)
  if (!isNaN(limit) && limit > 0) {
    params.push(limit)
    query += ` LIMIT $${params.length}`
  }

  const result = await pg.query(query, params)
  return result.rows
}

/**
 * Count total audit entries. Used for startup sync verification.
 * @param {import('pg').Pool} pg
 * @param {string} [qProjectId] - If provided, count only entries for this project
 * @returns {Promise<number>}
 */
export async function countEntries(pg, qProjectId) {
  if (typeof pg.countEntries === 'function') return pg.countEntries()
  if (qProjectId) {
    const result = await pg.query(
      'SELECT COUNT(*)::int AS count FROM audit_log WHERE q_project_id = $1',
      [qProjectId],
    )
    return result.rows[0].count
  }
  const result = await pg.query('SELECT COUNT(*)::int AS count FROM audit_log')
  return result.rows[0].count
}

/**
 * Export audit entries as JSONL-compatible array for compliance.
 * @param {import('pg').Pool} pg
 * @param {{ from?: string, to?: string, domain?: string, format?: string }} [options]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function exportEntries(pg, options = {}) {
  return getAllEntries(pg, options)
}

/**
 * Constitutional Rule 2 enforcement.
 * This function exists so the constitutional test suite can call it and verify
 * that it unconditionally throws. Never implement actual update logic here.
 */
export function updateEntry() {
  enforceAppendOnlyAudit()
}

/**
 * Constitutional Rule 2 enforcement.
 * This function exists so the constitutional test suite can call it and verify
 * that it unconditionally throws. Never implement actual delete logic here.
 */
export function deleteEntry() {
  enforceAppendOnlyAudit()
}
