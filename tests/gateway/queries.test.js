/**
 * Tests for gateway/src/shared/graph/queries.js
 *
 * Every exported function has a duck-typing guard:
 *   if (typeof pg.<fn> === 'function') return pg.<fn>(...)
 * We test BOTH the short-circuit path and the real SQL path by providing
 * either a stubbed pool or a mock pool with pre-configured query responses.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  createProject,
  getProjectByGroupId,
  getOrCreateKey,
  getCurrentVersion,
  getVersionHistory,
  getVersionAtDate,
  getNextVersionNumber,
  getSpecificVersion,
  insertVersion,
  transitionVersionStatus,
  insertVersionAuditLink,
  getVersionsByTag,
  getLatestDraftVersion,
  getVersionsByStatus,
  getVersionStatusCounts,
  getDraftVersions,
  getPendingDecisionById,
  countPendingForKey,
  resolvePendingDecision,
  markPendingDecisionStale,
  updateConfidence,
  updateLastAccessed,
  getVersionForBump,
  getBumpLog,
  recordBump,
  incrementDomainStat,
} from '../../gateway/src/shared/graph/queries.js'

afterEach(() => vi.clearAllMocks())

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a mock pool whose query() returns the given responses in sequence.
 */
function makePool(...responses) {
  let i = 0
  return {
    query: vi.fn(async () => responses[i++] ?? { rows: [] }),
  }
}

/**
 * Build a pool that has a duck-type shortcut function.
 */
function makeShortcutPool(fn, shortcutName, result) {
  return { [shortcutName]: vi.fn().mockResolvedValue(result) }
}

// ── createProject ─────────────────────────────────────────────────────────────

describe('createProject', () => {
  it('uses duck-typing shortcut when available', async () => {
    const pool = { createProject: vi.fn().mockResolvedValue('q_p99') }
    const result = await createProject(pool, 'test-group', 'alice', [], {}, {})
    expect(pool.createProject).toHaveBeenCalledOnce()
    expect(result).toBe('q_p99')
  })

  it('inserts into q_projects and returns q_project_id', async () => {
    const pool = makePool(
      { rows: [{ n: 7 }] },                     // SELECT nextval
      { rows: [{ q_project_id: 'q_p7' }] },     // INSERT RETURNING
    )
    const result = await createProject(pool, 'my-group', 'alice', [], {}, { displayName: 'My Group', createdBy: 'alice' })
    expect(result).toBe('q_p7')
  })
})

// ── getProjectByGroupId ───────────────────────────────────────────────────────

describe('getProjectByGroupId', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getProjectByGroupId: vi.fn().mockResolvedValue('q_p1') }
    const result = await getProjectByGroupId(pool, 'my-group')
    expect(result).toBe('q_p1')
  })

  it('returns null when no project found', async () => {
    const pool = makePool({ rows: [] })
    const result = await getProjectByGroupId(pool, 'missing')
    expect(result).toBeNull()
  })

  it('returns q_project_id when found', async () => {
    const pool = makePool({ rows: [{ q_project_id: 'q_p5' }] })
    const result = await getProjectByGroupId(pool, 'my-group')
    expect(result).toBe('q_p5')
  })
})

// ── getOrCreateKey ────────────────────────────────────────────────────────────

describe('getOrCreateKey', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getOrCreateKey: vi.fn().mockResolvedValue('q_k10') }
    const result = await getOrCreateKey(pool, 'q_p1', 'auth', 'jwt-key')
    expect(result).toBe('q_k10')
  })

  it('executes nextval + INSERT ON CONFLICT RETURNING and returns q_key_id', async () => {
    // getOrCreateKey does: nextval + INSERT ON CONFLICT DO UPDATE RETURNING q_key_id
    const pool = makePool(
      { rows: [{ n: 10 }] },                   // SELECT nextval
      { rows: [{ q_key_id: 'q_k10' }] },       // INSERT ... RETURNING q_key_id
    )
    const result = await getOrCreateKey(pool, 'q_p1', 'auth', 'jwt-key')
    expect(result).toBe('q_k10')
  })
})

// ── getCurrentVersion ─────────────────────────────────────────────────────────

describe('getCurrentVersion', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getCurrentVersion: vi.fn().mockResolvedValue({ version: 1 }) }
    const result = await getCurrentVersion(pool, 'q_k1')
    expect(result).toEqual({ version: 1 })
  })

  it('returns null when no active version', async () => {
    const pool = makePool({ rows: [] })
    const result = await getCurrentVersion(pool, 'q_k1')
    expect(result).toBeNull()
  })

  it('returns the ACTIVE version row', async () => {
    const row = { version_id: 'q_k1_v2', status: 'ACTIVE', content: 'stored' }
    const pool = makePool({ rows: [row] })
    const result = await getCurrentVersion(pool, 'q_k1')
    expect(result).toEqual(row)
  })
})

// ── getVersionHistory ─────────────────────────────────────────────────────────

describe('getVersionHistory', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getVersionHistory: vi.fn().mockResolvedValue([]) }
    const result = await getVersionHistory(pool, 'q_k1')
    expect(result).toEqual([])
  })

  it('returns all versions ordered', async () => {
    const rows = [{ version_id: 'q_k1_v2' }, { version_id: 'q_k1_v1' }]
    const pool = makePool({ rows })
    const result = await getVersionHistory(pool, 'q_k1')
    expect(result).toHaveLength(2)
  })
})

// ── getVersionAtDate ──────────────────────────────────────────────────────────

describe('getVersionAtDate', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getVersionAtDate: vi.fn().mockResolvedValue(null) }
    const result = await getVersionAtDate(pool, 'q_k1', '2024-01-01')
    expect(result).toBeNull()
  })

  it('returns null when no version at that date', async () => {
    const pool = makePool({ rows: [] })
    const result = await getVersionAtDate(pool, 'q_k1', '2024-01-01')
    expect(result).toBeNull()
  })

  it('returns the version row when found', async () => {
    const row = { version_id: 'q_k1_v1' }
    const pool = makePool({ rows: [row] })
    const result = await getVersionAtDate(pool, 'q_k1', '2024-01-01')
    expect(result).toEqual(row)
  })
})

// ── getNextVersionNumber ──────────────────────────────────────────────────────

describe('getNextVersionNumber', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getNextVersionNumber: vi.fn().mockResolvedValue(3) }
    const result = await getNextVersionNumber(pool, 'q_k1')
    expect(result).toBe(3)
  })

  it('returns 1 when no versions exist (COALESCE returns 1)', async () => {
    // COALESCE(MAX(version), 0) + 1 → when empty, next_version = 1
    const pool = makePool({ rows: [{ next_version: 1 }] })
    const result = await getNextVersionNumber(pool, 'q_k1')
    expect(result).toBe(1)
  })

  it('returns next version number when versions exist', async () => {
    const pool = makePool({ rows: [{ next_version: 5 }] })
    const result = await getNextVersionNumber(pool, 'q_k1')
    expect(result).toBe(5)
  })
})

// ── getSpecificVersion ────────────────────────────────────────────────────────

describe('getSpecificVersion', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getSpecificVersion: vi.fn().mockResolvedValue(null) }
    const result = await getSpecificVersion(pool, 'q_k1', 2)
    expect(result).toBeNull()
  })

  it('returns null when not found', async () => {
    const pool = makePool({ rows: [] })
    const result = await getSpecificVersion(pool, 'q_k1', 99)
    expect(result).toBeNull()
  })

  it('returns the row when found', async () => {
    const row = { version_id: 'q_k1_v2', version: 2 }
    const pool = makePool({ rows: [row] })
    const result = await getSpecificVersion(pool, 'q_k1', 2)
    expect(result).toEqual(row)
  })
})

// ── insertVersion ─────────────────────────────────────────────────────────────

describe('insertVersion', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { insertVersion: vi.fn().mockResolvedValue({ version_id: 'q_k1_v1' }) }
    const result = await insertVersion(pool, { qKeyId: 'q_k1', version: 1, topic: 'auth', key: 'jwt', content: 'stored', status: 'DRAFT', author: 'alice', startingConfidence: 0.7 })
    expect(result.version_id).toBe('q_k1_v1')
  })

  it('inserts and returns the version row when record has required fields', async () => {
    const row = { version_id: 'q_k1_v1' }
    const pool = makePool({ rows: [row] })
    const result = await insertVersion(pool, {
      version_id:  'q_k1_v1',
      q_key_id:    'q_k1',
      q_project_id: 'q_p1',
      version: 1,
      topic: 'auth',
      key: 'jwt-key',
      content: 'stored content',
      status: 'DRAFT',
      author: 'alice',
    })
    expect(result).toEqual(row)
  })

  it('throws when required fields are missing', async () => {
    const pool = makePool({ rows: [] })
    await expect(insertVersion(pool, { q_key_id: 'q_k1' })).rejects.toThrow(/version_id/)
  })
})

// ── transitionVersionStatus ───────────────────────────────────────────────────

describe('transitionVersionStatus', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { transitionVersionStatus: vi.fn().mockResolvedValue({ version_id: 'q_k1_v1' }) }
    const result = await transitionVersionStatus(pool, 'q_k1_v1', 'ACTIVE', null)
    expect(result.version_id).toBe('q_k1_v1')
  })

  it('throws when version not found', async () => {
    const pool = makePool({ rows: [] }) // SELECT returns nothing
    await expect(
      transitionVersionStatus(pool, 'q_k1_v1', 'ACTIVE', null),
    ).rejects.toThrow(/not found/)
  })

  it('throws when transition is illegal', async () => {
    // Return a row with ACTIVE status, then try to transition to DRAFT (illegal)
    const pool = makePool(
      { rows: [{ version_id: 'q_k1_v1', status: 'ACTIVE' }] }, // SELECT
    )
    await expect(
      transitionVersionStatus(pool, 'q_k1_v1', 'DRAFT', null),
    ).rejects.toThrow(/Illegal/)
  })

  it('returns the updated row on legal transition DRAFT→ACTIVE', async () => {
    const updatedRow = { version_id: 'q_k1_v1', status: 'ACTIVE' }
    const pool = makePool(
      { rows: [{ version_id: 'q_k1_v1', status: 'DRAFT' }] }, // SELECT current
      { rows: [updatedRow] },                                   // UPDATE RETURNING
    )
    const result = await transitionVersionStatus(pool, 'q_k1_v1', 'ACTIVE', null)
    expect(result.status).toBe('ACTIVE')
  })
})

// ── insertVersionAuditLink ────────────────────────────────────────────────────

describe('insertVersionAuditLink', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { insertVersionAuditLink: vi.fn().mockResolvedValue(undefined) }
    await insertVersionAuditLink(pool, 'q_k1_v1', 'audit-1', 'created_by')
    expect(pool.insertVersionAuditLink).toHaveBeenCalledOnce()
  })

  it('inserts a version-audit link', async () => {
    const pool = makePool({ rows: [] })
    await expect(insertVersionAuditLink(pool, 'q_k1_v1', 'audit-1', 'created_by')).resolves.not.toThrow()
    expect(pool.query).toHaveBeenCalledOnce()
  })
})

// ── getVersionsByTag ──────────────────────────────────────────────────────────

describe('getVersionsByTag', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getVersionsByTag: vi.fn().mockResolvedValue([]) }
    const result = await getVersionsByTag(pool, 'security', 'q_p1')
    expect(result).toEqual([])
  })

  it('returns rows with the matching tag', async () => {
    const rows = [{ version_id: 'q_k1_v1', tags: ['security'] }]
    const pool = makePool({ rows })
    const result = await getVersionsByTag(pool, 'security', 'q_p1')
    expect(result).toHaveLength(1)
  })
})

// ── getLatestDraftVersion ─────────────────────────────────────────────────────

describe('getLatestDraftVersion', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getLatestDraftVersion: vi.fn().mockResolvedValue(null) }
    const result = await getLatestDraftVersion(pool, 'q_k1')
    expect(result).toBeNull()
  })

  it('returns null when no draft exists', async () => {
    const pool = makePool({ rows: [] })
    const result = await getLatestDraftVersion(pool, 'q_k1')
    expect(result).toBeNull()
  })
})

// ── getVersionsByStatus ───────────────────────────────────────────────────────

describe('getVersionsByStatus', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getVersionsByStatus: vi.fn().mockResolvedValue([]) }
    const result = await getVersionsByStatus(pool, 'ACTIVE', 'q_p1')
    expect(result).toEqual([])
  })

  it('returns rows with matching status', async () => {
    const rows = [{ version_id: 'q_k1_v1', status: 'ACTIVE' }]
    const pool = makePool({ rows })
    const result = await getVersionsByStatus(pool, 'ACTIVE', 'q_p1')
    expect(result).toHaveLength(1)
  })
})

// ── getVersionStatusCounts ────────────────────────────────────────────────────

describe('getVersionStatusCounts', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getVersionStatusCounts: vi.fn().mockResolvedValue({}) }
    const result = await getVersionStatusCounts(pool, 'q_p1')
    expect(result).toEqual({})
  })

  it('returns aggregated counts as object (count is already int from ::int cast)', async () => {
    const pool = makePool({
      rows: [
        { status: 'ACTIVE', count: 3 },
        { status: 'DRAFT',  count: 1 },
      ],
    })
    const result = await getVersionStatusCounts(pool, 'q_p1')
    expect(result.ACTIVE).toBe(3)
    expect(result.DRAFT).toBe(1)
  })
})

// ── getDraftVersions ──────────────────────────────────────────────────────────

describe('getDraftVersions', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getDraftVersions: vi.fn().mockResolvedValue([]) }
    const result = await getDraftVersions(pool, { qProjectId: 'q_p1' })
    expect(result).toEqual([])
  })

  it('returns draft version rows', async () => {
    const rows = [{ version_id: 'q_k1_v1', status: 'DRAFT' }]
    const pool = makePool({ rows })
    const result = await getDraftVersions(pool, { qProjectId: 'q_p1' })
    expect(result).toHaveLength(1)
  })
})

// ── getPendingDecisionById ────────────────────────────────────────────────────

describe('getPendingDecisionById', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getPendingDecisionById: vi.fn().mockResolvedValue(null) }
    const result = await getPendingDecisionById(pool, 'q_c1')
    expect(result).toBeNull()
  })

  it('returns null when not found', async () => {
    const pool = makePool({ rows: [] })
    const result = await getPendingDecisionById(pool, 'q_c99')
    expect(result).toBeNull()
  })

  it('returns the pending decision row', async () => {
    const row = { conflict_id: 'q_c1', status: 'pending' }
    const pool = makePool({ rows: [row] })
    const result = await getPendingDecisionById(pool, 'q_c1')
    expect(result).toEqual(row)
  })
})

// ── countPendingForKey ────────────────────────────────────────────────────────

describe('countPendingForKey', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { countPendingForKey: vi.fn().mockResolvedValue(0) }
    const result = await countPendingForKey(pool, 'q_k1')
    expect(result).toBe(0)
  })

  it('returns 0 when no pending decisions', async () => {
    // cnt field (not count) — see actual query: COUNT(*)::int AS cnt
    const pool = makePool({ rows: [{ cnt: 0 }] })
    const result = await countPendingForKey(pool, 'q_k1')
    expect(result).toBe(0)
  })

  it('returns count when pending decisions exist', async () => {
    const pool = makePool({ rows: [{ cnt: 3 }] })
    const result = await countPendingForKey(pool, 'q_k1')
    expect(result).toBe(3)
  })
})

// ── resolvePendingDecision ────────────────────────────────────────────────────

describe('resolvePendingDecision', () => {
  it('uses duck-typing shortcut (updatePendingDecision)', async () => {
    // duck-typing checks pg.updatePendingDecision, not pg.resolvePendingDecision
    const pool = { updatePendingDecision: vi.fn().mockResolvedValue(undefined) }
    await resolvePendingDecision(pool, 'q_c1', { status: 'resolved', resolution: 'supersede', note: 'ok', resolvedBy: 'alice' })
    expect(pool.updatePendingDecision).toHaveBeenCalledOnce()
  })

  it('updates the pending decision row via SQL', async () => {
    const pool = makePool({ rows: [] })
    await expect(
      resolvePendingDecision(pool, 'q_c1', {
        status: 'resolved',
        resolution: 'reject',
        note: 'outdated info',
        resolvedBy: 'alice',
      }),
    ).resolves.not.toThrow()
    expect(pool.query).toHaveBeenCalledOnce()
  })
})

// ── markPendingDecisionStale ──────────────────────────────────────────────────

describe('markPendingDecisionStale', () => {
  it('uses duck-typing shortcut (updatePendingDecision)', async () => {
    // duck-typing checks pg.updatePendingDecision, not pg.markPendingDecisionStale
    const pool = { updatePendingDecision: vi.fn().mockResolvedValue(undefined) }
    await markPendingDecisionStale(pool, 'q_c1', 'outdated', 3)
    expect(pool.updatePendingDecision).toHaveBeenCalledOnce()
  })

  it('updates the pending decision to stale via SQL', async () => {
    const pool = makePool({ rows: [] })
    await expect(markPendingDecisionStale(pool, 'q_c1', 'active version advanced', 3)).resolves.not.toThrow()
    expect(pool.query).toHaveBeenCalledOnce()
  })
})

// ── updateConfidence ──────────────────────────────────────────────────────────

describe('updateConfidence', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { updateConfidence: vi.fn().mockResolvedValue(undefined) }
    await updateConfidence(pool, 'q_k1_v1', 0.8)
    expect(pool.updateConfidence).toHaveBeenCalledOnce()
  })

  it('issues an UPDATE query', async () => {
    const pool = makePool({ rows: [] })
    await updateConfidence(pool, 'q_k1_v1', 0.8)
    expect(pool.query).toHaveBeenCalledOnce()
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toContain('UPDATE')
    expect(params).toContain(0.8)
  })
})

// ── updateLastAccessed ────────────────────────────────────────────────────────

describe('updateLastAccessed', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { updateLastAccessed: vi.fn().mockResolvedValue(undefined) }
    await updateLastAccessed(pool, 'q_k1_v1')
    expect(pool.updateLastAccessed).toHaveBeenCalledOnce()
  })

  it('issues an UPDATE query', async () => {
    const pool = makePool({ rows: [] })
    await updateLastAccessed(pool, 'q_k1_v1')
    expect(pool.query).toHaveBeenCalledOnce()
    const [sql] = pool.query.mock.calls[0]
    expect(sql).toContain('UPDATE')
  })
})

// ── getVersionForBump ─────────────────────────────────────────────────────────

describe('getVersionForBump', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getVersionForBump: vi.fn().mockResolvedValue(null) }
    const result = await getVersionForBump(pool, 'q_k1')
    expect(result).toBeNull()
  })

  it('returns null when no active version', async () => {
    const pool = makePool({ rows: [] })
    const result = await getVersionForBump(pool, 'q_k1')
    expect(result).toBeNull()
  })

  it('returns version row when found', async () => {
    const row = { version_id: 'q_k1_v2', confidence: 0.7, starting_confidence: 0.9 }
    const pool = makePool({ rows: [row] })
    const result = await getVersionForBump(pool, 'q_k1')
    expect(result).toEqual(row)
  })
})

// ── getBumpLog ────────────────────────────────────────────────────────────────

describe('getBumpLog', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { getBumpLog: vi.fn().mockResolvedValue([]) }
    const result = await getBumpLog(pool, { qKeyId: 'q_k1', author: 'alice' })
    expect(result).toEqual([])
  })

  it('returns bump log entries', async () => {
    const rows = [{ bumped_at: '2024-01-01T00:00:00Z', bumped_by: 'alice' }]
    const pool = makePool({ rows })
    const result = await getBumpLog(pool, { qKeyId: 'q_k1', author: 'alice' })
    expect(result).toHaveLength(1)
  })
})

// ── recordBump ────────────────────────────────────────────────────────────────

describe('recordBump', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { recordBump: vi.fn().mockResolvedValue(undefined) }
    await recordBump(pool, { qKeyId: 'q_k1', author: 'alice', role: 'engineer', delta: 0.025 })
    expect(pool.recordBump).toHaveBeenCalledOnce()
  })

  it('inserts a bump record', async () => {
    const pool = makePool({ rows: [] })
    await recordBump(pool, { qKeyId: 'q_k1', author: 'alice', role: 'engineer', delta: 0.025 })
    expect(pool.query).toHaveBeenCalledOnce()
  })
})

// ── incrementDomainStat ───────────────────────────────────────────────────────

describe('incrementDomainStat', () => {
  it('uses duck-typing shortcut', async () => {
    const pool = { incrementDomainStat: vi.fn().mockResolvedValue(undefined) }
    await incrementDomainStat(pool, { qProjectId: 'q_p1', author: 'alice', domain: 'auth', field: 'approved_count' })
    expect(pool.incrementDomainStat).toHaveBeenCalledOnce()
  })

  it('upserts the domain stat row', async () => {
    const pool = makePool({ rows: [] })
    await incrementDomainStat(pool, { qProjectId: 'q_p1', author: 'alice', domain: 'auth', field: 'approved_count' })
    expect(pool.query).toHaveBeenCalledOnce()
  })

  it('skips query when author is missing', async () => {
    const pool = makePool({ rows: [] })
    await incrementDomainStat(pool, { qProjectId: 'q_p1', author: '', domain: 'auth', field: 'approved_count' })
    expect(pool.query).not.toHaveBeenCalled()
  })
})
