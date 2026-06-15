import { describe, it, expect, vi, beforeEach } from 'vitest'

import { KnowledgeStatus } from '../../gateway/src/shared/graph/schema.js'
import {
  getProjectGlobals,
  processPendingRow,
  buildVersionImpact,
} from '../../scripts/recheck-conflicts.js'

/**
 * Create a fake transactional pg client.
 * @returns {{ query: ReturnType<typeof vi.fn>, release: ReturnType<typeof vi.fn> }}
 */
function makeClient() {
  return {
    query:   vi.fn(),
    release: vi.fn(),
  }
}

/**
 * Create a fake pool with a connect() method.
 * @param {{ client?: ReturnType<typeof makeClient> }} [opts]
 * @returns {{ query: ReturnType<typeof vi.fn>, connect: ReturnType<typeof vi.fn> }}
 */
function makePool(opts = {}) {
  const client = opts.client ?? makeClient()
  return {
    query:   vi.fn(),
    connect: vi.fn().mockResolvedValue(client),
  }
}

/**
 * Minimal pending row fixture used by recheck processing tests.
 * @returns {Record<string, unknown>}
 */
function makePendingRow() {
  return {
    version_id:     'q_v2',
    q_key_id:       'q_k1',
    q_project_id:   'q_p1',
    topic:          'auth',
    key:            'csrf-token',
    version:        2,
    summary:        'CSRF tokens rotate per request.',
    author:         'alice',
    triggered_by:   'remember',
  }
}

describe('getProjectGlobals', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns globals from project_configs.config_json when present', async () => {
    const pool = makePool()
    pool.query.mockResolvedValue({
      rows: [{ config_json: { globals: ['security-standards', 'org-base'] } }],
    })

    const globals = await getProjectGlobals(pool, 'q_p1')

    expect(globals).toEqual(['security-standards', 'org-base'])
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT pc.config_json'),
      ['q_p1'],
    )
  })

  it('returns an empty array when no project config row exists', async () => {
    const pool = makePool()
    pool.query.mockResolvedValue({ rows: [] })

    await expect(getProjectGlobals(pool, 'q_p1')).resolves.toEqual([])
  })
})

describe('processPendingRow', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stores a pending decision and downgrades to DRAFT when a deferred row conflicts', async () => {
    const client = makeClient()
    const pool = makePool({ client })
    const row = makePendingRow()

    pool.query.mockResolvedValueOnce({
      rows: [{ config_json: { globals: ['security-standards'] } }],
    })

    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          version_id: 'q_v1',
          version:    1,
          summary:    'CSRF tokens are session-bound.',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE current -> DRAFT
      .mockResolvedValueOnce({ rows: [] }) // INSERT pending_decisions
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    const detectConflictFn = vi.fn().mockResolvedValue({
      conflict: true,
      reason:   'Incoming knowledge contradicts the active CSRF standard.',
    })

    const result = await processPendingRow(pool, row, {
      detectConflictFn,
      now: () => 1_717_000_000_000,
    })

    expect(result.outcome).toBe('conflicted')
    expect(result.newStatus).toBe(KnowledgeStatus.DRAFT)
    expect(result.supersededVersionId).toBeNull()
    expect(detectConflictFn).toHaveBeenCalledWith(
      row.summary,
      row.topic,
      row.key,
      row.topic,
      null,
      row.q_project_id,
      ['security-standards'],
    )
    expect(client.query).toHaveBeenNthCalledWith(2, expect.stringContaining('SELECT version_id, version, summary'), [
      row.q_project_id,
      row.q_key_id,
      row.version_id,
      KnowledgeStatus.ACTIVE,
    ])
    expect(client.query).toHaveBeenNthCalledWith(3, expect.stringContaining('UPDATE knowledge_versions SET status = $1'), [
      KnowledgeStatus.DRAFT,
      row.version_id,
    ])
    expect(client.query).toHaveBeenNthCalledWith(4, expect.stringContaining('INSERT INTO pending_decisions'), [
      'recheck_conflict_q_v2_1717000000000',
      row.q_key_id,
      row.q_project_id,
      1,
      'CSRF tokens are session-bound.',
      row.summary,
      'Incoming knowledge contradicts the active CSRF standard.',
    ])
  })

  it('captures the superseded active version id when promotion succeeds', async () => {
    const client = makeClient()
    const pool = makePool({ client })
    const row = makePendingRow()

    pool.query.mockResolvedValueOnce({ rows: [{ config_json: { globals: ['org-base'] } }] })

    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ version_id: 'q_v1' }] }) // supersede active sibling
      .mockResolvedValueOnce({ rows: [] }) // promote pending version
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    const detectConflictFn = vi.fn().mockResolvedValue({ conflict: false })

    const result = await processPendingRow(pool, row, { detectConflictFn })

    expect(result.outcome).toBe('promoted')
    expect(result.newStatus).toBe(KnowledgeStatus.ACTIVE)
    expect(result.supersededVersionId).toBe('q_v1')
    expect(client.query).toHaveBeenNthCalledWith(2, expect.stringContaining('RETURNING version_id'), [
      KnowledgeStatus.SUPERSEDED,
      row.q_project_id,
      row.version_id,
      KnowledgeStatus.ACTIVE,
    ])
  })
})

describe('buildVersionImpact', () => {
  it('includes the superseded version id when provided', () => {
    expect(buildVersionImpact('q_v1')).toEqual({
      versions_created:    [],
      versions_superseded: [{ version_id: 'q_v1' }],
    })
  })

  it('leaves versions_superseded empty when nothing was superseded', () => {
    expect(buildVersionImpact(null)).toEqual({
      versions_created:    [],
      versions_superseded: [],
    })
  })
})
