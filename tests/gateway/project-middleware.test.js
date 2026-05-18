/**
 * Tests for:
 *   gateway/src/middleware/project.js
 *   gateway/src/shared/audit/governance.js
 *
 * project middleware: called directly with mock req/res/next objects.
 * governance audit:   thin wrapper around writeAuditEntry — mocked at that level.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash } from 'node:crypto'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('../../gateway/src/config-cache.js', () => ({
  getProjectByTokenHash: vi.fn(),
  loadUserProfile:       vi.fn(),
}))

vi.mock('../../gateway/src/shared/audit/secondary.js', () => ({
  writeAuditEntry: vi.fn(),
}))

// ── Imports ────────────────────────────────────────────────────────────────────

import { getProjectByTokenHash } from '../../gateway/src/config-cache.js'
import { writeAuditEntry } from '../../gateway/src/shared/audit/secondary.js'
import { projectMiddleware } from '../../gateway/src/middleware/project.js'
import { writeGovernanceAudit } from '../../gateway/src/shared/audit/governance.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a mock Express request, response, and next function.
 * @param {object} [overrides]
 */
function makeMockReq(headers = {}, appLocals = {}) {
  return {
    headers,
    app: { locals: appLocals },
  }
}

function makeMockRes() {
  const res = {
    statusCode: 200,
    body:       null,
    status:     vi.fn().mockReturnThis(),
    json:       vi.fn().mockReturnThis(),
  }
  return res
}

function makeMockNext() {
  return vi.fn()
}

// ── project middleware ─────────────────────────────────────────────────────────

describe('projectMiddleware', () => {
  afterEach(() => vi.clearAllMocks())

  it('calls next(error) with UNAUTHORIZED when X-Quorum-Token header is missing', async () => {
    const req  = makeMockReq({}) // no x-quorum-token
    const res  = makeMockRes()
    const next = makeMockNext()

    await projectMiddleware(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    const err = next.mock.calls[0][0]
    expect(err).toBeTruthy()
    expect(err.status).toBe(401)
    expect(err.code).toBe('UNAUTHORIZED')
  })

  it('calls next(error) with FORBIDDEN when token is invalid', async () => {
    getProjectByTokenHash.mockResolvedValue(null) // no project found

    const req  = makeMockReq({ 'x-quorum-token': 'bad-token-value' })
    const res  = makeMockRes()
    const next = makeMockNext()

    await projectMiddleware(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    const err = next.mock.calls[0][0]
    expect(err).toBeTruthy()
    expect(err.status).toBe(403)
    expect(err.code).toBe('FORBIDDEN')
  })

  it('attaches req.project and calls next() with no args on valid token', async () => {
    const projectData = {
      id:      'proj-abc',
      slug:    'my-project',
      name:    'My Project',
      members: [],
      domains: [],
      governance: {},
      config_version: 1,
    }
    getProjectByTokenHash.mockResolvedValue(projectData)

    const plainToken = 'abc123secrettoken'
    const req  = makeMockReq({ 'x-quorum-token': plainToken }, { pool: {} })
    const res  = makeMockRes()
    const next = makeMockNext()

    await projectMiddleware(req, res, next)

    // Token should be SHA-256 hashed before lookup
    const expectedHash = createHash('sha256').update(plainToken).digest('hex')
    expect(getProjectByTokenHash).toHaveBeenCalledWith(expectedHash, expect.any(Object))

    expect(next).toHaveBeenCalledWith() // no error
    expect(req.project).toEqual(projectData)
  })

  it('calls next(err) when getProjectByTokenHash throws', async () => {
    getProjectByTokenHash.mockRejectedValue(new Error('DB connection failed'))

    const req  = makeMockReq({ 'x-quorum-token': 'some-token' })
    const res  = makeMockRes()
    const next = makeMockNext()

    await projectMiddleware(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    const err = next.mock.calls[0][0]
    expect(err.message).toMatch(/DB connection failed/)
  })

  it('hashes different tokens to different lookup values', async () => {
    getProjectByTokenHash.mockResolvedValue({ id: 'proj-1' })

    const req1  = makeMockReq({ 'x-quorum-token': 'token-alpha' }, { pool: {} })
    const req2  = makeMockReq({ 'x-quorum-token': 'token-beta'  }, { pool: {} })
    const next1 = makeMockNext()
    const next2 = makeMockNext()

    await projectMiddleware(req1, makeMockRes(), next1)
    await projectMiddleware(req2, makeMockRes(), next2)

    const call1Hash = getProjectByTokenHash.mock.calls[0][0]
    const call2Hash = getProjectByTokenHash.mock.calls[1][0]

    expect(call1Hash).not.toBe(call2Hash)
    // Both should be 64-char hex strings (SHA-256)
    expect(call1Hash).toMatch(/^[a-f0-9]{64}$/)
    expect(call2Hash).toMatch(/^[a-f0-9]{64}$/)
  })
})

// ── writeGovernanceAudit ──────────────────────────────────────────────────────

describe('writeGovernanceAudit', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to writeAuditEntry with correct fields for ownership_transfer', async () => {
    writeAuditEntry.mockResolvedValue({ entry_id: 'audit-1' })

    const pool = {}
    const result = await writeGovernanceAudit(pool, {
      actor:      'alice',
      actor_type: 'owner',
      action:     'ownership_transfer',
      project:    'proj-abc',
      from:       'alice',
      to:         'bob',
      reason:     'alice is leaving the team',
    })

    expect(writeAuditEntry).toHaveBeenCalledOnce()
    const [calledPool, entry] = writeAuditEntry.mock.calls[0]
    expect(calledPool).toBe(pool)
    expect(entry.topic).toBe('_governance')
    expect(entry.key).toBe('ownership_transfer')
    expect(entry.actor).toBe('alice')
    expect(entry.from).toBe('alice')
    expect(entry.to).toBe('bob')
    expect(entry.project).toBe('proj-abc')
    expect(entry.triggered_by).toBe('governance_endpoint')
    expect(result.entry_id).toBe('audit-1')
  })

  it('delegates to writeAuditEntry with correct fields for admin_add', async () => {
    writeAuditEntry.mockResolvedValue({ entry_id: 'audit-2' })

    const pool = {}
    await writeGovernanceAudit(pool, {
      actor:      'alice',
      actor_type: 'admin',
      action:     'admin_add',
      project:    null,
      to:         'charlie',
      reason:     'charlie joined the platform team',
    })

    const [, entry] = writeAuditEntry.mock.calls[0]
    expect(entry.action).toBe('admin_add')
    expect(entry.to).toBe('charlie')
    expect(entry.from).toBeNull()
    expect(entry.project).toBeNull()
  })

  it('delegates to writeAuditEntry with correct fields for admin_remove', async () => {
    writeAuditEntry.mockResolvedValue({ entry_id: 'audit-3' })

    const pool = {}
    await writeGovernanceAudit(pool, {
      actor:      'alice',
      actor_type: 'admin',
      action:     'admin_remove',
      project:    null,
      from:       'bob',
      reason:     'bob left the organisation',
    })

    const [, entry] = writeAuditEntry.mock.calls[0]
    expect(entry.action).toBe('admin_remove')
    expect(entry.from).toBe('bob')
    expect(entry.to).toBeNull()
  })

  it('spreads extra fields into the audit entry', async () => {
    writeAuditEntry.mockResolvedValue({ entry_id: 'audit-4' })

    const pool = {}
    await writeGovernanceAudit(pool, {
      actor:      'alice',
      actor_type: 'admin',
      action:     'role_update',
      project:    'proj-abc',
      reason:     'upgrading role for increased responsibility',
      extra:      { old_role: 'engineer', new_role: 'principal_architect' },
    })

    const [, entry] = writeAuditEntry.mock.calls[0]
    expect(entry.old_role).toBe('engineer')
    expect(entry.new_role).toBe('principal_architect')
  })

  it('propagates errors from writeAuditEntry', async () => {
    writeAuditEntry.mockRejectedValue(new Error('DB write failed'))

    const pool = {}
    await expect(
      writeGovernanceAudit(pool, {
        actor:      'alice',
        actor_type: 'admin',
        action:     'admin_add',
        project:    null,
        reason:     'test reason that is long enough',
      }),
    ).rejects.toThrow('DB write failed')
  })
})
