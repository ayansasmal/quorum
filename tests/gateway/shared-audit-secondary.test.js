/**
 * Tests for gateway/src/shared/audit/secondary.js
 *
 * All PostgreSQL I/O is mocked via a mock pool/client object.
 * No real DB connections are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('../../gateway/src/shared/audit/chain.js', () => ({
  buildEntryWithHash: vi.fn((entry, previousHash, chainPosition) => ({
    ...entry,
    previous_hash:  previousHash,
    chain_position: chainPosition,
    entry_hash:     'mock-hash-abc123',
  })),
  nextChainPosition: vi.fn(async (_client) => 1),
}))

vi.mock('../../gateway/src/shared/governance/constitutional.js', () => ({
  enforceAppendOnlyAudit: vi.fn(() => {
    const err = new Error('APPEND_ONLY_AUDIT: NO_UPDATE_OR_DELETE [ConstitutionalViolation]')
    err.name = 'ConstitutionalViolation'
    throw err
  }),
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { buildEntryWithHash, nextChainPosition } from '../../gateway/src/shared/audit/chain.js'
import {
  writeAuditEntry,
  getAuditEntry,
  getAllEntries,
  countEntries,
  exportEntries,
  updateEntry,
  deleteEntry,
} from '../../gateway/src/shared/audit/secondary.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a mock pg client with begin/commit/rollback/query/release.
 */
function makeMockClient(queryResponses = []) {
  let callIdx = 0
  const client = {
    query:   vi.fn(async () => queryResponses[callIdx++] ?? { rows: [] }),
    release: vi.fn(),
  }
  return client
}

/**
 * Build a mock pg pool whose connect() returns the given mock client.
 */
function makeMockPool(client) {
  return {
    connect: vi.fn(async () => client),
    query:   vi.fn(async () => ({ rows: [] })),
  }
}

// ── writeAuditEntry ────────────────────────────────────────────────────────────

describe('writeAuditEntry', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses pg.writeAuditEntry shortcut when available', async () => {
    const stub = vi.fn().mockResolvedValue({ entry_id: 'stub-1' })
    const pool = { writeAuditEntry: stub }

    const result = await writeAuditEntry(pool, { operation: 'remember', tool: 'remember' })

    expect(stub).toHaveBeenCalledOnce()
    expect(result.entry_id).toBe('stub-1')
  })

  it('executes a full transaction with BEGIN/COMMIT when pool has no shortcut', async () => {
    const client = makeMockClient([
      { rows: [] },               // BEGIN
      { rows: [] },               // nextChainPosition (mocked separately)
      { rows: [] },               // SELECT previous hash — no prev entry
      { rows: [] },               // INSERT
      { rows: [] },               // COMMIT
    ])

    // nextChainPosition resolves to 1 (mocked at module level)
    nextChainPosition.mockResolvedValue(1)
    // SELECT previous hash returns nothing
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT chain_position=0 → no prev hash
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    const pool = makeMockPool(client)

    const entry = {
      operation: 'remember',
      tool:      'remember',
      author:    'alice',
      timestamp: '2024-01-01T00:00:00.000Z',
    }

    const result = await writeAuditEntry(pool, entry)

    expect(client.query).toHaveBeenCalledWith('BEGIN')
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
    expect(result.entry_hash).toBe('mock-hash-abc123')
    expect(result.chain_position).toBe(1)
  })

  it('links to previous hash when chain_position > 1', async () => {
    nextChainPosition.mockResolvedValue(5)

    const client = makeMockClient()
    client.query
      .mockResolvedValueOnce({ rows: [] })                                          // BEGIN
      .mockResolvedValueOnce({ rows: [{ entry_hash: 'prev-hash-xyz' }] })           // SELECT prev hash
      .mockResolvedValueOnce({ rows: [] })                                          // INSERT
      .mockResolvedValueOnce({ rows: [] })                                          // COMMIT

    const pool = makeMockPool(client)

    buildEntryWithHash.mockImplementation((entry, prevHash, pos) => ({
      ...entry,
      previous_hash:  prevHash,
      chain_position: pos,
      entry_hash:     'linked-hash',
    }))

    const result = await writeAuditEntry(pool, { operation: 'recall', tool: 'recall', author: 'bob' })

    expect(buildEntryWithHash).toHaveBeenCalledWith(
      expect.anything(),
      'prev-hash-xyz',
      5,
    )
    expect(result.previous_hash).toBe('prev-hash-xyz')
  })

  it('rolls back and re-throws on INSERT error', async () => {
    nextChainPosition.mockResolvedValue(1)

    const client = makeMockClient()
    client.query
      .mockResolvedValueOnce({ rows: [] })                    // BEGIN
      .mockResolvedValueOnce({ rows: [] })                    // SELECT prev hash
      .mockRejectedValueOnce(new Error('INSERT failed'))      // INSERT throws
      .mockResolvedValueOnce({ rows: [] })                    // ROLLBACK

    const pool = makeMockPool(client)

    await expect(
      writeAuditEntry(pool, { operation: 'remember', tool: 'remember', author: 'alice' }),
    ).rejects.toThrow('INSERT failed')

    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('normalises missing fields to canonical defaults before hashing', async () => {
    nextChainPosition.mockResolvedValue(1)

    const client = makeMockClient()
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT prev hash
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    const pool = makeMockPool(client)

    // Entry with minimal fields — secondary.js should fill in defaults
    const entry = { operation: 'remember', tool: 'remember', author: 'alice' }
    const result = await writeAuditEntry(pool, entry)

    // buildEntryWithHash was called with normalised defaults
    expect(buildEntryWithHash).toHaveBeenCalledWith(
      expect.objectContaining({
        content_hash:    null,
        governance_json: expect.any(Object),
        outcome_json:    expect.any(Object),
        version_impact:  expect.any(Object),
      }),
      null, // no previous hash
      1,
    )
  })
})

// ── getAuditEntry ─────────────────────────────────────────────────────────────

describe('getAuditEntry', () => {
  afterEach(() => vi.clearAllMocks())

  it('uses pg.getAuditEntry shortcut when available', async () => {
    const stub = vi.fn().mockResolvedValue({ entry_id: 'e1' })
    const pool = { getAuditEntry: stub }

    const result = await getAuditEntry(pool, 'e1')
    expect(stub).toHaveBeenCalledWith('e1')
    expect(result.entry_id).toBe('e1')
  })

  it('queries audit_log by entry_id and returns the row', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ entry_id: 'e42' }] }),
    }

    const result = await getAuditEntry(pool, 'e42')
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT * FROM audit_log WHERE entry_id = $1',
      ['e42'],
    )
    expect(result.entry_id).toBe('e42')
  })

  it('returns null when no row found', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }

    const result = await getAuditEntry(pool, 'missing')
    expect(result).toBeNull()
  })
})

// ── getAllEntries ──────────────────────────────────────────────────────────────

describe('getAllEntries', () => {
  afterEach(() => vi.clearAllMocks())

  it('uses pg.getAllEntries shortcut when available', async () => {
    const stub = vi.fn().mockResolvedValue([{ entry_id: 'e1' }])
    const pool = { getAllEntries: stub }

    const result = await getAllEntries(pool, { limit: 5 })
    expect(stub).toHaveBeenCalledWith({ limit: 5 })
    expect(result).toHaveLength(1)
  })

  it('returns all rows ordered by chain_position with no filters', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ entry_id: 'e1' }, { entry_id: 'e2' }] }),
    }

    const result = await getAllEntries(pool)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY chain_position DESC'),
      [],
    )
    expect(result).toHaveLength(2)
  })

  it('applies qProjectId filter', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    await getAllEntries(pool, { qProjectId: 'proj-123' })
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toContain('q_project_id')
    expect(params).toContain('proj-123')
  })

  it('applies from/to timestamp filters', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    await getAllEntries(pool, {
      from: '2024-01-01T00:00:00Z',
      to:   '2024-12-31T23:59:59Z',
    })
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toContain('timestamp >=')
    expect(sql).toContain('timestamp <=')
    expect(params).toContain('2024-01-01T00:00:00Z')
    expect(params).toContain('2024-12-31T23:59:59Z')
  })

  it('applies tool and author filters', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    await getAllEntries(pool, { tool: 'remember', author: 'alice' })
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toContain('tool = ')
    expect(sql).toContain('author = ')
    expect(params).toContain('remember')
    expect(params).toContain('alice')
  })

  it('applies topic ILIKE filter', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    await getAllEntries(pool, { topic: 'auth' })
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toContain('ILIKE')
    expect(params).toContain('%auth%')
  })

  it('applies LIMIT when limit is a valid positive integer', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    await getAllEntries(pool, { limit: 50 })
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toContain('LIMIT')
    expect(params).toContain(50)
  })

  it('does not apply LIMIT for non-numeric or zero limit', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    await getAllEntries(pool, { limit: 'NaN' })
    const [sql] = pool.query.mock.calls[0]
    expect(sql).not.toContain('LIMIT')
  })
})

// ── countEntries ──────────────────────────────────────────────────────────────

describe('countEntries', () => {
  afterEach(() => vi.clearAllMocks())

  it('uses pg.countEntries shortcut when available', async () => {
    const stub = vi.fn().mockResolvedValue(42)
    const pool = { countEntries: stub }

    const result = await countEntries(pool)
    expect(stub).toHaveBeenCalledOnce()
    expect(result).toBe(42)
  })

  it('counts all entries when no qProjectId', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ count: 10 }] }),
    }

    const result = await countEntries(pool)
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT COUNT(*)::int AS count FROM audit_log',
    )
    expect(result).toBe(10)
  })

  it('counts entries filtered by qProjectId', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ count: 5 }] }),
    }

    const result = await countEntries(pool, 'proj-xyz')
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toContain('WHERE q_project_id = $1')
    expect(params).toContain('proj-xyz')
    expect(result).toBe(5)
  })
})

// ── exportEntries ─────────────────────────────────────────────────────────────

describe('exportEntries', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to getAllEntries with same options', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ entry_id: 'e1' }] }),
    }

    const result = await exportEntries(pool, { from: '2024-01-01T00:00:00Z' })
    expect(pool.query).toHaveBeenCalledOnce()
    expect(result).toHaveLength(1)
  })

  it('returns empty array when no entries match', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    const result = await exportEntries(pool)
    expect(result).toEqual([])
  })
})

// ── updateEntry / deleteEntry (constitutional guard) ──────────────────────────

describe('updateEntry', () => {
  it('always throws — append-only invariant', () => {
    expect(() => updateEntry()).toThrow()
  })
})

describe('deleteEntry', () => {
  it('always throws — append-only invariant', () => {
    expect(() => deleteEntry()).toThrow()
  })
})
