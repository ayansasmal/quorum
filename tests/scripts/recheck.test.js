import { describe, it, expect, vi, beforeEach } from 'vitest'

import { KnowledgeStatus } from '../../gateway/src/shared/graph/schema.js'
import {
  getProjectGlobals,
  processPendingRow,
  buildVersionImpact,
} from '../../scripts/recheck-conflicts.js'

const { s3Send } = vi.hoisted(() => ({ s3Send: vi.fn() }))

vi.mock('@aws-sdk/client-s3', () => ({
  // Use a named function (not arrow) so `new S3Client()` works correctly
  S3Client: function MockS3Client() { this.send = s3Send },
  GetObjectCommand: vi.fn(),
}))

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

  it('returns an empty array when no q_projects row exists for the project', async () => {
    const pool = makePool()
    pool.query.mockResolvedValue({ rows: [] })

    await expect(getProjectGlobals(pool, 'q_p1')).resolves.toEqual([])
  })

  it('returns an empty array when QUORUM_CONFIG_BUCKET is not set', async () => {
    const pool = makePool()
    pool.query.mockResolvedValue({ rows: [{ group_id: 'my-group' }] })
    delete process.env.QUORUM_CONFIG_BUCKET

    await expect(getProjectGlobals(pool, 'q_p1')).resolves.toEqual([])
  })

  it('loads globals from S3 config when group_id and bucket are available', async () => {
    s3Send.mockResolvedValue({
      Body: { transformToString: vi.fn().mockResolvedValue('{"globals":["security-standards","org-base"]}') },
    })

    const pool = makePool()
    pool.query.mockResolvedValue({ rows: [{ group_id: 'my-group' }] })
    process.env.QUORUM_CONFIG_BUCKET = 'test-bucket'

    const globals = await getProjectGlobals(pool, 'q_p1')

    expect(globals).toEqual(['security-standards', 'org-base'])
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT group_id FROM q_projects'),
      ['q_p1'],
    )

    delete process.env.QUORUM_CONFIG_BUCKET
  })

  it('returns null when S3 throws so the caller defers rather than promoting', async () => {
    s3Send.mockRejectedValue(new Error('NoSuchKey'))

    const pool = makePool()
    pool.query.mockResolvedValue({ rows: [{ group_id: 'my-group' }] })
    process.env.QUORUM_CONFIG_BUCKET = 'test-bucket'

    await expect(getProjectGlobals(pool, 'q_p1')).resolves.toBeNull()

    delete process.env.QUORUM_CONFIG_BUCKET
  })
})

describe('processPendingRow', () => {
  beforeEach(() => vi.clearAllMocks())

  it('defers when getProjectGlobals returns null (config unavailable)', async () => {
    const pool = makePool()
    const row = makePendingRow()

    const result = await processPendingRow(pool, row, {
      getProjectGlobalsFn: vi.fn().mockResolvedValue(null),
    })

    expect(result.outcome).toBe('deferred')
    expect(result.newStatus).toBeNull()
    expect(result.conflictResult.graphiti_unavailable).toBe(true)
  })

  it('stores a pending decision and downgrades to DRAFT when a deferred row conflicts', async () => {
    const client = makeClient()
    const pool = makePool({ client })
    const row = makePendingRow()

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
      getProjectGlobalsFn: vi.fn().mockResolvedValue(['security-standards']),
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

    client.query
      .mockResolvedValueOnce({ rows: [] })                      // BEGIN
      .mockResolvedValueOnce({ rows: [{ version_id: 'q_v1' }] }) // supersede active sibling
      .mockResolvedValueOnce({ rows: [] })                      // UPDATE pending_decisions
      .mockResolvedValueOnce({ rows: [] })                      // promote pending version
      .mockResolvedValueOnce({ rows: [] })                      // COMMIT

    const detectConflictFn = vi.fn().mockResolvedValue({ conflict: false })

    const result = await processPendingRow(pool, row, {
      detectConflictFn,
      getProjectGlobalsFn: vi.fn().mockResolvedValue([]),
    })

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

  it('auto-resolves open pending_decisions rows when promoting to ACTIVE', async () => {
    const client = makeClient()
    const pool = makePool({ client })
    const row = makePendingRow()

    client.query
      .mockResolvedValueOnce({ rows: [] })                      // BEGIN
      .mockResolvedValueOnce({ rows: [{ version_id: 'q_v1' }] }) // supersede active sibling
      .mockResolvedValueOnce({ rows: [] })                      // UPDATE pending_decisions
      .mockResolvedValueOnce({ rows: [] })                      // promote pending version
      .mockResolvedValueOnce({ rows: [] })                      // COMMIT

    await processPendingRow(pool, row, {
      detectConflictFn: vi.fn().mockResolvedValue({ conflict: false }),
      getProjectGlobalsFn: vi.fn().mockResolvedValue([]),
    })

    const pdCall = client.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE pending_decisions'),
    )
    expect(pdCall).toBeDefined()
    expect(pdCall[0]).toMatch(/status = 'resolved'/)
    expect(pdCall[0]).toMatch(/resolution = 'approved'/)
    expect(pdCall[1]).toEqual([row.q_key_id, row.q_project_id])
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
