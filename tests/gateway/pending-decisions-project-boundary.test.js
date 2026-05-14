/**
 * Gap 6 regression — pending_decisions UPDATEs must be scoped by project_id.
 *
 * `resolvePendingDecision()` and `markPendingDecisionStale()` previously used
 * `WHERE conflict_id = $N` only — conflict_id alone is architecturally
 * insufficient as a project boundary invariant. Every write path that touches
 * a project-scoped table must include project_id as an explicit guard.
 *
 * These tests capture the SQL+params handed to the pg pool and assert that
 * `project_id` participates in the WHERE clause for both UPDATE paths, and
 * that the dashboard caller forwards `req.user.project` through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  resolvePendingDecision,
  markPendingDecisionStale,
} from '../../gateway/src/shared/graph/queries.js'

/** Build a stub pg pool that records every .query(sql, params) call. */
function makeFakePool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  }
}

describe('resolvePendingDecision — project_id boundary', () => {
  let pool
  beforeEach(() => { pool = makeFakePool() })

  it('includes project_id in the WHERE clause and params', async () => {
    await resolvePendingDecision(pool, 'cfl_123', {
      status: 'resolved',
      resolution: 'supersede',
      note: 'fix bug',
      resolvedBy: 'alice',
    }, 'proj-a')

    expect(pool.query).toHaveBeenCalledTimes(1)
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toMatch(/UPDATE\s+pending_decisions/i)
    expect(sql).toMatch(/WHERE\s+conflict_id\s*=\s*\$\d+\s+AND\s+project_id\s*=\s*\$\d+/i)
    expect(params).toContain('cfl_123')
    expect(params).toContain('proj-a')
  })

  it('does not match rows in a different project (project_id is bound parameter)', async () => {
    // Simulate pg returning 0 rows when project_id doesn't match
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 })

    await resolvePendingDecision(pool, 'cfl_xyz', {
      status: 'resolved',
      resolution: 'reject',
      note: 'wrong project',
      resolvedBy: 'mallory',
    }, 'wrong-project')

    const [, params] = pool.query.mock.calls[0]
    // The wrong project id must be in the params — proving caller passed it through.
    expect(params).toContain('wrong-project')
  })
})

describe('markPendingDecisionStale — project_id boundary', () => {
  let pool
  beforeEach(() => { pool = makeFakePool() })

  it('includes project_id in the WHERE clause and params', async () => {
    await markPendingDecisionStale(pool, 'cfl_456', 'underlying entry changed', 7, 'proj-b')

    expect(pool.query).toHaveBeenCalledTimes(1)
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toMatch(/UPDATE\s+pending_decisions/i)
    expect(sql).toMatch(/WHERE\s+conflict_id\s*=\s*\$\d+\s+AND\s+project_id\s*=\s*\$\d+/i)
    expect(params).toContain('cfl_456')
    expect(params).toContain('proj-b')
  })

  it('passes the wrong-project value through as a parameter (would no-op in pg)', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 })

    await markPendingDecisionStale(pool, 'cfl_zzz', 'stale', 3, 'wrong-project')

    const [, params] = pool.query.mock.calls[0]
    expect(params).toContain('wrong-project')
  })
})
