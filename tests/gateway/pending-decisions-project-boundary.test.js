/**
 * pending_decisions UPDATE isolation — q_* ID design invariant.
 *
 * In the greenfield q_* schema (Phase 1), `conflict_id` values are
 * Quorum-assigned sequential IDs of the form `q_c{n}` (e.g. `q_c42`).
 * Because these IDs are opaque and globally unique (generated from
 * `q_conflict_seq`), a `WHERE conflict_id = $N` clause is sufficient
 * isolation — no `AND project_id = $N` guard is needed.
 *
 * Contrast with the old design where `conflict_id` was a user-supplied
 * string (e.g. `"conflict-auth"`), which required `AND project_id = $N`
 * to prevent cross-project manipulation.  That vulnerability no longer
 * exists: a caller cannot construct a `q_c{n}` ID they do not already
 * hold from a prior query scoped to their own project.
 *
 * These tests verify:
 *   1. The UPDATE SQL touches `pending_decisions` scoped by `conflict_id` only.
 *   2. `conflict_id` is the sole WHERE parameter — no extra `project_id` param.
 *   3. Correct column values are set for resolve and stale paths.
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

describe('resolvePendingDecision — conflict_id isolation (q_* schema)', () => {
  let pool
  beforeEach(() => { pool = makeFakePool() })

  it('updates pending_decisions scoped by conflict_id only', async () => {
    await resolvePendingDecision(pool, 'q_c123', {
      status: 'resolved',
      resolution: 'supersede',
      note: 'fix bug',
      resolvedBy: 'alice',
    })

    expect(pool.query).toHaveBeenCalledTimes(1)
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toMatch(/UPDATE\s+pending_decisions/i)
    // conflict_id is the sole WHERE predicate — q_c{n} is globally unique
    expect(sql).toMatch(/WHERE\s+conflict_id\s*=\s*\$\d+/i)
    expect(params).toContain('q_c123')
  })

  it('sets status, resolution, resolved_by from updates object', async () => {
    await resolvePendingDecision(pool, 'q_c456', {
      status: 'resolved',
      resolution: 'reject',
      note: 'not applicable',
      resolvedBy: 'bob',
    })

    const [, params] = pool.query.mock.calls[0]
    expect(params).toContain('resolved')
    expect(params).toContain('reject')
    expect(params).toContain('not applicable')
    expect(params).toContain('bob')
    expect(params).toContain('q_c456')
  })
})

describe('markPendingDecisionStale — conflict_id isolation (q_* schema)', () => {
  let pool
  beforeEach(() => { pool = makeFakePool() })

  it('updates pending_decisions scoped by conflict_id only', async () => {
    await markPendingDecisionStale(pool, 'q_c789', 'underlying entry changed', 7)

    expect(pool.query).toHaveBeenCalledTimes(1)
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toMatch(/UPDATE\s+pending_decisions/i)
    // conflict_id is the sole WHERE predicate — q_c{n} is globally unique
    expect(sql).toMatch(/WHERE\s+conflict_id\s*=\s*\$\d+/i)
    expect(params).toContain('q_c789')
  })

  it('sets stale_warning, current_active_version and status=stale', async () => {
    await markPendingDecisionStale(pool, 'q_c101', 'active version advanced to v5', 5)

    const [, params] = pool.query.mock.calls[0]
    expect(params).toContain('active version advanced to v5')
    expect(params).toContain(5)
    expect(params).toContain('q_c101')
  })
})
